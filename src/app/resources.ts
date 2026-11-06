/** Serves paginated context resources to orchestrator_read so large bodies stay out of model prompts until requested. */
// 上下文资源服务：为 orchestrator_read 工具提供分页资源，使大段内容在被请求之前不进入模型提示词。
// SessionId：DSH 会话 id 类型
import type { SessionId } from '@deepseek-ai/dsh-session'
// 核心域辅助：UserError 用户错误、key 内部键、latestReport 最新报告、reached 触发器可达性、runningAssignment 运行中的派工、threadKey 线程键
import { UserError, key, latestReport, reached, runningAssignment, threadKey, type Ticket, type Trigger } from '../core/index.ts'
// 执行器辅助：batchOf 工单批次、inputMessage 渲染输入、triggerMessage 渲染触发器消息、workerSessionId worker 会话 id
import { batchOf, inputMessage, triggerMessage, workerSessionId } from '../executor/dsh.ts'
// readGithub：读取 GitHub 原始内容
import { readGithub } from '../sources/github-read.ts'
// feishuReferences：飞书消息上下文引用；feishuRead：读取飞书原始内容
import { feishuReferences, feishuRead } from '../sources/feishu-read.ts'
// feishuRef：把触发器解析为飞书消息引用
import { feishuRef } from '../sources/feishu.ts'
// feishuTriggerId：由飞书消息 id 反查触发器 id
import { feishuTriggerId } from '../sources/feishu-trigger.ts'
// 卡片与分页工具（见 cards.ts）
import { ASSIGNMENTS, INPUTS, assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, preview, textPage, threadCard, ticketCard,
  ticketDetails, triggerCard, type TicketThread } from './cards.ts'
// threadTitle：线程的人类可读标题
import { threadTitle } from './views/records.ts'
// transcriptEntry：会话事件的对话记录投影
import { transcriptEntry } from './context.ts'
// builtInParts/defaultPrompts：内置提示词部分与默认配置
import { builtInParts, defaultPrompts } from './prompts.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Commands } from '../infra/commands.ts'
import type { PromptVersion, Prompts } from './prompts.ts'
import type { Sessions } from './sessions.ts'
import type { Settings } from './settings.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'

