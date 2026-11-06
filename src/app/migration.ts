/**
 * Migrates a schema 10 database to schema 11 in a single transaction so runtime readers never convert legacy shapes.
 * Databases older than schema 10 are rejected: this version cannot migrate them.
 */
// 把 schema 10 数据库在单个事务内迁移到 schema 11，运行期读取方永远不需要处理旧形状。
// 早于 schema 10 的库直接拒绝：本版本无法迁移它们。
import { basename } from 'node:path'
// z：zod 校验库
import { z } from 'zod'
// 核心域辅助：isoTime 归一化时间戳、said 包装自由文本；以及各领域类型
import { isoTime, said, type AcceptMode, type AdmissionCell, type ChannelRef, type Decision, type Execution, type Follow, type MandateBasis,
  type Reason, type Thread, type Ticket, type TicketInput, type TriggerDisposition } from '../core/index.ts'
// feishuChatLink：构造飞书会话链接
import { feishuChatLink } from '../sources/feishu-channel.ts'
// POLL_HORIZON_MS：轮询时间窗口
import { POLL_HORIZON_MS } from '../sources/poll.ts'
// SettingsSchema 设置 schema；policyVersion 策略版本号；SettingsOrigin 设置来源
import { SettingsSchema, policyVersion, type SettingsOrigin } from '../policy.ts'
// autoMergeThreshold 自动合并阈值句式；teamDefaults 团队段落默认文本
import { autoMergeThreshold, teamDefaults } from './context.ts'
// PromptConfigSchema / PromptConfig / PromptVersion：提示词配置 schema 与版本类型
import { PromptConfigSchema, type PromptConfig, type PromptVersion } from './prompts.ts'
// EffectKind / EffectPayloads：效果类别与载荷类型
import type { EffectKind, EffectPayloads } from './effects.ts'
// 各类通知内容构造器
import { promptsNotice, settingsNotice, subscriptionNotice } from './notices.ts'
// SettingsVersion / Store：设置版本与存储类型
import type { SettingsVersion, Store } from './store.ts'
// Versions：版本化记录存储
import { Versions } from './versions.ts'
// KV：键族定义；Key：类型化键
import { KV, type Key } from '../kv.ts'

// 当前 schema 版本号
export const SCHEMA_VERSION = 11
/** The oldest database schema version this build can open and migrate directly. */
// 本构建能直接打开并迁移的最旧数据库 schema 版本
export const OLDEST_SCHEMA = 10
/** Returns an error message explaining why `version` cannot be opened: older schemas need a new state directory. */
// 解释为何无法打开 version 的错误信息：更旧的 schema 需要新的状态目录
export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} predates schema ${OLDEST_SCHEMA}, which this version cannot migrate; start with a new state directory`

// Stored：迁移代码中"未定型的存储记录"形状
type Stored = Record<string, unknown>
// isObject：安全收窄为普通对象（null 与数组不算）
const isObject = (value: unknown): value is Stored => !!value && typeof value === 'object' && !Array.isArray(value)
// text：安全收窄为非空字符串
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** Runs one migration step, prefixing any thrown error with the name of the record that failed. */
// 执行一个迁移步骤：抛错时在错误前冠以出错的记录名，便于定位
function step<T>(record: string, work: () => T): T {
  try { return work() } catch (error) { throw new Error(`${record}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
}
/** Rewrite all schema 10 records into their schema 11 shapes in place. */
// migrateTo11：把全部 schema 10 记录就地改写为 schema 11 形状
export function migrateTo11(store: Store): void {
  // 1) 迁移设置记录（当前值与历史修订）
  step('the settings', () => { migrateSettingsRecords(store) })
  // 2) 迁移提示词修订
  step('the prompt versions', () => { migratePrompts(store) })
  // 汇总 answer-ready 标记：工单 id → 触发器 id 列表（人已回答的输入）
  const answers = new Map<string, string[]>()
  for (const name of store.keys('answer-ready:')) {
    // 键形如 answer-ready:<ticketId>:<triggerId>
    const [, ticketId, triggerId] = name.split(':')
    // 仅收集仍为 true 的标记
    if (store.get(name) === true && ticketId && triggerId) answers.set(ticketId, [...answers.get(ticketId) ?? [], triggerId])
  }
  // human：判断某触发器是否人工触发
  const human = (triggerId: string) => store.triggers.get(triggerId)?.human === true
  // closed：读取 github-ended 记录并解析为 PR 关闭状态
  const closed = (number: number) => pullEnd(store.get<unknown>(`github-ended:${number}`))
  // 3) 逐条迁移工单记录
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    step(`ticket ${String(row.id)}`, () => { store.tickets.save(ticketOf(JSON.parse(String(row.value)) as Stored, answers, human, closed)) })
  }
  // 4) 迁移带 mandate（授权）的决策记录：升级 basis（依据）形状
  for (const row of store.db.prepare("SELECT id, value FROM decision WHERE json_type(value, '$.mandate') = 'object'").all()) {
    step(`decision ${String(row.id)}`, () => {
      const decision = JSON.parse(String(row.value)) as Decision
      store.decisions.save({ ...decision, mandate: { ...decision.mandate!, basis: basisOf(decision.mandate!.basis as unknown) } })
    })
  }
  // 5) 迁移正在评估的线程：升级其评估依据形状
  for (const thread of store.threads.list()) {
    const evaluating = thread.evaluating
    if (evaluating) step(`thread ${thread.key}`, () => { store.threads.save({ ...thread, evaluating: { ...evaluating, basis: basisOf(evaluating.basis as unknown) } }) })
  }
  // 6) 回填线程的创建/活跃时间
  step('the Threads\' activity times', () => { backfillThreadTimes(store) })
  // Worker-readable input keys are now prefixed with `ticket/` instead of `task/`; keep any key already written under `ticket/`.
  // worker 可读输入键的前缀由 task/ 改为 ticket/：已存在于 ticket/ 下的键保持不动，其余改名后删除旧键
  for (const name of store.keys('task/')) {
    const renamed = `ticket/${name.slice('task/'.length)}`
    if (store.get(renamed) === undefined) store.set(renamed, store.get(name))
    store.delete(name)
  }
  // 7) 删除全部废弃键（DEAD_KEYS 中的前缀项按前缀枚举，整键项直接删）
  for (const name of DEAD_KEYS.flatMap(prefix => prefix.endsWith(':') ? store.keys(prefix) : [prefix])) store.delete(name)
  // Source read pages, prompt previews, and Feishu message links are now cached in memory instead of SQLite.
  // 数据源读取页、提示词预览与飞书消息链接改为内存缓存：删除 SQLite 里的旧缓存键
  store.db.exec(`DELETE FROM kv WHERE key LIKE 'feishu-read:%' OR key LIKE 'github-read:%' OR key LIKE 'feishu-source-link:%'
    OR key LIKE '%:prompt-preview/%'`)
  // 8) 把旧主会话队列搬进统一效果队列
  queueEarlierWork(store)
  // Convert dropped-message prose reasons into reason codes localized by the panel.
  // 把放弃消息的散文原因句转换为面板可本地化的原因码
  store.db.exec(`UPDATE outbox SET value = json_set(value, '$.dropped.reason', CASE value ->> '$.dropped.reason'
    WHEN 'The conversation can no longer receive messages' THEN 'channelGone'
    WHEN 'The Source no longer listens to this conversation' THEN 'channelIgnored'
    ELSE value ->> '$.dropped.reason' END) WHERE value -> '$.dropped' IS NOT NULL`)
  // 9) 出站箱行转换为状态回执并入队 pending 消息
  step('the outbox', () => { outboxReceipts(store) })
  // 10) 把独立 settings 键并入版本化设置
  step('the current settings', () => { settingsAsVersions(store) })
  // Sessions persist the prompt revisions each Session worked under in `KV.sessions.prompts` (`session-prompts:`), which authorizes reads; drop the old `prompt-version-read:` markers.
  // 各 Session 运行过的提示词修订现持久化在 KV.sessions.prompts（session-prompts:），它同时授权读取；删除旧的 prompt-version-read: 标记
  store.db.exec("DELETE FROM kv WHERE key LIKE 'prompt-version-read:%'")
  // Schema 6 tables stay in place: schema 7 imported them, but did not import every row.
  // schema 6 的表保留原地：schema 7 曾导入它们但未导尽每行，故这里再补迁移其记录
  step('the Sources\' records', () => { migrateSourceRecords(store) })
  // Worker Sessions now render inputs directly from the ticket record, so standalone input body keys are obsolete.
  // worker 会话现在直接从工单记录渲染输入：独立的输入正文键已废弃
  step('the Inputs\' bodies', () => { store.db.exec("DELETE FROM kv WHERE key LIKE 'ticket/%/input/%'") })
  // 11) 删除已复制到工单 follows 的 PR 结束记录
  step('the pull request ends', () => { dropPullEnds(store) })
  // 12) 把 problem-dismissed 标记挪到决策字段上
  step('the dismissed problems', () => { moveDismissals(store) })
  // 13) 工单去冗余字段（二次处理：上面 3) 之后字段已齐备，现在剥离派生字段）
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    step(`ticket ${String(row.id)}`, () => { store.tickets.save(withoutCopies(JSON.parse(String(row.value)) as Stored)) })
  }
  // 14) 决策/处置/派工结束原因由自由文本转为原因码
  step('the reasons', () => { reasonsAsCodes(store) })
  // 15) 归一化触发器与线程的时间戳
  step('the Triggers\' times', () => { triggerTimes(store) })
}
/**
 * Normalize trigger and thread timestamps to fixed-width millisecond ISO strings so lexicographical text order matches
 * chronological order (GitHub wrote whole seconds like `…:00Z`, which sorted after `…:00.001Z`).
 */
