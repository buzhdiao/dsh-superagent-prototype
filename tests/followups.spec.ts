/** Follow-up routing: human messages on subscribed threads go directly to the ticket worker and notify the main session without starting an Eval. */
// 本文件覆盖跟进消息（follow-up）的路由规则：已订阅线程上的真人消息直接送达工单 worker
// 并以卡片通知主 Session，不启动 Eval；涵盖权限差异（成员 vs 访客）、handback 后的重路由、
// 通知的持久化与去重、模型调用开销的合并、上下文订阅（context follow）、结束工单的恢复唤醒，
// 以及旧版本遗留队列的迁移清理。测试策略：startRuntime 真实运行时 + 事件捕获（relays/通知/投递）断言。
import { afterEach, expect, it, vi } from 'vitest'
// vitest 测试原语与计时器控制。
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'
// host 夹具：startRuntime 起真实运行时；feishu 构造飞书消息；CHAT 为会话 id。
import { repliedTo } from '../src/app/links.ts'
// repliedTo：找一条消息所回复的 Trigger（跨 kind 查询）。
import { inputMessage } from '../src/executor/dsh.ts'
// inputMessage：投递给 worker 的输入消息文案（断言其中的 handback 提示）。

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
// 每个用例后停掉运行时。
const THREAD = `feishu:${CHAT}:om_1`
// 基准线程：om_1 主题下的飞书会话。
const followup = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishu(id, text, { mentions: [], root_id: 'om_1',
  ...overrides })
// 构造 om_1 线程上的跟进消息（默认不带提及）。
const notices = (host: Host) => host.relays(host.runtime.masterId).filter(item => item.kind === 'follow_up')
// 主 Session 收到的 follow_up 通知列表。

it('delivers a follow-up to the worker and tells the main Session with a card, without an Eval', async () => {
  // 核心路径：跟进直达 worker + 主 Session 收卡片通知；不产生候选、不启动 Eval。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.deliveries.mockClear()
  // 清空受理阶段的投递记录，只观察本消息的投递。
  const message = followup('2', '顺便把标题也改了', { parent_id: 'om_1' })
  h.runtime.receive(message)
  await h.runtime.idle()
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: message.id, text: '顺便把标题也改了' })])
  // worker Session 直接收到了跟进消息。
  expect(notices(h)).toEqual([{ kind: 'follow_up', trigger_id: message.id, from: 'ou_alice', thread: THREAD, at: message.at,
    text: '顺便把标题也改了',
    replies_to: { trigger_id: ticket.origin.triggerId, preview: '@bot 修一下回归' },
    delivered_to: [{ ticket_id: ticket.id, title: ticket.title, state: 'working' }],
      note: expect.stringContaining('worker has it and decides') }])
  // 通知卡片：带被回复消息预览、送达的工单列表，以及“worker 持有并决定”的说明。
  // No candidate, no Eval, no Decision: nothing waits on the main Session, and the Thread's queue stays free.
  // 没有候选、没有 Eval、没有决策：主 Session 无待办，线程队列保持空闲。
  expect(h.candidates()).toEqual([])
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [] })
  expect(h.runtime.store.threads.get(THREAD)).not.toHaveProperty('evaluating')
  expect(h.runtime.store.decisions.byThread(THREAD)).toHaveLength(1)
  // 决策只有受理那条（本跟进没走决策）。
  expect(h.runtime.store.triggers.disposition(message.id)).toEqual({ fanout: [ticket.id], at: expect.any(String) })
  // Trigger 的处置记录为 fanout 到该工单。
})

it('sends a person\'s message that reaches no ticket, such as only one a person stopped, to Eval as before', async () => {
  // 没有可送达工单的真人消息（如工单已被停）回退到常规 Eval 流程。
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.stopTicket(ticket.id)
  h.deliveries.mockClear()
  const message = followup('2', '@bot 换个方式修', { mentions: [{ id: 'ou_bot' }] })
  h.runtime.receive(message)
  await h.runtime.idle()
  expect(notices(h)).toEqual([])
  // 没有跟进通知（没送达任何工单）。
  expect(h.candidates()).toEqual([message.id])
  // 消息作为候选进入 Eval。
})

