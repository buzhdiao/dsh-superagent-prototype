/**
 * 本测试文件覆盖核心引擎（src/core 的 Engine 及相关纯函数）：
 * 收集（trigger 去重/来源过滤/多线程关联）、评估（门拒绝、按线程串行与去抖、受理建工单、
 * 评估被替换、原子记录、超时重排与 unavailable、暂停下不超时）、订阅扇出（跟进直达活工单、
 * 未启动不投递、结束工单不收机器人消息、恢复去重、退订、交回线程）、恢复与停止
 * （人消息即恢复、人停止的工单不恢复、显式停止判定）、跟进（旧版排队的取出、门评估并行、
 * 线程释放）、交回（按门强度重排、每工单一次、未决定不重排、主 Session 附着）、
 * 上下文线程与备注（仅上下文不算跟进、不解阻塞）、跟进归属（停止即放行、工单结束送评估、
 * 认领判定、合并时机、重复附着）、中断派工（带备注重启、等待工单不重启）、暂停、策略变更
 * （只通知受影响的活工单、飞行中评估重排）、worker 汇报（提问的保持/替换/清除、终态报告、
 * 校验拒绝）、结局（合并/关闭/停止的时机）、附着（路由备注、批次评估收束）、直接决策
 * （显式/推断/重放）、自动输入（阻塞时扣留）、回复（回执一次、答案/结果/注意的时机）、
 * 工单命令（重试与催办）、失败投递、问题解除、旧版本兼容间隙、混合批次的强度取强、
 * 以及“worker 读到什么才算已读”的各竞态评审。测试策略：内存仓库 + 全假策略/评估器/执行器
 * 的 harness，直接驱动 Engine 的每个入口方法，断言落库与出站箱状态。
 */
import { describe, expect, it, vi } from 'vitest'
// vitest 断言与用例；vi 记录评估器/执行器的调用。
import { Engine, MemoryRepositories, UserError, followupOwners, key, runningAssignment, ticketOutcome, ticketStage,
  waitsForPerson } from '../src/core/index.ts'
// 被测模块：Engine 与内存仓库；辅助：key、runningAssignment、ticketOutcome/ticketStage、
// waitsForPerson、followupOwners；UserError：结构化拒绝。
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Outcome, Policy, Ticket, Trigger } from '../src/core/index.ts'
// Engine 的依赖接口类型。

const member = { source: 'chat', id: 'alice' }
// 名单内成员。
const guest = { source: 'chat', id: 'guest' }
// 名单外访客（跟进时按推断算）。
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}
// 触发器 fixture：默认 alice 在线程 t1 上，时间随 id 递增。
interface Hooks {
  emit?: (event: { type: string; data: Record<string, unknown> }) => void
  prepareTicket?: EngineOptions['prepareTicket']
}
// 可注入的钩子：事件监听与工单准备（可令其失败）。
function harness(policyOverrides: Partial<Policy> = {}, { emit, prepareTicket }: Hooks = {}) {
  // 搭建全假的引擎环境：内存仓库、假评估器/执行器/出站箱、可控时钟与策略。
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  // 出站箱记录。
  const withdrawn: string[] = []
  // 被撤回的出站消息 id。
  const requests: Candidate[] = []
  // 评估器收到的候选。
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  // 执行器被要求启动的派工。
  const deliveries = new Set<string>()
  // 待投递的工单 id（由 settle 模拟消费）。
  /** Inputs the Executor handed to a running assignment, as [ticket id, input id]. */
  // 执行器已交给运行中派工的输入，按 [工单 id, 输入 id] 记录。
  const delivered: [string, string][] = []
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(ticket => { deliveries.add(ticket.id) }), stop: vi.fn(),
  }
  let version = 'v1', paused = false
  const policy: Policy = {
    get version() { return version }, get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' } : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked',
    admitsInferred: rules => rules.length > 0,
    ...policyOverrides,
  }
  // 假策略：非人拒绝；alice 显式；订阅线程上的访客按跟进推断；版本 revoked 时授权失效。
  let clock = 0
  const scope: EngineOptions['scope'] = { scope: t => t.meta.blocked ? { listened: false, reason: 'chat not allowed' } : { listened: true, observed: false } }
  // 假范围：meta.blocked 的来源一律过滤。
  const queued: EngineOptions['outbox'] = {
    send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: id => { withdrawn.push(id) },
  }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox: queued,
    ...emit ? { emit } : {}, ...prepareTicket ? { prepareTicket } : {}, now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() })
  /** Simulate the executor starting queued assignments (unless `launch` is false) and delivering pending ticket inputs. */
  // 模拟执行器：启动排队的派工（除非 launch=false），并投递工单的待投递输入。
  function settle({ launch = true } = {}) {
    for (;;) {
      const next = launch ? launches.shift() : undefined
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const [ticketId] = deliveries
      if (ticketId === undefined) return
      deliveries.delete(ticketId)
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (ticket.ended || !assignment) continue
      for (const inputId of ticket.undelivered) { delivered.push([ticketId, inputId]); engine.inputsDelivered(ticketId, assignment.id, [inputId]) }
    }
  }
  const pump = () => { engine.evaluateDue(); settle() }
  // 一步：到期评估 + 模拟执行器。
  /** Simulate the worker's Session taking the delivered Trigger Inputs it has not yet read into a step. */
  // 模拟 worker 的 Session：把已投递但未读的触发器输入取进步骤。
  const read = (ticketId: string) => engine.inputsRead(ticketId, repo.tickets.get(ticketId)!.inputs.flatMap(input =>
    input.kind === 'trigger' && input.readAt === null ? [input.id] : []))
  const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  // 以候选的第一个触发器给出评估决定。
  return { repo, engine, outbox, withdrawn, requests, assessor, executor, delivered, settle, pump, read, decide,
    setVersion: (value: string) => { version = value }, setPaused: (value: boolean) => { paused = value }, tick: (seconds: number) => { clock += seconds } }
}
function accepted(h: ReturnType<typeof harness>, id = '1', thread = 't1') {
  h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] })); h.pump()
  const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })
  h.settle()
  return decision
}
// 标准前置：接收触发器并受理成工单。

