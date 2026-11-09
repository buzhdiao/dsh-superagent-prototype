// @vitest-environment jsdom
// Eval（评估）状态与设置页。
/**
 * 本测试文件覆盖面板的“评估”设置页（src/client 下 Policy/Eval 相关 UI）：
 * 决策列表按 kind 过滤与流量入口、策略草稿跨重挂载保留并逐发送者/逐规则合并他人保存、
 * Policy 只含规则与各来源分区（核心不含自动合并等提示词内容）、无效字段只展开所在规则、
 * 来源名单同步（草稿未保存时禁止）、规则的增删改/复制/启停不碰 Eval、
 * 策略版本的唯一展示与组成说明、授权（Mandate）版本跳转历史、
 * 飞书准入表按接收范围出格并警示“任何人可发起工作”、各来源机器人名单与 GitHub 准入表、
 * 以及 GitHub 开关与其准入行的英文界面。测试策略：jsdom + usePanel 假服务端，
 * 直接驱动真实 App 组件，断言 DOM 状态与假服务端收到的请求。
 */
import { act } from 'react'
// act：把事件派发圈进 React 的批量渲染。
import { expect, it } from 'vitest'
// vitest 断言与用例。
import { en, zh } from '../src/client/locales.ts'
// en/zh：英文与中文文案字典（用于按文案定位控件）。
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field } from './fixtures/panel.tsx'
// 面板测试夹具：usePanel 装配假服务端与挂载环境，mount/remount 挂载 App，其余为 DOM 交互助手。
import { server } from './fixtures/panel-server.ts'
// server：假面板服务端（可篡改 settings 状态并记录请求）。

usePanel()
// 为每个用例启用假面板服务端并负责卸载清理。
it('opens the Decisions under Policy from the flow line with their reasons, Decisions that start work first, filterable by kind',
  async () => {
  // 从总览流量行打开 Policy 下的决策列表：带理由、先看“开始工作”的决策，并可按 kind 过滤。
  await mount()
  await click(all('.dt-stat button')[1]!)
  // 点击总览第二个统计卡。
  expect(tab(zh['tab.eval']).getAttribute('aria-selected')).toBe('true')
  // 落在评估页签。
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=accept,reopen&window=24h')).toBe(true)
  // 默认查询：近 24 小时的 accept/reopen（开始工作的决策）。
  expect(text()).toContain(zh['reason.explicitRouted'])
  // 决策带人类可读的理由。
  await click(zh.stop)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=stop&window=24h')).toBe(true)
  // 切到 stop 过滤。
  expect(text()).toContain('@bot 修一下')
  await click(zh['decision.ignore'])
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore&window=24h')).toBe(true)
  // 切到 ignore 过滤。
  expect(text()).toContain(zh.none)
  // 该类决策为空时显示“暂无”。
  await click(zh.lastDayOnly)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore')).toBe(true)
  // 关闭“仅最近一天”后窗口参数从请求中消失。
})

it('keeps a Policy draft across remounts, and merges another save into it sender by sender and rule by rule', async () => {
  // 策略草稿跨重挂载保留；他人保存时逐发送者、逐规则合并进草稿，而不是整块覆盖。
  const addUser = async () => {
    // 在“能发起工作的人”名单里新增一行（open_id + 名字）。
    await click(all('.dt-part button').find(button => button.textContent === '添加')!)
    const row = all('.dt-part .dt-rows-item').at(-1)!
    await type(row.querySelector<HTMLInputElement>('input[aria-label="open_id"]')!,
      'ou_newperson'); await type(row.querySelector<HTMLInputElement>('input[aria-label="名字"]')!, '新人')
  }
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  // 从状态头进入策略编辑。
  expect(all('.dt-subtab').map(tab => tab.textContent)).toEqual(['飞书', 'GitHub'])
  // 子页签按来源划分。
  await addUser()
  expect(text()).toContain(zh.draftKept)
  // 出现草稿提示。
  await remount()
  expect(text()).toContain(zh.draftRestored)
  expect(all('.dt-part .dt-rows-item')).toHaveLength(2)
  // 重挂载后草稿恢复：名单仍是原有 + 新增一行。
  // Someone else renames a rule and allows another sender meanwhile: the draft keeps its own sender and takes both of theirs.
  // 与此同时别人重命名了规则、放行了另一名发送者：草稿保留自己的发送者，并同时收下对方的改动。
  const { policy } = server.settings
  server.settings = { ...server.settings, policy: { ...policy, rules: [{ ...policy.rules[0]!, name: '文案' }],
    sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob',
      name: 'Bob' }] } } } }
  server.revisions.policy = 4
  // 直接篡改服务端状态制造他人保存，并抬高版本号。
  await click(zh.save)
  expect(text()).toContain(zh.saveMerged)
  // 保存提示“已合并”。
  await type(all('.dt-part input[aria-label="名字"]').at(-2) as HTMLInputElement, '新同事')
  expect(text()).not.toContain(zh.saveMerged)
  // 继续编辑后“已合并”提示消失（回到普通草稿）。
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_newperson', name: '新同事' },
    { id: 'ou_bob', name: 'Bob' }])
  // 名单逐行合并：自己的两行（含改名）+ 他人的 Bob。
  expect(server.settings.policy.rules.map(rule => rule.name)).toEqual(['文案'])
  // 规则只按规则合并：保留他人重命名，草稿未动规则名。
  expect(sessionStorage.getItem('dsh-superagent/draft/master/policy')).toBeNull()
  // 保存后草稿从 sessionStorage 清除。
})

