/**
 * Typed fake management API server for panel tests. Implements every route in `src/app/api.ts` and records any
 * undeclared query parameter or body mismatch in `server.misuse`, which `usePanelServer` asserts is empty after each test.
 */
// 面板测试用的类型化假管理 API 服务端：实现 src/app/api.ts 里的每条路由，
// 并把未声明的查询参数或 body 形状不符记入 server.misuse（usePanelServer 在每个用例后断言其为空）。
// 作为 tests/fixtures 供 panel-*.spec.tsx 使用：测试可直接篡改其可变状态（server.settings/prompts/...）再驱动真实 UI。
import { afterEach, beforeEach, expect, vi } from 'vitest'
// vitest：beforeEach/afterEach 装配与清理，vi.stubGlobal 替换 fetch，expect 用于 misuse 断言。
import { z } from 'zod'
// zod：校验保存负载与来源配置。
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// DSH 客户端设置表单接口（fakeForm 模拟它）。
import type { Api, ApiResponse, RouteParams } from '../../src/app/api.ts'
// Api：被模拟的 API 路由表类型（路由键 → 参数/查询/响应）。
import { SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInPart, builtInParts, composePrompt, composeSkill, defaultPrompts,
  environmentSection, policySection, promptParts } from '../../src/app/prompts.ts'
// 提示词模块：内置部件、团队分区、模板拼装函数（预览与 prompts 视图复用真实实现）。
import type { DroppedReply, HistoryView, Problem, PromptsView, SetupView, SourceStatusRow, SourceView, StateView, ThreadPageView,
  ThreadRow, TicketPageView,
  TicketRow, TicketStage,
  TriggerRow } from '../../src/client/api.ts'
// 面板视图类型：各类响应体的形状来源。
import { SETUP_FIELDS } from '../../src/deployment.ts'
// SETUP_FIELDS：会触发 dsh-superagent 重启的设置字段。
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema } from '../../src/policy.ts'
// 设置块 schema：保存时照宿主一样解析校验。
import { SetupError, type SetupCode } from '../../src/setup.ts'
// SetupError：初始化问题的结构化错误。
import { feishuChannel } from '../../src/sources/feishu-trigger.ts'
// feishuChannel：构造飞书频道引用。
import { githubChannel } from '../../src/sources/github-trigger.ts'
// githubChannel：构造 GitHub 频道引用。
import { feishuKind } from '../../src/sources/feishu.ts'
// 飞书 kind（配置 schema、fields、facts、policy）。
import { githubKind } from '../../src/sources/github.ts'
// GitHub kind。
import type { Health } from '../../src/sources/host.ts'
// Health：来源健康条目结构。
import type { SourceKind } from '../../src/sources/kind.ts'
// SourceKind：来源种类接口。
import { testDeployment } from './deployment.ts'
// testDeployment：部署信息 fixture。

export const MEMBER = 'ou_alice'
// 基准成员（名单里已允许）。
const ALLOWED: Record<string, { id: string; name?: string }[]> = { feishu: [{ id: MEMBER, name: 'Alice' }], github: [{ id: 'alice' }] }
// fixture 策略里的准入名单，用于解析角色显示名。
type Actor = TriggerRow['actor']
/** Resolve an actor display label using the fixture policy's allowed list or the source kind's unnamed fallback. */
// 解析角色的显示标签：优先名单里的备注名，其次按 kind 的未命名回退（person/bot）。
export function actor(source: string, id: string, human = true): Actor {
  if (!id) return { source, id }
  const entry = ALLOWED[source]?.find(item => item.id.toLowerCase() === id.toLowerCase())
  const unnamed = source === 'feishu' ? feishuKind.policy?.unnamed : undefined
  const name = entry ? entry.name || entry.id : unnamed ? undefined : id
  return { source, id, name: name ? { zh: name, en: name } : human ? unnamed!.person : unnamed!.bot }
}
type TicketFields = Omit<TicketRow, 'stage' | 'action'>
const TICKET = {
  // 基准工单行：全部字段齐全，测试只覆盖需要的部分。
  id: 't1', title: '修复回归', state: 'open', actions: { retry: false, stop: true }, strength: 'explicit', ended: undefined,
  attention: undefined, assignments: 1, inputs: 2, undelivered: 0, deliveryError: undefined, sessionId: 'worker-t1', directory: '/w/t1',
  summary: 'working on it', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
  threads: [{ key: 'github:42', source: 'github', title: '#42 Fix login', url: 'https://github.com/acme/widgets/pull/42',
    facts: { number: { value: '#42' }, ci: { label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true } } }],
} satisfies TicketFields
export const ticketSummary = (fields: Partial<TicketFields> = {}, stage: TicketStage = { stage: 'working' }): TicketRow =>
  ({ ...TICKET, ...fields, ...stage })