/** Resource descriptors exposed via orchestrator_read, marking which resources worker sessions may also read for their own ticket. */
// 通过 orchestrator_read 暴露的资源描述清单：name 为资源名、holds 为内容说明；标 executor: true 的资源 worker 会话也可读（限其自己的工单）
export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  // tickets：工单卡片列表（最新在前），并说明各状态含义（person/review、person/blocked、working/queued 等）
  { name: 'tickets', holds: 'ticket cards, newest first; a card\'s state is person/review after a ready report, person/blocked or person/failed after those reports, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, else how the ticket ended' },
  // triggers：触发器卡片（含各自去向，最新在前）
  { name: 'triggers', holds: 'trigger cards with where each went, newest first' },
  // threads：已订阅线程（按最近活动排序，附标签、工单、当前评估与轮询错误）
  { name: 'threads', holds: 'subscribed threads, newest activity first, with their labels, tickets, current assessment and polling errors' },
  // thread/<key>：单个线程（worker 也可读）
  { name: 'thread/<key>', holds: 'one thread: its label and link, its tickets and latest decisions, and its triggers, newest first', executor: true },
  // decisions：决策列表
  { name: 'decisions', holds: 'decisions, newest first' },
  // decision/<id>：单个决策（含审计）
  { name: 'decision/<id>', holds: 'one decision with its audit' },
  // ticket/<id>：工单详情（worker 也可读）
  { name: 'ticket/<id>', holds: 'a ticket\'s card, the trigger, decision and threads it is tied to, its latest assignments with the start of each '
    + 'report, and its inputs, newest first', executor: true },
  // ticket/<id>/assignment：派工指令原文（worker 也可读）
  { name: 'ticket/<id>/assignment', holds: 'its assignment text', executor: true },
  // ticket/<id>/assignments：派工列表（worker 也可读）
  { name: 'ticket/<id>/assignments', holds: 'its assignments, newest first, with the start of each report', executor: true },
  // ticket/<id>/inputs：输入列表（worker 也可读）
  { name: 'ticket/<id>/inputs', holds: 'its inputs, newest first', executor: true },
  // ticket/<id>/result：最新报告（worker 也可读）
  { name: 'ticket/<id>/result', holds: 'its latest report', executor: true },
  // ticket/<id>/report/<id>：某条派工的报告（worker 也可读）
  { name: 'ticket/<id>/report/<id>', holds: 'the report of one of its assignments', executor: true },
  // ticket/<id>/transcript：执行会话对话记录索引（worker 也可读）
  { name: 'ticket/<id>/transcript', holds: 'its Executor Session\'s messages, newest first', executor: true },
  // ticket/<id>/message/<n>：对话记录中的单条消息（worker 也可读）
  { name: 'ticket/<id>/message/<n>', holds: 'one message of that transcript', executor: true },
  // ticket/<id>/input/<id>：投递给它的某条输入（worker 也可读）
  { name: 'ticket/<id>/input/<id>', holds: 'one input it was delivered', executor: true },
  // trigger/<id>：触发器全文（含去向、回复对象与同线程邻近消息；worker 也可读）
  { name: 'trigger/<id>', holds: 'a trigger\'s text, where it went, the message it replies to and the messages around it on its thread',
    executor: true },
  // settings：设置总览（小整块给全、大块摘要）
  { name: 'settings', holds: 'settings by block, each with the revision a save names: the small blocks whole, the Policy and the Source '
    + 'instances summarized' },
  // settings/<block>：单个设置块原文（与 orchestrator_settings_save 的入参一致）
  { name: 'settings/<block>', holds: 'one settings block whole, as orchestrator_settings_save takes it: policy, eval, executor, pause or '
    + 'source:<id>' },
  // prompts：提示词总览（各 Session 读的修订、技能与保存的历史）
  { name: 'prompts', holds: 'the prompt revision each Session reads, the skills, and the saved versions' },
  // prompts/<revision>：单个提示词版本（worker 也可读当前版本）
  { name: 'prompts/<revision>', holds: 'one prompt version by number, or current, the one the Session works under', executor: true },
  // prompts/defaults：内置提示词配置与各内置部分（按覆盖所用的键）
  { name: 'prompts/defaults', holds: 'the built-in prompt configuration, and the built-in parts by the key an override names' },
  // prompt-preview/<id>：保存前预览过的组合提示词
  { name: 'prompt-preview/<id>', holds: 'a composed prompt that orchestrator_prompts_save previewed' },
  // models：模型目录总览
  { name: 'models', holds: 'model providers, the DSH default and each role\'s model' },
  // models/<provider>：单个提供方的模型
  { name: 'models/<provider>', holds: 'one provider\'s models' },
  // feishu/<trigger-id>/…：飞书原始内容（由 dsh-superagent-feishu 技能描述；worker 也可读）
  { name: 'feishu/<trigger-id>/…', holds: 'a Feishu original, as the dsh-superagent-feishu skill describes', executor: true },
  // github/…：GitHub 原始内容（由 dsh-superagent-github 技能描述；worker 也可读）
  { name: 'github/…', holds: 'a GitHub original, as the dsh-superagent-github skill describes', executor: true },
]
// 资源清单的语法描述文本：按调用方是否为 worker 过滤（worker 只见带 executor 标记的），拼成 "名: 说明; ..." 形式
export const resourceGrammar = (executor: boolean): string => RESOURCES.filter(resource => !executor || resource.executor)
  .map(resource => `${resource.name}: ${resource.holds}`).join('; ')

// ResourceHost：资源读取所需的最小宿主依赖
export interface ResourceHost {
  // 存储：KV 读取、设置、触发器、工单、线程、只读查询、决策与回执状态
  readonly store: Pick<Store, 'get' | 'settings' | 'triggers' | 'tickets' | 'threads' | 'read' | 'decisions' | 'replyStatus'>
  // 分页缓存（按会话缓存已取回的资源首页正文）
  readonly pages: TextCache
  // 提示词管理器的部分能力：当前版本、按号读取、历史、技能与默认值变更
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'skills' | 'defaultChanged'>
  // 命令执行器
  readonly commands: Commands
  // 主会话 id
  readonly masterId: string
  // cordis 上下文（用于访问会话控制器）
  readonly context: Context
  // 某会话当前绑定的提示词版本
  promptVersion(sessionId: string): PromptVersion
  /** Whether a Session may read `revision` (the revision it currently runs under or any revision it ran under previously). */
  // 会话是否可读某提示词修订（当前运行的修订，或历史上运行过的修订）
  mayRead(sessionId: string, revision: number): boolean
  // 飞书资源的分页大小
  feishuPageSize(): number
  // 触发器来源链接解析（复用 links.ts 的能力）
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
}
// MainResourceHost：主会话专用宿主——在 ResourceHost 之上追加会话状态与设置读写能力
export interface MainResourceHost extends ResourceHost {
  readonly sessions: Pick<Sessions, 'status' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block'>
}
// Read：一次资源读取请求的上下文：宿主、资源名、路由剩余段、offset、可选 limit；会话 id、可选工单 id（worker 场景）与取消信号
interface Read {
  host: ResourceHost; resource: string; rest: string; offset: number; limit?: number
  sessionId: string; ticketId?: string; signal?: AbortSignal
}
// Route：路由表条目——资源名（带尾斜杠表示前缀匹配）与读取函数
type Route = readonly [name: string, read: (read: Read) => unknown]

