/** Idempotent message delivery to DSH agents across Session restarts. */
// 幂等（idempotent）消息投递：把消息发给 DSH agent，并保证同一条消息跨 Session（会话）重启与重试至多送达一次。
// Context：cordis 框架的依赖注入上下文类型
import type { Context } from '@deepseek-ai/cordis'
// Agent：DSH agent 实例类型
import type { Agent } from '@deepseek-ai/dsh-agent'
// freezeMessage：冻结生成不可变消息；MessageId：构造消息 id；ContextFormed/UserMessage：消息类型
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
// Session：会话类型
import type { Session } from '@deepseek-ai/dsh-session'
// 仅引入该模块的类型声明（为 sessionPersistence 等接口提供类型），无运行时代码
import type {} from '@deepseek-ai/dsh-session-persistence'

// 扩展 dsh-llm 的 MessageSourceMap：注册 `dsh-superagent` 这一消息来源（source）种类，用于标识由本插件投递的消息
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    // 该来源携带 kind 标识，并满足已成形上下文约束（ContextFormed）
    'dsh-superagent': { kind: 'dsh-superagent' } & ContextFormed
  }
}

// Seen：每个 Session 的"已投递消息 id"记录；ids 为幂等键集合，loaded 为共享的历史加载 Promise（避免并发重复加载）
type Seen = { ids: Set<string>; loaded?: Promise<void> }
/** The id of the message delivered under `requestId`, the same on every retry. */
// 由 requestId 派生消息 id：同一 requestId 无论重试多少次得到的 id 恒定，这是实现幂等的关键
export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)
/** Extracts the idempotency key from current or legacy plugin message sources. */
// 从消息来源中提取幂等键（即消息 id），兼容当前与旧版（legacy）插件来源格式
function deliveryId(message: UserMessage): string | undefined {
  // Persisted sources may predate the current producer-specific source map.
  // 持久化历史里的来源可能是"生产者专属来源表"出现之前的旧格式，因此用宽松的结构类型读取字段
  const source: { kind: string; plugin?: unknown; rpcId?: unknown } = message.source
  // 当前格式（kind 即 dsh-superagent）或旧插件格式（kind=plugin 且 plugin=dsh-superagent）：消息自身 id 即幂等键
  if (source.kind === 'dsh-superagent' || (source.kind === 'plugin' && source.plugin === 'dsh-superagent')) return message.id
  // Requests admitted by the former user RPC retain their original attribution.
  // 经旧版"用户 RPC"接入的请求保留其原始归属：用 rpcId 派生出对应的消息 id 作为幂等键
  if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return messageId(source.rpcId)
}

/**
 * Delivers messages to DSH agents at most once per request ID across active and restored Sessions.
 * Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
 * and marks delivered messages with `dsh-superagent`'s own source (`dsh-superagent`) rather than user RPCs so they are never mistaken for messages written by a person.
 */
