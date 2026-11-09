/** Concurrent runtime behavior across overlapping triggers, deliveries, and worker launches. */
// 交叠的触发器、投递与 worker 启动下的并发运行时行为。
/**
 * 本测试文件覆盖 Runtime 的并发与竞态行为：
 * 线程上迟到的消息并入下一次评估、慢链接查询只挂自己的候选卡、
 * 人已停止的工单不再收到投递（包括正在等待 worker Session 的）、prepare 命令后台并行
 * 而受理/收集/轮转继续、被暂停打断的启动保持排队并在恢复后完成、
 * worker 槽位规则（机器人输入等空闲槽、人的消息用限额外的保留槽、进行中的启动占槽）、
 * worker Session 创建失败的落库、瞬态 provider 失败的退避重试与第四次即失败、
 * 后台作业/子代理让 worker 保持忙碌并占槽、停止工单时杀作业/释放子代理、
 * 移交（blocked/failed/ready/提问）释放槽位且留给人的作业不杀、
 * 闲时 30 分钟杀后台作业并报告 waiting、宿主停止时先停 worker、
 * worker 读到的消息的“已读”判定（步骤取走才算、切断不算、重启恢复）、
 * 以及 Executor 部件的纯函数行为（WorkerSlots 槽位、派工文案、Input 渲染、汇报转投）。
 * 测试策略：内存 DSH 宿主 + deferred 闸门/假定时器制造交叠，直接驱动 Runtime 断言竞态结果。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// vitest 断言与用例；vi 的假定时器与 mock。
import { latestAssignment, waitsForPerson, type Ticket, type Trigger } from '../src/core/index.ts'
// core：最新派工取值、是否等人的判定与领域类型。
import { Later } from '../src/app/effects.ts'
// Later：效果重试的信号（槽位不足时抛出）。
import { reportRelay } from '../src/app/notices.ts'
// reportRelay：worker 汇报转投主 Session 的消息构造。
import { WorkerSlots, inputMessage, mandateInstructions, ticketExecution, transient, triggerMessage } from '../src/executor/dsh.ts'
// 被测模块：槽位表、Input 渲染、授权说明、派工构造、瞬态错误判定、触发器消息卡。
import { SettingsSchema } from '../src/policy.ts'
// SettingsSchema：设置解析（工单执行文案用例）。
import { Commands } from '../src/infra/commands.ts'
// Commands：被 mock 的远端命令（链接查询挂起）。
import { deferred, waitUntil } from './fixtures/async.ts'
// deferred：手工闸门；waitUntil：轮询等待条件成立。
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'
// 宿主 fixture：feishu 构造触发器，startRuntime 起假 DSH + 真 Runtime。

let h: Host
// 每个用例的宿主句柄。
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const lark = { users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false }
// lark 名单的常规应答。
const linkLookedUp = (messageId: string) =>
  vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes('+messages-mget') && args.includes(messageId))
// 判断某消息的源链接查询是否已发出。
/** Hold the first resolution of a Session until `gate` resolves; `held()` says whether it began. */
// 挂起某 Session 的首次解析，直到 gate 兑现；held() 表示挂起是否已开始。
function holdSession(sessionId: string, gate: Promise<void>) {
  let held = false
  h.controller.resolveAgent.mockImplementation(async (id: string) => { if (id === sessionId && !held) { held = true; await gate } return h.resolveDefault(id) })
  return () => held
}
/** The turn of a Session's agent ends, and DSH says so. */
// 某 Session 的 agent 回合结束，DSH 发状态事件说明。
const idle = (sessionId: string) => {
  const agent = h.agents.get(sessionId)!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}

it('evaluates a message that arrives on a thread while an earlier candidate\'s card waits for its link, in the thread\'s next Eval', async () => {
  // 早先候选卡的链接查询未返回时到达的消息，进入该线程的下一次评估而不是插队。
  const gate = deferred()
  // The first candidate's source link lookup is slow; Feishu allows it up to linkTimeoutMs.
  // 第一个候选的源链接查询很慢；飞书允许它等到 linkTimeoutMs。
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => { if (args.includes('+messages-mget') && args.includes('om_1')) await gate.promise; return lark })
  await h.runtime.settings.pause(true, 'panel')
  const a1 = feishu('1', '@bot 修 A'), b1 = feishu('2', '@bot 修 B'), b2 = feishu('3', '@bot B 还有这个', { root_id: 'om_2' })
  h.runtime.receive(a1); h.runtime.receive(b1)
  await h.runtime.settings.pause(false, 'panel')
  await waitUntil(() => linkLookedUp('om_1'))
  h.runtime.receive(b2)
  // b2 在 b1 的链接查询挂起期间到达。
  gate.resolve(); await h.runtime.idle()
  const threadB = `feishu:${CHAT}:om_2`
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b1.id] }, pending: [b2.id] })
  // 线程 B 正在评估 b1，b2 排队等待。
  await h.route({ kind: 'ignore', trigger_id: b1.id, reason: 'duplicate' })
  await h.runtime.idle()
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b2.id] }, pending: [] })
  // b1 决策后线程的下一次评估轮到 b2。
  // A slow link lookup holds only its own candidate's card.
  // 慢的链接查询只挂起它自己候选的卡。
  expect(h.candidates()).toEqual([b1.id, a1.id, b2.id])
})

it('delivers nothing to a ticket a person stopped while an earlier ticket\'s delivery waited', async () => {
  // 投递轮转被打断期间人停止了工单：该工单不再收到任何投递。
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  h.runtime.receive(feishu('6', '二的补充', { mentions: [], root_id: 'om_5', sender_id: 'ou_guest' }))
  // Tickets are processed newest-first, so holding ticket two pauses the pass before ticket one is delivered.
  // 工单按新者先处理：挂住工单二即可在工单一投递前停住整轮。
  const gate = deferred()
  const held = holdSession(two.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.deliveries.mock.calls.length
  gate.resolve(); await resumed; await h.runtime.idle()
  expect(h.deliveries.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ ended: { by: 'human' }, undelivered: [] })
  // 轮转继续后工单一没有新投递，其未送达输入也被清空。
})

it('drops a delivery whose ticket a person stopped while it waited for the worker Session', async () => {
  // 正在等待 worker Session 的投递：人停止工单后该投递被丢弃。
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  const gate = deferred()
  const held = holdSession(one.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.deliveries.mock.calls.length
  gate.resolve(); await resumed; await h.runtime.idle()
  expect(h.deliveries.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).not.toHaveProperty('delivery')
  // 工单上不再有投递痕迹。
})

it('runs prepare commands in the background, side by side, while accepts, intake and passes go on', async () => {
  // prepare 命令在后台并行；受理、消息收集与轮转照常进行。
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR"' } })
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  // 让所有 sh -c 命令都挂在 prepare 闸门上。
  const prepares = () => h.subprocess.spawn.mock.calls.filter(([spec]) => spec.argv[0] === 'sh').length
  const first = [feishu('1', '@bot 修一'), feishu('2', '@bot 修二')]
  for (const trigger of first) h.runtime.receive(trigger)
  await h.runtime.idle()
  for (const [index, trigger] of first.entries()) {
    const accepted = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: `fix-${index}`, acknowledgement: '收到。' })
    expect(accepted).toMatchObject({ decision: 'accept', ticket: { state: 'working/queued' } })
    // 受理立即完成：派工排队等 prepare。
  }
  await waitUntil(() => prepares() === 2)
  // A Source loop's next message is stored at once, and a pass relays it while both prepare commands still run.
  // 来源循环的下一条消息立即入库；两个 prepare 还在跑时轮转就把它的候选卡转投了。
  const later = feishu('3', '@bot 修三')
  expect(h.runtime.receive(later)).toBe('stored')
  await h.runtime.pump()
  expect(h.candidates()).toEqual([...first, later].map(trigger => trigger.id))
  prepare.resolve()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list().map(ticket => ticket.assignments.at(-1)!.state)).toEqual(['running', 'running'])
  // prepare 结束后两个派工都启动。
})

