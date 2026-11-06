/** Source message link resolution and candidate card assembly for the main Session. */
// 为主 Session（会话）解析"来源消息链接"（source link），并组装候选（Candidate）卡片。
// 核心域类型：候选、工单、触发器
import type { Candidate, Ticket, Trigger } from '../core/index.ts'
// Commands：命令执行器（提供 withSignal 附加取消信号）
import type { Commands } from '../infra/commands.ts'
// readFeishuLink：读取飞书消息的永久链接
import { readFeishuLink } from '../sources/feishu-read.ts'
// feishuRef：把触发器解析为飞书消息引用；feishuSettings：读取飞书相关设置
import { feishuRef, feishuSettings } from '../sources/feishu.ts'
// SourceRegistry：数据源（Source）注册表类型
import type { SourceRegistry } from '../sources/registry.ts'
// triggerMessage：把触发器渲染为 worker 输入格式的消息
import { triggerMessage } from '../executor/dsh.ts'
// 复用卡片层的投影工具
import { relatedTickets, ticketCard, triggerCard } from './cards.ts'
// Store：持久化存储类型（此处只取其部分视图）
import type { Store } from './store.ts'
// TextCache：链接解析结果的 LRU 缓存
import type { TextCache } from './cache.ts'

// LinkHost：链接解析所需的最小宿主依赖（存储的四个视图、链接缓存、命令执行器、数据源注册表、生命周期取消信号）
export interface LinkHost {
  // 存储：只需 settings、triggers、threads、tickets 四个部分
  readonly store: Pick<Store, 'settings' | 'triggers' | 'threads' | 'tickets'>
  // 飞书链接解析结果的缓存
  readonly links: TextCache
  // 命令执行器
  readonly commands: Commands
  // 数据源注册表
  readonly sources: SourceRegistry
  // 宿主生命周期取消信号（宿主关闭时中止未完成的解析）
  readonly lifetime: AbortSignal
}

/** Resolves and caches a trigger's external message URL, falling back to a readable resource path when lookup fails. */
// 解析并缓存触发器的外部消息 URL；查询失败时退化为可读资源路径（source_url_read）
export async function sourceLink(host: LinkHost, trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }> {
  // 触发器自带 URL 时直接使用，无需解析
  if (trigger.url) return { source_url: trigger.url }
  // 尝试把触发器解析为飞书消息引用（chatId + messageId）
  const ref = feishuRef(trigger)
  // 不是可解析的飞书消息：返回空对象（不提供来源链接）
  if (!ref) return {}
  // 以"会话 id:消息 id"作为缓存键
  const cacheKey = `${ref.chatId}:${ref.messageId}`
  // 先查缓存，命中直接返回，避免重复调用飞书接口
  const cached = host.links.get(cacheKey)
  if (cached) return { source_url: cached }
  // 声明解析结果 URL（在 try 中赋值）
  let url: string
  try {
    // 按设置构造独立的超时信号（linkTimeoutMs 毫秒）
    const timeout = AbortSignal.timeout(feishuSettings(host.sources).linkTimeoutMs)
    // 调用飞书读取器解析消息永久链接；取消信号取"调用方信号（缺省用宿主生命周期）与超时信号"的任意一个触发
    url = await readFeishuLink(host.commands.withSignal(AbortSignal.any([signal ?? host.lifetime, timeout])), ref)
  } catch {
    // 失败时先区分原因：若是宿主或调用方被取消，则照常抛出取消错误
    host.lifetime.throwIfAborted()
    signal?.throwIfAborted()
    // Optional link enrichment may fail independently of the retained source message.
    // 链接增强是可选能力，其失败不影响已保留的来源消息：退化为可读资源路径
    return { source_url_read: `feishu/${trigger.id}/message` }
  }
  // 解析成功则写入缓存，下次同一条消息直接复用
  host.links.set(cacheKey, url)
  // 返回解析出的外部链接
  return { source_url: url }
}

