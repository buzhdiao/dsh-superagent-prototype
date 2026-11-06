/** Context-aware shared UI widgets: page/section headers, timestamps, Markdown rendering, and confirmation actions. */
// 感知上下文的共享 UI 部件：页面/分节标题、时间戳、Markdown 渲染与确认操作。
import { Fragment, useState, type ReactNode } from 'react'
// Fragment 用于多片段渲染；useState 管理开关状态。
import type { SetupProblem } from '../setup.ts'
// SetupProblem：初始化问题结构。
import { Button, Icon, InfoTip, Modal, StateDot, type DotState, type IconName } from './controls.tsx'
// 基础控件：按钮、图标、信息提示、模态框、状态点。
import { inlines, linkify, markdownBlocks, type Inline } from './markdown.ts'
// Markdown 解析：块级结构、行内片段、URL 链接化。
import { useAction, usePanel, usePanelData } from './provider.tsx'
// 面板 Hook：动作包装、能力上下文、数据上下文。
import { settingsRoute, type SettingsGroup } from './route.ts'
// 设置页路由构造器与分组类型。
import { errorText, fullTime, readableMarkers, setupText, when } from './text.ts'
// 文本辅助函数。

const external = { target: '_blank', rel: 'noopener noreferrer' } as const
// 外链统一属性：新标签页打开并隔离 opener。

