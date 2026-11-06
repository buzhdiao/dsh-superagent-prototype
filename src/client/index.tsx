/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
// 浏览器插件入口：注册侧边栏图标、主管理面板与插件管理器配置视图。
import { useCallback, useEffect, useRef } from 'react'
// 引入 React Hook。
import type { Context } from '@deepseek-ai/cordis'
// 引入 cordis 插件上下文类型。
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// 引入主面板 id 类型。
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
// 引入侧边栏图标属性类型。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型侧载：扩展 locale 声明。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 类型侧载：扩展渲染器声明。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// 类型侧载：扩展工作区声明。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型侧载：扩展设置声明。
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// 引入插件管理器配置视图属性。
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// 引入会话服务接口。
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// 引入会话 id 类型。
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
// 引入会话导航工具与导航错误。
import { App } from './app.tsx'
// 引入根面板组件。
import { PluginConfig, usePageForm } from './deployment.tsx'
// 引入插件配置视图与页面表单 Hook。
import { en, zh } from './locales.ts'
// 引入中英词典。
import type { T } from './text.ts'
// 引入翻译函数类型。

// 插件客户端上下文：cordis 上下文 + 会话服务。
type ClientContext = Context & { sessions: ISessions }
// 本地化命名空间。
const NS = 'dshSuperagent'
// 主面板 id。
const PANEL_ID = 'dsh-superagent' as MainPanelId
// 插件条目名（用于查询其配置表单）。
const ENTRY = 'dsh-superagent'

// 侧边栏图标：锤子 SVG。
function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
// 已挂载面板包装：新会话导航开始或面板卸载时，取消未完成的会话导航。
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  // 待处理的会话导航中止控制器。
  const pending = useRef<AbortController>(undefined)
  // 卸载时中止未完成的导航。
  useEffect(() => () => { pending.current?.abort() }, [])
  // openSession：打开指定会话（新的导航会取消上一次）。
  const openSession = useCallback(async (id: string) => {
    // 中止上一次导航。
    pending.current?.abort()
    // 登记本次导航的控制器。
    const request = new AbortController(); pending.current = request
    try {
      // 打开已知会话（在工作区中打开目标）。
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      // 导航错误转为本地化消息（列表未就绪 / 会话不在列表中）。
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      // 其他错误原样抛出。
      throw error
    }
  }, [ctx, t])
  // 获取本插件的配置表单并适配为页面表单（缺失时机器设置为只读）。
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  // 渲染根面板。
  return <App t={t} openSession={openSession} deploymentForm={form} />
}

// 依赖注入声明：插槽、本地化、会话与工作区。
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
// 注册主面板、侧边栏图标与插件管理器配置视图；configForms 可选（缺失时机器设置只读）。
export function apply(ctx: ClientContext): void {
  // 注册中英词典。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  // 绑定翻译函数。
  const t = ctx.locale.bind(NS)
  // 注入主面板插槽。
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  // 注入侧边栏面板列表项（图标入口）。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
  // 注入插件管理器行内配置视图。
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
