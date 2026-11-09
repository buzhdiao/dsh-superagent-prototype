// @vitest-environment jsdom
// 执行状态、单个工单页与执行设置。
/**
 * 本测试文件覆盖面板的“执行”页（src/client 下执行状态与工单详情 UI）：
 * 工单列表按等待对象分组（执行器状态与暂停作为操作）、确认后停止工单、
 * 工单详情展示阶段/授权详情（含触发器与决策）/订阅线程/未送达输入/渠道与环境 disclosure、
 * 缺失工单报“未找到”而非空页、问题链接到渠道、连续自动消息折叠、字段说明用悬停 tooltip、
 * 待评审工单的评审入口与 Session 链接、执行设置“先按原样保留、保存时一次转换”、
 * 双语下说明输入未投递的原因、区分“工单不存在”与“宿主未响应”、
 * 推断授权的依据事实/上下文线程/交回输入、结束工单按结局措辞（附人的理由）、
 * 以及确认按钮双击只发一次停止。测试策略：jsdom + usePanel 假服务端，
 * 预置工单/线程/详情状态后驱动真实 App，断言 DOM 与假服务端收到的请求。
 */
import { act } from 'react'
// act：把事件派发圈进 React 的批量渲染。
import { expect, it } from 'vitest'
// vitest 断言与用例。
import { en, zh } from '../src/client/locales.ts'
// en/zh：英文与中文文案字典（用于按文案定位控件）。
import { usePanel, mount, remount, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
// 面板测试夹具：usePanel 装配假服务端与挂载环境，at 定位页面，其余为 DOM 交互助手。
import { MEMBER, server, ticketSummary, threadSummary } from './fixtures/panel-server.ts'
// server：假面板服务端（可篡改 tickets/ticketDetails 状态并记录请求）；ticketSummary/threadSummary：工单与线程行 fixture。

usePanel()
// 为每个用例启用假面板服务端并负责卸载清理。
it('lists Tickets under Execution by who they wait on, with the Executor state and its pause as an action', async () => {
  // 执行页的工单按“在等谁”分组列出，展示执行器状态，暂停是一个独立操作。
  server.tickets.open = [ticketSummary(), ticketSummary({ id: 't2', title: '执行中的工单', threads: [{ key: 'github:7',
    source: 'github', title: '#7 x', facts: { number: { value: '#7' }, autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' },
      value: { zh: '已开启', en: 'on' } } } }] })]
  // 预置两张进行中工单，第二张的线程带“自动合并已开启”事实。
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20')).toBe(true)
  // 列表按 open 状态拉取。
  expect(text()).toContain(zh.executorRunning)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('GitHub#7自动合并已开启')
  // 线程事实以 chip 形式透出。
  await click(zh.idleLabel)
  expect(server.requests.some(request => request.path === 'tickets?state=idle&limit=20')).toBe(true)
  // 切到“空闲”分组按 idle 拉取。
  expect(text()).toContain('执行器结束了当前回合')
  await click(zh['ticket.ended'])
  expect(text()).toContain('旧工单')
  expect(text()).toContain(zh['outcome.stopped'])
  // 已结束分组显示旧工单与结局。
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['执行中 2 / 3', '排队 0'])
  // 状态行：执行器占用与队列计数。
  // The pause is its own action: an Execution settings draft started before it still saves.
  // 暂停是独立操作：之前开始的执行设置草稿仍能保存。
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  // 落到设置页的运行时一节。
  await type(field<HTMLInputElement>(zh.maxWorkers), '4')
  await click(tab(zh['tab.execution']))
  await click(zh.pauseProcessing)
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: true } })
  // 暂停走 executor/pause 接口。
  expect(text()).toContain(zh.processingPaused)
  expect(find(zh.resumeProcessing).textContent).toBe(zh.resumeProcessing)
  // 暂停后出现恢复按钮。
  await click(tab(zh['tab.settings']))
  await click(zh.save)
  expect(server.settings).toMatchObject({ paused: true, executor: { maxWorkers: 4 } })
  // 设置草稿保存：暂停状态与 maxWorkers=4 同时落库。
})