export function When({ at }: { at: string | undefined }) {
  // 相对时间戳组件：正文显示相对时间，title 显示完整时间。
  const { t } = usePanel()
  return <time dateTime={at} title={fullTime(at, t('lang'))}>{when(at, t('lang'))}</time>
}
export function SetupMessage({ problem, lead }: { problem: Pick<SetupProblem, 'code' | 'values'>; lead?: boolean }) {
  // 初始化（setup）问题消息组件；lead 为 true 时带“设置有问题”前缀。
  const { t } = usePanel()
  const text = setupText(t, problem)
  // 本地化问题描述。
  return <>
    {lead ? t('setupProblem', { detail: text }) : text}
    {/* 按需包裹前缀。 */}
    {problem.values.output && <span className="dt-detail dt-mono dt-clamp">{problem.values.output}</span>}
    {/* 有诊断输出时以等宽字体截断展示。 */}
  </>
}
export function Section({ title, count, children, action, hint, badge, icon }: {
  // 分节容器：标题 + 可选计数/提示/徽标/动作按钮。
  title: string; count?: number | string; children: ReactNode; action?: ReactNode; hint?: string; badge?: ReactNode; icon?: IconName
}) {
  return <section className="dt-section">
    <h2 className="dt-section-title">
      {icon && <span className="dt-section-icon"><Icon name={icon} size={14} /></span>}<span className="dt-section-name">{title}</span>
      {/* 可选图标与标题名。 */}
      {count !== undefined && <span className="dt-count">{count}</span>}{hint && <InfoTip text={hint} />}{badge}
      {/* 计数、信息提示、徽标。 */}
      {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      {/* 动作按钮靠右。 */}
    </h2>
    {children}
    {/* 分节内容。 */}
  </section>
}
export function Hint({ children }: { children: ReactNode }) { return <p className="dt-hint">{children}</p> }
// 弱化说明文字。
export function LabelValue({ label, value }: { label: string; value: ReactNode }) {
  // 行内“标签: 值”组合。
  return <span className="dt-lv"><span className="dt-lv-label">{label}</span> <span className="dt-lv-value">{value}</span></span>
}
export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  // 键值对列表（dl/dt/dd 结构），display: contents 让网格布局接管。
  return <dl className="dt-kv">{rows.map(([key, value], index) => <div key={index}
    style={{ display: 'contents' }}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
}

function Inlines({ parts }: { parts: Inline[] }) {
  // 行内片段渲染：粗体、代码、链接、普通文本。
  return <>{parts.map((part, index) => part.kind === 'bold' ? <strong key={index}>{part.text}</strong>
    : part.kind === 'code' ? <code key={index} className="dt-code">{part.text}</code>
    : part.kind === 'link' ? <a key={index} className="dt-inline-link" href={part.url} title={part.url} {...external}>{part.text}</a>
    : <Fragment key={index}>{part.text}</Fragment>)}</>
  // 按 kind 分派到对应元素，链接统一走外链属性。
}
/** Renders a safe Markdown subset (headings, lists, paragraphs, bold, inline code, links) without interpreting raw HTML. */
export function MarkdownLite({ text }: { text: string }) {
  // 安全的 Markdown 子集渲染（标题、列表、段落、粗体、行内代码、链接），不解析原始 HTML。
  const { t } = usePanel()
  return <div className="dt-md">{markdownBlocks(readableMarkers(t, text)).map((block, index) => {
    // 先清理占位标记再按块渲染。
    if (block.kind !== 'list') return <p key={index} className={block.kind === 'heading' ? 'dt-md-heading' : undefined}><Inlines
      parts={inlines(block.text)} /></p>
    // 非列表块渲染为段落（标题加样式类）。
    const items = block.items.map((item, at) => <li key={at}><Inlines parts={inlines(item)} /></li>)
    // 列表块先渲染各列表项。
    return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
    // 按有序/无序选择列表元素。
  })}</div>
}
function MoreToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  // 展开/收起切换按钮。
  const { t } = usePanel()
  return <button type="button" className="dt-textlink dt-more" aria-expanded={open} onClick={onToggle}>{open ? t('collapse')
    : t('expand')}</button>
}
export function ClampText({ text }: { text: string }) {
  // 长文本截断显示组件：超长时折叠并提供展开入口。
  const [open, setOpen] = useState(false)
  const long = text.length > 480 || text.split('\n').length > 8
  // 超过 480 字符或 8 行视为长文本。
  return <>
    <div className={long && !open ? 'dt-event-text dt-clamp-8' : 'dt-event-text'}><Inlines parts={linkify(text)} /></div>
    {/* 收起时长文本限制为 8 行；内容做 URL 链接化。 */}
    {long && <MoreToggle open={open} onToggle={() => setOpen(!open)} />}
    {/* 仅长文本显示切换按钮。 */}
  </>
}

export function ConfirmButton({ label, title, message, onConfirm, variant = 'ghost', icon }: {
  // 带确认模态框的按钮：点击先弹窗，确认后才执行 onConfirm。
  label: string; title: string; message: string; onConfirm: () => Promise<unknown>; variant?: 'ghost' | 'outline'; icon?: IconName
}) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  // 模态框开关。
  const confirm = useAction(onConfirm)
  // 用 useAction 包装确认动作，获得 busy 与错误 Toast。
  return <>
    <Button variant={variant} size="sm" icon={icon && <Icon name={icon} size={14} />} onClick={() => setOpen(true)}>{label}</Button>
    {/* 触发按钮。 */}
    <Modal open={open} onClose={() => setOpen(false)} title={title} closeLabel={t('close')} description={message}
      footer={<>
        <Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        {/* 取消按钮。 */}
        <Button variant="primary" disabled={confirm.busy}
          onClick={() => { void confirm.run().then(done => { if (done) setOpen(false) }) }}>{t('confirm')}</Button>
        {/* 确认按钮：执行成功才关闭模态框。 */}
      </>} />
  </>
}
export function SessionButton({ sessionId, label,
  variant = 'ghost' }: { sessionId: string; label?: string; variant?: 'ghost' | 'outline' }) {
  // 打开会话按钮：调用面板的 openSession 能力。
  const { t, openSession, notify } = usePanel()
  return <Button variant={variant} size="sm" icon={<Icon name="session" size={14} />}
    onClick={() => { openSession(sessionId).catch(error => notify(errorText(error))) }}>{label ?? t('openSession')}</Button>
  {/* 失败时弹出错误通知。 */}
}
export function ExternalLink({ href, children, icon = 'external' }: { href: string; children: ReactNode; icon?: IconName }) {
  // 行内外链。
  return <a className="dt-inline-link dt-icon-link" href={href} {...external}><Icon name={icon} size={13} />{children}</a>
}
export function ActionLink({ href, children, icon = 'external' }: { href: string; children: ReactNode; icon?: IconName }) {
  // 按钮样式的动作外链。
  return <a className="dt-btn dt-btn-outline dt-btn-sm" href={href} {...external}><span className="dt-btn-icon"><Icon name={icon}
    size={14} /></span>{children}</a>
}
export function StageMark({ state, icon, label }: { state: DotState; icon: IconName; label: string }) {
  // 阶段标记：进行中显示动态状态点，否则显示图标，附文案。
  return <span className="dt-stage" data-state={state}>{state === 'ongoing' ? <StateDot state="ongoing" /> : <Icon name={icon}
    size={14} />}{label}</span>
}
export function LoadState({ error, loading }: { error?: Error | undefined; loading: boolean }) {
  // 加载状态占位：有错误显示错误，加载中显示提示，否则不渲染。
  const { t } = usePanel()
  if (error) return <p className="dt-error" role="alert">{error.message}</p>
  return loading ? <Hint>{t('loading')}</Hint> : null
}
export function LoadMore({ onMore }: { onMore: () => void }) {
  // “加载更多”按钮。
  const { t } = usePanel()
  return <Button variant="outline" size="sm" icon={<Icon name="chevron-down" size={14} />} onClick={onMore}>{t('loadMore')}</Button>
}