// 工单行工厂：在基准上打补丁并指定阶段。
export const threadSummary = (fields: Partial<ThreadRow> = {}): ThreadRow => ({
  // 线程行工厂：基准线程 feishu:oc_1:om_root。
  key: 'feishu:oc_1:om_root', source: 'feishu', title: '这个文案好奇怪', stage: 'subscribed', latest: undefined, lastAt: '2026-09-23T00:00:00Z',
  createdAt: '2026-09-22T00:00:00Z', subscriptions: 1, tickets: [{ id: 't1', title: '修复回归', state: 'open' }], evaluating: undefined,
  pending: 0, pollError: undefined, url: undefined, facts: { chat: { value: '团队群' } }, ...fields,
})
type TriggerFields = Partial<Omit<TriggerRow, 'disposition' | 'actions'>> & { disposition?: Partial<TriggerRow['disposition']> }
/** Build a trigger row on the default thread and compute `actions.requeue` using the host's eligibility rules. */
// 在默认线程上构造触发行，并按宿主同样的资格规则计算 actions.requeue。
export function trigger(id: string, at: string, { disposition, ...fields }: TriggerFields = {}): TriggerRow {
  const row = { id, source: 'feishu', actor: actor('feishu', MEMBER), human: true, at, text: `message ${id}`, preview: `message ${id}`,
    url: undefined, threads: ['feishu:oc_1:om_root'], ...fields,
    disposition: { queued: false, evaluating: false, delivered: false, filtered: undefined, fanout: [], handbacks: [], decision: undefined,
      ...disposition } }
  return { ...row, actions: { requeue: requeueable(row) } }
}
const requeueable = ({ human, disposition: d }: Pick<TriggerRow, 'human' | 'disposition'>) => human && !d.queued && !d.evaluating
  && (!!d.filtered || d.decision?.outcome === 'unavailable' || d.delivered || (d.fanout.length > 0 && !d.decision))
// 可重排条件：真人触发，且不在队列/评估中，且（被过滤、决策不可用、已送达、或已扇出但未决）。
type SearchItem = ApiResponse<'GET search'>['items'][number]
export function found(id: string, at: string, { threadTitle, filtered,
  ...fields }: TriggerFields & { threadTitle?: string; filtered?: string } = {}): SearchItem {
  const { text: _text, ...result } = trigger(id, at, fields)
  return filtered === undefined ? { ...result, threadTitle } : { ...result, threadTitle: undefined, filtered }
}
// 搜索结果项：正常项带线程标题；被过滤项改为带过滤原因。
export const promptVersion = (revision: number, config: PromptsView['current']['config']): PromptsView['current'] =>
  ({ revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'panel', config })
// 构造指定修订号的提示词版本视图。
/** Build a dropped outbound reply fixture (`feishu` replies to `oc_1`/`om_root`; `github` comments on PR #42). */
// 构造未送达回复 fixture（飞书回 oc_1/om_root；GitHub 评论在 PR #42 上）。
export const droppedReply = (id: string, hoursAgo: number, source: 'feishu' | 'github', reason: DroppedReply['dropped']['reason'],
  { ticket, thread }: { ticket?: DroppedReply['ticket']; thread?: false } = {}): DroppedReply => ({
  id, preview: `Reply ${id}`, kind: 'reply',
  channel: source === 'feishu' ? feishuChannel('oc_1', 'om_root') : githubChannel(42),
  dropped: { at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), reason }, ...ticket ? { ticket } : {},
  // thread: false 表示无线程引用（不生成跳转链接）。
  ...thread === false ? {} : { thread: source === 'feishu' ? 'feishu:oc_1:om_root' : 'github:42' },
})
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString()
// 24 小时前的时刻（未送达列表只显示这一天内的）。
export const problemOf = (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).problem
// 由 SetupCode 构造结构化问题（走真实 SetupError 的文案与占位）。
// The kinds' configurations differ, and the fake reads them only as the records the views carry.
// 两个 kind 的配置形状不同，本假服务端只把视图需要的记录读出来。
const KINDS = [feishuKind, githubKind] as unknown as SourceKind[]
export const MACHINE = { stateDir: '/srv/dsh-superagent', promptMaxChars: 100000, admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000 }
// 假机器信息（设置页展示用）。

