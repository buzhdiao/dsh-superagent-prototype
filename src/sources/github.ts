/** GitHub source kind definition, notification and repository polling loops, and Cordis plugin entry. */
// GitHub Source：kind 定义、通知与仓库轮询循环、Cordis 插件入口。
// 监听方式：以 agent 账号 gh 通知 API 为主干（谁 @ 了它），叠加四类"观察"开关
// （新 Issue / 新 PR / 评论 / 默认分支 CI——未点名也收，由 Policy 准入表决定成不成候选），
// 再加上对"工单对应的 PR + CI"与"已订阅 Thread"的轮询。
import type { Context } from '@deepseek-ai/cordis'
import { key, type Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GithubAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { ciCounts, ciFact, ciFailures, ciSummary, githubThreadContext, pullChecks } from './github-read.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, CommentSchema, githubAddress, issueTrigger, IssueSchema, pullTrigger, SOURCE }
  from './github-trigger.ts'
import { githubLink, sendGithub } from './github-channel.ts'
import type { GithubComment, PullRef } from './github-trigger.ts'
import { observePull, pullsOf, readPull, type Pull } from './github-pull.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'
import { z } from 'zod'

export { commentTrigger, type GithubComment } from './github-trigger.ts'
/** A notification of the agent account; `subject.url` is the API address of its Issue or PR. */
// NotificationSchema：agent 账号的一条通知——repository.full_name + subject.url（Issue/PR 的 API 地址）。
// looseObject：多余字段忽略（GitHub 通知字段很多，只取所需）。
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }), subject: z.looseObject({ url: z.string().nullish() }),
})

