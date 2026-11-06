/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
// 类型化的键值（KV）存储键与键族（key family），按唯一拥有并写入该族的组织部分分组。
// 读写方都通过这里的条目引用记录，使每个键只拼写一次并带上值类型。
import type { PromptVersion } from './app/prompts.ts'
// PromptVersion：提示词版本类型。
import type { SettingsVersion } from './app/store.ts'
// SettingsVersion：设置版本类型。
import type { SettingsSave } from './policy.ts'
// SettingsSave：设置保存结构（用于块修订键名）。
import type { Retry } from './sources/github.ts'
// Retry：GitHub 重试记录类型。

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
// Key<V>：值类型为 V 的 KV 键（幻影类型）；纯字符串即无类型键。
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
// Family：共享前缀的键族——可调用以由名字部分构造键，并暴露 prefix 供枚举。
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
// 定义单个类型化 KV 键；外部来源（Source）插件也用 record/family 为自己的键标注类型。
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  // 定义键族：键由 prefix 与名字部分以 `:` 连接（或自定义 format）。
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
  // 返回可调用对象并附上 prefix 属性。
}

export const KV = {
  // 全部 KV 键的注册表，按拥有组件分组。
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  // Store：当前数据库模式（schema）版本。
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  // Settings：当前修订号、每块修订号、以及保存过的设置快照（含当前版本）。
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  // Prompts：当前修订号与保存过的提示词版本；builtIn 记录覆盖项编辑自的内置原文（按 base），用于展示升级改了什么。
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  // Runtime：主会话（main Session）的 ID。
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  // Sessions：每个会话工作过的提示词修订号（最旧在前；最后一项即当前生效修订）。
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  // 模式 11 迁移：旧主会话队列导入效果表——转达队列、退订结果、提示词/设置通知游标。
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  // 各来源已解析的显示名：把命名 ID（如飞书群 ID）映射为显示名。
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  // GitHub 来源：通知游标与待重试；通知/轮询共享的 Issue/PR 读取游标；每条流的游标、按类的起始时间与 ETag；
  // 默认分支 CI 状态；以及每个 PR 的 CI 指纹与修订号（revision 计数已上报的 CI 变化，使每次变化产生独立触发 ID）。
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
  // 飞书来源：已知群聊（true 表示单聊）；每群历史游标与活跃话题（话题 ID → 最近可见时间）；
  // 每个轮询线程已见消息 ID 与初始化标记。
}
