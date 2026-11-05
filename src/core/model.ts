/** Domain model of a proactive agent: the concepts and their invariants, independent of any source, policy, or executor. */
// 领域模型（domain model）：这里定义 proactive agent（主动式 agent）的核心概念与不变量，
// 不依赖任何具体 Source（消息来源，如 GitHub / 飞书）、Policy（授权策略）或 Executor（执行器）。
// 术语约定（首次出现处给出中文解释）：
// - Trigger：来源产生的一条不可变事件（如一条评论），是 agent 被触发工作的最小单位；
// - Thread：一条会话线程（如一个 Issue、一个 PR、一个飞书话题），Trigger 挂在线程上；
// - Eval：对一个 Thread 上排队的 Trigger 的一次批量评估过程；
// - Decision：评估的结论（accept / ignore / stop / unavailable 等）；
// - Mandate：accept 决定产生的不可变授权，界定 agent 能做什么；
// - Ticket：一份被授权的工作事项（work item），agent 在自己的 Session 和目录里完成它；
// - Assignment：Ticket 与一次执行实例（worker Session）的绑定；
// - Session：DeepSeek Harness 里的 agent 会话，分主会话（Router / main Session）与 worker 会话。
import type { Reason } from './reasons.ts'

/** Actor identity in the source's own vocabulary; Policy decides which actors may originate work on that Source. */
// 行为者（actor）标识：source 与 id 都用来源自己的词汇表表示（如 GitHub 用户名）；
// 谁能发起工作由 Policy（授权策略）决定，这里只记录身份。
export interface ActorRef { source: string; id: string }
/** Thread identity; the rule that derives `id` from a native event belongs to the source. */
// Thread 标识：如何从来源的原生事件推导出 `id`（比如 GitHub issue 编号）是各 Source 自己的规则。
export interface ThreadRef { source: string; id: string }
/** Write-only address on a thread; the address format belongs to the source. */
// Channel：向某个 Thread 回写消息的"只写地址"，地址格式（发给谁、哪个话题）由 Source 自己定义。
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** Stable key of a thread across the whole domain. */
// Thread 的全局稳定键：`source:id` 形式的字符串，整个领域内唯一，用作存储键与索引。
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
/**
 * Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
 * values that do not parse as a timestamp are returned unchanged.
 */
// 时间戳规范化：统一转成 ISO 8601 格式（`Date#toISOString` 的输出），
// 这样在内存和 SQLite 中都可以直接按字符串字典序比较时间先后；
// 解析失败（不是合法时间戳）的值原样返回，不做修改。
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

/** One immutable event produced by a source. `text` and `meta` are untrusted external data. */
// Trigger：Source 产生的一条不可变事件。注意 `text` 与 `meta` 都是外部数据，不可信（不能当作授权依据）。
export interface Trigger {
  id: string
  source: string
  /** Every thread the trigger belongs to; the first (`threads[0]`) is the primary thread that hosts its evaluation. */
  // 该 Trigger 所属的所有 Thread；第一个（`threads[0]`）是主 Thread，负责承载对它的 Eval（评估）。
  threads: ThreadRef[]
  actor: ActorRef
  /** Source-declared: the event was written by a person rather than a bot, CI, or this agent. */
  // Source 声明的事实：这条消息是真人写的（而不是 bot、CI 或 agent 自己发的）。
  human: boolean
  /** Source-declared: the sender addressed the agent, by mentioning it or in a direct message to it. */
  // Source 声明的事实：发送方是否"点名"了 agent（@提及或在私信里）。
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** Source-native details for adapters; the core never interprets them. */
  // Source 原生的附加信息，仅供适配器（adapter）使用；core（领域核心）从不解读它们。
  meta: Record<string, unknown>
}

