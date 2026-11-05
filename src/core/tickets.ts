/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
// Tickets（工单部件）：Ticket（工单，work item）从 accept 到结束的完整生命周期、
// 订阅关系（Subscription）与输入（Input）的管理。
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, readUntil, runningAssignment, settled, threadKey, waitsForPerson } from './model.ts'
import type { Assignment, ChannelRef, Evaluation, Follow, Mandate, PolicyEffect, ThreadRef, Ticket, TicketEndBy, TicketInput, TicketOutcome,
  Trigger, TriggerDisposition } from './model.ts'
import type { AssessmentOutcome } from './ports.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { canRetry } from './stage.ts'

// sameChannel：比较两个 Channel（回写地址）是否相同——用 JSON 序列化比较（字段顺序由构造处保证一致）。
const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
// automatic：一个 Input 是否"非人写"——CI、bot、主会话的 note 都算。
// blocked/failed 时扣留的就是这类输入。
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
 * into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
 */
// readBefore：worker 是否在 `until`（最新报告/回合结束）之前读过某条 trigger Input——
// 判断依据是 Session 纳入步骤的时间（readAt）；旧数据没有 readAt，但只要在 until 前已送达（deliveredAt）
// 就算读过。
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
// STATUS_REQUEST：向 worker 请求状态汇报的固定话术——明确"只报状态，别继续实现、别做外部操作"。
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'

/**
 * Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
 * Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
 * Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
 * Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
 */