// repliedTo：若该触发器是对某条消息的回复，则找到它所回复的父触发器（可能不存在）
export function repliedTo({ store, sources }: { store: Pick<Store, 'triggers'>; sources: Pick<SourceRegistry, 'repliesTo'> },
  trigger: Trigger): Trigger | undefined {
  // 由数据源注册表计算"回复对象"对应的父触发器 id
  const parent = sources.repliesTo(trigger)
  // 无父触发器返回 undefined；否则从存储读取父触发器记录（可能已被清理）
  return parent === undefined ? undefined : store.triggers.get(parent)
}
/** Finds tickets subscribed to threads referenced in `trigger.text` (such as `#12` or URLs) that are not already in `known`. */
// 在触发器文本中寻找引用的线程（形如 `#12` 的编号或 URL），收集订阅这些线程、且不在已知列表（known）里的工单
function referencedTickets(host: LinkHost, trigger: Trigger, known: readonly Ticket[]): Ticket[] {
  // 用正则提取文本中的引用（#编号 或 http(s) 链接），逐个经数据源注册表解析出对应线程（可能一条都不剩）
  const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap(reference => host.sources.find(reference).threads)
  // 汇总这些线程订阅的全部工单 id（线程不存在时安全忽略）
  const ids = new Set(threads.flatMap(thread => host.store.threads.get(thread)?.subscriptions ?? []))
  // 去掉候选里已包含的工单（known 中已有的不再重复展示）
  for (const ticket of known) ids.delete(ticket.id)
  // 按剩余 id 读取工单记录（可能已被删除则跳过），最多返回 4 条，控制卡片体积
  return [...ids].flatMap(id => host.store.tickets.get(id) ?? []).slice(0, 4)
}
/** Builds the main Session's candidate card with routing metadata, handback history, and related or referenced tickets. */
// 组装主 Session 的候选卡片：路由元数据、worker 退回（handback）历史、相关与被引用工单一并呈现
export async function candidateCard(host: LinkHost, candidate: Candidate) {
  // 取批次中最后一个触发器作为主触发器（最新到达的那个）
  const primary = candidate.triggers.at(-1)!
  // 读取当前设置（用于展示评估模式）
  const settings = host.store.settings()
  // 查询主触发器的处置结果，得到已投递目标（fanout）；无记录时为空数组
  const delivered = host.store.triggers.disposition(primary.id)?.fanout ?? []
  // 收集主触发器文本中引用线程所关联的其他工单
  const referenced = referencedTickets(host, primary, candidate.tickets)
  // Triggers that a worker Session handed back as outside its ticket's scope, with the worker's reason.
  // 汇总批次内各触发器被 worker Session 以"超出工单范围"为由退回（handback）的记录，附 worker 给出的理由
  const handedBack = candidate.triggers.flatMap(trigger => (host.store.triggers.disposition(trigger.id)?.handbacks ?? [])
    .map(item => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })))
  // Format the primary trigger like a worker input (including the message it replies to) and summarize earlier batch triggers as cards.
  // 批次中除主触发器外的其余触发器，压缩成卡片数组（batch）
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  // 组装卡片：主触发器按 worker 输入格式渲染（含其回复的原消息与来源链接）、路由强度与评估模式、
  // 同批触发器卡片、退回记录、相关工单、已投递目标、被引用工单卡片；
  // 末尾 next_action 依路由强度给出下一步指引：explicit（显式路由）按 dispatch 说明用 orchestrator_route 处置
  // （接单/挂靠/停止/忽略）；否则先看卡片是否触及启用的规则，再走 orchestrator_eval 系列工具评估决策
  return { ...triggerMessage(primary, await sourceLink(host, primary), undefined, repliedTo(host, primary)), strength: candidate.strength,
    mode: settings.eval.mode, ...others.length ? { batch: others.map(trigger => triggerCard(trigger)) } : {},
    ...handedBack.length ? { handed_back: handedBack } : {}, ...relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}), ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
    next_action: candidate.strength === 'explicit' ? 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.'
      : 'Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.' }
}