it('keeps the Policy to its rules and each Source\'s part, in that Source\'s own identities', async () => {
  // Policy 只含规则与各来源分区，且各来源用自己的身份语境描述。
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['term.eval'], '.dt-settings-link'))
  // 从术语“评估”的设置链接进入。
  // Auto-merge and its threshold are prompt text, and no Source's settings sit in the Policy core.
  // 自动合并及其阈值属于提示词文本；任何来源的设置都不放进 Policy 核心。
  for (const gone of ['自动合并', '行数阈值', '成员', '计入策略版本']) expect(text()).not.toContain(gone)
  expect(all('.dt-lv').map(item => item.textContent)[0]).toBe('策略版本 abcdef12')
  // 顶部显示当前策略版本。
  expect(text()).toContain('名单内的人 @ 机器人或私聊机器人，总是明确的请求')
  // 飞书分区用飞书自己的身份语境描述。
  await click(find(zh['source.github'], '.dt-subtab'))
  expect(text()).toContain('能发起工作的 GitHub 账号')
  expect(text()).toContain('名单里的账号在 Issue 或评论里 @ 智能体的账号。')
  // GitHub 分区切换到 GitHub 的账号语境。
  // A saved account shows as its id; only a row being added is a field.
  // 已保存的账号显示为 id 文本；只有正在新增的行才是输入框。
  expect(all('.dt-part .dt-rows-item .dt-row-label').map(label => label.textContent)).toEqual(['alice'])
})

it('opens the rule list for an invalid field inside it only', async () => {
  // invalid 事件只展开所在规则的列表，不展开全部规则。
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const openRows = () => all('.dt-disclosure[data-open]').length
  // 统计展开的 disclosure 数。
  await act(async () => { field(zh.evalTimeout).dispatchEvent(new Event('invalid', { bubbles: false })) })
  expect(openRows()).toBe(0)
  // 非规则字段（evalTimeout）的 invalid 不展开任何规则。
  await click(all('.dt-rule [data-disclosure-row]')[0]!)
  await act(async () => { all('.dt-rule input')[0]!.dispatchEvent(new Event('invalid')) })
  expect(openRows()).toBe(all('.dt-rule').length)
  // 规则内字段 invalid（冒泡）时展开全部规则行。
})

it('syncs a Source\'s list from where the Source keeps it, but not while a Policy draft is unsaved', async () => {
  // 从来源自己保存名单处同步名单；草稿未保存时禁止同步。
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect([...all('.dt-part select')[0]!.querySelectorAll('option')].map(option => option.textContent)).toEqual(['不同步', '另一个群', '团队群'])
  // 同步来源下拉：选项来自来源配置里监听的群。
  await click(find('立即同步', '.dt-part button'))
  expect(server.requests.some(request => request.path === 'policy-sync/feishu' && request.method === 'POST')).toBe(true)
  // 立即同步发起 POST policy-sync/feishu。
  await type(all('.dt-part select')[0] as HTMLSelectElement, 'oc_other')
  const before = server.requests.length
  await click(find('立即同步', '.dt-part button'))
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.syncNeedsSave)
  // 有未保存草稿时只弹“先保存”提示。
  expect(server.requests.slice(before).some(request => request.path.startsWith('policy-sync'))).toBe(false)
  // 且不发出任何同步请求。
})