/** Where a trigger went after intake; it grants nothing, but decides who decides a person's follow-up (see `followupOwners`). */
// TriggerDisposition：Trigger 被接收（intake）之后的去向记录。
// 它本身不授予任何权限，但决定"某人后续追问时该由哪个 ticket 的 worker 决定"（见 `followupOwners`）。
export interface TriggerDisposition {
  /** Rejected by the source scope filter before entering the domain, for the Source's reason. */
  // `filtered`：在进入领域之前就被 Source 的 scope（监听范围）过滤器拒绝，记录 Source 给出的原因代码。
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /**
   * The tickets it reached, by subscription fan-out or attached by the main Session; a ticket that ended or could not resume
   * without its worker taking it up no longer counts.
   */
  // `fanout`：它实际到达的 Ticket 列表——通过订阅扇出（fan-out）或主会话手工附加（attach）；
  // 如果 Ticket 已结束、或未能恢复且 worker 没有接手，就不再计入。
  fanout: string[]
  /** The tickets of `fanout` it reached only on a Thread their Executor follows for context, which makes it none of theirs. */
  // `context`：`fanout` 中只是"顺带看到"的 Ticket——它们仅在 Executor 为获取上下文而关注的 Thread 上收到它，
  // 因此这条消息不算它们的活儿。
  context?: string[]
  /** A person, or the main Session for a message no ticket decides, sent it to Eval again; a hand-back does not set it. */
  // `requeued`：有人（或主会话，对没有 ticket 决定的消息）把它重新送去 Eval；worker 退回（hand-back）不设置这个标记。
  requeued?: true
  /** The tickets whose Executor handed it back as beyond the ticket, each once, with why; it goes to Eval once none decides it. */
  // `handbacks`：哪些 Ticket 的 Executor 认为它超出该 Ticket 范围而退回（每个 Ticket 至多一次），并记录原因；
  // 当没有任何 Ticket 再决定它时，它会被送去 Eval 重新评估。
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** The tickets whose Executor acknowledged it or answered it, taking it up as within the ticket. */
  // `acked`：哪些 Ticket 的 Executor 确认（ack）过它或回答过它——即把这条消息"接下"当作本 Ticket 范围内的事。
  acked?: string[]
  at: string
}
/** What deciding a follow-up's owners reads: the stored tickets, Threads and dispositions, as the Store and the core keep them. */
// 判定"后续追问归谁管"所需读取的记录：已存储的 Ticket、Thread 与 disposition，
// 接口保持最小化，以便内存实现（MemoryRepositories）和 SQLite 实现都能提供。
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { disposition(id: string): TriggerDisposition | undefined }
}
/**
 * The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
 * and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
 * while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
 * an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
 * main Session may only stop the work on it.
 */
// followupOwners：计算"某人的追问消息由哪些 Ticket 的 worker 决定"。
// 规则：消息到达了这些 Ticket 自己的 Thread、它们仍有权决定且没有退回。
// 具体来说：Ticket 存活时可决定；即使有人取消了该 Thread 的订阅也可决定；
// Ticket 已结束但不是被人停止、且该 Trigger 正等着恢复它时也可决定。
// 一旦有人把它重新送去 Eval、或某个 Eval 正持有它（旧版本可能排过队），就没有 owner。
// 有 owner 期间，这条消息不再进 Eval，主会话（main Session）只能停止相关工作，不能另行处置。
export function followupOwners(trigger: Pick<Trigger, 'id' | 'human' | 'threads'>, records: FollowupRecords): string[] {
  // 只有真人写的消息才有"追问"一说，bot/CI 的消息不适用。
  if (!trigger.human) return []
  const disposition = records.triggers.disposition(trigger.id)
  // 没有 disposition（从未被接收），或已被人工重排到 Eval，则没有 owner。
  if (!disposition || disposition.requeued) return []
  // The disposition alone rules most messages out, so a Thread or a ticket is read only for one that may have an owner.
  // disposition 本身已能排除大多数消息；只有可能存在 owner 时才去读 Thread 和 Ticket（减少存储访问）。
  const returned = new Set(disposition.handbacks?.map(item => item.ticketId))
  // 到达的 Ticket = fanout 中排除已退回的、排除仅为 context（顺带看到）的。
  const reached = disposition.fanout.filter(id => !returned.has(id) && !disposition.context?.includes(id))
  // 若没人到达，或主 Thread 上有 Eval 正持有该 Trigger，则没有 owner。
  if (!reached.length || records.threads.get(threadKey(trigger.threads[0]!))?.evaluating?.triggerIds.includes(trigger.id)) return []
  return reached.filter(id => {
    const ticket = records.tickets.get(id)
    // Ticket 存活；或已结束但不是被人停止、且该 Trigger 的 Input 还在等投递（即等待恢复它）——都算 owner。
    return !!ticket && (liveTicket(ticket) || (ticket.ended?.by !== 'human'
      && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id && ticket.undelivered.includes(input.id))))
  })
}
/**
 * Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
 * work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
 */
