/** Shared base class and configuration for Engine domain parts. */
// Engine 各领域部件（part）共享的基类与配置。
// Engine 由五个部件组成（Intake / Evals / Tickets / Assignments / Replies），它们都继承 EnginePart，
// 通过 EngineOptions 拿到仓储、Policy、时钟与事件发射器等共享能力。
import { UserError } from './errors.ts'
import { followupOwners, reached, threadKey } from './model.ts'
import type { Thread, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Assessor, AssessmentOutcome, DomainEvent, DomainEvents, Executor, Outbox, Policy, Repositories, SourceScope } from './ports.ts'

// EngineOptions：Engine 及其部件的全部依赖（端口）与可选钩子。
export interface EngineOptions {
  repo: Repositories
  policy: () => Policy
  /** Decides whether a Source listens to a trigger; one it does not listen to is stored with a `filtered` disposition. */
  // scope：判断 Source 是否监听某条 Trigger；不监听的也会被存储，只是带上 `filtered` 的 disposition。
  scope: SourceScope
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  prepareTicket?: (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>) => Ticket
  now?: () => string
  emit?: (event: DomainEvent) => void
}

/**
 * Base class for Intake, Evals, Tickets, Assignments, and Replies providing shared access to repositories, policy, clock, and event emission.
 * Each subclass mutates its own domain aggregates and delegates cross-aggregate changes to sibling parts within the transaction opened by Engine.
 */
// EnginePart：Intake / Evals / Tickets / Assignments / Replies 的共同基类，
// 提供仓储、Policy、时钟、事件发射的共享访问。
// 每个子类只改动自己负责的聚合；跨聚合的修改委托给兄弟部件，全部发生在 Engine 打开的事务内。
export abstract class EnginePart {
  protected readonly repo: Repositories
  constructor(protected readonly options: EngineOptions) { this.repo = options.repo }
  // now：当前时间（ISO 字符串）；测试可注入假时钟。
  protected now(): string { return this.options.now?.() ?? new Date().toISOString() }
  // policy：取当前生效的 Policy（每次调用都拿最新的，Settings 变更即时生效）。
  protected policy(): Policy { return this.options.policy() }
  /** The tickets whose worker decides a person's follow-up: see `followupOwners`. */
  // owners：某条真人追问当前由哪些 Ticket 的 worker 决定（见 `followupOwners`）。
  protected owners(trigger: Trigger): string[] { return followupOwners(trigger, this.repo) }
  /** Refuse a main-Session routing of a follow-up a ticket's worker still decides. */
  // leftToWorkers：主会话想把一条仍由 worker 决定的追问路由到别处时，拒绝之——
  // 归属 worker 的消息只有 worker 能退回，主会话只能停止相关 Ticket。
  protected leftToWorkers(trigger: Trigger): void {
    const owners = this.owners(trigger)
    if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
  }
  /**
   * Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when the
   * ticket decided it and no other ticket still does. One the ticket did not decide, such as a bot's, one a person sent to
   * Eval or one on a Thread it follows for context, went to Eval without it.
   * @returns whether it was queued.
   */
  // handBack：记录某 Ticket 的 worker 把一条到达它的 Trigger 退回（附原因）；
  // 若该 Ticket 之前有决定权、且现在没有任何 Ticket 再决定它，就把它排队送去 Eval。
  // 该 Ticket 本来就没决定的（bot 消息、人工已送 Eval、仅上下文 Thread 上的），本来就走 Eval，不需要这一步。
  protected handBack(ticketId: string, trigger: Trigger, reason: string): boolean {
    const decided = this.owners(trigger).includes(ticketId)
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    // 追加一条 handback 记录（ticketId + 原因 + 时间）；每个 Ticket 对每条 Trigger 至多退回一次（上游会查重）。
    const handbacks = [...disposition.handbacks ?? [], { ticketId, reason, at: this.now() }]
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, handbacks })
    // 只有"它决定过、现在没人决定了"才重新排队进 Eval。
    return decided && !this.owners(trigger).length && this.queueForEval(trigger)
  }
  /** Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it. */
  // takeUp：记录某 Ticket 的 worker 通过确认（ack）或回答，把一条真人消息"接下"为 Ticket 范围内的事。
  protected takeUp(ticketId: string, triggerId: string): void {
    const disposition = this.repo.triggers.disposition(triggerId)
    if (disposition && !disposition.acked?.includes(ticketId)) {
      this.repo.triggers.saveDisposition(triggerId, { ...disposition, acked: [...disposition.acked ?? [], ticketId] })
    }
  }
  /** Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it. */
  // queueForEval：把 Trigger 放到其主 Thread 的 pending 队列里等下一次 Eval；
  // 已在队列中、或正被某个 Eval 持有时，不重复排队。
  protected queueForEval(trigger: Trigger): boolean {
    const primary = this.thread(trigger.threads[0]!)
    if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) return false
    primary.pending.push(trigger.id)
    this.repo.threads.save(primary)
    return true
  }
  // emit：发出一个领域事件（带上时间戳）；没有配置发射器则为空操作。
  protected emit<K extends keyof DomainEvents>(type: K, data: DomainEvents[K]): void {
    this.options.emit?.({ type, at: this.now(), data } as DomainEvent)
  }
  // require：取出 Ticket，不存在则抛 unknownTicket（UserError）。
  protected require(ticketId: string): Ticket { const ticket = this.repo.tickets.get(ticketId); if (!ticket) throw new UserError('unknownTicket'); return ticket }
  /** Returns the stored Thread or an unsaved empty Thread aggregate. */
  // thread：返回已存储的 Thread；没有则返回一个尚未保存的空聚合（方便统一处理新 Thread）。
  protected thread(ref: ThreadRef): Thread {
    const k = threadKey(ref)
    return this.repo.threads.get(k) ?? { key: k, ref: { source: ref.source, id: ref.id }, createdAt: this.now(), subscriptions: [], correlated: [], pending: [], meta: {} }
  }
  // ticketsOnThread：Thread 上所有订阅 Ticket（过滤掉已被删除的）。
  protected ticketsOnThread(thread: Thread): Ticket[] {
    return thread.subscriptions.flatMap(id => { const ticket = this.repo.tickets.get(id); return ticket ? [ticket] : [] })
  }
  // source：Ticket 的源 Trigger（发起它的那条）。
  protected source(ticket: Ticket): Trigger | undefined { return this.repo.triggers.get(ticket.origin.triggerId) }
  // reaches：Trigger 是否到达过该 Ticket（见 model.ts 的 reached）。
  protected reaches(ticket: Ticket, trigger: Trigger, context = true): boolean {
    return reached(ticket, trigger, k => this.repo.threads.get(k), context)
  }
}