type Settings = ReturnType<typeof SettingsSchema.parse>
export interface PanelServer {
  // 假服务端的可变状态：测试可直接改写以驱动 UI 的各种分支。
  joined?: Record<string, string>; joining?: Record<string, string>
  // 已加入群（键值对）；joining 是下一次刷新群列表将返回的增量。
  joinError?: string
  // 设置后下一次刷新群列表报此错误。
  settings: Settings; revisions: Record<string, number>
  // 当前设置与各设置块的修订号。
  prompts: PromptsView
  tickets: { open: TicketRow[]; ended: TicketRow[] }; ticketDetails: Record<string, TicketPageView>
  threads: ThreadRow[]
  threadPages: (key: string, query: { before?: string; around?: string }) => ThreadPageView | undefined
  person: TicketRow[]; search: Pick<ApiResponse<'GET search'>, 'items' | 'threads'>; history: HistoryView
  requests: { path: string; method: string; body?: unknown }[]
  // 记录客户端发出的每个请求（供测试断言）。
  /** Requests with undeclared query params or invalid body presence; asserted empty after each test. */
  // 携带未声明查询参数或 body 形状不符的请求；每个用例后断言为空。
  misuse: string[]
  queued: Set<string>
  // 已重排进 Eval 的触发 id。
  searching?: (query: string) => Promise<void>
  // 设置后搜索请求被挂起直到它 resolve（模拟慢搜索）。
  setup: SetupView
  health: Record<string, Health>
  /** When true, all API requests return an empty 404 to simulate the host plugin being stopped. */
  // 为真时所有 API 请求都回空 404，模拟宿主插件停机。
  down: boolean
  /** Count of responses not yet consumed by the client. */
  // 客户端尚未消费的响应数（settle 等待它归零）。
  pending: number
  form?: ConfigForm<Record<string, unknown>> | undefined
  opened: string[]
  dropped: DroppedReply[]
  failing: Extract<Problem, { kind: 'outgoing' }>['outgoing'][]
}
export let server: PanelServer

