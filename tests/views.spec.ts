/**
 * 本测试文件覆盖只读视图层（src/app/views/* 与 settings-history）：
 * 被丢弃回复归属的线程命名、发送者按 Policy 名单命名（不可读 id 用种类默认名）、
 * 线程按其所做的事分类与“重投评估”动作、来源状态取第一个成立的、
 * 工单阶段随阻塞/被回答变化、跟进消息不因旧版本排队而误显示、总览问题清单
 * （超期评估、运行时错误、来源错误逐一列出）、全部来源关闭的提示、
 * 文本净化（去 HTML/实体标签、图片占位）、设置保存历史按“相对上一次”描述改动、
 * 机器人命名与机器人授权的依据事实、交回触发器的去向与上下文线程、
 * 名单移除后机器人授权的命名、把跟进送评估的时机（工单决定中/已结束/被认领/被停止）、
 * 以及页面内跟进的工单归属只读一次。测试策略：临时目录 + 真实 Store 与来源注册表，
 * 直接调用各视图函数，断言返回对象的精确形状。
 */
import { mkdtempSync, rmSync } from 'node:fs'
// 临时目录。
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
// vitest 断言与用例；vi 监听仓库读取次数。
import { Store } from '../src/app/store.ts'
// Store：视图的数据源。
import { SettingsSchema } from '../src/policy.ts'
// SettingsSchema：最小合法设置。
import { SourceRegistry } from '../src/sources/registry.ts'
// SourceRegistry：来源注册表（快照里解析发送者/规则用）。
import { feishuKind } from '../src/sources/feishu.ts'
// feishuKind：飞书来源（其 policy.unnamed 提供默认命名）。
import { githubKind } from '../src/sources/github.ts'
// githubKind：GitHub 来源。
import { snapshot, threadSummary, ticketSummary, triggerView } from '../src/app/views/records.ts'
// 被测模块：快照与线程/工单/触发器行视图。
import { basisFacts, ticketDetail } from '../src/app/views/tickets.ts'
// 被测模块：授权依据事实与工单详情。
import { threadDetail } from '../src/app/views/threads.ts'
// 被测模块：线程详情。
import { droppedReplies, sourcesStatus } from '../src/app/views/sources.ts'
// 被测模块：被丢弃回复与来源状态列表。
import { overview } from '../src/app/views/overview.ts'
// 被测模块：总览视图（问题清单）。
import { markdown, plain } from '../src/app/views/text.ts'
// 被测模块：多行文本/纯文本净化。
import { policyHistory } from '../src/app/settings-history.ts'
// 被测模块：设置历史视图（改动描述）。
import { KV } from '../src/kv.ts'
// KV：键名注册表（读/删设置版本）。
import { feishuLink } from '../src/sources/feishu-channel.ts'
// feishuLink：飞书频道的页面链接。
import { feishuChannel, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
// feishuChannel：构造飞书频道引用；feishuTriggerId：消息 id 到触发器 id。
import { githubLink } from '../src/sources/github-channel.ts'
// githubLink：GitHub 频道的页面链接。
import { githubChannel } from '../src/sources/github-trigger.ts'
// githubChannel：构造 GitHub 频道引用。
import { followupOwners, type ChannelRef } from '../src/core/index.ts'
// followupOwners：跟进消息可决定的工单；ChannelRef：频道引用类型。

let directory: string
let store: Store
// 每用例的临时目录与 Store。
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-views-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const links = (channel: ChannelRef) => (channel.source === 'feishu' ? feishuLink : githubLink)(channel.address, {})
// 按来源取频道链接助手（交给视图用）。
const drop = (id: string, channel: ChannelRef, ticketId?: string) => {
  // 记一条“频道已消失”的丢弃回复。
  const message = { id, channel, text: id, kind: 'reply' as const, ...ticketId ? { ticketId } : {} }
  store.receipts.add(message)
  store.receipts.settle(message, 'channelGone')
}

it('names the Thread of each dropped message: the one of the Trigger its Channel answers, or the Channel\'s own', () => {
  // 给每条被丢弃消息命名其线程：频道所回应触发器的线程，或频道自己的线程。
  // A Feishu Channel names its chat; the message it answers belongs to the Thread of the topic's root message.
  // 飞书频道命名它所在的群；它回应的消息属于话题根消息的线程。
  store.triggers.save({ id: feishuTriggerId('om_reply'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
    actor: { source: 'feishu', id: 'ou_a' }, human: true, at: new Date().toISOString(), text: 'please', meta: {} })
  store.threads.save({ key: 'github:42', ref: { source: 'github', id: '42' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
    meta: {} })
  drop('a', feishuChannel('oc_1', 'om_reply'))
  drop('b', githubChannel(42))
  // A message whose Trigger and Thread the store no longer has links nowhere.
  // 库里已没有其触发器与线程的消息：无处可链（thread 为 undefined）。
  drop('c', feishuChannel('oc_2', 'om_gone'))
  expect(Object.fromEntries(droppedReplies({ store, links }).map(item => [item.id, item.thread])))
    .toEqual({ a: 'feishu:oc_1:om_root', b: 'github:42', c: undefined })
  // a 经其回应的触发器落到话题根线程；b 用频道自己的线程；c 无处可链。
})

function views() {
  // 构造视图依赖：预置策略（名单 + 规则）与已注册的两来源。
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] },
    github: { allowed: [{ id: 'alice' }] } },
    rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }] } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind); sources.register(githubKind)
  return { store, sources, links }
}
const at = new Date().toISOString()
// 统一的时间戳。
/** A live ticket with no Assignment, as a follow-up's owner needs one. */
// 一个没有派工的活工单：跟进消息的归属需要它。
const live = (id: string) => store.tickets.save({ id, title: id, decisionId: 'd', channels: [], undelivered: [], createdAt: at,
  updatedAt: at,
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  origin: { triggerId: 'e0', triggerIds: ['e0'] }, assignments: [], inputs: [] })
const message = (id: string, actor: { source: string; id: string }, human = true) => ({ id, source: actor.source,
  threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor, human, at, text: `message ${id}`, meta: {} })
