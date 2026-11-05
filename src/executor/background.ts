/**
 * A worker's background work in DSH: the shell jobs its Session owns (`ctx.jobs`) and its subagents (`ctx.subagents`). They
 * keep the worker busy after its turn ended, and they stop with its Assignment. A profile without either service has none.
 */
// worker 在 DSH（DeepSeek Harness）里的后台工作：其 Session 拥有的 shell 作业（`ctx.jobs`）
// 与它派生的 subagent（`ctx.subagents`）。回合结束后它们仍让 worker 保持"忙碌"，
// 并随其 Assignment 一起停止。preset（profile）若没有对应服务，就当没有后台工作。
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** What the Executor uses of DSH's job registry: the jobs a Session can see, their events, a wait for one and a kill. */
// Jobs：Executor 用到的 DSH 作业注册表能力面——列出某 Session 可见的作业、订阅其事件、等待某个作业、杀掉它。
interface Jobs {
  list(caller: string): readonly { id: string; owner?: string; status: string; label?: string }[]
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<{ status: string }>
  kill(id: string, caller: string, reason?: string): unknown
  readonly events: { subscribe(filter: { owner: string }, listener: (event: { type: string }) => void): () => void }
}
/** What the Executor uses of DSH's subagents: joining a worker's subagents that work, its subagents, and releasing them. */
// Subagents：Executor 用到的 DSH subagent 能力面——等待其子 agent 结束、列出子 agent、释放（排空）它们。
interface Subagents {
  waitForChildren(parent: Agent): Promise<boolean>
  listChildren(parentSessionId: string): Promise<readonly { id: string }[]>
  drainChildren(parent: Agent, childIds: readonly string[]): Promise<void>
}
/** How long a stop waits for a killed job to end, collecting its end so the worker is not woken to hear of it. */
// KILL_WAIT_MS：停止时等待被杀作业结束的时限——目的是"收走"其结束事件，别把 worker 吵醒。
const KILL_WAIT_MS = 10_000
/** How long a release of subagents may take; it can hold up a shutdown, so DSH's own callers bound it too. */
// DRAIN_LIMIT_MS：释放 subagent 的时限；它可能拖住关机流程，所以有界。
const DRAIN_LIMIT_MS = 10_000
/** How long one wait that collects a job's end runs; one that ends with the job running is followed by the next. */
// COLLECT_WAIT_MS：单次"收集作业结束"等待的时长；超时作业仍在跑就再等下一轮。
const COLLECT_WAIT_MS = 10 * 60_000

// registry / subagentsOf：从 Cordis 容器里按服务名取作业注册表 / subagent 服务（可能未安装）。
const registry = (ctx: Context): Jobs | undefined => ctx.get('jobs') as Jobs | undefined
const subagentsOf = (ctx: Context): Subagents | undefined => ctx.get('subagents') as Subagents | undefined
// running：作业仍算"在运行"的两种状态（running 与正在停止中的 stopping）。
const running = (status: string) => status === 'running' || status === 'stopping'
/** The jobs the Session owns that run, but those in `except`, such as the ones left to a person. */
// owned：该 Session 拥有、仍在运行、且不在 `except`（如已移交给人的）之列的作业。
const owned = (jobs: Jobs, sessionId: string, except?: ReadonlySet<string>) =>
  jobs.list(sessionId).filter(job => job.owner === sessionId && running(job.status) && !except?.has(job.id))
/** `work`, or false once `signal` aborts or `ms` pass first. */
// until：带中止/超时的竞速——work 完成返回其结果；signal 中止或 ms 超时先到则返回 false。
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  let stop!: () => void
  // stopped：一个"手动触发即 resolve(false)"的 Promise，与 work 竞速。
  const stopped = new Promise<false>(resolve => { stop = () => { resolve(false) } })
  signal?.addEventListener('abort', stop, { once: true })
  const timer = ms === undefined ? undefined : setTimeout(stop, ms)
  // unref：定时器不阻止进程退出（关机时别被它拖住）。
  timer?.unref?.()
  // finally 里清理监听与定时器，避免泄漏。
  return Promise.race([work, stopped]).finally(() => { signal?.removeEventListener('abort', stop); clearTimeout(timer) })
}
/** The workers whose turn a stop of their subagents cancelled, whose next idle ends that turn rather than one of their own. */
// cancelled：因"释放 subagent"而被取消回合的 worker 集合——它们的下一次 idle 算作"结束被取消的回合"，
// 而不是它们自己的回合结束（DshExecutor 用它过滤误报）。
export const cancelled = new WeakSet<Agent>()
/** The pending join of each worker's subagents, which DSH cannot cancel, so a later look joins the same one. */
// joins：每个 worker 的"等待子 agent"承诺缓存——DSH 的这个等待无法取消，
// 缓存后同一 worker 的多次查看复用同一个 Promise。
const joins = new WeakMap<Agent, Promise<boolean>>()
// childrenEnd：等待某 worker 的全部 subagent 结束（带缓存复用）。
function childrenEnd(subagents: Subagents, agent: Agent): Promise<boolean> {
  let join = joins.get(agent)
  if (!join) {
    join = subagents.waitForChildren(agent).finally(() => { joins.delete(agent) })
    joins.set(agent, join)
  }
  return join
}

