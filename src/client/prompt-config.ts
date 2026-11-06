/** Pure helpers for editing prompt sections/skills and computing folded line diffs. */
// 提示词编辑的纯函数工具：段落/技能编辑与折叠式行差异计算。
import type { PromptConfig, PromptsView } from './api.ts'
// 引入提示词配置与视图类型。
import { valueLabel, type T } from './text.ts'
// 引入取值标签与翻译类型。

// 团队段落类型。
type TeamSection = PromptsView['sections'][number]
// 内置段落类型。
export type BuiltInPart = PromptsView['parts'][number]
// 是否为团队技能（skill/<name>）。
export const isSkill = (name: string): name is `skill/${string}` => name.startsWith('skill/')
/** A built-in part, which the editor names `part/<key>`, apart from the team skills (`skill/<name>`). */
// 是否为内置段落：编辑器以 `part/<key>` 命名，区别于团队技能（`skill/<name>`）。
export const isPart = (name: string): name is `part/${string}` => name.startsWith('part/')
// 取内置段落的 key（去掉前缀）。
export const partKey = (name: `part/${string}`): string => name.slice(5)
// 列出配置中的全部段落名：团队段落 + 技能 + 覆盖的内置段落。
export const sections = (config: PromptConfig): string[] => [...Object.keys(config).filter(name => name !== 'skills' && name !== 'overrides'),
  ...Object.keys(config.skills).map(name => `skill/${name}`), ...Object.keys(config.overrides ?? {}).map(key => `part/${key}`)]
/** Returns a team section or team skill's text, a built-in part's override, or `undefined` for one the team did not write. */
// 取段落文本：团队段落/技能的正文、内置段落的覆盖文本；团队未写过的为 undefined。
export const sectionText = (config: PromptConfig, name: string): string | undefined => isPart(name) ? config.overrides?.[partKey(name)]?.text
  : isSkill(name) ? config.skills[name.slice(6)]
  : name !== 'skills' && name !== 'overrides' && Object.hasOwn(config, name) ? config[name as TeamSection] : undefined
/**
 * A configuration with its overrides, none as an empty map, as the editor keeps it: a draft and the version it moves onto then
 * merge override by override, as a host stores no overrides as none. With `parts`, only the overrides of those parts stay, as
 * a version loaded from the history may override a part this version no longer has.
 */
// 归一化配置的 overrides（宿主以 none 表示无覆盖，这里统一为空映射）；传 parts 时只保留这些段落的覆盖（历史版本可能覆盖了当前版本没有的段落）。
export const withOverrides = (config: PromptConfig, parts?: readonly { key: string }[]): PromptConfig => ({ ...config,
  overrides: Object.fromEntries(Object.entries(config.overrides ?? {}).filter(([key]) => !parts || parts.some(part => part.key === key))) })
/** The text a built-in part reads with: the team's override, else its built-in text. */
// 内置段落实际生效文本：团队的覆盖优先，否则用内置文本。
export const partText = (config: PromptConfig, part: BuiltInPart): string => config.overrides?.[part.key]?.text ?? part.text
/**
 * Override a built-in part with `text`: an override keeps the built-in text it was edited from, the current one when new or
 * when `rebase`, and goes when its text is the built-in text again.
 */
