/** Thread detail page: Trigger timeline with gap-free pagination, Decisions, subscribed Tickets, and correlated Threads. */
// 线程（Thread）详情页：无缺口分页的触发（Trigger）时间线、决策、订阅的工单与关联线程。
import { useEffect, useState, type ReactNode } from 'react'
// useEffect 管理补页副作用；useState 管理折叠状态。
import { ApiError, usePoll, type ThreadPageView, type TriggerRow } from './api.ts'
// API 错误类型、轮询 Hook 与线程页数据类型。
import { Button, DisclosureRow, Icon, Tag } from './controls.tsx'
// 基础控件。
import { decisionMark } from './marks.ts'
// 决策结果标记。
import { useAction, usePanel } from './provider.tsx'
// 面板 Hook。
import { DecisionLine, Earlier, TicketLine, automatedRuns } from './rows.tsx'
// 列表行组件与自动消息分组工具。
import { actorName, errorText, readableMarkers, reasonLabel, valueLabel, when, type T } from './text.ts'
// 文本辅助函数。
import { ActionLink, ClampText, ConfirmButton, Hint, LoadState, PageHead, Section, When } from './widgets.tsx'
// 通用部件。

/** Disposition tags for a Trigger; omits `ignore` (the common case) and suppresses fanout tags when every target Ticket is already listed in `subscribed`. */
function triggerTags(t: T, trigger: TriggerRow, subscribed?: Set<string>): ReactNode {
  // 触发处置（disposition）标签：省略最常见的 ignore；扇出目标已全部在订阅列表时不再显示扇出标签。
  const d = trigger.disposition
  // 该触发的处置信息。
  const tags: ReactNode[] = []
  if (d.queued) tags.push(<Tag key="q" tone="info">{t('dispositionQueued')}</Tag>)
  // 已排队。
  else if (d.evaluating) tags.push(<Tag key="e" tone="info">{t('dispositionEvaluating')}</Tag>)
  // 评估中。
  else if (d.filtered) tags.push(<Tag key="f" tone="neutral">{t('tagFiltered', { reason: reasonLabel(t, d.filtered) })}</Tag>)
  // 被过滤（附原因）。
  else if (d.decision && d.decision.outcome !== 'ignore') {
    // 有决策且结果不是 ignore 时显示决策标签。
    const { tone, label } = decisionMark(t, d.decision.outcome)
    tags.push(<Tag key="d" tone={tone}>{label}</Tag>)
  }
  if (d.delivered) tags.push(<Tag key="o" tone="info" title={t('dispositionDeliveredHint')}>{t('dispositionDelivered')}</Tag>)
  // 已送达。
  else if (d.fanout.length && !(subscribed && d.fanout.every(id => subscribed.has(id)))) tags.push(<Tag key="o"
    tone="info">{t('dispositionFanout', { count: d.fanout.length })}</Tag>)
  // 有扇出且并非全部已订阅时显示扇出数量。
  return tags
}

function TriggerItem({ trigger, earlier, target, subscribed, requeue }: {
  // 时间线里的单个触发事件。
  trigger: TriggerRow; earlier: TriggerRow[]; target: string | undefined; subscribed: Set<string>
  requeue: { busy: boolean; run: () => void } | undefined
  // earlier 为折叠的同发送者自动消息；target 为深链定位的触发 id；requeue 为重新入队动作。
}) {
  const { t, navigate } = usePanel()
  const ticketId = trigger.disposition.decision?.ticketId
  // 决策产出的工单 id。
  const scroll = (element: HTMLLIElement | null) => {
    // 深链目标触发渲染时滚动到视口中央（dataset 防重复）。
    if (element && target === trigger.id
      && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) }
  }
  return <li id={`trigger-${trigger.id}`} className={`dt-event${target === trigger.id ? ' dt-highlight' : ''}${trigger.human ? ''
    : ' dt-event-quiet'}`} ref={scroll}>
    {/* 事件条目：深链目标高亮；非人工消息弱化显示。 */}
    <div className="dt-event-foot"><strong className="dt-event-actor">{actorName(t, trigger.actor)}</strong><When
      at={trigger.at} /></div>
    {/* 发送者与时间。 */}
    <ClampText text={readableMarkers(t, trigger.text || trigger.preview)} />
    {/* 消息正文（长文本可折叠），优先用全文。 */}
    <Earlier items={earlier} />
    {/* 被折叠的更早自动消息。 */}
    {trigger.disposition.handbacks.map(item => <Hint key={item.ticketId}>{t('handedBack', { ticket: item.title,
      reason: item.reason })}</Hint>)}
    {/* 交还（handback）记录。 */}
    <div className="dt-event-foot">
      {triggerTags(t, trigger, subscribed)}
      {/* 处置标签。 */}
      {ticketId && !subscribed.has(ticketId) && <button type="button" className="dt-textlink dt-icon-link"
        onClick={() => navigate({ page: 'execution', id: ticketId })}>{t('openTicket')}</button>}
        {/* 决策产出工单且未在下方订阅列表时提供打开入口。 */}
      {requeue && <button type="button" className="dt-textlink dt-icon-link dt-reveal" disabled={requeue.busy} aria-busy={requeue.busy}
        onClick={requeue.run}>
        <Icon name="refresh" size={13} />{t('requeue')}
        {/* 重新评估（requeue）按钮。 */}
      </button>}
    </div>
  </li>
}
interface Older { triggers: TriggerRow[]; cursor: string | null }
// Older：手动/补页加载的更早数据及分页游标。
const overlaps = (some: TriggerRow[], others: TriggerRow[]) => some.some(item => others.some(other => other.id === item.id))
// 两组触发是否存在 id 交集（判断页面是否衔接）。
const byTime = (triggers: TriggerRow[]) => [...new Map(triggers.map(item => [item.id, item])).values()]
  .sort((a, b) => a.at.localeCompare(b.at))
  // 按 id 去重后按时间升序排序。
