/** Root panel shell: header with global search and glossary, top-level navigation tabs, and active route view. */
// 根面板外壳：带全局搜索与术语表的顶栏、顶级导航页签与当前路由视图。
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
// 引入 React Hook 与表单事件/节点类型。
import type { SearchView } from './api.ts'
// 引入搜索结果视图类型。
import { Button, Dot, Icon, Input, Modal, SegmentedTabs } from './controls.tsx'
// 引入基础控件：按钮、状态点、图标、输入框、弹窗与分段页签。
import type { DeploymentForm } from './deployment.tsx'
// 引入部署表单类型。
import { EvalStatus } from './eval.tsx'
// 引入评估状态页。
import { ExecutionStatus } from './execution.tsx'
// 引入执行状态页。
import { ticketMark } from './marks.ts'
// 引入工单状态标记。
import { GLOSSARY, GLOSSARY_VALUES, en, zh, type DshSuperagentKey } from './locales.ts'
// 引入术语表、取值说明与中英文词条表。
import { OverviewPage } from './overview.tsx'
// 引入总览页。
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
// 引入面板上下文：Provider、上下文 Hook 与共享数据 Hook。
import { HOME, TABS, initialLocation, lastSettingsGroup, remember, routeLabel, settingsRoute, type Location, type Route,
  type Tab } from './route.ts'
// 引入路由工具：首页、页签列表、初始位置、设置分组记忆、本地持久化与路由标签。
import { SettingsPage } from './settings.tsx'
// 引入设置页。
import { SourceStatus } from './source.tsx'
// 引入来源状态页。
import { actorName, errorText, reasonLabel, valueLabel, type T, readableMarkers } from './text.ts'
// 引入展示工具：参与者名、错误文案、原因与取值标签等。
import { ThreadPage } from './thread.tsx'
// 引入线程详情页。
import { TicketPage } from './ticket.tsx'
// 引入工单详情页。
import { TriggerStatus } from './trigger.tsx'
// 引入触发器状态页。
import { When } from './widgets.tsx'
// 引入时间展示组件。

// 应用属性：翻译函数、打开会话回调与部署表单。
export interface AppProps {
  t: T; openSession: (sessionId: string) => Promise<void>
  deploymentForm: DeploymentForm
}

