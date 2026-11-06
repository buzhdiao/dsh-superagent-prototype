/** Block-scoped settings validation, optimistic concurrency saves, processing pause control, and source policy synchronization. */
// 按块（block）组织的设置校验、乐观并发保存、处理暂停控制，以及数据源（Source）策略同步。
import type { Context } from '@deepseek-ai/cordis'
// z：zod 校验库
import { z } from 'zod'
// UserError：用户错误；EngineForSettings：引擎对设置侧暴露的受限接口
import { UserError, type EngineForSettings } from '../core/index.ts'
// 各设置块的 zod schema、策略效果计算与策略版本号
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema, policyEffects, policyVersion } from '../policy.ts'
// 类型：Settings 值、SettingsBlock 块名、SettingsOrigin 来源、SettingsSave 保存记录
import type { Settings as SettingsValue, SettingsBlock, SettingsOrigin, SettingsSave } from '../policy.ts'
import type { SourceHost } from '../sources/host.ts'
// HealthBoard / HealthEntry：健康面板与条目类型
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { SourceRegistry } from '../sources/registry.ts'
// resolveRoleModel：解析角色模型路由
import { resolveRoleModel } from './role-models.ts'
// changedPaths：计算变化的字段路径；settingsNotice：设置变更通知内容
import { changedPaths, settingsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
// setupChanged：判断"setup 相关字段"是否变化
import { setupChanged, type Setup } from './setup.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

/**
 * Indicates an optimistic concurrency conflict when saving or syncing a settings block against a stale revision.
 * Thrown by `Settings.save` and `Settings.sync` and translated into an HTTP 409 response by the management routes.
 */
// SettingsConflict：保存或同步设置块时与过期修订发生乐观并发冲突；由管理路由翻译为 HTTP 409
export class SettingsConflict extends Error {}
// now：当前时间的 ISO 字符串
const now = (): string => new Date().toISOString()
/** Executor settings that control shell execution paths, prepare commands, and command shims. */
// 提取"执行环境相关"的 executor 设置（执行路径、prepare 命令、命令 shim）并序列化，用于比较这类字段是否变化
const environment = ({ executor }: SettingsValue) => JSON.stringify([executor.directory, executor.prepare, executor.blockedCommands])

/** Schema parser, settings merger, and non-panel origin guard for one settings block kind. */
// Block：一种设置块的处理契约——schema 解析、合并进总设置，以及（可选的）非面板来源守卫
interface Block {
  // 解析并校验该块的值（source 块需要实例 id）
  parse(value: unknown, sources: SourceRegistry, id: string): unknown
  // 把解析后的值合并进完整设置
  merge(settings: SettingsValue, value: unknown, id: string): SettingsValue
  // 可选守卫：非 panel 来源试图改动受限字段时抛错
  guard?(current: SettingsValue, candidate: SettingsValue, origin: SettingsOrigin): void
}
// 各设置块的处理实现
const BLOCKS: Record<'policy' | 'eval' | 'executor' | 'source', Block> = {
  // policy 块：先过 schema，再由数据源注册表校验其中各数据源的策略段
  policy: {
    parse: (value, sources) => {
      const policy = PolicyConfigSchema.parse(value)
      return { ...policy, sources: sources.validatePolicy(policy.sources) }
    },
    merge: (settings, value) => ({ ...settings, policy: value as SettingsValue['policy'] }),
  },
  // eval 块：纯 schema 校验与合并
  eval: { parse: value => EvalConfigSchema.parse(value), merge: (settings, value) => ({ ...settings, eval: value as SettingsValue['eval'] }) },
  // executor 块
  executor: {
    parse: value => ExecutorConfigSchema.parse(value),
    merge: (settings, value) => ({ ...settings, executor: value as SettingsValue['executor'] }),
    // Only the management panel may modify shell execution paths or commands.
    // 守卫：只有管理面板可以修改 shell 执行路径或命令
    guard: (current, candidate, origin) => { if (origin !== 'panel' && environment(current) !== environment(candidate)) throw new UserError('panelOnlyEnvironment') },
  },
  // source 块：某个数据源实例的开关与配置
  source: {
    parse: (value, sources, id) => sources.validate(id, z.object({ enabled: z.boolean(), config: z.unknown() }).parse(value)),
    merge: (settings, value, id) => ({ ...settings, sources: { ...settings.sources, [id]: value as SettingsValue['sources'][string] } }),
    // Only the management panel may switch source accounts.
    // 守卫：只有管理面板可以切换数据源账号
    guard: (current, candidate, origin) => { if (origin !== 'panel' && setupChanged(current, candidate)) throw new UserError('panelOnlyAccounts') },
  },
}

/** Host dependencies used by `Settings`. */
// SettingsHost：Settings 所需的宿主依赖
export interface SettingsHost {
  // 存储：设置读取/保存/块修订/原子事务/工单/键值
  readonly store: Pick<Store, 'settings' | 'saveSettings' | 'blockRevision' | 'atomic' | 'tickets' | 'get'>
  readonly sources: SourceRegistry
  /** Notified when a settings save changes the policy version. */
  // 引擎：设置保存使策略版本变化时通知它
  readonly engine: EngineForSettings
  /** Health board where each source's policy sync reports under `sync:<id>`. */
  // 健康面板：每个数据源的策略同步以 `sync:<id>` 为名上报
  readonly health: Pick<HealthBoard, 'claim'>
  /** DSH Cordis context used to validate and resolve role models. */
  // Cordis 上下文：用于校验与解析角色模型
  readonly context: Context
  // 生命周期取消信号
  readonly lifetime: AbortSignal
  /** Session manager through which the main Session is notified of saved settings. */
  // 会话管理器：通过它通知主会话设置已保存
  readonly sessions: Pick<Sessions, 'notify' | 'delivery'>
  /** Source host passed to source kinds' policy syncs and label refreshes. */
  // 数据源宿主：传给各数据源种类的策略同步与标签刷新
  readonly sourceHost: SourceHost
  /** Setup state, account/command checks, and restart trigger when setup-read fields change. */
  // setup：状态、账号/命令检查，以及 setup 相关字段变化时的重启触发
  readonly setup: Pick<Setup, 'configured' | 'checkAccounts' | 'blockCommands' | 'restart'>
  /** Triggers an immediate pass so work newly allowed by a settings save runs right away. */
  // 请求立即跑一轮处理，让新设置放行的工作马上执行
  requestPass(): void
}

/**
 * Validates and persists block-scoped settings in `Store`, enforces origin guards, and manages source policy synchronization and label refreshes.
 * `Runtime`, management HTTP routes, and main-Session tools read and save settings through it.
 * Notifies `Engine` when the policy version changes, notifies the main Session via `Sessions`, and triggers `Setup` restarts or `Passes` runs when saved settings take effect.
 * Tracks per-source synchronization status in `HealthBoard` and retries failed syncs with exponential backoff.
 */
// Settings：在 Store 中校验并持久化按块的设置，执行来源守卫，管理数据源策略同步与标签刷新。
// Runtime、管理 HTTP 路由与主会话工具经它读写设置。策略版本变化时通知 Engine，经 Sessions 通知主会话，
// 并在保存的设置生效时触发 Setup 重启或 Passes 运行。在 HealthBoard 中跟踪每个源的同步状态，失败按指数退避重试。
export class Settings {
  /** Per-source `sync:<id>` health entries, claimed lazily on each source's first policy sync. */
  // 每个数据源的 `sync:<id>` 健康条目：首次策略同步时才领取
  private readonly syncs = new Map<string, HealthEntry>()
  /** Pending exponential-backoff retry timer and last wait duration (ms) per source after a failed sync. */
  // 同步失败后的待重试定时器与上次等待时长（毫秒），按数据源记录
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>()
  constructor(private readonly host: SettingsHost) {
    // 生命周期中止时清掉全部重试定时器
    host.lifetime.addEventListener('abort', () => { for (const { timer } of this.retries.values()) clearTimeout(timer) }, { once: true })
  }
  /** Schedule exponential backoff retries (1 minute up to 1 hour) after a failed source sync, or clear pending retries on success. */
  // 源同步失败后安排指数退避重试（1 分钟起步，封顶 1 小时）；成功则清掉待重试
  private retrySync(id: string, failed: boolean): void {
    // 取并清掉已有的重试安排
    const previous = this.retries.get(id)
    if (previous) clearTimeout(previous.timer)
    this.retries.delete(id)
    // 未失败或已停机：不再重试
    if (!failed || this.host.lifetime.aborted) return
    // 等待时长：上次翻倍封顶 1 小时；首次 1 分钟
    const wait = previous ? Math.min(previous.wait * 2, 3_600_000) : 60_000
    // 安排重试（失败只记健康，不外抛）
    const timer = setTimeout(() => { this.sync(id).catch(() => { /* sync() records its failure in health. */ }) }, wait)
    // unref：不阻止进程正常退出
    timer.unref?.()
    this.retries.set(id, { timer, wait })
  }
  // 取（或首次领取）某数据源的同步健康条目
  private syncHealth(id: string): HealthEntry {
    let entry = this.syncs.get(id)
    if (!entry) this.syncs.set(id, entry = this.host.health.claim(`sync:${id}`))
    return entry
  }
  /** Returns the current validated settings from `Store`. */
  // 返回 Store 中当前（已校验过的）设置
  current(): SettingsValue { return this.host.store.settings() }
  /**
   * Returns an overview of all settings blocks with their current block revisions: full values for `pause`, `eval`, and
   * `executor`; rule summaries and allowed-sender counts for `policy`; and instance status switches for `sources` (with `read: 'settings/<block>'` paths for full block reads).
   */
  // 设置总览：pause/eval/executor 给全量值；policy 给规则摘要与各源允许发送者数；sources 给实例状态开关（附完整块读取路径）
  view() {
    const { store, sources } = this.host
    // 当前设置与"块修订号"读取器
    const settings = store.settings(), revision = (block: SettingsSave) => store.blockRevision(block)
    // 拆出策略规则与各数据源策略段
    const { rules, sources: parts } = settings.policy
    // 组装视图：全局修订号 + 各块
    return { revision: store.get(KV.settings.revision) ?? 0,
      pause: { revision: revision('pause'), value: { paused: settings.paused } },
      eval: { revision: revision('eval'), value: settings.eval },
      executor: { revision: revision('executor'), value: settings.executor },
      // policy：规则摘要 + 各源允许发送者数量 + 完整读取路径
      policy: { revision: revision('policy'), rules: rules.map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled })),
        allowed: Object.fromEntries(Object.entries(parts).map(([id, part]) => [id, part.allowed.length])), read: 'settings/policy' },
      // sources：每个实例的 id/种类/启用/安装状态、块修订与读取路径
      sources: sources.instances(settings).map(({ id, kind, enabled, installed }) =>
        ({ id, kind, enabled, installed, revision: revision(`source:${id}`), read: `settings/source:${id}` })) }
  }
  /**
   * Returns one settings block as accepted by `save` (`policy`, `eval`, `executor`, `pause` holding `{ paused }`, or
   * `source:<id>` holding `{ enabled, config }`) along with its current block revision.
   * @throws UserError (`unknownBlock`) when no such settings block exists.
   */
  // 读取单个设置块（与 save 的入参形状一致）及其当前块修订号；块不存在抛 unknownBlock
  block(block: string): { block: string; revision: number; value: unknown } {
    const { store, sources } = this.host
    // 解析出 source 实例 id（若有）
    const settings = store.settings(), id = block.startsWith('source:') ? block.slice('source:'.length) : undefined
    // source 块需要找到对应实例
    const instance = id === undefined ? undefined : sources.instances(settings).find(item => item.id === id)
    // 按块名取值：pause 给 { paused }；policy/eval/executor 给原值；source 给 { enabled, config }
    const value = block === 'pause' ? { paused: settings.paused } : block === 'policy' || block === 'eval' || block === 'executor' ? settings[block]
      : instance ? { enabled: instance.enabled, config: instance.config } : undefined
    // 未知块：抛用户错误
    if (value === undefined) throw new UserError('unknownBlock', { block })
    return { block, revision: store.blockRevision(block as SettingsSave), value }
  }
  /**
   * Validates and saves one settings block against its `revision`; a no-op save records no new revision, a changed policy
   * version notifies affected open tickets, and changing a setup-read field (`SETUP_FIELDS`, such as an account CLI) or any
   * change saved while waiting for setup (`!this.host.setup.configured()`) restarts `dsh-superagent` so setup runs again.
   * @param origin - Caller origin; restricts execution-environment and account-CLI changes to `'panel'` (a guardrail against prompt-injected tool calls, not an OS security boundary, since agents run shell commands; `origin` has no default so no caller receives panel privileges implicitly).
   * @returns Save outcome with the block's current `revision`, whether `policy_changed`, whether `restarting`, and `context_delivery` status (`'injected'` or `'pending'`).
   * @throws SettingsConflict when `block`'s revision changed before or during validation checks.
   * @throws UserError | z.ZodError when `block` is unknown, the source is not installed, `value` is invalid (such as an `executor` block carrying `paused`, which only `pause` sets), a non-panel `origin` changes panel-only fields, or a role-model or account check fails.
   */
  // 保存一个设置块（对其修订号做乐观并发检查）：无变化的保存不记新修订；策略版本变化时通知受影响的开放工单；
  // setup 相关字段变化（SETUP_FIELDS，如账号 CLI）或在等待 setup 期间的任何保存，都会重启 dsh-superagent 重新 setup。
  async save(block: SettingsBlock, value: unknown, revision: number, origin: SettingsOrigin) {
    const { store, sources, engine, sessions } = this.host
    // stale：块修订是否已过期
    const stale = () => revision !== store.blockRevision(block)
    // 保存前修订已过期：冲突
    if (stale()) throw new SettingsConflict('Settings changed. Reload before saving.')
    // 解析 source 块的实例 id 与块种类
    const id = block.startsWith('source:') ? block.slice(7) : block
    const kind = block.startsWith('source:') ? 'source' : block
    // 未知块种类：拒绝
    if (!(kind in BLOCKS)) throw new UserError('unknownBlock', { block })
    const rules = BLOCKS[kind as keyof typeof BLOCKS]
    // source 块的数据源种类必须已安装
    if (kind === 'source' && !sources.kind(id)) throw new UserError('sourceNotInstalled', { source: id })
    // schema 解析校验
    const parsed = rules.parse(value, sources, id)
    // 当前设置与合并后的候选设置
    const current = store.settings()
    const candidate = rules.merge(current, parsed, id)
    // eval/executor 块涉及角色模型变化时：先验证模型真实可用
    const model = block === 'eval' ? candidate.eval.model : block === 'executor' ? candidate.executor.model : null
    const previous = block === 'eval' ? current.eval.model : block === 'executor' ? current.executor.model : null
    if (model && JSON.stringify(model) !== JSON.stringify(previous)) {
      try { await resolveRoleModel(this.host.context, model) }
      catch (error) { throw new UserError('modelUnavailable', { block, error: error instanceof Error ? error.message : String(error) }) }
    }
    // 来源守卫（panel-only 字段的护栏）
    rules.guard?.(current, candidate, origin)
    // setup 相关字段变化：先校验账号 CLI 可用
    if (setupChanged(current, candidate)) await this.host.setup.checkAccounts(block, candidate)
    // 异步检查期间块可能又被改：再次检查修订
    if (stale()) throw new SettingsConflict('Settings changed during the checks. Reload before saving.')
    // Re-read current settings after async checks in case unrelated blocks were saved concurrently.
    // 异步检查后重读当前设置，防止并发保存的其他块被覆盖
    const old = store.settings()
    const settings = rules.merge(old, parsed, id)
    // 与现设置完全一致：无操作保存——不记新修订，只返回当前状态与投递情况
    if (JSON.stringify(SettingsSchema.parse(settings)) === JSON.stringify(old)) {
      const delivery = await sessions.delivery(`settings:${block}`)
      return { saved: true, revision: store.blockRevision(block), policy_changed: false, restarting: false, context_delivery: delivery }
    }
    // 是否需要重启：setup 相关字段变化，或本就处于等待 setup 状态
    const restarting = setupChanged(old, settings) || !this.host.setup.configured()
    // 前后策略版本号
    const before = policyVersion(old), after = policyVersion(settings)
    // scope：把数据源的作用域判断注入策略效果计算
    const scope = (version: SettingsValue) => ({
      scope: (input: { source: string; meta: Record<string, unknown> }) => this.host.sources.scope(input, version) })
    // 计算策略效果（哪些开放工单受影响）；版本未变则无效果
    const effects = before === after ? new Map() : policyEffects(store.tickets.open(), old, SettingsSchema.parse(settings), scope)
    // 受通知的工单 id 列表
    const notified = [...effects.keys()]
    // 原子落盘：保存设置、（非工具来源时）通知主会话、（版本变化时）通知引擎
    store.atomic(() => {
      store.saveSettings(SettingsSchema.parse(settings), { source: origin, block, policyVersion: after, policyChanged: before !== after, notified })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(old, settings)))
      if (before !== after) engine.policyChanged(before, after, effects)
    })
    // Rewrite worker command shims immediately when `blockedCommands` changes.
    // blockedCommands 变化时立即重写 worker 命令 shim
    const blocked = settings.executor.blockedCommands
    const changed = blocked.join(' ') !== old.executor.blockedCommands.join(' ')
    if (changed) await this.host.setup.blockCommands(blocked)
    // When restarting, the notice stays pending until after the restart; `setup.restart()` defers until this call returns.
    // 重启场景：通知保持 pending 直到重启完成；setup.restart() 会推迟到本次调用返回之后
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    // 需要重启则重启，否则请求立即处理一轮（让新设置立刻生效）
    if (restarting) this.host.setup.restart()
    else this.host.requestPass()
    // 返回保存结果
    return { saved: true, revision: store.blockRevision(block), policy_changed: before !== after, restarting, context_delivery: delivery }
  }
  /**
   * Pauses or resumes processing (new evaluations, worker dispatch, and channel delivery, while Sources continue recording
   * Triggers); saved in its own `'pause'` block so concurrent `executor` edits remain valid across it.
   * @returns Whether processing is now paused (`{ paused }`).
   */
  // 暂停/恢复处理（新的评估、worker 派发与渠道投递；数据源仍继续记录触发器）。
  // 存为独立的 'pause' 块：并发的 executor 编辑不会因此失效。
  async pause(paused: boolean, origin: SettingsOrigin): Promise<{ paused: boolean }> {
    const { store, sessions } = this.host
    // 状态未变：幂等返回
    const old = store.settings()
    if (old.paused === paused) return { paused }
    // 原子保存 pause 块，并（非工具来源时）通知主会话
    store.atomic(() => {
      const record = { source: origin, block: 'pause' as const, policyVersion: policyVersion(old), policyChanged: false, notified: [] }
      store.saveSettings({ ...old, paused }, record)
      if (origin !== 'tool') sessions.notify(...settingsNotice('pause', ['paused']))
    })
    // 等通知投递完成
    await sessions.delivery('settings:pause')
    // 请求立即处理一轮（暂停/恢复立即生效）
    this.host.requestPass()
    return { paused }
  }
  /** Returns the IDs of installed, enabled Sources whose policy section can synchronize now (empty while setup is not configured). */
  // 返回"已安装且启用、且其策略段当前可同步"的数据源 id（setup 未完成时为空）
  syncable(): string[] {
    const { sources } = this.host
    // setup 未完成：不能同步
    if (!this.host.setup.configured()) return []
    return sources.instances().filter(instance => instance.installed && instance.enabled).flatMap(instance => {
      // 该源种类的同步定义与当前策略段
      const sync = sources.kind(instance.id)?.policy?.sync
      const part = sources.policyPart(instance.id)
      // 两者齐备且同步方声明就绪才可同步
      return sync && part && sync.ready(part) ? [instance.id] : []
    })
  }
  /**
   * Synchronizes source `id`'s policy section from its external source of truth, saves it as a `'policy'` revision when
   * changed, and records the outcome in the `sync:<id>` health entry (scheduling exponential-backoff retries via `retrySync` on failure).
   * @returns The synchronized policy section for `id`.
   * @throws UserError (`nothingToSync`) when `id` cannot sync now, `SettingsConflict` if the `'policy'` block changed during synchronization, or the underlying sync error on failure.
   */
  // 从外部事实源同步某数据源的策略段：有变化时保存为一次 'policy' 修订，
  // 并把结果记入 sync:<id> 健康条目（失败时经 retrySync 安排指数退避重试）。
  async sync(id: string) {
    const { store, sources } = this.host
    // 当前不可同步：拒绝
    if (!this.syncable().includes(id)) throw new UserError('nothingToSync', { source: id })
    // 领取该源的健康条目
    const health = this.syncHealth(id)
    try {
      // 记录同步前的 policy 块修订号（用于并发检查）
      const revision = store.blockRevision('policy')
      // 执行外部同步，拿到最新策略段
      const part = await sources.kind(id)!.policy!.sync!.run(this.host.sourceHost, sources.policyPart(id)!, this.host.lifetime)
      // 同步期间 policy 块被改：冲突（避免覆盖他人修改）
      if (revision !== store.blockRevision('policy')) throw new SettingsConflict('Policy changed during synchronization. Retry with the current settings.')
      const policy = store.settings().policy
      // Skip saving a new revision when the synced list is unchanged.
      // 同步结果与现有内容一致：跳过保存（不产生新修订）
      if (JSON.stringify(part) !== JSON.stringify(policy.sources[id])) {
        await this.save('policy', { ...policy, sources: { ...policy.sources, [id]: part } }, revision, 'sync')
      }
      // 健康标为就绪（附允许数量），并清掉重试安排
      health.set({ state: 'ready', detail: `${part.allowed.length} allowed`, at: now() })
      this.retrySync(id, false)
      return part
    } catch (error) {
      // 失败：健康标错并安排退避重试，错误继续上抛
      health.set({ state: 'error', detail: String(error), at: now() })
      this.retrySync(id, true)
      throw error
    }
  }
  /**
   * Rereads a Source's display names (such as Feishu chat names) immediately.
   * @returns Sorted display names (`{ added }`) that were not present in the stored label map before this read.
   * @throws UserError (`noLabels`) when the Source has no label refresh; rethrows a failed read, keeping the stored list.
   */
  // 立即重读某数据源的显示名（如飞书群名）；返回新增名称（已排序）
  async refreshLabels(id: string): Promise<{ added: string[] }> {
    const { store, sources } = this.host
    // 实例与种类必须存在且支持标签刷新
    const instance = sources.instance(id)
    const kind = instance && sources.kind(instance.kind)
    if (!kind?.refreshLabels) throw new UserError('noLabels')
    // 读取现有标签映射
    const before = store.get(KV.sources.labels(id)) ?? {}
    // 执行刷新（失败原样抛出，存量列表保持不变）
    const after = await kind.refreshLabels(this.host.sourceHost)
    // 返回新增名称（排序）
    return { added: Object.entries(after).filter(([key]) => !(key in before)).map(([, name]) => name).sort((a, b) => a.localeCompare(b)) }
  }
}
