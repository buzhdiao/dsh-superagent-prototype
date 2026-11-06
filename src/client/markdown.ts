/** Lightweight parser for the Markdown subset used in reports and questions, plus plain-text URL linkification; never interprets raw HTML. */
// 轻量 Markdown 子集解析器：用于报告与提问文本，附带纯文本 URL 链接化（linkify）；从不解析原始 HTML。

// 行内（inline）节点：文本/加粗/代码，或链接。
export type Inline = { kind: 'text' | 'bold' | 'code'; text: string } | { kind: 'link'; text: string; url: string }
// 块（block）节点：标题/段落，或列表（含有序标记）。
export type Block = { kind: 'heading' | 'paragraph'; text: string } | { kind: 'list'; ordered: boolean; items: string[] }

// 缩短 URL 的显示文本：截断过长路径。
function shortUrl(url: string): string {
  try {
    // 解析 URL。
    const parsed = new URL(url)
    // 路径超过 24 字符时截断并加省略号。
    const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname
    // 显示为 主机 + 路径（根路径省略斜杠）。
    return `${parsed.host}${path === '/' ? '' : path}`
  } catch (error) { void error /* Not a URL after all; show it as written. */; return url }
}
/** Splits plain text into text and bare-URL link nodes, excluding trailing sentence punctuation from URLs. */
// 链接化（linkify）：把纯文本切分为文本节点与裸 URL 链接节点（URL 不含句尾标点）。
export function linkify(text: string): Inline[] {
  // 按 URL 切分，空片段过滤后映射：URL 片段做缩短显示的链接节点，其余为文本节点。
  return text.split(/(https?:\/\/[^\s)，。]*[^\s)，。.,;:!?'"])/).filter(Boolean).map((part): Inline => /^https?:\/\//.test(part)
    ? { kind: 'link', text: shortUrl(part), url: part } : { kind: 'text', text: part })
}
// 行内解析（inlines）：拆分加粗/代码/链接标记，其余递归做链接化。
export function inlines(text: string): Inline[] {
  // 按标记语法切分。
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/).flatMap((part): Inline[] => {
    // 加粗：去掉 ** 包裹。
    if (/^\*\*[^*]+\*\*$/.test(part)) return [{ kind: 'bold', text: part.slice(2, -2) }]
    // 行内代码：去掉反引号。
    if (/^`[^`]+`$/.test(part)) return [{ kind: 'code', text: part.slice(1, -1) }]
    // 尝试按 [文本](URL) 解析链接。
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)
    // 是链接则产出 link 节点，否则递归链接化。
    return link ? [{ kind: 'link', text: link[1]!, url: link[2]! }] : linkify(part)
  })
}
// 块级解析（markdownBlocks）：逐行识别列表项、标题与段落。
export function markdownBlocks(text: string): Block[] {
  // 结果块列表。
  const blocks: Block[] = []
  // 当前正在累积的列表块。
  let list: Extract<Block, { kind: 'list' }> | undefined
  // 逐行处理。
  for (const line of text.split('\n')) {
    // 匹配无序（-/*）或有序（数字./)）列表项。
    const item = /^\s*[-*]\s+(.*)$/.exec(line) ?? /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (item) {
      // 判断是否有序列表。
      const ordered = !/^\s*[-*]/.test(line)
      // 无列表或列表类型变化时新建列表块。
      if (!list || list.ordered !== ordered) blocks.push(list = { kind: 'list', ordered, items: [] })
      // 追加列表项文本。
      list.items.push(item[1]!)
      continue
    }
    // 非列表行结束当前列表。
    list = undefined
    // 匹配标题（1-6 级 #）。
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    // 非空行产出标题块或段落块（空行忽略）。
    if (line.trim()) blocks.push(heading ? { kind: 'heading', text: heading[1]! } : { kind: 'paragraph', text: line })
  }
  // 返回块列表。
  return blocks
}
