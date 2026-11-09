/**
 * Model surface contract tests: verify registered tools, system prompts, skills, and session inputs for the
 * orchestrator and worker roles against tool schemas, environment variables, glossary rules (`docs/001`), and size budgets.
 */
// 模型表面（model surface）契约测试：对编排者与 worker 两种角色，校验注册的工具、系统提示词、
// 技能与 Session 输入——工具 schema 的枚举值、环境变量名、术语表规则（docs/001）、禁用短语，以及体积预算。
// 测试策略：起一个完整 Runtime（假 DSH 宿主），驱动真实工作流让所有运行时生成的文本都产生一次，
// 收集全部“模型可见文本”逐条体检，任何漂移都对照 KNOWN_FAILURES 白名单。
import { Context } from '@deepseek-ai/cordis'
// cordis Context：服务容器，Runtime 经它取服务。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
// 临时目录与写文件。
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
// beforeAll/afterAll：整个文件共享一个 Runtime 实例。
import type { UserMessage } from '@deepseek-ai/dsh-llm'
// UserMessage：发给模型的用户消息。
import { latestAssignment } from '../src/core/index.ts'
// latestAssignment：工单最新一次派工。
import { promptParts } from '../src/app/prompts.ts'
// promptParts：按角色拼出提示词部件。
import { RESOURCES } from '../src/app/resources.ts'
// RESOURCES：orchestrator_read 可读的资源模板。
import { TICKET_STATES } from '../src/app/cards.ts'
// TICKET_STATES：工单卡片状态（文案里提到的状态必须是其中之一）。
import { Runtime } from '../src/app/runtime.ts'
// Runtime：被测的运行时宿主。
import { workerSessionId } from '../src/executor/dsh.ts'
// workerSessionId：工单对应 worker Session 的 id。
import { Store } from '../src/app/store.ts'
// Store：种子设置用。
import { Commands } from '../src/infra/commands.ts'
// Commands：mock 其 gh/lark/git/run 应答。
import { inputMessage } from '../src/executor/dsh.ts'
// inputMessage：把工单输入渲染成投递文本（用于匹配与命名）。
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
// 凭据助手定义与隔离 gitconfig 路径（供 git 检查应答）。
import { IM_WORDS, NOTE_WORDS, checkedImText } from '../src/infra/text.ts'
// IM_WORDS/NOTE_WORDS：文案声明的字数上限；checkedImText：即时消息文本的超限检查。
import { SettingsSchema } from '../src/policy.ts'
// SettingsSchema：设置解析。
import { feishuKind, feishuTrigger } from '../src/sources/feishu.ts'
// 飞书 kind 与触发器构造。
import { githubKind } from '../src/sources/github.ts'
// GitHub kind。
import { testMachine } from './fixtures/deployment.ts'
// testMachine：测试机器的部署信息。

type Role = 'orchestrator' | 'worker'
// 两种模型角色。
interface Surface { where: string; owner: string; role: Role | 'both'; text: string }
// 一个“模型可见文本”面：出处描述、归属模块、阅读角色、正文。
interface Tool {
  name: string; description: string; parameters: unknown
  execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>
}
// 工具的最小结构（名字、描述、参数 schema、执行函数）。
type Section = (context: { signal?: AbortSignal }) => string
// 系统提示词 section 函数。
interface Skill { name: string; description: string; content: string }
// 技能的结构。

/**
 * Maximum combined character count of system prompt and tool definitions per role (~5% above baseline).
 * Lower this limit when shrinking model-facing text; raise it only intentionally and explain why in the commit message.
 */
