/** Evals: the Thread-level assessments of queued Triggers, and the Decisions they end with. */
// Evals（评估部件）：Thread 级别的 Trigger 批量评估，以及评估最终产出的 Decision。
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { liveTicket, threadKey } from './model.ts'
import type { Decision, DecisionKind, Evaluation, Mandate, MandateBasis, Strength, Thread, Trigger } from './model.ts'
import type { AssessmentOutcome, Candidate, Policy } from './ports.ts'
import { said, type Reason } from './reasons.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

/** An outcome for the Eval that holds a Trigger; `evalId` names the Eval it was judged for, so a later Eval refuses it. */
// Outcome：针对"持有该 Trigger 的 Eval"给出的结论；`evalId` 标明是针对哪个 Eval 判断的，
// 若那个 Eval 已经结束（被更新的 Eval 取代），结论会被拒绝——防止陈旧结论覆盖新评估。
export type Outcome = AssessmentOutcome & { evalId?: string }
/** What an Eval ends with, as its Decision records it. */
// Finished：Eval 收尾时的内部形状（对应 Decision 的核心字段）。
interface Finished { kind: DecisionKind; reason: Reason[]; audit?: Record<string, unknown>; ticketId?: string; mandate?: Mandate }
/** An outcome's reason: a code it carries, else the words its assessor or person wrote. */
// reasonOf：结论的原因——自带 Reason 就直接用；自由字符串包装成 said（"评估者/人写下的话"）。
const reasonOf = (reason: string | Reason): Reason[] => [typeof reason === 'string' ? said(reason) : reason]
// stronger：两个强度取较强者——只要有一方 explicit（明确请求）就是 explicit。
const stronger = (a: Strength, b: Strength): Strength => a === 'explicit' || b === 'explicit' ? 'explicit' : 'inferred'
/** How many times in a row an expired Eval queues its Triggers again before it is recorded unavailable. */
// REQUEUES：Eval 过期后连续重排的次数上限，超过就记 unavailable（评估不可用），
// 避免忙碌的评估者把请求无限期拖住。
const REQUEUES = 2

/**
 * Evals runs the Evals of Threads: it batches a Thread's queued Triggers into one Eval, takes its strength, actor, and basis
 * from the gate, asks the assessor, keeps its deadline through a pause, and records the Decision it ends with: accept, stop,
 * ignore, or unavailable. It depends on Tickets to create the ticket an accept decides and to end the one a stop names; the
 * Engine routes the main Session's decisions, people's replays, worker handbacks, and the pass's Eval work here.
 */
