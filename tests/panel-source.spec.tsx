// @vitest-environment jsdom
// The Source status and settings.
// 来源（Source）状态页与设置页。
/**
 * 本测试文件覆盖面板的 Source 状态/设置界面：各 Source 的运行状态与计数、
 * 初始化问题（setup problem）跳转到修复设置、飞书群列表的刷新与折叠、
 * 按 kind 字段渲染设置表单并按修订号保存（含冲突合并）、CLI 账号展示与“保存即重启”的锁定、
 * 来源健康的多语言展示与诊断原文、未送达消息列表、以及重启期间的轮询恢复。
 * 测试策略：jsdom + usePanel 假服务端驱动真实 App，篡改 server.setup/settings/health 后断言 DOM 与请求。
 */
import { act } from 'react'
// act：圈住 React 状态更新。
import { expect, it, onTestFinished, vi } from 'vitest'
// vitest 断言、用例、收尾钩子与计时器控制。
import { zh } from '../src/client/locales.ts'
// zh：中文文案字典（按文案定位控件）。
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
// 面板测试夹具：挂载/交互/查询助手；remount 重新挂载以模拟页面刷新。
import { server, problemOf, droppedReply } from './fixtures/panel-server.ts'
// server：假面板服务端；problemOf：构造初始化问题；droppedReply：构造未送达回复。

