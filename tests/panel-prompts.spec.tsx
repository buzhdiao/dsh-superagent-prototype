// @vitest-environment jsdom
// Prompts（提示词）设置页。
/**
 * 本测试文件覆盖面板的 Prompts 设置页（src/client 下的提示词编辑界面）：
 * 团队分区与内置部件的列表/编辑/保存、全文预览的顺序与可编辑性、草稿冲突时逐节 rebase、
 * 技能（skill）的增删与命名校验、内置部件的 override（含 base 记录与升级对比）、
 * 模板占位符校验、历史版本载入与已移除部件的清理。测试策略：jsdom + usePanel 假服务端，
 * 直接驱动真实 App 组件，断言 DOM 状态与假服务端收到的请求。
 */
import { act } from 'react'
// act：把状态更新圈进 React 的批量渲染。
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
// builtInParts：内置提示词部件；builtInBase：把内置原文规整为 override 的 base 记录；defaultPrompts：默认团队分区。
import { expect, it } from 'vitest'
// vitest 断言与用例。
import { zh } from '../src/client/locales.ts'
// zh：中文文案字典（用于按文案定位控件）。
import { usePanel, mount, settle, all, tab, click, type, text, field, at } from './fixtures/panel.tsx'
// 面板测试夹具：usePanel 装配假服务端与挂载环境，mount 挂载 App，其余为 DOM 交互助手。
import { server, promptVersion } from './fixtures/panel-server.ts'
// server：假面板服务端（可篡改 prompts 状态并记录请求）；promptVersion：构造指定版本的提示词。

usePanel()
// 为每个用例启用假面板服务端并负责卸载清理。
it('lists the team sections, then the built-in parts, edits and saves them separately from settings, and resets one section', async () => {
  // 导航列表 = 团队分区在前、内置部件在后；编辑走独立的 prompts 接口而非 settings；可整节重置。
  at({ page: 'settings', query: { group: 'prompts' } })
  // 定位到设置页的 prompts 组。
  await mount()
  const names = all('.dt-prompt-nav .dt-nav-item > span').map(item => item.textContent)
  expect(names.slice(0, 3)).toEqual(['沟通方式', '工单范围', '交付要求'])
  // 前三项是团队分区。
  expect(names.slice(3)).toEqual(Object.keys(builtInParts()).map(key => zh[`promptPart.${key}` as keyof typeof zh]))
  // 其后是全部内置部件（按其定义顺序）。
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Custom communication rule')
  expect(text()).toContain('1 处修改')
  // 修改计数出现：草稿与已存版本产生差异。
  await click(tab(zh.promptViewFull))
  // The full prompt shows every part, team or built in, as editable, in the order the Session reads them.
  // 全文预览按 Session 的阅读顺序展示全部部件（团队与内置），均可编辑。
  const parts = all('.dt-preview-part').map(part => [part.querySelector('b')?.textContent, part.hasAttribute('data-editable')])
  expect(parts.slice(0, 5)).toEqual([['共享约定', true], ['主 Session 角色', true], ['沟通方式', true], ['工单范围', true], ['交付要求', true]])
  expect(text()).toContain('Custom communication rule')
  // 草稿里的修改在全文预览中生效。
  await click(all('.dt-preview-part').find(part => part.querySelector('b')?.textContent === '沟通方式')!.querySelector('button')!)
  // 在全文预览里对“沟通方式”节发起重置。
  await click(zh.promptResetSection)
  expect(text()).not.toContain('处修改')
  // 重置后草稿与已存版本一致，修改计数消失。
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Second rule')
  await click(zh.save)
  expect(server.prompts.current.config.communication).toBe('Second rule')
  // 保存落到服务端的 prompts 状态。
  expect(server.requests.some(request => request.path.startsWith('settings/'))).toBe(false)
  // 提示词保存不经过 settings 接口（与设置解耦）。
})

it('keeps a conflicting prompt draft, rebases it onto the newer version and saves on retry', async () => {
  // 保存冲突：别人先存了新版本时保留草稿，并逐节 rebase 到新版本上再保存。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Mine')
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), scope: 'Theirs' })
  // 模拟他人已把提示词更新到版本 1（scope 被改）。
  await click(zh.save)
  expect(document.querySelector('.dt-savebar')?.textContent).toContain('提示词已被修改到版本 1。已保留你的草稿')
  // 冲突提示：版本已变但草稿未丢。
  await click(zh.save)
  // The other save's section stays: the draft moved onto version 1 section by section, not as a whole.
  // 他人改动的节保留：草稿是逐节搬到版本 1 上的，不是整体覆盖。
  expect(server.prompts.current.config).toMatchObject({ communication: 'Mine', scope: 'Theirs' })
})

