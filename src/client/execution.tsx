/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
// 执行（Execution）状态视图（进行中工单与暂停控制）与执行设置组（执行器容量与工作区环境）。
import { useRef, useState } from 'react'
// 引入 ref 与 state Hook。
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
// 引入工单过滤项与类型。
import { LIMITS } from '../limits.ts'
// 引入字段取值限制。
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
// 引入轮询 Hook 与视图类型。
import { DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
// 引入基础控件。
import { SaveBar } from './draft.tsx'
// 引入保存栏。
import { usePanel } from './provider.tsx'
// 引入面板上下文。
import { TicketLine } from './rows.tsx'
// 引入工单行组件。
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
// 引入设置套件。
import { localized } from './text.ts'
// 引入本地化工具。
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'
// 引入通用组件：确认按钮、提示、键值、加载更多/状态、区块与状态头。

// 执行状态页：进行中工单列表与暂停控制。
export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  // 取上下文。
  const { t, call, navigate } = usePanel()
  // 加载条数状态（每次多加载 20）。
  const [limit, setLimit] = useState(20)
  // 轮询工单列表（按当前过滤与条数）。
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  // 解构暂停状态与执行器并发上限。
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  // 暂停使用独立的块修订号，切换暂停不会使已打开的执行设置草稿失效。
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  // 状态标识：等待初始化 / 已暂停 / 运行中。
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  // 按钮动作文案 key。
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    {/* 状态头（附设置入口）。 */}
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    {/* 状态行：状态文本 + 负载 + 暂停按钮。 */}
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {/* 无初始化问题时才显示执行中/排队负载。 */}
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      {/* 暂停/恢复确认按钮。 */}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    {/* 过滤圆片行。 */}
    <div className="dt-filters">
      {/* 工单过滤项：切换以 replace 方式导航并重置条数。 */}
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'open' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {/* idle 过滤的说明。 */}
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    {/* 加载/错误状态。 */}
    <LoadState error={error} loading={!data} />
    {/* 工单列表：person 阶段带提问标记并支持交互后刷新。 */}
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {/* 加载更多。 */}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

// firstSentence：取描述的第一句话（兼容中英文句读）。
const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
// 环境变量折叠面板：列出各来源声明的变量，点击键可插入。
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  // 取翻译。
  const { t } = usePanel()
  // 展开状态。
  const [open, setOpen] = useState(false)
  // owner：变量归属显示（executor 或来源标题）。
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  // 变量总数。
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  // 折叠行：标题带数量徽标。
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    {/* 展开主体。 */}
    <div className="dt-disclosure-body">
      {/* 提示：点击键插入。 */}
      <Hint>{t('environmentPick')}</Hint>
      {/* 变量表。 */}
      <table className="dt-table">
        {/* 表头：键 / 描述 / 归属。 */}
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        {/* 表体：每行键（可点插入）、描述首句与归属（来源关闭时附标记）。 */}
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
// 执行设置组合页：执行器块与环境块 + 配置历史。
export function ExecutionSettings() {
  // 取翻译。
  const { t } = usePanel()
  // 取各配置块、执行环境与来源列表。
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  // 草稿保留用户原文（如屏蔽命令间的分隔符），仅在保存时解析。
  const executor = blocks.executor.value
  // 已保存值：maxWorkers 转字符串、blockedCommands 数组拼接为空格分隔字符串。
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' ') }
  // 草稿：保存时把 maxWorkers 转回数字、blockedCommands 按空白/逗号拆分数组。
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  // 当前草稿值。
  const value = draft.value
  // edit：合并编辑。
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  // 准备命令文本域引用。
  const prepare = useRef<HTMLTextAreaElement>(null)
  // insert：在光标处插入变量占位并恢复焦点。
  const insert = (key: string) => {
    // 取文本域。
    const field = prepare.current
    // 光标位置（缺省为文本末尾）。
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    // 在光标区间插入 "$key" 占位。
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    // 下一帧恢复焦点并把光标放到占位之后。
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  // 页面容器。
  return <div className="dt-form">
    {/* 执行器设置表单。 */}
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      {/* 提交中禁用整组字段。 */}
      <Fields disabled={draft.busy}>
        {/* 执行器块。 */}
        <div className="dt-form dt-block">
          {/* 标题与说明气泡。 */}
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          {/* 执行器模型。 */}
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          {/* 最大并发 worker 输入。 */}
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        {/* 环境块。 */}
        <div className="dt-form dt-block">
          {/* 标题与说明气泡。 */}
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          {/* 执行目录（空时提示默认根目录）。 */}
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          {/* 准备命令文本域。 */}
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          {/* 环境变量折叠面板（点击键插入占位）。 */}
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          {/* 屏蔽命令输入。 */}
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      {/* 保存栏。 */}
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    {/* 配置历史。 */}
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
