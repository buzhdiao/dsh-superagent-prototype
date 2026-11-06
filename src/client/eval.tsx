/** Eval status view (Decision log) and Eval settings group (Policy rules, per-Source admission, and assessor settings). */
// 评估（Eval）状态视图（决策日志）与评估设置组（策略规则、每来源准入与评估者设置）。
import { useState } from 'react'
// 引入 useState。
import { ADMISSION_DEFAULTS, ADMISSION_OPTIONS, type Admission, type AdmissionCell } from '../admission.ts'
// 引入准入默认值、可选项及相关类型。
import type { AdmissionRowView } from '../sources/kind.ts'
// 引入准入行视图类型。
import { LIMITS } from '../limits.ts'
// 引入各字段取值限制。
import { DECISION_FILTERS, DECISION_KINDS, usePoll, type DecisionFilter, type Settings, type SourceView } from './api.ts'
// 引入决策过滤项、类型映射、轮询 Hook 与视图类型。
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill, SegmentedControl, Switch } from './controls.tsx'
// 引入基础控件。
import { SaveBar } from './draft.tsx'
// 引入保存栏。
import { useAction, usePanel } from './provider.tsx'
// 引入动作 Hook 与面板上下文。
import { DecisionLine } from './rows.tsx'
// 引入决策行组件。
import { ConfigHistory, Field, Fields, ModelField, SourceField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
// 引入设置套件：配置历史、字段、模型/来源字段、数字转换与块草稿。
import { localized, valueLabel, when } from './text.ts'
// 引入本地化、取值标签与时间格式化工具。
import { Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'
// 引入通用组件：提示、键值、加载更多/状态、区块与状态头。

// 评估状态页：决策日志列表，支持过滤与时间窗口。
export function EvalStatus({ filter, window, paused }: { filter: DecisionFilter; window: '24h' | undefined; paused: boolean }) {
  // 取翻译、API 调用与导航。
  const { t, call, navigate } = usePanel()
  // 加载条数状态（每次多加载 30）。
  const [limit, setLimit] = useState(30)
  // 轮询决策列表：按过滤项映射决策类型，附可选时间窗口。
  const { data, error } = usePoll(() => call('GET decisions', { query: { limit, kind: DECISION_KINDS[filter],
    ...window ? { window } : {} } }), [filter, limit, window])
  // show：以 replace 方式导航到新的过滤条件（不增加返回栈层级）。
  const show = (key: DecisionFilter, last24h: boolean) => navigate({ page: 'eval', query: { ...key === 'work' ? {} : { filter: key },
    ...last24h ? { window: '24h' } : {} } }, true)
  return <>
    {/* 状态头（附设置入口）。 */}
    <StatusHead hint={t('evalStatusIntro')} settings="eval" />
    {/* 暂停记录横幅：附"去恢复"链接。 */}
    {paused && <p className="dt-banner">
      {t('evalRecordsPaused')} <button type="button" className="dt-textlink"
        onClick={() => navigate({ page: 'execution' })}>{t('resumeWhere')}</button>
    </p>}
    {/* 过滤器行。 */}
    <div className="dt-filters">
      {/* 决策过滤圆片：切换时重置加载条数。 */}
      {DECISION_FILTERS.map(key => <Pill key={key} active={filter === key} onClick={() => { setLimit(30); show(key, !!window) }}>
        {t(`decisionFilter.${key}`)}
      </Pill>)}
      {/* 24 小时窗口圆片（选中状态下点击可取消窗口）。 */}
      {window && <><span className="dt-filter-gap" /><Pill active onClick={() => show(filter, false)}>{t('lastDayOnly')}</Pill></>}
    </div>
    {/* 加载/错误状态。 */}
    <LoadState error={error} loading={!data} />
    {/* 决策列表或空提示。 */}
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(decision => <DecisionLine key={decision.id}
      decision={decision} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {/* 加载更多。 */}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 30)} />}
  </>
}

