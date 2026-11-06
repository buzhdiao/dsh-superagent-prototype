/** Ticket detail page: stage and actions, Mandate details, undelivered/delivered Inputs, subscribed Threads, and Assignments. */
// 工单（Ticket）详情页：阶段与操作、授权（Mandate）详情、未送达/已送达输入（Input）、订阅线程与任务分配（Assignment）。
import { useState, type ReactNode } from 'react'
// useState 管理折叠状态。
import { ApiError, usePoll, type TicketPageView } from './api.ts'
// API 错误、轮询 Hook 与工单页数据类型。
import { DisclosureRow, Dot, Icon, Tag, type IconName } from './controls.tsx'
// 基础控件。
import { decisionMark, reportDot, ticketMark } from './marks.ts'
// 状态标记函数。
import { usePanel } from './provider.tsx'
// 面板上下文。
import { settingsRoute } from './route.ts'
// 设置页路由。
import { Earlier, ThreadLine, automatedRuns } from './rows.tsx'
// 列表行组件与自动消息分组。
import { actorName, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
// 文本辅助函数。
import { ActionLink, ConfirmButton, ExternalLink, Hint, KeyValues, LabelValue, LoadState, MarkdownLite, PageHead, Section, SessionButton,
  StageMark, When } from './widgets.tsx'
// 通用部件。

type Input = TicketPageView['inputs'][number]
// Input：单个输入记录类型。
function InputLine({ input, earlier = [] }: { input: Input; earlier?: { id: string; at: string; preview: string }[] }) {
  // 输入列表行：显示送达状态与内容。
  const { t, navigate } = usePanel()
  const trigger = input.kind === 'trigger' ? input.trigger : undefined
  // 输入若来自消息触发则取触发信息。
  return <li className="dt-row">
    <Dot state={input.delivered ? 'idle' : 'warning'} label={input.delivered ? t('inputDelivered') : t('inputUndelivered')} />
    {/* 送达状态点：未送达显示警告。 */}
    <div className="dt-row-main">
      {trigger ? <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'trigger',
        id: trigger.thread, query: { trigger: trigger.id } })}>
        {actorName(t, trigger.actor)}{t('labelSeparator')}{readableMarkers(t, trigger.preview) || t('empty')}
      </button></div> : <div className="dt-row-title">{valueLabel(t, 'input', input.kind)}</div>}
      {/* 消息输入跳转到对应触发位置；其他类型显示类型名。 */}
      <div className="dt-row-meta">{input.kind === 'trigger' && <span>{valueLabel(t, 'input', input.kind)}</span>}<When
        at={input.at} /></div>
      {/* 元信息：类型（消息触发时）与时间。 */}
      {(input.kind === 'text' || input.kind === 'note') && input.text && <div className="dt-row-quote"><MarkdownLite text={input.text} /></div>}
      {/* 文本/备注输入渲染 Markdown 内容。 */}
      {trigger?.handback && <Hint>{t('inputHandedBack', { reason: trigger.handback.reason })}</Hint>}
      {/* 触发被交还时显示原因。 */}
      <Earlier items={earlier} />
      {/* 折叠的更早自动输入。 */}
    </div>
  </li>
}
function InputList({ inputs }: { inputs: Input[] }) {
  // 输入列表：自动消息按发送者分组折叠。
  const sender = (input: Input) => input.kind === 'trigger' && input.trigger && !input.trigger.human
    ? `${input.trigger.actor.source}:${input.trigger.actor.id}` : undefined
  // 仅非人工消息触发参与分组。
  const shown = (input: Input) => ({ id: input.id, at: input.at, preview: input.kind === 'trigger' ? input.trigger?.preview ?? '' : '' })
  // 折叠摘要所需的预览字段。
  return <ul className="dt-list">{automatedRuns(inputs, sender).map(run => <InputLine key={run.item.id} input={run.item}
    earlier={run.earlier.map(shown)} />)}</ul>
}

