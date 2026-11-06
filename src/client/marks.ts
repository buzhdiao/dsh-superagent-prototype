/** Pure mappers from domain states (Tickets, Threads, Sources, Decisions) to UI status indicators. */
// 纯映射层：把领域状态（工单、线程、来源、决策）映射为 UI 状态标识。
import type { DecisionRow, SourceStatusRow, ThreadRow, TicketStage, TicketSummary } from './api.ts'
// 引入视图行类型。
import type { DshSuperagentKey } from './locales.ts'
// 引入翻译 key 类型。
import { valueLabel, type T } from './text.ts'
// 引入取值标签与翻译类型。
import type { DotState, IconName, TagTone } from './controls.tsx'
// 引入圆点/图标/色调类型。

// 状态标识（Mark）：文案、色调、圆点状态与图标。
export interface Mark { label: string; tone: TagTone; dot: DotState; icon: IconName }

// 工单状态标识：按阶段给出文案与视觉标记。
export function ticketMark(t: T, ticket: TicketStage & Pick<TicketSummary, 'ended'>): Mark {
  // 按阶段分发。
  switch (ticket.stage) {
    // 已结束：显示结果标签，中性色。
    case 'ended': return { label: valueLabel(t, 'outcome', ticket.ended?.outcome), tone: 'neutral', dot: 'idle', icon: 'stop' }
    // 等待人处理：按具体动作选择图标与警示色。
    case 'person': {
      // 当前等待的动作。
      const action = ticket.action
      // 图标按动作选择：验收/失败/受阻/交付/提问。
      const icon: IconName = action === 'review' ? 'review' : action === 'failed' ? 'alert' : action === 'blocked' ? 'blocked'
        : action === 'delivery' ? 'inbox' : 'ask'
      // 失败为危险色与错误点，其余为警告色与警告点。
      return { label: t(`stage.${action}`), tone: action === 'failed' ? 'danger' : 'warning', dot: action === 'failed' ? 'error'
        : 'warning', icon }
    }
    // 执行中：排队为中性空闲，否则进行中。
    case 'working': return ticket.action === 'queued' ? { label: t('stage.queued'), tone: 'neutral', dot: 'idle', icon: 'queue' }
      : { label: t('stage.working'), tone: 'info', dot: 'ongoing', icon: 'running' }
    // 其余（idle）：等待新触发。
    default: return { label: t('stage.idle'), tone: 'neutral', dot: 'idle', icon: 'clock' }
  }
}
// 报告状态到圆点状态的映射：失败=错误，受阻/等待=警告，就绪=完成，其余=进行中。
export const reportDot = (report: string | undefined): DotState => report === 'failed' ? 'error'
  : report === 'blocked' || report === 'waiting' ? 'warning' : report === 'ready' ? 'done' : 'ongoing'

// 线程阶段标识表：各阶段对应的圆点、图标与文案 key。
const THREAD_MARKS: Record<ThreadRow['stage'], Omit<Mark, 'label' | 'tone'> & { label: DshSuperagentKey }> = {
  error: { dot: 'error', icon: 'alert', label: 'threadPollFailed' },
  evaluating: { dot: 'ongoing', icon: 'running', label: 'threadEvaluating' },
  queued: { dot: 'warning', icon: 'queue', label: 'threadQueued' },
  subscribed: { dot: 'done', icon: 'inbox', label: 'threadSubscribed' },
  dormant: { dot: 'idle', icon: 'clock', label: 'threadDormantShort' },
  unsubscribed: { dot: 'idle', icon: 'hash', label: 'threadUnsubscribed' },
}
// 线程状态标识：查表取标记，文案带排队计数参数。
export function threadMark(t: T, thread: Pick<ThreadRow, 'stage' | 'pending'>): Omit<Mark, 'tone'> {
  // 取该阶段的圆点/图标/文案 key。
  const { dot, icon, label } = THREAD_MARKS[thread.stage]
  // 生成带 count 参数的文案。
  return { dot, icon, label: t(label, { count: thread.pending }) }
}

// 来源状态标识表：各状态的圆点与文案 key。
const SOURCE_MARKS: Record<SourceStatusRow['state'], { dot: DotState; label: DshSuperagentKey }> = {
  missing: { dot: 'idle', label: 'sourceNotInstalled' }, off: { dot: 'idle', label: 'sourceOff' },
  error: { dot: 'error', label: 'sourceState.error' }, setup: { dot: 'idle', label: 'sourceState.setup' },
  starting: { dot: 'ongoing', label: 'sourceState.ongoing' }, paused: { dot: 'warning', label: 'sourceState.warning' },
  ready: { dot: 'done', label: 'sourceState.done' },
}
// 来源状态到圆点与文案的映射。
export const sourceMark = (t: T, state: SourceStatusRow['state']) => ({ dot: SOURCE_MARKS[state].dot, label: t(SOURCE_MARKS[state].label) })

// 决策结果类型。
type Outcome = DecisionRow['outcome']
// 决策结果标识表：各结果对应的圆点、图标与色调。
const DECISION_MARKS: Record<Outcome, Omit<Mark, 'label'>> = {
  accept: { dot: 'done', icon: 'decision', tone: 'success' }, reopen: { dot: 'done', icon: 'refresh', tone: 'success' },
  stop: { dot: 'idle', icon: 'stop', tone: 'danger' }, ignore: { dot: 'idle', icon: 'dismiss', tone: 'neutral' },
  unavailable: { dot: 'warning', icon: 'alert', tone: 'warning' }, wouldAccept: { dot: 'idle', icon: 'dismiss', tone: 'warning' },
}
/** Maps a Decision outcome to its visual mark, distinguishing `wouldAccept` (an ignore that observe mode would have accepted). */
// 决策结果标识：wouldAccept（观察模式下本会接单的忽略）使用专属文案。
export function decisionMark(t: T, outcome: Outcome): Mark {
  // 查表取标记；文案区分 wouldAccept 与普通决策结果。
  return { ...DECISION_MARKS[outcome], label: outcome === 'wouldAccept' ? t('wouldAccept') : valueLabel(t, 'decision', outcome) }
}