// 每角色“系统提示词 + 工具定义”的字符总量上限（约高出基线 5%）。
// 缩减模型可见文本时应下调；上调必须有明确理由并写进提交说明。
const BUDGET: Record<Role, number> = { orchestrator: 59_000, worker: 40_500 }
const PROMPTS = 'prompts/, skills/', TOOLS = 'src/app/tools/', SESSIONS = 'src/app/sessions.ts'
// 各文本面的归属模块路径。
const NOTICES = 'src/app/notices.ts', LINKS = 'src/app/links.ts', ASSESSMENT = 'src/app/assessment.ts'
const EXECUTOR = 'src/executor/dsh.ts', ERRORS = 'src/core/errors.ts'
const TICKETS = 'src/core/tickets.ts', ASSIGNMENTS = 'src/core/assignments.ts'
/** Regex patterns compiled from `orchestrator_read` resource templates (`<…>` matches one path segment; `…` matches the rest). */
// 由 orchestrator_read 资源模板编译出的正则（<…> 匹配一段路径，… 匹配其余）。
const RESOURCE_NAMES = RESOURCES.map(({ name }) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[^>]+>/g, '[^/\\s]+').replace('…', '.+')}$`))
/** Report and assignment states, which text names as such; a ticket or a worker is in one of the card states (TICKET_STATES). */
// 报告/派工状态词；工单或 worker 的状态必须用卡片状态（TICKET_STATES）。
const REPORT_WORDS = /^(ready|waiting|blocked|failed|progress|running|queued)$/
/** Retired terminology superseded by `docs/001`. */
// 被 docs/001 废弃的旧术语。
const LEGACY: [word: string, pattern: RegExp][] = [['reopen', /reopen/i], ['event/', /(?<![\w-])event\//], ['task/', /(?<![\w-])task\//],
  ['member', /\bmembers?\b/i], ['topic', /\btopics?\b/i], ['admission_', /\badmission_/], ['guide/', /\bguide\//]]
/** Disallowed phrases in generated or static model-facing text. */
// 模型可见文本中禁止出现的短语（按出处范围限定）。
const BANNED: [rule: string, where: RegExp, phrase: RegExp][] = [
  ['An out-of-scope proactive ticket ends as dropped', /^worker (prompt from the runtime|input assignment \(inferred\))$/, /report blocked/i],
  // 越界的主动工单应以 dropped 结束，worker 文本不得让工人报 blocked。
  ['A question goes back where the person who raised it wrote', /./, /always returns to the original|ask(?: promptly)? in the original ticket conversation/i],
  // 问题回到提问者原话处，不允许“永远回到原工单会话”这类表述。
  ['The main Session has no tool that messages a worker', /./, /request the answer through the worker/i],
  // 主 Session 没有给 worker 发消息的工具，不得让模型“通过 worker 要答案”。
  ['A stop goes through orchestrator_route, not through an assessment', /^assessment instructions$/, /decision=stop/i],
  // 停止走 orchestrator_route，评估指令里不得出现 decision=stop。
]
/** Known failures tolerated for now, by the file that owns the text; keep empty. */
// 暂时容忍的已知失败，按文本归属文件记录；应保持为空。
const KNOWN_FAILURES: [owner: string, failure: string][] = []

const MEMBER = 'ou_alice', CHAT = 'oc_team'
// 基准成员与会话。
const feishu = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT,
  chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, mentions: [{ id: 'ou_bot' }],
  create_time: String(Date.parse('2026-09-09T00:00:00Z') + Number(id) * 1000), ...overrides }, 'ou_bot', 'cli_bot')!
// 构造飞书群消息触发器（id 决定时间戳顺序）。
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/)
// 把文本切成句子（句末标点或换行处）。
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')
// 生成 count 个“word”的文本，用于字数上限测试。

/** Start a configured Runtime on a fake DSH host (as in tests/runtime.spec.ts) that records registered tools, prompts, skills, and delivered messages per session. */
// 在假 DSH 宿主上启动一个配置好的 Runtime（与 tests/runtime.spec.ts 同套路），
// 逐 Session 记录注册的工具、系统提示词 section、技能与投递的消息。
async function start() {
  const directory = mkdtempSync(join(tmpdir(), 'model-surface-'))
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  // 两个占位 CLI 可执行文件（路径作为应答匹配的键）。
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  // gh 查 user 返回 agent-bot，其余返回仓库信息；lark 返回成员名单。
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const answers: Record<string, string> = {
    // 子进程应答表：按整条 argv 匹配。
    [`git -C ${directory} rev-parse --show-toplevel`]: `${directory}\n`,
    [`git -C ${directory} remote get-url --push origin`]: 'https://github.com/acme/widgets.git\n',
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(AGENT)}\0`,
    ['git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$']:
      `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
    // git 凭据配置检查的应答：凭据只来自隔离 gitconfig（指向代理 CLI）。
  }
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  // DSH 输出读取器的假实现。
  const subprocess = { spawn: (spec: { argv: readonly string[] }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    // 跳过 env 与 VAR=... 前缀，再按整条命令查应答表。
    const collected = { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') }
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected }
  } }
  const agents = new Map<string, { status: string }>()
  // 假 agent 注册表。
  const tools = new Map<string, Map<string, Tool>>()
  // 每个 Session 注册的工具。
  const sections = new Map<string, Section>()
  // 每个 Session 的系统提示词 section。
  const skills = new Map<string, Skill[]>()
  // 每个 Session 注册的技能。
  const inputs: { sessionId: string; text: string }[] = []
  // 所有投递给 Session 的消息（含内容文本）。
  const create = async ({ sessionId }: { sessionId: string }) => {
    if (agents.has(sessionId)) return
    const agentCtx = new Context()
    const own = new Map<string, Tool>(), registered: Skill[] = []
    tools.set(sessionId, own); skills.set(sessionId, registered)
    const register = (tool: Tool) => { own.set(tool.name, tool); return () => own.delete(tool.name) }
    // 记录每个注册的工具，并返回注销函数。
    agentCtx.reflect.provide('tools', { register, get: () => undefined, restrict: () => () => {}, guard: () => () => {} })
    agentCtx.reflect.provide('skills', { register: (skill: Skill) => { registered.push(skill); return () => {} } })
    const section = (spec: { text: Section }) => { sections.set(sessionId, spec.text); return () => {} }
    agentCtx.reflect.provide('systemPrompt', { section })
    // 记录系统提示词 section 函数。
    const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
      // A pending message taken out, as DSH's inbox does by its id.
      // 按 id 取出一条待处理消息，模拟 DSH 收件箱的行为。
      remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
        const at = list.findIndex(message => message.id === id)
        if (at >= 0) list.splice(at, 1)
        return at >= 0
      }) }
    const record = (message: UserMessage) => {
      inputs.push({ sessionId, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
    }
    // 把消息内容拼成纯文本记录下来。
    const deliver = (queue: UserMessage[]) => (message: UserMessage) => {
      queue.push(message); record(message); agents.get(sessionId)!.status = 'running'
    }
    // followup/steer 共用：入队 + 记录 + 置为运行中。
    const session = { id: sessionId, snapshotEvents: () => [], requestHeader: () => undefined, append: () => {} }
    agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver(inbox.nextTurn), steer: deliver(inbox.nextStep),
      inject: record, status: 'idle', cancel: () => {}, whenIdle: async () => {}, session } as never)
  }
  const resolveAgent = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const ctx = new Context()
  const history = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
  // 空历史持久化。
  const services = { agents, llm: { resolveCallConfig: async (value: unknown) => value },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) },
    sessionController: { create, resolveAgent, selectModel: async () => {}, rename: async () => {}, inspect: async () => ({ events: [] }) },
    sessionPersistence: { flush: async () => {}, open: async () => history }, permissionPresets: { set: () => {} }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} } }
  // Runtime 需要的全部服务，均以假实现提供。
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  const seed = new Store(join(directory, 'orchestrator.sqlite'))
  const github = { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }
  seed.saveSettings(SettingsSchema.parse({ ...seed.settings(), sources: { github, feishu: { enabled: true, config: { cli: BOT } } } }))
  // 预置两个 Source 的启用设置（Runtime 启动前写入）。
  seed.close()
  const runtime = new Runtime(ctx, testMachine({ stateDir: directory }), () => {})
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  const allowed = { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } }
  const feishuSource = { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } }
  runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: allowed }, eval: { ...settings.eval, mode: 'auto' },
    sources: { ...settings.sources, feishu: feishuSource } })
  // 配置准入名单、auto 评估模式与监听群。
  const run = async (sessionId: string, name: string, args: unknown) =>
    await tools.get(sessionId)!.get(name)!.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
  // 直接调用某 Session 上的工具。
  const stop = async () => { await runtime.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  return { ctx, runtime, agents, tools, sections, skills, inputs, run, stop }
}
type Host = Awaited<ReturnType<typeof start>>

/** Exercise the orchestrator and worker workflows so all runtime-generated prompt sections, cards, notices, and errors are emitted. */
// 驱动一遍编排者与 worker 的完整工作流，让所有运行时生成的提示词、卡片、通知与错误都真正产生一次。
async function drive(host: Host) {
  const { runtime, run } = host
  const master = runtime.masterId
  // Candidates wait, which the main Session decides in one call: a request it accepts, thanks it ignores, and plain chat in the
  // channel, a proactive candidate whose card shows it touches no rule, which it ignores from its card.
  // 候选等待主 Session 一次路由定夺：受理一个请求、忽略道谢与闲聊；主动候选从卡片即可判定忽略。
  const request = feishu('1', '@bot 修一下回归'), thanks = feishu('3', '@bot 谢谢'), chat = feishu('4', '中午吃什么', { mentions: [] })
  await runtime.receive(request); await runtime.receive(thanks); await runtime.receive(chat)
  const routed = await run(master, 'orchestrator_route', { decisions: [
    { kind: 'accept', trigger_id: request.id, title: '修复回归', worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' },
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' }, { kind: 'ignore', trigger_id: chat.id, reason: 'Lunch chat.' }] }) as
    { results: { decision?: string; reason?: string; ticket?: { ticket_id: string } }[] }
  expect(routed.results.map(result => result.decision)).toEqual(['accept', 'ignore', 'ignore'])
  expect(routed.results[2]!.reason).toMatch(/^Ignored from its card/)
  // 闲聊候选直接凭卡片忽略。
  const a = routed.results[0]!.ticket!.ticket_id
  const answer = { trigger_id: request.id, purpose: 'answer', text: '是配置。' }
  const refusal = await run(master, 'orchestrator_reply', answer).then(() => '', (error: Error) => error.message)
  // 故意让 orchestrator_reply 拒绝“只回答案不回评估”，收集其错误文案作为受检文本。
  const proposal = feishu('5', '把副标题改成“浏览网页”', { mentions: [] })
  await runtime.receive(proposal)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_5', chat_id: CHAT }] })
  // lark 补充应答：把消息 om_5 关联到会话。
  await run(master, 'orchestrator_eval', { trigger_id: proposal.id })
  const proactive = (await run(master, 'orchestrator_eval_decide', { trigger_id: proposal.id, decision: 'accept', title: '文案修订', worktree_name: 'copy-fix',
    scope: '改副标题', reason: 'explicit copy change', intent_evidence: 'quoted', acknowledgement: '收到，把副标题改成“浏览网页”。',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy change' }, { rule_id: 'visual', matched: false, reason: 'not visual' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'it names the text' } })).ticket as { ticket_id: string }
  // 主动工单的受理走完整评估参数（规则评估、意图方向）。
  const b = proactive.ticket_id
  await runtime.idle()
  const [workerA, workerB] = [a, b].map(workerSessionId) as [string, string]
  await run(workerA, 'orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' })
  await run(workerA, 'orchestrator_report', { state: 'progress', summary: 'It reads the config.', human_action: null, reply_to_trigger_id: request.id })
  // worker 发进度报告（一次带人类动作，一次回复触发消息）。
  const other = feishu('9', '@bot 顺便看看这个')
  await runtime.receive(other)
  await run(master, 'orchestrator_route', { decisions: [{ kind: 'attach', ticket_id: a, trigger_id: other.id }] })
  // 主 Session 把消息挂到工单 a。
  await run(workerA, 'orchestrator_thread_unrelated', { thread: `feishu:${CHAT}:om_9`, reason: 'It asks for something else.' })
  await run(workerA, 'orchestrator_thread_follow', { thread: `feishu:${CHAT}:om_7`, reason: 'The same settings page.' })
  // worker 声明线程无关并关注另一线程（产生 thread_unrelated/thread_followed 通知文本）。
  await runtime.receive(feishu('7', '@bot 这个页面的按钮也改一下'))
  const beyond = feishu('8', '另外把导出也做了', { mentions: [], root_id: 'om_1' })
  await runtime.receive(beyond)
  await runtime.idle()
  await run(workerA, 'orchestrator_trigger_handback', { trigger_id: beyond.id, reason: 'It asks for an export feature.' })
  // worker 把超出范围的跟进交还（产生 handback 候选文本）。
  await run(master, 'orchestrator_ticket_note', { ticket_id: a, text: 'Ticket B changes the same settings page.' })
  // 主 Session 给工单 a 留言（note 输入文本）。
  await runtime.pump()
  await runtime.idle()
  await run(workerA, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  await runtime.receive(feishu('2', '再加一个按钮', { mentions: [], root_id: 'om_1' }))
  await vi.waitFor(async () => {
    await runtime.pump()
    expect(runtime.store.tickets.get(a)!.inputs.some(input => input.kind === 'resumed')).toBe(true)
  })
  // 新消息恢复已结束的工单（resumed 输入文本）。
  const policy = runtime.store.settings().policy
  // The rule ticket b was accepted under changes, so its worker is told how; the one it was not is disabled, which tells no one.
  // 工单 b 受理所依据的规则被修改（通知其 worker）；与其无关的规则被禁用（不通知）。
  const rules = policy.rules.map(rule => rule.id === 'visual' ? { ...rule, enabled: false }
    : rule.id === 'copy' ? { ...rule, instruction: `${rule.instruction} Keep the wording short.` } : rule)
  await runtime.settings.save('policy', { ...policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  // Worker b's turn ends: it is idle, as DSH says when it emits the event.
  // worker b 的回合结束：按 DSH 的说法置为 idle 并发出事件。
  host.agents.get(workerB)!.status = 'idle'
  host.ctx.emit('agent/status', { agent: host.agents.get(workerB), status: 'idle' } as never)
  await vi.waitFor(() => expect(latestAssignment(runtime.store.tickets.get(b)!)?.report?.state).toBe('waiting'))
  runtime.engine.requestStatus(b)
  // Resume runs once the status request reached the worker (whose Assignment is then busy rather than settled), so it gets the recovery note.
  // 状态请求到达 worker 后（其派工处于忙而非结算态）才恢复，因此它能收到恢复说明（recovery 输入文本）。
  await runtime.idle()
  expect(runtime.store.tickets.get(b)!.undelivered).toEqual([])
  runtime.executor.resume()
  await runtime.pump()
  await runtime.idle()
  return { a, b, workerA, workerB, refusal }
}

function walk(node: unknown, visit: (node: Record<string, unknown>, property?: string) => void, property?: string): void {
  // 深度遍历 JSON schema：访问每个对象节点，并携带其属性名（enum 归属哪个参数）。
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, property); return }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  visit(record, property)
  for (const [name, value] of Object.entries(record)) {
    const properties = name === 'properties' && value && typeof value === 'object' ? Object.entries(value) : undefined
    if (properties) for (const [child, schema] of properties) walk(schema, visit, child)
    else walk(value, visit, ['anyOf', 'oneOf', 'allOf', 'items'].includes(name) ? property : undefined)
    // properties 展开时带上子属性名；组合关键字（anyOf 等）沿用当前属性名。
  }
}

/** Collect all model-visible text surfaces (prompt sections, tool schemas, skills, errors, and session inputs) with their owning module. */
// 收集全部模型可见文本面（提示词、工具 schema、技能、错误、Session 输入），并标注归属模块。
function collect(host: Host, { a, b, workerA, workerB, refusal }: Awaited<ReturnType<typeof drive>>): Surface[] {
  const { runtime } = host
  const surfaces: Surface[] = []
  const config = runtime.prompts.current().config
  const shared = new Set(['runtime/shared', 'communication', 'scope', 'delivery', 'runtime/subscriptions', 'runtime/replies'])
  // 两种角色共读的部件名。
  for (const [role, sessionId] of [['orchestrator', runtime.masterId], ['worker', workerA], ['worker', workerB]] as const) {
    const parts = promptParts(config, role)
    for (const { name, text } of parts) {
      surfaces.push({ where: `${role} prompt ${name}`, owner: PROMPTS, role: shared.has(name) ? 'both' : role, text })
    }
    // The revision line, the execution environment and the note on a proactive ticket come from the runtime.
    // 版本行、执行环境说明与主动工单备注由运行时生成（非 prompts 模板）。
    const generated = parts.reduce((text, part) => text.replace(part.text, ''), host.sections.get(sessionId)!({}))
    surfaces.push({ where: `${role} prompt from the runtime`, owner: SESSIONS, role, text: generated })
  }
  for (const [role, sessionId] of [['orchestrator', runtime.masterId], ['worker', workerA]] as const) {
    for (const tool of host.tools.get(sessionId)!.values()) {
      const descriptions = [tool.description]
      walk(tool.parameters, node => { if (typeof node.description === 'string') descriptions.push(node.description) })
      // 工具描述与其参数 schema 里的一切描述都算受检文本。
      surfaces.push({ where: `${role} tool ${tool.name}`, owner: TOOLS, role, text: descriptions.join('\n') })
    }
  }
  for (const { name, description, content } of host.skills.get(runtime.masterId)!) {
    surfaces.push({ where: `skill ${name}`, owner: PROMPTS, role: 'both', text: `${description}\n${content}` })
  }
  surfaces.push({ where: 'orchestrator tool orchestrator_reply error', owner: ERRORS, role: 'orchestrator', text: refusal })
  for (const { text } of host.inputs.filter(input => input.sessionId === runtime.masterId)) {
    const value = JSON.parse(text) as Record<string, unknown>
    const kind = String(value.kind ?? Object.keys(value)[0])
    const owner = kind === 'candidate' ? LINKS : kind === 'worker_attention' ? TOOLS : kind === 'worker_report' ? EXECUTOR : NOTICES
    // 主 Session 的每种输入按 kind 归属其生成模块。
    surfaces.push({ where: `orchestrator input ${kind}`, owner, role: 'orchestrator', text })
  }
  for (const [id, sessionId] of [[a, workerA], [b, workerB]] as const) {
    const ticket = runtime.store.tickets.get(id)!
    const assignment = ticket.execution!.assignment
    surfaces.push({ where: `worker input assignment (${ticket.mandate.strength})`, owner: EXECUTOR, role: 'worker', text: assignment })
    // 派工说明本身（显式/推断两种强度）也是受检文本。
    const card = (text: string) => { try { return JSON.parse(text) as Record<string, unknown> } catch { return undefined } }
    for (const { text } of host.inputs.filter(input => input.sessionId === sessionId)) {
      const input = ticket.inputs.find(item => item.kind === 'trigger' ? card(text)?.trigger_id === item.triggerId
        : inputMessage(item) === text)
      // 把投递文本对应回工单输入：触发输入按 trigger_id，其余按渲染文本。
      if (!input) continue
      // Text inputs are named by their id prefix; the restart note's id is a content hash, so it is named by its text.
      // 文本输入按 id 前缀命名；重启说明的 id 是内容哈希，只能按文本识别。
      const kind = input.kind === 'trigger' ? input.context ? 'trigger (context)' : 'trigger' : input.kind !== 'text' ? input.kind
        : input.id.includes(':') ? input.id.split(':')[0]! : /host restarted/i.test(input.text) ? 'recovery' : 'text'
      const owner = kind === 'status' ? TICKETS : kind === 'recovery' ? ASSIGNMENTS : EXECUTOR
      surfaces.push({ where: `worker input ${kind}`, owner, role: 'worker', text })
    }
  }
  return surfaces
}

let host: Host
let sessions: Awaited<ReturnType<typeof drive>>
let surfaces: Surface[]
beforeAll(async () => {
  host = await start()
  sessions = await drive(host)
  surfaces = collect(host, sessions)
  // 整个文件先起运行时、驱动工作流、收集文本面，再逐用例检查。
})
afterAll(async () => { await host?.stop() })
const toolsOf = (role: Role) => host.tools.get(role === 'orchestrator' ? host.runtime.masterId : sessions.workerA)!
// 按角色取其工具表。

/** Check collected surfaces for unregistered tools, invalid enum options, legacy terms, banned phrases, and cross-role tool references. */
// 对收集到的文本面做全套检查：未注册工具、非法枚举、旧术语、禁用短语、跨角色工具引用等。
function failures(): Map<string, string> {
  const found = new Map<string, string>()
  const options = new Map<string, Set<string>>()
  const schemas = [...toolsOf('orchestrator').values(), ...toolsOf('worker').values()].map(tool => tool.parameters)
  walk(schemas, (node, property) => {
    if (property && Array.isArray(node.enum)) options.set(property, new Set([...options.get(property) ?? [], ...node.enum.map(String)]))
  })
  // 汇总所有 schema 里的枚举选项（按参数名）。
  for (const name of ['decision', 'purpose', 'state']) expect(options.has(name), `${name} has options`).toBe(true)
  // 前置校验：三个关键参数确实有枚举。
  const tools = { orchestrator: new Set(toolsOf('orchestrator').keys()), worker: new Set(toolsOf('worker').keys()) }
  const registered = (token: string) => tools.orchestrator.has(token) || tools.worker.has(token)
  const variables = new Set(host.runtime.ticketEnvironment(host.runtime.store.tickets.get(sessions.a)!).map(variable => variable.key))
  // 工单实际会拿到的环境变量名集合。
  for (const { where, owner, role, text } of surfaces) {
    const fail = (problem: string) => found.set(`${where}: ${problem}`, owner)
    for (const [token] of text.matchAll(/\borchestrator_[a-z_]+/g)) if (!registered(token)) fail(`${token} is not a tool`)
    // 文本提到的工具必须真的注册过。
    for (const [, name, values] of text.matchAll(/\b([a-z_]+)[=:] ?([a-z][a-z/-]*)/g)) {
      for (const value of options.has(name!) ? values!.split('/') : []) {
        if (!options.get(name!)!.has(value)) fail(`${name}=${value} is not an option`)
      }
    }
    // 文本里 name=value 形式的取值必须是 schema 枚举里的合法选项。
    for (const [word, pattern] of LEGACY) if (pattern.test(text)) fail(`legacy word "${word}"`)
    for (const [rule, scope, phrase] of BANNED) if (scope.test(where) && phrase.test(text)) fail(`breaks "${rule}"`)
    for (const [name] of text.matchAll(/\bDSH_SUPERAGENT_[A-Z][A-Z_]*[A-Z]\b/g)) if (!variables.has(name)) fail(`${name} is not a variable`)
    // 提到的 DSH_SUPERAGENT_* 环境变量必须真实存在。
    // A ticket's or worker's state is a card state; a report state is named with the word report.
    // 工单/worker 的状态必须用卡片状态词；报告状态必须带 report 字样。
    const states = [...text.matchAll(/\b([a-z]+(?:\/[a-z]+)*) (?:tickets?|workers?)\b/g), ...text.matchAll(/\b(?:tickets?|workers?) (?:is|are)(?: still)? ([a-z]+)\b/g)]
    for (const [phrase, word] of states) {
      if (word!.split('/').some(part => REPORT_WORDS.test(part)) && !(TICKET_STATES as readonly string[]).includes(word!)) fail(`"${phrase}" is not a card state`)
    }
    for (const [phrase] of text.matchAll(/\bwait(?:ing)? for (?:ready|waiting|blocked|failed)\b(?! report)/g)) fail(`"${phrase}" names a report state without report`)
    // “等待 ready/waiting/...”这类说法漏掉了 report，要修。
    for (const [found] of text.matchAll(/\b(?:ticket|trigger|decision|prompts|prompt-preview|models|feishu|github)\/[^\s"'`,;)\]]*/g)) {
      const name = found.replace(/[.:]+$/, '')
      if (!RESOURCE_NAMES.some(pattern => pattern.test(name))) fail(`${name} is not a resource orchestrator_read reads`)
    }
    // 文本引导模型读的路径必须是 orchestrator_read 的资源模板之一。
    // Text only one role reads names the other role's tools only in a sentence that says the other role uses them.
    // 单角色文本提到对方工具时，只能出现在说明“那是对方在用”的句子里。
    const other = role === 'orchestrator' ? 'worker' : role === 'worker' ? 'orchestrator' : undefined
    const names = other === 'worker' ? /\b(workers?|executors?)\b/i : /\b(orchestrator|main session)\b/i
    for (const sentence of sentences(text)) {
      for (const [, count] of sentence.matchAll(/\b(\d+)[- ]words?\b/g)) {
        const limit = /routing/i.test(sentence) ? NOTE_WORDS : IM_WORDS
        if (Number(count) !== limit) fail(`"${count} words" is not ${limit}`)
      }
      // 文本自己声明的字数上限必须与常量一致（routing 说明用 NOTE_WORDS，即时消息用 IM_WORDS）。
      for (const [token] of other && !names.test(sentence) ? sentence.matchAll(/\borchestrator_[a-z_]+/g) : []) {
        if (!registered(token) || tools[role as Role].has(token)) continue
        fail(`tells the ${role} to use ${token}, which only the ${other} has`)
      }
    }
  }
  return found
}

