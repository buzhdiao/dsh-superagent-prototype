/** Manages versioned role prompts, behavioral policies, and operational skills independently of access settings. */
// 管理版本化的角色提示词（prompt）、行为策略与运营技能（Skill），与访问设置（access settings）相互独立。
// z：zod 校验库
import { z } from 'zod'
// UserError：面向用户的业务错误；key：生成内部 KV 键
import { UserError, key } from '../core/index.ts'
// policyVersion：策略版本号；Settings/SettingsOrigin：设置与其来源类型
import { policyVersion, type Settings, type SettingsOrigin } from '../policy.ts'
// 从 context 导入各内置提示词文本（两个角色提示词、共用段、策略段、准入、交接、团队默认、Source 技能、CLI 说明）
import { masterPrompt, workerPrompt, sharedPrompt, guides, mainAdmissionPolicy, handoffPolicy, teamDefaults, sourceSkills, cliNotes } from './context.ts'
// environmentLines：把执行环境变量渲染成清单行；Variable：环境变量类型
import { environmentLines, type Variable } from './execution-environment.ts'
// promptsNotice：提示词变更后给主 Session 的通知内容
import { promptsNotice } from './notices.ts'
// Sessions：会话管理器类型（用于通知与投递查询）
import type { Sessions } from './sessions.ts'
// Store：持久化存储类型
import type { Store } from './store.ts'
// Versions：版本化记录存储（保存提示词配置的历史修订）
import { Versions } from './versions.ts'
// KV：内部键值表的键族定义
import { KV } from '../kv.ts'

/** Prompt sections the team writes; the built-in parts follow dsh-superagent's text until the team overrides them. */
// 团队自行编写的提示词段落（preset 段）：未覆盖之前，内置部分沿用 dsh-superagent 的文本
export const TEAM_SECTIONS = ['communication', 'scope', 'delivery'] as const
// 团队段落名的字面量联合类型
export type TeamSection = typeof TEAM_SECTIONS[number]
/** Markdown headings for each team section; fixed prompt sections refer to them by these exact names. */
// 各团队段落在提示词中的 Markdown 标题；固定段落以这些确切标题名引用它们
const TEAM_HEADINGS: Record<TeamSection, string> = { communication: 'Communication', scope: 'Ticket scope', delivery: 'Delivery requirements' }
// 合法技能名的正则：小写字母开头，后接小写字母/数字/连字符
export const SKILL_NAME = /^[a-z][a-z0-9-]*$/
/** Prefix prepended to skill names when registering them in DSH Sessions. */
// 在 DSH Session 中注册技能时统一加的前缀
export const SKILL_PREFIX = 'dsh-superagent-'
// 技能名校验 schema：符合 SKILL_NAME 正则，且不得与内置 Source 技能重名
const SkillNameSchema = z.string().regex(SKILL_NAME).refine(name => !(Object.keys(sourceSkills) as string[]).includes(name),
  'This name belongs to a built-in skill')
/** The built-in parts a team may override, by key: both roles' parts, the Source skills, and the generated parts' templates. */
// 团队可覆盖的内置部分（part）的全部键：两个角色各自的段落、Source 技能，以及"生成部分"的模板
const PART_KEYS = ['runtime/shared', 'runtime/orchestrator', 'runtime/worker', 'runtime/subscriptions', 'runtime/replies',
  'runtime/dispatch', 'runtime/work', 'runtime/admission', 'runtime/handoff/orchestrator', 'runtime/handoff/worker', 'runtime/environment',
  'runtime/policy', 'runtime/policy/none', 'skill/feishu', 'skill/github'] as const
// PartKey：内置部分键的字面量联合类型
export type PartKey = typeof PART_KEYS[number]
/** A team's text for a built-in part, and `base`, the key of the built-in text it was edited from. */
// 覆盖（override）schema：text 为团队的替换文本；base 记录它所编辑自的内置文本的键（升级时用于对比变化）。strict() 拒绝未知字段
const OverrideSchema = z.object({ text: z.string(),
  base: z.string().optional().describe('Key of the built-in text it was edited from; copy as read, or omit.') }).strict()
