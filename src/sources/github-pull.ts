/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
// Pull Request 绑定、生命周期观察与终结 IM 通知的辅助函数。
import { z } from 'zod'
// zod：校验 API 输出。
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
// 核心类型与工具。
import type { Deployment } from '../deployment.ts'
// Deployment：部署信息。
import { sameName } from '../infra/text.ts'
// sameName：大小写不敏感名称比较。
import type { SourceContext } from './host.ts'
// SourceContext：来源宿主能力。
import { githubPage, SOURCE, UserSchema } from './github-trigger.ts'
// GitHub 页面链接、来源标识与用户模式。

const PullSchema = z.looseObject({
  // PR 的最小结构。
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
// Pull：PR 数据（补上编号）。
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
  // 读取单个 PR 并补上编号。
const pullNumber = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) : undefined
// 从线程键（github:<number>）解析 PR 编号。
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
  // 工单跟随的 PR 编号列表；open 为 true 时只统计尚未关闭的。
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
  // 工单当前关注的 PR：优先最后一个打开的，否则最后一个跟随的。
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  deployment: Pick<Deployment, 'github' | 'repository'>): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? '', deployment.repository)
  // PR 由代理账号从配置仓库（非 fork）的分支发起时为 true。
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
  // 分支最后一段路径等于工单短名（如 agent/<name>）即认为属于该工单。
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
// 自动合并开启的事实标签。

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  // 校验并把打开的 PR 绑定到工单：PR 须是工单的来源 PR，或代理在工单分支上发起的 PR；一个 PR 至多绑定一个打开工单。
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  // 工单已结束（如其 PR 已关闭）。
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number
  // 该 PR 就是工单的来源 PR。
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref)
  // 或该 PR 是代理在工单分支上发起的。
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
    // 两个条件都不满足时拒绝绑定并给出指引。
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  // PR 已属于另一个活动工单。
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${pr.number}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  // PR 打开且（未跟随/已关闭跟随/代理新开的 PR 尚非 own）时执行绑定。
  return undefined
  // 绑定成功或 PR 未打开（不算错误）。
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  // 对轮询到的 PR 做 open/merged/closed 状态与自动合并事实的对账。
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  // 已合并/关闭则报告关闭。
  else {
    const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // 只有分支上唯一的打开工单才是候选。
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${pr.number}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
    // 工单曾跟随过它（现已重开），或未跟随其他打开 PR 时，自动绑定。
  }
  ctx.threads.describe(`github:${pr.number}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  // 更新线程上的自动合并事实（null 移除）。
  return ended
  // 返回 PR 是否已结束。
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  // 原子绑定：工单跟随线程 + 线程 meta 补充 PR 信息。
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: String(pr.number) }, own)
    ctx.threads.patch(`github:${pr.number}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  // 向跟随该 PR 的打开工单报告一次合并/关闭；是否结束由核心决定。
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).includes(pr.number))) return
  // 没有打开工单在跟随它。
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  // 关闭时间。
  ctx.tickets.threadClosed({ source: SOURCE, id: String(pr.number) }, pr.merged ? 'merged' : 'closed', at)
  // 对 PR 的订阅保留，之后那里的人工评论可以唤醒工单。
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  // 工单随 PR 终结时为 IM 会话构造幂等通知（优先它自己开的最后一个已关闭 PR，否则最后一个跟随的）。
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(item.thread) !== undefined)
  // 已关闭且是 GitHub PR 的跟随项。
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  // 取关闭时间最新的一个。
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  // 优先自己开的，否则任意跟随的。
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  // 非终结结果或没有可通知的 PR。
  const number = pullNumber(follow.thread)!
  const url = githubPage(repository, number, true)
  // PR 页面链接。
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  // 通知语言跟随工单来源请求：含汉字且无假名判定为中文。
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub 时间线与关联 Issue 已展示合并/关闭，因此跳过 GitHub 渠道。
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
  // 只发 IM 渠道；id 含渠道地址与结果保证幂等。
}