it('shows a built-in skill with the CLI notes in the full prompt, editable as a built-in part, and adds a team skill but no skill under a built-in name', async () => {
  // 技能：内置技能在全文预览可见且可编辑；可新增团队技能，但不得占用内置技能名。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewFull))
  await act(async () => { const select = field<HTMLSelectElement>(zh.promptPreviewTarget); select.value = 'skill/github'; select.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
  // 预览目标切到内置技能 skill/github。
  expect(text()).toContain('## CLI usage')
  // 全文里能看到该技能的 CLI 说明。
  expect(all('.dt-preview-part[data-editable] b').map(name => name.textContent)).toEqual([zh['promptPart.skill/github']])
  // 该技能作为可编辑部件出现。
  await click(tab(zh.promptViewEdit))
  for (const name of ['Bad Name', 'github']) {
    await type(field<HTMLInputElement>(zh.promptAddSkill), name)
    await click(zh.promptAddSkillAction)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.promptSkillNameInvalid)
    // 非法名（大写/空格）与内置名（github）都被拒绝。
  }
  await type(field<HTMLInputElement>(zh.promptAddSkill), 'testing')
  await click(zh.promptAddSkillAction)
  expect(all('.dt-nav-item').map(item => item.textContent)).toContain('dsh-superagent-testing')
  // 合法名新增成功，导航里出现带命名空间的技能项。
})

it('loads all defaults into the draft from the history without saving them', async () => {
  // 从历史载入“默认值”只填充草稿，不触发保存。
  server.prompts.current = promptVersion(0, { ...defaultPrompts(), scope: 'Old scope' })
  // 服务端当前版本 0，scope 是旧文案。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewHistory))
  const first = `版本 0 · ${zh.promptHistoryInitial} · ${zh['historySource.defaults']}`
  expect(all('.dt-row-title').map(title => title.textContent)).toContain(first)
  // 历史里第一条：版本 0 的初始默认值来源。
  await click(zh.promptDefaults)
  expect(text()).toContain(zh.promptDraftFromDefaults)
  // 提示草稿已由默认值填充。
  expect(server.requests.some(request => request.path === 'prompts' && request.method === 'PUT')).toBe(false)
  // 没有发生保存（无 PUT prompts 请求）。
})

it('keeps the Prompts save bar hidden while a preview loads for an unchanged draft', async () => {
  // 未修改的草稿在预览加载期间不得闪现保存条（避免误导可保存）。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  let shown = false
  const watch = new MutationObserver(() => { if (document.querySelector('.dt-savebar')) shown = true })
  watch.observe(document.body, { childList: true, subtree: true })
  // 用 MutationObserver 盯住 savebar 是否出现过。
  await click(tab(zh.promptViewFull))
  await settle()
  watch.disconnect()
  expect(shown).toBe(false)
  // 预览加载全程未出现保存条。
})

it('marks team sections that differ from the defaults, and shows a draft as a diff against the saved version or the defaults', async () => {
  // 导航可标出偏离默认值的团队分区；草稿 diff 可切换基准（已存版本 或 默认值）。
  server.prompts.current = promptVersion(1, { ...defaultPrompts(), delivery: `${defaultPrompts().delivery}\nCommit as the bot account.` })
  server.prompts.revision = 1
  // 已存版本 1：delivery 相对默认多了一行。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(all('.dt-prompt-nav .dt-nav-item').filter(item => item.querySelector('.dt-changed-tag')).map(item => item.querySelector('span')!.firstChild?.textContent)).toEqual(['交付要求'])
  // 只有“交付要求”被标为已改。
  await type(field<HTMLTextAreaElement>(zh.promptBody), `${defaultPrompts().communication}\nSign as the agent.`)
  await click(tab(zh.promptViewFull))
  // A draft opens against the saved version: only its change shows, and the parts it leaves as they were fold.
  // 草稿默认对已存版本开 diff：只显示草稿的改动，与已存版本一致的节折叠。
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toEqual(['Sign as the agent.\n'])
  expect(all('.dt-preview-part del')).toHaveLength(0)
  expect(text()).toContain(zh.promptSameAsSaved)
  // 其余节标记为“与已存版本一致”。
  await click(zh.promptCompareDefault)
  // 切换为与默认值对比。
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toEqual(['Sign as the agent.\n', 'Commit as the bot account.\n'])
  // 两处相对默认值的改动都显示。
})

it('discards a prompt draft by reading the saved version again', async () => {
  // 丢弃草稿 = 重新读取已存版本。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Mine')
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), communication: 'Theirs' })
  // 期间服务端被更新到版本 1。
  await click(zh.discard)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe('Theirs')
  // 丢弃后展示的是最新已存内容。
  expect(all('.dt-savebar')).toHaveLength(0)
  // 保存条消失。
})

