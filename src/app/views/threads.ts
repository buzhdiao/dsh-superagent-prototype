/** Thread list, timeline detail, cross-entity search, and decision list views. */
// 线程（Thread）列表、时间线详情、跨实体搜索与决策列表视图。
import { threadKey, type Thread, type Ticket, type Trigger } from '../../core/index.ts'
// 引入核心模型：线程键工具与线程/工单/触发器类型。
import type { ThreadFilter } from '../api.ts'
// 引入线程过滤条件类型。
import type { TextCache } from '../cache.ts'
// 引入文本缓存类型（用于飞书 AppLink 查询）。
import { awaitingEval, channelLink, dayAgo, decisionView, newestFirst, page, snapshot, threadSummary, threadTitle, ticketLine,
  ticketSummary, triggerView, type ViewHost } from './records.ts'
// 引入共享视图工具：待评估触发器、频道链接、时间窗口、分页、快照及各类视图构造器。
import { attribute } from './text.ts'
// 引入文本属性提取工具。

// 线程列表视图：按过滤条件筛选、排序并分页。
export function threadList(host: ViewHost, filter: ThreadFilter, offset: number, limit: number) {
  // 解构出存储。
  const { store } = host
  // 构建共享快照（含参与者名称解析等）。
  const view = snapshot(host)
  // recent 过滤的时间下界：24 小时前。
  const since = dayAgo()
  // 进行中工单 id 集合。
  const open = new Set(store.tickets.open().map(ticket => ticket.id))
  // 线程是否"活跃"：其订阅的工单中仍有进行中的。
  const live = (thread: Thread) => thread.subscriptions.some(id => open.has(id))
  // 线程最后活跃时间（缺省为创建时间）。
  const lastAt = (thread: Thread) => thread.lastAt ?? thread.createdAt
  // 过滤条件：recent 只留 24 小时内活跃的；all 全留；subscribed 只留活跃的；evaluating 留正在评估或有待评估项的。
  const kept = (thread: Thread) => filter === 'recent' ? lastAt(thread) >= since
    : filter === 'all' || (filter === 'subscribed' ? live(thread) : !!thread.evaluating || awaitingEval(view, thread).length > 0)
  // 按过滤条件选择候选集：subscribed 取已订阅线程；evaluating 取活跃线程；其余取全部线程。
  const candidates = filter === 'subscribed' ? store.read.subscribedThreads()
    : filter === 'evaluating' ? store.threads.active() : store.threads.list()
  // 过滤后按最后活跃时间从新到旧排序。
  const threads = candidates.filter(kept).sort((a, b) => lastAt(b).localeCompare(lastAt(a)))
  // 分页。
  const result = page(threads, offset, limit)
  // 把当页线程映射为线程摘要视图。
  return { ...result, items: result.items.map(thread => threadSummary(view, thread)) }
}
// 线程列表视图类型：由 threadList 的返回值推导。
export type ThreadListView = ReturnType<typeof threadList>
/**
 * Thread timeline with triggers ordered oldest-first, inline decisions, and subscribed tickets.
 * `before` pages backward; `around` anchors the page on a specific trigger.
 */
// 线程时间线详情：触发器从旧到新排列、内联决策与订阅工单；before 向前（更早）翻页，around 以指定触发器锚定页。
export function threadDetail(host: ViewHost, key: string, before: string | undefined, limit: number, around?: string) {
  // 解构出存储。
  const { store } = host
  // 按键取线程。
  const thread = store.threads.get(key)
  // 线程不存在则无详情。
  if (!thread) return undefined
  // 构建共享快照。
  const view = snapshot(host)
  // around 锚点：指定某条触发器，让页对准它。
  const target = around ? store.triggers.get(around) : undefined
  // Cursors pair timestamp and id so triggers sharing the same second (e.g., GitHub timestamps) page deterministically.
  // 游标由"时间戳|id"成对组成，使同一秒的触发器（如 GitHub 时间戳）也能确定性翻页。
  const [at = '', id = ''] = before?.split('|') ?? []
  // 取线程触发器（多取 1 条用于判断是否有更早的）；锚点模式包含目标本身，before 模式从游标处向前取。
  const triggers = target ? store.read.threadTriggers(key, limit + 1, target, true)
    : store.read.threadTriggers(key, limit + 1, before ? { at, id } : undefined)
  // 取该线程的全部决策。
  const decisions = store.decisions.byThread(key)
  // 取到的数量超过 limit 说明还有更早的触发器。
  const more = triggers.length > limit
  // 有更多时丢弃多取的第一条（它只用来探测边界）。
  const shown = more ? triggers.slice(1) : triggers
  // 取线程第一条触发器。
  const first = store.read.firstTrigger(key)
  // 线程链接：优先元数据 url，回退首条触发器 url，再回退其频道链接。
  const url = attribute(thread.meta.url) ?? first?.url ?? (first?.channel ? channelLink(view, first.channel).url : undefined)
  // `context` lists tickets whose Executor follows this thread for context only (messages reach them without granting authority).
  // 组装详情：线程摘要 + 链接 + 仅作上下文（context）的工单列表。
  return { ...threadSummary(view, thread), url, context: thread.context ?? [],
    // 关联线程：补充其标题（记录已删除时回退为键）。
    correlated: thread.correlated.map(other => {
      // 取关联线程的记录。
      const value = store.threads.get(other)
      // 有记录用其标题，否则用键。
      return { key: other, title: value ? threadTitle(store, value) : other }
    }),
    // 订阅工单映射为工单行（工单已删除的跳过）。
    tickets: thread.subscriptions.flatMap(id => { const ticket = store.tickets.get(id); return ticket ? [ticketLine(view, ticket)] : [] }),
    // 决策倒序（新→旧）映射为决策视图。
    decisions: decisions.slice().reverse().map(decision => decisionView(view, decision)),
    // 时间线：当页触发器映射为触发器视图；有更早的给出向前翻页游标（时间|id）。
    timeline: shown.map(trigger => triggerView(view, trigger, decisions)), earlier: more ? `${shown[0]!.at}|${shown[0]!.id}` : null }
}
// 线程详情视图类型：由 threadDetail 的返回值推导（排除 undefined）。
export type ThreadDetailView = NonNullable<ReturnType<typeof threadDetail>>
/**
 * Searches triggers, threads, and tickets by text, ID, source-extracted references (e.g., `#N`, URLs), or cached Feishu AppLinks.
 * @param links - Feishu message AppLinks cached since startup, keyed by chat and message ID.
 */