// Rule 类型：策略规则。
type Rule = Settings['policy']['rules'][number]
// 单条规则行：可折叠的名称/指令编辑与启用开关。
function RuleRow({ rule, expanded, onToggle, onChange, onDuplicate, onRemove }: {
  rule: Rule; expanded: boolean; onToggle: () => void; onChange: (rule: Rule) => void; onDuplicate: () => void; onRemove: () => void
}) {
  // 取翻译。
  const { t } = usePanel()
  // 规则显示名（空则"新规则"）。
  const name = rule.name.trim() || t('newRule')
  // 渲染规则行。
  return <li className="dt-rule">
    {/* 折叠行：启用状态点 + 名称；收起时显示指令预览。 */}
    <DisclosureRow icon={<span className="dt-rule-dot" data-enabled={rule.enabled
      || undefined} />} title={name} open={expanded} onToggle={onToggle}
      collapsedContent={<span className="dt-rule-preview">{rule.instruction}</span>}>
      {/* 展开后的规则编辑体。 */}
      <div className="dt-rule-body">
        {/* 名称输入。 */}
        <Field label={t('ruleName')}><Input value={rule.name} required maxLength={LIMITS.ruleName} onChange={event => onChange({ ...rule,
          name: event.target.value })} /></Field>
        {/* 指令输入。 */}
        <Field label={t('ruleInstruction')}>
          <textarea className="dt-textarea" rows={4} required maxLength={LIMITS.ruleInstruction} value={rule.instruction}
            placeholder={t('ruleInstructionPlaceholder')}
            onChange={event => onChange({ ...rule, instruction: event.target.value })} />
        </Field>
        {/* 操作按钮：复制与删除。 */}
        <div className="dt-actions">
          <Button variant="ghost" size="sm" icon={<Icon name="copy" />} onClick={onDuplicate}>{t('duplicate')}</Button>
          <Button variant="ghost" size="sm" icon={<Icon name="trash" />} onClick={onRemove}>{t('remove')}</Button>
        </div>
      </div>
    </DisclosureRow>
    {/* 启用开关。 */}
    <Switch className="dt-rule-switch" checked={rule.enabled} onChange={enabled => onChange({ ...rule, enabled })} label={t('ruleEnable',
      { name })} />
  </li>
}

// Part 类型：来源策略分片（宽松对象）。
type Part = Record<string, unknown>
// 单个来源的策略分片编辑：字段表单、同步操作与准入表。
function SourcePart({ source, part, saved, dirty, onChange, reload }: {
  source: SourceView; part: Part; saved: Part; dirty: boolean; onChange: (next: Part) => void; reload: () => Promise<void>
}) {
  // 取上下文。
  const { t, call, notify } = usePanel()
  // 来源策略（断言存在）。
  const policy = source.policy!
  // 同步配置。
  const sync = policy.sync
  // 同步动作（完成后重载数据）。
  const run = useAction(() => call('POST policy-sync/:id', { id: source.id }), { reload })
  // Syncing saves the Policy block, so require unsaved edits to be saved or discarded first.
  // 同步会保存整个策略块，因此有未保存修改时先要求保存或丢弃。
  const syncNow = () => { if (dirty) notify(t('syncNeedsSave')); else void run.run() }
  // 渲染来源分片。
  return <div className="dt-part">
    {/* 策略字段表单。 */}
    {policy.fields.map(field => <SourceField key={field.key} field={field} value={part[field.key]} saved={saved[field.key]} fact={undefined}
      labels={source.labels}
      onChange={next => onChange({ ...part, [field.key]: next })} />)}
    {/* 同步按钮与同步健康状态。 */}
    {sync && <div className="dt-row-buttons">
      <Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={run.busy || !sync.ready} onClick={syncNow}>{localized(t,
        sync.label)}</Button>
      {/* 同步成功时间。 */}
      {sync.health?.state === 'ready' && sync.health.at && <LabelValue label={t('syncDone')} value={when(sync.health.at, t('lang'))} />}
      {/* 同步错误详情。 */}
      {sync.health?.state === 'error' && <span className="dt-error dt-clamp">{sync.health.detail}</span>}
    </div>}
    {/* 有准入行则渲染准入表，否则展示显式请求（explicit）说明。 */}
    {policy.rows ? <AdmissionTable rows={policy.rows} labels={source.labels} table={(part.admission ?? {}) as AdmissionTable}
      explicit={localized(t, policy.explicit)}
      onChange={admission => onChange({ ...part, admission })} />
      : <div className="dt-field"><span className="dt-field-head">{t('explicitRequest')}</span><span>{localized(t,
        policy.explicit)}</span></div>}
  </div>
}