/** A job by its id and the first line of its label. */
// named：作业的可读名——id + label 的第一行。
const named = (job: { id: string; label?: string }) => { const line = job.label?.split('\n')[0]?.trim(); return line ? `${job.id} (${line})` : job.id }
/** The shell jobs the Session owns that still run, but those in `except`, with their names. */
// runningJobs：列出该 Session 仍在运行、不在 except 之列的 shell 作业（id + 名字）。
export const runningJobs = (ctx: Context, sessionId: string, except?: ReadonlySet<string>): { id: string; name: string }[] => {
  const jobs = registry(ctx)
  return jobs ? owned(jobs, sessionId, except).map(job => ({ id: job.id, name: named(job) })) : []
}

/**
 * Wait until no shell job the Session owns runs; false at once when none ran, or when `signal` aborts first. The wait is
 * no waiter on any job, so each job's end still reaches the worker.
 */
// jobsEnd：等到该 Session 拥有的 shell 作业全部结束——
// 本来就没有在跑的直接 false；靠订阅作业事件（settled/removed）而非 wait()，
// 这样每个作业的结束结果仍会送达 worker，不会被这里"截胡"。
function jobsEnd(ctx: Context, sessionId: string, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  const jobs = registry(ctx)
  if (!jobs || !owned(jobs, sessionId, except).length) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    // done：一次性收尾——置位、退订、摘掉 abort 监听、resolve。
    const done = (value: boolean) => {
      if (settled) return
      settled = true; unsubscribe(); signal.removeEventListener('abort', aborted); resolve(value)
    }
    const aborted = () => { done(false) }
    // Only an end can leave no job running; a job's output does not.
    // 只有"结束/移除"事件才可能让作业清零；作业有输出不算结束。
    const unsubscribe = jobs.events.subscribe({ owner: sessionId }, event => {
      if ((event.type === 'settled' || event.type === 'removed') && !owned(jobs, sessionId, except).length) done(true)
    })
    signal.addEventListener('abort', aborted, { once: true })
    // 订阅前就已中止的边界情况。
    if (signal.aborted) aborted()
  })
}

/**
 * Wait until nothing runs for a worker that went idle: its shell jobs, but those in `except`, and its subagents. A job's or a
 * subagent's end wakes the worker with its result, which ends this look: the turn it starts ends with an idle of its own,
 * which looks afresh.
 * @returns true once all of it ended with the worker idle; false when the worker runs again, or when `signal` aborts first,
 * as when the host stops or the look's time is up.
 */
// untilQuiet：等待"空闲 worker 的后台全部安静"——其 shell 作业（除 except）与 subagent 都结束。
// 作业或 subagent 的结束会把结果送进 worker、唤醒它并开启新回合，从而结束本轮查看；
// 新回合自己的 idle 会再次调用这里（循环重新看）。
// 返回 true：全部结束且 worker 仍空闲；false：worker 又跑起来了、或 signal 中止（宿主停止/查看限时到）。
export async function untilQuiet(ctx: Context, agent: Agent, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  for (;;) {
    const subagents = subagentsOf(ctx)
    // 先等 subagent 结束（signal 可中断），再等 shell 作业结束。
    const children = subagents ? await until(childrenEnd(subagents, agent), signal) : false
    const jobs = await jobsEnd(ctx, agent.id, signal, except)
    // worker 不再空闲（被唤醒去干活了）或被中止：本轮查看结束，返回 false。
    if (signal.aborted || agent.status !== 'idle') return false
    // 后台没有 subagent 也没有作业在跑：安静了。
    if (!children && !jobs) return true
  }
}

