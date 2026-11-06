/** Prompts settings group: section/skill editor, full composed prompt preview with diffing, and revision history. */
// 提示词设置组：段落/技能编辑器、带差异对比的完整提示词预览与版本历史。
import { Fragment, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
// 引入 React Hook 与类型。
import type { ApiResponse } from '../app/api.ts'
// 引入 API 响应类型。
import type { PromptConfig, PromptsView } from './api.ts'
// 引入提示词配置与视图类型。
import { SaveBar, useDraft, type DraftWords } from './draft.tsx'
// 引入草稿 Hook、保存栏与自定义文案类型。
import { changedSections, isPart, isSkill, lineDiff, partKey, partText, partWith, sectionLabel, sectionText, skillNameFree, withOverride,
  withOverrides, withSection, withoutSkill, type BuiltInPart, type DiffLine } from './prompt-config.ts'
// 引入提示词配置纯函数工具。
import { useAction, usePanel } from './provider.tsx'
// 引入动作 Hook 与面板上下文。
import { errorText, valueLabel, when, type T } from './text.ts'
// 引入展示工具与翻译类型。
import { Hint, LoadState } from './widgets.tsx'
// 引入提示与加载状态组件。
import { Button, Icon, Input, SegmentedControl } from './controls.tsx'
// 引入基础控件。

// 页签类型：编辑 / 完整 / 历史。
type Tab = 'edit' | 'full' | 'history'
// 草稿来源（Origin）：历史版本、默认值或"某段落已重置"。
type Origin = { revision: number } | 'defaults' | { reset: string }
// 编辑附注：草稿来源与选中段落。
interface PromptNote { from?: Origin; selection?: string }
// originText：草稿来源的描述文案。
const originText = (t: T, view: PromptsView, from: Origin | undefined): string | undefined => from === undefined ? undefined
  : from === 'defaults' ? t('promptDraftFromDefaults') : 'revision' in from ? t('promptDraftFromHistory', { revision: from.revision })
  : t('promptDraftSectionReset', { part: sectionLabel(t, view, from.reset) })

// 提示词页面：拉取视图数据后进入编辑器。
export function PromptsPage() {
  // 取 API 调用。
  const { call } = usePanel()
  // 视图数据状态。
  const [view, setView] = useState<PromptsView>()
  // 错误状态。
  const [error, setError] = useState<Error>()
  // reload：重新拉取提示词视图。
  const reload = useCallback(async () => { setView(await call('GET prompts')) }, [call])
  // 挂载时加载一次。
  useEffect(() => { reload().catch(setError) }, [reload])
  // 有数据渲染编辑器，否则显示加载/错误。
  return view ? <PromptsEditor view={view} reload={reload} /> : <LoadState loading error={error} />
}

// 提示词编辑器：管理草稿、三个视图页签与保存栏。
function PromptsEditor({ view, reload }: { view: PromptsView; reload: () => Promise<void> }) {
  // 取上下文。
  const { t, call, notify } = usePanel()
  // 已保存配置（overrides 归一化为映射）。
  const saved = withOverrides(view.current.config)
  // 草稿：按主 Session 隔离存储键；保存时按上下文投递情况提示。
  const draft = useDraft<PromptConfig, PromptNote>({ key: `dsh-superagent/prompts/${view.masterId}`, saved, revision: view.revision,
    reload,
    // save：提交到服务端。
    save: async (config, baseRevision) => {
      // 调用保存 API（带基线修订号做并发保护）。
      const result = await call('PUT prompts', { body: { config, baseRevision } })
      // 通知等待注入主 Session，或普通"已保存"。
      notify(t(result.context_delivery === 'pending' ? 'promptSavedPending' : 'saved'))
      // 返回结果（含新修订号与是否重启）。
      return result
    } })
  // 当前草稿配置。
  const config = draft.value
  // 当前视图页签。
  const [tab, setTab] = useState<Tab>('edit')
  // 选中的段落（恢复上次选择，缺省第一个团队段落）。
  const [selection, select] = useState(draft.meta?.selection ?? 'communication')
  // Fall back to the first section when the selected section (e.g., a skill removed by discard) is no longer in the draft.
  // 选中段落已不在草稿中（例如被丢弃的技能）时回退到第一段。
  const exists = isPart(selection) ? view.parts.some(part => part.key === partKey(selection)) : sectionText(config, selection) !== undefined
  // 实际选中的段落。
  const selected = exists ? selection : 'communication'
  // 草稿相对已保存版本的变更段落。
  const changed = changedSections(config, saved)
  // edit：编辑草稿并保留来源/选区附注。
  const edit = (next: PromptConfig, note: PromptNote = {}) => draft.edit(next, { from: note.from ?? draft.meta?.from,
    selection: note.selection ?? selected })
  // open：选中某段落并切到编辑页签。
  const open = (name: string) => { select(name); setTab('edit') }
  // words：保存栏自定义文案（合并、冲突与编辑中状态行）。
  const words: DraftWords = { merged: revision => t('promptConflict', { revision }),
    // conflict：列出双方都改过的段落（把合并路径还原成段落名）。
    conflict: (revision, paths) => t('promptConflictParts', { revision, parts: paths.map(([name, item]) => sectionLabel(t, view,
      item === undefined ? name! : name === 'skills' ? `skill/${item}` : name === 'overrides' ? `part/${item}` : name!)).join(t('listSeparator')) }),
    // editing：版本号 + 变更数 + 草稿来源。
    editing: [t('promptsDraftVersion', { revision: draft.revision }), t('promptChanges', { count: changed.length }),
      originText(t, view, draft.meta?.from)].filter(Boolean).join(' · ') }
  // 三个视图页签。
  const tabs = [{ value: 'edit' as const, label: t('promptViewEdit') }, { value: 'full' as const, label: t('promptViewFull') },
    { value: 'history' as const, label: t('promptViewHistory') }]
  // 已从当前版本移除、团队文本不再使用的段落。
  const removed = view.defaultChanged.filter(item => item.removed).map(item => item.part)
  // 页面容器。
  return <div className="dt-form">
    {/* 视图页签行。 */}
    <div className="dt-subtabs" role="tablist" aria-label={t('promptViews')}>{tabs.map(item => <button key={item.value} type="button"
      role="tab" className="dt-subtab" aria-selected={tab === item.value} onClick={() => setTab(item.value)}>{item.label}</button>)}</div>
    {/* 已移除段落的提示。 */}
    {removed.length > 0 && <Hint>{t('promptRemovedParts', { parts: removed.join(t('listSeparator')) })}</Hint>}
    {/* 编辑视图。 */}
    {tab === 'edit' && <PromptSections config={config} view={view} changed={changed} selected={selected} onSelect={select} onEdit={edit} />}
    {/* 完整提示词预览视图。 */}
    {tab === 'full' && <FullPrompt config={config} view={view} dirty={draft.dirty} revision={draft.revision} onEdit={open} />}
    {/* 历史视图（版本变化时重挂）。 */}
    {tab === 'history' && <PromptHistory key={view.revision} view={view} from={draft.meta?.from}
      onLoad={(next, from) => edit(withOverrides(next, view.parts), { from })} />}
    {/* 保存栏：丢弃时重载数据。 */}
    <SaveBar {...draft} words={words} onSave={() => { void draft.submit() }}
      onDiscard={() => { draft.discard(); reload().catch(failure => notify(errorText(failure))) }} />
  </div>
}

// 段落编辑视图：左侧段落导航 + 右侧编辑器。
function PromptSections({ config, view, changed, selected, onSelect, onEdit }: {
  config: PromptConfig; view: PromptsView; changed: string[]; selected: string; onSelect: (name: string) => void
  onEdit: (next: PromptConfig, note?: PromptNote) => void
}) {
  // 取翻译。
  const { t } = usePanel()
  // 新技能名输入。
  const [name, setName] = useState('')
  // 技能名无效标记。
  const [invalid, setInvalid] = useState(false)
  // item：导航项按钮（选中项带 aria-current）。
  const item = (section: string, children: ReactNode) => <button key={section} type="button" className="dt-nav-item"
    aria-current={section === selected ? 'true' : undefined} onClick={() => onSelect(section)}>{children}</button>
  // unsaved：未保存变更的小圆点标记。
  const unsaved = (section: string) => changed.includes(section) && <span className="dt-changed-dot" aria-label={t('unsaved')} />
  // add：添加自定义技能。
  const add = (event: FormEvent) => {
    // 阻止表单默认提交。
    event.preventDefault()
    // 名字不合法则标记错误并返回。
    if (!skillNameFree(name.trim(), config, view)) { setInvalid(true); return }
    // 生成技能段落名。
    const section = `skill/${name.trim()}`
    // 清空输入。
    setName('')
    // 写入空技能并选中它。
    onEdit(withSection(config, section, ''), { selection: section }); onSelect(section)
  }
  // 选中的内置段落定义（选中内置段落时）。
  const part = isPart(selected) ? view.parts.find(item => item.key === partKey(selected)) : undefined
  // 布局：左导航 + 右编辑器。
  return <div className="dt-prompt">
    {/* 段落导航。 */}
    <nav className="dt-prompt-nav" aria-label={t('promptSections')}>
      {/* 团队约定组。 */}
      <div className="dt-nav-group">{t('promptTeamGroup')}</div>
      {/* 团队段落项：标题 + 变更标记 + 一句说明。 */}
      {view.sections.map(section => item(section, <>
        <span>{sectionLabel(t, view, section)}{config[section] !== view.defaults[section] && <span
          className="dt-changed-tag">{t('promptChanged')}</span>}{unsaved(section)}</span><small>{t(`promptPartHint.${section}`)}</small>
      </>))}
      {/* 内置段落组。 */}
      <div className="dt-nav-group">{t('promptBuiltInGroup')}</div>
      {/* 内置段落项：覆盖标记与"默认已更新"标记。 */}
      {view.parts.map(entry => item(`part/${entry.key}`, <span>{sectionLabel(t, view, `part/${entry.key}`)}
        {config.overrides?.[entry.key] && <span className="dt-changed-tag">{t('promptChanged')}</span>}
        {updated(config, entry) && <span className="dt-changed-tag dt-updated-tag">{t('promptDefaultUpdated')}</span>}
        {unsaved(`part/${entry.key}`)}</span>))}
      {/* 技能组。 */}
      <div className="dt-nav-group">{t('promptSkillsGroup')}</div>
      {/* 技能项。 */}
      {Object.keys(config.skills).map(skill => item(`skill/${skill}`, <span>{sectionLabel(t, view, `skill/${skill}`)}{unsaved(
        `skill/${skill}`)}</span>))}
      {/* 添加自定义技能表单。 */}
      <form className="dt-add-skill" onSubmit={add}>
        <Input value={name} placeholder={t('promptSkillName')} aria-label={t('promptAddSkill')} spellCheck={false}
          onChange={event => { setName(event.target.value); setInvalid(false) }} />
        {/* 名字无效的错误提示。 */}
        {invalid && <p className="dt-error" role="alert">{t('promptSkillNameInvalid')}</p>}
        <Button variant="ghost" size="sm" type="submit" icon={<Icon name="plus" />}>{t('promptAddSkillAction')}</Button>
      </form>
    </nav>
    {/* 按选中段落类型渲染内置编辑器或团队编辑器。 */}
    {part ? <BuiltInEditor config={config} view={view} part={part} onEdit={onEdit} />
      : <TeamEditor config={config} view={view} selected={selected} onSelect={onSelect} onEdit={onEdit} />}
  </div>
}
/** Whether an override was edited from a built-in text that has changed since. */
// 覆盖所基于的内置文本自编辑以来是否已变化（用于"默认内容已更新"提示）。
const updated = (config: PromptConfig, part: BuiltInPart): boolean => {
  // 取该段落的覆盖。
  const override = config.overrides?.[part.key]
  // 有基线且基线不同于当前内置文本。
  return !!override?.base && override.base !== part.base
}
// 团队段落/技能编辑器：正文编辑 + 删除（技能）或恢复默认（段落）。
function TeamEditor({ config, view, selected, onSelect, onEdit }: {
  config: PromptConfig; view: PromptsView; selected: string; onSelect: (name: string) => void; onEdit: (next: PromptConfig, note?: PromptNote) => void
}) {
  // 取翻译。
  const { t } = usePanel()
  // 当前文本。
  const text = sectionText(config, selected) ?? ''
  // 默认文本（用于恢复默认）。
  const fallback = sectionText(view.defaults, selected)
  // 编辑器主体。
  return <div className="dt-prompt-main">
    {/* 小标题与操作按钮。 */}
    <div className="dt-subhead"><h3 className="dt-section-title">{sectionLabel(t, view, selected)}</h3>
      {/* 技能显示删除按钮，团队段落显示恢复默认按钮。 */}
      <span className="dt-actions">{isSkill(selected)
        ? <Button variant="outline" size="sm" icon={<Icon name="trash" />} onClick={() => { onEdit(withoutSkill(config, selected),
          { selection: 'communication' }); onSelect('communication') }}>{t('remove')}</Button>
        : <Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={fallback === text}
          onClick={() => onEdit(withSection(config, selected, fallback ?? ''), { from: { reset: selected } })}>
          {t('promptResetSection')}
        </Button>}
    </span></div>
    {/* 谁会读到这段内容。 */}
    <Hint>{t(isSkill(selected) ? 'promptReadBy.skill' : 'promptReadBy.both')}</Hint>
    {/* Markdown 正文编辑区。 */}
    <textarea className="dt-textarea dt-mono dt-editor" spellCheck={false} aria-label={t('promptBody')} value={text}
      onChange={event => onEdit(withSection(config, selected, event.target.value))} />
  </div>
}
/**
 * A built-in part: its text, the team's override or the built-in one, with a reset; a template says which placeholders it
 * keeps; an override whose built-in text changed since shows the change and offers to keep the team's text or take the new one.
 */
// 内置段落编辑器：覆盖或内置文本 + 恢复默认；模板段说明占位符；内置文本已变化的覆盖展示变化并提供取舍。
function BuiltInEditor({ config, view, part, onEdit }: {
  config: PromptConfig; view: PromptsView; part: BuiltInPart; onEdit: (next: PromptConfig, note?: PromptNote) => void
}) {
  // 取翻译。
  const { t } = usePanel()
  // 段落名。
  const name = `part/${part.key}`
  // reset：移除覆盖，恢复内置默认。
  const reset = () => onEdit(withOverride(config, part, undefined), { from: { reset: name } })
  // The built-in text the override was edited from, when this installation kept that one.
  // 覆盖编辑时所基于的内置文本（本安装保留过该基线时才有）。
  const base = config.overrides?.[part.key]?.base
  // 在默认变更记录中找到该基线对应的旧内置文本。
  const previous = view.defaultChanged.find(item => item.part === part.key && item.base === base)?.previous
  // readBy：按角色数决定"谁会读到"的文案 key。
  const readBy = part.key.startsWith('skill/') ? 'promptReadBy.skill' : part.roles.length > 1 ? 'promptReadBy.both'
    : `promptReadBy.${part.roles[0]!}` as const
  // 编辑器主体。
  return <div className="dt-prompt-main">
    {/* 小标题与恢复默认按钮（无覆盖时禁用）。 */}
    <div className="dt-subhead"><h3 className="dt-section-title">{sectionLabel(t, view, name)}</h3>
      <span className="dt-actions"><Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={!config.overrides?.[part.key]}
        onClick={reset}>{t('promptResetSection')}</Button></span></div>
    {/* 谁会读到这段内容。 */}
    <Hint>{t(readBy)}</Hint>
    {/* 模板段：说明必须保留的占位符。 */}
    {part.placeholders && <Hint>{t('promptTemplateHint', { placeholders: part.placeholders.join(t('listSeparator')) })}</Hint>}
    {/* 内置默认已变化的覆盖：展示变化并给出去留选择。 */}
    {updated(config, part) && <section className="dt-default-updated" aria-label={t('promptDefaultUpdated')}>
      <b>{t('promptDefaultUpdated')}</b>
      {/* 说明文案。 */}
      <Hint>{t('promptDefaultUpdatedHint')}</Hint>
      {/* 有旧默认记录则对比旧默认与新默认；否则对比团队文本与新默认。 */}
      {previous !== undefined ? <><Hint>{t('promptDefaultUpdatedKnown')}</Hint><Diff lines={lineDiff(previous, part.text)} /></>
        : <><Hint>{t('promptDefaultUpdatedUnknown')}</Hint><Diff lines={lineDiff(partText(config, part), part.text)} /></>}
      {/* 保留我的文本 / 改用新默认。 */}
      <span className="dt-actions">
        <Button variant="outline" size="sm" onClick={() => onEdit(withOverride(config, part, partText(config, part), true))}>
          {t('promptKeepMine')}</Button>
        <Button variant="outline" size="sm" onClick={reset}>{t('promptTakeDefault')}</Button>
      </span>
    </section>}
    {/* 正文编辑区（值为生效文本）。 */}
    <textarea className="dt-textarea dt-mono dt-editor" spellCheck={false} aria-label={t('promptBody')} value={partText(config, part)}
      onChange={event => onEdit(withOverride(config, part, event.target.value))} />
  </div>
}

// Preview 类型：完整提示词预览接口的响应。
type Preview = ApiResponse<'POST prompts/preview'>
// 预览目标类型：主 Session / 执行器 / 某个技能。
type Target = 'orchestrator' | 'worker' | `skill/${string}`
// 段落种类到文案 key 的映射。
const KIND_LABEL = { team: 'promptPartTeam', fixed: 'promptPartFixed', generated: 'promptPartGenerated' } as const
// 完整提示词预览：按目标渲染整段提示词并做差异对比。
function FullPrompt({ config, view, dirty, revision, onEdit }: {
  config: PromptConfig; view: PromptsView; dirty: boolean; revision: number; onEdit: (name: string) => void
}) {
  // 取上下文。
  const { t, call, notify } = usePanel()
  // 预览目标。
  const [target, setTarget] = useState<Target>('orchestrator')
  // 比较对象（草稿脏时默认与已保存版本比较）。
  const [compare, setCompare] = useState<'saved' | 'default'>(dirty ? 'saved' : 'default')
  // Keep the preview paired with the config it was composed from so diffs stay consistent until the next preview arrives.
  // 预览结果与其来源配置成对保存，保证下一次预览到达前差异始终一致。
  const [preview, setPreview] = useState<{ config: PromptConfig; value: Preview }>()
  // 预览错误。
  const [error, setError] = useState<Error>()
  useEffect(() => {
    // 有效性标记：配置变化或卸载后忽略过期响应。
    let active = true
    // 请求预览并记录其来源配置。
    call('POST prompts/preview', { body: config }).then(value => { if (active) { setPreview({ config, value }); setError(undefined) } },
      (failure: Error) => { if (active) setError(failure) })
    // 清理：置为无效。
    return () => { active = false }
  }, [call, config])
  // 无预览或出错时显示加载/错误状态。
  if (!preview || error) return <LoadState loading error={error} />
  // 实际使用的比较对象：干净时只能与默认值比较。
  const shown = dirty ? compare : 'default'
  // A built-in skill is a built-in part, by its key.
  // 目标技能不是团队技能时即为内置段落（按 key 判断）。
  const team = isSkill(target) && Object.hasOwn(preview.config.skills, target.slice(6))
  // 目标的段落列表：技能为单项，Session 目标为其全部段落。
  const parts: { name: string; kind: 'team' | 'fixed' | 'generated'; key?: string; heading?: string; text: string }[] = isSkill(target)
    ? [{ name: target, kind: team ? 'team' : 'fixed', ...team ? {} : { key: target }, text: preview.value.skills[target.slice(6)] ?? '' }]
    : preview.value.parts[target]
  // builtIn：按 key 查内置段落定义。
  const builtIn = (key: string) => view.parts.find(part => part.key === key)
  return <>
    {/* 头部：目标选择、状态、比较切换与复制。 */}
    <div className="dt-subhead">
      {/* 预览目标下拉。 */}
      <select className="dt-select dt-inline-select" aria-label={t('promptPreviewTarget')} value={target}
        onChange={event => setTarget(event.target.value as Target)}>
        <option value="orchestrator">{valueLabel(t, 'promptRole', 'orchestrator')}</option>
        <option value="worker">{valueLabel(t, 'promptRole', 'worker')}</option>
        {/* 技能选项。 */}
        {Object.keys(preview.value.skills).map(name => <option key={name} value={`skill/${name}`}>{sectionLabel(t, view,
          `skill/${name}`)}</option>)}
      </select>
      {/* 段数 / 字符数 / 草稿或版本状态提示。 */}
      <Hint>{t('promptFullState', { count: parts.length, chars: parts.reduce((sum, part) => sum + part.text.length, 0),
        state: dirty ? t('promptPreviewDraft') : t('promptPreviewSaved', { revision }) })}</Hint>
      {/* 比较对象切换（脏时才有"与已保存比较"）。 */}
      <SegmentedControl className="dt-segmented dt-compare" label={t('promptCompare')} value={shown} options={[...dirty
        ? [{ value: 'saved' as const, label: t('promptCompareSaved') }] : [], { value: 'default' as const,
          label: t('promptCompareDefault') }]} onChange={setCompare} />
      {/* 复制全文按钮。 */}
      <Button variant="outline" size="sm" icon={<Icon name="copy" />} onClick={() => {
        void navigator.clipboard.writeText(parts.map(part => part.text).join('\n\n')).then(() => notify(t('copied')))
      }}>{t('promptCopyAll')}</Button>
    </div>
    {/* 逐段渲染。 */}
    {parts.map(part => {
      // 段落种类。
      const { kind } = part
      // 草稿中该段落的团队文本（如有）。
      const text = sectionText(preview.config, part.name) ?? ''
      // 内置段落定义（内置/生成的段落有 key）。
      const entry = part.key === undefined ? undefined : builtIn(part.key)
      // The text a part is compared with: a team section's, or a built-in part's, override or built-in text, in the saved
      // version or the defaults; a generated part holds data and is not compared.
      // 比较基准文本：团队段落用其正文，内置段落用其覆盖或内置文本（取自已保存版本或默认值）；生成段不参与比较。
      const from = (config: PromptConfig) => kind === 'team' ? partWith(part, sectionText(config, part.name) ?? '')
        : kind === 'fixed' && entry ? partText(config, entry) : undefined
      // 按当前比较对象取基准。
      const base = from(shown === 'saved' ? view.current.config : view.defaults)
      // edited：团队段落是否不同于默认（技能除外）；内置段落是否有覆盖。
      const edited = kind === 'team' ? !isSkill(part.name) && text !== sectionText(view.defaults, part.name)
        : !!entry && !!preview.config.overrides?.[entry.key]
      // A generated part's template the draft changed shows filled, as it is not compared.
      // 草稿改过的生成段模板按填充后的内容展示（它不参与比较）。
      const template = kind === 'generated' && !!entry
        && preview.config.overrides?.[entry.key]?.text !== view.current.config.overrides?.[entry.key]?.text
      // 渲染段落区块（可编辑的带 data-editable 标记）。
      return <section key={part.name} className="dt-preview-part" data-editable={kind === 'team' || entry !== undefined || undefined}>
        {/* 段头：名称、种类、变更标记与"编辑此段"链接。 */}
        <div className="dt-preview-head"><b>{sectionLabel(t, view, entry ? `part/${entry.key}` : part.name)}</b><span>{t(KIND_LABEL[kind])}</span>
          {edited && <span className="dt-changed-tag">{t('promptChanged')}</span>}
          {(kind === 'team' || entry) && <button type="button" className="dt-textlink"
            onClick={() => onEdit(entry ? `part/${entry.key}` : part.name)}>{t('promptEditSource')}</button>}
        </div>
        {/* When comparing against saved, show only changes from this draft and fold the parts it leaves as they were. */}
        {/* 有基准且不同则显示差异；与已保存相同（或生成段未改）显示提示；否则显示原文。 */}
        {base !== undefined && base !== part.text ? <Diff lines={lineDiff(base, part.text)} />
          : shown === 'saved' && !template ? <Hint>{t(kind === 'generated' ? 'promptBuiltInFolded' : 'promptSameAsSaved')}</Hint>
          : <pre className="dt-pre">{part.text}</pre>}
      </section>
    })}
  </>
}
// 差异渲染组件：折叠计数行用灰色，插入用 ins，删除用 del。
function Diff({ lines }: { lines: DiffLine[] }) {
  // 取翻译。
  const { t } = usePanel()
  // 渲染为 pre 文本块。
  return <pre className="dt-pre">{lines.map((line, index) => <Fragment key={index}>{line.kind === 'fold'
    ? <><span className="dt-diff-fold">{t('promptSameLines', { count: line.count })}</span>{'\n'}</>
    : line.kind === 'ins' ? <ins>{`${line.text}\n`}</ins> : line.kind === 'del' ? <del>{`${line.text}\n`}</del>
    : `${line.text}\n`}</Fragment>)}</pre>
}

// 提示词历史视图：版本列表、载入历史版本与默认值、Session 使用情况。
function PromptHistory({ view, from, onLoad }: {
  view: PromptsView; from: Origin | undefined; onLoad: (config: PromptConfig, from: Origin) => void
}) {
  // 取上下文。
  const { t, call } = usePanel()
  // 更早版本的分页状态。
  const [older, setOlder] = useState<Pick<PromptsView, 'revisions' | 'next_offset'>>()
  // 下一页 offset（已加载更早页则用其 offset）。
  const next = older ? older.next_offset : view.next_offset
  // more：加载更早的版本页。
  const more = useAction(async (offset: number) => {
    // 请求下一页。
    const page = await call('GET prompts', { query: { offset } })
    // 追加版本并记录新的下一页 offset。
    setOlder({ revisions: [...older?.revisions ?? [], ...page.revisions], next_offset: page.next_offset })
  })
  // load：载入指定版本到草稿。
  const load = useAction(async (revision: number) => {
    // 请求该版本并把其配置交给 onLoad。
    onLoad((await call('GET prompts', { query: { revision } })).current.config, { revision })
  })
  // 历史页主体。
  return <div className="dt-form">
    {/* 载入说明。 */}
    <Hint>{t('promptHistoryHint')}</Hint>
    {/* 版本列表。 */}
    <ul className="dt-list">{[...view.revisions, ...older?.revisions ?? []].map(version => <li key={version.revision} className="dt-row">
      <div className="dt-row-main">
        {/* 版本标题：修订号、保存时间（初始版本无时间）与来源。 */}
        <div className="dt-row-title">{t('promptHistoryItem', { revision: version.revision, time: version.savedAt
          ? when(version.savedAt, t('lang')) : t('promptHistoryInitial'), source: valueLabel(t, 'historySource', version.source) })}</div>
        {/* 变更段落或"无内容变化"。 */}
        <div className="dt-row-meta">{version.changed.length ? t('promptHistoryChanged', { parts: version.changed.map(name =>
          sectionLabel(t, view, name)).join(t('listSeparator')) }) : t('promptHistoryNone')}</div>
      </div>
      {/* 载入按钮：忙碌或正是当前草稿来源版本时禁用。 */}
      <div className="dt-row-actions"><Button variant="outline" size="sm" icon={<Icon name="history" />}
        disabled={load.busy || (typeof from === 'object' && 'revision' in from && from.revision === version.revision)}
        onClick={() => { void load.run(version.revision) }}>{t('promptRestore')}</Button></div>
    </li>)}</ul>
    {/* 底部操作。 */}
    <div className="dt-actions">
      {/* 更早版本按钮（还有下一页时显示）。 */}
      {next !== null && <Button variant="outline" size="sm" icon={<Icon name="chevron-down" />} disabled={more.busy}
        onClick={() => { void more.run(next) }}>{t('promptOlder')}</Button>}
      {/* 整套载入默认值。 */}
      <Button variant="outline" size="sm" icon={<Icon name="refresh" />}
        onClick={() => onLoad(view.defaults, 'defaults')}>{t('promptDefaults')}</Button>
    </div>
    {/* Session 最近使用的版本。 */}
    <div className="dt-field"><span>{t('promptSessions')}</span>
      {/* 会话列表或空提示。 */}
      {view.sessions.length ? <ul className="dt-changes dt-mono">{view.sessions.map(item => <li
        key={item.sessionId}>{t('promptSessionItem', { session: item.sessionId, revision: item.revision })}</li>)}</ul>
        : <Hint>{t('promptNoSessions')}</Hint>}
    </div>
  </div>
}