// Evals 负责运行各 Thread 的 Eval：把排队 Trigger 合成一批，从门（gate）取强度/行为者/依据，
// 交给评估者（主会话），在处理暂停时顺延超时，并记录最终 Decision（accept/stop/ignore/unavailable）。
// accept 时依赖 Tickets 创建 Ticket；stop 时依赖 Tickets 结束对应 Ticket。
// 主会话的决策、人工重放、worker 退回、定时评估工作都由 Engine 路由到这里。
export class Evals extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  /**
   * Expire a Thread's Eval past its deadline (see `expire`), unless processing is paused: then the Eval notes when the
   * processing pause began, and once processing resumes its deadline moves forward by the pause's length. An Eval whose
   * candidate has not reached the assessor's Session does not expire.
   */
  // due：每个 pass（每两秒）对每个进行中 Eval 调用一次，检查是否过期。
  // 处理暂停时：记下暂停开始时间（首次），恢复时按暂停时长顺延 deadline。
  // 候选还没送达评估者 Session 的 Eval 永不过期（超时从送达起算）。
  due(thread: Thread, policy: Policy): void {
    const evaluation = thread.evaluating
    // 暂停期间且已记录过暂停时间：什么都不做。
    if (!evaluation || (policy.paused && evaluation.pausedAt)) return
    const now = this.now()
    if (policy.paused) evaluation.pausedAt = now
    else if (evaluation.pausedAt) {
      // 恢复：deadline += (现在 - 暂停开始)，即把暂停时长补回去。
      evaluation.deadline = new Date(Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)).toISOString()
      delete evaluation.pausedAt
    } else if (evaluation.delivered && evaluation.deadline <= now) { this.expire(thread); return }
    else return
    this.repo.threads.save(thread)
  }
  /** An Eval's candidate reached the assessor's Session: its deadline counts from now. */
  // delivered：候选送达评估者 Session——从此刻起算超时（deadline = now + evalTimeoutMs）。
  delivered(evalId: string, policy: Policy): void {
    const thread = this.repo.threads.active().find(item => item.evaluating?.id === evalId)
    if (!thread?.evaluating || thread.evaluating.delivered) return
    const now = this.now()
    thread.evaluating.delivered = now
    thread.evaluating.deadline = new Date(Date.parse(now) + policy.evalTimeoutMs).toISOString()
    this.repo.threads.save(thread)
  }
  /**
   * An Eval past its deadline queues its Triggers again for a fresh Eval, up to `REQUEUES` times in a row, so a busy
   * assessor does not drop requests; after that it is recorded unavailable.
   */
  // expire：Eval 过期——先重排（把 Trigger 放回队首）至多 REQUEUES 次，给忙碌的评估者机会；
  // 超过次数则记 unavailable（timeout），panel 上会显示这个问题供人 dismiss。
  private expire(thread: Thread): void {
    const expired = (thread.expired ?? 0) + 1
    if (expired > REQUEUES) { this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [{ code: 'timeout' }] }); return }
    const { id, triggerIds } = thread.evaluating!
    delete thread.evaluating
    thread.expired = expired
    // 旧 Trigger 排到队首（去重），新的 Eval 会把它们与期间新到的合并成一批。
    thread.pending = [...triggerIds, ...thread.pending.filter(item => !triggerIds.includes(item))]
    this.repo.threads.save(thread)
    // 通知评估者释放该 Eval 的缓存状态。
    this.options.assessor.release?.(id)
  }
  /** Start one Eval of the Triggers queued on a Thread, judged by the gate, and ask the assessor for it. */
  // start：启动一个 Thread 的 Eval——先清理队列，再用门逐一判定各 Trigger，
  // 取最强可准入者为 primary，把整批打包成 Evaluation 并交给评估者。
  start(threadKeyValue: string, policy: Policy): void {
    const thread = this.repo.threads.get(threadKeyValue)!
    const at = this.now()
    // A person's follow-up a ticket still decides is that ticket's: one an older version queued leaves the queue without a Decision.
    // 旧版本可能把"Ticket 仍在决定的真人追问"排进了 Eval 队列——这里把它们移出队列（不产生 Decision），
    // 并发 trigger.followup 事件让主会话把它们转给对应 Ticket。
    const delivered = (id: string) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger && this.owners(trigger).length > 0
    }
    if (thread.pending.some(delivered)) {
      const followups = thread.pending.filter(delivered)
      thread.pending = thread.pending.filter(id => !followups.includes(id))
      this.repo.threads.save(thread)
      for (const triggerId of followups) this.emit('trigger.followup', { triggerId })
      if (!thread.pending.length) return
    }
    // Triggers that already originated a ticket cannot lend authority to a new evaluation or spawn a duplicate ticket.
    // 已经开过 Ticket 的 Trigger 不能再次借权给新的评估，也不能造成重复开工——直接记 ignore。
    const accepted = this.accepted(thread.key)
    const started = thread.pending.filter(id => accepted.has(id))
    const startedTicket = (id: string): Reason => ({ code: 'startedTicket', triggerId: id, values: { ticket: accepted.get(id)!.ticketId! } })
    if (started.length) this.ignore(thread, started, started.map(startedTicket), policy, at)
    // 载入剩余 Trigger 与 Thread 上的 Ticket（供门与评估者判断）。
    const triggers = thread.pending.flatMap(id => { const trigger = this.repo.triggers.get(id); return trigger ? [trigger] : [] })
    const tickets = this.ticketsOnThread(thread)
    const reasons: Reason[] = []
    // strongest：整批中"可准入的最强 Trigger"——explicit 优先，同级取更晚的（更新者胜出）。
    let strongest: { trigger: Trigger; strength: Strength; basis: MandateBasis } | undefined
    for (const trigger of triggers) {
      const gate = policy.gate(trigger, thread, tickets)
      if (!gate.admissible) { reasons.push({ code: gate.reason, triggerId: trigger.id }); continue }
      const later = gate.strength === strongest?.strength && trigger.at >= strongest.trigger.at
      const weaker = !strongest || stronger(strongest.strength, gate.strength) !== strongest.strength
      if (weaker || later) strongest = { trigger, strength: gate.strength, basis: gate.basis }
    }
    // 没有任何可准入 Trigger：整批记 ignore（带各自被拒原因或 noAdmissible）。
    if (!strongest) {
      if (thread.pending.length) this.ignore(thread, [...thread.pending], reasons.length ? reasons : [{ code: 'noAdmissible' }], policy, at)
      this.repo.threads.save(thread)
      return
    }
    // Eval id 由 Thread、Policy 版本、时间与整批 Trigger 派生——同批同时的评估得到同一个 id（幂等）。
    const evalId = key('eval', thread.key, policy.version, at, ...thread.pending)
    const deadline = new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString()
    const { strength, trigger: { actor }, basis } = strongest
    // 挂上进行中的 Evaluation，清空队列。
    thread.evaluating = { id: evalId, threadKey: thread.key, triggerIds: thread.pending, primary: strongest.trigger.id, strength, actor, basis,
      policyVersion: policy.version, startedAt: at, deadline }
    thread.pending = []
    this.repo.threads.save(thread)
    // 每个 Trigger 的 disposition 记上 evalId。
    for (const trigger of triggers) {
      this.repo.triggers.saveDisposition(trigger.id, { ...(this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at }), evalId })
    }
    this.emit('eval.started', { evalId, threadKey: thread.key, triggerIds: thread.evaluating.triggerIds, strength: strongest.strength })
    // 请求评估者（主会话）评估。
    this.options.assessor.request(this.candidateOf(thread))
  }
  /** The candidate of the Eval that holds `triggerId`, or undefined while no Eval holds it. */
  // candidate：主会话读取某 Trigger 所属 Eval 的候选材料；没有 Eval 持有它则无。
  candidate(triggerId: string): Candidate | undefined {
    const thread = this.holding(triggerId)
    return thread && this.candidateOf(thread)
  }
  /**
   * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does.
   * @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
   * ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
   * mode or without enabled matching rules.
   */
  // decide：对一条 Trigger 落结论——
  // 有 Eval 持有它就在那个 Eval 上落；没有则构造"直接 Eval"（gate-only）单独判定。
  decide(triggerId: string, outcome: Outcome): Decision {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    const held = this.holding(triggerId)
    // 结论声明的 evalId 必须仍是当前持有的 Eval，否则说明评估已结束/被取代。
    if (outcome.evalId && held?.evaluating?.id !== outcome.evalId) throw new UserError('evalFinished', { eval: outcome.evalId })
    // Prevent a replayed trigger that already created a ticket from spawning a second one.
    // 已经开过 Ticket 的 Trigger 不允许再开一个——返回已有 Decision。
    const earlier = outcome.kind === 'accept' ? this.accepted(threadKey(trigger.threads[0]!)).get(triggerId) : undefined
    if (earlier) {
      // Only an Eval started by an earlier version can still hold it; reassess the remaining triggers without it, or ignore it if alone.
      // 若旧版本启动的 Eval 仍持有它：把其余 Trigger 重排成新 Eval（不含它）；它单独一批则整个记 ignore。
      const others = held?.evaluating?.triggerIds.filter(id => id !== triggerId) ?? []
      if (held && others.length) this.reassess(held, { code: 'acceptedBefore', values: { trigger: triggerId } }, [triggerId])
      else if (held) {
        this.finish(held, held.evaluating!, { kind: 'ignore', reason: [{ code: 'startedTicket', triggerId, values: { ticket: earlier.ticketId! } }] })
      }
      return earlier
    }
    // A follow-up that reached a ticket is its worker's to judge: the main Session may only stop the work on it.
    // 已到达某个 Ticket 的追问归 worker 判断：主会话对它只能停止（stop），其他结论一律拒绝。
    if (outcome.kind !== 'stop') this.leftToWorkers(trigger)
    const thread = held ?? this.thread(trigger.threads[0]!)
    const evaluation = held?.evaluating ?? this.directEval(thread, trigger, outcome.kind, outcome.kind === 'stop' ? outcome.ticketId : undefined)
    // An inferred candidate is accepted only on enabled rules its assessment matched, while assessments may accept.
    // inferred 候选只有在 auto 模式且匹配的规则都启用时才能被接受。
    if (outcome.kind === 'accept' && evaluation.strength !== 'explicit' && !this.policy().admitsInferred(outcome.rules ?? [])) {
      throw new UserError('notExplicit')
    }
    return this.decideEval(thread, evaluation, outcome)
  }
  /**
   * Queue a stored Trigger for a fresh Eval on its primary Thread and emit `trigger.requeued`; returns false while an Eval holds it.
   * @throws UserError when the Trigger is unknown.
   */
  // reevaluate：人工重放——把已存储的 Trigger 重新排队评估（有 Eval 持有则返回 false）。
  reevaluate(triggerId: string): boolean {
    if (!this.requeue(triggerId)) return false
    this.emit('trigger.requeued', { triggerId })
    return true
  }
  /** Queue a Trigger for a fresh Eval on its primary Thread; false while an Eval holds it. */
  // requeue：重新入队并记录 disposition.requeued=true（之后 followupOwners 不再把它当作某 Ticket 的追问）。
  private requeue(triggerId: string): boolean {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    if (this.holding(triggerId)) return false
    this.queueForEval(trigger)
    const disposition = this.repo.triggers.disposition(triggerId) ?? { fanout: [], at: this.now() }
    this.repo.triggers.saveDisposition(triggerId, { ...disposition, requeued: true })
    return true
  }
  /**
   * Record that a ticket's Executor hands back a Trigger that reached it as beyond the ticket, and queue it for a fresh Eval
   * when the ticket decided it and no other ticket still does (see `handBack`): the gate judges it as any message on its
   * Thread, and its candidate carries the reasons, so no requeue notice comes before it. The ticket keeps its Subscription,
   * and hands a Trigger back once.
   * @returns whether it was queued: false while another ticket decides it, and for one the ticket did not decide.
   */
  // handback：worker 把一条到达本 Ticket 的消息退回（认为超出本 Ticket 范围）。
  // 校验：消息确实到达过本 Ticket（有对应 Input）、且本 Ticket 没退回过它。
  // 退回后由 handBack 决定是否重新排队进 Eval（ Eval 的候选会带上退回原因，无需另发通知）。
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    const ticket = this.require(ticketId)
    if (!ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === triggerId)) throw new UserError('notReached')
    if (this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)) throw new UserError('handedBack')
    return this.handBack(ticketId, this.repo.triggers.get(triggerId)!, reason)
  }
  /**
   * Marks an `unavailable` Decision dismissed so the overview lists it no more.
   * @throws UserError when the Decision is unknown or not `unavailable`.
   */
  // dismiss：人工处理掉 unavailable Decision 显示的问题（panel 总览不再列出）。
  dismiss(decisionId: string): Decision {
    const decision = this.repo.decisions.get(decisionId)
    if (decision?.kind !== 'unavailable') throw new UserError('unknownProblem')
    decision.dismissed = true
    this.repo.decisions.save(decision)
    return decision
  }
  /** Take a Trigger out of its Thread's queue because it was routed by hand. */
  // withdraw：主会话手工把 Trigger 路由给某个 Ticket 时，把它从 Thread 队列取出（不再进 Eval）。
  withdraw(trigger: Trigger): void {
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!))
    if (!thread?.pending.includes(trigger.id)) return
    thread.pending = thread.pending.filter(id => id !== trigger.id)
    this.repo.threads.save(thread)
  }
  /**
   * End the Eval that holds a Trigger routed to a ticket, since the ticket has it now: one that holds other Triggers too
   * queues them again for a fresh Eval without it.
   */
  // routed：一条 Trigger 被路由给 Ticket 后，持有它的 Eval 就此结束——
  // 只含它一个则记 ignore(routed)；还含别的 Trigger 则把它们重排成不含它的新 Eval。
  routed(triggerId: string, ticketId: string): void {
    const held = this.holding(triggerId)
    const reason: Reason = { code: 'routed', values: { ticket: ticketId } }
    if (held?.evaluating?.triggerIds.length === 1) this.finish(held, held.evaluating, { kind: 'ignore', reason: [reason] })
    else if (held) this.reassess(held, { ...reason, triggerId }, [triggerId])
  }
  /** Start the Evals in progress again under the new Policy version, and say that it changed. */
  // policyChanged：Policy 变更——把所有进行中的 Eval 作废重评（新 Policy 版本），并发 policy.changed 事件。
  policyChanged(from: string, to: string): void {
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.reassess(thread, { code: 'policyChanged' })
    this.emit('policy.changed', { from, to })
  }
  /** End a Thread's Eval as unavailable for `reason` and queue its Triggers, except `without`, for a new Eval ahead of the others. */
  // reassess：以 unavailable 结束当前 Eval（附原因），把除 `without` 之外的 Trigger 排到队首等新一轮 Eval。
  // （例如 Policy 变更、路由剥离、重复接受等场景。）
  private reassess(thread: Thread, reason: Reason, without: string[] = []): Decision {
    const ids = thread.evaluating!.triggerIds.filter(id => !without.includes(id))
    const decision = this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [reason] })
    const current = this.repo.threads.get(thread.key)!
    current.pending = [...ids, ...current.pending.filter(id => !ids.includes(id))]
    this.repo.threads.save(current)
    return decision
  }
  /** The Thread whose Eval holds a Trigger: an Eval runs on the primary Thread of each Trigger it holds. */
  // holding：找出哪个 Thread 的 Eval 正持有该 Trigger（Eval 挂在其主 Thread 上）。
  private holding(triggerId: string): Thread | undefined {
    const trigger = this.repo.triggers.get(triggerId)
    const thread = trigger && this.repo.threads.get(threadKey(trigger.threads[0]!))
    return thread?.evaluating?.triggerIds.includes(triggerId) ? thread : undefined
  }
  // candidateOf：从 Thread 的进行中 Evaluation 组装评估者所需的候选材料。
  private candidateOf(thread: Thread): Candidate {
    const evaluation = thread.evaluating!
    const triggers = evaluation.triggerIds.flatMap(id => { const trigger = this.repo.triggers.get(id); return trigger ? [trigger] : [] })
    const { id: evalId, strength, policyVersion } = evaluation
    return { evalId, thread, triggers, strength, policyVersion, tickets: this.ticketsOnThread(thread) }
  }
  /**
   * Record that the queued Triggers `ids` of a Thread start no Eval, for `reason`, and take them out of its queue. Its id
   * differs from an Eval's, so it never replaces the Decision of an earlier Eval of the same Triggers.
   */
  // ignore：这批排队 Trigger 不启动 Eval（附原因），直接出队并记一条 ignore Decision。
  // 注意其 id 含 'ignored' 字样，与真 Eval 的 id 不同，不会顶替同批 Trigger 之前 Eval 的 Decision。
  private ignore(thread: Thread, ids: string[], reason: Reason[], policy: Policy, at: string): void {
    const evaluation = { id: key('eval', thread.key, 'ignored', policy.version, at, ...ids), threadKey: thread.key, triggerIds: ids, strength: 'inferred' as const,
      actor: { source: thread.ref.source, id: '' }, basis: { via: 'followup' as const }, policyVersion: policy.version, startedAt: at, deadline: at }
    this.record(thread, evaluation, { kind: 'ignore', reason })
    thread.pending = thread.pending.filter(id => !ids.includes(id))
    // 有 Decision 落地即清零连续过期计数。
    delete thread.expired
  }
  /**
   * The accept Decisions of the Triggers whose primary Thread is `threadKey`, by Trigger: what each one started. An Eval and
   * its Decision run on its Triggers' primary Thread, so the Thread's Decisions, read by their index, hold them all.
   */
  // accepted：主 Thread 为 threadKey 的所有 Trigger 的 accept 决策映射——
  // 用于判断"这条 Trigger 是否已开过 Ticket"（防重复）。Eval 与 Decision 都在 Trigger 的主 Thread 上，
  // 所以按 Thread 读 Decision 列表即可覆盖。
  private accepted(threadKey: string): Map<string, Decision> {
    const accepted = new Map<string, Decision>()
    for (const decision of this.repo.decisions.byThread(threadKey)) {
      if (decision.kind !== 'accept' || !decision.ticketId) continue
      for (const id of decision.triggerIds) if (!accepted.has(id)) accepted.set(id, decision)
    }
    return accepted
  }
  /**
   * A gate-only Eval of one Trigger, for an outcome decided without a queued Eval, such as on a follow-up that reached a
   * ticket. It is decided at once, beside an Eval its Thread may have in progress, and takes the Trigger out of the queue.
   * Its id names the outcome's kind, so a stop and an accept of one message at the same moment are two Decisions.
   */
  // directEval：为"没有排队 Eval"的结论构造一次性（gate-only）Eval——
  // 典型场景：对一条到达 Ticket 的追问执行 stop。它单独过门判定，立即出结论；
  // 不影响 Thread 上可能同时在跑的 Eval。id 含结论 kind，同一条消息的 stop 与 accept 是两个不同 Decision。
  private directEval(thread: Thread, trigger: Trigger, kind: AssessmentOutcome['kind'], ticketId?: string): Evaluation {
    const policy = this.policy()
    const gate = policy.gate(trigger, thread, this.ticketsOnThread(thread))
    if (!gate.admissible) throw new UserError('notAdmissible', { reason: gate.reason })
    const at = this.now()
    // 若它恰好在排队中，先取出来（它马上就地出结论）。
    if (thread.pending.includes(trigger.id)) { thread.pending = thread.pending.filter(id => id !== trigger.id); this.repo.threads.save(thread) }
    const id = key('eval', thread.key, 'direct', trigger.id, kind, ...ticketId ? [ticketId] : [], at)
    // 直接 Eval：deadline 就设为 now，等于立即到期（结论马上产生）。
    return { id, threadKey: thread.key, triggerIds: [trigger.id], primary: trigger.id,
      strength: gate.strength, actor: trigger.actor, basis: gate.basis, policyVersion: policy.version, startedAt: at, deadline: at }
  }
  /** Apply an outcome to an Eval of a Thread: the one in progress, or a gate-only one. */
  // decideEval：把结论应用到某个 Eval 上（进行中的或直接 Eval）。
  private decideEval(thread: Thread, evaluation: Evaluation, outcome: AssessmentOutcome): Decision {
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    // Requeue if Policy changed without a live policyChanged call (such as across an upgrade or restart).
    // 版本兜底：结论基于的 Policy 版本已过期（如升级/重启期间没触发 policyChanged）——重排或作废。
    if (this.policy().version !== evaluation.policyVersion) {
      if (thread.evaluating?.id === evaluation.id) return this.reassess(thread, { code: 'policyChanged' })
      return this.finish(thread, evaluation, { kind: 'unavailable', reason: [{ code: 'policyChanged' }], ...audit })
    }
    // An inferred candidate ignored without an assessment, from its card, says so beside the reason given.
    // 从候选卡片直接忽略（没有评估审计）的 inferred 候选：附 ignoredFromCard 原因。
    const unassessed = outcome.kind === 'ignore' && evaluation.strength !== 'explicit' && !outcome.audit ? [{ code: 'ignoredFromCard' }] : []
    if (outcome.kind === 'ignore' || outcome.kind === 'unavailable') return this.finish(thread, evaluation, { kind: outcome.kind,
      reason: [...unassessed, ...reasonOf(outcome.reason)], ...audit })
    if (outcome.kind === 'stop') {
      // stop 的规则：目标 Ticket 必须存在且存活；必须基于 explicit 强度的请求。
      const ticket = this.repo.tickets.get(outcome.ticketId)
      if (!ticket || !liveTicket(ticket)) return this.finish(thread, evaluation, { kind: 'ignore', reason: [{ code: 'stopUnknown' }],
        ...audit })
      if (evaluation.strength !== 'explicit') return this.finish(thread, evaluation, { kind: 'ignore',
        reason: [{ code: 'stopNotExplicit' }], ...audit })
      const decision = this.finish(thread, evaluation, { kind: 'stop', reason: reasonOf(outcome.reason), ticketId: ticket.id, ...audit })
      // 记录 Decision 后由 Tickets 结束该 Ticket（人停止，撤回 Mandate）。
      this.tickets.end(ticket.id, 'human', 'stopped', this.now(), typeof outcome.reason === 'string' ? outcome.reason : undefined)
      return decision
    }
    return this.accept(thread, evaluation, outcome)
  }
  /** Record an accept with the Mandate the Eval gives, and have Tickets create its ticket. */
  // accept：记录 accept Decision——从 Eval 继承强度/Policy 版本/行为者/门依据，附上评估匹配的规则，
  // 生成 Mandate 与确定性 ticketId，交由 Tickets.create 建 Ticket 并启动执行。
  private accept(thread: Thread, evaluation: Evaluation, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Decision {
    const at = this.now()
    const basis = { ...evaluation.basis, ...(outcome.rules ? { rules: outcome.rules } : {}) }
    const { strength, policyVersion, actor } = evaluation
    const mandate: Mandate = { strength, policyVersion, basis, actor, scope: outcome.scope }
    // ticketId 由 Eval id 派生：同一 Eval 重复 accept 不会产生两个 Ticket。
    const ticketId = key('ticket', evaluation.id)
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    const decision = this.finish(thread, evaluation, { kind: 'accept', reason: reasonOf(outcome.reason), ...audit, mandate, ticketId })
    this.tickets.create(ticketId, decision.id, mandate, evaluation, outcome, at)
    return decision
  }
  /** Record an Eval's Decision; the Thread's own Eval ends with it, while a gate-only one leaves the Thread's Eval going. */
  // finish：记录 Eval 的 Decision。若是 Thread 正在进行的那个 Eval，则随之结束（清 evaluating/expired、
  // 释放评估者缓存）；直接 Eval（gate-only）不影响 Thread 上的进行中 Eval。
  private finish(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const decision = this.record(thread, evaluation, outcome)
    // Direct (gate-only) evaluations do not clear the thread's active evaluation.
    // 直接（gate-only）评估不清除 Thread 的进行中 Eval。
    if (thread.evaluating?.id !== evaluation.id) return decision
    delete thread.evaluating; delete thread.expired
    this.repo.threads.save(thread)
    this.options.assessor.release?.(evaluation.id)
    return decision
  }
  // record：把 Decision 写入仓储，并给批内每个 Trigger 的 disposition 记上 evalId 与 decisionId。
  private record(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const at = this.now()
    const decision: Decision = { id: key('decision', evaluation.id), evalId: evaluation.id, threadKey: thread.key, triggerIds: evaluation.triggerIds,
      policyVersion: evaluation.policyVersion, at, kind: outcome.kind, reason: outcome.reason, strength: evaluation.strength,
      ...(outcome.ticketId ? { ticketId: outcome.ticketId } : {}), ...(outcome.mandate ? { mandate: outcome.mandate } : {}), ...(outcome.audit ? { audit: outcome.audit } : {}) }
    this.repo.decisions.save(decision)
    for (const id of evaluation.triggerIds) {
      const disposition = this.repo.triggers.disposition(id) ?? { fanout: [], at }
      this.repo.triggers.saveDisposition(id, { ...disposition, evalId: evaluation.id, decisionId: decision.id })
    }
    this.emit('decision.recorded', { decisionId: decision.id, kind: decision.kind, threadKey: thread.key })
    return decision
  }
}