function Details({ icon, title, open = false, children }: { icon: IconName; title: ReactNode; open?: boolean; children: ReactNode }) {
  // 详情折叠区通用封装。
  const [shown, setShown] = useState(open)
  return <DisclosureRow icon={<Icon name={icon} />} title={title} open={shown} onToggle={() => setShown(!shown)}>
    <div className="dt-disclosure-body">{children}</div>
    {/* 折叠内容。 */}
  </DisclosureRow>
}
function Assignments({ ticket }: { ticket: TicketPageView }) {
  // 任务分配（Assignment）列表。
  const { t } = usePanel()
  const report = (state: string) => t('assignmentReportShort', { state: valueLabel(t, 'report', state) })
  // 工作进程（worker）报告状态的简短文案。
  return <ul className="dt-list">{ticket.assignments.slice().reverse().map((item, index) => <li key={item.id} className="dt-row">
    <Dot state={item.state === 'running' ? reportDot(item.report?.state) : 'idle'} label={valueLabel(t, 'assignment', item.state)} />
    {/* 状态点：运行中的任务用报告状态着色。 */}
    <div className="dt-row-main">
      <div className="dt-row-title">{t('assignmentNumber', { number: ticket.assignments.length - index })}</div>
      {/* 序号（倒序后换算为正序编号）。 */}
      <div className="dt-row-meta">
        {/* A running Assignment whose worker reported a non-progress state has ended its turn; show that report as its tag and end its span there. */}
        {item.turnEndedAt && item.report ? <Tag tone="neutral">{report(item.report.state)}</Tag> : <Tag tone={item.state === 'running'
          ? 'info'
          : 'neutral'}>{valueLabel(t, 'assignment', item.state)}</Tag>}
        {/* 回合已结束的运行中任务显示其报告标签，否则显示任务状态。 */}
        {item.state !== 'running' && item.report && <span>{report(item.report.state)}</span>}
        {/* 非运行中且已有报告时补充报告状态。 */}
        <span>{t('assignmentSpan', { from: when(item.startedAt ?? item.createdAt, t('lang')), to: when(item.endedAt ?? item.turnEndedAt,
          t('lang')) || t('now') })}</span>
        {/* 起止时间区间：未结束显示“至今”。 */}
        {item.endedReason && <span>{reasonLabel(t, item.endedReason)}</span>}
        {/* 结束原因。 */}
      </div>
    </div>
    {item.ref && item.ref !== ticket.sessionId && <div className="dt-row-actions"><SessionButton variant="outline"
      sessionId={item.ref} /></div>}
    {/* 分配有独立会话时提供打开入口。 */}
  </li>)}</ul>
}
function MandateDetails({ ticket, actor }: { ticket: TicketPageView; actor: string }) {
  // 授权（Mandate）详情：触发来源、决策依据与基础事实。
  const { t, navigate } = usePanel()
  const { mandate, decision } = ticket
  // 授权与本次决策。
  const fact = (item: TicketPageView['basis']['facts'][number]): string => {
    // 把基础事实格式化为可读文本。
    if (item.name === 'legacyAuthority') return valueLabel(t, 'legacy', item.value)
    // 旧版权限来源。
    if (item.name === 'mode' || item.name === 'addressed') return valueLabel(t, item.name, item.value)
    // 模式与称呼方式。
    if (item.name === 'admission') return valueLabel(t, 'admissionCell', item.value)
    // 准入单元格。
    if (item.name === 'rules') return item.value.map(rule => rule.name).join(t('listSeparator'))
    // 命中规则名列表。
    return item.name === 'sender' ? item.value : t('yes')
    // sender 显示原值；其余布尔事实显示“是”。
  }
  const { legacy } = ticket.basis
  // Omit `sender` when it matches `actor`, which is already shown on the status line.
  const facts = ticket.basis.facts.filter(item => !(item.name === 'sender' && item.value === actor))
  // sender 与状态行已显示的 actor 相同时省略。
  const direction = decision?.direction
  // 实施方向信息。
  const rows: [string, ReactNode][] = decision ? [
    // 有决策时构造两行键值。
    [t('term.trigger'), <button type="button" className="dt-trigger-link" onClick={() => navigate({ page: 'trigger', id: decision.thread,
      query: { trigger: decision.triggerIds[0] ?? '' } })}>
      <span className="dt-trigger-text">{readableMarkers(t, decision.preview) || t('empty')}</span>
      <span className="dt-row-meta"><span>{valueLabel(t, 'source', mandate.actor.source)} · {actor}</span><When at={decision.at} /></span>
    </button>],
    // 触发行：预览文本 + 来源/操作者 + 时间，点击跳转到触发位置。
    [t('term.decision'), <div className="dt-kv-stack">
      <span>{decisionMark(t, decision.outcome).label}</span>
      {/* 决策结果。 */}
      <Hint>{reasonLabel(t, decision.reason)}</Hint>
      {/* 决策原因。 */}
      {decision.rules.map(rule => <Hint key={rule.id}>{t(rule.matched ? 'ruleMatched' : 'ruleUnmatched', { rule: rule.name,
        reason: rule.reason })}</Hint>)}
      {/* 各规则的命中情况与原因。 */}
      {direction && <Hint>{t('directionLine', { intent: t(direction.implementation_requested ? 'intentYes' : 'intentNo'),
        basis: valueLabel(t, 'targetBasis', direction.target_basis),
        design: t(direction.requires_design_decision ? 'designNeeded' : 'designNotNeeded') })} {t('directionEvidence',
          { evidence: direction.evidence })}</Hint>}
      {/* 实施方向概述与依据证据。 */}
    </div>],
  ] : []
  const version = <button type="button" className="dt-textlink dt-mono" onClick={() => navigate(settingsRoute('eval',
    { version: mandate.policyVersion }))}>{mandate.policyVersion.slice(0, 8)}</button>
  {/* 策略版本号按钮：跳转到评估设置中的该版本。 */}
  return <Section title={t('mandateDetails')} icon="shield">
    <KeyValues rows={[...rows, [t('term.scope'), legacy ? t('legacyScopeShort') : mandate.scope || t('empty')],
      ...facts.map((item): [string, string] => [valueLabel(t, 'basis', item.name), fact(item)]),
      ...legacy ? [] : [[t('policyVersion'), version] as [string, ReactNode]]]} />
    {/* 键值对：触发行、决策行、范围、基础事实、策略版本（旧版无版本号）。 */}
  </Section>
}