// settled：判断一个 Decision 是否真正"了结"了消息的诉求。
// stop（无论执行还是拒绝）只了结那个 Ticket 的工作；路由（routed）交给 ticket 的 worker 决定；
// unavailable（评估不可用）什么也没决定——这些都不算 settled。
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean => !['stop', 'unavailable'].includes(decision.kind)
  && !decision.reason.some(reason => ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code))

export type Strength = 'explicit' | 'inferred'
/** The cells of a receiving scope's row in the admission table, by whether the sender is listed and addresses the agent. */
// AdmissionCell：接收范围（receiving scope）在"准入表"（admission table）中的格子，
// 按发送者是否在允许名单、是否点名 agent 划分（名单内必点名，所以只有三个格子）。
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/**
 * Whether proactive candidates are assessed and accepted (`auto`), still assessed so Decisions record what they would accept
 * (`would_accept`) without accepting (`observe`), or not admitted (`off`).
 */
// AcceptMode：主动式候选（没人明确要求、由规则推断出的工作）的处理模式——
// `auto` 评估并接受；`observe` 只评估并记录"本来会接受什么"，不真正接受；`off` 完全不受理。
export type AcceptMode = 'off' | 'observe' | 'auto'
/** Where a Mandate's Trigger was received: its Source, its receiving scope as the Source recorded it, and its admission row. */
// Received：Mandate 的 Trigger 当初被接收的位置——哪个 Source、Source 记录的接收范围、命中的准入表行。
interface Received { source?: string; scope?: Record<string, unknown>; row?: string }
/**
 * How the gate admitted the Trigger a Mandate came from, which `revalidate` re-checks (see `docs/002`):
 * - `addressed`: a sender on the Source's list addressed the agent;
 * - `followup`: a message on a Thread that has tickets;
 * - `admission`: the cell of the receiving scope's admission row; `observation` when it made an inferred candidate under
 *   an accept mode;
 * - `listed`: accepted before Mandates recorded their basis, from a sender who must still be on the list; `authority` is
 *   what an earlier version recorded instead.
 * `sender` names the allowed sender at acceptance time, and `rules` the rules an assessment matched.
 */
// MandateBasis：门（gate）当初凭什么放行了产生 Mandate 的 Trigger，供 `revalidate` 复核（详见 docs/002 授权文档）：
// - `addressed`：名单上的发送者点名了 agent；
// - `followup`：消息出现在已有 Ticket 的 Thread 上（追问场景）；
// - `admission`：命中接收范围的准入表格子；若因此产生了 inferred 候选，附带 `observation`（当时模式）；
// - `listed`：在 Mandate 记录 basis 之前的旧数据，发送者必须仍在名单上；`authority` 是更早版本的记录方式；
// - `bot`：名单上 bot 发的消息——至多只能产生 inferred 候选，绝不构成明确请求或停止指令。
// `sender` 记录接受时的允许发送者，`rules` 记录评估匹配到的规则。
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
  | { via: 'addressed'; addressed: 'mention' | 'direct' }
  | { via: 'followup'; authority?: string }
  | { via: 'admission'; cell: AdmissionCell; addressed?: 'mention' | 'direct'; observation?: { mode: AcceptMode } }
  | { via: 'listed'; addressed?: 'mention' | 'direct'; observation?: { mode?: AcceptMode }; authority?: string }
  /** A message of a bot on its Source's bot list: an inferred candidate at most, never an explicit request or a stop. */
  // 名单上 bot 的消息：至多是 inferred 候选，永远不能算明确请求或停止指令。
  | { via: 'bot'; addressed?: 'mention' | 'direct'; observation: { mode: AcceptMode } }
)

