/** Shared view projections for triggers, tickets, threads, decisions, and channel links. */
// 触发器（Trigger）、工单（Ticket）、线程（Thread）、决策（Decision）与频道链接的共享视图投影层，供各 UI 页面复用。
import { z } from 'zod'
// 引入 zod：用于声明并校验存储中审计元数据（audit）的结构，容忍旧版本格式。
import { canRetry, followupOwners, latestReport, liveTicket, settled, threadKey, ticketStage, type ActorRef, type ChannelRef, type Decision,
  type DecisionKind, type Thread, type ThreadFacts, type Ticket, type TicketStage, type Trigger } from '../../core/index.ts'
// 引入核心领域模型与工具：重试判断、跟进负责人、最新报告、存活判断、决策落定、线程键、工单阶段等。
import { allowedSender, listedBot } from '../../policy.ts'
// 引入策略查询：允许发件人名单与已登记机器人列表。
import type { ChannelLink, Localized } from '../../sources/kind.ts'
// 引入来源类型定义：频道链接与双语本地化（Localized）文本。
import type { SourceRegistry } from '../../sources/registry.ts'
// 引入来源注册表类型：按 id 查询来源类型与实例。
import { workerSessionId } from '../../executor/dsh.ts'
// 引入执行器工具：由工单 id 推导其共享 worker 会话 id。
import type { Store } from '../store.ts'
// 引入应用存储类型。
import { attribute, markdown, plain, preview, readable } from './text.ts'
// 引入文本工具：属性提取、Markdown 渲染、纯文本化、截断预览与可读化。

export type LinkTarget = (channel: ChannelRef) => ChannelLink
// 链接解析器类型：由频道引用（ChannelRef）解析出对应的频道链接。
export interface ViewHost { store: Store; sources: SourceRegistry; links: LinkTarget }
// 视图宿主（ViewHost）：构建各视图所需的最小依赖集合——存储、来源注册表与链接解析器。
export const page = <T>(items: T[], offset: number, limit: number) => ({ items: items.slice(offset, offset + limit), total: items.length, next_offset: offset + limit < items.length ? offset + limit : null })
// 通用分页工具：按 offset/limit 切出当页条目，附带总数与下一页 offset（没有下一页时为 null）。
const DAY = 86_400_000
// 一天的毫秒数，用于"最近 24 小时"统计窗口。
export const dayAgo = () => new Date(Date.now() - DAY).toISOString()
// 返回 24 小时前的 ISO 时间戳，作为统计窗口起点。
export const newestFirst = (a: Ticket, b: Ticket) => b.updatedAt.localeCompare(a.updatedAt)
// 工单排序比较器：按更新时间从新到旧。

/** Sender projection for the UI; automated notices have an empty `id` and no `name`. */
// 参与者（Actor）的 UI 投影：来源、id 与可选显示名。
export interface ActorView { source: string; id: string; name?: Localized }
/** The tickets whose worker decides a person's follow-up (see `followupOwners`). */
// 跟进负责人（Owners）类型：给出某触发器对应负责处理的工单 id 列表。
export type Owners = (trigger: Trigger) => string[]
/**
 * The owners of follow-ups as one request reads them: the rows of a page share their tickets and Threads, so each is read
 * once however many rows it decides.
 */