// 把触发器与线程时间戳归一化为定宽毫秒 ISO 串，使字典序与时间序一致
// （GitHub 曾写整秒如 `…:00Z`，会排在 `…:00.001Z` 之后，导致排序错乱）。
function triggerTimes(store: Store): void {
  // 逐条修正 trigger 表的 at 列与 JSON 内的 at 字段
  for (const row of store.db.prepare('SELECT id, at FROM trigger').all()) {
    const at = isoTime(String(row.at))
    if (at !== row.at) store.db.prepare("UPDATE trigger SET at = ?, value = json_set(value, '$.at', ?) WHERE id = ?").run(at, at, String(row.id))
  }
  // 同步 trigger_thread 索引表里的 at（与 trigger 表对齐）
  store.db.exec(`UPDATE trigger_thread SET at = (SELECT at FROM trigger WHERE trigger.id = trigger_thread.id)
    WHERE at <> (SELECT at FROM trigger WHERE trigger.id = trigger_thread.id)`)
  // 修正线程的 createdAt/lastAt
  for (const thread of store.threads.list()) {
    const createdAt = isoTime(thread.createdAt), lastAt = thread.lastAt === undefined ? undefined : isoTime(thread.lastAt)
    // 均无需修正：跳过
    if (createdAt === thread.createdAt && lastAt === thread.lastAt) continue
    store.threads.save({ ...thread, createdAt, ...lastAt === undefined ? {} : { lastAt } })
  }
}
/**
 * Obsolete KV keys and prefixes (ending in `:`) from removed `github-issue` eligibility checks, earlier migrations,
 * and pre-schema-11 maintenance and subscription tracking.
 */
// 废弃的 KV 键与前缀（以 `:` 结尾）：来自已移除的 github-issue 资格检查、早期迁移，
// 以及 schema 11 之前的维护与订阅跟踪。
const DEAD_KEYS = ['github-object-state:', 'github-issue-eligibility:', 'github-auto-merge:',
  'source-labels-at:', 'legacy-migrated-at', 'thread-times-backfilled', 'settings-before-9', 'answer-ready:', 'prompt-sections', 'prompt-settings-text',
  'prompt-vocabulary', 'subscriptions', 'subscriptions-initialized', 'subscription-seen:', 'subscription-initialized:', 'subscription-since:',
  'observation-since:', 'task-threads:', 'maintenance-recovery:', 'maintenance-progress-report-recovery:', 'maintenance-thread-followup:',
  'master-recovery:', 'github-issue-candidates']

/**
 * Move legacy main-session queues into the unified effect queue in order (relays to steer, then notices for removed
 * subscriptions, saved prompts, and saved settings), then delete the legacy keys.
 */
// 把旧主会话队列按序搬进统一效果队列（先 relay 转 steer；再依次是取消订阅/已存提示词/已存设置的通知），然后删除旧键。
function queueEarlierWork(store: Store): void {
  // 取迁移专用的效果入队器
  const queue = effectQueue(store)
  // 旧队列键：relay 列表、取消订阅线程、提示词与设置
  const { relays, unsubscribed, prompts, settings } = KV.queues
  // 逐条把旧 relay 转为 relay 效果
  for (const { id, text } of store.get(relays) ?? []) queue('relay', id, { text })
  // 组装要注入主会话的通知：取消订阅 / 提示词已保存 / 设置已保存
  const prompt = store.get(prompts), saved = store.get(settings)
  const notices = [...(store.get(unsubscribed) ?? []).map(thread => subscriptionNotice(thread)),
    ...prompt == null ? [] : [promptsNotice(prompt)], ...saved == null ? [] : [settingsNotice()]]
  // 逐条入队为 notice 效果
  for (const [name, value, summary] of notices) queue('notice', name, { value, summary })
  // 删除旧队列键
  for (const name of [relays, unsubscribed, prompts, settings]) store.delete(name)
}

/**
 * Insert effects directly into the database during migration before `Effects` exists, preserving prior failure counts;
 * unlike `Effects.enqueue` (which upserts payload, increments generation, and resets attempts), `INSERT OR IGNORE` leaves an already-queued row for that `kind` and `key` untouched.
 */
// 在 Effects 尚未存在的迁移期直接向数据库插入效果，并保留此前的失败计数；
// 与 Effects.enqueue（upsert 载荷、generation+1、清零尝试）不同，INSERT OR IGNORE 不触碰同 kind+key 的已排队行。
function effectQueue(store: Store) {
  // 从表中恢复效果行序号
  let seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  return <K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K], failed = { attempts: 0, error: '' }) =>
    store.db.prepare('INSERT OR IGNORE INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, key, JSON.stringify(payload), ++seq, failed.attempts, failed.error, Date.now(), new Date().toISOString())
}
/**
 * Convert outbox rows into status receipts (`pending`, `sent`, or `dropped`) and enqueue pending messages as `reply`
 * effects in row order, moving their prior `attempts` and `error` onto the effect.
 */
// 把出站箱行转换为状态回执（pending/sent/dropped），并按行序把 pending 消息入队为 reply 效果，
// 把此前的 attempts 与 error 迁移到效果行上。
function outboxReceipts(store: Store): void {
  // 读取 outbox 表现有列
  const columns = store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().map(row => String(row.name))
  // 没有 sent 列说明已是新形状：无需迁移
  if (!columns.includes('sent')) return
  const queue = effectQueue(store)
  // 逐行按插入序转换
  for (const row of store.db.prepare('SELECT id, value, sent FROM outbox ORDER BY rowid').all()) {
    // 剥离旧的尝试字段（保留消息主体）
    const { attempts, error, nextAttemptAt: _next, ...message } = JSON.parse(String(row.value)) as Stored
    // 推导状态：dropped 优先，其次 sent 列，否则 pending
    const status = message.dropped ? 'dropped' : row.sent ? 'sent' : 'pending'
    // 回写带状态的回执
    store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run(JSON.stringify({ ...message, status }), String(row.id))
    // pending 消息入队 reply 效果，迁移其失败计数与错误
    if (status === 'pending') queue('reply', String(row.id), {}, { attempts: Number(attempts ?? 0) || 0, error: typeof error === 'string' ? error : '' })
  }
  // 删除旧索引与 sent 列
  store.db.exec('DROP INDEX IF EXISTS outbox_waiting; ALTER TABLE outbox DROP COLUMN sent')
}

