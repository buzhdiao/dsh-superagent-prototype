/** Same-origin client and polling hook for the orchestrator management API. */
// 编排器（orchestrator）管理 API 的同源客户端与轮询 Hook。
import { useCallback, useEffect, useRef, useState } from 'react'
// 引入 React Hook：回调稳定化、副作用、可变引用与状态。
import type { Api, ApiRequest, ApiResponse } from '../app/api.ts'
// 引入管理 API 的路由与请求/响应类型。
import { USER_ERRORS, type UserErrorCode } from '../core/errors.ts'
// 引入用户错误码表及其类型。
import type { TicketStage } from '../core/stage.ts'
// 引入工单阶段类型（用于重导出）。
import type { SetupProblem } from '../setup.ts'
// 引入初始化问题类型。

/** Host rejection identified by a structured user error code and interpolation values. */
// 用户错误（UserFailure）：由结构化错误码与插值（interpolation）值标识的服务端拒绝。
export interface UserFailure { code: UserErrorCode; values: Record<string, string> }
/**
 * Represents a failed management API request with a localized message and structured diagnostic details.
 * Thrown by API callers and inspected by UI views and draft state to distinguish validation issues, missing records,
 * and unreachable hosts (`details.unreachable` is set when `dsh-superagent` did not answer at all, such as during a restart,
 * in which case a 404 does not mean a record is missing).
 */
// API 错误（ApiError）：携带本地化消息与结构化诊断详情，用于区分校验问题、记录缺失与主机不可达。
export class ApiError extends Error {
  // 构造：错误消息、HTTP 状态码与可选详情（校验问题、初始化问题、用户错误、主机不可达标记）。
  constructor(message: string, readonly status: number,
    readonly details: { issues?: { path: string; message: string }[]; setup?: SetupProblem; user?: UserFailure; unreachable?: boolean } = {}) {
    // 交给 Error 基类保存消息。
    super(message)
  }
  // 校验问题列表：缺省为空数组。
  get issues() { return this.details.issues ?? [] }
  /** True when the host confirmed the record does not exist, rather than being unreachable. */
  // 主机明确确认记录不存在（404 且并非不可达）时为真。
  get missing() { return this.status === 404 && !this.details.unreachable }
}
// 各类 API 错误场景的本地化文案构造器。
export interface ApiMessages {
  offline: string; notRunning: string; serverError: (status: number) => string; requestFailed: (status: number) => string
  setup: (problem: SetupProblem) => string
  user: (failure: UserFailure) => string
}
// 判断是否为已登记的用户错误码。
const isUserError = (code: unknown): code is UserErrorCode => typeof code === 'string' && Object.hasOwn(USER_ERRORS, code)

/** Calls one management endpoint; the `x-orchestrator-request` header marks the request as originating from this page. */
// 调用单个管理端点；x-orchestrator-request 头标记请求来自本页面。
async function api<T>(messages: ApiMessages, path: string, method: string, body?: unknown): Promise<T> {
  // 响应对象（先声明，供 try/catch 之后使用）。
  let response: Response
  // 有请求体时附加 JSON 头并序列化；没有则用空对象展开。
  const json = body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  try {
    // 发起同源请求到编排器 API。
    response = await fetch(`/orchestrator/api/${path}`, { method, ...json, headers: { 'x-orchestrator-request': '1', ...json.headers } })
  } catch {
    // 请求根本发不出去（网络层失败）视为主机不可达（unreachable）。
    throw new ApiError(messages.offline, 0, { unreachable: true })
  }
  // 读取响应文本。
  const text = await response.text()
  // 解析结果占位。
  let value: unknown
  // 解析 JSON：空体当空对象；解析失败置 undefined（响应可能不是 JSON）。
  try { value = text ? JSON.parse(text) : {} } catch { value = undefined }
  // 非 2xx：解析失败结构并抛出 ApiError。
  if (!response.ok) {
    // 失败响应的宽松结构断言。
    const failure = (value ?? {}) as { error?: unknown; issues?: unknown; setup?: SetupProblem; code?: unknown
      values?: Record<string, string> }
    // 取校验（validation）问题数组；非数组则视为空。
    const issues = Array.isArray(failure.issues) ? failure.issues as { path: string; message: string }[] : []
    // 识别结构化用户错误（错误码已登记才算）。
    const user = isUserError(failure.code) ? { code: failure.code, values: failure.values ?? {} } : undefined
    // dsh-superagent always responds with a body; an empty 404 comes from the DSH web server when dsh-superagent routes are unmounted during startup or restart.
    // dsh-superagent 总是带响应体；空 404 来自 DSH web 服务器（启动或重启期间其路由尚未挂载）。
    const { status } = response
    // 依次按优先级选择文案：初始化问题 > 用户错误 > 服务器 error 字符串 > 空 404（未运行）> 5xx 服务器错误 > 其他请求失败。
    const message = failure.setup ? messages.setup(failure.setup) : user ? messages.user(user)
      : typeof failure.error === 'string' ? failure.error : !text && status === 404 ? messages.notRunning
      : status >= 500 ? messages.serverError(status) : messages.requestFailed(status)
    // 抛出带状态码与详情的错误；响应无内容时标记 unreachable（此时 404 不代表记录缺失）。
    throw new ApiError(message, status, { issues, ...failure.setup ? { setup: failure.setup } : {}, ...user ? { user } : {},
      ...text ? {} : { unreachable: true } })
  }
  // 成功时返回解析结果。
  return value as T
}