// 供单次请求使用的跟进负责人计算器：同一页各行共享工单与线程，每条记录只读取一次。
export function ownersOf(store: Pick<Store, 'tickets' | 'threads' | 'triggers'>): Owners {
  // 局部工具 once：把"按 id 读取"包装为带缓存的读取器。
  const once = <T>(read: (id: string) => T) => {
    // 缓存表：记录已读取过的 id 及其结果。
    const seen = new Map<string, T>()
    // 返回包装后的读取函数：未命中缓存才真正读取并写入缓存。
    return (id: string) => { if (!seen.has(id)) seen.set(id, read(id)); return seen.get(id) as T }
  }
  // 用带缓存的读取器组装 followupOwners 所需的记录访问接口（tickets/threads 各自缓存，triggers 原样透传）。
  const records = { tickets: { get: once(id => store.tickets.get(id)) }, threads: { get: once(key => store.threads.get(key)) },
    triggers: store.triggers }
  // 返回闭包：对每个触发器计算决定其跟进的负责工单列表。
  return trigger => followupOwners(trigger, records)
}
/** One request's reads, each read once: the Threads each Ticket subscribes to, the rules by id, and the senders' names. */
// 单次请求的快照（Snapshot）：在宿主能力之上追加各类查询（线程订阅、规则名、参与者名、跟进负责人），读取各自只做一次。
export interface Snapshot extends ViewHost {
  threadsOf(ticketId: string): Thread[]
  /** Current rule name, falling back to `id` once a rule has been removed. */
  rule(id: string): { id: string; name: string }
  /** Resolves sender display name from policy allowlists/bot lists, falling back to the Source kind's unnamed label or raw id. */
  actor(actor: ActorRef, human?: boolean): ActorView
  /** The owners of follow-ups (see `ownersOf`). */
  owners: Owners
}
// 构建单次请求的视图快照：在宿主之上组装各带缓存的查询。
export function snapshot(host: ViewHost): Snapshot {
  // 解构出存储与来源注册表。
  const { store, sources } = host
  // 惰性缓存：工单 id 到订阅它的线程列表，首次访问时才构建。
  let subscribed: Map<string, Thread[]> | undefined
  // threadsOf：查询某个工单被哪些线程订阅。
  const threadsOf = (ticketId: string) => {
    // 缓存尚未构建时，先遍历一次所有已订阅线程建立映射。
    if (!subscribed) {
      subscribed = new Map()
      // 把每个线程登记到它订阅的每个工单 id 名下（追加到已有列表之后）。
      for (const thread of store.read.subscribedThreads()) for (const id of thread.subscriptions) subscribed.set(id,
        [...subscribed.get(id) ?? [], thread])
    }
    // 返回该工单的订阅线程列表，没有则为空数组。
    return subscribed.get(ticketId) ?? []
  }
  // 读取当前全局设置。
  const settings = store.settings()
  // 规则 id 到名称的映射，用于界面展示规则名。
  const rules = new Map(settings.policy.rules.map(rule => [rule.id, rule.name]))
  // 便捷函数：把同一名称包装成中英双语对象。
  const named = (name: string) => ({ zh: name, en: name })
  // actor：把参与者引用解析为 UI 展示用的参与者视图。
  const actor = ({ source, id }: ActorRef, human?: boolean): ActorView => {
    // 没有 id（自动通知类）直接返回不带名称的视图。
    if (!id) return { source, id }
    // 先查策略允许发件人名单，再查已登记机器人列表。
    const entry = allowedSender(settings, { source, id }) ?? listedBot(settings, { source, id })
    // 命中名单则用其名称，缺省回退为其 id。
    if (entry) return { source, id, name: named(entry.name || entry.id) }
    // 否则取来源类型声明的"未命名参与者"文案。
    const unnamed = sources.kind(source)?.policy?.unnamed
    // 有未命名文案时按是否为机器人区分（human 为 false 即机器人）；否则回退用原始 id。
    return { source, id, name: unnamed ? human === false ? unnamed.bot : unnamed.person : named(id) }
  }
  // 组装快照：展开宿主能力并附加各查询；规则已删除时回退显示 id。
  return { ...host, threadsOf, rule: id => ({ id, name: rules.get(id) ?? id }), actor, owners: ownersOf(store) }
}

/**
 * The Triggers of a Thread's queue that wait for an Eval: a person's follow-up a ticket still decides, which an older
 * version queued, leaves the queue with the next Eval without one.
 */
export const awaitingEval = ({ store, owners }: { store: Pick<Store, 'triggers'>; owners: Owners }, thread: Thread): string[] =>
  // 逐个检查队列中的触发器 id，保留"真正等待评估"的项。
  thread.pending.filter(id => {
    // 按 id 取触发器记录。
    const trigger = store.triggers.get(id)
    // 触发器记录已不存在，或其跟进已无负责工单，都算"仍在等待评估"（仍由工单决定的旧触发器会在下次评估时直接离开队列）。
    return !trigger || !owners(trigger).length
  })
