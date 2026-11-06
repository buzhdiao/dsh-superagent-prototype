/** Read-only GitHub repository, conversation, and CI check inspection for assessments and workers. */
// 面向评估与 worker 的 GitHub 只读检视：仓库路径、会话与 CI 检查。
import { z } from 'zod'
// zod：校验 API 输出。
import type { ThreadFact } from '../core/index.ts'
// ThreadFact：线程事实。
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
// validItems：逐项校验；Commands：命令执行器；Tally：跳过计数。
import { CommentSchema, IssueSchema, isHumanLogin, reviewPlace, type GithubComment } from './github-trigger.ts'
// 触发侧的共享模式与工具。
import type { ContextMessage, ThreadContext } from './kind.ts'
// ContextMessage：上下文消息；ThreadContext：线程上下文读取器接口。

const CheckSchema = z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })
// check run 的最小结构。
const StatusSchema = z.looseObject({ context: z.string(), state: z.string() })
// commit status 的最小结构。
type Check = Pick<z.infer<typeof CheckSchema>, 'name' | 'status' | 'conclusion'>
type Status = Pick<z.infer<typeof StatusSchema>, 'context' | 'state'>

export interface CiSnapshot { head: string; checks: Check[]; statuses: Status[] }
// CI 快照：commit、check runs 与 statuses。
/** Check conclusions and status states that count as failures; `success`, `neutral`, `skipped`, and `stale` do not. */
const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])
// 视为失败的结论/状态；success、neutral、skipped、stale 不算。
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  // 统计失败与进行中的检查数量。
  const statuses = snapshot.statuses ?? []
  return {
    failed: snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).length + statuses.filter(status => FAILING.has(status.state)).length,
    running: snapshot.checks.filter(check => check.status !== 'completed').length + statuses.filter(status => status.state === 'pending').length,
  }
}
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  // 生成给人读的 CI 摘要（一行结论 + 查看全部检查的指引）。
  const checks = snapshot.checks.map(check => ({ name: check.name, failed: FAILING.has(check.conclusion ?? ''), running: check.status !== 'completed' }))
  const statuses = (snapshot.statuses ?? []).map(status => ({ name: status.context, failed: FAILING.has(status.state), running: status.state === 'pending' }))
  // 两类检查统一为 {名称, 是否失败, 是否进行中}。
  const results = [...checks, ...statuses]
  const failed = results.filter(result => result.failed).map(result => result.name)
  const running = results.filter(result => result.running).map(result => result.name)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  // 名称列表最多展示 5 个。
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`
  // 位置与 commit 短哈希。
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}`
    : running.length ? `CI running ${running.length}/${results.length} ${at}: ${names(running)}`
      : `CI passed ${results.length}/${results.length} ${at}`
  // 优先报失败，其次进行中，最后通过。
  return `${line}\nRead ${read} for every check.`
}
export function ciFailures(snapshot: CiSnapshot): string[] {
  // 列出失败检查的名称（排序后）。
  return [...snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).map(check => check.name),
    ...(snapshot.statuses ?? []).filter(status => FAILING.has(status.state)).map(status => status.context)].sort()
}
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  // 把 CI 计数转成线程事实标签。
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

/** Reads a non-hidden file or directory listing from the repository's default branch via the GitHub API; hidden entries and `node_modules` are rejected. */
export async function readRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  // 经 GitHub API 读取默认分支上的非隐藏文件或目录列表；隐藏条目与 node_modules 一律拒绝。
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  // 拒绝 ..、隐藏段与 node_modules。
  const resource = `contents/${parts.map(encodeURIComponent).join('/')}`
  // 限定到配置仓库的 contents API 路径。
  if (kind === 'file') return commands.api(resource, '-H', 'Accept: application/vnd.github.raw')
  // 文件直接取原始内容。
  // GitHub returns an entry array for a directory and a single object for a file.
  const entries = await commands.api(z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]), resource)
  // GitHub 对目录返回条目数组，对文件返回单对象。
  if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
  // 目录列表过滤隐藏与 node_modules 后按名排序。
}