const gapBetween = (newest: ThreadPageView, older: Older | undefined): boolean =>
  !!older && newest.earlier !== null && !overlaps(newest.timeline, older.triggers)
  // 轮询到的最新页与已加载的更早页之间是否存在时间缺口。
function mergeTimeline(newest: ThreadPageView, older: Older | undefined): ThreadPageView {
  // 合并最新轮询页与更早页；有缺口时暂不合并（等待补页），避免时间线出现跳跃。
  if (!older || newest.earlier === null || gapBetween(newest, older)) return newest
  return { ...newest, timeline: byTime([...older.triggers, ...newest.timeline]), earlier: older.cursor }
  // 无缺口时按时间合并，游标取更早页的游标。
}
const PAGE = 50
// 每页加载的触发数量。
/**
 * Manage a Thread's timeline across live polling, deep-linked `target` Triggers, and manual pagination.
 * Fills any gap between the latest polled page and older loaded pages before merging so the timeline remains contiguous.
 */
function useThreadTimeline(key: string, target: string | undefined) {
  // 线程时间线管理 Hook：轮询最新页、深链定位、手动分页，并在合并前自动补齐缺口。
  const { call, notify } = usePanel()
  const [older, setOlder] = useState<Older>()
  // 已加载的更早页。
  const { data: newest, error, reload } = usePoll(() => call('GET threads/:key', { key, query: { limit: PAGE } }), [key])
  // 轮询最新一页。
  const data = newest && mergeTimeline(newest, older)
  // 合并后的展示数据。
  const read = (id: string) => !!newest?.timeline.some(item => item.id === id) || !!older?.triggers.some(item => item.id === id)
  // 判断某个触发是否已在已加载数据中。
  const missing = !!target && !!newest && !read(target)
  // 深链目标触发尚未加载时为 true。
  useEffect(() => {
    // 加载包含目标触发的一页（around 定位）。
    if (!missing) return
    let active = true
    call('GET threads/:key', { key, query: { limit: PAGE, around: target } }).then(page => {
      if (active) setOlder({ triggers: page.timeline, cursor: page.earlier })
      // 卸载后不再写入状态。
    }, (failure: unknown) => { if (active) notify(errorText(failure)) })
    return () => { active = false }
  }, [missing, call, key, target, notify])
  const gap = !!newest && gapBetween(newest, older)
  // 最新页与更早页之间出现缺口（例如轮询到新数据后）。
  useEffect(() => {
    // 补页：从最新页的游标向前翻页，直到与更早页衔接。
    if (!gap || !newest || !older) return
    let active = true
    const fill = async () => {
      let run = newest.timeline, cursor = newest.earlier
      // run 为已收集的衔接数据，cursor 为当前向前翻页的位置。
      while (cursor !== null && !overlaps(run, older.triggers)) {
        const page = await call('GET threads/:key', { key, query: { limit: PAGE, before: cursor } })
        run = [...page.timeline, ...run]; cursor = page.earlier
        // 逐页向前加载并累积，直到与已加载的更早页重叠。
      }
      if (active) setOlder({ triggers: byTime([...older.triggers, ...run]), cursor: overlaps(run, older.triggers) ? older.cursor : cursor })
      // 合并去重；若补到了衔接则保留原游标，否则用新的游标。
    }
    fill().catch((failure: unknown) => { if (active) notify(errorText(failure)) })
    // 补页失败弹出通知。
    return () => { active = false }
  }, [gap, newest, older, call, key, notify])
  const earlier = useAction(async (shown: ThreadPageView) => {
    // 手动“加载更早”：以当前展示数据的游标向前取一页并合并。
    const page = await call('GET threads/:key', { key, query: { limit: PAGE, before: shown.earlier! } })
    setOlder({ triggers: [...page.timeline, ...shown.timeline], cursor: page.earlier })
  })
  return { data, error, reload, earlier }
}
export function ThreadPage({ id, target }: { id: string; target?: string }) {
  // 线程详情页组件；target 为可选的深链触发 id。
  const { t, call, navigate, notify } = usePanel()
  const [decisionsOpen, setDecisionsOpen] = useState(false)
  // 决策折叠区状态。
  const { data, error, reload, earlier } = useThreadTimeline(id, target)
  // 时间线数据与动作。
  const requeue = useAction(async (trigger: string) => {
    // 重新入队动作：触发对该消息重新评估。
    const result = await call('POST triggers/:id/requeue', { id: trigger })
    if (!result.queued) notify(t('requeueAlready'))
    // 已在队列中时提示无需重复。
  }, { reload })
  if (!data) return <><PageHead
    title={t('term.thread')} />{error instanceof ApiError && error.missing ? <Hint>{t('threadNotFound')}</Hint> : <LoadState
      error={error} loading />}</>
  // 无数据时：404 显示未找到，否则显示加载/错误占位。
  const subscribed = new Set(data.tickets.map(ticket => ticket.id))
  // 已订阅工单 id 集合。
  // Never fold a deep-linked `target` Trigger into an automated run.
  const sender = (trigger: TriggerRow) => !trigger.human && trigger.id !== target ? `${trigger.actor.source}:${trigger.actor.id}`
    : undefined
  // 自动消息分组键：仅非人工且非深链目标的消息参与折叠。
  const unsubscribe = async () => {
    // 取消订阅：退订后若上下文投递仍待处理则提示。
    const result = await call('POST threads/:key/unsubscribe', { key: data.key })
    if (result.context_delivery === 'pending') notify(t('unsubscribePending'))
    await reload()
  }
  return <>
    <PageHead title={readableMarkers(t, data.title)}>{data.url && <ActionLink href={data.url}>{t('openOriginal')}</ActionLink>}</PageHead>
    {/* 页头：标题 + 打开原始消息外链。 */}
    {error && <LoadState error={error} loading={false} />}
    {/* 数据已加载但轮询出错时显示错误。 */}
    <div className="dt-row-meta dt-status-line">
      <span>{valueLabel(t, 'source', data.source)}</span><span>{t('threadLatest',
        { time: when(data.lastAt, t('lang')) })}</span><span>{t('threadCreated', { time: when(data.createdAt, t('lang')) })}</span>
      {/* 来源、最近消息时间、创建时间。 */}
    </div>
    {data.evaluating && <p className="dt-banner">
      {t('evaluatingBanner', { count: data.evaluating.triggers, strength: valueLabel(t, 'strength', data.evaluating.strength),
        deadline: when(data.evaluating.deadline, t('lang')) })}
      {/* 有评估进行中时显示横幅：数量、强度与截止时间。 */}
    </p>}
    {data.pollError && <p className="dt-error dt-clamp">{t('pollFailed', { error: data.pollError })}</p>}
    {/* 拉取消息失败的提示。 */}
    {data.tickets.length > 0 && <Section title={t('subscribedTickets')} count={data.tickets.length}>
      <ul className="dt-list">{data.tickets.map(ticket => <TicketLine key={ticket.id} ticket={ticket}
        context={data.context.includes(ticket.id)} />)}</ul>
      {/* 订阅的工单列表；仅上下文的工单带标记。 */}
    </Section>}
    {data.decisions.length > 0 && <DisclosureRow icon={<Icon name="decision" />} title={t('threadDecisions',
      { count: data.decisions.length })} open={decisionsOpen}
      onToggle={() => setDecisionsOpen(!decisionsOpen)}>
      {/* 决策折叠区。 */}
      <div className="dt-disclosure-body"><ul className="dt-list">{data.decisions.map(decision => <DecisionLine key={decision.id}
        decision={decision} />)}</ul></div>
    </DisclosureRow>}
    {data.correlated.length > 0 && <Section title={t('term.correlation')}>
      <ul className="dt-plain-list">{data.correlated.map(item => <li key={item.key}>
        <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'trigger', id: item.key })}>{readableMarkers(t,
          item.title)}</button>
        {/* 关联线程跳转。 */}
      </li>)}</ul>
    </Section>}
    <Section title={t('timeline')} count={t('newestFirst')}>
      {/* 时间线分节（按最新在前排序）。 */}
      {data.timeline.length ? <ol className="dt-timeline">{automatedRuns(data.timeline.slice().reverse(), sender).map(({ item,
        earlier: folded }) =>
        <TriggerItem key={item.id} trigger={item} earlier={folded} target={target} subscribed={subscribed}
          requeue={item.actions.requeue ? { busy: requeue.busy, run: () => { void requeue.run(item.id) } } : undefined} />)}</ol>
            : <Hint>{t('noTriggers')}</Hint>}
        {/* 倒序后按自动消息分组渲染；空时显示占位。 */}
      {data.earlier && <div>
        <Button variant="outline" size="sm" icon={<Icon name="chevron-down"
          size={14} />} disabled={earlier.busy} onClick={() => { void earlier.run(data) }}>
          {t('loadEarlier')}
          {/* 手动加载更早一页。 */}
        </Button>
      </div>}
    </Section>
    {data.tickets.length > 0 && <div className="dt-danger-zone">
      <span className="dt-hint">{t('unsubscribeHint')}</span>
      <ConfirmButton variant="outline" icon="unsubscribe" label={t('unsubscribe')} title={t('unsubscribeTitle')}
        message={t('unsubscribeConfirm', { title: data.title })}
        onConfirm={unsubscribe} />
      {/* 危险区：确认后取消订阅。 */}
    </div>}
  </>
}