describe('intake', () => {
  // describe 所测：收集（trigger 入库与过滤）。
  it('stores a trigger once and records source filtering', () => {
    // 触发器只入库一次；来源过滤被记录为处置。
    const h = harness()
    expect(h.engine.receive(trigger('1'))).toBe('stored')
    expect(h.engine.receive(trigger('1'))).toBe('duplicate')
    expect(h.engine.receive(trigger('2', { meta: { blocked: true } }))).toBe('filtered')
    expect(h.repo.triggers.disposition('2')?.filtered).toEqual({ code: 'chat not allowed' })
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual(['1'])
    // 存下的触发器进入线程的待评估队列。
  })
  it('records correlation for a trigger on several threads and evaluates only on the primary one', () => {
    // 多线程触发器记录关联；只在主线程上评估。
    const h = harness()
    h.engine.receive(trigger('1', { threads: [{ source: 'gh', id: 'pr-7' }, { source: 'gh', id: 'run-9' }] }))
    expect(h.repo.threads.get('gh:pr-7')).toMatchObject({ pending: ['1'], correlated: ['gh:run-9'] })
    expect(h.repo.threads.get('gh:run-9')).toMatchObject({ pending: [], correlated: ['gh:pr-7'] })
    // 主线程排队，其余线程只记关联。
  })
})
describe('eval', () => {
  // describe 所测：评估的生命周期。
  it('ignores at the gate without an assessor when nothing is admissible', async () => {
    // 门全拒时不劳评估器：直接记 ignore 决策并绑处置。
    const h = harness()
    h.engine.receive(trigger('1', { human: false })); h.pump()
    expect(h.assessor.request).not.toHaveBeenCalled()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'ignore', triggerIds: ['1'] })])
    expect(h.repo.triggers.disposition('1')?.decisionId).toBeDefined()
  })
  it('releases the assessor\'s state for every eval that ends, decided or not', async () => {
    // 每个结束的评估（无论是否被决策）都要释放评估器状态。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    expect(h.assessor.release).toHaveBeenCalledExactlyOnceWith(h.requests[0]!.evalId)
  })
  it('serializes evals per thread and debounces triggers that arrive meanwhile', async () => {
    // 评估按线程串行：评估期间到达的触发器合并进下一批（去抖）。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.engine.receive(trigger('2')); h.engine.receive(trigger('3')); h.pump()
    expect(h.requests).toHaveLength(1)
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual(['2', '3'])
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    h.pump()
    expect(h.requests[1]!.triggers.map(t => t.id)).toEqual(['2', '3'])
    expect(h.requests[1]!.strength).toBe('explicit')
    // 第二批沿用最强触发器的强度。
  })
  it('accept creates a ticket with a mandate, subscribes the thread, queues the acknowledgement and starts an assignment', async () => {
    // 受理：带授权建工单、订阅线程、排队回执、启动派工。
    const h = harness()
    const decision = accepted(h)
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket).toMatchObject({ title: 'Fix', mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: member, scope: 'small' }, channels: [trigger('1').channel],
      origin: { triggerId: '1', triggerIds: ['1'] } })
    expect(ticket).not.toHaveProperty('ended')
    expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running', startedAt: expect.any(String) })])
    expect(h.repo.threads.get('chat:t1')?.subscriptions).toEqual([ticket.id])
    expect(h.outbox).toEqual([{ id: key('ack', '1'), channel: trigger('1').channel, text: 'ok', kind: 'acknowledgement', ticketId: ticket.id }])
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('refuses to decide an eval that a later eval replaced, and decides the later one', async () => {
    // 被更新的评估顶替后：旧评估拒绝决策，新评估可决策。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const first = h.requests[0]!
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2'); h.pump()
    const second = h.requests[1]!
    expect(() => h.decide(first, { kind: 'ignore', reason: 'chatter' })).toThrow('has finished or a later eval replaced it')
    expect(h.decide(second, { kind: 'ignore', reason: 'chatter' })).toMatchObject({ kind: 'ignore', evalId: second.evalId })
  })
  it('records an accept with its ticket, subscriptions and acknowledgement together, or none of them', async () => {
    // 受理的建单/订阅/回执要么一起记录，要么都不记（原子性）。
    const h = harness({}, { prepareTicket: () => { throw new Error('No directory for the ticket') } })
    h.engine.receive(trigger('1')); h.pump()
    const evalId = h.requests[0]!.evalId
    expect(() => h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })).toThrow('No directory')
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ evaluating: { id: evalId }, subscriptions: [] })
    expect(h.outbox).toEqual([])
  })
  it('records unavailable when the policy version changed during assessment', async () => {
    // 评估期间策略版本变了：决策记为 unavailable，不建单。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.setVersion('v2')
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'x', scope: 'x', reason: 'x' })
    expect(decision.kind).toBe('unavailable')
    expect(h.repo.tickets.list()).toEqual([])
  })
  it('starts every pending eval in one step, so a second pump starts none of them again', () => {
    // 一步启动全部待评估（各线程并发）；再次 pump 不会重复启动。
    const h = harness()
    for (const [id, thread] of [['1', 'A'], ['2', 'B']] as const) h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] }))
    expect(h.engine.evaluateDue()).toBeUndefined()
    h.engine.evaluateDue()
    expect(h.requests.map(candidate => candidate.thread.key)).toEqual(['chat:A', 'chat:B'])
  })
  it('counts an Eval\'s deadline from its delivery, queues its Triggers again twice when it expires, then records it unavailable', async () => {
    // 评估期限从“评估器已取走候选”起算；超时重排两次，第三次记 unavailable。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    // A candidate the assessor's Session has not taken does not expire.
    // 评估器还没取走的候选不超时。
    h.tick(600); h.pump()
    expect(h.engine.candidate('1')?.evalId).toBe(h.requests[0]!.evalId)
    const deliver = () => { h.engine.candidateDelivered(h.requests.at(-1)!.evalId) }
    deliver()
    h.tick(59); h.pump()
    expect(h.requests).toHaveLength(1)
    // Expired, it records nothing and queues the Trigger for a fresh Eval, twice.
    // 超时后不记录任何决策，把触发器重新排队进新评估——两次。
    h.tick(2); h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.assessor.release).toHaveBeenCalledWith(h.requests[0]!.evalId)
    expect(h.requests.map(item => item.triggers.map(each => each.id))).toEqual([['1'], ['1']])
    deliver(); h.tick(61); h.pump()
    expect(h.requests).toHaveLength(3)
    // The third expiry is recorded unavailable.
    // 第三次超时记录 unavailable。
    deliver(); h.tick(61); h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'unavailable', reason: [{ code: 'timeout' }] })])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('expired')
  })
})
describe('subscription fan-out', () => {
  // describe 所测：订阅扇出（跟进直达工单）。
  it('delivers a person\'s later message on a subscribed thread to the live ticket as context, and not to Eval', async () => {
    // 订阅线程上人的后续消息作为上下文直达活工单，不进评估。
    const h = harness()
    const decision = accepted(h)
    const requests = h.requests.length
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: '2' })])
    expect(ticket.undelivered).toEqual([])
    expect(h.delivered).toEqual([[ticket.id, ticket.inputs[0]!.id]])
    expect(h.repo.triggers.disposition('2')).toEqual({ fanout: [ticket.id], at: expect.any(String) })
    // No Eval, so no Decision and no timeout, and the Thread's queue stays free for a new request.
    // 没有评估就没有决策与超时；线程队列保持空闲给新请求。
    expect([h.requests.length, h.repo.threads.get('chat:t1')!.pending, h.repo.decisions.byThread('chat:t1').length]).toEqual([requests, [],
      1])
    h.tick(600); h.engine.evaluateDue()
    expect(h.repo.decisions.byThread('chat:t1')).toHaveLength(1)
    // A bot's message there still goes to Eval, which the gate does not admit.
    // 机器人在该线程的消息仍进评估（门会拒），记 ignore。
    h.engine.receive(trigger('3', { human: false })); h.pump()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: ['3'] })
  })
  it('keeps inputs undelivered until an assignment is running, and asks to launch one whose launch failed again', () => {
    // 派工没跑起来就不投递输入；启动失败会再次请求启动。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
    h.settle({ launch: false })
    h.engine.receive(trigger('2')); h.engine.evaluateDue(); h.settle({ launch: false })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.undelivered).toHaveLength(1)
    expect(h.executor.deliver).not.toHaveBeenCalled()
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id); h.settle()
    expect(h.delivered).toEqual([[ticket.id, ticket.undelivered[0]!]])
    // 派工启动后输入才送达。
  })
  it('does not hand a bot\'s message to an ended ticket, and still assesses it', async () => {
    // 机器人的消息不给已结束的工单，但仍照常评估（门拒绝）。
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.engine.receive(trigger('2', { human: false })); h.pump()
    // The Executor reads its threads again when it resumes, so bots and CI neither wake nor queue on an ended ticket.
    // 执行器恢复时会重读线程：机器人与 CI 既不唤醒也不排在已结束工单上。
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('resumes once however often it pumps, with the resume note ahead of the message, and drops what waited when the policy no longer holds the mandate', async () => {
    // 无论 pump 多少次只恢复一次；恢复备注在消息之前；策略不再支持授权时丢弃等待的消息。
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    h.setVersion('v1')
    h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)!.ended).toBeDefined()
    // 授权失效期间不恢复。
    h.engine.receive(trigger('3', { actor: guest })); h.pump(); h.pump()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.inputs.filter(input => input.kind === 'resumed')).toHaveLength(1)
    // 多次 pump 也只有一条 resumed 输入。
  })
  it('takes delivery reports only from the assignment that still runs the open ticket', () => {
    // 只有仍运行着活工单的派工才能上报投递结果。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const assignment = h.repo.tickets.get(ticketId)!.assignments[0]!.id
    h.engine.receive(trigger('2'))
    const input = key('input', ticketId, 'trigger', '2')
    h.engine.deliveryFailed(ticketId, assignment, 'Session busy')
    expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: 'Session busy' })
    h.engine.deliveryFailed(ticketId, 'another', 'other')
    h.engine.inputsDelivered(ticketId, 'another', [input])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [input], delivery: { error: 'Session busy' } })
    // 过期派工的上报被忽略。
    h.engine.inputsDelivered(ticketId, assignment, [input])
    expect(h.repo.tickets.get(ticketId)!.undelivered).toEqual([])
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    h.engine.receive(trigger('3')); h.engine.stopTicket(ticketId)
    h.engine.deliveryFailed(ticketId, assignment, 'late')
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    // 工单结束后同样忽略。
  })
  it('unsubscribing a thread stops fan-out until a new decision subscribes it', async () => {
    // 退订线程即停止扇出，直到新的决策重新订阅。
    const h = harness()
    const decision = accepted(h)
    expect(h.engine.unsubscribe('chat:t1')).toBe(true)
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([])
  })
  it('lets an Executor drop a thread attached to its ticket, keeping the thread\'s other tickets, but not its own threads', async () => {
    // worker 可丢弃工单附着的无关线程（保留该线程的其他工单）；自己的线程不可丢。
    const events: { type: string; data: Record<string, unknown> }[] = []
    const h = harness({}, { emit: event => events.push(event) })
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    // A follow-up of the second ticket goes to the first only once the second's worker hands it back.
    // 第二个工单的跟进要等其 worker 交回后才到第一个。
    h.engine.handback(second, '3', 'It is about the first fix')
    h.engine.attach(first, '3')
    expect(h.repo.threads.get('chat:t2')!.subscriptions).toEqual([second, first])
    h.engine.markUnrelated(first, 'chat:t2', 'about another fix')
    expect(h.repo.threads.get('chat:t2')!.subscriptions).toEqual([second])
    expect(events.filter(event => event.type === 'thread.unsubscribed').map(event => event.data))
      .toEqual([{ threadKey: 'chat:t2', ticketId: first, by: 'executor', reason: 'about another fix' }])
    expect(() => h.engine.markUnrelated(first, 'chat:t2', 'again')).toThrow(new UserError('notFollowing'))
    expect(() => h.engine.markUnrelated(first, 'chat:t1', 'its own')).toThrow(new UserError('sourceThread'))
    h.engine.bindThread(first, { source: 'gh', id: 'pr-9' }, true)
    expect(() => h.engine.markUnrelated(first, 'gh:pr-9', 'its PR')).toThrow(new UserError('followedThread'))
    // 三类拒绝：未跟随、自己的来源线程、跟随的 PR。
  })
})
describe('resume and stop', () => {
  // describe 所测：恢复与停止。
  async function ended(h: ReturnType<typeof harness>, by: 'executor' | 'human') {
    const decision = accepted(h)
    if (by === 'executor') h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    else h.engine.stopTicket(decision.ticketId!)
    return decision.ticketId!
  }
  // 造一个已结束的工单（executor 结束或人停止）。
  it('resumes an ended ticket on any person\'s message on its thread, under the same mandate and without a Decision', async () => {
    // 线程上任何人的消息都恢复已结束工单：沿用同一授权、不需要 reopen 决策。
    const h = harness()
    const ticketId = await ended(h, 'executor')
    const decisions = h.repo.decisions.byThread('chat:t1').length
    // It resumes as the message arrives, before any Eval of it.
    // 消息一到就恢复，早于它的任何评估。
    h.engine.receive(trigger('2', { actor: guest }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
    h.pump()
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.mandate.policyVersion).toBe('v1')
    expect(ticket.inputs.map(input => input.kind)).toEqual(['trigger', 'resumed'])
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    // The message still reaches Eval as a follow-up, but no reopen Decision is needed or possible.
    // 消息仍作为跟进进评估，但不需要也不可能有 reopen 决策。
    expect(h.repo.decisions.byThread('chat:t1').filter(decision => decision.kind !== 'ignore')).toHaveLength(decisions)
  })
  it('resumes an ended ticket an earlier version left with a person\'s message waiting, on the next pass', async () => {
    // 旧版本留在工单上等待的人消息：下一轮轮转恢复工单。
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const stored = h.repo.tickets.get(ticketId)!
    const input = { id: 'waiting', kind: 'trigger' as const, triggerId: '2', at: stored.updatedAt, human: true as const }
    h.repo.tickets.save({ ...stored, inputs: [...stored.inputs, input], undelivered: ['waiting'] })
    h.pump()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ kind: 'resumed' })]) })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
  })
  it('resumes an ended ticket at once when a person attaches a message to it', async () => {
    // 人把消息附着到已结束工单：立即恢复并排新派工。
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const subject = h.engine.attach(ticketId, '2')
    expect(subject).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: 'pending' })] })
    expect(subject).not.toHaveProperty('ended')
  })
  it('keeps a ticket a person stopped ended: the stop withdrew its mandate', async () => {
    // 人停止的工单保持结束：停止已撤回授权。
    const h = harness()
    const ticketId = await ended(h, 'human')
    expect(h.executor.stop).toHaveBeenCalledOnce()
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.objectContaining({ by: 'human' }) })
    expect(h.executor.start).toHaveBeenCalledOnce()
    // 消息到达也不复活。
  })
  it('keeps a ticket ended when its mandate no longer passes the current policy', async () => {
    // 授权过不了当前策略（版本已吊销）时工单保持结束。
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.setVersion('revoked')
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
  })
  it('stops a live ticket only on an explicit instruction and ends it by the human', async () => {
    // 活工单只在显式指令下停止，结束记为人。
    const h = harness()
    const decision = accepted(h)
    // Follow-ups that reached the ticket: the gate judges them when the main Session acts on one, a guest's as inferred.
    // 已到工单的跟进：主 Session 对其操作时由门判定，访客的按推断。
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.engine.decide('2', { kind: 'stop', ticketId: decision.ticketId!, reason: 'x' })).toMatchObject({ kind: 'ignore',
      strength: 'inferred', reason: [{ code: 'stopNotExplicit' }] })
    h.engine.receive(trigger('3')); h.pump()
    expect(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'human said stop' }).kind).toBe('stop')
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.objectContaining({ by: 'human' }) })
    expect(h.executor.stop).toHaveBeenCalledOnce()
  })
})
describe('follow-ups', () => {
  // describe 所测：跟进消息的排队与评估。
  it('takes a follow-up an older version queued out of the queue without a Decision, and keeps one sent to Eval again', () => {
    // 旧版本排队的跟进直接出队（无决策）；被人再送评估的保持。
    const h = harness()
    accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.receive(trigger('3', { actor: guest }))
    // As an older version left them: both queued for Eval; a person sent the second there again.
    // 如旧版本留下的样子：两条都排队等评估；第二条是人又送进去的。
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, pending: ['2', '3'] })
    h.engine.reevaluate('3'); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3'])
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    expect(h.repo.decisions.byThread('chat:t1').flatMap(decision => decision.triggerIds)).toEqual(['1'])
    // '2' 直达工单出队；只有 '3' 进评估；没有新决策。
  })
  it('decides a follow-up in a gate-only Eval beside the Eval its Thread has in progress, which goes on', () => {
    // 跟进可在“只过门”的评估中与线程进行中的评估并行决策，后者不受影响。
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    const evaluating = h.repo.threads.get('chat:t1')!.evaluating!
    h.engine.receive(trigger('3'))
    expect(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'stop it' })).toMatchObject({ kind: 'stop',
      triggerIds: ['3'] })
    expect(h.repo.threads.get('chat:t1')!.evaluating).toEqual(evaluating)
    expect(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })).toMatchObject({ kind: 'ignore', triggerIds: ['2'] })
    // 3 的停止即时决策；2 的门评估照常结束。
  })
  it('leaves the Thread free for a later request that reaches no ticket', () => {
    // 工单决定跟进期间线程没被评估占用：新请求即刻评估，与被放弃的跟进同批。
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    h.engine.stopTicket(decision.ticketId!, 'not needed')
    // The follow-up held no Eval while the ticket decided it, so the next request is assessed at once rather than after a
    // timeout, together with the follow-up, which the stop let go of before its worker took it up.
    // 跟进由工单决定期间不占评估：下一个请求立即评估（而非等超时），与停止放开的跟进同批。
    h.engine.receive(trigger('3')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2', '3'])
  })
})
describe('hand-back', () => {
  // describe 所测：worker 交回消息。
  it('queues a message that reached a ticket for a fresh Eval with the gate\'s strength, once per ticket, and keeps the subscription',
    () => {
    // 已到工单的消息交回后按门的强度重新排队评估；每工单每消息一次；订阅保留。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2')); h.engine.receive(trigger('3', { actor: guest })); h.pump()
    expect(h.engine.handback(ticketId, '2', 'A new request')).toBe(true); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'explicit', triggers: [{ id: '2' }] })
    expect(h.repo.triggers.disposition('2')!.handbacks).toEqual([{ ticketId, reason: 'A new request', at: expect.any(String) }])
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })
    expect(() => h.engine.handback(ticketId, '2', 'Again')).toThrow(new UserError('handedBack'))
    expect(h.engine.handback(ticketId, '3', 'A guest asks for more')).toBe(true); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'inferred', triggers: [{ id: '3' }] })
    expect(h.repo.threads.get('chat:t1')!.subscriptions).toContain(ticketId)
    // Only a message that reached the ticket can go back.
    // 只有到过工单的消息才能交回。
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    expect(() => h.engine.handback(ticketId, '4', 'Not mine')).toThrow(new UserError('notReached'))
  })
  it('queues again no message the ticket did not decide: one a person sent to Eval, a bot\'s, or one on a Thread followed for context',
    () => {
    // 工单没决定过的消息不因交回重排：人送评估的、机器人的、上下文线程上的。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
    h.engine.receive(trigger('2')); h.engine.reevaluate('2')
    h.engine.receive(trigger('3', { human: false })); h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] })); h.pump()
    for (const candidate of h.requests.slice(-2)) h.decide(candidate, { kind: 'ignore', reason: 'chat' })
    // Each went to Eval without the ticket, and its Decision stands.
    // 各自不经工单进了评估，决策照常成立。
    for (const id of ['2', '3', '4']) expect(h.engine.handback(ticketId, id, 'Not this ticket')).toBe(false)
    expect([h.repo.threads.get('chat:t1')!.pending, h.repo.threads.get('chat:issue')!.pending]).toEqual([[], []])
    // The hand-back is recorded all the same, so the main Session does not attach the message back.
    // 交回仍然被记录：主 Session 不能再把消息附着回去。
    expect(h.repo.triggers.disposition('4')!.handbacks).toEqual([{ ticketId, reason: 'Not this ticket', at: expect.any(String) }])
    expect(() => h.engine.attach(ticketId, '4')).toThrow(new UserError('handedBackHere'))
  })
  it('leaves a message the main Session attached to a ticket to its worker, whose hand-back sends it to Eval', () => {
    // 主 Session 附着给工单的消息由 worker 决定；其交回把它送进评估。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] })); h.pump()
    h.engine.attach(ticketId, '2'); h.settle()
    // Routed to the ticket, it is not new work as well.
    // 已路由给工单的消息不能再当新工作受理。
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Y', scope: 'small', reason: 'requested' }))
      .toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.engine.handback(ticketId, '2', 'Asks for another change')).toBe(true)
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2'])
  })
})
describe('context threads and notes', () => {
  // describe 所测：上下文线程与备注。
  it('fans a Thread followed for context out to the live ticket, resumes no ended ticket from it, unless it was attached', async () => {
    // 仅上下文跟随的线程扇出给活工单；不从中恢复已结束工单——除非主 Session 附着过。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })).toBe(true)
    expect(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })).toBe(false)
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'issue' }] })); h.settle()
    expect(h.repo.tickets.get(ticketId)!.inputs.map(input => input.kind === 'trigger' && input.triggerId)).toEqual(['2'])
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 'issue' }] }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    // Attached by the main Session, the Thread is the ticket's own, and a person's later message there resumes it.
    // 主 Session 附着后该线程成为工单自己的线程：人的后续消息可恢复工单。
    h.engine.attach(ticketId, '3'); h.settle()
    expect(h.repo.threads.get('chat:issue')).toMatchObject({ context: [] })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('counts a message on a Thread a ticket follows only for context as none of its follow-ups, and lifts no block with it', () => {
    // 仅上下文线程上的消息不算工单的跟进，也不解其阻塞。
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 'other').ticketId!
    h.engine.followForContext(follower, { source: 'chat', id: 't1' })
    h.engine.receive(trigger('3', { actor: guest })); h.pump()
    expect(h.repo.triggers.disposition('3')).toMatchObject({ fanout: [owner, follower], context: [follower] })
    expect(h.repo.tickets.get(follower)!.inputs.at(-1)).toMatchObject({ triggerId: '3', context: true })
    // On the follower's own Thread no longer: a message reaching only it goes to Eval, with the guest's that the stopped owner
    // let go of.
    // 回到 follower 自己的线程就不同了：只到它的消息进评估——与被停止的 owner 放开的访客消息同批。
    h.engine.stopTicket(owner, 'done')
    h.engine.report(follower, { state: 'blocked', summary: 'needs a decision' })
    h.engine.receive(trigger('4')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3', '4'])
    expect(waitsForPerson(h.repo.tickets.get(follower)!)).toBe(true)
  })
  it('sends a message to Eval when the ticket it reached cannot resume and only a ticket following its Thread for context is left', () => {
    // 消息到达的工单无法恢复、只剩上下文跟随者时：送评估。
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 'other').ticketId!
    h.engine.followForContext(follower, { source: 'chat', id: 't1' })
    h.engine.report(owner, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('3')); h.setVersion('v1'); h.pump()
    expect(h.repo.triggers.disposition('3')).toMatchObject({ fanout: [follower], context: [follower] })
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3'])
  })
  it('gives an open ticket\'s worker a note as an Input of its own, held like automatic Input, and refuses one for an ended ticket', () => {
    // 活工单的备注是独立输入，像自动输入一样被扣留；已结束工单拒收备注。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.note(ticketId, 'The other ticket renamed the API').inputs.at(-1)).toMatchObject({ kind: 'note',
      text: 'The other ticket renamed the API' })
    // A worker that reported blocked waits for a person: a note does not wake it.
    // 报了 blocked 等人的 worker：备注不唤醒它。
    h.settle()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    const note = h.engine.note(ticketId, 'Ticket B changed the schema').inputs.at(-1)!
    h.settle()
    expect(h.delivered.map(([, id]) => id)).not.toContain(note.id)
    expect(h.repo.tickets.get(ticketId)!.inputs).toContainEqual(note)
    h.engine.stopTicket(ticketId, 'done')
    expect(() => h.engine.note(ticketId, 'Too late')).toThrow(new UserError('ticketEnded'))
  })
})
describe('follow-up owners', () => {
  // describe 所测：跟进消息的归属与交接。
  const accept = { kind: 'accept' as const, title: 'Y', scope: 'small', reason: 'requested' }
  const decides = (...tickets: string[]) => new UserError('workerDecides', { tickets: tickets.join(', ') })
  it('lets the main Session take a follow-up as new work once it stopped the ticket on it', () => {
    // 主 Session 在“停止了决定该消息的工单”之后可把跟进当新工作受理。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // "Stop this, and do Y instead": the stop ends the ticket that decided the message, so the request is the main Session's.
    // “停掉这个，改做 Y”：停止结束了决定该消息的工单，请求就归主 Session。
    h.engine.receive(trigger('2')); h.settle()
    expect(() => h.engine.decide('2', accept)).toThrow(decides(ticketId))
    expect(h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' }).kind).toBe('stop')
    // At the same moment, the accept is a Decision of its own beside the stop's.
    // 同一时刻，受理可以作为独立决策与停止并列。
    expect(h.engine.decide('2', accept)).toMatchObject({ kind: 'accept', triggerIds: ['2'] })
    expect(h.repo.decisions.byThread('chat:t1').filter(item => item.triggerIds.includes('2')).map(item => item.kind)).toEqual(['stop',
      'accept'])
  })
  it('sends a follow-up its worker never received to Eval when the ticket ends, by a report or a stop', () => {
    // worker 从未收到的跟进在工单结束（汇报或停止）时送评估。
    for (const end of ['report', 'stop'] as const) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.receive(trigger('2'))
      expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1)
      if (end === 'report') h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      else h.engine.stopTicket(ticketId, 'not needed')
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
      h.pump()
      expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2'])
    }
  })
  it('sends a follow-up its worker got since its last report to Eval when the ticket ends, unless it acknowledged it', () => {
    // worker 在上次汇报之后收到的跟进在工单结束时送评估——除非它确认过。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    // The worker acknowledges one of two messages, and its final report was on its way before it took up the other.
    // worker 确认了两条消息之一；其最终汇报发出时还没接手另一条。
    h.tick(1); h.engine.receive(trigger('2')); h.engine.receive(trigger('3')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
    // The ticket no longer counts as having reached it, so its candidate names no ticket that gave no reason.
    // 工单不再算“到过”未接手的消息：候选卡不会说出一个没给理由的工单。
    expect([h.repo.triggers.disposition('2')!.fanout, h.repo.triggers.disposition('3')!.fanout]).toEqual([[ticketId], []])
  })
  it('keeps a ticket open after its pull request merged while its worker is on a person\'s message it took up after its last report',
    () => {
    // PR 合并时 worker 正处理“上次汇报之后接手的人消息”：工单保持打开。
    for (const taken of [true, false]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
      h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
      // A person asks for one more change, which the worker takes up or has not yet, and the pull request merges meanwhile.
      // 人又提一条改动；worker 接手或尚未接手，期间 PR 合并了。
      h.tick(1); h.engine.receive(trigger('2')); h.settle()
      if (taken) h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
      h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
      // One it has not taken up leaves the merge to end the ticket, and goes to Eval.
      // 未接手的那条让合并照常结束工单，自己进评估。
      expect([h.repo.tickets.get(ticketId)!.ended?.outcome, h.repo.threads.get('chat:t1')!.pending]).toEqual(taken ? [undefined, []]
        : ['merged', ['2']])
      // The worker's ready report ends it as the pull request did.
      // 接手后的 ready 汇报按 PR 的结局（merged）结束工单。
      if (taken) h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
      expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    }
  })
  it('gives a follow-up its ended ticket let go to that ticket again when the main Session attaches it there', () => {
    // 主 Session 把工单放开的跟进重新附着：消息再次到达 worker，工单恢复。
    for (const resumed of [false, true]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      // The ticket ends before its worker took up a person's message, which goes to Eval; a later message may resume it.
      // worker 接手前工单结束，消息进评估；之后的另一条消息可能已恢复工单。
      h.engine.report(ticketId, { state: 'progress', summary: 'working' })
      h.tick(1); h.engine.receive(trigger('2')); h.settle()
      h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      if (resumed) { h.tick(1); h.engine.receive(trigger('3')) }
      h.pump()
      h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
      // Its worker gets the message again, and an ended ticket resumes for it.
      // worker 再次拿到该消息，已结束的工单为它恢复。
      const copies = h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2')
      expect(h.delivered).toContainEqual([ticketId, copies[1]?.id])
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
      expect(followupOwners(trigger('2'), h.repo)).toEqual([ticketId])
    }
  })
  it('wakes an ended ticket for a message attached to it that its worker read only for context or before its last report', () => {
    // 附着的消息若只被 worker 当上下文读过、或在最后一次汇报前读过：恢复工单。
    for (const read of ['context', 'report'] as const) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      if (read === 'context') h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
      h.tick(1); h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: read === 'context' ? 'issue' : 't1' }] })); h.settle()
      // The worker reports after reading it and drops the ticket; a person sends a follow-up it had to Eval from the panel.
      // worker 读完消息后汇报并放弃工单；人从面板把该跟进送评估。
      h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'read it' })
      h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      if (read === 'report') h.engine.reevaluate('2')
      h.pump()
      h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
      expect(followupOwners(h.repo.triggers.get('2')!, h.repo)).toEqual([ticketId])
    }
  })
  it('counts a question the final report answers as taken up, so it does not come back as a candidate beside its answer', () => {
    // 最终汇报已回答的问题算“接手过”：不会和答案一起回到候选。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'It reads the config.', answers: '2' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    expect(h.repo.triggers.disposition('2')).toMatchObject({ fanout: [ticketId], acked: [ticketId] })
  })
  it('sends to Eval a message attached after its Eval was unavailable, once its ticket ends without taking it up', () => {
    // 评估 unavailable 之后附着到工单的消息：工单结束且未接手时送评估。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] })); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' })
    h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2'])
  })
  it('counts an acknowledgement an earlier version queued without recording it on the message as taking the message up', () => {
    // 旧版本只排了回执、没在消息上记录：也算接手了消息。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.outbox.push({ id: key('ack', '2'), channel: trigger('2').channel!, text: 'On it', kind: 'acknowledgement', ticketId })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect([h.repo.threads.get('chat:t1')!.pending, h.repo.triggers.disposition('2')!.fanout]).toEqual([[], [ticketId]])
  })
  it('counts a message that resumed a ticket as taken up by the report that ends it again, unlike one that came later', () => {
    // 恢复工单的消息由“再次结束工单的汇报”算接手；更晚到的消息不算。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    // A person's thanks resumes the ticket, and its worker takes it into a step first, a moment after its Assignment started,
    // as the Executor delivers it; a request comes while it reports that nothing is left.
    // 人的感谢恢复工单；worker 在派工启动后片刻（执行器投递时）先把它取进步骤；另一条请求在它汇报无事可做时到达。
    h.tick(1); h.engine.receive(trigger('2'))
    h.tick(1); h.engine.assignmentStarted(ticketId, h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id)
    h.tick(1); h.settle(); h.read(ticketId)
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
    // '2' 已读不送评估；'3' 未接手进评估。
  })
  it('sends a follow-up its ticket let go to Eval after a stop on it was refused, but not the one a stop ended it on', () => {
    // A guest's stop is refused, and the worker drops the ticket; a member's stop ends it, and the main Session, which stopped
    // it, decides the rest of the message itself.
    // 访客的停止被拒、worker 放弃工单（消息送评估）；成员的停止结束工单，消息归停止它的主 Session 决定。
    for (const actor of [guest, member]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.receive(trigger('2', { actor }))
      h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' })
      if (actor === guest) h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(actor === guest ? ['2'] : [])
    }
  })
  it('sends the message a stop ended a ticket on to Eval once another ticket it reached ends without taking it up', () => {
    // 停止结束的工单放开了消息：它到达的另一个工单也未接手而结束时，送评估。
    const h = harness()
    const stopped = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!
    h.engine.bindThread(other, { source: 'chat', id: 't1' }, false)
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.decide('2', { kind: 'stop', ticketId: stopped, reason: 'asked to stop' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    h.engine.report(other, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
  it('hands the follow-ups on a thread a worker found unrelated back to Eval, with its reason', () => {
    // worker 判定线程无关时把其上的跟进交回评估，并附理由。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const elsewhere = { threads: [{ source: 'chat', id: 'x' }] }
    h.engine.receive(trigger('2', elsewhere)); h.pump()
    h.engine.attach(ticketId, '2'); h.settle()
    h.engine.receive(trigger('3', elsewhere)); h.settle()
    expect(() => h.engine.decide('3', accept)).toThrow(decides(ticketId))
    // The worker finds the attached thread is not its ticket's, and answers nothing there: the message the main Session
    // attached goes back with the later one, and each candidate says why.
    // worker 发现附着的线程不属于其工单且不在那边回话：主 Session 附着的消息与后来的消息一起交回，各自候选说明原因。
    h.engine.markUnrelated(ticketId, 'chat:x', 'about something else')
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2', '3'])
    expect(h.repo.triggers.disposition('3')!.handbacks).toEqual([{ ticketId, reason: 'about something else', at: expect.any(String) }])
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2', '3'])
  })
  it('keeps a follow-up two tickets reached with the one that did not hand it back, and queues it once neither decides it', () => {
    // 到过两个工单的跟进留在未交回的工单手里；两个都不决定时排队评估。
    const h = harness()
    const first = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.handback(first, '2', 'another change'); h.pump()
    const second = h.decide(h.requests.at(-1)!, accept).ticketId!
    h.settle()
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    expect(h.repo.triggers.disposition('3')!.fanout).toEqual([first, second])
    expect(h.engine.handback(first, '3', 'for the other ticket')).toBe(false)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    // The main Session may neither take nor dismiss it while the second ticket's worker decides it.
    // 第二个工单的 worker 决定它时：主 Session 既不能受理也不能无视。
    expect(() => h.engine.decide('3', accept)).toThrow(decides(second))
    expect(() => h.engine.decide('3', { kind: 'ignore', reason: 'chat' })).toThrow(decides(second))
    expect(h.engine.handback(second, '3', 'neither ticket')).toBe(true)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('lets an Eval an earlier version started on a follow-up decide it', () => {
    // 旧版本在跟进上启动的评估仍可决策它。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2')); h.settle()
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'e-legacy', threadKey: 'chat:t1', triggerIds: ['2'], strength: 'explicit',
      actor: member, basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '2026-09-23T00:00:00Z', deadline: '2026-09-24T00:00:00Z' } })
    expect(followupOwners(trigger('2'), h.repo)).toEqual([])
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'chat', evalId: 'e-legacy' })).toMatchObject({ kind: 'ignore',
      triggerIds: ['2'] })
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
    // 决策不结束工单。
  })
})
describe('interrupted assignments', () => {
  // describe 所测：被中断的派工。
  it('starts an Assignment interrupted mid-work again with a note, and hands one that waits what waits for it', () => {
    // 干活中被中断的派工带备注重启；等待中的工单只拿到在等的输入。
    const h = harness()
    const interrupted = accepted(h).ticketId!
    const first = h.repo.tickets.get(interrupted)!.assignments[0]!
    const waiting = accepted(h, '2', 't2').ticketId!
    h.engine.report(waiting, { state: 'waiting', summary: 'done for now' })
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    vi.mocked(h.executor.start).mockClear(); vi.mocked(h.executor.deliver).mockClear()
    // The Executor reports each Assignment that was running; a fact about one that no longer runs is dropped.
    // 执行器上报每个运行中的派工；对已不运行的派工的事实被丢弃。
    for (const id of [interrupted, waiting]) h.engine.assignmentInterrupted(id, runningAssignment(h.repo.tickets.get(id)!)!.id)
    h.engine.assignmentInterrupted(interrupted, first.id)
    const ticket = h.repo.tickets.get(interrupted)!
    expect(ticket.assignments).toEqual([expect.objectContaining({ id: first.id, state: 'ended', endedReason: 'hostRestarted' }),
      expect.objectContaining({ state: 'pending' })])
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('The host restarted') })])
    expect(ticket.undelivered).toEqual([ticket.inputs[0]!.id])
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: interrupted }), ticket.assignments[1])
    // A worker that waits keeps its Session and gets what waits for it.
    // 等待中的 worker 保留其 Session，只拿到在等的输入。
    expect(h.repo.tickets.get(waiting)!.assignments).toHaveLength(1)
    expect(h.executor.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: waiting }), expect.objectContaining({ state: 'running' }))
  })
  it('starts again a worker that reported but then got a person\'s message, which it was working on', () => {
    // 汇报后又收到人消息并在处理的 worker：重启时派工重新启动。
    const h = harness()
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.report(other, { state: 'waiting', summary: 'done for now' })
    h.tick(1); h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 't2' }] })); h.settle()
    const running = runningAssignment(h.repo.tickets.get(other)!)!
    expect(running.deliveredAt! > running.report!.at).toBe(true)
    h.engine.assignmentInterrupted(other, running.id)
    expect(h.repo.tickets.get(other)!.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
  })
})
describe('pause', () => {
  // describe 所测：暂停。
  it('lets no Eval expire while processing is paused, and moves its deadline on by the pause\'s length', () => {
    // 暂停期间评估不超时；期限按暂停时长顺延。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.engine.candidateDelivered(h.requests[0]!.evalId)
    const deadline = Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline)
    h.tick(30); h.setPaused(true); h.pump()
    // Paused past the deadline, the Eval waits.
    // 暂停越过了期限：评估继续等。
    h.tick(300); h.pump()
    expect(h.engine.candidate('1')).toBeDefined()
    h.setPaused(false); h.pump()
    expect(Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline)).toBe(deadline + 300_000)
    h.tick(29); h.pump()
    expect(h.engine.candidate('1')).toBeDefined()
    // Expired, it queues the Trigger again for a fresh Eval.
    // 真正超时后：触发器重排进新评估。
    h.tick(1); h.pump()
    expect(h.engine.candidate('1')?.evalId).not.toBe(h.requests[0]!.evalId)
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
})
describe('policy change', () => {
  // describe 所测：策略变更。
  it('tells only the live tickets a change bears on how it does, and restarts in-flight evals under the new version', async () => {
    // 只通知受影响的活工单变更如何影响它；飞行中的评估按新版本重启。
    const h = harness()
    const decision = accepted(h)
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] })); h.pump()
    const effect = { rules: [{ id: 'copy', name: 'Copy', change: 'changed' as const, instruction: 'Fix typos only.' }] }
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2', new Map([[decision.ticketId!, effect]]))
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([expect.objectContaining({ kind: 'policy-changed', from: 'v1', to: 'v2', effect })])
    expect(h.repo.tickets.get(other)!.inputs.filter(input => input.kind === 'policy-changed')).toEqual([])
    expect(h.repo.decisions.byThread('chat:t2')).toEqual([expect.objectContaining({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })])
    expect(h.repo.threads.get('chat:t2')?.pending).toEqual(['2'])
    h.pump()
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: 'v2', triggers: [expect.objectContaining({ id: '2' })] })
    const told = h.repo.tickets.get(decision.ticketId!)!.inputs.find(input => input.kind === 'policy-changed')!
    expect(h.delivered).toEqual([[decision.ticketId, told.id]])
    // 变更输入投递给运行中的派工。
  })
  it('does not start evals while paused', async () => {
    // 暂停时不启动评估。
    const h = harness({ paused: true })
    h.engine.receive(trigger('1')); h.pump()
    expect(h.assessor.request).not.toHaveBeenCalled()
  })
})

