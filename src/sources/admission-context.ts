/** Bounded thread message window loaded for admission assessments. */
// 准入评估（admission assessment）加载的有界线程消息窗口。
import type { Commands } from '../infra/commands.ts'
// Commands：命令执行器。
import type { ContextMessage, TriggerContext } from './kind.ts'
// ContextMessage：上下文消息；TriggerContext：触发上下文。

/** Selects the first five thread messages plus five messages on either side of `sourceId`, recording omitted gap counts. */
export function threadWindow(messages: ContextMessage[], sourceId: string) {
  // 选取开头 5 条消息 + 触发消息前后各 5 条，并记录每段被省略的条数。
  const trigger = messages.findIndex(message => message.id === sourceId)
  // 触发消息在已加载消息中的位置（可能不在其中）。
  const selected = messages.map((message, index) => ({ message, index }))
    .filter(({ index }) => index < 5 || (trigger >= 0 && Math.abs(index - trigger) <= 5))
  // 保留开头 5 条，以及距离触发消息不超过 5 条的消息。
  let previous = -1
  // 上一个被保留消息的下标，用于计算省略数。
  const entries = selected.map(({ message, index }) => {
    const omitted_before = index - previous - 1
    // 该消息之前被省略的消息条数（相邻保留消息之间）。
    previous = index
    return { message, position: index + 1, omitted_before }
    // position 为在完整线程中的 1 起始位置。
  })
  return { entries, source_found: trigger >= 0, loaded_messages: messages.length, omitted_after: messages.length - previous - 1 }
  // 返回窗口条目、触发消息是否在快照中、快照大小与尾部省略数。
}
/**
 * Reads up to `maxPages` of a trigger's thread and builds the bounded message window around the trigger; counts describe
 * only this loaded snapshot (never unread history), and `status` reports fallback modes such as `chat_neighbours`.
 */
export async function admissionContext(context: TriggerContext, commands: Commands, maxPages: number) {
  // 读取触发所在线程的至多 maxPages 页，并构造围绕触发的有界消息窗口。
  const messages: ContextMessage[] = []
  const seen = new Set<string>()
  // 已见消息 id，用于跨页去重。
  const cursors = new Set<string>()
  // 已出现过的分页游标，用于检测游标循环。
  let next: string | undefined
  // 下一页游标。
  let status: string | undefined
  // 来源报告的回退状态（如 chat_neighbours）。
  let more = true
  // 是否还有更多页。
  for (let page = 0; more && page < maxPages; page++) {
    // 逐页读取，最多 maxPages 页。
    const result = await context.read(commands, 'thread', next)
    for (const message of result.messages) if (!seen.has(message.id)) {
      seen.add(message.id); messages.push(message)
      // 去重后按顺序追加。
    }
    status ??= result.status
    // 只记录第一次出现的状态。
    next = result.next
    more = next !== undefined
    if (next !== undefined && cursors.has(next)) throw new Error('Thread pagination repeated a cursor; context is incomplete')
    // 游标重复说明分页异常，上下文不完整，直接报错。
    if (next !== undefined) cursors.add(next)
  }
  return { messages, window: threadWindow(messages, context.messageId), complete: !more, next: more ? next ?? null : null,
    ...status ? { status } : {} }
  // 返回消息、窗口、是否完整、下一游标（仅完整时为 null）与可选状态。
}
