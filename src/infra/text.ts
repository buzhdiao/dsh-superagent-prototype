/** Word counting and string formatting utilities for IM message limits and templates. */
// 即时消息（IM）字数限制与模板用的词数统计和字符串格式化工具。
const words = new Intl.Segmenter('zh', { granularity: 'word' })
// 中文语境的词级分词器。
export const IM_WORDS = 100
// IM 消息词数上限。
export const NOTE_WORDS = 30
// 备注词数上限。
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  // 统计中/英/混合文本的“词”数，忽略标点。
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  // 只累计 isWordLike 的分词片段。
  return count
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
export function checkedImText(text: string): string {
  // 校验待发送的 IM Markdown 消息不超 IM_WORDS（链接文案与 URL 都计入）。
  const count = wordCount(text)
  if (count > IM_WORDS) throw new Error(`IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`)
  // 超限抛错，提示改为简短的高层更新且不要拆成多条。
  return text
}
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
// 模板填充：把 {name} 占位符替换为对应值（缺失替换为空串）。
/** Case-insensitive comparison for GitHub logins and repository names. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
// GitHub 登录名与仓库名的大小写不敏感比较。
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// 转义正则元字符。