/**
 * Ensure the latest settings revision snapshot holds the current settings (saving a new revision if missing or if earlier
 * migration steps stripped a removed Source), then delete the standalone `settings` key.
 */
// 确保最新设置修订快照持有当前设置（缺失或此前迁移剥离了已移除数据源时保存新修订），然后删除独立的 settings 键。
function settingsAsVersions(store: Store): void {
  // 读取独立 settings 键
  const current = store.get<unknown>('settings')
  // 没有独立键：无事可做
  if (current === undefined) return
  // 构建设置版本存储
  const versions = new Versions<SettingsVersion>(store, KV.settings.revision, KV.settings.version)
  // 取已知最大修订号（指针与快照中的较大者）
  const newest = Math.max(versions.revision(), ...versions.list().map(version => version.revision))
  // 修正指针（历史修订可能领先于指针）
  if (newest) store.set(KV.settings.revision, newest)
  // 快照内容与当前设置不一致：保存为新修订
  if (JSON.stringify(versions.current()?.settings) !== JSON.stringify(current)) {
    const settings = SettingsSchema.parse(current)
    versions.save(revision => ({ revision, savedAt: new Date().toISOString(), source: 'internal', policyVersion: policyVersion(settings),
      policyChanged: false, notified: [], settings }))
  }
  // 删除独立的 settings 键（此后以版本快照为准）
  store.delete('settings')
}

/** Settings save origin names recorded by versions before schema 11, mapped to current `SettingsOrigin` values. */
// schema 11 之前记录的设置保存来源名 → 当前 SettingsOrigin 的映射
const ORIGINS: Readonly<Record<string, SettingsOrigin>> = { web: 'panel', 'orchestrator-tool': 'tool', 'policy-sync': 'sync', 'member-sync': 'sync' }
/** Source kinds removed from dsh-superagent; the unified `github` Source now ingests Issues via notifications. */
// 已从 dsh-superagent 移除的数据源种类；统一的 github 源现在经通知接入 Issue
const REMOVED_SOURCES: readonly string[] = ['github-issue']
/**
 * Upgrade current and historical settings records to the schema 11 structure: strip removed source kinds from active
 * settings while keeping them in historical revisions and mapping historical origin names.
 */
// 把当前与历史设置记录升级为 schema 11 结构：活跃设置中剥离已移除的数据源种类（历史修订保留），
// 并把历史来源名映射为新名。
function migrateSettingsRecords(store: Store): void {
  // 当前设置：迁移并剥离已移除的源
  const stored = store.get<unknown>('settings')
  if (stored !== undefined) {
    const settings = SettingsSchema.parse(migrateSettings(stored))
    store.set('settings', { ...settings, sources: Object.fromEntries(Object.entries(settings.sources).filter(([id]) => !REMOVED_SOURCES.includes(id))) })
  }
  // Preserve unparseable historical revisions as-is so a corrupt history entry does not block startup.
  // 无法解析的历史修订原样保留（只映射来源名），损坏的历史条目不阻塞启动
  for (const name of store.keys('settings-version:')) {
    const version = store.get<{ source: string; settings: unknown }>(name)!
    const settings = SettingsSchema.safeParse(migrateSettings(version.settings))
    store.set(name, { ...version, source: ORIGINS[version.source] ?? version.source, ...settings.success ? { settings: settings.data } : {} })
  }
}
// Member：旧版跨来源成员（姓名/飞书 id/GitHub 账号）
interface Member { name?: string; feishuId?: string; github?: string }
/**
 * Convert legacy flat settings (chat lists in Policy, top-level pause flag) or pre-schema-11 domain settings into current domain blocks:
 * strips fields replaced by rule instructions and prompts (Executor reviewers and branch prefix, rule `visual` flag, `autoMergeLineLimit`, Source `authority`, GitHub `mergeCli`), extracts `paused` to the top level, and splits cross-source `members` into per-source `policy.sources` entries.
 */
// 把旧的扁平设置（Policy 内的会话列表、顶层暂停旗标）或 schema 11 前的领域设置转换为当前领域块：
// 剥离被规则指令与提示词取代的字段（执行器 reviewer/分支前缀、规则 visual 旗标、autoMergeLineLimit、
// 数据源 authority、GitHub mergeCli）；把 paused 提为顶层；把跨来源 members 拆进各源的 policy.sources 条目。
export function migrateSettings(value: unknown): unknown {
  // 非对象：原样返回
  if (!isObject(value)) return value
  // 已是（近似）当前形状：只做字段剥离
  if (!('members' in value || 'allowedChats' in value || 'admission' in value)) return withoutRemovedFields(value)
  // 旧扁平形状的类型视图
  const old = value as { models?: { orchestrator?: unknown; worker?: unknown }; paused?: boolean; allowedChats?: string[]; members?: unknown[];
    allowDirectMessages?: boolean; pollSeconds?: number; maxWorkers?: number; admission?: { mode?: string; chats?: string[]; timeoutSeconds?: number; rules?: unknown[] } }
  // 会话监听表：chatId → mentions/all
  const chats = new Map<string, 'mentions' | 'all'>()
  // 旧 allowedChats：只监听提及
  for (const chatId of old.allowedChats ?? []) chats.set(chatId, 'mentions')
  // Observed chats were active only when admission was enabled.
  // 准入启用时，观察会话监听全部消息
  if (old.admission?.mode !== 'off') for (const chatId of old.admission?.chats ?? []) chats.set(chatId, 'all')
  // 飞书源配置：会话列表 + 私聊开关
  const feishu = { chats: [...chats].map(([chatId, listen]) => ({ chatId, listen })), directMessages: old.allowDirectMessages ?? true }
  // 组装当前领域块形状
  return withoutRemovedFields({
    sources: { feishu: { enabled: true, config: feishu }, github: { enabled: true, config: { pollSeconds: old.pollSeconds ?? 60 } } },
    policy: { ...(old.members ? { members: old.members } : {}), ...(old.admission?.rules ? { rules: old.admission.rules } : {}) },
    eval: { ...(old.admission?.mode ? { mode: old.admission.mode } : {}), ...(old.admission?.timeoutSeconds ? { timeoutSeconds: old.admission.timeoutSeconds } : {}),
      model: old.models?.orchestrator ?? null },
    executor: { model: old.models?.worker ?? null, ...(old.maxWorkers ? { maxWorkers: old.maxWorkers } : {}), paused: old.paused ?? false },
  })
}
// withoutRemovedFields：从设置中剥离已废弃字段（但不改动代码语义）
function withoutRemovedFields(value: Stored): Stored {
  // 拆出三大块与剩余字段
  const { executor, policy, sources, ...rest } = value as { executor?: Stored; policy?: Stored; sources?: Record<string, Stored> }
  // `paused` is now a top-level setting rather than a field on `executor`.
  // executor 块：剥离 reviewer/visualReviewer/branchPrefix；paused 提为顶层
  const { reviewer: _reviewer, visualReviewer: _visualReviewer, branchPrefix: _branchPrefix, paused, ...kept } = executor ?? {}
  // policy 块：拆出 members/memberChat/autoMergeLineLimit/rules
  const { members, memberChat, autoMergeLineLimit: _limit, rules: storedRules, ...policyRest } = policy ?? {}
  // 规则条目剥离 visual 旗标
  const rules = Array.isArray(storedRules) ? storedRules.map((rule: unknown) => { if (!isObject(rule)) return rule; const { visual: _visual, ...fields } = rule; return fields })
    : storedRules
  // 旧 members 列表（若为数组）
  const people = Array.isArray(members) ? members as Member[] : undefined
  // 把跨来源成员拆为飞书/GitHub 两份允许名单
  const parts = people ? {
    feishu: { allowed: people.filter(member => member.feishuId).map(member => ({ id: member.feishuId!, ...(member.name ? { name: member.name } : {}) })),
      ...(memberChat ? { syncChat: memberChat } : {}) },
    github: { allowed: people.filter(member => member.github).map(member => ({ id: member.github! })) },
  } : undefined
  // The GitHub Source no longer configures a dedicated merge account; auto-merge policy now lives in prompts.
  // GitHub 源不再配置专用合并账号：自动合并策略改由提示词承载
  const withoutMerge = (id: string, config: unknown) => { if (id !== 'github' || !isObject(config)) return config; const { mergeCli: _mergeCli, ...fields } = config; return fields }
  // 各数据源实例：剥离 authority 字段并对 GitHub 配置去 mergeCli
  const instances = sources ? Object.fromEntries(Object.entries(sources).map(([id, instance]) => {
    const { authority: _authority, ...fields } = instance
    return [id, 'config' in fields ? { ...fields, config: withoutMerge(id, fields.config) } : fields]
  })) : undefined
  // Rewrite environment variable prefixes from the project's earlier names in `prepare` commands.
  // prepare 命令里的环境变量前缀由旧项目名改写为 DSH_SUPERAGENT_
  if (typeof kept.prepare === 'string') kept.prepare = kept.prepare.replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
  // 重新组装：paused 提到顶层，其余按块放回
  return { ...rest, ...(typeof paused === 'boolean' ? { paused } : {}), ...(executor ? { executor: kept } : {}),
    ...(instances ? { sources: instances } : {}),
    ...(policy ? { policy: { ...policyRest, ...(rules ? { rules } : {}), ...(parts ? { sources: parts } : {}) } } : {}) }
}

