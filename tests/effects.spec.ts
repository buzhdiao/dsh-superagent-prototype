/** The durable effect queue: coalescing, per-kind limits, retries with backoff, health and shutdown. */
// 本文件覆盖 src/app/effects.ts 的持久化副作用队列：同键合并、按 kind 的并发上限、
// 带退避的重试、健康上报、drain/重启续跑。测试策略：用真实 SQLite Store + 可控假时钟，
// 以 deferred 把 handler 挂起，精确观察调度顺序与重试节奏。
import { mkdtempSync, rmSync } from 'node:fs'
// 临时目录的创建与清理。
import { tmpdir } from 'node:os'
// 系统临时目录。
import { join } from 'node:path'
// 路径拼接。
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
// vitest 测试原语；vi.waitFor 轮询异步条件。
import { Effects, Later } from '../src/app/effects.ts'
// 被测模块：Effects 副作用队列；Later 是 handler 请求“稍后再来”的非失败信号。
import { Store } from '../src/app/store.ts'
// Store：SQLite 存储，队列条目持久化其中。
import { HealthBoard } from '../src/infra/health.ts'
// HealthBoard：健康状态板，队列按 kind 上报状态。
import { deferred } from './fixtures/async.ts'
// deferred：可手动 resolve 的 Promise 工具。

let directory: string
// 每用例的临时目录。
let store: Store
// 队列背后的存储。
let clock: number
// 假时钟（毫秒），Effects 用它决定重试到期。
let board: HealthBoard
let health: Readonly<Record<string, unknown>>
// 健康板与其只读快照（board.all 是响应式读取口）。
let effects: Effects
// 被测队列实例。
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'effects-'))
  store = new Store(join(directory, 'db.sqlite'))
  // 真实 SQLite，验证持久化语义。
  clock = Date.parse('2026-09-09T00:00:00Z')
  board = new HealthBoard()
  health = board.all
  effects = new Effects(store, board, () => clock)
  // 注入假时钟，使重试间隔可精确推进。
  effects.start()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
// 关库并清理临时目录。
const relay = (text: string) => ({ text })
// 构造负载的小工厂。

it('runs an effect queued inside a transaction once it commits, and none from a transaction that rolled back', async () => {
  // 事务语义：入队与事务同生共死——提交后才可运行，回滚的入队作废。
  const run = vi.fn(async () => {})
  effects.handle('relay', run)
  store.atomic(() => { effects.enqueue('relay', 'kept', relay('a')) })
  // 事务内入队 'kept' 并正常提交。
  expect(() => store.atomic(() => { effects.enqueue('relay', 'dropped', relay('b')); throw new Error('rolled back') })).toThrow('rolled back')
  // 事务内入队 'dropped' 后回滚。
  await effects.idle()
  expect(run.mock.calls).toEqual([[relay('a'), 'kept']])
  // 只执行了提交事务里的那条，负载与键原样。
  expect(effects.pending('relay')).toBe(false)
  // 队列清空：回滚条目未残留。
})

it('keeps one effect per key with the latest payload, and runs it again when a new payload arrives while it runs', async () => {
  // 同键合并：运行中只保留最新负载；运行中到达的新负载会再跑一次。
  const hold = deferred()
  const run = vi.fn(async (payload: { text: string }) => { if (payload.text === 'first') await hold.promise })
  // 首次执行挂起，用于制造“运行中”窗口。
  effects.handle('relay', run)
  effects.enqueue('relay', 'k', relay('first'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  // 等首次执行真正开始。
  effects.enqueue('relay', 'k', relay('second')); effects.enqueue('relay', 'k', relay('third'))
  // 运行中连入两次：second 应被 third 合并掉。
  hold.resolve()
  await effects.idle()
  expect(run.mock.calls.map(([payload]) => payload.text)).toEqual(['first', 'third'])
  // 顺序是 first（旧负载跑完）→ third（最新负载重跑），second 被合并。
})

it('runs a kind oldest first, as many at once as its limit allows, and holds it while the limit is 0', async () => {
  // 并发上限：按入队先后启动至多 limit 个；limit 归零时暂停放行，恢复后继续。
  const holds = new Map<string, ReturnType<typeof deferred<void>>>()
  let limit = 2
  const run = vi.fn(async (_payload: unknown, key: string) => { const hold = deferred(); holds.set(key, hold); await hold.promise })
  // 每次执行都挂起，记录其 deferred 以便手动放行。
  effects.handle('launch', run, { limit: () => limit })
  for (const key of ['a', 'b', 'c']) effects.enqueue('launch', key, { ticketId: key, assignmentId: key })
  await vi.waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(['a', 'b']))
  // limit=2：先启动 a、b，c 等待。
  limit = 0
  holds.get('a')!.resolve()
  await vi.waitFor(() => expect(effects.pending('launch', 'a')).toBe(false))
  // a 完成；此刻上限为 0。
  effects.kick(); await Promise.resolve()
  expect(run).toHaveBeenCalledTimes(2)
  // 即使手动 kick，limit=0 也不放行 c。
  limit = 2
  holds.get('b')!.resolve()
  await vi.waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(['a', 'b', 'c']))
  // 恢复上限并完成 b：c 立即启动。
  holds.get('c')!.resolve()
  await effects.idle()
})

