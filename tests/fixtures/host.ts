/**
 * In-memory DSH host fixture (as in tests/runtime.spec.ts) running a configured Runtime with GitHub and Feishu sources,
 * allowed member Alice (`ou_alice`), listened chat `oc_team`, and `auto` eval mode. Stop it with `stop()`.
 */
// 内存版 DSH 宿主 fixture（与 tests/runtime.spec.ts 同法）：起一个配置好的 Runtime，
// 带 GitHub 与飞书来源、已放行成员 Alice（ou_alice）、监听群 oc_team，评估模式为 auto。
// 用 stop() 收尾。供 runtime-concurrency.spec.ts 等并发用例复用。
import { Context } from '@deepseek-ai/cordis'
// cordis Context：服务容器，把假服务装进去供 Runtime 取用。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
// 临时目录、清理与放置占位 CLI 文件。
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
// vi：mock 记录器；Mock：mock 函数类型。
import type { UserMessage } from '@deepseek-ai/dsh-llm'
// UserMessage：投给模型的消息。
import { Runtime } from '../../src/app/runtime.ts'
// 被驱动的主对象：Runtime 宿主。
import { Store } from '../../src/app/store.ts'
// Store：预置数据库（seed 参数直接改库）。
import { SettingsSchema } from '../../src/policy.ts'
// SettingsSchema：解析并保存来源设置。
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
// feishuKind：注册飞书来源；feishuTrigger：构造飞书触发器。
import { githubKind } from '../../src/sources/github.ts'
// githubKind：注册 GitHub 来源。
import { Commands } from '../../src/infra/commands.ts'
// Commands：被 spy 的远端命令封装（gh/lark/git/run）。
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'
// credentialHelper/workerGitConfig：worker 的 git 凭据配置（启动检查的应答里引用）。
import type { Trigger } from '../../src/core/index.ts'
// Trigger：来源触发器类型。
import { testMachine } from './deployment.ts'
// testMachine：测试机器信息 fixture。

export const MEMBER = 'ou_alice'
// 基准成员：名单里的飞书用户。
export const CHAT = 'oc_team'
// 基准群：被监听的群聊。

/** Build a Feishu mention trigger from Alice in `oc_team`, using the digits in `id` as the timestamp offset in seconds. */
// 构造 Alice 在 oc_team 群里点名机器人的飞书触发器：id 中的数字作为时间戳的秒偏移。
export function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  const at = String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000)
  // 时间戳 = 基准时刻 + id 的数字部分秒数，决定消息先后。
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: at,
    mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}

type RegisteredTool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
// 已注册工具的最小结构。
type FakeAgent = {
  id: string; status: string; inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  cancel: Mock; inject: Mock<(message: UserMessage) => void>; steer: Mock<(message: UserMessage) => void>; followup: Mock<(message: UserMessage) => void>
}
// 假 agent：收件箱（新回合/下一步两条队列）与投递 mock。
/** A text message, as DSH's job tools and subagents send their notices. */
// 一条文本消息：DSH 的作业工具与子代理发送通知的形态。
const notice = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'tool-jobs', form: 'notice' } }) as unknown as UserMessage
type HttpHandler = (req: unknown, res: unknown) => Promise<void>
// HTTP 路由处理器（直接调用，不监听端口）。
type Delivery = { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }
// 一次投递的记录：哪个 Session、队列还是插入。

/**
 * DSH's job registry as the Executor uses it, with DSH's job tools: the jobs a Session can see, their events, a wait and a
 * kill. `run` starts a job a Session owns, `output` has one print, and `end` ends one, as its process does; an end no wait
 * collected reaches its owner, which it wakes when idle, as the job tools deliver it. `released` counts the waits ends
 * released.
 * @param owner - the agent of a Session, which an end reaches.
 */
