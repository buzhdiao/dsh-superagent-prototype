/** Normalizes GitHub issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
// 把 GitHub 的 Issue、PR、评论、评审与 CI 变化规范化为领域触发（Trigger）。
import { z } from 'zod'
// zod：GitHub API 数据校验。
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
// key：确定性 id 构造；核心类型。
import { escapeRegExp, sameName } from '../infra/text.ts'
// 文本工具：正则转义与大小写不敏感比较。

export const SOURCE = 'github'
// 来源标识。
/** GitHub reply address: issue/PR conversation, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `github:${number}`, address: { number: String(number), ...(url ? { url } : {}) } })
  // GitHub 回复地址：Issue/PR 会话；url 指向讨论评论时即评审线程。
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
  // 构造 Issue/PR 页面链接。
/** Parses a web or API URL for an Issue, PR, or review comment in `repository`; returns undefined for other URLs or repositories. */
export function githubAddress(url: string, repository: string): { number: number; pr: boolean; discussion?: number } | undefined {
  // 解析指向本仓库 Issue/PR/评审评论的网页或 API URL；其他 URL 或仓库返回 undefined。
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  // 仓库名不匹配（大小写不敏感）则不认。
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
  // pr 表示是否为 PR；discussion 为评审评论 id。
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
  // 已删除账号 GitHub 返回 null 并显示为 ghost，这里统一转换。
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
export const CommentSchema = z.looseObject({
  // GitHub 评论或评审；评审带 state/commit_id，行内评论带文件、行号、diff 块与线程根评论 id。
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
// GithubComment：评论/评审类型。
/** An Issue as `issues/<number>` returns it; GitHub sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  // `issues/<number>` 返回的 Issue；当编号是 PR 时 GitHub 会带 pull_request 字段。
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
// GithubIssue：Issue 类型。
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
// 新开 Issue/PR 的公共字段。
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }
// PR 引用：编号、是否 PR、链接与作者。
/**
 * True when GitHub reports the account as a regular user rather than a bot or GitHub App.
 * Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
  // GitHub 报告为普通用户（非 bot/GitHub App）时为 true；以普通账号运行的评审 bot 在这里视作人，由提示词识别自动化账号。
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which GitHub ends at the commented line. */
export function reviewPlace(comment: GithubComment): string {
  // 格式化行内评审评论的“文件:行号”与 diff 块末几行（GitHub 的 diff 块止于被评论行）。
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  // 组合评论文本：评审结论、行内位置与正文。
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  // 有裁决的评审（非仅评论）。
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  // 行内评论附位置信息。
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
  // 判断文本是否 @ 了某登录名（词边界匹配，忽略大小写）。
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
  // 触发的操作者信息：human 在账号是人且不是代理自身时为 true。
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  // 为评论或评审构造触发；无正文评论或无正文的 COMMENTED 评审文本为空。
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  // 事件时间：优先编辑时间。
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  // 版本号：用于 id 区分编辑前后。
  const id = key('github-comment', comment.html_url ?? `github:${ref.number}`, String(comment.id), version)
  // 确定性触发 id：同一评论编辑后产生新 id。
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: String(ref.number) }], ...author(comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
  // 被 @ 代理时记 addressed=mention；meta 保留编号、评论 id、类型与行内位置。
}
/**
 * Builds the trigger for a newly opened Issue's title and body.
 * The ID is the same as when Issue bodies were stored previously, so already-stored bodies are not ingested again.
 */
export function issueTrigger(issue: Opened, agent: string): Trigger {
  // 为新开 Issue 的标题与正文构造触发；id 与此前存正文的格式一致，已入库的正文不会重复摄入。
  const body = issue.body ?? ''
  return { id: key('github-issue', String(issue.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.number) }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence in GitHub and never collide, so this reuses `issueTrigger`'s `github-issue` ID format.
 */
export function pullTrigger(pull: Opened, agent: string): Trigger {
  // 为新开 PR 的标题与描述构造触发；GitHub 中 PR 与 Issue 编号同序列永不冲突，故复用 issueTrigger 的 github-issue id 格式。
  return { ...issueTrigger(pull, agent), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
  // meta 标记 isPr 并记录 PR 作者。
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  // 为默认分支 CI 变化构造触发；默认分支没有可回复的人，因此不带 channel。
  return { id: key('github-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
  // revision 计数 CI 变化，使每次变化产生独立触发 id。
}
export function ciTrigger(pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string): Trigger {
  // 为 PR 的 CI 变化构造触发。
  return { id: key('github-ci', String(pr.number), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: String(pr.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
  // 同一 PR 的每次 CI 变化用 revision 区分。
}
