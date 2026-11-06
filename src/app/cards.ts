/** Compact, bounded model-facing projections of triggers, tickets, threads, and decisions; full texts stay behind readable resources. */
// 紧凑、有界的"面向模型"投影（projection）：把触发器（Trigger）、工单（Ticket）、线程（Thread）与决策（Decision）压缩成卡片；
// 完整文本不直接内联，而是通过可读资源路径（如 `ticket/<id>`）按需分页读取。
// 从核心域导入投影所需的取值辅助（latestReport 取最新报告、reasonText 翻译原因码、threadKey 算线程键、ticketStage 算工单阶段）与各类型
import { latestReport, reasonText, threadKey, ticketStage, type Decision, type Mandate, type Thread, type Ticket, type TicketInput,
  type Trigger, type TriggerDisposition } from '../core/index.ts'
// pullOf：若工单关联了 GitHub PR，则返回其 PR 编号
import { pullOf } from '../sources/github-pull.ts'
// batchLine：把批量触发器压成单行；inputResource：生成工单输入对应的可读资源路径
import { batchLine, inputResource } from '../executor/dsh.ts'

/** Collapses whitespace and truncates text for display previews while keeping code, angle brackets, and links intact for model readers. */
// 折叠所有空白为单个空格并截断到 160 字符，生成预览文本；保留代码、尖括号与链接原样不转义，方便模型阅读
export function preview(text: string): string { return text.replace(/\s+/g, ' ').slice(0, 160) }
// 触发器卡片：把一个 Trigger 投影为紧凑对象；可选携带处置结果（disposition：过滤原因 / 决策 id / 投递范围）
export function triggerCard(trigger: Trigger, disposition?: TriggerDisposition) {
  // 基础字段：id、来源、可选来源 URL、触发者、首个线程键、是否人工、时间、文本预览与长度、可读资源路径；
  // 条件展开（...?{}:{}）保证可选字段在不存在时完全不出现在卡片里
  return { trigger_id: trigger.id, source: trigger.source, ...(trigger.url ? { source_url: trigger.url } : {}), actor: trigger.actor.id, thread: threadKey(trigger.threads[0]!), human: trigger.human, at: trigger.at,
    preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}`,
    // 存在处置结果时补充：filtered 为被过滤原因文本、decision_id 为关联决策、delivered_to 为实际投递目标列表
    ...(disposition ? { disposition: { ...(disposition.filtered ? { filtered: reasonText(disposition.filtered) } : {}),
      ...(disposition.decisionId ? { decision_id: disposition.decisionId } : {}),
      delivered_to: disposition.fanout } } : {}) }
}
/** The states a ticket card shows: an open ticket's stage (docs/003), and an ended ticket's outcome. */
// 工单卡片可能展示的全部状态：未结束工单显示阶段（stage，见 docs/003），已结束工单显示结局（outcome）
export const TICKET_STATES = ['person/delivery', 'person/answer', 'person/review', 'person/blocked', 'person/failed', 'working', 'working/queued', 'idle',
  'completed', 'merged', 'closed', 'dropped', 'stopped'] as const
// 由状态常量数组推导出的字符串字面量联合类型
export type TicketCardState = typeof TICKET_STATES[number]
// 计算某张工单当前应显示的卡片状态
function cardState(ticket: Ticket): TicketCardState {
  // 已结束的工单直接显示结局（completed/merged/closed/dropped/stopped 等）
  if (ticket.ended) return ticket.ended.outcome
  // 未结束则计算当前所处阶段
  const stage = ticketStage(ticket)
  // 阶段为 person（等人操作）时，状态为 person/<动作>（delivery/answer/review/blocked/failed）
  if (stage.stage === 'person') return `person/${stage.action}`
  // idle 直接映射；working 且已排队动作时显示 working/queued，否则显示 working
  return stage.stage === 'idle' ? 'idle' : stage.stage === 'working' && stage.action ? 'working/queued' : 'working'
}
// 工单卡片：把一张 Ticket 投影为紧凑对象（模型据此了解工单概况）
export function ticketCard(ticket: Ticket) {
  // 已结束时补充 ended 信息：结束时间、操作者、原因（未填原因时退回用结局名充当）
  const ended = ticket.ended && { at: ticket.ended.at, by: ticket.ended.by, reason: ticket.ended.reason ?? ticket.ended.outcome }
  // 取出工单的 attention（需要人关注的问题）
  const { attention } = ticket
  // 基础字段：id、标题、卡片状态、授权强度（mandate.strength）；条件补充 PR 编号、ended 信息与 attention；
  // preview 取最新报告摘要的预览（无报告则为空）；read 指向工单可读资源
  return { ticket_id: ticket.id, title: ticket.title, state: cardState(ticket), strength: ticket.mandate.strength,
    ...(pullOf(ticket) ? { pr_number: pullOf(ticket) } : {}), ...(ended ? { ended } : {}),
    ...(attention ? { attention: { question: attention.question, ...attention.triggerId ? { trigger_id: attention.triggerId } : {} } } : {}),
    preview: preview(latestReport(ticket)?.summary ?? ''), read: `ticket/${ticket.id}` }
}
/** Strips `policyVersion`, an internal hash that callers never query by. */
// 从 mandate（授权）中去掉 policyVersion 字段——它是内部哈希，调用方从不按它查询，避免污染卡片
const mandateOf = ({ policyVersion: _version, ...mandate }: Mandate) => mandate
// 卡片内联展示的输入（INPUTS）与派工记录（ASSIGNMENTS）条数上限
export const INPUTS = 10, ASSIGNMENTS = 3
// 单条输入文本内联展示的最大长度；超过该长度则退化为"预览 + 可读资源引用"
const INPUT_TEXT = 80
/** Summarizes a ticket input inline for short text or as a resource reference, omitting decision IDs for worker Sessions. */
// 工单输入（TicketInput）的单行投影：短文本直接内联，长文本给预览并附可读资源；worker 会话不展示 decision_id
export function inputLine(ticket: Ticket, input: TicketInput, worker = false) {
  // 生成该输入对应的可读资源引用（read 字段）
  const read = { read: inputResource(ticket.id, input.id) }
  // names：按输入类型决定附加字段——触发器/续传给 trigger_id；reopen 且非 worker 给 decision_id；
  // 其他非纯文本给可读资源；纯文本不超过 80 字符内联全文，超长则给截断预览、总长与可读资源
  const names = input.kind === 'trigger' || input.kind === 'resumed' ? { trigger_id: input.triggerId }
    : input.kind === 'reopen' && !worker ? { decision_id: input.decisionId }
    : input.kind !== 'text' ? read
    : input.text.length <= INPUT_TEXT ? { text: input.text }
    : { preview: preview(input.text).slice(0, INPUT_TEXT), chars: input.text.length, ...read }
  // 输出：类型、时间、上面选定的附加字段；尚未成功投递的输入追加 undelivered 标记
  return { kind: input.kind, at: input.at, ...names, ...ticket.undelivered.includes(input.id) ? { undelivered: true } : {} }
}
// 单条派工记录（assignment）的投影：id、状态、创建时间；有结束原因时翻译为可读文本；
// 有报告时内联报告状态、时间、摘要预览（截到 100 字符）与该报告的可读资源路径
export function assignmentLine(ticket: Ticket, item: Ticket['assignments'][number]) {
  return { id: item.id, state: item.state, at: item.createdAt, ...(item.endedReason ? { ended_reason: reasonText({ code: item.endedReason }) } : {}),
    ...(item.report ? { report: { state: item.report.state, at: item.report.at, preview: preview(item.report.summary).slice(0, 100),
      chars: item.report.summary.length, read: `ticket/${ticket.id}/report/${item.id}` } } : {}) }
}
// 通用"最新优先"分页工具：把 items 倒转（新→旧）后按 offset/size 切页；
// 还有更多时附 next_resource 与 next_offset，供模型按同一资源继续翻页
export function newestPage<T, L>(items: readonly T[], offset: number, size: number, line: (item: T) => L, next: string) {
  // 复制后倒转，使最新条目排最前（底层数组按追加序存放）
  const newest = items.slice().reverse()
  // 判断本页之后是否还有更多条目
  const more = offset + size < newest.length
  // 返回本页条目（逐条经 line 函数投影）；more 时附翻页游标
  return { items: newest.slice(offset, offset + size).map(line), ...more ? { next_resource: next, next_offset: offset + size } : {} }
}
// 工单详情里的线程引用条目：thread 为线程键；context 表示仅作上下文引用；bound 表示已绑定订阅
export interface TicketThread { thread: string; context?: true; bound?: true }
/** Projects a ticket with its linked triggers, threads, and first pages of assignments and inputs, omitting decision IDs for workers. */
// 工单详情投影：含来源触发器、线程列表、派工记录与输入的第一页；worker 会话省略 decision_id
export function ticketDetails(ticket: Ticket, threads: TicketThread[], batch: readonly Trigger[], worker = false) {
  // Drop card preview because the latest report's preview is already shown on the first assignment entry.
  // 从卡片中去掉 preview 字段（最新报告的预览已展示在第一条派工记录里，避免重复）
  const { preview: _preview, ...card } = ticketCard(ticket)
  // 组装详情：卡片基础信息、来源触发器 id、同批次其他触发器（batch，若有）；
  // 非 worker 才带 decision_id；线程列表、执行目录、授权范围与发起人；
  // assignments/inputs 各给第一页（后续页经 read 资源翻页读取）；末尾附 assignment/result/transcript 三个可读资源路径
  return { ...card, trigger_id: ticket.origin.triggerId, ...batch.length ? { batch: batch.map(batchLine) } : {},
    ...worker ? {} : { decision_id: ticket.decisionId }, threads, directory: ticket.execution?.directory,
    scope: ticket.mandate.scope, requested_by: ticket.mandate.actor.id,
    assignments: newestPage(ticket.assignments, 0, ASSIGNMENTS, item => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`),
    inputs: newestPage(ticket.inputs, 0, INPUTS, input => inputLine(ticket, input, worker), `ticket/${ticket.id}/inputs`),
    assignment: `ticket/${ticket.id}/assignment`, result: `ticket/${ticket.id}/result`, transcript: `ticket/${ticket.id}/transcript` }
}