it('keeps a launch that a pause cut short queued, and finishes it once processing resumes', async () => {
  // 被暂停打断的启动保持排队；恢复处理后完成启动。
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'make worktree' } })
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  const trigger = feishu('1', '@bot 修一')
  h.runtime.receive(trigger); await h.runtime.idle()
  await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-one', acknowledgement: '收到。' })
  await waitUntil(() => h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv[0] === 'sh'))
  await h.runtime.settings.pause(true, 'panel')
  prepare.resolve(); await h.runtime.idle()
  const [ticket] = h.runtime.store.tickets.list()
  expect(ticket!.assignments).toEqual([expect.objectContaining({ state: 'pending' })])
  expect(h.runtime.effects.pending('launch')).toBe(true)
  // 暂停中：派工仍 pending，launch 效果挂起。
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(ticket!.id)!.assignments).toEqual([expect.objectContaining({ state: 'running' })])
  // 恢复后派工启动。
})

const botMessage = () => feishu('2', 'CI 失败', { mentions: [], root_id: 'om_1', sender_id: 'cli_ci', sender_type: 'bot' })
// 机器人输入 fixture：工一线程上的 CI 失败通知。
it('wakes an idle worker for a bot\'s Input only when a worker slot is free, and creates a worker Session someone deleted again', async () => {
  // 机器人的 Input 只在有空闲 worker 槽时唤醒 worker；worker Session 被删后能重建。
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  h.runtime.receive(botMessage()); await h.runtime.idle()
  // Ticket two's worker takes the only slot, so ticket one's Input waits.
  // 工单二的 worker 占着唯一的槽：工单一的 Input 只能等。
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  h.agents.get(two.sessionId)!.status = 'idle'
  h.agents.delete(one.sessionId)
  // 工单一的 Session 被人删掉了。
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
  // 槽位空出后：Input 送达且 Session 被重新创建并运行。
})

it('wakes an idle worker for a person\'s message at once, in the slot kept beyond the limit', async () => {
  // 人的消息立即唤醒 worker：用限额外为“人”保留的槽。
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
  // 尽管唯一槽被工单二占着，人的消息仍即刻送达并唤醒。
})

it('counts a launch under way against maxWorkers, so a bot\'s Input for an idle worker waits for the slot', async () => {
  // 进行中的启动也计入 maxWorkers：空闲 worker 的机器人 Input 必须等槽。
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1, prepare: 'make worktree' } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  // Ticket two's launch holds the only slot while its prepare command runs, before its worker's Session does.
  // 工单二的启动在其 prepare 运行期间（worker Session 还没建）就占着唯一的槽。
  const prepare = deferred()
  h.hooks.prepare = prepare.promise
  h.runtime.receive(feishu('5', '@bot 修二')); await h.runtime.idle()
  await h.route({ kind: 'accept', trigger_id: feishu('5', '').id, title: 'two', worktree_name: 'fix-two', acknowledgement: '收到。' })
  await waitUntil(() => h.subprocess.spawn.mock.calls.filter(([spec]) => spec.argv[0] === 'sh').length === 2)
  h.runtime.receive(botMessage()); await h.runtime.pump()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  expect(h.agents.get(one.sessionId)!.status).toBe('idle')
  prepare.resolve(); await h.runtime.idle()
  const two = h.runtime.store.tickets.list().find(ticket => ticket.id !== one.ticket.id)!
  expect(h.agents.get(`worker-${two.id}`)!.status).toBe('running')
  // The slot is ticket two's now, so ticket one's Input still waits.
  // 槽现在归工单二：工单一的 Input 继续等。
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
})

it('records on the ticket that its worker Session could not be created again', async () => {
  // worker Session 无法重建时把错误记录在工单上。
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  h.agents.delete(one.sessionId)
  h.controller.resolveAgent.mockImplementation(async (id: string) => {
    if (id === one.sessionId) throw new Error('The Session store is offline')
    return h.resolveDefault(id)
  })
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ delivery: { error: expect.stringContaining('The Session store is offline') } })
})