export function TicketPage({ id }: { id: string }) {
  // 工单详情页组件。
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET tickets/:id', { id }), [id])
  // 轮询工单详情。
  const after = async (request: Promise<unknown>) => { await request; await reload() }
  // 执行操作后刷新。
  if (!data) return <><PageHead
    title={t('term.ticket')} />{error instanceof ApiError && error.missing ? <Hint>{t('ticketNotFound')}</Hint> : <LoadState
      error={error} loading />}</>
  // 无数据时：404 显示未找到，否则显示加载/错误占位。
  const status = ticketMark(t, data)
  // 工单状态标记。
  const actor = actorName(t, data.mandate.actor)
  // 授权操作者显示名。
  const { legacy } = data.basis
  // 是否旧版授权。
  const undelivered = data.inputs.filter(input => !input.delivered)
  // 未送达的输入。
  const failedText = /^(?:\w+Error|Error)\b[:：]/.test(data.summary)
  // 摘要形如“*Error:”时视为失败文本，用等宽字体展示。
  const failed = data.stage === 'person' && data.action === 'failed'
  // 当前处于人工失败动作。
  const opening = data.threads.find(thread => thread.url)
  // 第一个有链接的线程（用于打开原始消息）。
  const ended = data.ended && (() => {
    // 结束状态文案。
    const outcome = valueLabel(t, 'outcome', data.ended.outcome), reason = reasonLabel(t, data.ended.reason), time = when(data.ended.at,
      t('lang'))
    return reason ? t('endedAt', { time, outcome, reason }) : t('endedAtShort', { time, outcome })
  })()
  const channel = data.channels[0]
  // 第一个渠道（用于跳转回复）。
  return <>
    <PageHead title={data.title}>
      {opening?.url && <ActionLink href={opening.url}>{t('openThread', { source: valueLabel(t, 'source', opening.source) })}</ActionLink>}
      {/* 打开原始线程外链。 */}
      {data.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
        message={t('retryConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/retry', { id }))} />}
      {/* 重试按钮（需确认）。 */}
      {data.sessionId && <SessionButton variant="outline" sessionId={data.sessionId} />}
      {/* 打开会话按钮。 */}
    </PageHead>
    {error && <LoadState error={error} loading={false} />}
    {/* 后续轮询出错提示。 */}
    <div className="dt-row-meta dt-status-line">
      <StageMark state={status.dot} icon={status.icon} label={status.label} />
      {/* 阶段标记。 */}
      <LabelValue label={t('ticketMandateLabel')} value={valueLabel(t, 'strength', data.mandate.strength)} />
      {/* 授权强度。 */}
      <LabelValue label={t('ticketActorLabel')} value={`${valueLabel(t, 'source', data.mandate.actor.source)} · ${actor}`} />
      {/* 授权来源与操作者。 */}
      <LabelValue label={t('ticketUpdatedLabel')} value={when(data.updatedAt, t('lang'))} />
      {/* 更新时间。 */}
    </div>
    {ended && <Hint>{ended}</Hint>}
    {/* 已结束提示。 */}
    {data.attention && <div className="dt-banner"><span className="dt-banner-label">{t('attentionPrefix')}</span><MarkdownLite
      text={data.attention.question} />
      {/* 需要关注的问题横幅。 */}
      {channel && <div className="dt-banner-actions">
        <ActionLink href={channel.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source', channel.source) })}</ActionLink>
        {/* 到渠道回复的按钮。 */}
      </div>}</div>}
    {/* Ordinary progress stays in the Session/Channels; only a report that halted work (blocked/failed) is shown here. */}
    {data.actions.retry && data.summary && <p className={`dt-banner${failed ? ' dt-danger' : ''}${failedText ? ' dt-mono' : ''}`}>
      <span className="dt-banner-label">{t(failed ? 'failedPrefix' : 'blockedPrefix')}</span>{data.summary}
      {/* 只有阻塞/失败的报告才在此显示；失败时红色、错误文本用等宽字体。 */}
    </p>}
    {data.deliveryError && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('deliveryFailedPrefix')}</span>{data.deliveryError}
      {/* 送达失败横幅。 */}
    </p>}
    <MandateDetails ticket={data} actor={actor} />
    {/* 授权详情。 */}
    {undelivered.length > 0 && <Section title={t('undeliveredInputs')} count={undelivered.length}>
      <Hint>{data.deliveryError ? t('inputRetryHint') : data.paused ? t('inputPausedHint') : t('inputWaitingHint')}</Hint>
      {/* 未送达原因提示：送达失败/已暂停/等待中。 */}
      <InputList inputs={undelivered} />
      {/* 未送达输入列表。 */}
    </Section>}
    {data.threads.length > 0 && <Section title={t('subscribedThreads')} count={data.threads.length}>
      <ul className="dt-list">{data.threads.map(thread => <ThreadLine key={thread.key} thread={thread} ticketId={data.id}
        context={thread.context} />)}</ul>
      {/* 订阅线程列表；ticketId 让本工单不出现在扇出目标里。 */}
    </Section>}
    <div className="dt-details">
      {/* A single Assignment adds nothing beyond the status line; list Assignments only once work has been resumed or handed over. */}
      {data.assignments.length > 1 && <Details icon="queue" title={`${t('term.assignment')} · ${data.assignments.length}`} open><Assignments
        ticket={data} /></Details>}
        {/* 单次分配没有额外信息；只有续跑/交接后才展示分配列表。 */}
      {data.environment.length > 0 && <Details icon="settings" title={t('term.environment')}>
        <table className="dt-table"><tbody>{data.environment.map(variable => <tr key={variable.key} title={localized(t,
          variable.description)}>
          <td className="dt-mono">{variable.key}</td><td className="dt-mono">{variable.value || <span
            className="dt-hint">{t('empty')}</span>}</td>
          {/* 环境变量表：键与值（空值显示占位），title 提供描述。 */}
        </tr>)}</tbody></table>
      </Details>}
      <Details icon="message" title={t('term.channel')}>
        <ul className="dt-plain-list">{data.channels.map((item, index) => <li key={index}>
          <ExternalLink href={item.url} icon={item.source === 'github' ? 'pull' : 'message'}>{localized(t, item.label)}</ExternalLink>
          {/* 渠道链接：GitHub 用 PR 图标，其余用消息图标。 */}
        </li>)}</ul>
      </Details>
      {data.inputs.length > undelivered.length && <Details icon="inbox" title={t('deliveredInputs',
        { count: data.inputs.length - undelivered.length })}>
        <InputList inputs={data.inputs.filter(input => input.delivered)} />
        {/* 已送达输入折叠列表。 */}
      </Details>}
      <Details icon="hash" title={t('identifiers')}>
        <KeyValues rows={[[t('ticketId'), <span className="dt-mono">{data.id}</span>], [t('executionDirectory'), <span
          className="dt-mono">{data.directory ?? t('empty')}</span>],
          ...legacy && data.mandate.scope ? [[t('legacyAssignment'), <span
            className="dt-mono dt-clamp">{data.mandate.scope}</span>] as [string, ReactNode]] : []]} />
        {/* 标识信息：工单 id、执行目录，旧版授权额外显示分配范围。 */}
      </Details>
    </div>
    {data.actions.stop && <div className="dt-danger-zone">
      <span className="dt-hint">{t('stopHint')}</span>
      <ConfirmButton variant="outline" label={t('stop')} title={t('stopConfirmTitle')} message={t('stopConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/stop', { id }))} />
      {/* 危险区：确认后停止工单。 */}
    </div>}
  </>
}