// 触发器 fixture：落在同一飞书话题根线程上，可指定发送者与是否为人。

it('names each sender as the Policy lists it, by its id where the id is readable, and as its kind names one it does not list', () => {
  // 发送者命名：名单里的按名单、id 可读的用 id、都不行用来源种类给的默认名。
  const view = snapshot(views())
  expect([view.actor({ source: 'feishu', id: 'OU_ALICE' }), view.actor({ source: 'github', id: 'alice' }), view.actor({ source: 'github',
    id: 'bob' }),
    view.actor({ source: 'feishu', id: 'ou_bob' }), view.actor({ source: 'feishu', id: 'ou_bot' }, false), view.actor({ source: 'feishu',
      id: '' })])
    .toEqual([{ source: 'feishu', id: 'OU_ALICE', name: { zh: 'Alice', en: 'Alice' } }, { source: 'github', id: 'alice',
      name: { zh: 'alice', en: 'alice' } },
      { source: 'github', id: 'bob', name: { zh: 'bob', en: 'bob' } }, { source: 'feishu', id: 'ou_bob',
        name: feishuKind.policy!.unnamed!.person },
      { source: 'feishu', id: 'ou_bot', name: feishuKind.policy!.unnamed!.bot }, { source: 'feishu', id: '' }])
  // 飞书 id 大小写不敏感地匹配名单；GitHub 的 id 直接显示；机器人按 bot 默认名；空 id 无名。
  expect(view.rule('copy')).toEqual({ id: 'copy', name: 'Copy fixes' })
  expect(view.rule('gone')).toEqual({ id: 'gone', name: 'gone' })
  // 规则按名单命名；不在名单的规则以其 id 充当名字。
})

it('classifies a Thread by what it is doing, and offers a filtered Trigger of a person to Eval again', () => {
  // 线程按其正在做的事分类（排队评估等）；被过滤的人触发器可再次送评估，自动的不行。
  const host = views()
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: [],
    correlated: [],
    pending: ['e2'], meta: {} })
  store.triggers.save(message('e1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.save(message('e2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.save(message('e3', { source: 'feishu', id: 'ou_bot' }, false))
  for (const id of ['e1', 'e3']) store.triggers.saveDisposition(id, { filtered: { code: 'not_a_member' }, fanout: [], at })
  // e1/e3 因“不在名单”被过滤；e2 在等待评估。
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('feishu:oc_1:om_root')!).stage).toBe('queued')
  const rows = ['e1', 'e2', 'e3'].map(id => triggerView(view, store.triggers.get(id)!))
  // A queued Trigger waits for Eval already, and an automated one is not offered.
  // 已排队的触发器不必再送评估；自动触发器不提供该动作。
  expect(rows.map(row => row.actions.requeue)).toEqual([true, false, false])
  expect(rows[0]!.actor.name).toEqual({ zh: 'Alice', en: 'Alice' })
  // 被过滤的 Alice 仍按名单命名。
})

