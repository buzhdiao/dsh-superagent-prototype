/** Trigger-scoped Feishu context reader; retrieved messages are returned for model inspection without entering intake. */
// 触发范围内的飞书上下文读取器；读取到的消息仅供模型检视，不进入摄入（intake）流程。
import { z } from 'zod'
// zod：校验 CLI 输出结构。
import type { Trigger } from '../core/index.ts'
// Trigger：核心触发类型。
import { validItems, type Commands } from '../infra/commands.ts'
// validItems：逐项校验并跳过非法项；Commands：命令执行器。
import { admissionImageKeys, readAdmissionImage } from './feishu-image.ts'
// 图片键提取与图片读取。
import { feishuRef, feishuTime, HistoricalMessageSchema, HistoryPageSchema, historyText, withMentionNames, type HistoricalMessage }
  from './feishu-trigger.ts'
// 飞书触发侧的共享模式与工具。
import type { ContextMessage, ThreadContext } from './kind.ts'
// ContextMessage：上下文消息；ThreadContext：线程上下文读取器接口。

/** Retained source message reference anchoring context reads; `at` is the timestamp around which `chatAround` queries. */
export interface FeishuRef { triggerId: string; chatId: string; messageId: string; at?: string }
// 被保留的来源消息引用，锚定上下文读取；at 是 chatAround 查询围绕的时间戳。
const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/)
// 飞书消息 id 的格式模式。
const sourceSchema = z.object({
  // 来源消息（mget 原始端点）的最小结构。
  message_id: messageId, chat_id: z.string(), root_id: messageId.optional(), parent_id: messageId.optional(),
  thread_id: z.string().regex(/^omt?_[a-zA-Z0-9_-]+$/).optional(), deleted: z.boolean().optional(),
})
const messageSchema = z.object({
  // CLI 规范化后的消息结构。
  message_id: messageId, chat_id: z.string(), content: z.string().optional(), msg_type: z.string(),
  sender: z.object({ id: z.string(), name: z.string().optional(), open_bot_id: z.string().optional(), sender_type: z.string() }),
  create_time: z.string(), update_time: z.string().optional(), updated: z.boolean().optional(), deleted: z.boolean().optional(),
  mentions: z.array(z.object({ id: z.string(), name: z.string().optional(), key: z.string().optional() })).optional(),
  message_app_link: z.string().optional(), thread_id: z.string().optional(), root_id: z.string().optional(), parent_id: z.string().optional(),
})
export type FeishuMessage = z.infer<typeof messageSchema>
// FeishuMessage：规范化消息类型。
/** A topic page; messages are validated individually so an unreadable item is skipped alone and counted. */
const threadSchema = z.object({ messages: z.array(z.unknown()), has_more: z.boolean(), page_token: z.string().optional(),
  thread_id: z.string() })
// 话题页结构：消息数组先按 unknown 收下，再逐条校验，单条不可读只跳过并计数。

/** Reads the CLI-provided AppLink for the source message alone, without retaining expanded thread content. */
export async function readFeishuLink(commands: Commands, ref: FeishuRef): Promise<string> {
  // 只读取来源消息自身的 AppLink，不保留展开的话题内容。
  const id = messageId.parse(ref.messageId)
  const result = z.object({ messages: z.array(z.object({ message_id: messageId, chat_id: z.string(), message_app_link: z.url().optional(), deleted: z.boolean().optional() })) })
    .parse(await commands.lark(['im', '+messages-mget', '--message-ids', id, '--no-reactions']))
  // 批量取消息，只取链接字段。
  const message = result.messages.find(item => item.message_id === id)
  if (!message || message.deleted || message.chat_id !== ref.chatId || !message.message_app_link) throw new Error('Source message link unavailable')
  // 消息不存在/已删除/群不匹配/无链接都视为不可用。
  return message.message_app_link
}