it('collects both roles\' tools, prompts, skills and inputs', () => {
  // 元测试：确认收集器确实覆盖了两角色的工具与全部关键文本面。
  expect([...toolsOf('worker').keys()].sort()).toEqual(['orchestrator_ack', 'orchestrator_read', 'orchestrator_report',
    'orchestrator_thread_follow',
    'orchestrator_thread_unrelated', 'orchestrator_trigger_handback'])
  // worker 恰好拥有这六个工具。
  expect([...toolsOf('orchestrator').keys()]).toEqual(expect.arrayContaining(['orchestrator_route', 'orchestrator_eval_decide', 'orchestrator_reply']))
  // The one routing tool takes the place of four.
  // 一个 orchestrator_route 取代了四个路由工具。
  for (const name of ['orchestrator_ticket_accept', 'orchestrator_ticket_attach', 'orchestrator_ticket_stop', 'orchestrator_trigger_ignore']) {
    expect(toolsOf('orchestrator').has(name)).toBe(false)
  }
  const wheres = new Set(surfaces.map(surface => surface.where))
  for (const where of ['orchestrator prompt runtime/dispatch', 'worker prompt runtime/work', 'skill dsh-superagent-github', 'skill dsh-superagent-feishu',
    'orchestrator prompt runtime/admission', 'orchestrator input candidate', 'orchestrator input worker_attention', 'orchestrator input worker_report',
    'orchestrator input thread_unrelated', 'orchestrator input ticket_ended', 'orchestrator input settings_saved', 'worker input assignment (explicit)',
    'worker input assignment (inferred)', 'worker input policy-changed', 'worker input resumed', 'worker input status',
    'worker input recovery', 'worker input note', 'worker input trigger (context)', 'orchestrator input follow_up',
    'orchestrator input thread_followed', 'orchestrator tool orchestrator_reply error']) expect(wheres).toContain(where)
  // 所有预期的文本面（提示词/技能/各类输入与错误）都被收集到。
  expect(sessions.refusal).not.toBe('')
  // orchestrator_reply 的拒绝错误确实发生了。
})

