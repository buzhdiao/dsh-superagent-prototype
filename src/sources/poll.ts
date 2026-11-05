/** Shared polling helpers for subscribed threads, overlap-safe cursors, and timer-friendly delays. */
// 轮询共享助手：已订阅 Thread 的轮询、防重叠的游标、可测试的延时。
import { liveTicket, type Thread } from '../core/index.ts'
import type { SourceContext } from './host.ts'

/** How long a subscribed Thread with no live Ticket continues to be polled after its last Trigger or Ticket end. */
// POLL_HORIZON_MS：没有存活 Ticket 的已订阅 Thread，在其最后一次活动/结束后还继续轮询多久（14 天）。
export const POLL_HORIZON_MS = 14 * 24 * 3600_000
/** True when a subscribed thread has a live ticket or recent activity/completion within `POLL_HORIZON_MS`. */
// polled：一个已订阅 Thread 是否值得本轮轮询——
// 有存活 Ticket 就轮；否则看最近一次活动/工单结束是否在 14 天窗口内。
export function polled(ctx: SourceContext, thread: Thread, now = Date.now()): boolean {
  const tickets = thread.subscriptions.map(id => ctx.tickets.get(id))
  if (tickets.some(ticket => !!ticket && liveTicket(ticket))) return true
  const times = [thread.lastAt ?? thread.createdAt, ...tickets.map(ticket => ticket?.ended?.at ?? '')]
    .map(Date.parse).filter(Number.isFinite)
  return now - Math.max(...times) < POLL_HORIZON_MS
}
/** Steps a poll start timestamp back by 5 seconds so late-arriving remote events are not missed; deterministic trigger IDs deduplicate overlaps. */
// cursorAt：把轮询起点回拨 5 秒——远端事件可能迟到；
// 重叠部分靠 Trigger id 的确定性派生去重，重复消息是无害的 no-op。
export const cursorAt = (started: string): string => new Date(Date.parse(started) - 5000).toISOString()
/** Polls each subscribed Thread of `source` within the horizon independently; records failures on the Thread as `pollError` (unless `stopped()`) and clears `pollError` on success. */
// pollThreads：逐个轮询某 Source 在窗口内的已订阅 Thread——
// 每个 Thread 独立失败（记 pollError 到 Thread，面板可见；stopped 时不记）；
// 成功即清掉 pollError。skip 让调用方跳过本轮已读过的。
export async function pollThreads(ctx: SourceContext, source: string, stopped: () => boolean, poll: (thread: Thread) => Promise<void>,
  skip: (thread: Thread) => boolean = () => false): Promise<void> {
  for (const thread of ctx.threads.subscribed(source)) {
    if (stopped()) return
    if (skip(thread) || !polled(ctx, thread)) continue
    try {
      await poll(thread)
      ctx.threads.patch(thread.key, { pollError: undefined })
    } catch (error) {
      if (stopped()) return
      ctx.threads.patch(thread.key, { pollError: String(error) })
    }
  }
}
/** Waits `ms` or until `signal` aborts using global `setTimeout` so test fake timers can drive polling loops. */
// pause：等待 ms 或 signal 中止——用全局 setTimeout（而非 Node 定时器），
// 让测试的假时钟也能驱动轮询循环。
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const stop = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}