function resolved() {
  // 由 setup.accounts 还原出部署信息（卡片 facts 用）。
  const accounts = server.setup.accounts
  return accounts ? testDeployment({ repository: accounts.repository, github: { cli: '/bin/false', login: accounts.agent, noreply: '' },
    ...accounts.feishu ? { feishu: { cli: '/bin/false', ...accounts.feishu } } : { feishu: undefined } }) : undefined
}
/** Default source health: paused during setup; Feishu defaults to `socket closed` unless overridden or paused by setup. */
// 默认来源健康：初始化未过时全部暂停；飞书默认“socket closed”，除非被覆盖或因初始化暂停。
function healthOf(name: string): Health {
  if (server.setup.problem) return { state: 'paused', detail: 'Waiting for setup', code: 'setupPending' }
  if (server.health[name]) return server.health[name]
  if (name !== 'feishu') return { state: 'ready', detail: '' }
  return server.setup.feishuProblem ? { state: 'paused', detail: server.setup.feishuProblem.detail } : { state: 'error',
    detail: 'socket closed' }
}
const problemOf_ = (id: string) => [server.setup.problem, server.setup.feishuProblem].find(item => item?.place === id) ?? undefined
// 找出归属某个来源的初始化问题。
function sourceSettings(): SourceView[] {
  return KINDS.map(kind => {
    const config = kind.schema.parse(server.settings.sources[kind.kind]?.config ?? {})
    // 配置按 kind schema 解析（补默认值）。
    const problem = problemOf_(kind.kind)
    const { admission: _admission, ...part } = server.settings.policy.sources[kind.kind] ?? { allowed: [], admission: {} }
    // 策略片段去掉 admission（视图不带它）。
    const sync = kind.policy?.sync && { label: kind.policy.sync.label, ready: kind.policy.sync.ready(kind.policy.schema.parse(part)),
      health: server.health[`sync:${kind.kind}`] }
    const policy = kind.policy && { fields: kind.policy.fields, explicit: kind.policy.explicit, ...kind.policy.rows
      ? { rows: kind.policy.rows(config) } : {}, ...sync ? { sync } : {} }
    return { id: kind.kind, kind: kind.kind, title: kind.title, description: kind.description, installed: true,
      value: { enabled: server.settings.sources[kind.kind]?.enabled ?? true, config },
        revision: server.revisions[`source:${kind.kind}`] ?? 0,
      restarts: SETUP_FIELDS[kind.kind] ?? [], fields: kind.fields, facts: kind.facts?.(resolved()) ?? {},
      labels: kind.kind === 'feishu' ? { oc_team: '团队群', oc_other: '另一个群', ...server.joined } : {}, ...problem ? { problem } : {},
      ...policy ? { policy } : {} }
  })
}
function sourceStatuses(): SourceStatusRow[] {
  return KINDS.map(kind => {
    const enabled = server.settings.sources[kind.kind]?.enabled ?? true
    const health = kind.health.map(name => ({ name, ...healthOf(name) }))
    const problem = problemOf_(kind.kind)
    const state = !enabled ? 'off' : problem || health.some(item => item.state === 'error') ? 'error' : server.setup.problem ? 'setup'
      : health.some(item => item.state === 'starting') ? 'starting' : health.some(item => item.state === 'paused') ? 'paused' : 'ready'
    // 状态归并：关闭/出错/等待初始化/启动中/暂停/就绪，按优先级取第一个命中。
    const feishu = kind.kind === 'feishu'
    return { id: kind.kind, title: kind.title, installed: true, enabled, state, health, ...problem ? { problem } : {},
      stats: { received: feishu ? 12 : 0, filtered: feishu ? 2 : 0, lastAt: '2026-09-23T00:00:00Z' },
      // 统计数字是固定样本值（面板只展示）。
      filtered: feishu ? [] : [{ id: 'e9', at: '2026-09-23T00:02:00Z', actor: actor('github', 'someone'), preview: 'looks wrong',
        reason: { code: 'source_disabled' } }],
      dropped: server.dropped.filter(item => item.channel.source === kind.kind && item.dropped.at >= dayAgo()) }
      // 未送达回复按来源与 24 小时窗口过滤。
  })
}
const stateView = (): StateView => ({
  setup: server.setup, load: { running: server.setup.problem ? 0 : 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers },
  // 初始化未过时不显示运行负载。
  masterId: 'master', paused: server.settings.paused,
  // The panel does not read health; the service script does.
  // 面板不读健康板；那是服务脚本的事。
  health: {},
})
const settingsView = (): ApiResponse<'GET settings'> => ({
  policyVersion: 'abcdef1234567890',
  blocks: { policy: { value: server.settings.policy, revision: server.revisions.policy ?? 0 },
    eval: { value: server.settings.eval, revision: server.revisions.eval ?? 0 },
    executor: { value: server.settings.executor, revision: server.revisions.executor ?? 0 } },
  sources: sourceSettings(),
  environment: { root: '/srv/dsh-superagent/work', variables: [
    // 环境变量说明视图（分拥有者展示，enabled 表示该来源启用）。
    { owner: 'executor', enabled: true, variables: [{ key: 'DSH_SUPERAGENT_DIR', description: { zh: '工单的执行目录',
      en: 'The ticket directory' } },
      { key: 'DSH_SUPERAGENT_NAME', description: { zh: '工单短名', en: 'Short name' } }] },
    { owner: 'github', enabled: false, variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库',
      en: 'Repository' } }] }] },
})
const overviewView = (): ApiResponse<'GET overview'> => {
  const { problem, feishuProblem } = server.setup
  const setup = problem ?? feishuProblem
  return {
    problems: [...setup ? [{ kind: 'setup' as const, ...setup }] : [],
      // 问题列表：初始化问题、无来源、来源错误、评估超时/不可用、暂停、运行时错误、无准入名单、外发失败。
      ...KINDS.some(kind => server.settings.sources[kind.kind]?.enabled !== false) ? [] : [{ kind: 'no-source' as const }],
      ...feishuProblem || server.settings.sources.feishu?.enabled === false ? [] : [{ kind: 'source-error' as const, source: { id: 'feishu',
        title: { zh: '飞书', en: 'Feishu' },
        health: { name: 'feishu', state: 'error' as const, detail: 'socket closed' } } }],
      // 飞书启用且无飞书问题时，默认样本视为有 socket 错误。
      ...server.threads.filter(thread => thread.evaluating && thread.evaluating.deadline < new Date().toISOString())
        .map(thread => ({ kind: 'eval-overdue' as const, thread })),
      { kind: 'eval-unavailable' as const, decisionId: 'u1', thread: threadSummary(), reason: [{ code: 'timeout' }], triggerId: 'e3' },
      ...server.settings.paused ? [{ kind: 'executor-paused' as const }] : [],
      // As on the host, every entry in error that is not a Source's own, a Policy sync, or the individually listed unavailable Evals is a runtime-error.
      // 与宿主一致：非来源自身、非策略同步、也非单独列出的不可用 Eval 的 error 条目，都归为 runtime-error。
      ...Object.entries(server.health).filter(([name, item]) => item.state === 'error' && !KINDS.some(kind => kind.health.includes(name))
        && !name.startsWith('sync:') && name !== 'evals')
        .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
      ...Object.values(server.settings.policy.sources).some(part => part.allowed.length) ? [] : [{ kind: 'no-allowed' as const }],
      ...server.failing.map(outgoing => ({ kind: 'outgoing' as const, outgoing }))],
    person: server.person, executor: { running: 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers, idle: 1 },
    flow: { received: 12, filtered: 2, triggers: 10, judged: 5, accepted: 1, evaluating: 0,
      dropped: server.dropped.filter(item => item.dropped.at >= dayAgo()).length },
    // 流量统计为固定样本，dropped 按当天窗口计数。
    policyVersion: 'abcdef1234567890',
  }
}
export const acceptDecision = (): NonNullable<TicketPageView['decision']> => ({ id: 'd1', kind: 'accept', outcome: 'accept',
  reason: [{ code: 'explicitRouted' }], at: '2026-09-22T00:00:00Z', strength: 'explicit', ticketId: undefined,
  triggerIds: ['e1'], thread: 'feishu:oc_1:om_root', rules: [], preview: '@bot 修一下', ticketTitle: undefined })