/** Enforces that main-Session-only resources cannot be read by worker Sessions. */
// 守卫：仅主会话可读的资源不允许 worker 会话读取（worker 必带 ticketId；宿主还须带 settings 视图）
const main = ({ host, ticketId }: Read): MainResourceHost => {
  if (ticketId || !('settings' in host)) throw new Error('This resource belongs to the main Session')
  return host as MainResourceHost
}
// 文本资源返回：textPage 包装，默认页大小 4000 字符
const text = ({ resource, offset, limit }: Read, body: string) => textPage(resource, body, offset, limit ?? 4000)
// 通用列表分页：默认页大小 20、上限 50；多取一条用于判断"还有更多"
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  // 本页大小
  const size = Math.min(limit ?? 20, 50)
  // 多取一条：items.length > size 说明还有下一页
  const items = fetch(offset, size + 1)
  // 返回本页条目与下一页偏移（无更多则 null）
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}
/** Check whether a worker session's ticket is authorized to read a trigger (via delivery, ticket origin, or followed thread). */
// 可达性判定：worker 工单是否被授权读取某触发器——经投递、工单来源，或其关注的线程
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean => reached(ticket, trigger, key => host.store.threads.get(key))
  || ticket.origin.triggerIds.includes(trigger.id) || trigger.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)))
// 取触发器（带校验）：存在性 + worker 场景的可达性
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  // 触发器必须存在
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  // worker 场景下取其工单
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  // worker 会话读取不可达的触发器：拒绝
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  return found
}
/** Fetch and cache a source resource on offset 0, serving subsequent offsets from the session cache. */
// 数据源资源分页：offset 0 时真正抓取并写入会话缓存；后续 offset 从缓存读取（避免重复请求外部服务）
async function sourcePage(read: Read, source: string, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read
  // 首页抓取并序列化；否则读会话缓存
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`)
  // 缓存未命中（跳页读取）：要求先从 offset 0 读起
  if (body === undefined) throw new Error(`Read this ${source === 'feishu' ? 'Feishu' : 'GitHub'} resource from offset 0 first`)
  // 首页时写入缓存
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body)
  // 按文本分页返回
  return text(read, body)
}
// 线程详情中展示的决策条数上限
const THREAD_DECISIONS = 5
// 触发器单行压缩投影：id、触发者、是否人工、时间、预览与读取路径
const triggerLine = (trigger: Trigger) => ({ trigger_id: trigger.id, actor: trigger.actor.id, human: trigger.human, at: trigger.at,
  preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}` })
// 读取某工单执行会话的完整事件列表（用于 transcript 相关资源）
async function transcript(host: ResourceHost, ticketId: string) {
  return (await host.context.sessionController.inspect(workerSessionId(ticketId) as SessionId)).events
}

