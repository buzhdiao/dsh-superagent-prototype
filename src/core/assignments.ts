/** What the Executor and its workers report about the Assignments that run tickets. */
// Assignments（执行报告部件）：记录 Executor 与其 worker 对运行 Ticket 的 Assignment 的所有汇报。
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { automatic, type Tickets } from './tickets.ts'

/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
// WorkerReport：一条状态报告——可以是 worker 通过工具提交的，也可以是 Executor 代报的
// （回合空转后的 waiting、出错后的 failed）。
export interface WorkerReport {
  state: ReportState
  summary: string
  /** Open question for a person: a string asks it, `null` clears an open one, and `undefined` keeps the current one. */
  // 待人回答的问题：字符串=提出新问题；null=清除现有问题；undefined=保持不变。
  question?: string | null
  /** The person's message whose request raised the question; routes the question to the channel where it was written. */
  // 引发该问题的那条真人消息：问题将发回它所在的会话。
  askedBy?: string
  /** The person's question this report answers, which the worker thereby takes up; authorizes the main Session to send an answer reply. */
  // 本报告所回答的真人问题；同时表示 worker"接下"了那条消息，并授权主会话发送回答。
  answers?: string
}
// RECOVERY_NOTE：宿主重启后恢复 Assignment 时给 worker 的恢复说明。
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'

/**
 * Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
 * reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
 * interrupted it, and a worker's report with its question for a person. It depends on
 * Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
 * Executor's lifecycle callbacks and its workers' reports here.
 */
// Assignments 记录 Executor 及 worker 的全部汇报：Assignment 启动、Inputs 送达/失败、Session 纳入步骤（read）、
// worker 回合结束、宿主重启中断、worker 报告（含待人问题）。
// 依赖 Tickets 完成重启/结束，依赖 Replies 撤回被替换的问题；Engine 把 Executor 的生命周期回调路由到这里。
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /** Marks a non-ended assignment running, queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
  // started：把未结束的 Assignment 置为 running（幂等），并对存活 Ticket 触发待投递 Inputs 的投递，发 assignment.started 事件。
  started(ticketId: string, assignmentId: string): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
   * longer running. Its worker reads each once its Session takes it into a step (see `read`).
   */
  // delivered：Inputs 已送达运行中的 Assignment——从 undelivered 移除、记 deliveredAt、清除之前的投递失败；
  // 若 Assignment 已不在运行则忽略。"读过"要等 Session 纳入步骤（见 `read`）才算。
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      // readAt ??= null：初始化为 null 表示"已投递但尚未读"（之后 read 才写入时间）。
      if (input.kind === 'trigger' && inputIds.includes(input.id)) { input.readAt ??= null; input.deliveredTo = assignmentId }
    }
    // 送达成功即清除 delivery 失败标记。
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }
  /** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
  // read：worker 的 Session 把携带这些 Input 的消息纳入步骤（user/message 事件）——模型从此能读到；
  // 记录 readAt 时间（首个为准）。
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  // turnEnded：worker 的一个回合结束（也发生在报告之后），记录 idleAt 作为"读过"的另一个时间界。
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  // deliveryFailed：向运行中 Assignment 投递 Inputs 失败——在 Ticket 上挂失败标记（面板可见），直到下次成功。
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }
  /**
   * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case it keeps its
   * session and flushes any waiting undelivered inputs.
   */
  // interrupted：宿主重启打断了运行中的 Assignment——
  // 若最新报告不是"已尘埃落定"（waiting/ready/blocked/failed）或其后又送达过 Input（busy），
  // 视为工作中断：带恢复说明重启；否则保留原 Session，只补投还等着的 Inputs。
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
  }
  /**
   * Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
   * inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
   * or a question/answer referencing a non-human or unreached trigger.
   */
  // report：在存活 Ticket 的当前 Assignment 上记录 worker 报告；同步更新 attention（提问）、answers（已回答）、
  // 被扣留的自动 Inputs，并在 dropped 或 ready（且跟随的 Thread 已收尾）时结束 Ticket。
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    // 规则校验：问题不能与结果/回答同时出现；askedBy 必须配问题。
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    // person：校验引用的确实是一条"到达过本 Ticket 且真人写的"消息；channel=true 时还要求可回写。
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    // 报告落在当前 Assignment 上：优先 running，其次最新一个。
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const previous = ticket.attention
    // 构造新问题（确定性 id）；文本没变就沿用旧的。
    const ask = (question: string) => ({ id: key('attention', ticketId, question, at), question, ...(report.askedBy ? { triggerId: report.askedBy } : {}) })
    const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous
    // 新问题为 null、或报告 ready，都视为清空提问；否则保留/更新。
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // A replaced or cleared attention question withdraws any pending unsent reply for the previous question from the outbox.
    // 问题被替换或清除时，撤回旧问题尚未发出的提问消息，避免发出过时问题。
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    assignment.report = { state: report.state, summary: report.summary, at }
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    // 报告了答案，即表示 worker 接下了那条提问消息（takeUp 记入 disposition.acked）。
    if (report.answers) this.takeUp(ticketId, report.answers)
    // blocked/failed 时丢弃还没投递的自动 Inputs（CI、策略变更等）——人还没接手，别再喂机器消息。
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    // A ticket that follows Threads ends with them: a ready report ends it only once followsDone holds, with that outcome.
    // 跟随 Thread 的 Ticket 以 Thread 的收尾为准：ready 只有在 followsDone 成立时才按该结果结束。
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    // A dropped report after a close the ticket deferred ends it as the close did, which its final notice tells.
    // dropped 报告：若 Ticket 曾因收尾未完而推迟结束，则按当初的关闭结果结束（最终通知里说明）。
    const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /** The ticket, while it is open and `assignmentId` runs it. */
  // running：返回该 Ticket——前提是它存活且正是 assignmentId 在运行；否则 undefined（上报自动失效）。
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
