/**
 * Context-free UI primitives styled with `--dsw-alias-*` tokens.
 * Mirrors DSH ui-primitives markup and keyboard behavior without coupling to its internal package API.
 */
// 无上下文依赖的基础 UI 组件，使用 `--dsw-alias-*` 设计令牌；复刻 DSH ui-primitives 的标记与键盘行为，但不耦合其内部包 API。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent,
  type ReactNode } from 'react'
// 引入 React Hook 与 DOM 属性类型。
import { createPortal } from 'react-dom'
// 引入传送门：把弹窗/气泡渲染到 body。

// className 拼接工具：过滤假值后用空格连接。
const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

// 图标名到 SVG 路径数据的映射（24x24 视窗，描边风格）。
const ICON_PATHS = {
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  'chevron-up': 'M5 15l7-7 7 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  question: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 8v4l3 2',
  shield: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z',
  decision: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 12.5l2.5 2.5 4.5-5',
  message: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4V6a1 1 0 0 1 1-1z',
  inbox: 'M4 13l2.5-8h11l2.5 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
  hash: 'M10 4L8 20M16 4l-2 16M5 9h15M4 15h15',
  filter: 'M4 5h16l-6 7.5V18l-4 2v-7.5z',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5',
  close: 'M6 6l12 12M18 6L6 18',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  session: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  stop: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5h5v5h-5z',
  pause: 'M9 6v12M15 6v12',
  play: 'M8 5l11 7-11 7z',
  unsubscribe: 'M6 16v-5a6 6 0 0 1 10-4.5M18 11v5l2 2H8M10 20h4M4 4l16 16',
  dismiss: 'M4 4l16 16M9.9 5.2A9 9 0 0 1 21 12a12 12 0 0 1-2.4 3.2M6.3 6.4A12 12 0 0 0 3 12c2 4 5.5 6 9 6 1.4 0 2.7-.3 3.9-.9',
  pull: 'M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8v8M7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16V9a2 2 0 0 0-2-2h-4M13 5l-2 2 2 2',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  review: 'M9 4h6v3H9zM7 5H5v15h14V5h-2M9 13l2 2 4-4',
  ask: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16.5h.01',
  running: 'M12 3a9 9 0 1 0 9 9',
  blocked: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  queue: 'M4 6h16M4 12h16M4 18h10',
} as const satisfies Record<string, string>
// 图标名类型：ICON_PATHS 的键集合。
export type IconName = keyof typeof ICON_PATHS
// 图标组件：按名称渲染描边风格 SVG。
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  // 以 currentColor 描边、默认 16px，装饰性（aria-hidden）。
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>
}

// 按钮属性：变体、尺寸、可选图标及原生按钮属性。
type ButtonProps = { variant?: 'primary' | 'ghost' | 'outline'; size?: 'md' | 'sm'; icon?: ReactNode; className?: string }
  & ButtonHTMLAttributes<HTMLButtonElement>
// 按钮组件：默认 ghost 变体、md 尺寸、type=button（避免误触发表单提交）。
export function Button({ variant = 'ghost', size = 'md', icon, className, children, type = 'button', ...rest }: ButtonProps) {
  // 渲染按钮；有图标时先渲染图标区，再渲染内容。
  return <button type={type} className={cx('dt-btn', `dt-btn-${variant}`, `dt-btn-${size}`, className)} {...rest}>
    {icon !== undefined && <span className="dt-btn-icon">{icon}</span>}{children}
  </button>
}

// 标签色调类型。
export type TagTone = 'outline' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
// 标签组件：带色调与悬浮标题。
export function Tag({ tone = 'outline', title, children }: { tone?: TagTone; title?: string; children: ReactNode }) {
  // 色调写入 data-tone 供样式使用。
  return <span className="dt-tag" data-tone={tone} title={title}>{children}</span>
}

// 圆片（Pill）组件：可按压切换的筛选按钮（aria-pressed 表达状态）。
export function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  // 激活时附加 active 样式。
  return <button type="button" className={cx('dt-pill', active && 'dt-pill-active')} aria-pressed={active}
    onClick={onClick}>{children}</button>
}