const builtInItem = (name: string) => all('.dt-prompt-nav .dt-nav-item').find(item => item.querySelector('span')!.firstChild?.textContent === name)!
// 按显示名找导航里的内置部件项。
it('edits a built-in part as an override of its built-in text, marks it changed, and resets it to the built-in text', async () => {
  // 内置部件以 override 形式编辑：保存记录被编辑自的内置原文（base）；重置即删除 override。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  const shared = builtInParts()['runtime/shared']!
  await click(builtInItem(zh['promptPart.runtime/shared']))
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(shared.text)
  // 编辑框初始为内置原文。
  expect(text()).toContain(zh['promptReadBy.both'])
  // 标明该部件由哪些读者使用（此处为双方）。
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Shared, the team way.')
  expect(builtInItem(zh['promptPart.runtime/shared']).querySelector('.dt-changed-tag')?.textContent).toBe(zh.promptChanged)
  // 修改后导航项标“已修改”。
  await click(zh.save)
  // The override records the built-in text it was edited from.
  // override 记录它编辑自的内置原文（base）。
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/shared': { text: 'Shared, the team way.', base: builtInBase(shared.text) } })
  // The full prompt reads the override in place of the built-in text, compared with the defaults.
  // 全文预览就地读取 override 替代内置原文，并以默认值为对比基准。
  await click(tab(zh.promptViewFull))
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toContain('Shared, the team way.\n')
  await click(all('.dt-preview-part[data-editable] button')[0]!)
  await click(zh.promptResetSection)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(shared.text)
  // 重置回到内置原文。
  await click(zh.save)
  expect(server.prompts.current.config).not.toHaveProperty('overrides')
  // 与内置一致后 override 被删除。
})

it('says which placeholders a template keeps', async () => {
  // 模板类部件要说明必须保留的占位符。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(zh['promptPart.runtime/policy']))
  expect(text()).toContain('这是模板：保留占位符 {version}、{mode}、{rules}，由系统填入内容。')
  // 展示占位符清单。
  expect(text()).toContain(zh['promptReadBy.orchestrator'])
  // 并标明阅读者（此处为编排者）。
})

it('marks an override whose built-in text an upgrade changed, shows how it changed, and keeps the team\'s text or takes the new one', async () => {
  // 升级改动了 override 的内置原文：标记该部件、展示默认内容的变化；团队可选“采用新默认”或“保留我的”。
  const dispatch = builtInParts()['runtime/dispatch']!
  const overrides = { 'runtime/dispatch': { text: '## dispatch\nOur routing.', base: builtInBase('## dispatch\nThe old routing.') } }
  // override 编辑自旧版内置原文。
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides })
  server.prompts.defaultChanged = [{ part: 'runtime/dispatch', base: overrides['runtime/dispatch'].base, previous: '## dispatch\nThe old routing.' }]
  // 服务端报告：该部件的默认内容已从 previous 变为新值。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(all('.dt-prompt-nav .dt-updated-tag').map(tag => tag.closest('.dt-nav-item')!.querySelector('span')!.firstChild?.textContent))
    .toEqual([zh['promptPart.runtime/dispatch']])
  // 导航项标“默认已更新”。
  await click(builtInItem(zh['promptPart.runtime/dispatch']))
  // The change of the built-in text, beside the team's text, which stays, in a region named by the mark.
  // 在专门区域并排展示默认内容的变化与团队文本（团队文本保持不动）。
  const box = () => document.querySelector(`section[aria-label="${zh.promptDefaultUpdated}"]`)
  expect(box()!.textContent).toContain('下面是默认内容的变化。')
  expect([...box()!.querySelectorAll('del')].map(line => line.textContent)).toEqual(['The old routing.\n'])
  expect(box()!.querySelectorAll('ins').length).toBeGreaterThan(0)
  // del 显示旧默认，ins 显示新默认。
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe('## dispatch\nOur routing.')
  // 编辑框仍是团队文本。
  // Taking the new built-in text drops the override.
  // 采用新默认即丢弃 override。
  await click(zh.promptTakeDefault)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(dispatch.text)
  expect(all('.dt-default-updated')).toHaveLength(0)
  // 提示区消失。
  await click(zh.discard)
  await click(builtInItem(zh['promptPart.runtime/dispatch']))
  // Keeping the team's text records the new built-in text as the one it was edited from.
  // 保留团队文本时，把新内置原文记录为它编辑自的 base。
  await click(zh.promptKeepMine)
  expect(all('.dt-default-updated')).toHaveLength(0)
  await click(zh.save)
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/dispatch': { text: '## dispatch\nOur routing.', base: builtInBase(dispatch.text) } })
  // base 已更新为新内置原文。
})