it('leaves a delivered follow-up to its ticket\'s worker: the main Session may stop the ticket on it, and route it only once handed back',
  async () => {
  // 已送达的跟进归 worker 决定：主 Session 只能停工单，路由（attach/accept/requeue）须等 worker handback。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const other = await h.acceptedTicket(feishu('3', '@bot 另一件事'))
  const settle = async (id: string, text: string, sender?: string) => {
    const message = followup(id, text, sender ? { sender_id: sender } : {})
    h!.runtime.receive(message); await h!.runtime.idle()
    return message.id
  }
  // 收一条跟进并等它处理完，返回消息 id。
  const master = (name: string, args: Record<string, unknown>) => h!.runTool(h!.runtime.masterId, name, args)
  // 在主 Session 上调用编排工具。
  const decides = /its worker decides whether it belongs there/
  // 主 Session 越权路由时的统一报错文案。
  // A guest's follow-up stays inferred, so its stop does not stop the work; the main Session cannot route or requeue it.
  // 访客的跟进只算推断性授权：其“停下”不停掉工作；主 Session 也不能路由或重排它。
  const guest = await settle('4', '别做了', 'ou_guest')
  expect(await h!.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: guest })).toMatchObject({ decision: 'ignore' })
  await expect(h!.route({ kind: 'accept', trigger_id: guest, title: 'More', worktree_name: 'more', acknowledgement: 'ok' }))
    .rejects.toThrow(decides)
  await expect(master('orchestrator_trigger_requeue', { trigger_id: guest })).rejects.toThrow(decides)
  // A person may still send it to Eval from the panel.
  // 真人可从面板把它送进 Eval。
  expect(await h.api('POST', `triggers/${encodeURIComponent(guest)}/requeue`)).toMatchObject({ status: 200, body: { queued: true } })
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.candidates()).toContain(guest)
  // Alice's follow-ups carry her authority once the worker hands them back: one goes to the other ticket, one becomes new work.
  // Alice 的跟进被 handback 后带上她的授权：一条可挂到别的工单，一条可开成新工作。
  const attach = await settle('5', '这个其实是另一件事的')
  await expect(h!.route({ kind: 'attach', ticket_id: other.ticket.id, trigger_id: attach })).rejects.toThrow(decides)
  await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: attach, reason: 'It is about the other request.' })
  expect(await h!.route({ kind: 'attach', ticket_id: other.ticket.id, trigger_id: attach }))
    .toMatchObject({ ticket: expect.objectContaining({ ticket_id: other.ticket.id }) })
  // handback 后 attach 成功。
  const work = await settle('6', '另外把导出按钮也加上')
  const request = { trigger_id: work, title: '导出按钮', worktree_name: 'export', acknowledgement: '收到，加导出按钮。' }
  await expect(h!.route({ kind: 'accept', ...request })).rejects.toThrow(decides)
  // The attach subscribed the other ticket to this thread, so its worker decides the message too; it is new work once both
  // hand it back.
  // 上一步 attach 已把另一工单订阅到本线程：它的 worker 也要决定这条消息；两边都 handback 后才能开新工作。
  await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: work, reason: 'It asks for an export button.' })
  await expect(h!.route({ kind: 'accept', ...request })).rejects.toThrow(decides)
  await h.runTool(other.sessionId, 'orchestrator_trigger_handback', { trigger_id: work, reason: 'Not this ticket either.' })
  const accepted = await h!.route({ kind: 'accept', ...request })
  expect(h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!.mandate).toMatchObject({ strength: 'explicit' })
  // 新工单的授权强度为 explicit（继承了 Alice 的明确请求）。
  // A stop on a person's request needs no hand-back.
  // 对真人请求的停工不需要 handback。
  const stop = await settle('7', '先停一下')
  expect(await h!.route({ kind: 'stop', ticket_id: ticket.id, trigger_id: stop })).toMatchObject({ decision: 'stop' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
})

