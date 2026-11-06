/** Shared list rows for Tickets, Threads, and Decisions, plus Source fact chips and automated-message run folding. */
// 共享列表行组件：工单（Ticket）、线程（Thread）、决策（Decision），以及来源事实小片与自动消息折叠。
import { useState } from 'react'
// useState：管理折叠组件的展开状态。
import type { DecisionRow, ThreadFacts, ThreadRow, TicketRow } from './api.ts'
// 各列表行数据的 API 类型。
import { Icon, Tag } from './controls.tsx'
// 图标与标签控件。
import { decisionMark, threadMark, ticketMark } from './marks.ts'
// 把行数据映射为状态点/图标/文案的标记函数。
import { usePanel } from './provider.tsx'
// usePanel：读取面板上下文。
import { actorName, localized, readableMarkers, reasonLabel, valueLabel } from './text.ts'
// 文本辅助：操作者名、双语、占位标记清理、原因与取值标签。
import { ActionLink, ConfirmButton, LabelValue, SessionButton, StageMark, When } from './widgets.tsx'
// 通用部件：动作链接、确认按钮、键值对、会话按钮、阶段标记、时间。

export function TicketLine({ ticket, question, onChanged, context }: {
  // 工单列表行组件。
  ticket: TicketRow; question?: boolean; onChanged?: () => Promise<void>; context?: boolean
  // question 表示在提问视图（用状态点标记）；onChanged 在操作后回调刷新；context 标记“仅上下文”。
}) {
  const { t, call, navigate } = usePanel()
  // 取翻译、请求与导航能力。
  const status = ticketMark(t, ticket)
  // 计算工单的状态点、图标与文案。
  const after = async (request: Promise<unknown>) => { await request; await onChanged?.() }
  // 执行请求后触发父级刷新。
  const note = question && ticket.note && { ...ticket.note, text: readableMarkers(t, ticket.note.text) }
  // 提问视图下展示备注，并把其中的占位标记替换为可读文本。
  const answer = ticket.reply && ticket.stage === 'person' && ticket.action === 'answer' ? ticket.reply : undefined
  // 仅当工单处于“人工待答复”阶段时才显示跳转回复的链接。
  return <li className="dt-row dt-link dt-ticket" data-state={question ? status.dot : undefined}>
    {/* 列表行：提问视图下把状态写入 data-state 供样式使用。 */}
    <div className="dt-ticket-stage"><StageMark state={status.dot} icon={status.icon} label={status.label} /></div>
    {/* 左侧阶段标记列。 */}
    <div className="dt-ticket-body">
      {/* 右侧主体列。 */}
      <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'execution',
        id: ticket.id })}>{ticket.title}</button></div>
      {/* 标题按钮：点击进入该工单的执行详情页。 */}
      <div className="dt-row-meta dt-ticket-meta">
        {/* 元信息行。 */}
        {ticket.threads.map(thread => <ThreadChip key={thread.key} thread={thread} />)}
        {/* 关联线程的小片。 */}
        {context && <ContextTag />}
        {/* 仅上下文标记。 */}
        {ticket.undelivered > 0 && <LabelValue label={t('ticketUndeliveredLabel')} value={ticket.undelivered} />}
        {/* 存在未送达回复时显示计数。 */}
        {note ? <span className={note.error ? 'dt-ticket-note dt-ticket-note-error' : 'dt-ticket-note'} title={note.text}>{note.text}</span>
          : <When at={ticket.updatedAt} />}
        {/* 有备注显示备注（错误备注高亮），否则显示更新时间。 */}
      </div>
      {/* Always render the actions container so every Ticket row keeps a uniform three-line height. */}
      <div className="dt-ticket-actions">{onChanged && <>
        {/* 操作区始终渲染以保证行高一致；仅在支持刷新回调时填充内容。 */}
        {answer && <ActionLink href={answer.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source',
          answer.source) })}</ActionLink>}
        {/* 待答复时显示“到来源里回复”的外链。 */}
        {ticket.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
          message={t('retryConfirm', { title: ticket.title })}
          onConfirm={() => after(call('POST tickets/:id/retry', { id: ticket.id }))} />}
        {/* 允许重试时显示确认重试按钮。 */}
        {ticket.actions.retry && ticket.sessionId && <SessionButton variant="outline" sessionId={ticket.sessionId} />}
        {/* 有关联会话且可重试时提供打开会话入口。 */}
        {ticket.actions.stop && <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('stopConfirmTitle')}
          message={t('stopConfirm', { title: ticket.title })}
          onConfirm={() => after(call('POST tickets/:id/stop', { id: ticket.id }))} />}
        {/* 允许停止时显示确认停止按钮。 */}
      </>}</div>
    </div>
  </li>
}