it('states each Source by the first state that holds', () => {
  // 来源状态取第一个成立的：off/starting 被健康与问题覆盖。
  const host = views()
  const states = (setup: Parameters<typeof sourcesStatus>[2], health: Parameters<typeof sourcesStatus>[1] = {}) =>
    Object.fromEntries(sourcesStatus(host, health, setup).map(source => [source.id, source.state]))
  expect(states({})).toEqual({ feishu: 'starting', github: 'starting' })
  // 没有任何健康信息时：启动中。
  expect(states({}, { feishu: { state: 'ready', detail: '' }, history: { state: 'paused', detail: '' }, github: { state: 'error',
    detail: 'x' } }))
    .toEqual({ feishu: 'paused', github: 'error' })
  // 暂停/错误覆盖“就绪”。
  const problem = { place: 'deployment', code: 'stateDirUnset', values: {}, detail: '' } as never
  expect(states({ problem }, { feishu: { state: 'ready', detail: '' }, history: { state: 'ready', detail: '' }, github: { state: 'ready',
    detail: '' } }))
    .toEqual({ feishu: 'setup', github: 'setup' })
  // 有初始化问题时一切让位于 setup。
})

it('follows the Ticket\'s stage: a blocked Ticket a person answered since is working, with no retry, note or turn end', () => {
  // 工单阶段跟随最新情况：阻塞的工单被人的输入回答后回到 working，不再有重试/备注/回合结束。
  const host = views()
  const blocked = { state: 'blocked' as const, summary: 'Needs the design file', at: '2026-09-22T00:01:00Z' }
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit' as const, policyVersion: 'v', basis: { via: 'listed' as const }, actor: { source: 'feishu',
      id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [{ id: 'a1', state: 'running' as const, createdAt: at, startedAt: at,
      report: blocked }],
    inputs: [] as { id: string; kind: 'trigger'; triggerId: string; at: string; human?: true }[] }
  store.tickets.save(ticket)
  const row = ticketSummary(store.tickets.get('t1')!)
  expect(row).toMatchObject({ stage: 'person', action: 'blocked', actions: { retry: true }, note: { text: 'Needs the design file',
    error: false } })
  // 阻塞中：等人处理、可重试、摘要作为备注。
  expect(ticketDetail(host, 't1')!.assignments[0]).toMatchObject({ turnEndedAt: blocked.at })
  // 阻塞即回合结束时间。
  store.tickets.save({ ...ticket, inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:02:00Z', human: true }] })
  const answered = ticketSummary(store.tickets.get('t1')!)
  expect(answered).toMatchObject({ stage: 'working', actions: { retry: false } })
  expect(answered).not.toHaveProperty('note')
  expect(ticketDetail(host, 't1')!.assignments[0]).not.toHaveProperty('turnEndedAt')
  // 人的输入之后：回到 working，重试/备注/回合结束都消失。
})

it('does not show a follow-up that reached a ticket as waiting for an Eval, though an older version queued it', () => {
  // 已送达工单的跟进不显示为“等评估”，即使旧版本把它排过队。
  const host = views()
  live('t1')
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, at })
  // f1 直接送达工单；f2 被（旧版本）重新排队。
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: ['f1'], meta: {} })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('feishu:oc_1:om_root')!)).toMatchObject({ stage: 'subscribed', pending: 0 })
  expect(triggerView(view, store.triggers.get('f1')!).disposition.queued).toBe(false)
  // f1 虽在线程 pending 里，但已送达工单：不算排队。
  // One a person sent to Eval again waits for it.
  // 被人再送评估的消息（requeued）才真的在等评估。
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root')!, pending: ['f1', 'f2'] })
  expect(threadSummary(snapshot(host), store.threads.get('feishu:oc_1:om_root')!)).toMatchObject({ stage: 'queued', pending: 1 })
})

const load = { running: 0, queued: 0 }
// 总览的执行器负载。
const problems = (host: ReturnType<typeof views>, health: Parameters<typeof overview>[1] = {}) =>
  overview(host, health, 'v1', load).problems
// 取总览的问题清单。

