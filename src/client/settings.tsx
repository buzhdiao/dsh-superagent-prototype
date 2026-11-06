/** Settings tab shell routing between stage settings (Sources, Eval, Execution), Prompts, and Deployment. */
// 设置页签外壳：在阶段设置（来源、评估、执行）、提示词与部署之间路由。
import type { StateView } from './api.ts'
// StateView：全局状态视图类型。
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
// 部署设置页及其表单状态类型。
import { EvalSettings } from './eval.tsx'
// 评估设置分组。
import { ExecutionSettings } from './execution.tsx'
// 执行设置分组。
import { PromptsPage } from './prompts.tsx'
// 提示词（Prompts）分组。
import { usePanel } from './provider.tsx'
// usePanel：读取面板能力上下文。
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
// 设置分组列表与设置页路由构造器。
import { SettingsProvider } from './settings-kit.tsx'
// SettingsProvider：设置上下文 Provider。
import { SourceSettings } from './source.tsx'
// SourceSettings：来源设置分组页面。

const STAGE_GROUPS: readonly SettingsGroup[] = ['source', 'eval', 'execution']
// 属于“阶段设置”的分组，导航上会加 data-stage 标记用于样式区分。
export function SettingsPage({ group, query, state, deploymentForm }: {
  // 设置页组件：按分组渲染对应子页面。
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
  // group 为当前分组；query 为设置页查询参数；state/deploymentForm 由宿主传入。
}) {
  const { t, navigate } = usePanel()
  // 取翻译函数与导航函数。
  const content = (() => {
    // 立即执行函数：根据分组选择要渲染的设置内容。
    switch (group) {
      case 'source': return <SettingsProvider><SourceSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      // 来源设置：query.source 存在时聚焦该来源。
      case 'eval': return <SettingsProvider><EvalSettings version={query.version} /></SettingsProvider>
      // 评估设置：可指定版本。
      case 'execution': return <SettingsProvider><ExecutionSettings /></SettingsProvider>
      // 执行设置。
      case 'prompts': return <PromptsPage />
      // 提示词页无需 SettingsProvider 包裹。
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
      // 部署页：传入初始化状态与部署表单。
    }
  })()
  return <div className="dt-settings">
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      {/* 左侧分组导航，aria-label 标注为“设置”。 */}
      {SETTINGS_GROUPS.map(value => <button key={value} type="button" className="dt-settings-link" data-stage={STAGE_GROUPS.includes(value)
        || undefined}
        aria-current={value === group ? 'page' : undefined} onClick={() => navigate(settingsRoute(value),
          true)}>{t(`settingsGroup.${value}`)}</button>)}
      {/* 每个分组一个按钮：阶段分组加 data-stage；当前分组标记 aria-current；点击替换式跳转（replace）。 */}
    </nav>
    <div className="dt-settings-body">
      <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
      {/* 当前分组标题。 */}
      {content}
      {/* 渲染选中的设置内容。 */}
    </div>
  </div>
}