it('shows the team\'s text against the new default when the default it was edited from is not known, or is another one', async () => {
  // base 未知或不匹配时，退化为“团队文本 vs 新默认”的直接对比，而非展示默认内容的变化。
  const dispatch = builtInParts()['runtime/dispatch']!
  // The override was restored from an older version: its base is not the one the changed default was found for.
  // 该 override 从旧版本恢复而来：其 base 不是检测到默认变化时的那个。
  const overrides = { 'runtime/dispatch': { text: '## dispatch\nOur routing.', base: 'restored' } }
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides })
  server.prompts.defaultChanged = [{ part: 'runtime/dispatch', base: 'another', previous: '## dispatch\nThe old routing.' }]
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(zh['promptPart.runtime/dispatch']))
  const box = document.querySelector(`section[aria-label="${zh.promptDefaultUpdated}"]`)!
  // It says the lines are the team's text against the new default, not how the default changed.
  // 文案说明展示的是“你的文本 vs 新默认内容”，而不是默认内容如何变化。
  expect(box.textContent).toContain('系统没有记录你编辑时的默认内容；下面是你的文本与新默认内容的对比。')
  expect(box.textContent).not.toContain('下面是默认内容的变化。')
  expect([...box.querySelectorAll('del')].map(line => line.textContent)).toEqual(['Our routing.\n'])
  // del 侧是团队文本。
  expect([...box.querySelectorAll('ins')].map(line => line.textContent).join('')).toBe(`${dispatch.text.split('\n').slice(1).join('\n')}\n`)
  // ins 侧是新默认正文（去掉标题行）。
})

it('keeps both sides\' first overrides when a draft moves onto a version saved meanwhile', async () => {
  // 冲突 rebase：双方对同一部件的首个 override 各自保留。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(zh['promptPart.runtime/shared']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Shared, ours.')
  const theirs = { 'runtime/dispatch': { text: '## dispatch\nTheirs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) } }
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides: theirs })
  // 他人同时保存了 dispatch 的 override。
  await click(zh.save)
  expect(document.querySelector('.dt-savebar')?.textContent).not.toContain('undefined')
  // 冲突提示文案完整（无 undefined 拼接）。
  await click(zh.save)
  expect(server.prompts.current.config.overrides).toEqual({ ...theirs,
    'runtime/shared': { text: 'Shared, ours.', base: builtInBase(builtInParts()['runtime/shared'].text) } })
  // rebase 后：他人的 dispatch override 与本方的 shared override 共存。
})

it('shows a draft\'s template of a generated part filled, and names a part by its label when a save is refused', async () => {
  // 生成类部件的模板在预览中按系统填好的样子展示；保存被拒时用部件标签指名错误。
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(builtInItem(zh['promptPart.runtime/environment']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Where you work:\n{variables}')
  await click(tab(zh.promptViewFull))
  const environment = all('.dt-preview-part').find(part => part.querySelector('b')?.textContent === zh['promptPart.runtime/environment'])!
  expect(environment.querySelector('pre')?.textContent).toBe('Where you work:\n')
  // {variables} 由系统填入，预览里显示为填好后的空内容。
  await click(tab(zh.promptViewEdit))
  await click(builtInItem(zh['promptPart.runtime/policy']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), '## Policy\n{version} {mode}')
  // 删掉了必需占位符 {rules}。
  await click(zh.save)
  expect(text()).toContain(`「${zh['promptPart.runtime/policy']}」的模板必须保留占位符 {rules}`)
  // 保存被拒并按标签指名部件与缺失的占位符。
})

it('lists the overrides of parts this version no longer has, which the next save drops', async () => {
  // 本版本已移除的部件若还有 override，要列出提示，下次保存时丢弃。
  server.prompts.defaultChanged = [{ part: 'runtime/retired', base: 'b', removed: true }]
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  expect(text()).toContain(zh.promptRemovedParts.replace('{parts}', 'runtime/retired'))
  // 提示文案列出已移除部件名。
})

it('loads a version from the history without its overrides of parts this version no longer has, so it saves', async () => {
  // 从历史载入版本时剔除该版本已不存在的部件 override，使其能通过当前校验保存。
  const dispatch = { text: '## dispatch\nOurs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewHistory))
  // The version restored overrides a part a later version removed.
  // 被恢复的版本 override 了一个后续版本已移除的部件。
  const saved = server.prompts.current
  server.prompts.current = promptVersion(0, { ...defaultPrompts(), overrides: { 'runtime/dispatch': dispatch, 'runtime/retired': { text: 'Old.', base: 'b' } } })
  await click(zh.promptRestore)
  server.prompts.current = saved
  // 恢复动作完成后服务端回到当前版本。
  await click(zh.save)
  expect(server.prompts.current.config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // 保存成功：retired 部件的 override 已被剔除，dispatch 的保留。
})
