/**
 * Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
 * Effects reschedules the row after the initial retry delay without incrementing its failure count, and DshExecutor throws it from launch and delivery handlers.
 */
// "稍后再试"信号错误（Later）：表示某个副作用（effect，效果）当前无法执行，例如处理暂停中或 worker 名额已满。
// Effects 会在初始重试延迟后重新调度该行且不累计失败次数；DshExecutor 的 launch 与 delivery 处理器也会抛出它。
export class Later extends Error {}
/** Consecutive failures before an effect kind reports an error, matching the Sources poll failure threshold. */
// 某类效果（effect kind）连续失败达到该次数才在健康面板上报错误；与 Sources 轮询失败阈值保持一致
export const FAILURES_BEFORE_ERROR = 3
// HealthBoard/HealthEntry：健康面板类型（按效果类别登记健康条目）
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
// Store：持久化存储（效果队列表存于其 SQLite 中）
import type { Store } from './store.ts'

// EffectPayloads：各类效果的载荷（payload）定义，键为效果类别（kind）
export interface EffectPayloads {
  /** Build an Eval's candidate card and relay it to the main Session; the key is the Eval ID. */
  // 评估（assessment）：构建评估候选卡并转发给主 Session；键为评估 ID
  assessment: { triggerId: string }
  /** Launch a pending Assignment; the key is the Assignment ID. */
  // 启动（launch）：启动一条待执行的派工（Assignment）；键为派工 ID
  launch: { ticketId: string; assignmentId: string }
  /** Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket ID. */
  // 投递（delivery）：把工单处于等待的输入（Input）交给其运行中的派工；键为工单 ID
  delivery: { ticketId: string }
  /** Steer a report or a candidate into the main Session; the key is the request ID. */
  // 转达（relay）：把报告或候选"插话"进主 Session；键为请求 ID
  relay: { text: string }
  /** Inject a notice into the main Session without waking it; the key names what it reports, such as `prompts`. */
  // 通知（notice）：向主 Session 注入一条通知但不唤醒它；键说明通知内容，如 `prompts`
  notice: { value: Record<string, unknown>; summary: string }
  /** Send a message for a Channel through its Source; the key is the message ID, whose receipt the Outbox keeps. */
  // 回复（reply）：经数据源（Source）向渠道（Channel）发送消息；键为消息 ID，其回执（receipt）由 Outbox 保存
  reply: Record<string, never>
}
// EffectKind：全部效果类别名的联合类型
export type EffectKind = keyof EffectPayloads
// Handler：单个效果类别的处理器契约
interface Handler<K extends EffectKind> {
  // 执行该效果：接收载荷与键
  run: (payload: EffectPayloads[K], key: string) => Promise<void>
  /** How many may run at once now; 0 holds the kind, such as while processing is paused. */
  // 当前允许并发运行的个数；返回 0 表示挂起该类别（例如处理暂停期间）
  limit: () => number
  /** Initial and maximum retry backoff delays, in milliseconds. */
  // 重试退避的初始与最大延迟（毫秒）
  retry: readonly [number, number]
  /** Effects run one at a time in queue order, and a failed one holds back later rows of the same kind. */
  // 有序模式：同一类别一次只跑一个、严格按队列顺序，失败的那条会阻塞其后同类行
  ordered: boolean
  /** When true, repeated failures do not mark the effect kind's health entry as `error` (used when failures are already surfaced on a ticket). */
  // quiet 为 true 时，反复失败不会把该类别的健康条目标为 `error`（用于失败已在工单上呈现的场景）
  quiet: boolean
}
// Options：注册处理器时的可选项（全部可选，未给的用默认值）
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>
/** `seq` preserves the row's queue position; `generation` increments on payload updates so a running attempt does not delete a newer payload. */
// Row：效果队列表中的一行。seq 保留排队位置；generation 在载荷更新时自增，
// 使仍在运行的旧尝试不会误删或覆盖更新后的载荷；attempts 为失败次数、due 为下次到期时间
interface Row { key: string; value: string; seq: number; generation: number; attempts: number; due: number }
// Task：一次运行中的效果任务（done 用于等待其完成）
type Task = { kind: EffectKind; key: string; done: Promise<void> }

/**
 * Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
 * Coordinates per-kind handlers, concurrency limits, exponential backoff, and health reporting for MasterAssessor, DshExecutor, Sessions, and Outbox.
 */
