/** Versioned record storage backed by numbered snapshots and a current-revision pointer in the Store KV table. */
// 版本化记录存储：以"编号快照 + 当前修订号指针"实现，全部数据存放在 Store 的键值（KV）表中。
import type { Family, Key } from '../kv.ts'
// 仅引入 Store 类型（用于约束其 get/set/keys/atomic 方法）
import type { Store } from './store.ts'

/**
 * Manages numbered snapshots of a versioned record in the `Store` key-value table with a pointer key tracking the active revision.
 * Each save writes a new snapshot and advances the pointer atomically, keeping full history without duplicating the active record.
 * Used by `Store` for settings history and by `Prompts` for versioned prompt configuration.
 */
// Versions（版本管理器）：在 Store 键值表中管理某条版本化记录的编号快照，并用一个指针键记录当前生效的修订号（revision）。
// 每次保存都写入新快照并原子地推进指针，既完整保留历史，又不重复存储当前生效记录。
// 被 Store 用于设置（settings）历史，被 Prompts 用于版本化的提示词配置。
export class Versions<V extends { revision: number }> {
  // store：只依赖 Store 的 get/set/keys/atomic 四个方法（用 Pick 收窄，便于测试时替换实现）
  // pointer：指向当前修订号的指针键；family：由修订号生成快照键的"键族"函数
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>, private readonly pointer: Key<number>,
    private readonly family: Family<V, [revision: number]>) {}
  /** Current revision number, or `0` before the first save. */
  // 当前修订号；尚未保存过时返回 0
  revision(): number { return this.store.get(this.pointer) ?? 0 }
  /** Current snapshot, or `undefined` before the first save. */
  // 当前生效的快照；尚未保存过时返回 undefined
  current(): V | undefined {
    // 先读指针拿到当前修订号
    const revision = this.store.get(this.pointer)
    // 指针不存在说明从未保存过；否则按修订号取对应快照
    return revision === undefined ? undefined : this.get(revision)
  }
  // 按修订号读取某个历史快照（不存在时返回 undefined）
  get(revision: number): V | undefined { return this.store.get(this.family(revision)) }
  // 保存新版本：在原子事务（atomic）中依次生成新记录、写快照、推进指针，保证三步要么全成要么全不做
  save(make: (revision: number) => V): V {
    return this.store.atomic(() => {
      // 以"当前修订号 + 1"调用工厂函数生成新版本内容
      const version = make(this.revision() + 1)
      // 写入新版本的快照
      this.store.set(this.family(version.revision), version)
      // 把指针推进到新修订号（此后 current() 即返回新版本）
      this.store.set(this.pointer, version.revision)
      // 返回刚保存的版本
      return version
    })
  }
  /** Stores a snapshot without advancing the current revision pointer (e.g., to record an initial built-in baseline). */
  // 仅存一份快照但不推进当前修订号指针（例如记录内置初始基线，不改变"当前版本"的语义）
  keep(version: V): void { this.store.set(this.family(version.revision), version) }
  // 列出历史版本：按修订号从新到旧排序，limit 限制返回条数（默认 Infinity 即全部）
  list(limit = Infinity): V[] {
    // 枚举该键族下全部快照键 → 逐个读取（读不到则跳过）→ 按修订号降序排序 → 截取前 limit 条
    return this.store.keys(this.family).flatMap(name => this.store.get(name) ?? []).sort((a, b) => b.revision - a.revision).slice(0, limit)
  }
}