/** Resource references are anchored to an accepted trigger instead of arbitrary chat or message IDs. */
export function feishuReferences(ref: FeishuRef) {
  // 资源引用锚定到已接受的触发，而不是任意群/消息 ID。
  const read = (section: string) => `feishu/${ref.triggerId}/${section}`
  return { skill: 'dsh-superagent-feishu', message: read('message'), root: read('root'), parent: read('parent'), thread: read('thread'),
    around: read('around') }
  // 暴露消息/根消息/父消息/话题/周边五类资源。
}

/** Validates a model-supplied resource string before any network request; only `thread` and `around` take pagination cursors. */
export function feishuResource(resource: string) {
  // 在发起任何网络请求前校验模型提供的资源串；只有 thread/around 带分页游标。
  const match = /^feishu\/([^/]+)\/(message|root|parent|thread|around)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] !== 'thread' && match[2] !== 'around')) {
    throw new Error('Use feishu/<trigger-id>/message, /root, /parent, /thread or /around; follow returned next_resource for another page')
    // 格式非法或游标用在不支持的段落时报错。
  }
  return { triggerId: match[1]!, section: match[2]!, cursor: match[3] ? decodeURIComponent(match[3]) : undefined }
}
async function sourceOf(commands: Commands, ref: FeishuRef) {
  // 读取并校验来源消息本身。
  const id = messageId.parse(ref.messageId)
  // Use the raw mget endpoint to read parent/root IDs without triggering CLI thread expansion.
  const params = JSON.stringify({ message_ids: [id] })
  const listed = await commands.lark(['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', params])
  // 用原始 mget 端点读取父/根消息 ID，避免 CLI 触发话题展开。
  const sourceResult = z.object({ items: z.array(sourceSchema) }).parse(listed)
  const source = sourceResult.items.find(message => message.message_id === id)
  if (!source || source.deleted) throw new Error('The source Feishu message is unavailable or deleted; retained trigger text is still readable')
  // 来源消息不可用或已删除。
  if (source.chat_id !== ref.chatId) throw new Error('Feishu source chat does not match the accepted trigger')
  // 群 ID 与接受的触发不一致。
  return source
}