/** Reads check runs and commit statuses for a commit without emitting a trigger. */
export async function pullChecks(commands: Commands, head: string, tally?: Tally): Promise<CiSnapshot> {
  // 读取某 commit 的 check runs 与 commit statuses，不产生触发。
  const page = z.looseObject({ check_runs: z.array(z.unknown()) })
  const pages = await commands.api(z.array(page), `commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp')
  // --paginate + --slurp 取全部分页。
  const runs = validItems(CheckSchema, pages.flatMap(page => page.check_runs), tally)
  const statuses = await commands.pages(StatusSchema, `commits/${head}/statuses?per_page=100`, tally)
  const latest = new Map<string, string>()
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
  // statuses 按时间倒序返回，保留每个 context 的最新状态。
  const checks = runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }))
  return { head, checks: checks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    statuses: [...latest].map(([context, state]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)) }
  // 排序使快照稳定可比较。
}

/** Formats a GitHub comment, review, or issue as a model-facing ContextMessage, marking bots and GitHub Apps because bot messages never authorize work. */
function githubMessage(item: GithubComment, text: string, id: string): ContextMessage {
  // 把评论/评审/Issue 格式化为面向模型的 ContextMessage；机器人与 GitHub App 会打标记，因为 bot 消息从不构成工作授权。
  const line = item.line ?? item.original_line
  return { id, from: item.user.login, at: item.created_at ?? item.submitted_at ?? '', text,
    ...!isHumanLogin(item.user) ? { bot: true } : {}, ...item.html_url ? { url: item.html_url } : {},
    ...item.path ? { path: item.path, ...line != null ? { line } : {} } : {} }
  // 行内评论附带文件路径与行号。
}
const reviewText = (review: GithubComment): string =>
  [review.state && review.state !== 'COMMENTED' ? review.state : '', review.body ?? ''].filter(Boolean).join('\n\n')
  // 评审文本：非 COMMENTED 状态先给出评审结论，再接正文。
const DescriptionSchema = IssueSchema.extend({
  // Issue/PR 描述结构：扩展标签、草稿、合并状态与分支。
  labels: z.array(z.looseObject({ name: z.string() })).nullish(), draft: z.boolean().nullish(), merged: z.boolean().nullish(),
  head: z.looseObject({ ref: z.string() }).nullish(), base: z.looseObject({ ref: z.string() }).nullish(),
})
async function reviewThread(commands: Commands, number: number, comment: number, tally?: Tally): Promise<GithubComment[]> {
  // 读取某条行内评论所在的评审讨论线程。
  const comments = await commands.pages(CommentSchema, `pulls/${number}/comments?per_page=100`, tally)
  const root = comments.find(item => item.id === comment)?.in_reply_to_id ?? comment
  // 用 in_reply_to_id 回溯线程根评论。
  return comments.filter(item => item.id === root || item.in_reply_to_id === root)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  // 取根评论及其全部回复，按时间排序。
}
function threadMessages(thread: GithubComment[], id: (comment: GithubComment) => string): ContextMessage[] {
  // 把讨论线程映射为上下文消息：首条带评审位置信息，其余标记回复目标。
  const [first] = thread
  return thread.map(item => item === first
    ? githubMessage(item, [reviewPlace(item), item.body ?? ''].filter(Boolean).join('\n\n'), id(item))
    : { ...githubMessage(item, item.body ?? '', id(item)), ...first ? { reply_to: id(first) } : {} })
}

/**
 * Reads an Issue or PR, a page of its comments or reviews, a review thread, or a CI snapshot as model-facing
 * `{ id, from, at, text, reply_to?, path?, line?, url }` messages rather than raw GitHub API records.
 */
export async function readGithub(commands: Commands, resource: string): Promise<unknown> {
  // 资源读取统一入口：Issue/PR、评论页、评审页、评审线程或 CI 快照。
  // A commit's CI, such as the default branch's, which no PR names.
  const commit = /^github\/commits\/([0-9a-f]{7,40})\/checks$/.exec(resource)
  if (commit) return pullChecks(commands, commit[1]!)
  // commit 的 CI（如不属于任何 PR 的默认分支 CI）。
  const match = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use github/issues/<number>, github/pulls/<number>, or append /comments/<page>, /reviews/<page>, /thread/<comment-id> or /checks; or github/commits/<sha>/checks')
    // 资源格式非法。
  }
  const [, kind, number, section, page = '1'] = match
  if (kind === 'issues' && (section === 'reviews' || section === 'checks' || section === 'thread')) {
    throw new Error('Reviews, review threads and checks require a pull request')
    // 评审/检查只对 PR 有意义。
  }
  const path = `${kind}/${number}`
  if (section === 'checks') {
    // PR 的 CI 快照。
    if (match[4]) throw new Error('Checks do not take a page number')
    const pr = await commands.api(z.looseObject({ head: z.looseObject({ sha: z.string() }) }), path)
    return pullChecks(commands, pr.head.sha)
    // 用 PR head commit 查 CI。
  }
  if (section === 'thread') {
    // 评审线程。
    if (!match[4]) throw new Error('Name the review thread by one of its comments: github/pulls/<number>/thread/<comment-id>')
    const thread = await reviewThread(commands, Number(number), Number(match[4]))
    if (!thread.length) throw new Error('No review comment of this PR has that id')
    return { messages: threadMessages(thread, item => String(item.id)) }
  }
  if (!section) {
    // 读取 Issue/PR 描述本身。
    const item = await commands.api(DescriptionSchema, path)
    const branches = item.head && item.base ? { head: item.head.ref, base: item.base.ref } : {}
    const labels = item.labels?.length ? { labels: item.labels.map(label => label.name) } : {}
    return { number: item.number, title: item.title, state: item.state, ...item.merged ? { merged: true } : {},
      ...item.draft ? { draft: true } : {}, ...branches, ...labels, ...githubMessage(item, item.body ?? '', String(item.number)) }
    // 描述消息附带分支/标签/合并/草稿状态。
  }
  const listed = await commands.api(z.array(z.unknown()), `${path}/${section}?per_page=20&page=${page}`)
  // 评论或评审分页。
  const tally = { skipped: 0 }
  const items = validItems(CommentSchema, listed, tally)
  const messages = items.map(item => section === 'reviews'
    ? githubMessage({ ...item, created_at: item.submitted_at ?? item.created_at }, reviewText(item), String(item.id))
    : { ...githubMessage(item, item.body ?? '', String(item.id)), ...item.in_reply_to_id ? { reply_to: String(item.in_reply_to_id) } : {} })
  // 评审消息带结论；评论消息带回复目标。
  return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `github/${kind}/${number}/${section}/${Number(page) + 1}` } : {} }
  // 满页时给出下一页资源。
}
/** Reads one page of an Issue or PR conversation (with the Issue/PR description first on page 1), using comment URLs as message IDs. */
async function conversationPage(commands: Commands, number: number, page: number) {
  // 读取 Issue/PR 会话的一页；第 1 页先放描述，消息 id 用评论 URL。
  const messages: ContextMessage[] = []
  if (page === 1) {
    const issue = await commands.api(IssueSchema, `issues/${number}`)
    messages.push(githubMessage(issue, `${issue.title}\n\n${issue.body ?? ''}`, issue.html_url))
    // 第 1 页以“标题 + 正文”的描述开头。
  }
  const listed = await commands.api(z.array(z.unknown()), `issues/${number}/comments?per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  const comments = validItems(CommentSchema, listed, tally)
  messages.push(...comments.map(comment => githubMessage(comment, comment.body ?? '', comment.html_url ?? String(comment.id))))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
  // 满页 100 条才有下一页。
}
/**
 * Context reader for a GitHub Trigger: reads the review thread for an inline review comment (whose first comment is its
 * root and parent), or the Issue/PR conversation by page otherwise (whose first page is its root and parent).
 */
export const githubThreadContext: ThreadContext<unknown> = {
  // GitHub 触发的上下文读取器。
  messageId: trigger => trigger.url ?? '',
  // 锚定消息 id 即触发 URL。
  read: async (commands, trigger, part, cursor) => {
    // The default branch's CI has no conversation; its Trigger is its context.
    if (typeof trigger.meta.branch === 'string') {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
      // 默认分支 CI 没有会话，触发自身即上下文。
    }
    const number = Number(trigger.meta.number)
    if (trigger.meta.kind === 'inline' && typeof trigger.meta.commentId === 'number') {
      // 行内评审评论：读整个评审线程。
      const thread = await reviewThread(commands, number, trigger.meta.commentId)
      const messages = threadMessages(thread, item => item.html_url ?? String(item.id))
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      // thread 段读全线程，其他段只读根评论。
      return { messages: read, body: { status: 'review_thread', messages: read }, status: 'review_thread' }
    }
    const body = await conversationPage(commands, number, Number(cursor ?? '1'))
    // 其余按会话分页读取。
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
