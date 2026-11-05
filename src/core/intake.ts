/** Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing. */
// Intake（入口部件）：Trigger 的接收、Thread 关联、订阅扇出（fan-out）与评估排队。
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
 * Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
 * ticket's worker decides (see `followupOwners`).
 * Engine delegates trigger reception to this part.
 */
// Intake 负责：接收来自 Source 的 Trigger，先去重、再按 SourceScope 过滤，然后记录 Thread 关联；
// 把被监听的 Trigger 扇出给订阅了相应 Thread 的 Ticket，并把"没有任何 Ticket 的 worker 决定"的
// Trigger 排队到其主 Thread 上等待 Eval（见 `followupOwners`）。
// Engine.receive 直接委托到这里。
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  // receive：一个 Source 交来一条 Trigger。返回 stored / duplicate / filtered。
  receive(received: Trigger): ReceiveResult {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    // 规范化时间戳（GitHub 的秒级时间等），统一成 ISO 形式，保证后续字符串比较正确。
    const trigger = { ...received, at: isoTime(received.at) }
    // 不变式：Trigger 至少要属于一个 Thread，否则是 Source 适配层的 bug。
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    // 幂等：同一 id 的 Trigger 只接收一次。
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    // Source scope 判断：不监听则存储并记 filtered，事件不进入领域流程。
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // Track reached tickets and whether they were reached only via context threads (a ticket's own thread makes `context` false).
    // 记录到达的 Ticket，以及是否"仅经上下文 Thread 到达"（只要有一个到达渠道是 Ticket 自己的 Thread，context 就算 false）。
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      // 维护 Thread 上最新事件时间，并把它与本 Trigger 的其他 Thread 互相关联（correlated）。
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      for (const ticketId of thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // Only a person's message on a non-context thread resumes an ended ticket; bots and CI do not (the Executor re-reads
        // threads when it resumes), and a human-stopped ticket receives nothing because its Mandate was withdrawn.
        // 只有非上下文 Thread 上的真人消息能恢复已结束的 Ticket；bot 与 CI 不能（恢复时 Executor 会重读 Thread）；
        // 被人停止的 Ticket 什么都不收——它的 Mandate 已被撤回。
        const followed = !!thread.context?.includes(ticketId)
        const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed
        // 已结束且不能恢复的 Ticket 跳过。
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    // 扇出：把 Trigger 作为 trigger 类 Input 交给每个到达的 Ticket（Tickets.addInput 幂等且会触发投递）。
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.tickets.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
        ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
    }
    // 记录 disposition：fanout 到达列表 + 仅上下文到达的子集。
    const fanout = [...reached.keys()], context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // A person's message that no ticket decides, such as one that reached only tickets a person stopped or that follow the
    // Thread for context, and every bot's, goes to Eval.
    // 没有任何 Ticket 决定的消息（只到达了被停止的或纯上下文的 Ticket），以及所有 bot 消息，都排队进 Eval。
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    // 扇出后再尝试唤醒已结束的 Ticket（真人消息可能恢复它）。
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}