it('keeps an effect\'s place in its queue when it is queued again with a new payload', async () => {
  // 同键重复入队不改其在队列中的位置（保持首次入队的次序）。
  const run = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
  let room = 0
  effects.handle('launch', run, { limit: () => room })
  store.atomic(() => {
    effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
    effects.enqueue('launch', 'second', { ticketId: 't2', assignmentId: 'a2' })
    effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
    // first 在 second 之后再次入队。
  })
  await effects.idle()
  room = 1
  await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second'])
  // 放行一个时先跑 first：重复入队没有把它排到 second 后面。
})

it('retries a failed effect after a delay that doubles up to its maximum, and reports the kind in error after three failures', async () => {
  // 重试：延迟按 1s→2s→3s(封顶) 翻倍；连续三次失败后健康转 error；成功后恢复 ready。
  let fail = true
  const run = vi.fn(async () => { if (fail) throw new Error('session busy') })
  effects.handle('notice', run, { retry: [1000, 3000] })
  // 退避序列：首延迟 1s，封顶 3s。
  effects.enqueue('notice', 'prompts', { value: { prompt_config_saved: 2 }, summary: 'Prompt configuration saved' })
  await effects.idle()
  expect(health.notice).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  // 首次失败后：kind 仍 ready，但报有一条在等待（含时间戳）。
  for (const wait of [1000, 2000, 3000, 3000]) {
    clock += wait - 1; await effects.idle()
    const calls = run.mock.calls.length
    clock += 1; await effects.idle()
    expect(run).toHaveBeenCalledTimes(calls + 1)
    // 差 1ms 不触发、加满整段才触发：验证延迟精确到毫秒。
    if (wait === 2000) expect(health.notice).toMatchObject({ state: 'error', detail: expect.stringContaining('1 waiting since 2026-09-09T00:00:00.000Z; the last failure: Error: session busy') })
    // 第三次失败（延迟 2s 后那次）已达到阈值：健康转 error 并附最后失败原因。
  }
  fail = false
  clock += 3000; await effects.idle()
  expect(health.notice).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
  // 成功后健康恢复 ready 且无等待。
  expect(effects.pending('notice')).toBe(false)
})

it('starts nothing once drained, keeps what waits and what shutdown cut short, and runs it after the next start', async () => {
  // drain：停掉在跑的、不再启动新的，但保留等待中的条目；重启后接着跑。
  const hold = deferred()
  effects.handle('relay', async () => { await hold.promise; throw new Error('aborted') })
  effects.enqueue('relay', 'cut', relay('a'))
  await vi.waitFor(() => expect(effects.pending('relay', 'cut')).toBe(true))
  // 'cut' 已在运行中（pending 标志在开始时仍为真）。
  await Promise.resolve()
  const drained = effects.drain()
  effects.enqueue('relay', 'later', relay('b'))
  // drain 过程中再入队 'later'：不被启动。
  hold.resolve(); await drained
  const next = new Effects(store, new HealthBoard(), () => clock)
  // 新实例模拟进程重启（同一 Store）。
  next.start()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => {})
  next.handle('relay', run)
  await next.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['cut', 'later'])
  // 重启后被中断的 'cut' 与等待中的 'later' 都被重跑。
})

it('lets a handler defer an effect without a failure, until a later dispatch after its first delay', async () => {
  // Later：handler 请求延后不算失败——健康仍 ready，按首段延迟重派。
  let later = true
  const run = vi.fn(async () => { if (later) throw new Later('paused') })
  effects.handle('launch', run, { retry: [5000, 60_000] })
  effects.enqueue('launch', 'a', { ticketId: 't', assignmentId: 'a' })
  await effects.idle()
  expect(health.launch).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  // Later 不触发错误态：kind 保持 ready，仅报等待中。
  later = false
  clock += 4999; await effects.idle()
  expect(run).toHaveBeenCalledOnce()
  // 差 1ms 未到期：不重派。
  clock += 1; await effects.idle()
  expect(run).toHaveBeenCalledTimes(2)
  // 满 5s 后重派成功。
  expect(effects.pending('launch')).toBe(false)
})