// Executor 视角的 DSH 作业注册表，带 DSH 的作业工具：Session 可见的作业列表、事件、wait 与 kill。
// `run` 启动一个 Session 拥有的作业，`output` 让作业打印一次，`end` 像进程那样结束一个作业；
// 没被 wait 收集的结束通知会送达其属主（空闲则唤醒，等价于作业工具的投递）。
// `released` 统计已释放的等待数。
// @param owner - 由 sessionId 取对应 Session 的 agent（结束通知的收件人）。
export function jobRegistry(owner: (sessionId: string) => FakeAgent | undefined = () => undefined) {
  type Job = { id: string; owner: string; status: string; label?: string }
  // 作业条目：id、属主、状态与可选标签。
  const jobs = new Map<string, Job>()
  const listeners = new Set<{ owner: string; listener: (event: { type: string }) => void }>()
  // 作业事件的订阅者（按属主过滤）。
  const waits = new Map<string, ((job: Job) => void)[]>()
  // 每个作业上挂起的 wait 回调。
  let released = 0
  const emit = (job: Job, type: string) => { for (const listener of [...listeners]) if (listener.owner === job.owner) listener.listener({ type }) }
  // 只向作业属主的订阅者发事件。
  const end = (id: string, status = 'completed') => {
    // 结束一个作业：置状态、放行等待者，并把结束通知按 DSH 的方式送达属主。
    const job = jobs.get(id)!
    job.status = status
    const waiting = waits.get(id) ?? []
    waits.delete(id); released += waiting.length
    for (const wake of waiting) wake({ ...job })
    emit(job, 'settled')
    const agent = waiting.length ? undefined : owner(job.owner)
    // 已被 wait 收集的结束不再投递通知。
    const ended = notice(`notice-${id}`, `Job ${id} ended: ${status}`)
    if (agent?.status === 'idle') agent.followup(ended)
    else agent?.inject(ended)
    // 空闲属主走 followup（排队），运行中的走 inject（插入）。
  }
  const service = {
    list: vi.fn((caller: string) => [...jobs.values()].filter(job => job.owner === caller)),
    // list 只给调用者自己的作业。
    // A wait ends with the job, or fails once its signal aborts, which leaves the job's end uncollected.
    // wait 随作业结束而结束，或在其信号中止时失败（中止会把它的等待移除，作业结束即“未被收集”）。
    wait: vi.fn((id: string, _timeoutMs: number, _caller: string, signal?: AbortSignal) => new Promise<Job>((resolve, reject) => {
      const wake = (job: Job) => { signal?.removeEventListener('abort', abort); resolve(job) }
      const abort = () => { waits.set(id, (waits.get(id) ?? []).filter(item => item !== wake)); reject(new Error('wait aborted')) }
      waits.set(id, [...waits.get(id) ?? [], wake])
      signal?.addEventListener('abort', abort, { once: true })
    })),
    // A killed job ends a moment later, as its process does, also under a test's fake timers.
    // 被杀的作业稍后像其进程那样结束——在测试的假定时器下同样成立（用微任务排队）。
    kill: vi.fn((id: string) => { queueMicrotask(() => { end(id, 'killed') }); return 'requested' }) as Mock<(id: string) => string>,
    events: { subscribe: (filter: { owner: string }, listener: (event: { type: string }) => void) => {
      const entry = { owner: filter.owner, listener }
      listeners.add(entry)
      return () => { listeners.delete(entry) }
    } },
    // 事件订阅：返回取消订阅的函数。
  }
  return { service, end, output: (id: string) => { emit(jobs.get(id)!, 'output') }, get released() { return released },
    run: (owner: string, label?: string) => { const id = `bash-${jobs.size + 1}`; jobs.set(id, { id, owner, status: 'running', label }); return id } }
  // run：登记一个运行中的作业并返回 id；output：只发一次 output 事件。
}

/**
 * DSH's subagents as the Executor uses them. `spawn` starts a child of a Session, an agent while it lives, which a drain of
 * the Session's descendants refuses from then on; `settle` ends one, whose end wakes its idle parent or steers a running one
 * before a wait for the parent's children returns. Releasing or interrupting a child settles it; a drain of descendants
 * injects their ends. The catalog lists every child a Session had.
 */
