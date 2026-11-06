/** Shared panel React contexts, state polling, restart detection, and action runner hook. */
// 面板层共享的 React Context、状态轮询、重启检测与动作执行 Hook。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
// 引入 React 的 Context 创建、回调/记忆化/副作用/引用/状态等 Hook 及 ReactNode 类型。
import { createPortal } from 'react-dom'
// createPortal 用于把 Toast 渲染到 document.body，脱离组件树层级。
import { caller, usePoll, type ApiMessages, type Call, type SetupView, type StateView } from './api.ts'
// 引入请求构造器 caller、轮询 Hook usePoll 以及各 API 视图类型。
import type { Route } from './route.ts'
// Route：面板内类型化路由。
import STYLES from './client.css?raw'
// 以原始字符串形式导入面板样式表，便于运行时注入 <style> 标签。
import { errorText, setupText, valueLabel, type T } from './text.ts'
// 引入错误文案、初始化问题文案、取值标签与翻译器类型 T。

export interface PanelContext {
  // 面板上下文：提供翻译、请求、导航、通知等公共能力。
  t: T
  // 翻译函数。
  call: Call
  // 类型化 API 调用函数。
  navigate: (route: Route, replace?: boolean) => void
  // 路由跳转，replace 为 true 时替换当前历史记录。
  back: () => void
  // 返回上一页。
  backLabel: string
  // 返回按钮的文案。
  openSession: (sessionId: string) => Promise<void>
  // 打开某个会话详情。
  notify: (text: string) => void
  // 弹出 Toast 通知。
  restart: () => void
  // 触发“软重启”检测模式（进入快速轮询等待服务恢复）。
}
export interface PanelData {
  // 面板数据上下文：全局轮询得到的状态与派生信息。
  state: StateView | undefined
  // 最近一次轮询到的全局状态；未加载时为 undefined。
  error: Error | undefined
  // 轮询出错时的错误对象。
  reload: () => Promise<void>
  // 手动重新拉取状态。
  setup: SetupView | undefined
  // 初始化（setup）视图信息。
  /** Executor Sessions in an active turn, which a restart of `dsh-superagent` interrupts. */
  running: number
  // 正处于活动回合中的执行器会话数量，重启 dsh-superagent 会中断它们。
  /** Incremented each time dsh-superagent recovers from a restart so dependent views refetch. */
  restarts: number
  // dsh-superagent 每次从重启中恢复就自增，依赖它的视图据此重新拉取数据。
}
const Panel = createContext<PanelContext | undefined>(undefined)
// 创建能力上下文（默认 undefined，表示未在 Provider 内）。
const PanelState = createContext<PanelData | undefined>(undefined)
// 创建数据上下文。
export function usePanel(): PanelContext {
  // Hook：读取面板能力上下文，越界使用时抛错。
  const value = useContext(Panel)
  if (!value) throw new Error('dsh-superagent page rendered outside its panel')
  return value
}
export function usePanelData(): PanelData {
  // Hook：读取面板数据上下文，越界使用时抛错。
  const value = useContext(PanelState)
  if (!value) throw new Error('dsh-superagent page rendered outside its panel')
  return value
}
/** Wrap an async action with re-entrancy protection, busy state, optional reload, and error toast reporting. */
export function useAction<A extends unknown[]>(action: (...args: A) => Promise<unknown>,
  { reload }: { reload?: () => Promise<unknown> } = {}) {
  // Hook：包装异步动作，提供防重入、busy 状态、可选刷新与错误 Toast 上报。
  const { notify } = usePanel()
  // 取出通知函数用于错误上报。
  const [busy, setBusy] = useState(false)
  // busy 状态供按钮禁用/加载样式使用。
  const running = useRef(false)
  // ref 记录是否正在执行，防止并发重入。
  const run = async (...args: A): Promise<boolean> => {
    // 实际执行函数：返回是否成功。
    if (running.current) return false
    // 已有同动作在跑则直接忽略本次调用。
    running.current = true
    setBusy(true)
    try { await action(...args); await reload?.(); return true }
    // 执行动作，成功后可选刷新数据并返回 true。
    catch (failure) { notify(errorText(failure)); return false }
    // 失败时弹出错误 Toast 并返回 false。
    finally { running.current = false; setBusy(false) }
    // 无论成败都清理运行标记与 busy 状态。
  }
  return { run, busy }
}
// 对外暴露执行函数与 busy 标记。

