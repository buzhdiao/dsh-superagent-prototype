/** GitHub outbound channel: posts issue/PR comments and review thread replies under the agent account. */
// GitHub 出站渠道：以代理账号发布 Issue/PR 评论与评审讨论（review thread）回复。
import { z } from 'zod'
// zod：校验 API 输出。
import type { OutboundMessage } from '../core/index.ts'
// OutboundMessage：出站消息结构。
import { CliError } from '../infra/commands.ts'
// CliError：带 HTTP 状态码的 CLI 错误。
import { sameName } from '../infra/text.ts'
// sameName：GitHub 登录名/仓库名的大小写不敏感比较。
import type { SourceContext } from './host.ts'
// SourceContext：来源宿主能力。
import type { ChannelLink, ChannelLinks } from './kind.ts'
// ChannelLink/ChannelLinks：渠道链接类型。
import { githubAddress, githubPage } from './github-trigger.ts'
// GitHub 地址解析与页面链接构造。

const CommentSchema = z.looseObject({
  // 评论的最小结构。
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})
/** True when an issue is permanently deleted (410) or locked (403); 404 is retried because it can indicate temporary permission loss on a private repo. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
  // Issue 被永久删除（410）或已锁定（403）时为 true；404 需要重试，因为私有仓库可能临时失去可见性。
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
  // 目标不存在的判定（404/410）。
/** Posts a comment or review-thread reply with an embedded HTML marker so retries do not create duplicate comments. */
export async function sendGithub(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  // 发布评论或评审回复；正文内嵌 HTML 标记，保证重试不会产生重复评论。
  const { commands } = host
  const { repository, github } = commands.deployment
  // 部署的仓库与代理账号。
  const number = Number(message.channel.address.number)
  // 回复目标 Issue/PR 编号。
  if (!number) throw new Error('Missing GitHub reply target')
  try {
    // Retained trigger URLs also route replies queued before thread-aware delivery.
    const address = githubAddress(message.channel.address.url ?? '', repository)
    // 解析保留的触发 URL；它也能为“话题化投递上线前排队的回复”定位目标。
    let rootId: number | undefined
    if (address?.pr && address.discussion && address.number === number) {
      // Fall back to a top-level PR comment if the target inline review comment was deleted.
      const source = await commands.api(CommentSchema, `pulls/comments/${address.discussion}`)
        .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
      // 目标行内评审评论被删除时回退为 PR 顶层评论。
      rootId = source ? source.in_reply_to_id ?? source.id : undefined
      // 回复线程的根评论 id。
    }
    const path = rootId === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
    // 顶层评论走 issues 接口，评审回复走 pulls 接口。
    const marker = `<!-- dsh-superagent:${message.id} -->`
    // 幂等标记。
    const mine = (comment: z.infer<typeof CommentSchema>) => sameName(comment.user?.login ?? '', github.login)
      && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker)
    // 判断某条评论是否为本消息已发出的。
    if ((await commands.pages(CommentSchema, path)).some(mine)) return 'sent'
    // 已存在同标记评论则视为已发送（幂等）。
    const target = rootId === undefined ? path : `${path}/${rootId}/replies`
    // 有根评论时发布到其 replies。
    await commands.api(z.unknown(), target, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    // 目标已删除/锁定时返回 gone。
    throw error
  }
}
export function githubLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  // 构造 GitHub 渠道链接：有原始 URL 用原始 URL，否则退回仓库页面链接。
  const number = address.number ?? ''
  const review = !!links.repository && !!githubAddress(address.url ?? '', links.repository)?.discussion
  // 是否是评审讨论（从 URL 解析出 discussion）。
  return { url: address.url ?? (links.repository ? githubPage(links.repository, Number(number)) : ''),
    label: review ? { zh: `GitHub #${number} 的 review 讨论`, en: `Review discussion on GitHub #${number}` }
      : { zh: `GitHub #${number}`, en: `GitHub #${number}` } }
  // 标签区分普通 Issue/PR 与评审讨论。
}
