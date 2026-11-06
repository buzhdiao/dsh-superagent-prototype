/** SQLite persistence for domain aggregates, key-value state, settings history, and the channel outbox. */
// SQLite 持久化：承载领域聚合、键值状态、设置历史与渠道出站箱（outbox）。
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
// 核心域类型与辅助：key 内部键、threadKey 线程键，以及各聚合类型
import { key, threadKey, type ChannelRef, type Decision, type OutboundMessage, type ReplyStatus, type Repositories, type Thread, type ThreadFact,
  type ThreadFacts, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'
// KV：键族定义；Family/Key：键族与类型化键
import { KV, type Family, type Key } from '../kv.ts'
// SettingsSchema 设置 schema；Settings/SettingsOrigin/SettingsSave：设置值/来源/保存记录类型
import { SettingsSchema, type Settings, type SettingsOrigin, type SettingsSave } from '../policy.ts'
// 迁移工具：最旧支持版本、当前版本、schema 10→11 迁移函数、过旧提示文本
import { OLDEST_SCHEMA, SCHEMA_VERSION, migrateTo11, tooOld } from './migration.ts'
// Versions：版本化记录存储
import { Versions } from './versions.ts'
// storeReads：只读查询集合
import { storeReads } from './store-read.ts'

/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
// 触发器在线程时间线上的位置：按时间戳排序、以 id 决胜
export interface TimelinePlace { at: string; id: string }
/** Why a message was dropped: its conversation can never receive it (`channelGone`), or its Source no longer listens to it (`channelIgnored`). */
// 消息被放弃（drop）的原因：目标会话永远收不到它（channelGone），或数据源不再监听该会话（channelIgnored）
export type DropReason = 'channelGone' | 'channelIgnored'
/** Outbound message receipt tracked in the outbox from the moment it is queued (`pending`, `sent`, or `dropped`); delivery attempt counts live on its `reply` effect. */
// 出站消息回执（Receipt）：从入队那一刻起在出站箱中被跟踪（pending/sent/dropped）；投递尝试次数记在其 reply 效果行上
export interface Receipt extends OutboundMessage { status: ReplyStatus; dropped?: { at: string; reason: DropReason } }
/** A dropped outbound message receipt, with the timestamp and reason it was dropped. */
// 已放弃的出站消息回执（附放弃时间与原因）
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }
/** Saved settings snapshot with the policy version and ticket notifications it produced (`internal` saves have no origin). */
// 设置版本快照：附策略版本与受通知的工单（internal 来源的保存没有 origin）
export interface SettingsVersion {
  revision: number; savedAt: string; source: SettingsOrigin | 'internal'; block?: SettingsSave
  policyVersion: string; policyChanged: boolean; notified: string[]; settings: Settings
}
/**
 * Generated columns and partial indexes defining active working sets so passes scan only active rows.
 * Older databases missing a column get it added on open and populated by SQLite from stored JSON rows.
 */