/** Prompt configuration shape saved before team sections existed, when all sections (including fixed ones) were editable. */
// 团队段落出现之前保存的提示词配置形状：当时所有段落（含固定段）都可编辑
const LegacyPromptConfigSchema = z.object({ shared: z.string(), orchestrator: z.string(), worker: z.string(), guides: z.record(z.string(), z.string()) })
/** Guide names from legacy prompt configurations that are now fixed built-in prompt sections or skills. */
// 旧提示词配置里现已成为固定内置段落或技能的 guide 名
const LEGACY_FIXED = new Set(['cli', 'subscriptions', 'replies', 'reviews', 'dispatch', 'work', 'feishu', 'github'])
/** Tool names used in saved prompts before the domain vocabulary rename, paired with what replaces them now. */
// 领域词汇更名前保存在提示词里的工具名 → 现在的替代写法
const RENAMED_TOOLS: readonly (readonly [string, string])[] = [
  ['orchestrator_subscription_remove', 'orchestrator_thread_unsubscribe'], ['orchestrator_subscriptions', 'orchestrator_threads'],
  ['orchestrator_create_task', 'orchestrator_route (kind accept)'], ['orchestrator_send_task', 'orchestrator_route (kind attach)'],
  ['orchestrator_reopen_task', 'orchestrator_route (kind attach)'], ['orchestrator_ticket_reopen', 'orchestrator_route (kind attach)'],
  ['orchestrator_stop_task', 'orchestrator_route (kind stop)'], ['orchestrator_ignore_event', 'orchestrator_route (kind ignore)'],
  ['orchestrator_request_status', 'orchestrator_ticket_request_status'], ['orchestrator_inspect_task', 'orchestrator_ticket_inspect'],
  ['orchestrator_observations', 'orchestrator_decisions'], ['orchestrator_event_replay', 'orchestrator_trigger_requeue'],
  ['orchestrator_tasks', 'orchestrator_tickets'], ['orchestrator_assess', 'orchestrator_eval'], ['admission_read', 'orchestrator_eval_read'],
  ['admission_decide', 'orchestrator_eval_decide'],
]
/** Read-only tools replaced by `orchestrator_read <resource>`, mapped to their resource paths. */
// 被 `orchestrator_read <资源>` 取代的只读工具 → 对应资源路径
const READ_TOOLS: Readonly<Record<string, string>> = { orchestrator_tickets: 'tickets', orchestrator_threads: 'threads', orchestrator_decisions: 'decisions',
  orchestrator_settings_read: 'settings', orchestrator_prompts_read: 'prompts', orchestrator_models: 'models', orchestrator_ticket_inspect: 'ticket/<id>' }
/**
 * Rewrites skill and variable prefixes from the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), replaces retired
 * read tools with `orchestrator_read`, and the four routing tools with `orchestrator_route` and their kind.
 */
// 改写技能/变量前缀（旧项目名 dsh-tag、dsh-go、dsh-freelancer → dsh-superagent），
// 把退役的只读工具替换为 orchestrator_read，四个路由工具替换为 orchestrator_route 加 kind。
const currentNames = (value: string): string => value.replace(/\bdsh-(?:tag|go|freelancer)-/g, 'dsh-superagent-').replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
  .replace(/\borchestrator_(?:tickets|threads|decisions|settings_read|prompts_read|models|ticket_inspect)\b/g, name => `orchestrator_read ${READ_TOOLS[name]}`)
  .replace(/\borchestrator_(?:ticket_(accept|attach|stop)|trigger_(ignore))\b/g, (_name, ticket?: string, trigger?: string) =>
    `orchestrator_route (kind ${ticket ?? trigger ?? ''})`)
/** Rewrites a legacy skill body to current tool, argument, resource, section, skill, and variable names. */
// 把旧技能正文改写为当前的工具、参数、资源、段落、技能与变量名
function legacyText(value: string): string {
  // 先替换成对的工具改名
  let result = value
  for (const [from, to] of RENAMED_TOOLS) result = result.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
  // 再做通用更名：事件/任务词汇 → 触发器/工单词汇，资源前缀与 guide 引用一并改写
  return currentNames(result.replaceAll('reply_to_event_id', 'reply_to_trigger_id').replace(/\bevent_id\b/g, 'trigger_id').replace(/\btask_id\b/g, 'ticket_id')
    .replaceAll('related_tasks', 'related_tickets').replace(/(?<![\w/-])event\//g, 'trigger/').replace(/(?<![\w/-])task\//g, 'ticket/').replaceAll('<event-id>', '<trigger-id>')
    .replace(/\bguide\/([a-z][a-z0-9-]*)\b/g, (_match, name: string) => LEGACY_FIXED.has(name) ? `the ${name} section` : `skill dsh-superagent-${name}`))
}
/**
 * Upgrade a stored prompt configuration to current sections, tool names, and skill references; legacy configurations take
 * built-in team sections, keep custom guides as skills, and carry any auto-merge line threshold into `delivery`.
 */
// 把存量提示词配置升级为当前段落、工具名与技能引用；旧配置采用内置团队段落、
// 把自定义 guide 保留为技能，并把自动合并行数阈值带进 delivery 段。
function normalize(config: unknown): PromptConfig {
  // 尝试按旧形状解析
  const legacy = LegacyPromptConfigSchema.safeParse(config)
  // 从旧 work 段提取自动合并行数阈值
  const limit = legacy.success ? /fewer than (\d+) lines \(additions plus deletions\)/.exec(legacy.data.guides.work ?? '')?.[1] : undefined
  // 旧配置：团队段落用默认文本（delivery 替换为记录的阈值）；自定义 guide 保留为技能（正文做新旧名改写）
  const current = legacy.success ? { ...teamDefaults, delivery: limit ? teamDefaults.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(Number(limit))) : teamDefaults.delivery,
    skills: Object.fromEntries(Object.entries(legacy.data.guides).filter(([name]) => !LEGACY_FIXED.has(name)).map(([name, body]) => [name, legacyText(body)])) }
    // 新配置：直接按 schema 解析
    : PromptConfigSchema.parse(config)
  // 三个团队段与全部技能正文统一做新旧名改写
  return { communication: currentNames(current.communication), scope: currentNames(current.scope), delivery: currentNames(current.delivery),
    skills: Object.fromEntries(Object.entries(current.skills).map(([name, body]) => [name, currentNames(body)])) }
}
/**
 * Normalize stored prompt revisions to current sections and names (recording original configs under `legacy` when saved
 * before team sections existed or unparseable) and synthesize a new revision for removed settings fields (auto-merge
 * threshold and cross-source member identities) unless an earlier migration already created it.
 */