describe('worker reports', () => {
  // describe 所测：worker 汇报。
  it('asks, keeps, replaces and clears the question for a person, and says which question a report replaced', () => {
    // 提问的设置、保持、替换与清除；被替换的问题从出站箱撤回。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = h.engine.report(ticketId, { state: 'progress', summary: 'need a call', question: 'Which color?', askedBy: '1' })
    expect(asked.attention).toMatchObject({ question: 'Which color?', triggerId: '1' })
    expect(h.engine.report(ticketId, { state: 'blocked', summary: 'still waiting' }).attention).toEqual(asked.attention)
    expect(h.withdrawn).toEqual([])
    const replaced = h.engine.report(ticketId, { state: 'progress', summary: 'other question', question: 'Which size?' })
    expect(replaced.attention).toMatchObject({ question: 'Which size?' })
    expect(replaced.attention).not.toHaveProperty('triggerId')
    // The replaced question is withdrawn from the outbox if its message has not gone out yet.
    // 被替换的问题若消息还没发出去就从出站箱撤回。
    expect(h.withdrawn).toEqual([key('attention-reply', asked.attention!.id)])
    const cleared = h.engine.report(ticketId, { state: 'progress', summary: 'answered', question: null })
    expect(cleared).not.toHaveProperty('attention')
    expect(h.withdrawn).toEqual([key('attention-reply', asked.attention!.id), key('attention-reply', replaced.attention!.id)])
  })
  it('ends the ticket on a final report: dropped drops it, ready completes it unless it follows a Source\'s Thread that is open', () => {
    // 终态汇报的结局：dropped 即结束；ready 完成它——除非还跟着未关闭的来源线程。
    const outcome = (state: 'ready' | 'dropped' | 'failed', follows: boolean, closed = false) => {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Merge it?' })
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
      // Work resumed after both closed ends with its ready report, using the latest close outcome.
      // 两个线程都关闭后恢复的工作以其 ready 汇报收尾，采用最新的关闭结局。
      if (closed) {
        h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'closed', '2026-09-22T00:00:00Z')
        h.engine.threadClosed({ source: 'gh', id: 'pr-10' }, 'merged', '2026-09-22T00:00:01Z')
      }
      h.engine.report(ticketId, { state, summary: 'done' })
      return h.repo.tickets.get(ticketId)!
    }
    expect(outcome('dropped', true)).toMatchObject({ ended: { by: 'executor', outcome: 'dropped' } })
    expect(outcome('dropped', true).ended).not.toHaveProperty('reason')
    expect(outcome('ready', false)).toMatchObject({ ended: { outcome: 'completed' } })
    expect(outcome('ready', false)).not.toHaveProperty('attention')
    expect(outcome('ready', true)).toMatchObject({ follows: [{ thread: 'gh:pr-9', own: false }, { thread: 'gh:pr-10', own: true }],
      assignments: [expect.objectContaining({ report: expect.objectContaining({ state: 'ready' }) })] })
    expect(outcome('ready', true)).not.toHaveProperty('ended')
    expect(outcome('ready', true)).not.toHaveProperty('attention')
    expect(outcome('ready', true, true)).toMatchObject({ ended: { outcome: 'merged' } })
    expect(outcome('failed', false)).toMatchObject({ attention: { question: 'Merge it?' } })
    expect(outcome('failed', false)).not.toHaveProperty('ended')
    // failed 不是终态：问题保留、工单不结束。
  })
  it('refuses a question with a result or an answer, and questions or answers that name no person\'s message of the ticket', () => {
    // 拒绝带结果/答案的提问，以及指向不属于本工单人消息的提问或回答。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { human: false, threads: [{ source: 'chat', id: 't1' }] }))
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const report = (extra: object) => () => h.engine.report(ticketId, { state: 'progress', summary: 'x', ...extra })
    expect(report({ state: 'ready', question: 'Q?' })).toThrow(new UserError('questionWithResult'))
    expect(report({ question: 'Q?', answers: '1' })).toThrow(new UserError('questionWithResult'))
    expect(report({ askedBy: '1' })).toThrow(new UserError('askerWithoutQuestion'))
    expect(report({ question: 'Q?', askedBy: '2' })).toThrow(new UserError('notAsker'))
    expect(report({ answers: '4' })).toThrow(new UserError('notAnswerable'))
    expect(report({ answers: '1' })()).toMatchObject({ answers: ['1'] })
  })
  it('refuses a report on an ended ticket', () => {
    // 已结束的工单拒绝任何汇报。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'x' })).toThrow(new UserError('ticketEnded'))
  })
})
describe('outcomes', () => {
  // describe 所测：结局记录。
  it('records how a ticket ended', () => {
    // 记录工单如何结束（谁、结局、理由）。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId, 'Human asked to stop')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: 'Human asked to stop' })
    expect(ticketOutcome(h.repo.tickets.get(ticketId)!)).toBe('stopped')
    expect(ticketOutcome({})).toBeUndefined()
  })
})
describe('attach', () => {
  // describe 所测：附着消息到工单。
  it('sends the routing note for a message the worker has, ends an Eval that holds only that message, and refuses a ticket a person stopped or the Policy no longer holds', () => {
    // 附着带路由备注；只含该消息的评估被收束；人停止的工单与授权被吊销的工单拒绝附着。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.delivered.map(([, input]) => input)).toEqual([key('input', ticketId, 'trigger', '2')])
    // The follow-up reached the ticket without an Eval, and is its worker's to judge; sent to Eval again by a person, it is judged there.
    // 跟进不经评估直达工单，归 worker 判断；人把它送评估后再由评估判断。
    expect(h.engine.candidate('2')).toBeUndefined()
    expect(() => h.engine.attach(ticketId, '2')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.engine.reevaluate('2')).toBe(true); h.pump()
    expect(h.engine.candidate('2')).toBeDefined()
    const attached = h.engine.attach(ticketId, '2', 'The guest asks for the same fix'); h.settle()
    expect(attached.inputs).toEqual([expect.objectContaining({ triggerId: '2' }), expect.objectContaining({ triggerId: '2', note: 'The guest asks for the same fix' })])
    expect(h.delivered.map(([, input]) => input)).toEqual(attached.inputs.map(input => input.id))
    expect(h.engine.candidate('2')).toBeUndefined()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticketId } }] })
    // A note for a message that still waits for the worker goes out with it, as for one a person sent to Eval at once.
    // 还在等 worker 的消息带着备注一起出去——与刚被人送评估的消息一样。
    h.engine.receive(trigger('5', { actor: guest })); h.engine.reevaluate('5')
    expect(h.engine.attach(ticketId, '5', 'Same fix again').inputs.at(-1)).toMatchObject({ triggerId: '5', note: 'Same fix again' })
    h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    expect(() => h.engine.attach(ticketId, '2')).toThrow(new UserError('mandateRevoked'))
    h.setVersion('v1')
    const stopped = accepted(h, '3', 't3').ticketId!
    h.engine.stopTicket(stopped)
    expect(() => h.engine.attach(stopped, '2')).toThrow(new UserError('ticketStopped'))
    expect(() => h.engine.attach('missing', '2')).toThrow(new UserError('unknownTicket'))
  })
  it('ends the batch Eval of a message attached to a ticket and assesses the rest again, leaving the message to that ticket', () => {
    // 附着收束其所在的批次评估：该消息归工单，其余消息重新评估。
    const h = harness()
    const ticketId = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!
    const elsewhere = { threads: [{ source: 'chat', id: 'x' }] }
    h.engine.receive(trigger('2', elsewhere)); h.engine.receive(trigger('3', elsewhere)); h.pump()
    h.engine.attach(ticketId, '3'); h.pump()
    expect(h.repo.decisions.byThread('chat:x')).toEqual([expect.objectContaining({ kind: 'unavailable', triggerIds: ['2', '3'],
      reason: [{ code: 'routed', triggerId: '3', values: { ticket: ticketId } }] })])
    expect(h.engine.candidate('2')?.triggers.map(item => item.id)).toEqual(['2'])
    expect(followupOwners(h.repo.triggers.get('3')!, h.repo)).toEqual([ticketId])
    expect(() => h.engine.attach(other, '3')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
    // 已附着给工单 3 的消息不能再附给别的工单。
  })
  it('names missing things apart from refusals and fills in the values', () => {
    // UserError 区分“缺失”（missing）与“拒绝”，并把值填进消息。
    expect([new UserError('unknownTicket').missing, new UserError('ticketEnded').missing]).toEqual([true, false])
    expect(new UserError('notAdmissible', { reason: 'not_a_member' })).toMatchObject({ code: 'notAdmissible', values: { reason: 'not_a_member' }, message: 'Trigger is not admissible: not_a_member' })
  })
})
describe('direct decisions', () => {
  // describe 所测：不经评估的直接决策。
  it('decides an explicit request no Eval holds in a direct Eval, refuses a proactive accept without matched rules, and accepts a Trigger once', () => {
    // 无评估持有的显式请求走直接决策；推断受理必须带规则；每个触发器只受理一次。
    const h = harness()
    h.engine.receive(trigger('1'))
    const decision = h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'routed' })
    expect(decision).toMatchObject({ kind: 'accept', triggerIds: ['1'], strength: 'explicit' })
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'routed' })).toEqual(decision)
    // A guest's follow-up reached that ticket without an Eval: its worker decides it, and only what the worker hands back can
    // become new work, under the gate's authority, inferred.
    // 访客的跟进不经评估到了该工单：归其 worker 决定；只有 worker 交回的才能成为新工作，且按门的推断授权。
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    const ticketId = decision.ticketId!
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['r1'] }))
      .toThrow(new UserError('workerDecides', { tickets: ticketId }))
    h.engine.handback(ticketId, '2', 'A different fix')
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'proactive' })).toThrow(new UserError('notExplicit'))
    expect(h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule',
      rules: ['r1'] })).toMatchObject({ kind: 'accept', strength: 'inferred' })
    expect(() => h.engine.decide('missing', { kind: 'ignore', reason: 'x' })).toThrow(new UserError('unknownTrigger'))
  })
  it('accepts an inferred candidate only on rules the Policy admits, whoever names them', () => {
    // 推断候选只在策略放行的规则上受理，无论谁点名。
    const h = harness({ admitsInferred: rules => rules.includes('enabled') })
    accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    const candidate = h.requests.at(-1)!
    expect(() => h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['disabled'] })).toThrow(new UserError('notExplicit'))
    expect(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['enabled'] })).toMatchObject({ kind: 'accept' })
  })
  it('ends the Eval of a replayed Trigger that started a ticket, and returns that ticket\'s Decision for it', () => {
    // 重放已开过工单的触发器：评估收束，直接返回当初工单的决策。
    const h = harness()
    const decision = accepted(h)
    h.tick(1)
    expect(h.engine.reevaluate('1')).toBe(true)
    h.pump()
    expect(h.engine.candidate('1')).toBeUndefined()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: ['1'],
      reason: [{ code: 'startedTicket', triggerId: '1', values: { ticket: decision.ticketId } }] })
    expect(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' })).toEqual(decision)
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(() => h.engine.reevaluate('missing')).toThrow(new UserError('unknownTrigger'))
  })
  it('keeps a replayed Trigger that started a ticket out of the Eval of the Triggers queued with it', () => {
    // 重放的开过工单的触发器不借权威给同批排队的触发器。
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.engine.reevaluate('1'); h.pump()
    // The member's replayed request lends the guest's message no authority.
    // 成员的重放请求不给访客的消息借权威。
    expect(h.engine.candidate('1')).toBeUndefined()
    expect(h.engine.candidate('2')).toMatchObject({ strength: 'inferred', triggers: [{ id: '2' }] })
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed' })).toThrow(new UserError('notExplicit'))
    expect(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' })).toEqual(decision)
    expect(h.repo.tickets.list()).toHaveLength(1)
  })
  it('starts a ticket from a request accepted beside a replayed one, with its own origin and acknowledgement', () => {
    // 与重放请求并列受理的请求开出自己的工单（自己的来源与回执）。
    const h = harness()
    const first = accepted(h)
    h.tick(1); h.engine.receive(trigger('2')); h.engine.reevaluate('2'); h.engine.reevaluate('1'); h.pump()
    const second = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed', acknowledgement: 'On it' })
    expect(second.ticketId).not.toBe(first.ticketId)
    expect(h.repo.tickets.get(second.ticketId!)!.origin).toEqual({ triggerId: '2', triggerIds: ['2'] })
    expect(h.outbox.find(message => message.id === key('ack', '2'))).toMatchObject({ text: 'On it', kind: 'acknowledgement' })
    // The replayed request still answers with the ticket it started.
    // 重放的请求仍以其开出的工单作答。
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'again' })).toEqual(first)
  })

})
describe('automatic input', () => {
  // describe 所测：自动输入的扣留与放行。
  it('holds back automatic Input from a worker that reported blocked or failed until a person\'s message arrives', () => {
    // 报了 blocked/failed 的 worker：自动输入扣留在工单上，直到人的消息到达。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const bot = (id: string) => trigger(id, { human: false })
    h.engine.receive(bot('2'))
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    // Both pending and subsequent automated inputs stay queued on the ticket without waking the worker.
    // 待投与后续的自动输入都留在工单上排队，不唤醒 worker。
    h.engine.receive(bot('3')); h.settle()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], inputs: [expect.objectContaining({ triggerId: '2' }), expect.objectContaining({ triggerId: '3' })] })
    expect(h.delivered).toEqual([])
    h.tick(1)
    h.engine.receive(trigger('4', { actor: guest })); h.engine.receive(bot('5')); h.settle()
    expect(h.delivered.map(([, input]) => input)).toEqual([key('input', ticketId, 'trigger', '4'), key('input', ticketId, 'trigger', '5')])
    // 人的消息先投，紧随其后是积压的自动输入。
  })
  it('stops waiting for a person on a person\'s message, a later report that is neither blocked nor failed, or a retry', () => {
    // 三种方式解除“等人”：人的消息到达、之后有非阻塞/失败的汇报、或重试。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    expect(waitsForPerson(ticket())).toBe(true)
    expect(ticketStage(ticket())).toEqual({ stage: 'person', action: 'blocked' })
    // The worker has the person's reply, so the stale blocked report no longer holds the ticket.
    // worker 拿到了人的回答：过期的 blocked 汇报不再扣住工单。
    h.tick(1); h.engine.receive(trigger('2', { actor: guest })); h.settle()
    expect(waitsForPerson(ticket())).toBe(false)
    expect(ticketStage(ticket())).toEqual({ stage: 'working' })
    h.tick(1); h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    expect(waitsForPerson(ticket())).toBe(true)
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'found a way' })
    expect(waitsForPerson(ticket())).toBe(false)
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' })
    h.engine.retryTicket(ticketId)
    expect(waitsForPerson(ticket())).toBe(false)
  })
  it('launches a failed launch again for a person\'s message, but not for a Policy change', () => {
    // 人的消息重启失败启动；策略变更不会。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const ticketId = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' }).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'The prepare command failed' })
    vi.mocked(h.executor.start).mockClear()
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2')
    expect(h.executor.start).not.toHaveBeenCalled()
    h.tick(1); h.engine.receive(trigger('2', { actor: guest }))
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: ticketId }), expect.objectContaining({ state: 'pending' }))
  })
})
describe('replies', () => {
  // describe 所测：回复（回执/答案/结果/注意）。
  it('acknowledges a person\'s message that reached an open ticket once, and refuses others', () => {
    // 到过活工单的人消息确认一次；其余拒绝。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // The acknowledgement of the accept stays; a later request for one reuses it.
    // 受理的回执已存在：再次请求确认复用它。
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '1', text: 'On it' })).toEqual({ id: key('ack', '1'), status: 'pending', reused: true })
    expect(h.outbox.map(message => message.text)).toEqual(['ok'])
    h.engine.receive(trigger('2', { actor: guest }))
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'Looking' })).toEqual({ id: key('ack', '2'), status: 'pending', reused: false })
    h.engine.receive(trigger('3', { human: false }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '3', text: 'x' })).toThrow(new UserError('ackNotPerson'))
    h.engine.receive(trigger('6', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '6', text: 'x' })).toThrow(new UserError('notReached'))
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'x' })).toThrow(new UserError('ackEnded'))
  })
  it('sends an answer only after the worker reported it, a result only for a ready ticket, and attention only for its current question', () => {
    // 答案只在 worker 汇报后发；结果只给 ready 的工单；注意只针对当前问题。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = trigger('2', { actor: guest, channel: { source: 'chat', thread: 't1', address: { message: '2' } } })
    h.engine.receive(asked)
    expect(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' })).toThrow(new UserError('noAnswer'))
    h.engine.report(ticketId, { state: 'progress', summary: 'Yes', answers: '2' })
    expect(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' })).toMatchObject({ status: 'pending', reused: false })
    expect(h.outbox.at(-1)).toMatchObject({ channel: asked.channel, text: 'Yes', kind: 'reply' })
    expect(h.repo.tickets.get(ticketId)!.answers).toEqual([])
    // 回答的渠道是提问者的消息所在处；工单不留 answers 记录。
    expect(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toThrow(new UserError('notReady'))
    h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Which color?', askedBy: '2' })
    expect(() => h.engine.reply({ purpose: 'attention', ticketId, question: 'Which size?', text: 'x' })).toThrow(new UserError('notAttention'))
    // Without an open question there is nothing to ask, whether or not a question is named.
    // 没有打开的问题就没什么可问：无论是否指名问题。
    const quiet = accepted(h, '9', 't9').ticketId!
    expect(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, text: 'Anything to send.' })).toThrow(new UserError('notAttention'))
    expect(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, question: '', text: 'Anything to send.' })).toThrow(new UserError('notAttention'))
    const attention = h.repo.tickets.get(ticketId)!.attention!
    expect(h.engine.reply({ purpose: 'attention', ticketId, question: 'Which color?', text: 'Which color?' }).id).toBe(key('attention-reply', attention.id))
    // A question goes where the message that raised it was written.
    // 问题回到提出它的消息所在处。
    expect(h.outbox.at(-1)!.channel).toEqual(asked.channel)
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ status: 'pending' })
    expect(h.outbox.at(-1)!.channel).toEqual(trigger('1').channel)
    // 结果回到原工单来源。
  })
})
describe('ticket commands', () => {
  // describe 所测：工单命令（跟随、重试、催办）。
  it('ends a ticket by the same rule on a close and on a ready report: once no PR it opened is open, as the latest of them ended', () => {
    // 关闭与 ready 汇报用同一规则结束工单：其打开的 PR 都不再打开时，按其中最新的结局。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // It started from someone's PR and opened its own.
    // 它从别人的 PR 起家，又开了自己的。
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-5' }, false)
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true)
    h.engine.threadClosed({ source: 'gh', id: 'pr-7' }, 'merged', '2026-09-23T00:00:00Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // A person's comment resumes it; its ready report ends it again as its own PR did, though the one it started from is open.
    // 人的评论恢复它；ready 汇报再次按其自己 PR 的结局结束——虽然起家的 PR 还开着。
    h.tick(10); h.engine.receive(trigger('2', { threads: [{ source: 'gh', id: 'pr-5' }] })); h.settle()
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
    h.engine.report(ticketId, { state: 'ready', summary: 'Answered' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // The PR it started from closing later changes nothing.
    // 起家的 PR 之后再关闭也不改变结局。
    h.engine.threadClosed({ source: 'gh', id: 'pr-5' }, 'closed', '2026-09-23T00:00:30Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // A ticket that opened no PR ends when the one it follows closes, as it did.
    // 没开自己 PR 的工单：跟随的 PR 关闭时按其结局结束。
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.bindThread(other, { source: 'gh', id: 'pr-8' }, false)
    h.engine.report(other, { state: 'ready', summary: 'Pushed to their branch' })
    expect(h.repo.tickets.get(other)).not.toHaveProperty('ended')
    h.engine.threadClosed({ source: 'gh', id: 'pr-8' }, 'closed', '2026-09-23T00:01:00Z')
    expect(h.repo.tickets.get(other)!.ended).toMatchObject({ outcome: 'closed' })
  })
  it('stops following a Thread whose Subscription a person removes', () => {
    // 人退订线程：工单不再跟随；ready 汇报即可完成。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true)
    expect(h.engine.unsubscribe('gh:pr-7')).toBe(true)
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('follows')
    // Its ready report completes it, since it follows no Thread now.
    // 现在不跟随任何线程：ready 汇报即完成工单。
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'completed' })
  })
  it('follows a Source\'s Threads, and ends once no Thread of its own is open, unless resumed work has not finished', () => {
    // 跟随来源线程；自己的线程都关闭后结束——除非恢复的工作还没完成。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const close = (id: string, outcome: 'merged' | 'closed', at: string) => {
      const open = h.repo.tickets.open().map(ticket => ticket.id)
      h.engine.threadClosed({ source: 'gh', id }, outcome, at)
      return open.filter(item => h.repo.tickets.get(item)!.ended)
    }
    expect(h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)).toMatchObject({ follows: [{ thread: 'gh:pr-9', own: false }] })
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
    expect(h.repo.threads.get('gh:pr-9')!.subscriptions).toEqual([ticketId])
    // The Thread it started from closes while its own is open: it records the close and works on.
    // 起家的线程关闭而自己的还开着：记录关闭并继续干活。
    expect(close('pr-9', 'closed', '2026-09-23T00:00:00Z')).toEqual([])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ follows: [{ thread: 'gh:pr-9', closed: { outcome: 'closed' } }, { thread: 'gh:pr-10' }] })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
    // Its own closes too: it ends as that one did, when it did, once.
    // 自己的也关闭：按其结局与时间结束，且只结束一次。
    expect(close('pr-10', 'merged', '2026-09-23T00:00:01Z')).toEqual([ticketId])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-23T00:00:01.000Z' } })
    expect(close('pr-10', 'merged', '2026-09-23T00:00:01Z')).toEqual([])
    expect(() => h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-11' }, true)).toThrow(new UserError('ticketEnded'))
    // A ticket retried after its PR closed but before the close was reported works on until it reports ready.
    // PR 已关闭但关闭还没上报就重试的工单：继续干活直到 ready 汇报。
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(other, { source: 'gh', id: 'pr-12' }, true)
    h.engine.report(other, { state: 'failed', summary: 'tests fail' })
    h.tick(10); h.engine.retryTicket(other)
    expect(close('pr-12', 'closed', '2026-09-23T00:00:05Z')).toEqual([])
    expect(h.repo.tickets.get(other)!.ended).toBeUndefined()
    h.engine.report(other, { state: 'ready', summary: 'done' })
    expect(h.repo.tickets.get(other)).toMatchObject({ ended: { outcome: 'closed' } })
  })

  it('retries a ticket that reported failed with a new Assignment, and asks only a waiting worker for its status', () => {
    // 失败的工单重试开新派工；催办只发给等待中的 worker。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError('notRetryable'))
    expect(h.engine.requestStatus(ticketId)).toBe(false)
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([])
    h.engine.report(ticketId, { state: 'waiting', summary: 'idle' })
    expect(h.engine.requestStatus(ticketId)).toBe(true)
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('status-only') })])
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    const retried = h.engine.retryTicket(ticketId)
    expect(retried.assignments).toEqual([expect.objectContaining({ state: 'ended', endedReason: 'retried' }), expect.objectContaining({ state: 'pending' })])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    expect(h.executor.start).toHaveBeenLastCalledWith(expect.objectContaining({ id: ticketId }), retried.assignments[1])
  })
})
describe('failed deliveries', () => {
  // describe 所测：失败的投递。
  it('forgets a failed delivery once a new Assignment takes over or the ticket ends', () => {
    // 新派工接手或工单结束：失败投递的记录被清除。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const failed = () => {
      h.engine.deliveryFailed(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id, 'Session busy')
      expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: 'Session busy' })
    }
    failed()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' })
    h.engine.retryTicket(ticketId); h.settle()
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    failed()
    h.engine.stopTicket(ticketId)
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
  })
})
describe('problems', () => {
  // describe 所测：问题解除。
  it('dismisses the problem an unavailable Decision shows, and only such a Decision', () => {
    // 只能解除 unavailable 决策显示的问题；其他决策报 unknownProblem。
    const h = harness()
    const decision = accepted(h)
    expect(() => h.engine.dismiss(decision.id)).toThrow(new UserError('unknownProblem'))
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] })); h.pump()
    const unavailable = h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' })
    expect(h.engine.dismiss(unavailable.id)).toMatchObject({ kind: 'unavailable', dismissed: true })
    expect(h.repo.decisions.get(unavailable.id)).toMatchObject({ dismissed: true })
  })
})
describe('retry after a failed delivery', () => {
  // describe 所测：投递失败后的重试。
  it('starts a new Assignment for a ticket whose Input keeps failing to reach its worker, which takes the Input', () => {
    // 输入一直送不到 worker 的工单：重试开新派工并保留待投输入。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'tests fail' })
    // A person's answer goes to the failed worker, and delivering it fails.
    // 人的回答要送给失败的 worker，投递失败。
    h.tick(5); h.engine.receive(trigger('2'))
    const answered = h.repo.tickets.get(ticketId)!
    expect(answered.undelivered).toHaveLength(1)
    h.engine.deliveryFailed(ticketId, runningAssignment(answered)!.id, 'Session gone')
    expect(ticketStage(h.repo.tickets.get(ticketId)!)).toEqual({ stage: 'person', action: 'delivery' })
    const retried = h.engine.retryTicket(ticketId)
    expect(retried.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
    expect(retried).not.toHaveProperty('delivery')
    expect(retried.undelivered).toHaveLength(1)
  })
})
describe('Evals across Policy versions, revoked Mandates and mixed batches', () => {
  // describe 所测：跨策略版本的评估、吊销授权与混合批次。
  it('queues an Eval\'s batch again when it is decided under an older Policy, such as after an upgrade changed the version', () => {
    // 用旧策略决策：记 unavailable 并重排该批触发器。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const candidate = h.requests.at(-1)!
    // An upgrade changes the version without a Policy change being reported.
    // 升级改了版本但没有上报策略变更。
    h.setVersion('v2')
    expect(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r' })).toMatchObject({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: ['1'] })
    h.pump()
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: 'v2', triggers: [expect.objectContaining({ id: '1' })] })
  })
  it('queues a person\'s message for Eval when the only ticket it reached cannot resume under the Policy now, and says it reached none', () => {
    // 到达的工单在当前策略下无法恢复：消息排队评估，候选卡说明没有工单到达。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle()
    h.setVersion('revoked')
    h.tick(5); h.engine.receive(trigger('2'))
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
    expect(followupOwners(trigger('2'), h.repo)).toEqual([])
  })
  it('queues a person\'s message that waited out a pause for Eval when the ticket it reached cannot resume once the pause lifts', () => {
    // 暂停期间等待的消息：暂停解除后其工单无法恢复时送评估。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle()
    h.setPaused(true)
    h.tick(5); h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1)
    h.setVersion('revoked'); h.setPaused(false); h.engine.evaluateDue()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() })
    expect(h.repo.threads.get('chat:t1')!.pending.includes('2') || h.engine.candidate('2') !== undefined).toBe(true)
  })
  it('takes a new ticket\'s origin and acknowledgement from the admissible Trigger that gave its batch its strength', () => {
    // 新工单的来源与回执取自给批次强度的那个可受理触发器。
    const h = harness()
    h.engine.receive(trigger('1'))
    h.tick(1); h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci-bot' }, channel: { source: 'chat', thread: 'chat:t1', address: { message: 'bot' } } }))
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['1', '2'])
    const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r', acknowledgement: 'ok' })
    expect(h.repo.tickets.get(decision.ticketId!)!.origin).toEqual({ triggerId: '1', triggerIds: ['1', '2'] })
    expect(h.outbox).toEqual([expect.objectContaining({ id: key('ack', '1'), channel: trigger('1').channel })])
  })
})
describe('gaps', () => {
  // describe 所测：旧版本遗留行为的兼容间隙。
  it('takes a mixed batch\'s strength, actor and basis from its strongest admissible Trigger, the latest of equal strength', () => {
    // 混合批次的强度/发起者/依据取自最强的可受理触发器；同强取最新。
    // A guest's message is admitted as inferred, as on a Thread a ticket follows.
    // 访客消息按推断受理（如同工单跟随的线程上）。
    const gate: Policy['gate'] = t => t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
    for (const order of [['guest', 'alice'], ['alice', 'guest']]) {
      const h = harness({ gate })
      order.forEach((who, index) => { h.tick(1); h.engine.receive(trigger(String(10 + index), { actor: who === 'alice' ? member : guest })) })
      h.pump()
      const alice = String(10 + order.indexOf('alice'))
      expect(h.repo.threads.get('chat:t1')!.evaluating).toMatchObject({ strength: 'explicit', actor: member, basis: { via: 'listed' }, primary: alice })
    }
    const named = harness({ gate: t => ({ admissible: true, strength: 'explicit', basis: { via: 'listed', sender: t.actor.id } }) })
    named.engine.receive(trigger('1', { actor: { source: 'chat', id: 'bob' } }))
    named.tick(1); named.engine.receive(trigger('2', { actor: { source: 'chat', id: 'carol' } }))
    named.pump()
    expect(named.repo.threads.get('chat:t1')!.evaluating).toMatchObject({ actor: { id: 'carol' }, basis: { sender: 'carol' }, primary: '2' })
    // 同强取最新：carol（'2'）胜出。
  })
  it('changes nothing and delivers nothing on a late start of an Assignment a retry replaced', () => {
    // 被重试顶替的派工迟到启动：不改变任何状态、不投递。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const first = h.repo.tickets.get(ticketId)!.assignments[0]!.id
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    h.engine.retryTicket(ticketId)
    const before = h.repo.tickets.get(ticketId)!
    const delivered = h.delivered.length
    h.engine.assignmentStarted(ticketId, first); h.settle({ launch: false })
    expect(h.repo.tickets.get(ticketId)!.assignments).toEqual(before.assignments)
    expect(h.delivered).toHaveLength(delivered)
  })
  it('records a stop that names an unknown or ended ticket as ignored', () => {
    // 指向未知或已结束工单的停止记为 ignore（stopUnknown）。
    const h = harness()
    const ended = accepted(h).ticketId!
    h.engine.report(ended, { state: 'ready', summary: 'Done' })
    for (const [id, ticketId] of [['2', 'missing'], ['3', ended]] as const) {
      h.tick(1); h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: `t${id}` }] })); h.pump()
      expect(h.decide(h.requests.at(-1)!, { kind: 'stop', ticketId, reason: 'stop it' })).toMatchObject({ kind: 'ignore', reason: [{ code: 'stopUnknown' }] })
    }
    expect(h.repo.tickets.get(ended)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  })
  it('refuses a direct decision on a Trigger the gate does not admit, and leaves the queue as it was', () => {
    // 门不受理的触发器直接决策被拒：队列原样。
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    const pending = h.repo.threads.get('chat:t1')!.pending
    expect(() => h.engine.decide('1', { kind: 'ignore', reason: 'noise' })).toThrow(new UserError('notAdmissible', { reason: 'not human' }))
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(pending)
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
  it('refuses to retry a ticket a person stopped after its failed report', () => {
    // 人停止的工单不可重试。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError('notRetryable'))
  })
  it('answers a question once, sends a result only for finished work, and the same result once', () => {
    // 问题只答一次；结果只给已完成的工作；同一结果只发一次。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.report(ticketId, { state: 'progress', summary: 'It reads the config.', answers: '2' })
    expect(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'It reads the config.' })).toMatchObject({ reused: false })
    expect(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Something else.' })).toThrow(new UserError('noAnswer'))
    expect(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toThrow(new UserError('notReady'))
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    const sent = h.outbox.length
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ reused: false })
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ reused: true })
    expect(h.outbox).toHaveLength(sent + 1)
    // A ticket whose PR closed unmerged, or that a person stopped, has no result to send.
    // PR 未合并而关闭的工单、或被人停止的工单：没有结果可发。
    const closed = accepted(h, '5', 't5').ticketId!
    h.engine.bindThread(closed, { source: 'gh', id: 'pr-1' }, true)
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'closed', '2026-09-23T00:01:00Z')
    expect(() => h.engine.reply({ purpose: 'result', ticketId: closed, text: 'x' })).toThrow(new UserError('notReady'))
    const stopped = accepted(h, '6', 't6').ticketId!
    h.engine.stopTicket(stopped)
    expect(() => h.engine.reply({ purpose: 'result', ticketId: stopped, text: 'x' })).toThrow(new UserError('notReady'))
  })
  it('keeps an Eval\'s deadline on a repeated delivery, refuses to queue a held Trigger again, and puts expired Triggers first', () => {
    // 重复投递不刷新评估期限；持有中的触发器拒绝重排；超时的触发器排在新来的前面。
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const evalId = h.requests[0]!.evalId
    h.engine.candidateDelivered(evalId)
    const deadline = h.repo.threads.get('chat:t1')!.evaluating!.deadline
    h.tick(30); h.engine.candidateDelivered(evalId)
    expect(h.repo.threads.get('chat:t1')!.evaluating!.deadline).toBe(deadline)
    expect(h.engine.reevaluate('1')).toBe(false)
    // A Trigger that arrives meanwhile queues behind the expired one, and the fresh Eval takes both in that order.
    // 期间到达的触发器排在超时者之后：新评估按此顺序一起取。
    h.tick(1); h.engine.receive(trigger('2', { actor: guest }))
    h.tick(30); h.engine.evaluateDue()
    expect(h.repo.threads.get('chat:t1')!.evaluating!.triggerIds).toEqual(['1', '2'])
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
})
describe('final review', () => {
  // describe 所测：最终评审（旧版本兼容）。
  it('ignores an Eval an earlier version left holding only a Trigger that started a ticket, instead of recording it unavailable', () => {
    // 旧版本遗留的“只含已开工单触发器”的评估记 ignore（startedTicket），不记 unavailable。
    const h = harness()
    const decision = accepted(h)
    // An earlier version could leave an Eval holding the Trigger after it started a ticket.
    // 旧版本可能在触发器开工单后仍让评估持有它。
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'old-eval', threadKey: 'chat:t1', triggerIds: ['1'], primary: '1', strength: 'explicit', actor: member,
      basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '', deadline: '2999-01-01T00:00:00.000Z' } })
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'replayed' })).toEqual(decision)
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'startedTicket', triggerId: '1',
      values: { ticket: decision.ticketId } }] })
    expect(h.repo.decisions.byThread('chat:t1').some(item => item.kind === 'unavailable')).toBe(false)
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
  })
  it('clears the count of expired Evals when the gate ignores what a Thread queued', () => {
    // 门忽略线程排队的触发器时清零过期评估计数。
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    h.repo.threads.save({ ...h.repo.threads.get('chat:t1')!, expired: 1 })
    h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'ignore' })])
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('expired')
  })
})
describe('final review: Policy transitions', () => {
  // describe 所测：策略变更通知。
  it('tells a worker of each Policy change that bears on its ticket, also of one that repeats an earlier transition', () => {
    // 每次影响工单的策略变更都告知 worker，包括重复先前的转变。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const effect = { requesterAllowed: false as const }
    for (const [from, to] of [['A', 'B'], ['B', 'A'], ['A', 'B']]) { h.tick(1); h.engine.policyChanged(from!, to!, new Map([[ticketId, effect]])) }
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'policy-changed')).toHaveLength(3)
  })
})
describe('final review: Threads followed for context', () => {
  // describe 所测：仅上下文线程的边界。
  it('lets a worker acknowledge or ask no one on a Thread it follows only for context', () => {
    // worker 在仅上下文的线程上不确认、不提问。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'side' })
    h.tick(1); h.engine.receive(trigger('5', { threads: [{ source: 'chat', id: 'side' }], channel: { source: 'chat', thread: 'side', address: { message: '5' } } }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '5', text: 'On it' })).toThrow(new UserError('notReached'))
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'A question', question: 'Which page?', askedBy: '5' })).toThrow(new UserError('notAsker'))
  })
})
describe('final review: close times', () => {
  // describe 所测：关闭时间。
  it('records a Source\'s close time in the canonical form, and keeps the ticket\'s updatedAt moving forward', () => {
    // 来源给的关闭时间规范化为毫秒；工单的 updatedAt 不回退。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-1' }, true)
    h.tick(30)
    const before = h.repo.tickets.get(ticketId)!.updatedAt
    // GitHub gives whole seconds, and the PR merged before the ticket's last change.
    // GitHub 给整秒，且 PR 在工单最后一次变更之前就已合并。
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'merged', '2026-09-23T00:00:05Z')
    const ended = h.repo.tickets.get(ticketId)!
    expect(ended.ended).toMatchObject({ at: '2026-09-23T00:00:05.000Z', outcome: 'merged' })
    expect(ended.follows).toEqual([{ thread: 'gh:pr-1', own: true, closed: { at: '2026-09-23T00:00:05.000Z', outcome: 'merged' } }])
    expect(ended.updatedAt >= before).toBe(true)
  })
})
describe('model-surface review', () => {
  // describe 所测：模型可见层面的边界。
  it('resumes an ended ticket only on a person\'s message, not on a bot\'s that is attached to it', () => {
    // 只有人的消息恢复已结束工单；附着上去的机器人消息不行。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    h.tick(1); h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci' }, threads: [{ source: 'chat', id: 'ci' }] }))
    h.engine.attach(ticketId, '2')
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    // A person's message resumes it, with what waited.
    // 人的消息恢复它（带着等待的东西）。
    h.tick(1); h.engine.receive(trigger('3'))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
})
describe('follow-up review: turn ends', () => {
  // describe 所测：回合结束与合并的竞态。
  const merge = (h: ReturnType<typeof harness>) => h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
  it('lets a merge send to Eval only the messages its worker had no turn to read after its ready report', () => {
    // 合并只把“ready 汇报之后 worker 没有回合去读的消息”送评估。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    // A person thanks the worker, which reads it in a turn and leaves it; another message comes after that turn.
    // 人感谢 worker，worker 在一个回合里读完并放下；另一条消息在该回合之后到达。
    h.tick(1); h.engine.receive(trigger('2')); h.settle(); h.read(ticketId)
    h.tick(1); h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id)
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    merge(h)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('keeps a ticket open at a merge while its worker works on a message it took up, also after a progress report', () => {
    // worker 正处理接手的消息时合并不结束工单——进度汇报之后也一样。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    // It answers another question in a progress report while it works on the message.
    // 它在处理该消息期间用进度汇报回答了另一个问题。
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Answered the other question' })
    merge(h)
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('ends a ticket whose close it deferred as the close did when its worker then drops the work', () => {
    // 推迟了的关闭：worker 之后放弃工作时按关闭的结局结束工单。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    merge(h)
    h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing more to do' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
  })
  it('sends a message another ticket handed back to Eval when a stop on it ends the ticket that kept it', () => {
    // 别的工单交回的消息：当持有它的工单被停止结束时送评估。
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.receive(trigger('3')); h.settle()
    expect(h.engine.handback(second, '3', 'It is about the first fix')).toBe(false)
    h.engine.decide('3', { kind: 'stop', ticketId: first, reason: 'asked to stop' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('gives a live ticket\'s worker again a message it had that a person sent to Eval and the main Session attached back', () => {
    // worker 已有的消息被人送评估、又被主 Session 附着回来：再次交给 worker。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.engine.reevaluate('2'); h.pump()
    h.engine.attach(ticketId, '2')
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2')).toHaveLength(2)
  })
})
describe('follow-up review: turn ends and deliveries', () => {
  // describe 所测：回合结束与投递交叠的竞态。
  it('lets a stop send to Eval a message that waited for delivery when a turn ended, and reached the worker after', () => {
    // 回合结束后消息才送达 worker、人在该回合中停止工单：消息送评估。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.tick(1); h.engine.receive(trigger('2'))
    const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id
    const [inputId] = ticket().undelivered
    // The turn ends while the message is on its way; it reaches the worker after, and a person stops the ticket in that turn.
    // 消息在路上时回合结束；随后消息到达 worker，人在该回合里停止工单。
    h.tick(1); h.engine.turnEnded(ticketId, assignmentId)
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [inputId!])
    h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
})
describe('follow-up review: delivery times', () => {
  // describe 所测：投递时序的竞态。
  it('lets a stop send to Eval a message that came before the worker\'s waiting report but reached the worker after it', () => {
    // 消息早于 waiting 汇报到达库、却晚于汇报送达 worker：停止工单后送评估。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2'))
    const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id
    const [inputId] = ticket().undelivered
    // The Executor reports the worker waiting while the message is on its way; it reaches the worker after, and a person stops.
    // 消息在路上时执行器已把 worker 报成等待；之后消息才到达，人停止工单。
    h.tick(1); h.engine.report(ticketId, { state: 'waiting', summary: 'Waiting for input' })
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [inputId!])
    h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
})
describe('routing review', () => {
  // describe 所测：一条跟进多个工单的路由。
  it('records two stops of one follow-up that reached two tickets, made in the same moment, as two Decisions', () => {
    // 一条到过两个工单的跟进：同一时刻的两个停止记为两条决策。
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.receive(trigger('3')); h.settle()
    const stops = [first, second].map(ticketId => h.engine.decide('3', { kind: 'stop', ticketId, reason: 'asked to stop' }))
    expect(new Set(stops.map(stop => stop.id)).size).toBe(2)
    expect(stops.map(stop => h.repo.decisions.get(stop.id)?.ticketId)).toEqual([first, second])
    expect([first, second].map(id => h.repo.tickets.get(id)!.ended?.outcome)).toEqual(['stopped', 'stopped'])
  })
})

describe('what a worker read', () => {
  // describe 所测：worker 读到什么才算已读（消息从不进入候选）。
  /** A ticket that ended, resumed by a person's message `2`, whose new Assignment started; its Inputs wait for delivery. */
  // 已结束、被人消息 '2' 恢复且新派工已启动的工单；其输入等待投递。
  function resumed() {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.tick(1); h.engine.receive(trigger('2'))
    const assignmentId = h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id
    h.tick(1); h.engine.assignmentStarted(ticketId, assignmentId)
    const [note, message] = h.repo.tickets.get(ticketId)!.undelivered as [string, string]
    return { h, ticketId, assignmentId, note, message, pending: () => h.repo.threads.get('chat:t1')!.pending }
  }
  it('sends to Eval a message that woke a ticket and reached its worker only after a progress report, at a dropped report', () => {
    // 唤醒了工单、又在进度汇报之后才到达 worker 的消息：dropped 汇报时送评估（没被读到）。
    const { h, ticketId, assignmentId, note, message, pending } = resumed()
    // Delivering the message fails at first; the worker reports progress, and the retry hands the message over while it
    // writes that nothing is left.
    // 消息先投递失败；worker 报进度，重试在它写下“无事可做”的同时把消息交过去。
    h.engine.inputsDelivered(ticketId, assignmentId, [note])
    h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy')
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Looking' })
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [message])
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
    expect(pending()).toEqual(['2'])
  })
  it('counts a message that woke a ticket as read by a later dropped report once its worker\'s Session took it into a step', () => {
    // worker 的 Session 把消息取进步骤后：之后的 dropped 汇报算读过它。
    const { h, ticketId, assignmentId, note, message, pending } = resumed()
    // The Session takes it into the step its arrival starts, before the Executor records the delivery.
    // Session 在其到达启动的步骤里取走它——早于执行器记录投递。
    h.engine.inputsRead(ticketId, [message])
    h.engine.inputsDelivered(ticketId, assignmentId, [note, message])
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Looking' })
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
    expect(pending()).toEqual([])
  })
  it('sends to Eval at a merge a message that reached the worker after its last step, which no step took before its turn ended', () => {
    // 合并时送评估：最后一个步骤之后到达、回合结束前没有步骤取走的消息。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id)
    h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
  it('counts a message a retry delivered after a failure and a turn end as read by a dropped report only once a step took it', () => {
    // 失败与回合结束之后重试送达的消息：只有步骤取走了才被 dropped 汇报算作已读。
    for (const taken of [false, true]) {
      const { h, ticketId, assignmentId, note, message, pending } = resumed()
      h.engine.inputsDelivered(ticketId, assignmentId, [note])
      h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy')
      h.tick(1); h.engine.turnEnded(ticketId, assignmentId)
      h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [message])
      if (taken) h.read(ticketId)
      h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
      expect(pending()).toEqual(taken ? [] : ['2'])
    }
  })
  it('counts a message a step took before a restart cut its turn off as read only once the restarted worker reports', () => {
    // 重启切断回合前步骤已取走的消息：只有重启后的 worker 汇报了才算已读。
    for (const reported of [false, true]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'working' })
      h.tick(1); h.engine.receive(trigger('2')); h.settle(); h.read(ticketId)
      // The Assignment starts again with a recovery note, in the same Session, which holds the message.
      // 派工带着恢复备注在同一 Session 里重启；消息还在其中。
      h.tick(1); h.engine.assignmentInterrupted(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id); h.settle()
      if (reported) { h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Recovered' }) }
      h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(reported ? [] : ['2'])
    }
  })
})
describe('read claims review', () => {
  // describe 所测：读取认领（投递了但没读的输入的去向）。
  it('gives a retry\'s Assignment the messages the failed one had delivered but no step of its worker took', () => {
    // 失败派工已投递、worker 没取走的消息交给重试的新派工。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputId = ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === '2')!.id
    expect(ticket().undelivered).toEqual([])
    h.tick(1); h.engine.report(ticketId, { state: 'failed', summary: 'The turn broke.' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputId])
  })
})
describe('read claims review: retries', () => {
  // describe 所测：重试对“已投未读”输入的边界。
  it('gives a retry only what the Assignment it replaces had delivered and no step took, not what an earlier end let go of', () => {
    // 重试只拿“被顶替派工已投递、无步骤取走”的输入；不拿先前结束放开的。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id
    // A follow-up reaches the worker, and the ticket ends before any step took it, which sends it to Eval.
    // 跟进到了 worker；任何步骤取走之前工单结束——消息送评估。
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
    // A person's message resumes the ticket; its worker reports blocked before a step took the message, and a person retries.
    // 人的消息恢复工单；worker 在步骤取走消息前报 blocked，人重试。
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputOf('3')])
    // 只有 '3'（当前派工投了没读）回待投；'2' 已在评估队列。
  })
})
describe('read claims review: restarts', () => {
  // describe 所测：重启对“已投未读”输入的边界。
  it('gives a restart\'s Assignment what the replaced one had delivered and no step took, and a retry of it gets it again', () => {
    // 重启的新派工拿到“被顶替派工已投递、无步骤取走”的输入；再重试仍能拿到。
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    // The host restarts mid-work before a step took the message, which a cancel may have dropped: the new Assignment gets it.
    // 步骤取走消息前宿主重启（cancel 可能丢过它）：新派工拿到它。
    h.tick(1); h.engine.assignmentInterrupted(ticketId, runningAssignment(ticket())!.id)
    expect(ticket().undelivered[0]).toBe(inputOf('2'))
    h.settle()
    // That Assignment blocks before a step took it, and a person retries: the retry's Assignment gets it too.
    // 新派工在步骤取走前报 blocked，人重试：重试的派工也拿到它。
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputOf('2')])
  })
})
describe('ignores from the card', () => {
  // describe 所测：从候选卡无视（ignore）的标注。
  const said = (text: string) => ({ code: 'said', values: { text } })
  it('marks the ignore of an inferred candidate that no assessment judged, unlike an assessed one or an explicit candidate\'s', () => {
    // 未经评估判断的推断候选的 ignore 带 ignoredFromCard 标注；有评估的与显式候选的不带。
    const h = harness()
    accepted(h)
    // A guest's message sent to Eval is an inferred candidate, which the main Session ignores from its card.
    // 送评估的访客消息是推断候选，主 Session 从卡上无视它。
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'inferred' })
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'Plain chat.' }).reason).toEqual([{ code: 'ignoredFromCard' }, said('Plain chat.')])
    // An assessment's ignore keeps its rule judgments, without the mark.
    // 评估的 ignore 保留规则判定，不带标注。
    h.engine.receive(trigger('3', { actor: guest })); h.engine.reevaluate('3'); h.pump()
    expect(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'Plain chat.', audit: { rule_assessments: [] } }))
      .toMatchObject({ reason: [said('Plain chat.')], audit: { rule_assessments: [] } })
    // An explicit candidate is always routed from its card.
    // 显式候选总是从卡上路由。
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 't9' }] })); h.pump()
    expect(h.engine.decide('4', { kind: 'ignore', reason: 'Thanks.' }).reason).toEqual([said('Thanks.')])
    // Accepting an inferred candidate still takes an assessment's matched rules.
    // 受理推断候选仍需要评估的匹配规则。
    h.engine.receive(trigger('5', { actor: guest })); h.engine.reevaluate('5'); h.pump()
    expect(() => h.engine.decide('5', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'chat' })).toThrow(new UserError('notExplicit'))
  })
})