it('adds, copies, renames, disables and deletes rules in Policy without touching Eval', async () => {
  // 在 Policy 里增/复制/改名/启停/删规则，全程不触碰 Eval 设置。
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh.addRule)
  await type(field<HTMLInputElement>(zh.ruleName), '文档')
  await type(field<HTMLTextAreaElement>(zh.ruleInstruction), '修复失效链接')
  await click(zh.duplicate)
  expect(all('.dt-rule').map(rule => rule.querySelector('[data-disclosure-row]')!.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('文档 副本')]))
  // 复制出的规则标题带“副本”。
  await click('启用规则：文案修改')
  // 用复选框的 aria-label 定位：停用原有规则。
  const removeButtons = all('button').filter(button => button.textContent === '删除')
  await click(removeButtons.at(-1)!)
  await click(zh.save)
  expect(server.settings.policy.rules.map(rule => [rule.name, rule.enabled])).toEqual([['文案修改', false], ['文档', true]])
  // 保存后：原规则被停用、新规则启用、“副本”已被删除。
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/policy'])
  // 全部改动只落到 settings/policy 一个接口（与 Eval 解耦）。
})

it('shows the current Policy version once, explains what makes it up, and opens a Mandate\'s version in the Policy history', async () => {
  // 当前策略版本只展示一次，并说明其组成；从授权（Mandate）可跳到历史里的对应版本。
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await settle()
  expect(all('.dt-lv')[0]!.textContent).toBe('策略版本 abcdef12')
  expect(all('.dt-info').map(tip => tip.getAttribute('aria-label')).join('\n')).toContain('策略版本由接单规则、各来源上的策略和评估的接单模式决定')
  // 版本提示说明其组成（规则 + 各来源策略 + 接单模式）。
  expect(all('.dt-tag').filter(tag => tag.textContent === '计入策略版本')).toHaveLength(0)
  // 不再给各行重复挂“计入策略版本”标签。
  await click(tab(zh['tab.execution']))
  await click('修复回归')
  await click('abcdef12')
  // 从工单详情点策略版本号。
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
  // 落到设置页的“评估”一节并标为当前。
  await settle()
  // The history opens at the save that made the version, and lists versions that Source saves made too.
  // 历史定位到产生该版本的保存，也列出来源保存产生的版本。
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('生成策略版本 abcdef12')
  expect(text()).toContain('生成策略版本 98765432')
})

it('sets the Feishu admission table per receiving scope, offering only the cells a scope can receive, and warns when anyone may originate work', async () => {
  // 飞书准入表按接收范围逐行设置：范围只能收到它听得见的消息格；名单外任何人可发起时给警示。
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { enabled: true, config: { cli: 'lark-bot',
    chats: [{ chatId: 'oc_team', listen: 'all' }, { chatId: 'oc_other', listen: 'mentions' }], directMessages: true,
      otherChats: 'none' } } } }
  // 预置来源配置：一个全量群、一个仅@群、允许私聊、其他群不收。
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['term.eval'], '.dt-settings-link'))
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  // Chats receiving every message have all three cells; @-only chats only the mention cell; other chats nothing while not received.
  // 全量接收的群有三个格；仅@的群只有点名格；不接收的其他群暂没有格。
  expect(rows).toEqual([['团队群', 3], ['另一个群', 1], ['其他群', 0], ['私聊', 1]])
  const cell = field<HTMLSelectElement>('团队群 · 名单外 · 点名智能体')
  expect(cell.value).toBe('ignore')
  await type(cell, 'explicit')
  // 把“团队群 · 名单外 · 点名”设为 explicit。
  // The warning is an icon in a slot every cell reserves, with the text on hover, so the table does not move.
  // 警示是每格预留槽位里的图标，文字悬停显示，避免表格跳动。
  expect(document.querySelector('.dt-admission .dt-info-warn')?.getAttribute('aria-label')).toBe(zh.admissionAnyoneWarning)
  expect(all('.dt-admission-slot')).toHaveLength(5)
  // A message not addressed to the bot cannot be an explicit request.
  // 未点名机器人的消息不可能成为明确请求：该格没有 explicit 选项。
  expect([...field<HTMLSelectElement>('团队群 · 名单外 · 未 @').options].map(option => option.value)).toEqual(['inferred', 'ignore'])
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.admission).toEqual({ oc_team: { unlistedAddressed: 'explicit' } })
  // 保存只落改动的那个格子。
})