/**
 * A configuration, whose overrides may name a part a later version no longer has, which `Prompts.validate` drops when the
 * saved version holds it and refuses otherwise.
 */
// 提示词配置 schema：三个团队段落文本 + 团队技能表 + 可选的内置部分覆盖表。
// 覆盖可能指向后续版本已不存在的部分：`Prompts.validate` 在"已保存版本确实持有该部分"时静默丢弃，否则拒绝。
export const PromptConfigSchema = z.object({ communication: z.string(), scope: z.string(), delivery: z.string(),
  skills: z.record(SkillNameSchema, z.string()), overrides: z.record(z.string(), OverrideSchema).optional()
    .describe('Text in place of a built-in part, by its key in prompts/defaults; a part not named follows its built-in text.') }).strict()
// PromptConfig：由 schema 推导出的配置类型
export type PromptConfig = z.infer<typeof PromptConfigSchema>
// 一次提示词修订（revision）的完整记录：修订号、上一修订号、保存时间、来源、配置
export interface PromptVersion { revision: number; previousRevision: number | null; savedAt: string; source: string; config: PromptConfig;
  /** Original unmigrated config preserved when differences cannot be compared across schema versions. */
  // 未经迁移的原始旧配置（schema 版本差异导致无法逐字段对比时原样保留）
  legacy?: { config: unknown } }
// 默认提示词配置：团队段落取内置默认文本，无任何团队技能与覆盖
export const defaultPrompts = (): PromptConfig => ({ ...teamDefaults, skills: {} })

// 执行环境段落的固定标题（说明其来自本安装的设置、优先于指令中出现的其他仓库/账号；空值表示此处未配置该部分）
const ENVIRONMENT_HEADING = 'Execution environment (from this installation\'s settings; it takes precedence over any repository or account named elsewhere in these instructions; an empty value means that part is not configured here). The prepare command of a ticket directory reads the same variables:'
// Policy 段落开头模板：含策略版本号与接受模式（accept mode）占位符；并说明二者与规则只影响主动候选（explicit 请求任何模式下都按 dispatch 路由）
const POLICY_HEAD = '## Policy\nPolicy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.'
// Role：角色名（orchestrator 调度者 / worker 执行者）
type Role = 'orchestrator' | 'worker'
/** A built-in part a team may override: the roles that read it, its text, and the placeholders a template's override keeps. */
// 内置部分：哪些角色读取它（roles）、文本内容（text）、模板覆盖必须保留的占位符（placeholders）
interface BuiltInPart { roles: readonly Role[]; text: string; placeholders?: readonly string[] }
// 三种角色集合常量：BOTH 两角色、MAIN 仅调度者、WORKER 仅执行者
const BOTH: readonly Role[] = ['orchestrator', 'worker'], MAIN: readonly Role[] = ['orchestrator'], WORKER: readonly Role[] = ['worker']
// 内置部分表缓存：首次使用时才构建（因其读取的文本模块存在循环导入），undefined 表示尚未构建
let parts: Readonly<Record<PartKey, BuiltInPart>> | undefined
/**
 * The built-in parts of both roles' prompts, the two Source skills, and the templates of the generated parts, whose data the
 * system fills in, by the key an override names them by. Built on first use, as the texts it reads are imported in a cycle.
 */