// AgentDelivery：按 requestId 保证"至多投递一次"的投递器，同时覆盖活跃 Session 与从持久化恢复的 Session。
// 通过活跃事件、持久化历史、待投递收件箱三处追踪已送达的消息 id，使 `Sessions` 的重试不会造成重复投递；
// 投递的消息标记为 dsh-superagent 自有来源（而非用户 RPC），避免被误认为真人发言。
export class AgentDelivery {
  // 以 Session 实例为键的 WeakMap：Session 被回收后记录随之释放，无需手动清理
  private readonly seen = new WeakMap<Session, Seen>()
  constructor(private readonly ctx: Context) {
    // 监听会话事件流：每当有用户消息进入活跃 Session，就把本插件投递的消息记入已见集合
    ctx.on('session/event', (session, event) => {
      // 只关心 user/message 事件
      if (event.type !== 'user/message') return
      // 提取该消息的幂等键
      const id = deliveryId(event.data)
      // 记入该 Session 的已见集合（记录对象可能尚未创建，用 ?. 兜底——正式记录在 history() 中惰性建立）
      if (id) this.seen.get(session)?.ids.add(id)
    })
  }
  // 获取（并按需初始化）某个 agent 所属 Session 的已见记录：合并活跃事件与持久化历史
  private async history(agent: Agent): Promise<Seen> {
    // 取已有记录；不存在则新建并登记到 WeakMap
    let seen = this.seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.seen.set(agent.session, seen) }
    // 用 state 固定引用，保证异步闭包里始终指向同一个记录对象
    const state = seen
    // loaded ??= ：只加载一次，并发调用共享同一个 Promise；失败时清空 loaded 以便下次重新加载
    state.loaded ??= (async () => {
      // 先等持久化层把缓冲事件全部落盘，确保随后读到的是完整历史
      await this.ctx.sessionPersistence.flush()
      // 以只读方式打开该 agent 的持久化存储（await using 保证作用域结束自动释放句柄）
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      // 从 offset 0 开始分批读取历史事件
      for (let offset = 0; ; ) {
        // 每批最多读 512 条事件
        const { events } = await handle.read(offset, 512)
        // 读到空批次说明已到末尾
        if (!events.length) break
        // 遍历本批事件，收集本插件曾投递过的消息 id
        for (const event of events) {
          // 非用户消息事件不参与幂等统计，跳过
          if (event.type !== 'user/message') continue
          // 提取幂等键并加入已见集合
          const id = deliveryId(event.data)
          if (id) state.ids.add(id)
        }
        // 推进读取偏移量，继续下一批
        offset += events.length
      }
    })().catch(error => { state.loaded = undefined; throw error })
    // 等待加载完成（若加载失败则在此抛出）
    await state.loaded
    // 返回就绪的已见记录
    return state
  }
  // 查询某 requestId 的消息是否已送达（或正躺在待投递收件箱里等待消费）
  async holds(agent: Agent, requestId: string): Promise<boolean> {
    // 计算 requestId 对应的消息 id
    const id = messageId(requestId)
    // 已见集合命中，或收件箱（nextTurn/nextStep）中存在该消息，都视为"已持有"
    return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  }
  /** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
  // 投递入口：向选定的收件箱投递（至多一次），或以 inject 模式写入历史而不唤醒 agent；
  // 在向生产者确认（accepted 回调）之前先确保消息已持久化（flush），这样任何时点的重试都不会重复投递
  async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    // 若取消信号已触发，立即抛错终止
    signal.throwIfAborted()
    // 预热：加载持久化历史（耗时 I/O，放在取消检查之后、授权之前）
    const seen = await this.history(agent)
    // 加载期间可能已被取消，再次检查
    signal.throwIfAborted()
    // 目标 agent 若已被销毁（ctx.agents 中已不是同一实例），投递无意义，直接报错
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    // 调用方可选的授权回调（如配额/准入检查），在真正发送前执行
    authorize?.()
    // 计算 requestId 对应的消息 id（重试时恒定）
    const id = messageId(requestId)
    // 检查该消息是否已在待投递收件箱中（可能是上一次投递后尚未被消费）
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    // 只有"历史上没发过、收件箱里也没有"时才真正构造并发送——这就是幂等保证
    if (!seen.ids.has(id) && !pending) {
      // 构造消息来源：inject 模式标记为 notice（附摘要），其余标记为 relay（转发）；都归属 dsh-superagent 自有来源
      const source = typeof mode === 'object' ? { kind: 'dsh-superagent' as const, form: 'notice' as const, summary: mode.inject }
        : { kind: 'dsh-superagent' as const, form: 'relay' as const }
      // 冻结生成不可变消息：id 用幂等 id，角色为 user，内容为单段文本
      const message = freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text }], source })
      // inject 模式：直接写入历史不唤醒 agent；因不会产生 user/message 事件回流，需立即记入已见集合
      if (typeof mode === 'object') { agent.inject(message); seen.ids.add(id) }
      // steer 模式：插入到当前步骤之间（打断式引导，尽快生效）
      else if (mode === 'steer') agent.steer(message)
      // queue 模式：排入下一轮（followup，正常排队）
      else agent.followup(message)
    }
    // 通知生产者"已受理"（无论是否真的新发送——重试场景下消息可能早已送达）
    accepted?.()
    // 最后强制持久化落盘：即使进程随即崩溃，重启后的重试也会从历史中看到该消息，不会重复投递
    await this.ctx.sessionPersistence.flush()
  }
}