/**
 * Count main-session model turns triggered by steers: each steer while idle starts a new turn,
 * whereas all steers arriving while running batch into the next step.
 */
// 统计 steer 触发的主 Session 模型轮次：空闲时的每次 steer 开新轮次；运行中到达的 steer 合并进下一步。
function modelCalls(host: Host) {
  const master = host.agents.get(host.runtime.masterId)!
  const seen: string[] = []
  const steer = master.steer.getMockImplementation() as (message: unknown) => void
  master.steer.mockImplementation((message: unknown) => { seen.push(master.status); steer(message) })
  // 包装原 steer 实现：记录每次 steer 时刻主 Session 的状态。
  return () => seen.filter(status => status === 'idle').length + (seen.includes('running') ? 1 : 0)
  // 空闲 steer 各算一轮；只要出现过运行中 steer，合并算一轮。
}

it('costs the main Session one model call for a burst of follow-ups while it works, and two while it idles', async () => {
  // 批量跟进的模型调用开销：忙时合并为 1 轮，空闲时 2 轮（通知一轮、无候补处理一轮）。
  for (const busy of [true, false]) {
    h = await startRuntime()
    await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
    const master = h.agents.get(h.runtime.masterId)!
    master.status = busy ? 'running' : 'idle'
    // 把主 Session 置为忙/闲两种状态。
    h.deliveries.mockClear()
    const calls = modelCalls(h)
    for (const id of ['2', '3', '4', '5', '6']) h.runtime.receive(followup(id, `第 ${id} 条补充`, { sender_id: 'ou_guest' }))
    await h.runtime.idle()
    expect([notices(h).length, h.candidates().length, calls()]).toEqual([5, 0, busy ? 1 : 2])
    // 5 条通知全发出、不进 Eval；忙时 1 轮、闲时 2 轮。
    await h.stop(); h = undefined
    // 在循环内手动收尾，准备下一状态。
  }
})

it('keeps a follow-up\'s notice in the effect queue until the main Session takes it, and sends it once', async () => {
  // 通知的可靠性：随 intake 事务入库、按 Trigger 键控去重、主 Session 收下后清空队列。
  h = await startRuntime()
  await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.deliveries.mockClear()
  h.agents.get(h.runtime.masterId)!.steer.mockImplementationOnce(() => { throw new Error('session gone') })
  // 第一次 steer 失败：模拟主 Session 暂时不可用。
  const message = followup('2', '补充一点')
  h.runtime.receive(message)
  await h.runtime.idle()
  // The notice is stored with the intake's transaction, keyed by its Trigger, and a duplicate message adds nothing.
  // 通知与 intake 同事务入库，键为 Trigger id；重复消息不产生新条目。
  expect(h.runtime.store.db.prepare("SELECT key FROM effect WHERE kind = 'relay'").all()).toEqual([{ key: `followup:${message.id}` }])
  expect(h.runtime.receive(followup('2', '补充一点'))).toBe('duplicate')
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  // 推进时间触发重试，通知补发。
  expect(notices(h).map(item => item.trigger_id)).toEqual([message.id])
  expect(h.runtime.effects.pending('relay')).toBe(false)
  // 只发一次，队列清空。
})