/** Immutable authorization produced by an accept decision; execution is bounded by it and it never changes. */
// Mandate：accept 决定产生的不可变授权；后续所有执行都以此为界，且永不修改。
// （恢复 Ticket 时会用 Policy 重新复核它是否仍然成立，即 revalidate。）
export interface Mandate {
  strength: Strength
  policyVersion: string
  /** How the gate admitted it, for re-validation and audit. */
  // 门当初怎么放行的，用于复核（revalidation）与审计。
  basis: MandateBasis
  actor: ActorRef
  scope: string
}

/** Active trigger evaluation on a thread; at most one exists per thread. */
// Evaluation：一个 Thread 上进行中的 Trigger 评估；每个 Thread 同时至多一个。
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** The admissible Trigger that gave the batch its strength, which a ticket the Eval starts takes as its origin. */
  // 批次中"可准入"的最强 Trigger，它决定了整批的强度；Eval 由此创建的 Ticket 以它为 origin（源头）。
  primary?: string
  strength: Strength
  /** Actor and gate basis of the strongest admissible trigger; they seed the mandate on accept. */
  // 最强可准入 Trigger 的行为者与门依据；accept 时它们被继承为 Mandate 的种子。
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  /** Timestamp when the candidate reached the assessor's Session; it cannot expire before, and its deadline counts from then. */
  // 候选送达评估者 Session 的时间；在此之前 Eval 不会过期，超时也以此为起点计算。
  delivered?: string
  /** Expiration timestamp, counted from delivery (or from start until delivered); a processing pause shifts it forward by the pause duration. */
  // 过期时间：从送达起算（未送达前从 start 起算）；处理暂停（pause）时顺延暂停时长。
  deadline: string
  /** Timestamp when processing pause began; resuming shifts `deadline` forward by the pause duration; cleared on resume. */
  // 暂停开始的时间；恢复时按暂停时长顺延 `deadline`，随后清空。
  pausedAt?: string
}

/** Thread aggregate: consistency boundary of eval, holder of subscriptions and decision history. */
// Thread 聚合根：Eval 的一致性边界，同时持有订阅关系（subscriptions）与决策历史。
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  /** Time of the newest trigger on the thread. */
  // 线程上最新一条 Trigger 的时间。
  lastAt?: string
  /** Tickets subscribed to this thread; live ones receive every trigger as context through fan-out. */
  // 订阅了本 Thread 的 Ticket 列表；存活的 Ticket 会通过扇出（fan-out）收到每条 Trigger。
  subscriptions: string[]
  /**
   * The subscribed tickets whose Executor follows the thread for read-only context, such as an Issue or another pull request
   * it found: its messages reach them, but grant nothing, and a person's message there resumes none of them that ended.
   */
  // 仅"为看上下文"订阅本 Thread 的 Ticket：比如 worker 发现相关的 Issue 或另一个 PR。
  // 它们能收到消息，但这些消息不授予任何权限，也不会恢复已结束的 Ticket。
  context?: string[]
  /** Keys of threads that shared a trigger with this one; context only. */
  // 与本 Thread 共享过 Trigger 的其他 Thread 的 key，仅作上下文关联用。
  correlated: string[]
  /** Triggers waiting for the next eval (debounce buffer). */
  // 等待下一次 Eval 的 Trigger 队列（防抖缓冲：把短时间内的多条消息合并成一次评估）。
  pending: string[]
  evaluating?: Evaluation
  /** How many Evals of its queued Triggers expired in a row, each of which queued them again; a Decision clears it. */
  // 本 Thread 的 Eval 连续过期次数（每次过期都把 Trigger 重新排队）；产生 Decision 后清零。
  expired?: number
  /**
   * Source-native attributes needed by channels or readers (for example a Feishu thread id). Its Source may also describe
   * the thread for people: `label`, a display name, and `facts`, a {@link ThreadFacts} map.
   */
  // Source 原生属性，供回写通道或读取器使用（如飞书的话题 id）。
  // Source 还可以在此为人提供描述：`label`（显示名）与 `facts`（{@link ThreadFacts} 事实表）。
  meta: Record<string, unknown>
}
/** Text in both interface languages, or the same text in both. */
// Text：双语界面的文本——要么中英各一份，要么两种语言共用同一句。
export type Text = string | { zh: string; en: string }
/** One fact a Source states about its thread, such as an issue number or a CI result; `problem` marks one that needs a person. */
// ThreadFact：Source 对其 Thread 的一条事实陈述（如 Issue 编号、CI 结果）；`problem` 标记需要人来处理的事实。
export interface ThreadFact { label?: Text; value: Text; problem?: true }
/** A thread's facts by id, ordered for display; each writer owns its fact ids. */
// ThreadFacts：Thread 的事实表，按 id 组织、按展示顺序排列；每个写入方拥有自己的 fact id 命名空间。
export type ThreadFacts = Record<string, ThreadFact>

