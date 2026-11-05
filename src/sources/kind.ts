/** SourceKind plugin contract: configuration schema, UI form fields, policy integration, channel adapter, and thread context reader. */
// SourceKind 插件契约：一个消息来源（Source）要接入 dsh-superagent，需要提供——
// 配置 schema、面板表单字段、Policy 集成（允许名单/准入表）、回写通道（channel）、
// 以及给评估用的 Thread 上下文读取器。
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { z } from 'zod'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext, SourceHost } from './host.ts'

// Localized：双语字段。
export interface Localized { zh: string; en: string }
/** `advanced` folds a rarely changed field (such as a polling tunable) behind the card's Advanced section. */
// FieldBase：表单字段基础——key/label/提示；advanced=true 时折叠进"高级"区（如轮询参数）。
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/**
 * Configuration field specification; `rows` edits a list of records keyed by its first column, `choose` picks from
 * resolved source labels, and `fact` displays a read-only value from `facts`.
 */
// FieldSpec：配置字段的规格（面板据此渲染）——
// switch 开关 / select 下选 / number 数字 / text 文本（pattern 校验、choose 从来源标签中挑、readonly）/
// fact 只读事实（来自 facts，如部署状态）/ rows 可编辑的记录列表（第一列作 key）。
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'fact'; settings?: 'deployment' }
  | FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] }

