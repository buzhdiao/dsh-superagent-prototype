/** Ticket list, ticket detail, mandate basis formatting, and executor load views. */
// 工单（Ticket）列表、工单详情、授权依据（mandate basis）格式化与执行器负载视图。
import { liveTicket, threadKey, ticketStage, type AcceptMode, type AdmissionCell, type MandateBasis, type Ticket,
  type TicketStage } from '../../core/index.ts'
// 引入核心模型：存活判断、线程键、工单阶段及授权相关类型。
import { workerSessionId } from '../../executor/dsh.ts'
// 引入执行器工具：由工单 id 推导其共享 worker 会话 id。
import type { Store } from '../store.ts'
// 引入应用存储类型。
import { channelLink, decisionView, newestFirst, page, snapshot, threadSummary, ticketLine, type Snapshot,
  type ViewHost } from './records.ts'
// 引入共享视图工具：频道链接、决策视图、排序、分页、快照与工单行。
import { markdown, preview } from './text.ts'
// 引入文本工具：Markdown 渲染与截断预览。

// 授权准入事实的展示条目：每项是"名称 + 可选值"的联合类型。
export type BasisFact =
  | { name: 'addressed'; value: 'mention' | 'direct' } | { name: 'followup' } | { name: 'admission'; value: AdmissionCell } | { name: 'observation' }
  | { name: 'mode'; value: AcceptMode } | { name: 'rules'; value: { id: string; name: string }[] } | { name: 'sender'; value: string }
  | { name: 'legacyAuthority'; value: string } | { name: 'bot' }
/**
 * Extracts displayable mandate admission facts in reading order (omitting the receiving scope, which is stored
 * only for re-validation), marking pre-scope records that only have `authority` as `legacy`.
 */