usePanel()
// 为每个用例启用假面板服务端。
it('shows each Source\'s state on the Source status and opens its settings from a setup problem', async () => {
  // 状态页展示每个 Source 的状态行；初始化问题提供跳转设置的入口。
  await mount()
  await click(zh['tab.source'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(all('.dt-form > .dt-list > .dt-row .dt-row-name').map(title => title.textContent)).toEqual(['飞书', 'GitHub'])
  // 两个已启用 Source 各占一行。
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.querySelector('.dt-row-meta')?.textContent).toBe('24 小时到达 12被过滤 2最近 ' + document.querySelector('.dt-row-meta time, .dt-row-meta .dt-lv:last-child .dt-lv-value')?.textContent)
  // 元信息：24 小时计数与最近触发时间。
  expect(text()).toContain(zh['sourceState.error'])
  expect(text()).toContain('socket closed')
  // GitHub 处于 error，诊断原文照录。
  expect(all('.dt-card')).toHaveLength(0)
  // 状态页不渲染设置卡片。
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
  await remount()
  await click(zh['tab.source'])
  await click(zh.sourceOpenSettings)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  // 跳转后落在设置页的来源分组。
  expect(all('.dt-card')[1]!.textContent).toContain('部署检查未通过：没有设置智能体的 GitHub CLI。')
  // 出问题的 Source 卡片展示检查结论。
})

it('folds more than six chats into a line of their names', async () => {
  // 监听群多于 6 个时折叠成一行群名摘要。
  const chats = Array.from({ length: 7 }, (_, n) => ({ chatId: n ? `oc_c${n}` : 'oc_team', listen: 'all' as const }))
  server.settings.sources.feishu = { ...server.settings.sources.feishu!, config: { ...server.settings.sources.feishu!.config, chats } }
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const summary = all('.dt-card')[0]!.querySelector('.dt-rows-summary')!
  expect(summary.textContent).toBe(['团队群', 'oc_c1', 'oc_c2', 'oc_c3', 'oc_c4', 'oc_c5', 'oc_c6'].join('、'))
  // 摘要按群名展开：已命名群显示名称，其余显示 id。
})

it('rereads the chats the bot has joined on request and says which are new, keeping unsaved edits', async () => {
  // 手动刷新群列表：报告新增群；失败保持原列表；正在添加的行不被重置。
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const feishu = () => all('.dt-card')[0]!
  const button = () => [...feishu().querySelectorAll('button')].find(item => item.textContent === '刷新群列表')!
  await click([...feishu().querySelectorAll('button')].find(item => item.textContent === '添加')!)
  server.joining = { oc_new: '新群' }
  // 下一次刷新会读到“新群”。
  await click(button())
  expect(server.requests.find(request => request.path === 'sources/feishu/labels')).toMatchObject({ method: 'POST' })
  expect(document.querySelector('.dt-toast')?.textContent).toBe('列表已更新，新增：新群')
  // 提示列出新增群名。
  // The row being added stays, and now offers the new chat.
  // 正在添加的行保留，且下拉里出现新群。
  const pick = feishu().querySelectorAll('.dt-rows-item')[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群', '新群'])
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.labelsCurrent)
  // 无新增时提示“列表已是最新”。
  server.joinError = 'lark-cli: token expired'
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe('读取失败，列表保持不变：lark-cli: token expired')
  // 刷新失败：toast 说明列表未变。
  expect(button().disabled).toBe(false)
  // 按钮恢复可点。
  // Only a field whose key column offers a refresh shows the button.
  // 只有键列支持刷新的字段才显示刷新按钮。
  expect([...all('.dt-card')[1]!.querySelectorAll('button')].some(item => item.textContent === '刷新群列表')).toBe(false)
})

it('renders each Source\'s settings from its kind\'s fields and saves one Source against its own revision', async () => {
  // 设置表单由 kind 的 fields 渲染；每个 Source 按自己的修订号保存，冲突时逐字段合并重试。
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const cards = all('.dt-card')
  expect(cards.map(card => card.querySelector('.dt-row-title')?.firstChild?.textContent)).toEqual(['飞书', 'GitHub'])
  const feishu = cards[0]!
  expect(feishu.textContent).toContain('接收的群')
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '添加')!)
  const rows = feishu.querySelectorAll('.dt-rows-item')
  // A saved chat shows its name; a row being added picks from the joined chats not yet configured.
  // 已保存的行显示群名；正在添加的行从未配置的已加入群里选择。
  expect(rows[0]!.querySelector('.dt-row-label')?.textContent).toBe('团队群')
  expect(rows[0]!.querySelector('select[aria-label="选择机器人已加入的群"]')).toBeNull()
  const pick = rows[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群'])
  await type(pick, 'oc_other')
  await type(rows[1]!.querySelector('select[aria-label="接收"]')!, 'all')
  await click('接收私聊')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT', body: { revision: 0,
    value: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_other', listen: 'all' }],
      directMessages: false } } } })
  // 飞书按 revision 0 保存，负载为完整实例配置。
  expect(server.settings.sources.feishu!.config).toMatchObject({ directMessages: false })
  const github = all('.dt-card')[1]!
  await click('运行来源：GitHub')
  server.revisions['source:github'] = 5
  // 保存间隙别处把 github 的修订号推进到 5。
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  // Another save changed nothing this draft changed, so the draft moves onto the newer revision and saves from there.
  // 别人的保存没有动本草稿改过的字段：草稿合并到新修订号并从那里保存。
  expect(github.querySelector('.dt-savebar')?.textContent).toContain('设置已在别处修改，你的修改已合并到最新版本')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github).toMatchObject({ enabled: false })
  expect(server.revisions['source:github']).toBe(6)
  // 重试后以修订号 6 保存成功。
})

