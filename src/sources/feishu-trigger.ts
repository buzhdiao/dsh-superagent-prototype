/** Normalizes Feishu live events, chat history items, and topic replies into domain Triggers. */
// 把飞书实时事件、历史消息与话题回复规范化为领域触发（Trigger）。
import { z } from 'zod'
// zod：事件结构校验。
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
// key：确定性 id 构造；ChannelRef/Trigger：核心类型。
import type { FeishuMessage, FeishuRef } from './feishu-read.ts'
// 读取侧的规范化消息与引用类型。

export const SOURCE = 'feishu'
// 来源标识。
/** Constructs a Feishu reply channel address; records `direct` explicitly because both group and direct chat IDs start with `oc_`. */
export const feishuChannel = (chatId: string, messageId: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `feishu:${chatId}`, address: { chatId, messageId, ...direct ? { direct: 'true' } : {} } })
  // 构造飞书回复渠道地址；群聊与单聊的会话 ID 都以 oc_ 开头，故显式记录 direct。
/** A message as the live event consumer prints it; the history and topic-page paths normalize what they read into this shape. */
const EventSchema = z.object({ message_id: z.string(), chat_id: z.string(), chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string(), sender_type: z.enum(['user', 'bot']), content: z.string(), create_time: z.string(),
  mentions: z.array(z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).default([]),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(), message_app_link: z.url().optional() })
// 实时事件消费者输出的消息形态；历史与话题页路径把读到的内容规范化成这一形状。
export type FeishuEvent = z.infer<typeof EventSchema>
// FeishuEvent：规范化事件类型。
export const feishuThreadId = (chatId: string, rootId: string | undefined, messageId: string): string => `${chatId}:${rootId ?? messageId}`
// 线程键：会话 ID + 根消息（无根时用消息自身）。
/** Deterministic trigger ID for a Feishu message; every read path for this message produces the same ID. */
export const feishuTriggerId = (messageId: string): string => key('feishu', messageId)
// 飞书消息的确定性触发 ID；同一消息的任何读取路径都得到相同 ID。
export const withMentionNames = (text: string, mentions: { key?: string | undefined; name?: string | undefined }[]): string =>
  mentions.reduce((result, mention) => mention.key && mention.name ? result.replaceAll(mention.key, `@${mention.name}`) : result, text)
  // 把文本中的提及占位符（@_user_N）替换为真实用户名。
/**
 * Parses a Feishu message timestamp into an ISO-8601 string: live events and the history API return epoch milliseconds as a
 * string, whereas topic/thread pages return a local timestamp string such as `2026-09-11 12:00`.
 */
export function feishuTime(value: string): string {
  // 把飞书时间戳解析为 ISO-8601：实时事件与历史 API 返回字符串化的毫秒，话题/线程页返回 `2026-09-11 12:00` 这类本地时间串。
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  // 纯数字按毫秒处理，否则按日期串解析。
  if (!Number.isFinite(time)) throw new Error(`Unreadable Feishu message time: ${value}`)
  // 无法解析的时间。
  return new Date(time).toISOString()
}
/** Converts a normalized Feishu event into a Trigger, returning undefined for messages sent by the bot itself. */
export function feishuTrigger(input: unknown, botId: string, botAppId: string): Trigger | undefined {
  // 把规范化事件转为触发；机器人自己发的消息返回 undefined。
  const event = EventSchema.parse(input)
  if (event.sender_id === botId || event.sender_id === botAppId) return
  // 忽略机器人自身的消息。
  const direct = event.chat_type === 'p2p'
  // 是否单聊。
  const mentioned = event.mentions.some(mention => mention.id === botId || mention.id === botAppId)
  // 是否 @ 了机器人。
  const thread = feishuThreadId(event.chat_id, event.root_id, event.message_id)
  // 所属线程键。
  return { id: feishuTriggerId(event.message_id), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: event.sender_id }, human: event.sender_type === 'user',
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: feishuTime(event.create_time), text: withMentionNames(event.content, event.mentions),
    channel: feishuChannel(event.chat_id, event.message_id, direct), ...(event.message_app_link ? { url: event.message_app_link } : {}),
    meta: { chatId: event.chat_id, messageId: event.message_id, direct, mentioned, ...(event.root_id ? { rootId: event.root_id } : {}),
      ...(event.parent_id ? { parentId: event.parent_id } : {}), ...(event.thread_id ? { threadId: event.thread_id } : {}) } }
  // 组装触发：单聊记 addressed=direct，被 @ 记 mention；meta 保留群/消息/根/父/话题 ID。
}
export const feishuParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined
  // 触发父消息对应的触发 ID（非飞书或无父消息为 undefined）。
