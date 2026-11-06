/** Source status view: health, 24-hour trigger counts, and recently filtered or dropped messages per Source instance. */
// 来源（Source）状态视图：每个实例的健康状况、24 小时触发器计数，以及最近被过滤或丢弃的消息。
import { threadKey } from '../../core/index.ts'
// 引入线程键工具：把线程引用规范成键。
import type { Deployment } from '../../deployment.ts'
// 引入部署事实类型。
import type { Health } from '../../sources/host.ts'
// 引入健康检查项类型。
import type { SourceInstance } from '../../sources/kind.ts'
// 引入来源实例类型。
import type { SourceRegistry } from '../../sources/registry.ts'
// 引入来源注册表类型。
import type { SetupProblem } from '../../setup.ts'
// 引入初始化问题类型。
import { dayAgo, snapshot, type ViewHost } from './records.ts'
// 引入共享视图工具：24 小时前时间戳、请求快照与视图宿主类型。
import { preview } from './text.ts'
// 引入文本预览工具。

// 健康项映射：检查项名称到健康状态。
export type HealthMap = Record<string, Health>
/** Resolves health entries for a Source instance, treating stale `sourceOff` entries on an enabled Source as `starting`. */
// 解析来源实例的健康条目：已启用来源上的过期 sourceOff（来源关闭）记录按"启动中"处理。
export function sourceHealth(sources: SourceRegistry, instance: SourceInstance, health: HealthMap) {
  // 取实例对应的来源类型定义。
  const kind = sources.kind(instance.kind)
  // 预置"启动中"健康项，用于缺失或过期条目的回退。
  const starting: Health = { state: 'starting', detail: '' }
  // 将类型声明的各健康检查项映射为实际状态。
  const parts = (kind?.health ?? []).map(name => {
    // 取该检查项的当前健康记录。
    const entry = health[name]
    // 条目缺失，或来源已启用但记录仍是关闭状态（过期），都视为"启动中"。
    return { name, ...(!entry || (instance.enabled && entry.code === 'sourceOff') ? starting : entry) }
  })
  // 返回实例健康视图：id、标题（无类型定义时回退为 id）与各检查项状态。
  return { id: instance.id, title: kind?.title ?? { zh: instance.id, en: instance.id }, health: parts }
}
// 初始化（setup）状态：部署事实、全局问题与飞书（Feishu）专属问题。
export interface SetupState {
  /** Resolved deployment facts; undefined while waiting for initial setup. */
  deployment?: Deployment | undefined
  /** Setup failure that stops all Sources. */
  problem?: SetupProblem | undefined
  /** Feishu bot check failure that pauses only the Feishu Source. */
  feishuProblem?: SetupProblem | undefined
}
// 在全局问题与飞书专属问题中，找出"发生位置"（place）等于指定来源 id 的问题。
export const problemOf = (id: string, setup: SetupState) => [setup.problem, setup.feishuProblem].find(problem => problem?.place === id)
/** Source lifecycle state in priority order: missing kind, disabled, setup/part error, blocked on global setup, starting, paused, or ready. */
// 来源生命周期状态（SourceState）：按优先级取第一个命中的状态。
export type SourceState = 'missing' | 'off' | 'error' | 'setup' | 'starting' | 'paused' | 'ready'
// 推断来源实例的生命周期状态：未安装 > 已禁用 > 出错 > 被全局初始化阻塞 > 启动中 > 暂停 > 就绪。
function sourceState(instance: SourceInstance & { installed: boolean }, parts: { state: string }[], setup: SetupState): SourceState {
  // 尚未安装为 missing（缺失）。
  if (!instance.installed) return 'missing'
  // 已禁用为 off（关闭）。
  if (!instance.enabled) return 'off'
  // 有初始化问题或任一健康检查项报错为 error。
  if (problemOf(instance.id, setup) || parts.some(part => part.state === 'error')) return 'error'
  // 全局初始化未完成（有全局问题）则为 setup（被阻塞）。
  if (setup.problem) return 'setup'
  // 任一检查项仍在启动则为 starting。
  if (parts.some(part => part.state === 'starting')) return 'starting'
  // 有暂停的检查项为 paused，否则为 ready（就绪）。
  return parts.some(part => part.state === 'paused') ? 'paused' : 'ready'
}
// 组装所有来源实例的状态视图：健康、24 小时统计、最近被过滤与被丢弃的消息。
export function sourcesStatus(host: ViewHost, health: HealthMap, setup: SetupState) {
  // 解构出存储与来源注册表。
  const { store, sources } = host
  // 构建共享快照（含参与者名称解析）。
  const view = snapshot(host)
  // 统计窗口起点：24 小时前。
  const since = dayAgo()
  // 取窗口内各来源的触发器统计（收到数、过滤数、最后时间）。
  const stats = store.read.triggerStats(since)
  // filtered：取指定来源最近被过滤（filtered）的触发器（最多读 5 条再按窗口过滤），映射为预览视图。
  const filtered = (source: string) => store.read.triggers({ source, filtered: true }, 0, 5).items.filter(trigger => trigger.at >= since)
    .map(trigger => ({ id: trigger.id, at: trigger.at, actor: view.actor(trigger.actor, trigger.human), preview: preview(trigger.text, 120),
      reason: store.triggers.disposition(trigger.id)?.filtered }))
  // 取最近 24 小时被丢弃（dropped）的回复列表。
  const dropped = droppedReplies(host)
  // 为每个来源实例生成状态视图。
  return sources.instances().map(instance => {
    // 拆出健康检查项与其余（id、标题）信息。
    const { health: parts, ...named } = sourceHealth(sources, instance, health)
    // 查询该实例的初始化问题。
    const problem = problemOf(instance.id, setup)
    // 组装实例状态：安装/启用标记、生命周期状态、健康项、问题、统计与明细列表（丢弃回复按来源过滤）。
    return { ...named, installed: instance.installed, enabled: instance.enabled, state: sourceState(instance, parts, setup), health: parts,
      ...problem ? { problem } : {}, stats: stats[instance.id] ?? { received: 0, filtered: 0, lastAt: '' }, filtered: filtered(instance.id),
      dropped: dropped.filter(item => item.channel.source === instance.id) }
  })
}
// 来源状态视图类型：由 sourcesStatus 返回数组的元素推导。
export type SourceStatusView = ReturnType<typeof sourcesStatus>[number]
/** Replies dropped in the last 24 hours, enriched with their associated ticket and thread. */
// 最近 24 小时被丢弃的回复，逐条补充其关联的工单与线程。
export function droppedReplies({ store, links }: Pick<ViewHost, 'store' | 'links'>) {
  // Fetch the exact 24-hour dropped count so this list's length matches the overview's `dropped` metric.
  // 先取精确的 24 小时丢弃计数，再按它取记录，使本列表长度与总览页的 dropped 指标一致。
  return store.read.droppedReplies(store.read.droppedSince(dayAgo())).map(item => {
    // 关联的工单（如有）。
    const ticket = item.ticketId ? store.tickets.get(item.ticketId) : undefined
    // 解析频道对应的触发器 id。
    const { triggerId } = links(item.channel)
    // 触发器所属的第一个线程作为"主线程"。
    const home = triggerId ? store.triggers.get(triggerId)?.threads[0] : undefined
    // 主线程键；没有则回退频道自带的线程（仍存在时才附上）。
    const thread = home ? threadKey(home) : store.threads.get(item.channel.thread) ? item.channel.thread : undefined
    // 组装丢弃回复视图：类型、频道、文本预览、丢弃时间与可选的工单/线程关联。
    return { id: item.id, kind: item.kind, channel: item.channel, preview: preview(item.text), dropped: item.dropped,
      ...ticket ? { ticket: { id: ticket.id, title: ticket.title } } : {}, ...thread ? { thread } : {} }
  })
}
