/**
 * Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
 * Edits host-level plugin configuration limits through DSH `ConfigForm` when writable.
 */
// 部署设置视图：面板设置页签与 DSH 插件管理器配置页共用；可写时通过 DSH `ConfigForm` 编辑宿主级插件配置限制。
import { useCallback, useMemo, useSyncExternalStore } from 'react'
// 引入 React Hook：回调稳定化、记忆化与外部存储同步。
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// 引入 DSH 设置界面的表单类型。
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// 引入 DSH 插件管理器的配置页表单类型。
import { LIMITS } from '../limits.ts'
// 引入各机器限制的取值范围。
import type { SetupView } from './api.ts'
// 引入初始化视图类型。
import { InfoTip, Input } from './controls.tsx'
// 引入信息气泡与输入框组件。
import { SaveBar, useDraft } from './draft.tsx'
// 引入保存栏与草稿 Hook。
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
// 引入面板上下文：Provider、上下文 Hook 与共享数据 Hook。
import { Field, Fields } from './settings-kit.tsx'
// 引入设置表单的字段与字段组组件。
import { setupText, type T } from './text.ts'
// 引入初始化问题文案工具与翻译类型。
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage } from './widgets.tsx'
// 引入通用组件：检查初始化按钮、提示、键值表、区块与问题消息。

// 部署表单类型：DSH 配置页表单（未就绪时为 undefined）。
export type DeploymentForm = ConfigPageForm | undefined
// Op 类型：DSH 表单 mutate 操作的元素类型。
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

// 托管到 DSH 的机器限制键（提示词长度、准入上下文页数与超时）。
const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
// Limits：限制键到字符串值的映射（输入框以字符串编辑）。
type Limits = Record<typeof MACHINE_LIMITS[number], string>
// 把未知值转成展示字符串：仅接受字符串/数字，否则为空串。
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
// 从配置对象提取各限制键的字符串值（缺省为空串）。
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits

// 把 DSH ConfigForm 适配为 React 可用的部署表单（外部存储 + 快照）。
export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): DeploymentForm {
  // 订阅函数：无表单时返回空订阅。
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  // 用外部存储同步表单快照。
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  // 表单与快照就绪时打包 state 与 mutate，并按引用稳定缓存。
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

/** Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only. */
// 部署配置页：DSH 配置表单不可用或只读时回退为只读展示。
export function DeploymentPage({ setup, form, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean }) {
  // 取翻译与通知。
  const { t, notify } = usePanel()
  // 表单快照。
  const snapshot = form?.state
  // 是否可编辑：表单就绪且可写。
  const editable = snapshot?.status === 'ready' && snapshot.writable
  // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  // 构建草稿：已保存值取可写时的表单值（否则回退为 setup 的机器配置）；仅在可写时传修订号，使 ready 前开始的草稿在可写后重定基（rebase）。
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    // reload 为空操作：保存即生效，无需重拉。
    reload: async () => {},
    // save：把草稿提交给 DSH 表单。
    save: async (value, revision, base) => {
      // 仅对值有变化的键生成 set/unset 操作：填了数字则 set，清空则 unset。
      const ops: Op[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      // 表单缺失或 DSH 拒绝变更时抛错。
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      // 成功后提示已保存。
      notify(t('saved'))
      // 返回新修订号与"无需重启"标记。
      return { revision: revision + 1, restarting: false }
    } })
  // 派生的账号信息。
  const accounts = setup.accounts
  // Remote browsers (`memory` mode) are read-only; `unavailable` indicates `dsh-superagent` is still starting.
  // 只读原因提示：远程浏览器（memory 模式）只读；unavailable 表示 dsh-superagent 仍在启动中。
  const readOnlyHint = !form ? t('deploymentNoForms') : snapshot?.mode === 'memory' ? t('deploymentReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  // limit：渲染单个数字限制输入框（范围来自 LIMITS，不可编辑时禁用）。
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} disabled={!editable}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  // 飞书账号描述：账号名/机器人 id，缺失时按飞书初始化问题或"未配置"提示。
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  // 表单：提交交给草稿的 submit 处理。
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    {/* 提交中禁用整组字段。 */}
    <Fields disabled={draft.busy}>
      {/* 介绍文案。 */}
      <Hint>{t('deploymentIntro')}</Hint>
      {/* 全局初始化问题横幅与检查按钮。 */}
      {setup.problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
      </div>}
      {/* 派生账号信息区块（按需显示）。 */}
      {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        {/* 仓库、智能体与飞书账号的键值表。 */}
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
        <Hint>{t('deploymentAccountsWhere')}</Hint>
      </Section>}
      {/* 机器配置区块。 */}
      <Section title={t('deploymentMachine')}>
        {/* 只读原因提示（如有）。 */}
        {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
        {/* 状态目录展示（附说明气泡）。 */}
        <div className="dt-field">
          <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
          <span className="dt-mono">{setup.machine.stateDir}</span>
        </div>
      </Section>
      {/* 机器限制区块。 */}
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {/* 三个限制输入框。 */}
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
      </Section>
    </Fields>
    {/* 可编辑时显示保存栏。 */}
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
  </form>
}

/** Plugin Manager config page; includes derived repository and accounts because Source settings live in the main panel. */
// 插件管理器配置页：附带派生的仓库与账号信息（来源设置在主面板中）。
function PluginPage({ form }: { form: DeploymentForm }) {
  // 取翻译。
  const { t } = usePanel()
  // 取共享面板数据：状态与错误。
  const { state, error } = usePanelData()
  // 嵌入容器：状态就绪渲染部署页；出错显示错误；否则加载中。
  return <div className="dt-embedded">
    {state ? <DeploymentPage setup={state.setup} form={form} accounts />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>}
  </div>
}
/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
// DSH 插件管理器配置视图入口：summary 模式不渲染（由 DSH 展示包描述）。
export function PluginConfig({ t, view, form }: { t: T; view: 'page' | 'summary'; form: DeploymentForm }) {
  // page 模式用面板 Provider 包裹（10 秒轮询间隔）。
  return view === 'page' ? <PanelProvider t={t} interval={10_000}><PluginPage form={form} /></PanelProvider> : null
}
