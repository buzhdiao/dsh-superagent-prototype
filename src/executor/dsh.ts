/** DSH executor: manages one persistent worker session and workspace directory per ticket. */
// DshExecutor：基于 DSH（DeepSeek Harness）的执行器——
// 为每个 Ticket（工单）维护一个常驻的 worker Session（执行会话）和一个隔离的工作区目录。
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } from './background.ts'

// now：当前时间的 ISO 字符串（本文件内多处使用）。
const now = (): string => new Date().toISOString()
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
// workerSessionId：worker Session 的命名规则——`worker-<ticketId>`，由 Ticket id 直接派生。
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
// ticketOfSession：从 Session id 反查 Ticket id；非 worker 会话返回 undefined。
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** Maximum runtime for a workspace prepare command. */
// PREPARE_TIMEOUT_MS：工作区准备命令（prepare）的最长运行时间。
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
// 瞬态错误（网络/模型提供方抖动）的最大重试次数，与回合恢复前的首退避时长。
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** How long a worker's background work may run on after its turn ended before it is stopped and the worker reported waiting. */
// BACKGROUND_LIMIT_MS：回合结束后，worker 的后台工作（shell 作业/subagent）最多还能跑多久，超时会被停掉。
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** How long a host stop waits for the workers' background work to stop. */
// SHUTDOWN_STOP_MS：宿主停止时等待各 worker 后台工作停下的时间。
const SHUTDOWN_STOP_MS = 10_000
/** How long a worker that goes on after a passing failure waits for a worker slot, or for processing to resume, between looks. */
// SLOT_WAIT_MS：瞬态失败后继续的 worker，在等 worker 槽位或等处理恢复时的轮询间隔。
const SLOT_WAIT_MS = 5000
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
// fromPerson：一个 Input 是否来自真人——非上下文类 human trigger，或直接的文本输入（如状态请求）。
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * Internal error thrown when a ticket's workspace prepare command fails during launch.
 * DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
 */
// PrepareFailed：launch 期间工作区准备命令失败抛出的内部错误。
// 不自动重试：目录已存在即视为"已准备好"，自动重试会把失败命令留下的残当成就绪工作区——
// 所以直接把 Ticket 标记为 failed，等真人消息或人工重试。
class PrepareFailed extends Error {}
// PASSING：判定"瞬态错误"的正则——连接类错误码、socket/fetch 错误、过载/限流词、408/429/5xx 状态码。
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
 * connection that was refused, reset, timed out, or could not resolve its host.
 */
