/**
 * 本测试文件覆盖全部 Source 实现：飞书（事件消费、话题轮询、历史恢复、策略同步、群标签）、
 * GitHub（评论/review 转触发、PR 绑定与合并收尾、通知轮询与光标、失败重试与丢弃、流式观察
 * issues/comments/CI）、来源上下文（健康上报、线程补丁、配置读取）以及轮询节奏（连续失败计数）。
 * 测试策略：host() 搭真实 Store+Engine+SourceRegistry，spy 掉 Commands 的 CLI 调用返回假应答，
 * 驱动真实 apply/pollRound/pollThreads 等入口，断言 receive 到的触发器与落库状态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// vitest 测试原语与 spy。
import { Engine, MemoryRepositories, key, type Assessor, type Executor, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
// core：Engine 引擎与领域类型；key：类型化触发器 id。
import { backfillChat, consumerRetry, feishuKind, feishuTriggerId, feishuRef, feishuTime, feishuTrigger, historyEvent }
  from '../src/sources/feishu.ts'
// 飞书：历史恢复、事件消费重试、kind、触发器转换与工具函数。
import { KV } from '../src/kv.ts'
// KV：键名注册表。
import { apply as applyFeishu, pollThreads as pollFeishuThreads } from '../src/sources/feishu.ts'
// apply：插件注册入口；pollThreads：订阅线程轮询。
import { runFeishu } from '../src/sources/feishu-loops.ts'
// runFeishu：飞书事件消费循环（真实进程驱动）。
import { commentTrigger, githubAddress, githubChannel, issueTrigger, type GithubComment, type GithubIssue } from '../src/sources/github-trigger.ts'
// GitHub 触发器侧：评论转触发、地址解析、频道引用。
import { claimPull, observePull, pullEndNotices, pullOf, ticketBranch, type Pull } from '../src/sources/github-pull.ts'
// GitHub PR 侧：绑定、观察、结束通知与分支匹配。
import { ciCounts, ciFact, ciSummary } from '../src/sources/github-read.ts'
// GitHub 读取侧：CI 统计与摘要。
import { apply as applyGithub, githubKind, pollFailure, pollRound } from '../src/sources/github.ts'
// GitHub 主入口：插件注册、失败上报与一轮轮询。
import { pollThreads as pollGithubThreads } from '../src/sources/github.ts'
// 订阅 GitHub 线程的轮询。
import { SourceRegistry } from '../src/sources/registry.ts'
// SourceRegistry：来源注册表。
import { cursorAt, POLL_HORIZON_MS } from '../src/sources/poll.ts'
// cursorAt：流光标工具；POLL_HORIZON_MS：轮询时间窗下界。
import { Store } from '../src/app/store.ts'
// Store：SQLite 存储。
import { Commands, commandError } from '../src/infra/commands.ts'
// Commands：CLI 执行器（被 spy）；commandError：构造命令错误。
import { HealthBoard } from '../src/infra/health.ts'
// HealthBoard：健康状态板。
import { testDeployment } from './fixtures/deployment.ts'
// testDeployment：测试部署 fixture。
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
// 设置 schema 与策略合成。
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
// sourceContextOf：按 kind 构造来源上下文。
import { SetupError, type SetupProblem } from '../src/setup.ts'
// SetupError / SetupProblem：初始化问题。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
// 文件系统：事件消费用例的真实 CLI 脚本。
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MEMBER = 'ou_alice'
// 基准成员 id。
function host(overrides: Partial<SourceContextDeps> = {}) {
  // 来源测试的通用宿主：真实 Store + Engine + 注册表 + spy 的 CLI。
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sources-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' }, github: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' }, sources: { feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_observed', listen: 'all' }], directMessages: true } } } })
  // 预置：准入名单、自动评估、飞书监听两个群并允许私聊。
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment()
  sources.register(feishuKind); sources.register(githubKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // Record outbound messages in the store without sending them.
  // 外发消息只记进 store，不真正发送。
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  // The Sources' functions take the context; plugin entries and kind callbacks take the host, which builds each kind's context.
  // 来源函数拿 context；插件入口与 kind 回调拿 host（由它构造各 kind 的上下文）。
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'feishu', health: ['github', 'feishu', 'history'] })
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all
  return { ...value, ...context, health, store, engine, commands: parts.commands, receive, executor }
}
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
// 空注册表对应的健康板（便于断言插件注册后的健康条目）。
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  healthOf.set(sources, board)
  return sources
}
const subscribed = (h: ReturnType<typeof host>, ref: { source: string; id: string }, meta: Record<string, unknown> = {}) =>
  h.store.threads.save({ key: `${ref.source}:${ref.id}`, ref, createdAt: new Date().toISOString(), subscriptions: ['ticket'], correlated: [], pending: [], meta })
// 把一个线程登记为已被工单订阅。
const openTicket = (id: string): Ticket => ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '',
  basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: `source-${id}`, triggerIds: [] } })
// 活跃工单工厂。
const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
// 工单执行信息工厂。
const pulled = (number: number) => ({ follows: [{ thread: `github:${number}`, own: true }] })
// 让工单跟随某个自己的 PR。
const endedPull = (number: number, at: string, merged = true): Pull =>
  ({ ...openPull(number), state: 'closed', merged, ...merged ? { merged_at: at } : { closed_at: at } })
// 已关闭的 PR（默认已合并）。
const agentsPull = (number: number, ref: string): Pull =>
  ({ ...openPull(number), user: { login: 'agent-bot' }, head: { sha: 'abc', ref, repo: { full_name: 'acme/widgets' } } })
// 智能体自己开的 PR。
const openPull = (number: number) => ({ number, title: 'Fix the margin', state: 'open',
  html_url: `https://github.com/acme/widgets/pull/${number}`, user: { login: 'carol' },
  head: { sha: 'abc', ref: 'fix', repo: { full_name: 'acme/widgets' } } })
// 他人打开的 PR。
const notification = (number: number, kind: 'issues' | 'pulls' = 'issues') => ({ id: `n${number}`, updated_at: '2026-09-09T00:00:00Z',
  reason: 'mention',
  repository: { full_name: 'acme/widgets' }, subject: { url: `https://api.github.com/repos/acme/widgets/${kind}/${number}`,
    type: kind === 'pulls' ? 'PullRequest' : 'Issue', title: '' } })
// GitHub 通知样本。
const refused = (status: number, text: string) => commandError({ stderr: `gh: ${text} (HTTP ${status})`, code: 1 })
// 构造 gh 报出的 HTTP 错误。
/** Stubs `gh api` calls against `acme/widgets` and returns the requested paths in order. */
// stub 掉对 acme/widgets 的 gh api 调用，并按顺序返回请求过的路径。
function github(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    reads.push(args[1]!.replace(/^repos\/acme\/widgets\//, ''))
    const path = reads.at(-1)!.split('?')[0]!
    const list = /\/(comments|reviews|statuses)$/.test(path) ? [] : refused(404, 'Not Found')
    // 未声明的路径：列表类回空表，其余 404。
    const route = routes[path] ?? (path.endsWith('/check-runs') ? { check_runs: [] } : list)
    const value: unknown = typeof route === 'function' ? (route as () => unknown)() : route
    // 路由值可以是函数（延迟求值）或 Error。
    if (value instanceof Error) throw value
    if (args.includes('--include')) return `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify(value)}`
    // --include 要求返回原始 HTTP 头（分页/限速测试用）。
    return JSON.stringify(args.includes('--slurp') ? [value] : value)
  })
  return reads
}
const bare = (reads: string[]) => reads.map(path => path.split('?')[0])
// 去掉查询串，便于比较读取路径。
describe('feishu source', () => {
  // 飞书来源。
  it('registers its kind without a bot, and names on its health what setup still needs', async () => {
    // 无飞书部署时也能注册 kind，健康条目指出还缺什么。
    const run = async (overrides: Partial<SourceContextDeps>) => {
      // The fixture's registry already holds the kind; this one starts empty so the plugin's registration shows.
      // host 的注册表已含 kind；这里换成空注册表以观察插件注册过程。
      const value = host({ sources: emptyRegistry(), ...overrides })
      const disposers: (() => unknown)[] = []
      applyFeishu({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.waitFor(() => expect(value.health.history).toBeDefined())
      const registered = value.sources.kind('feishu')
      // Snapshot health before disposal clears the registered entries.
      // 在注销清掉健康条目前快照健康状态。
      const health = { ...value.health }
      for (const dispose of disposers) await dispose()
      return { ...value, registered, health }
    }
    const unset = await run({ deployment: testDeployment({ feishu: undefined }) })
    expect(unset.registered).toBe(feishuKind)
    expect(unset.health).toMatchObject({ feishu: { state: 'paused', code: 'feishuCliUnset' }, history: { state: 'paused', code: 'feishuBotMissing' } })
    // 健康分别报缺 CLI 与缺 bot。
    const problem = new SetupError('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }).problem
    const refused = await run({ deployment: testDeployment({ feishu: undefined }), feishuProblem: problem })
    // A failed bot check waits for the operator's fix and a check; it does not retry by itself like a polling error.
    // bot 检查失败属于等待操作者修复并重新检查，不像轮询错误那样自行重试。
    expect(refused.health.feishu).toEqual({ state: 'paused', detail: problem.detail })
    expect((await run({ configured: () => false })).health.feishu).toEqual({ state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' })
    // 部署检查未过：等待检查。
  })
  it('translates live events into triggers keyed by root message, and drops the bot\'s own messages', () => {
    // 实时事件转触发器：线程键取根消息；bot 自己的消息丢弃。
    const trigger = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1757376000000', mentions: [{ id: 'cli_bot' }], root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1', message_app_link: 'https://applink/x' }, 'ou_bot', 'cli_bot')!
    expect(trigger).toMatchObject({ id: key('feishu', 'om_2'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: MEMBER }, human: true, at: '2025-09-09T00:00:00.000Z', url: 'https://applink/x', channel: { source: 'feishu', address: { chatId: 'oc_1', messageId: 'om_2' } }, meta: { chatId: 'oc_1', direct: false, mentioned: true, rootId: 'om_1', parentId: 'om_1', threadId: 'omt_1', messageId: 'om_2' } })
    // 群消息：线程为 chat:root，meta 保留全部上下文。
    expect(trigger.addressed).toBe('mention')
    expect(feishuTrigger({ message_id: 'om_5', chat_id: 'oc_2', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1' }, 'ou_bot', 'cli_bot')!.addressed).toBe('direct')
    // 私聊算 direct。
    expect(feishuTrigger({ message_id: 'om_6', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1' }, 'ou_bot', 'cli_bot')).not.toHaveProperty('addressed')
    // 未提及的群消息不算被点名。
    expect(feishuRef(trigger)).toEqual({ triggerId: trigger.id, chatId: 'oc_1', messageId: 'om_2', at: trigger.at })
    expect(feishuTrigger({ message_id: 'om_3', chat_id: 'oc_1', chat_type: 'p2p', sender_id: 'ou_bot', sender_type: 'bot', content: 'me', create_time: '1' }, 'ou_bot', 'cli_bot')).toBeUndefined()
    // bot 自己发的消息不转触发器。
    expect(feishuTrigger(historyEvent({ message_id: 'om_4', chat_id: 'oc_1', create_time: '2', sender: { id: 'ou_x', sender_type: 'app' }, body: { content: '{"text":"from app"}' } }, 'oc_1', false), 'ou_bot', 'cli_bot')).toMatchObject({ human: false, text: 'from app', threads: [{ id: 'oc_1:om_4' }] })
    // 历史消息里的应用消息：human=false，线程没有根消息。
  })
  it('polls subscribed threads and stores unseen replies as triggers on that thread', async () => {
    // 轮询已订阅线程：未见过的回复存为该线程的触发器；错误记录到线程 meta。
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot fix', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!, { chatId: 'oc_1', messageId: 'om_root', sourceTriggerId: source.id })
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!, createdAt: '2025-09-01T00:00:00Z',
      lastAt: new Date().toISOString() })
    const reply = { message_id: 'om_reply', chat_id: 'oc_1', msg_type: 'text', content: 'more details', sender: { id: 'ou_guest', sender_type: 'user' }, create_time: '1757376000000', thread_id: 'omt_1', root_id: 'om_root', mentions: [] }
    const mine = { ...reply, message_id: 'om_mine', sender: { id: 'ou_bot', sender_type: 'app', open_bot_id: 'ou_bot' } }
    // bot 自己的回复。
    const earlier = { ...reply, message_id: 'om_old', create_time: '1700000000000' }
    // 早于线程创建时间的旧回复。
    const lark = vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_1', thread_id: 'omt_1' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      return { thread_id: 'omt_1', has_more: false, messages: [mine, reply, earlier] }
    })
    await pollFeishuThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: key('feishu', 'om_reply'), threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
      actor: { id: 'ou_guest' }, human: true, text: 'more details', meta: expect.objectContaining({ threadId: 'omt_1' }) })
    // 只有别人的新回复变成触发器。
    expect(h.store.get('thread-seen:feishu:oc_1:om_root')).toEqual(expect.arrayContaining(['om_reply', 'om_mine', 'om_old']))
    // 全部消息都记入“已见”，避免重复投递。
    expect(h.store.threads.get('feishu:oc_1:om_root')?.meta).toMatchObject({ threadId: 'omt_1', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', facts: { chat: { value: 'oc_1' } } })
    // 线程 meta 补上 threadId、链接与会话名。
    lark.mockRejectedValue(new Error('rate limited'))
    await pollFeishuThreads(h)
    expect(h.store.threads.get('feishu:oc_1:om_root')?.meta.pollError).toContain('rate limited')
    // 读取失败记到线程的 pollError。
    h.store.close()
  })
  it('translates a polled topic reply as the event consumer translates the live event', async () => {
    // 轮询到的话题回复必须与实时事件消费产出完全相同的触发器（两侧一致性）。
    const h = host()
    // A direct-message chat the bot knows from its events.
    // 一个 bot 通过事件认识的私聊会话。
    h.store.set('feishu-chats', { oc_dm: true })
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user',
      content: 'fix it', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_dm:om_root')!, createdAt: '2025-09-01T00:00:00Z',
      lastAt: new Date().toISOString() })
    const page = (message_id: string, sender: Record<string, string>, extra: Record<string, unknown> = {}) => ({ message_id,
      chat_id: 'oc_dm', msg_type: 'text', content: 'and the header', sender,
      create_time: '2026-09-11 12:00', thread_id: 'omt_dm', ...extra })
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_dm', thread_id: 'omt_dm' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      // The page lists the reply without its root, and the bot's own message by its app.
      // 页面里只有回复（无根消息）与 bot 以应用身份发的消息。
      const messages = [page('om_mine', { id: 'cli_bot', sender_type: 'app' }), page('om_reply', { id: MEMBER, sender_type: 'user' })]
      return { thread_id: 'omt_dm', has_more: false, messages }
    })
    await pollFeishuThreads(h)
    const live = feishuTrigger({ message_id: 'om_reply', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user',
      content: 'and the header',
      create_time: String(Date.parse('2026-09-11 12:00')), root_id: 'om_root', thread_id: 'omt_dm' }, 'ou_bot', 'cli_bot')
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([live])
    // 轮询产出与实时事件的触发器逐字段相等。
    expect(live).toMatchObject({ addressed: 'direct', threads: [{ source: 'feishu', id: 'oc_dm:om_root' }] })
    h.store.close()
  })
  it('reads message times given as epoch milliseconds or as local times, and refuses others', () => {
    // 飞书时间两种合法格式：毫秒时间戳与本地时间串；其余拒绝。
    expect(feishuTime('1757376000000')).toBe('2025-09-09T00:00:00.000Z')
    expect(feishuTime('2026-09-11 12:00')).toBe(new Date(2026, 8, 11, 12, 0).toISOString())
    expect(() => feishuTime('soon')).toThrow('Unreadable Feishu message time')
  })
  it('polls a subscribed topic while a live ticket follows it or it had a message in the last two weeks', async () => {
    // 话题轮询条件：有活跃工单跟随，或最近两周有消息。
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: 'fix', create_time: '1' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!,
      lastAt: new Date(Date.now() - 15 * 24 * 3600_000).toISOString() })
    const lark = vi.spyOn(h.commands, 'lark').mockResolvedValue({ items: [] })
    await pollFeishuThreads(h)
    expect(lark).not.toHaveBeenCalled()
    // 15 天无消息且无工单：不轮询。
    h.store.tickets.save(openTicket('ticket'))
    await pollFeishuThreads(h)
    expect(lark).toHaveBeenCalled()
    // 有活跃工单跟随：开始轮询。
    h.store.close()
  })
  it('keeps a quiet topic in history recovery while a subscribed Thread that is polled follows it', async () => {
    // 历史恢复保留被已轮询线程跟随的话题，安静话题被遗忘。
    const h = host()
    const day = 24 * 3600_000
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_team', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: 'fix', create_time: String(Date.now() - 30 * day), thread_id: 'omt_followed' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.tickets.save(openTicket('ticket'))
    const old = new Date(Date.now() - 30 * day).toISOString()
    h.store.set('feishu-history-threads:oc_team', { omt_followed: old, omt_quiet: old })
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'lark').mockResolvedValue({ has_more: false, items: [] })
    const now = new Date().toISOString()
    await backfillChat(h, 'oc_team', false, new Date(Date.now() - 60_000).toISOString(), now, new AbortController().signal)
    expect(h.store.get('feishu-history-threads:oc_team')).toEqual({ omt_followed: old })
    // 只有 omt_followed 被保留。
    h.store.close()
  })
  it('refuses a history page with a message outside its chat or topic, and a page token that does not advance', async () => {
    // 历史页防护：跨会话/跨话题的消息、不前进的分页 token 都要报错。
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const message = (fields: Record<string, unknown>) => ({ message_id: 'om_1', chat_id: 'oc_team', create_time: String(Date.now() - 1000),
      sender: { id: MEMBER, sender_type: 'user' }, body: { content: '{"text":"hi"}' }, ...fields })
    const lark = vi.spyOn(h.commands, 'lark')
    const now = new Date().toISOString()
    const recover = () => backfillChat(h, 'oc_team', false, new Date(Date.now() - 60_000).toISOString(), now, new AbortController().signal)
    lark.mockResolvedValueOnce({ has_more: false, items: [message({ chat_id: 'oc_other' })] })
    await expect(recover()).rejects.toThrow('outside the requested chat or thread')
    // A topic's page that holds a message of another topic.
    // 话题页里混入另一话题的消息。
    h.store.set('feishu-history-threads:oc_team', { omt_1: now })
    lark.mockResolvedValueOnce({ has_more: false, items: [] }).mockResolvedValueOnce({ has_more: false, items: [message({ thread_id: 'omt_2' })] })
    await expect(recover()).rejects.toThrow('outside the requested chat or thread')
    h.store.set('feishu-history-threads:oc_team', {})
    const stuck = { has_more: true, page_token: 'p1', items: [] }
    lark.mockResolvedValueOnce(stuck).mockResolvedValueOnce(stuck)
    await expect(recover()).rejects.toThrow('did not advance')
    // 连续两页 token 相同：报“未前进”。
    lark.mockResolvedValueOnce({ has_more: true, items: [] })
    await expect(recover()).rejects.toThrow('did not advance')
    // has_more 却没有 token 同样报错。
    h.store.close()
  })
  it('stops reading a polled topic at the first message it knew, once the topic\'s first poll ran', async () => {
    // 首轮之后按“遇到已见消息即停”：不再翻旧页。
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: '@bot fix', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!, { chatId: 'oc_1', messageId: 'om_root', sourceTriggerId: source.id })
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!, lastAt: new Date().toISOString() })
    h.store.set('thread-seen:feishu:oc_1:om_root', ['om_2'])
    h.store.set('thread-initialized:feishu:oc_1:om_root', true)
    const reply = (id: string) => ({ message_id: id, chat_id: 'oc_1', msg_type: 'text', content: `reply ${id}`, create_time: String(Date.now()),
      sender: { id: 'ou_guest', sender_type: 'user' }, thread_id: 'omt_1', root_id: 'om_root' })
    const lark = vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_1', thread_id: 'omt_1' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      // Newest first: a new reply, then the one the Thread knew, and an older page that is not read.
      // 按最新在前：新回复、线程已认识的那条，以及不再读取的更早页。
      return { thread_id: 'omt_1', has_more: true, page_token: 'older', messages: [reply('om_3'), reply('om_2')] }
    })
    await pollFeishuThreads(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_3'])
    expect(lark.mock.calls.filter(([args]) => args[1] === '+threads-messages-list')).toHaveLength(1)
    // 只读了一页就停。
    h.store.close()
  })
  it('recovers the topics of a chat while they had a message in the last two weeks, and forgets quieter ones', async () => {
    // 每日历史恢复：两周内有消息的话题保留，更安静的遗忘。
    const h = host()
    const day = 24 * 3600_000
    const start = Date.parse('2026-09-01T00:00:00.000Z')
    h.store.set('feishu-history-threads:oc_team', { omt_old: new Date(start).toISOString() })
    let round = 0
    const scans: string[] = []
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      const params = JSON.parse(args[args.indexOf('--params') + 1]!) as { container_id_type: string; container_id: string }
      scans.push(params.container_id)
      // Each day's chat scan yields one new thread; thread scans return no further messages.
      // 每天的会话扫描产出一个新话题；话题扫描不再有后续消息。
      return { has_more: false, items: params.container_id_type === 'chat' ? [{ message_id: `om_${round}`, chat_id: 'oc_team',
        create_time: String(start + round * day), thread_id: `omt_${round}`,
        sender: { id: 'ou_bob', sender_type: 'user' }, body: { content: '{"text":"hi"}' } }] : [] }
    })
    for (round = 0; round < 30; round++) {
      scans.length = 0
      const since = new Date(start + round * day - 60_000).toISOString()
      await backfillChat(h, 'oc_team', false, since, new Date(start + round * day + 60_000).toISOString(), new AbortController().signal)
      if (round === 0) expect(scans).toContain('omt_old')
      // 第一天还扫了旧话题。
    }
    // The chat, and the topics with a message in the last 14 days.
    // 会话本身 + 最近 14 天有消息的话题。
    expect(scans).toHaveLength(1 + 14)
    expect(Object.keys(h.store.get<Record<string, string>>('feishu-history-threads:oc_team')!)).toHaveLength(14)
    expect(h.store.get<Record<string, string>>('feishu-history-threads:oc_team')!.omt_29).toBe(new Date(start + 29 * day).toISOString())
    h.store.close()
  })
  it('skips and counts a history message it cannot read, and takes in the others', async () => {
    // 读不了的历史消息跳过并计数，其余照收。
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const item = (id: string) => ({ message_id: id, chat_id: 'oc_team', create_time: String(Date.now()), sender: { id: MEMBER,
      sender_type: 'user' },
      body: { content: '{"text":"@bot fix it"}' } })
    vi.spyOn(h.commands, 'lark').mockResolvedValue({ has_more: false, items: [item('om_good'), { message_id: 'om_bad',
      chat_id: 'oc_team' }] })
    // om_bad 缺 create_time 与正文，读不出来。
    const tally = { skipped: 0 }
    const since = new Date(Date.now() - 60_000).toISOString()
    await backfillChat(h, 'oc_team', false, since, new Date().toISOString(), new AbortController().signal, tally)
    expect(tally.skipped).toBe(1)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_good'])
    h.store.close()
  })
  it('waits a second before restarting the event consumer after a run that stayed up for a minute, and backs off otherwise', () => {
    // 事件消费重启策略：跑满一分钟后重试只等 1 秒，否则按上限 60 秒退避。
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(1000, 500)).toBe(2000)
    expect(consumerRetry(32_000, 500)).toBe(60_000)
    expect(consumerRetry(60_000, 120_000)).toBe(1000)
    // 上一次跑满一分钟：重置回 1 秒。
  })
  it('syncs its part of the Policy from the sync chat: people who left are removed, names follow the chat, new people are appended', async () => {
    // 策略同步：以同步群成员名单为准——离开者移除、名字以群为准、新人追加。
    const h = host()
    // The sync reads the chat under its signal, so stopping the sync stops the read.
    // 同步在自己的信号下读群名单：停止同步即停止读取。
    const withSignal = vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const lark = vi.spyOn(h.commands, 'lark').mockResolvedValue({ users: [{ member_id: 'ou_carol', name: 'Carol' }, { member_id: MEMBER, name: 'Alice Li' }], has_more: false })
    const sync = feishuKind.policy!.sync!
    expect(sync.ready({ allowed: [] })).toBe(false)
    // 没配同步群时 readiness 为 false。
    const signal = new AbortController().signal
    expect(await sync.run(h, { allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }], syncChat: 'oc_team' }, signal))
      .toEqual({ allowed: [{ id: MEMBER, name: 'Alice Li' }, { id: 'ou_carol', name: 'Carol' }], syncChat: 'oc_team' })
    // Bob 离群被移除；Alice 名字以群为准；Carol 新增。
    expect(withSignal).toHaveBeenCalledWith(signal)
    expect(lark.mock.calls[0]![0]).toEqual(expect.arrayContaining(['+chat-members-list', '--chat-id', 'oc_team']))
    lark.mockResolvedValue({ users: [], has_more: true })
    await expect(sync.run(h, { allowed: [], syncChat: 'oc_team' }, new AbortController().signal)).rejects.toThrow('incomplete member list')
    // 分页不完整时拒绝同步（防止误删全部名单）。
    h.store.close()
  })
})
describe('github source', () => {
  // GitHub 来源。
  it('normalizes comments and reviews into triggers with review-thread channels, and marks only GitHub Apps and machine accounts as automated', () => {
    // 评论/review 归一为触发器：只有 GitHub App 与机器账号算自动化（human=false）。
    const trigger = commentTrigger({ id: 5, body: 'nit', user: { login: 'review-bot[bot]', type: 'Bot' }, html_url: 'https://github.com/acme/widgets/pull/7#discussion_r5', updated_at: '2026-09-01T00:00:00Z' }, { number: 7, isPr: true, prAuthor: 'agent-bot' }, 'inline', 'agent-bot')
    expect(trigger).toMatchObject({ source: 'github', threads: [{ source: 'github', id: '7' }], human: false, channel: { address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#discussion_r5' } }, meta: { commentId: 5, kind: 'inline', prAuthor: 'agent-bot' } })
    // A review bot on an ordinary account counts as a person here; the prompts name it as automated.
    // 普通账号上的 review bot 在这里算人；由提示词说明它是自动化的。
    expect(commentTrigger({ id: 6, body: 'x', user: { login: 'review-bot', type: 'User' } }, { number: 7, isPr: false }, 'conversation', 'agent-bot').human).toBe(true)
    expect(commentTrigger({ id: 7, body: 'x', user: { login: 'ci[bot]', type: 'Bot' } }, { number: 7, isPr: false }, 'conversation', 'agent-bot').human).toBe(false)
    // A review decision reaches the ticket even without a body; a plain review comment carries only its body.
    // review 决定没有正文也要传达给工单；普通 review 评论只带正文。
    const review = (fields: Partial<GithubComment>) => commentTrigger({ id: 8, user: { login: 'carol', type: 'User' }, submitted_at: '2026-09-01T00:00:00Z', ...fields }, { number: 7, isPr: true }, 'review', 'agent-bot').text
    expect(review({ state: 'APPROVED', commit_id: 'abc123' })).toBe('APPROVED review of commit abc123')
    expect(review({ state: 'CHANGES_REQUESTED', commit_id: 'abc123', body: 'Keep the margin' })).toBe('CHANGES_REQUESTED review of commit abc123\n\nKeep the margin')
    expect(review({ state: 'COMMENTED', commit_id: 'abc123' })).toBe('')
    // COMMENTED 无正文则不产生文本。
    // A mention of the agent addresses it, whatever the case; the agent's own messages are automated.
    // 提及智能体即算点名（大小写不敏感，但邮箱不算）；智能体自己的消息是自动化的。
    expect(commentTrigger({ id: 9, body: '@Agent-Bot please fix', user: { login: 'alice', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot')).toMatchObject({ human: true, addressed: 'mention' })
    expect(commentTrigger({ id: 10, body: 'mail@agent-bot.example', user: { login: 'alice', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot')).not.toHaveProperty('addressed')
    expect(commentTrigger({ id: 11, body: 'pushed', user: { login: 'Agent-Bot', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot').human).toBe(false)
  })
  it('reads the address of an Issue, a PR or a review comment of the repository, and nothing else', () => {
    // githubAddress：只认本仓库的 issue/PR/review 链接（API 或网页两种形式）。
    expect(githubAddress('https://api.github.com/repos/acme/widgets/pulls/9', 'acme/widgets')).toEqual({ number: 9, pr: true })
    expect(githubAddress('https://api.github.com/repos/Acme/Widgets/issues/12', 'acme/widgets')).toEqual({ number: 12, pr: false })
    // 仓库比较大小写不敏感。
    expect(githubAddress('https://github.com/acme/widgets/pull/7/#discussion_r5', 'acme/widgets')).toEqual({ number: 7, pr: true,
      discussion: 5 })
    expect(githubAddress('https://github.com/acme/widgets/issues/7#issuecomment-3', 'acme/widgets')).toEqual({ number: 7, pr: false })
    for (const url of ['https://github.com/acme/gadgets/pull/7', 'https://api.github.com/repos/acme/widgets/commits/abc',
      'https://github.com/acme/widgets/pull/7/files', '']) {
      expect(githubAddress(url, 'acme/widgets')).toBeUndefined()
      // 别的仓库、commit、文件页与空串都不算。
    }
  })
  it('matches a branch to a ticket by its short name as the last path segment', () => {
    // ticketBranch：以最后一段的短名匹配工单分支。
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'agent/fix-title-1a2b3c')).toBe(true)
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'fix-title-1a2b3c')).toBe(true)
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'agent/fix-title-1a2b3c-2')).toBe(false)
    // 多出后缀不算匹配。
    expect(ticketBranch({}, 'agent/x')).toBe(false)
    // 工单没有执行信息时不算。
  })
  it('describes CI as one fact: failed checks first, then unfinished ones, otherwise passed', () => {
    // CI 事实：失败优先，其次进行中，否则通过。
    const counts = ciCounts({ head: 'abc', checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }, { name: 'docs', status: 'completed', conclusion: 'skipped' }], statuses: [{ context: 'deploy', state: 'error' }, { context: 'preview', state: 'pending' }] })
    expect(counts).toEqual({ failed: 2, running: 2 })
    // skipped 不算失败。
    expect(ciFact(counts)).toEqual({ label: { zh: 'CI 失败', en: 'CI failed' }, value: '2', problem: true })
    expect(ciFact({ failed: 0, running: 1 })).toEqual({ label: { zh: 'CI 进行中', en: 'CI running' }, value: '1' })
    expect(ciFact({ failed: 0, running: 0 })).toEqual({ label: 'CI', value: { zh: '通过', en: 'passed' } })
  })
  it('starts a review comment\'s text with its file, line and diff lines, and keeps them and the comment it answers', () => {
    // 行内评论文本以文件/行号/diff 开头，并保留所回复的评论 id。
    const comment: GithubComment = { id: 5, body: 'Use the theme token', user: { login: 'carol', type: 'User' }, path: 'src/render.ts', line: 43,
      diff_hunk: '@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8', in_reply_to_id: 4,
      html_url: 'https://github.com/acme/widgets/pull/9#discussion_r5', created_at: '2026-09-09T00:00:00Z' }
    const trigger = commentTrigger(comment, { number: 9, isPr: true }, 'inline', 'agent-bot')
    expect(trigger.text).toBe('src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\nUse the theme token')
    expect(trigger.meta).toMatchObject({ path: 'src/render.ts', line: 43, inReplyTo: 4, commentId: 5, kind: 'inline' })
  })
  it('gives an assessment of a review comment the earlier comments of its review thread', async () => {
    // 评估一条 review 评论时给出其 review 线程里更早的评论。
    const h = host()
    const comment = (id: number, reply?: number) => ({ id, body: `comment ${id}`, user: { login: 'carol', type: 'User' }, path: 'src/render.ts',
      line: 43, html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`, created_at: `2026-09-09T00:00:0${id}Z`,
      ...reply ? { in_reply_to_id: reply } : {} })
    vi.spyOn(h.commands, 'pages').mockResolvedValue([comment(1), comment(2, 1), comment(3), comment(4, 1)])
    // 四条评论：3、4 各回复 1、2，构成两个线程。
    const trigger = commentTrigger(comment(4, 1), { number: 9, isPr: true }, 'inline', 'agent-bot')
    const context = h.sources.threadContext(trigger)!
    const thread = await context.read(h.commands, 'thread')
    expect(thread).toMatchObject({ status: 'review_thread' })
    expect(thread.messages.map(message => message.id)).toEqual([1, 2, 4].map(id => `https://github.com/acme/widgets/pull/9#discussion_r${id}`))
    // 本线程是 1 → 2 → 4（不含另一线程的 3）。
    expect(context.messageId).toBe(thread.messages[2]!.id)
    expect((await context.read(h.commands, 'parent')).messages.map(message => message.id)).toEqual([thread.messages[0]!.id])
    // parent 只读根评论。
    h.store.close()
  })
  it('starts a CI Trigger\'s text with what failed or still runs, so its preview says it', () => {
    // CI 触发器文本以失败/进行中的检查开头，预览即见结论。
    const check = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion })
    const failing = { head: 'abc1234def', checks: [check('lint', 'completed', 'failure'), check('e2e', 'completed', 'timed_out'),
      check('unit', 'completed', 'success'), check('docs', 'in_progress', null)], statuses: [] }
    const read = 'github/pulls/9/checks'
    expect(ciSummary(failing, 'PR #9',
      read)).toBe('CI failed 2/4 on PR #9 at abc1234: lint, e2e; 1 still running\nRead github/pulls/9/checks for every check.')
    expect(ciSummary({ ...failing, checks: [check('docs', 'queued', null)] }, 'PR #9',
      read)).toMatch(/^CI running 1\/1 on PR #9 at abc1234: docs/)
    expect(ciSummary({ ...failing, checks: [check('unit', 'completed', 'success')] }, 'PR #9',
      read)).toMatch(/^CI passed 1\/1 on PR #9 at abc1234/)
  })
  it('binds a PR to the unique live ticket on its branch and ends tickets when the PR closes', async () => {
    // PR 绑定分支上唯一的活跃工单；PR 合并/关闭时结束工单；恢复后的工单在报告 ready 时才随 PR 收尾。
    const h = host()
    const decisionId = 'd'
    const request = feishuTrigger({ message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot 修一下标题', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(request)
    h.store.tickets.save({ id: 't1', title: 'one', decisionId, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }], assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: execution('one'), origin: { triggerId: request.id, triggerIds: [request.id] } })
    const agentsPull = (number: number): Pull => ({ ...openPull(number), user: { login: 'agent-bot' }, head: { sha: 'abc',
      ref: 'agent/one', repo: { full_name: 'acme/widgets' } } })
    await observePull(h, agentsPull(9))
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(9)
    expect(h.store.threads.get('github:9')?.subscriptions).toEqual(['t1'])
    // A ticket that follows a PR moves to another only by its Executor's report.
    // 工单跟随的 PR 只随 Executor 的报告更换：别处出现的新 PR 不动它。
    await observePull(h, agentsPull(10))
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(9)
    expect(await observePull(h, endedPull(9, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-02T00:00:00.000Z' } })
    expect(h.store.threads.get('github:9')?.subscriptions).toEqual(['t1'])
    // The notice its end gives follows the language of the source request.
    // 结束通知的语言跟随来源请求（中文请求出中文通知）。
    const notices = pullEndNotices(h.store.tickets.get('t1')!, request.text, 'acme/widgets')
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', channel: expect.objectContaining({ source: 'feishu' }), text: expect.stringContaining('已合并') })])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    // Resumed after the merge, the ticket works on: a later look at the merged PR reports nothing again.
    // 合并后恢复的工单继续工作：再看已合并的 PR 不再结束它。
    h.store.tickets.save({ ...h.store.tickets.get('t1')!, ended: undefined, assignments: [...h.store.tickets.get('t1')!.assignments, { id: 'a2', state: 'pending', createdAt: '2026-09-03T00:00:00Z' }] })
    expect(await observePull(h, endedPull(9, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    // Once the resumed work reports ready, the ticket ends with the merged PR, at that time and without a second notice.
    // 恢复的工作报告 ready 后，工单才随已合并 PR 结束，时间取当时，且不再发第二条通知。
    h.engine.report('t1', { state: 'ready', summary: 'answered' })
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    expect(Date.parse(h.store.tickets.get('t1')!.ended!.at)).toBeGreaterThan(Date.parse('2026-09-03T00:00:00Z'))
    // Its notice has the id of the first one, so it goes out once.
    // 第二次的通知沿用第一条的 id：确保只发出一次。
    expect(pullEndNotices(h.store.tickets.get('t1')!, request.text, 'acme/widgets').map(notice => notice.id)).toEqual(notices.map(notice => notice.id))
    h.store.close()
  })
  it('keeps a ticket working on its other open PR when one of its PRs merges', async () => {
    // 工单的多个 PR：一个合并时继续跟另一个，全部合并才结束。
    const h = host()
    h.store.tickets.save({ id: 't3', title: 'three', decisionId: 'd3', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [], execution: execution('fix-3'), origin: { triggerId: 'x', triggerIds: [] }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
    expect(claimPull(h, 't3', agentsPull(21, 'agent/fix-3'))).toBeUndefined()
    expect(claimPull(h, 't3', agentsPull(22, 'agent/fix-3'))).toBeUndefined()
    expect(await observePull(h, endedPull(22, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t3')).toMatchObject({ follows: [{ thread: 'github:21', own: true },
      { thread: 'github:22', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'merged' } }] })
    expect(h.store.tickets.get('t3')).not.toHaveProperty('ended')
    expect(pullOf(h.store.tickets.get('t3')!)).toBe(21)
    expect(h.executor.stop).not.toHaveBeenCalled()
    // 另一个 PR 还开着：不结束工单。
    expect(await observePull(h, endedPull(21, '2026-09-03T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t3')).toMatchObject({ ended: { outcome: 'merged', at: '2026-09-03T00:00:00.000Z' } })
    // A PR's end is kept on the tickets that follow it, so binding and closing write no key-value record.
    // PR 的结束结果存在跟随它的工单上：不再写 KV 记录。
    expect(h.store.keys('github-')).toEqual([])
    h.store.close()
  })
  it('follows a PR it opened again when it reopens, while another PR it opened is open', async () => {
    // 之前合并/关闭的 PR 重新打开：工单重新跟随它。
    const h = host()
    h.store.tickets.save({ ...openTicket('t5'), execution: execution('fix-5'),
      follows: [{ thread: 'github:21', own: true }, { thread: 'github:22', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'closed' } }] })
    await observePull(h, agentsPull(22, 'agent/fix-5'))
    expect(h.store.tickets.get('t5')!.follows).toEqual([{ thread: 'github:21', own: true }, { thread: 'github:22', own: true }])
    // 22 的 closed 记录被清除（重新打开）。
    h.store.close()
  })
  it('ends a ticket when its own PR merges, though the PR it started from is still open', async () => {
    // 自己的 PR 合并即结束工单，哪怕来源 PR 还开着。
    const h = host()
    h.store.tickets.save({ id: 't4', title: 'four', decisionId: 'd4', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' }, channels: [githubChannel(30, 'https://github.com/acme/widgets/pull/30#issuecomment-1')], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [], execution: execution('fix-4'), origin: { triggerId: 'x', triggerIds: [] }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
    h.store.threads.save({ key: 'github:30', ref: { source: 'github', id: '30' }, createdAt: '', subscriptions: ['t4'], correlated: [], pending: [], meta: { number: 30, isPr: true } })
    expect(claimPull(h, 't4', agentsPull(31, 'agent/fix-4'))).toBeUndefined()
    expect(await observePull(h, endedPull(31, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t4')).toMatchObject({ ended: { outcome: 'merged' } })
    h.store.close()
  })
  it('writes the terminal notice in English for a request without Han characters', async () => {
    // 结束通知的语言跟随请求：无汉字的请求出英文通知。
    const h = host()
    const request = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot fix the title', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(request)
    h.store.tickets.save({ id: 't2', title: 'two', decisionId: 'd2', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_2' } }], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', ...pulled(12), origin: { triggerId: request.id, triggerIds: [request.id] } })
    expect(await observePull(h, endedPull(12, '2026-09-02T00:00:00Z', false))).toBe(true)
    expect(pullEndNotices(h.store.tickets.get('t2')!, request.text, 'acme/widgets'))
      .toEqual([expect.objectContaining({ text: '[PR #12](https://github.com/acme/widgets/pull/12) was closed without merging.' })])
    h.store.close()
  })
  it('polls subscribed PR threads since their checkpoint and skips the bot\'s own comments', async () => {
    // 订阅的 PR 线程按检查点增量轮询，跳过 bot 自己的评论；首次顺带补全线程标题。
    const h = host()
    const thread: Thread = { key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: true } }
    h.store.threads.save(thread)
    const comment = (id: number, login: string, at: string, body: string) => ({ id, body, user: { login }, created_at: at, updated_at: at })
    github(h, { 'issues/7': { ...issue(7, { title: 'Fix the margin' }), pull_request: { url: 'x' } }, 'pulls/7': openPull(7),
      'issues/7/comments': [comment(1, 'agent-bot', '2026-09-01T01:00:00Z', 'mine'), comment(2, 'a', '2026-08-01T00:00:00Z', 'old'),
        comment(3, 'b', '2026-09-01T02:00:00Z', 'new')] })
    // bot 自己的评论、游标之前的旧评论、之后的新评论。
    await pollGithubThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ actor: { id: 'b' }, text: 'new', threads: [{ source: 'github', id: '7' }] })
    expect(h.store.get('github-cursor:7')).toBeDefined()
    // A Thread whose title the Source had not read yet is named by its number and title, with its number as a fact.
    // 来源尚未读过标题的线程：补上编号+标题的标签，编号作为事实。
    expect(h.store.threads.get('github:7')!.meta).toMatchObject({ title: 'Fix the margin', label: '#7 Fix the margin', facts: { number: { value: '#7' } } })
    h.store.close()
  })
  it('polls a subscribed Thread for two weeks after the Ticket that follows it ended', async () => {
    // 工单结束后线程仍被轮询两周。
    const h = host()
    const day = 24 * 3600_000
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date(Date.now() - 30 * day).toISOString(), subscriptions: ['t1'], correlated: [], pending: [],
      meta: { number: 7, isPr: false, title: 'Login fails' } })
    const ended = (ago: number) => h.store.tickets.save({ ...openTicket('t1'),
      ended: { at: new Date(Date.now() - ago).toISOString(), by: 'executor', reason: 'merged', outcome: 'merged' } })
    const reads = github(h, {})
    ended(3 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    // 结束 3 天：仍轮询。
    ended(15 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    // 结束 15 天：不再新增读取。
    h.store.close()
  })
  it('polls a subscribed Thread while a live ticket follows it or its last Trigger is under two weeks old', async () => {
    // 轮询条件：活跃工单跟随，或最后一条触发器在两周内。
    const h = host()
    const day = 24 * 3600_000
    const thread = (lastAt: number, subscriptions = ['t']) => h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' },
      createdAt: '2026-09-01T00:00:00Z', lastAt: new Date(Date.now() - lastAt).toISOString(),
      subscriptions, correlated: [], pending: [], meta: { number: 7, isPr: false, title: 'Login fails' } })
    const reads = github(h, {})
    thread(15 * day)
    await pollGithubThreads(h)
    expect(reads).toEqual([])
    // 15 天无消息：不轮询。
    thread(13 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    // 13 天：轮询。
    // A live ticket keeps a quiet Thread polled.
    // 活跃工单让安静线程继续被轮询。
    h.store.tickets.save(openTicket('t9'))
    thread(15 * day, ['t9'])
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments', 'issues/7/comments'])
    h.store.close()
  })
  it('takes in a review decision without a body and skips a plain review comment without one', async () => {
    // review 决定无正文也收；普通评论无正文则跳过。
    const h = host()
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: true,
      title: 'Fix the margin' } })
    github(h, { 'pulls/7': openPull(7), 'pulls/7/reviews': [
      { id: 4, state: 'APPROVED', commit_id: 'abc123', user: { login: 'carol', type: 'User' }, submitted_at: '2026-09-02T00:00:00Z' },
      { id: 5, state: 'COMMENTED', commit_id: 'abc123', body: '', user: { login: 'dave', type: 'User' }, submitted_at: '2026-09-02T00:01:00Z' },
    ] })
    await pollGithubThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ actor: { id: 'carol' }, text: 'APPROVED review of commit abc123', meta: { kind: 'review' } })
    h.store.close()
  })
  it('reads each PR once per round and takes its end, auto-merge and CI from that read', async () => {
    // 一轮里每个 PR 只读一次：结束、自动合并、CI 都取自这一次读取。
    const h = host()
    h.store.tickets.save({ ...openTicket('t9'), ...pulled(9) })
    h.store.threads.save({ key: 'github:9', ref: { source: 'github', id: '9' }, createdAt: '', lastAt: new Date().toISOString(),
      subscriptions: ['t9'], correlated: [], pending: [], meta: { number: 9, isPr: true, title: 'Fix' } })
    const pr = { number: 9, title: 'Fix', state: 'open', auto_merge: { merge_method: 'merge' } as unknown,
      html_url: 'https://github.com/acme/widgets/pull/9', user: { login: 'agent-bot' },
      head: { sha: 'abc', ref: 'agent/nine', repo: { full_name: 'acme/widgets' } } }
    const checks = { check_runs: [{ name: 'test', status: 'in_progress', conclusion: null }] }
    const routes: Record<string, unknown> = { notifications: [notification(9, 'pulls')], 'pulls/9': pr, 'commits/abc/check-runs': checks }
    const reads = github(h, routes)
    await pollRound(h)
    // The notification, the ticket's PR and the subscribed Thread share one read of the PR.
    // 通知、工单的 PR 与订阅线程共享同一次 PR 读取。
    expect(reads.filter(path => path === 'pulls/9')).toHaveLength(1)
    const facts = () => h.store.threads.get('github:9')!.meta.facts as Record<string, unknown>
    expect(facts()).toMatchObject({ autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' } }, ci: { value: '1' } })
    routes['pulls/9'] = { ...pr, auto_merge: null }
    routes['commits/abc/check-runs'] = { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }
    await pollRound(h)
    expect(facts()).not.toHaveProperty('autoMerge')
    // Only a change after the first look is a Trigger.
    // 只有首次查看之后的变更才成为触发器。
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta)).toEqual([expect.objectContaining({ ci: true, revision: 1 })])
    routes['pulls/9'] = { ...pr, state: 'closed', merged: true, merged_at: '2026-09-09T00:00:00Z' }
    await pollRound(h)
    expect(h.store.tickets.get('t9')).toMatchObject({ ended: { outcome: 'merged' } })
    h.store.close()
  })
  it('reads each notified Issue alone and reads a failed one again next round, from where it was', async () => {
    // 逐个读取被通知的 Issue；失败的下轮从原位置重读。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:12', ref: { source: 'github', id: '12' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: {} })
    const mention = (id: number, number: number, at: string): GithubComment => ({ id, body: '@agent-bot take this',
      user: { login: 'alice', type: 'User' }, html_url: `https://github.com/acme/widgets/issues/${number}#issuecomment-${id}`,
      created_at: at, updated_at: at })
    const routes: Record<string, unknown> = { notifications: [notification(12), notification(13)], 'issues/12': refused(502, 'Bad Gateway'),
      'issues/13': issue(13, { created_at: '2026-08-01T00:00:00Z' }),
      'issues/13/comments': [mention(1, 13, '2026-09-08T01:00:00Z')] }
    github(h, routes)
    // A read that failed for another reason than a missing Issue fails the round once every step ran.
    // 非“不存在”的读取失败：等所有步骤跑完后整轮失败。
    await expect(pollRound(h)).rejects.toThrow('#12: Error: gh: Bad Gateway (HTTP 502)')
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13])
    // The cursor moved together with the Issue it does not cover yet.
    // 光标与尚未覆盖的 Issue（#12 的重试位置）一起前进。
    expect(Date.parse(h.store.get<string>('github-since')!)).toBeGreaterThan(Date.parse('2026-09-08T00:00:00.000Z'))
    expect(h.store.get('github-retry')).toEqual({ 12: { since: '2026-09-08T00:00:00.000Z', pr: false, attempts: 1, failedAt: expect.any(String) } })
    expect(h.store.threads.get('github:12')!.meta.pollError).toContain('Bad Gateway')
    Object.assign(routes, { notifications: [], 'issues/12': issue(12, { created_at: '2026-08-01T00:00:00Z' }),
      'issues/12/comments': [mention(2, 12, '2026-09-08T02:00:00Z')] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13, 12])
    // 下轮从重试位置读到 #12 的新评论。
    expect(h.store.get('github-retry')).toEqual({})
    expect(h.store.threads.get('github:12')!.meta).not.toHaveProperty('pollError')
    h.store.close()
  })
  it('drops an Issue GitHub reports as deleted after recording it, and reads one it answers 404 for again', async () => {
    // GitHub 明确说已删除（410）的 Issue 记录后丢弃；404（可能是私有库失访问）则重读。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.tickets.save(openTicket('t14'))
    h.store.threads.save({ key: 'github:14', ref: { source: 'github', id: '14' }, createdAt: '', lastAt: new Date().toISOString(),
      subscriptions: ['t14'], correlated: [], pending: [], meta: { number: 14, isPr: false, title: 'Gone' } })
    const deleted = refused(410, 'This issue was deleted')
    github(h, { notifications: [notification(14), notification(15)], 'issues/14': deleted, 'issues/15': deleted })
    await pollRound(h)
    expect(h.store.get('github-retry')).toEqual({})
    // Dropping a read moves no read position.
    // 丢弃读取不移动读取位置。
    expect(h.store.get('github-cursor:14')).toBeUndefined()
    expect(h.store.threads.get('github:14')!.meta.pollError).toContain('deleted')
    // Without a Thread to keep it, the Source's health names it.
    // 没有线程承载时，来源健康点名被删的编号。
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '2 notifications; next poll ≥ 60s; deleted on GitHub: #14, #15' })
    // GitHub also answers 404 for a private repository the agent lost access to: that is a failure read again.
    // 私库失访问也回 404：当作失败重读。
    github(h, { notifications: [notification(16)] })
    await expect(pollRound(h)).rejects.toThrow('#16: Error: gh: Not Found (HTTP 404)')
    expect(h.store.get('github-retry')).toEqual({ 16: expect.objectContaining({ pr: false }) })
    h.store.close()
  })
  it('skips and counts a notification or comment it cannot read, and names the count in the health', async () => {
    // 读不出的通知/评论跳过计数，健康里报出数量。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    const comment = { id: 3, body: '@agent-bot please fix', user: { login: 'alice', type: 'User' },
      html_url: 'https://github.com/acme/widgets/issues/12#issuecomment-3', created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z' }
    github(h, { notifications: [notification(12), { id: 'n-odd', subject: {} }], 'issues/12': issue(12,
      { created_at: '2026-08-01T00:00:00Z' }),
      'issues/12/comments': [comment, { body: 'no id' }] })
    // n-odd 缺 subject，无 id 的评论读不出。
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(['@agent-bot please fix'])
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '1 notifications; next poll ≥ 60s; 2 unreadable items skipped' })
    h.store.close()
  })
  it('reads every page of the notifications when GitHub says there are more, and waits as long as GitHub asks', async () => {
    // 通知分页读全；轮询间隔遵循 GitHub 的 X-Poll-Interval。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    const calls: string[][] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications' && args.includes('--include')) {
        return 'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/notifications?page=2>; rel="next"\r\nX-Poll-Interval: 120\r\n\r\n[]'
      }
      if (path === 'notifications') return JSON.stringify([[notification(12)], [notification(13)]])
      if (/^issues\/\d+$/.test(path)) return JSON.stringify(issue(Number(path.split('/')[1]), { created_at: '2026-08-01T00:00:00Z' }))
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    expect(await pollRound(h)).toBe(120)
    // 返回值即下一轮的等待秒数。
    const notifications = calls.filter(args => args[1]!.includes('/notifications'))
    expect(notifications.map(args => args.includes('--paginate'))).toEqual([false, true])
    // 第一页普通读，发现 next 链接后带 --paginate 读全。
    const paths = calls.map(args => args[1]!.split('?')[0])
    expect(paths).toEqual(expect.arrayContaining(['repos/acme/widgets/issues/12', 'repos/acme/widgets/issues/13']))
    // 两页里的通知都处理了。
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '2 notifications; next poll ≥ 120s' })
    h.store.close()
  })
  it('drops a notified Issue whose reads fail for a day, so the Source leaves the error, and keeps its read position', async () => {
    // 读取持续失败一天的 Issue 被丢弃：来源离开错误态，但保留读取位置。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:16', ref: { source: 'github', id: '16' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
      meta: {} })
    h.store.set('github-cursor:16', '2026-09-01T00:00:00.000Z')
    github(h, { notifications: [notification(16)] })
    await expect(pollRound(h)).rejects.toThrow('#16: Error: gh: Not Found (HTTP 404)')
    const first = h.store.get<Record<string, { failedAt: string; attempts: number }>>('github-retry')![16]!
    expect(first).toMatchObject({ attempts: 1, failedAt: expect.any(String) })
    // However many reads failed, a day of failures has not passed: the read is retried, and the round still fails.
    // 无论尝试多少次，只要不到一天就继续重试，整轮仍失败。
    h.store.set('github-retry', { 16: { ...first, attempts: 99 } })
    github(h, { notifications: [] })
    await expect(pollRound(h)).rejects.toThrow('#16')
    // A day after the first failed read, it is dropped: its Thread keeps the error, the health names it, and the round does not
    // fail. Its read position stays, so a later read takes in what the failed reads missed.
    // 首次失败满一天后丢弃：线程保留错误、健康点名、整轮不再失败；读取位置不动，以后再读补上漏掉的。
    h.store.set('github-retry', { 16: { ...first, failedAt: new Date(Date.now() - 25 * 3600_000).toISOString() } })
    await pollRound(h)
    expect(h.store.get('github-retry')).toEqual({})
    expect(h.store.get('github-cursor:16')).toBe('2026-09-01T00:00:00.000Z')
    expect(h.store.threads.get('github:16')?.meta.pollError).toContain('Not Found')
    expect(h.health.github).toMatchObject({ state: 'ready',
      detail: '0 notifications; next poll ≥ 60s; dropped after their reads kept failing: #16' })
    h.store.close()
  })
  it('polls the PRs of open tickets and subscribed Threads although the notifications fail, and then fails the round', async () => {
    // 通知接口失败时：先照常轮询工单 PR 与订阅线程，最后整轮失败且不移动全局光标。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: false,
      title: 'Login fails' } })
    github(h, { notifications: refused(503, 'Service Unavailable'), 'issues/7/comments': [{ id: 3, body: 'still broken',
      user: { login: 'b', type: 'User' }, created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' }] })
    await expect(pollRound(h)).rejects.toThrow('HTTP 503')
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ text: 'still broken' }))
    expect(h.store.get('github-since')).toBe('2026-09-08T00:00:00.000Z')
    h.store.close()
  })
  it('takes in the description of a notified PR someone opened since the cursor, as a new PR\'s stream does', async () => {
    // 光标之后别人新开的 PR：其描述作为触发器收进（与流式观察一致）。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    const pr = { ...openPull(9), body: '@agent-bot please review', created_at: '2026-09-09T00:00:00Z' }
    github(h, { notifications: [notification(9, 'pulls')], 'pulls/9': pr })
    await pollRound(h)
    const opened = h.receive.mock.calls.map(([trigger]) => trigger).filter(trigger => trigger.meta.kind === 'pull')
    const id = issueTrigger({ ...pr, id: 9 } as GithubIssue, 'agent-bot').id
    expect(opened).toEqual([expect.objectContaining({ id, addressed: 'mention', actor: { source: 'github', id: 'carol' },
      meta: expect.objectContaining({ number: 9, isPr: true, prAuthor: 'carol' }) })])
    // The agent's own PR, and one opened before the cursor, bring no description.
    // 智能体自己的 PR 与光标之前打开的 PR 不带描述。
    h.receive.mockClear()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    github(h, { notifications: [notification(9, 'pulls')], 'pulls/9': { ...pr, user: { login: 'agent-bot' } } })
    await pollRound(h)
    h.store.set('github-since', '2026-09-10T00:00:00.000Z')
    github(h, { notifications: [{ ...notification(9, 'pulls'), updated_at: '2026-09-11T00:00:00Z' }], 'pulls/9': pr })
    await pollRound(h)
    expect(h.receive.mock.calls.filter(([trigger]) => trigger.meta.kind === 'pull')).toEqual([])
    h.store.close()
  })
  it('reads a subscribed default-branch CI Thread as no Issue, and keeps no poll error on it', async () => {
    // 默认分支 CI 线程（ci:main）不算 Issue，也不留轮询错误。
    const h = host()
    h.store.tickets.save(openTicket('ticket'))
    subscribed(h, { source: 'github', id: 'ci:main' })
    h.store.threads.save({ ...h.store.threads.get('github:ci:main')!, lastAt: new Date().toISOString() })
    const reads = github(h, {})
    await pollGithubThreads(h)
    expect(reads).toEqual([])
    expect(h.store.threads.get('github:ci:main')!.meta).not.toHaveProperty('pollError')
    h.store.close()
  })
  it('drops an Issue or a ticket\'s PR that GitHub answers 410 for, and keeps a failed PR read on its Thread', async () => {
    // 410（已删）的 Issue/PR 丢弃并在健康点名；非 410 的失败留在所属线程上。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    h.store.tickets.save({ ...openTicket('ticket'), follows: [{ thread: 'github:7', own: true }, { thread: 'github:8', own: true }] })
    subscribed(h, { source: 'github', id: '5' }, { number: 5, isPr: false, title: 'Gone' })
    h.store.threads.save({ ...h.store.threads.get('github:5')!, lastAt: new Date().toISOString() })
    // The PRs' Threads, which nothing subscribes to, so only the ticket's PR reads reach them.
    // 两个 PR 线程无人订阅：只有工单的 PR 读取会触达它们。
    for (const number of [7, 8]) {
      h.store.threads.save({ key: `github:${number}`, ref: { source: 'github', id: String(number) }, createdAt: '', subscriptions: [],
        correlated: [], pending: [], meta: {} })
    }
    github(h, { notifications: [], 'issues/5/comments': refused(410, 'Gone'), 'pulls/7': refused(410, 'Gone') })
    // Every PR read but #8's succeeds or is dropped; #8 fails like a network error.
    // 除 #8 外全部成功或被丢弃；#8 像网络错误一样失败。
    vi.mocked(h.commands.run).mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (path === 'issues/5/comments' || path === 'pulls/7') throw refused(410, 'Gone')
      if (path === 'pulls/8') throw refused(502, 'Bad Gateway')
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    await expect(pollRound(h)).rejects.toThrow(/#8: .*502/)
    expect(h.store.threads.get('github:8')!.meta.pollError).toContain('502')
    expect(h.store.threads.get('github:7')!.meta.pollError).toContain('410')
    // 线程上先记下当时的错误。
    vi.mocked(h.commands.run).mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (path === 'issues/5/comments' || path === 'pulls/7' || path === 'pulls/8') throw refused(410, 'Gone')
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    // With every failure a 410, the round succeeds and names what GitHub deleted.
    // 全部变成 410 后：整轮成功，健康点名 GitHub 已删的编号。
    await pollRound(h)
    expect(h.health.github).toMatchObject({ state: 'ready', detail: expect.stringContaining('deleted on GitHub: #5, #7, #8') })
    h.store.close()
  })
  it('waits for setup, pauses while the Source is off, and counts only consecutive failed polls towards an error', async () => {
    // 轮询健康：等初始化、关闭即暂停；只有连续失败达到阈值才报错。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const start = async (overrides: Partial<SourceContextDeps>,
        github: { enabled: boolean; config: Record<string, unknown> } = { enabled: true, config: {} }) => {
        const board = new HealthBoard()
        const settings = SettingsSchema.parse({ sources: { github } })
        const sources = new SourceRegistry(() => settings, board)
        healthOf.set(sources, board)
        const value = host({ sources, ...overrides })
        const disposers: (() => unknown)[] = []
        applyGithub({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
        return { value, stop: async () => { for (const dispose of disposers) await dispose(); value.store.close() } }
      }
      const pending = await start({ configured: () => false })
      await vi.waitFor(() => expect(pending.value.health.github).toMatchObject({ state: 'paused', code: 'setupPending' }))
      await pending.stop()
      const off = await start({}, { enabled: false, config: {} })
      await vi.waitFor(() => expect(off.value.health.github).toMatchObject({ state: 'paused', code: 'sourceOff' }))
      await off.stop()
      // Rounds fail, succeed, fail, fail: only the last two in a row make the error. A round reads through a Commands of its own.
      // 轮次序列：失败、成功、失败、失败——只有最后连续两次构成错误。每轮用自己的 Commands 读取。
      const outcomes = [false, true, false, false]
      let round = 0
      const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async () => {
        if (!outcomes[round++]) throw refused(502, 'Bad Gateway')
        return 'HTTP/2.0 200 OK\r\n\r\n[]'
      })
      const flaky = await start({}, { enabled: true, config: { failuresBeforeError: 2 } })
      // Each round reads its notifications once, then waits a minute for the next.
      // 每轮读一次通知，然后等一分钟进入下一轮。
      const until = async (count: number) => {
        while (round < count) {
          await vi.waitFor(() => expect(round).toBeGreaterThan(0))
          if (round < count) await vi.advanceTimersByTimeAsync(60_000)
        }
      }
      await until(3)
      expect(flaky.value.health.github).toMatchObject({ state: 'ready' })
      // 一次成功清零连败计数。
      await until(4)
      await vi.waitFor(() => expect(flaky.value.health.github).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } }))
      await flaky.stop()
      run.mockRestore()
    } finally { vi.useRealTimers() }
  })
  it('reports a failure that escapes the polling loop as its health instead of an unhandled rejection', async () => {
    // 轮询循环逃逸的异常（如 ready Promise 失败）记为健康错误，而非未处理 rejection。
    // The fixture's registry already holds the kind; this one starts empty so the plugin can register it.
    // host 的注册表已含 kind；这里用空注册表让插件自己注册。
    const value = host({ sources: emptyRegistry(), ready: Promise.reject(new Error('lock held')) })
    const disposers: (() => unknown)[] = []
    applyGithub({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(value.health.github).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') }))
    for (const dispose of disposers) await dispose()
    value.store.close()
  })
  /** An Issue as GitHub returns it, opened by alice. */
  // GitHub 返回的 Issue 样本（alice 打开）。
  const issue = (number: number, fields: Partial<GithubIssue> = {}): GithubIssue => ({ id: 1000 + number, number, title: 'Login fails',
    body: 'details', state: 'open', created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/acme/widgets/issues/${number}`,
    user: { login: 'alice', type: 'User' }, ...fields })
  /** GitHub as `pollRound` reads it after `since`: one notification per Issue, the Issues, and their conversation comments by number. */
  // 按指定 since 布置 GitHub 的应答：每个 Issue 一条通知、Issue 本体与按编号的会话评论。
  function notify(h: ReturnType<typeof host>, issues: GithubIssue[], comments: Record<number, GithubComment[]> = {},
    since = '2026-09-08T00:00:00.000Z') {
    h.store.set('github-since', since)
    // A notification is as new as the latest change it reports: the Issue or its newest comment.
    // 通知的新旧取其所报的最新变更：Issue 本体或其最新评论。
    const updated = (item: GithubIssue) => [item.updated_at ?? item.created_at,
      ...(comments[item.number] ?? []).map(comment => comment.updated_at ?? '')].sort().at(-1)!
    const notifications = issues.map(item => ({ id: `n${item.number}`, updated_at: updated(item), reason: 'mention',
      repository: { full_name: 'acme/widgets' },
      subject: { url: `https://api.github.com/repos/acme/widgets/issues/${item.number}`, type: 'Issue', title: item.title } }))
    // An Issue that is a PR also answers as the PR.
    // 属于 PR 的 Issue 同时按 PR 路径应答。
    const routes: Record<string, unknown> = { notifications, ...Object.fromEntries(issues.flatMap(item => [[`issues/${item.number}`, item],
      [`pulls/${item.number}`, openPull(item.number)],
      [`issues/${item.number}/comments`, comments[item.number] ?? []]])) }
    return { routes, reads: github(h, routes) }
  }
  it('takes in a new Issue from its notification as a Trigger with its body, addressed to the agent when the body mentions it', async () => {
    // 通知里的新 Issue：带正文成为触发器；正文提及智能体则算点名。
    const h = host()
    // A pull request reported at its Issue address, and an Issue the agent opened itself, add nothing.
    // 以 Issue 地址上报的 PR 与智能体自己开的 Issue 都不收。
    const agents = { user: { login: 'agent-bot', type: 'User' } }
    notify(h, [issue(12, { body: '@agent-bot please fix the login' }), issue(13, { pull_request: { url: 'x' } }), issue(14, agents)])
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledOnce()
    const id = key('github-issue', '12')
    const url = 'https://github.com/acme/widgets/issues/12'
    expect(h.receive.mock.calls[0]![0]).toEqual({ id, source: 'github', threads: [{ source: 'github', id: '12' }],
      actor: { source: 'github', id: 'alice' }, human: true, at: '2026-09-09T00:00:00Z',
      text: 'Login fails\n\n@agent-bot please fix the login', addressed: 'mention', channel: githubChannel(12, url), url,
      meta: { number: 12, isPr: false, kind: 'issue' } })
    // An allowed sender's mention is an explicit request on that poll.
    // 名单内发送者的提及在本次轮询即是显式请求。
    expect(h.engine.candidate(id)?.strength).toBe('explicit')
    expect(h.store.threads.get('github:12')!.meta).toMatchObject({ title: 'Login fails', label: '#12 Login fails' })
    h.store.close()
  })
  it('takes in a comment on an earlier Issue from its notification, without the Issue body', async () => {
    // 通知里旧 Issue 的新评论：只收评论，不带 Issue 正文。
    const h = host()
    const url = 'https://github.com/acme/widgets/issues/12'
    const comment: GithubComment = { id: 5, body: '@agent-bot can you take this?', user: { login: 'alice', type: 'User' },
      html_url: `${url}#issuecomment-5`, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z' }
    const { reads } = notify(h, [issue(12, { created_at: '2026-08-01T00:00:00Z' })], { 12: [comment] })
    await pollRound(h)
    const expected = commentTrigger(comment, { number: 12, isPr: false, url }, 'conversation', 'agent-bot')
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expected])
    // An Issue has only its conversation; the comments are read since the notification cursor.
    // Issue 只读会话评论；评论自通知光标起读。
    const since = encodeURIComponent('2026-09-08T00:00:00.000Z')
    expect(reads.filter(path => path.includes('/comments'))).toEqual([`issues/12/comments?per_page=100&since=${since}`])
    h.store.close()
  })
  it('keeps one body Trigger for an Issue that a later poll reads again', async () => {
    // 下一轮再次读到同一 Issue：正文触发器保持唯一（重复投递被判重）。
    const h = host()
    // Opened just before the poll, the Issue is still after the cursor the next poll reads from.
    // Issue 在轮询前刚打开：下轮的光标仍在它之后，会再读到。
    notify(h, [issue(12, { created_at: new Date(Date.now() - 1000).toISOString() })], {}, new Date(Date.now() - 60_000).toISOString())
    await pollRound(h)
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.store.read.threadTriggers('github:12', 10).map(trigger => trigger.id)).toEqual([key('github-issue', '12')])
    expect(h.store.decisions.byThread('github:12').map(decision => decision.triggerIds)).toEqual([[key('github-issue', '12')]])
    h.store.close()
  })
  it('takes in an Issue without a mention as a Trigger that is not addressed, and a bot\'s Issue as automated', async () => {
    // 无提及的 Issue 照收但不算点名；bot 的 Issue 是自动化的。
    const h = host()
    notify(h, [issue(12, { body: 'Login fails on Safari' }), issue(15, { user: { login: 'dependabot[bot]', type: 'Bot' } })])
    await pollRound(h)
    const taken = (number: number) => h.receive.mock.calls.map(([trigger]) => trigger).find(trigger => trigger.meta.number === number)
    const [plain, bot] = [taken(12), taken(15)]
    expect(plain).toMatchObject({ id: key('github-issue', '12'), human: true })
    expect(plain).not.toHaveProperty('addressed')
    expect(bot).toMatchObject({ id: key('github-issue', '15'), human: false })
    // The Issue's own read position moves past what this round read.
    // Issue 自己的读取位置越过本轮读到的内容。
    expect(Date.parse(h.store.get<string>('github-cursor:12')!)).toBeGreaterThan(Date.parse('2026-09-08T00:00:00.000Z'))
    h.store.close()
  })
  it('keeps an Issue body the unclaimed-Issue Source stored before as the one Trigger of that body', async () => {
    // 旧的“未认领 Issue”来源已存的正文触发器：作为该正文的唯一触发器（判重）。
    const h = host()
    const stored: Trigger = { id: key('github-issue', '12'), source: 'github-issue', threads: [{ source: 'github', id: '12' }],
      actor: { source: 'github', id: 'alice' },
      human: true, at: '2026-09-09T00:00:00Z', text: 'Login fails\n\n@agent-bot please fix the login', meta: { number: 12, isPr: false,
        eligibleAt: '' } }
    h.store.triggers.save(stored)
    notify(h, [issue(12, { body: '@agent-bot please fix the login' })])
    await pollRound(h)
    expect(await h.receive.mock.results[0]!.value).toBe('duplicate')
    expect(h.store.read.threadTriggers('github:12', 10)).toEqual([stored])
    h.store.close()
  })
  it('takes in an Issue body only when the Issue was opened since the cursor, not when an edit or a comment changed it', async () => {
    // 只有光标之后“新开”的 Issue 才收正文；编辑或新评论引起的变化不算。
    const h = host()
    // Whoever edits the body, its author would be the actor, so a mention added by an edit is not read.
    // 无论谁编辑正文，作者都是开 Issue 的人：编辑后追加的提及不读。
    const edited = issue(12, { created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
      body: 'Login fails. @agent-bot can you look?' })
    notify(h, [edited])
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    h.store.close()
  })
  it('reads a PR that a notification names by its Issue address as the PR', async () => {
    // 通知以 Issue 地址指名的 PR：按 PR 读取（含 reviews）。
    const h = host()
    h.store.set('github-since', '2026-09-08T00:00:00.000Z')
    const review = { id: 4, state: 'APPROVED', commit_id: 'abc', user: { login: 'carol', type: 'User' },
      submitted_at: '2026-09-09T00:00:00Z' }
    const reads = github(h, { notifications: [notification(9)], 'issues/9': { ...issue(9), pull_request: { url: 'x' } },
      'pulls/9/reviews': [review],
      'pulls/9': { title: 'Fix', state: 'open', html_url: 'https://github.com/acme/widgets/pull/9', user: { login: 'carol' },
        head: { sha: 'abc', ref: 'fix', repo: null } } })
    await pollRound(h)
    expect(bare(reads)).toEqual(['notifications', 'issues/9', 'pulls/9', 'issues/9/comments', 'pulls/9/comments', 'pulls/9/reviews'])
    // 发现是 PR 后改读 PR 的评论与 reviews。
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({ text: 'APPROVED review of commit abc',
      meta: expect.objectContaining({ isPr: true }) })])
    h.store.close()
  })
  it('moves no read position when the Source is turned off during a read', async () => {
    // 读取过程中来源被关闭：不移动读取位置，也不投递。
    const h = host()
    const comment: GithubComment = { id: 5, body: 'more', user: { login: 'alice', type: 'User' }, created_at: '2026-09-09T00:00:00Z',
      updated_at: '2026-09-09T00:00:00Z' }
    const { routes } = notify(h, [issue(12, { created_at: '2026-08-01T00:00:00Z' })], { 12: [comment] })
    routes['issues/12/comments'] = () => {
      h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, github: { enabled: false, config: {} } } })
      return [comment]
    }
    // 读取评论的瞬间把来源关掉。
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get('github-cursor:12')).toBeUndefined()
    expect(h.store.get('github-since')).toBe('2026-09-08T00:00:00.000Z')
    h.store.close()
  })
  it('lets a ticket follow its source PR or the agent\'s PR from its branch, and refuses others', async () => {
    // PR 绑定资格：来源 PR 或分支上的智能体 PR；他人的分支同名 PR 也拒绝。
    const h = host()
    const source = commentTrigger({ id: 1, body: '@agent-bot fix', user: { login: 'alice' },
      html_url: 'https://github.com/acme/widgets/pull/30#issuecomment-1' }, { number: 30, isPr: true }, 'conversation', 'agent-bot')
    h.store.triggers.save(source)
    h.store.tickets.save({ ...openTicket('t1'), execution: execution('fix-1'), origin: { triggerId: source.id, triggerIds: [source.id] } })
    h.store.tickets.save({ ...openTicket('t2'), execution: execution('other-2'), ...pulled(41) })
    const agents = (number: number, ref: string, repo = 'acme/widgets'): Pull => ({ ...openPull(number), user: { login: 'agent-bot' },
      head: { sha: 'abc', ref, repo: { full_name: repo } } })
    expect(claimPull(h, 't1', agents(40, 'agent/fix-1', 'someone/fork'))).toContain('PR does not belong to this ticket')
    // fork 仓库的 PR 不行。
    expect(claimPull(h, 't1', { ...openPull(31), head: { sha: 'abc', ref: 'agent/fix-1',
      repo: { full_name: 'acme/widgets' } } })).toContain('PR does not belong to this ticket')
    // 他人开的同名分支 PR 不行。
    expect(claimPull(h, 't1', agents(41, 'agent/fix-1'))).toBe('PR already belongs to another active ticket')
    // 已被别的活跃工单占用的 PR 拒绝。
    // A PR that is not open is not bound, and that is no refusal.
    // 未打开的 PR 不绑定，但不算拒绝。
    expect(claimPull(h, 't1', { ...agents(42, 'agent/fix-1'), state: 'closed' })).toBeUndefined()
    expect(pullOf(h.store.tickets.get('t1')!)).toBeUndefined()
    expect(claimPull(h, 't1', openPull(30))).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'github:30', own: false }])
    // 来源 PR 绑定为 own=false。
    expect(claimPull(h, 't1', agents(43, 'agent/fix-1'))).toBeUndefined()
    expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'github:30', own: false }, { thread: 'github:43', own: true }], channels: [] })
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(43)
    // 当前 PR 取自己的（own=true）那条。
    expect(h.store.threads.get('github:43')).toMatchObject({ subscriptions: ['t1'], meta: { isPr: true, prAuthor: 'agent-bot' } })
    // The PR the ticket started from is not one it opened: when its own PR merges, the ticket ends instead of following it.
    // 来源 PR 不是它开的：自己的 PR 合并时工单结束而非跟随。
    expect(await observePull(h, endedPull(43, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    expect(claimPull(h, 't1', openPull(30))).toBe('Ticket ended because its PR was closed')
    h.store.close()
  })
})

