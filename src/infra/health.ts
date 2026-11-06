/** Component health registry displayed in the overview and source status panels. */
// 组件健康注册表：展示在总览与来源状态面板中。
import type { Health } from '../sources/host.ts'
// Health：健康条目数据结构。

export interface HealthEntry {
  // 单个健康条目的句柄。
  get(): Health | undefined
  set(health: Health): void
  /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
  release(): void
  // 注销条目（如来源类型注销时）；之后的 set 变为空操作。
}

/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
 */
export class HealthBoard {
  // 组件健康条目的中央注册表：每个条目名单一写入者。由 Runtime/Effects/Sessions/DshExecutor/Settings/SourceRegistry 认领，管理 HTTP 路由读取。
  private readonly entries: Record<string, Health> = {}
  // 名字 → 健康数据。
  private readonly claimed = new Set<string>()
  // 已被认领的名字集合。
  claim(name: string, initial?: Health): HealthEntry {
    // 认领一个健康条目；同名重复认领视为程序错误。
    if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`)
    this.claimed.add(name)
    if (initial) this.entries[name] = initial
    // 可附带初始健康数据。
    let held = true
    // 记录条目是否仍被持有，释放后置写无效。
    return {
      get: () => this.entries[name],
      set: health => { if (held) this.entries[name] = health },
      // 仅在持有期间允许写入。
      release: () => {
        // 注销：删除数据并归还名字。
        if (!held) return
        held = false
        this.claimed.delete(name)
        delete this.entries[name]
      },
    }
  }
  get all(): Readonly<Record<string, Health>> { return this.entries }
  // 全部健康条目的只读视图。
}