/**
 * A trigger with where it went: queued for Eval, the Decision that consumed it, the Tickets it fanned out to, `delivered`
 * when it is a person's follow-up that a ticket's worker decides without an Eval, and the Tickets that handed it back for
 * a new Eval, with why; `requeue` when a person may send it to Eval, which is where no Eval reached a judgement: its Source
 * filtered it, its Eval was unavailable, a ticket's worker still decides it, or it reached a ticket and nothing decided it,
 * such as a message a worker neither acknowledged, answered nor handed back, or one only a stop was decided on.
 */
// 触发器详情视图：展示它去了哪里——评估队列、消费它的决策、扇出的工单、交还记录，以及是否允许重新评估。
export function triggerView(view: Snapshot, trigger: Trigger, threadDecisions?: Decision[]) {
  // 从快照中解构出存储。
  const { store } = view
  // 读取该触发器的处置（disposition）记录：是否被过滤、扇出、交还等。
  const disposition = store.triggers.disposition(trigger.id)
  // 取触发器所属的第一个线程作为"主线程"。
  const home = store.threads.get(threadKey(trigger.threads[0]!))
  // 优先使用处置中记录的决策；否则在传入的决策列表（或主线程决策）里找最后一条涉及该触发器的决策。
  const decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId)
    : (threadDecisions ?? (home ? store.decisions.byThread(home.key) : [])).filter(item => item.triggerIds.includes(trigger.id)).at(-1)
  // 是否已"交付"：它是某人的跟进且已由某个工单的执行者负责决定（无需评估）。
  const delivered = view.owners(trigger).length > 0
  // 是否仍在主线程的待评估队列中（已交付的情形不算排队）。
  const queued = !!home?.pending.includes(trigger.id) && !delivered
  // 是否正被一次进行中的评估（evaluating）处理。
  const evaluating = !!home?.evaluating?.triggerIds.includes(trigger.id)
  // 是否已有结论：处置已被确认（acked），或关联决策已落定（settled）。
  const decided = !!disposition?.acked?.length || (!!decision && settled(decision))
  // 是否"未经评判"（unjudged）：被来源过滤、评估不可用、已交付由工单决定、已扇出但未落定，或存在尚未落定的决策。
  const unjudged = !!disposition?.filtered || decision?.kind === 'unavailable' || delivered || (!!disposition?.fanout.length && !decided)
    || (!!decision && !decided)
  // 是否允许"重新评估"（requeue）：人工触发器、不在队列/评估中、且尚未形成结论。
  const requeue = trigger.human && !queued && !evaluating && unjudged
  // 组装触发器视图：基本信息、正文与预览、所属线程键、可执行动作及处置详情。
  return { id: trigger.id, source: trigger.source, actor: view.actor(trigger.actor, trigger.human), human: trigger.human, at: trigger.at,
    // 正文先做可读化再转纯文本（保留换行）。
    text: plain(readable(trigger.text), true),
    // 文本预览、原始链接、所属线程键列表与可执行动作（重新评估）。
    preview: preview(trigger.text), url: trigger.url, threads: trigger.threads.map(threadKey), actions: { requeue },
    // 处置详情：各状态标记、扇出的工单、交还记录及最终决策。
    disposition: { queued, evaluating, delivered, filtered: disposition?.filtered, fanout: disposition?.fanout ?? [],
      // 每条交还（handback）记录补充交还目标工单的标题（工单已删除时回退为其 id）。
      handbacks: (disposition?.handbacks ?? []).map(item => ({ ...item,
        title: store.tickets.get(item.ticketId)?.title ?? item.ticketId })),
      // 关联决策的摘要：结果、原因与产出的工单 id。
      decision: decision ? { id: decision.id, outcome: outcomeOf(decision), reason: decision.reason, ticketId: decision.ticketId }
        : undefined } }
}
// 触发器视图类型：由 triggerView 的返回值推导。
export type TriggerView = ReturnType<typeof triggerView>
/** Single-line summary of why a ticket in the `person` stage is waiting on human action (omitted once answered and back with the Executor). */
// 工单处于 person 阶段等待人工操作的单行说明；已回答并回到执行器（Executor）后省略。
function ticketNote(ticket: Ticket, stage: TicketStage): { text: string; error: boolean } | undefined {
  // 仅 person 阶段需要说明。
  if (stage.stage !== 'person') return undefined
  // 等待人回答时，展示所提问题的预览（非错误）。
  if (stage.action === 'answer' && ticket.attention) return { text: preview(ticket.attention.question), error: false }
  // 交付失败时，展示错误预览并标记为错误。
  if (stage.action === 'delivery' && ticket.delivery) return { text: preview(ticket.delivery.error), error: true }
  // 取最近一次执行报告的摘要。
  const summary = latestReport(ticket)?.summary
  // 仅阻塞（blocked）/失败（failed）阶段且有摘要时才生成说明。
  if ((stage.action !== 'blocked' && stage.action !== 'failed') || !summary) return undefined
  // 取摘要第一行作为说明；失败阶段标记为错误。
  return { text: preview(summary.split('\n')[0]!), error: stage.action === 'failed' }
}
// 组装工单摘要视图：标题、状态、阶段、等待说明、可执行动作与统计信息。
export function ticketSummary(ticket: Ticket) {
  // 计算工单当前所处阶段。
  const stage = ticketStage(ticket)
  // 计算等待人工操作的说明（可能没有）。
  const note = ticketNote(ticket, stage)
  // 判断工单是进行中（open）还是已结束（ended）。
  const state = liveTicket(ticket) ? 'open' as const : 'ended' as const
  // 展开阶段与说明，再补充以下字段。
  return { id: ticket.id, title: ticket.title, state, ...stage, ...note ? { note } : {},
    // 可执行动作：是否可重试、是否可停止；以及授权强度与结束时间。
    actions: { retry: canRetry(ticket), stop: liveTicket(ticket) }, strength: ticket.mandate.strength, ended: ticket.ended,
    // 待人关注（attention）的问题以 Markdown 渲染；并统计分配、输入与未交付数量。
    attention: ticket.attention && { ...ticket.attention, question: markdown(ticket.attention.question) },
      assignments: ticket.assignments.length, inputs: ticket.inputs.length, undelivered: ticket.undelivered.length,
    // Every started Assignment of a Ticket runs in its one shared worker Session.
    // 交付错误的归因来源，以及共享 worker 会话 id（存在已启动的分配时才生成）。
    deliveryError: attribute(ticket.delivery?.error), sessionId: ticket.assignments.some(item => item.startedAt)
      ? workerSessionId(ticket.id) : '',
    // 执行目录、最新报告摘要与创建/更新时间。
    directory: attribute(ticket.execution?.directory), summary: latestReport(ticket)?.summary ?? '', createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt }
}
// 工单摘要视图类型：由 ticketSummary 的返回值推导。
export type TicketSummaryView = ReturnType<typeof ticketSummary>
// 解析线程的展示链接：优先元数据中的 url，回退到线程第一条触发器的 url。
function threadUrl(store: Store, thread: Thread): string | undefined {
  return attribute(thread.meta.url) ?? store.read.firstTrigger(thread.key)?.url
}
// 组装线程事实（facts）视图：键、来源、标题、可选链接与元数据事实。
export function threadFacts(store: Store, thread: Thread) {
  // 先解析线程链接（可能不存在）。
  const url = threadUrl(store, thread)
  // 有链接才附加 url 字段；事实数据来自线程元数据。
  return { key: thread.key, source: thread.ref.source, title: threadTitle(store, thread), ...url ? { url } : {}, facts: (thread.meta.facts ?? {}) as ThreadFacts }
}
// 线程事实视图类型：由 threadFacts 的返回值推导。
export type ThreadFactsView = ReturnType<typeof threadFacts>
// 工单行视图：在工单摘要之上附加该工单被订阅的各线程事实列表。
export const ticketLine = (view: Snapshot, ticket: Ticket) => ({ ...ticketSummary(ticket),
  threads: view.threadsOf(ticket.id).map(thread => threadFacts(view.store, thread)) })