it('lists each Source\'s bots next to its people and saves them, and sets the GitHub admission table by its receiving scopes', async () => {
  // 各来源的用户名单旁列出机器人名单并保存；GitHub 准入表随其接收开关的范围变化。
  await mount()
  await click(tab(zh['tab.settings']))
  // The GitHub Source receives only what is addressed to the agent until a switch opens a scope of the repository.
  // 在开关打开某个仓库范围之前，GitHub 来源只接收点名智能体的消息。
  const github = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  expect([...github.querySelectorAll('.dt-switch-row')].map(row => row.textContent)).toEqual(['接收仓库里的新 Issue', '接收仓库里的新 PR',
    '接收仓库里的评论', '接收默认分支的 CI'])
  expect([...github.querySelectorAll('[role="switch"]')].slice(1).map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'false',
    'false', 'false'])
  // 四个接收开关默认全关（第一个开关不属于接收范围，故从下标 1 起）。
  await click(find(zh['term.eval'], '.dt-settings-link'))
  const lists = () => all('.dt-part > .dt-field .dt-subhead .dt-field-head').map(head => head.firstChild?.textContent)
  const list = (label: string) => all('.dt-part > .dt-field').find(item => item.textContent?.startsWith(label))!
  const add = async (label: string) => {
    // 在指定名单里加一行并返回该行。
    await click([...list(label).querySelectorAll('button')].find(button => button.textContent === zh.addRow)!)
    return [...list(label).querySelectorAll('.dt-rows-item')].at(-1)!
  }
  expect(lists()).toEqual(['能发起工作的飞书用户', '消息可以成为候选的机器人'])
  // 飞书分区：用户名单 + 机器人名单并排。
  const bot = await add('消息可以成为候选的机器人')
  await type(bot.querySelector<HTMLInputElement>('input[aria-label="App ID 或 open_id"]')!, 'cli_reviewer')
  await type(bot.querySelector<HTMLInputElement>('input[aria-label="名字"]')!, '评审机器人')
  await click(find(zh['source.github'], '.dt-subtab'))
  expect(lists()).toEqual(['能发起工作的 GitHub 账号', '评论可以成为候选的机器人'])
  // GitHub 分区：账号名单 + 机器人名单。
  await type((await add('评论可以成为候选的机器人')).querySelector<HTMLInputElement>('input[aria-label="账号"]')!, 'dependabot[bot]')
  // Until the GitHub Source receives the repository's Issues, pull requests, comments or CI, only messages that mention the agent arrive.
  // 在 GitHub 来源接收仓库的 Issue/PR/评论/CI 之前，只有点名智能体的消息会到达。
  const rows = () => all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelector('.dt-admission-scope small')?.textContent, row.querySelectorAll('select').length])
  expect(rows()).toEqual([['新 Issue', '仅 @', 1], ['新 PR', '仅 @', 1], ['评论', '仅 @', 1], ['默认分支的 CI', '不接收', 0]])
  // 开关全关：每个范围都标“仅 @”，CI 不接收、没有格。
  expect(field<HTMLSelectElement>('新 Issue · 名单外 · 点名智能体').value).toBe('ignore')
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.bots).toEqual([{ id: 'cli_reviewer', name: '评审机器人' }])
  expect(server.settings.policy.sources.github!.bots).toEqual([{ id: 'dependabot[bot]' }])
  // 两个来源的机器人名单分别落库。
})

it('shows the GitHub Source\'s switches for what it receives across the repository, and the admission rows they open, in English', async () => {
  // 英文界面：GitHub 接收开关与其打开的准入行。
  server.settings.sources.github = { ...server.settings.sources.github!, config: { ...server.settings.sources.github!.config,
    observeIssues: true, observeCi: true } }
  // 预置：接收 Issue 与 CI。
  await mount(en)
  await click(tab(en['tab.settings']))
  const github = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  expect([...github.querySelectorAll('.dt-switch-row')].map(row => [row.textContent, row.querySelector('[role="switch"]')
    ?.getAttribute('aria-checked')])).toEqual([['Receive new Issues in the repository', 'true'],
    ['Receive new pull requests in the repository', 'false'], ['Receive comments in the repository', 'false'],
    ['Receive the default branch\'s CI', 'true']])
  // 开关行随预置配置显示开/关。
  await click(find('Receive comments in the repository', '[role="switch"]'))
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github!.config).toMatchObject({ observeIssues: true, observeComments: true, observeCi: true })
  // 提交卡片表单后评论开关落库。
  await click(find(en['term.eval'], '.dt-settings-link'))
  await click(find(en['source.github'], '.dt-subtab'))
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  expect(rows).toEqual([['New Issues', 3], ['New pull requests', 1], ['Comments', 3], ['Default branch CI', 1]])
  // 打开的范围有 3 格（名单外点名/名单外未点名/名单内），未开的只有点名格。
  // CI has no sender: its one cell is that of a message off the list that does not mention the agent.
  // CI 没有发送者：它唯一的一格就是“名单外且未点名”的格。
  expect(field('Default branch CI · Not on the list · no mention')).toBeTruthy()
  expect(all('.dt-admission thead th').map(cell => cell.textContent)).toContain(en.admissionAddressed)
  // 表头含“点名智能体”一列的英文文案。
})