// 把存量提示词修订归一化为当前段落与名称（团队段落出现前保存或无法解析的修订，把原配置记入 legacy），
// 并为已移除的设置字段（自动合并阈值、跨来源成员身份）合成一次新修订——除非更早的迁移已创建过。
function migratePrompts(store: Store): void {
  // Preserve original configs on legacy or unparseable revisions, falling back to the last readable config so sessions always have valid prompts.
  // 在旧格式或无法解析的修订上保留原配置；解析失败退回上一份可读配置，保证会话总有有效提示词
  const versions = store.keys('prompt-version:').map(name => store.get<PromptVersion & { config: unknown }>(name)!).sort((a, b) => a.revision - b.revision)
  // 最近一份可读配置
  let readable: PromptConfig = { ...teamDefaults, skills: {} }
  for (const version of versions) {
    // 是否旧格式
    const legacy = LegacyPromptConfigSchema.safeParse(version.config).success
    let config: PromptConfig
    // 归一化；失败退回最近可读配置
    try { config = normalize(version.config) } catch { config = readable }
    // 旧格式或退回的修订：把原配置记入 legacy 字段
    const kept = legacy || config === readable ? { legacy: version.legacy ?? { config: version.config } } : {}
    // 写回归一化后的修订
    store.set(`prompt-version:${version.revision}`, { ...version, config, ...kept })
    readable = config
  }
  // 设置已迁移过提示词（旧标记存在）：不再合成新修订
  if (store.get('prompt-settings-text') === 1) return
  // 读取 schema 9 前的设置（含自动合并阈值与成员）
  const before = store.get<unknown>('settings-before-9')
  const policy = (isObject(before) ? before.policy : undefined) as { autoMergeLineLimit?: unknown; members?: unknown } | undefined
  // 自动合并阈值（缺省 200 行）
  const limit = typeof policy?.autoMergeLineLimit === 'number' ? policy.autoMergeLineLimit : 200
  // 跨来源成员：同时有飞书与 GitHub 账号的人
  const mapped = ((Array.isArray(policy?.members) ? policy.members : []) as Member[]).filter(person => person.feishuId && person.github)
  // 当前提示词修订号
  const revision = store.get<number>('prompt-revision')
  const current = revision === undefined ? undefined : store.get<PromptVersion>(`prompt-version:${revision}`)
  const config = current?.config ?? { ...teamDefaults, skills: {} }
  // delivery 段落替换为记录的阈值（无记录且本就是 200 行则原样；否则追加一句）
  const delivery = config.delivery.includes(autoMergeThreshold(200)) ? config.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(limit))
    : limit === 200 ? config.delivery : `${config.delivery}\nEnable auto-merge only on a PR that changes fewer than ${limit} lines (additions plus deletions).`
  // 合成跨来源身份说明技能（尚无 identities 技能且有映射成员时）
  const identities = mapped.length && !config.skills.identities ? { identities: ['The same colleague may use a different account on each Source. When you mention, assign or request a review from someone you met on another Source, use their account on this one:',
    ...mapped.map(person => `- ${person.name ?? person.feishuId} (Feishu ${person.feishuId}) is @${person.github} on GitHub`)].join('\n') } : {}
  const next = { ...config, delivery, skills: { ...config.skills, ...identities } }
  // 内容无变化：不合成新修订
  if (JSON.stringify(next) === JSON.stringify(config)) return
  // 当前修订号（无则 0，并补写修订 0 作为默认基线）
  const previous = current?.revision ?? 0
  if (!current) store.set('prompt-version:0', { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config })
  // 写入迁移产生的新修订并推进指针
  store.set(`prompt-version:${previous + 1}`, { revision: previous + 1, previousRevision: previous, savedAt: new Date().toISOString(), source: 'settings-migration', config: next })
  store.set('prompt-revision', previous + 1)
}

// CELLS：准入表的三个单元格名
const CELLS: readonly string[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
/**
 * Upgrade a legacy mandate basis object to the current tagged union shape.
 * Current bases recorded `source` and `scope`; older ones recorded a Feishu chat directly (`chatId`) or schema 6's `legacyAuthority`.
 * A basis with neither an admission table cell nor `followup` came from a listed sender (`addressed` when it recorded `addressed`, `sender`, and `source`, else `listed`), which holds while the sender remains listed.
 */
// 把旧版授权依据（mandate basis）对象升级为当前的可辨识联合形状。
// 当前形状记录 source 与 scope；更旧的直接记录飞书会话（chatId）或 schema 6 的 legacyAuthority。
// 既无准入单元格也无 followup 的依据来自列名发送者（记有 addressed/sender/source 时为 addressed，否则 listed），发送者仍在列时成立。
export function basisOf(stored: unknown): MandateBasis {
  // Missing or non-object bases default to a listed-sender basis (`via: 'listed'`).
  // 缺失或非对象的依据默认按"列名发送者"（via: 'listed'）处理
  const old = isObject(stored) ? stored : {}
  // 已是新形状（带 via）：原样返回
  if (typeof old.via === 'string') return old as unknown as MandateBasis
  // Older Feishu bases recorded `chatId` and `direct` at the top level instead of inside `scope`.
  // 旧飞书依据把 chatId/direct 记在顶层而非 scope 内：重组成来源+范围
  const chat = text(old.chatId) ? { source: 'feishu', scope: { chatId: old.chatId, direct: old.direct === true } } : {}
  // received：来源与范围（有记录用之，否则用上面的飞书会话）
  const received = text(old.source) ? { source: old.source as string, ...isObject(old.scope) ? { scope: old.scope } : {}, ...text(old.row) ? { row: old.row as string } : {} } : chat
  // 发送者（新名 sender，旧名 member）
  const sender = text(old.sender) ?? text(old.member)
  // 公共字段拼装
  const common = { ...received, ...sender ? { sender } : {}, ...Array.isArray(old.rules) ? { rules: old.rules as string[] } : {} }
  // 寻址方式：显式记录 > direct 旗标 > mention 旗标
  const addressed = old.addressed === 'mention' || old.addressed === 'direct' ? old.addressed
    : old.direct === true ? 'direct' as const : old.mention === true ? 'mention' as const : undefined
  // 观察模式
  const mode = text(old.mode) as AcceptMode | undefined
  // Schema 6 imports recorded `legacyAuthority`.
  // schema 6 导入的依据带 legacyAuthority
  const authority = text(old.legacyAuthority) ? { authority: old.legacyAuthority as string } : {}
  // 跟进型依据
  if (old.followup === true) return { via: 'followup', ...common, ...authority }
  // 准入表型依据（带单元格与可选的观察模式）
  if (CELLS.includes(String(old.admission))) {
    return { via: 'admission', ...common, cell: old.admission as AdmissionCell, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: { mode: mode ?? 'auto' } } : {} }
  }
  // 显式寻址型依据（需有寻址方式、发送者与来源）
  if (addressed && sender && text(old.source)) return { via: 'addressed', ...common, addressed }
  // Any basis with neither a table cell nor `followup` came from a listed sender.
  // 其余（既无单元格也无 followup）：列名发送者型依据
  return { via: 'listed', ...common, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: mode ? { mode } : {} } : {}, ...authority }
}
/**
 * Upgrade a schema 10 ticket record to schema 11: extracts `origin`, `execution`, `delivery`, and followed PR threads
 * (`follows`) from `meta` and GitHub opener channels, merges reported `answers`, marks human trigger inputs (`human: true`),
 * and converts pending `reopen` inputs into `text` inputs for the worker.
 */