it('lists an Eval past its deadline, and as dsh-superagent\'s own errors only parts no Source or Policy sync reports', () => {
  // 总览列出超期的评估；运行时错误只列来源与策略同步都不覆盖的部分，来源错误逐个列出。
  const host = views()
  const evaluating = { id: 'e1', threadKey: 'github:1', triggerIds: ['t1'], strength: 'explicit' as const, actor: { source: 'github',
    id: 'alice' },
    basis: { via: 'addressed' as const, addressed: 'mention' as const }, policyVersion: 'v1', startedAt: '2026-01-01T00:00:00Z',
    deadline: '2026-01-01T00:02:00Z' }
  store.threads.save({ key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: at, subscriptions: [], correlated: [], pending: [],
    evaluating, meta: {} })
  const error = (detail: string) => ({ state: 'error' as const, detail })
  const health = { relay: error('relay failing'), reply: error('reply failing'), feishu: error('socket closed'),
    history: error('read failed'),
    'sync:feishu': error('sync failed'), evals: error('unavailable'), launch: { state: 'ready' as const, detail: '' } }
  // 健康表：两个运行时部件故障、来源与其历史故障、飞书策略同步故障、评估不可用。
  const found = problems(host, health)
  expect(found).toContainEqual({ kind: 'eval-overdue', thread: expect.objectContaining({ key: 'github:1', stage: 'evaluating' }) })
  // 超过截止时间的评估入列。
  // Effects are dsh-superagent's own; a Source shows its parts and its Policy sync, and the Evals are listed one by one.
  // 效果属于运行时本身；来源负责展示其部件与策略同步，评估逐个列出。
  expect(found.filter(item => item.kind === 'runtime-error')).toEqual([{ kind: 'runtime-error', name: 'relay', detail: 'relay failing' },
    { kind: 'runtime-error', name: 'reply', detail: 'reply failing' }])
  // feishu 与 sync:feishu 归入来源错误；evals 逐个列出；history 属于来源。
  expect(found.filter(item => item.kind === 'source-error').map(item => item.source.health.name)).toEqual(['feishu', 'history'])
})

it('says no Source runs when every Source is off, and states a Source missing or off', () => {
  // 全部来源关闭时报“无来源在跑”；未安装的来源标 missing、关闭的标 off。
  const host = views()
  expect(problems(host).map(item => item.kind)).not.toContain('no-source')
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { feishu: { enabled: false, config: {} }, github: { enabled: false, config: {} },
    jira: { enabled: true, config: { site: 'acme' } } } })
  expect(problems(host).map(item => item.kind)).toContain('no-source')
  // 开着的来源一个都没有：报 no-source。
  expect(Object.fromEntries(sourcesStatus(host, {}, {}).map(source => [source.id, [source.state, source.installed]])))
    .toEqual({ feishu: ['off', true], github: ['off', true], jira: ['missing', false] })
  // 未注册 kind 的 jira 是 missing（未安装），两个已注册来源是 off。
})

it('sends text without HTML, entity-encoded tags included, and with images named', () => {
  // 文本净化：去 HTML 标签（含实体编码的）、图片以占位出现，链接与代码去修饰。
  const text = '<div>Hello <b>there</b></div> &lt;script&gt;alert(1)&lt;/script&gt; <!-- note --> ![shot](https://x/y.png) [Image: diagram]'
  expect(plain(text)).toBe('Hello there alert(1) [image] [image]')
  expect(markdown(`**Fix** ${text}\n\n- one`)).toBe('**Fix** Hello there alert(1)  [image] [image]\n\n- one')
  // markdown 净化保留安全的 ** 与列表，去掉其余标签与注释。
  expect(plain('[the docs](https://example.com) and `code` &amp; more')).toBe('the docs and code & more')
  // 链接只留文字、反引号去掉、实体解码。
})

