/**
 * Runtime settings schemas, assessment validation, and policy gate evaluation.
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
// policy.ts：运行时设置的 schema、评估结论校验、Policy 门（gate）的判定——授权的核心。
// "谁能让 agent 干活"按 Source 各自的身份体系配置（GitHub 用户名 / 飞书 open_id）；
// Policy 不做跨 Source 的身份映射（同一个人在两边是两条记录）。
import { LIMITS } from './limits.ts'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { key, type AssessmentOutcome, type Mandate, type Policy, type PolicyEffect, type SourceScope, type Strength, type Thread, type Ticket,
  type Trigger, type ActorRef, type GateResult } from './core/index.ts'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'

// RuleIdSchema：规则 id——字母数字下划线连字符，至多 80 字符。
export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
// RuleMatchSchema：评估中"命中某条规则"的记录（id + 一句理由）。
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
// RuleAssessmentSchema：对一条启用规则的完整评估（命中与否 + 理由）。
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
// AdmissionDirectionSchema：评估必须给出"方向三问"——是否要求实现、目标是否有依据、是否还需设计决策。
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
// directionAllowed：评估是否确立了"实现意图 + 有依据的目标 + 无待决设计"——三者齐备才允许 accept。
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
// Assessment：评估的结构（与 AssessmentSchema 的形状对应，此处为宽松接口）。
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
// assessmentOutcome：把评估转换为 Engine 的 AssessmentOutcome——
// 规则覆盖必须"每条启用规则恰好评一次"；accept 要求方向成立 + 至少一条启用规则命中 + 意图证据；
// inferred 候选只在 auto 模式接受，observe 模式记为 would_accept（观察记录）。
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  // 覆盖校验：数量一致、无重复、无未知/禁用 id。
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  // audit：全部评估记录进 Decision，供面板与审计。
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    // observe 模式：记录"本会接受"及提案，但不真正开工。
    const proposal = { title, scope, worktree_name: name }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}) }
}
// DEFAULT_RULES：开箱即用的两条规则——错别字修正与局部视觉修复（都很窄）。
const DEFAULT_RULES = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
// Rule：一条准入规则——说明"什么样的活可以接、怎么干、怎么沟通"。
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction) }).strict()
export type Rule = z.infer<typeof RuleSchema>
// RoleModel：一个角色（评估/执行）用的模型（提供方 + 模型名 + 可选推理力度）。
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>

// AllowedSchema：允许名单里的一项（发送者 id + 可选显示名）。
export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
// Weak：准入表里"较弱"的两个取值（未点名消息不可能 explicit）。
const Weak = z.enum(['inferred', 'ignore'])
// AdmissionRowSchema / AdmissionTableSchema：准入表的行与表（行 id 是 Source 给的接收范围）。
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: Weak.optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
// SourcePolicySchema：一个 Source 的 Policy 部分——允许名单、准入表、其余字段（bots 等）由 kind 校验。
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}) }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
// PolicyConfigSchema：policy 块——规则（id 去重）+ 各 Source 部分。
export const PolicyConfigSchema = z.object({
  rules: z.array(RuleSchema).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs').default(DEFAULT_RULES),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({}),
}).strict()
// EvalConfigSchema：eval 块——模式（off/observe/auto）、评估超时、评估模型。
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  model: RoleModelSchema.nullable().default(null),
}).strict()
// CommandNameSchema：可屏蔽的命令名——合法命令名，且不允许屏蔽 worker 必需命令。
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare` command, and blocked commands. */
// ExecutorConfigSchema：executor 块——worker 模型、并发数、目录根、prepare 命令、屏蔽命令。
export const ExecutorConfigSchema = z.object({
  model: RoleModelSchema.nullable().default(null),
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty for <stateDir>/work').default(''),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
}).strict()
// SourceInstanceSchema：一个 Source 实例的存储形状（启用 + 原始配置）。
export const SourceInstanceSchema = z.object({ enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}) }).strict()
// SettingsSchema：全部设置的顶层 schema。
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
// SettingsBlock：可保存的设置块；SettingsSave 额外含 pause；SettingsOrigin：保存来源（panel/tool/sync）。
export type SettingsBlock = 'policy' | 'eval' | 'executor' | `source:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync'

// POLICY_REVISION：版本算法自己的版本号（算法变了才升）。
export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
// policyVersion：对"影响授权"的设置算版本哈希——
// 模型、并发、暂停、轮询间隔的变化不改变版本（不作废既有 Mandate 与进行中的 Eval）。
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
// allowedSender：在发送者所属 Source 的允许名单里查它。
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
// listedBot：在 Source 的 bot 名单里查它——名单内 bot 的消息至多是 inferred 候选。
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
// anyoneAllowed：任何 Source 配了允许名单吗（setup 引导用）。
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
// senderName：名单项的显示名。
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
// participating：Thread 上是否有"真正的"工单（排除仅为上下文的订阅）——追问强度的基础。
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
// listened：查 Source scope 的监听判断。
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

// admissionCell：按"是否在名单 / 是否点名"映射到准入表格子（名单内且点名不用表——必 explicit）。
function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
// admissionOf：取某行某格的准入值；没有行则用默认值。
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
// STRENGTH：准入值的强度序（ignore < inferred < explicit），复核时比较。
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
// policyEffects：计算设置从 old 变到 now 对每个存活工单的影响——
// 规则变更/失效、发送者失去授权、inferred 工作不再被接受（模式离开 auto）。
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    // 规则维度：工单依据的规则哪些变了/失效了。
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    // Mandate 复核维度：旧版放行、新版不再放行——定位是发送者还是模式变了。
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      // 保留旧模式与旧规则再看一次：仍不放行 → 是发送者/接收范围失去了授权。
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
// settingsPolicy：由设置构建一个无状态的 Policy 对象（门 + 复核 + 模式判断）——
// 每次调用都新建，天然反映最新设置。
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  // machineGate：非人类 Trigger 的门——只有名单内 bot（至多 inferred）与无发送者的系统/CI 事件能过。
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    // 名单外 bot / Source 不听 / 既没点名也不在观察范围：拒绝。
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      // 名单内 bot：off 模式直接拒；否则作为 inferred 候选（带观察记录）。
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    // 无发送者的系统/CI 事件：只走"名单外未点名"格子，且需 inferred + 非 off。
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    // gate：人类 Trigger 的门——名单 + 点名 + 准入表 + 追问四条路径。
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      // 路径一：名单内 + 点名 = 明确请求（explicit），不需要准入表。
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      // 未点名的消息只有在 Source 观察该范围全部消息时才进准入表（否则根本收不到）。
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      // 先查 explicit 格子再查追问——已有工单的 Thread 不能把明确请求降级成追问。
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      // 路径二：追问（Thread 上有真工单）——
      // 私聊线程只属于一个发送者（别人没有追问可言）；off 模式不产生 inferred 追问（交给表）。
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      // 路径三：准入表格子给 inferred 且非 off。
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      // 拒绝：原因按情况区分（不在名单 / 表配置忽略 / 没点名）。
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    // admitsInferred：inferred 候选能否被接受——auto 模式 + 至少一条规则 + 全部是启用中的规则。
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    // revalidate：复核旧 Mandate 在当前 Policy 下是否仍成立（恢复工单/附加前用）。
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      const { source } = basis
      // 接收范围已不被监听：立即失效。
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      // 追问：explicit 永远有效；inferred 要求 auto + 规则仍启用。
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      // bot：先看还在不在名单，后面再看观察条件。
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      // 准入表：发送者现在的格子强度不低于原来即可。
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        // 接受后被加进名单的发送者：格子迁移到 listedUnaddressed。
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      // 观察型/inferred 的 Mandate：auto 模式 + 规则仍启用才继续有效。
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