// 把 schema 10 工单记录升级为 schema 11：从 meta 与"GitHub 开仓渠道"提取 origin、execution、delivery
// 与关注的 PR 线程（follows），合并已上报的 answers，给人工触发器输入标 human: true，
// 并把 pending 的 reopen 输入转换为给 worker 的 text 输入。
export function ticketOf(old: Stored, answers = new Map<string, string[]>(), human: (triggerId: string) => boolean = () => false,
  closed: (number: number) => Follow['closed'] = () => undefined): Ticket {
  // 拆出 meta（其中的字段要么搬走要么废弃）
  const { meta: storedMeta, ...rest } = old as Stored & { meta?: Stored }
  const ticket = rest as unknown as Ticket
  const meta = storedMeta ?? {}
  // 来源触发器与触发器列表
  const triggerId = text(meta.sourceTriggerId) ?? ''
  const triggerIds = Array.isArray(meta.triggerIds) ? meta.triggerIds as string[] : triggerId ? [triggerId] : []
  // 工作目录
  const directory = text(meta.workspace)
  // Remaining `meta` fields are obsolete: schema 6 task states stay in the `task` table, and accept fields live on `execution` and `mandate`.
  // meta 的其余字段已废弃：schema 6 的任务状态留在 task 表，接单字段归 execution 与 mandate
  const execution: Execution | undefined = directory ? { name: text(meta.name) ?? basename(directory), directory,
    assignment: text(meta.assignment) ?? text(meta.legacyPrompt) ?? '' } : undefined
  // 逐条转换输入：人工触发器补 human 标记；pending 的 reopen 转为 text 输入（附续传说明）
  const inputs = ticket.inputs.map((input): TicketInput => input.kind === 'trigger' ? { ...input, ...human(input.triggerId) ? { human: true } : {} }
    : input.kind !== 'reopen' || !ticket.undelivered.includes(input.id) ? input
    : { id: input.id, kind: 'text', at: input.at, text: JSON.stringify({ resumed: true, decision_id: input.decisionId, read: `ticket/${ticket.id}/assignment`,
      note: 'This ticket ended earlier and a follow-up resumed it under the same mandate. Inspect the worktree, git history and PR state before continuing; do not repeat completed external operations.' }) })
  // 合并上报的 answers（旧 answers 字段与 answer-ready 标记并集去重）
  const reported = [...new Set([...ticket.answers ?? [], ...answers.get(ticket.id) ?? []])]
  // 结束记录补齐 outcome（旧记录可能没有）
  const ended = ticket.ended && { ...ticket.ended, outcome: ticket.ended.outcome ?? outcomeOf(ticket.ended) }
  // 升级授权依据
  const mandate = { ...ticket.mandate, basis: basisOf(ticket.mandate.basis as unknown) }
  // 投递失败信息（旧 meta.deliveryError）
  const delivery = ticket.delivery ?? (text(meta.deliveryError) ? { error: meta.deliveryError as string, at: ticket.updatedAt } : undefined)
  // 执行信息：优先 meta 提取的，其次已存在的
  const kept = execution ?? ticket.execution
  // 关注的 PR 线程：优先已有，否则从 meta 与开仓渠道重建
  const follows = ticket.follows ?? followsOf(meta, ticket.channels, closed)
  // 组装 schema 11 工单
  return { ...ticket, inputs, ...ended ? { ended } : {}, mandate, origin: ticket.origin ?? { triggerId, triggerIds },
    // A ticket stopped by a person receives no further work, so clear any undelivered inputs.
    // 被人停止的工单不再接收任何工作：清空未投递输入
    ...ended?.by === 'human' ? { undelivered: [] } : {},
    ...kept ? { execution: kept } : {}, ...delivery ? { delivery } : {},
    channels: ticket.channels.filter(channel => !opener(channel)), ...follows.length ? { follows } : {},
    ...reported.length ? { answers: reported } : {} }
}
/** Schema 10 recorded a PR opened by the ticket as a GitHub Channel without a comment URL (`address.url`). */
// schema 10 把工单自己开的 PR 记为没有评论 URL 的 GitHub 渠道
const opener = (channel: ChannelRef): boolean => channel.source === 'github' && !channel.address.url && !!Number(channel.address.number)
/**
 * Reconstruct followed PR threads from legacy ticket metadata (`meta.prNumber` last, after PRs opened via GitHub opener
 * channels), marking opened PRs `own: true` and attaching recorded close outcomes.
 */
// 从旧工单元数据重建关注的 PR 线程（meta.prNumber 排在开仓渠道 PR 之后），自己开的 PR 标 own: true 并附已记录的关闭结局。
function followsOf(meta: Stored, channels: ChannelRef[], closed: (number: number) => Follow['closed']): Follow[] {
  // 开仓渠道对应的 PR 号
  const opened = channels.filter(opener).map(channel => Number(channel.address.number))
  // meta.prNumber（若记录了）
  const bound = typeof meta.prNumber === 'number' ? [meta.prNumber] : []
  // 去重合并（开的在前、绑定在后），逐个附关闭状态
  return [...new Set([...opened.filter(number => !bound.includes(number)), ...bound])].map(number => {
    const end = closed(number)
    return { thread: `github:${number}`, own: opened.includes(number), ...end ? { closed: end } : {} }
  })
}
/** Parse a schema 10 `github-ended:<number>` record into a followed PR's `closed` state when valid. */
// 把 schema 10 的 github-ended:<编号> 记录解析为关注 PR 的 closed 状态（无效返回 undefined）
function pullEnd(stored: unknown): Follow['closed'] {
  if (!isObject(stored) || typeof stored.at !== 'string' || (stored.reason !== 'merged' && stored.reason !== 'closed')) return undefined
  return { at: stored.at, outcome: stored.reason }
}
/**
 * Strip redundant fields stored twice on legacy tickets: removes `state` (derived from `ended`), moves top-level `summary`
 * onto the latest Assignment as a `progress` report when no Assignment has a report, and removes `execution.session` and
 * per-Assignment `ticketId` and `ref` (derived from `ticket.id`).
 */
// 剥离旧工单上重复存储的冗余字段：删 state（可由 ended 推出）；顶层 summary 在没有任何派工报告时
// 挪到最新派工作为 progress 报告；删 execution.session 与每条派工上的 ticketId/ref（可由 ticket.id 推出）。
export function withoutCopies(old: Stored): Ticket {
  // 拆出 state 与 summary
  const { state, summary, ...ticket } = old as Stored & Ticket & { state?: string; summary?: unknown }
  // 每条派工剥离 ticketId 与 ref
  const assignments = ticket.assignments.map(item => {
    const { ticketId: _ticket, ref: _ref, ...rest } = item as typeof item & { ticketId?: string; ref?: string }
    return rest
  })
  // 最新一条派工
  const latest = assignments.at(-1)
  // 顶层 summary 在没有派工报告时转为最新派工的 progress 报告
  if (latest && typeof summary === 'string' && summary && !assignments.some(item => item.report)) {
    latest.report = { state: 'progress', summary, at: ticket.updatedAt }
  }
  // execution 剥离 session 字段
  const { session: _session, ...execution } = (ticket.execution ?? {}) as Partial<Execution> & { session?: string }
  // An open ticket has no `ended` record; a ticket marked `ended` without one defaults to `closed`.
  // open 工单没有 ended 记录；标为 ended 却缺记录的默认按 closed 补齐
  const closed = { at: ticket.updatedAt, by: 'executor' as const, reason: 'closed', outcome: 'closed' as const }
  const ended = state === 'open' ? undefined : ticket.ended ?? (state === 'ended' ? closed : undefined)
  // 从工单上移除旧 ended
  const { ended: _ended, ...rest } = ticket
  // Retain `ended.reason` only when it differs from `ended.outcome`, and drop duplicate end reasons from assignments stopped by that end.
  // ended.reason 仅在与 outcome 不同时保留；同时删除因该结束而停下的派工上的重复结束原因
  const { reason, ...end } = ended ?? {} as NonNullable<Ticket['ended']>
  const once = ended && { ...end, ...reason && reason !== ended.outcome ? { reason } : {} } as NonNullable<Ticket['ended']>
  for (const item of assignments) if (ended && item.endedReason === reason && item.endedAt === ended.at) delete item.endedReason
  // 重新组装工单
  return { ...rest, ...once ? { ended: once } : {}, assignments, ...ticket.execution ? { execution: execution as Execution } : {} }
}
/** Fixed English reason sentences written by versions before schema 11, mapped to their current reason codes. */
// schema 11 之前版本写下的固定英文原因句 → 当前原因码的映射
const SENTENCES: Readonly<Record<string, string>> = {
  'Assessment timed out': 'timeout', 'Assessment interrupted or timed out': 'timeout',
  'Assessment interrupted, timed out or ended without a decision': 'timeout',
  'Policy changed during assessment': 'policyChanged', 'Access or rule version changed': 'policyChanged',
  'No admissible trigger': 'noAdmissible', 'Explicit member request routed by the orchestrator': 'explicitRouted',
  'Explicit request from an allowed sender routed by the orchestrator': 'explicitRouted',
  'Imported from the pre-domain-model task record': 'legacyImport', 'host restarted': 'hostRestarted', 'Human asked to stop': 'humanStop',
  'Forwarded to the existing topic worker': 'forwarded', 'Sender is not an authorized human member': 'senderNotMember',
  'Retried by a person': 'retried', 'Stop target is unknown or already ended': 'stopUnknown',
  'Stop requires an explicit instruction from an authorized member': 'stopNotExplicit',
  'Implementation intent or target direction is not established, or a product/design decision is still required': 'directionUnsettled',
  'No enabled admission rule matched': 'noRuleMatched',
}
/** Parse a legacy reason string into a `Reason` when it matches a fixed sentence in `SENTENCES`, a parameterized sentence (`routed`, `startedTicket`, `observed`), or a snake_case gate/source code. */
// 解析旧原因串：命中 SENTENCES 固定句、参数化句式（routed/startedTicket/observed）或 snake_case 门/源码时转为 Reason
function knownReason(text: string): Reason | undefined {
  // 固定句命中
  if (SENTENCES[text]) return { code: SENTENCES[text] }
  // 参数化句式：路由到某工单 / 已被某工单接单
  const routed = /^Routed to ticket (\S+)$/.exec(text) ?? /^Already accepted as ticket (\S+)$/.exec(text)
  if (routed) return { code: text.startsWith('Routed') ? 'routed' : 'startedTicket', values: { ticket: routed[1]! } }
  // 观察模式句式
  const observed = /^Observe mode: would accept \((.*)\)$/s.exec(text)
  if (observed) return { code: 'observed', values: { text: observed[1]! } }
  // snake_case 代码（门/源码）直接作为原因码
  return /^[a-z]+(?:_[a-z]+)+$/.test(text) ? { code: text } : undefined
}
/**
 * Parse a stored Decision reason into structured `Reason` codes: splits `<triggerId>: <reason>` batches joined by `; `
 * into per-Trigger reasons, maps known sentences/codes via `knownReason`, and wraps any other free-form assessor or human
 * text with `said`.
 */