const messages = (t: T): ApiMessages => ({
  // 按当前翻译器构造各 API 错误场景的本地化消息。
  offline: t('offline'), notRunning: t('hostNotRunning'), serverError: status => t('serverError', { status }),
    requestFailed: status => t('requestFailed', { status }),
  // 离线、宿主未运行、服务端错误、请求失败四类基础文案。
  setup: problem => problem.values.output ? `${setupText(t, problem)}\n${problem.values.output}` : setupText(t, problem),
  // 初始化失败文案：有输出时把输出附在描述之后。
  // A refusal names a prompt part by its label.
  user: ({ code, values }) => t(`userError.${code}`, values.part ? { ...values, part: valueLabel(t, 'promptPart', values.part) } : values),
  // 用户可见错误：若涉及提示词片段，用其可读标签替换原始键名。
})
function Toast({ text, onDone, holdMs = 3000 }: { text: string; onDone: () => void; holdMs?: number }) {
  // Toast 组件：显示提示文本，经过一段停留时间后回调 onDone 关闭。
  const done = useRef(onDone)
  // 用 ref 保存最新的 onDone，避免定时器闭包捕获旧回调。
  done.current = onDone
  // 每次渲染都更新 ref 中的回调。
  useEffect(() => { const timer = setTimeout(() => done.current(), holdMs + 1000); return () => clearTimeout(timer) }, [holdMs])
  // 停留 holdMs 后再延长 1 秒触发关闭（给 CSS 动画留时间），卸载时清理定时器。
  return createPortal(<div className="dt-toast" role="status" style={{ ['--dt-toast-hold' as string]: `${holdMs}ms` }}>{text}</div>,
    document.body)
  // 通过 Portal 渲染到 body；CSS 变量 --dt-toast-hold 控制动画停留时长。
}
const stay = () => {}
// 默认导航/返回实现：空操作。
const noSession = async () => {}
// 默认“打开会话”实现：空异步操作。
export function PanelProvider({ t, interval = 5000, openSession = noSession, navigate = stay, back = stay, backLabel = '', children }: {
  // 面板根 Provider：包住整个页面，向下提供能力与数据两个 Context。
  t: T; interval?: number; openSession?: (sessionId: string) => Promise<void>; navigate?: PanelContext['navigate']; back?: () => void
  backLabel?: string
  // 各项能力均可由宿主注入，未注入时使用空实现；interval 为轮询间隔。
  children: ReactNode
}) {
  // Read the current translator via ref so locale changes do not recreate `call` and restart polling.
  const copy = useRef(t)
  // 用 ref 持有最新翻译器，语言切换不会重建 call、也不会重启轮询。
  copy.current = t
  // 每次渲染同步最新翻译器到 ref。
  const call = useMemo(() => caller(() => messages(copy.current)), [])
  // call 仅创建一次，发送请求时才动态读取当前语言的错误消息。
  const [toast, setToast] = useState<{ text: string; id: number }>()
  // 当前 Toast 的文本与唯一 id（用于重置组件）。
  const notify = useCallback((text: string) => setToast({ text, id: Date.now() }), [])
  // 弹出通知：用时间戳作为 id，确保重复通知能重新触发动画。
  // Poll at 1s during a restart until the server goes down and answers again, or time out after 30s if the restart completed between polls.
  const [restarting, setRestarting] = useState<{ down: boolean }>()
  // 重启检测状态：down 表示服务端当前是否已不可达。
  const [restarts, setRestarts] = useState(0)
  // 重启恢复次数计数器。
  const restart = useCallback(() => setRestarting({ down: false }), [])
  // 进入重启检测模式：切换到 1 秒快速轮询。
  const { data: state, error, reload } = usePoll(() => call('GET state'), [call], restarting ? 1000 : interval)
  // 轮询全局状态：重启期间用 1 秒间隔，平时用传入的 interval。
  if (restarting && !!error !== restarting.down) {
    // 重启期间检测到“可达/不可达”状态翻转时执行以下逻辑。
    setRestarting(error ? { down: true } : undefined)
    // 服务端报错则标记 down；重新应答则退出重启模式。
    if (!error) setRestarts(restarts + 1)
    // 恢复时递增 restarts，通知依赖视图重新拉取数据。
  }
  useEffect(() => {
    // 重启模式兜底超时：若 30 秒内未观察到状态翻转则自动退出。
    if (!restarting) return
    const timer = setTimeout(() => setRestarting(undefined), 30_000)
    return () => clearTimeout(timer)
  }, [restarting])
  const context = useMemo(() => ({ t, call, navigate, back, backLabel, openSession, notify, restart }), [t, call, navigate, back, backLabel,
    openSession, notify, restart])
  // 组装能力上下文，依赖变化时才重建。
  const data = useMemo(() => ({ state, error, reload, setup: state?.setup, running: state?.load.running ?? 0, restarts }), [state, error,
    reload, restarts])
  // 组装数据上下文：setup 与 running 从全局状态中派生。
  return <Panel.Provider value={context}><PanelState.Provider value={data}>
    <style>{STYLES}</style>
    {/* 注入面板全局样式。 */}
    {children}
    {/* 渲染页面内容。 */}
    {toast && <Toast key={toast.id} text={toast.text} onDone={() => setToast(undefined)} />}
    {/* 有通知时渲染 Toast，key 变化可重新挂载以重播动画。 */}
  </PanelState.Provider></Panel.Provider>
}