// 准入表类型：行 id → 单元格 → 准入值。
type AdmissionTable = Record<string, Partial<Record<AdmissionCell, Admission>>>
// 三个准入单元格：列出未点名、未列出点名、未列出未点名。
const CELLS: readonly AdmissionCell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
// 准入（admission）表：按行渲染各单元格的选择器。
function AdmissionTable({ rows, labels, table, explicit, onChange }: {
  rows: AdmissionRowView[]; labels: Record<string,
    string>; table: AdmissionTable; explicit: string; onChange: (table: AdmissionTable) => void
}) {
  // 取翻译。
  const { t } = usePanel()
  // 行显示名：优先自定义标签。
  const name = (row: AdmissionRowView) => labels[row.id] ?? localized(t, row.label)
  // set：更新某行某格的准入值。
  const set = (row: string, cell: AdmissionCell, value: Admission) => onChange({ ...table, [row]: { ...table[row], [cell]: value } })
  // select：渲染某行某格的下拉选择。
  const select = (row: AdmissionRowView, cell: AdmissionCell) => {
    // 当前值（缺省为该格默认值）。
    const value = table[row.id]?.[cell] ?? ADMISSION_DEFAULTS[cell]
    // Reserve a fixed-width slot for the warning icon so selecting a value never shifts column widths.
    // 为警告图标预留固定宽度槽位，使选择值不会引起列宽变化。
    return <td key={cell}><span className="dt-admission-cell">
      {/* 下拉选择。 */}
      <select className="dt-select" aria-label={`${name(row)} · ${t(`admissionCell.${cell}`)}`} value={value} onChange={event => set(row.id,
        cell, event.target.value as Admission)}>
        {/* 可选项。 */}
        {ADMISSION_OPTIONS[cell].map(option => <option key={option} value={option}>{t(`admissionValue.${option}`)}</option>)}
      </select>
      {/* 特定组合（未列出+点名+explicit）显示警告气泡。 */}
      <span className="dt-admission-slot">{cell === 'unlistedAddressed' && value === 'explicit' && <InfoTip
        text={t('admissionAnyoneWarning')} icon="alert" warn />}</span>
    </span></td>
  }
  // 表格区块。
  return <Section title={t('admission')} hint={t('admissionHint')}>
    {/* 显式请求说明。 */}
    <Hint>{explicit}</Hint>
    {/* 准入表。 */}
    <table className="dt-table dt-admission">
      {/* 表头：范围 + 列出/未列出分组。 */}
      <thead>
        <tr><th rowSpan={2}>{t('admissionScope')}</th><th>{t('admissionListed')}</th><th colSpan={2}>{t('admissionUnlisted')}</th></tr>
        <tr><th>{t('admissionUnaddressed')}</th><th>{t('admissionAddressed')}</th><th>{t('admissionUnaddressed')}</th></tr>
      </thead>
      {/* 表体：每行为范围名与各格选择器（来源未提供该格则显示不适用）。 */}
      <tbody>{rows.map(row => <tr key={row.id}>
        <td className="dt-admission-scope">{name(row)}<small>{localized(t, row.note)}</small></td>
        {CELLS.map(cell => row.cells[cell] ? select(row, cell) : <td key={cell} className="dt-admission-na"
          aria-label={t('admissionNotReceived')}>—</td>)}
      </tr>)}</tbody>
    </table>
    {/* 脚注。 */}
    <Hint>{t('admissionFootnote')}</Hint>
  </Section>
}