// 键盘导航工具：方向键/Home/End 在选项列表中移动选择（环绕）。
function walk<V extends string>(event: KeyboardEvent, values: readonly V[], value: V, onChange: (next: V) => void) {
  // 当前值的位置。
  const index = values.indexOf(value)
  // 各按键对应的步进：左右各一步，Home 到头，End 到尾。
  const steps: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: values.length - 1 }
  // 取本次按键的步进。
  const next = steps[event.key]
  // 不是导航键则忽略。
  if (next === undefined) return
  // 阻止默认行为（如页面滚动）。
  event.preventDefault()
  // 环绕取目标值（对长度取模）。
  const target = values[(next + values.length) % values.length]!
  // 值有变化才回调 onChange。
  if (target !== value) onChange(target)
  // 取列表容器。
  const list = event.currentTarget as HTMLElement
  // 下一帧把焦点移到当前选中的页签上（roving tabindex）。
  requestAnimationFrame(() => list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus())
}
// 页签项：值、标签、DOM id 与关联面板 id。
interface TabItem<V extends string> { value: V; label: string; id: string; panelId: string }
/** Page-level tab bar that re-emits `onChange` when clicking the active tab so callers can reset to the tab root. */
// 页面级页签栏：点击已激活页签也会重新触发 onChange，便于调用方重置回页签根视图。
export function SegmentedTabs<V extends string>({ items, value, onChange, label, className }: {
  items: readonly TabItem<V>[]; value: V; onChange: (next: V) => void; label: string; className?: string
}) {
  // 列表容器引用。
  const list = useRef<HTMLDivElement>(null)
  // 溢出方向状态：start/end/both。
  const [more, setMore] = useState<'start' | 'end' | 'both'>()
  // measure：按滚动位置判断两端是否还有内容。
  const measure = useCallback(() => {
    // 取容器元素。
    const element = list.current
    // 无元素直接返回。
    if (!element) return
    // 判断左侧与右侧是否还有内容（留 1px 容差）。
    const start = element.scrollLeft > 1, end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    // 组合出溢出方向；无溢出为 undefined。
    setMore(start && end ? 'both' : start ? 'start' : end ? 'end' : undefined)
  }, [])
  // Observe both the tablist container (pane resize) and individual tabs (locale label changes).
  // 同时观察容器（窗格缩放）与各页签（语言标签变化引起宽度变化）。
  useEffect(() => {
    // 先测量一次。
    measure()
    // 无容器或环境不支持 ResizeObserver 则跳过。
    if (!list.current || typeof ResizeObserver === 'undefined') return
    // 创建尺寸观察器。
    const observer = new ResizeObserver(measure)
    // 观察容器。
    observer.observe(list.current)
    // 逐个观察页签。
    for (const tab of list.current.children) observer.observe(tab)
    // 清理：断开观察。
    return () => { observer.disconnect() }
  }, [measure, items.length])
  // 渲染 tablist：均分列宽、滚动时重测、支持方向键导航。
  return <div ref={list} role="tablist" aria-label={label} className={cx('dt-tabs', className)} data-more={more} onScroll={measure}
    style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }} onKeyDown={event => walk(event,
      items.map(item => item.value), value, onChange)}>
    {/* 渲染每个页签：选中的可聚焦，其余 tabIndex=-1。 */}
    {items.map(item => <button key={item.value} type="button" role="tab" id={item.id} aria-controls={item.panelId}
      aria-selected={item.value === value}
      tabIndex={item.value === value ? 0 : -1} className="dt-tab" onClick={() => onChange(item.value)}>{item.label}</button>)}
  </div>
}
// 分段控件（SegmentedControl）：segment 形式的选项组，行为同页签。
export function SegmentedControl<V extends string>({ options, value, onChange, label, disabled, className }: {
  options: readonly { value: V; label: string; title?: string }[]; value: V; onChange: (next: V) => void; label: string; disabled?: boolean
  className?: string
}) {
  // 渲染容器：均分列宽；禁用时忽略键盘导航。
  return <div role="tablist" aria-label={label} className={cx('dt-segmented', className)}
    style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    onKeyDown={event => { if (!disabled) walk(event, options.map(option => option.value), value, onChange) }}>
    {/* 渲染每个选项：仅值变化才回调 onChange。 */}
    {options.map(option => <button key={option.value} type="button" role="tab" aria-selected={option.value === value}
      tabIndex={option.value === value ? 0 : -1}
      title={option.title} disabled={disabled} className="dt-segment"
        onClick={() => { if (option.value !== value) onChange(option.value) }}>{option.label}</button>)}
  </div>
}