// Effects：基于 SQLite 的持久化副作用队列——效果行在命令事务内写入，事务提交后再派发执行。
// 为 MasterAssessor、DshExecutor、Sessions 与 Outbox 协调各类处理器、并发上限、指数退避与健康上报。
export class Effects {
  // 各效果类别的处理器注册表（以 never 泛型擦除存储，运行时再断言回具体类型）
  private readonly handlers = new Map<EffectKind, Handler<never>>()
  // 各效果类别在健康面板中的条目
  private readonly health = new Map<EffectKind, HealthEntry>()
  // 当前运行中的任务集合
  private readonly tasks = new Set<Task>()
  /** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
  // 上次派发失败的类别集合；下一次派发成功时会刷新其健康状态
  private readonly broken = new Set<EffectKind>()
  // 全局行序号：保证入队顺序（重启时从表中恢复最大值继续递增）
  private seq: number
  // 是否已有一次派发被排入微任务队列（合并同一轮事件循环内的多次 kick）
  private scheduled = false
  /** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
  // 效果只在 start 与 drain 之间运行；start 之前入队的行会等待（例如初始化尚未完成时）
  private started = false
  // drain 之后置位：不再启动新任务
  private stopped = false
  constructor(private readonly store: Store, private readonly board: Pick<HealthBoard, 'claim'>, private readonly now = () => Date.now()) {
    // 启动时从表中恢复最大序号，保证重启后 seq 仍单调递增
    this.seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  }
  /** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
  // 在调用方事务内 upsert 一条效果：与同类同键的等待行合并（更新载荷并重置尝试次数），同时保留其原排队位置（seq 不变）
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    // INSERT ... ON CONFLICT：新行直接插入；同类同键已存在时更新载荷、generation+1、清零尝试与错误、刷新到期时间
    this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString())
    // 入队后踢一下调度器
    this.kick()
  }
  // 注册某效果类别的处理器（重复注册报错），并领取其健康条目
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options: Options<K> = {}): void {
    // 同一类别不允许注册两个处理器
    if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`)
    // 从健康面板领取（或复用）该类别的健康条目
    this.health.set(kind, this.board.claim(kind))
    // 选项默认值：并发 1、退避 2s→60s、无序、不静默
    const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options
    // 有序类别强制并发上限为 1（limit 与 1 取小）；存入注册表（类型断言抹平泛型差异）
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet } as unknown as Handler<never>)
    // 立即按当前队列状态刷新一次健康
    this.report(kind)
    // 注册后踢一下调度器，让积压行有机会运行
    this.kick()
  }
  // 查询是否还有待处理的效果（可按类别，或精确到类别+键）
  pending(kind: EffectKind, key?: string): boolean {
    // 不给键：查该类别是否存在任意行；给键：查该类别+键是否存在
    return key === undefined ? !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) : !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key)
  }
  /** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
  // 按类别与键删除排队中的行；若该效果已在运行，则让当次尝试正常跑完（删除只影响未开始的行）
  cancel(kind: EffectKind, key: string): void {
    // 直接删除队列行
    this.store.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key)
    // 提交后刷新该类别的健康状态（等待行数发生变化）
    this.store.afterCommit(() => { this.report(kind) })
  }
  // 开始运行效果（此前入队的行此时才被派发）
  start(): void { this.started = true; this.kick() }
  // kick：把一次派发合并进微任务——同一轮事件循环内的多次触发只派发一次
  kick(): void {
    // 已排程则直接返回
    if (this.scheduled) return
    // 标记已排程
    this.scheduled = true
    // 微任务中清标记并执行派发（等同步代码全部入队完毕后再统一调度）
    queueMicrotask(() => { this.scheduled = false; this.dispatch() })
  }
  /** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
  // 等待空闲：直到指定类别（缺省为全部类别）没有正在运行的效果、且没有任何可启动的效果为止
  async idle(kind?: EffectKind): Promise<void> {
    // 循环：派发 → 收集运行中任务的 done Promise → 全部等完再复查（等待期间可能有新任务启动）
    for (;;) {
      // 先主动派发一次（可能因 limit/到期而无事可做）
      this.dispatch()
      // 取当前运行中（可按类别过滤）任务的完成信号
      const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done)
      // 没有运行中的即视为空闲
      if (!running.length) return
      // 等全部结束（allSettled：个别失败也不中断等待）
      await Promise.allSettled(running)
    }
  }
  /** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
  // 停机排水：不再启动新效果，等待运行中的结束；仍在排队的行留在 SQLite 里等下次 start
  async drain(): Promise<void> {
    // 置停止标志（此后 dispatch 直接返回）
    this.stopped = true
    // 等待所有运行中的任务结束
    await Promise.allSettled([...this.tasks].map(task => task.done))
  }
  // dispatch：按类别逐个检查队列，启动到期且有空余配额的效果
  private dispatch(): void {
    // 未 start 或已 drain：不派发
    if (!this.started || this.stopped) return
    // 遍历全部已注册的类别
    for (const [kind, handler] of this.handlers) {
      try {
        // 统计该类别正在运行的键集合
        const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key))
        // Ordered kinds block behind their oldest row even when it is not yet due; limit() is queried only after ready rows exist.
        // 取行策略：有序类别只看最老的一行（即使未到期也阻塞后续行，保证严格顺序）；
        // 无序类别取所有到期行（上限 16 + 当前运行数，避免一次拉取过多）
        const rows = (handler.ordered
          ? this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1').all(kind)
          : this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?')
            .all(kind, this.now(), 16 + running.size)) as unknown as Row[]
        // 可启动行：有序类别若已有运行中的则本批不启动（保持串行）；否则过滤出"已到期且不在运行中"的行
        const ready = handler.ordered && running.size ? [] : rows.filter(row => row.due <= this.now() && !running.has(row.key))
        // 剩余并发配额：无可启动行时不询问 limit()（保持"0 表示挂起"的语义）
        let room = ready.length ? handler.limit() - running.size : 0
        // 逐个启动可运行行，直到配额耗尽
        for (const row of ready) {
          // 配额用尽即停止启动
          if (room-- <= 0) break
          // 启动该行的执行任务
          this.run(kind, handler, row)
        }
        // 若该类别此前处于 broken（派发失败）状态且本轮未再抛错，则移除标记并刷新健康
        if (this.broken.delete(kind)) this.report(kind)
      } catch (error) { this.failed(kind, error) }
    }
  }
  // run：把一行包装为运行中的任务并登记（结束时自动清理并再次 kick）
  private run(kind: EffectKind, handler: Handler<never>, row: Row): void {
    // 先建任务占位（done 稍后被真实 Promise 覆盖，避免 finally 回调里引用不到自身）
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    // 执行尝试：失败则记录健康错误；结束（无论成败）时把任务移出集合并踢调度器
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.failed(kind, error) })
      .finally(() => { this.tasks.delete(task); this.kick() })
    // 登记为运行中的任务
    this.tasks.add(task)
  }
  // attempt：单次执行尝试（含成功删除与各类失败回退的数据库收尾）
  private async attempt(kind: EffectKind, handler: Handler<never>, row: Row): Promise<void> {
    // 捕获执行失败（不在此处抛出，避免影响收尾逻辑）
    let failure: { error: unknown } | undefined
    try { await handler.run(JSON.parse(row.value) as never, row.key) } catch (error) { failure = { error } }
    // Match seq and generation so a row replaced or re-queued while running is not overwritten.
    // 收尾条件带上 seq 与 generation：运行期间该行若被更新（新载荷）或重新入队，旧尝试不得覆盖新状态
    const own = 'kind = ? AND key = ? AND seq = ? AND generation = ?', ownRow = [kind, row.key, row.seq, row.generation] as const
    // 执行成功：删除队列行（条件匹配才删）
    if (!failure) this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow)
    // Leave running rows untouched on shutdown so they retry on the next start.
    // 失败但正处于停机：保持队列行原样不动，留给下次 start 时重试
    else if (this.stopped) return
    // Later 信号：不累计失败次数，仅按初始退避延迟推后到期时间
    else if (failure.error instanceof Later) {
      this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow)
    } else {
      // 一般失败：指数退避（初始 × 2^尝试次数，封顶最大延迟，指数最多取 16）
      const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16))
      // 累计尝试次数、记录错误文本（截断到 1000 字符）并推后到期时间
      this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`)
        .run(String(failure.error).slice(0, 1000), this.now() + delay, ...ownRow)
    }
    // 停机期间不刷新健康（避免停机过程中的误报）
    if (!this.stopped) this.report(kind)
  }
  // failed：派发/执行本身抛错时的兜底——标记类别为 broken 并在健康面板上报错误
  private failed(kind: EffectKind, error: unknown): void {
    // 加入 broken 集合（下次派发成功时移除并刷新）
    this.broken.add(kind)
    // 健康条目置为 error，附错误文本与时间
    this.health.get(kind)?.set({ state: 'error', detail: `The effect queue failed: ${String(error)}`, at: new Date(this.now()).toISOString() })
  }
  // report：按队列现状刷新某类别的健康条目（等待数、最早入队时间、最大尝试次数、最近错误）
  private report(kind: EffectKind): void {
    // 一条 SQL 汇总：等待行数、最早 since、最大 attempts、最近一条有失败的错误文本
    const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind)
    // 等待行数
    const waiting = Number(row?.waiting ?? 0)
    // 是否判定为失败状态：最大尝试次数达到阈值，且该类别未标记 quiet
    const failing = Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR && !this.handlers.get(kind)?.quiet
    // 基础描述：有等待行时给出数量与最早入队时间，否则"没有等待"
    const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : 'Nothing waiting'
    // 写入健康条目：失败态附最近一次错误；否则为就绪态
    this.health.get(kind)?.set(failing
      ? { state: 'error', detail: `${detail}; the last failure: ${String(row?.error)}`, at: new Date(this.now()).toISOString() }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() })
  }
}