// 策略块（PolicyBlock）设置表单：规则列表 + 每来源策略。
function PolicyBlock() {
  // 取翻译。
  const { t } = usePanel()
  // 取设置数据（各块、来源与策略版本）与重载。
  const { settings: { blocks, sources, policyVersion }, reload } = useSettings()
  // 策略块草稿。
  const draft = useBlockDraft('policy', blocks.policy.value, blocks.policy.revision)
  // 当前草稿值。
  const policy = draft.value
  // 展开的规则 id 集合。
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 声明了策略的已安装来源。
  const parts = sources.filter(source => source.installed && source.policy)
  // 当前选中的来源子页签 id。
  const [tab, setTab] = useState<string>()
  // 当前来源（缺省第一个）。
  const current = parts.find(source => source.id === tab) ?? parts[0]
  // edit：合并编辑策略。
  const edit = (next: Partial<typeof policy>) => draft.edit({ ...policy, ...next })
  // toggle：展开/收起某条规则。
  const toggle = (id: string) => { const next = new Set(expanded); if (next.has(id)) next.delete(id); else next.add(id); setExpanded(next) }
  // insert：在指定位置插入规则并展开它。
  const insert = (rule: Rule, at: number) => {
    // 展开新规则。
    setExpanded(new Set([...expanded, rule.id]))
    // 在 at 位置插入。
    edit({ rules: [...policy.rules.slice(0, at), rule, ...policy.rules.slice(at)] })
  }
  // Expand all rules when native form validation fails inside a collapsed rule.
  // 原生表单校验在收起规则内失败时，展开全部规则以便看到问题。
  const reveal = (target: EventTarget) => { if (target instanceof Element
    && target.closest('.dt-rules')) setExpanded(new Set(policy.rules.map(rule => rule.id))) }
  // part：取来源策略分片（缺省空对象）。
  const part = (id: string) => (policy.sources[id] ?? { allowed: [] }) as Part
  // add：追加一条空白新规则。
  const add = () => insert({ id: crypto.randomUUID(), name: '', enabled: true, instruction: '' }, policy.rules.length)
  // 表单：提交走草稿；invalid 事件冒泡时触发 reveal。
  return <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}
    onInvalidCapture={event => reveal(event.target)}>
    {/* 提交中禁用整组字段。 */}
    <Fields disabled={draft.busy}>
      {/* 标题与说明气泡。 */}
      <h2 className="dt-block-title">{t('term.policy')}<InfoTip text={t('policyIntro')} /></h2>
      {/* 策略版本展示。 */}
      <p className="dt-flow">
        <LabelValue label={t('policyVersion')} value={<span className="dt-mono">{policyVersion.slice(0, 8)}</span>} /><InfoTip
          text={t('policyVersionHint')} />
      </p>
      {/* 规则区块（带添加按钮）。 */}
      <Section title={t('rules')} hint={t('rulesHint')} action={<Button variant="ghost" size="sm" icon={<Icon name="plus" />}
        onClick={add}>{t('addRule')}</Button>}>
        {/* 规则列表或空提示。 */}
        {policy.rules.length ? <ul className="dt-rules">{policy.rules.map((rule, index) => <RuleRow key={rule.id} rule={rule}
          expanded={expanded.has(rule.id)}
          onToggle={() => toggle(rule.id)} onChange={next => edit({ rules: policy.rules.map((item, position) => position === index ? next
            : item) })}
          onDuplicate={() => insert({ ...rule, id: crypto.randomUUID(), name: `${rule.name}${t('copySuffix')}`.slice(0, LIMITS.ruleName) },
            index + 1)}
          onRemove={() => edit({ rules: policy.rules.filter((_, position) => position !== index) })} />)}</ul>
            : <Hint>{t('rulesEmpty')}</Hint>}
      </Section>
      {/* 每来源策略区块（有可用来源时）。 */}
      {current && <Section title={t('policyPerSource')} hint={t('policyPerSourceHint')}>
        {/* 来源子页签（多于一个来源时显示）。 */}
        {parts.length > 1 && <div className="dt-subtabs" role="tablist" aria-label={t('policyPerSource')}>
          {parts.map(source => <button key={source.id} type="button" role="tab" aria-selected={source === current} className="dt-subtab"
            onClick={() => setTab(source.id)}>
            {localized(t, source.title)}
          </button>)}
        </div>}
        {/* 当前来源的分片编辑。 */}
        <SourcePart key={current.id} source={current} part={part(current.id)}
          saved={(blocks.policy.value.sources[current.id] ?? {}) as Part} dirty={draft.dirty}
          reload={reload} onChange={next => edit({ sources: { ...policy.sources,
            [current.id]: next as typeof policy.sources[string] } })} />
      </Section>}
    </Fields>
    {/* 保存栏。 */}
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