it('runs an ordered kind one at a time in the order queued, and holds the later effects while an earlier one fails', async () => {
  // ordered kind：严格串行按入队顺序；前面失败重试期间后面一律等待。
  const failing = new Set(['first'])
  const run = vi.fn(async (_payload: { text: string }, key: string) => { if (failing.has(key)) throw new Error('offline') })
  effects.handle('relay', run, { ordered: true, limit: () => 4, retry: [1000, 1000] })
  // limit=4 也无效：ordered 一次只跑一个。
  effects.enqueue('relay', 'first', relay('a')); effects.enqueue('relay', 'second', relay('b'))
  await effects.idle()
  clock += 1000; await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'first'])
  // 1s 后只重试了 first，second 仍被挡住。
  failing.clear()
  clock += 1000; await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'first', 'first', 'second'])
  // first 第三次成功后，second 才被启动。
})

it('keeps a quiet kind\'s failures out of its health, and asks no limit while nothing is due', async () => {
  // quiet kind：失败不上健康板；空队时不调用 limit 回调（避免无谓开销）。
  const limit = vi.fn(() => 4)
  effects.handle('delivery', async () => { throw new Error('Session gone') }, { quiet: true, limit, retry: [1000, 1000] })
  effects.kick(); await effects.idle()
  expect(limit).not.toHaveBeenCalled()
  // 没有到期条目就不询问 limit。
  effects.enqueue('delivery', 't', { ticketId: 't' })
  for (let attempt = 0; attempt < 4; attempt++) { await effects.idle(); clock += 1000 }
  // 连续失败并重试数轮。
  expect(health.delivery).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  // quiet：即使反复失败，健康仍报 ready（等待中），不进 error。
})

it('keeps an effect cancelled and queued again while its first run goes on, which the first run does not end', async () => {
  // 运行中取消+重入队：取消不打断正在跑的首次执行；新负载再跑一次。
  const hold = deferred<void>()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => { if (run.mock.calls.length === 1) await hold.promise })
  effects.handle('relay', run)
  effects.enqueue('relay', 'k', relay('first'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  effects.cancel('relay', 'k')
  effects.enqueue('relay', 'k', relay('second'))
  // 首次仍在跑时取消并重入队。
  hold.resolve()
  await effects.idle()
  expect(run.mock.calls.map(([payload]) => payload.text)).toEqual(['first', 'second'])
  // 首次（旧负载）跑完后，second 负载再跑一次。
  expect(effects.pending('relay')).toBe(false)
})

it('queues an effect after a restart behind the ones that waited, for a kind that keeps its order', async () => {
  // ordered kind 重启：序号跨重启延续，重启后新入队的条目排在既有等待者之后。
  const hold = deferred<void>()
  effects.handle('relay', async () => { await hold.promise; throw new Error('aborted') }, { ordered: true })
  effects.enqueue('relay', 'first', relay('a'))
  effects.enqueue('relay', 'second', relay('b'))
  await vi.waitFor(() => expect(effects.pending('relay', 'first')).toBe(true))
  const drained = effects.drain()
  hold.resolve(); await drained
  // Sequence numbers continue across restarts so newly queued effects run after existing pending ones.
  // 序号跨重启延续：重启后新入队的条目要排在等待中的旧条目之后。
  const next = new Effects(store, new HealthBoard(), () => clock)
  next.enqueue('relay', 'third', relay('c'))
  // 先入队 third（模拟重启间隙到达的消息），再 start。
  next.start()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => {})
  next.handle('relay', run, { ordered: true })
  await next.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second', 'third'])
  // 顺序：等待中的 first、second 在前，重启后入队的 third 在后。
})

it('reports a failure of the queue itself under its kind, until a dispatch of that kind succeeds again', async () => {
  // 队列自身故障（如 limit 回调抛错）记到对应 kind 名下；该 kind 派发成功后恢复 ready。
  let broken = true
  effects.handle('relay', async () => {}, { limit: () => { if (broken) throw new Error('database is locked'); return 1 } })
  effects.enqueue('relay', 'k', relay('a'))
  await effects.idle()
  expect(health.relay).toMatchObject({ state: 'error', detail: 'The effect queue failed: Error: database is locked' })
  // limit 抛错被记为该 kind 的队列故障。
  broken = false
  effects.kick()
  await effects.idle()
  expect(health.relay).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
  // 恢复后照常派发并回到 ready。
})

it('refuses a second handler for a kind', () => {
  // 一个 kind 只允许注册一个 handler，重复注册直接报错。
  effects.handle('relay', async () => {})
  expect(() => effects.handle('relay', async () => {})).toThrow('The relay effects already have a handler')
})
