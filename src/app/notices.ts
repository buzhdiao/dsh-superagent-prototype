/** Formats background notices and steering relays delivered to the main Session via the effect queue. */
// notices：组装发往主会话（Router）的两类消息——
// 后台通知（notice，注入不唤醒）与转向转发（relay，进入主会话回合并唤醒它），
// 都经效果队列（Effects）送达。
import { randomUUID } from 'node:crypto'
import { followupOwners, key, liveTicket, type DomainEvent, type Ticket, type WorkerReport } from '../core/index.ts'
import { triggerMessage } from '../executor/dsh.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { repliedTo } from './links.ts'
import type { Store } from './store.ts'
import { ticketCard } from './cards.ts'

/**
 * A background notice tuple for the main Session: `[name, value, summary]`, where `name` is the coalescing key in
 * `Effects` (a newer notice with the same `name` overwrites an unsent waiting one, rather than permanently deduplicating future notices).
 */
// Notice：后台通知的三元组 `[name, value, summary]`——
// name 是 Effects 里的合并键（同名的未发送等待通知会被更新者覆盖，而不是永久去重）。
export type Notice = readonly [name: string, value: Record<string, unknown>, summary: string]
/** Builds a notice for a saved prompt configuration revision, coalescing under `'prompts'`. */
// promptsNotice：提示词配置保存的通知——同一合并键 `prompts`，连续保存只提醒最新一次。
export const promptsNotice = (revision: number): Notice =>
  ['prompts', { prompt_config_saved: revision, effect: 'next-request', read: `prompts/${revision}` }, `Prompt configuration saved (revision ${revision})`]
/**
 * Builds a notice for a saved settings block with the changed dot-separated paths (coalescing per block under
 * `settings:<block>`), or for the whole settings on legacy saves that recorded no block.
 */
// settingsNotice：设置保存的通知——按块合并（settings:<block>），附变更的点分路径；
// 没记录块的旧式保存对整个 settings 通知。
export const settingsNotice = (block?: string, changed: string[] = []): Notice => block
  ? [`settings:${block}`, { settings_saved: block, changed, read: `settings/${block}` }, `Settings saved: ${block}`]
  : ['settings', { settings_saved: true, read: 'settings' }, 'Settings saved']
/** Returns up to 20 dot-separated paths where two values differ (e.g. `eval.mode` or `policy.rules.1.enabled`). */
// changedPaths：递归比较两个值，返回至多 20 个有差异的点分路径（如 eval.mode、policy.rules.1.enabled）。
export function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  // 序列化比较：相等即无差异（简单可靠，规模有限）。
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  // 有一方不是对象（或为空）：整个路径算一个差异点。
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [path]
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const at = (value: object, name: string) => (value as Record<string, unknown>)[name]
  return keys.flatMap(name => changedPaths(at(before, name), at(after, name), path ? `${path}.${name}` : name)).slice(0, 20)
}
/** Strips the latest report preview from a ticket card when the relay already carries or does not need the summary. */
// brief：给转发用的 Ticket 卡片去掉最新报告预览——摘要已经在消息本体里，不重复。
function brief(ticket: Ticket) {
  const { preview: _preview, ...card } = ticketCard(ticket)
  return card
}
/** Creates a one-off receipt notice with a unique `name` key so repeated occurrences of the same event are each delivered instead of coalescing. */
// receiptNotice：一次性"回执"通知——用随机唯一键，同一种事件发生多次每次都送达（不合并）。
export const receiptNotice = (value: Record<string, unknown>, summary: string): Notice => [key('receipt', randomUUID()), value, summary]
/** Builds a notice that a person removed a thread's subscriptions at `at`; a later removal of the same thread replaces an unsent waiting notice. */
// subscriptionNotice：人退订了某 Thread 的通知——按 Thread 合并；同一 Thread 的多次退订只留最新。
export const subscriptionNotice = (thread: string, at?: string): Notice => [`subscription:${thread}`,
  { subscription_changes: [{ thread, removed: true }], ...at ? { at } : {} }, `Removed the subscriptions on thread ${thread}`]

