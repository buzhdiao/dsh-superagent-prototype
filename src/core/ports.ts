/** Ports the core depends on. Sources, policies, assessors, executors, and channels are project-specific. */
// 端口（ports）：core 领域核心对外部世界的依赖接口（依赖倒置）。
// Source、Policy、评估者（assessor）、执行者（executor）、回写通道（channel）都是项目侧的具体实现，
// core 只依赖这里的抽象接口，保证 src/core 不做任何 I/O。
import type { Assignment, ChannelRef, Decision, DecisionKind, Mandate, MandateBasis, Strength, Thread, Ticket, TicketEndBy, TicketOutcome, Trigger }
  from './model.ts'
import type { Reason } from './reasons.ts'

/** Gate admission result: either inadmissible with a reason code, or admissible with strength and MandateBasis. */
// GateResult：门（gate，Policy 的准入判断）的结果——
// 拒绝时给出原因代码；放行时给出强度（explicit/inferred）与 Mandate 依据（basis）。
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** Whether a Source receives a Trigger; `observed` when it also receives messages not addressed to the agent, and `row` the receiving scope the Policy's admission table names, such as a chat. */
// ScopeResult：某个 Source 是否接收一条 Trigger——
// `observed` 表示该 Source 连"没点名 agent"的消息也一并收进来（用于推断主动式候选）；
// `row` 是 Policy 准入表（admission table）指定的接收范围（比如某个群聊）。
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis. */
// SourceScope：领域眼中的 Source 配置——对每条 Trigger（或已记录的 Mandate basis）给出监听判断。
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy. */
// Policy：带版本的授权规则集；`gate` 决定谁能让 agent 干活。
// 注意：Source 的监听范围（scope）不属于 Policy。
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** Re-check a mandate's gate-layer basis under this policy, such as before an ended ticket resumes. */
  // revalidate：在当前 Policy 下复核一个旧 Mandate 的门依据是否仍成立（比如已结束 Ticket 恢复之前）。
  revalidate(mandate: Mandate): boolean
  /** Whether an inferred candidate may be accepted on the rules its assessment matched: assessments accept, and each rule is enabled. */
  // admitsInferred：匹配到这些规则的 inferred（推断型）候选能否被接受——要求模式为 auto 且每条规则都启用。
  admitsInferred(rules: readonly string[]): boolean
  /** How long an assessor may take before an eval is recorded as unavailable. */
  // evalTimeoutMs：评估者最长可用时间，超过则该 Eval 记为 unavailable（评估不可用）。
  evalTimeoutMs: number
}

/** What the assessor receives: bounded facts, never authority. */
// Candidate：评估者收到的材料——有边界的事实，绝不是授权（授权只来自 Policy 的门）。
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** Every ticket on the thread, including ended ones, for duplicate judgement. */
  // 该 Thread 上的所有 Ticket（含已结束的），供评估者判断"是否重复开工"。
  tickets: Ticket[]
}

export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /** An accept: `rules` the assessment matched, `name` the ticket's requested short name, and `note` a routing note for its worker. */
  // accept：接受开工。`rules` 是匹配到的规则，`name` 是为 Ticket 起的短名，`note` 是给 worker 的路由备注。
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; note?: string }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** Semantic judgement. `request` queues the assessment, idempotently per `evalId`; the outcome returns through `Engine.decide`. */
// Assessor：语义判断者（由主会话 / Router 扮演）。
// `request` 把评估请求排队（按 evalId 幂等）；结论最终通过 `Engine.decide` 记录。
export interface Assessor {
  request(candidate: Candidate): void
  /** Called whenever an eval ends, decided or not, so the assessor drops what it kept for it. */
  // release：Eval 结束（无论有无结论）时回调，评估者据此丢弃为它缓存的状态。
  release?(evalId: string): void
}

/**
 * Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
 * commands, so each method only queues work, which reports back through the Engine's callbacks.
 */