it('lets a worker go on after a passing provider failure, three times, before its ticket fails', async () => {
  // 瞬态 provider 失败允许 worker 继续，最多三次，第四次工单失败。
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
  const fail = (error: unknown) => { h.ctx.emit('agent/error', { agent: h.agents.get(one.sessionId), turn: 1, step: 1, error } as never) }
  const busy = Object.assign(new Error('Service Unavailable'), { status: 503 })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    fail(busy)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === one.sessionId).at(-1)!.text)
      .toContain('Your last turn failed for a passing reason')
    expect(latestAssignment(ticket())?.report).toBeUndefined()
    // 退避后重投提示语，但不算汇报。
  } finally { vi.useRealTimers() }
  fail(busy); fail(busy)
  expect(latestAssignment(ticket())?.report).toBeUndefined()
  // The fourth passing failure fails the ticket, as any other failure does at once.
  // 第四次瞬态失败使工单失败，如同任何其他失败立即生效。
  fail(busy)
  await vi.waitFor(() => expect(latestAssignment(ticket())?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('Service Unavailable') }))
})
describe('a worker that goes on after a passing failure', () => {
  // describe 所测：瞬态失败退避的细节。
  const busy = () => Object.assign(new Error('Service Unavailable'), { status: 503 })
  const told = (sessionId: string) => h.deliveries.mock.calls.map(([call]) => call)
    .filter(call => call.sessionId === sessionId && call.text.includes('Your last turn failed for a passing reason'))
  it('starts the count of passing failures again once its turn ends as turns do', async () => {
    // 回合正常结束后瞬态失败计数重新开始，而不是把下一次当成连续第四次。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const fail = () => { h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: busy() } as never) }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try { fail(); fail(); fail(); await vi.advanceTimersByTimeAsync(60_000) } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(3)
    // Once the resumed turn ends normally, a later passing failure starts a new retry count rather than counting as the fourth in a row.
    // 恢复的回合正常结束后，之后的瞬态失败开新一轮计数。
    agent.status = 'idle'
    h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    fail()
    await h.runtime.idle()
    expect(latestAssignment(ticket())?.report?.state).toBe('waiting')
  })
  it('waits while processing is paused, and goes on once it resumes', async () => {
    // 处理暂停时退避定时器等待；恢复后继续。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    agent.status = 'idle'
    await h.runtime.settings.pause(true, 'panel')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: busy() } as never)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(told(one.sessionId)).toEqual([])
      // 暂停期间：定时器空转，不投递。
      await h.runtime.settings.pause(false, 'panel')
      await vi.advanceTimersByTimeAsync(5000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(1)
    // 恢复后投递一次提示。
  })
  it('drops its timer when the host stops within the backoff', async () => {
    // 退避期间宿主停止：定时器被丢弃。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.ctx.emit('agent/error', { agent: h.agents.get(one.sessionId), turn: 1, step: 1, error: busy() } as never)
      await h.runtime.stop()
      // Its timer is cleared with the Executor, so nothing reads the closed database.
      // 定时器随执行器一起清除：不会去读已关闭的数据库。
      await vi.advanceTimersByTimeAsync(60_000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toEqual([])
  })
})
describe('a worker whose work runs in the background', () => {
  // describe 所测：后台作业/子代理下 worker 的忙碌与释放。
  /** The worker's last words, as its Session holds them. */
  // worker 的最后发言（其 Session 快照里保存的）。
  const said = (sessionId: string, text: string) => {
    (h.agents.get(sessionId) as unknown as { session: { snapshotEvents: () => unknown[] } }).session.snapshotEvents =
      () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }]
  }
  const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000)
  // 快进 n 分钟（假定时器下）。
  it('stays busy while its shell job runs, holding its slot, and reports waiting once the job ended and its turn ends', async () => {
    // shell 作业运行期间 worker 保持忙碌并占槽；作业结束唤醒它、回合结束后报告 waiting。
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const job = h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    // No waiting report and nothing relayed while the job runs; the next ticket waits for the slot the job holds.
    // 作业运行中：没有 waiting 汇报也不转投；下一个工单等它占的槽。
    expect(latestAssignment(ticket())?.report).toBeUndefined()
    const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
    expect(latestAssignment(h.runtime.store.tickets.get(two.ticket.id)!)).toMatchObject({ state: 'pending' })
    // The job ends, which wakes the worker with its result; its turn ends, and it reports waiting.
    // 作业结束带着结果唤醒 worker；其回合结束后报告 waiting。
    h.jobs.end(job)
    expect(h.agents.get(one.sessionId)!.status).toBe('running')
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
  })
  it('stays busy while a subagent of it works, and reports waiting once the turn its end woke it for ends', async () => {
    // 子代理工作期间 worker 保持忙碌；子代理结束唤醒的回合结束后报告 waiting。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const child = h.subagents.spawn(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    expect(latestAssignment(ticket())?.report).toBeUndefined()
    h.subagents.settle(child)
    expect(h.agents.get(one.sessionId)!.status).toBe('running')
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
  })
  it('kills its shell jobs and releases its subagents when its ticket stops, whose ends wake no one, and lets it start new ones', async () => {
    // 工单停止时杀 shell 作业、释放子代理（其结束不唤醒任何人）；之后仍可启动新的。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    const job = h.jobs.run(one.sessionId), child = h.subagents.spawn(one.sessionId)
    h.runtime.engine.stopTicket(one.ticket.id)
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String)))
    await vi.waitFor(() => expect(h.subagents.service.drainChildren).toHaveBeenCalledWith(agent, [child]))
    // The kill's end released the stop's own wait, which is how DSH tells the worker's job tools it was collected; the
    // released subagent's end, which DSH delivers before the release returns, is dropped with the turn it woke.
    // kill 的结束释放了停止自己的等待（DSH 以此告知作业工具“已收集”）；子代理的结束通知在释放返回前由 DSH 投出，
    // 与它唤醒的回合一起被丢弃。
    expect(h.jobs.released).toBe(1)
    await vi.waitFor(() => expect(agent.cancel.mock.invocationCallOrder.at(-1)).toBeGreaterThan(h.subagents.service.drainChildren.mock.invocationCallOrder[0]!))
    expect(agent.cancel).toHaveBeenLastCalledWith({ kind: 'user' }, { keepInbox: false })
    // Its Session still admits subagents, as when the ticket resumes.
    // 其 Session 仍接受子代理（如同工单恢复时那样）。
    expect(() => h.subagents.spawn(one.sessionId)).not.toThrow()
  })
  it('reports waiting for the Assignment that replaced one whose idle still waited for its subagents', async () => {
    // 换新派工接替“回合已结束但仍在等子代理”的旧派工：新派工最终报告 waiting。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    // The first Assignment's turn ends while a subagent of it works.
    // 第一个派工的回合在其子代理工作期间结束。
    const child = h.subagents.spawn(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    // Delivering a person's message fails, and a person retries: the subagent is released, and a second Assignment starts.
    // 投递人的消息失败，人重试：子代理被释放，第二个派工启动。
    h.runtime.engine.deliveryFailed(one.ticket.id, latestAssignment(ticket())!.id, 'Session busy')
    h.runtime.engine.retryTicket(one.ticket.id); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(ticket())).toMatchObject({ state: 'running' }))
    expect(h.subagents.live(child)).toBe(false)
    // The second Assignment's turn ends: it is reported waiting.
    // 第二个派工的回合结束：报告 waiting。
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    expect(ticket().assignments).toHaveLength(2)
  })
  /**
   * A worker that hands off to a person, with `report`, frees its slot and stops its subagents; its job, a server for the
   * person, runs on, and its end wakes no one.
   */
  // 用 report 移交人的 worker：释放槽位、停掉子代理；留给人的作业（如服务进程）继续跑，结束也不唤醒谁。
  async function handsOff(report: Record<string, unknown>, before?: (ticketId: string) => void) {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    before?.(one.ticket.id)
    const job = h.jobs.run(one.sessionId, 'pnpm dev'), child = h.subagents.spawn(one.sessionId)
    await h.runTool(one.sessionId, 'orchestrator_report', report); await h.runtime.idle()
    const relayed = h.relays(h.runtime.masterId).length
    idle(one.sessionId); await h.runtime.idle()
    // The subagent stops, and the turn its end woke is cancelled; the job's end is collected.
    // 子代理停止，其结束唤醒的回合被取消；作业的结束被收集。
    await vi.waitFor(() => expect(h.subagents.live(child)).toBe(false))
    await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.status).toBe('idle'))
    expect(h.jobs.service.wait).toHaveBeenCalledWith(job, expect.any(Number), one.sessionId, expect.anything())
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
    h.jobs.end(job)
    expect(h.agents.get(one.sessionId)!.status).toBe('idle')
    expect(h.jobs.released).toBe(1)
    // The worker reads of the end at its next turn.
    // worker 在下一回合读到作业结束通知。
    await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.inject).toHaveBeenCalledWith(expect.objectContaining({
      content: [expect.objectContaining({ text: `Your background job ${job} (pnpm dev) ended: completed.` })] })))
    await h.runtime.idle()
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
    expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toMatchObject({ state: report.state })
    return one
  }
  it('frees the slot of a worker that reports blocked, stopping its subagents and leaving its jobs, whose end wakes no one', async () => {
    await handsOff({ state: 'blocked', summary: 'Which color?' })
  })
  it('keeps a failed worker from being woken by a job it left, and from failing again', async () => {
    await handsOff({ state: 'failed', summary: 'The build broke.' })
  })
  it('frees the slot of a worker that reports ready on a ticket that follows its pull request', async () => {
    await handsOff({ state: 'ready', summary: 'PR ready' }, ticketId => { h.runtime.engine.bindThread(ticketId, { source: 'github', id: '7' }, true) })
  })
  it('frees the slot of a worker that asks a person a question with a progress report', async () => {
    await handsOff({ state: 'progress', summary: 'The server runs.', human_action: 'Does the button look right?' })
  })
  it('leaves the background work of a turn a person started in the worker\'s Session after a hand-off to that turn', async () => {
    // 人转入 worker Session 的回合留下的后台工作照常保持忙碌（即使在移交之后）。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' }); await h.runtime.idle()
    // A person answers in the worker's Session, which the ticket does not record; the turn starts a subagent and a job.
    // 人在 worker 的 Session 里回答（工单不记录）；该回合启动了子代理与作业。
    await new Promise(resolve => setTimeout(resolve, 5))
    h.ctx.emit('agent/inbox/claimed', { agent, message: { id: 'typed', role: 'user', content: [], source: { kind: 'user' } }, turn: 2 } as never)
    const child = h.subagents.spawn(one.sessionId), job = h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    await new Promise(resolve => setTimeout(resolve, 10))
    // They keep the worker busy, as any turn's background work does.
    // 它们让 worker 保持忙碌，与任何回合的后台工作一样。
    expect(h.subagents.live(child)).toBe(true)
    expect(h.jobs.service.wait).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(1)
    h.subagents.settle(child); h.jobs.end(job)
    expect(agent.status).toBe('running')
  })
  it('leaves the jobs a worker left to a person out of a later turn\'s background work, and does not kill them at the limit', async () => {
    // worker 留给人的作业不算进后续回合的后台工作，也不会在时限被杀。
    const one = await handsOff({ state: 'ready', summary: 'PR ready' }, ticketId => { h.runtime.engine.bindThread(ticketId, { source: 'github', id: '7' }, true) })
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    // A second server, left too; then a note from the orchestrator wakes the worker, whose turn ends without a report.
    // 又留了一个服务进程；随后编排者的备注唤醒 worker，其回合结束且没有汇报。
    const server = h.jobs.run(one.sessionId, 'pnpm preview')
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Preview up' }); await h.runtime.idle()
    idle(one.sessionId); await h.runtime.idle()
    await vi.waitFor(() => expect(h.jobs.service.wait).toHaveBeenCalledWith(server, expect.any(Number), one.sessionId, expect.anything()))
    await new Promise(resolve => setTimeout(resolve, 5))
    h.runtime.engine.note(one.ticket.id, 'CI passed on the pull request.'); await h.runtime.idle()
    await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.status).toBe('running'))
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(0)
  })
  it('records each end of a worker\'s turn on its Assignment, also after its ready report', async () => {
    // worker 的每次回合结束都记在其派工上，ready 汇报之后也不例外。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    const report = latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report!
    await new Promise(resolve => setTimeout(resolve, 5))
    idle(one.sessionId); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.idleAt! > report.at).toBe(true))
  })
  it('shows no turn end on a running Assignment whose worker works again, whatever turn ends were recorded', async () => {
    // worker 又开工时，运行中的派工不显示回合结束（无论记录过多少次）。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'On it again' })
    const page = await h.api('GET', `tickets/${one.ticket.id}`)
    expect((page.body as { assignments: Record<string, unknown>[] }).assignments[0]).not.toHaveProperty('turnEndedAt')
  })
  it('keeps a ticket open at a merge while its worker does in the background a message it acknowledged', async () => {
    // 合并（PR 关闭）时 worker 还在后台处理其已确认的消息：工单保持打开。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    idle(one.sessionId); await h.runtime.idle()
    // A person asks for more; the worker acknowledges it, starts the work in the background and its turn ends.
    // 人要求更多；worker 确认、在后台开工、回合结束。
    await new Promise(resolve => setTimeout(resolve, 5))
    const more = feishu('2', '再加个测试', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    await vi.waitFor(() => expect(ticket().undelivered).toEqual([]))
    await h.runTool(one.sessionId, 'orchestrator_ack', { trigger_id: more.id, text: '收到' })
    h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    h.runtime.engine.threadClosed({ source: 'github', id: '7' }, 'merged', new Date().toISOString())
    expect(ticket().ended).toBeUndefined()
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
    // 合并不结束工单，也不杀后台作业。
  })
  it('keeps a worker busy with what it started after a message reached its ready ticket', async () => {
    // 消息到达 ready 的工单后 worker 开工的后台工作让它保持忙碌。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    // The ticket follows its pull request, so a ready report leaves it open.
    // 工单跟随其 PR：ready 汇报不关闭它。
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' })
    idle(one.sessionId); await h.runtime.idle()
    expect(h.runtime.executor.activeCount()).toBe(0)
    // A person asks for more; the worker starts the tests in the background and ends its turn.
    // 人要求更多；worker 在后台开跑测试并结束回合。
    await new Promise(resolve => setTimeout(resolve, 5))
    h.runtime.receive(feishu('2', '再加个测试', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(ticket())?.deliveredAt! >= latestAssignment(ticket())!.report!.at).toBe(true))
    const job = h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(1)
    h.jobs.end(job); idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
  })
  it('gives each idle of a worker its own 30 minutes, not counting the turns that ends of its background work wake it for', async () => {
    // worker 的每次空闲各有 30 分钟；后台作业结束唤醒的回合不计入上一个空闲的时限。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const first = h.jobs.run(one.sessionId)
    let second = ''
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      idle(one.sessionId)
      await minutes(20)
      // The job ends and wakes the worker, which starts another and ends its turn 5 minutes later.
      // 作业结束唤醒 worker，它又启动一个并在 5 分钟后结束回合。
      h.jobs.end(first)
      second = h.jobs.run(one.sessionId)
      await minutes(5)
      idle(one.sessionId)
      // 35 minutes after the first idle, 10 after the second.
      // 距第一次空闲 35 分钟，距第二次 10 分钟。
      await minutes(10)
      expect(h.jobs.service.kill).not.toHaveBeenCalled()
      expect(latestAssignment(ticket())?.report).toBeUndefined()
      await minutes(20)
    } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(second, one.sessionId, expect.any(String)))
    expect(latestAssignment(ticket())?.report?.state).toBe('waiting')
    // 第二个空闲满 30 分钟后作业被杀并报告 waiting。
  })
  it('kills the jobs that run 30 minutes after the turn ended, leaving its subagents, and reports waiting after the worker\'s words', async () => {
    // 回合结束 30 分钟后仍在跑的作业被杀（子代理保留）；waiting 汇报跟在 worker 最后发言之后。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    said(one.sessionId, 'The tests run in the background.')
    const job = h.jobs.run(one.sessionId, 'pnpm test\n  --watch=false'), child = h.subagents.spawn(one.sessionId)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      idle(one.sessionId)
      await minutes(29)
      expect(latestAssignment(ticket())?.report).toBeUndefined()
      await minutes(1)
    } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report).toMatchObject({ state: 'waiting', summary: 'The tests run in the background.\n\n'
      + `Background jobs ran 30 minutes after the worker's turn ended and were killed: ${job} (pnpm test).` }))
    expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String))
    // The kill was collected, so the worker reads of it at its next turn.
    // kill 已被收集：worker 在下一回合读到通知。
    expect(h.agents.get(one.sessionId)!.inject).toHaveBeenCalledWith(expect.objectContaining({ content: [expect.objectContaining({
      text: `Your background jobs ran 30 minutes after your turn ended and were killed: ${job} (pnpm test).` })] }))
    // Stopping its subagent would wake it with the end, in the Assignment it was just reported waiting in.
    // 不能停它的子代理：那会用结束唤醒它，打断刚报告的 waiting。
    expect(h.subagents.live(child)).toBe(true)
    expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'waiting' })
  })
  it('says a worker\'s subagents still run when only they ran 30 minutes after the turn ended', async () => {
    // 回合结束 30 分钟后只有子代理还在跑：waiting 汇报说明子代理仍在运行。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.subagents.spawn(one.sessionId)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try { idle(one.sessionId); await minutes(30) } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toMatchObject({ state: 'waiting',
      summary: 'Subagents still ran 30 minutes after the worker\'s turn ended.' }))
  })
  it('holds a delivery that reached a worker while a hand-off stopped its subagents until the stop ended', async () => {
    // 移交（停子代理）期间到达 worker 的投递被挂住，直到停止结束——避免被取消丢弃。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    h.subagents.spawn(one.sessionId)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    // A person's message is on its way into the worker's Session, held there, as the worker hands off; the release is slow.
    // 人的消息正在进 worker Session 的路上并被挂住（worker 正在移交）；释放很慢。
    const session = deferred(), drain = deferred(), release = h.subagents.service.drainChildren.getMockImplementation()!
    h.subagents.service.drainChildren.mockImplementationOnce(async (parent, ids) => { await drain.promise; await release(parent, ids) })
    await new Promise(resolve => setTimeout(resolve, 5))
    const held = holdSession(one.sessionId, session.promise)
    h.runtime.receive(feishu('2', '按钮再大一点', { mentions: [], root_id: 'om_1' }))
    await vi.waitFor(() => expect(held()).toBe(true))
    idle(one.sessionId)
    await vi.waitFor(() => expect(h.subagents.service.drainChildren).toHaveBeenCalled())
    session.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    drain.resolve()
    // The message reaches the worker after the stop's cancel, which would have dropped it.
    // 消息在停止的 cancel 之后才到达 worker（否则会被丢弃）。
    const message = expect.objectContaining({ sessionId: one.sessionId, text: expect.stringContaining('按钮再大一点') })
    await vi.waitFor(() => expect(h.deliveries).toHaveBeenCalledWith(message), { timeout: 5000 })
    const delivered = h.deliveries.mock.calls.findIndex(([call]) => call.sessionId === one.sessionId && call.text.includes('按钮再大一点'))
    expect(h.deliveries.mock.invocationCallOrder[delivered]).toBeGreaterThan(agent.cancel.mock.invocationCallOrder.at(-1)!)
  })
  it('keeps an Input a restart found handed over to a settled worker, and delivers a waiting one once its subagents stopped', async () => {
    // 重启时发现已移交但 worker 已停的 Input：保留在收件箱；子代理停掉后才投递等待中的那条。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!, ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    // A subagent still runs, whose release is slow; one Input waits in the Session's inbox, another in the ticket.
    // 还有一个子代理在跑、释放很慢；一条 Input 在 Session 收件箱里，另一条在工单上。
    h.subagents.spawn(one.sessionId)
    const gate = deferred(), drain = h.subagents.service.drainChildren.getMockImplementation()!
    h.subagents.service.drainChildren.mockImplementationOnce(async (parent, ids) => { await gate.promise; await drain(parent, ids) })
    agent.inbox.nextStep.push({ id: 'taken-later', role: 'user', content: [{ type: 'text', text: 'Handed over' }], source: { kind: 'user' } } as never)
    const stored = ticket()
    stored.inputs.push({ id: 'input-late', kind: 'text', text: 'One more thing', at: new Date().toISOString() })
    stored.undelivered.push('input-late')
    h.runtime.store.tickets.save(stored)
    // The delivery waits for the release, so the effects are not idle until it ends.
    // 投递等释放：效果不空闲直到释放结束。
    h.runtime.executor.resume()
    await new Promise(resolve => setTimeout(resolve, 20))
    const late = expect.objectContaining({ sessionId: one.sessionId, text: expect.stringContaining('One more thing') })
    expect(h.deliveries).not.toHaveBeenCalledWith(late)
    const reports = () => h.relays(h.runtime.masterId).filter(item => item.kind === 'worker_report').length
    const reported = reports()
    gate.resolve()
    await vi.waitFor(() => expect(h.deliveries).toHaveBeenCalledWith(late))
    expect(agent.cancel).not.toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(agent.inbox.nextStep.map(message => message.id)).toContain('taken-later')
    // The turn the subagent's end woke and the release cancelled reports nothing.
    // 子代理结束唤醒、又被释放取消的回合不产生汇报。
    await h.runtime.idle()
    expect(reports()).toBe(reported)
  })
  it('collects the end of a job left to a person until dsh-superagent stopped its workers', async () => {
    // 留给人的作业：其结束被收集，直到 dsh-superagent 停掉所有 worker。
    const one = await handsOff({ state: 'blocked', summary: 'Which color?' })
    const agent = h.agents.get(one.sessionId)!
    const server = h.jobs.run(one.sessionId, 'pnpm dev')
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Which size?' }); await h.runtime.idle()
    idle(one.sessionId)
    await vi.waitFor(() => expect(h.jobs.service.wait).toHaveBeenCalledWith(server, expect.any(Number), one.sessionId, expect.anything()))
    // The server ends while the host stops, after it cancelled the workers.
    // 服务进程在宿主停止期间结束（在它取消 worker 之后）。
    const cancel = agent.cancel.getMockImplementation()!
    agent.cancel.mockImplementationOnce((...args: unknown[]) => { h.jobs.end(server); return cancel(...args as [unknown, { keepInbox?: boolean }]) })
    const woken = agent.followup.mock.calls.length
    await h.stop()
    expect(agent.followup.mock.calls.length).toBe(woken)
    expect(agent.status).toBe('idle')
    // 停止后不再唤醒 worker。
  })
  it('stops every worker\'s jobs and subagents when dsh-superagent stops, before it releases their tool limits', async () => {
    // dsh-superagent 停止时先停每个 worker 的作业与子代理，再释放其工具限制。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const job = h.jobs.run(one.sessionId), child = h.subagents.spawn(one.sessionId)
    await h.stop()
    expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String))
    expect(h.subagents.live(child)).toBe(false)
  })
  it('cancels no worker for a subagent that ended before, and cancels the turn a release woke also when the release fails', async () => {
    // 之前就已结束的子代理不触发取消；释放失败时它唤醒的回合同样被取消。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    h.subagents.settle(h.subagents.spawn(one.sessionId))
    // Its ready report ends the ticket, and it ends its own turn.
    // 其 ready 汇报结束工单，它自己结束回合。
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
    await h.runtime.idle(); await new Promise(resolve => setTimeout(resolve, 10))
    expect(agent.cancel).not.toHaveBeenCalled()
    // A release that fails after the ends woke the worker still cancels that turn.
    // 结束唤醒 worker 后释放才失败：该回合仍被取消。
    const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
    const other = h.agents.get(two.sessionId)!
    const child = h.subagents.spawn(two.sessionId)
    h.subagents.service.drainChildren.mockImplementationOnce(async () => { h.subagents.settle(child); throw new Error('ACTIVATION_TEARDOWN_FAILED') })
    h.runtime.engine.stopTicket(two.ticket.id)
    await vi.waitFor(() => expect(h.subagents.service.drainChildren).toHaveBeenCalled())
    await vi.waitFor(() => expect(other.cancel.mock.invocationCallOrder.at(-1)).toBeGreaterThan(h.subagents.service.drainChildren.mock.invocationCallOrder.at(-1)!))
  })
  it('stops the jobs and the turn of a worker a restart in this process left running, before its Assignment starts again', async () => {
    // 进程内“重启”发现 worker 还在跑：先停其作业与回合（保留收件箱），再重启其派工。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const job = h.jobs.run(one.sessionId)
    h.runtime.executor.resume()
    expect(h.agents.get(one.sessionId)!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String)))
    expect(h.runtime.store.tickets.get(one.ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
    // 工单上记录“宿主已重启”的输入。
  })
  it('stops a ticket whose worker Session was never created without a health error, and goes on past a failing kill', async () => {
    // 停止从未创建 Session 的工单不报健康错误；单个 kill 失败不影响其余作业被杀。
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    await h.acceptedTicket(feishu('1', '@bot 修一'))
    const queued = await h.acceptedTicket(feishu('5', '@bot 修二'))
    expect(h.agents.has(queued.sessionId)).toBe(false)
    // DSH cannot list the children of a Session that does not exist.
    // DSH 无法列出不存在的 Session 的孩子。
    const list = h.subagents.service.listChildren.getMockImplementation()!
    h.subagents.service.listChildren.mockImplementation(async (id: string) => {
      if (id === queued.sessionId) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      return list(id)
    })
    h.runtime.engine.stopTicket(queued.ticket.id); await h.runtime.idle()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.runtime.health.worker?.state).not.toBe('error')
    // A kill that throws leaves the other jobs to be killed.
    // 抛错的 kill 不妨碍其余作业被杀。
    const one = h.runtime.store.tickets.list().find(ticket => ticket.id !== queued.ticket.id)!
    const sessionId = `worker-${one.id}`
    const [first, second] = [h.jobs.run(sessionId), h.jobs.run(sessionId)]
    h.jobs.service.kill.mockImplementationOnce(() => { throw new Error('No such process') })
    h.runtime.engine.stopTicket(one.id)
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(second, sessionId, expect.any(String)))
    expect(h.jobs.service.kill).toHaveBeenCalledWith(first, sessionId, expect.any(String))
  })
})
describe('what a worker read', () => {
  // describe 所测：worker 读到的消息的“已读”判定。
  const later = () => new Promise(resolve => setTimeout(resolve, 5))
  // 等一小段时间（让异步事件落地）。
  /** A ticket its worker completed, and a person's thanks on its thread, which resumes it once received. */
  // worker 已完成的工单 + 线程上人的感谢（收到即恢复工单）。
  async function completed() {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' }); await h.runtime.idle()
    idle(one.sessionId)
    await later()
    return { one, thanks: feishu('2', '@bot 谢谢', { root_id: 'om_1' }), ticket: () => h.runtime.store.tickets.get(one.ticket.id)! }
  }
  /** Deliveries to a Session of a message with `text` fail until the returned function lets them through. */
  // 某 Session 上含 text 的消息投递一直失败，直到调用返回的放行函数。
  function failing(sessionId: string, text: string) {
    const agent = h.agents.get(sessionId)!, steer = agent.steer.getMockImplementation()!
    let fail = true
    agent.steer.mockImplementation(message => {
      if (fail && message.content.some(block => block.type === 'text' && block.text.includes(text))) throw new Error('Session busy')
      steer(message)
    })
    return () => { fail = false }
  }
  /** Runs `then` after the delivery retry, two seconds on; the clock moves on only by `vi.setSystemTime`. */
  // 在投递重试（2 秒后）之后执行 then；时钟只随 vi.setSystemTime 前进。
  async function retried(then: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
    try { await h.runtime.pump(); await h.runtime.idle(); await then(); await h.runtime.pump(); await h.runtime.idle() }
    finally { vi.useRealTimers() }
  }
  it('sends to Eval a message that woke a ticket and that a retry delivered after a progress report, at a dropped report', async () => {
    // 唤醒了工单、又在进度汇报之后由重试送达的消息：worker 报 dropped 时送评估（无人读过它）。
    const { one, thanks, ticket } = await completed()
    const pass = failing(one.sessionId, '谢谢')
    h.runtime.receive(thanks); await h.runtime.idle()
    expect(ticket().delivery).toBeDefined()
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Looking' })
    pass()
    // The retry steers the message in while the worker writes that nothing is left, and no step takes it before.
    // 重试在 worker 写下“无事可做”时插入消息；在此之前没有任何步骤取走它。
    await retried(async () => {
      expect(ticket().undelivered).toEqual([])
      await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    })
    expect(h.candidates()).toContain(thanks.id)
  })
  it('counts a delivered message as read only once its step took it into the Session, not when a cut-off step claimed it', async () => {
    // 只有步骤把消息取进 Session 才算已读；被切断的步骤即使认领了也不算。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const more = feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    const input = () => h.runtime.store.tickets.get(one.ticket.id)!.inputs.find(item => item.kind === 'trigger' && item.triggerId === more.id) as
      { readAt?: string | null }
    await vi.waitFor(() => expect(input().readAt).toBe(null))
    // A step claims it and is cut off before the Session took it, as a cancel in its pre-step does, which drops the message.
    // 步骤认领了消息但 Session 取走之前被切断（如预步骤里的取消），消息被丢弃。
    h.claim(one.sessionId); await h.runtime.idle(); await later()
    expect(input().readAt).toBe(null)
  })
  it('keeps a note waiting in a worker\'s Session across an in-process restart, for the next Assignment\'s first step', async () => {
    // 进程内重启后备注仍留在 worker Session 收件箱里等下一次派工的首步。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.note(one.ticket.id, 'Ticket B changes the same page.'); await h.runtime.idle()
    const copies = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('Ticket B changes the same page.'))
    await vi.waitFor(() => expect(copies()).toHaveLength(1))
    const claimed: string[] = []
    h.ctx.on('agent/inbox/claimed', ({ message }) => { claimed.push(message.id) })
    // The restart cancels the worker's turn and keeps its inbox, where the note waits.
    // 重启取消 worker 回合并保留收件箱：备注在原地等。
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(claimed).toContain(copies()[0]![0].id))
    expect(copies()).toHaveLength(1)
    // 重启后不再重复投递（只被重新认领）。
  })
  it('delivers once a message a crash left waiting in a worker\'s Session, which the restart puts back for the next Assignment', async () => {
    // 崩溃留下的等待消息只投递一次：重启把它放回给下一个派工。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.receive(feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    const copies = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('再改一下'))
    await vi.waitFor(() => expect(copies()).toHaveLength(1))
    // The process dies: the worker's agent is not loaded when the restart runs, and its inbox, which holds the message,
    // persists for the launch that loads it.
    // 进程死了：重启运行时 worker 的 agent 未加载；装着消息的收件箱持久保留给启动时加载。
    const agent = h.agents.get(one.sessionId)!
    h.agents.delete(one.sessionId); agent.status = 'idle'
    h.controller.resolveAgent.mockImplementation(async (id: string) => { if (id === one.sessionId) h.agents.set(id, agent); return h.resolveDefault(id) })
    const waiting: string[][] = [], launch = agent.followup.getMockImplementation()!
    agent.followup.mockImplementation(message => { waiting.push([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(item => item.id)); launch(message) })
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(copies()).toHaveLength(2))
    // The launch's message found no copy of it waiting, which its step would take beside the copy delivered after.
    // 启动的消息里没有该消息的副本：步骤将在其后送达的副本一并取走。
    expect(waiting[0]).not.toContain(copies()[0]![0].id)
  })
  it('gives the Assignment an in-process restart starts a message a cut-off step had claimed, once', async () => {
    // 进程内重启启动的派工会拿到“被切断步骤认领过”的消息，且只投一次。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.receive(feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    const sent = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('再改一下')).length
    await vi.waitFor(() => expect(sent()).toBe(1))
    // A step claims it and the restart cuts the step off before the Session took it, which drops it.
    // 步骤认领了消息，重启在 Session 取走前切断该步骤（消息被丢弃）。
    h.claim(one.sessionId)
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(sent()).toBe(2))
    await h.runtime.idle(); await later()
    expect(sent()).toBe(2)
    // 重启后恰好重投一次，不再更多。
  })
  it('counts a message that woke a ticket as read by a later dropped report once a step of its worker took it', async () => {
    // 唤醒了工单的消息被 worker 的步骤取走后：之后的 dropped 汇报就算读过它。
    const { one, thanks } = await completed()
    // The resumed Assignment's message wakes the worker; its next step takes the note that it resumed and the message.
    // 恢复派工的消息唤醒 worker；下一步取走恢复备注与该消息。
    h.runtime.receive(thanks); await h.runtime.idle()
    h.step(one.sessionId)
    await later()
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    await h.runtime.pump(); await h.runtime.idle()
    expect(h.candidates()).not.toContain(thanks.id)
    // 已读：不再送评估。
  })
  it('counts a message a retry delivered to its idle worker as read by the report of the turn it woke', async () => {
    // 重试送达给空闲 worker 的消息：由它唤醒的回合的汇报判定已读。
    const { one, thanks, ticket } = await completed()
    const pass = failing(one.sessionId, '谢谢')
    h.runtime.receive(thanks); await h.runtime.idle()
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    pass()
    // The retry wakes the worker, whose first step takes the message.
    // 重试唤醒 worker，其首步取走消息。
    await retried(async () => {
      expect(h.agents.get(one.sessionId)!.status).toBe('running')
      vi.setSystemTime(Date.now() + 1000)
      await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    })
    expect(h.candidates()).not.toContain(thanks.id)
  })
  it('sends to Eval at a merge a message that reached the worker after its last step, which no step took before its turn ended', async () => {
    // 合并时送评估：最后一步之后才到达、回合结束前没有步骤取走的消息。
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    // A person's thanks reaches the worker after the step of its report, and its turn ends with no step taking it.
    // 人的感谢在汇报那步之后才到；回合结束时没有任何步骤取走它。
    await later()
    const thanks = feishu('2', '@bot 谢谢', { root_id: 'om_1' })
    h.runtime.receive(thanks); await h.runtime.idle()
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    await later()
    h.runtime.engine.threadClosed({ source: 'github', id: '7' }, 'merged', new Date().toISOString())
    await h.runtime.pump(); await h.runtime.idle()
    expect(ticket().ended).toMatchObject({ outcome: 'merged' })
    expect(h.candidates()).toContain(thanks.id)
    // 未读的感谢在合并时送评估。
  })
})
it('reports nothing for a worker whose turn ends while it waits out the backoff of a passing failure', async () => {
  // worker 在退避等待期间结束回合：不产生任何汇报。
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const agent = h.agents.get(one.sessionId)!
  const relayed = h.relays(h.runtime.masterId).length
  h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('Service Unavailable'), { status: 503 }) } as never)
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toBeUndefined()
  expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
})
it('wakes an idle worker for a status request in the slot kept for a person, while every other slot is taken', async () => {
  // 状态催办用为“人”保留的槽唤醒空闲 worker——即使其余槽全被占用。
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  // Its worker ended its turn without a report, so it waits.
  // 其 worker 未汇报就结束了回合：处于等待。
  h.agents.get(one.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.agents.get(one.sessionId), status: 'idle' } as never)
  await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  expect(h.runtime.engine.requestStatus(one.ticket.id)).toBe(true); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
})
it('tells a passing failure of the provider or the network from one that a later try would meet again', () => {
  // 区分瞬态失败（provider/网络）与“再试还会遇到”的失败。
  for (const error of [Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { status: 503 }),
    Object.assign(new Error('connect'), { code: 'ECONNRESET' }), new TypeError('fetch failed'), new Error('getaddrinfo EAI_AGAIN api.example.com')]) {
    expect(transient(error)).toBe(true)
  }
  for (const error of [Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('x'), { status: 401 }), new Error('context too long'), 'LlmError: offline']) {
    expect(transient(error)).toBe(false)
  }
})
it('reports a worker waiting when its turn ends after a person answered its blocked report', async () => {
  // 人的回答晚于 blocked 汇报到达：回合结束后 worker 报告 waiting。
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' })
  // The person answers later than the report.
  // 人的回答比汇报晚。
  await new Promise(resolve => setTimeout(resolve, 5))
  h.runtime.receive(feishu('2', '蓝色', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
  const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
  expect(waitsForPerson(ticket())).toBe(false)
  h.agents.get(one.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.agents.get(one.sessionId), status: 'idle' } as never)
  await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
})

it('resumes an ended ticket a person wrote to during a pause once it lifts, under the Policy then', async () => {
  // 暂停期间写到已结束工单的消息在暂停解除后恢复工单——按“解除时”的策略判定授权。
  const pass = async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
    try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  }
  const ended = async (id: string) => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu(id, `@bot 修${id}`, { root_id: `om_${id}` }))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
    return ticket.id
  }
  const first = await ended('1'), second = await ended('3')
  const followUp = async (id: string, root: string) => {
    await h.runtime.settings.pause(true, 'panel')
    h.runtime.receive(feishu(id, '再改一下', { mentions: [], root_id: root })); await h.runtime.idle()
  }
  // While processing is paused, the message waits on the ended ticket; the first pass after the pause resumes it.
  // 处理暂停期间消息在已结束工单上等待；暂停后的第一轮轮转恢复工单。
  await followUp('2', 'om_1')
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ ended: expect.anything(), undelivered: [expect.any(String)] })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: 'running' })] })
  expect(h.runtime.store.tickets.get(first)).not.toHaveProperty('ended')
  // A Mandate the Policy no longer holds when the pause lifts does not resume: its sender left the list meanwhile.
  // 暂停解除时策略已不再支持其授权的工单不恢复：发送者期间被移出名单。
  await followUp('4', 'om_3')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu!, allowed: [] } } } })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(second)).toMatchObject({ ended: expect.anything(), undelivered: [] })
})