/**
 * Converts an unsolicited domain event into a main-Session notice (`ticket.ended`, `trigger.requeued`, or
 * `thread.unsubscribed` by a person or executor); returns `undefined` for events that require no notice.
 */
// eventNotice：把"主会话没主动做的"领域事件转成通知——
// ticket.ended、trigger.requeued、thread.unsubscribed；其余事件不需要通知。
export function eventNotice(event: DomainEvent, ticket: (id: string) => Ticket | undefined = () => undefined): Notice | undefined {
  const { at } = event
  if (event.type === 'ticket.ended') {
    const { ticketId, by, outcome, reason = outcome } = event.data
    // 尽量带上结束时的 Ticket 卡片（brief 版）。
    const ended = ticket(ticketId)
    return receiptNotice(ended ? { ticket_ended: brief(ended) } : { ticket_ended: ticketId, by, outcome, reason, at }, `Ticket ${ticketId} ended (${reason})`)
  }
  if (event.type === 'trigger.requeued') {
    const id = event.data.triggerId
    return receiptNotice({ trigger_requeued: id, read: `trigger/${id}`, at }, `Trigger ${id} queued for a fresh assessment`)
  }
  // 人退订：普通退订通知。
  if (event.type === 'thread.unsubscribed' && event.data.by === 'person') return subscriptionNotice(event.data.threadKey, at)
  if (event.type === 'thread.unsubscribed') {
    // Executor 退订：说明 worker 读过之后认为无关——后续消息要指名才会再附加给该 Ticket。
    const { ticketId, threadKey: thread, reason } = event.data
    const note = 'Its Executor found this thread unrelated after reading it; attach later triggers there to this ticket only when they '
      + 'point at it explicitly.'
    return receiptNotice({ thread_unrelated: { ticket_id: ticketId, thread, reason }, at, note },
      `Ticket ${ticketId} no longer follows thread ${thread}: ${reason}`)
  }
  return undefined
}

/** Builds a background notice when a ticket's worker subscribes to a related thread for context only. */
// threadFollowedNotice：worker 为上下文订阅了一个相关 Thread 的通知（说明"仅上下文、不授权"）。
export const threadFollowedNotice = (ticketId: string, thread: string, reason: string): Notice =>
  receiptNotice({ thread_followed: { ticket_id: ticketId, thread, reason },
    note: 'For context only: its messages reach this ticket and grant nothing.' },
    `Ticket ${ticketId} follows thread ${thread} for context: ${reason}`)

/** Steering relay payload for the main Session: `id` is the request ID that makes delivery idempotent, and `text` is the message body. */
// Relay：转向主会话的转发载荷——id 是请求 id（保证投递幂等），text 是消息体。
export interface Relay { id: string; text: string }
/** What a follow-up asks of the main Session: nothing but a stop the person asks for, since its ticket's worker decides it. */
// FOLLOWUP_NOTE：追问转发的固定说明——worker 决定它，主会话只在人要求停止时出手。
const FOLLOWUP_NOTE = 'Its ticket\'s worker has it and decides; act only if the person asks to stop the work '
  + '(orchestrator_route kind stop with this trigger_id).'
/**
 * Builds a steering relay for a human follow-up trigger that reached at least one live ticket (including an ended ticket
 * that resumed on the follow-up), with the trigger rendered as workers read it, the replied-to message, and the open
 * tickets it reached; returns `undefined` while no ticket's worker decides it (see `followupOwners`) or it reached no live ticket.
 */