// 覆盖内置段落：覆盖记录其编辑所基于的内置文本；新建或 rebase 时用当前内置文本；文本回到内置内容时移除覆盖。
export function withOverride(config: PromptConfig, part: BuiltInPart, text: string | undefined, rebase = false): PromptConfig {
  // 拆出该段落现有的覆盖与其余覆盖。
  const { [part.key]: previous, ...others } = config.overrides ?? {}
  // 基线：rebase 用当前内置文本，否则沿用旧基线（缺省当前内置文本）。
  const base = rebase ? part.base : previous?.base ?? part.base
  // 文本为空或等于内置文本时移除覆盖；否则写入覆盖（文本 + 基线）。
  return { ...config, overrides: text === undefined || text === part.text ? others : { ...others, [part.key]: { text, base } } }
}
// 写团队段落或技能文本。
export function withSection(config: PromptConfig, name: string, text: string): PromptConfig {
  return isSkill(name) ? { ...config, skills: { ...config.skills, [name.slice(6)]: text } } : { ...config, [name]: text }
}
// 删除团队技能。
export function withoutSkill(config: PromptConfig, name: string): PromptConfig {
  // 从技能表中剔除该技能。
  const { [name.slice(6)]: _removed, ...skills } = config.skills
  return { ...config, skills }
}
/** The sections, skills and overrides of a draft that differ from the saved version; an override re-based counts too. */
// 草稿与已保存版本存在差异的段落/技能/覆盖；重定基（rebase）过的覆盖也算变更。
export const changedSections = (config: PromptConfig, saved: PromptConfig): string[] =>
  [...new Set([...sections(config), ...sections(saved)])].filter(name => isPart(name)
    ? JSON.stringify(config.overrides?.[partKey(name)]) !== JSON.stringify(saved.overrides?.[partKey(name)])
    : sectionText(config, name) !== sectionText(saved, name))
// 段落显示名：内置段落/团队段落用文案表，技能用前缀 + 名称。
export const sectionLabel = (t: T, view: Pick<PromptsView, 'skillPrefix'>, name: string): string =>
  isPart(name) ? valueLabel(t, 'promptPart', partKey(name)) : isSkill(name) ? `${view.skillPrefix}${name.slice(6)}` : valueLabel(t, 'promptPart', name)
// 技能名是否可用：符合宿主的命名规则、未被占用、且不与内置技能重名。
export const skillNameFree = (name: string, config: PromptConfig, view: Pick<PromptsView, 'skillName' | 'builtin'>): boolean =>
  new RegExp(view.skillName).test(name) && !Object.hasOwn(config.skills, name) && !view.builtin.includes(name)
/** Formats a team prompt part with its heading (omitted for skills, which have no heading). */
// 给团队段落拼上标题行（技能没有标题，直接用正文）。
export const partWith = (part: { name: string; heading?: string | undefined }, base: string): string =>
  part.heading === undefined ? base : `${part.heading}\n${base}`

// 差异行类型：相同/删除/插入，或折叠标记（省略的相同行数）。
export type DiffLine = { kind: 'same' | 'del' | 'ins'; text: string } | { kind: 'fold'; count: number }
/** Compute a line diff, folding runs of more than four unchanged lines to their boundary lines and a count. */
// 计算行级差异（基于 LCS），把超过 4 行的相同段折叠为"首行 + 计数 + 尾行"。
export function lineDiff(before: string, after: string): DiffLine[] {
  // 两侧按行拆分。
  const a = before.split('\n'), b = after.split('\n')
  // Fill LCS table from the end so the forward pass below reconstructs the diff in order.
  // 自尾部向前填 LCS 表，使后面的正向扫描能按顺序重建差异。
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  // 填表：相同字符取对角 +1，否则取相邻较大值。
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1
    : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  // 差异行列表。
  const lines: { kind: 'same' | 'del' | 'ins'; text: string }[] = []
  // 正向扫描重建差异。
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    // 两侧行相同：same，双指针前进。
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'same', text: a[i]! }); i++; j++ }
    // 优先插入：j 前进能保持（或不减少）LCS 长度时取 b 的行。
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) lines.push({ kind: 'ins', text: b[j++]! })
    // 否则删除：取 a 的行。
    else lines.push({ kind: 'del', text: a[i++]! })
  }
  // 折叠结果。
  const folded: DiffLine[] = []
  // 逐段扫描相同行段。
  for (let k = 0; k < lines.length;) {
    // 找到本段连续 same 行的结尾。
    let end = k
    while (end < lines.length && lines[end]!.kind === 'same') end++
    // 超过 4 行的相同段折叠为：首行 + 省略计数 + 尾行。
    if (end - k > 4) folded.push(lines[k]!, { kind: 'fold', count: end - k - 2 }, lines[end - 1]!)
    // 否则原样保留该段。
    else folded.push(...lines.slice(k, Math.max(end, k + 1)))
    // 跳到下一段（至少前进一行，避免死循环）。
    k = Math.max(end, k + 1)
  }
  // 返回折叠后的差异。
  return folded
}
