/** Application composition root and lifecycle manager for dsh-superagent. */
// dsh-superagent 的应用组装根（composition root）与生命周期管理器：在此装配全部服务并管理启动与停机。
// Service / Context：cordis 服务基类与上下文类型
import { Service, type Context } from '@deepseek-ai/cordis'
// Agent：DSH agent 类型；SessionId：会话 id 类型
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
// 以下数行为 type-only 空导入：仅声明对 DSH 各服务（API 会话控制器、会话持久化、工作区、权限预设、系统提示词、工具、技能、子进程）的类型依赖
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
// lockSync：进程间同步目录锁
import { lockSync } from 'proper-lockfile'
// Engine：核心引擎；key 内部键；reasonText 原因码转文本；类型：EngineForSettings、ReceiveResult、Ticket、Trigger
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
// allowedSender / settingsPolicy：发送者准入与策略构造
import { allowedSender, settingsPolicy } from '../policy.ts'
// SourceRegistry：数据源注册表（类）
import { SourceRegistry } from '../sources/registry.ts'
// Commands：命令执行器（类）
import { Commands } from '../infra/commands.ts'
// Deployment / Machine：部署与宿主机器信息类型
import type { Deployment, Machine } from '../deployment.ts'
// environmentOf / ticketEnvironment：环境变量汇总；Variable：环境变量类型
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
// SetupProblem：setup 问题类型
import type { SetupProblem } from '../setup.ts'
// DshExecutor：worker 执行器；sourceTrigger 取工单来源触发器；triggerMessage 渲染触发器消息；workerSessionId worker 会话 id
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
// ticketCard：工单卡片投影
import { ticketCard } from './cards.ts'
// MasterAssessor：主会话评估器
import { MasterAssessor } from './assessment.ts'
// KV：内部键族
import { KV } from '../kv.ts'
// Store：SQLite 持久化存储
import { Store } from './store.ts'
// evalsHealth：评估健康摘要
import { evalsHealth } from './views/overview.ts'
// TextCache：LRU 文本缓存
import { TextCache } from './cache.ts'
// Effects：持久化副作用队列
import { Effects } from './effects.ts'
// Prompts：提示词管理器
import { Prompts } from './prompts.ts'
// registerHttp / HttpHost：管理面板 HTTP 路由注册
import { registerHttp, type HttpHost } from './http.ts'
// LinkTarget：链接解析目标类型
import type { LinkTarget } from './views/records.ts'
// candidateCard / repliedTo / sourceLink / LinkHost：链接解析与候选卡片能力
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
// eventNotice / followupNotice：领域事件通知与触发器跟进通知
import { eventNotice, followupNotice } from './notices.ts'
// pullEndNotices：PR 结束时的渠道通知
import { pullEndNotices } from '../sources/github-pull.ts'
// HealthBoard：健康面板
import { HealthBoard } from '../infra/health.ts'
// Outbox：出站消息投递
import { Outbox } from './outbox.ts'
// Passes：处理轮调度器
import { Passes } from './passes.ts'
// Setup：安装引导
import { Setup } from './setup.ts'
// feishuSettings：飞书设置读取
import { feishuSettings } from '../sources/feishu.ts'
// health 健康条目工厂；Health/SourceContext/SourceHost：数据源宿主相关类型
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
// Sessions：会话管理器
import { Sessions } from './sessions.ts'
// Settings：设置管理器
import { Settings } from './settings.ts'
// sourceContextOf / SourceContextDeps：数据源上下文构建
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
// ResourceHost：资源读取宿主类型
import type { ResourceHost } from './resources.ts'
// mainTools / executorTools：主会话与执行器的工具注册
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
// 数据源插件只通过 `SourceHost` 服务接口与 dsh-superagent 交互（类型增强：把 cordis 上下文上的 orchestrator 服务声明为 SourceHost）
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
// now：当前时间的 ISO 字符串
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
// dsh-superagent 的组装根：连接 Store、Setup、Engine、SourceRegistry、Effects、Outbox、Passes、Sessions、Settings、
// Prompts、DshExecutor 与 MasterAssessor。在 Cordis 上下文上暴露 SourceHost 服务供数据源插件使用，
// 并协调启动、setup 检查、HTTP 路由注册与优雅停机。打开 SQLite 前先锁状态目录，防止并发进程损坏或重复迁移状态。
export class Runtime extends Service implements SourceHost {
  // 以下为装配好的各服务：存储 / setup 引导 / 提示词 / 副作用队列 / 数据源注册表 / 命令执行器 / 会话 / 设置 / worker 执行器 / 评估器 / 出站箱 / 引擎 / 处理轮
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  // ready：初始化完成（或 setup 未就绪而挂起）的 Promise
  readonly ready: Promise<void>
  // 健康面板与 runtime 自身的健康条目
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  // 主会话 id
  readonly masterId: string
  // 触发器来源链接的解析缓存（20 万字符上限）
  private readonly sourceLinks = new TextCache(200_000)
  // 停机/失锁时中止的信号控制器
  private readonly stopped = new AbortController()
  // 各类注销回调（HTTP 路由等），停机时逆序执行
  private readonly disposers: (() => void)[] = []
  // 状态目录锁的释放函数
  private releaseLock?: () => Promise<void>
  // 停机标志
  private closingFlag = false
  // 停机 Promise（幂等 stop 共享）
  private stopping?: Promise<void>
  // 数据源上下文依赖（惰性 getter 引用尚未初始化的成员）
  private readonly sourceDeps: SourceContextDeps
  // 工具宿主（主会话与执行器工具共用）
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  // 大于 0 表示主会话工具正在执行 Engine 命令——抑制由自身动作触发的领域事件通知（防自环）
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    // 以 orchestrator 为服务名初始化基类
    super(ctx, 'orchestrator')
    // runtime：闭包内引用 this（供下方尚未初始化成员的惰性 getter 使用）
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    // 打开数据库前先建好状态目录（权限 0700）并加锁，防止另一进程并发迁移或写入
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    // compromised：目录锁被破坏（另一进程介入）时的处理——标记健康错误并触发停机信号
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    // 获取状态目录锁（陈旧锁阈值 30 秒）
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    // 把释放函数包装为 async（统一 releaseLock 类型）
    this.releaseLock = async () => { release() }
    // opened：记录已打开的 Store，初始化失败时需要关闭它
    let opened: Store | undefined
    try {
      // report：把存储层错误降级为警告日志（单条错误不应令整个进程崩溃）
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      // 打开 SQLite 存储
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      // 安装引导
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      // deployed：setup 完成后汇总当前环境变量（否则 undefined——提示词中显示"等待 setup"）
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      // feishu：是否已配置飞书机器人
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      // 提示词管理器：依赖字符上限、环境变量与飞书开关
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      // 主会话 id：优先取存储中的，否则由状态目录路径派生一个稳定 id
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      // 持久化主会话 id
      store.set(KV.runtime.masterId, masterId)
      // 命令执行器：部署信息与命令环境均来自 setup
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      // 副作用队列
      const effects = this.effects = new Effects(store, board)
      // 数据源注册表：设置读取器 + 健康面板 + 插件动态加载回调
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        // 数据源插件动态加载时，等启动完成后同步其成员列表（若该种类可同步）
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      // 链接解析宿主
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      // link：便捷封装（触发器 → 来源链接）
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      // environment：某工单的执行环境变量
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      // 资源宿主（分页缓存 400 万字符上限）
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      // 会话管理器：主会话注册 mainTools，worker 会话注册 executorTools
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      // policyChanged：引擎策略变化回调（供 Settings 经受限接口调用引擎）
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      // 设置管理器
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      // worker 执行器（engine 用惰性 getter，因为 engine 在其之后才创建）
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      // 主会话评估器
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      // 出站消息投递
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      // policy：由当前设置构造引擎策略
      const policy = () => settingsPolicy(store.settings(), sources)
      // 核心引擎：接收入触发器、准备派工，并在领域事件发生时通过 emit 发通知
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          // 只向主会话通知"不是它自己发起"的领域事件（quiet>0 时抑制，防自环）
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          // 人的消息到达开放工单即属该工单：主会话在同一事务内获知；工单已结束的则在恢复后再获知——除非是主会话自己路由过去的
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          // 构造跟进通知并转发给主会话
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          // 工单经 PR 结束时通知其相关会话
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            // 取工单来源触发器的原始请求文本
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            // 逐条发送 PR 结束通知
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      // 每个处理轮后刷新 evals 健康条目（过去一小时内是否有评估因不可用而失败）
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      // evaluateDue：处理到期的评估并刷新健康
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      // 处理轮调度器
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      // 数据源上下文依赖（部分用 getter 延迟求值，保证拿到初始化后的成员）
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      // 工具宿主：主会话与执行器工具的共享依赖
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      // 启动异步初始化（ready 即它的 Promise）
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      // 初始化失败时释放数据库与状态锁，使进程内重启能重新获取它们
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  // health：全部健康条目的只读快照
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  // lifetime：停止或失去状态目录锁时中止的信号，用于取消进行中的读取与子进程
  get lifetime(): AbortSignal { return this.stopped.signal }
  // 为某数据源种类构建受限上下文
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  // 已解析的部署信息；setup 未完成时抛错
  get deployment(): Deployment { return this.setup.deployment }
  // setup 是否已完成
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  // 飞书机器人不可用的原因（尽管飞书源已配置 CLI）
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  // links：渠道链接解析器（基于已解析的部署信息）
  links(): LinkTarget {
    // setup 完成才有部署信息
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    // 仓库与（可选的）飞书信息作为链接解析上下文
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    // 按渠道解析出可点击链接
    return channel => this.sources.link(channel, links)
  }
  // 工单执行环境变量（含来源触发器上下文）
  ticketEnvironment(ticket: Ticket): Variable[] {
    // 取工单的来源触发器（可能不存在）
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  // 触发一次 setup 检查
  checkSetup(): void { this.setup.check() }
  // 接入一个触发器（经处理轮）
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  // 等待处理轮空闲
  idle(): Promise<void> { return this.passes.idle() }
  // 立即推动一次处理轮
  pump(): Promise<void> { return this.passes.pump() }
  // 等待全部回复投递完成
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  // paused：暂停中或等待 setup 期间，挂起评估、派发与出站投递；数据源仍会记录进来的触发器
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  // initialize：异步初始化流程（构造函数中的 this.ready 即它的 Promise）
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    // 在 setup 完成前先注册管理 HTTP 路由，让运维能在界面上修复 setup 问题
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    // 执行 setup；未完成则把健康标为"等待 setup"并返回（用户配置完成后重启生效）
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    // 安装会话与执行器的服务钩子
    this.sessions.install()
    this.executor.install()
    // 确保主会话存在
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    // 同步所有可同步的数据源（失败记入健康，不阻塞启动）
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    // 若在等待 setup / 创建会话 / 同步策略期间被 stop()，则不再启动后台循环
    if (this.closing()) return
    // 恢复执行器、启动处理轮与副作用队列
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    // 标记就绪
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  // httpHost：管理 HTTP 路由所需的宿主依赖集合
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  // 幂等停止：并发或重复调用共享同一个停机 Promise
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  // shutdown：有序停机
  private async shutdown(): Promise<void> {
    // 标记停机、停止处理轮、触发中止信号
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      // 停止评估器
      this.assessor.stop()
      // 收集全部 agent id（主会话 + 各工单的 worker 会话）
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      // 取出实际存在的 agent
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      // 取消各 agent（保留收件箱，避免丢消息）
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      // 等处理轮、副作用队列与各 agent 全部结束
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      // worker 的作业与子代理一并停止：否则它们的结束事件会在下方工具限额释放前又启动 worker 轮
      await this.executor.shutdown()
      // 释放执行器与会话管理器
      this.executor.dispose()
      this.sessions.dispose()
      // 逆序执行注销回调（后注册的先注销）
      for (const dispose of this.disposers.reverse()) dispose()
      // 最后确保会话持久化落盘
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      // 先恢复 setup、关闭数据库，再释放目录锁——防止另一进程在写入中途打开数据库；锁失效场景可能早已释放
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        // 释放目录锁（失败仅告警，不影响停机）
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