// 评估块（EvalBlock）设置表单：接受模式、超时与评估者模型。
function EvalBlock() {
  // 取翻译。
  const { t } = usePanel()
  // 取评估块。
  const block = useSettings().settings.blocks.eval
  // 已保存值：超时秒数转字符串以便输入框编辑。
  const saved = { ...block.value, timeoutSeconds: String(block.value.timeoutSeconds) }
  // 草稿（提交时把超时转回数字）。
  const draft = useBlockDraft('eval', saved, block.revision, value => ({ ...value, timeoutSeconds: numberOf(value.timeoutSeconds) }))
  // 当前草稿值。
  const value = draft.value
  // edit：合并编辑。
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  // 表单。
  return <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}>
    {/* 提交中禁用整组字段。 */}
    <Fields disabled={draft.busy}>
      {/* 标题与说明气泡。 */}
      <h2 className="dt-block-title">{t('evalSettings')}<InfoTip text={t('evalIntro')} /></h2>
      {/* 接受模式分段选择。 */}
      <Section title={t('acceptMode')} hint={t(`modeOption.${value.mode}`)}>
        <SegmentedControl className="dt-segmented" label={t('acceptMode')} value={value.mode} onChange={mode => edit({ mode })}
          options={(['off', 'observe', 'auto'] as const).map(mode => ({ value: mode, label: valueLabel(t, 'mode', mode),
            title: t(`modeOption.${mode}`) }))} />
      </Section>
      {/* 评估超时输入。 */}
      <Field label={t('evalTimeout')} hint={t('evalTimeoutHint')}>
        <Input type="number" min={LIMITS.evalTimeoutSeconds.min} max={LIMITS.evalTimeoutSeconds.max} required value={value.timeoutSeconds}
          onChange={event => edit({ timeoutSeconds: event.target.value })} />
      </Field>
      {/* 评估者模型选择。 */}
      <Section title={t('assessorModel')} hint={t('assessorModelHint')}>
        <ModelField id="dt-eval-model" value={value.model} onChange={model => edit({ model })} />
      </Section>
    </Fields>
    {/* 保存栏。 */}
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

// 评估设置组合页：策略块 + 评估块 + 配置历史。
export function EvalSettings({ version }: { version?: string | undefined }) {
  // 渲染两个块与历史（可聚焦指定版本）。
  return <div className="dt-form">
    {/* 策略块。 */}
    <PolicyBlock />
    {/* 评估块。 */}
    <EvalBlock />
    {/* 配置历史。 */}
    <ConfigHistory blocks={['policy', 'eval']} versions {...version ? { focus: version } : {}} />
  </div>
}