export type DecisionKind = 'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable'
/** Outcome of one eval, recorded on the thread. */
// Decision：一次 Eval 的结论，记录在 Thread 上。
// kind：ignore（不理会）/ accept（接受并开工）/ reopen（重开，旧概念）/ stop（停止某 Ticket）/ unavailable（评估不可用）。
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  /** Why, by code: one reason, or one for each Trigger of the batch it concerns. */
  // 原因（按代码）：一条；或批次里的每个 Trigger 各一条（用 triggerId 区分）。
  reason: Reason[]
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  /** Assessor-supplied audit data (rule assessments, direction, evidence). */
  // 评估者提供的审计数据（各规则的评估结论、方向判断、证据）。
  audit?: Record<string, unknown>
  /** A person dismissed the problem an unavailable Decision shows. */
  // 有人已把 unavailable Decision 的问题从总览（overview）中处理掉（dismiss）。
  dismissed?: true
}

export type AssignmentState = 'pending' | 'running' | 'ended'
/**
 * What an Assignment reports: work is in progress (`progress`), its worker waits for a Trigger (`waiting`), a result is
 * ready (`ready`), a person must act to unblock or recover it (`blocked` or `failed`), or nothing is left to do (`dropped`).
 */
// ReportState：Assignment 的状态报告——
// progress（进行中）/ waiting（等新输入）/ ready（有结果了）/ blocked、failed（需要人来解阻或恢复）/ dropped（无事可做）。
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** Binding between a ticket and one executor instance. */
// Assignment：Ticket 与一个执行实例（worker Session 的一次运行）的绑定。
export interface Assignment {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state: ReportState; summary: string; at: string }
  /** When Inputs last reached the worker; one at or after `report.at` means the worker has been busy with Inputs since that report. */
  // Inputs 最近一次到达 worker 的时间；若 ≥ `report.at`，说明该报告之后 worker 又收到了新输入（忙过）。
  deliveredAt?: string
  /**
   * When a turn of its worker last ended with nothing left to run for it and nothing waiting for it: what its Session took
   * into a step before, the worker read.
   */
  // worker 最近一次"彻底空闲"（后台无事、无待处理输入）的回合结束时间；
  // 在此之前 Session 已将其纳入步骤（step）的消息，worker 都算读过了。
  idleAt?: string
}

export type TicketInput =
  /** A Trigger on one of its Threads, or attached to it; `human` when a person wrote it. */
  // trigger 输入：本 Ticket 的某个 Thread 上的 Trigger，或被主会话附加（attach）过来的；
  // `human` 表示是真人写的。
  | { id: string; kind: 'trigger'; triggerId: string; at: string; note?: string; human?: true
    /** It reached the ticket only on a Thread its Executor follows for context. */
    // 它只是在"上下文 Thread"上顺带到达的，不是本 Ticket 的活儿。
    context?: true
    /**
     * When the worker's Session took the message that carried it into a step, from which its model reads it; `null` while
     * it waits in the Session. One delivered before reads were recorded has none, and counts as read from `deliveredAt`.
     */
    // worker 的 Session 把携带它的消息纳入步骤（step）的时间——此后模型才能读到；`null` 表示还在 Session 收件箱里。
    // 在开始记录读取时间之前投递的旧 Input 没有此字段，按 `deliveredAt` 视为已读。
    readAt?: string | null
    /** The Assignment it was last delivered to. */
    // 它最近一次投递给的 Assignment。
    deliveredTo?: string
    /** When an earlier version handed it to the worker. */
    // 旧版本代码把它交给 worker 的时间。
    deliveredAt?: string }
  /** The Policy changed in a way that bears on the ticket, as `effect` says; Inputs written before effects have none. */
  // policy-changed 输入：Policy 发生了影响本 Ticket 的变化（详见 `effect`）；早于该机制的历史输入没有此类型。
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect?: PolicyEffect }
  /** A Decision reopened the ticket; written before ended tickets resumed on their own. */
  // reopen 输入：某个 Decision 重开了 Ticket；这是"Ticket 自动恢复"机制出现之前的旧类型，仅作历史保留。
  | { id: string; kind: 'reopen'; decisionId: string; at: string }
  /** A human's message on one of its Threads resumed the ended ticket under its unchanged Mandate. */
  // resumed 输入：真人消息把已结束的 Ticket 在原 Mandate 不变的情况下重新拉起来。
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'text'; text: string; at: string }
  /** A fact the main Session gave the ticket from other work: context, which asks for nothing and grants nothing. */
  // note 输入：主会话从别的工作中转来的事实，仅作上下文——不要求做什么，也不授予任何权限。
  | { id: string; kind: 'note'; text: string; at: string }

