/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
// SourceRegistry：已安装 Source kind 的注册表、其实例配置的管理者，
// 也是 Engine 的 SourceScope（监听判断）实现——通用代码经它访问一切 Source 能力。
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'


/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
// SourceRegistry：管理注册的 SourceKind 插件，校验其实例与 Policy 配置，
// 并为 Engine 实现 SourceScope。注册时在 HealthBoard 上独占声明各 kind 的健康条目；
// Runtime、Settings、Outbox、MasterAssessor 对通道、链接、环境变量、Thread 读取器的
// 访问都经它中转——Source 侧的具体实现由此对上层不可见。
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  // register：注册一个 SourceKind——
  // 健康条目在 HealthBoard 上独占声明（`sync:` 前缀归 Settings 所有，kind 不得占用）；
  // 返回注销函数（清理 kind 与健康条目）。
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    // 任一条目声明失败：先释放已成功的，再整体拒绝。
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  // healthEntries：取当前仍有效的健康条目。
  // Source 上下文只持有构建时拿到的条目——注销后再上报是空操作（旧引用失效），不会串到重新注册的新条目。
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  // kind：按 id 取 kind。
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** Every registered kind's instance ordered by ID, followed by stored instances whose kind is not installed (with their config kept as stored). */
  // instances：全部实例（面板用）——已安装的按 id 排序；kind 已卸载的"孤儿实例"附在后面，配置原样保留。
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).map(kind => ({ ...this.resolve(kind, settings.sources[kind.kind]), installed: true }))
    const orphaned = Object.entries(settings.sources).filter(([id]) => !this.kinds.has(id)).map(([id, stored]) => ({ id, kind: id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  // instance：按 id 取单个实例。
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kinds.get(id)
    return kind ? this.resolve(kind, settings.sources[id]) as SourceInstance<C> : undefined
  }
  // validate：校验提交的实例配置（enabled + 经 kind schema 解析的 config）。
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const kind = this.kinds.get(id)
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  // validatePolicy：逐个 kind 校验提交的 Policy 部分；
  // 未安装 kind 的部分原样保留（不丢配置）。admission 由 Policy 自己的 schema 校验。
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kinds.get(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  // policyPart：读某 kind 当前 Policy 部分（解析失败回退默认/空表）。
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kinds.get(id)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  // channelAllowed：某地址还能否收回复——kind 未安装不行；实例禁用不行；kind 的 allowed 说了算。
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kinds.get(channel.source)
    if (!kind) return false
    const instance = this.resolve(kind, settings.sources[channel.source])
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  // declarations：每个已安装 kind 的环境变量声明（不论启用与否——setup 与校验需要）。
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  // environments：启用实例的环境变量及其取值器（供 Setup 与执行环境使用）。
  environments(settings = this.settings()) {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      const instance = this.resolve(kind, settings.sources[kind.kind])
      return kind.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  // send：经其 kind 的 Channel 幂等发送——
  // kind 未装：'waiting'（消息先攒着）；kind 没有通道或目标已不可达：'gone'（丢弃）。
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kinds.get(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands }, message) : 'gone'
  }
  // link：地址 → 链接；kind 没有通道时给空链接（label 用来源名）。
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kinds.get(channel.source)?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  // find：跨所有 kind 的搜索（合并去重 Thread 与检索词）。
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  // repliesTo：转发给对应 kind 的 repliesTo。
  repliesTo(trigger: Trigger): string | undefined { return this.kinds.get(trigger.source)?.repliesTo?.(trigger) }
  // threadContext：把 kind 的 ThreadContext 与实例配置绑定成一个针对具体 Trigger 的读取器。
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kinds.get(trigger.source)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind, settings.sources[kind.kind])
    return {
      messageId: context.messageId(trigger),
      // read：闭包捕获 trigger 与 config，调用方只给 part/cursor。
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      // image：没有图片能力的 kind 抛错。
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  // scope：Engine 的 SourceScope 实现——
  // kind 未装：配置过的 Source 什么也不听（source_not_installed）；没配置过的默认全听不观察。
  // 实例禁用：不听。其余交给 kind 自己的 scope 规则。
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kinds.get(input.source)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  // resolve：合并存储配置与 schema 默认值——
  // 存储配置校验失败：回退 schema 默认并禁用实例（脏配置不至于半生不熟地运行）。
  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id: kind.kind, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