it('names only registered tools, schema options, environment variables and glossary words, with the enforced word limits', () => {
  // 契约主测试：检查结果必须与 KNOWN_FAILURES 白名单一致——新问题要修，已修的要从白名单移除。
  const found = failures(), known = new Map(KNOWN_FAILURES.map(([owner, failure]) => [failure, owner]))
  const drift = [...found].filter(([failure]) => !known.has(failure)).map(([failure, owner]) => `${owner}: ${failure}`)
  const fixed = [...known].filter(([failure]) => !found.has(failure))
    .map(([failure, owner]) => `${owner}: ${failure} (fixed: drop it from KNOWN_FAILURES)`)
  expect([...drift, ...fixed], 'model-facing text differs from KNOWN_FAILURES; each line starts with the owner of the text').toEqual([])
})

it('enforces the word limits the text states', async () => {
  // 运行时也要真执行字数上限：即时消息超限抛错；路由备注超限只拒绝该条目。
  expect(checkedImText(words(IM_WORDS))).toBe(words(IM_WORDS))
  expect(() => checkedImText(words(IM_WORDS + 1))).toThrow(`maximum is ${IM_WORDS}`)
  const attach = (note: string) =>
    host.run(host.runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'attach', ticket_id: 'unknown', trigger_id: 'unknown', note }] })
  // A note over the limit refuses its item alone; one at the limit goes on to the Engine, which knows no such ticket.
  // 超限的 note 只拒绝该条目；恰好达限的通过校验，进入 Engine 后因工单不存在而报未知。
  expect(await attach(words(NOTE_WORDS + 1))).toEqual({ results: [expect.objectContaining({ refused: expect.stringContaining(`${NOTE_WORDS} words`) })] })
  expect(await attach(words(NOTE_WORDS))).toEqual({ results: [expect.objectContaining({ refused: expect.stringMatching(/Unknown (ticket|trigger)/) })] })
})