// 内置部分注册表：两个角色提示词的内置部分、两个 Source 技能，以及各"生成部分"的模板（数据由系统填入），键即覆盖所用的键。
// 首次调用时才构建——因为它读取的文本模块存在循环导入。
export const builtInParts = (): Readonly<Record<PartKey, BuiltInPart>> => parts ??= {
  // 共用基础提示词（两角色）与调度者/执行者各自的角色提示词
  'runtime/shared': { roles: BOTH, text: sharedPrompt }, 'runtime/orchestrator': { roles: MAIN, text: masterPrompt },
  'runtime/worker': { roles: WORKER, text: workerPrompt },
  // 四个策略段：订阅（subscriptions）与回复（replies）两角色共用；派发（dispatch）归调度者、工作（work）归执行者
  'runtime/subscriptions': { roles: BOTH, text: `## subscriptions\n${guides.subscriptions}` },
  'runtime/replies': { roles: BOTH, text: `## replies\n${guides.replies}` },
  'runtime/dispatch': { roles: MAIN, text: `## dispatch\n${guides.dispatch}` }, 'runtime/work': { roles: WORKER, text: `## work\n${guides.work}` },
  // 主准入策略：仅调度者
  'runtime/admission': { roles: MAIN, text: mainAdmissionPolicy },
  // 交接（handoff）策略：共用段 + 角色专属段
  'runtime/handoff/orchestrator': { roles: MAIN, text: handoffPolicy('orchestrator') },
  'runtime/handoff/worker': { roles: WORKER, text: handoffPolicy('worker') },
  // 执行环境段：模板；占位符 {variables} 由系统填入变量清单，覆盖时必须保留该占位符
  'runtime/environment': { roles: BOTH, text: `${ENVIRONMENT_HEADING}\n{variables}`, placeholders: ['{variables}'] },
  // 策略段（有启用规则时）：占位符为版本、模式与规则清单
  'runtime/policy': { roles: MAIN, text: `${POLICY_HEAD} The enabled rules, by name and id:\n{rules}`, placeholders: ['{version}', '{mode}', '{rules}'] },
  // 策略段（无任何启用规则时）：说明主动候选只能被忽略
  'runtime/policy/none': { roles: MAIN, text: `${POLICY_HEAD} No rule is enabled: a proactive candidate can only be ignored.`,
    placeholders: ['{version}', '{mode}'] },
  // 两个 Source 技能全文，各附 CLI 使用说明
  'skill/feishu': { roles: BOTH, text: `${sourceSkills.feishu}\n\n## CLI usage\n${cliNotes}` },
  'skill/github': { roles: BOTH, text: `${sourceSkills.github}\n\n## CLI usage\n${cliNotes}` },
}
/** The key of a built-in text, which an override's `base` records. */
// 计算一段内置文本的键（覆盖的 base 记录的就是它）：对文本内容做哈希，文本一变键即变
export const builtInBase = (text: string): string => key('prompt-built-in', text)
/** The built-in part a key names, if any; a name an object's prototype has names none. */
// 按键取内置部分（不存在返回 undefined）；用 Object.hasOwn 而非 in，避免把 Object 原型上的属性名误判为部分名
export const builtInPart = (part: string): BuiltInPart | undefined =>
  Object.hasOwn(builtInParts(), part) ? builtInParts()[part as PartKey] : undefined
/** The text of a built-in part: the team's override, else the built-in one. */
// 取某内置部分的最终文本：团队覆盖优先，否则用内置文本
const builtIn = (config: PromptConfig, part: PartKey): string =>
  (config.overrides && Object.hasOwn(config.overrides, part) ? config.overrides[part]!.text : undefined) ?? builtInParts()[part].text
/** Fill a template's placeholders in one pass, so text filled in is not read for placeholders again. */
// 一趟填充模板占位符：replace 回调保证已填入的文本不会再被当作占位符扫描（防止嵌套替换）
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match)
/** The execution environment part: its template with the variables, or, while setup waits, that it waits. */
// 生成执行环境段落：有变量清单时填充模板；初始化未完成（variables 为 undefined）时改用"等待 setup"的提示
export function environmentSection(config: PromptConfig, variables: Variable[] | undefined): string {
  return variables ? fill(builtIn(config, 'runtime/environment'), { variables: environmentLines(variables) })
    : 'Execution environment: dsh-superagent is waiting for setup; the management panel names what is missing.'
}
/**
 * The main Session's Policy section: the Policy version and accept mode it judges proactive candidates by, and every enabled
 * rule, as the settings hold them, each on one line, so a line of an instruction reads as no rule or heading of its own; the
 * settings bound each instruction (`LIMITS.ruleInstruction`). `key` names the template it was filled from.
 */