// 术语表（Glossary）弹窗：双语术语对照、状态图例与取值说明。
function Glossary({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 取面板上下文中的翻译函数。
  const { t } = usePanel()
  // 用一条文案对比判断当前界面语言是否为中文。
  const chinese = t('tab.overview') === zh['tab.overview']
  // 本语言词条与对照语言词条。
  const [own, other] = chinese ? [zh, en] : [en, zh]
  // 分组标题：roles 组用专属文案，其余复用页签文案。
  const heading = (group: keyof typeof GLOSSARY) => t(group === 'roles' ? 'glossaryGroup.roles' : `tab.${group}`)
  // 弹窗容器：标题、关闭按钮、介绍文案与主按钮。
  return <Modal className="dt-glossary-modal" open={open} onClose={onClose} title={t('glossary')} closeLabel={t('close')}
    description={t('glossaryIntro')} footer={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}>
    <div className="dt-glossary-body">
      {/* 双语对照表。 */}
      <table className="dt-glossary">
        {/* 表头：本语言 / 对照语言 / 含义。 */}
        <thead><tr>
          <th>{t(chinese ? 'glossaryChinese' : 'glossaryEnglish')}</th><th>{t(chinese ? 'glossaryEnglish' : 'glossaryChinese')}</th>
          <th>{t('glossaryMeaning')}</th>
        </tr></thead>
        {/* 按分组渲染表体。 */}
        {Object.entries(GLOSSARY).map(([group, keys]) => <tbody key={group}>
          <tr><th colSpan={3} scope="rowgroup" className="dt-glossary-group">{heading(group as keyof typeof GLOSSARY)}</th></tr>
          {keys.map(key => <tr key={key}><td>{own[`term.${key}`]}</td><td>{other[`term.${key}`]}</td><td>{own[`meaning.${key}`]}</td></tr>)}
        </tbody>)}
      </table>
      {/* 图例标题。 */}
      <p className="dt-legend-title">{t('legendTitle')}</p>
      {/* 状态图例：五种状态圆点及文案。 */}
      <ul className="dt-legend">{(['done', 'ongoing', 'warning', 'error', 'idle'] as const).map(state => <li key={state}>
        <Dot state={state} /><span>{t(`legend.${state}`)}</span>
      </li>)}</ul>
      {/* 取值说明：每组值以 "本语言 对照语言" 并列展示。 */}
      <dl className="dt-values">{Object.entries(GLOSSARY_VALUES).map(([group, values]) => <div key={group} style={{ display: 'contents' }}>
        <dt>{own[`term.${group}` as DshSuperagentKey]}</dt>
        <dd>{values.map(key => `${own[key]} ${other[key]}`).join(' · ')}</dd>
      </div>)}</dl>
    </div>
  </Modal>
}

// 文本高亮（Highlight）：把查询命中的片段包进 <mark>。
function Highlight({ text, query }: { text: string; query: string }) {
  // 大小写不敏感地查找查询首次出现的位置。
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  // 未命中直接返回原文。
  if (index < 0) return <>{text}</>
  // 命中时拆成"前 + 命中 + 后"三段，命中段加高亮标记。
  return <>{text.slice(0, index)}<mark className="dt-mark">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>
}
// 搜索结果行（Result）：名称可点击打开，children 为元信息。
function Result({ name, open, children }: { name: ReactNode; open: (() => void) | undefined; children: ReactNode }) {
  // 有打开回调时名称渲染为按钮，否则保持纯文本。
  return <li className="dt-row dt-link"><div className="dt-row-main">
    <div className="dt-row-title">{open ? <button type="button" className="dt-open" onClick={open}>{name}</button> : name}</div>
    <div className="dt-row-meta">{children}</div>
  </div></li>
}
// 搜索结果面板：计数提示与工单/线程/触发器结果列表。
function SearchResults({ result, query, onClose }: { result: SearchView; query: string; onClose: () => void }) {
  // 取翻译函数与导航。
  const { t, navigate } = usePanel()
  // 取共享面板数据（用于判断是否配置了飞书账号）。
  const { setup } = usePanelData()
  // 是否完全没有结果。
  const empty = !result.items.length && !result.threads.length && !result.tickets.length
  // 各类结果的条数。
  const counts = { tickets: result.tickets.length, threads: result.threads.length, items: result.items.length }
  // go：关闭结果面板并跳转到指定路由。
  const go = (route: Route) => () => { onClose(); navigate(route) }
  // 结果区域容器。
  return <div className="dt-search-results" role="region" aria-label={t('searchLabel')}>
    {/* 头部：计数提示与关闭按钮。 */}
    <div className="dt-search-head">
      {/* 空结果提示区分是否配置飞书账号；有结果时提示是否达到 20 条上限。 */}
      <span className="dt-hint">{empty ? t(setup?.accounts?.feishu ? 'searchNone' : 'searchNoneGithub')
        : t(result.items.length >= 20 ? 'searchFoundCapped' : 'searchFound', counts)}</span>
      <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />} aria-label={t('close')} onClick={onClose} />
    </div>
    {/* 有结果时渲染列表。 */}
    {!empty && <ul className="dt-list">
      {/* 工单结果：点击进入执行页。 */}
      {result.tickets.map(ticket => <Result key={ticket.id} name={<Highlight text={ticket.title} query={query} />}
        open={go({ page: 'execution', id: ticket.id })}>
        <span>{t('term.ticket')}</span><span>{ticket.stage === 'ended' ? t('ticket.ended') : ticketMark(t, ticket).label}</span>
      </Result>)}
      {/* 线程结果：点击进入触发器页。 */}
      {result.threads.map(thread => <Result key={thread.key} name={readableMarkers(t, thread.title)} open={go({ page: 'trigger',
        id: thread.key })}>
        <span>{t('term.thread')}</span>
      </Result>)}
      {/* Filtered triggers have no Thread and display their filter reason instead of a link. */}
      {/* 触发器结果：未被过滤的可点击跳转并定位到该触发器。 */}
      {result.items.map(item => <Result key={item.id} name={<Highlight text={readableMarkers(t, item.preview) || t('empty')}
        query={query} />}
        open={item.filtered === undefined ? go({ page: 'trigger', id: item.threads[0]!, query: { trigger: item.id } }) : undefined}>
        <span>{valueLabel(t, 'source', item.source)}</span><span>{actorName(t, item.actor)}</span><When at={item.at} />
        {item.threadTitle && <span className="dt-ellipsis">{t('inThread', { thread: readableMarkers(t, item.threadTitle) })}</span>}
        {item.filtered !== undefined && <span>{t('searchFiltered', { reason: reasonLabel(t, item.filtered) })}</span>}
      </Result>)}
    </ul>}
  </div>
}

