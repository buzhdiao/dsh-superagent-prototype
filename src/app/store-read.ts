/** Read-only Store queries for views, tools, and Source polling. */
// Store 的只读查询集合：供视图、工具与数据源（Source）轮询使用。
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Decision, Thread, Trigger } from '../core/index.ts'
// Dropped：已放弃的回复记录；Receipt：出站回执；TimelinePlace：时间线定位（at+id）
import type { Dropped, Receipt, TimelinePlace } from './store.ts'

// storeReads：基于 SQLite 连接构建全部只读查询
export function storeReads(db: DatabaseSync) {
  // values：执行 SQL 并把每行的 value 列（JSON 文本）反序列化为对象数组
  const values = <T>(sql: string, ...parameters: SQLInputValue[]): T[] => db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  return {
  /** Newest first by arrival (`rowid`) order rather than trigger timestamp. */
  // 最近触发器：按到达顺序（rowid）倒序，而非触发时间戳（保序入队顺序）
  recentTriggers: (offset = 0, limit = 50): Trigger[] => db.prepare('SELECT value FROM trigger ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Trigger),
  /** Per-source trigger counts since `since`, plus the latest arrival timestamp across all time. */
  // 按数据源统计：自 since 以来的触发数与被过滤数，以及全部时间的最近到达时间
  triggerStats: (since: string): Record<string, { received: number; filtered: number; lastAt: string }> => {
    // 结果表
    const result: Record<string, { received: number; filtered: number; lastAt: string }> = {}
    // 一条聚合 SQL：按 source 分组，左连处置表统计过滤数
    for (const row of db.prepare("SELECT json_extract(t.value, '$.source') AS source, MAX(t.at) AS last, SUM(t.at >= ?) AS received, SUM(t.at >= ? AND json_extract(d.value, '$.filtered') IS NOT NULL) AS filtered FROM trigger t LEFT JOIN disposition d ON d.id = t.id GROUP BY source").all(since, since))
      // 逐源填入结果（缺失以 0/空串兜底）
      result[String(row.source)] = { received: Number(row.received ?? 0), filtered: Number(row.filtered ?? 0), lastAt: String(row.last ?? '') }
    return result
  },
  /**
   * Counts triggers arriving at or after `since` that passed source filtering and reached a decision,
   * and how many accept/reopen decisions those same arrivals produced.
   */
  // flow：统计自 since 以来"通过源过滤且到达决策"的触发器数（judged），以及这些到达产生的 accept/reopen 决策数（accepted）
  flow: (since: string): { judged: number; accepted: number } => {
    // passed：通过过滤的触发器条件片段（两条查询复用）
    const passed = "t.at >= ? AND NOT EXISTS (SELECT 1 FROM disposition s WHERE s.id = t.id AND json_extract(s.value, '$.filtered') IS NOT NULL)"
    // judged：在决策的 triggerIds 中出现且通过过滤的去重触发器数
    const judged = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE ${passed}`).get(since)
    // accepted：限 since 后到达的触发器中，产生 accept/reopen 决策的去重决策数
    const accepted = db.prepare(`SELECT COUNT(DISTINCT d.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE json_extract(d.value, '$.kind') IN ('accept', 'reopen') AND t.at >= ?`).get(since)
    return { judged: Number(judged?.n ?? 0), accepted: Number(accepted?.n ?? 0) }
  },
  // triggers：按条件（来源 / 是否被过滤）筛选触发器并分页；more 表示还有更多
  triggers: (options: { source?: string; filtered?: boolean }, offset = 0, limit = 50): { items: Trigger[]; more: boolean } => {
    // 动态拼 WHERE 条件
    const where = [...(options.source ? ["json_extract(t.value, '$.source') = ?"] : []), ...(options.filtered ? ["json_extract(d.value, '$.filtered') IS NOT NULL"] : [])]
    // 多取一条用于判断 more
    const rows = db.prepare(`SELECT t.value FROM trigger t LEFT JOIN disposition d ON d.id = t.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.at DESC LIMIT ? OFFSET ?`).all(...(options.source ? [options.source] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Trigger), more: rows.length > limit }
  },
  /** Latest `limit` triggers on a thread returned oldest-first, optionally bounded before (or through) `before`. */
  // 线程上最近 limit 条触发器，按旧→新返回；可选以 before 为界（through 表示含边界）
  threadTriggers: (threadKeyValue: string, limit = 50, before?: TimelinePlace, through = false): Trigger[] => {
    // 边界条件片段：(at,id) 元组比较
    const place = before ? `AND (x.at, x.id) ${through ? '<=' : '<'} (?, ?)` : ''
    // 按 (at,id) 倒序取 limit 条再整体反转（得到旧→新）
    return values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${place}
      ORDER BY x.at DESC, x.id DESC LIMIT ?`, threadKeyValue, ...before ? [before.at, before.id] : [], limit).reverse()
  },
  // 线程触发器分页（新→旧）
  threadPage: (threadKeyValue: string, offset: number, limit: number): Trigger[] => values(`SELECT t.value FROM trigger_thread x
    JOIN trigger t ON t.id = x.id WHERE x.thread = ? ORDER BY x.at DESC, t.rowid DESC LIMIT ? OFFSET ?`, threadKeyValue, limit, offset),
  /** Nearest non-CI triggers on a thread immediately before and after `(at, id)`. */
  // 线程上紧邻 (at,id) 前后的非 CI 触发器
  neighbours: (threadKeyValue: string, at: string, id: string): { before?: Trigger; after?: Trigger } => {
    // nearest：按方向取相邻一条（排除 CI 触发器；排序方向随比较方向翻转）
    const nearest = (side: '<' | '>') => values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id
      WHERE x.thread = ? AND (x.at, x.id) ${side} (?, ?) AND json_extract(t.value, '$.meta.ci') IS NULL
      ORDER BY x.at ${side === '<' ? 'DESC' : 'ASC'}, x.id ${side === '<' ? 'DESC' : 'ASC'} LIMIT 1`, threadKeyValue, at, id)[0]
    // 前后各取一条
    const before = nearest('<'), after = nearest('>')
    // 只带存在的方向
    return { ...before ? { before } : {}, ...after ? { after } : {} }
  },
  /** Oldest trigger on a thread, used to title the thread in listings. */
  // 线程上最早的触发器：用于列表中的线程标题（humanOnly 限人工触发）
  firstTrigger: (threadKeyValue: string, humanOnly = false): Trigger | undefined => {
    const row = db.prepare(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${humanOnly ? 'AND x.human = 1' : ''} ORDER BY x.at ASC, t.rowid ASC LIMIT 1`).get(threadKeyValue)
    return row ? JSON.parse(String(row.value)) as Trigger : undefined
  },
  // search：按 id、URL 前缀、消息 id 或文本模糊搜索触发器（LIKE 通配符已转义）
  search: (query: string, limit = 20): Trigger[] => {
    // 构造转义后的模糊匹配模式
    const pattern = `%${query.replace(/[\\%_]/g, match => `\\${match}`)}%`
    // 一条 SQL 兼顾：精确 id / URL LIKE / 消息 id 精确 / 文本模糊
    return db.prepare("SELECT value FROM trigger WHERE id = ? OR json_extract(value, '$.url') LIKE ? ESCAPE '\\' OR json_extract(value, '$.meta.messageId') = ? OR json_extract(value, '$.text') LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?").all(query, `${query.replace(/[\\%_]/g, match => `\\${match}`)}%`, query, pattern, limit).map(row => JSON.parse(String(row.value)) as Trigger)
  },
  // 最近决策（按到达序倒序，分页）
  recentDecisions: (offset = 0, limit = 50): Decision[] => db.prepare('SELECT value FROM decision ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Decision),
  /** Decisions matching `kinds` whose triggers arrived at or after `since`, aligned with `flow` window counts. */
  // 按种类与时间窗筛选决策（分页；时间窗口径与 flow 一致）
  decisions: (options: { kinds: string[]; since: string }, offset: number, limit: number): { items: Decision[]; more: boolean } => {
    // 动态 WHERE：种类 IN (...) + 存在 since 之后到达的触发器
    const where = [...(options.kinds.length ? [`json_extract(d.value, '$.kind') IN (${options.kinds.map(() => '?').join(',')})`] : []),
      ...(options.since ? ["EXISTS (SELECT 1 FROM json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE t.at >= ?)"] : [])]
    // 多取一条判断 more
    const rows = db.prepare(`SELECT d.value FROM decision d ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.rowid DESC LIMIT ? OFFSET ?`)
      .all(...options.kinds, ...(options.since ? [options.since] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Decision), more: rows.length > limit }
  },
  /** Newest decisions of the given kinds, for surfaces that must surface rare outcomes among many ignores. */
  // 给定种类中最近的决策：用于在大量"忽略"中凸显少见结局（如错误/失败）
  decisionsOfKinds: (kinds: string[], limit = 30): Decision[] => db.prepare(`SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (${kinds.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT ?`).all(...kinds, limit).map(row => JSON.parse(String(row.value)) as Decision),
  /** Messages whose `reply` effect failed, with consecutive failure count and last error, oldest first. */
  // 投递失败的回复消息：附连续失败次数与最近错误，按队列序从旧到新
  failingReplies: (): (Receipt & { attempts: number; error: string })[] => db.prepare(`SELECT o.value, e.attempts, e.error FROM effect e
    JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 ORDER BY e.seq`).all()
    .map(row => ({ ...JSON.parse(String(row.value)) as Receipt, attempts: Number(row.attempts), error: String(row.error) })),
  // 已放弃（dropped）的回复列表（新→旧，分页）
  droppedReplies: (limit = 20): Dropped[] =>
    values('SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?', limit),
  // 自 since 以来放弃的回复数
  droppedSince: (since: string): number => Number(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE dropped >= ?').get(since)?.n ?? 0),
  // 已订阅线程列表（可选按来源过滤）
  subscribedThreads: (source?: string): Thread[] => source
    ? values('SELECT value FROM thread WHERE subscribed = ? ORDER BY rowid', source)
    // Force the partial index so SQLite does not scan the entire table in rowid order.
    // 强制使用部分索引：避免 SQLite 按 rowid 顺序全表扫描
    : values('SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid'),
  }
}