// 主 Session 的 Policy 段：策略版本与接受模式，加上当前启用的全部规则（每条规则压成一行，
// 避免任何一行被误读为独立规则或标题；设置端用 `LIMITS.ruleInstruction` 约束单行长度）。key 记录填充所用模板键。
export function policySection(settings: Settings, config: PromptConfig = defaultPrompts()): { key: string; text: string } {
  // 把文本中的换行折叠为空格（规则名与指令一律单行）
  const line = (text: string) => text.replace(/\s*\n\s*/g, ' ')
  // 过滤出启用的规则，逐条渲染为 `- 名称 (id): 指令`
  const rules = settings.policy.rules.filter(rule => rule.enabled).map(({ id, name, instruction }) => `- ${line(name)} (${id}): ${line(instruction)}`)
  // 有启用规则用 runtime/policy 模板，否则用"无规则"模板
  const part = rules.length ? 'runtime/policy' : 'runtime/policy/none'
  // 填充版本号、接受模式与规则清单，返回模板键与生成文本
  return { key: part, text: fill(builtIn(config, part), { version: policyVersion(settings), mode: settings.eval.mode, rules: rules.join('\n') }) }
}
/**
 * Assemble a role's system prompt sections in order from fixed templates, team sections, the generated execution environment
 * and, last, the main Session's generated Policy section, which nothing follows, and whose change leaves the rest unchanged.
 */
// 按顺序组装某角色的系统提示词分段：固定模板、团队段落、生成的执行环境段，
// 最后是主 Session 生成的 Policy 段（没有任何段落跟随其后；它的变化不影响其余段落）。
export function promptParts(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }) {
  // A built-in part names the key its text is overridden by, which for the handoff names the role.
  // fixed：固定分段。name 为展示名，key 为覆盖所用键（交接部分按角色区分键名）
  const fixed = (name: string, part = name) => ({ name, kind: 'fixed' as const, key: part, text: builtIn(config, part as PartKey) })
  // team：团队分段。有文本时加 Markdown 标题头，无文本则为空串（随后被过滤掉）
  const team = (name: TeamSection) => ({ name, kind: 'team' as const, heading: `## ${TEAM_HEADINGS[name]}`,
    text: config[name] ? `## ${TEAM_HEADINGS[name]}\n${config[name]}` : '' })
  // 依序拼装：共用与角色提示词 → 三个团队段 → 各策略段（调度者用 dispatch、执行者用 work）→
  // 调度者追加准入段 → 交接段（按角色取键）→ 可选的执行环境段 → 调度者且提供时追加 Policy 段；
  // 最后过滤掉空文本的分段
  return [
    fixed('runtime/shared'), fixed(`runtime/${role}`),
    ...TEAM_SECTIONS.map(team),
    ...['subscriptions', 'replies', role === 'orchestrator' ? 'dispatch' : 'work'].map(name => fixed(`runtime/${name}`)),
    ...role === 'orchestrator' ? [fixed('runtime/admission')] : [],
    fixed('runtime/handoff', `runtime/handoff/${role}`),
    ...environment ? [{ name: 'runtime/environment', kind: 'generated' as const, key: 'runtime/environment', text: environment }] : [],
    ...role === 'orchestrator' && policy ? [{ name: 'runtime/policy', kind: 'generated' as const, ...policy }] : [],
  ].filter(part => part.text)
}
// 把各分段文本用空行连接成完整系统提示词
export function composePrompt(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }): string {
  return promptParts(config, role, environment, policy).map(part => part.text).join('\n\n')
}
// 取某个技能的全文：内置 Source 技能取其（可被覆盖的）内置部分，团队技能取配置里的文本，未知名返回空串
export function composeSkill(config: PromptConfig, name: string): string {
  return name === 'feishu' || name === 'github' ? builtIn(config, `skill/${name}`) : config.skills[name] ?? ''
}

/** An override whose built-in text changed since its `base`, with that text when kept, or whose part this version no longer has. */
// DefaultChange：描述一处"默认值已变"——某覆盖的内置文本自 base 以来发生变化（可附当时的文本），或该部分在本版本已不存在
export interface DefaultChange { part: string; base?: string; previous?: string; removed?: true }
/**
 * Indicates an optimistic concurrency conflict when saving a prompt configuration against a stale base revision.
 * Thrown by `Prompts.save` and translated into an HTTP 409 response by the management routes.
 */