// 顶部栏：标题、全局搜索、术语表入口与主会话按钮。
function Header({ masterId }: { masterId: string | undefined }) {
  // 取上下文：翻译、API 调用、打开会话与通知。
  const { t, call, openSession, notify } = usePanel()
  // 术语表弹窗开关。
  const [glossary, setGlossary] = useState(false)
  // 搜索框输入内容。
  const [query, setQuery] = useState('')
  // 最近一次搜索结果（连同其查询词）。
  const [result, setResult] = useState<{ query: string; value: SearchView }>()
  // Ignore responses from superseded or cleared search requests.
  // 请求序号：忽略被取代或已清空的搜索请求的响应。
  const latest = useRef(0)
  // show：展示（或清除）结果，并使旧请求作废。
  const show = (value?: { query: string; value: SearchView }) => { latest.current++; setResult(value) }
  // 搜索表单引用（用于判断点击是否在表单外）。
  const search = useRef<HTMLFormElement>(null)
  useEffect(() => {
    // 没有结果时无需监听。
    if (!result) return
    // 点击目标不在搜索表单内时关闭结果。
    const close = (event: PointerEvent) => { if (!search.current?.contains(event.target as Node)) show() }
    // 挂载指针按下监听。
    document.addEventListener('pointerdown', close)
    // 卸载时移除监听。
    return () => { document.removeEventListener('pointerdown', close) }
  }, [result])
  // 提交搜索。
  const submit = (event: FormEvent) => {
    // 阻止表单默认提交（避免整页刷新）。
    event.preventDefault()
    // 查询词去首尾空白。
    const text = query.trim()
    // 空查询直接清除结果。
    if (!text) { show(); return }
    // 登记本次请求序号。
    const request = ++latest.current
    // 发起搜索；仍是最新请求才展示结果，失败则通知错误。
    call('GET search', { query: { q: text } }).then(value => { if (request === latest.current) setResult({ query: text, value }) },
      failure => { if (request === latest.current) notify(errorText(failure)) })
  }
  // 顶部栏布局。
  return <header className="dt-head">
    <div className="dt-head-title"><h1 className="dt-title">{t('title')}</h1></div>
    {/* 工具栏：搜索、术语表与主会话。 */}
    <div className="dt-toolbar">
      {/* 全局搜索表单：Escape 清除结果。 */}
      <form ref={search} className="dt-search" role="search" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') show() }}>
        {/* 搜索输入框：清空输入即收起结果。 */}
        <Input type="search" icon={<Icon name="search" />} value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchLabel')}
          onChange={event => { setQuery(event.target.value); if (!event.target.value) show() }} />
        {/* 有结果时展示结果面板。 */}
        {result && <SearchResults result={result.value} query={result.query} onClose={() => { show() }} />}
      </form>
      {/* 术语表入口按钮。 */}
      <Button variant="ghost" size="sm" icon={<Icon name="question" />} aria-label={t('glossary')} title={t('glossary')} aria-haspopup="dialog"
        onClick={() => setGlossary(true)} />
      {/* 打开主会话按钮：无主会话时禁用。 */}
      <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} disabled={!masterId}
        onClick={() => { if (masterId) openSession(masterId).catch(failure => notify(errorText(failure))) }}>{t('openMaster')}</Button>
    </div>
    {/* 术语表弹窗。 */}
    <Glossary open={glossary} onClose={() => setGlossary(false)} />
  </header>
}

