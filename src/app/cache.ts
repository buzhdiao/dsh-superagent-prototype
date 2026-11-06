/**
 * In-memory LRU cache bounded by total UTF-16 code units, always retaining the most recently inserted entry.
 * Runtime uses separate instances to cache paginated resource snapshots for `orchestrator_read` and resolved Feishu message links for search and cards.
 */
// 内存中的 LRU 缓存（Least Recently Used，最近最少使用）：以 UTF-16 码元总长度为上限，且永远保留最近插入的那一条。
// Runtime 会创建多个独立实例：分别缓存 `orchestrator_read` 工具的分页资源快照，以及为搜索和卡片解析出的飞书消息链接。
export class TextCache {
  // 用 Map 的插入顺序（迭代时从旧到新）来维护"最近使用"序：键为缓存键，值为缓存文本
  private readonly texts = new Map<string, string>()
  // 当前缓存中所有文本的总长度（UTF-16 码元数），用于与 limit 比较判断是否超限
  private size = 0
  // limit：缓存允许的最大总字符数
  constructor(private readonly limit: number) {}
  // 读取缓存：命中时把该条目从 Map 中删除再重新插入（挪到末尾，即"最近使用"位置），实现访问即保鲜
  get(key: string): string | undefined {
    const text = this.texts.get(key)
    if (text !== undefined) { this.texts.delete(key); this.texts.set(key, text) }
    // 返回命中的文本；未命中返回 undefined
    return text
  }
  // 写入缓存：先扣除旧值长度，再插入新值并累计大小，最后从最旧端逐条淘汰直到不超限
  set(key: string, text: string): void {
    // 若同键已有旧值，先从总大小中扣除其长度（?? 0 表示此前不存在该键）
    this.size -= this.texts.get(key)?.length ?? 0
    // 删除旧条目（随后重新插入，等效于把该键挪到 Map 末尾，视为最近插入）
    this.texts.delete(key)
    this.texts.set(key, text)
    // 把新文本长度计入总大小
    this.size += text.length
    // 从 Map 头部（最旧端）开始逐条淘汰，直到总大小回到限额以内
    for (const [oldest, value] of this.texts) {
      // 已不超限，或遍历到刚插入的 key 本身（保证最新条目永不被淘汰）时停止
      if (this.size <= this.limit || oldest === key) break
      // 淘汰最旧条目
      this.texts.delete(oldest)
      // 并从总大小中扣减其长度
      this.size -= value.length
    }
  }
  /** Entries ordered from least to most recently used. */
  // 以"最旧 → 最新"的顺序返回全部条目（供需要遍历缓存的调用方使用）。
  entries(): IterableIterator<[string, string]> { return this.texts.entries() }
}