// Executor 视角的 DSH 子代理。`spawn` 给 Session 生一个孩子（活着即一个 agent），
// 之后对该 Session 后代的 drain 会拒绝新的 spawn；`settle` 结束一个孩子——
// 其结束会唤醒空闲的父会话或插给运行中的父会话，然后父会话的 waitForChildren 才返回。
// 释放或打断孩子都会 settle 它；drain 后代会把他们的结束注入父会话。
// 目录（listChildren）列出 Session 有过的每个孩子。
export function subagentRuntime(agents: Map<string, FakeAgent>) {
  const children = new Map<string, { parent: string; live: boolean; settled: PromiseWithResolvers<void> }>()
  // 孩子：属主、是否存活、以及 settle 时才 resolve 的承诺。
  const closed = new Set<string>()
  // 已被 drain 关闭、不再收孩子的父会话。
  const settle = (id: string, wake = true) => {
    // 结束一个孩子：从 agent 表摘除，结束通知送达父会话（空闲唤醒 / 运行插入 / 不唤醒则注入）。
    const child = children.get(id)
    if (!child?.live) return
    child.live = false
    agents.delete(id)
    const parent = agents.get(child.parent), ended = notice(`settled-${id}`, `Subagent ${id} settled`)
    if (!wake) parent?.inject(ended)
    else if (parent?.status === 'idle') parent.followup(ended)
    else parent?.steer(ended)
    child.settled.resolve()
  }
  const service = {
    waitForChildren: vi.fn(async (parent: { id: string }) => {
      // 等父会话所有活着的孩子 settle；有孩子时返回 true。
      const live = [...children.values()].filter(child => child.parent === parent.id && child.live)
      await Promise.all(live.map(child => child.settled.promise))
      return live.length > 0
    }),
    listChildren: vi.fn(async (id: string) => [...children].filter(([, child]) => child.parent === id).map(([childId]) => ({ id: childId }))),
    drainChildren: vi.fn(async (_parent: { id: string }, ids: readonly string[]) => { for (const id of ids) settle(id) }),
    // 逐个 settle 指定的孩子（带唤醒）。
    drainDescendants: vi.fn(async (parents: readonly { id: string }[]) => {
      // 关闭父会话（不再收孩子）并 settle 其孩子（不唤醒，改为注入结束）。
      for (const parent of parents) {
        closed.add(parent.id)
        for (const [id, child] of children) if (child.parent === parent.id) settle(id, false)
      }
    }),
    interrupt: vi.fn((id: string) => { settle(id) }),
    // 打断即 settle。
  }
  const spawn = (parent: string) => {
    // 生一个孩子：登记并放一个“运行中”的假 agent 进表。
    if (closed.has(parent)) throw new Error('DRAINING: the Session admits no new subagents')
    const id = `child-${children.size + 1}`
    children.set(id, { parent, live: true, settled: Promise.withResolvers<void>() })
    agents.set(id, { id, status: 'running', session: { header: { parentSession: parent } } } as never)
    return id
  }
  return { service, settle, spawn, live: (id: string) => !!children.get(id)?.live }
}