// 页面容器（Pages）：按当前路由渲染对应页面。
function Pages({ route, openTab, deploymentForm }: { route: Route; openTab: (tab: Tab) => void; deploymentForm: DeploymentForm }) {
  // 取翻译函数。
  const { t } = usePanel()
  // 取共享面板数据：状态、错误与重载。
  const { state, error, reload } = usePanelData()
  // Keep the active tab scrolled into view on narrow screens when routes change via links.
  // 通过链接切换路由时，把当前页签滚动到可见区域（适配窄屏）。
  useEffect(() => { document.getElementById(`dt-tab-${route.page}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [route.page])
  // 等待态：出错显示错误信息，否则显示加载中。
  const waiting = error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>
  // 按路由选择要渲染的页面组件。
  const page = (() => {
    // 按页名分发。
    switch (route.page) {
      // 总览页。
      case 'overview': return <OverviewPage />
      // 来源状态页。
      case 'source': return <SourceStatus />
      // 触发器：带 id 进入线程详情页；否则显示触发器列表。
      case 'trigger': return route.id !== undefined ? <ThreadPage key={route.id} id={route.id} target={route.query?.trigger} />
        : <TriggerStatus filter={route.query?.filter ?? 'subscribed'} />
      // 评估状态页（带过滤与时间窗口参数）。
      case 'eval': return <EvalStatus filter={route.query?.filter ?? 'work'} window={route.query?.window}
        paused={!!state?.paused} />
      // 执行：带 id 进入工单详情页；状态就绪后显示执行列表，否则等待。
      case 'execution': return route.id !== undefined ? <TicketPage key={route.id} id={route.id} />
        : state ? <ExecutionStatus filter={route.query?.filter ?? 'open'} state={state} reload={reload} /> : waiting
      // 设置页：状态就绪后渲染，否则等待。
      case 'settings': return state ? <SettingsPage key={state.masterId} group={route.query.group} query={route.query} state={state}
        deploymentForm={deploymentForm} /> : waiting
    }
  })()
  // 页面骨架：顶栏 + 页签 + 主体。
  return <div className="dt-page">
    <div className="dt-column">
      {/* 顶部栏。 */}
      <Header masterId={state?.masterId} />
      {/* 有错误且状态可用时显示的错误横幅。 */}
      {error && state && <p className="dt-error" role="status">{error.message}</p>}
      {/* 顶级导航页签。 */}
      <SegmentedTabs className="dt-tabs" label={t('pagesLabel')} value={route.page} onChange={openTab}
        items={TABS.map(value => ({ value, label: t(`tab.${value}`), id: `dt-tab-${value}`, panelId: 'dt-page' }))} />
      {/* 主体区域。 */}
      <main id="dt-page" role="tabpanel" aria-labelledby={`dt-tab-${route.page}`} className="dt-main">{page}</main>
    </div>
  </div>
}

/** Root panel component managing route history and shared panel state. */
// 根面板组件（App）：管理路由历史与共享面板状态。
export function App({ t, openSession, deploymentForm }: AppProps) {
  // 路由位置状态：当前路由与返回栈。
  const [location, setLocation] = useState(initialLocation)
  // 位置变化时持久化到本地（remember）。
  useEffect(() => { remember(location) }, [location])
  // Preserve the last opened settings group across navigation so the Settings tab reopens at it.
  // move：在位置变更时保留上次打开的设置分组，使设置页签重开时回到原分组。
  const move = useCallback((next: (current: Location) => Pick<Location, 'route' | 'stack'>) =>
    setLocation(current => ({ ...next(current), group: lastSettingsGroup(current) })), [])
  /** Navigates to `route`; `replace` swaps the current entry (filters, paging) instead of pushing a back step. */
  // navigate：默认压栈（保留返回路径）；replace 时替换当前项（用于过滤、翻页），栈最多保留 20 层。
  const navigate = useCallback((route: Route, replace = false) => move(current => ({ route,
    stack: replace ? current.stack : [...current.stack, current.route].slice(-20) })), [move])
  // back：弹出返回栈；栈空则回首页。
  const back = useCallback(() => move(current => ({ route: current.stack.at(-1) ?? HOME, stack: current.stack.slice(0, -1) })), [move])
  // openTab：切换顶级页签并清空返回栈；设置页签回到上次的分组。
  const openTab = useCallback((tab: Tab) => move(current => ({ stack: [], route: tab === 'settings'
    ? settingsRoute(lastSettingsGroup(current)) : { page: tab, id: undefined } })), [move])
  // 用面板 Provider 提供上下文并渲染页面容器。
  return <PanelProvider t={t} openSession={openSession} navigate={navigate} back={back} backLabel={routeLabel(t, location.stack.at(-1) ?? HOME)}>
    <Pages route={location.route} openTab={openTab} deploymentForm={deploymentForm} />
  </PanelProvider>
}