// 跨实体搜索：按文本、ID、来源提取的引用（如 #N、URL）或缓存的飞书（Feishu）AppLink 搜索触发器、线程与工单。
export function search(host: ViewHost, query: string, links: Pick<TextCache, 'entries'>) {
  // 解构出存储与来源注册表。
  const { store, sources } = host
  // 查询词去首尾空白。
  const value = query.trim()
  // 空查询返回空结果。
  if (!value) return { tickets: [], items: [], threads: [] }
  // 构建共享快照。
  const view = snapshot(host)
  // 让各来源解析查询（识别 #N、URL 等引用）。
  const named = sources.find(value)
  // 搜索词集合：原文 + 各来源识别出的术语。
  const terms = new Set([value, ...named.terms])
  // 缓存的飞书 AppLink 命中查询时，把对应消息 id 也加入搜索词。
  for (const [name, url] of links.entries()) if (url === value) terms.add(name.split(':').at(-1)!)
  // 命中的触发器按 id 去重。
  const found = new Map<string, Trigger>()
  // 逐词搜索并汇总触发器。
  for (const term of terms) for (const trigger of store.read.search(term)) found.set(trigger.id, trigger)
  // 来源识别出的线程映射为摘要（记录已不存在的跳过）。
  const threads = named.threads.flatMap(key => { const thread = store.threads.get(key); return thread ? [threadSummary(view, thread)]
    : [] })
  // 查询的小写形式，用于标题匹配。
  const lower = value.toLowerCase()
  // Match tickets by threads they own (e.g., bound PRs) or subscribe to, as well as by title.
  // 工单匹配维度：其跟随（follows）与订阅的线程，以及标题文本。
  const reaches = (ticket: Ticket) => [...(ticket.follows ?? []).map(follow => follow.thread),
    ...view.threadsOf(ticket.id).map(thread => thread.key)]
  // 工单命中条件：可达线程被来源识别命中，或标题包含查询。
  const matches = (ticket: Ticket) => reaches(ticket).some(key => named.threads.includes(key)) || ticket.title.toLowerCase().includes(lower)
  // 过滤工单、按更新时间从新到旧排序、取前 10 并映射为摘要。
  const tickets = store.tickets.list().filter(matches).sort(newestFirst).slice(0, 10).map(ticketSummary)
  // Omit automated triggers from threads already included in `threads`.
  // 已在 threads 结果中的线程，其自动触发器不再重复出现在条目里。
  const shownThreads = new Set(threads.map(thread => thread.key))
  // 把触发器映射为搜索结果行。
  const item = (trigger: Trigger) => {
    // 取触发器的主线程。
    const home = store.threads.get(threadKey(trigger.threads[0]!))
    // 剔除全文 text 字段，只保留其余视图字段。
    const { text: _text, ...row } = triggerView(view, trigger)
    // Triggers filtered by their Source have no Thread record; surface the filter reason instead.
    // 被来源过滤的触发器没有线程记录，改附过滤原因。
    const filtered = home ? {} : { filtered: store.triggers.disposition(trigger.id)?.filtered ?? '' }
    // 补充主线程标题（无主线程时为 undefined）与过滤原因。
    return { ...row, threadTitle: home ? threadTitle(store, home) : undefined, ...filtered }
  }
  // 保留全部人工触发器，以及未包含线程中的自动触发器。
  const items = [...found.values()].filter(trigger => trigger.human || !shownThreads.has(threadKey(trigger.threads[0]!)))
  // 汇总：条目按时间倒序取前 20，附工单与线程结果。
  return { tickets, items: items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map(item), threads }
}
// 搜索视图类型：由 search 的返回值推导。
export type SearchView = ReturnType<typeof search>
// 决策列表视图：按类型与起始时间过滤并分页。
export function decisionList(host: ViewHost, kinds: string[], offset: number, limit: number, since = '') {
  // 读取一页决策（more 表示还有下一页）。
  const { items, more } = host.store.read.decisions({ kinds, since }, offset, limit)
  // 构建共享快照。
  const view = snapshot(host)
  // 映射为决策视图；有下一页时给出下一页 offset。
  return { items: items.map(decision => decisionView(view, decision)), next_offset: more ? offset + limit : null }
}
// 决策列表视图类型：由 decisionList 的返回值推导。
export type DecisionListView = ReturnType<typeof decisionList>