export function feishuRef(trigger: Trigger): FeishuRef | undefined {
  // 从触发提取读取所需的引用。
  const meta = trigger.meta as { chatId?: string; messageId?: string }
  if (trigger.source !== SOURCE || !meta.chatId || !meta.messageId) return undefined
  return { triggerId: trigger.id, chatId: meta.chatId, messageId: meta.messageId, at: trigger.at }
}

/** A message from the history API; a deleted message may have no body/content. */
export const HistoricalMessageSchema = z.looseObject({
  // 历史 API 消息；已删除消息可能没有正文。
  message_id: z.string(), chat_id: z.string(), create_time: z.string(),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(),
  deleted: z.boolean().optional(), message_app_link: z.string().optional(),
  sender: z.looseObject({ id: z.string().default(''), sender_type: z.string() }),
  body: z.looseObject({ content: z.string() }).optional(),
  mentions: z.array(z.looseObject({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).optional(),
})
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>
// HistoricalMessage：历史消息类型。
/** One page of the history API; items are validated individually so an unreadable item is skipped alone. */
export const HistoryPageSchema = z.looseObject({
  // 历史 API 分页；items 逐条校验，单条不可读只跳过自身。
  items: z.array(z.unknown()).default([]), has_more: z.boolean().default(false), page_token: z.string().optional(),
})
export function historyText(message: HistoricalMessage): string {
  // 提取历史消息正文：content 可能是 JSON（{text: ...}）或纯文本。
  let content: unknown
  try { content = JSON.parse(message.body?.content ?? '') }
  catch { content = message.body?.content ?? '' /* Feishu also returns plain-text system messages. */ }
  // 解析失败按纯文本处理（飞书系统消息就是纯文本）。
  const plain = content && typeof content === 'object' && 'text' in content && typeof content.text === 'string' ? content.text : undefined
  // JSON 对象形态取 text 字段。
  return typeof content === 'string' ? content : plain ?? JSON.stringify(content)
  // 纯文本直接返回；JSON 对象优先 text，否则序列化保底。
}
export function historyEvent(message: HistoricalMessage, chatId: string, direct: boolean): unknown {
  // 把历史消息适配成规范化事件形态（发送者 id 即 sender.id）。
  return { message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot', content: historyText(message),
    mentions: message.mentions ?? [], root_id: message.root_id, parent_id: message.parent_id, thread_id: message.thread_id,
    message_app_link: message.message_app_link }
}
/**
 * Adapts a topic-page message into the live-event schema, falling back to `root` when Feishu omits `root_id` on replies;
 * an app's message carries its bot's `open_bot_id`, and a deleted message may have no content.
 */
export function topicEvent(message: FeishuMessage, chatId: string, direct: boolean, root: string): unknown {
  // 把话题页消息适配成实时事件形态；飞书在回复上可能省略 root_id，回退到传入的 root。
  return { message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.open_bot_id ?? message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot',
    content: message.content ?? '', mentions: message.mentions ?? [], parent_id: message.parent_id, thread_id: message.thread_id,
    root_id: message.root_id ?? (message.message_id === root ? undefined : root), message_app_link: message.message_app_link }
  // 应用消息带其 bot 的 open_bot_id；已删除消息可能无内容。
}