// 输入框组件：带可选前置图标。
export function Input({ icon, className, ...rest }: { icon?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  // 渲染图标（如有）与原生 input。
  return <span className={cx('dt-input', className)}>{icon !== undefined && <span
    className="dt-input-icon">{icon}</span>}<input {...rest} /></span>
}

// 开关（Switch）组件。
export function Switch({ checked, onChange, label,
  className }: { checked: boolean; onChange: (next: boolean) => void; label: string; className?: string }) {
  // 渲染 role=switch 按钮，点击切换状态。
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={cx('dt-switch', className)}
    onClick={() => onChange(!checked)}>
    <span className="dt-switch-thumb" />
  </button>
}

// 状态点类型。
export type DotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
// 状态点：进行中渲染动画 spinner，其余渲染静态圆点。
export function StateDot({ state, className }: { state: DotState; className?: string }) {
  // 进行中：spinner。
  if (state === 'ongoing') {
    return <svg className={cx('dt-spinner', className)} data-state="ongoing" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
      <g><circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="12" r="9.5" /></g>
    </svg>
  }
  // 其他状态：静态圆点，状态写入 data-state。
  return <span className={cx('dt-state-dot', className)} data-state={state} aria-hidden="true" />
}
// 圆点（Dot）：带可选无障碍标签的状态点。
export function Dot({ state, label }: { state: DotState; label?: string }) {
  // 基础圆点元素。
  const dot = <StateDot className="dt-dot" state={state} />
  // 有标签时包一层带 aria-label 的容器，否则直接返回圆点。
  return label ? <span className="dt-dot-wrap" title={label} role="img" aria-label={label}>{dot}</span> : dot
}

// 折叠行（DisclosureRow）：可展开/收起的区块头。
export function DisclosureRow({ icon, title, open, onToggle, collapsedContent, children }: {
  icon: ReactNode; title: ReactNode; open: boolean; onToggle: () => void; collapsedContent?: ReactNode; children?: ReactNode
}) {
  // 容器按 open 标记展开态。
  return <div className="dt-disclosure" data-open={open || undefined}>
    {/* 行主体：角色为按钮、可聚焦，Enter/空格切换。 */}
    <div className="dt-disclosure-row" role="button" tabIndex={0} aria-expanded={open} data-disclosure-row onClick={onToggle}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}>
      {/* 引导区：图标 + 折叠指示箭头。 */}
      <span className="dt-disclosure-lead">
        <span className="dt-disclosure-icon">{icon}</span>
        <span className="dt-disclosure-chevron"><Icon name={open ? 'chevron-up' : 'chevron-down'} /></span>
      </span>
      {/* 标题。 */}
      <span className="dt-disclosure-title">{title}</span>
      {/* 收起时显示的附加内容。 */}
      {!open && collapsedContent}
    </div>
    {/* 展开时显示的内容。 */}
    {open && children}
  </div>
}