// 按阅读顺序提取可展示的授权准入事实（省略仅用于复验的接收范围），仅有旧 authority 字段的记录标记为 legacy。
export function basisFacts(basis: MandateBasis, rule: Snapshot['rule']): { facts: BasisFact[]; legacy: boolean } {
  // 按阅读顺序收集事实。
  const facts: BasisFact[] = []
  // 记录发送者。
  if (basis.sender) facts.push({ name: 'sender', value: basis.sender })
  // 经机器人转发而来的标记。
  if (basis.via === 'bot') facts.push({ name: 'bot' })
  // 非"跟进"来源且被点名/私聊（addressed）时记录。
  if (basis.via !== 'followup' && basis.addressed) facts.push({ name: 'addressed', value: basis.addressed })
  // Imported bases already record their follow-up in `authority`.
  // 跟进来源且未记录在旧 authority 字段时，单独显示 followup。
  if (basis.via === 'followup' && !basis.authority) facts.push({ name: 'followup' })
  // 准入（admission）来源显示其所在的准入单元格。
  if (basis.via === 'admission') facts.push({ name: 'admission', value: basis.cell })
  // 观察记录仅对 admission/listed/bot 来源存在。
  const observation = basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot' ? basis.observation : undefined
  // Listed bot messages are inferred candidates regardless of where received, so only the accept mode is shown from `observation`.
  // 非 bot 来源有观察记录时显示 observation（bot 来源只展示接受模式）。
  if (observation && basis.via !== 'bot') facts.push({ name: 'observation' })
  // 观察到的接受模式（AcceptMode）。
  if (observation?.mode) facts.push({ name: 'mode', value: observation.mode })
  // 命中的规则列表（映射为 id + 名称）。
  if (basis.rules?.length) facts.push({ name: 'rules', value: basis.rules.map(rule) })
  // 旧版权限字段仅对 followup/listed 来源显示。
  const authority = basis.via === 'followup' || basis.via === 'listed' ? basis.authority : undefined
  // 有旧版权限字段时显示 legacyAuthority。
  if (authority) facts.push({ name: 'legacyAuthority', value: authority })
  // 返回事实列表与 legacy 标记（是否存在旧版权限字段）。
  return { facts, legacy: authority !== undefined }
}
// 工单列表视图：按阶段筛选、排序并分页。
export function ticketList(host: ViewHost, stage: 'open' | TicketStage['stage'], offset: number, limit: number) {
  // 构建共享快照。
  const view = snapshot(host)
  // 解构出存储。
  const { store } = view
  // 筛选条件：open 取存活工单；其他按阶段精确匹配。
  const shown = (ticket: Ticket) => stage === 'open' ? liveTicket(ticket) : ticketStage(ticket).stage === stage
  // ended 阶段需从全部工单里取（含已结束），其余只从进行中工单取；再过滤并按更新时间排序。
  const tickets = (stage === 'ended' ? store.tickets.list() : store.tickets.open()).filter(shown).sort(newestFirst)
  // 分页。
  const result = page(tickets, offset, limit)
  // 当页工单映射为工单行视图。
  return { ...result, items: result.items.map(ticket => ticketRow(view, ticket)) }
}
// 工单列表视图类型：由 ticketList 的返回值推导。
export type TicketListView = ReturnType<typeof ticketList>
// 工单行视图：在工单行基础上，person 阶段且知道首个频道时附上回复链接。
export function ticketRow(view: Snapshot, ticket: Ticket) {
  // 基础工单行（摘要 + 订阅线程）。
  const line = ticketLine(view, ticket)
  // 工单的第一个关联频道。
  const channel = ticket.channels[0]
  // person 阶段且有频道时解析回复链接。
  const reply = line.stage === 'person' && channel ? channelLink(view, channel) : undefined
  // 有回复链接才附加 reply 字段。
  return { ...line, ...reply ? { reply } : {} }
}
/** Executor slot utilization: `running` worker Sessions in an active turn (which occupy slots and are interrupted by a restart), and tickets `queued` for a slot. */
// 执行器负载（ExecutorLoad）：活动回合中占槽位、重启即中断的运行中 worker 会话数，以及排队等待槽位的工单数。
export interface ExecutorLoad { running: number; queued: number }
// 计算执行器负载：running 由调用方传入，queued 在此统计。
export function executorLoad(store: Store, running: number): ExecutorLoad {
  // 排队判断：工单处于 working 阶段且动作（action）为 queued。
  const queued = (ticket: Ticket) => { const stage = ticketStage(ticket); return stage.stage === 'working' && stage.action === 'queued' }
  // 统计进行中工单里排队的数量。
  return { running, queued: store.tickets.open().filter(queued).length }
}
// 工单详情视图：摘要、授权依据、频道、决策、分配（assignment）与输入等。
export function ticketDetail(host: ViewHost, id: string) {
  // 解构出存储。
  const { store } = host
  // 按 id 取工单。
  const ticket = store.tickets.get(id)
  // 工单不存在则无详情。
  if (!ticket) return undefined
  // 构建共享快照。
  const view = snapshot(host)
  // 取工单阶段。
  const { stage } = ticketStage(ticket)
  // 产出该工单的决策。
  const decision = store.decisions.get(ticket.decisionId)
  // 把工单输入映射为展示视图。
  const input = (value: Ticket['inputs'][number]) => {
    // 输入为触发器时取其记录。
    const trigger = value.kind === 'trigger' ? store.triggers.get(value.triggerId) : undefined
    // 查找"交还给本工单"的交还（handback）记录。
    const handback = trigger && store.triggers.disposition(trigger.id)?.handbacks?.find(item => item.ticketId === id)
    // 触发器输入的展示字段：参与者、是否人工、预览、线程键与交还信息。
    const shown = trigger && { id: trigger.id, actor: view.actor(trigger.actor, trigger.human), human: trigger.human,
      preview: preview(trigger.text), thread: threadKey(trigger.threads[0]!),
      ...handback ? { handback: { reason: handback.reason, at: handback.at } } : {} }
    // 文本/备注输入以 Markdown 渲染。
    const text = (value.kind === 'text' || value.kind === 'note') && value.text ? { text: markdown(value.text) } : {}
    // 组合：是否已送达（不在未交付列表中）与触发器详情。
    return { ...value, ...text, delivered: !ticket.undelivered.includes(value.id), ...shown ? { trigger: shown } : {} }
  }
  // Pass `human = false` for bot-originated mandates so the Source kind still labels the actor as a bot if removed from the policy list.
  // 是否人工发起：bot 来源的授权传 human=false，使来源在参与者被移出策略名单后仍能标其为机器人。
  const human = ticket.mandate.basis.via !== 'bot'
  // 组装详情：工单行 + 授权参与者解析。
  return { ...ticketLine(view, ticket), mandate: { ...ticket.mandate, actor: view.actor(ticket.mandate.actor, human) },
    // 准入事实与全局暂停标记。
    basis: basisFacts(ticket.mandate.basis, view.rule), paused: store.settings().paused,
    // 关联频道映射为频道链接视图。
    channels: ticket.channels.map(channel => channelLink(view, channel)),
    // 产出决策的视图（如存在）。
    decision: decision ? decisionView(view, decision) : undefined,
    // Every started Assignment ran in the ticket's one worker Session. A running assignment whose worker reported a non-progress state has finished its turn unless a human response resumed the ticket.
    // 分配列表：已启动的附 worker 会话引用；运行中但报告非 progress 且阶段已离开 working 的，视为本轮已结束并附报告时间。
    assignments: ticket.assignments.map(assignment => ({ ...assignment, ...assignment.startedAt ? { ref: workerSessionId(ticket.id) } : {},
      ...assignment.state === 'running' && assignment.report && assignment.report.state !== 'progress' && stage !== 'working'
        ? { turnEndedAt: assignment.report.at } : {} })),
    // 输入倒序（新→旧）映射为展示视图。
    inputs: ticket.inputs.slice().reverse().map(input),
    // Threads followed for context only (e.g., related issues) grant no authority and are marked with `context: true`.
    // 订阅线程映射为摘要；仅作上下文（context）的线程（如相关 issue）标记 context: true。
    threads: view.threadsOf(id).map(thread => ({ ...threadSummary(view, thread),
      ...thread.context?.includes(id) ? { context: true as const } : {} })) }
}
// 工单详情视图类型：由 ticketDetail 的返回值推导（排除 undefined）。
export type TicketDetailView = NonNullable<ReturnType<typeof ticketDetail>>