// 页面隐藏（后台标签页）时轮询间隔的放大倍数（退避，backoff）。
const HIDDEN_FACTOR = 6
// 深比较两个值是否相同（用于跳过无变化的状态更新）。
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
/**
 * Poll an endpoint while mounted, backing off when the document is hidden.
 * Preserves the last successful value across dependency changes and errors, skips state updates when the response is unchanged,
 * and drops stale responses when `deps` or `intervalMs` changes start a new subscription.
 */
// 轮询 Hook：挂载期间定时拉取端点；隐藏时退避；依赖或间隔变化时丢弃过期响应并重建订阅。
export function usePoll<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs = 5000) {
  // 轮询状态：最近一次成功的数据与错误。
  const [state, setState] = useState<{ data?: T; error?: Error }>({})
  // 用 ref 持有加载函数，避免其函数身份变化导致订阅重建。
  const loader = useRef(load)
  // 每次渲染同步最新的加载函数。
  loader.current = load
  // 刷新函数占位：由 effect 填充，供手动 reload 使用。
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    // 订阅有效性标记：清理后置 false，防止过期响应写入状态。
    let active = true
    // 下一次轮询的定时器。
    let timer: ReturnType<typeof setTimeout> | undefined
    // Serialize requests so a manual reload after a mutation runs after the current poll finishes.
    // 请求串行队列：变更（mutation）后的手动刷新会等当前轮询结束再执行。
    let queue = Promise.resolve()
    // 单次轮询。
    const once = async () => {
      // 先取消已排定的下一次轮询。
      clearTimeout(timer)
      try {
        // 执行加载。
        const value = await loader.current()
        // 数据不变时跳过更新（若此前有错误则只清除错误），避免无谓渲染。
        if (active) setState(previous => same(previous.data, value) ? previous.error ? { data: previous.data as T } : previous : { data: value })
      } catch (failure) {
        // 记录错误（统一包装为 Error）。
        if (active) setState(previous => ({ ...previous, error: failure instanceof Error ? failure : new Error(String(failure)) }))
      } finally {
        // 调度下一次轮询：页面隐藏时按倍数放慢。
        if (active) timer = setTimeout(run, document.hidden ? intervalMs * HIDDEN_FACTOR : intervalMs)
      }
    }
    // 把单次轮询排入串行队列。
    const run = () => (queue = queue.then(once))
    // 页面重新可见时立即轮询一次。
    const shown = () => { if (!document.hidden) void run() }
    // 暴露手动刷新入口。
    refresh.current = run
    // 立即开始第一轮。
    void run()
    // 监听可见性变化（visibilitychange）。
    document.addEventListener('visibilitychange', shown)
    // 清理：停止轮询并移除监听。
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
    // 依赖（deps）或间隔变化时重建订阅。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs])
  // 稳定的手动刷新回调。
  const reload = useCallback(() => refresh.current(), [])
  // 对外暴露数据、错误与 reload。
  return { data: state.data, error: state.error, reload }
}

