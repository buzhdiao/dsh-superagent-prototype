/** In-memory repository implementation for testing and ephemeral engine instances. */
// 内存仓储实现：用于测试与临时的引擎实例。
import { latestAssignment, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from './model.ts'
// 领域模型与最近一次分配的工具函数。
import type { Repositories } from './ports.ts'
// Repositories：仓储端口接口。

const clone = <T>(value: T): T => structuredClone(value)
// 深拷贝工具：返回给调用方的数据与库内状态互不影响。
/**
 * In-memory implementation of the Repositories port backed by cloned Map entries so caller mutations do not affect stored state.
 * Provides snapshot-based atomic rollback and matches the ordering semantics of the SQLite store for Engine tests.
 */
export class MemoryRepositories implements Repositories {
  // Repositories 端口的内存实现：底层用 Map 存储，读写均克隆，提供基于快照的原子回滚，排序语义与 SQLite 存储一致。
  private readonly triggerRows = new Map<string, Trigger>()
  // 触发表。
  private readonly dispositions = new Map<string, TriggerDisposition>()
  // 触发处置表。
  private readonly threadRows = new Map<string, Thread>()
  // 线程表。
  private readonly ticketRows = new Map<string, Ticket>()
  // 工单表。
  private readonly decisionRows = new Map<string, Decision>()
  // 决策表。
  atomic<T>(work: () => T): T {
    // 原子执行：先快照全部表，抛错时整体回滚。
    const maps: Map<string, unknown>[] = [this.triggerRows, this.dispositions, this.threadRows, this.ticketRows, this.decisionRows]
    const snapshot = maps.map(map => new Map(map))
    // 浅拷贝每个 Map 作为快照（值本身不可变使用，浅拷贝足够）。
    try { return work() }
    catch (error) {
      maps.forEach((map, index) => { map.clear(); for (const [id, value] of snapshot[index]!) map.set(id, value) })
      // 失败时清空各表并按快照恢复。
      throw error
    }
  }
  readonly triggers = {
    // 触发仓储。
    get: (id: string) => clone(this.triggerRows.get(id)),
    save: (trigger: Trigger) => { this.triggerRows.set(trigger.id, clone(trigger)) },
    // 存取均克隆。
    disposition: (id: string) => clone(this.dispositions.get(id)),
    saveDisposition: (id: string, value: TriggerDisposition) => { this.dispositions.set(id, clone(value)) },
    // 处置的存取。
  }
  readonly threads = {
    // 线程仓储。
    get: (key: string) => clone(this.threadRows.get(key)),
    save: (thread: Thread) => { this.threadRows.set(thread.key, clone(thread)) },
    // 列出全部（克隆）。
    list: () => [...this.threadRows.values()].map(clone),
    active: () => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
    // 活跃线程：有待处理消息或正在评估。
  }
  readonly tickets = {
    // 工单仓储。
    get: (id: string) => clone(this.ticketRows.get(id)),
    save: (ticket: Ticket) => { this.ticketRows.set(ticket.id, clone(ticket)) },
    // 最新在前，与 SQLite 存储的顺序一致。
    /** Newest first, matching the SQLite Store's order. */
    list: () => [...this.ticketRows.values()].reverse().map(clone),
    open: () => this.tickets.list().filter(ticket => !ticket.ended),
    // 未结束的工单。
    active: () => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
    // 活跃工单：有未送达输入或最近一次分配处于待执行/运行中。
  }
  readonly decisions = {
    // 决策仓储。
    get: (id: string) => clone(this.decisionRows.get(id)),
    save: (decision: Decision) => { this.decisionRows.set(decision.id, clone(decision)) },
    byThread: (key: string) => [...this.decisionRows.values()].filter(decision => decision.threadKey === key).map(clone),
    // 按线程键列出决策。
  }
}