// Executor：执行 Assignment 的一方；并发与工作区管理是它自己的事。
// Engine 在事务内调用它，所以每个方法只负责把工作排队，结果通过 Engine 的回调（assignmentStarted 等）回报。
export interface Executor {
  /** Queue a pending assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
  // start：把 pending 的 Assignment 排队启动；通过 `Engine.assignmentStarted` 或 failed 报告回报。
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * Queue delivery of the ticket's waiting Inputs to its running assignment; reports back through `Engine.inputsDelivered`
   * or `Engine.deliveryFailed`, and through `Engine.inputsRead` once its worker's Session takes them into a step.
   */
  // deliver：把 Ticket 待投递的 Inputs 送到运行中的 Assignment；
  // 通过 `Engine.inputsDelivered` / `Engine.deliveryFailed` 回报；worker 的 Session 将其纳入步骤后再报 `Engine.inputsRead`。
  deliver(ticket: Ticket, assignment: Assignment): void
  /** End an assignment's work, such as cancelling its Session's turn; called after the ticket or assignment has already ended in the domain. */
  // stop：终止一个 Assignment 的工作（如取消其 Session 的回合并）；在领域侧 Ticket/Assignment 已结束之后才调用。
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}

/** A message for a Channel; `ticketId` names the Ticket it is for, when there is one. */
// OutboundMessage：发往 Channel 的外发消息；`ticketId` 标明它属于哪个 Ticket（如果有的话）。
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }
/** A queued message waits (`pending`), went out (`sent`), or was dropped because its conversation can never receive it (`dropped`). */
// ReplyStatus：排队消息的状态——pending（等待中）/ sent（已发出）/ dropped（会话已不可能收到，被丢弃）。
export type ReplyStatus = 'pending' | 'sent' | 'dropped'
/** The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later. */
// Outbox：发件箱端口。Engine 在事务内把消息排队，之后由发送方（Outbox 服务）投递。
export interface Outbox {
  /** Queue a message idempotently; an id queued before keeps its first message. */
  // send：按幂等方式排队；同一个 id 重复排队保留第一条消息。
  send(message: OutboundMessage): void
  /** Whether a message was queued, and what became of it. */
  // status：查询某 id 是否排过队、最终状态如何。
  status(id: string): ReplyStatus | undefined
  /** Withdraw a message that has not gone out. */
  // withdraw：撤回尚未发出的消息。
  withdraw(id: string): void
}

/** What the Engine reports after a change, by event type. */
// DomainEvents：Engine 在每次变更后对外发布的领域事件（按事件类型组织）。
// Runtime 会把其中一部分转成主会话通知（如 ticket.ended、trigger.requeued、thread.unsubscribed）。
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  /** A person dropped every ticket's Subscription, or a ticket's Executor its own, for `reason`. */
  // thread.unsubscribed：人取消了该 Thread 上的全部订阅，或某 Ticket 的 Executor 取消了自己的（附原因）。
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** A person's follow-up that reached tickets and that an earlier version also queued for Eval left the queue. */
  // trigger.followup：真人追问已到达某些 Ticket，且旧版本还把它排进了 Eval 队列——现在它出队，归 Ticket 决定。
  'trigger.followup': { triggerId: string }
  'policy.changed': { from: string; to: string }
}
// DomainEvent：带类型与时间的具体事件（上面映射类型的分布式应用）。
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/** Durable state. Every method is synchronous so `atomic` can wrap a unit of work. */
// Repositories：持久化仓储接口。所有方法都是同步的，这样 `atomic` 才能把一组读写包成一个事务。
// 实现：SQLite（src/app/store.ts）与内存版（src/core/memory.ts，供测试）。
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): import('./model.ts').TriggerDisposition | undefined
    saveDisposition(id: string, value: import('./model.ts').TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** Threads with Triggers queued for Eval or an Eval in progress. */
    // active：有 Trigger 排队等 Eval、或 Eval 进行中的 Thread（工作集，配生成列索引）。
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** Tickets with undelivered Inputs or a pending or running Assignment, which is always the latest. */
    // active：有未投递 Input、或最新 Assignment 处于 pending/running 的 Ticket。
    active(): Ticket[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
}