// followupNotice：为"到达了至少一个存活 Ticket 的真人追问"构造转发——
// 内容：worker 视角的 Trigger 卡、所回复的消息、到达的存活 Ticket 列表。
// 没有 Ticket 的 worker 决定它、或没到达存活 Ticket 时不转发。
export function followupNotice(store: Store, sources: SourceRegistry, triggerId: string): Relay | undefined {
  const trigger = store.triggers.get(triggerId)
  const disposition = store.triggers.disposition(triggerId)
  if (!trigger || !followupOwners(trigger, store).length) return undefined
  // 收集到达的存活 Ticket（附状态与是否仅上下文）。
  const tickets = disposition!.fanout.flatMap(id => {
    const ticket = store.tickets.get(id)
    const context = disposition!.context?.includes(id) ? { context: true } : {}
    return ticket && liveTicket(ticket) ? [{ ticket_id: id, title: ticket.title, state: ticketCard(ticket).state, ...context }] : []
  })
  if (!tickets.length) return undefined
  return followupRelay(triggerMessage(trigger, {}, undefined, repliedTo({ store, sources }, trigger)), tickets)
}
/**
 * A person's message that reached tickets, as the main Session hears of it: the message as their workers read it, and the
 * tickets it reached with their state. Their workers decide it; the main Session may only stop the work on it.
 */
// followupRelay：追问转发的消息体——kind=follow_up，带到达 Ticket 与固定说明。
export function followupRelay(message: { trigger_id: string },
  tickets: readonly { ticket_id: string; title: string; state: string; context?: boolean }[]): Relay {
  return { id: `followup:${message.trigger_id}`, text: JSON.stringify({ kind: 'follow_up', ...message, delivered_to: tickets,
    note: FOLLOWUP_NOTE }) }
}
/** Formats a worker report relay for the main Session (truncating summaries over 600 characters behind `ticket/<id>/result`); `replyTo` names the human question trigger it answers. */
// resultRelay：worker 结果/状态转发的消息体——
// kind=worker_report；摘要超过 600 字截断（全文在 ticket/<id>/result 资源里）；
// replyTo 标明它回答的是哪条真人提问。
export function resultRelay(ticket: Ticket, state: string, text: string, replyTo?: string): Relay {
  // id 由 Ticket + 更新时间 + 文本派生：同状态重复转发合并，变化则新发。
  const id = key('worker-result', ticket.id, ticket.updatedAt, text)
  const summary = text.length > 600 ? { summary: text.slice(0, 600), chars: text.length } : { summary: text }
  const report = { kind: 'worker_report', ticket: brief(ticket), trigger_id: ticket.origin.triggerId, state, ...replyTo ? { answer_to: replyTo } : {},
    ...summary, read: `ticket/${ticket.id}/result` }
  return { id: `report:${id}`, text: JSON.stringify(report) }
}
/**
 * Converts a worker report recorded on `ticket` into a main-Session relay: a question for a person produces a
 * `worker_attention` relay, and a result, blocker, end, or answer to a question produces a `worker_report` relay, while
 * routine `progress` reports without `answers` stay internal.
 * @returns The steering `Relay`, or `undefined` when the report is not relayed to the main Session.
 */
// reportRelay：把 worker 报告转成给主会话的转发——
// 有人问题 → worker_attention（立刻转发，问题等人）；
// 结果/阻塞/结束/回答 → worker_report；
// 无回答的普通 progress → 不打扰主会话（undefined，留在 Ticket 与面板上）。
export function reportRelay(ticket: Ticket, report: Pick<WorkerReport, 'state' | 'summary' | 'question' | 'answers'>): Relay | undefined {
  const asked = report.question ? ticket.attention : undefined
  if (asked) {
    return { id: `attention:${ticket.id}:${asked.id}`,
      text: JSON.stringify({ kind: 'worker_attention', ticket: brief(ticket), state: report.state, read: `ticket/${ticket.id}/result` }) }
  }
  if (report.state === 'progress' && !report.answers) return undefined
  return resultRelay(ticket, report.state, report.summary, report.answers)
}