// VariableSpec：向执行环境注册的变量（如 GITHUB_TOKEN），带双语说明。
export interface VariableSpec { key: string; description: Localized }
// EnvironmentInput：计算变量值时拿到的输入——部署信息、实例配置、触发消息（可选）。
export interface EnvironmentInput<C> { deployment: Deployment; config: C; trigger?: Trigger }
// AdmissionRowView：该 Source 在 Policy 准入表中的一行的视图（三个格子 + 标签/说明）。
export interface AdmissionRowView { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }
/** Policy extension for a source kind, defining allowed senders, admission table rows, and optional external roster sync. */
// SourcePolicyPart：Source 类型的 Policy 扩展——允许名单（allowed）、准入表行、可选的外部花名册同步。
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** Validates the Source's part of the Policy, including `allowed` (senders who may originate work). */
  // schema：校验该 Source 的 Policy 部分，含 allowed（可以让 agent 干活的发送者）。
  schema: z.ZodType<P>
  /** Form fields of the policy part; the first is `allowed`. */
  // fields：Policy 部分的表单字段；第一个必须是 allowed。
  fields: FieldSpec[]
  /** Describes what the Source marks as addressed to the agent, which an allowed sender's explicit request requires. */
  // explicit：说明该 Source 把什么算作"点名 agent"（明确请求的必要条件）。
  explicit: Localized
  /** Fallback display labels for unlisted human or bot senders when raw sender IDs are not human-readable. */
  // unnamed：名单外发送者的兜底显示名（原始 id 不可读时用）。
  unnamed?: { person: Localized; bot: Localized }
  /** Receiving scopes of the Policy's admission table under `config` (matching `scope().row`); kinds without `rows` use the table's defaults. */
  // rows：在当前配置下的接收范围行（与 scope().row 对应）；没有此方法的类型用准入表默认行。
  rows?(config: Record<string, unknown>): AdmissionRowView[]
  /** Optional external roster sync (such as chat members); `ready` reports whether `part` names a target to refresh from. */
  // sync：可选的外部名单同步（如群成员）；ready 表示配置里是否指定了同步目标。
  sync?: { label: Localized; ready(part: P): boolean; run(host: SourceHost, part: P, signal: AbortSignal): Promise<P> }
}
/** UI link for a channel address; `triggerId` names the Trigger whose own deep link is preferred when available. */
// ChannelLink：回写地址对应的 UI 链接；triggerId 指明优先用该 Trigger 自身的深链。
export interface ChannelLink { url: string; label: Localized; triggerId?: string }
// ChannelLinks：构造链接所需的部署信息（仓库、飞书）。
export type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'feishu'>>
/** Outbound messaging adapter for a source kind's threads. */
// SourceChannel：该 Source 的外发（回写）适配器。
export interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  // allowed：这个地址还能不能收回复（没有此方法则一概可以）。
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  // send：按消息 id 幂等发送；目标会话已不可能收到回复时返回 'gone'；
  // 暂时性失败要抛错（交给 Outbox 重试）。
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** Returns the URL and label for `address`; `url` is empty when `links` lack the required deployment info. */
  // link：地址 → 链接与标签；部署信息不足时 url 为空。
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink
}
/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message can never authorize work on its own (at most an inferred candidate). */
// ContextMessage：上下文读取器返回的规范化消息——
// bot 标记非人发送者：它的消息自己永远不能授权工作（至多是 inferred 候选）。
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
// ContextPartName：可读的上下文部分——Thread 分页 / 话题根 / 所回复的父消息。
export type ContextPartName = 'thread' | 'root' | 'parent'
// ContextPart：一个上下文部分的内容——消息列表、下一页游标、原生附加信息、状态。
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** Bounded thread context reader used by assessments to inspect messages and images around a trigger. */
// ThreadContext：评估用的有界 Thread 读取器（围绕 Trigger 看消息与图片）。
export interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  // messageId：Trigger 自己的消息在其 Thread 消息中的 id。
  messageId(trigger: Trigger): string
  /** Reads a page of thread messages (`thread`, first page when `cursor` is omitted), the topic root (`root`), or the replied-to message (`parent`). */
  // read：读一页 Thread 消息（thread，无 cursor 为首页）、话题根（root）或所回复的父消息（parent）。
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
  /** Extracts image keys from message text that `image` can read; omitted for kinds without image support. */
  // images：从消息文本中提取可读的图片 key（不支持图片的类型省略）。
  images?(text: string): string[]
  /** Reads one image of a message in the Trigger's Thread as an attachment for `agent`. */
  // image：读取 Trigger 所在 Thread 中某条消息的一张图片，作为 agent 的附件。
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
// TriggerContext：绑定了一个具体 Trigger 的 ThreadContext（配置已解析、闭包已捕获 trigger）。
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
  images(text: string): string[]
  /** @throws for a kind without image support. */
  image(agent: Agent, commands: Commands, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
/** Pluggable source kind descriptor registered with SourceRegistry. */
// SourceKind：注册进 SourceRegistry 的可插拔 Source 描述符——
// 一个 kind = 一种来源类型（github / feishu）；实例（instance）是它的启用配置。
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; a default instance with the same ID exists when none is stored. */
  // 稳定 id；没有存储实例时，同 id 的默认实例生效。
  kind: string
  title: Localized
  description: Localized
  /** Read-only status facts derived from `deployment` (undefined while waiting for setup), keyed by field key. */
  // facts：从部署信息派生的只读状态事实（setup 未完成时为 undefined）。
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>
  /** Validates stored and submitted configuration and fills defaults. */
  // schema：校验存储与提交的配置并填默认值。
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** Health entry names owned by this kind under `health[...]`; no other kind or core loop may report them. */
  // health：该 kind 拥有的健康条目名（注册时独占声明，其他部件不得占用）。
  health: string[]
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  // scope：本类型 Trigger（或已记录 Mandate 依据）的监听规则；没有 scope 的类型全听、且不观察未点名消息。
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** Outbound reply adapter; kinds without `channel` produce no replies or channel checks. */
  // channel：回写适配器；没有 channel 的类型不产生回复。
  channel?: SourceChannel<C>
  /** Bounded context reader for assessments; assessments of a kind without `threadContext` read none. */
  // threadContext：评估用的有界上下文读取器；没有则评估只能看 Trigger 文本。
  threadContext?: ThreadContext<C>
  /** Maps a search query to candidate Thread keys (such as `github:12`) and Trigger search terms (such as a Feishu `om_` ID). */
  // find：把搜索词映射为候选 Thread key（如 github:12）与 Trigger 检索词（如飞书 om_ 消息 id）。
  find?(query: string): { threads: string[]; terms: string[] }
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  // repliesTo：不联网就能推导出"本 Trigger 回复的是哪条消息"的 Trigger id。
  repliesTo?(trigger: Trigger): string | undefined
  /** Policy section for kinds whose senders have their own identity. */
  // policy：发送者有独立身份的类型提供 Policy 部分（允许名单等）。
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  /** Rereads display names for row keys (such as chat names), stores the resolved names in `KV.sources.labels(kind)`, and returns them. */
  // refreshLabels：重读行 key 的显示名（如群名），存进 KV 并返回。
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>
  /** Variables the kind registers with the execution environment and how their values are computed. */
  // environment：向执行环境注册的变量及其取值方式。
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

// SourceInstance：一个 Source 实例——id（同 kind）、启用开关、配置。
export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