it('words each settings save by what it changed from the one before, and nothing after a gap in the history', () => {
  // 每次设置保存按“相对上一次”的改动来描述；历史断档之后无从比较则不给描述。
  const host = views()
  const first = store.settings()
  const allowed = (entries: { id: string; name?: string }[]) => ({ ...first.policy, sources: { ...first.policy.sources,
    feishu: { ...first.policy.sources.feishu!, allowed: entries } } })
  const alice = { id: 'ou_alice', name: 'Alice Liu' }, bob = { id: 'ou_bob', name: 'Bob' }
  store.saveSettings({ ...first, policy: allowed([alice, bob, { id: 'ou_carol' }]), paused: true,
    sources: { ...first.sources, feishu: { enabled: false, config: {} } },
    executor: { ...first.executor, directory: '/srv/work', prepare: 'npm ci', blockedCommands: ['rm', 'curl'] } })
  // 第一次保存：名单三行（一行改名、两行新增）、暂停、关飞书、执行目录/prepare/封锁命令。
  const second = store.settings()
  store.saveSettings({ ...second, policy: allowed([alice, { id: 'ou_carol' }]), paused: false, sources: { ...second.sources,
    feishu: { enabled: true, config: {} } } })
  // 第二次保存：删 Bob 一行、恢复、开飞书。
  const changes = (revision: number) => policyHistory(store, host.sources, 'v').items.find(item => item.revision === revision)!.changes
  const revision = store.get(KV.settings.revision)!
  expect(changes(revision - 1)).toEqual([
    { code: 'sourceRowsAdded', source: 'feishu', part: true, field: 'allowed', items: ['Bob', 'ou_carol'] },
    { code: 'sourceRowsChanged', source: 'feishu', part: true, field: 'allowed', items: ['Alice Liu'] },
    { code: 'paused' }, { code: 'executionDirectory', from: '', to: '/srv/work' }, { code: 'prepareCommand' },
    { code: 'blockedCommands', from: '', to: 'rm curl' }, { code: 'sourceDisabled', source: 'feishu' }])
  // 新增行用名字（可读时）、改名行单独记录；其余字段各自一条改动。
  expect(changes(revision)).toEqual([{ code: 'sourceRowsRemoved', source: 'feishu', part: true, field: 'allowed', items: ['Bob'] },
    { code: 'resumed' }, { code: 'sourceEnabled', source: 'feishu' }])
  // 第二次保存的相对改动。
  // A save whose predecessor is missing from the history has nothing to compare with.
  // 前驱版本在历史里缺失的保存没有比较对象。
  store.delete(KV.settings.version(revision))
  store.saveSettings({ ...store.settings(), paused: true })
  expect(changes(revision + 1)).toBeNull()
})

it('names a listed bot as the Policy lists it, and gives a bot\'s Mandate a basis fact of its own', () => {
  // 名单里的机器人按名单命名；机器人的授权给出自己专属的依据事实（sender/bot/addressed/mode）。
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [], bots: [{ id: 'cli_review', name: '评审机器人' }] } } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  const view = snapshot({ store, sources, links })
  expect(view.actor({ source: 'feishu', id: 'cli_review' }, false).name).toEqual({ zh: '评审机器人', en: '评审机器人' })
  // 机器人名单同样参与命名。
  expect(basisFacts({ via: 'bot', sender: '评审机器人', addressed: 'mention', observation: { mode: 'auto' } }, view.rule).facts)
    .toEqual([{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'addressed', value: 'mention' }, { name: 'mode', value: 'auto' }])
  // 依据事实：发送者、机器人标记、点名方式与观察模式。
})

it('shows a follow-up that reached a ticket as delivered, the tickets that handed a Trigger back with why, and the Threads a ticket follows for context', () => {
  // 已送达工单的跟进显示 delivered；交回触发器的工单附原因；工单跟随的上下文线程打标记。
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, handbacks: [{ ticketId: 't1', reason: 'Asks for a new feature', at }], at })
  // f1 送达 t1；f2 被 t1 交回（要求新功能）。
  const view = snapshot(host)
  expect(triggerView(view, store.triggers.get('f1')!).disposition).toMatchObject({ delivered: true, queued: false, handbacks: [] })
  // A Trigger handed back goes to Eval as any message on its Thread; the Ticket that handed it back is named by its title once it has one.
  // 被交回的触发器像线程上任何消息一样回评估；交回的工单一有标题就用标题命名。
  expect(triggerView(view, store.triggers.get('f2')!).disposition).toMatchObject({ delivered: false,
    handbacks: [{ ticketId: 't1', title: 't1', reason: 'Asks for a new feature' }] })
  store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: at, subscriptions: ['t1'], context: ['t1'],
    correlated: [], pending: [], meta: {} })
  expect(threadDetail(host, 'github:7', undefined, 50)?.context).toEqual(['t1'])
  // 线程详情透出“仅上下文”的工单列表。
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [],
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'f1', at }, { id: 'i2', kind: 'trigger', triggerId: 'f2', at }] })
  const page = ticketDetail(host, 't1')!
  expect(Object.fromEntries(page.threads.map(thread => [thread.key, !!thread.context]))).toEqual({ 'feishu:oc_1:om_root': false,
    'github:7': true })
  // 工单详情：飞书线程是自己的订阅、GitHub 线程是仅上下文。
  expect(page.inputs.map(input => input.kind === 'trigger' && input.trigger?.handback)).toEqual([{ reason: 'Asks for a new feature', at },
    undefined])
  // 输入列表里被交回的那条带 handback。
  expect(triggerView(snapshot(host), store.triggers.get('f2')!).disposition.handbacks[0]?.title).toBe('Fix')
  // 工单有标题后，交回列表用标题。
})