it('ends a worker\'s turn only when the stop that ended its Assignment commits', async () => {
  // 只有结束派工的停止真正提交后才结束 worker 的回合（事务回滚则不取消）。
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.agents.get(one.sessionId)! as unknown as { cancel: ReturnType<typeof vi.fn> }
  expect(() => h.runtime.store.atomic(() => { h.runtime.engine.stopTicket(one.ticket.id); throw new Error('rolled back') })).toThrow('rolled back')
  expect(worker.cancel).not.toHaveBeenCalled()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.ended).toBeUndefined()
  h.runtime.engine.stopTicket(one.ticket.id)
  expect(worker.cancel).toHaveBeenCalledOnce()
})

describe('the Executor\'s parts', () => {
  // describe 所测：Executor 的纯函数部件。
  it('holds one worker slot per ticket that runs or starts, and lets launches take the slots no worker or wake holds', () => {
    // 每个运行中或启动中的工单占一个槽；launch 只能用无人占用/唤醒占用的槽。
    const running = ['t1']
    const slots = new WorkerSlots(() => running, () => 3)
    slots.reserve('t2', 'launch')
    slots.reserve('t3', 'wake')
    expect(slots.used()).toBe(3)
    // launches() excludes 'launch' reservations because the launch queue tracks active launches separately.
    // launches() 不把 launch 预约计入（启动队列另算活跃启动数）。
    expect(slots.launches()).toBe(1)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    expect(() => slots.reserve('t3', 'wake')).not.toThrow()
    slots.free('t3')
    expect(slots.used()).toBe(2)
    slots.reserve('t4', 'launch')
    expect(slots.used()).toBe(3)
    // 同一工单可重复预约；释放后槽位让出。
  })
  it('wakes a worker for a person\'s message in the one slot beyond the limit, and ahead of launches once a slot frees up', () => {
    // 人的唤醒用限额外的那一个槽；槽释放后人的唤醒优先于 launch。
    const running = ['t1', 't2', 't3']
    const slots = new WorkerSlots(() => running, () => 3)
    expect(() => slots.reserve('t4', 'launch')).toThrow(Later)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    slots.reserve('t5', 'person')
    expect(slots.used()).toBe(4)
    expect(slots.launches()).toBeLessThanOrEqual(0)
    // No second person's wake fits beyond the limit; once a worker ends, it does, while a launch still waits.
    // 限额外只容得下一个人的唤醒；有 worker 结束后第二个人可以，launch 仍要等。
    expect(() => slots.reserve('t6', 'person')).toThrow(Later)
    running.splice(0, 1)
    expect(() => slots.reserve('t7', 'launch')).toThrow(Later)
    slots.reserve('t6', 'person')
    expect(slots.used()).toBe(4)
  })
  it('words an assignment, and the limits an inferred mandate sets, from the ticket alone', () => {
    // 派工文案只从工单出发；推断授权的限制放系统提示词而不重复在派工里。
    const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true,
      instruction: 'Fix typos only.' }] } })
    const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
      mandate: { strength: 'inferred', policyVersion: 'v1', basis: { rules: ['copy'] }, actor: { source: 'github', id: 'alice' },
        scope: '' } } as unknown as Ticket
    const execution = ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo' } as never,
      settings, '/state')
    expect(execution).toEqual(expect.objectContaining({ name: 'fix-typo-ticket-01234' }))
    expect(execution).not.toHaveProperty('session')
    // The source Trigger goes with the assignment, so the text does not point at it.
    // 源触发器随派工一起给：文案里不再指向它。
    expect(execution.assignment).toContain('Scope: the typo.')
    expect(execution.assignment).not.toContain('trigger/tr1')
    expect(ticketExecution({ ...ticket, mandate: { ...ticket.mandate, strength: 'explicit' } } as Ticket,
      { kind: 'accept', title: 'Fix', scope: 'Fix', reason: 'r', name: 'fix-login', note: 'the login page' } as never, settings, '/state').assignment)
      .toBe('Routing note (not the source request): the login page')
    // The worker's system prompt holds the limits an inferred Mandate sets, so the assignment does not repeat them.
    // 推断授权的限制在 worker 的系统提示词里：派工不重复；但会列出所依据的规则。
    expect(execution.assignment).not.toContain(mandateInstructions(ticket.mandate))
    expect(execution.assignment).toContain('- Copy fixes (copy): Fix typos only.')
    expect(mandateInstructions({ strength: 'explicit' })).toBe('')
  })
  it('renders each kind of Input as its worker reads it, inline, and no reopen Input', () => {
    // 各类 Input 按 worker 视角渲染（内联）；reopen 输入不渲染。
    const asked = { id: 'tr1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Which page?', meta: {} } as Trigger
    const reply = { ...asked, id: 'tr2', text: 'The login page. '.repeat(50) }
    const card = triggerMessage(reply, { source_url: 'https://x' }, 'see the log', asked)
    expect(card).toEqual({ trigger_id: 'tr2', from: 'ou_a', thread: 'feishu:oc:om_1', at: '2026-09-01T00:00:00Z', text: expect.stringMatching(/^The login page\./),
      chars: reply.text.length, read: 'trigger/tr2', source_url: 'https://x', routing_note: 'see the log', replies_to: { trigger_id: 'tr1', preview: 'Which page?' } })
    expect(card.text).toHaveLength(601)
    expect(triggerMessage(asked, {})).toEqual({ trigger_id: 'tr1', from: 'ou_a', thread: 'feishu:oc:om_1', at: asked.at, text: 'Which page?' })
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: '' }, card)!)).toEqual(card)
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'gone', at: '' })!)).toEqual({ trigger_id: 'gone', read: 'trigger/gone' })
    expect(inputMessage({ id: 'i2', kind: 'text', at: '', text: 'Please also update the docs' })).toBe('Please also update the docs')
    // A Policy change says what it means for the ticket, without version hashes.
    // 策略变更按其对工单的意义来表述，不带版本哈希。
    const changed = inputMessage({ id: 'i3', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { requesterAllowed: false,
      requester: { source: 'github', id: 'ci-bot' },
      rules: [{ id: 'copy', name: 'Copy fixes', change: 'changed', instruction: 'Fix typos only.' }, { id: 'visual', name: 'Visual', change: 'disabled' }] } })!
    expect(changed).toContain('Rule Copy fixes (copy), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: Fix typos only.')
    expect(changed).toContain('Rule Visual (visual), which this ticket was accepted under, no longer applies')
    // The sender is named, a bot as a person.
    // 发送者被点名（机器人也当人称呼）。
    expect(changed).toContain('The sender this ticket is for, ci-bot on github, may no longer start work here')
    expect(changed).not.toContain('person')
    expect(changed).not.toContain('v2')
    const mode = inputMessage({ id: 'i6', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { proactive: false } })!
    expect(mode).toContain('Work inferred from a rule is no longer accepted, as the accept mode is no longer auto')
    expect(mode).not.toContain('sender')
    expect(inputMessage({ id: 'i5', kind: 'resumed', at: '', triggerId: 'tr2' })).not.toContain('tr2')
    expect(inputMessage({ id: 'i4', kind: 'reopen', at: '' } as never)).toBeUndefined()
  })
  it('relays a worker\'s question, result or answer to the main Session, and keeps its progress internal', () => {
    // worker 的提问/结果/回答转投主 Session；进度汇报只留内部。
    const ticket = { id: 't1', title: 'Fix', updatedAt: '2026-09-01T00:00:00Z', attention: { id: 'a1', question: 'Which color?' }, assignments: [],
      mandate: { strength: 'explicit' }, origin: { triggerId: 'tr1' } } as unknown as Ticket
    expect(reportRelay(ticket, { state: 'progress', summary: 'halfway' })).toBeUndefined()
    expect(reportRelay(ticket, { state: 'blocked', summary: 'need input', question: 'Which color?' }))
      .toMatchObject({ id: 'attention:t1:a1', text: expect.stringContaining('"kind":"worker_attention"') })
    const ready = reportRelay({ ...ticket, attention: undefined } as unknown as Ticket, { state: 'ready', summary: 'Done',
      answers: 'tr9' })!
    expect(ready.id).toMatch(/^report:/)
    expect(JSON.parse(ready.text)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: 't1' }, trigger_id: 'tr1', state: 'ready', answer_to: 'tr9', summary: 'Done' })
  })
})