it('relays a message a worker handed back as a candidate with the worker\'s reason', async () => {
  // handback：消息作为候选转给主 Session 并附 worker 的理由；同一消息不能重复 handback 或挂回原工单。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = followup('2', '另外把导出按钮也加上')
  h.runtime.receive(message)
  await h.runtime.idle()
  expect(await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: message.id, reason: 'It asks for an export button.' }))
    .toEqual({ trigger_id: message.id, queued: true })
  await h.runtime.pump(); await h.runtime.idle()
  // The candidate tells the main Session; no requeue notice comes before it.
  // 候选直接告知主 Session；此前不发任何 requeue 通知。
  const injected = h.agents.get(h.runtime.masterId)!.inject.mock.calls.map(([notice]) => JSON.stringify(notice))
  expect(injected.filter(notice => notice.includes('trigger_requeued'))).toEqual([])
  expect(h.relays(h.runtime.masterId).find(item => item.kind === 'candidate'
    && item.trigger_id === message.id)).toMatchObject({ strength: 'explicit',
    handed_back: [{ trigger_id: message.id, ticket_id: ticket.id, reason: 'It asks for an export button.' }] })
  // 候选卡带 explicit 强度与 handback 记录（含理由）。
  await expect(h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: message.id,
    reason: 'Again' })).rejects.toThrow(/handed that trigger back/)
  // 不能对同一条消息重复 handback。
  // Attaching it back to the ticket that returned it is refused.
  // 不能把它挂回交还它的那个工单。
  await expect(h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: message.id }))
    .rejects.toThrow(/handed that trigger back as beyond it/)
})

it('lets a worker follow a related thread for context, which the main Session hears of without waking, and notes a ticket', async () => {
  // 上下文订阅：worker 可关注相关线程只作背景；新消息不惊动主 Session；主 Session 可给工单留言。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const master = h.agents.get(h.runtime.masterId)!
  master.inject.mockClear(); h.deliveries.mockClear()
  expect(await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github:7',
    reason: 'The issue it fixes.' })).toEqual({ followed: true, thread: 'github:7' })
  await h.runtime.idle()
  expect(h.runtime.store.threads.get('github:7')).toMatchObject({ subscriptions: [ticket.id], context: [ticket.id] })
  // 该线程被订阅，且标记为上下文（context）订阅。
  const text = (message: unknown) => (message as { content: { text: string }[] }).content[0]!.text
  const injected = master.inject.mock.calls.map(([message]) => JSON.parse(text(message)) as Record<string, unknown>)
  expect(injected).toEqual([expect.objectContaining({ thread_followed: { ticket_id: ticket.id, thread: 'github:7',
    reason: 'The issue it fixes.' } })])
  // 主 Session 收到一条“线程已被关注”的注入说明。
  expect(h.relays(h.runtime.masterId)).toEqual([])
  // 没有卡片通知（不打扰）。
  await expect(h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github', reason: 'x' })).rejects.toThrow(/<source>:<id>/)
  // 线程 id 格式不对则拒绝。
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_ticket_note', { ticket_id: ticket.id, text: 'Ticket B renamed the setting.' }))
    .toMatchObject({ reason: 'Noted for the worker' })
  // 主 Session 给工单留言。
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId).map(call => call.text))
    .toEqual([expect.stringContaining('Note from the orchestrator, for context only: Ticket B renamed the setting.')])
  // 留言以“仅供背景参考”的文案投递给 worker。
})

it('takes the message a follow-up answers from its Source kind, whichever kind it is', async () => {
  // repliedTo：优先问来源 kind 的 repliesTo；kind 不支持时退回存储查询。
  h = await startRuntime()
  const parent = feishu('1', 'the earlier message')
  h.runtime.store.triggers.save(parent)
  const reply = { ...feishu('2', 'a reply'), source: 'other' }
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: trigger => trigger.id === reply.id ? parent.id : undefined } },
    reply)).toEqual(parent)
  // kind 的 repliesTo 能认领回复关系。
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: () => undefined } }, reply)).toBeUndefined()
  // kind 认不出则没有答案。
  expect(repliedTo(h.runtime, followup('3', 'yes', { parent_id: 'om_1' }))).toEqual(parent)
  // 真实运行时（飞书 kind）按 parent_id 找到被回复消息。
})