it('shows the account each CLI signs in as, and keeps a saved CLI on screen while dsh-superagent restarts', async () => {
  // CLI 当前账号展示；保存代理 CLI 会重启 dsh-superagent，期间字段锁定且值不被丢。
  await mount()
  await click(tab(zh['tab.settings']))
  const github = all('.dt-card')[1]!
  expect(github.textContent).toContain('当前账号 @agent-bot')
  const labels = () => [...github.querySelectorAll('label')].map(label => label.textContent)
  expect(labels()).toEqual(['监听的仓库', '智能体的 GitHub CLI'])
  // 默认只显示基础字段，高级字段折叠。
  expect(field<HTMLInputElement>('监听的仓库').value).toBe('acme/widgets')
  // A fact describes the saved value, so an edited CLI shows none until it is saved.
  // 账号是“已存值”的事实说明：CLI 改动未保存前不显示账号。
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), 'gh-other')
  expect(github.textContent).not.toContain('当前账号 @agent-bot')
  await click(zh.discard)
  expect(github.textContent).toContain('当前账号 @agent-bot')
  // 丢弃草稿后账号说明恢复。
  await click([...github.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes('高级'))!)
  expect(labels()).toEqual(['监听的仓库', '智能体的 GitHub CLI', '轮询间隔 / 秒', '连续失败几次后报告异常'])
  // 展开高级字段。
  expect(all('.dt-card')[0]!.textContent).toContain('当前机器人 Widgets Bot')
  // 飞书卡展示当前机器人身份。
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), '/opt/bin/gh-agent')
  expect(github.textContent).toContain('保存会重启 dsh-superagent：2 个进行中的派工会中断，并带恢复说明重新开始。')
  // 改动 CLI 时预告重启影响。
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github!.config).toMatchObject({ cli: '/opt/bin/gh-agent' })
  expect(text()).toContain(zh.savedRestarting)
  // The saved value stays, and the card's fields are disabled, until the saved revision returns with the restarted dsh-superagent.
  // 重启期间：已存值保持显示、字段禁用，直到重启后的服务端返回已存修订号。
  expect(field<HTMLInputElement>('智能体的 GitHub CLI').value).toBe('/opt/bin/gh-agent')
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(true)
  expect(sessionStorage.getItem('dsh-superagent/draft/master/source:github')).toBeNull()
  // 草稿已清空（不再需要恢复）。
})

it('points a setup problem at the settings that fix it', async () => {
  // 初始化问题指到能修复它的设置卡片，并触发滚动定位。
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  // jsdom has no scrolling; mock scrollIntoView to record which card the link brings into view.
  // jsdom 没有滚动；用 mock scrollIntoView 记录链接定位到了哪张卡片。
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  await mount()
  expect(text()).toContain(zh.problemSetup)
  expect(text()).toContain(zh['setup.agentCliUnset'])
  // Nothing runs while setup waits, so the Executor says so instead of counting.
  // 初始化未过时什么都不跑：执行器显示“等待初始化”而非计数。
  expect(text()).toContain(zh.executorWaitingSetup)
  expect(all('.dt-stat').map(stat => stat.textContent)).not.toContain('执行中2 / 3')
  expect(text()).toContain('在设置 › 来源的 GitHub 卡片修正后保存，会重新检查')
  await click(find(zh.problemSetup, 'button, a, [role="button"]'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  expect(all('.dt-card')[1]!.textContent).toContain('部署检查未通过：没有设置智能体的 GitHub CLI。')
  expect(scroll.mock.contexts).toContain(all('.dt-card')[1])
  // 链接把出问题的 GitHub 卡片滚入视野。
  delete (Element.prototype as Partial<Element>).scrollIntoView
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('部署检查未通过：没有设置智能体的 GitHub CLI。')
  // 部署分组同样展示该检查问题。
  // After a fix outside dsh-superagent, a check runs setup again.
  // 在 dsh-superagent 之外修复后，可手动重新检查。
  await click(zh.setupCheck)
  expect(server.requests.filter(request => request.path === 'setup/check')).toEqual([{ path: 'setup/check', method: 'POST' }])
  expect(text()).toContain(zh.setupChecking)
  server.setup = { ...server.setup, problem: problemOf('gitTooOld') }
  await remount()
  await click(zh['tab.overview'])
  await click(find(zh.problemSetup, 'button, a, [role="button"]'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  // gitTooOld 问题跳到部署分组。
  expect(text()).toContain('部署检查未通过：git 没有读取 dsh-superagent 为 github.com 写的凭据配置')
})

it('shows a failed Feishu bot check as a problem of the Feishu Source only, with a check after a fix outside dsh-superagent', async () => {
  // 飞书检查失败只算飞书 Source 的问题；重新检查会重启 dsh-superagent，需确认且不打扰执行中的派工。
  server.setup = { ...server.setup, feishuProblem: problemOf('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }),
    accounts: { ...server.setup.accounts!, feishu: null } }
  await mount()
  expect(text()).toContain(zh.problemSetupFeishu)
  expect(text()).not.toContain('飞书 来源异常')
  // 不影响 GitHub Source 的状态展示。
  await click(find(zh.problemSetupFeishu, 'button, a, [role="button"]'))
  const feishu = all('.dt-card')[0]!
  expect(feishu.textContent).toContain('部署检查未通过：应用 cli_bot 的机器人身份状态是 missing；用 lark-cli 配置应用密钥。')
  // dsh-superagent runs meanwhile, so checking again asks first: the restart interrupts running Executor Sessions.
  // dsh-superagent 正在运行：重新检查先弹确认（重启会打断执行中的 Executor Session）。
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '重新检查')!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('重新检查会重启 dsh-superagent：2 个进行中的派工会中断')
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(false)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(true)
  // 确认后才发检查请求。
  await click(tab(zh['tab.source']))
  // The Source's state carries the problem once, not again as its health.
  // Source 状态里该问题只出现一次，健康信息里不重复。
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.textContent?.match(/cli_bot 的机器人身份状态是 missing/g)).toHaveLength(1)
})

it('leaves Feishu out of a GitHub-only deployment', async () => {
  // 纯 GitHub 部署：飞书相关选项从界面消失。
  server.setup = { ...server.setup, accounts: { ...server.setup.accounts!, feishu: null } }
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { enabled: false, config: {} } } }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewFull))
  expect([...field<HTMLSelectElement>(zh.promptPreviewTarget).options].map(option => option.textContent)).toEqual(['主 Session',
    '执行器 Session', 'dsh-superagent-github'])
  // 预览目标只有主 Session、执行器与 github 来源，无飞书。
})

