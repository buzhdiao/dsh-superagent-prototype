/** Ticket stage classification and retry eligibility (docs/003). */
// Ticket 阶段（stage）分类与可重试判断，对应 docs/003 的阶段表。
// panel（web 面板）据此决定把每个 Ticket 摆在哪个列表、给人什么提示。
import { latestAssignment, waitsForPerson, type Ticket } from './model.ts'

/** High-level execution stage of a ticket: waiting on a person, actively working or queued, idle between turns, or ended. */
// TicketStage：Ticket 的执行阶段——
// person（等人：投递失败/待回答/待复审/blocked/failed）、working（干活或排队中）、idle（回合间空闲）、ended（已结束）。
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' }

/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
// ticketStage：把 Ticket 归入某个阶段；规则按 docs/003 的表顺序判断，第一条命中的生效。
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  // A human follow-up after a blocked or failed report returns the ticket to the executor.
  // blocked/failed 报告后若仍等人（没有真人消息来解阻），就停在 person 阶段。
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  // 没有 Assignment 或最新一个还在排队：working/queued。
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  // 报告 waiting（等新输入）或 Assignment 已结束：idle（回合间空闲）。
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  // 其余（如 progress）：working。
  return { stage: 'working' }
}

/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
// canRetry：存活的 Ticket 能否被人工重试——
// 卡在 blocked/failed 报告且之后没有真人跟进，或 Input 投递失败未恢复。
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}