// 线程标题：优先自定义标签，其次首条触发器文本预览，最后回退线程键。
export function threadTitle(store: Pick<Store, 'read'>, thread: Thread): string {
  // 取线程元数据中的自定义标签。
  const label = attribute(thread.meta.label)
  // 有标签则直接作为标题。
  if (label) return label
  // Prefer the first human trigger over automated triggers when deriving a fallback thread title.
  // 标题回退时优先取人工（human）触发器而非自动触发器。
  const first = store.read.firstTrigger(thread.key, true) ?? store.read.firstTrigger(thread.key)
  // 用触发器文本前 80 字符作标题；完全没有触发器时用线程键。
  return first ? preview(first.text, 80) : thread.key
}
// 线程上的最新动态：最近一条触发器的参与者与文本预览。
function latestOnThread(view: Snapshot, thread: Thread) {
  // 取该线程最近一条触发器（限制 1 条）。
  const trigger = view.store.read.threadTriggers(thread.key, 1)[0]
  // 没有触发器就没有"最新动态"。
  if (!trigger) return undefined
  // 组装最新动态：参与者、是否人工、时间与 120 字预览。
  return { actor: view.actor(trigger.actor, trigger.human), human: trigger.human, at: trigger.at, preview: preview(trigger.text, 120) }
}
/** Thread lifecycle stage in priority order: poll error, evaluating, queued, subscribed by open ticket, dormant (ended tickets only), or unsubscribed. */
// 线程生命周期阶段（ThreadStage）：按优先级取第一个命中的状态。
export type ThreadStage = 'error' | 'evaluating' | 'queued' | 'subscribed' | 'dormant' | 'unsubscribed'
// 按优先级推断线程所处阶段：轮询错误 > 评估中 > 队列待评估 > 有进行中工单 > 休眠 > 未订阅。
function threadStage(thread: Thread, pending: number, tickets: { state: string }[]): ThreadStage {
  // 元数据记录了轮询（poll）错误则为 error。
  if (attribute(thread.meta.pollError)) return 'error'
  // 正在评估中。
  if (thread.evaluating) return 'evaluating'
  // 队列中还有待评估触发器则为 queued。
  if (pending) return 'queued'
  // 有进行中的工单订阅则为 subscribed。
  if (tickets.some(ticket => ticket.state === 'open')) return 'subscribed'
  // 只剩已结束工单为 dormant（休眠），没有任何工单为 unsubscribed（未订阅）。
  return tickets.length ? 'dormant' : 'unsubscribed'
}
// 组装线程摘要视图：标题、阶段、最新动态、订阅工单与评估状态等。
export function threadSummary(view: Snapshot, thread: Thread) {
  // 解构出存储。
  const { store } = view
  // 将线程订阅的每个工单 id 映射为摘要行（标题与状态）。
  const tickets = thread.subscriptions.map(id => {
    // 按 id 取工单记录。
    const ticket = store.tickets.get(id)
    // 工单缺失标为 unknown；存活为 open；否则为 ended。
    return { id, title: ticket?.title ?? id, state: !ticket ? 'unknown' : liveTicket(ticket) ? 'open' : 'ended' }
  })
  // 统计仍在等待评估的触发器数量。
  const pending = awaitingEval(view, thread).length
  // 组装摘要：基础信息与推断出的阶段。
  return { key: thread.key, source: thread.ref.source, title: threadTitle(store, thread), stage: threadStage(thread, pending, tickets),
    // 最新动态与时间（最后活跃时间缺省为创建时间）。
    latest: latestOnThread(view, thread), lastAt: thread.lastAt ?? thread.createdAt, createdAt: thread.createdAt,
    // 订阅数量与工单摘要列表。
    subscriptions: thread.subscriptions.length, tickets,
    // 进行中评估的详情：id、强度、涉及触发器数、开始与截止时间。
    evaluating: thread.evaluating ? { id: thread.evaluating.id, strength: thread.evaluating.strength, triggers: thread.evaluating.triggerIds.length, startedAt: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } : undefined,
    // 待评估数量、轮询错误与线程链接。
    pending, pollError: attribute(thread.meta.pollError), url: threadUrl(store, thread),
    // 元数据事实。
    facts: (thread.meta.facts ?? {}) as ThreadFacts }
}
// 线程摘要视图类型：由 threadSummary 的返回值推导。
export type ThreadSummaryView = ReturnType<typeof threadSummary>
/** Resolves a channel link, preferring the specific trigger URL when the source link references a trigger. */
// 频道链接视图：来源链接若指向某条触发器，则优先使用该触发器自身的 URL。
export function channelLink({ store, links }: ViewHost, channel: ChannelRef) {
  // 解析来源链接：基础 URL、显示标签与可选的触发器 id。
  const { url, label, triggerId } = links(channel)
  // 链接指向的触发器仍存在时，用触发器自己的 URL；否则用来源链接的 URL。
  return { source: channel.source, url: (triggerId && store.triggers.get(triggerId)?.url) || url, label }
}
/** Parses stored assessment audit metadata, tolerating fields omitted or shaped differently by older versions. */
// 评估审计（audit）元数据的宽松 schema：字段缺失或旧版本结构不同时容忍并回退，避免视图崩溃。
const AuditSchema = z.object({
  // 观察模式（observe）下本会被接受的标记（布尔，可缺省）。
  would_accept: z.boolean().optional().catch(undefined),
  // 逐规则评估结果：规则 id、是否命中及原因（较新版本的格式）。
  rule_assessments: z.array(z.object({ rule_id: z.string(), matched: z.boolean(), reason: z.string() })).optional().catch(undefined),
  // 仅记录命中规则与原因（更旧版本的格式）。
  matches: z.array(z.object({ rule_id: z.string(), reason: z.string() })).optional().catch(undefined),
  // 方向判断结论：是否要求实现、判断依据、是否需要设计决策及证据。
  direction: z.object({ implementation_requested: z.boolean(), target_basis: z.string(), requires_design_decision: z.boolean(),
    evidence: z.string() }).optional().catch(undefined),
}).catch({})
/** Decision kind, or `wouldAccept` for an ignore decision that observe mode would have accepted. */
// 决策结果（DecisionOutcome）：决策类型，或忽略决策在观察模式下本会被接受时的 wouldAccept。
export type DecisionOutcome = DecisionKind | 'wouldAccept'
// 由决策计算展示结果：忽略决策若审计显示"观察模式本会接受"，则显示为 wouldAccept。
const outcomeOf = (decision: Decision): DecisionOutcome =>
  decision.kind === 'ignore' && AuditSchema.parse(decision.audit ?? {}).would_accept ? 'wouldAccept' : decision.kind