// GithubConfigSchema：GitHub 实例配置——账号（repository/cli 继承自账号 schema）、
// 轮询间隔、连续失败阈值，以及四个"观察"开关。
const GithubConfigSchema = GithubAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false) }).strict()
export type GithubConfig = z.infer<typeof GithubConfigSchema>
// OBSERVED：范围名 → 配置开关的映射。
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
// scopeOf：从 Trigger 的 meta 推断它属于哪个接收范围（决定"观察"开关是否覆盖它）。
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}
// githubKind：GitHub 的 SourceKind 定义（配置/表单/监听规则/通道/上下文/策略部分/环境变量）。
export const githubKind: SourceKind<GithubConfig> = {
  kind: SOURCE,
  title: { zh: 'GitHub', en: 'GitHub' },
  description: { zh: '智能体的 GitHub 账号；接收仓库里发给它的通知、已订阅 Issue 与 PR 的讨论、CI 状态变化和 PR 合并关闭。', en: 'The agent\'s GitHub accounts; receives notifications to it in the repository, discussion on subscribed Issues and PRs, CI changes, and PR merge or close.' },
  schema: GithubConfigSchema,
  // fields：面板表单——仓库、agent 的 gh CLI、轮询参数（高级）、四个观察开关。
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。这个来源接收这个仓库的通知和讨论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'Written owner/name. This Source receives the repository\'s notifications and discussion; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitHub CLI', en: 'Agent GitHub CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GH_CONFIG_DIR 登录智能体账号的 gh 包装脚本。智能体以它登录的账号行事，执行器以 gh 调用它。保存时检查它登录的账号能否推送到仓库，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a gh wrapper signed in to the agent account through GH_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as gh. Saving checks that this account can push to the repository, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, hint: { zh: 'GitHub 要求更长间隔时以 GitHub 为准。', en: 'A longer interval requested by GitHub wins.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and review comments on Issues and PRs that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' },
      hint: { zh: '打开后，默认分支的 CI 失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s CI, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } }],
  // What the Source observes across the repository it receives in full; elsewhere, only what addresses the agent.
  // scope：本 Source 的监听规则——观察开关打开的范围整仓全收（observed=true）；
  // 其余范围只收"点名 agent"的（通知本来就是发给它的）。
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  // health：本 kind 独占的健康条目名。
  health: ['github'],
  // channel：回写通道（评论/评审回复）与链接构造。
  channel: { send: sendGithub, link: githubLink },
  // threadContext：评估时的有界 Thread 读取器（Issue/PR 会话分页）。
  threadContext: githubThreadContext,
  // `#12`, `12`, or the page of an Issue or PR, of any repository, names Thread 12.
  // find：搜索词 → Thread（支持 #12、12、Issue/PR 页面 URL）。
  find: query => {
    const number = (/^#?(\d+)$/.exec(query.trim()) ?? /github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)/.exec(query))?.[1]
    return { threads: number ? [`${SOURCE}:${number}`] : [], terms: [] }
  },
  // policy：GitHub 的 Policy 部分——允许名单（可发起工作的账号）与 bot 名单（评论可成候选的机器人）。
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+(\[bot\])?$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitHub 账号', en: 'GitHub accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号（例如 dependabot[bot]）的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收仓库里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list, such as dependabot[bot], becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the repository on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+(\\[bot\\])?' }] }],
    // explicit：GitHub 上"点名 agent"= 在 Issue 或评论里 @ agent 账号。
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    // rows：把配置渲染成准入表行视图（各范围：全部 / 仅 @）。
    rows(stored) {
      const config = GithubConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        // CI 没有发送者，所以准入表里只有"名单外未点名"格子有意义。
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  // environment：向 worker 执行环境注册的变量（仓库名、agent 账号、提交邮箱、Issue/PR 编号、PR head 引用）。
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '这个来源监听的仓库，owner/name。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The repository this Source watches, as owner/name. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITHUB_ACCOUNT', description: { zh: '智能体的 GitHub 账号；gh 以它登录，除自动合并外的 GitHub 操作都用 gh，不用其他账号或凭据', en: 'The agent\'s GitHub account. gh is signed in to it; use gh for every GitHub operation except auto-merge, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 GitHub 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on GitHub' } },
      { key: 'DSH_SUPERAGENT_GITHUB_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
    ],
    // values：从部署信息与触发消息计算变量值。
    values: ({ deployment, trigger }) => {
      const number = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITHUB_REPOSITORY: deployment.repository, DSH_SUPERAGENT_GITHUB_ACCOUNT: deployment.github.login, DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: deployment.github.noreply, DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
    },
  },
  // facts：setup 完成后显示的只读状态（当前登录账号）。
  facts: (deployment): Record<string, Localized | string> => deployment ? {
    cli: { zh: `当前账号 @${deployment.github.login}`, en: `Current account @${deployment.github.login}` },
  } : {},
}
// 插件名与注入的服务（orchestrator = Runtime 以 SourceHost 形式注入）。
export const name = 'dsh-superagent-github'
export const inject = ['orchestrator']
// apply：Cordis 插件入口——注册 kind + 启动轮询循环（停止时中止并等待收尾）。
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(githubKind), 'github: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, githubKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    // 未处理 rejection 会杀死 DSH 进程——逃出轮询循环的失败改记为 Source 健康，而不是让它飞出去。
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('github', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
// pollFailure：连续失败达到阈值才报 error 健康——单次网络抖动保持安静。
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
// watch：轮询主循环——setup 未完成则挂起等待重启；每轮跑 pollRound，失败计数，按间隔停顿。
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('github', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GithubConfig>(SOURCE)
    try {
      // 每轮重读配置（改动即时生效）；没配置（关闭）则报 paused。
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('github', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('github', failed)
    }
    // 停顿：取"GitHub 要求的间隔"与配置间隔的较大者。
    await pause(Math.max(interval, ctx.config<GithubConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
// Round：一轮轮询的状态——开始时间、中止信号、PR 读取去重、已读集合、失败/丢弃清单、跳过计数。
interface Round {
  started: string; signal?: AbortSignal | undefined
  pulls: Map<number, Promise<Pull>>; read: Set<number>; failures: string[]; dropped: number[]; abandoned: number[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Map(), read: new Set(),
  failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
// stopped：一轮中途的停止检查——信号中止，或 Source 已被关闭。
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
// Retry：一次失败的待重读记录——起因时间、是否 PR、失败时间、尝试次数。
export interface Retry { since: string; pr: boolean; failedAt?: string; attempts?: number }
// RETRY_WINDOW_MS：重试放弃窗口（24 小时）——永久读不了的 Thread 不把健康条目永远钉在 error。
const RETRY_WINDOW_MS = 24 * 3600_000
/** True when GitHub returns HTTP 410 (Gone); HTTP 404 is retried because it can indicate revoked access to a private repository. */
// deleted：HTTP 410 = 确已删除；404 要重试（可能是私有仓库的访问被撤销，以后会恢复）。
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410
/** Records a failed read on the Thread and in the round; deleted (410) or abandoned (24h+) threads do not fail the round. */
// failed：把一次读失败记到 Thread（pollError，面板可见）与本轮清单——
// 410 与超窗放弃不算轮失败；其余进 failures（累计到阈值才报健康）。
function failed(ctx: SourceContext, round: Round, number: number, error: unknown, abandoned = false): void {
  if (deleted(error)) round.dropped.push(number)
  else if (abandoned) round.abandoned.push(number)
  else round.failures.push(`#${number}: ${String(error)}`)
  ctx.threads.patch(`github:${number}`, { pollError: String(error) })
}
// included：把 gh --include 的原始输出拆成 HTTP 头与响应体。
function included(raw: string): { headers: string; body: string } {
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  return { headers: raw.slice(0, split), body: raw.slice(split).trim() }
}
// ListedSchema：仓库级列表项（评论项带 issue_url / pull_request_url 供回溯所属编号）。
const ListedSchema = CommentSchema.extend({ issue_url: z.string().nullish(), pull_request_url: z.string().nullish() })
/** Repository-wide event streams; GitHub's `/issues` endpoint includes PRs, and `/issues/comments` covers issue and PR conversation comments (excluding inline review comments). */
// STREAMS：仓库级事件流——/issues（含 PR）、会话评论、行内评审评论。
const STREAMS = [
  { id: 'issues', observed: (config: GithubConfig) => config.observeIssues || config.observePulls, path: 'issues?state=all' },
  { id: 'comments', observed: (config: GithubConfig) => config.observeComments, path: 'issues/comments?' },
  { id: 'review-comments', observed: (config: GithubConfig) => config.observeComments, path: 'pulls/comments?' },
] as const
/** Polls repository-wide streams (new Issues/PRs, comments, default-branch CI); each stream reads from when it was switched on, resets when switched off, and fails independently. */
// pollRepository：轮询仓库级流（新 Issue/PR、评论、默认分支 CI）——
// 每个流从"开关打开的时刻"开始读，关闭即清状态，各自独立失败。
async function pollRepository(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GithubConfig>(SOURCE)
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    // 开关关闭：清掉该流的状态（下次打开从头开始）。
    if (!stream.observed(config)) { ctx.state.set(KV.github.stream(stream.id), undefined); continue }
    try { await readStream(ctx, round, stream.id, stream.path, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  // When CI observation is turned off, clear the failure baseline but preserve the revision counter so future triggers have unique IDs.
  // CI 观察关闭：清失败基线，但保留 revision 计数（保证将来 Trigger id 唯一）。
  if (!config.observeCi) {
    const seen = ctx.state.get(KV.github.branchCi)
    ctx.state.set(KV.github.branchCi, seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch CI: ${String(error)}`) }
}
/**
 * Polls one repository-wide event stream (oldest first) since its cursor and steps the cursor to five seconds before the
 * newest item (`cursorAt`), relying on Trigger ID deduplication so repeated messages are no-ops. While the cursor stays
 * unchanged (including when clamped to the hourly horizon), sending the last page's ETag makes an unchanged list return
 * HTTP 304 and cost no rate limit. Items from before their kind was switched on or beyond the horizon are ignored.
 */
// readStream：读一个仓库级流（旧→新）——
// 游标推进到最新项的 5 秒前（cursorAt），靠 Trigger id 去重兜住重复；
// 游标未动（含被"小时级地平线"截住）时带上次 ETag：无变化返回 304，不耗速率配额。
// 开关打开之前的地平线之外的项目一律忽略（"从打开时开始"）。
async function readStream(ctx: SourceContext, round: Round, id: string, path: string, config: GithubConfig): Promise<void> {
  const name = KV.github.stream(id)
  const stored = ctx.state.get(name)
  // issues 流按观察开关拆成 issues 与 pulls 两类起点（各自独立计时）。
  const kinds = id === 'issues' ? [...config.observeIssues ? ['issues'] : [], ...config.observePulls ? ['pulls'] : []] : ['comments']
  const before = typeof stored?.started === 'object' ? stored.started : {}
  const started: Record<string, string> = Object.fromEntries(kinds.map(kind => [kind, before[kind] ?? round.started]))
  // horizon：可读下界（整小时对齐）——GitHub 的 since 对太久远的项目会全量返回，用这个兜住。
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  // 条件请求：游标未变时带上次 ETag。
  const conditional = stored?.etag && stored.since === since ? ['-H', `If-None-Match: ${stored.etag}`] : []
  let raw: string
  const listed = `${path}&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
  try { raw = await ctx.commands.withSignal(round.signal).api(listed, '--include', ...conditional) }
  catch (error) {
    // 304 = 无变化：本轮此流无事。
    if (error instanceof CliError && error.code === 304) return
    throw error
  }
  const { headers, body } = included(raw)
  // validItems：跳过并统计解析不了的条目（不让一条脏数据毁掉整页）。
  const items = validItems(ListedSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const { login } = ctx.deployment.github
  // fresh：项目对某类是否"够新"——在起点之后且在地平线内。
  const fresh = (at: string | null | undefined, kind: string) =>
    kind in started && Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon)
  for (const item of items) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    // 中途停止：抛错中止——游标还没推进，未读的下一轮会重读。
    if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
    // agent 自己的动作不算事件。
    if (sameName(item.user.login, login)) continue
    if (id === 'issues') {
      // issues 流：按是否带 pull_request 分流为 PR / Issue；各自按起点判新。
      const issue = IssueSchema.safeParse(item)
      const pr = issue.success && !!issue.data.pull_request
      if (!issue.success || !fresh(issue.data.created_at, pr ? 'pulls' : 'issues')) continue
      await ctx.receive(pr ? pullTrigger(issue.data, login) : issueTrigger(issue.data, login))
      // 顺手维护 Thread 的显示名。
      nameThread(ctx, issue.data.number, issue.data.title)
      continue
    }
    // 评论流：从 issue_url/pull_request_url 反解所属编号。
    const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec((id === 'comments' ? item.issue_url : item.pull_request_url) ?? '')?.[1])
    if (!number || !fresh(item.updated_at ?? item.created_at, 'comments')) continue
    const isPr = id === 'review-comments' || /\/pull\//.test(item.html_url ?? '')
    const ref = { number, isPr, ...item.html_url ? { url: item.html_url } : {} }
    const trigger = commentTrigger(item, ref, id === 'comments' ? 'conversation' : 'inline', login)
    if (trigger.text) await ctx.receive(trigger)
  }
  // 推进游标：取最新项的 updated_at 再退 5 秒；没有有效项则维持 since。
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  const next = Date.parse(moved) > Date.parse(since) ? moved : since
  const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim()
  // The ETag belongs to this request, which the next round repeats only while the cursor stays unchanged.
  // ETag 只在游标未变时保留（变了就失效）。
  ctx.state.set(name, { since: next, started, ...etag && next === since ? { etag } : {} })
}
/** Polls default-branch CI checks, emitting a trigger only when the set of failing checks changes after the initial baseline. */
// pollBranchCi：默认分支 CI——
// 以"失败检查的集合"为指纹；首次观察建立基线（不触发），之后集合变化才发 Trigger。
async function pollBranchCi(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { default_branch: branch } = await commands.api(z.looseObject({ default_branch: z.string() }), '')
  const head = await commands.api(z.looseObject({ sha: z.string() }), `commits/${encodeURIComponent(branch)}`)
  const snapshot = await pullChecks(commands, head.sha, round.tally)
  const previous = ctx.state.get(KV.github.branchCi)
  // The first observation after switching on or renaming the default branch establishes the baseline.
  // 分支改名也重新建立基线。
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  // Retain previous failures while checks are still running so recovery is reported only once all checks pass.
  // 检查还在跑时沿用旧失败集——"恢复"只在全部通过时报一次。
  const now = failures.length || !counts.running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const summary = ciSummary(snapshot, branch, `github/commits/${head.sha}/checks`)
    const url = `https://github.com/${ctx.deployment.repository}/commit/${head.sha}`
    await ctx.receive(branchCiTrigger(branch, head.sha, revision, summary, url))
    // 同步 Thread 的 CI 事实（面板显示）。
    ctx.threads.describe(`github:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
  }
  ctx.state.set(KV.github.branchCi, { branch, failures: now, revision })
}
/**
 * One polling round: notifications, then observed repository streams, then the PRs of open tickets with their CI, then
 * subscribed Threads. Each step and each Issue, PR, or Thread fails independently so all steps run before the round fails.
 * Other read failures (including 404) fail the round toward the error threshold, whereas deleted (410) or abandoned
 * (24h+) threads are recorded only on the thread and in health detail.
 * @returns the polling interval requested by GitHub, in seconds.
 */
// pollRound：一轮轮询——
// 1) 通知（agent 账号被点名的）→ 2) 观察的仓库级流 → 3) 工单 PR 及其 CI → 4) 已订阅 Thread。
// 各步骤、各 Issue/PR/Thread 独立失败：先全跑完，再决定本轮是否算失败（走向错误阈值）。
// 410（已删）与超窗放弃只记在 Thread 与健康详情里。
// 返回 GitHub 要求的轮询间隔（秒）。
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  // 通知步骤的错误单独存——先跑完其他步骤再抛。
  const notified = await pollNotifications(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  await pollRepository(ctx, round)
  await pollTicketPulls(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in notified) throw notified.error
  const { count, interval } = notified.value
  if (signal?.aborted) return interval
  if (round.failures.length) throw new Error(`${round.failures.length} GitHub reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  // 汇总健康详情：删除/放弃/跳过的清单。
  const named = (numbers: number[]) => [...new Set(numbers)].sort((a, b) => a - b).map(number => `#${number}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitHub: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('github', { state: 'ready', detail: `${count} notifications; next poll ≥ ${interval}s${dropped}`, at: round.started })
  return interval
}
/** Reads notifications since the cursor and each Issue or PR they name, advancing the cursor atomically with the retry map for failed reads; deleted (410) Issues are dropped once their error is recorded. */
// pollNotifications：读通知——
// 自游标以来 agent 账号的通知 + 上轮失败的重试项，逐个读取其 Issue/PR；
// 游标与重试表在同一事务里推进（原子）；410 的删除项记录错误后即放弃。
async function pollNotifications(ctx: SourceContext, round: Round): Promise<{ count: number; interval: number }> {
  const { state } = ctx
  const commands = ctx.commands.withSignal(round.signal)
  // since 首次初始化后保持稳定。
  const since = state.get(KV.github.since) ?? round.started
  if (state.get(KV.github.since) === undefined) state.set(KV.github.since, since)
  const { repository } = ctx.deployment
  const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`
  const raw = await commands.api(path, '--include')
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  const headers = raw.slice(0, split)
  const body = raw.slice(split).trim()
  // 轮询间隔以 GitHub 的 x-poll-interval 为准（至少 60 秒）。
  const asked = Number(/x-poll-interval:\s*(\d+)/i.exec(headers)?.[1] ?? 60)
  const interval = Math.max(60, Number.isFinite(asked) ? asked : 60)
  // 有下一页时翻页读全，否则单页即可。
  const notifications = /rel="next"/.test(headers)
    ? await commands.pages(NotificationSchema, path, round.tally)
    : validItems(NotificationSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const retries = { ...state.get(KV.github.retries) }
  // Failed items from the previous round run first, followed by newly notified items in chronological order; each is read once.
  // 待读清单：上轮失败项优先，再按时间序加新通知项；每项一轮只读一次。
  const items = new Map(Object.entries(retries).map(([number, retry]) => [Number(number), retry]))
  for (const notification of notifications.reverse()) {
    // 其他仓库的通知忽略；discussion 不支持；已在清单的跳过。
    if (!sameName(notification.repository.full_name, repository)) continue
    const address = githubAddress(notification.subject.url ?? '', repository)
    if (!address || address.discussion || items.has(address.number)) continue
    const { number, pr } = address
    // 该项的读取起点：其 Thread 游标与通知游标中较晚者。
    items.set(number, { since: [state.get(KV.github.cursor(number)) ?? since, since].sort().at(-1)!, pr })
  }
  for (const [number, item] of items) {
    if (stopped(ctx, round)) return { count: notifications.length, interval }
    round.read.add(number)
    try {
      await readNotified(ctx, round, number, item)
      // 成功即从重试表移除。
      delete retries[number]
    } catch (error) {
      if (stopped(ctx, round)) return { count: notifications.length, interval }
      const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
      // Abandon notification retries after 24 hours of failures so a permanently unreadable thread does not hold source health in error; its cursor stays so a later notification or thread poll still reads what was missed.
      // 连续失败超 24 小时即放弃：不让永久读不了的 Thread 把健康条目钉在 error；
      // 游标不动——以后的新通知或 Thread 轮询仍会补上错过的内容。
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      failed(ctx, round, number, error, abandoned)
      if (!deleted(error) && !abandoned) { retries[number] = retry; continue }
      delete retries[number]
    }
  }
  // 游标与重试表原子推进。
  ctx.atomic(() => { state.set(KV.github.since, cursorAt(round.started)); state.set(KV.github.retries, retries) })
  return { count: notifications.length, interval }
}
// readNotified：读一个被通知的 Issue/PR——先定性（Issue 还是 PR），再收正文与评论。
async function readNotified(ctx: SourceContext, round: Round, number: number, item: Retry): Promise<void> {
  const { since } = item
  let isPr = item.pr
  if (!isPr) {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    // `issues/<n>` also returns PRs with `pull_request` set; handle them in the PR branch below.
    // issues/<n> 对 PR 也会返回（带 pull_request 字段）——转 PR 分支处理。
    isPr = !!issue.pull_request
    if (!isPr) {
      // An Issue opened by someone other than the agent since the cursor brings its body so a mention in it reaches the gate.
      // A mention added by a later edit to the body is not read: only the author can be the actor of the body.
      // 光标之后他人新开的 Issue：把正文也交上去（正文里的 @ 才能到得了门）；
      // 之后编辑加进去的 @ 不算——正文的作者只能是创建者。
      const { login } = ctx.deployment.github
      const opened = Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, login)
      if (opened) await ctx.receive(issueTrigger(issue, login))
      await intakeComments(ctx, { number, isPr: false, url: issue.html_url }, since, round)
      nameThread(ctx, number, issue.title)
    }
  }
  if (isPr) {
    const pr = await pull(ctx, round, number)
    // Emit a PR description trigger for PRs opened since the cursor; its ID is the same as the one produced by the repository PR stream.
    // 光标之后新开的 PR：发正文 Trigger（id 与仓库级 PR 流产出的一致，天然去重）。
    const { login } = ctx.deployment.github
    if (pr.created_at && Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, login)) {
      const opened = { number, title: pr.title ?? '', body: pr.body, user: pr.user, created_at: pr.created_at, html_url: pr.html_url }
      await ctx.receive(pullTrigger(opened, login))
    }
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
    if (pr.title) nameThread(ctx, number, pr.title)
  }
  // 成功读取：推进该 Thread 的游标并清掉其 pollError。
  ctx.state.set(KV.github.cursor(number), cursorAt(round.started))
  ctx.threads.patch(`github:${number}`, { pollError: undefined })
}
/** Reads and observes a PR at most once per polling round. */
// pull：一轮内对同一 PR 至多读一次（Promise 缓存），读后顺带观察其开合/合并状态。
function pull(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  let read = round.pulls.get(number)
  if (!read) {
    read = readPull(ctx, number, round.signal).then(async pr => { await observePull(ctx, pr); return pr })
    round.pulls.set(number, read)
  }
  return read
}
// intakeComments：收一个 Issue/PR 的评论——会话评论、（PR 的）行内评论、评审。
async function intakeComments(ctx: SourceContext, ref: PullRef, since: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { login } = ctx.deployment.github
  const kinds = ref.isPr ? ['conversation', 'inline', 'review'] as const : ['conversation'] as const
  for (const kind of kinds) {
    const suffix = `&since=${encodeURIComponent(since)}`
    const path = kind === 'conversation' ? `issues/${ref.number}/comments?per_page=100${suffix}` : kind === 'inline' ? `pulls/${ref.number}/comments?per_page=100${suffix}` : `pulls/${ref.number}/reviews?per_page=100`
    const comments = await commands.pages(CommentSchema, path, round.tally)
    for (const comment of comments) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      // 中途停止：抛错——游标不动，未读的下一轮重来。
      if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
      // 光标之前的旧评论跳过；agent 自己的跳过。
      const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(comment.user.login, login)) continue
      // A review decision without a body still reaches the ticket: a worker may be waiting for that approval.
      // 没有正文的评审决定（如批准）也要交——worker 可能正等着这个批准。
      const trigger = commentTrigger(comment, ref, kind, login)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}
// pollTicketPulls：轮询所有存活工单关联的 PR（及未关闭未合并者的 CI）。
export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true)))]
  for (const number of numbers) {
    if (stopped(ctx, round)) return
    try {
      const pr = await pull(ctx, round, number)
      if (pr.state !== 'closed' && !pr.merged) await pollChecks(ctx, round, number, pr)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, number, error) }
  }
}
/** Polls a PR's CI checks; only changes after the first baseline observation become Triggers. */
// pollChecks：一个 PR 的 CI——以检查快照的哈希为指纹；
// 首次观察建基线（revision=0 不触发），之后指纹变化才发 ciTrigger。
async function pollChecks(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<void> {
  const snapshot = await pullChecks(ctx.commands.withSignal(round.signal), pr.head.sha, round.tally)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.github.ci(number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(ciTrigger(pr, revision, ciSummary(snapshot, `PR #${number}`, `github/pulls/${number}/checks`)))
  ctx.state.set(KV.github.ci(number), { fingerprint, revision })
  ctx.threads.describe(`github:${number}`, { facts: { ci: ciFact(ciCounts(snapshot)) } })
}
// nameThread：维护 Issue/PR Thread 的标题与显示信息（面板、搜索用）。
function nameThread(ctx: SourceContext, number: number, title: string): void {
  ctx.threads.patch(`github:${number}`, { title })
  ctx.threads.describe(`github:${number}`, { label: `#${number} ${title}`, facts: { number: { value: `#${number}` } } })
}
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
// pollThreads：轮询已订阅的 Issue/PR Thread（本轮已读过的跳过）；
// 410 的在 window（地平线）内仍照常轮一次（花一次读取），不让本轮失败。
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(Number(thread.ref.id)); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(Number(thread.ref.id)))
}
// pollThread：读一个已订阅 Thread 的增量（自其游标以来）。
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's CI Thread has no Issue or PR to read; its CI arrives as Triggers.
  // CI Thread 没有可读的 Issue/PR——其内容以 Trigger 到达。
  if (thread.ref.id.startsWith('ci:')) return
  const number = Number(thread.ref.id)
  if (!number) throw new Error('Subscribed thread has no GitHub issue or PR number')
  round.read.add(number)
  // meta 缺失（旧数据）：先读一次 Issue 补齐 isPr/title/url。
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    ctx.threads.patch(thread.key, { number, isPr: !!issue.pull_request, url: issue.html_url })
    if (issue.title) nameThread(ctx, number, issue.title)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.github.cursor(number)
  // 读取起点：游标，没有则 Thread 创建时间。
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (thread.meta.isPr === true) {
    const pr = await pull(ctx, round, number)
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
  } else await intakeComments(ctx, { number, isPr: false }, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