// 把存量决策原因解析为结构化 Reason：`<triggerId>: <原因>` 以 "; " 连接的批次拆为逐触发器原因，
// 已知句子/代码经 knownReason 映射，其余自由文本（评估者或人的话）用 said 包装。
export function reasonsOf(stored: unknown): Reason[] {
  // 已是数组：视为新形状
  if (Array.isArray(stored)) return stored as Reason[]
  const text = typeof stored === 'string' ? stored : ''
  // 按 "; " 切分并匹配 `<triggerId>: <原因>`
  const parts = text.split('; ').map(part => /^([^:\s]+): (.+)$/s.exec(part))
  // 每段都匹配且原因可识别：逐触发器输出
  if (parts.every(match => match && knownReason(match[2]!))) return parts.map(match => ({ ...knownReason(match![2]!)!, triggerId: match![1]! }))
  // 否则整串作为单条原因（已知则映射，未知则用 said 包装）
  return [knownReason(text) ?? said(text)]
}
/** Convert stored decision, disposition, and assignment end reasons from free-form strings to reason codes. */
// 把存量的决策、处置与派工结束原因从自由文本转换为原因码
function reasonsAsCodes(store: Store): void {
  // 决策：整串原因转结构化 Reason 数组
  for (const row of store.db.prepare('SELECT value FROM decision').all()) {
    const decision = JSON.parse(String(row.value)) as Decision & { reason: unknown }
    store.decisions.save({ ...decision, reason: reasonsOf(decision.reason) })
  }
  // 处置：filtered 为文本的转为 { code }
  for (const row of store.db.prepare("SELECT id, value FROM disposition WHERE json_type(value, '$.filtered') = 'text'").all()) {
    const disposition = JSON.parse(String(row.value)) as TriggerDisposition & { filtered: string }
    store.triggers.saveDisposition(String(row.id), { ...disposition, filtered: { code: SENTENCES[disposition.filtered] ?? disposition.filtered } })
  }
  // 派工结束原因：固定句映射为码（其余原样保留）
  for (const ticket of store.tickets.list()) {
    const ended = (reason?: string) => reason && SENTENCES[reason] === 'retried' ? 'retried' : reason && SENTENCES[reason] === 'hostRestarted' ? 'hostRestarted' : reason
    // 没有任何需要转换的：跳过
    if (!ticket.assignments.some(item => item.endedReason !== ended(item.endedReason))) continue
    // 逐条替换后保存
    const assignments = ticket.assignments.map(item => item.endedReason ? { ...item, endedReason: ended(item.endedReason) } : item)
    store.tickets.save({ ...ticket, assignments })
  }
}
/** Move `problem-dismissed:<decisionId>` KV flags onto their corresponding `Decision.dismissed` fields and delete the KV keys. */
// 把 problem-dismissed:<decisionId> 标记挪到对应决策的 dismissed 字段上，并删除 KV 键
function moveDismissals(store: Store): void {
  for (const name of store.keys('problem-dismissed:')) {
    const decision = store.decisions.get(name.slice('problem-dismissed:'.length))
    if (decision && store.get<unknown>(name) === true) store.decisions.save({ ...decision, dismissed: true })
    store.delete(name)
  }
}
/** Delete `github-ended:<number>` KV records after their close outcomes have been copied onto `Ticket.follows`. */
// 关闭结局已复制到工单 follows 后，删除 github-ended:<编号> KV 记录
function dropPullEnds(store: Store): void {
  for (const name of store.keys('github-ended:')) store.delete(name)
}
/** Infer a ticket's `ended.outcome` when predating recorded outcomes (`stopped` for human stops, else matching `reason` or defaulting to `closed`). */
// 在尚未记录结局的时代推断工单的 ended.outcome（人停为 stopped，否则取与 reason 相同的结局，缺省 closed）
function outcomeOf(ended: Pick<NonNullable<Ticket['ended']>, 'by' | 'reason'>): NonNullable<Ticket['ended']>['outcome'] {
  // 人为停止
  if (ended.by === 'human') return 'stopped'
  // reason 与四个结局同名则取之，否则 closed
  return (['completed', 'merged', 'closed', 'dropped'] as const).find(outcome => outcome === ended.reason) ?? 'closed'
}
/** Backfill thread creation and activity timestamps from their earliest and latest triggers. */
// 用线程上最早与最新的触发器回填线程的创建/活跃时间
function backfillThreadTimes(store: Store): void {
  // 已回填过（旧标记）：跳过
  if (store.get('thread-times-backfilled')) return
  for (const thread of store.threads.list()) {
    // 最早与最新触发器
    const first = store.read.firstTrigger(thread.key), last = store.read.threadTriggers(thread.key, 1)[0]
    // 线程上没有任何触发器：跳过
    if (!first || !last) continue
    // 取更早的创建时间与更新的活跃时间
    const times: Pick<Thread, 'createdAt' | 'lastAt'> = { createdAt: first.at < thread.createdAt ? first.at : thread.createdAt,
      lastAt: !thread.lastAt || last.at > thread.lastAt ? last.at : thread.lastAt }
    store.threads.save({ ...thread, ...times })
  }
}

