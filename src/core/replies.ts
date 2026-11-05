/** The Engine's messages to Channels, each by the rule that allows it. */
// Replies（回写部件）：Engine 对 Channel 的所有写消息，每一条都由允许它的规则放行。
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
// ReplyRequest：按目的（purpose）区分的四类消息——
// acknowledgement：worker 对所接真人请求的确认；answer：worker 报告后对真人问题的回答；
// result：处于 ready/completed/merged/dropped 的 Ticket 的结果；attention：Ticket 当前待人的问题。
// 不带 ticketId 时，用 triggerId 反查它到达的 Ticket。
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
// Reply：排队结果——消息 id、当前状态、以及是否命中了之前已排队的同 id 消息（reused）。
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
// Replies 通过 Outbox 端口写 Channel：确认、回答、结果、提问，各自只在规则允许时发出；
// 消息 id 由内容确定性派生，保证同一消息不会发两次（幂等）。
// Engine.reply 路由到这里；Tickets 在 accept 时请求确认消息；Assignments 在问题被替换时请求撤回。
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  // reply：按目的排队一条消息——
  // 确认/回答发往那条真人消息所在的会话；提问发往引发问题的消息所在会话（或 Ticket 起始会话）；
  // 结果发往 Ticket 的起始会话，且仅当 Ticket 处于 ready/completed/merged/dropped。
  // 每条消息至多排队一次；确认即使已排队，也会记录 worker 已"接下"该消息。
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  // acknowledgeAccepted：accept 决定自带的确认消息——
  // 发往发起 Ticket 的那条消息所在处；要求该消息有 Channel 且是真人写的，否则不发。
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  // withdrawAttention：从发件箱撤回 Ticket 尚未发出的提问消息（已被报告替换或清除时用）。
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  // acknowledge：确认消息的规则与入箱。
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    // 已结束的 Ticket 不再补发确认（避免对历史请求刷屏）。
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    // 仅上下文 Thread 是只读的：不向其发确认。
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    // 首次确认必须是真人消息（bot/CI 不需要被确认）。
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    // 保留已有的自动确认或第一条排队确认——重复请求不重复发送。
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    // 无论是否新排队，都记录该 Ticket 的 worker 已接下这条消息。
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  // answer：回答 / 结果 / 提问三类消息的规则与入箱。
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    // 未给 ticketId 时：反查该 Trigger 到达过的 Ticket。
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      // result 的放行规则：Ticket 已按结果结束（merged/completed/dropped），或存活且最新报告为 ready。
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    // 提问消息必须与 Ticket 当前打开的问题文本一致，防止把常规未完成工作当问题发出去。
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    // 回答只能针对真人的原始问题（worker 报告、自动触发器不行）。
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    // 确定性 id：提问按 attention.id，其余按（trigger/ticket + 文本）派生——同内容不会重复发。
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    // 回答的放行条件：worker 已报告该问题的答案（answers 列表里有它），或消息已排队过。
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    // 目标 Channel：回答发给原始问题所在会话；提问/结果发给引发问题的消息或 Ticket 起始会话。
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {} })
    // 答案发出后从 answers 列表移除：同一个问题不会被重复答复。
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  // sourceChannel：Ticket 的起始会话——源 Trigger 的 Channel，退而取其第一个 Channel。
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