/** The enabled rules' lines of the main Session's Policy section, as the settings hold them now. */
// 主 Session 政策节中“启用规则”的行，与设置里的当前状态一致。
const ruleLines = () => host.runtime.store.settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`)
it.each(['orchestrator', 'worker'] as const)('keeps the %s within its character budget', role => {
  // 预算测试：提示词 + 工具定义的字符总量不超过 BUDGET。
  const ids = role === 'orchestrator' ? [host.runtime.masterId] : [sessions.workerA, sessions.workerB]
  // Strip machine-dependent variable values (such as directory paths), and the team's rules, before measuring prompt length.
  // 度量前剔除依赖机器的变量值（如目录路径）与团队规则行，保证基线稳定。
  const builtIn = (text: string) => ruleLines().reduce((rest, line) => rest.replace(line, ''), text).replace(/ = "[^"\n]*"/g, ' = ""')
  const prompt = Math.max(...ids.map(id => builtIn(host.sections.get(id)!({})).length))
  const definitions = [...toolsOf(role).values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  const tools = JSON.stringify(definitions).length
  expect(prompt + tools, `${prompt} characters of prompt and ${tools} of tools`).toBeLessThanOrEqual(BUDGET[role])
})

it('keeps the routing rules in dispatch, which says the main Session may accept the rest of a stop message as new work', () => {
  // 路由规则的归属：stop 消息的剩余部分可受理为新工作——这条规则要写在 dispatch 提示词里，而非工具描述。
  const route = toolsOf('orchestrator').get('orchestrator_route')!.description
  const dispatch = surfaces.find(surface => surface.where === 'orchestrator prompt runtime/dispatch')!.text
  expect(dispatch).toContain('you may accept the rest of the message as new work')
  expect(dispatch).toContain('decide those whose card already settles them in one orchestrator_route call')
  // dispatch 同时说明可一次性凭卡片定夺。
  expect(route).not.toMatch(/needs a new ticket on another explicit instruction/)
  // 工具描述里不得残留与之矛盾的旧规则。
})

it('lists in the main Session\'s Policy section exactly the enabled rules, as the drive\'s save left them', () => {
  // 政策节逐行列出且仅列出启用的规则，与 drive 中的设置保存结果一致。
  const text = host.sections.get(host.runtime.masterId)!({}), at = text.indexOf('## Policy')
  const listed = text.slice(at, text.indexOf('\n\n', at)).split('\n').filter(line => line.startsWith('- '))
  expect(listed).toEqual(ruleLines())
  // The drive disabled the visual rule and changed the copy rule's instruction.
  // drive 已禁用 visual 规则并修改了 copy 规则的指令。
  expect(listed).toEqual([expect.stringMatching(/^- .* \(copy\): .*Keep the wording short\.$/)])
  // 只剩 copy 一条启用规则，且指令含追加内容。
})
