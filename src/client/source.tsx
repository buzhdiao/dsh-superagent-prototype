/** Source status view (health, filtered Triggers, dropped replies) and Source settings cards. */
// 来源（Source）状态视图（健康、被过滤的触发、被丢弃的回复）与来源设置卡片。
import { useEffect, useState } from 'react'
// useState 管理折叠状态；useEffect 处理聚焦滚动。
import type { FieldSpec } from '../sources/kind.ts'
// FieldSpec：来源字段定义。
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
// 轮询 Hook 与来源状态相关类型。
import { DisclosureRow, Dot, Icon, InfoTip, Switch, Tag } from './controls.tsx'
// 基础控件：折叠行、状态点、图标、信息提示、开关、标签。
import { SaveBar } from './draft.tsx'
// SaveBar：草稿保存/放弃操作条。
import { sourceMark } from './marks.ts'
// sourceMark：来源状态到点/文案的映射。
import { usePanel, usePanelData } from './provider.tsx'
// 面板 Hook。
import { setupPage, settingsRoute, type Route } from './route.ts'
// 路由构造器与路由类型。
import { ConfigHistory, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
// 设置工具：字段容器、来源字段、块级草稿 Hook、设置上下文。
import { actorName, healthText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
// 文本辅助函数。
import { CheckSetupButton, Hint, LabelValue, LoadState, SetupMessage, StatusHead, When } from './widgets.tsx'
// 通用部件。

function SourceCard({ source }: { source: SourceView }) {
  // 单个来源的设置卡片：字段编辑、启停开关、高级字段折叠。
  const { t, call } = usePanel()
  const { running } = usePanelData()
  // running：当前运行中的任务数，用于提示重启影响。
  const { reload } = useSettings()
  // 设置上下文的刷新函数。
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // 高级字段折叠状态。
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  // 触发来源重新抓取标签并刷新设置；返回新增数量。
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  // 以“块”为粒度的草稿管理（未保存编辑暂存本地）。
  const value = draft.value
  // 当前（可能未保存）的配置值。
  const { problem, value: saved } = source
  // problem：来源级初始化问题；saved：服务端已保存的值。
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // 判断某字段相对已保存值是否被修改。
  // Saving a modified setup-sensitive field restarts dsh-superagent, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  // 有未保存修改且改动涉及“保存即重启”的字段时为 true。
  const description = localized(t, source.description)
  // 来源描述（按当前语言）。
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  // 渲染单个字段：值/已存值/标签刷新；事实（fact）类字段或未改动字段展示派生事实，编辑中的字段隐藏事实。
  const advanced = source.fields.filter(spec => spec.advanced)
  // 标记为高级的字段。
  return <form id={`dt-source-${source.id}`} className="dt-card" onSubmit={event => { void draft.submit(event) }}>
    {/* 表单即卡片，id 用于外部定位滚动，提交交给草稿逻辑。 */}
    <Fields disabled={draft.busy}>
      {/* 字段容器：保存期间禁用。 */}
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title">
            <span className="dt-card-title">{localized(t, source.title)}</span>{description && <InfoTip text={description} />}
            {/* 来源标题与描述气泡。 */}
            {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
            {/* 未安装来源显示警告标签。 */}
          </div>
        </div>
        {source.installed && <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
          label={t('sourceEnable', { name: localized(t, source.title) })} />}
        {/* 已安装来源提供启用/停用开关（进草稿）。 */}
      </div>
      {problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
        {/* 来源级初始化问题：显示错误并附“检查设置”按钮。 */}
      </div>}
      {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
      {/* 未安装时的说明。 */}
      {source.installed && source.fields.filter(spec => !spec.advanced).map(field)}
      {/* 渲染普通字段。 */}
      {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}>
        {/* 高级字段折叠区。 */}
        <div className="dt-disclosure-body">{advanced.map(field)}</div>
      </DisclosureRow>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
      onDiscard={draft.discard} />
    {/* 保存条：改动涉及重启且有运行中任务时提示会被中断。 */}
  </form>
}

export function SourceSettings({ focus }: { focus?: string }) {
  // 来源设置页：列出全部来源卡片，可定位到指定来源。
  const { sources } = useSettings().settings
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus])
  // focus 变化时滚动到对应来源卡片。
  return <div className="dt-form">
    {sources.map(source => <SourceCard key={source.id} source={source} />)}
    {/* 每个来源一张卡片。 */}
    <ConfigHistory blocks={['source:']} />
    {/* 来源块的历史变更记录。 */}
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  // 被丢弃回复（dropped replies）折叠列表：显示原因与时间，并可跳转来源。
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  // 跳转目标：优先工单；早期未记录 ticketId 的消息回退到线程。
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    {/* 折叠行标题带数量。 */}
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      {/* 说明文字。 */}
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          {/* 回复预览。 */}
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {/* 丢弃原因与时间。 */}
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
            {/* 可用时的跳转链接。 */}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
function SourceRow({ source }: { source: SourceStatusRow }) {
  // 来源状态行：健康概况、收发统计、问题与被过滤消息。
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const [filteredOpen, setFilteredOpen] = useState(false)
  // 被过滤消息折叠状态。
  const { problem, dropped } = source
  // 来源级初始化问题与被丢弃回复。
  const { dot, label: state } = sourceMark(t, source.state)
  // 状态点与状态文案。
  const { received, filtered, lastAt } = source.stats
  // 收到数、过滤数、最近消息时间。
  // Omit healthy parts and suppress per-part notes when a setup problem already explains why the Source is stopped.
  const notes = source.enabled && !problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  // 分部健康备注：仅展示错误/暂停的部分；已有初始化问题解释停用原因时不再重复。
  return <li className="dt-row">
    <Dot state={dot} label={state} />
    {/* 左侧状态点。 */}
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-row-name">{localized(t, source.title)}</span><span className="dt-status-text"
        data-state={dot}>{state}</span></div>
      {/* 名称与状态。 */}
      <div className="dt-row-meta">
        {received > 0 && <LabelValue label={t('sourceReceivedLabel')}
          value={received} />}{filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={filtered} />}
        {/* 收到/过滤计数。 */}
        {lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(lastAt, t('lang'))} />}
        {/* 最近消息时间。 */}
      </div>
      {problem && <p className="dt-error">
        <SetupMessage problem={problem} lead /> <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
          {t('sourceOpenSettings')}
        </button>
        {/* 初始化问题 + 打开设置链接。 */}
      </p>}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
        {/* 分部健康备注：名称 + 文案（无错误码时用等宽字体显示原始信息）。 */}
      </p>)}
      {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
        onToggle={() => setFilteredOpen(!filteredOpen)}>
        {/* 被过滤消息折叠列表。 */}
        <div className="dt-disclosure-body">
          <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
            className="dt-row-main">
            <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
              || t('empty')}</div>
            {/* 发送者与消息预览。 */}
            <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
            {/* 过滤原因与时间。 */}
          </div></li>)}</ul>
        </div>
      </DisclosureRow>}
      {dropped.length > 0 && <DroppedReplies items={dropped} />}
      {/* 有被丢弃回复时展示折叠列表。 */}
    </div>
  </li>
}

export function SourceStatus() {
  // 来源状态页：轮询全部来源状态并渲染。
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  // 轮询来源列表。
  // Global deployment setup problems halt all Sources and show at the top; Source-specific setup problems show on that Source's row.
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  // 部署级初始化问题会让全部来源停摆，在页顶展示；来源级问题只在该来源行展示。
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="source" />
    {/* 页头：说明 + 跳转来源设置。 */}
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
      {/* 全局初始化问题与“去修复”链接。 */}
    </p>}
    <LoadState error={error} loading={!data} />
    {/* 加载/错误占位。 */}
    {data && <ul className="dt-list">{data.map(source => <SourceRow key={source.id} source={source} />)}</ul>}
    {/* 来源状态行列表。 */}
  </div>
}