function ContextTag() {
  // “仅上下文”小标签：该线程/工单只作为上下文，不触发扇出。
  const { t } = usePanel()
  return <Tag tone="quiet" title={t('contextOnlyHint')}>{t('contextOnly')}</Tag>
}
/** Thread list row; on a Ticket page, `ticketId` omits that Ticket from fanout targets and `context` marks context-only threads. */
export function ThreadLine({ thread, ticketId, context }: { thread: ThreadRow; ticketId?: string; context?: boolean }) {
  // 线程列表行；在工单页中 ticketId 用于把当前工单排除在扇出目标之外，context 标记仅上下文线程。
  const { t, navigate } = usePanel()
  const live = thread.tickets.filter(ticket => ticket.state === 'open' && ticket.id !== ticketId)
  // 仍然打开的扇出目标工单（排除当前工单页自身的工单）。
  const { dot, icon, label } = threadMark(t, thread)
  // 线程状态标记。
  const reaches = live.length > 0 && `${live[0]!.title}${live.length > 1 ? t('andMore', { count: live.length - 1 }) : ''}`
  // 扇出目标预览：显示第一个工单标题，多余以“等 N 个”概括；无目标时为 false。
  return <li className="dt-row dt-link dt-ticket">
    <div className="dt-ticket-stage"><StageMark state={dot} icon={icon} label={label} /></div>
    {/* 左侧状态列。 */}
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <button type="button" className="dt-open" title={thread.pollError} onClick={() => navigate({ page: 'trigger',
          id: thread.key })}>{readableMarkers(t, thread.title)}</button>
        {/* 标题按钮进入线程详情；轮询错误放在 title 提示里。 */}
      </div>
      <div className="dt-row-quote dt-line">
        {thread.latest && <>{actorName(t, thread.latest.actor)}{t('labelSeparator')}{readableMarkers(t, thread.latest.preview)
          || t('empty')}</>}
        {/* 最新一条消息：操作者 + 预览文本（空时显示占位）。 */}
      </div>
      <div className="dt-row-meta dt-line">
        <ThreadChip thread={thread} />
        {/* 来源与事实小片。 */}
        {context && <ContextTag />}
        {/* 仅上下文标记。 */}
        {thread.pollError ? <span className="dt-line-text dt-error-text">{thread.pollError}</span> : reaches && <LabelValue
          label={t('fanoutTo')} value={reaches} />}
        {/* 轮询出错显示错误，否则显示扇出目标。 */}
        <When at={thread.lastAt} />
        {/* 最近活动时间。 */}
      </div>
    </div>
  </li>
}