describe('source context', () => {
  // 来源上下文（SourceContext）。
  it('gives each kind the setup problem whose place it is', () => {
    // 按 place 把初始化问题分给对应的 kind。
    const feishu: SetupProblem = { place: 'feishu', code: 'feishuNoBot', values: {}, detail: 'No bot' }
    const github: SetupProblem = { place: 'github', code: 'agentCliUnset', values: {}, detail: 'No CLI' }
    const h = host({ feishuProblem: feishu, setupProblem: github })
    expect(h.context(feishuKind).problem).toBe(feishu)
    expect(h.context(githubKind).problem).toBe(github)
    expect(h.context({ kind: 'probe', health: [] }).problem).toBeUndefined()
    h.store.close()
  })
  it('lets a kind report only its own health entries', () => {
    // kind 只能上报自己声明的健康条目。
    const h = host()
    const github = h.context(githubKind)
    github.report('github', { state: 'ready', detail: 'ok' })
    expect(h.health.github).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => github.report('feishu', { state: 'error', detail: 'x' })).toThrow('no health entry feishu')
    h.store.close()
  })
  it('patches a Thread\'s meta as it is now, so a change another writer made meanwhile stays', () => {
    // 线程 meta 按当前值打补丁：并发写者的改动保留。
    const h = host()
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: { title: 'old', pollError: 'boom' } })
    const snapshot = h.store.threads.get('github:7')!
    h.store.threads.save({ ...snapshot, subscriptions: ['t'], meta: { ...snapshot.meta, label: '#7 old' } })
    // 模拟别的写者在快照之后改了 subscriptions 与 label。
    h.threads.patch('github:7', { title: 'new', pollError: undefined })
    expect(h.store.threads.get('github:7')).toMatchObject({ subscriptions: ['t'], meta: { title: 'new', label: '#7 old' } })
    expect(h.store.threads.get('github:7')!.meta).not.toHaveProperty('pollError')
    // undefined 的补丁字段删除该键。
    // A Thread that does not exist is not created.
    // 不存在的线程不会因补丁而创建。
    h.threads.patch('github:8', { title: 'x' })
    expect(h.store.threads.get('github:8')).toBeUndefined()
    h.store.close()
  })
  it('reads the configuration of an instance that is on, removes a record set to undefined, and merges ticket meta', () => {
    // 上下文工具：只读启用实例的配置；undefined 删除状态记录；工单绑定合并式写入。
    const h = host()
    expect(h.config('feishu')).toMatchObject({ directMessages: true })
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, feishu: { enabled: false, config: {} } } })
    expect(h.config('feishu')).toBeUndefined()
    // 关闭的实例读不到配置。
    h.state.set('github-retry', { 1: {} })
    h.state.set('github-retry', undefined)
    expect(h.store.keys('github-retry')).toEqual([])
    h.store.tickets.save({ ...openTicket('t1'), execution: execution('one') })
    h.tickets.bindThread('t1', { source: 'github', id: '4' }, true)
    // The ticket follows the Thread; its other fields stay as they were.
    // 工单跟随该线程；其余字段保持原样（合并写入）。
    expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'github:4', own: true }], execution: execution('one'),
      origin: { triggerId: 'source-t1' } })
    h.store.close()
  })
})
it('reports GitHub as failing only after the configured number of consecutive failed polls', () => {
  // pollFailure：连续失败计数达到配置阈值才报错。
  const eof = new Error('Get "https://api.github.com/x": EOF')
  expect(pollFailure(1, 3, eof)).toBeUndefined()
  expect(pollFailure(2, 3, eof)).toBeUndefined()
  expect(pollFailure(3, 3, eof)).toEqual({ state: 'error', detail: '3 consecutive failed polls; last: Error: Get "https://api.github.com/x": EOF', code: 'pollFailures', values: { count: '3', error: 'Error: Get "https://api.github.com/x": EOF' } })
  expect(githubKind.schema.parse({})).toEqual({ repository: '', cli: '', pollSeconds: 60, failuresBeforeError: 3, observeIssues: false,
    observePulls: false, observeComments: false, observeCi: false })
  // 顺带核对 kind 配置的默认值。
})
describe('feishu event consumer', () => {
  // 飞书事件消费循环（真实子进程）。
  let dir: string
  let controller: AbortController
  let running: Promise<unknown> | undefined
  // The fake CLI is a real process, which starts slower while the whole suite runs.
  // 假 CLI 是真实进程，套件并行时启动更慢，放宽等待时限。
  const until = { timeout: 10_000 }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-consumer-')); controller = new AbortController() })
  afterEach(async () => {
    controller.abort()
    await running
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })
  /**
   * A bot CLI whose `event consume` behaves as `mode` says: `never` gets ready, `warn` warns once ready, `ready` stays up,
   * and `flaky` exits after its first ready. It records each run and the PID of the latest.
   */
  // 一个 event consume 行为可编程的 bot CLI：never 不就绪、warn 就绪后告警、ready 常驻、
  // flaky 首次就绪即退出、events/late 打印事件。记录运行次数与最近一次的 PID。
  function cli(mode: 'never' | 'warn' | 'ready' | 'flaky' | 'events' | 'late'): string {
    const path = join(dir, 'lark-bot')
    writeFileSync(path, `#!/bin/sh
  [ "$1" = event ] || { echo '{"ok":true,"data":{}}'; exit 0; }
  n=$(cat '${dir}/runs' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${dir}/runs'; echo $$ > '${dir}/pid'
  case ${mode} in
    never) exec sleep 60 ;;
    warn) echo '[event] ready' >&2; echo 'WARN the connection was reset' >&2; exec sleep 60 ;;
    ready) echo '[event] ready' >&2; exec sleep 60 ;;
    flaky) echo '[event] ready' >&2; [ "$n" -gt 1 ] && exec sleep 60; exit 1 ;;
    events) echo '[event] ready' >&2; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
    late) echo '[event] ready' >&2; sleep 1; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
  esac
  `, { mode: 0o755 })
    return path
  }
  const runs = () => existsSync(join(dir, 'runs')) ? Number(readFileSync(join(dir, 'runs'), 'utf8')) : 0
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  /** The Feishu Source's context, on a fresh Store whose Feishu Source is on, with `cli` as the bot CLI. */
  // 飞书来源上下文：全新 Store、飞书启用、bot CLI 指向给定脚本。
  function consumerSource(path: string, config: Record<string, unknown> = { chats: [] }) {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: true, config } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(feishuKind)
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const policy = () => settingsPolicy(store.settings(), sources)
    const engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, outbox })
    const deployment = testDeployment({ feishu: { ...testDeployment().feishu!, cli: path } })
    const health = board.all
    const commands = new Commands(() => deployment, {}, controller.signal)
    const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment, ready: Promise.resolve(), configured: () => true,
      receive: (trigger: Trigger) => engine.receive(trigger) }
    const turnOff = () => store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: false, config: { chats: [] } } } }))
    return { ctx: sourceContextOf(deps, feishuKind), health, store, turnOff }
  }

  /** A message event line as `event consume` prints it; a group message mentions the bot. */
  // 一行 event consume 打印的消息事件；群消息提及 bot。
  const event = (id: string, chat: string, type: 'group' | 'p2p') => JSON.stringify({ message_id: id, chat_id: chat, chat_type: type,
    sender_id: 'ou_alice', sender_type: 'user', content: 'fix it', create_time: String(Date.now()),
    ...type === 'group' ? { mentions: [{ id: 'ou_bot', name: 'Bot' }] } : {} })
  it('takes in the event lines it reads, records each chat as direct or not, and reports a malformed line without stopping', async () => {
    // 读入事件行：记录各会话是否私聊；坏行上报错误但不停机。
    writeFileSync(join(dir, 'events'), [event('om_1', 'oc_group', 'group'), event('om_2', 'oc_dm', 'p2p'), 'not json',
      event('om_3', 'oc_group', 'group')].join('\n') + '\n')
    const { ctx, health, store } = consumerSource(cli('events'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(store.triggers.get(feishuTriggerId('om_3'))).toBeDefined(), until)
    // 坏行之后的事件照常处理。
    expect(['om_1', 'om_2'].map(id => store.triggers.get(feishuTriggerId(id))?.meta.direct)).toEqual([false, true])
    expect(store.get(KV.feishu.chats)).toEqual({ oc_group: false, oc_dm: true })
    expect(health.feishu).toMatchObject({ state: 'error', detail: expect.stringContaining('JSON') })
    controller.abort(); await running; store.close()
  }, 20_000)
  it('drops the events it reads once the Source is off', async () => {
    // 来源关闭后读到的事件丢弃。
    writeFileSync(join(dir, 'events'), event('om_9', 'oc_group', 'group') + '\n')
    const { ctx, health, store, turnOff } = consumerSource(cli('late'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready' }), until)
    turnOff()
    // The CLI prints the event a second after it is ready, before the consumer stops for the Source being off.
    // CLI 在就绪一秒后才打印事件——赶在消费者因来源关闭而停止之前。
    await vi.waitFor(() => expect(existsSync(join(dir, 'printed'))).toBe(true), until)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(store.triggers.get(feishuTriggerId('om_9'))).toBeUndefined()
    controller.abort(); await running; store.close()
  }, 20_000)
  it('keeps a chat\'s history cursor when its read fails, and recovers known direct chats only while direct messages are on', async () => {
    // 历史恢复：读失败保光标；已知私聊只在私聊开启时恢复。
    const hour = new Date(Date.now() - 3_600_000).toISOString()
    const recovered = async (directMessages: boolean) => {
      const chat = (chatId: string) => ({ chatId, listen: 'mentions' })
      const { ctx, health, store } = consumerSource(cli('ready'), { chats: [chat('oc_a'), chat('oc_b')], directMessages })
      store.set(KV.feishu.chats, { oc_dm: true, oc_a: false })
      for (const chat of ['oc_a', 'oc_b', 'oc_dm']) store.set(KV.feishu.history(chat), hour)
      const chats: string[] = []
      const lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async args => {
        const params = args[2] === '/open-apis/im/v1/messages' ? JSON.parse(args.at(-1)!) as { container_id: string } : undefined
        if (params) chats.push(params.container_id)
        if (params?.container_id === 'oc_a') throw new Error('rate limited')
        // oc_a 读取失败：其光标必须保持。
        return { has_more: false, items: [] }
      })
      const stop = new AbortController()
      const loops = runFeishu(ctx, AbortSignal.any([stop.signal, controller.signal]))
      await vi.waitFor(() => expect(['ready', 'error']).toContain(health.history?.state), until)
      stop.abort(); await loops; lark.mockRestore()
      const cursors = Object.fromEntries(['oc_a', 'oc_b', 'oc_dm'].map(chat => [chat, store.get(KV.feishu.history(chat))]))
      const result = { chats, cursors, history: health.history }
      store.close(); rmSync(join(dir, 'db.sqlite'), { force: true }); rmSync(join(dir, 'db.sqlite-wal'), { force: true })
      rmSync(join(dir, 'db.sqlite-shm'), { force: true })
      return result
    }
    const on = await recovered(true)
    expect(on.chats).toEqual(['oc_a', 'oc_b', 'oc_dm'])
    // 私聊开启：已知的私聊也恢复。
    expect(on.history).toMatchObject({ state: 'error', detail: expect.stringContaining('oc_a: Error: rate limited') })
    // 历史健康点名失败的会话。
    expect(on.cursors.oc_a).toBe(hour)
    expect(Date.parse(on.cursors.oc_b!)).toBeGreaterThan(Date.parse(hour))
    expect(Date.parse(on.cursors.oc_dm!)).toBeGreaterThan(Date.parse(hour))
    // 成功的会话光标前进，失败的保持。
    const off = await recovered(false)
    expect(off.chats).toEqual(['oc_a', 'oc_b'])
    expect(off.cursors.oc_dm).toBe(hour)
    // 私聊关闭：跳过已知私聊。
  }, 20_000)
  it('reports an error when the consumer is not ready within 45 seconds', async () => {
    // 消费者 45 秒内未就绪：报错并杀掉进程。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { ctx, health, store } = consumerSource(cli('never'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(runs()).toBe(1), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'error',
      detail: expect.stringContaining('did not become ready within 45 seconds') }), until)
    expect(alive(pid)).toBe(false)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('reports a warning the consumer prints as an error', async () => {
    // 消费者打印的 WARN 行按错误上报。
    const { ctx, health, store } = consumerSource(cli('warn'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'error', detail: 'WARN the connection was reset' }), until)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('stops the consumer within five seconds once the Source is off', async () => {
    // 来源关闭后 5 秒内停掉消费者进程。
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { ctx, health, store, turnOff } = consumerSource(cli('ready'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready', detail: 'Listening for bot events' }), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    turnOff()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'paused', code: 'sourceOff' }), until)
    expect(alive(pid)).toBe(false)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('starts the consumer again after it exits, and is ready once the next run listens', async () => {
    // 消费者退出后自动重启：下一轮监听即恢复 ready。
    const { ctx, health, store } = consumerSource(cli('flaky'))
    running = runFeishu(ctx, controller.signal)
    const exited = { state: 'error', detail: expect.stringContaining('exited (1, ready=true)') }
    await vi.waitFor(() => expect(health.feishu).toMatchObject(exited), until)
    // The first restart waits a second.
    // 第一次重启等待 1 秒。
    await vi.waitFor(() => expect(runs()).toBe(2), until)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready' }), until)
    controller.abort(); await running; store.close()
  }, 20_000)
})

describe('observing the GitHub repository', () => {
  // 流式观察仓库（issues/comments/review-comments/CI）。
  /** Hour `hour` of the day before yesterday, well within the polling horizon. */
  // 前天的第 hour 小时（在轮询窗口内）。
  const at = (hour: number) => new Date(Math.floor(Date.now() / 86_400_000 - 2) * 86_400_000 + hour * 3_600_000).toISOString()
  const issue = (number: number, fields: Partial<GithubIssue> = {}): GithubIssue => ({ id: 1000 + number, number, title: `Issue ${number}`,
    body: 'details', state: 'open', created_at: at(0), updated_at: at(0),
    html_url: `https://github.com/acme/widgets/issues/${number}`, user: { login: 'carol', type: 'User' }, ...fields })
  const observe = (h: ReturnType<typeof host>, config: Record<string, boolean>) =>
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, github: { enabled: true, config } } })
  /** GitHub as the repository's lists and its default branch answer; a request with the ETag of an unchanged list answers 304. */
  // GitHub 的仓库列表与默认分支应答；带未变更列表 ETag 的请求回 304。
  function repository(h: ReturnType<typeof host>, answers: { issues?: unknown[]; comments?: unknown[]; reviewComments?: unknown[];
    branch?: { sha: string; checks: unknown[] } }) {
    const calls: string[][] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      const bare = args[1]!.replace(/^repos\/acme\/widgets\/?/, '').split('?')[0]!
      const listed = (list: unknown[] | undefined) => `HTTP/2.0 200 OK\r\nETag: "same"\r\n\r\n${JSON.stringify(list ?? [])}`
      if (bare === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (args.includes('If-None-Match: "same"')) throw commandError({ stderr: 'gh: HTTP 304', code: 1 })
      // ETag 未变：gh 报 304。
      if (bare === 'issues') return listed(answers.issues)
      if (bare === 'issues/comments') return listed(answers.comments)
      if (bare === 'pulls/comments') return listed(answers.reviewComments)
      if (bare === '') return JSON.stringify({ default_branch: 'main' })
      if (bare === 'commits/main') return JSON.stringify({ sha: answers.branch!.sha })
      if (bare.endsWith('/check-runs')) return JSON.stringify([{ check_runs: answers.branch!.checks }])
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    return calls
  }
  it('takes in the new Issues and PRs from when it started observing them, and asks again with the ETag while nothing is newer',
    async () => {
    // 观察 Issues/PRs：从各自开启时刻起收新条目；没有更新时用 ETag 条件请求。
    const h = host()
    observe(h, { observeIssues: true, observePulls: true })
    h.store.set('github-since', at(-24))
    h.store.set('github-stream:issues', { since: at(0), started: { issues: at(0), pulls: at(0) } })
    const calls = repository(h, { issues: [issue(3, { created_at: at(-24), updated_at: at(1) }),
      issue(4, { created_at: at(2), updated_at: at(2) }),
      { ...issue(5, { created_at: at(3), updated_at: at(3) }), pull_request: { url: 'x' } },
      issue(6, { created_at: at(4), updated_at: at(4), user: { login: 'agent-bot', type: 'User' } })] })
    await pollRound(h)
    // #3 was opened before the Source observed Issues, and #6 is the agent's own.
    // #3 在开启观察之前就存在；#6 是智能体自己的。
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.kind, trigger.id]))
      .toEqual([[4, 'issue', issueTrigger(issue(4), 'agent-bot').id], [5, 'pull', issueTrigger(issue(5), 'agent-bot').id]])
    const started = { issues: at(0), pulls: at(0) }
    expect(h.store.get('github-stream:issues')).toEqual({ since: cursorAt(at(4)), started })
    // 光标推进到最新条目前 5 秒。
    const list = () => calls.filter(args => args[1]!.startsWith('repos/acme/widgets/issues?'))
    expect(list()[0]![1]).toContain(`since=${encodeURIComponent(at(0))}`)
    // The next round repeats the request at the newest Issue, whose ETag the round after sends, which GitHub answers 304 for.
    // 下一轮按最新 Issue 重发请求；再下一轮带上该响应的 ETag，GitHub 回 304。
    await pollRound(h)
    expect(h.store.get('github-stream:issues')).toEqual({ since: cursorAt(at(4)), started, etag: '"same"' })
    h.receive.mockClear()
    await pollRound(h)
    expect(list().at(-1)).toEqual(expect.arrayContaining(['-H', 'If-None-Match: "same"']))
    expect(h.receive).not.toHaveBeenCalled()
    // Switched off, the stream forgets where it was, so it starts afresh once switched on again.
    // 关闭观察后流忘记位置：再开启时从头开始。
    observe(h, {})
    await pollRound(h)
    expect(h.store.get('github-stream:issues')).toBeUndefined()
    h.store.close()
  })
  it('takes in the repository\'s conversation and review comments, on the Issue or PR each is on', async () => {
    // 仓库会话与行内评论：各归其所属的 Issue/PR 线程。
    const h = host()
    observe(h, { observeComments: true })
    h.store.set('github-since', at(-24))
    for (const stream of ['comments', 'review-comments']) {
      h.store.set(`github-stream:${stream}`, { since: at(0), started: { comments: at(0) } })
    }
    const comment = (id: number, fields: Record<string, unknown>) => ({ id, body: `comment ${id}`, user: { login: 'carol', type: 'User' },
      created_at: at(1), updated_at: at(1), ...fields })
    repository(h, {
      comments: [comment(1, { issue_url: 'https://api.github.com/repos/acme/widgets/issues/7',
        html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' }),
        comment(2, { issue_url: 'https://api.github.com/repos/acme/widgets/issues/9',
          html_url: 'https://github.com/acme/widgets/pull/9#issuecomment-2',
          user: { login: 'dependabot[bot]', type: 'Bot' } })],
      reviewComments: [comment(3, { pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/9', path: 'src/a.ts', line: 4,
        html_url: 'https://github.com/acme/widgets/pull/9#discussion_r3' })] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.isPr, trigger.meta.kind, trigger.human]))
      .toEqual([[7, false, 'conversation', true], [9, true, 'conversation', false], [9, true, 'inline', true]])
    // 会话评论按 issue_url 归属；行内评论按 pull_request_url 归属。
    h.store.close()
  })
  it('fails the round for a stream whose read fails, keeps its cursor, and still reads the other streams', async () => {
    // 一个流读失败：整轮失败、其光标不动，其它流照读。
    const h = host()
    observe(h, { observeIssues: true, observeComments: true })
    h.store.set('github-since', at(-24))
    const kind = (stream: string) => stream === 'issues' ? 'issues' : 'comments'
    for (const stream of ['issues', 'comments', 'review-comments']) {
      h.store.set(`github-stream:${stream}`, { since: at(0), started: { [kind(stream)]: at(0) } })
    }
    const comment = { id: 1, body: 'looks off', user: { login: 'carol', type: 'User' }, created_at: at(1), updated_at: at(1),
      issue_url: 'https://api.github.com/repos/acme/widgets/issues/7', html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' }
    repository(h, { comments: [comment] })
    const run = h.commands.run as unknown as { getMockImplementation(): (program: string, args: string[]) => Promise<string> }
    const answer = run.getMockImplementation()
    vi.mocked(h.commands.run).mockImplementation(async (program, args) => {
      if (args[1]!.startsWith('repos/acme/widgets/issues?')) throw refused(502, 'Bad Gateway')
      return answer(program, args)
    })
    // 只让 issues 流失败。
    await expect(pollRound(h)).rejects.toThrow(/issues: .*502/)
    expect(h.store.get('github-stream:issues')).toEqual({ since: at(0), started: { issues: at(0) } })
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ text: 'looks off' }))
    expect(h.store.get('github-stream:comments')).toEqual({ since: cursorAt(at(1)), started: { comments: at(0) } })
    // 失败流的 since 不变；成功流的 since 前进。
    h.store.close()
  })
  it('reads a stream whose cursor is older than the polling horizon from the horizon, without the ETag of the older request', async () => {
    // 光标落后于轮询窗口：从窗口（整点）起读，且不带旧请求的 ETag。
    const h = host()
    observe(h, { observeIssues: true })
    h.store.set('github-since', at(-24))
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
    h.store.set('github-stream:issues', { since: old, started: { issues: old }, etag: '"same"' })
    const calls = repository(h, {})
    await pollRound(h)
    const list = calls.find(args => args[1]!.startsWith('repos/acme/widgets/issues?'))!
    expect(list).not.toContain('-H')
    const since = Date.parse(decodeURIComponent(/since=([^&]+)/.exec(list[1]!)![1]!))
    // The horizon, on the hour.
    // 从整点的窗口时刻起读。
    expect(Date.now() - POLL_HORIZON_MS - since).toBeGreaterThanOrEqual(0)
    expect(Date.now() - POLL_HORIZON_MS - since).toBeLessThan(3_600_000)
    h.store.close()
  })
  it('starts the default branch\'s CI afresh when the default branch is renamed, without a Trigger', async () => {
    // 默认分支改名：CI 重新从头观察，不产生触发器。
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since', at(-24))
    h.store.set('github-branch-ci', { branch: 'master', failures: [], revision: 2 })
    const answers = { branch: { sha: 'ddd4444', checks: [{ name: 'lint', status: 'completed', conclusion: 'failure' }] } }
    repository(h, answers)
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get('github-branch-ci')).toEqual({ branch: 'main', failures: ['lint'], revision: 2 })
    // 分支名换成 main，首个查看只记失败清单。
    h.store.close()
  })
  it('takes in new PRs only from when their switch turned on, apart from when new Issues were', async () => {
    // PR 观察只从其开关打开的时刻起收，独立于 Issues 的起点。
    const h = host()
    observe(h, { observeIssues: true, observePulls: true })
    h.store.set('github-since', at(-24))
    // The stream took in Issues from hour 0; PRs were switched on only now.
    // 流从 0 点起收 Issues；PRs 是现在才打开的。
    h.store.set('github-stream:issues', { since: at(0), started: { issues: at(0) } })
    repository(h, { issues: [{ ...issue(5, { created_at: at(2), updated_at: at(2) }), pull_request: { url: 'x' } },
      issue(6, { created_at: at(3), updated_at: at(3) })] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.kind])).toEqual([[6, 'issue']])
    // hour 2 的 PR 早于 PR 起点而不收；hour 3 的 Issue 照收。
    expect(h.store.get<{ started: Record<string, string> }>('github-stream:issues')!.started).toEqual({ issues: at(0), pulls: expect.any(String) })
    // Switched off, a kind forgets its start.
    // 关闭后该 kind 忘记自己的起点。
    observe(h, { observePulls: true })
    await pollRound(h)
    expect(Object.keys(h.store.get<{ started: Record<string, string> }>('github-stream:issues')!.started)).toEqual(['pulls'])
    h.store.close()
  })
  it('keeps a stream\'s cursor five seconds before its newest item, and a stale cursor on the hour, so the ETag is sent again', async () => {
    // 光标保持在最新条目前 5 秒；过旧的 cursor 取整点，使 ETag 重试稳定。
    const h = host()
    observe(h, { observeIssues: true })
    h.store.set('github-since', at(-24))
    h.store.set('github-stream:issues', { since: at(0), started: { issues: at(0) } })
    repository(h, { issues: [issue(6, { created_at: at(3), updated_at: at(3) })] })
    await pollRound(h)
    expect(h.store.get<{ since: string }>('github-stream:issues')!.since).toBe(new Date(Date.parse(at(3)) - 5000).toISOString())
    // A cursor behind the horizon reads from the horizon on the hour, the same in the next round, which sends the ETag.
    // 落后窗口的 cursor 从整点窗口读，下一轮相同起点并带上 ETag。
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
    h.store.set('github-stream:issues', { since: old, started: { issues: old } })
    const calls = repository(h, {})
    await pollRound(h); await pollRound(h)
    const lists = calls.filter(args => args[1]!.startsWith('repos/acme/widgets/issues?'))
    const since = (args: string[]) => decodeURIComponent(/since=([^&]+)/.exec(args[1]!)![1]!)
    expect(since(lists[0]!)).toBe(since(lists[1]!))
    expect(Date.parse(since(lists[0]!)) % 3_600_000).toBe(0)
    expect(lists[1]).toEqual(expect.arrayContaining(['-H', 'If-None-Match: "same"']))
    h.store.close()
  })
  it('gives each change of the default branch\'s CI its own id, also when one commit fails, passes and fails again', async () => {
    // 默认分支 CI 的每次变化有独立 id；同一 commit 反复翻转也各有一条。
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since', at(-24))
    const check = (name: string, conclusion: string) => ({ name, status: 'completed', conclusion })
    const answers = { branch: { sha: 'eee5555', checks: [check('lint', 'success')] } }
    repository(h, answers)
    await pollRound(h)
    for (const conclusion of ['failure', 'success', 'failure']) {
      answers.branch = { sha: 'eee5555', checks: [check('lint', conclusion)] }
      await pollRound(h)
    }
    const ids = h.receive.mock.calls.map(([trigger]) => trigger.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    // Switched off and on again, the CI starts from a new first look, and its ids keep counting.
    // 关闭再开启：CI 重新首个查看，id 继续递增（不重复）。
    observe(h, {})
    await pollRound(h)
    observe(h, { observeCi: true })
    await pollRound(h)
    answers.branch = { sha: 'eee5555', checks: [check('lint', 'success')] }
    await pollRound(h)
    expect(new Set(h.receive.mock.calls.map(([trigger]) => trigger.id)).size).toBe(4)
    h.store.close()
  })
  it('tells of the default branch\'s CI when its failed checks change and once it passes again, after a first look', async () => {
    // 默认分支 CI 通知：首个查看不通知；失败集合变化才报，全部通过才报恢复。
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since', at(-24))
    const check = (name: string, conclusion: string | null) => ({ name, status: conclusion ? 'completed' : 'in_progress', conclusion })
    const answers = { branch: { sha: 'aaa1111', checks: [check('lint', 'success'), check('e2e', 'success')] } }
    repository(h, answers)
    const texts = () => h.receive.mock.calls.map(([trigger]) => trigger.text.split('\n')[0])
    await pollRound(h)
    expect(texts()).toEqual([])
    // 首个查看（基线）不通知。
    answers.branch = { sha: 'bbb2222', checks: [check('lint', 'failure'), check('e2e', null)] }
    await pollRound(h)
    answers.branch = { sha: 'bbb2222', checks: [check('lint', 'failure'), check('e2e', 'success')] }
    await pollRound(h)
    // A rerun that still runs is no recovery yet; the recovery is told once every check passes.
    // 仍有检查在跑不算恢复；全部通过才报恢复。
    answers.branch = { sha: 'ccc3333', checks: [check('lint', null), check('e2e', null)] }
    await pollRound(h)
    answers.branch = { sha: 'ccc3333', checks: [check('lint', 'success'), check('e2e', 'success')] }
    await pollRound(h)
    expect(texts()).toEqual(['CI failed 1/2 on main at bbb2222: lint; 1 still running', 'CI passed 2/2 on main at ccc3333'])
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ human: false, actor: { id: '' }, threads: [{ source: 'github', id: 'ci:main' }],
      meta: { ci: true, branch: 'main', sha: 'bbb2222' }, url: 'https://github.com/acme/widgets/commit/bbb2222' })
    expect(h.receive.mock.calls[0]![0].text).toContain('Read github/commits/bbb2222/checks for every check.')
    h.store.close()
  })
})