// 组装决策视图：结果、原因、规则命中明细、方向判断与触发器文本预览。
export function decisionView(view: Snapshot, decision: Decision) {
  // 解构出存储。
  const { store } = view
  // 取决策所属线程。
  const thread = store.threads.get(decision.threadKey)
  // 收集决策所涉每条触发器的文本预览（触发器已被清理时跳过）。
  const texts = decision.triggerIds.flatMap(id => { const trigger = store.triggers.get(id); return trigger ? [preview(trigger.text)] : [] })
  // 解析审计元数据（容忍旧版本格式）。
  const audit = AuditSchema.parse(decision.audit ?? {})
  // Fall back to `matches` for assessments recorded by older versions.
  // 优先用逐规则评估结果；旧版本回退为 matches（全部视为命中）。
  const judged = audit.rule_assessments ?? audit.matches?.map(match => ({ ...match, matched: true })) ?? []
  // 组装决策视图：id、类型、结果、原因与时间。
  return { id: decision.id, kind: decision.kind, outcome: outcomeOf(decision), reason: decision.reason, at: decision.at,
    // 强度、产出的工单 id、涉及触发器与所属线程键。
    strength: decision.strength, ticketId: decision.ticketId, triggerIds: decision.triggerIds, thread: decision.threadKey,
    // 规则命中列表：补充规则显示名（已删除规则回退为 id）。
    rules: judged.map(rule => ({ ...view.rule(rule.rule_id), matched: rule.matched, reason: rule.reason })),
    // 有方向判断时附加 direction 字段。
    ...audit.direction ? { direction: audit.direction } : {},
    // 附加线程标题（线程仍存在时）与各触发器预览合并成的单行文本。
    ...thread ? { threadTitle: threadTitle(store, thread) } : {}, preview: texts.join(' / '),
    // 决策产出的工单标题（工单已删除时为 undefined）。
    ticketTitle: decision.ticketId ? store.tickets.get(decision.ticketId)?.title : undefined }
}
// 决策视图类型：由 decisionView 的返回值推导。
export type DecisionView = ReturnType<typeof decisionView>