// Tickets 管理 Ticket 的一生：accept 决定创建 Ticket（带 Mandate、订阅、首个 Assignment）、
// 绑定/附加 Thread、添加 Input、恢复（resume）、重试（retry）、重启（restart）、结束（end）、退订。
// 与 Replies 协作发确认，与 Executor 协作启动/投递/停止。
// Intake、Evals、Assignments、Engine 的 Ticket/订阅变更都委托到这里。
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

  /**
   * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
   * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
   * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
   */
  // create：按 accept 决定创建 Ticket——
  // 带 Mandate、批次内各 Trigger 的 Channel 与 Thread（自动订阅）、首个 Assignment、确认消息，并排队启动。
  // origin 取 primary（最强可准入 Trigger）；旧数据没有 primary 时退回批次最后一条。
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // Fall back to the last trigger for Evals recorded before `primary` existed.
    // 兼容：`primary` 字段出现之前的 Eval，回退用批次最后一条。
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    // 初始 Ticket：空 channels/assignments/inputs/undelivered，origin 记录发起与整批。
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    let ticket: Ticket = { id, title: outcome.title, decisionId, mandate, channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin }
    // 收集批次内所有去重后的 Channel——之后这个 Ticket 的回复都发往这些会话。
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel)
    }
    // prepareTicket 钩子：Executor 借此填入执行信息（worktree 名、目录、任务说明）。
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    // 订阅批次 Trigger 所在的所有 Thread——这些 Thread 上后来的消息都会扇出给本 Ticket。
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    // 确认消息：accept 自带的 acknowledgement，发往发起消息的会话。
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    // 通知 Executor 启动首个 Assignment（入队 launch effect）。
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /**
   * Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
   * @throws UserError when the ticket is unknown or has ended.
   */
  // bind：Source 要求某个存活 Ticket 跟随它的一个 Thread——订阅 + 记入 follows。
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // Re-binding a thread reopens it if previously closed; `own` remains true once set.
    // 重复绑定 = 重新打开（清除 closed 记录）；own 一旦为 true 就保持。
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
   * work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
   */
  // threadClosed：记录 Thread 关闭（PR 合并/关闭），并结束所有"跟完 Thread"的 Ticket——
  // 除非其工作尚未收尾（unfinished）；那样的 Ticket 等下一条 ready/dropped 报告再结束。
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      // 只处理还开着（未记录关闭）的跟随项。
      const follow = ticket.follows?.find(item => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      // 没跟完、或关闭后工作还没收尾的，先不结束。
      if (!done || this.unfinished(ticket, at)) continue
      // Work resumed after the close and finished ends now.
      // 关闭之后才恢复并完成的工作：结束时间用现在，而不是关闭时间。
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }
  /**
   * How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
   * once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
   */
  // followsDone：跟随 Thread 的 Ticket 何时算"跟完了"——
  // 自己开过 Thread（own）：它们全部关闭即可；没开过：跟随的所有 Thread 都得关闭。
  // 返回其中最晚的一次关闭（决定结束结果与时间）；没跟完则 undefined。
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    // 按关闭时间排序取最晚者（字符串比较，ISO 时间戳保证字典序即时间序）。
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /**
   * The Trigger to attach to a ticket, once the ticket may take it.
   * @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
   */
  // attachable：附加前的校验——Trigger 存在、没有 Ticket 的 worker 仍在决定它、
  // 目标 Ticket 未被人停止；已结束的 Ticket 要求其 Mandate 在当前 Policy 下仍成立。
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
    // worker 仍在决定的追问不能被主会话抢走——先退回才轮到别人。
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError('mandateRevoked')
    return trigger
  }
  /**
   * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
   * then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
   * message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
   */
  // attach：把 Trigger 附加给 Ticket——订阅其 Thread、作为 Input 加入（可带路由备注）。
  // 之后 worker 像对待自己 Thread 上的消息一样决定它；
  // 若 worker 并不"持有"该消息（曾让掉/仅上下文/结束后才有），就作为新 Input 再送一次（唤醒已结束的 Ticket）。
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
    // 取当前 disposition：人工送 Eval 的 requeued 标记、仅上下文阅读的 context 标记都就此终结。
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter(id => id !== ticketId)
    // fanout 里加上本 Ticket（去重）；context 里去掉它。
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: [...new Set([...disposition.fanout, ticketId])],
      ...followed?.length ? { context: followed } : {} })
    const ticket = this.require(ticketId)
    // 确定性 Input id：同一 Trigger 对同一 Ticket 的首次附加永远同 id（幂等）。
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find(input => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({ id: inputId, kind: 'trigger', triggerId: trigger.id, at, ...(note ? { note } : {}),
      ...trigger.human ? { human: true } : {} })
    // 情况一：worker 还没见过该 Trigger——直接加 Input（新 id 或已有 id）。
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id))
    // 情况二：Input 还在等投递，且有新备注——就地更新备注。
    else if (note && ticket.undelivered.includes(id)) { existing.note = note; ticket.updatedAt = at; this.repo.tickets.save(ticket) }
    // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context only, or ended after
    // its worker had it, so the worker gets it again.
    // 情况三：worker 本不持有该消息（人工送 Eval / 曾让掉 / 仅上下文读过 / 结束后才附加）——
    // 用带时间戳的新 id 再送一份。
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // The worker has the message already, so the note comes with it again.
    // 情况四：worker 已持有消息——只有备注时，把备注作为新 Input 送一次。
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
  }
  /**
   * Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
   * @returns whether the status request input was queued.
   * @throws UserError when the ticket is unknown.
   */
  // requestStatus：只对"最新报告为 waiting"的运行中 worker 请求状态汇报（用固定话术作为 text Input）。
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    // Input id 含 updatedAt：同一状态期间重复请求是同一条（幂等），状态变化后允许再问。
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
  }
  /**
   * Stops a ticket on behalf of a human, ending any active assignments.
   * @throws UserError when the ticket is unknown.
   */
  // stop：人停止 Ticket——以 human 身份结束，活动中的 Assignment 一并终止。
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * Ends the stalled assignment of a retryable open ticket (`failed`, `blocked`, or failed input delivery) and starts a new one.
   * @throws UserError when the ticket is unknown or not retryable.
   */
  // retry：人工重试——结束停滞的 Assignment（标记 retried），把 worker 没读过的 Input 挪回队首，
  // 开新 Assignment 并让 Executor 停旧启新。
  retry(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    const latest = latestAssignment(ticket)
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable')
    this.endAssignment(ticket, latest, 'retried')
    this.requeueUntaken(ticket, latest)
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.stop(ticket, latest, 'retried')
    this.options.executor.start(ticket, assignment)
    return ticket
  }
  /**
   * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
   * @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
   */
  // markUnrelated：worker 发现某个附加 Thread 与本 Ticket 无关——
  // 退订该 Thread（仅本 Ticket），并把"该 Ticket 在其上仍决定、且没被接下的"真人消息按原因退回。
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    // 不允许退订：Ticket 的发起 Thread、Source 绑定的 Thread（follows）、或本来就没订阅的。
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // Its worker found the Thread is not its ticket's: it hands back, with its reason, the person's messages there it decides.
    // 逐条检查本 Ticket 的 Trigger 输入：在其上的、仍由本 Ticket 决定的，退回。
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
   * were accepted; the others are left alone.
   */
  // policyChanged：把 Policy 变更的影响告知每个受影响的存活 Ticket（各加一条 policy-changed Input）。
  // 按接受时间从旧到新遍历——投递队列因此保持接受顺序。
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // Iterate tickets oldest first so deliveries queue in acceptance order.
    // 最旧优先遍历，保证投递顺序与接受顺序一致。
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // Include `at` in the input key so repeated transitions between the same policy versions still record a new input.
      // Input id 里带上 at：同一对版本之间来回变更也能各自记录一条。
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
   * followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
   * it received from the Thread.
   */
  // dropSubscriptions：退订一个 Thread——所有 Ticket 或仅 `ticketId`；没有任何退订则返回 false。
  // 同时从各 Ticket 的 follows 里移除（其关闭不再影响 Ticket 结束）。
  // 注意：各 Ticket 保留对"已经收到的"消息的决定权。
  dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean {
    const current = this.repo.threads.get(thread)
    const tickets = current?.subscriptions.filter(id => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter(id => !tickets.includes(id))
    this.repo.threads.save(current)
    // 从每个 Ticket 的 follows 里移除该 Thread（没有 follows 字段的保持没有）。
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some(item => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter(item => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) this.emit('thread.unsubscribed', { threadKey: current.key, ticketId: id, by, ...(reason ? { reason } : {}) })
    return true
  }
  /**
   * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
   * failed once no person is waited for: a Policy change alone does not launch it again.
   */
  // addInput：幂等地加入一个 Input，然后：
  // - 有运行中 Assignment → 请求投递；
  // - 有 pending 的 Assignment 且没人等 → 请求再次启动（launch 失败后靠新输入自救；纯策略变更不重启）。
  addInput(ticket: Ticket, input: TicketInput): void {
    // 幂等：同 id 的 Input 只加一次。
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // Hold back automated inputs while the worker is waiting on a person.
    // worker 正等人时，扣留非人写的自动输入（别往人和机器中间塞机器消息）。
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest)
  }
  /**
   * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
   * and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
   * takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
   * the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
   */
  // wake：已结束的 Ticket 被其 Thread 上的真人消息唤醒——
  // 在原 Mandate 不变下恢复（没有新 Eval、没有新 Decision，因为没有新授权）。
  // Mandate 已不被当前 Policy 认可 → 保持结束并放手（refuse）。
  // 暂停期间消息先等着，暂停后的第一个 pass 再按当时的 Policy 恢复。
  // 每次都重新读 Ticket：幂等，已恢复的不受影响。
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    // 不存在 / 还活着 / 被人停止（Mandate 已撤回，绝不自动恢复）/ 没有等投递的输入 → 无事可做。
    if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) return
    const policy = this.policy()
    if (policy.paused) return
    if (!policy.revalidate(ticket.mandate)) { this.refuse(ticket); return }
    // Only a human's message resumes an ended ticket; bot/CI triggers wait alongside inputs from before the ticket ended.
    // 只有真人消息能恢复已结束的 Ticket；bot/CI 的与"结束前遗留输入"一起继续等。
    const first = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).find(input => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const at = this.now()
    delete ticket.ended; ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    // Prepend the resumed marker so it is delivered ahead of the waiting messages.
    // 插入 resumed 标记 Input 并放到队首——先告诉 worker"这条消息恢复了本 Ticket"，再送遗留消息。
    const resumed: TicketInput = { id: key('input', ticket.id, 'resumed', first.triggerId), kind: 'resumed', triggerId: first.triggerId, at }
    ticket.inputs.push(resumed); ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }
  /** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
  // triggersOf：Ticket 的 trigger Inputs 对应的 Trigger 实体（可按 ids 过滤）。
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
   * acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
   */
  // takenUp：worker 是否"接下"过某条真人消息（确认或回答过）。
  // 兼容旧数据：确认机制出现之前的消息，看发件箱里有没有它的确认消息。
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
  // untaken：指定 Input ids 中，"本 Ticket 决定且 worker 尚未接下"的真人消息。
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
   * messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
   * that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
   * up, a Decision settled it, or it is the message a stop ended this ticket on.
   */
  // letGo：Ticket 结束（或无法恢复）时"放手"——
  // waiting：worker 从未收到的消息；left：它决定过但 worker 没接下的真人消息。
  // 两者都从 disposition.fanout 中移除本 Ticket（不再算"到达过"）；
  // left 中没有其他 Ticket 决定、未被接下、未被 Decision 了结、也不是停止本 Ticket 的那条消息——送去 Eval。
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: disposition.fanout.filter(id => id !== ticketId) })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : undefined
      // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
      // 停止本 Ticket 的那条消息由主会话自己处理（它发起了停止），除非有 Ticket 曾退回过它。
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
  // refuse：无法恢复的 Ticket 放手所有等着的消息（ Mandate 复核失败的唤醒路径）。
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
  // restart：用新 Assignment 替换运行中的——旧的结束（记 reason），未读的 Input 挪回队首，
  // `note`（如恢复说明）作为第一条文本 Input，然后启动新 Assignment。
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }
  /**
   * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
   * have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
   * in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
   */
  // requeueUntaken：把被替换 Assignment 投递过、但 worker 一步都没读过的 Trigger Input 挪回队首——
  // 取消可能丢消息，或声称领取的步骤被打断；新 Assignment 启动时会从 Session 收件箱清掉副本，
  // 保证重新投递的这份是唯一到达 worker 的。
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
  /**
   * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
   * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
   * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
   * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
   * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
   */
  // end：以某结果结束 Ticket——
  // `at` 记录"结束事实"发生的时间（如 PR 合并时刻），`reason` 用文字补充原因（默认用结果名）。
  // 结束前计算两组要放手的消息（letGo）：
  // waiting = worker 从未收到的；left = 它决定过、但在最新报告/回合结束前没读过（含结束报告本身）、
  // 且没确认/回答/退回过的真人消息—— worker 已没有机会再退回它们。
  end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at = this.now(), reason?: string): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    const stopping = ticket.assignments.filter(assignment => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    const until = readUntil(ticket)
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // An end dated earlier, such as a PR's merge, does not move the ticket's last change back.
    // 结束时间可能早于现在（如 PR 实际合并的时刻），但 updatedAt 不回退。
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // The Assignments the end stops end with it; the ticket's end says why.
    // 所有未结束的 Assignment 随之结束。
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    // 通知 Executor 停止每个被终止的 Assignment（取消回合、后台工作）。
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }
  /**
   * Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
   * has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
   * after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
   * change asks for no work.
   */
  // unfinished：Thread 关闭时（at 时刻），Ticket 的工作是否还没收尾——
  // 1) worker 接下过一条它决定的真人消息，且 Session 纳入该消息之后既没有非 progress 报告、也没有回合结束；
  // 2) 或关闭之后工作恢复过（Assignment 晚于关闭开始），且没有 ready 报告、或有报告后新到的 Input。
  // 纯策略变更不算未收尾的工作。
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    // 没接下真人消息，或最新 Assignment 早于关闭时刻：看 taken 即可。
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    // 恢复后的工作：报告不是 ready、或有报告之后新到的输入（策略变更除外），都算没收尾。
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? ''))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
  }
  /** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
  // newAssignment：追加一个 pending 的 Assignment（id 由序号派生），并清除上一次的投递失败标记。
  private newAssignment(ticket: Ticket): Assignment {
    const assignment: Assignment = { id: key('assignment', ticket.id, String(ticket.assignments.length)), state: 'pending', createdAt: this.now() }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    return assignment
  }
  // endAssignment：把一个 Assignment 置为 ended（附原因），并发出 assignment.ended 事件。
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /**
   * Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  // note：主会话给存活 Ticket 递一条事实（note 类 Input）——仅上下文，不授予任何权限。
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
   * @returns false when the ticket follows the Thread already.
   * @throws UserError when the ticket is unknown or has ended.
   */
  // followForContext：worker 发现相关 Thread——订阅它仅作上下文（进 Thread.context 列表）。
  // 已在订阅则返回 false。
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
  /** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
  // subscribe：订阅一个 Thread——之后的 Trigger 会扇出给该 Ticket；
  // 若它此前只是"上下文订阅"，这次升级为正式订阅（后续消息按自己的算）。
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
