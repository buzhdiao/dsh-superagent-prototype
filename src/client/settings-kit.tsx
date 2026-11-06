/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
// 共享设置上下文、块级草稿 Hook、表单控件、来源模式字段渲染器与配置历史。
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement,
  type ReactNode } from 'react'
// React 工具：克隆元素注入 id、Context、副作用、布局副作用、引用与状态。
import type { ApiResponse } from '../app/api.ts'
// ApiResponse：API 响应类型工具。
import type { FieldSpec, Localized } from '../sources/kind.ts'
// FieldSpec：来源字段模式；Localized：双语文本。
import { usePoll, type HistoryView, type Settings, type SettingsView, type SourceView } from './api.ts'
// 轮询 Hook 与设置/历史相关类型。
import { Button, DisclosureRow, Icon, InfoTip, Input, SegmentedControl, Switch } from './controls.tsx'
// 基础控件。
import { useDraft } from './draft.tsx'
// useDraft：通用草稿 Hook（本地未保存编辑）。
import { useAction, usePanel, usePanelData } from './provider.tsx'
// 面板 Hook。
import { settingsRoute } from './route.ts'
// 设置页路由构造器。
import { errorText, localized, valueLabel, when, type T } from './text.ts'
// 文本辅助函数。
import { Hint, LoadState } from './widgets.tsx'
// 通用部件。

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => text.trim() ? Number(text) : null
// 解析数字输入串；空串返回 null，让服务端拒绝必填数字为空而非强转为 0。
interface SettingsData { settings: SettingsView; reload: () => Promise<void> }
// 设置上下文数据：设置视图与刷新函数。
const SettingsContext = createContext<SettingsData | undefined>(undefined)
// 设置上下文。
export function useSettings(): SettingsData {
  // Hook：读取设置上下文，越界使用时抛错。
  const value = useContext(SettingsContext)
  if (!value) throw new Error('A settings block rendered outside the settings')
  return value
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  // 设置上下文 Provider：轮询全局设置并向下提供。
  const { call } = usePanel()
  const { restarts } = usePanelData()
  // restarts：宿主重启恢复计数，变化时强制重新拉取设置。
  const { data, error, reload } = usePoll(() => call('GET settings'), [call, restarts])
  if (!data) return <LoadState error={error} loading />
  // 尚未加载到数据时显示加载/错误占位。
  return <SettingsContext.Provider value={{ settings: data, reload }}>
    {error && <LoadState error={error} loading={false} />}
    {/* 加载过数据但后续轮询出错时，在内容上方显示错误。 */}
    {children}
    {/* 设置页内容。 */}
  </SettingsContext.Provider>
}
export function useBlockDraft<V>(block: string, saved: V, revision: number, toValue: (draft: V) => unknown = draft => draft) {
  // 块级草稿 Hook：以设置块（block）为单位管理未保存修改与保存动作。
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const { reload } = useSettings()
  return useDraft({ key: `dsh-superagent/draft/${state?.masterId ?? ''}/${block}`, saved, revision, reload, save: async (value, from) => {
    // 草稿按 masterId+block 隔离，避免不同宿主实例间串草稿。
    const result = await call('PUT settings/:block', { block, body: { value: toValue(value), revision: from } })
    // 保存时携带修订号做乐观并发控制。
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    // 保存成功提示；保存触发重启时提示不同文案。
    return result
  } })
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  // 字段集包装器：保存完成重新启用后，把焦点恢复到之前激活的输入框。
  const set = useRef<HTMLFieldSetElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    // 在布局阶段处理焦点记录与恢复。
    const active = document.activeElement
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null
    // 禁用时记录当前在字段集内激活的元素。
    else if (focused.current && (!active
      || active === document.body)) { focused.current.focus({ preventScroll: true }); focused.current = null }
    // 重新启用且焦点已丢失时恢复焦点（不滚动页面）。
  }, [disabled])
  return <fieldset ref={set} className="dt-fieldset" disabled={disabled}>{children}</fieldset>
  // fieldset 的 disabled 属性可一次性禁用全部内部控件。
}
export function Field({ label, hint, note,
  children }: { label: string; hint?: string | undefined; note?: ReactNode; children: ReactElement<{ id?: string }> }) {
  // 单字段布局：标签 + 提示气泡 + 控件（自动注入 id 关联）+ 备注。
  const id = useId()
  return <div className="dt-field">
    <span className="dt-field-head"><label htmlFor={id}>{label}</label>{hint && <InfoTip text={hint} />}</span>{cloneElement(children,
      { id })}{note && <small>{note}</small>}
    {/* 用 cloneElement 给子控件注入 id，使 label 的 htmlFor 生效。 */}
  </div>
}
function SwitchRow({ label, hint, checked,
  onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (next: boolean) => void }) {
  // 开关行：左侧标签与提示，右侧开关。
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</div><Switch checked={checked} onChange={onChange}
      label={label} />
  </div>
}
type RoleModel = Settings['eval']['model']
// RoleModel：评估配置里的模型角色结构。
export function ModelField({ id, value, onChange }: { id: string; value: RoleModel; onChange: (next: RoleModel) => void }) {
  // 模型选择字段：provider/model/effort 三输入，空值表示继承默认。
  const { t, call } = usePanel()
  const [catalog, setCatalog] = useState<ApiResponse<'GET models'>>()
  // 模型目录数据。
  const [error, setError] = useState<string>()
  // 目录加载错误。
  useEffect(() => { call('GET models').then(setCatalog, failure => setError(errorText(failure))) }, [call])
  // 挂载时拉取模型目录。
  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  // 当前三输入框的值（空串表示未设置）。
  const set = (next: Partial<typeof current>) => {
    // 任一输入变化时合并并回写；三者为空则整值为 null（继承默认）。
    const { provider, model, effort } = { ...current, ...next }
    onChange(provider.trim() || model.trim() || effort.trim() ? { provider, model, ...effort ? { reasoningEffort: effort } : {} } : null)
  }
  const models = catalog?.groups.find(group => group.id === current.provider.trim())?.models ?? []
  // 当前 provider 下的可选模型列表。
  const fallback = catalog?.default
  // 服务端默认模型。
  const input = (name: keyof typeof current, label: string, placeholder: string) => <Field label={label}>
    <Input list={`${id}-${name}s`} spellCheck={false} placeholder={placeholder} value={current[name]}
      onChange={event => set({ [name]: event.target.value })} />
    {/* 每个输入绑定一个 datalist 提供候选项。 */}
  </Field>
  return <div className="dt-model">
    <Hint>{fallback ? t('defaultModel', { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort
      ? ` · ${fallback.reasoningEffort}` : ''}` }) : t('defaultModelUnavailable')}</Hint>
    {/* 显示当前默认模型或不可用提示。 */}
    {error && <p className="dt-error">{t('modelCatalogError', { error })}</p>}
    {/* 目录加载失败提示。 */}
    <div className="dt-grid3">
      {input('provider', t('modelProvider'), t('modelInherit'))}{input('model', t('modelName'), t('modelInherit'))}{input('effort',
        t('modelEffort'), t('modelEffortDefault'))}
      {/* 三列输入：provider、model、reasoning effort。 */}
    </div>
    <datalist id={`${id}-providers`}>{catalog?.groups.map(group => <option key={group.id}
      value={group.id}>{group.name}</option>)}</datalist>
    {/* provider 候选列表。 */}
    <datalist id={`${id}-models`}>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
    {/* model 候选列表。 */}
    <datalist id={`${id}-efforts`}>
      {(models.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []).map(effort => <option key={effort.id}
        value={effort.id}>{effort.name}</option>)}
      {/* effort 候选随所选模型变化。 */}
    </datalist>
  </div>
}

type HistoryChange = NonNullable<HistoryView['items'][number]['changes']>[number]
// HistoryChange：单条配置变更记录类型。
function changeText(t: T, change: HistoryChange, sources: SourceView[]): string {
  // 把一条变更记录格式化为人读文本。
  const source = sources.find(item => item.id === change.source)
  // 变更涉及的来源。
  const field = (change.part ? source?.policy?.fields : source?.fields)?.find(item => item.key === change.field)
  // 变更字段定义（part 表示策略部分）。
  const shown = (value: unknown) => value === undefined || value === null || value === '' ? t('unsetValue') : typeof value === 'boolean'
    ? t(value ? 'yes' : 'no')
    : change.code === 'mode' ? valueLabel(t, 'mode', String(value)) : String(value)
  // 值的展示规则：空显示“未设置”，布尔翻译，mode 翻译，其余转字符串。
  return t(`change.${change.code}`,
    { items: (change.items ?? []).map(item => source?.labels[item] ?? item).join(t('listSeparator')),
    from: shown(change.from), to: shown(change.to), name: change.name ?? '', source: source ? localized(t, source.title)
      : change.source ?? '',
    field: field ? localized(t, field.label) : change.field ?? '' })
  // 按变更码查模板并填充插值。
}
/**
 * Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
 * Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
 */
export function ConfigHistory({ blocks, versions, focus }: { blocks: string[]; versions?: boolean; focus?: string }) {
  // 配置历史折叠组件：blocks 过滤展示的块（前缀匹配）；versions 含全部策略变更；focus 高亮目标版本。
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const { sources } = settings
  const [open, setOpen] = useState(!!focus)
  // 带 focus（从版本对比跳转来）时默认展开。
  const [data, setData] = useState<HistoryView>()
  // 历史数据。
  const [error, setError] = useState<string>()
  // 加载错误。
  const revisions = JSON.stringify([Object.values(settings.blocks).map(block => block.revision), sources.map(source => source.revision)])
  // 把各块与来源的修订号序列化，作为“需要刷新历史”的依赖信号。
  useEffect(() => { if (open) call('GET policy/history').then(setData, failure => setError(errorText(failure))) }, [open, call, revisions])
  // 展开时拉取历史；修订号变化（保存后）会重新拉取。
  const listed = (block: string | undefined) => block ? blocks.some(item => item === block || (item.endsWith(':')
    && block.startsWith(item))) : blocks.includes('policy')
  // 判断某条记录是否属于要展示的块：以冒号结尾的块名按前缀匹配；无 block 的旧记录归入 policy。
  const items = data?.items.filter(item => (versions && item.policyChanged) || listed(item.block)) ?? []
  // 过滤出要展示的历史条目。
  // Match the oldest save that produced the focused Policy version (where that version originated).
  const target = focus ? items.filter(item => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1) : undefined
  // 在 focus 版本下：取最早一次产生该版本的保存（列表按时间倒序，故取最后一个）。
  const scroll = (element: HTMLLIElement | null) => { if (element
    && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) } }
  // 目标条目渲染时滚动到视口中央（dataset 防重复）。
  return <DisclosureRow icon={<Icon name="history" />} title={t('configHistory')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      {error && <p className="dt-error">{error}</p>}
      {/* 加载错误。 */}
      {data && <>
        <Hint>{t('historyIntro')}</Hint>
        {/* 历史说明。 */}
        {focus && !target && <Hint>{t('policyVersionUnrecorded', { version: focus.slice(0, 8) })}</Hint>}
        {/* 目标版本无对应保存记录时的提示。 */}
        {items.length ? <ul className="dt-timeline">{items.map(item => <li key={item.revision} className={item === target
          ? 'dt-event dt-highlight' : 'dt-event'}
          ref={item === target ? scroll : undefined}>
          {/* 时间线列表，目标条目高亮并滚动定位。 */}
          <div className="dt-row-title">{t('historyItem', { revision: item.revision, source: valueLabel(t, 'historySource',
            item.source) })}</div>
          {/* 修订号与保存来源。 */}
          <div className="dt-event-foot">{when(item.savedAt, t('lang'))}{item.policyChanged && <> · {t('historyPolicyChanged',
            { version: item.policyVersion.slice(0, 8) })}</>}</div>
          {/* 保存时间，策略变更时附版本号。 */}
          {item.changes === null ? <Hint>{t('historyNoBaseline')}</Hint> : item.changes.length
            ? <ul className="dt-changes">{item.changes.map((change, index) => <li key={index}>{changeText(t, change, sources)}</li>)}</ul>
              : <Hint>{t('historyNoChanges')}</Hint>}
          {/* 变更明细：无基线/无变更/逐条列出。 */}
          {item.notified.length > 0 && <Hint>{t('historyNotified', { count: item.notified.length,
            titles: item.notified.map(ticket => ticket.title).join(t('listSeparator')) })}</Hint>}
          {/* 本次保存影响的工单。 */}
        </li>)}</ul> : <Hint>{t('historyEmpty')}</Hint>}
        {/* 无历史记录提示。 */}
      </>}
    </div>
  </DisclosureRow>
}

type Row = Record<string, string>
// Row：行编辑字段中的一行（列键 → 值）。
type Column = Extract<FieldSpec, { type: 'rows' }>['columns'][number]
// Column：行编辑字段的列定义。
const ROWS_SHOWN = 6
// 超过 6 行时折叠为摘要。
const byName = ([, a]: [string, string], [, b]: [string, string]) => a.localeCompare(b)
// 按显示名排序的比较函数。
function RowsField({ field, value, saved, onChange, labels, refreshLabels }: {
  // 行编辑字段组件：多行多列的键值表格编辑。
  field: Extract<FieldSpec, { type: 'rows' }>; value: unknown; saved: unknown; onChange: (next: unknown) => void; labels: Record<string,
    string>
  refreshLabels: (() => Promise<string[]>) | undefined
}) {
  const { t, notify } = usePanel()
  const [open, setOpen] = useState(false)
  // 折叠展开状态。
  const refresh = useAction(async () => {
    // “刷新标签”动作：从来源重新拉取候选并提示结果。
    try {
      const added = await refreshLabels!()
      notify(added.length ? t('labelsAdded', { names: added.join(t('listSeparator')) }) : t('labelsCurrent'))
      // 有新增显示新增名，否则提示已是最新。
    } catch (failure) { notify(t('labelsFailed', { error: errorText(failure) })) }
    // 刷新失败提示。
  })
  const label = localized(t, field.label), hint = localized(t, field.hint)
  // 字段标签与提示。
  const rows = Array.isArray(value) ? value as Row[] : []
  // 当前值必须是行数组。
  const set = (index: number, row: Row) => onChange(rows.map((item, position) => position === index ? row : item))
  // 替换指定行。
  const key = field.columns[0]!
  // 第一列作为行的主键列。
  const savedKeys = new Set((Array.isArray(saved) ? saved as Row[] : []).map(row => row[key.key]))
  // 已保存行的主键集合：已存在的行主键不可改。
  const choose = key.type === 'text' && key.choose && Object.keys(labels).length ? localized(t, key.choose) : ''
  // 主键列是文本且有候选标签时显示为下拉选择。
  // Exclude options already selected in another row.
  const choices = (id: string) => Object.entries(labels).filter(([option]) => option === id
    || !rows.some(other => other[key.key] === option)).sort(byName)
  // 下拉候选排除已被其他行占用的选项。
  const blank = Object.fromEntries(field.columns.map(column => [column.key, column.type === 'select' ? column.options[0]!.value : '']))
  // 新增行的空白模板：select 列取第一个选项，其余为空串。
  // Summarize a row by its second column only when that column is free text (e.g., a display name), not a select option.
  const named = field.columns[1]?.type === 'text' ? field.columns[1] : undefined
  // 第二列是自由文本时用它作为行的摘要名。
  const rowName = (row: Row) => (named && row[named.key]) || labels[row[key.key] ?? ''] || row[key.key] || ''
  // 行摘要：第二列文本 > 主键的显示名 > 主键。
  const cell = (row: Row, index: number, column: Column) => {
    // 渲染一个单元格。
    const id = row[key.key] ?? '', change = (next: string) => set(index, { ...row, [column.key]: next })
    if (column === key && (savedKeys.has(id) || (!choose && labels[id]))) {
      // 已保存行的主键、或无下拉但已有标签的主键，渲染为不可编辑文本。
      return <span key={column.key} className={labels[id] ? 'dt-row-label' : 'dt-row-label dt-mono'} title={id}>{labels[id] ?? id}</span>
    }
    if (column === key && choose) {
      // 主键列带下拉时渲染 select。
      return <select key={column.key} className="dt-select" aria-label={choose} required value={id}
        onChange={event => change(event.target.value)}>
        <option value="" disabled>{choose}</option>
        {/* 空选项仅作占位不可选。 */}
        {choices(id).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
        {/* 过滤后的候选。 */}
      </select>
    }
    if (column.type === 'select') {
      // 普通枚举列渲染 select。
      return <select key={column.key} className="dt-select" aria-label={localized(t, column.label)} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)}>
        {column.options.map(option => <option key={option.value} value={option.value}>{localized(t, option.label)}</option>)}
      </select>
    }
    return <Input key={column.key} className={column.optional ? undefined : 'dt-mono'} aria-label={localized(t, column.label)}
      placeholder={localized(t, column.label)}
      required={!column.optional} pattern={column.pattern} spellCheck={false} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)} />
    // 其余列渲染文本输入（必填列用等宽字体，支持校验 pattern）。
  }
  return <div className="dt-field">
    <div className="dt-subhead">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}<span className="dt-count">{rows.length || ''}</span></span>
      {/* 字段头：标签、提示、行数。 */}
      <span className="dt-subhead-actions">
        {key.type === 'text' && key.refresh && refreshLabels && <Button variant="ghost" size="sm" className={refresh.busy ? 'dt-btn-busy'
          : undefined} icon={<Icon name="refresh" />}
          disabled={refresh.busy} aria-busy={refresh.busy} onClick={() => { void refresh.run() }}>{localized(t, key.refresh)}</Button>}
        {/* 主键支持刷新时显示刷新标签按钮。 */}
        <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={() => { setOpen(true); onChange([...rows,
          blank]) }}>{t('addRow')}</Button>
        {/* 新增一行并展开列表。 */}
      </span>
    </div>
    {rows.length > ROWS_SHOWN && <button type="button" className="dt-textlink dt-rows-summary" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      {/* 行数超限时的折叠摘要按钮。 */}
      {open ? t('collapse') : rows.map(rowName).join(t('listSeparator'))}
      {/* 收起时用行摘要名串联展示。 */}
    </button>}
    {(rows.length <= ROWS_SHOWN || open) && <ul className="dt-rows"
      style={{ ['--dt-columns' as string]: field.columns.length }}>{rows.map((row, index) => <li key={index} className="dt-rows-item">
      {/* 行列表：CSS 变量声明列数以驱动网格布局。 */}
      {field.columns.map(column => cell(row, index, column))}
      {/* 逐列渲染单元格。 */}
      <Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={t('removeRow', { name: labels[row[key.key] ?? '']
        || row[key.key] || label })}
        onClick={() => onChange(rows.filter((_, position) => position !== index))} />
      {/* 行删除按钮。 */}
    </li>)}</ul>}
  </div>
}
export function SourceField({ field, value, saved, fact, onChange, labels, refreshLabels }: {
  // 来源字段统一渲染入口：按字段类型分派到对应控件。
  field: FieldSpec; value: unknown; saved: unknown; fact: Localized | string | undefined; onChange: (next: unknown) => void
  labels: Record<string, string>
  refreshLabels?: () => Promise<string[]>
}) {
  const { t, navigate } = usePanel()
  const label = localized(t, field.label), hint = localized(t, field.hint)
  // 字段标签与提示。
  switch (field.type) {
    case 'switch': return <SwitchRow label={label} hint={hint} checked={value === true} onChange={onChange} />
    // 开关型。
    case 'select': return <Field label={label} hint={hint}>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={label} value={String(value ?? field.options[0]!.value)}
        options={field.options.map(option => ({ value: option.value, label: localized(t, option.label) }))} onChange={onChange} />
      {/* 分段控件型：值缺省取第一个选项。 */}
    </Field>
    case 'number': return <Field label={label} hint={hint}>
      <Input type="number" min={field.min} max={field.max} required value={String(value ?? '')}
        onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
      {/* 数字型：保留空串，非空才转数字。 */}
    </Field>
    case 'text': return <Field label={label} hint={hint} note={localized(t, fact)}>
      {/* 文本型：fact 作为备注展示。 */}
      {field.choose && Object.keys(labels).length
        ? <select className="dt-select" value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          <option value="">{localized(t, field.choose)}</option>
          {/* 空选项表示清除。 */}
          {value && !labels[String(value)] ? <option value={String(value)}>{String(value)}</option> : null}
          {/* 当前值不在候选里时保留原值选项。 */}
          {Object.entries(labels).sort(byName).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
          {/* 按名排序的候选。 */}
        </select>
        : <Input value={String(value ?? '')} readOnly={field.readonly} pattern={field.pattern} spellCheck={false}
          onChange={event => onChange(event.target.value)} />}
      {/* 无候选时渲染普通输入，只读字段禁编辑。 */}
    </Field>
    case 'fact': return <div className="dt-field">
      {/* 事实型：只读展示派生信息。 */}
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</span>
      <span className="dt-mono">{localized(t, fact) || t('empty')}</span>
      {/* 等宽展示事实值。 */}
      {field.settings && <small>
        <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute(field.settings!))}>{t(`openSettingsOf.${field.settings}`)}</button>
        {/* 指向相关设置分组时提供跳转链接。 */}
      </small>}
    </div>
    case 'rows': return <RowsField field={field} value={value} saved={saved} onChange={onChange} labels={labels}
      refreshLabels={refreshLabels} />
    // 行编辑型。
  }
}