// 路由表：资源名 → 读取函数（带尾斜杠的按前缀匹配）
const ROUTES: readonly Route[] = [
  // tickets：工单卡片分页列表（最新在前）；每张卡附当前运行中 worker 会话的重试状态
  ['tickets', read => {
    const host = main(read), tickets = host.store.tickets.list()
    const card = (ticket: Ticket) => ({ ...ticketCard(ticket), ...host.sessions.modelRetry(runningAssignment(ticket) && workerSessionId(ticket.id)) })
    return list(read, (offset, count) => tickets.slice(offset, offset + count).map(card))
  }],
  // triggers：触发器卡片分页（最新在前），附各自的处置结果
  ['triggers', read => {
    const { store } = main(read)
    return list(read, (offset, count) => store.read.recentTriggers(offset, count).map(item => triggerCard(item, store.triggers.disposition(item.id))))
  }],
  // threads：已订阅线程列表（按最近活动时间倒序），卡片附标题
  ['threads', read => {
    const { store } = main(read)
    const threads = store.read.subscribedThreads().sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    return list(read, (offset, count) => threads.slice(offset, offset + count).map(thread => threadCard(thread, threadTitle(store, thread))))
  }],
  // thread/<key>：单个线程：标题与链接、工单与最近决策、触发器分页（最新在前）；worker 会话也可读（限其相关线程）
  ['thread/', read => {
    const { host, rest, ticketId } = read
    // 取线程与（worker 场景下的）工单
    const thread = host.store.threads.get(rest)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    // Worker Sessions may only read threads their own ticket subscribes to or follows.
    // 线程不存在，或 worker 会话试图读其工单未订阅/未关注的线程：拒绝
    if (!thread || (ticketId && !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === rest)))) {
      throw new Error('Unknown or inaccessible thread')
    }
    const { store } = host
    // 从线程卡片中抽出 tickets 字段（worker 场景不回填，主会话场景重填为卡片）
    const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread))
    // 触发器分页（每行用 triggerLine 压缩）
    const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine))
    // Worker sessions cannot inspect other tickets or decisions on a shared thread.
    // worker 会话只返回卡片与触发器分页，不给共享线程上的其他工单与决策
    if (ticketId) return { ...card, ...page }
    // 主会话：附加线程订阅的工单卡片与最近 N 条决策（按时间正序取尾再倒序 → 最新在前）
    const tickets = ids.flatMap(id => { const found = store.tickets.get(id); return found ? [ticketCard(found)] : [] })
    const decisions = store.decisions.byThread(thread.key).slice(-THREAD_DECISIONS).reverse().map(decisionCard)
    return { ...card, tickets, decisions, ...page }
  }],
  // decisions：决策卡片分页（最新在前）
  ['decisions', read => list(read, (offset, count) => main(read).store.read.recentDecisions(offset, count).map(decisionCard))],
  // decision/<id>：单个决策详情（含审计）
  ['decision/', read => {
    const decision = main(read).store.decisions.get(read.rest)
    if (!decision) throw new Error('Unknown decision')
    return decisionDetails(decision)
  }],
  // settings：设置总览（按块）
  ['settings', read => main(read).settings.view()],
  // settings/<block>：单个设置块原文
  ['settings/', read => text(read, JSON.stringify(main(read).settings.block(read.rest)))],
  // prompts：提示词总览：各 Session 读取的修订、技能、保存历史与内置默认值变更
  ['prompts', read => {
    const host = main(read), current = host.prompts.current(), status = host.sessions.status()
    const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50)), skills = host.prompts.skills(current.config).map(([name]) => name)
    // The built-in parts whose text changed since the team overrode them, and those this version no longer has, which the
    // panel shows and the next save drops.
    // 计算默认值变更：内置文本已变的覆盖与已消失的部分——面板据此展示，下一次保存会丢弃它们
    const changes = host.prompts.defaultChanged(current.config)
    // 分为"仍存在但已变"与"已消失"两类，各取部分名列表
    const changed = changes.filter(item => !item.removed).map(item => item.part)
    const removed = changes.filter(item => item.removed).map(item => item.part)
    // 组装返回：当前修订与读取路径、待处理通知；可选的变更/消失列表；
    // 各 Session 的修订绑定；技能（内置/团队，附注册前缀）；
    // 修订历史（字段名转换为 previous_revision/saved_at）与翻页游标
    return { revision: status.revision, read: `prompts/${current.revision}`, notification_pending: status.notificationPending,
      ...changed.length ? { default_changed: changed } : {}, ...removed.length ? { removed_parts: removed } : {},
      sessions: status.sessions.map(session => ({ session_id: session.sessionId, revision: session.revision })),
      skills: { built_in: skills.filter(name => !(name in current.config.skills)).map(name => `dsh-superagent-${name}`),
        team: Object.keys(current.config.skills).map(name => `dsh-superagent-${name}`) },
      items: history.revisions.map(({ previousRevision, savedAt, ...version }) =>
        ({ ...version, previous_revision: previousRevision, saved_at: savedAt })),
      next_offset: history.next_offset }
  }],
  // A worker Session may read only its current prompt revision and revisions it previously ran under.
  // prompts/<revision>：单个提示词版本文本；worker 会话只能读其当前绑定修订及曾运行过的修订
  ['prompts/', read => {
    const { host, resource, rest, sessionId, ticketId } = read
    const prompts = host.prompts
    // 该会话当前绑定的提示词版本
    const bound = host.promptVersion(sessionId)
    // parts：内置部分"键 → 文本"对照表（defaults 版本需要展示）
    const parts = () => Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]))
    // 解析目标版本：current=会话绑定版本；defaults 仅主会话可读（附内置部分表）；
    // 数字按修订号读取（0 号在尚未保存时即当前内置默认）；其余形式视为未定义
    const version = rest === 'current' ? bound : rest === 'defaults' && !ticketId ? { revision: 0, config: defaultPrompts(), parts: parts() }
      : /^\d+$/.test(rest) ? (Number(rest) === 0 && prompts.current().revision === 0 ? prompts.current() : prompts.version(Number(rest))) : undefined
    // 版本不存在，或 worker 会话无权读该修订：拒绝
    if (!version || (ticketId && !host.mayRead(sessionId, version.revision))) throw new Error('Unknown or inaccessible prompt version')
    // 文本化返回（current 请求把资源名规范化为 prompts/<修订号>）
    return text({ ...read, resource: rest === 'current' ? `prompts/${version.revision}` : resource }, JSON.stringify(version))
  }],
  // prompt-preview/<id>：读取此前 orchestrator_prompts_save 预览过的组合提示词（从会话缓存取）
  ['prompt-preview/', read => {
    const body = main(read).pages.get(`${read.sessionId}:${read.resource}`)
    if (body === undefined) throw new Error('Unknown preview for this Session')
    return text(read, body)
  }],
  // models：模型目录总览：DSH 默认模型、各角色模型、失败记录与提供方列表
  ['models', async read => {
    const host = main(read), catalog = await host.context.sessionController.modelCatalog(), settings = host.store.settings()
    // 各角色当前配置的模型
    const roles = { orchestrator: settings.eval.model, worker: settings.executor.model }
    return { default: catalog.default, roles, failures: catalog.failures,
      providers: catalog.groups.map(group => ({ id: group.id, name: group.name, count: group.models.length, read: `models/${group.id}` })) }
  }],
  // models/<provider>：单个提供方的模型列表（分页）
  ['models/', async read => {
    const models = (await main(read).context.sessionController.modelCatalog()).groups.find(group => group.id === read.rest)?.models
    if (!models) throw new Error('Unknown model provider')
    return list(read, (offset, count) => models.slice(offset, offset + count))
  }],
  // feishu/<trigger-id>/…：读取某飞书来源触发器的原始内容（分页，须可解析出飞书消息引用）
  ['feishu/', async read => {
    // 校验触发器存在且（worker 场景）可达
    const source = trigger(read.host, read.rest.split('/')[0]!, read.ticketId)
    // 必须能解析出飞书消息引用
    const ref = feishuRef(source)
    if (!ref) throw new Error('A Feishu source trigger is required')
    // 命令执行器附加取消信号
    const commands = read.host.commands.withSignal(read.signal)
    // 经 sourcePage 抓取并缓存
    return sourcePage(read, 'feishu', () => feishuRead(commands, ref, read.resource, read.host.feishuPageSize()))
  }],
  // github/…：读取 GitHub 资源（分页）
  ['github/', read => sourcePage(read, 'github', () => readGithub(read.host.commands.withSignal(read.signal), read.resource))],
  // trigger/<id>：单个触发器全文，附去向、其回复的原消息与线程上邻近消息
  ['trigger/', async read => {
    const { host, rest, ticketId, offset, signal } = read
    // 资源名必须就是触发器 id（不允许再带子路径）
    if (!rest || rest.includes('/')) throw new Error('Unknown context resource')
    // 校验触发器存在且（worker 场景）可达
    const found = trigger(host, rest, ticketId)
    // 尝试解析为飞书消息引用（用于附上下文引用）
    const ref = feishuRef(found)
    // Redact decision IDs, other tickets, and unreachable neighbour triggers when a worker session reads a trigger.
    // worker 会话读取时做脱敏：隐藏决策 id、其他工单与不可达的邻近触发器
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    // shown：仅当（主会话或）该工单可达时才展示某触发器
    const shown = (item: Trigger | undefined) => item && (!ticket || readable(host, ticket, item)) ? item : undefined
    // 取原始处置结果
    const disposition = host.store.triggers.disposition(found.id)
    // worker 场景的处置结果副本：抹掉 decisionId，fanout 只留本工单
    const visible = disposition && ticket ? { ...disposition, decisionId: undefined, fanout: disposition.fanout.filter(id => id === ticket.id) }
      : disposition
    // Omit card preview and self-reference because this resource returns the full text.
    // 本资源本身返回全文：去掉卡片的 preview/chars/read 自引用字段
    const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
    // 若触发器是飞书消息的回复，取其父消息 id
    const parent = found.source === 'feishu' && typeof found.meta.parentId === 'string' ? found.meta.parentId : undefined
    // 父触发器（worker 场景下同样要过可达性过滤）
    const repliedTo = shown(parent ? host.store.triggers.get(feishuTriggerId(parent)) : undefined)
    // 线程上该消息前后的邻近触发器
    const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
    // 前后邻近（经可达性过滤）
    const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
    // 组装返回：脱敏后的卡片、来源链接、确认（ack）状态、可选的飞书上下文引用；
    // 仅第 0 页附 replied_to 与 around 邻近行；最后附全文文本分页
    return { ...card, ...await host.sourceLink(found, signal), acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
      ...(ref ? { context: feishuReferences(ref) } : {}),
      ...(offset === 0 ? {
        ...repliedTo ? { replied_to: triggerLine(repliedTo) } : {},
        around: { ...around.before ? { before: triggerLine(around.before) } : {}, ...around.after ? { after: triggerLine(around.after) } : {} },
      } : {}),
      ...text(read, found.text) }
  }],
  // ticket/<id>[/<section>[/<part>]]：工单详情与各子资源（assignments/inputs/result/report/transcript/input/message）
  ['ticket/', async read => {
    const { host, resource, rest, ticketId, signal } = read
    // 解析路径段：id / section / part（出现多余段即报错）
    const [id, section, part, ...more] = rest.split('/')
    if (!id || more.length) throw new Error('Unknown context resource')
    // worker 会话只能读自己的工单
    if (ticketId && ticketId !== id) throw new Error('Ticket does not belong to this worker')
    // 工单必须存在
    const ticket = host.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    // 无 section：返回工单详情卡片
    if (section === undefined) {
      // 运行中的 worker 会话（若有）
      const running = runningAssignment(ticket) && workerSessionId(ticket.id)
      // 主会话附会话重试状态；worker 宿主无 sessions 视图则给空对象
      const retry = 'sessions' in host ? (host as MainResourceHost).sessions.modelRetry(running) : {}
      // Merge subscribed threads (including context-only subscriptions) and source-bound threads without duplicates.
      // 合并"订阅的线程（含仅上下文订阅）"与"数据源绑定的线程"，并去重
      const bound = new Set((ticket.follows ?? []).map(follow => follow.thread))
      // 订阅了本工单的线程
      const subscribed = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(id))
      // 构造线程引用条目：context 标记仅上下文订阅；bound 标记数据源绑定
      const marked = (key: string, context: boolean): TicketThread =>
        ({ thread: key, ...context ? { context: true } : {}, ...bound.has(key) ? { bound: true } : {} })
      // 先收订阅线程，再收未出现在订阅中的绑定线程
      const threads = [...subscribed.map(thread => marked(thread.key, !!thread.context?.includes(id))),
        ...[...bound].filter(key => !subscribed.some(thread => thread.key === key)).map(key => marked(key, false))]
      // 返回详情（worker 场景隐藏决策 id）与重试状态
      return { ...ticketDetails(ticket, threads, batchOf(host, ticket), !!ticketId), ...retry }
    }
    // assignments / inputs：两个列表子资源（分页，默认页大小分别为 ASSIGNMENTS/INPUTS，上限 50）
    if (section === 'assignments' || section === 'inputs') {
      // 不允许再带子路径
      if (part !== undefined) throw new Error('Unknown context resource')
      const size = Math.min(read.limit ?? (section === 'assignments' ? ASSIGNMENTS : INPUTS), 50)
      // 分别按派工/输入投影做"最新优先"分页
      const { items, next_offset } = section === 'assignments'
        ? newestPage(ticket.assignments, read.offset, size, item => assignmentLine(ticket, item), resource)
        : newestPage(ticket.inputs, read.offset, size, input => inputLine(ticket, input, !!ticketId), resource)
      return { items, next_offset: next_offset ?? null }
    }
    // 其余 section 返回文本主体
    let body: string
    if (section === 'input' && part) {
      // Render the input on demand with its resolved source link, matching either its short key or full input ID.
      // 按需渲染某条输入：匹配其短键或完整输入 id；触发器类输入附解析好的来源链接
      const input = ticket.inputs.find(item => key(item.id) === part || item.id === part)
      // 触发器类输入取对应触发器
      const trigger = input?.kind === 'trigger' ? host.store.triggers.get(input.triggerId) : undefined
      // 渲染触发器消息卡（附来源链接与备注）
      const card = trigger && input?.kind === 'trigger' ? triggerMessage(trigger, await host.sourceLink(trigger, signal), input.note) : undefined
      // 依输入类型渲染最终消息文本
      const message = input && inputMessage(input, card)
      if (message === undefined) throw new Error('Unknown ticket input')
      body = message
    } else if (section === 'message' && part && /^\d+$/.test(part)) {
      // message/<n>：执行会话对话记录的第 n 条，投影为精简条目
      const event = (await transcript(host, id))[Number(part)]
      const entry = event && transcriptEntry(event)
      if (!entry) throw new Error('Unknown transcript entry')
      body = JSON.stringify(entry)
    } else if (section === 'report' && part) {
      // report/<assignment-id>：某条派工的报告摘要
      const report = ticket.assignments.find(item => item.id === part)?.report
      if (!report) throw new Error('Unknown assignment report')
      body = report.summary
    } else if (part !== undefined) throw new Error('Unknown context resource')
    // assignment：工单的派工指令原文
    else if (section === 'assignment') body = ticket.execution?.assignment ?? ''
    // result：最新报告摘要
    else if (section === 'result') body = latestReport(ticket)?.summary ?? ''
    else if (section === 'transcript') {
      // transcript：对话记录索引（新到旧），每条一行 JSON（含类型、80 字符预览、长度与读取路径）
      body = (await transcript(host, id)).flatMap((event, index) => {
        const entry = transcriptEntry(event)
        // 拼接消息文本（非文本块以 [类型] 占位）生成预览
        const said = entry?.message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(' ') ?? ''
        return entry ? [{ type: entry.type, preview: preview(said).slice(0, 80), chars: JSON.stringify(entry).length,
          read: `ticket/${id}/message/${index}` }] : []
      }).reverse().map(event => JSON.stringify(event)).join('\n')
    } else throw new Error('Unknown context resource')
    // 统一按文本分页返回
    return text(read, body)
  }],
]