/**
 * How a Policy change bears on a ticket: the rules it was accepted under that changed, with their instruction now, or no
 * longer apply; `proactive: false` once inferred work is no longer accepted, as when the accept mode leaves `auto`; and
 * `requesterAllowed: false` once the sender it is for, `requester`, a person or a bot, may no longer start work there.
 */
// PolicyEffect：一次 Policy 变更对本 Ticket 的具体影响——
// `rules`：接受时所依据的规则哪些变了、哪些失效（附现在的指令文本）；
// `proactive: false`：不再接受 inferred 工作（如 accept 模式离开了 `auto`）；
// `requesterAllowed: false`：本 Ticket 对应的发送者（`requester`，人或 bot）已不能在这里发起工作了。
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
  requester?: ActorRef
}

export type TicketEndBy = 'executor' | 'human'
/** How a ticket ended: with its result, with its pull request merged or closed unmerged, with nothing to do, or stopped by a person. */
// TicketOutcome：Ticket 的结束方式——交付完成（completed）/ 对应 PR 被合并（merged）或关闭未合并（closed）/
// 无事可做（dropped）/ 被人停止（stopped）。
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/** A question for a person; `triggerId` is the human message that raised it, whose conversation it goes back to. */
// Attention：待人回答的问题；`triggerId` 是引发该问题的真人消息，回答会送回那条消息所在的会话。
export interface Attention { id: string; question: string; triggerId?: string }
/** Ticket aggregate: an authorized work item with its assignments, channels, thread bindings, and inputs. */
// Ticket 聚合根：一份被授权的工作事项（work item），连同它的执行记录、回写通道、Thread 绑定与输入。
export interface Ticket {
  id: string
  title: string
  decisionId: string
  mandate: Mandate
  /** The Channels of the messages it was accepted from, which its replies go to. */
  // 接受它的那些消息的 Channel；它的回复（结果、答复）发往这里。
  channels: ChannelRef[]
  /** When, by whom, and how the ticket ended, with a person's or the host's reason beyond the outcome; an open ticket has none. */
  // 结束记录：何时、由谁（executor/human）、以何种结果结束，可附人或宿主给出的原因；存活的 Ticket 没有此字段。
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  /** Open question for a person; cleared by the executor or when the ticket ends. */
  // 当前待人回答的问题；由 Executor（报告进展时）或 Ticket 结束时清除。
  attention?: Attention
  assignments: Assignment[]
  inputs: TicketInput[]
  /** Inputs not yet handed to a running assignment. */
  // 还没送达运行中 Assignment 的 Input id 列表。
  undelivered: string[]
  /**
   * Threads a Source made the ticket follow, such as its pull requests': a `ready` report ends the ticket only once
   * `followsDone` holds; the close that makes it hold ends the ticket with that outcome unless its work has not finished (see
   * `Tickets.unfinished`), and then its next `ready` or `dropped` report ends it.
   */
  // Ticket 被要求跟随的 Thread（比如它自己开的 PR）：
  // `ready` 报告只有在 `followsDone` 成立（自己开的 Thread 都已关闭）时才结束 Ticket；
  // 若是 Thread 关闭本身使条件成立，则按该关闭结果结束，除非工作尚未收尾（见 `Tickets.unfinished`）——
  // 那样就等下一条 `ready` 或 `dropped` 报告再结束。
  follows?: Follow[]
  /** People's questions the worker answered, whose answers the main Session may send. */
  // worker 已给出答案的真人问题列表；主会话据此可以把答案发出去（发送即从列表移除）。
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** The Triggers it was accepted from: the one that started it, and the batch its Eval held. */
  // 接受它的 Trigger：`triggerId` 是直接发起它的那条，`triggerIds` 是其 Eval 批次的全部。
  origin: { triggerId: string; triggerIds: string[] }
  /** What its Executor chose: its short name, directory and assignment text. */
  // Executor 为它选定的执行信息：短名称、工作目录、任务说明文本。
  execution?: Execution
  /** The latest failed delivery of an Input to its worker, until a delivery succeeds. */
  // 最近一次向 worker 投递 Input 失败的记录，直到某次投递成功才清除。
  delivery?: { error: string; at: string }
}
/**
 * A Thread a ticket follows, by its key: `own` when the ticket opened it, such as its own pull request, and when and how it
 * closed. `followsDone` holds once no Thread of its own is open, or, when the ticket has no `own` Thread, once every followed
 * Thread closed; the ticket then ends unless its work has not finished (see `Tickets.unfinished`).
 */
