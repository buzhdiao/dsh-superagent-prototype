/** Overview view: active system problems, tickets awaiting human action, executor load, and 24-hour trigger flow. */
// 总览视图（Overview）：当前系统问题、等待人工处理的工单、执行器负载与 24 小时触发流。
// 核心域辅助：reasonText 原因码转文本、ticketStage 工单阶段；类型：Decision 决策、Thread 线程
import { reasonText, ticketStage, type Decision, type Thread } from '../../core/index.ts'
// Health：健康条目类型
import type { Health } from '../../sources/host.ts'
// SetupProblem：setup 问题类型
import type { SetupProblem } from '../../setup.ts'
// anyoneAllowed：判断是否"任何人都允许发起"（用于检查允许名单是否为空）
import { anyoneAllowed } from '../../policy.ts'
import type { Store } from '../store.ts'
// 记录视图辅助：awaitingEval 等待评估、dayAgo 一天前、newestFirst 最新优先排序、ownersOf 所有者、snapshot 快照、threadSummary 线程摘要
import { awaitingEval, dayAgo, newestFirst, ownersOf, snapshot, threadSummary, type ViewHost } from './records.ts'
// sourceHealth / HealthMap：数据源健康投影与健康映射
import { sourceHealth, type HealthMap } from './sources.ts'
// ticketRow / ExecutorLoad：工单行投影与执行器负载
import { ticketRow, type ExecutorLoad } from './tickets.ts'
// preview：文本预览
import { preview } from './text.ts'

/** Threads whose latest decision since `since` is an undismissed `unavailable` eval and that are neither evaluating nor queued. */
// 找出"最近一次决策是未驳回的 unavailable 评估"的线程：既不在评估中、也没有排队等待的评估
function unjudged(store: Store, since: string): { thread: Thread; decision: Decision }[] {
  // 已见线程键集合（每个线程只取最近一条）
  const seen = new Set<string>()
  // 评估查询所需的队列上下文
  const queue = { store, owners: ownersOf(store) }
  // 取最近 200 条 unavailable 决策，先过滤出 since 之后的
  return store.read.decisionsOfKinds(['unavailable'], 200).filter(decision => decision.at >= since).flatMap(decision => {
    // 该线程已有更新的记录：跳过
    if (seen.has(decision.threadKey)) return []
    seen.add(decision.threadKey)
    // 线程必须存在
    const thread = store.threads.get(decision.threadKey)
    // 正在评估、有排队评估、或决策已被驳回：不算"未判定"
    if (!thread || thread.evaluating || awaitingEval(queue, thread).length || decision.dismissed) return []
    // 该决策不是线程的最新决策（之后已有新判定）：跳过
    if (store.decisions.byThread(thread.key).at(-1)?.id !== decision.id) return []
    return [{ thread, decision }]
  })
}
/** Reports error health when any thread has an undismissed `unavailable` eval from the last hour without a newer decision or active eval. */
// evals 健康条目：过去一小时内存在"未驳回且无更新判定"的 unavailable 评估时报错
export function evalsHealth(store: Store, now = Date.now()): Health {
  // 一小时前的时间点
  const since = new Date(now - 3_600_000).toISOString()
  // 未判定的线程
  const open = unjudged(store, since)
  // 没有：健康就绪
  if (!open.length) return { state: 'ready', detail: 'No unavailable Eval in the last hour' }
  // 取最近的一条
  const latest = open[0]!.decision
  // 报错：数量 + 最近一条所在线程与原因
  return { state: 'error', at: latest.at, detail: `${open.length} Eval(s) unavailable in the last hour without a later judgement; `
    + `the latest on ${latest.threadKey}: ${reasonText(latest.reason)}` }
}
/**
 * Builds the operator overview: active system problems, tickets awaiting human action, executor load, and 24-hour trigger flow.
 * @param setup - Setup problem to surface first (where setup stopped, or a Source paused by setup).
 */