/** @param seed - writes to the database before the Runtime opens it, such as records an earlier version stored. */
// @param seed - 在 Runtime 打开数据库之前写入它，比如塞入旧版本存过的记录。
export async function startRuntime(seed?: (store: Store) => void) {
  // 起一个完整的内存宿主：假 DSH 服务 + 真实 Runtime，返回交互助手集合。
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-host-'))
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  // 磁盘上的占位 CLI：agent 的 gh 与飞书机器人（setup 会先找可执行文件）。
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  // gh 只答 user 与仓库信息；lark 答名单；git/run 空应答。
  const scoped = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'
  const answers: Record<string, string> = {
    // 启动检查子进程的应答表（按 argv）。
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(AGENT)}\0`,
    [scoped]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
    // git 凭据助手应答：worker 的隔离 gitconfig + agent 的助手。
  }
  /** A prepare command (`sh -c`) waits for this while it is set. */
  // 设置了它时，prepare 命令（sh -c）会一直等这个 Promise。
  const hooks: { prepare?: Promise<void> } = {}
  const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
    // 假子进程：剥掉 env/KEY=VALUE 前缀后按 argv 查应答。
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const exited = { exitCode: 0, signal: null }
    const done = argv[0] === 'sh' && hooks.prepare ? hooks.prepare.then(() => exited) : Promise.resolve(exited)
    // prepare 钩子挂起时，sh -c 命令等它结束才退出。
    return { done, collected: { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') } }
  }) }
  const agents = new Map<string, FakeAgent>()
  // 假 agent 注册表（subagentRuntime 与 jobRegistry 共用）。
  /** Each Session's next step, which takes the messages that wait for one. */
  // 每个 Session 的“下一步”：取走等下一步的消息。
  const steps = new Map<string, () => void>(), claims = new Map<string, () => void>()
  // steps：正常取消息；claims：取消息但不入历史（模拟取消发生在取走之前）。
  const tools = new Map<string, Map<string, RegisteredTool>>()
  // 每个 Session 注册的工具。
  const deliveries = vi.fn<(request: Delivery) => void>()
  // 所有投递给 Session 的消息记录。
  let http!: HttpHandler
  const resolveDefault = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const controller = {
    // 假会话控制器：create 装配假 agent（工具/技能/提示词/收件箱/取消语义）。
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const sessionTools = new Map<string, RegisteredTool>()
      tools.set(sessionId, sessionTools)
      const register = (tool: RegisteredTool) => { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) }
      agentCtx.reflect.provide('tools', { register, get: () => undefined, restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        // A pending message taken out, as DSH's inbox does by its id.
        // 待处理消息按 id 被取出，与 DSH 的收件箱一致。
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      // A step claims each message once, all that wait for a step and, as a turn starts, the next queued one, and takes them into
      // the Session's history, unless it is `cut` off before, as a cancel in its pre-step does; DSH says each.
      // 每条消息只认领一次：取走等下一步的全部、回合开始时取排队的第一条，并写入 Session 历史；
      // 若此前被 `cut`（预步骤里的取消）则不进历史——每种情况 DSH 都会发事件说明。
      const taken = new Set<string>()
      let turn = 0
      const take = (starts: boolean, cut = false) => {
        const agent = agents.get(sessionId)!
        const queued = starts ? inbox.nextTurn.filter(message => !taken.has(message.id)).slice(0, 1) : []
        for (const message of [...inbox.nextStep.filter(item => !taken.has(item.id)), ...queued]) {
          taken.add(message.id)
          ctx.emit('agent/inbox/claimed', { agent, message, turn } as never)
          if (!cut) ctx.emit('session/event', session as never, { type: 'user/message', data: message } as never)
        }
      }
      steps.set(sessionId, () => { take(false) })
      claims.set(sessionId, () => { take(false, true) })
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        // 投递：入队（或插入），记录之，并按 DSH 的方式唤醒空闲 agent。
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        // A message wakes an idle agent: its turn starts at once, and DSH says so, and its first step takes what waits.
        // 消息唤醒空闲 agent：回合立即开始（DSH 发状态事件），其首步取走等着的消息。
        const agent = agents.get(sessionId)!
        if (agent.status !== 'idle') return
        agent.status = 'running'
        ctx.emit('agent/status', { agent, status: 'running' } as never)
        turn++
        take(true)
      })
      const session = { id: sessionId, snapshotEvents: () => [], requestHeader: () => undefined, append: vi.fn() }
      let status = 'idle'
      const idle: (() => void)[] = []
      // A cancel drops the inbox unless kept, and the turn it stops ends a moment later, which DSH says.
      // 取消默认清空收件箱（除非 keepInbox），它停掉的回合稍后结束，DSH 会发空闲状态事件。
      const cancel = vi.fn((_cause: unknown, options?: { keepInbox?: boolean }) => {
        if (!options?.keepInbox) { inbox.nextTurn.length = 0; inbox.nextStep.length = 0 }
        if (status === 'idle') return
        queueMicrotask(() => {
          const agent = agents.get(sessionId)!
          if (agent.status === 'idle') return
          agent.status = 'idle'
          ctx.emit('agent/status', { agent, status: 'idle' } as never)
        })
      })
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), inject: vi.fn(), session, cancel,
        get status() { return status }, set status(next: string) { status = next; if (next === 'idle') for (const wake of idle.splice(0)) wake() },
        // Once its turn ended, as DSH's does.
        // whenIdle：回合结束后（像 DSH 那样）兑现等待者。
        whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise<void>(resolve => { idle.push(resolve) }) } as never)
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(resolveDefault), rename: vi.fn(async () => {}),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }),
    // 插件投递不得走用户 RPC：prompt 直接抛错。
    inspect: vi.fn(async () => ({ events: [] })),
  }
  const reader = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
  const persistence = { flush: vi.fn(async () => {}), open: vi.fn(async () => reader) }
  // 空持久化：flush 无操作，open 给一个空事件 reader。
  const webServer = { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return () => {} } }
  // webServer：记下 Runtime 注册的处理器，供 api() 直接调用。
  const jobs = jobRegistry(id => agents.get(id))
  const subagents = subagentRuntime(agents)
  const services = { agents, llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) }, sessionController: controller,
    sessionPersistence: persistence, workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess, webServer,
    jobs: jobs.service, subagents: subagents.service }
  // 全部假服务装进服务表，再注入 cordis 容器。
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  // 写出占位 CLI 文件（可执行），让 setup 的“找可执行文件”通过。
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }, feishu: { enabled: true, config: { cli: BOT } } }
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), sources }))
  seed?.(seeded)
  seeded.close()
  // 预置两来源并允许调用方 seed 再补数据，然后关库交给 Runtime。
  const runtime = new Runtime(ctx, testMachine({ stateDir: directory }), vi.fn())
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  // 等就绪后注册两个来源 kind。
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { ...sources, feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
  // 默认策略：评估 auto、名单放行 Alice/alice、飞书监听群聊全量 + 私聊。
  deliveries.mockClear()

  /** Parsed JSON payloads delivered to `sessionId`. */
  // 投递给某 Session 的 JSON 载荷（已解析）。
  const relays = (sessionId: string) => deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
    .map(call => JSON.parse(call.text) as Record<string, unknown>)
  const candidates = () => relays(runtime.masterId).filter(item => item.kind === 'candidate').map(item => item.trigger_id)
  // 主 Session 收到的候选卡的触发器 id 列表。
  const runTool = async (sessionId: string, name: string, args: unknown) => {
    // 调用某 Session 上注册的工具。
    const tool = tools.get(sessionId)?.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
    return await tool.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
  }
  /** Route one decision with the main Session's orchestrator_route, answering its result; a refused one throws its reason. */
  // 用主 Session 的 orchestrator_route 走一条决策：返回其结果；被拒的抛出理由。
  async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    return results[0]!
  }
  async function acceptedTicket(trigger: Trigger) {
    // 标准前置：投递触发器、受理成工单并等派工完成。
    runtime.receive(trigger)
    await runtime.idle()
    const result = await route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' })
    await runtime.idle()
    const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    return { trigger, ticket, sessionId: `worker-${ticket.id}` }
  }
  async function api(method: string, path: string, json?: unknown) {
    // 直接调用 webServer 路由（带可选 JSON 请求体），不需要真实端口。
    let status = 0, text = ''
    const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  async function stop() { await runtime.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  // 停掉 Runtime、还原全部 mock 并清理临时目录。
  /** The Session's model takes its next step, which takes the messages steered in since its last. */
  // 让 Session 的模型走下一步：取走自上次以来插入（steer）的消息。
  const step = (sessionId: string) => { steps.get(sessionId)!() }
  /** A step of the worker claims what waits for it, and is cut off before the Session took it. */
  // worker 的一步只认领等它的消息，且在 Session 取走之前就被切断（不进历史）。
  const claim = (sessionId: string) => { claims.get(sessionId)!() }
  return { runtime, ctx, directory, agents, tools, deliveries, relays, candidates, runTool, route, acceptedTicket, api, controller, subprocess, hooks, resolveDefault, stop,
    jobs, subagents, step, claim }
}
export type Host = Awaited<ReturnType<typeof startRuntime>>
// Host：startRuntime 返回的宿主句柄类型。
