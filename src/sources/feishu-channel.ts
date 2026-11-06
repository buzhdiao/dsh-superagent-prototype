/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
// 飞书出站渠道：发送话题内的机器人回复并构造会话深链。
import type { OutboundMessage } from '../core/index.ts'
// OutboundMessage：出站消息结构。
import { CliError } from '../infra/commands.ts'
// CliError：CLI 错误（含飞书错误码）。
import { checkedImText } from '../infra/text.ts'
// checkedImText：校验 IM 消息词数上限。
import type { SourceContext } from './host.ts'
// SourceContext：来源宿主能力。
import type { ChannelLink, ChannelLinks } from './kind.ts'
// ChannelLink/ChannelLinks：渠道链接类型。
import { feishuTriggerId } from './feishu-trigger.ts'
// feishuTriggerId：由消息 id 构造触发 id。

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
// 飞书/Lark 的 AppLink 会话深链；事件未随附消息自身链接时使用。
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
// 判断目标消息是否已永久消失（被撤回/删除/不存在）：只有飞书返回这些错误码才算；超时或崩溃不算。
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/** Replies in the topic of the target message; Feishu keeps at most one reply per idempotency key (the outgoing message's `message.id`). */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  // 在目标消息的话题内回复；飞书按幂等键（出站消息的 message.id）保证至多一条回复。
  const messageId = message.channel.address.messageId
  // 目标消息 id（回复对象）。
  if (!messageId) throw new Error('Missing Feishu reply target')
  // 缺少回复目标。
  const text = checkedImText(message.text)
  // 先校验消息词数限制。
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--markdown', text, '--reply-in-thread', '--idempotency-key', message.id]
  // 组装 lark-cli 回复参数：话题内回复 + 幂等键。
  try { await host.commands.lark(reply) }
  catch (error) {
    if (gone(error)) return 'gone'
    // 目标消息已消失时返回 gone（不算失败）。
    throw error
    // 其他错误向上抛。
  }
  return 'sent'
  // 发送成功。
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
// 兜底会话链接（按 bot 品牌构造）；触发上若带消息自身深链则优先用那个。有消息 id 时附触发定位。
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