export interface FeishuPage<M> { status: string; thread_id?: string; messages: M[]; next_resource: string | null; skipped?: number }
// 分页结果：状态、话题 id、消息、下一页资源与跳过数。
export interface FeishuOne<M> { status: string; message: M | null }
// 单条结果。
/** Fetches one message or a bounded topic page of a Trigger's source message with explicit pagination continuation. */
export async function readFeishu(commands: Commands, ref: FeishuRef, resource: string, pageSize: number,
  order: 'asc' | 'desc' = 'asc'): Promise<FeishuPage<FeishuMessage> | FeishuOne<FeishuMessage>> {
  // 读取触发来源消息的单条消息或有界话题页，分页续读需显式跟随 next_resource。
  const request = feishuResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
  // 资源必须指向本触发。
  if (request.section === 'around') throw new Error('The chat around a message is read with feishuRead')
  // around 段由 feishuRead 处理。
  const source = await sourceOf(commands, ref)
  if (request.section === 'thread') {
    // 话题分页读取。
    if (!source.thread_id) return { status: 'no_thread', messages: [], next_resource: null }
    // 来源消息不属于话题。
    const args = ['im', '+threads-messages-list', '--thread', source.thread_id, '--order', order, '--page-size', String(pageSize), '--no-reactions']
    if (request.cursor) args.push('--page-token', request.cursor)
    // 带游标续读。
    const result = threadSchema.parse(await commands.lark(args))
    const tally = { skipped: 0 }
    const messages = validItems(messageSchema, result.messages, tally)
    // 逐条校验，不可读的跳过并计数。
    const outside = messages.some(message => message.chat_id !== source.chat_id
      || (message.thread_id && message.thread_id !== source.thread_id))
    if (result.thread_id !== source.thread_id || outside) throw new Error('Feishu returned messages outside the source thread')
    // 返回了来源话题之外的消息，拒绝。
    if (result.has_more && (!result.page_token || result.page_token === request.cursor)) throw new Error('Feishu thread pagination did not advance; history is incomplete')
    // 分页游标未前进，历史不完整。
    return { status: 'available', thread_id: result.thread_id, messages, ...tally.skipped ? { skipped: tally.skipped } : {},
      next_resource: result.has_more ? `feishu/${ref.triggerId}/thread/${encodeURIComponent(result.page_token!)}` : null }
    // 有下一页时给出续读资源。
  }
  const target = request.section === 'root' ? source.root_id : request.section === 'parent' ? source.parent_id : source.message_id
  // 按段落选择目标消息：根/父/自身。
  if (!target) return { status: `no_${request.section}`, message: null }
  // 该段落没有对应消息。
  // The CLI renders rich text and merged forwards; automatic thread replies are omitted in favor of explicit pages.
  const result = z.object({ messages: z.array(messageSchema) }).parse(await commands.lark(['im', '+messages-mget', '--message-ids', target, '--no-reactions']))
  // CLI 会渲染富文本与合并转发；自动话题回复不在此读取，改用显式分页。
  const message = result.messages.find(message => message.message_id === target)
  if (!message) throw new Error('The requested Feishu message is unavailable; do not infer its contents')
  // 目标消息不可读，要求模型不要臆测。
  if (message.chat_id !== source.chat_id) throw new Error('Feishu returned a message outside the source chat')
  // 返回了来源群之外的消息。
  return { status: message.deleted ? 'deleted' : 'available', message }
}
function isoTime(value: string): string {
  // 时间转 ISO；转换失败原样返回。
  try { return feishuTime(value) } catch { return value }
}
export function feishuView(message: FeishuMessage): ContextMessage {
  // 把规范化消息映射为模型可读的上下文消息。
  return { id: message.message_id, from: message.sender.name || message.sender.id, at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(message.content ?? '', message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true } : {}, ...message.deleted ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {}, ...message.message_app_link ? { url: message.message_app_link } : {} }
  // 文本先还原提及名；按条件附加 bot/删除/回复目标/链接字段。
}
/** Formats a chat history API message for model inspection; the history API identifies senders by `open_id` only. */
function historyView(message: HistoricalMessage): ContextMessage {
  // 把历史 API 消息格式化为模型可读；历史 API 只用 open_id 标识发送者。
  return { id: message.message_id, from: message.sender.id, at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(historyText(message), message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true } : {}, ...message.deleted ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {}, ...message.message_app_link ? { url: message.message_app_link } : {} }
}
/** Reads chat messages surrounding `ref.at` (five before and five after on initial read, then pages of ten older messages). */
async function chatAround(commands: Commands, ref: FeishuRef, cursor: string | undefined, before = 5,
  after = 5): Promise<FeishuPage<ContextMessage>> {
  // 读取 ref.at 前后的群消息（首次读前 5 后 5，续读每次 10 条更早的）。
  const time = Date.parse(ref.at ?? '')
  if (!Number.isFinite(time)) throw new Error('The source Feishu message has no time to read the chat around')
  // 来源消息没有时间戳无法定位。
  const list = async (parameters: Record<string, unknown>) => {
    // 历史列表查询封装。
    const params = JSON.stringify({ container_id_type: 'chat', container_id: ref.chatId, ...parameters })
    const page = HistoryPageSchema.parse(await commands.lark(['api', 'GET', '/open-apis/im/v1/messages', '--params', params]))
    return { ...page, items: validItems(HistoricalMessageSchema, page.items).filter(item => item.chat_id === ref.chatId) }
    // 逐条校验并过滤出本群消息。
  }
  // Feishu takes whole seconds; the source message counts among the earlier items, so `before + 1` holds it and those before it.
  const earlier = await list({ end_time: String(Math.ceil(time / 1000)), sort_type: 'ByCreateTimeDesc', page_size: cursor ? 10 : before + 1,
    ...cursor ? { page_token: cursor } : {} })
  // 飞书只接受整秒；来源消息算在 earlier 里，因此 before+1 才能同时容纳它和它之前的消息。
  const later = cursor || !after ? []
    : (await list({ start_time: String(Math.floor(time / 1000)), sort_type: 'ByCreateTimeAsc', page_size: after + 1 })).items
  // 首次读取才取之后的消息（after+1 排除来源消息自身）。
  const seen = new Set<string>()
  const messages = [...earlier.items.reverse(), ...later].filter(item => !seen.has(item.message_id) && seen.add(item.message_id))
    .map(historyView)
  // earlier 倒序转正后与 later 拼接，去重（filter 的副作用收集已见 id）。
  const more = earlier.has_more && earlier.page_token && earlier.page_token !== cursor
  // 还有更早消息且游标在前进。
  const next = more ? `feishu/${ref.triggerId}/around/${encodeURIComponent(earlier.page_token!)}` : null
  return { status: 'available', messages, next_resource: next }
}
export async function feishuRead(commands: Commands, ref: FeishuRef, resource: string,
  pageSize: number): Promise<FeishuPage<ContextMessage> | FeishuOne<ContextMessage>> {
  // 统一入口：around 段读周边，其他段交给 readFeishu 再映射为上下文消息。
  const request = feishuResource(resource)
  if (request.section === 'around') {
    if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
    await sourceOf(commands, ref)
    // 先校验来源消息仍可用。
    return chatAround(commands, ref, request.cursor)
  }
  const result = await readFeishu(commands, ref, resource, pageSize)
  if ('messages' in result) return { ...result, messages: result.messages.map(feishuView) }
  // 分页结果逐条映射。
  return { status: result.status, message: result.message ? feishuView(result.message) : null }
  // 单条结果映射。
}
function sourceRef(trigger: Trigger): FeishuRef {
  // 从触发取出飞书引用；非飞书触发报错。
  const ref = feishuRef(trigger)
  if (!ref) throw new Error('A Feishu source trigger is required')
  return ref
}
export const feishuThreadContext: ThreadContext<{ readPageSize: number }> = {
  // 飞书线程上下文读取器实现。
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  // 触发锚定的消息 id。
  read: async (commands, trigger, part, cursor, config) => {
    // 按段落读取；part 为 message/root/parent/thread/around。
    const ref = sourceRef(trigger)
    const resource = `feishu/${trigger.id}/${part}${cursor ? '/' + encodeURIComponent(cursor) : ''}`
    const body = await feishuRead(commands, ref, resource, config.readPageSize)
    if (part === 'thread' && body.status === 'no_thread') {
      // Fall back to preceding chat messages when the trigger message does not belong to a topic thread.
      const around = await chatAround(commands, ref, undefined, 5, 0)
      // 触发消息不属于话题线程时回退到之前的群消息。
      return { messages: around.messages, body: { status: 'chat_neighbours', messages: around.messages }, status: 'chat_neighbours' }
      // 状态标记为 chat_neighbours 告知调用方这是回退模式。
    }
    const messages = 'messages' in body ? body.messages : body.message ? [body.message] : []
    // 分页/单条统一为消息数组。
    const next = 'next_resource' in body && body.next_resource ? decodeURIComponent(body.next_resource.split('/').at(-1)!) : undefined
    // 从续读资源中取出游标。
    return { messages, next, body: { ...body }, status: body.status }
  },
  images: admissionImageKeys,
  // 图片键提取器。
  image: (agent, commands, trigger, message, key, stateDir, signal) =>
    readAdmissionImage(agent, commands, { ...sourceRef(trigger), messageId: message.id }, message.text, key, stateDir, signal),
  // 读取指定消息中的图片附件。
}