it('shows the Sources waiting for the deployment check, and the problem on the Source that fixes it, with its link', async () => {
  // 部署检查期间：无关 Source 显示“等待部署检查”，出问题的 Source 显示错误并带跳转。
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await mount()
  await click(zh['tab.source'])
  const rows = all('.dt-form > .dt-list > .dt-row')
  // The GitHub Source is where the problem is fixed, so it shows the error; Feishu waits.
  // GitHub Source 是修复问题的地方，因此显示错误；飞书等待。
  expect(rows.map(row => row.querySelector('.dt-status-text')?.textContent)).toEqual(['等待部署检查', '出错'])
  expect(text()).not.toContain('Waiting for setup')
  // 界面文案为中文，不混英文。
  expect(rows[1]!.textContent).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  await click(find(zh.sourceOpenSettings, '.dt-row button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
})

it('shows a Source\'s health in the interface language, and a diagnostic as reported', async () => {
  // 健康详情按界面语言渲染（带参数替换），诊断原文原样展示。
  server.health = { github: { state: 'error', detail: '3 consecutive failed polls; last: EOF', code: 'pollFailures', values: { count: '3',
    error: 'EOF' } } }
  await mount()
  await click(zh['tab.source'])
  const github = all('.dt-form > .dt-list > .dt-row').find(row => row.querySelector('.dt-row-name')?.textContent === 'GitHub')!
  expect(github.textContent).toContain('GitHub 来源：连续 3 次轮询失败，最近一次：EOF')
  // code+values 渲染成中文文案。
  expect(github.textContent).not.toContain('consecutive')
  const feishu = all('.dt-form > .dt-list > .dt-row').find(row => row.querySelector('.dt-row-name')?.textContent === '飞书')!
  expect(feishu.querySelector('.dt-mono')?.textContent).toBe('socket closed')
  // 没有对应文案码的诊断按原文等宽展示。
})

it('shows a refused Source save with the output of the tool that failed on its own line', async () => {
  // 保存被拒：保存条里分两行显示结论与失败工具的输出。
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const feishu = all('.dt-card')[0]!
  await type(field<HTMLInputElement>('机器人的 lark-cli'), 'lark-broken')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(feishu.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe('机器人的 lark-cli 不可用。\nlark-cli: app secret missing')
})

it('shows a setup problem on its Source card within one read of the settings, which the settings groups share', async () => {
  // 初始化问题通过共享的设置读取到达来源卡片；来源设置页不额外读来源状态接口。
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const card = () => document.getElementById('dt-source-github')!
  expect(card().textContent).not.toContain(zh['setup.agentCliUnset'])
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
  // The settings are read every five seconds, as the state is; the Source settings do not read the Source status.
  // 设置与状态同为每 5 秒轮询一次；来源设置页不读 Source 状态接口。
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings')).toHaveLength(2)
  expect(server.requests.some(request => request.path === 'sources')).toBe(false)
  expect(card().textContent).toContain(zh['setup.agentCliUnset'])
  // 一次轮询后卡片即显示问题。
})

it('lists the messages a Source did not send in the last day under it, newest first, with why and where they belong', async () => {
  // 未送达消息列表：按来源分组、最新在前，标明原因与归属（可跳转）。
  // Include a drop older than 24h (m0) and one with a missing thread (m1).
  // 样本包含超过 24 小时的旧丢弃（m0）与缺线程引用的（m1）。
  server.dropped = [droppedReply('m3', 1, 'feishu', 'channelGone', { ticket: { id: 't1', title: '修复回归' } }),
    droppedReply('m2', 3, 'feishu', 'channelIgnored'), droppedReply('m1', 4, 'feishu', 'channelGone', { thread: false }),
    droppedReply('m0', 30, 'feishu', 'channelGone'), droppedReply('g0', 2, 'github', 'channelGone')]
  await mount()
  await click(zh['tab.source'])
  const [feishu, github] = all('.dt-form > .dt-list > .dt-row')
  const disclosure = (scope: Element) =>
    [...scope.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes(zh.sourceDroppedTitle))!
  await click(disclosure(feishu!))
  const rows = [...feishu!.querySelectorAll('.dt-disclosure-body .dt-row')].map(row => [row.querySelector('.dt-row-title')?.textContent,
    row.querySelector('.dt-tag')?.textContent, row.querySelector('button')?.textContent])
  expect(rows).toEqual([['Reply m3', zh['reason.channelGone'], '修复回归'],
    ['Reply m2', zh['reason.channelIgnored'], zh['term.thread']], ['Reply m1', zh['reason.channelGone'], undefined]])
  // m0 超过 24 小时不显示；有归属工单的给跳转按钮，无线程的没有。
  expect(github!.textContent).toContain(`${zh.sourceDroppedTitle} 1`)
  await click(find('修复回归', '.dt-disclosure-body button'))
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  // 点击工单归属跳到执行页。
  await remount()
  await click(zh['tab.source'])
  await click(disclosure(document.body))
  // A Feishu Channel names its chat; the link opens the Thread of the message it answers, which the host found.
  // 飞书频道用会话名链接：打开它所回复消息的线程（宿主已定位）。
  await click(find(zh['term.thread'], '.dt-disclosure-body button'))
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(text()).not.toContain(zh.threadNotFound)
  // 线程找得到，不显示“未找到”。
})

it('takes no space for messages that were all sent', async () => {
  // 全部送达时不渲染未送达区块。
  await mount()
  await click(zh['tab.source'])
  expect(text()).not.toContain(zh.sourceDroppedTitle)
})

it('reads the settings again as soon as dsh-superagent answers after a save restarted it', async () => {
  // 保存触发重启后：服务端一恢复应答就立刻重读设置并解锁字段。
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), '/opt/bin/gh-agent')
  const github = all('.dt-card')[1]!
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(true)
  // dsh-superagent restarts: DSH answers with empty 404s, then it answers again.
  // 重启过程：先应答空的 404，随后恢复应答。
  server.down = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  server.down = false
  const reads = server.requests.filter(request => request.path === 'settings').length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings').length).toBeGreaterThan(reads)
  // 恢复应答后 1 秒内即重读设置（不等下一个整周期）。
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(false)
  expect(field<HTMLInputElement>('智能体的 GitHub CLI').value).toBe('/opt/bin/gh-agent')
  // 字段解锁且显示已保存的值。
})