it('tells the main Session of a follow-up to an ended ticket once the ticket resumes, and not when it cannot', async () => {
  // 已结束工单的跟进：处理恢复（工单复活）后才通知主 Session；无法恢复期间不发。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  // 工单已结束。
  // While processing is paused the message waits for the ticket, which has not resumed: the main Session hears nothing yet.
  // 处理被暂停时消息等待工单，而工单尚未恢复：主 Session 先不被告知。
  await h.runtime.settings.pause(true, 'panel')
  h.deliveries.mockClear()
  const message = followup('2', '再改一下标题')
  h.runtime.receive(message); await h.runtime.idle()
  expect(notices(h)).toEqual([])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  // 工单因新消息复活。
  expect(notices(h)).toEqual([expect.objectContaining({ trigger_id: message.id, delivered_to: [expect.objectContaining({ ticket_id: ticket.id })] })])
  // 复活后才发跟进通知。
})

it('tells the main Session nothing of a message it attached to an ended ticket, which resumes for it', async () => {
  // 主 Session 亲自把消息挂到已结束工单：工单为它复活，但不再发通知（它本来就知道）。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  const request = feishu('40', '@bot 上次那个改动还要改一下', { root_id: undefined })
  h.runtime.receive(request); await h.runtime.idle()
  await h.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: request.id })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  // 工单复活。
  expect(notices(h)).toEqual([])
  // 没有额外通知。
})

it('tells the main Session of a follow-up an earlier version queued for Eval, when the queue lets it go', async () => {
  // 兼容迁移：旧版本把跟进同时排进了 Eval 队列；出队时不再评估，改为补发跟进通知。
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const message = followup('2', '顺便看看日志')
  h.deliveries.mockClear()
  // An earlier version delivered the follow-up to the ticket, queued it for Eval as well, and told the main Session nothing.
  // 旧版本的行为：跟进已送达工单、也排进了 Eval 队列、且未告知主 Session。
  h.runtime.store.atomic(() => {
    h!.runtime.store.triggers.save(message)
    h!.runtime.store.triggers.saveDisposition(message.id, { fanout: [ticket.id], at: message.at })
    h!.runtime.store.threads.save({ ...h!.runtime.store.threads.get(THREAD)!, pending: [message.id] })
    // 手工构造旧状态：Trigger 已 fanout、线程队列 pending。
  })
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.threads.get(THREAD)).toMatchObject({ pending: [] })
  expect(notices(h)).toEqual([expect.objectContaining({ trigger_id: message.id, delivered_to: [expect.objectContaining({ ticket_id: ticket.id })] })])
  // 出队后补发通知而不是开启 Eval。
})

it('sends a request on a thread a worker follows only for context to Eval, and marks the worker\'s copy as context', async () => {
  // 仅上下文订阅线程上的正式请求：进 Eval 由主 Session 评估；worker 拿到的是只读背景副本。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: `feishu:${CHAT}:om_9`, reason: 'The same page.' })
  h.deliveries.mockClear()
  const request = feishu('10', '@bot 把这里的按钮也改了', { root_id: 'om_9' })
  h.runtime.receive(request)
  await h.runtime.idle()
  // It is nobody's follow-up: the main Session assesses it, and the worker reads it as context.
  // 它不属于任何工单的跟进：主 Session 评估它，worker 只作背景阅读。
  expect(h.candidates()).toEqual([request.id])
  expect(notices(h)).toEqual([])
  expect(h.runtime.store.triggers.disposition(request.id)).toMatchObject({ fanout: [ticket.id], context: [ticket.id] })
  // 处置记录同时标明 fanout 与 context。
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: request.id, context: true })])
  // worker 收到的副本带 context 标记。
})

it('shows a candidate\'s message as its workers would read it, with the message it answers', async () => {
  // 候选卡的呈现：正文按 worker 所见截断（600 字加省略号）、带字数、被回复消息预览，且不带 triggers 字段。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const long = `另外，${'导出按钮的文案也需要改。'.repeat(60)}`
  const reply = followup('2', long, { parent_id: 'om_1' })
  h.runtime.receive(reply); await h.runtime.idle()
  await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: reply.id, reason: 'Another change.' })
  await h.runtime.pump(); await h.runtime.idle()
  const card = h.relays(h.runtime.masterId).find(item => item.kind === 'candidate' && item.trigger_id === reply.id)!
  expect(card).toMatchObject({ from: 'ou_alice', text: long.slice(0, 600) + '…', chars: long.length, read: `trigger/${reply.id}`,
    replies_to: { trigger_id: ticket.origin.triggerId, preview: '@bot 修一下回归' } })
  expect(card).not.toHaveProperty('triggers')
  // 卡面向人阅读（read 链接），不暴露内部 triggers 列表。
})