/**
 * Kill the shell jobs the Session owns, but those in `except`, collecting each end so the worker is not woken to hear of it.
 * One failure stops none other.
 */
// killJobs：杀掉该 Session 拥有的 shell 作业（except 除外），
// 并"收集"每个作业的结束事件（等它结束），避免 worker 被吵醒听到死讯。
// 单个失败不影响其他作业；有失败则抛 AggregateError。
export async function killJobs(ctx: Context, sessionId: string, reason: string, except?: ReadonlySet<string>): Promise<void> {
  const jobs = registry(ctx)
  const live = jobs ? owned(jobs, sessionId, except) : []
  const failures: unknown[] = []
  // The waits start before the kills, so each end counts as collected.
  // 先发起 wait 再 kill：保证每个结束事件都被收集到（不会错过竞态）。
  const collected = live.map(job => jobs!.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => undefined))
  for (const job of live) try { jobs!.kill(job.id, sessionId, reason) } catch (error) { failures.push(error) }
  await Promise.all(collected)
  if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`)
}

/**
 * Collect the end of a shell job the Session owns, so it wakes no one, until `signal` aborts.
 * @returns the job's name and status once it ended; undefined when `signal` aborted first.
 */
// collectJob：持续"收集"一个作业的结束——吞掉结束事件，不让它唤醒任何 worker，
// 直到 signal 中止。返回作业名与最终状态；signal 先中止则 undefined。
export async function collectJob(ctx: Context, sessionId: string, job: { id: string; name: string }, signal: AbortSignal):
  Promise<{ name: string; status: string } | undefined> {
  const jobs = registry(ctx)
  // 单次 wait 有时长上限（COLLECT_WAIT_MS）；作业仍在跑就继续下一轮等。
  while (jobs && !signal.aborted) {
    const view = await jobs.wait(job.id, COLLECT_WAIT_MS, sessionId, signal).catch(() => undefined)
    if (!view) return undefined
    if (!running(view.status)) return { name: job.name, status: view.status }
  }
  return undefined
}

/**
 * Release the worker's live subagents, for a bounded time. DSH delivers each one's end to the worker before the release
 * returns, which wakes it, so the worker's turn is cancelled after, keeping its inbox when `keepInbox`, and the stop ends
 * with that turn. Its Session still admits subagents.
 */
// stopSubagents：在有限时间内释放 worker 存活的 subagent。
// DSH 会在 drain 返回前把每个 subagent 的结束送达 worker 并唤醒它——
// 所以 drain 之后立刻取消 worker 的回合（keepInbox 决定是否保留收件箱），
// 被取消的回合记入 cancelled 集合（下次 idle 不当真）。Session 仍可再收 subagent。
export async function stopSubagents(ctx: Context, agent: Agent, keepInbox = false): Promise<void> {
  const subagents = subagentsOf(ctx)
  if (!subagents) return
  // The catalog lists every subagent the Session had; one that ended has no agent.
  // 目录列出 Session 曾有过的全部 subagent；已结束的取不到 agent——过滤出还活着的。
  const live = (await subagents.listChildren(agent.id)).map(child => child.id).filter(id => ctx.agents.get(id as SessionId))
  if (!live.length) return
  try { await until(subagents.drainChildren(agent, live), undefined, DRAIN_LIMIT_MS) }
  finally {
    // 无论 drain 成功、超时还是出错，都要取消被唤醒的回合。
    if (agent.status !== 'idle') cancelled.add(agent)
    agent.cancel({ kind: 'user' }, { keepInbox })
    await until(agent.whenIdle(), undefined, DRAIN_LIMIT_MS)
  }
}

/**
 * Stop what a worker runs in the background once its Assignment ends: kill its shell jobs and release its subagents (see
 * `stopSubagents`). A Session not loaded has no subagent at work. One failure stops nothing else.
 */
// stopBackground：Assignment 结束后停掉 worker 的一切后台工作——先杀 shell 作业，再释放 subagent。
// Session 未加载则没有 subagent 在跑。单项失败不阻断其他清理；有失败抛 AggregateError。
export async function stopBackground(ctx: Context, sessionId: string, reason: string, keepInbox = false): Promise<void> {
  const failures: unknown[] = []
  await killJobs(ctx, sessionId, reason).catch((error: unknown) => { failures.push(error) })
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error: unknown) => { failures.push(error) })
  if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`)
}