/**
 * Read a paginated resource for the main Session or a ticket's worker Session.
 * Legacy prefixes (`event/`, `task/`, `observation/`) remain accepted so references in older Session history stay readable.
 */
// 读取入口：为主 Session 或某工单的 worker 会话读取分页资源。
// 旧前缀（event/、task/、observation/）仍被接受，使旧会话历史中的引用依然可读。
export async function readResource(host: ResourceHost, resource: string, offset: number, limit: number | undefined, ticketId?: string,
  signal?: AbortSignal) {
  // 把旧前缀归一化为新资源名
  const name = resource.replace(/^event\//, 'trigger/').replace(/^task\//, 'ticket/').replace(/^observation\//, 'decision/')
  // 按路由表匹配：带尾斜杠的路由按前缀匹配，否则精确匹配
  const route = ROUTES.find(([route]) => route.endsWith('/') ? name.startsWith(route) : name === route)
  if (!route) throw new Error('Unknown context resource')
  // 会话 id：worker 用其工单的执行会话，主会话用 masterId
  const sessionId = ticketId ? workerSessionId(ticketId) : host.masterId
  // 路由剩余段（前缀路由取前缀之后的部分）
  const rest = route[0].endsWith('/') ? name.slice(route[0].length) : ''
  // 组装 Read 上下文（可选字段按需展开）并调用路由处理器
  return route[1]({ host, resource: name, rest, offset, sessionId, ...limit ? { limit } : {}, ...ticketId ? { ticketId } : {},
    ...signal ? { signal } : {} })
}
