/** Typed panel routes, route parser, and sessionStorage location history. */
// 面板的类型化路由定义、路由解析器，以及基于 sessionStorage 的位置历史。
import { THREAD_FILTERS, TICKET_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
// 引入线程/工单可用的筛选值，用于校验查询参数。
import type { SetupPlace } from '../setup.ts'
// SetupPlace：初始化问题发生的页面位置。
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
// 引入评估页的决策筛选值。
import type { T } from './text.ts'
// T：翻译器类型。

export const TABS = ['overview', 'source', 'trigger', 'eval', 'execution', 'settings'] as const
// 面板全部顶层页签（总览、来源、触发、评估、执行、设置）。
export type Tab = typeof TABS[number]
// Tab：页签名的联合类型。
export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'prompts', 'deployment'] as const
// 设置页内部分组：阶段设置（前三个）、提示词、部署。
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
// SettingsGroup：设置分组的联合类型。
export type Route = { page: 'overview' | 'source'; id?: undefined; query?: undefined }
  | { page: 'trigger'; id?: undefined; query?: { filter?: ThreadFilter } }
  | { page: 'trigger'; id: string; query?: { trigger?: string } }
  | { page: 'eval'; id?: undefined; query?: { filter?: DecisionFilter; window?: '24h' } }
  | { page: 'execution'; id?: undefined; query?: { filter?: TicketFilter } }
  | { page: 'execution'; id: string; query?: undefined }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } }
// Route：判别联合类型，按页面区分；trigger/execution 支持“列表态”或“带 id 详情态”。
export const HOME: Route = { page: 'overview' }
// 首页路由：总览页。
export const settingsRoute = (group: SettingsGroup, query: { source?: string; version?: string } = {}): Route =>
  ({ page: 'settings', query: { group, ...query } })
// 构造设置页路由，可附带来源名或版本号等附加查询。
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : settingsRoute('source', { source: place })
// 由初始化问题位置推导应跳转的设置页（部署问题进部署页，其余进对应来源）。
export const routeLabel = (t: T, route: Route): string =>
  route.id ? t(route.page === 'trigger' ? 'term.thread' : 'term.ticket') : t(`tab.${route.page}`)
// 路由显示名：详情态显示“线程/工单”，列表态显示页签名。

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
// 从允许列表中挑出合法值，否则返回 undefined。
function compact<Q extends object>(query: Q): Q | undefined {
  // 去掉值为 undefined 的键；全部为空时返回 undefined。
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/** Validate and normalize a stored route, dropping unrecognized query filters or removed tabs (such as the legacy `policy` tab). */
export function parseRoute(value: unknown): Route | undefined {
  // 校验并规范化存储的路由，丢弃无法识别的查询筛选或已移除的页签（如旧版 policy 页）。
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  // 宽松解构待校验对象，所有字段都按 unknown 处理。
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  // 取字符串型查询参数的辅助函数。
  const record = typeof id === 'string' && id ? id : undefined
  // id 必须是非空字符串才算详情态。
  switch (page) {
    case 'overview': case 'source': return { page }
    // 总览与来源页没有参数。
    case 'trigger': return record ? { page, id: record, query: compact({ trigger: text('trigger') }) }
      : { page, query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) }
    // 触发页：有 id 时构造线程详情，否则校验列表筛选。
    case 'eval': return { page, query: compact({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) }
    // 评估页：校验决策筛选与时间窗口（仅允许 24h）。
    case 'execution': return record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter) }) }
    // 执行页：同触发页，支持详情态与列表态。
    case 'settings': return { page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'source',
      ...compact({ source: text('source'), version: text('version') }) } }
    // 设置页：分组非法时回退到 source，并附带来源/版本查询。
    default: return undefined
    // 其余一律视为无效路由。
  }
}

const ROUTE_KEY = 'dsh-superagent/route'
// sessionStorage 中保存路由历史的键名。
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
// Location：当前路由 + 历史栈 + 上次访问的设置分组。
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'source'
// 取“最近一次设置分组”：当前在设置页就用当前分组，否则用记忆值，兜底 source。
export function initialLocation(): Location {
  // 启动时恢复上次的位置；失败则回退首页。
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    // 读取并解析存储的 JSON（键不存在时按 null 处理）。
    const route = parseRoute(stored?.route)
    // 校验当前路由。
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    // 历史栈必须是数组。
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
    // 当前路由有效则逐项校验历史栈（非法项被丢弃）并恢复分组记忆。
  } catch (error) {
    // Route memory is a convenience; an unreadable value falls back to HOME.
    void error
    // 路由记忆只是便利功能，解析失败时静默回退首页。
  }
  return { route: HOME, stack: [] }
  // 兜底：从首页开始，历史为空。
}
export function remember(location: Location): void {
  // 把当前位置写入 sessionStorage 持久化。
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch (failure) { void failure /* Route memory is a convenience. */ }
  // 写入失败（如隐私模式配额）时静默忽略。
}