it('names a bot\'s Mandate as a bot once the Policy no longer lists it', () => {
  // 名单不再列出某机器人后，其授权的发起者仍按“机器人”默认名命名。
  const host = views()
  const mandate = { strength: 'inferred' as const, policyVersion: 'v', basis: { via: 'bot' as const,
    observation: { mode: 'auto' as const } },
    actor: { source: 'feishu', id: 'cli_removed' }, scope: '' }
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at, mandate,
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [] })
  expect(ticketDetail(host, 't1')!.mandate.actor).toEqual({ source: 'feishu', id: 'cli_removed', name: feishuKind.policy!.unnamed!.bot })
})

it('offers a person to send a follow-up to Eval while a ticket decides it, or once nothing did', () => {
  // 跟进消息“送评估”动作的时机：工单决定期间可送；工单结束（无人认领）也可送；worker 已认领则不可；停止决定后（消息被放开）又可送；送出后排队不可再送。
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  const row = () => triggerView(snapshot(host), store.triggers.get('f1')!)
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: true } })
  // A ticket that ended after its worker had it leaves it to nobody: a person may still send it to Eval.
  // worker 拿过但工单已结束：消息无人认领，仍可送评估。
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'executor', reason: 'done', outcome: 'completed' } })
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: false } })
  // Not once its worker acknowledged it, which took it up; a stop on it decided only the ticket's work.
  // worker 认领（acked）后消息被其接手：不可再送；对工单的停止只决定工单的工作。
  store.triggers.saveDisposition('f1', { fanout: ['t1'], acked: ['t1'], at })
  expect(row().actions.requeue).toBe(false)
  store.decisions.save({ id: 'stop', evalId: 'e', threadKey: 'feishu:oc_1:om_root', triggerIds: ['f1'], policyVersion: 'v', at, kind: 'stop',
    reason: [{ code: 'humanStop' }], strength: 'explicit', ticketId: 't1' })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // So once the stop ended the ticket, which let go of the message, as the Engine records it.
  // 停止结束工单、放开消息之后（引擎如此记录）：又可送评估。
  store.triggers.saveDisposition('f1', { fanout: [], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // Once sent, it waits for the Eval.
  // 送出之后：它就在等评估，不能再送。
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root')!, pending: ['f1'] })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], requeued: true, at })
  expect(row()).toMatchObject({ actions: { requeue: false }, disposition: { queued: true } })
})

it('reads each ticket a page\'s follow-ups reached once, and nothing for a message no ticket can decide', () => {
  // 一页跟进的工单归属只读一次工单仓库；没有工单能决定的消息一次也不读。
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [], pending: [], meta: {} })
  for (const id of ['f1', 'f2', 'f3']) {
    store.triggers.save(message(id, { source: 'feishu', id: 'ou_alice' }))
    store.triggers.saveDisposition(id, { fanout: ['t1'], at })
  }
  const view = snapshot(host)
  const tickets = vi.spyOn(store.tickets, 'get')
  expect(['f1', 'f2', 'f3'].map(id => triggerView(view, store.triggers.get(id)!).disposition.delivered)).toEqual([true, true, true])
  expect(tickets).toHaveBeenCalledOnce()
  tickets.mockRestore()
  // 三条跟进同属一个工单：仓库 get 只调用一次（结果被复用）。
  // A message the ticket handed back is decided by no ticket, which needs no read.
  // 被工单交回的消息没有决定者：无需任何读取。
  store.triggers.saveDisposition('f3', { fanout: ['t1'], handbacks: [{ ticketId: 't1', reason: 'Another change', at }], at })
  const records = { tickets: { get: vi.fn() }, threads: { get: vi.fn() }, triggers: store.triggers }
  expect(followupOwners(store.triggers.get('f3')!, records)).toEqual([])
  expect([records.tickets.get, records.threads.get].map(read => read.mock.calls.length)).toEqual([0, 0])
})
