/** Trigger status view listing Threads filtered by subscription and evaluation activity. */
// 触发状态页：按订阅（subscription）与评估活动筛选并列出线程（Thread）。
import { useState } from 'react'
// useState：管理列表加载数量上限。
import { THREAD_FILTERS, type ThreadFilter } from '../app/api.ts'
// 线程筛选器常量与类型。
import { usePoll } from './api.ts'
// usePoll：轮询 Hook。
import { Pill } from './controls.tsx'
// Pill：筛选按钮控件。
import { usePanel } from './provider.tsx'
// usePanel：读取面板上下文。
import { ThreadLine } from './rows.tsx'
// ThreadLine：单条线程的列表行组件。
import { Hint, LoadMore, LoadState, StatusHead } from './widgets.tsx'
// 通用部件：提示、加载更多、加载状态、页头。

export function TriggerStatus({ filter }: { filter: ThreadFilter }) {
  // 触发状态视图组件，filter 为当前筛选。
  const { t, call, navigate } = usePanel()
  // 取翻译、请求与导航能力。
  const [limit, setLimit] = useState(20)
  // 每次加载的条数上限，默认 20，可“加载更多”递增。
  const { data, error } = usePoll(() => call('GET threads', { query: { filter, limit } }), [filter, limit])
  // 按筛选与上限轮询线程列表。
  const go = (next: ThreadFilter) => { setLimit(20); navigate({ page: 'trigger', query: next !== 'subscribed' ? { filter: next } : {} },
    true) }
  // 切换筛选：重置分页；subscribed 为默认筛选（不写入 query），其余写入，替换式跳转。
  return <>
    <StatusHead hint={t('triggerIntro')} />
    {/* 页头与说明文字。 */}
    <div className="dt-filters">
      {THREAD_FILTERS.map(value => <Pill key={value} active={filter === value}
        onClick={() => go(value)}>{t(`threadFilter.${value}`)}</Pill>)}
      {/* 渲染全部筛选按钮，当前项高亮。 */}
    </div>
    <LoadState error={error} loading={!data} />
    {/* 错误或首次加载的占位状态。 */}
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(thread => <ThreadLine key={thread.key} thread={thread} />)}</ul>
      : <Hint>{t('threadsNone')}</Hint>)}
    {/* 有数据时渲染线程列表，列表为空时显示空提示。 */}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
    {/* 还有下一页时显示“加载更多”（通过增大 limit 实现）。 */}
  </>
}