// 决策过滤项（含 all）。
export const DECISION_FILTERS = ['work', 'stop', 'ignore', 'unavailable', 'all'] as const
// 决策过滤项类型。
export type DecisionFilter = typeof DECISION_FILTERS[number]
// 过滤项到决策类型查询串的映射（all 为空串表示不过滤）。
export const DECISION_KINDS: Readonly<Record<DecisionFilter, string>> = { work: 'accept,reopen', stop: 'stop', ignore: 'ignore',
  unavailable: 'unavailable', all: '' }

// 类型化路由调用器（Call）类型：按路由名与请求参数发起调用并返回对应响应。
export type Call = <K extends keyof Api>(route: K, ...request: {} extends ApiRequest<K> ? [request?: ApiRequest<K>] : [request: ApiRequest<K>])
  => Promise<ApiResponse<K>>
/** Build a typed route caller that resolves localized error messages on each request. */
// 构建类型化路由调用器：每次请求时解析本地化错误文案。
export function caller(messages: () => ApiMessages): Call {
  // 返回实际的调用函数。
  return (route, ...[request]) => {
    // 路由形如 "GET tickets/:id"，拆出 HTTP 方法与路径模板。
    const [method, pattern] = route.split(' ') as [string, string]
    // 请求参数（含 query 与 body 两个特殊键）。
    const values = (request ?? {}) as Record<string, unknown> & { query?: Record<string, unknown>; body?: unknown }
    // 把路径模板中的 :参数 替换为 URL 编码后的实际值。
    const path = pattern.replace(/:(\w+)/g, (_match, name: string) => encodeURIComponent(String(values[name])))
    // 拼接查询串：过滤 undefined 与空串后编码连接。
    const query = Object.entries(values.query ?? {}).filter(([, value]) => value !== undefined && value !== '')
      .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&')
    // 发起调用（有查询串则附加）。
    return api(messages(), query ? `${path}?${query}` : path, method, values.body)
  }
}

// 以下为按管理 API 响应结构推导出的视图类型别名。
export type StateView = ApiResponse<'GET state'>
// 全局状态视图类型。
export type SetupView = StateView['setup']
// 初始化视图类型。
export type SettingsView = ApiResponse<'GET settings'>
// 设置视图类型。
export type Settings = { [B in keyof SettingsView['blocks']]: SettingsView['blocks'][B]['value'] }
// 各配置块"值"的类型映射。
export type SourceView = SettingsView['sources'][number]
// 单个来源设置卡片类型。
export type SourceStatusRow = ApiResponse<'GET sources'>[number]
// 来源状态行类型。
export type TicketRow = ApiResponse<'GET tickets'>['items'][number]
// 工单列表行类型。
export type TicketPageView = ApiResponse<'GET tickets/:id'>
// 工单详情视图类型。
export type ThreadRow = ApiResponse<'GET threads'>['items'][number]
// 线程列表行类型。
export type ThreadPageView = ApiResponse<'GET threads/:key'>
// 线程详情视图类型。
export type TriggerRow = ThreadPageView['timeline'][number]
// 时间线触发器行类型。
export type DecisionRow = ApiResponse<'GET decisions'>['items'][number]
// 决策列表行类型。
export type Problem = ApiResponse<'GET overview'>['problems'][number]
// 总览问题条目类型。
export type DroppedReply = SourceStatusRow['dropped'][number]
// 丢弃回复条目类型。
export type SearchView = ApiResponse<'GET search'>
// 搜索结果视图类型。
export type TicketSummary = SearchView['tickets'][number]
// 搜索结果中的工单摘要类型。
export type { TicketStage }
// 重导出工单阶段类型。
export type HistoryView = ApiResponse<'GET policy/history'>
// 策略历史视图类型。
export type PromptsView = ApiResponse<'GET prompts'>
// 提示词（prompts）视图类型。
export type PromptConfig = PromptsView['defaults']
// 提示词默认配置类型。
export type ThreadFacts = TicketRow['threads'][number]
// 工单行中的线程事实类型。
export type Actor = TriggerRow['actor']
// 参与者视图类型。