it('stops an open Ticket from its page after confirmation', async () => {
  // 工单页停止工单需要确认；未确认不发请求。
  await mount()
  await click('修复回归')
  await click(zh.stop)
  expect(server.requests.some(request => request.path.endsWith('/stop'))).toBe(false)
  // 只点停止不发请求。
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止“修复回归”')
  // 弹出确认框并带上工单名。
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
  // 确认后 POST tickets/t1/stop。
})

it('shows a Ticket with its stage, its Mandate details with the Trigger and Decision behind it, its Threads, and the rest behind disclosures', async () => {
  // 工单详情：阶段在前，授权详情（含背后触发器与决策）与线程直接展示，其余收进 disclosure。
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  // Progress is in the Channels and the Session, so the page has no report section.
  // 进度在渠道与会话里，因此页面没有“汇报”一节。
  expect(all('.dt-section-title').map(title => title.querySelector('.dt-section-name')?.textContent)).toEqual(['授权详情', '未送达的输入', '订阅的线程'])
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh.executingLabel)
  expect(document.querySelector('.dt-status-line .dt-stage .dt-spinner')).not.toBeNull()
  // 执行中阶段带旋转指示。
  // A Thread this Ticket follows reads as subscribed on its page, though no other Ticket follows it.
  // 本工单跟随的线程在其页面显示为“已订阅”，即使没有其他工单跟随。
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).toContain(zh.threadSubscribed)
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).not.toContain(zh.threadUnsubscribed)
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['授权 明确', '发起 飞书 · Alice', expect.stringMatching(/^更新 /)])
  // 状态行：授权强度、发起者与更新时间。
  for (const expected of ['修复登录页回归', '点名方式@ 智能体', '名单里的人明确请求，由主 Session 接单', '未送达：等待派工运行',
    'Alice：顺便改标题']) expect(text()).toContain(expected)
  // 授权详情各字段与触发器预览都出现在页面上。
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('飞书团队群')
  await click(zh['term.channel'])
  expect(all('.dt-disclosure-body a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['飞书消息',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1'], ['GitHub #42', 'https://github.com/acme/widgets/issues/42']])
  // 渠道 disclosure：飞书 applink 与 GitHub 原文链接。
  await click(zh['term.environment'])
  expect(all('.dt-disclosure-body .dt-table tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR/w/t1',
    'DSH_SUPERAGENT_GITHUB_NUMBER—'])
  // 环境 disclosure：worker 的环境变量与取值。
  await click(document.querySelector<HTMLElement>('.dt-trigger-link')!)
  expect(tab(zh['tab.trigger']).getAttribute('aria-selected')).toBe('true')
  // 授权详情里的触发器链接跳到触发器页。
})

it('reports a missing Ticket instead of rendering an empty page', async () => {
  // 工单不存在时报“未找到”，而非渲染空页。
  at({ page: 'execution', id: 'missing' })
  await mount()
  expect(document.querySelector('.dt-hint')?.textContent).toBe(zh.ticketNotFound)
})

it('links a question to its Channel, folds consecutive automated messages among Inputs, and shows field explanations in a hover tooltip',
  async () => {
  // 等人回答的问题链接到渠道；输入里连续自动消息折叠；字段说明用悬停 tooltip。
  const ci = (id: string, at: string, failed: number) => ({ id, kind: 'trigger' as const, triggerId: `c${id}`, at, delivered: true,
    trigger: { id: `c${id}`, actor: { source: 'github', id: '' }, human: false,
      preview: `CI of PR #42 at abc1234: 10 checks, ${failed} failed, 0 running.`, thread: 'github:42' } })
  // 构造自动 CI 通知输入（非人发起）。
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' }, inputs: [ci('i3',
    '2026-09-22T00:06:00Z', 1), ci('i2', '2026-09-22T00:05:00Z', 0)] }
  // 预置：等人回答的问题 + 两条连续自动输入。
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(all('.dt-banner a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  // 问题横幅带“去飞书回答”的渠道链接。
  await click('已送达的输入 · 2')
  expect(all('.dt-disclosure-body .dt-row-title').map(title => title.textContent)).toEqual(['自动通知：CI of PR #42 at abc1234: 10 checks, 1 failed, 0 running.'])
  // 两条自动输入折叠为一行，只显示最新一条。
  await click('同一发送者之前还有 1 条自动消息')
  expect(text()).toContain('CI of PR #42 at abc1234: 10 checks, 0 failed, 0 running.')
  // 展开后能看到更早的那条。
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).not.toContain('到期后记为未完成')
  // 默认不渲染字段说明文本。
  const tip = field(zh.evalTimeout).closest('.dt-field')!.querySelector<HTMLElement>('.dt-info')!
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('到期后记为未完成')
  // 悬停时说明进 tooltip。
  expect(tip.closest('.dt-field')!.textContent).not.toContain('到期后记为未完成')
  // 说明不占据版面。
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  // 移开后 tooltip 消失。
})

