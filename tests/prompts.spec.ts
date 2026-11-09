/**
 * 本测试文件覆盖提示词模块（src/app/prompts.ts 的 Prompts 及相关函数）：
 * 团队分区与技能作为版本保存（重启存活、历史与回滚）、角色提示词由固定节围绕团队节拼装、
 * 提示词文件读取（容忍 CRLF/行尾空白/空行、缺失与空文件报错）、UI 前后对照证据交给可改的交付要求、
 * 提示词以固定 handoff 规则与执行环境收尾（主 Session 以 Policy 收尾）、保存前的校验
 * （未知键/内置技能名/超限）、工单执行环境变量与“setup 未完成”提示、内置来源技能注册、
 * 以及 override（内置部件改写）的全生命周期：原地替换、生成部件模板填充、校验拒绝、
 * base 记录与升级对比、旧配置兼容、已移除部件清理、base 继承与 rebase、
 * 原型链键与占位符注入防护、环境标题固定措辞。测试策略：临时目录 + 真实 Store，
 * 直接调用 Prompts 的 save/validate/compose/preview/skills/history 断言行为。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
// 临时目录与文件写入。
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
// join：拼路径；relative：把临时目录里的文件表示成 prompts/ 下的相对名。
import { describe, expect, it } from 'vitest'
// vitest 断言与用例（it.each 表驱动角色）。
import { Store } from '../src/app/store.ts'
// Store：真实 SQLite 存储（验证版本持久化与重启存活）。
import { Prompts, builtInBase, composePrompt, defaultPrompts, policySection, promptParts, type PromptConfig } from '../src/app/prompts.ts'
// 被测模块：Prompts 服务与拼装/部件/内置 base 等辅助。
import { USER_ERRORS, UserError } from '../src/core/index.ts'
// USER_ERRORS：用户错误的处置表；UserError：结构化用户错误。
import { KV } from '../src/kv.ts'
// KV：键名注册表（直接预置 prompts 的版本与内置原文）。
import { SettingsSchema, policyVersion } from '../src/policy.ts'
// SettingsSchema：最小合法设置；policyVersion：策略版本哈希。
import { guides, handoffPolicy, mainAdmissionPolicy, masterPrompt, sharedPrompt, workerPrompt } from '../src/app/context.ts'
// context：各固定节原文（shared/master/worker/handoff/admission 与 guides 字典）。
import { promptFile } from '../src/app/skill-files.ts'
// promptFile：按名读打包的提示词文件。
import { packagePath } from '../src/infra/paths.ts'
// packagePath：包内路径（prompts/ 目录）。
import type { Variable } from '../src/app/execution-environment.ts'
// Variable：执行环境变量条目。

/** The execution environment outside any ticket, as the runtime passes it once setup has finished. */
// setup 完成后运行时传入的“工单之外”的执行环境。
const variables = (): Variable[] => [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', value: 'acme/widgets', description: { zh: '仓库', en: 'The repository' }, owner: 'github' }]
// 环境变量 fixture：仓库变量，归 github 来源。
const ENVIRONMENT_LINE = '- DSH_SUPERAGENT_GITHUB_REPOSITORY = "acme/widgets": The repository.'
// 环境节里该变量渲染出的那一行（多个用例复用）。
const promptsOf = (store: Store, maxChars = 100000) => new Prompts(store, () => maxChars, variables, () => true)
// 以给定上限、环境变量与“setup 已完成”构造 Prompts 服务。
function withStore(body: (store: Store, dir: string) => void): void {
  // 起一个临时 Store 跑一段断言，结束后关闭并清理目录。
  const dir = mkdtempSync(join(tmpdir(), 'prompts-')); const store = new Store(join(dir, 'db'))
  try { body(store, dir) } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}

it('saves team sections and skills as versions that survive a restart, with history and rollback', () => {
  // 团队分区与技能作为带版本号的保存：重启存活、可查历史、可回滚。
  const dir = mkdtempSync(join(tmpdir(), 'prompt-config-'))
  let store = new Store(join(dir, 'db'))
  try {
    let prompts = promptsOf(store)
    expect(prompts.current().config).toEqual(defaultPrompts())
    // 初始状态：版本 0 即默认提示词。
    const config = { ...defaultPrompts(), scope: 'Finish what was asked.', delivery: '', skills: { release: 'Tag releases on Fridays.' } }
    prompts.save(config, 0, 'panel')
    expect(composePrompt(prompts.current().config, 'worker')).toContain('## Ticket scope\nFinish what was asked.')
    // 保存后的拼装提示词包含改过的 scope 节。
    // An empty team section leaves the prompt; the fixed sections stay.
    // 空团队节从拼装里消失；固定节照旧保留。
    expect(promptParts(config, 'worker').map(part => part.name)).not.toContain('delivery')
    expect(store.get('settings-revision')).toBeUndefined()
    // 提示词保存不占用设置修订号（与 settings 解耦）。
    store.close(); store = new Store(join(dir, 'db')); prompts = promptsOf(store)
    // 重启：重开 Store 与 Prompts。
    expect(prompts.current()).toMatchObject({ revision: 1, config })
    // 保存的版本重启后仍在。
    prompts.save(prompts.version(0).config, 1, 'tool')
    expect(prompts.current()).toMatchObject({ revision: 2, previousRevision: 1, config: defaultPrompts() })
    // 回滚到版本 0 的内容作为新版本 2 保存。
    expect(prompts.history(0, 1)).toMatchObject({ revisions: [{ revision: 2 }], next_offset: 1 })
    expect(prompts.history(2, 1).next_offset).toBeNull()
    // 历史分页：能翻页、末页没有下一页。
    expect(prompts.history(1, 1).revisions[0]).toMatchObject({ revision: 1, changed: ['scope', 'delivery', 'skill/release'] })
    // 版本记录列出本次保存改动的键。
    expect(() => prompts.save(config, 1, 'panel')).toThrow('version changed')
    // 基于过期版本号保存被拒（并发保护）。
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('assembles every role from fixed sections around the team sections, whatever the configuration says', () => {
  // 无论配置如何，每个角色都由固定节围绕团队节拼装（顺序固定、固定节原文完整）。
  const config = { communication: 'Say little.', scope: '', delivery: 'Attach screenshots.', skills: {} }
  for (const role of ['orchestrator', 'worker'] as const) {
    const names = promptParts(config, role, 'env').map(part => part.name)
    expect(names).toEqual(['runtime/shared', `runtime/${role}`, 'communication', 'delivery', 'runtime/subscriptions', 'runtime/replies', role === 'orchestrator' ? 'runtime/dispatch' : 'runtime/work', ...role === 'orchestrator' ? ['runtime/admission'] : [], 'runtime/handoff', 'runtime/environment'])
    // 部件顺序：共享 → 角色节 → 团队节 → 订阅/回复 → 派工或工作 → （仅主 Session 的准入）→ handoff → 环境。
    const prompt = composePrompt(config, role)
    for (const fixed of [sharedPrompt, role === 'orchestrator' ? masterPrompt : workerPrompt, guides.subscriptions!, guides.replies!, handoffPolicy(role)]) expect(prompt).toContain(fixed)
    // 每个固定节原文都完整出现在拼装结果里。
    expect(prompt.endsWith(handoffPolicy(role))).toBe(true)
    // 拼装以 handoff 规则收尾。
  }
  expect(composePrompt(config, 'orchestrator')).toContain(mainAdmissionPolicy)
  expect(composePrompt(config, 'worker')).not.toContain(mainAdmissionPolicy)
  // 准入策略只属于主 Session。
})

it('reads a prompt file whatever its line ends and blank lines, and names a missing or empty one', () => {
  // 读提示词文件时容忍任意换行符与行尾空白/空行；缺失或空文件报错并给出路径。
  const dir = mkdtempSync(join(tmpdir(), 'prompt-file-'))
  // promptFile resolves paths relative to prompts/; use a relative path to reach the temp dir.
  // promptFile 按 prompts/ 下的相对路径解析；用相对名指向临时目录里的文件。
  const name = (file: string) => relative(packagePath('prompts'), join(dir, file))
  try {
    writeFileSync(join(dir, 'crlf.md'), 'One.\r\nTwo. \r\n \t\r\n\r\nThree.\r\n')
    writeFileSync(join(dir, 'blank.md'), ' \n\t\n')
    expect(promptFile(name('crlf'))).toBe('One. Two.\nThree.')
    // CRLF 归一、行尾空白折叠、空白行分段为段落分隔。
    expect(() => promptFile(name('blank'))).toThrow(`Empty packaged file: ${join(dir, 'blank.md')}`)
    expect(() => promptFile(name('absent'))).toThrow(`Missing packaged file: ${join(dir, 'absent.md')}`)
    // 空/缺失文件都以带绝对路径的错误说明。
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('leaves the UI before-and-after evidence to the delivery requirements, which a team can change', () => {
  // UI 前后对照证据是可改的交付要求：团队改写后内置的固定要求不再出现。
  const config = { ...defaultPrompts(), delivery: 'Only capture the finished screen.' }
  for (const role of ['orchestrator', 'worker'] as const) expect(composePrompt(config, role)).not.toContain('Before and After visual evidence')
})

it.each(['orchestrator', 'worker'] as const)('ends the %s prompt with the fixed handoff rules and the execution environment, and the main Session\'s with its Policy', role => {
  // 两个角色的提示词都以固定 handoff 规则 + 执行环境收尾；主 Session 以 Policy 收尾。
  withStore(store => {
    const prompts = promptsOf(store)
    const preview = prompts.preview(defaultPrompts())
    expect(promptParts(defaultPrompts(), role).at(-1)).toEqual({ name: 'runtime/handoff', kind: 'fixed', key: `runtime/handoff/${role}`,
      text: handoffPolicy(role) })
    // 最后一个部件是固定 handoff（每个角色一份）。
    expect(preview[role]).toBe(prompts.compose(defaultPrompts(), role))
    // 预览与拼装结果一致。
    expect(preview[role]).toContain(`${handoffPolicy(role)}\n\nExecution environment`)
    // handoff 之后紧跟执行环境节。
    if (role === 'worker') expect(preview[role].endsWith(ENVIRONMENT_LINE)).toBe(true)
    // Nothing follows the main Session's Policy section, so a Policy change leaves the rest of its prompt as it was.
    // 主 Session 的 Policy 之后没有别的节：策略变更不影响提示词其余部分。
    else expect(preview[role].endsWith(`${ENVIRONMENT_LINE}\n\n${policySection(store.settings()).text}`)).toBe(true)
    expect(preview.parts[role].at(-1)!.name).toBe(role === 'orchestrator' ? 'runtime/policy' : 'runtime/environment')
    // 末部件：主 Session 是 runtime/policy，worker 是 runtime/environment。
  })
})

it('rejects unknown keys, built-in skill names and oversized configuration before persisting', () => {
  // 持久化之前就拒绝：未知键、占用内置技能名、非法技能名、超限配置。
  withStore(store => {
    const prompts = promptsOf(store)
    expect(() => prompts.save({ ...defaultPrompts(), shared: 'x' }, 0, 'panel')).toThrow()
    expect(() => prompts.save({ communication: '', scope: '' }, 0, 'panel')).toThrow()
    for (const name of ['github', 'feishu']) expect(() => prompts.save({ ...defaultPrompts(), skills: { [name]: 'mine' } }, 0, 'panel')).toThrow('built-in skill')
    // 内置技能名不可被团队技能占用。
    expect(() => prompts.save({ ...defaultPrompts(), skills: { 'Bad Name': 'x' } }, 0, 'panel')).toThrow()
    expect(() => promptsOf(store, 1000).save(defaultPrompts(), 0, 'panel')).toThrow('exceeds')
    // 超过字符上限的配置被拒。
    expect(prompts.current().revision).toBe(0)
    // 全部拒绝后版本号不变（没有半写入）。
  })
})

it('lists a ticket\'s execution environment in its prompt, and says setup is incomplete before setup finished', () => {
  // 工单环境变量出现在 worker 提示词的环境节里；setup 未完成时提示 setup 尚未结束。
  withStore(store => {
    const ticket: Variable[] = [{ key: 'DSH_SUPERAGENT_DIR', value: '/srv/work/fix-1', description: { zh: '', en: 'This ticket\'s directory' }, owner: 'executor' }]
    expect(promptsOf(store).compose(defaultPrompts(), 'worker', ticket).endsWith('- DSH_SUPERAGENT_DIR = "/srv/work/fix-1": This ticket\'s directory.')).toBe(true)
    // 工单级变量渲染在末尾的环境行。
    expect(promptParts(defaultPrompts(), 'worker', 'env').at(-1)).toEqual({ name: 'runtime/environment', kind: 'generated', key: 'runtime/environment',
      text: 'env' })
    // 环境部件标记为 generated。
    expect(new Prompts(store, () => 100000, () => undefined, () => false).compose(defaultPrompts(), 'worker')).toContain('dsh-superagent is waiting for setup')
    // setup 未完成（无变量）时提示等待 setup。
  })
})

it('registers the built-in Source skills, Feishu only with a Feishu bot, before the team skills', () => {
  // 内置来源技能注册在团队技能之前；没有飞书机器人时不注册 feishu 技能。
  withStore(store => {
    const config = { ...defaultPrompts(), skills: { release: 'Tag releases.' } }
    const skills = promptsOf(store).skills(config)
    expect(skills.map(([name]) => name)).toEqual(['feishu', 'github', 'release'])
    // 顺序：内置来源技能在前，团队技能在后。
    expect(skills[1]![1]).toContain('## CLI usage')
    // github 技能内容来自打包文件。
    expect(skills[2]![1]).toBe('Tag releases.')
    // 团队技能内容原样。
    expect(new Prompts(store, () => 100000, variables, () => false).skills(config).map(([name]) => name)).toEqual(['github', 'release'])
    // 没有飞书机器人时 feishu 技能消失。
  })
})


describe('overrides of built-in parts', () => {
  // 内置部件的 override（改写）：校验、模板填充、base 记录、升级对比与清理。
  const settings = () => SettingsSchema.parse({})
  // 最小合法设置。
  const config = (overrides: PromptConfig['overrides']) => ({ ...defaultPrompts(), overrides })
  // 带指定 overrides 的配置。
  it('compose in place of the built-in texts, for the roles that read each, the handoff per role and the Source skills', () => {
    // override 原地替换内置原文：共享节对两角色、dispatch 只对主 Session、handoff 按角色、github 技能。
    withStore(store => {
      const prompts = promptsOf(store)
      const edited = prompts.validate(config({ 'runtime/shared': { text: 'Shared, the team way.' }, 'runtime/dispatch': { text: '## dispatch\nRoute well.' },
        'runtime/handoff/worker': { text: 'Hand off as a worker.' }, 'skill/github': { text: 'GitHub, the team way.' } }))
      const main = prompts.compose(edited, 'orchestrator'), worker = prompts.compose(edited, 'worker')
      for (const prompt of [main, worker]) expect(prompt.startsWith('Shared, the team way.\n\n')).toBe(true)
      // 共享节 override 出现在两个角色开头。
      expect(main).toContain('## dispatch\nRoute well.')
      expect(main).not.toContain(guides.dispatch)
      // dispatch 替换掉内置派工指南。
      expect(worker).toContain('Hand off as a worker.')
      expect(main).toContain(handoffPolicy('orchestrator'))
      // handoff 按角色各自替换。
      expect(prompts.skills(edited)).toContainEqual(['github', 'GitHub, the team way.'])
      // 技能同样可被 override。
      // The parts say what they are edited by.
      // 部件标注它被哪个 override 改写。
      expect(promptParts(edited, 'worker').find(part => part.name === 'runtime/handoff')).toMatchObject({ key: 'runtime/handoff/worker',
        text: 'Hand off as a worker.' })
    })
  })
  it('fill the templates of the generated parts with the data, which stays generated', () => {
    // 生成部件的 override 是模板：数据仍由系统填充，部件保持 generated。
    withStore(store => {
      const prompts = promptsOf(store)
      const edited = prompts.validate(config({ 'runtime/environment': { text: 'Where you work:\n{variables}\nAsk nobody for more.' },
        'runtime/policy': { text: '## Policy\nRules of {version} in {mode} mode:\n{rules}' },
        'runtime/policy/none': { text: '## Policy\n{version}, {mode}: nothing to accept.' } }))
      expect(prompts.compose(edited, 'worker').endsWith(`Where you work:\n${ENVIRONMENT_LINE}\nAsk nobody for more.`)).toBe(true)
      // 环境模板的 {variables} 填充为环境行。
      const policy = policySection(settings(), edited)
      expect(policy).toEqual({ key: 'runtime/policy', text: `## Policy\nRules of ${policyVersion(settings())} in ${settings().eval.mode} mode:\n`
        + settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`).join('\n') })
      // policy 模板填充版本、模式与启用规则清单。
      const none = SettingsSchema.parse({ policy: { rules: [] } })
      expect(policySection(none, edited)).toEqual({ key: 'runtime/policy/none', text: `## Policy\n${policyVersion(none)}, ${none.eval.mode}: nothing to accept.` })
      // 无启用规则时改用 runtime/policy/none 模板。
      // A rule's text that names a placeholder is not filled again.
      // 规则文本里出现的占位符样文本不会被再次填充。
      const named = SettingsSchema.parse({ policy: { rules: [{ id: 'x', name: 'X', enabled: true, instruction: 'Keep {mode} and $& as written.' }] } })
      expect(policySection(named, edited).text.endsWith('- X (x): Keep {mode} and $& as written.')).toBe(true)
    })
  })
  it('refuses an unknown part and a template that drops a placeholder, and drops an override equal to the built-in text', () => {
    // 校验拒绝未知部件与丢占位符的模板；与内置原文相同的 override 直接丢弃。
    withStore(store => {
      const prompts = promptsOf(store)
      expect(() => prompts.validate(config({ 'runtime/nothing': { text: 'x' } }))).toThrow(new UserError('unknownPromptPart', { part: 'runtime/nothing' }))
      expect(() => prompts.validate(config({ 'runtime/policy': { text: '## Policy\n{version} {mode}' } })))
        .toThrow(new UserError('promptPlaceholders', { part: 'runtime/policy', placeholders: '{rules}' }))
      expect(() => prompts.validate(config({ 'runtime/environment': { text: 'Where you work.' } })))
        .toThrow(new UserError('promptPlaceholders', { part: 'runtime/environment', placeholders: '{variables}' }))
      // 丢占位符的模板报缺少哪些占位符。
      // Back to the built-in text: the part follows the built-in text again, so a later upgrade updates it.
      // 写回内置原文即撤销 override：部件重新跟随内置文本，后续升级会更新它。
      expect(prompts.validate(config({ 'runtime/shared': { text: sharedPrompt } }))).not.toHaveProperty('overrides')
      // The whole configuration, overrides included, stays within the limit.
      // 含 override 在内的整个配置都要在长度限制内。
      expect(() => promptsOf(store, 5000).validate(config({ 'runtime/shared': { text: 'x'.repeat(5000) } }))).toThrow(UserError)
    })
  })
  it('records the built-in text an override was edited from, and lists the overrides whose built-in text changed since', () => {
    // 记录 override 编辑时基于的内置原文（base），升级后列出内置原文已变化的 override。
    withStore(store => {
      const prompts = promptsOf(store)
      // An override edited from today's built-in text has nothing to show.
      // 基于当天内置原文编辑的 override 无升级差异可显示。
      const saved = prompts.save(config({ 'runtime/dispatch': { text: '## dispatch\nRoute well.' } }), 0, 'panel')
      expect(saved.config.overrides!['runtime/dispatch']!.base).toBe(builtInBase(`## dispatch\n${guides.dispatch}`))
      expect(prompts.defaultChanged(saved.config)).toEqual([])
      // One edited from a built-in text an earlier version shipped, which this installation kept when it was saved.
      // 基于“旧版本曾内置、本安装保存时还留着”的原文编辑的 override：升级后差异浮现。
      const earlier = '## replies\nAn earlier built-in text.'
      store.set(KV.prompts.builtIn(builtInBase(earlier)), earlier)
      const upgraded = prompts.save(config({ ...saved.config.overrides, 'runtime/replies': { text: 'Our replies.', base: builtInBase(earlier) },
        'runtime/work': { text: 'Our work.', base: 'unknown' } }), saved.revision, 'panel')
      expect(prompts.defaultChanged(upgraded.config)).toEqual([{ part: 'runtime/replies', base: builtInBase(earlier), previous: earlier },
        { part: 'runtime/work', base: 'unknown' }])
      // defaultChanged 列出：base 是旧内置原文的（附当时的原文）、base 未知无从比较的。
      // Kept as it was: an upgrade never replaces the team's text.
      // 团队文本原样保留：升级永不替换 override。
      expect(prompts.compose(prompts.current().config, 'worker')).toContain('Our replies.')
    })
  })
  it('reads a configuration saved before overrides existed unchanged', () => {
    // 读取 overrides 出现之前的旧配置：原样返回、拼装结果与显式空 overrides 相同。
    withStore(store => {
      const prompts = promptsOf(store)
      const saved = prompts.save({ ...defaultPrompts(), communication: 'Ours.' }, 0, 'panel')
      expect(saved.config).toEqual({ ...defaultPrompts(), communication: 'Ours.' })
      expect(prompts.compose(saved.config, 'orchestrator')).toBe(prompts.compose({ ...defaultPrompts(), communication: 'Ours.', overrides: {} }, 'orchestrator'))
    })
  })
  it('drops an override of a part a later version no longer has, which the saved version holds, and lists it as removed', () => {
    // 新版本已移除部件的 override：校验时被静默丢弃并列为 removed；客户端凭空编造的部件仍拒绝。
    withStore(store => {
      const prompts = promptsOf(store)
      const config = { ...defaultPrompts(), overrides: { 'runtime/retired': { text: 'Old.', base: 'b' } } }
      // Only a part the saved version holds goes quietly; one a client makes up is refused.
      // 只有已保存版本持有的部件才被安静地丢弃；客户端编造的部件名直接拒绝。
      expect(() => prompts.validate(config)).toThrow(new UserError('unknownPromptPart', { part: 'runtime/retired' }))
      store.set(KV.prompts.version(1), { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config }); store.set(KV.prompts.revision, 1)
      // 把含 retired override 的配置预置成已保存的版本 1。
      expect(prompts.defaultChanged(config)).toEqual([{ part: 'runtime/retired', base: 'b', removed: true }])
      // 该部件在新版本已不存在：列为 removed。
      expect(prompts.validate(config)).toEqual(defaultPrompts())
      // 校验时 override 被丢弃，其余回到默认。
      expect(USER_ERRORS.unknownPromptPart[0]).toBe('refused')
      // 未知部件错误的处置是“拒绝”。
    })
  })
  it('keeps the base of the saved override of a part when a save omits it, and shows a re-based override as a change', () => {
    // 保存省略 base 时沿用已存 base；改绑 base（rebase）算一次改动并记入历史。
    withStore(store => {
      const prompts = promptsOf(store)
      const first = prompts.save(config({ 'runtime/shared': { text: 'Ours.', base: 'earlier' } }), 0, 'panel')
      const second = prompts.save(config({ 'runtime/shared': { text: 'Ours, edited.' } }), first.revision, 'tool')
      expect(second.config.overrides!['runtime/shared']).toEqual({ text: 'Ours, edited.', base: 'earlier' })
      // 新保存没带 base：沿用已存的 'earlier'。
      // Keeping the team's text after an upgrade changes only the base, which the history names.
      // 升级后保留团队文本、只改 base 的保存，历史记为该部件的一次改动。
      const rebased = prompts.save(config({ 'runtime/shared': { text: 'Ours, edited.', base: builtInBase(sharedPrompt) } }), second.revision, 'panel')
      expect(prompts.history().revisions.find(version => version.revision === rebased.revision)!.changed).toEqual(['runtime/shared'])
    })
  })
  it('refuses a part an object\'s prototype names, and empty text, and fills no placeholder a prototype names', () => {
    // 防原型链注入：原型链上的键名当部件名会被拒绝；空文本拒绝；原型链键名不会被当占位符填充。
    withStore(store => {
      const prompts = promptsOf(store)
      for (const part of ['constructor', 'toString']) {
        expect(() => prompts.validate(config(JSON.parse(`{"${part}": { "text": "x" }}`)))).toThrow(new UserError('unknownPromptPart', { part }))
      }
      // The parser drops a __proto__ key, which sets no prototype.
      // 解析器丢弃 __proto__ 键，不会设置任何原型。
      expect(prompts.validate(config(JSON.parse('{"__proto__": { "text": "x" }}')))).toEqual(defaultPrompts())
      expect(() => prompts.validate(config({ 'runtime/shared': { text: ' \n ' } }))).toThrow(new UserError('promptPartEmpty', { part: 'runtime/shared' }))
      const edited = prompts.validate(config({ 'runtime/environment': { text: '{constructor} {toString}\n{variables}' } }))
      expect(prompts.compose(edited, 'worker').endsWith(`{constructor} {toString}\n${ENVIRONMENT_LINE}`)).toBe(true)
      // 模板里的 {constructor}/{toString} 原样保留，只有 {variables} 被填充。
    })
  })
  it('keeps the environment heading as it was, naming the prepare command', () => {
    // 环境节标题措辞保持原样并提及 prepare 命令；工单级环境行说明指向 prepare。
    expect(composePrompt(defaultPrompts(), 'worker', 'x')).not.toContain('The prepare command')
    // 传入工单环境（'x' 即工单目录）时环境节直接列变量，不写“prepare 命令”段。
    withStore(store => {
      expect(promptsOf(store).compose(defaultPrompts(), 'worker')).toContain('an empty value means that part is not configured here). '
        + `The prepare command of a ticket directory reads the same variables:\n${ENVIRONMENT_LINE}`)
    })
    // 无工单变量时提及“工单目录的 prepare 命令读同样的变量”。
  })
})