// transient：判断一个错误是否为可重试的瞬态网络/模型提供方失败——
// 带数字 status 时按 408/429/5xx 判断；否则把 error 名、消息、code 拼起来过 PASSING 正则。
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
// ticketWorktreeName：校验过的英文 worktree 名后接 12 位 Ticket id 后缀，保证全局唯一且稳定。
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Host dependencies used by `DshExecutor`. */
// ExecutorHost：DshExecutor 依赖的宿主能力（窄接口，依赖倒置）。
export interface ExecutorHost {
  /** DSH Cordis context: agents and their events, and the subprocess service used to run prepare commands. */
  // Cordis 上下文：agent（会话）及其事件、运行 prepare 命令用的子进程服务。
  readonly context: Context
  /** Where the Executor reports what happened to Assignments and Inputs. */
  // engine：Executor 向领域汇报 Assignment/Input 事实的通道（角色化接口）。
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** Durable effect queue through which launches and input deliveries run. */
  // effects：持久化副作用队列——launch 与 delivery 都经由它执行（重启后可恢复）。
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  // health：`worker` 健康条目——后台事件处理失败时上报。
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  // lifetime：宿主生命周期的 AbortSignal，停机时所有等待都会感知。
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  // sessions：worker 会话管理，以及向主会话转发 worker 报告。
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  // closing：宿主是否正在关闭（关机期间不再重试、不再启动）。
  closing(): boolean
  /** Whether processing is paused, which holds launches and input deliveries. */
  // paused：处理是否被暂停（暂停时 launch/delivery 一律挂起）。
  paused(): boolean
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  // environment：Ticket 的执行环境变量（传给 prepare 命令）。
  environment(ticket: Ticket): Variable[]
  // sourceLink：Trigger 的来源消息链接（发送给 worker 用）。
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  // repliedTo：`trigger` 所回复的那条消息的存储 Trigger。
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** Looks up a ticket's origin trigger in Store. */
// sourceTrigger：从 Store 查 Ticket 的源 Trigger（发起它的那条）。
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
// mandateInstructions：给 worker 的额外 Mandate 指令——
// inferred（规则推断出的主动工作）只允许规则范围内的小型内部改动；
// explicit（明确请求）不需要额外限制，返回空串。
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
// ticketExecution：为新接受的 Ticket 生成执行元数据——worktree 短名、工作区目录、任务说明文本。
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  // 路由备注（主会话的路由说明）不是源请求，文本里明确标注。
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  // 找出接受时所依据的规则全文——inferred 工作要按规则的流程与沟通指示执行。
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  // 源 Trigger 会随任务一起送达（见 launch），所以 assignment 文本不重复 Trigger 内容；
  // inferred 任务写明接受的规则与范围。
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
// ASSIGNMENT_CHARS / TRIGGER_CHARS：worker 消息里任务说明与 Trigger 文本的内联字数上限；
// 超长的部分让 worker 通过资源（resource）读取。
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
// capped：截断到 limit 字符；截断时附总字数 chars 与全文资源路径 read。
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
// triggerMessage：把 Trigger 格式化为投递给 worker 的卡片——
// 作者、Thread、时间、截断文本、来源链接、路由备注，以及（worker 没见过时）所回复消息的预览。
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
// batchLine：同批其余 Trigger 的一行摘要（作者/时间/160 字预览/全文资源路径）。
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
// batchOf：Ticket 接受批次中除 primary 外的其余 Trigger（按批次顺序）。
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
// RESUMED：恢复说明——Ticket 曾结束、被 Thread 上的消息在原授权下唤醒；
// 指示 worker：范围内就续做，超范围就退回（handback）并报 dropped，无事可做（如感谢）也报 dropped。
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
// RETRIED：人工重试后的说明——从当前 worktree/git/PR 状态继续。
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
// policyMessage：把策略变更格式化为给 worker 的说明；effect 字段出现之前的旧输入给通用提示。
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Resource path under which a worker session reads the full text of a ticket input. */
// inputResource：worker Session 读取某 Input 全文所用的资源路径。
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
// inputMessage：把各类 Input 渲染成投递给 worker 的消息文本——
// trigger（经 triggerMessage，或退化为 id+资源路径）、policy-changed、resumed、note（标注"仅上下文"）、text 原文。
// 旧的 reopen 输入返回 undefined（迁移已把待投递的 reopen 转成了 text）。
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  // 上下文订阅来的 Trigger 打上 context 标记——worker 得知这不是点名给它的工作。
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
// WorkerSlots：worker 并发槽位管理——
// 一个 Ticket 在以下期间持有槽位：worker 回合运行中、回合结束后 shell 作业/subagent 仍在跑、launch/wake 启动中。
// 槽位在 await 之前同步预留，避免两个启动抢走最后一个槽位；
// 真人追问（by='person'）允许超额用一个槽位——人的消息永远不必排在新建 worker 后面。
export class WorkerSlots {
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  // starting：当前持有启动槽位的 Ticket → 启动类型（launch 新建 / wake 唤醒 / person 真人唤醒）。
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
   * @param max - Returns the configured maximum number of concurrent worker slots.
   */
  // running：哪些 Ticket 的 worker 正持有槽位（回合或后台工作中）；max：配置的最大并发 worker 数。
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** Number of slots currently in use across running workers and starting reservations. */
  // used：当前占用的槽位数（运行中的 + 启动预留的，按 Ticket 去重）。
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  // launches：还能接受多少并发 launch——总槽位减去被运行中 worker 与 wake 预留占用的。
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free.
   */
  // reserve：为 Ticket 预留启动槽位（幂等）；真人唤醒可超额；
  // 没有空槽则抛 Later（效果队列的"稍后再来"，不计失败）。
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  // free：worker 跑起来或启动尝试结束后，释放预留槽位。
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/**
 * Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
 * `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
// DshExecutor：在"每个 Ticket 一个常驻 worker Session + 隔离目录"中执行 Assignment。
// launch 与投递经 Effects 排队（重启可恢复）；并发用 WorkerSlots 管理；
// 监听 Cordis 的 agent/status、agent/inbox/claimed、session/event、agent/error 事件，
// 并把状态变化回报给 Engine。prepare/launch/deliver/stop/resume 都由它完成。
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  // transient：瞬态失败已试次数——worker 回合按 assignment.id 记，launch 按 `launch:<assignment.id>` 记。
  private readonly transient = new Map<string, number>()
  /** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
  // resuming：正在等待退避定时器以恢复回合的 Assignment id 集合。
  private readonly resuming = new Set<string>()
  /**
   * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  // settling：对"已空闲 worker 的后台工作"的查看（每 Ticket 一个），查看期间持有其槽位；
  // worker 再跑起来或 Assignment 结束时结束。
  private readonly settling = new Map<string, AbortController>()
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  // stopping：正在执行的"停后台工作"（每 Ticket 一个）；该 Ticket 的 launch/delivery 要等它完成。
  private readonly stopping = new Map<string, Promise<void>>()
  /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
  // left：worker 移交给人后留下的作业（如给人用的本地服务器），及其结束的收集器。
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** When a person's message typed into a worker's Session last started a turn, by ticket. */
  // personal：最近一次"人在 worker Session 里打字开启回合"的时间（每 Ticket）。
  private readonly personal = new Map<string, string>()
  /** The timers of workers that go on after a passing failure, which dispose clears. */
  // timers：瞬态失败后重试的定时器集合；dispose 时统一清除。
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  // 构造：注册 launch 与 delivery 两个 effect 处理器；处理暂停时并发上限为 0（全部挂起）。
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    // Each launch reserves a worker slot so launches run concurrently while slots are free.
    // launch：并发上限 = 空闲槽位数；重试 5s 起指数退避至 300s。
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    // delivery：并发 4；quiet=true——投递失败记录在 Ticket 上，不占用 delivery 的健康条目。
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  // prepare：Engine 的 prepareTicket 钩子——为新接受的 Ticket 填 execution（worktree 名/目录/任务说明）。
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /**
   * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
   * execution environment variables, then verifies the directory as the worker sees it.
   * A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
   * @throws PrepareFailed with the command's output when the prepare command fails.
   */
  // prepareDirectory：为新 Ticket 的工作区跑配置的 prepare 命令（在其父目录、带执行环境变量），
  // 然后以 worker 的视角校验目录。失败抛 PrepareFailed（不自动重试）；
  // 留下的空目录会被删除，非空目录保留（输出里说明了里面是什么）。
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
    // 超时用 AbortSignal：prepare 卡住（比如等凭据输入）时失败并释放，而不是无限占着 worker 槽位。
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
        // 删除失败命令留下的空目录——否则重试会误判"已准备好"。（目录非空时保留，rmdir 会失败，忽略。）
        await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  // start：为新接受或恢复的 Assignment 入队一个 launch effect——槽位空闲时按队列顺序启动。
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  // deliver：入队一个 delivery effect，把待投递的 Input 送进运行中的 worker Session。
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  // launchQueued：执行排队的 launch——Ticket 已结束或被更新 Assignment 取代则跳过。
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    // 校验：Ticket 存活、Assignment 仍是最新且 pending——陈旧的 launch 直接放弃。
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    // 同步预留槽位（避免两个启动抢最后一个），结束后释放。
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // Shutdown or pause re-queues the launch for resume, and transient network/provider errors retry with backoff.
      // A failed prepare command is not retried automatically because an existing directory counts as prepared, so retrying
      // would treat whatever a failed prepare command left behind in the directory as a prepared workspace; instead the
      // ticket is marked failed and waits until new human input or an explicit retry arrives.
      // 关机/暂停：抛回 Later 由效果队列重排；瞬态网络/提供方错误：退避重试；
      // prepare 失败：不自动重试（目录存在即视为已就绪，重试会把残留当成就绪）——
      // Ticket 标记 failed，等新的真人输入或人工重试。
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  // deliverQueued：把排队的 Input 逐条送进运行中的 Assignment——
  // 每条投递前重读 Ticket 状态：Ticket 结束或被其他 Assignment 接管就立即停。
  private async deliverQueued(ticketId: string): Promise<void> {
    // A stop of the worker's background work ends with a cancel, which would drop what is delivered meanwhile.
    // 若该 Ticket 的后台工作正在停止（结束时带取消），先等它完成——否则期间投递的东西会被取消丢掉。
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        // 每轮都重读最新状态（投递期间一切可能变化）。
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        // 唤醒空闲 worker 需要预留槽位（真人消息用它的专属超额槽位）。
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          // 判断队首待投递里有没有真人消息——有则用 person 类型预留（可超额、优先于新建 launch）。
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          // Recreate the worker session if it was externally deleted.
          // worker Session 被外部删掉了：重建一个。
          if (!this.host.context.agents.get(sessionId as SessionId)) {
            await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker')
          }
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          // 关机/Later 抛回重排；否则记投递失败到 Ticket 上，并继续抛（由效果队列重试）。
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        // 单条送达即回报（逐条确认，失败定位到条）。
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  // deliverInput：投递单条 Input——渲染消息文本，超长则包成带读取路径的 JSON 预览，用 steer 方式送入会话。
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    // live：送进会话前的最后一道校验（等待 sourceLink 期间 Ticket 可能已结束/被接管/后台在停）。
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      // A stop of the worker's background work that started meanwhile ends with a cancel, which would drop the Input.
      // 后台停止刚开始：抛 Later 稍后再送（停止以取消收尾，会丢掉送进来的东西）。
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    // 'steer'：直接注入当前回合；live 作为前置校验在真正发送前再跑一次。
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  // triggerCard：为 worker 格式化 Ticket 上的一个 Trigger 卡片；
  // 它回复的父消息若 worker 没见过（不是源 Trigger、也不在其 Inputs 里），附带预览。
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
   * report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
   */
  // stop：结束某 Assignment 的工作——在结束事务提交之后才执行（afterCommit）：
  // 回滚则 worker 继续干活；同事务里排队的 launch 也在此之后才启动。
  // 步骤：结束后台查看；除非最后的话是 ready/dropped 且之后没送过新 Input（ownTurn），取消其回合；
  // 停其 shell 作业与 subagent（包括移交给人留着的作业）。
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    // busy：报告之后又投递过 Input——worker 还在消化新输入。
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      if (!ownTurn) this.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
      // Its shell jobs and subagents stop with it, also those of a worker that ends its own turn.
      // 无论如何，shell 作业与 subagent 都随 Assignment 一起停。
      this.stopWork(ticket.id, reason)
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /** Stop what a ticket's worker runs in the background (see `stopBackground`). */
  // stopWork：停掉该 Ticket worker 的后台工作（经 background.stopBackground），并纳入 stopping 跟踪。
  private stopWork(ticketId: string, reason: string, keepInbox = false): void {
    this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox))
  }
  /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
  // track：登记一次后台停止（链上之前未完的停止），期间 launch/delivery 会等它；完成自清。
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    // 后台跑，不阻塞调用方；失败进 worker 健康条目。
    void this.background(stop)
  }
  /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
  // stopped：等正在进行的后台停止完成（宿主停止则不等）。
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /**
   * On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
   * of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
   */
  // shutdown：宿主停止时（限时 SHUTDOWN_STOP_MS）——
  // 停掉每个已加载 worker 的后台工作（保留收件箱）；结束"移交给人"作业的收集（它们已被杀）；
  // 取消期间又跑起来的 worker 回合（保留收件箱）。
  async shutdown(): Promise<void> {
    const agents = this.host.store.tickets.list().map(ticket => this.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
      .filter((agent): agent is Agent => agent !== undefined)
    const stop = async () => {
      await Promise.allSettled(agents.map(agent => stopBackground(this.host.context, agent.id, 'dsh-superagent stopped', true)))
      for (const { collect } of this.left.values()) collect.abort()
      const running = agents.filter(agent => agent.status !== 'idle')
      for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(running.map(agent => agent.whenIdle()))
    }
    await until(stop(), undefined, SHUTDOWN_STOP_MS)
  }
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
  // activeCount：占用 worker 槽位的存活 Ticket 数——面板显示执行负载用。
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  // running：该 Ticket 的 worker 是否占着槽位——回合运行中，或回合结束后后台查看（settling）仍在。
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  // launchFailed：launch 失败后把 Ticket 标记 failed——等新的真人输入或人工重试。
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  // failed：一个事务内：记 failed 报告 + 把失败转发给主会话。
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  // relay：把通知交给 Sessions 转发（入队 relay effect）。
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  // launch：真正启动一个 Assignment——准备目录、确保 worker Session、投递任务消息。
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    // current：贯穿整个启动过程的"授权校验"——关机/暂停/失活/被接管都会让启动静默放弃。
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // Prepare the workspace directory once; an existing directory counts as already prepared, including worktrees created before `prepare` commands existed.
    // 目录只准备一次：已存在的目录视为已就绪（兼容 prepare 机制出现之前建的 worktree）。
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) return
    // The background work of the Assignment this one replaces stops first, so its end does not clear this one's message.
    // 被替换 Assignment 的后台工作先停完——它的收尾（取消）不会清掉本次要投的消息。
    await this.stopped(ticket.id)
    if (!current()) return
    // A message put back for this Assignment may still wait in the Session, kept by a restart's cancel or persisted across a
    // crash, where this launch's message would take it into a step beside the copy delivered next: that copy is the only one.
    // 清掉 Session 收件箱里"为本 Assignment 放回去"的旧消息副本（重启取消/崩溃遗留）——
    // 否则它会和接下来投递的正式副本一起进入步骤；正式投递的那份才是唯一份。
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    // 首条消息带完整任务与源 Trigger；后续 Assignment 只说增量——
    // 除非 Session 丢了首条消息（比如被人为删除），那就要重讲一遍。
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    // 组装任务消息 JSON：首个带 title/assignment/trigger 卡/批次；后续只带 assignment 序号（与重试说明）。
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    // requestId：首个 Assignment 用稳定 id（幂等），后续按 Assignment 区分。
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    // 'queue'：排队发送；发送前与实际送达后各跑一次回调（授权校验 / 上报 assignmentStarted）。
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
  // ticketOf：agent 是否为 worker 会话；是则返回其 Ticket。
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
  // install：订阅宿主的四类事件（启动时调用一次）——worker 状态、人工收件、消息入步、错误。
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // A turn that starts ends the look at its worker's background work; the turn's own idle looks afresh.
      // 回合开始：结束之前的后台查看（settle）；回合自己结束时会重新查看。
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // The turn a stop of the worker's subagents woke and cancelled is no turn of the worker's.
      // 释放 subagent 时被唤醒又取消的回合不算数（cancelled 集合过滤）；关机期间不处理。
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      // worker 空闲：后台查看其作业与 subagent（见 workerIdle）。
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
    }))
    // A person's message typed into a worker's Session, which the ticket does not record.
    // 人在 worker Session 里直接打字（领域里不记录这种消息）——记下时间，供 workerIdle 判断"这是人的回合"。
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // The Inputs a message of dsh-superagent's carries, which its worker reads once the Session took the message into its
    // history: a step that claimed it may be cancelled or fail before, which drops it.
    // session/event 的 user/message：dsh-superagent 发的消息已被 Session 纳入历史——
    // 此时其携带的 Inputs 算"已读"（此前认领步骤可能被取消或失败，那就不算）。
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        // 找出"消息 id 匹配、还没记 readAt"的 trigger Inputs，回报已读。
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
          && this.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return
      // 瞬态错误：安排退避重试（恢复回合）；其他错误：直接把 Ticket 标记 failed。
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
    }))
  }
  /** Unsubscribes from host agent events and clears any pending transient-retry timers. */
  // dispose：退订事件、清掉待触发的重试定时器。
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  // resume：宿主重启后的对账——
  // 正在运行的 Assignment：报 interrupted（Engine 决定重启或补投）；
  // pending 的：重新入队 launch（旧版本可能没走效果队列）；failed 且等人的：继续等。
  resume(): void {
    // Launch pending tickets oldest first (in acceptance order).
    // 按接受时间从旧到新启动，保持接受顺序。
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        // A restart within this process left DSH's Sessions, jobs and subagents running: they stop first. The inbox keeps an
        // Input that was handed over but not yet taken.
        // 进程内重启：DSH 的 Session/作业/subagent 还在——先停（保留收件箱里"已移交未读取"的 Input）。
        this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent restarted', true)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      }
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  // background：在后台跑 worker 事件处理；失败写 health error，恢复后写回 ready。
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  // retries：判断错误是否瞬态、重试额度是否还有——是则计数 +1 并返回 true（要重试）；
  // 非瞬态或额度用尽则清除计数并返回 false。
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  // resumeAfter：瞬态错误后按指数退避重试 worker 回合——
  // 给它发一条"上回合因瞬态原因失败，继续任务"的消息。
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      // Ticket 已结束或被接管：放弃重试。
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // Wait while processing is paused or no wake slot is free.
      // 暂停中或没有唤醒槽位：过 SLOT_WAIT_MS 再看。
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      const sessionId = workerSessionId(ticketId)
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    // 退避时长：15s * 2^(n-1)。
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
  // after：安排延时回调；dispose 后不再触发；unref 使定时器不阻止进程退出。
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
   * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
   */
  // handOff：worker 移交给人后释放槽位——
  // 停其 subagent；其 shell 作业（比如给人用的服务器）留给人，直到 Assignment 结束。
  // 这些作业不占槽位、不受限时；结束被"收集"，不会在槽位外唤醒 worker；
  // 每个的结局会在 worker 下一回合通知它。
  private handOff(ticketId: string, agent: Agent): void {
    this.track(ticketId, stopSubagents(this.host.context, agent, true))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended) return
        // 作业结束：注入一条说明（不唤醒 worker，收件箱注入）。
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  // workerIdle：worker 回合结束后的收尾——判断是"移交给人"还是"后台等待"，并落实报告。
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
    await agent.whenIdle()
    // A turn that failed for a passing reason goes on after its backoff, which is no end of the turn.
    // 正在等待瞬态重试的回合不算结束。
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // A turn that ended as turns do starts the count of passing failures again.
    // 回合正常结束：瞬态失败计数清零。
    this.transient.delete(idle.id)
    // The ticket while the Assignment that went idle runs it.
    // live：Assignment 仍运行、Ticket 仍存活时的最新 Ticket。
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person;
    // an Input delivered after its result or question is new work.
    // handedOff：worker 是否已把工作移交给人——
    // 最后的话是结果（ready）、或有待回答问题、或 blocked/failed 等人，且之后没有新 Input 送达。
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // A turn a person started in the Session is the person's work, which goes on in the background as any turn's does.
    // person：最近一次人在 Session 里打字的时间——人开启的回合也照常等后台。
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // The worker read what reached it before a turn that ended: one it handed off with, or one whose background work ended.
    // 已移交（且不是人刚开的新回合）：回合结束，释放槽位并按移交处理。
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile: at most for the limit from
    // this idle, and until the worker runs again or the Assignment ends.
    // 回合的真正结束要等后台安静——期间占着槽位：至多 BACKGROUND_LIMIT_MS（从本次 idle 起），
    // worker 再跑起来或 Assignment 结束则提前结束。
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    // worker 复活/被中止/超时但还有后台在跑/Ticket 变化/等待重试：不再往下走。
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(idle.id)) return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // Its shell jobs that ran past the limit are killed, which it is told at its next turn; its subagents, whose stop would
      // wake it, go on.
      // 超时的 shell 作业被杀（下一回合通知 worker）；subagent 停止会唤醒 worker，所以随它去。
      const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name)
      if (jobs.length) {
        void this.background(killJobs(this.host.context, sessionId, 'The job ran past its limit', left))
        const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`
        void this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }))
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
    // 回合收尾期间 worker 可能已报告；被真人消息解除的 blocked/failed 是陈旧状态——移交判断以当前为准。
    if (handedOff(current)) return
    // 取 worker 最后一条 assistant 消息的文本，与超时说明拼接，作为 waiting 报告的摘要。
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      // orchestrator_report 之后的收尾不算新状态；也避免空的移交通知。
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
  }
}