it('keeps a listed member\'s request on a ticket\'s thread to that ticket, so it is not done twice', async () => {
  // 基准场景：名单成员在工单自己线程上的点名请求归该工单，避免重复开工。
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下设置页保存按钮的文案'))
  h.deliveries.mockClear()
  // The benchmark's case: an addressed request from a listed member on the ticket's own thread.
  // 基准用例：名单成员在本工单线程上的点名请求。
  const request = followup('2', '@bot [W1-a] 概览页的保存按钮也按同样方式改一下', { mentions: [{ id: 'ou_bot' }] })
  h.runtime.receive(request); await h.runtime.idle()
  // The worker has it and decides; the main Session hears of it and cannot open a second ticket for it.
  // worker 持有并决定这条消息；主 Session 收到通知，但不能为它开第二张工单。
  // worker 持有并决定；主 Session 收到通知但不能为它开第二张工单。
  expect(h.relays(sessionId)).toEqual([expect.objectContaining({ trigger_id: request.id })])
  expect(notices(h)).toEqual([expect.objectContaining({ trigger_id: request.id,
    note: expect.stringContaining('orchestrator_route kind stop') })])
  await expect(h.route({ kind: 'accept', trigger_id: request.id, title: '概览页按钮',
    worktree_name: 'overview-button', acknowledgement: '收到。' })).rejects.toThrow(/its worker decides whether it belongs there/)
  // The worker takes it as within its ticket and says so.
  // worker 认定它属于本工单并确认。
  expect(await h.runTool(sessionId, 'orchestrator_ack', { trigger_id: request.id, text: '收到：概览页的保存按钮也一起改。' }))
    .toMatchObject({ trigger_id: request.id })
  expect(h.runtime.store.tickets.list().map(item => item.id)).toEqual([ticket.id])
  expect(h.candidates()).toEqual([])
  // 仍只有一张工单、零候选。
})

it('leaves a follow-up to its ticket\'s worker after the main Session drops the subscriptions of its thread', async () => {
  // 主 Session 退订线程后，已送达的跟进仍归 worker 决定。
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const request = followup('2', '@bot 另外把导出按钮也加上', { mentions: [{ id: 'ou_bot' }] })
  h.runtime.receive(request); await h.runtime.idle()
  const master = (name: string, args: Record<string, unknown>) => h!.runTool(h!.runtime.masterId, name, args)
  expect(await master('orchestrator_thread_unsubscribe', { thread: THREAD })).toEqual({ removed: true, thread: THREAD })
  // The worker has the message and still decides it, so the main Session cannot open a second ticket for it.
  // worker 已持有该消息并仍由它决定：主 Session 不能为它开第二张工单。
  await expect(h!.route({ kind: 'accept', trigger_id: request.id, title: '导出按钮', worktree_name: 'export',
    acknowledgement: '收到，加导出按钮。' })).rejects.toThrow(/its worker decides whether it belongs there/)
  expect(h.runtime.store.tickets.list().map(item => item.id)).toEqual([ticket.id])
})

it('tells a worker it may hand back a message beyond its ticket or for another one, also when the message resumed it', async () => {
  // 提示文案：恢复工单的消息同样可以 handback（超出工单范围或属于别的工单）。
  expect(inputMessage({ id: 'r', kind: 'resumed', triggerId: 't', at: '' })).toContain('hand it back with orchestrator_trigger_handback')
  // 恢复类输入的消息里带 handback 指引。
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  expect((h.tools.get(sessionId)!.get('orchestrator_trigger_handback') as unknown as { description: string }).description)
    .toContain('beyond this ticket or for another one')
  // 工具描述也说明可交还“超出本工单或属于其他工单”的消息。
})