export function DecisionLine({ decision }: { decision: DecisionRow }) {
  // 决策列表行：展示一次触发/路由决策的结果。
  const { t, navigate } = usePanel()
  const matched = decision.rules.filter(rule => rule.matched).map(rule => rule.name)
  // 命中的规则名列表。
  const mark = decisionMark(t, decision.outcome)
  // 决策结果对应的状态标记。
  const preview = readableMarkers(t, decision.preview)
  // 消息预览（清理占位标记）。
  const reason = decision.reason ? reasonLabel(t, decision.reason) : ''
  // 决策原因的本地化文本。
  const open = () => decision.ticketId ? navigate({ page: 'execution', id: decision.ticketId })
    : navigate({ page: 'trigger', id: decision.thread, query: { trigger: decision.triggerIds[0] ?? '' } })
  // 点击跳转：有关联工单进工单页，否则进线程详情并定位到触发器。
  return <li className="dt-row dt-link dt-ticket">
    <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={mark.label} /></div>
    {/* 左侧结果标记。 */}
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <button type="button" className="dt-open" title={reason || undefined} onClick={open}>
          {decision.ticketTitle ?? (decision.threadTitle ? readableMarkers(t, decision.threadTitle) : preview || t('empty'))}
          {/* 标题优先用工单标题，其次线程标题，最后退回消息预览。 */}
        </button>
      </div>
      <div className="dt-row-quote dt-line">{preview}</div>
      {/* 消息预览行。 */}
      <div className="dt-row-meta dt-line">
        {reason && <span className="dt-line-text">{reason}</span>}
        {/* 原因文本。 */}
        {matched.length > 0 && <LabelValue label={t('ruleLabel')} value={matched.join(t('listSeparator'))} />}
        {/* 命中的规则。 */}
        <When at={decision.at} />
        {/* 决策时间。 */}
      </div>
    </div>
  </li>
}

function ThreadChip({ thread }: { thread: Pick<ThreadFacts, 'source' | 'facts' | 'url' | 'title'> }) {
  // 线程小片：显示来源名与各事实（fact），有链接时整片可点击跳转原消息。
  const { t } = usePanel()
  const cells = <>
    <span className="dt-chip-source">{valueLabel(t, 'source', thread.source)}</span>
    {/* 来源名。 */}
    {Object.entries(thread.facts).map(([id, fact]) => <span key={id} className={fact.problem ? 'dt-chip-fact dt-chip-problem'
      : 'dt-chip-fact'}>
      {/* 每个事实一个小片；有问题时高亮。 */}
      {fact.label && <span className="dt-chip-label">{localized(t, fact.label)}</span>}{localized(t, fact.value)}
      {/* 可选标签 + 事实值。 */}
    </span>)}
  </>
  // 无链接时渲染为普通小片。
  return thread.url ? <a className="dt-chip dt-chip-link" href={thread.url} target="_blank" rel="noopener noreferrer" title={thread.title}>
    {cells}<span className="dt-chip-open"><Icon name="external" size={11} /></span>
    {/* 有链接渲染为外链 a 标签，附外部打开图标。 */}
  </a> : <span className="dt-chip">{cells}</span>
}

type Run<I> = { item: I; earlier: I[] }
// Run：代表一组连续自动消息——最新一条 item + 折叠的 earlier 列表。
/** Group consecutive automated items from the same sender so only the newest is shown by default. */
export function automatedRuns<I>(items: I[], sender: (item: I) => string | undefined): Run<I>[] {
  // 把同一发送者连续出现的自动消息分组，默认只展示最新一条。
  const runs: Run<I>[] = []
  for (const item of items) {
    const last = runs.at(-1), from = sender(item)
    // 取当前最后一个分组与该消息的发送者。
    if (last && from !== undefined && sender(last.item) === from) last.earlier.push(item)
    // 发送者与上一组相同则并入其 earlier。
    else runs.push({ item, earlier: [] })
    // 否则开新组。
  }
  return runs
}
export function Earlier({ items }: { items: { id: string; at: string; preview: string }[] }) {
  // “更早的自动消息”折叠组件：默认收起，可展开查看。
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  // 无内容不渲染。
  return <div>
    <button type="button" className="dt-textlink" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? t('collapse') : t('automatedEarlier', { count: items.length })}
      {/* 展开时显示“收起”，收起时显示“更早的 N 条”。 */}
    </button>
    {open && <ul className="dt-plain-list dt-hint">{items.map(item => <li key={item.id}><When
      at={item.at} /> · {readableMarkers(t, item.preview) || t('empty')}</li>)}</ul>}
    {/* 展开后逐条列出时间与预览。 */}
  </div>
}