// 生成列（generated columns）与部分索引：定义"活跃工作集"，让处理轮只扫描活跃行。
// 旧库缺列时在打开时补列，并由 SQLite 从存量 JSON 行自动填充。
const SETS: Record<string, Record<string, string>> = {
  // ticket 表的生成列
  ticket: {
    // open：尚未结束的工单
    open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
    // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
    // active：仍有未投递输入、或最新派工处于 pending/running 的工单（引擎总先关闭旧派工再加新的，故只看最新一条即可）
    active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
  },
  // thread 表的生成列
  thread: {
    // active：有待处理触发器或正在评估的线程
    active: "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
    // subscribed：有订阅的线程（值为来源名）
    subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  },
  // Composite key (ticketId + thread) used to preserve per-conversation reply order.
  // outbox 表：dropped 为放弃时间；pending 为"工单+会话"复合键，用于保持每个会话的回复顺序
  outbox: { dropped: "TEXT AS (value ->> '$.dropped.at')", pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)` },
}
// 转发导出当前 schema 版本
export { SCHEMA_VERSION }
/**
 * SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
 * The Runtime opens it after locking the state directory and automatically migrates supported older schemas on startup.
 * The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
 */
// SQLite 存储实现：领域 Repositories、视图读查询、版本化设置、出站回执与键值状态。
// Runtime 在锁定状态目录后打开它，启动时自动迁移受支持的旧 schema。
// Engine 在 atomic 事务内变更领域聚合；数据源、视图与 Outbox 读状态或更新各自记录。
export class Store implements Repositories {
  // 原生 SQLite 连接（Effects 等组件也直接使用）
  readonly db: DatabaseSync
  /**
   * Opens or creates the SQLite database at `path`, migrating schema 10 to schema 11 in a single transaction.
   * @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
   * @throws When the database schema is older than `OLDEST_SCHEMA` (10), newer than `SCHEMA_VERSION` (11), or when migration fails; in every case the database file is left unchanged and the SQLite handle is closed so a later attempt in the same process can open it.
   */
  // 打开或创建 path 处的 SQLite 库，并在单个事务内把 schema 10 迁移到 11。
  // report 接收 afterCommit 回调抛出的错误（不使已提交事务失败）；
  // schema 过旧/过新或迁移失败时抛错——每种情况下数据库文件保持不变，并关闭 SQLite 句柄以便同进程稍后重试。
  constructor(path: string, private readonly report: (error: unknown) => void = () => {}) {
    // 确保数据库目录存在（权限 0700）
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // 打开连接
    this.db = new DatabaseSync(path)
    // 构建只读查询集合
    this.read = storeReads(this.db)
    try {
      // 收紧数据库文件权限
      chmodSync(path, 0o600)
      // WAL 日志 + FULL 同步 + 建键值表
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      // 读取已记录的 schema 版本
      const version = this.get(KV.store.schema)
      // 比当前程序更新的库：拒绝（避免不兼容读取破坏数据）
      if (version !== undefined && version > SCHEMA_VERSION) throw new Error(`Unsupported orchestrator database version ${version}`)
      // 早于最旧支持版本：拒绝迁移
      if (version !== undefined && version < OLDEST_SCHEMA) throw new Error(tooOld(version))
      // 是否需要迁移（旧于当前版本）
      const migrating = version !== undefined && version < SCHEMA_VERSION
      try {
        // 在一个事务内完成建表、补列、迁移与版本标记
        this.atomic(() => {
          // 建全部领域表与索引（幂等 IF NOT EXISTS）
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
              PRIMARY KEY (thread, id));
            CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
              generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
              since TEXT NOT NULL, PRIMARY KEY (kind, key));
            CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
            CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
            CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
            CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
          `)
          // 对齐生成列与部分索引
          this.addColumns()
          // 旧版本库执行 10→11 迁移
          if (migrating) migrateTo11(this)
          // 更新 schema 版本标记
          if (version !== SCHEMA_VERSION) this.set(KV.store.schema, SCHEMA_VERSION)
        })
      } catch (error) {
        // 非迁移场景的错误原样上抛
        if (!migrating) throw error
        // 迁移失败：说明原因并上抛（库保持原 schema 不变）
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`The orchestrator database is unchanged at schema ${version}: its migration to schema ${SCHEMA_VERSION} failed: ${reason}`, { cause: error })
      }
    } catch (error) {
      // 打开期的任何错误：先关闭句柄再上抛
      this.db.close()
      throw error
    }
  }
  /** Reconciles generated working-set columns and indexes when opening databases created by earlier versions. */
  // 打开旧版本创建的库时：调和生成列与部分索引
  private addColumns(): void {
    // columns：读取某表现有列名集合
    const columns = (table: string) => new Set(this.db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table).map(row => String(row.name)))
    // 逐表处理
    for (const [table, definitions] of Object.entries(SETS)) {
      // Drop generated columns whose definition changed or that were removed, along with their index, before adding current ones.
      // 先删除定义已变或已移除的生成列（连带其索引），再加当前定义
      const sql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? '')
      // 现有生成列（pragma hidden 值 2/3 表示生成列）
      const generated = this.db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(table).map(row => String(row.name))
      for (const name of generated) {
        // 定义未变：保留
        if (definitions[name] && sql.includes(`${name} ${definitions[name]}`)) continue
        // 删除该列及其索引
        this.db.exec(`DROP INDEX IF EXISTS ${table}_${name}; ALTER TABLE ${table} DROP COLUMN ${name}`)
      }
      // 现有列集合
      const existing = columns(table)
      // 补齐缺失列，并为每个生成列建部分索引
      for (const [name, definition] of Object.entries(definitions)) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`)
      }
    }
    // effect 表的 generation 列旧库可能缺失：补上
    if (!columns('effect').has('generation')) this.db.exec('ALTER TABLE effect ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
  }
  /** Closes the underlying SQLite database connection. */
  // 关闭底层 SQLite 连接
  close(): void { this.db.close() }
  /** Parses JSON `value` columns returned by `sql`. */
  // 执行 SQL 并把 value 列（JSON 文本）反序列化为对象数组
  private values<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  }
  /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
  // 重建触发器的线程索引：先删旧行再插入，替换同触发器早前保存的索引行
  private indexThreads(trigger: Trigger): void {
    // 删除该触发器的旧索引行
    this.db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id)
    // 批量插入新索引（重复则忽略）
    const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)')
    for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
  }
  // 事务嵌套深度（0 表示当前不在事务中）
  private depth = 0
  /** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
  // 按保存点层级登记的"提交后回调"；回滚某层会丢弃其回调
  private readonly committed: (() => void)[][] = []
  /**
   * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
   * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
   */
  // 在保存点事务中执行 operation（若已在事务中则嵌套其中）；失败回滚其变更。
  // 提交后回调只在整个最外层事务提交后执行；回调错误只上报，不使已提交事务失败。
  atomic<T>(operation: () => T): T {
    // 记录本层深度
    const level = this.depth++
    // 保存点名
    const name = `orchestrator_atomic_${level}`
    // 清空本层回调列表
    this.committed[level] = []
    // 建立保存点
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    // 执行并在成功时释放保存点；失败回滚后再释放并上抛
    try { value = operation(); this.db.exec(`RELEASE ${name}`) }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
    // 取出本层登记的回调
    const actions = this.committed.splice(level)[0]!
    // 非最外层：把回调上交外层（等外层提交后再执行）
    if (level) this.committed[level - 1]!.push(...actions)
    // 最外层：立即执行回调（错误上报不抛出）
    else for (const action of actions) { try { action() } catch (error) { this.report(error) } }
    return value
  }
  /**
   * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
   * callbacks queued inside a transaction that rolls back are discarded and never run.
   * Use `afterCommit` for immediate in-memory follow-ups to a committed write (such as refreshing health or cancelling an in-memory turn) that cannot wait for the effect queue and need not survive a restart; use `Effects` for durable side effects that must survive a crash.
   */
  // 安排 action 在最外层事务提交后执行（不在事务中则立即执行）；回滚事务中登记的回调会被丢弃、永不执行。
  // afterCommit 适合提交后的即时内存后续（刷新健康、取消内存中的轮次等），等不了效果队列也不需跨重启存活；
  // 必须跨崩溃存活的持久副作用应使用 Effects。
  afterCommit(action: () => void): void {
    // 在事务中：登记到当前层
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    // 不在事务中：立即执行
    else action()
  }
  /** Reads a typed KV record by its key in `KV`. */
  // 读取类型化 KV 记录（不存在返回 undefined）
  get<V>(name: Key<V>): V | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(name)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as V
  }
  /** Writes a typed KV record under `name`. */
  // 写入类型化 KV 记录（upsert 语义）
  set<V>(name: Key<V>, value: V): void {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  }
  /** Deletes the KV record at `name`. */
  // 删除 KV 记录
  delete(name: string): void { this.db.prepare('DELETE FROM kv WHERE key=?').run(name) }
  /** Returns all KV keys belonging to `family` or starting with `prefix`. */
  // 返回属于某键族（或以某前缀开头）的全部 KV 键
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | { prefix: string }): string[] {
    // 统一取前缀
    const prefix = typeof family === 'string' ? family : family.prefix
    // 转义 LIKE 通配符后拼匹配模式
    const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(pattern).map(row => String(row.key))
  }

  /** Versioned settings snapshots; the current settings are the snapshot of the latest revision. */
  // 版本化设置快照：当前设置即最新修订的快照
  private readonly settingsVersions = new Versions<SettingsVersion>(this, KV.settings.revision, KV.settings.version)
  /** Current validated settings. */
  // 当前（经 schema 校验的）设置
  settings(): Settings { return SettingsSchema.parse(this.settingsVersions.current()?.settings ?? {}) }
  /** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
  // 某设置块的修订号：每个配置页都按自己的块做乐观并发
  blockRevision(block: SettingsSave): number { return this.get(KV.settings.block(block)) ?? 0 }
  /** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
  // 保存设置为下一修订（并成为当前值）；record.block 存在时递增该块的修订计数
  saveSettings(value: unknown, record: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'> = { source: 'internal', policyVersion: '', policyChanged: false, notified: [] }): Settings {
    // 先过 schema 校验
    const settings = SettingsSchema.parse(value)
    return this.atomic(() => {
      // 写入新版本快照（自动推进当前修订）
      this.settingsVersions.save(revision => ({ ...record, revision, savedAt: new Date().toISOString(), settings }))
      // 递增块修订计数（供乐观并发检查）
      if (record.block) this.set(KV.settings.block(record.block), this.blockRevision(record.block) + 1)
      return settings
    })
  }
  /** Saved settings revisions, newest first; revisions predating settings history are absent. */
  // 已保存的设置修订（新→旧）；早于历史功能启用的修订不存在
  settingsHistory(limit = 20): SettingsVersion[] { return this.settingsVersions.list(limit) }

  // triggers 仓储：触发器的读取/保存/处置读取/处置保存
  readonly triggers = {
    // 按 id 读取触发器
    get: (id: string): Trigger | undefined => { const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Trigger : undefined },
    // 保存触发器（upsert）并重建线程索引（原子操作）
    save: (trigger: Trigger): void => this.atomic(() => {
      this.db.prepare('INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at').run(trigger.id, JSON.stringify(trigger), trigger.at)
      this.indexThreads(trigger)
    }),
    // 读取触发器的处置记录
    disposition: (id: string): TriggerDisposition | undefined => { const row = this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as TriggerDisposition : undefined },
    // 保存处置记录（upsert）
    saveDisposition: (id: string, value: TriggerDisposition): void => { this.db.prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)) },
  }
  // threads 仓储：线程的读取/保存/列表/活跃集/描述与元数据补丁
  readonly threads = {
    // 按键读取线程
    get: (keyValue: string): Thread | undefined => { const row = this.db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue); return row ? JSON.parse(String(row.value)) as Thread : undefined },
    // 保存线程（upsert）
    save: (thread: Thread): void => { this.db.prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(thread.key, JSON.stringify(thread)) },
    // 全部线程（按插入序）
    list: (): Thread[] => this.db.prepare('SELECT value FROM thread ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Thread),
    // 活跃线程（生成列 active=1）
    active: (): Thread[] => this.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
    /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
    // 更新线程的人类可见元数据（label、url、facts——fact 传 null 表示按 id 删除）；线程不存在则无操作
    describe: (keyValue: string, patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void => {
      // 线程必须存在
      const thread = this.threads.get(keyValue)
      if (!thread) return
      // 合并 facts（null 删除对应条目）
      const facts: ThreadFacts = { ...(thread.meta.facts as ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) { if (fact) facts[id] = fact; else delete facts[id] }
      // 组装新 meta（未提供的字段保持原值）
      const meta = { ...thread.meta, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.url === undefined ? {} : { url: patch.url }), facts }
      // meta 有变化才保存（避免无谓写入）
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    },
    /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
    // 原子地设置/删除（值传 undefined）线程上的来源专属元数据键（重读后打补丁）；线程不存在则无操作
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void => this.atomic(() => {
      // 线程必须存在
      const thread = this.threads.get(keyValue)
      if (!thread) return
      // 逐键应用补丁（undefined 表示删除）
      const meta = { ...thread.meta }
      for (const [name, value] of Object.entries(patch)) { if (value === undefined) delete meta[name]; else meta[name] = value }
      // meta 有变化才保存
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    }),
  }
  // tickets 仓储：工单的读取/保存/列表/开放集/活跃集
  readonly tickets = {
    // 按 id 读取工单
    get: (id: string): Ticket | undefined => { const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Ticket : undefined },
    // 保存工单（upsert）
    save: (ticket: Ticket): void => { this.db.prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id, JSON.stringify(ticket)) },
    /** Newest first. */
    // 全部工单（最新在前）
    list: (): Ticket[] => this.values('SELECT value FROM ticket ORDER BY rowid DESC'),
    /** Newest first. */
    // 开放工单（最新在前，生成列 open=1）
    open: (): Ticket[] => this.values('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
    /** Newest first. */
    // 活跃工单（最新在前，生成列 active=1）
    active: (): Ticket[] => this.values('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
  }
  // decisions 仓储：决策的读取/保存/按线程列表
  readonly decisions = {
    // 按 id 读取决策
    get: (id: string): Decision | undefined => { const row = this.db.prepare('SELECT value FROM decision WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Decision : undefined },
    // 保存决策（upsert，冗余存 thread 列便于按线程查询）
    save: (decision: Decision): void => { this.db.prepare('INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread').run(decision.id, decision.threadKey, JSON.stringify(decision)) },
    // 某线程的全部决策（按插入序）
    byThread: (threadKeyValue: string): Decision[] => this.db.prepare('SELECT value FROM decision WHERE thread=? ORDER BY rowid').all(threadKeyValue).map(row => JSON.parse(String(row.value)) as Decision),
  }
  /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
  // 只读查询：供管理视图、orchestrator 工具与数据源轮询使用（见 storeReads）
  readonly read: ReturnType<typeof storeReads>

  /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
  // 队列消息的投递状态；回执永久保留，使消息 id 天然幂等
  replyStatus(id: string): ReplyStatus | undefined { return this.receipts.get(id)?.status }
  /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
  // 渠道投递的出站回执仓储；只有 Outbox 会写入 receipts
  readonly receipts = {
    // 读取回执
    get: (id: string): Receipt | undefined => this.values<Receipt>('SELECT value FROM outbox WHERE id = ?', id)[0],
    /** Pending message receipts, oldest first. */
    // 待投递回执（旧→新）
    waiting: (): Receipt[] => this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    /** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` consecutive failed `reply` effect attempts. */
    // 同工单同会话中更早的消息仍在 pending、且其 reply 效果连续失败次数未达阈值时为真（用于保持会话内顺序）
    behind: (id: string, failures: number): boolean => !!this.db.prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`).get(id, failures),
    /**
     * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
     * @returns Whether the message ID was newly recorded.
     */
    // 记录新的 pending 回执；重复的消息 id 保留原回执。返回是否为新记录
    add: (message: OutboundMessage): boolean => {
      // 构造 pending 状态的回执
      const receipt: Receipt = { ...message, status: 'pending' }
      // INSERT OR IGNORE：changes>0 说明确实新插入
      return Number(this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)').run(message.id, JSON.stringify(receipt)).changes) > 0
    },
    /**
     * Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
     * was withdrawn while being sent so its ID cannot be queued again.
     */
    // 把 pending 回执结案为 sent 或 dropped（附放弃原因与时间）；若消息在投递中被撤回删除则重建回执，使其 id 无法再次入队
    settle: (message: OutboundMessage, outcome: 'sent' | DropReason): void => {
      // 结案载荷
      const settled = outcome === 'sent' ? { status: 'sent' } : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      // 拆出消息关键字段（重建回执时需要）
      const { id, channel, text, kind, ticketId } = message
      // 先尝试就地更新 pending 回执
      const updated = this.db.prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'")
        .run(JSON.stringify(settled), id)
      // 没更新到（回执已被撤回删除）：重建回执，防止同 id 再次入队
      if (!Number(updated.changes)) this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
        .run(id, JSON.stringify({ id, channel, text, kind, ...ticketId ? { ticketId } : {}, ...settled }))
    },
    /**
     * Withdraws a pending message that has not yet been sent.
     * @returns Whether a pending message with `id` was waiting and removed.
     */
    // 撤回尚未发送的 pending 消息；返回是否确实存在并删除了
    withdraw: (id: string): boolean =>
      Number(this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) > 0,
  }
}
// 转发导出 key/threadKey 与 ChannelRef 类型
export { key, threadKey }
export type { ChannelRef }