// 可聚焦元素选择器。
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
// 焦点圈定（trapTab）：Tab 循环限制在对话框内。
function trapTab(event: globalThis.KeyboardEvent, dialog: HTMLElement) {
  // Query `*` and filter so elements stay in document order across all DOM implementations.
  // 查询 `*` 再过滤，保证各 DOM 实现下元素都按文档顺序排列。
  const items = [...dialog.querySelectorAll<HTMLElement>('*')].filter(element => element.matches(FOCUSABLE))
  // 首尾可聚焦元素与当前焦点。
  const first = items[0], last = items.at(-1), active = document.activeElement
  // Shift+Tab 的回退目标是最后一个，否则是第一个。
  const target = event.shiftKey ? last : first
  // 焦点在对话框外、在对话框本身、或已到达边界时，阻止默认并把焦点送回边界。
  if (!target || !dialog.contains(active) || active === dialog || active === (event.shiftKey ? first : last)) {
    event.preventDefault()
    target?.focus()
  }
}
/** Accessible modal dialog with focus trapping, Escape/backdrop dismissal, and focus restoration. */
// 无障碍弹窗（Modal）：焦点圈定、Escape/遮罩关闭与焦点还原。
export function Modal({ open, onClose, title, closeLabel, description, footer, className, children }: {
  open: boolean; onClose: () => void; title: string; closeLabel: string; description?: string; footer?: ReactNode; className?: string
  children?: ReactNode
}) {
  // 对话框元素引用。
  const dialog = useRef<HTMLDivElement>(null)
  // Keep `onClose` in a ref so parent re-renders (e.g., background polls) do not re-run the effect and reset focus.
  // 用 ref 持有 onClose：父级重渲染（如后台轮询）不会重启 effect、从而不重置焦点。
  const close = useRef(onClose)
  // 每次渲染同步最新回调。
  close.current = onClose
  useEffect(() => {
    // 未打开不接管键盘。
    if (!open) return
    // 记录打开前的焦点元素，用于关闭后还原。
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    // 焦点移入对话框。
    dialog.current?.focus()
    // 键盘处理：Escape 关闭，Tab 圈定焦点。
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close.current()
      else if (event.key === 'Tab' && dialog.current) trapTab(event, dialog.current)
    }
    // 挂载键盘监听。
    document.addEventListener('keydown', onKeyDown)
    // 清理监听并把焦点还原给打开者。
    return () => { document.removeEventListener('keydown', onKeyDown); opener?.focus() }
  }, [open])
  // 未打开不渲染。
  if (!open) return null
  // 传送门到 body：遮罩（点击关闭）+ 对话框。
  return createPortal(<div className="dt-modal-root" role="presentation">
    {/* 半透明遮罩。 */}
    <div className="dt-modal-mask" aria-hidden="true" onClick={onClose} />
    {/* 对话框主体。 */}
    <div ref={dialog} className={cx('dt-modal', className)} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      {/* 头部：标题与关闭按钮。 */}
      <div className="dt-modal-header">
        <h2>{title}</h2>
        <button type="button" className="dt-modal-close" aria-label={closeLabel} onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      {/* 描述文案（可选）。 */}
      {description && <p className="dt-modal-description">{description}</p>}
      {/* 主体内容（可选）。 */}
      {children !== undefined && <div className="dt-modal-body">{children}</div>}
      {/* 底部操作区（可选）。 */}
      {footer !== undefined && <div className="dt-modal-footer">{footer}</div>}
    </div>
  </div>, document.body)
}

/** Portaled tooltip trigger supporting hover, keyboard focus, and touch toggle. */
// 信息提示（InfoTip）：支持悬停、键盘聚焦与触点切换的传送门气泡触发器。
export function InfoTip({ text, icon = 'question', warn }: { text: string; icon?: IconName; warn?: boolean }) {
  // 锚点按钮引用。
  const anchor = useRef<HTMLButtonElement>(null)
  // 气泡元素引用。
  const bubble = useRef<HTMLSpanElement>(null)
  // 气泡开关状态。
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    // 取锚点与气泡元素。
    const target = anchor.current, element = bubble.current
    // 未打开或缺元素则跳过。
    if (!open || !target || !element) return
    // 视口边距与气泡间距常量。
    const margin = 12, gap = 8
    // 取两者的包围盒。
    const a = target.getBoundingClientRect(), b = element.getBoundingClientRect()
    // 判断上方是否放得下气泡。
    const above = a.top - gap - b.height >= margin
    // 水平居中并钳制在视口内。
    element.style.left = `${Math.max(margin, Math.min(a.left + a.width / 2 - b.width / 2, window.innerWidth - margin - b.width))}px`
    // 上方放得下则放上方，否则放下方。
    element.style.top = `${above ? a.top - gap - b.height : a.bottom + gap}px`
    // 定位完成后再显示，避免闪烁。
    element.style.visibility = 'visible'
  }, [open])
  useEffect(() => {
    // 未打开无需监听。
    if (!open) return
    // 关闭函数。
    const close = () => setOpen(false)
    // 滚动（捕获阶段，覆盖内部滚动容器）与窗口缩放都关闭气泡。
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close)
    // 清理监听。
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close) }
  }, [open])
  // 触发按钮 + 传送门气泡。
  return <>
    {/* 触发按钮：悬停/键盘聚焦/触点切换，Escape 关闭。 */}
    <button ref={anchor} type="button" className={warn ? 'dt-info dt-info-warn' : 'dt-info'} aria-label={text}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onBlur={() => setOpen(false)}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setOpen(true) }}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}
      onPointerUp={event => { if (event.pointerType === 'touch') setOpen(!open) }}
      onClick={event => { if (event.detail > 0 && (event.nativeEvent as PointerEvent).pointerType !== 'touch') setOpen(false) }}>
      <Icon name={icon} size={14} />
    </button>
    {/* 气泡渲染到 body：先隐藏待定位后再显示。 */}
    {open && createPortal(<span ref={bubble} role="tooltip" className="dt-tooltip" style={{ visibility: 'hidden' }}>{text}</span>,
      document.body)}
  </>
}