// PromptConflict：保存提示词配置时与过期的基准修订（base revision）发生乐观并发冲突；由管理路由翻译为 HTTP 409
export class PromptConflict extends Error {}
/**
 * Stores numbered prompt configurations in `Store` via `Versions` and composes role system prompts and skills with the execution environment.
 * `Sessions` reads the composed prompts and skills for orchestrator and worker runs, while management routes and tools validate, preview, and save revisions through it.
 */
// Prompts：经 Versions 把编号的提示词配置存入 Store，并组合角色系统提示词与技能（含执行环境段）。
// Sessions 读取组合结果用于调度者/执行者运行；管理路由与工具经它校验、预览、保存修订。
export class Prompts {
  // 版本化存储实例（管理 PromptVersion 的历史与当前指针）
  private readonly versions: Versions<PromptVersion>
  constructor(private readonly store: Store, private readonly maxChars: () => number, private readonly environment: () => Variable[] | undefined,
    private readonly feishu: () => boolean) {
    // 用 Store 的 KV 键族初始化版本存储（修订指针 + 版本快照）
    this.versions = new Versions(store, KV.prompts.revision, KV.prompts.version)
  }
  /** A role's prompt; the main Session's Policy section follows the settings as they are now, at each model request. */
  // 组合某角色的完整提示词；主 Session 的 Policy 段在每次模型请求时按"当下设置"生成，不随修订持久化
  compose(config: PromptConfig, role: Role, variables = this.environment()): string {
    return composePrompt(config, role, environmentSection(config, variables), role === 'orchestrator' ? policySection(this.store.settings(), config) : undefined)
  }
  /** Returns skills to register in every Session: built-in Source skills (`feishu` only when a Feishu bot is configured) followed by team skills. */
  // 返回要在每个 Session 注册的技能清单：内置 Source 技能在前（feishu 仅在配置了飞书机器人时包含），团队技能在后
  skills(config: PromptConfig): [string, string][] {
    return [...this.feishu() ? ['feishu'] : [], 'github', ...Object.keys(config.skills)].map(name => [name, composeSkill(config, name)])
  }
  // 当前版本：已有修订则读取；否则返回修订 0 的"内置默认"虚拟版本（尚未持久化）
  current(): PromptVersion {
    const revision = this.versions.revision()
    return revision ? this.version(revision) : { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config: defaultPrompts() }
  }
  /** Reads a revision by number; revision 0 resolves to built-in defaults before the first save persists it. */
  // 按修订号读取版本；修订 0 在首次保存之前解析为内置默认（首次保存会把默认固化为修订 0）
  version(revision: number): PromptVersion {
    const version = this.versions.get(revision) ?? (revision === 0 && this.versions.revision() === 0 ? this.current() : undefined)
    // 找不到对应修订：抛用户错误
    if (!version) throw new UserError('unknownPromptRevision', { revision: String(revision) })
    return version
  }
  /**
   * Parse a configuration: an override names a built-in part, holds text and keeps its template's placeholders, and records the
   * built-in text it was edited from: the saved override's unless it names one, else the current one. It goes once its text is
   * the built-in text again, and so does one of a part this version no longer has, which the saved version holds.
   */
  // 校验并解析配置：覆盖必须指向内置部分、文本非空且保留模板占位符，并记录编辑自的内置文本键 base——
  // 未显式给 base 时沿用已保存覆盖的 base，再退回当前内置文本的 base。覆盖文本与内置文本一致时视为未覆盖而移除；
  // 指向"本版本已不存在部分"的覆盖，若已保存版本持有它则一并移除。
  validate(value: unknown): PromptConfig {
    // 先过 schema：得到三个团队段落 + 技能表，以及（可选的）覆盖表
    const { overrides, ...config } = PromptConfigSchema.parse(value)
    // 已保存版本的覆盖（用于 base 的沿用与"部分已消失"的判断）
    const saved = this.current().config.overrides ?? {}
    // 逐个处理覆盖：返回保留的 [名, 覆盖] 对（flatMap 以空数组表示丢弃）
    const kept = Object.entries(overrides ?? {}).flatMap(([name, override]) => {
      // 查该键对应的内置部分
      const part = builtInPart(name)
      // 键不属于任何内置部分、但已保存版本里有它：该部分在本版本已消失，静默丢弃
      if (!part && Object.hasOwn(saved, name)) return []
      // 键不属于任何内置部分且未保存过：未知部分，拒绝
      if (!part) throw new UserError('unknownPromptPart', { part: name })
      // 覆盖文本为空白：拒绝
      if (!override.text.trim()) throw new UserError('promptPartEmpty', { part: name })
      // 检查模板占位符是否全部保留
      const missing = (part.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      // 缺占位符：拒绝并列出缺失项
      if (missing.length) throw new UserError('promptPlaceholders', { part: name, placeholders: missing.join(', ') })
      // base 解析优先级：显式给的 > 已保存覆盖记录的 > 当前内置文本的键
      const base = override.base ?? (Object.hasOwn(saved, name) ? saved[name]!.base : undefined) ?? builtInBase(part.text)
      // 覆盖文本与内置文本完全一致：视为未覆盖，丢弃
      return override.text === part.text ? [] : [[name, { text: override.text, base }] as const]
    })
    // 组装最终配置：只有存在保留的覆盖时才带 overrides 字段
    const result: PromptConfig = { ...config, ...kept.length ? { overrides: Object.fromEntries(kept) } : {} }
    // 整体大小限制（字符数），超限拒绝
    const limit = this.maxChars()
    if (JSON.stringify(result).length > limit) throw new UserError('promptTooLong', { limit: String(limit) })
    return result
  }
  /**
   * The overrides of `config` whose built-in part changed since the team edited it, by the `base` they were edited from, each
   * with the built-in text of that base when this installation kept it, and those of a part this version no longer has.
   */
  // 找出 config 中"内置文本已变化"的覆盖：以 base 对比当前内置文本；
  // 若本安装保留了 base 时的文本则附上（previous）；部分已不存在的标 removed
  defaultChanged(config: PromptConfig): DefaultChange[] {
    return Object.entries(config.overrides ?? {}).flatMap(([part, { base }]): DefaultChange[] => {
      // 查该部分当前是否存在
      const now = builtInPart(part)
      // 部分已不存在：记 removed（base 有则带上，供界面展示）
      if (!now) return [{ part, ...base === undefined ? {} : { base }, removed: true as const }]
      // 没记 base，或 base 与当前内置文本的键一致：内置文本未变，无需报告
      if (base === undefined || base === builtInBase(now.text)) return []
      // 尝试读取 base 时的内置文本（保存时持久化过）
      const previous = this.store.get(KV.prompts.builtIn(base))
      // 报告变化；保留过旧文本则附上
      return [{ part, base, ...previous === undefined ? {} : { previous } }]
    })
  }
  // 预览：校验配置后组合两个角色的提示词全文、分段结构与技能表，并说明预览的覆盖范围
  preview(value: unknown) {
    const config = this.validate(value)
    const environment = environmentSection(config, this.environment()), policy = policySection(this.store.settings(), config)
    return { orchestrator: composePrompt(config, 'orchestrator', environment, policy), worker: composePrompt(config, 'worker', environment),
      parts: { orchestrator: promptParts(config, 'orchestrator', environment, policy), worker: promptParts(config, 'worker', environment) },
      skills: Object.fromEntries(this.skills(config)), scope: 'Team sections, skills, and overrides of built-in parts, which follow their built-in text until overridden. Workers additionally inherit the host prompt and repository AGENTS.md. Prompt text changes what the agents are told, not what dsh-superagent allows: tool permissions, the gate and account wrappers stay.' }
  }
  // 保存新修订：先校验，再在原子事务内做乐观并发检查并落盘
  save(value: unknown, baseRevision: number, source: SettingsOrigin): PromptVersion {
    const config = this.validate(value)
    return this.store.atomic(() => {
      // 读取当前版本用于冲突检查
      const previous = this.current()
      // 调用方给的 baseRevision 与当前不符：乐观并发冲突，要求先比较最新版本再保存
      if (previous.revision !== baseRevision) throw new PromptConflict(`Prompt version changed to ${previous.revision}; compare the latest version before saving`)
      // Persist the built-in defaults as revision 0 before recording the first custom revision.
      // 记录首个自定义修订前，先把内置默认固化存为修订 0（作为对比基线）
      if (previous.revision === 0 && !this.versions.get(0)) this.versions.keep(previous)
      // The built-in text each override was edited from, kept to show what an upgrade changed in it.
      // 把每个覆盖所编辑自的内置文本持久化（首次遇到该 base 时），升级后用于展示"内置文本变了什么"
      for (const [part, { base }] of Object.entries(config.overrides ?? {})) {
        const text = builtInParts()[part as PartKey].text
        if (base === builtInBase(text) && this.store.get(KV.prompts.builtIn(base)) === undefined) this.store.set(KV.prompts.builtIn(base), text)
      }
      // 写入新修订（Versions 自动递增修订号并推进指针）
      return this.versions.save(revision => ({ revision, previousRevision: previous.revision, savedAt: new Date().toISOString(), source, config }))
    })
  }
  // 历史列表：从当前修订往回分页，逐项给出变更字段摘要
  history(offset = 0, limit = 20) {
    const current = this.current()
    // 从新到旧逐个构造修订条目（条数不超过 limit，也不越过修订 0）
    const revisions = Array.from({ length: Math.min(limit, Math.max(0, current.revision + 1 - offset)) }, (_, i) => {
      // 当前版本尚未持久化（修订 0）时直接用内存中的 current，其余按号读取
      const version = current.revision - offset - i === 0 && current.revision === 0 ? current : this.version(current.revision - offset - i)
      // 摘要 = 版本记录去掉 config（config 只用于差异对比）
      const { config, ...summary } = version
      // 上一修订的配置（用于对比）；无上一修订则 undefined
      const previous = version.previousRevision === null ? undefined : this.versions.get(version.previousRevision)?.config
      // Pre-team-section revisions are not comparable field-by-field.
      // 旧格式（本修订或其上一修订任一为 legacy）无法逐字段对比
      const legacy = version.legacy || (version.previousRevision !== null && this.versions.get(version.previousRevision)?.legacy)
      // 旧格式：变更字段就标一个 legacy
      if (legacy) return { ...summary, changed: ['legacy'] }
      // 把配置铺平成"字段名 → 文本"的对照表：三个团队段、技能（skill/ 前缀）、覆盖（序列化为 JSON 便于对比）
      const entries = (value: PromptConfig) => ({ communication: value.communication, scope: value.scope, delivery: value.delivery,
        ...Object.fromEntries(Object.entries(value.skills).map(([name, text]) => ['skill/' + name, text])),
        // An override changes with its text or with the built-in text it was edited from.
        ...Object.fromEntries(Object.entries(value.overrides ?? {}).map(([part, override]) => [part, JSON.stringify(override)])) })
      // 前后两个版本的对照表
      const before = previous ? entries(previous) : {}
      const after = entries(config)
      // 变更字段 = 两版字段并集中取值不同的那些；无上一修订则无变更
      const changed = previous ? [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => (before as Record<string, string>)[name] !== (after as Record<string, string>)[name]) : []
      // 返回摘要 + 变更字段列表
      return { ...summary, changed }
    })
    // 还有更早的修订时给出下一页偏移，否则 null
    return { revisions, next_offset: offset + revisions.length <= current.revision ? offset + revisions.length : null }
  }
}
/** Save a new prompt revision and notify the main Session when the change originated outside its own tool call. */
// 保存新提示词修订；若变更并非来自主 Session 自己的工具调用（origin ≠ tool），则通知主 Session
export async function savePrompts(host: { store: Pick<Store, 'atomic'>; prompts: Pick<Prompts, 'save'>; sessions: Pick<Sessions, 'notify' | 'delivery'> },
  config: unknown, baseRevision: number, origin: SettingsOrigin) {
  // 在同一原子事务中保存并在必要时通知（保存与通知要么都发生要么都不发生）
  const version = host.store.atomic(() => {
    const saved = host.prompts.save(config, baseRevision, origin)
    // 外部来源（管理面板等）的修改需要通知主 Session 重载提示词
    if (origin !== 'tool') host.sessions.notify(...promptsNotice(saved.revision))
    return saved
  })
  // 返回修订号、生效时机（下一次请求生效）与提示词上下文的投递状态
  return { revision: version.revision, effect: 'next-request' as const, context_delivery: await host.sessions.delivery('prompts') }
}
