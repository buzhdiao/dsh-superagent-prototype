/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and Executor load. */
// 总览页：待人工处理的工单、系统问题、24 小时流量统计与执行器负载。
import type { ReactNode } from 'react'
// 引入 React 节点类型。
import { usePoll, type Problem } from './api.ts'
// 引入轮询 Hook 与问题条目类型。
import { Button, Icon } from './controls.tsx'
// 引入按钮与图标组件。
import { useAction, usePanel, usePanelData } from './provider.tsx'
// 引入动作 Hook 与面板上下文。
import { setupPage, settingsRoute, type Route } from './route.ts'
// 引入路由工具。
import { TicketLine } from './rows.tsx'
// 引入工单行组件。
import { healthText, localized, reasonLabel, valueLabel, readableMarkers } from './text.ts'
// 引入展示工具。
import { CheckSetupButton, ConfirmButton, Hint, LoadState, Section, SetupMessage } from './widgets.tsx'
// 引入通用组件。

// 问题行组件：渲染单条系统问题（标题可跳转、详情、提示与操作按钮）。
function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  // 取上下文。
  const { t, call, navigate } = usePanel()
  // 通用动作 Hook：执行请求，完成后触发 onChanged 重载。
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  // row：通用问题行渲染。
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      {/* 标题：有路由时渲染为跳转按钮。 */}
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {/* 详情、提示与操作按钮。 */}
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  // go：跳转到设置的按钮。
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  // raw：等宽字体的错误原文。
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  // worded：常规排版的错误文案。
  const worded = (text: string) => <p className="dt-error">{text}</p>
  // 按问题种类渲染对应行。
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    // 飞书机器人检查失败只暂停飞书来源；其余部署检查问题会停掉整个服务。
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      setupPage(problem.place), t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    // 无运行来源。
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    // 没有人能发起工作。
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    // 处理已暂停：附恢复确认按钮。
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    // 运行异常：显示健康项名称与原始详情。
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    // 来源异常。
    case 'source-error': {
      // 取来源健康记录。
      const health = problem.source.health
      // 有结构化错误码则文字化展示，否则显示原始详情。
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    // 评估超时未决定：跳转到线程。
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    // 评估未完成：附重新评估与不再提示按钮。
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        {/* 重新评估按钮。 */}
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        {/* 不再提示按钮。 */}
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    // 回复发送失败：显示来源、重试次数与错误原文。
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

// 总览页组件。
export function OverviewPage() {
  // 取上下文。
  const { t, call, navigate } = usePanel()
  // 取共享面板数据（部署状态）。
  const { setup } = usePanelData()
  // 轮询总览数据。
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  // 无数据时显示加载/错误状态。
  if (!data) return <LoadState error={error} loading />
  // stat：统计项（带标签；有路由时数值可点击跳转）。
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  // more："详情"跳转链接。
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  // 页面结构：待处理工单 + 问题 + 24 小时流量 + 执行器。
  return <>
    {/* 轮询错误横幅。 */}
    {error && <LoadState error={error} loading={false} />}
    {/* 待人工处理的工单区块。 */}
    <Section title={t('pendingTickets')} count={data.person.length}>
      {/* 工单卡片列表或空提示。 */}
      {data.person.length ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
        : <Hint>{t('needsYouNone')}</Hint>}
    </Section>
    {/* 系统问题区块（有问题时才显示）。 */}
    {data.problems.length > 0 && <Section title={t('problems')} count={data.problems.length}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={reload} />)}</ul>
    </Section>}
    {/* 24 小时流量区块（带"详情"跳转）。 */}
    <Section title={t('lastDay')} action={more({ page: 'trigger', query: { filter: 'recent' } })}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      {/* 到达与已评估按触发计数（非线程/决策），故不提供跳转链接。 */}
      <div className="dt-stats">
        {/* 各流量统计项：被过滤跳来源页，已接单跳评估页（24 小时窗口），有丢弃才显示丢弃。 */}
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
      </div>
    </Section>
    {/* 执行器区块（带"详情"跳转）。 */}
    <Section title={t('term.executor')} action={more({ page: 'execution' })}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {/* 暂停状态已在上方问题区展示，故两种状态下计数展示一致；等待部署检查时不渲染统计。 */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {/* 执行中（并发/上限）、排队与空闲统计。 */}
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
    </Section>
  </>
}