/** Upgrade stored source state (Feishu topics, direct-chat flags, thread links, GitHub cursors, and pending assessments) to schema 11. */
// 把存量的数据源状态（飞书话题、私聊旗标、线程链接、GitHub 游标、待处理评估）升级为 schema 11。
function migrateSourceRecords(store: Store): void {
  // 六个来源状态迁移步骤依次执行
  feishuTopics(store)
  feishuDirectAddresses(store)
  feishuThreadLinks(store)
  issueSourceRecords(store)
  githubCursors(store)
  assessmentTriggers(store)
}
/** Convert legacy Feishu topic ID arrays into maps keyed by topic ID with the chat's last recovery timestamp. */
// 把旧版飞书话题 id 数组转换为"话题 id → 该会话最近恢复时间"的映射
function feishuTopics(store: Store): void {
  for (const name of store.keys(KV.feishu.topics)) {
    const topics: unknown = store.get(name)
    // 已是映射：跳过
    if (!Array.isArray(topics)) continue
    // 该会话的最近恢复时间（无记录用现在）
    const seen = store.get(KV.feishu.history(name.slice(KV.feishu.topics.prefix.length))) ?? new Date().toISOString()
    store.set(name, Object.fromEntries(topics.map(id => [String(id), seen])))
  }
}
/**
 * Backfill `direct: 'true'` onto Feishu channel addresses from `KV.feishu.chats`, because Feishu `oc_` chat IDs do not
 * distinguish direct messages from group chats on their own.
 */
// 从 KV.feishu.chats 给飞书渠道地址回填 direct: 'true'——飞书的 oc_ 会话 id 本身无法区分私聊与群聊。
function feishuDirectAddresses(store: Store): void {
  // 已知的私聊会话表
  const chats = store.get(KV.feishu.chats) ?? {}
  // direct：需要打私聊标记的渠道（来源/地址形状正确、会话在私聊表、且尚无 direct 字段）
  const direct = (channel: unknown): channel is ChannelRef => isObject(channel) && channel.source === 'feishu' && isObject(channel.address)
    && chats[String(channel.address.chatId)] === true && channel.address.direct === undefined
  // marked：打上 direct: 'true'
  const marked = (channel: ChannelRef): ChannelRef => direct(channel)
    ? { ...channel, address: { ...channel.address, direct: 'true' } } : channel
  // 触发器与出站箱两表逐行处理
  for (const table of ['trigger', 'outbox'] as const) {
    for (const row of store.db.prepare(`SELECT id, value FROM ${table} WHERE value ->> '$.channel.source' = 'feishu'`).all()) {
      const value = JSON.parse(String(row.value)) as Stored
      // 渠道不需打标：跳过
      if (!direct(value.channel)) continue
      // 重写该行的渠道地址
      const rewritten = JSON.stringify({ ...value, channel: marked(value.channel) })
      store.db.prepare(`UPDATE ${table} SET value = ? WHERE id = ?`).run(rewritten, row.id!)
    }
  }
  // 工单的渠道列表同样打标
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    const ticket = JSON.parse(String(row.value)) as Ticket
    if (ticket.channels.some(direct)) store.tickets.save({ ...ticket, channels: ticket.channels.map(marked) })
  }
}
/** Backfill chat URLs onto Feishu threads created before threads stored their own URL, inferring the brand from existing trigger URLs. */
// 给"线程存 URL 之前"创建的飞书线程回填会话链接：从既有触发器 URL 推断品牌（Lark 或飞书）
function feishuThreadLinks(store: Store): void {
  // 是否存在 larksuite.com 的触发器 URL（区分 Lark 与飞书）
  const lark = store.db.prepare(`SELECT 1 FROM trigger WHERE value ->> '$.source' = 'feishu'
    AND value ->> '$.url' LIKE '%larksuite.com%' LIMIT 1`).get()
  for (const thread of store.threads.list()) {
    // 非飞书线程 / 已有 URL / 首条触发器已带 URL：跳过
    if (thread.ref.source !== 'feishu' || typeof thread.meta.url === 'string' || store.read.firstTrigger(thread.key)?.url) continue
    // 从线程引用 id 中取出会话 id
    const chatId = thread.ref.id.split(':')[0]
    if (chatId) store.threads.save({ ...thread, meta: { ...thread.meta, url: feishuChatLink(lark ? 'lark' : 'feishu', chatId) } })
  }
}
/**
 * Reassign triggers from the removed `github-issue` source to `github`, schedule a retry from the earliest waiting message
 * within `POLL_HORIZON_MS` on each issue that had pending messages, and delete the obsolete `github-issue` KV keys.
 */
// 把已移除的 github-issue 源的触发器改归 github；对每个有待发消息且仍在 POLL_HORIZON_MS 窗口内的 Issue 安排重试；
// 删除废弃的 github-issue KV 键。
function issueSourceRecords(store: Store): void {
  // 触发器来源统一改为 github
  store.db.exec(`UPDATE trigger SET value = json_set(value, '$.source', 'github') WHERE value ->> '$.source' = 'github-issue'`)
  // 旧"待发消息"表：Issue 编号 → 时间
  const pending = store.get('github-issue-pending' as Key<Record<string, { number: number; at: string }>>) ?? {}
  // 现有的 GitHub 重试表
  const retries = { ...store.get(KV.github.retries) }
  for (const { number, at } of Object.values(pending)) {
    // 超出轮询窗口的不再安排
    if (!(Date.now() - Date.parse(at) < POLL_HORIZON_MS)) continue
    // 合并重试安排（保留更早的起始时间，pr 标记沿用）
    const retry = retries[number]
    retries[number] = { ...retry, since: retry && retry.since < at ? retry.since : at, pr: retry?.pr ?? false }
  }
  // 有重试安排才写回
  if (Object.keys(retries).length) store.set(KV.github.retries, retries)
  // 删除 github-issue 相关的废弃键
  const kept = ['github-issue-pending', 'github-issues-since', 'github-issues-started-at', ...store.keys('github-issue-eligibility:')]
  for (const name of kept) store.delete(name)
}
/** Consolidate per-issue/PR notification and thread subscription cursors into a single cursor holding the later timestamp. */
// 把每个 Issue/PR 的通知游标与线程订阅游标合并为单个游标（取更晚的时间戳）
function githubCursors(store: Store): void {
  for (const name of [...store.keys('github-thread:'), ...store.keys('thread-since:github:')]) {
    // 旧游标时间
    const at = store.get<string>(name as Key<string>)
    // 新统一游标键（按编号）
    const cursor = KV.github.cursor(Number(name.slice(name.lastIndexOf(':') + 1)))
    const current = store.get(cursor)
    // 旧游标更晚（或新游标缺失）：写入
    if (at && !(current && current >= at)) store.set(cursor, at)
    store.delete(name)
  }
}
/** Attach trigger IDs to pending assessment effects and re-enqueue undelivered active evaluations so their timeout deadlines start. */
// 给待处理的评估效果补上触发器 id；未投递的活跃评估重新入队，使其超时截止期开始计时
function assessmentTriggers(store: Store): void {
  // 活跃线程的评估 id → 首个触发器 id
  const triggers = new Map(store.threads.active()
    .flatMap(thread => thread.evaluating ? [[thread.evaluating.id, thread.evaluating.triggerIds[0]] as const] : []))
  // 逐条补全/清理缺触发器 id 的评估效果
  for (const row of store.db.prepare("SELECT key FROM effect WHERE kind = 'assessment' AND value ->> '$.triggerId' IS NULL").all()) {
    const triggerId = triggers.get(String(row.key))
    const named = JSON.stringify({ triggerId })
    // 找得到触发器：补写 id；否则删除该效果
    if (triggerId) store.db.prepare("UPDATE effect SET value = ? WHERE kind = 'assessment' AND key = ?").run(named, row.key!)
    else store.db.prepare("DELETE FROM effect WHERE kind = 'assessment' AND key = ?").run(row.key!)
  }
  // Re-enqueue active evaluations that predate delivery tracking so delivery starts their timeout deadline instead of leaving the thread stuck.
  // 把早于投递跟踪机制存在的活跃评估重新入队：由投递流程启动其超时截止期，线程不至于卡死
  let seq = Number(store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  for (const thread of store.threads.active()) {
    const evaluation = thread.evaluating
    // 已投递或无触发器：跳过
    if (!evaluation || evaluation.delivered || !evaluation.triggerIds[0]) continue
    // 重新入队评估效果（已存在则忽略）
    store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES ('assessment', ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING`)
      .run(evaluation.id, JSON.stringify({ triggerId: evaluation.triggerIds[0] }), ++seq, Date.now(), new Date().toISOString())
  }
}