// 线程卡片：线程键、人类可读标签、来源、订阅的工单列表；正在评估时附起始时间与截止时间；
// pending 为待处理触发器数量；轮询出错给错误预览、有外部链接附 url；read 指向线程可读资源
export function threadCard(thread: Thread, label: string) {
  return { thread: thread.key, label, source: thread.ref.source, tickets: thread.subscriptions,
    ...(thread.evaluating ? { evaluating: { since: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } } : {}),
    pending: thread.pending.length,
    ...(thread.meta.pollError ? { error: preview(String(thread.meta.pollError)) } : {}), ...(thread.meta.url ? { url: thread.meta.url } : {}),
    read: `thread/${thread.key}` }
}
// 决策（Decision）卡片：决策 id、类型、原因文本、强度（explicit/implicit）、所属线程键、
// 触发它的触发器 id 列表、可选关联工单 id、时间；read 指向决策可读资源
export function decisionCard(decision: Decision) {
  return { decision_id: decision.id, kind: decision.kind, reason: reasonText(decision.reason), strength: decision.strength,
    thread: decision.threadKey,
    trigger_ids: decision.triggerIds, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), at: decision.at,
    read: `decision/${decision.id}` }
}
// 决策详情：在卡片基础上补充授权内容（mandate，去掉内部 policyVersion）与审计信息（audit，若有）
export function decisionDetails(decision: Decision) {
  return { ...decisionCard(decision), ...(decision.mandate ? { mandate: mandateOf(decision.mandate) } : {}),
    ...(decision.audit ? { audit: decision.audit } : {}) }
}
/** Slices text by UTF-16 code units so concatenated pages reconstruct the exact string. */
// 按 UTF-16 码元切页：各页按 offset 顺序拼接后可精确还原原文（不做字符感知切分，保证无损）
export function textPage(resource: string, text: string, offset: number, limit: number) {
  // 计算本页结束位置（不超过文本总长）
  const end = Math.min(text.length, offset + limit)
  // 返回资源名、本页 offset、总字符数、下一页 offset（已到末尾则为 null）与本页文本
  return { resource, offset, total_chars: text.length, next_offset: end < text.length ? end : null, text: text.slice(offset, end) }
}
// 相关工单列表：未结束的排前面、同组内按创建时间倒序；最多展示 8 张卡片并给出总数
export function relatedTickets(tickets: readonly Ticket[]) {
  // 排序规则：两者"是否未结束"相同时按创建时间倒序（新的在前）；否则未结束者排前（a 已结束则 a 靠后）
  const order = [...tickets].sort((a, b) => Number(!a.ended) === Number(!b.ended) ? b.createdAt.localeCompare(a.createdAt) : a.ended ? 1 : -1)
  // 输出前 8 张工单卡片与工单总数
  return { related_tickets: order.slice(0, 8).map(ticketCard), tickets_total: tickets.length }
}