// 基准受理决策。
const ticketDetail = (): TicketPageView => ({
  // 工单详情视图：完整字段样本（授权依据、环境变量、频道链接、派工与输入）。
  ...ticketSummary(), paused: false, decision: acceptDecision(), threads: [threadSummary()],
  mandate: { strength: 'explicit', policyVersion: 'abcdef1234567890', basis: { via: 'addressed', sender: 'Alice', addressed: 'mention' },
    actor: actor('feishu', MEMBER), scope: '修复登录页回归' },
  basis: { facts: [{ name: 'sender', value: 'Alice' }, { name: 'addressed', value: 'mention' }], legacy: false },
  environment: [{ key: 'DSH_SUPERAGENT_DIR', value: '/w/t1', description: { zh: '执行目录', en: 'Directory' }, owner: 'executor' },
    { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', value: '', description: { zh: '编号', en: 'Number' }, owner: 'github' }],
  channels: [{ source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } },
    { source: 'github', url: 'https://github.com/acme/widgets/issues/42', label: { zh: 'GitHub #42', en: 'GitHub #42' } }],
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-22T00:00:00Z',
    startedAt: '2026-09-22T00:01:00Z',
    report: { state: 'progress', summary: 'working', at: '2026-09-22T00:02:00Z' } }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: false,
    trigger: { id: 'e2', actor: actor('feishu', MEMBER), human: true, preview: '顺便改标题', thread: 'feishu:oc_1:om_root' } },
  { id: 'i2', kind: 'policy-changed', at: '2026-09-22T00:04:00Z', delivered: true, from: 'aaaaaaaaaaaaaaaa', to: 'bbbbbbbbbbbbbbbb' }],
})
function threadPage(key: string, { before, around }: { before?: string; around?: string }): ThreadPageView | undefined {
  // 线程分页：只有基准线程有数据；两页时间线由 cursor/around 决定。
  if (key !== threadSummary().key) return undefined
  const base = { ...threadSummary(), tickets: [ticketSummary()], correlated: [{ key: 'github:42', title: 'PR 42' }], decisions: [],
    url: 'https://example.test/thread', context: [] }
  const decision = { id: 'd1', outcome: 'accept' as const, reason: [{ code: 'said', values: { text: 'x' } }], ticketId: 't1' }
  if (before === 'cursor-1' || around === 'e1') return { ...base, timeline: [trigger('e1', '2026-09-20T00:00:00Z',
    { disposition: { decision } })], earlier: null }
  // 早页：只有已决策的 e1，且没有更早页。
  return { ...base, earlier: 'cursor-1', timeline: [trigger('e3', '2026-09-23T00:00:00Z', { disposition: { fanout: ['t1'] } }),
    trigger('e4', '2026-09-23T00:01:00Z', { disposition: { filtered: { code: 'not_a_member' } } })] }
  // 首页：e3 已扇出、e4 被过滤，还有更早页（cursor-1）。
}
function initial(): PanelServer {
  const settings = SettingsSchema.parse({
    // 初始设置：两个来源启用、准入名单、一条规则、屏蔽命令。
    policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' },
      github: { allowed: [{ id: 'alice' }] } },
      rules: [{ id: 'copy', name: '文案修改', enabled: true, instruction: '修正明确的文案错误' }] },
    sources: { feishu: { enabled: true, config: { cli: 'lark-bot', chats: [{ chatId: 'oc_team', listen: 'mentions' }],
      directMessages: true } },
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } } },
    executor: { blockedCommands: ['gh-personal'] },
  })
  const ended = ticketSummary({ id: 't0', title: '旧工单', state: 'ended', actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'human', reason: 'Human asked to stop', outcome: 'stopped' } }, { stage: 'ended' })
  // 一个已结束工单样本。
  const reply = { source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } }
  const defaults = { revision: 0, previousRevision: null, savedAt: '', source: 'defaults' }
  return {
    health: {}, down: false, pending: 0, opened: [], requests: [], misuse: [], queued: new Set(), dropped: [], failing: [],
    setup: { machine: MACHINE, problem: null, feishuProblem: null,
      accounts: { repository: 'acme/widgets', agent: 'agent-bot', feishu: { appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot',
        name: 'Widgets Bot' } } },
    // 默认部署检查通过，账号信息齐全。
    settings, revisions: { policy: 3, eval: 1, executor: 0 },
    prompts: { masterId: 'master', sections: TEAM_SECTIONS, skillName: SKILL_NAME.source, builtin: ['feishu', 'github'],
      skillPrefix: SKILL_PREFIX, revision: 0, current: { ...defaults, config: defaultPrompts() },
      defaults: defaultPrompts(), parts: Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) })),
      defaultChanged: [], revisions: [{ ...defaults, changed: [] }], sessions: [], notificationPending: false, next_offset: null },
    // 提示词视图：默认配置、全部内置部件（带 base）、无变更记录。
    tickets: { open: [ticketSummary()], ended: [ended] }, ticketDetails: { t1: ticketDetail() },
    threads: [threadSummary()], threadPages: threadPage,
    person: [ticketSummary({ attention: { id: 'q1', question: '需要确认按钮颜色' }, note: { text: '需要确认按钮颜色', error: false }, reply },
      { stage: 'person', action: 'answer' }),
      // 待人回复样本：有注意点与回复渠道。
      ticketSummary({ id: 't4', title: '截图工具', actions: { retry: true, stop: true }, sessionId: 'worker-t4',
        summary: 'LlmError: no adapter registered for provider "provider-a"',
        note: { text: 'LlmError: no adapter registered for provider "provider-a"', error: true } }, { stage: 'person', action: 'failed' })],
      // 失败待重试样本：错误摘要 + 可重试。
    search: { items: [], threads: [] },
    history: { current: 3, policyVersion: 'abcdef1234567890', items: [
      // 设置历史样本：两个修订，含变更码与被通知的工单。
      { revision: 4, savedAt: '2026-09-23T00:00:00Z', source: 'panel', policyVersion: '9876543210fedcba', policyChanged: true, notified: [],
        block: 'source:feishu',
        changes: [{ code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_team'] }] },
      { revision: 3, savedAt: '2026-09-22T00:00:00Z', source: 'panel', policyVersion: 'abcdef1234567890', policyChanged: true,
        notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
        changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceField', source: 'feishu', field: 'directMessages',
          from: true, to: false },
          { code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_other', 'oc_new'] }] }] },
  }
}

/** A refusal response carrying the host's HTTP status code and JSON error body. Returned by route handlers when a request is rejected. */
// 拒绝响应：携带宿主的 HTTP 状态码与 JSON 错误体，由路由处理器在请求被拒时返回。
class Refusal { constructor(readonly status: 400 | 404 | 409 | 500, readonly body: Record<string, unknown>) {} }
const refuse = (status: Refusal['status'], error: string, more: Record<string, unknown> = {}) => new Refusal(status, { error, ...more })
type Query<K extends keyof Api> = Api[K] extends { query?: infer Q } ? keyof NonNullable<Q> & string : never
type Body<K extends keyof Api> = Api[K] extends { body: infer B } ? B : undefined
// 从 Api 类型推导每条路由的查询参数与 body 类型。
interface Request<K extends keyof Api> { params: RouteParams<K>; query: Partial<Record<Query<K>, string>>; body: Body<K> }
type Answer<K extends keyof Api> = ApiResponse<K> | Refusal
type Route<K extends keyof Api> = { query?: readonly Query<K>[]; answer: (request: Request<K>) => Answer<K> | Promise<Answer<K>> }
  & (Api[K] extends { body: unknown } ? { body: true } : { body?: never })
const page = <T>(items: T[]) => ({ items, total: items.length, next_offset: null })
// 分页响应的假实现（单页，无后续）。
const ticketOf = (id: string) =>
  [...server.tickets.open, ...server.person, ...server.tickets.ended].find(ticket => ticket.id === id) ?? server.ticketDetails[id]
// 在全部工单集合（含待人/已结束/详情）里找工单。
const SourceSave = z.object({ enabled: z.boolean(), config: z.unknown() })

const ROUTES: { [K in keyof Api]: Route<K> } = {
  // 路由表：键必须与 Api 完全一致（缺一路由会编译失败）。
  'GET state': { answer: stateView },
  'GET overview': { answer: overviewView },
  'GET search': { query: ['q'], answer: async ({ query }) => {
    const q = query.q ?? ''
    await server.searching?.(q)
    // 挂起钩子：测试可借它延迟搜索响应。
    return { tickets: [], threads: server.search.threads, items: server.search.items.filter(item => item.preview.includes(q)) }
  } },
  'GET sources': { answer: sourceStatuses },
  'GET settings': { answer: settingsView },
  'POST sources/:id/labels': { answer: () => {
    // Label refresh failures come from the bot CLI and are returned verbatim.
    // 刷新群列表的失败来自 bot CLI，原样返回。
    if (server.joinError) return refuse(500, server.joinError)
    const added = Object.values(server.joining ?? {}); server.joined = { ...server.joined, ...server.joining }; server.joining = undefined
    return { added }
  } },
  'GET threads': { query: ['filter', 'offset', 'limit'], answer: () => page(server.threads) },
  'GET threads/:key': { query: ['limit', 'before', 'around'], answer: ({ params, query }) => {
    const found = server.threadPages(params.key, query)
    if (!found) return refuse(404, 'Thread not found')
    // A Trigger sent to Eval again is queued and cannot be requeued.
    // 已重排进 Eval 的触发标记为 queued，且不能再重排。
    const queued = (item: TriggerRow) => ({ ...item, disposition: { ...item.disposition, queued: true }, actions: { requeue: false } })
    return { ...found, timeline: found.timeline.map(item => server.queued.has(item.id) ? queued(item) : item) }
  } },
  'POST threads/:key/unsubscribe': { answer: ({ params }) => {
    const removed = server.threads.length > 0
    server.threads = []
    return { removed, thread: params.key, context_delivery: 'injected' }
  } },
  'POST triggers/:id/requeue': { answer: ({ params }) => { server.queued.add(params.id); return { queued: true } } },
  'GET decisions': { query: ['kind', 'window', 'offset', 'limit'], answer: ({ query }) =>
    ({ items: query.kind === 'ignore' ? [] : [acceptDecision()], next_offset: null }) },
  // 忽略类决策列表为空样本，其余给受理决策。
  'POST decisions/:id/dismiss': { answer: ({ params }) => params.id === 'u1' ? { dismissed: true } : refuse(404,
    'Unavailable Eval not found') },
  // 只有样本里的 u1 可被忽略。
  'GET tickets': { query: ['state', 'offset', 'limit'], answer: ({ query }) => page(server.tickets[query.state === 'ended' ? 'ended'
    : 'open']) },
  'GET tickets/:id': { answer: ({ params }) => server.ticketDetails[params.id] ?? refuse(404, 'Ticket not found') },
  'POST tickets/:id/retry': { answer: ({ params }) => {
    const ticket = ticketOf(params.id)
    if (!ticket) return refuse(404, 'Ticket not found')
    return ticket.actions.retry ? { retried: true } : refuse(400, 'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed',
      { code: 'notRetryable', values: {} })
    // 不可重试的错误文案照抄宿主（面板据此展示）。
  } },
  'POST tickets/:id/stop': { answer: ({ params }) => {
    if (!ticketOf(params.id)) return refuse(404, 'Ticket not found')
    server.tickets.open = []; server.person = server.person.filter(ticket => ticket.id !== params.id)
    return { stopped: true }
  } },
  'POST executor/pause': { body: true, answer: ({ body }) => {
    server.settings = { ...server.settings, paused: body.paused }
    server.revisions.pause = (server.revisions.pause ?? 0) + 1
    return { paused: body.paused }
  } },
  'PUT settings/:block': { body: true, answer: ({ params: { block }, body }) => {
    // 保存设置块：与宿主同款的修订号冲突与校验逻辑。
    const source = block.startsWith('source:') ? KINDS.find(kind => `source:${kind.kind}` === block) : undefined
    if (!['policy', 'eval', 'executor'].includes(block) && !source) return block.startsWith('source:') ? refuse(404, 'Source not found')
      : refuse(400, 'Invalid settings: block')
    if (body.revision !== (server.revisions[block] ?? 0)) return refuse(409, 'Settings changed. Reload before saving.')
    let restarting = false
    if (block === 'policy') server.settings = { ...server.settings, policy: PolicyConfigSchema.parse(body.value) }
    else if (block === 'executor') server.settings = { ...server.settings, executor: ExecutorConfigSchema.parse(body.value) }
    else if (block === 'eval') server.settings = { ...server.settings, eval: EvalConfigSchema.parse(body.value) }
    else if (source) {
      const { enabled, config: value } = SourceSave.parse(body.value)
      const config = source.schema.parse(value)
      // As on the server, a changed CLI that fails its check refuses the save with the setup problem.
      // 与宿主一致：改动的 CLI 检查不过时拒绝保存并附初始化问题。
      if (config.cli === 'lark-broken') {
        const refused = new SetupError('feishuCliFailed', { output: 'lark-cli: app secret missing' })
        return refuse(400, refused.message, { setup: refused.problem })
      }
      restarting = (config.cli ?? '') !== (server.settings.sources[source.kind]?.config.cli ?? '')
      server.settings = { ...server.settings, sources: { ...server.settings.sources, [source.kind]: { enabled, config } } }
    }
    server.revisions[block] = (server.revisions[block] ?? 0) + 1
    return { restarting, revision: server.revisions[block] }
  } },
  'GET policy/history': { answer: () => server.history },
  'POST policy-sync/:id': { answer: ({ params }) => ({ policy: server.settings.policy.sources[params.id] }) },
  'POST setup/check': { answer: () => ({ restarting: true }) },
  'GET models': { answer: () => ({ default: { provider: 'host', model: 'default' }, routableProviders: [], failures: [],
    groups: [{ id: 'worker-provider', name: 'Worker provider', models: [{ id: 'worker-model', name: 'Worker model',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] }) },
  'GET prompts': { query: ['revision', 'offset'], answer: () => server.prompts },
  'PUT prompts': { body: true, answer: ({ body }) => {
    const { revision } = server.prompts
    if (body.baseRevision !== revision) return refuse(409,
      `Prompt version changed to ${revision}; compare the latest version before saving`)
    // 基于过期修订保存即 409（面板据此做冲突 rebase）。
    // As the host does: a template keeps its placeholders, and no overrides are stored as none.
    // 与宿主一致：模板必须保留占位符；空 overrides 不存。
    const { overrides = {}, ...config } = body.config as PromptsView['current']['config']
    for (const [part, override] of Object.entries(overrides)) {
      if (!builtInPart(part)) return refuse(400, 'refused', { code: 'unknownPromptPart', values: { part } })
      const missing = (builtInPart(part)?.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) return refuse(400, 'refused', { code: 'promptPlaceholders', values: { part, placeholders: missing.join(', ') } })
    }
    server.prompts.revision++
    server.prompts.current = promptVersion(server.prompts.revision, Object.keys(overrides).length ? { ...config, overrides } : config)
    return { revision: server.prompts.revision, context_delivery: 'injected' }
  } },
  'POST prompts/preview': { body: true, answer: ({ body }) => {
    const skills = [...server.setup.accounts?.feishu ? ['feishu'] : [], 'github', ...Object.keys(body.skills)].map(name => [name,
      composeSkill(body, name)])
    // The generated parts from their templates, without variables or rules.
    // 由模板生成的部件：不带变量与规则（预览专用）。
    const environment = environmentSection(body, []), policy = policySection(SettingsSchema.parse({ policy: { rules: [] } }), body)
    return { parts: { orchestrator: promptParts(body, 'orchestrator', environment, policy), worker: promptParts(body, 'worker', environment) },
      skills: Object.fromEntries(skills),
      orchestrator: composePrompt(body, 'orchestrator'), worker: composePrompt(body, 'worker'), scope: '' }
  } },
}

function match(method: string, segments: string[]) {
  // 按方法与路径段匹配路由：:param 段捕获为参数。
  for (const key of Object.keys(ROUTES) as (keyof Api)[]) {
    const [verb, path] = key.split(' ') as [string, string]
    const pattern = path.split('/')
    if (verb !== method || pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith(':')
      || part === segments[index])) continue
    return { key, params: Object.fromEntries(pattern.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1),
      decodeURIComponent(segments[index]!)]] : [])) }
  }
  return undefined
}
async function run<K extends keyof Api>(key: K, params: Record<string, string>, query: URLSearchParams, body: unknown): Promise<Answer<K>> {
  // 执行路由：先做“误用”检查（未声明查询参数、body 有无不符），再调用处理器。
  const route: Route<K> = ROUTES[key]
  const read: readonly string[] = route.query ?? []
  for (const name of query.keys()) if (!read.includes(name)) server.misuse.push(`${key} with the query parameter ${name}`)
  if ((body !== undefined) !== !!route.body) server.misuse.push(`${key} ${body === undefined ? 'without' : 'with'} a body`)
  const values: Partial<Record<Query<K>, string>> = {}
  for (const name of route.query ?? []) { const value = query.get(name); if (value !== null) values[name] = value }
  return route.answer({ params: params as RouteParams<K>, query: values, body: body as Body<K> })
}
/**
 * Response wrapper that increments `server.pending` when constructed and decrements it when `.text()` is consumed.
 * Requests held back by `server.searching` are not constructed until `searching` resolves, so they do not count as pending early.
 */
// 响应包装：构造时 pending 加一，.text() 被消费时减一；
// 被 server.searching 挂起的请求在 resolve 前不会构造，因此不会提前计入 pending。
class Reply extends Response {
  constructor(value: unknown, status: number) { super(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json' } }); server.pending++ }
  override async text() { server.pending--; return super.text() }
}

export function usePanelServer(cleanup: () => void) {
  // 每个用例装配一次假服务端，并 stub 全局 fetch。
  beforeEach(() => {
    sessionStorage.clear()
    server = initial()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (server.down) return new Response(null, { status: 404 })
      // 模拟宿主插件停机：全部请求空 404。
      const address = new URL(url, 'http://127.0.0.1:3082')
      const path = address.pathname.replace('/orchestrator/api/', '')
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
      server.requests.push({ path: decodeURIComponent(`${path}${address.search}`), method, ...body === undefined ? {} : { body } })
      // 记录请求（供测试断言面板发了什么）。
      const route = match(method, path.split('/'))
      if (!route) return new Reply({ error: 'Unknown operation' }, 404)
      const answer = await run(route.key, route.params, address.searchParams, body)
      return answer instanceof Refusal ? new Reply(answer.body, answer.status) : new Reply(answer, 200)
    }))
  })
  afterEach(() => {
    try { expect(server.misuse).toEqual([]) }
    // 用例结束：面板不得发出任何“误用”请求。
    finally { cleanup(); vi.unstubAllGlobals() }
  })
}

type Ops = Parameters<ConfigForm<Record<string, unknown>>['mutate']>[0]
/** Fake DSH host configuration form that records mutations and optionally applies them to its snapshot. */
// 假 DSH 宿主配置表单：记录 mutate 调用，可选择把变更应用到快照。
export function fakeForm(writable = true, accept = true) {
  const listeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot<Record<string, unknown>> = { status: 'ready', value: { ...MACHINE }, base: undefined, user: undefined,
    revision: 1, writable,
    mode: 'host' }
  const notify = () => { for (const listener of listeners) listener() }
  const mutations: { ops: Ops; revision: number | undefined }[] = []
  const form: ConfigForm<Record<string, unknown>> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      if (!accept || revision !== snapshot.revision) return false
      // accept=false 或修订号过期时拒绝变更（模拟并发冲突）。
      const value = { ...snapshot.value }
      for (const op of ops) { if (op.op === 'set') value[op.path[0]!] = op.value; else delete value[op.path[0]!] }
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
      notify()
      return true
    },
    set: async () => false, unset: async () => false,
  }
  const publish = (patch: Partial<ConfigFormSnapshot<Record<string, unknown>>>) => { snapshot = { ...snapshot, ...patch }; notify() }
  // publish：测试主动推送快照补丁（模拟宿主侧状态变化）。
  return { form, mutations, publish }
}
