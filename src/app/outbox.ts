/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
// 可靠的出站消息投递（Outbox）：以持久化回执（receipt）为底座，并借助可重试的 reply 效果完成重试。
// 核心端口类型：OutboundMessage 出站消息、Outbox 端口（重命名为 OutboxPort）、ReplyStatus 回执状态
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
// Commands：命令执行器类型
import type { Commands } from '../infra/commands.ts'
// checkedImText：校验飞书 IM 回复文本长度是否合规
import { checkedImText } from '../infra/text.ts'
// SourceRegistry：数据源注册表（提供实例状态、渠道许可与发送能力）
import type { SourceRegistry } from '../sources/registry.ts'
// FAILURES_BEFORE_ERROR：失败阈值；Later：稍后再试信号；Effects：效果队列类型
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
// Store：持久化存储类型
import type { Store } from './store.ts'

// OutboxHost：Outbox 所需的最小宿主依赖（存储、效果队列的四个方法、数据源子集、命令执行器、暂停开关）
export interface OutboxHost {
  // 存储：需要原子事务与回执表
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  // 效果队列：需要入队、取消、注册处理器与等待空闲
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  // 数据源：实例查询、渠道许可检查与发送
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  // 命令执行器
  readonly commands: Commands
  // 处理是否暂停中（暂停时 reply 效果的并发上限归 0）
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
// Outbox：把出站渠道消息持久化为回执，并经 Effects 与 SourceRegistry 顺序投递。
// 为 Engine 与 source contexts 实现核心 Outbox 端口，保证每个工单内按会话有序投递（除非更早的消息反复失败）。
// 处理暂停或数据源不可用时消息等待；目标会话被忽略或已消失时以 dropped 结案。
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    // 注册 reply 效果处理器：暂停时并发 0（挂起），否则 1（串行以保证会话内顺序）；重试退避 5s→300s
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  // 记录消息回执并在同一事务内入队其投递效果；重复的消息 ID 会被忽略（幂等）
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    // 在此校验飞书 IM 回复文本长度；确认类（ack）消息在决策时已校验过
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    // 取宿主依赖
    const { store, effects } = this.host
    // 原子事务：新增回执成功（非重复）才入队对应的 reply 效果
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  // 查询某消息的回执状态（未记录时返回 undefined）
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  // 撤回消息：在事务里作废回执，并取消其排队中的投递效果
  withdraw(id: string): void {
    const { store, effects } = this.host
    // 事务：回执撤回成功才取消效果（撤回失败说明已投出，不可再取消）
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  // 等待全部 reply 效果投递完毕（供优雅停机或测试使用）
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  // deliver：单条消息的投递逻辑（由 reply 效果驱动，可被重试）
  private async deliver(id: string): Promise<void> {
    // 取依赖与回执
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    // 回执不存在或已不是 pending（已投出/已作废/已结案）：无事可做
    if (receipt?.status !== 'pending') return
    // 数据源已关闭或未安装：抛 Later 稍后再试（不累计失败次数）
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    // 会话内顺序保证：同工单同会话中更早的消息仍在 pending 时，本消息一律延后，直到前者超过失败阈值（避免乱序投递）
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    // 目标会话/渠道已被忽略（如已退订）：回执结案为 channelIgnored，不再重试
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    // 经数据源真正发送；返回 waiting 表示数据源尚未安装，抛 Later 稍后再试
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    // 结案：目标永久不可达（如消息被撤回、Issue 被删除）记为 channelGone，否则记为 sent——回执状态本身防止后续重试
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