export function StatusHead({ hint, settings }: { hint: string; settings?: SettingsGroup }) {
  // 状态页页头：标题 + 说明气泡，可选跳转对应设置页。
  const { t, navigate } = usePanel()
  return <div className="dt-status-head">
    <h2 className="dt-status-title">{t('statusTitle')}<InfoTip text={hint} /></h2>
    {settings && <Button variant="ghost" size="sm" icon={<Icon name="settings" />}
      onClick={() => navigate(settingsRoute(settings))}>{t('tab.settings')}</Button>}
    {/* 提供设置分组时显示设置入口。 */}
  </div>
}
export function PageHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  // 详情页页头：左侧返回按钮 + 标题 + 可选动作区。
  const { back, backLabel } = usePanel()
  return <div className="dt-page-head">
    <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" />} onClick={back}>{backLabel}</Button>
    {/* 返回上一页。 */}
    <div className="dt-page-title"><h2>{title}</h2>{children && <span className="dt-actions">{children}</span>}</div>
    {/* 标题与动作区。 */}
  </div>
}
/** Trigger a host setup re-check and restart, prompting for confirmation when running Assignments would be interrupted. */
export function CheckSetupButton() {
  // “检查设置”按钮：触发宿主重新检查初始化并重启；有运行中任务时先确认。
  const { t, call, notify, restart } = usePanel()
  const { running } = usePanelData()
  // running：正在执行中的任务数。
  const check = async () => { await call('POST setup/check'); notify(t('setupChecking')); restart() }
  // 请求检查后提示并进入重启检测模式。
  const action = useAction(check)
  if (running > 0) {
    // 有运行中任务时改用确认弹窗，说明重启会中断它们。
    const message = t('setupCheckInterrupts', { count: running })
    return <ConfirmButton variant="outline" icon="refresh" label={t('setupCheck')} title={t('setupCheck')} message={message}
      onConfirm={check} />
  }
  const icon = <Icon name="refresh" size={14} />
  return <Button variant="outline" size="sm" icon={icon} disabled={action.busy}
    onClick={() => { void action.run() }}>{t('setupCheck')}</Button>
  // 无运行中任务时直接执行，busy 期间禁用。
}