// 构建运维总览：当前系统问题、等待人工处理的工单、执行器负载与 24 小时触发流。
// setup 参数：要优先呈现的 setup 问题（setup 停在了哪里，或被 setup 暂停的数据源）。
export function overview(host: ViewHost, health: HealthMap, policyVersionValue: string, load: ExecutorLoad, setup?: SetupProblem) {
  const { store, sources } = host
  // 记录快照（供线程摘要等复用）
  const view = snapshot(host)
  // 当前设置
  const settings = store.settings()
  // 当前时间与 24 小时前
  const now = new Date().toISOString(), since = dayAgo()
  // 正在评估的线程
  const evaluating = store.threads.active().filter(thread => thread.evaluating)
  // 数据源实例
  const instances = sources.instances()
  // 运行中（启用且已安装）的数据源及其健康投影
  const running = instances.filter(instance => instance.enabled && instance.installed).map(instance => sourceHealth(sources, instance, health))
  // Exclude source-owned and policy-sync health entries so only core runtime errors surface as `runtime-error`.
  // 排除数据源自有与策略同步的健康条目：只有核心 runtime 错误才以 runtime-error 呈现
  const sourceParts = new Set(instances.flatMap(instance => sources.kind(instance.kind)?.health ?? []))
  // 问题清单：按优先级拼装各类问题
  const problems = [
    // setup 问题最优先
    ...(setup ? [{ kind: 'setup' as const, ...setup }] : []),
    // 没有任何运行中的数据源
    ...(running.length ? [] : [{ kind: 'no-source' as const }]),
    // Only allowed senders can originate work, so empty allowlists mean no request can ever become a ticket.
    // 只有允许名单内的人才能发起工作：名单为空意味着任何请求都不可能成为工单
    ...(anyoneAllowed(settings) ? [] : [{ kind: 'no-allowed' as const }]),
    // 各数据源健康中的错误项
    ...running.flatMap(source => source.health.filter(item => item.state === 'error').map(item => ({ kind: 'source-error' as const, source: { id: source.id, title: source.title, health: item } }))),
    // 执行器暂停
    ...(settings.paused ? [{ kind: 'executor-paused' as const }] : []),
    // Unavailable Evals behind the `evals` health entry are listed individually as `eval-unavailable` below.
    // 核心 runtime 错误（排除数据源自有、sync 前缀与 evals 条目——后者在下方单独列出）
    ...Object.entries(health).filter(([name, item]) => item.state === 'error' && !sourceParts.has(name) && !name.startsWith('sync:')
      && name !== 'evals')
      .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
    // 评估超期的线程（截止时间已过仍在评估）
    ...evaluating.filter(thread => thread.evaluating!.deadline < now)
      .map(thread => ({ kind: 'eval-overdue' as const, thread: threadSummary(view, thread) })),
    // 未判定的 unavailable 评估
    ...unjudged(store, since).map(({ thread, decision }) => ({ kind: 'eval-unavailable' as const, decisionId: decision.id,
      thread: threadSummary(view, thread), reason: decision.reason, triggerId: decision.triggerIds[0] ?? '' })),
    // 投递失败的出站消息
    ...store.read.failingReplies().map(item => ({ kind: 'outgoing' as const, outgoing: { id: item.id, channel: item.channel,
      text: preview(item.text),
      attempts: item.attempts, error: item.error } })),
  ]
  // 开放工单（最新优先）
  const open = store.tickets.open().sort(newestFirst)
  // 各数据源的触发统计
  const stats = Object.values(store.read.triggerStats(since))
  // 汇总 24 小时接收与过滤数
  const received = stats.reduce((sum, item) => sum + item.received, 0), filtered = stats.reduce((sum, item) => sum + item.filtered, 0)
  // 决策流统计
  const judgement = store.read.flow(since)
  // 返回总览：问题清单、等人工的工单、执行器、24 小时流、策略版本
  return {
    problems,
    // 等待人工处理的工单（阶段为 person）
    person: open.filter(ticket => ticketStage(ticket).stage === 'person').map(ticket => ticketRow(view, ticket)),
    // 执行器：当前负载 + worker 上限 + 空闲工单数
    executor: { ...load, maxWorkers: settings.executor.maxWorkers, idle: open.filter(ticket => ticketStage(ticket).stage === 'idle').length },
    // 24 小时触发流：接收/被过滤/进入流（差值）/已判定/已接单/评估中/放弃
    flow: { received, filtered, triggers: received - filtered, judged: judgement.judged, accepted: judgement.accepted,
      evaluating: evaluating.length, dropped: store.read.droppedSince(since) },
    policyVersion: policyVersionValue,
  }
}
// OverviewView：总览视图类型（由返回值推导）
export type OverviewView = ReturnType<typeof overview>
