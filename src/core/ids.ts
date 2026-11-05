/** Stable content-derived identifiers; equal inputs always produce the same id. */
// 由内容派生的稳定 id：相同输入永远得到相同 id（幂等键的基础）。
// 比如 reply 的 id 由 trigger/ticket/text 派生，重复排队也不会重复发送。
import { createHash } from 'node:crypto'
// key：把所有输入 JSON 序列化后取 SHA-256，截前 32 个十六进制字符。
// 截断换来更短的 id；对内部键（非安全场景）足够。
export function key(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}
