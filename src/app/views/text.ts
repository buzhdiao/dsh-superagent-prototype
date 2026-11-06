/** Text sanitization and formatting helpers for plain-text previews and HTML-free Markdown in views. */
// 视图层文本净化与格式化工具：纯文本预览与无 HTML 的 Markdown。
// HTML 实体（entity）到字符的映射表，用于解码基本实体。
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }
/** Strips HTML comments and tags, decodes basic entities, and strips again to catch entity-encoded tags. */
// 去 HTML：先去注释与标签，再解码基本实体，然后再去一遍以捕获实体编码的标签。
const withoutHtml = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name: string) => ENTITIES[name]!)
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '')
// 纯文本化（plain）：把 Markdown/HTML 文本转成干净纯文本；lines 为 true 时保留换行并把列表项换成 • 。
export function plain(text: string, lines = false): string {
  // 在去 HTML 的基础上继续清理 Markdown 语法。
  const result = withoutHtml(text)
  // 图片语法与 [Image: ...] 占位统一替换为 [image]。
    .replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]/g, '[image]')
  // 链接只保留显示文字。
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
  // 去标题井号、列表符转 • （lines 模式）、去加粗/斜体/行内代码标记。
    .replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, lines ? '• ' : '').replace(/(\*\*|__|`)/g, '')
  // lines 模式压缩空格与多余空行并去首尾空白；否则把所有空白折叠为单个空格。
  return lines ? result.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : result.replace(/\s+/g, ' ').trim()
}
// 受限 Markdown：仅去 HTML 与图片占位（保留其余 Markdown 语法），用于安全渲染。
export const markdown = (text: string): string => withoutHtml(text).replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]/g, '[image]').trim()
// 标量（scalar）判断：null 或非对象类型。
const scalar = (value: unknown): value is string | number | boolean | null => value === null || typeof value !== 'object'
// 把任意值内联（inline）成一行文本。
function inline(value: unknown): string {
  // 标量直接转字符串（null 为空串）。
  if (scalar(value)) return value === null ? '' : String(value)
  // 数组元素用逗号连接，对象值用 · 连接；递归内联并过滤空片段。
  return (Array.isArray(value) ? value : Object.values(value as object)).map(inline).filter(Boolean).join(Array.isArray(value) ? ', ' : ' · ')
}
// 把 JSON 值展开成"键: 值"形式的行列表。
function jsonLines(value: unknown): string[] {
  // 含非标量元素的数组渲染为 "- 条目" 列表行。
  if (Array.isArray(value) && !value.every(scalar)) return value.map(item => `- ${inline(item)}`)
  // 对象逐键展开：标量值（或纯标量数组）输出 "键: 值"；嵌套结构先输出键名再递归展开。
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([name, item]) => scalar(item) || (Array.isArray(item) && item.every(scalar)) ? [`${name}: ${inline(item)}`]
      : [`${name}:`, ...jsonLines(item)])
  }
  // 其余情况（纯标量数组或单个标量）内联成一行。
  return [inline(value)]
}
/** Formats JSON payloads (or `label: <JSON>` notices) as key-value lines; returns non-JSON text unchanged. */
// 可读化（readable）：把 JSON 载荷（或 `label: <JSON>` 通知）格式化为键值行；非 JSON 文本原样返回。
export function readable(text: string): string {
  // 匹配 "标签: {JSON}" 或纯 JSON 文本（对象或数组）。
  const match = /^(?:([^\n{[]{1,200}): )?(\{[\s\S]*\}|\[[\s\S]*\])$/.exec(text.trim())
  // 不符合 JSON 形态则原样返回。
  if (!match) return text
  // 解析 JSON 并展开为键值行；带标签时把标签放在第一行。
  try { return [...match[1] ? [match[1]] : [], ...jsonLines(JSON.parse(match[2]!))].join('\n') }
  // 只是"长得像 JSON"的文本解析失败时按原文展示。
  catch (error) { void error /* Text that only looks like JSON is shown as written. */; return text }
}
// 预览（preview）：可读化 + 纯文本化后截断到指定长度（默认 160）。
export function preview(text: string, length = 160): string { return plain(readable(text)).slice(0, length) }
// 属性（attribute）提取：仅当值是非空字符串时返回，否则为 undefined。
export const attribute = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
