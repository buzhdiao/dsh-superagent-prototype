/** Localization, reason formatting, message marker cleanup, and relative timestamp helpers. */
// 本地化（Localization）、原因格式化、消息占位标记清理与相对时间戳辅助函数。
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Translate：宿主 UI 包提供的翻译器类型。
import type { DshSuperagentKey } from './locales.ts'
// DshSuperagentKey：本面板全部文案键的联合类型。
import type { Localized } from '../sources/kind.ts'
// Localized：中英双语文本结构。
import type { SetupProblem } from '../setup.ts'
// SetupProblem：初始化（setup）问题结构。
import type { Health } from '../sources/host.ts'
// Health：来源健康状态结构。
import { reasonText, type Reason } from '../core/reasons.ts'
// reasonText/Reason：核心的原因结构及其英文兜底文案。

export type T = Translate<DshSuperagentKey>
// T：绑定到本面板文案键的翻译器类型。
export const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)
// 从任意抛出值提取可展示的错误文本。
export const localized = (t: T, text: Localized | string | undefined): string =>
  typeof text === 'string' ? text : text ? text[t('lang') === 'en' ? 'en' : 'zh'] : ''
// 取本地化文本：字符串原样返回；双语结构按当前语言选 en/zh；空值返回空串。
export const actorName = (t: T, actor: { name?: Localized } | undefined): string => actor?.name ? localized(t, actor.name)
  : t('automatedNotice')
// 操作者显示名：有名字用名字，否则显示“自动通知”。
export function valueLabel(t: T, group: string, key: string | undefined): string {
  // 把枚举键翻译为可读标签；没有对应文案时回退显示原始键。
  if (!key) return ''
  const name = `${group}.${key}` as DshSuperagentKey
  // 拼出形如 group.key 的文案键。
  const text = t(name)
  return text === name ? key : text
  // 翻译器查不到时会原样返回键名，据此判断是否存在译文。
}
/** Format one or more structured or raw reasons in the active UI language, truncating multi-line host errors to their first line. */
export function reasonLabel(t: T, reason: string | Reason | readonly Reason[] | undefined): string {
  // 以当前 UI 语言格式化一个或多个原因（结构化或原始字符串），多行宿主错误截断为首行。
  if (typeof reason === 'string') return reason ? label(t, { code: reason }) : ''
  // 字符串视为原因码处理；空串返回空。
  return [reason ?? []].flat().map(item => label(t, item)).filter(Boolean).join('；')
  // 数组逐项格式化、去空后用中文分号连接。
}
function label(t: T, reason: Reason): string {
  // 单个原因的格式化。
  const key = `reason.${reason.code}` as DshSuperagentKey
  // 拼出原因文案键。
  const text = reason.code === 'said' ? reason.values?.text ?? '' : t(key, reason.values)
  // said（模型自述）直接用其文本；其他查翻译表。
  if (reason.code !== 'said' && text !== key) return text
  // 有译文且非 said 时直接返回。
  const written = reason.code === 'said' ? text : reasonText({ ...reason, triggerId: undefined })
  // 否则回退到核心层的英文 reasonText（去掉 triggerId 避免噪音）。
  if (/^\w*Error\b/.test(written)) { const first = written.split('\n')[0]!; return first.length > 140 ? `${first.slice(0, 140)}…` : first }
  // 形如 *Error 的宿主报错：只取首行，超 140 字符截断加省略号。
  return written
}
export const setupText = (t: T, problem: Pick<SetupProblem, 'code' | 'values'>): string => t(`setup.${problem.code}`, problem.values)
// 初始化问题的本地化描述。
export const healthText = (t: T, health: Pick<Health, 'detail' | 'code' | 'values'>): string =>
  health.code ? t(`healthCode.${health.code}` as const, health.values) : health.detail
// 健康状态文案：有错误码用码翻译，否则显示原始 detail。
/** Replaces Feishu and GitHub content placeholders (images, cards, media, forwards, unresolved mentions) with localized labels. */
export function readableMarkers(t: T, text: string): string {
  // 把飞书/GitHub 消息里的占位标记（图片、卡片、媒体、合并转发、未解析提及）替换成本地化标签：
  // Markdown 图片语法与 [Image: …]/[image] 占位 → 图片标签；聊天卡片占位 → 卡片标签；
  // 媒体占位与合并转发占位 → 对应标签；未解析的用户提及（@_user_N）→ “某人”标签。
  return text.replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]|\[image\]/g, t('imageMarker'))
    .replace(/\[Chat card: [^\]]*\]/g, t('cardMarker'))
    .replace(/\[Media: [^\]]*\]/g, t('mediaMarker')).replace(/\[Merged forward\]/g, t('forwardMarker'))
    .replace(/@_user_\d+/g, t('unknownMention'))
}
const timeLocale = (lang: string) => lang === 'en' ? 'en' : 'zh-CN'
// 由语言代码推导 Intl 使用的 locale。
export function when(value: string | undefined, lang: string): string {
  // 智能时间显示：24 小时内用相对时间，否则按日期显示。
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  // 无法解析的日期原样返回。
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  // 与当前时间的差（秒）。
  if (Math.abs(seconds) < 86_400) {
    // 一天以内走相对时间格式化。
    const relative = new Intl.RelativeTimeFormat(timeLocale(lang), { numeric: 'auto' })
    if (Math.abs(seconds) < 60) return relative.format(0, 'second')
    // 一分钟内显示“刚刚/现在”。
    if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), 'minute')
    // 一小时内按分钟。
    return relative.format(Math.round(seconds / 3600), 'hour')
    // 一天内按小时。
  }
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const year = sameYear ? {} : { year: 'numeric' } as const
  // 同年省略年份，跨年带上年份。
  return date.toLocaleString(timeLocale(lang), { ...year, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  // 按本地格式显示“月 日 时:分”。
}
export function fullTime(value: string | undefined, lang: string): string {
  // 完整时间戳显示（hover 提示等场景）。
  const date = new Date(value ?? '')
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(timeLocale(lang))
  // 解析失败返回空串，成功则返回完整本地时间。
}