it('offers a Ticket awaiting review its review place and Session in the page head', async () => {
  // 待评审工单在页头给出评审去处（GitHub 原文链接）。
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'review', threads: [threadSummary(),
    { ...threadSummary({ key: 'github:42', source: 'github', title: '#42 Fix login' }), url: 'https://github.com/acme/widgets/pull/42' }] }
  // 预置待评审工单，线程带 PR url。
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.review'])
  expect(all('.dt-page-head a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['打开 GitHub 原文',
    'https://github.com/acme/widgets/pull/42']])
  // 页头链接指向评审去处。
})

it('keeps what a person types in the Execution settings, converting it once on save', async () => {
  // 执行设置里输入原样保留，保存时才一次性转换。
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const blocked = () => field<HTMLInputElement>(zh.blockedCommands), root = () => field<HTMLInputElement>(zh.executionDirectory),
    workers = () => field<HTMLInputElement>(zh.maxWorkers)
  // A separator typed before the next command, a space inside a path and a cleared number stay as typed.
  // 下一命令前敲的分隔符、路径中的空格、清空的数字都按输入原样保留。
  await type(blocked(), 'gh-personal ')
  expect(blocked().value).toBe('gh-personal ')
  await type(blocked(), 'gh-personal, gh-other')
  await type(root(), '/srv/my work ')
  expect(root().value).toBe('/srv/my work ')
  await type(workers(), '')
  expect(workers().value).toBe('')
  await type(workers(), '2')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).toMatchObject({ value: { blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work ', maxWorkers: 2 } })
  // 请求体：命令列表拆分、目录保原样、数字转数值。
  expect(server.settings.executor).toMatchObject({ blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work', maxWorkers: 2 })
  // 落库的目录去掉了尾部空格。
})

it('says why an Input was not delivered on its Ticket\'s page, in either language', async () => {
  // 工单页说明输入未投递的原因，中英文都覆盖。
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'delivery', deliveryError: 'feishu: message recalled' }
  // 预置投递失败（消息被撤回）。
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${zh.deliveryFailedPrefix}feishu: message recalled`)
  // 中文：危险横幅带前缀 + 原始错误。
  expect(text()).toContain(zh.inputRetryHint)
  expect(text()).not.toContain(zh.inputWaitingHint)
  // 显示重试提示而非等待提示。
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/9月\d+日/)
  await remount(en)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/Sep \d+/)
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${en.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(en.inputRetryHint)
  // 英文：日期、阶段与横幅同样成立。
})

it('tells a Ticket or Thread that does not exist from a dsh-superagent that is not answering', async () => {
  // 区分“工单/线程不存在”与“dsh-superagent 宿主未响应”。
  at({ page: 'execution', id: 't9' })
  await mount()
  expect(text()).toContain(zh.ticketNotFound)
  // 宿主正常应答时：确实报“未找到”。
  // While dsh-superagent restarts, DSH's web server answers every route with an empty 404.
  // dsh-superagent 重启期间，DSH 的 web 服务对每条路由都回空 404。
  at({ page: 'execution', id: 't1' })
  server.down = true
  await remount()
  expect(text()).not.toContain(zh.ticketNotFound)
  expect(text()).toContain(zh.hostNotRunning)
  // 宿主宕机时改报“宿主未运行”，不误报“未找到”。
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await remount()
  expect(text()).not.toContain(zh.threadNotFound)
  expect(text()).toContain(zh.hostNotRunning)
  // 线程页同理。
})

it('gives a Ticket a bot\'s message started its basis, marks a Thread it follows for context, and an Input it handed back', async () => {
  // 推断授权展示“机器人消息发起”的依据事实；上下文线程打标记；交回的输入带交回说明。
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, mandate: { ...t1.mandate, strength: 'inferred', basis: { via: 'bot', sender: '评审机器人',
    observation: { mode: 'auto' } } },
  basis: { facts: [{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'mode', value: 'auto' }], legacy: false },
  threads: [threadSummary(), { ...threadSummary({ key: 'github:7', title: '#7 相关 Issue' }), context: true }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: true, trigger: { id: 'e2',
    actor: { source: 'feishu', id: MEMBER, name: { zh: 'Alice', en: 'Alice' } }, human: true, preview: '顺便加一个页面',
    thread: 'feishu:oc_1:om_root', handback: { reason: 'Asks for a new page', at: '2026-09-22T00:05:00Z' } } }] }
  // 预置：推断授权（sender/bot/mode 三条事实）、上下文线程、一条被交回的输入。
  at({ page: 'execution', id: 't1' })
  await mount()
  const facts = () => all('.dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(facts()).toEqual(expect.arrayContaining([[zh['basis.sender'], '评审机器人'], [zh['basis.bot'], zh.yes], [zh['basis.mode'], zh['mode.auto']]]))
  // 授权依据以键值对呈现（发送者/机器人/观察模式）。
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, zh.contextOnly])
  // 上下文线程带“仅上下文”标记。
  await click(zh.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('已交回评估：Asks for a new page')
  // 已送达输入披露交回原因（中文）。
  await remount(en)
  expect(facts()).toEqual(expect.arrayContaining([[en['basis.bot'], en.yes]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, en.contextOnly])
  await click(en.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('Handed back for an Eval: Asks for a new page')
  // 英文界面同样成立。
})

it('words an ended Ticket by its outcome, on its row and its page, with a person\'s reason after it', async () => {
  // 已结束工单按结局措辞（列表行与详情页一致），人的理由跟在结局后面。
  const fields = { id: 't3', title: '已合并的工单', state: 'ended' as const, actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const } }
  server.tickets.ended = [ticketSummary(fields, { stage: 'ended' }), ...server.tickets.ended]
  server.ticketDetails.t3 = { ...server.ticketDetails.t1!, ...fields, stage: 'ended' }
  // 预置一张执行器合并收尾的工单。
  await mount()
  await click(zh['tab.execution'])
  await click(zh['ticket.ended'])
  expect(all('.dt-ticket-stage').map(stage => stage.textContent)).toEqual([zh['outcome.merged'], zh['outcome.stopped']])
  // 列表行按结局显示“已合并/已停止”。
  await click('已合并的工单')
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['outcome.merged'])
  expect(text()).toContain(zh['outcome.merged'])
  expect(text()).not.toContain('执行器结束')
  // 详情页同样按结局措辞，不出现“执行器结束”之类的过程描述。
  server.ticketDetails.t3 = { ...server.ticketDetails.t3, ended: { at: '2026-09-21T00:00:00Z', by: 'human', outcome: 'stopped',
    reason: '不需要了' } }
  await remount(en)
  expect(all('.dt-hint').map(hint => hint.textContent).find(line => line?.includes(en['outcome.stopped']))).toMatch(/Stopped by a person: 不需要了$/)
  // 人停止的工单在英文界面把理由跟在结局后面。
})

it('sends one stop for a double click on Confirm', async () => {
  // 确认按钮双击只发一次停止请求。
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh.stop)
  const confirm = find(zh.confirm)
  await act(async () => { confirm.click(); confirm.click() })
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop')).toHaveLength(1)
  // 两次点击只产生一个 stop 请求。
})