// Follow：Ticket 跟随的一个 Thread（按 key 记录）。
// `own` 表示这个 Thread 是 Ticket 自己开的（比如它提交的 PR）；`closed` 记录它何时、以何种结果关闭。
// `followsDone`：自己开的 Thread 都关了（没有 own 的则所有跟随的都关了）时成立，
// 此时 Ticket 才会结束——除非工作还没收尾（见 `Tickets.unfinished`）。
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }
// Execution：Executor 为 Ticket 选定的执行信息（worktree 短名 / 工作目录 / 任务说明）。
export interface Execution { name: string; directory: string; assignment: string }

/** Whether a ticket is open: it has not ended. */
// liveTicket：Ticket 是否仍存活（未结束）。
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
/** How a ticket ended. */
// ticketOutcome：Ticket 的结束结果；存活则无。
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined => ticket.ended?.outcome
// runningAssignment：当前处于 running 状态的 Assignment（每个 Ticket 至多一个）。
export const runningAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.find(assignment => assignment.state === 'running')
/**
 * Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
 * to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
 */
// reached：判断某个 Trigger 是否"到达过"某 Ticket——
// 三种情况：它是发起本 Ticket 的那条、作为 Input 进来过、或在其订阅的 Thread 上；
// `context=false` 时排除"仅为上下文"的 Thread（worker 可读但不可回写、不构成工作）。
export function reached(ticket: Ticket, trigger: Trigger, thread: (key: string) => Thread | undefined, context = true): boolean {
  if (ticket.origin.triggerId === trigger.id) return true
  const input = ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === trigger.id)
  return trigger.threads.some(ref => {
    const current = thread(threadKey(ref))
    return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id))
  }) || (input && (context || !trigger.threads.every(ref => thread(threadKey(ref))?.context?.includes(ticket.id))))
}
// latestAssignment：最新一个 Assignment（数组的最后一个）。
export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.at(-1)
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
// latestReport：所有 Assignment 中最近的一条报告，即这个 Ticket "最后一次说了什么"。
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] => ticket.assignments.findLast(assignment => assignment.report)?.report
/**
 * Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
 * is false, or the end of its latest turn, whichever is later.
 */
// readUntil：worker"最后一次有机会读到输入"的时间点——
// 取最新报告的时间（`progress=false` 时跳过 progress 报告）与其最近一次彻底空闲（idleAt）的较晚者。
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = ticket.assignments.findLast(assignment => assignment.report && (progress || assignment.report.state !== 'progress'))?.report
  return [report?.at ?? '', ...ticket.assignments.map(assignment => assignment.idleAt ?? '')].reduce((a, b) => a > b ? a : b)
}
/**
 * Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
 * since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
 */
// waitsForPerson：Ticket 是否正等人处理——最新报告是 blocked/failed，且那之后没有任何真人消息到达。
// 之后若来了非该类的报告、真人消息、或人工重试（会开新 Assignment），状态即解除。
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at)
}
