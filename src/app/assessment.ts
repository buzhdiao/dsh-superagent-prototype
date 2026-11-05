/** Proactive candidate assessment for the main Session: relays candidate cards, serves bounded context reads, and records outcomes. */
// MasterAssessor：主会话（Router，main Session）对主动式候选（proactive candidate）的评估支撑——
// 转发候选卡片、提供有边界的上下文读取、把主会话的判断落成 AssessmentOutcome。
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { reasonText, threadKey, type Assessor, type AssessmentOutcome, type Candidate, type EngineForMainSession,
  type Trigger } from '../core/index.ts'
import { AdmissionDirectionSchema, RuleAssessmentSchema, assessmentOutcome, directionAllowed, type Settings } from '../policy.ts'
import { checkedImText } from '../infra/text.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import { admissionContext } from '../sources/admission-context.ts'
import { readRepositoryPath } from '../sources/github-read.ts'
import type { TriggerContext } from '../sources/kind.ts'
import { relatedTickets } from './cards.ts'
import { textPage } from './context.ts'
import { AcknowledgementSchema } from './tools/tool.ts'
import type { Effects } from './effects.ts'

/** Schema for a short lowercase kebab-case English ticket worktree name (1–4 words, at most 32 characters). */
// WorktreeNameSchema：Ticket 的 worktree 短名——1-4 个小写英文单词的 kebab-case，至多 32 字符。
// 中文标题要先译成英文；不允许中文、拼音或通用名。
export const WorktreeNameSchema = z.string().max(32).regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, 'Use 1–4 short English words in lowercase kebab-case, at most 32 characters').describe('Meaningful short English ticket name, e.g. fix-plan-color. Translate Chinese titles into English; no Chinese, pinyin or generic ticket names. 1–4 lowercase words in kebab-case, at most 32 characters.')
/** Schema for the main Session's proactive candidate assessment decision (`orchestrator_eval_decide`). */
// AssessmentSchema：主会话提交主动候选评估结论的 schema（orchestrator_eval_decide 工具的入参）——
// 要求：每条启用规则一条评估、必须有方向判断；accept 时还要求 worktree 短名。
export const AssessmentSchema = z.object({
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(RuleAssessmentSchema)
    // 每条规则的评估最多出现一次（rule_id 不得重复）。
    .refine(assessments => new Set(assessments.map(assessment => assessment.rule_id)).size === assessments.length,
      'Duplicate rule assessment IDs').describe('One per enabled rule.'),
  direction: AdmissionDirectionSchema.describe('Required for every decision.'),
  title: z.string().min(1).max(160),
  worktree_name: WorktreeNameSchema.optional(),
  scope: z.string().max(1500),
  // intent_evidence：接受时给出确立"三个事实"的原话引用（谁、在什么语境、要了什么）。
  intent_evidence: z.string().trim().min(1).max(700).nullish().describe('For acceptance: the quotes that establish the three facts.'),
  // acknowledgement：接受时的一句话确认（源语言），回复到触发消息处；除非匹配的规则要求沉默，否则必填。
  acknowledgement: AcknowledgementSchema.nullish().describe('For acceptance: one sentence in the source language, posted as a reply to the trigger; omit only when a matched rule asks for silence.'),
  reason: z.string().min(1).max(500),
}).strict().refine(value => value.decision !== 'accept' || !directionAllowed(value.direction) || !value.rule_assessments.some(rule => rule.matched)
  // accept 且方向允许且至少一条规则匹配 → 必须给出 worktree 名。
  || !!value.worktree_name, { message: 'Accepted work requires a short English worktree_name', path: ['worktree_name'] })

/** Character limits in the initial thread window: for the trigger itself, its two nearest neighbours, other window messages, and stub previews. */
// 初始 Thread 窗口的字数限制：Trigger 本体 / 邻近两条 / 窗口消息 / 未展开存根。
const TRIGGER_CHARS = 4000, NEAR_CHARS = 1200, WINDOW_CHARS = 400, STUB_CHARS = 50
// FINISHED：评估已结束（已决/超时/重启）后读取时的报错文案。
const FINISHED = 'This assessment has finished: it was decided, timed out or restarted'
// EXPLICIT：明确请求不走评估，要走路由（orchestrator_route）——提示语。
const EXPLICIT = 'This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore'
// AssessmentContext：admissionContext 的返回类型（初始 Thread 窗口）。
type AssessmentContext = Awaited<ReturnType<typeof admissionContext>>
// ReadCache：一个 Eval 的读取缓存——文本快照、图片引用、消息全文、合法分页游标。
type ReadCache = {
  snapshots: Map<string, string>; images: Map<string, { id: string; text: string }>; messages: Map<string, string>; cursors: Set<string>
}
/** Per-evaluation state kept while an Eval runs: served reads cache, loaded thread context (or error), and any in-flight initial load. */
// EvalReads：单个 Eval 期间的按需状态——读取缓存、已加载的 Thread 上下文（或其错误）、进行中的首次加载。
interface EvalReads { cache: ReadCache; context?: AssessmentContext; error?: string; loading?: Promise<void> }
/** Message returned when assessing a Trigger whose Source provides no thread context. */
// NO_CONTEXT：该 Source 不提供 Thread 上下文时的提示。
const NO_CONTEXT = 'This Source gives no Thread context; assess the Trigger\'s own text and the batch.'
/** Host dependencies used by `MasterAssessor`. */
// AssessorHost：MasterAssessor 依赖的宿主能力（窄接口）。
export interface AssessorHost {
  /** Active evaluations in `Engine` that the assessor reads and decides. */
  // engine：读取与决策进行中 Eval 的角色接口。
  readonly engine: Pick<EngineForMainSession, 'candidate' | 'candidateDelivered' | 'decide'>
  readonly commands: Commands
  readonly deployment: Deployment
  /** Durable effect queue through which candidate assessments are delivered. */
  // effects：候选评估经持久化效果队列投递（重启可恢复）。
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  settings(): Settings
  /** Whether processing is paused, which holds candidate deliveries. */
  // paused：处理暂停时，候选投递一律挂起。
  paused(): boolean
  /** Thread context reader for `trigger`'s Source, or `undefined` when the Source has none. */
  // threadContext：该 Trigger 所属 Source 的 Thread 读取器（没有则 undefined）。
  threadContext(trigger: Trigger): TriggerContext | undefined
  /** Delivers a candidate card to the main Session once per request ID, resolving after the Session receives it. */
  // deliver：把候选卡片送进主会话（按请求 id 幂等，送达后才 resolve）。
  deliver(requestId: string, text: string): Promise<void>
  // candidateCard：候选的卡片数据（触发卡片、关联 Ticket 等）。
  candidateCard(candidate: Candidate): Promise<Record<string, unknown>>
}

/** Schema for bounded context or repository read requests during an active evaluation (`orchestrator_eval_read`). */
// EvalReadSchema：评估期间的有界读取请求 schema（orchestrator_eval_read）。
// 支持读消息/根消息/父消息/Thread 分页/仓库文件/目录/图片。
export const EvalReadSchema = z.object({
  trigger_id: z.string().min(1).describe('Original candidate ID returned by orchestrator_eval; every reference is scoped to this trigger.'),
  resource: z.enum(['message', 'root', 'parent', 'thread', 'file', 'directory', 'image']),
  path: z.string().optional().describe('Repository-relative path, only for file/directory.'),
  message_id: z.string().optional().describe('Only for message: omit for the trigger, or the id of a window message or stub.'),
  cursor: z.string().optional().describe('Only for thread: omit on the first page, then the next_cursor of the window or the cursor of next_read. Never a thread or message ID.'),
  image_id: z.string().optional().describe('Only for image: an image id the window or a read lists.'),
  offset: z.number().int().min(0).default(0).describe('Text pagination: copy next_offset; keep the other arguments unchanged. Images use 0.'),
}).strict().superRefine((read, ctx) => {
  // 交叉字段校验：path 只配 file/directory；message_id 只配 message；cursor 只配 thread；image_id 只配 image。
  if ((read.resource === 'file' || read.resource === 'directory') !== (read.path !== undefined)) ctx.addIssue({ code: 'custom', message: 'path is required only for file/directory. To read the source/root/parent, use resource=message/root/parent without a path.' })
  if (read.message_id !== undefined && read.resource !== 'message') ctx.addIssue({ code: 'custom', message: 'message_id is only for message; use returned image_id for images.' })
  if (read.cursor !== undefined && read.resource !== 'thread') ctx.addIssue({ code: 'custom', message: 'cursor is only for thread. First page: {resource:"thread"}.' })
  if ((read.resource === 'image') !== (read.image_id !== undefined)) ctx.addIssue({ code: 'custom', message: 'Images require image_id from a returned read reference. Read the thread or root first to discover their images.' })
})
/** Validated arguments for `MasterAssessor.read`. */
// EvalRead：read 方法收到的已校验参数类型（zod 推断）。
export type EvalRead = z.infer<typeof EvalReadSchema>

/**
 * Implements the `Engine` `Assessor` port for proactive candidate evaluation in the main Session.
 * Relays each evaluation's candidate card to the main Session through the durable `assessment` effect, serves bounded `TriggerContext` and repository reads while the evaluation runs, and converts the main Session's assessment into an `AssessmentOutcome` for `Engine.decide`.
 * Depends on `SourceRegistry` (via `AssessorHost`) for source-specific thread context and on `Sessions` for deduplicated candidate delivery; the main Session's `orchestrator_eval*` tools call `context`, `read`, and `decide`.
 */
// MasterAssessor：Engine 的 Assessor 端口实现（主会话评估）。
// 经持久化 assessment effect 把候选卡片转给主会话；评估期间提供有界的 Thread/仓库读取；
// 把主会话的评估转换为 AssessmentOutcome 交给 Engine.decide（Policy 会再核验）。
// 主会话的 orchestrator_eval* 三个工具分别调用 context / read / decide。
export class MasterAssessor implements Assessor {
  /** Per-evaluation read caches and thread contexts, keyed by `evalId`. */
  // evals：进行中 Eval 的状态表（按 evalId 键）。
  private readonly evals = new Map<string, EvalReads>()
  private readonly controller = new AbortController()
  /** Registers the handler that relays each Eval's candidate card, which a link lookup may delay for seconds. */
  // 构造：注册 assessment effect 处理器——把候选卡片送进主会话（链接解析可能让它延迟数秒）。
  constructor(private readonly host: AssessorHost) {
    // Start the evaluation deadline only after the main Session receives the candidate card, so a busy Session does not consume evaluation time.
    // 只有主会话真正收到候选卡片后才开始算评估超时——忙碌的主会话不白白消耗评估时间。
    host.effects.handle('assessment', async ({ triggerId }, evalId) => {
      const candidate = this.host.engine.candidate(triggerId)
      // Eval 已被取代/结束：不再投递。
      if (candidate?.evalId !== evalId) return
      await this.host.deliver(`candidate:${evalId}`, JSON.stringify({ kind: 'candidate', ...await this.host.candidateCard(candidate) }))
      // 送达回报给 Engine——超时从此刻起算。
      this.host.engine.candidateDelivered(evalId)
    }, { limit: () => host.paused() ? 0 : 4 })
  }
  /** Enqueues an `assessment` effect to deliver `candidate`'s card to the main Session. */
  // request：Assessor 端口——为候选入队一个 assessment effect（按 evalId 幂等）。
  request(candidate: Candidate): void { this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }) }
  /** Whether `evalId` is still the active evaluation for `trigger`. */
  // live：evalId 是否仍是该 Trigger 的当前 Eval。
  private live(evalId: string, trigger: Trigger): boolean { return this.host.engine.candidate(trigger.id)?.evalId === evalId }
  /** Drop an Eval's context and reads once it finishes; any running load for it discards its result. */
  // release：Eval 结束即丢弃其上下文与缓存；进行中的加载结果也会被丢弃（current() 守卫）。
  release(evalId: string): void { this.evals.delete(evalId) }
  /** Resolve the active evaluation for a trigger; historical triggers have none, and explicit requests are routed instead. */
  // evalFor：解析 Trigger 的当前评估——历史 Trigger 没有评估；明确请求应走路由而非评估。
  private evalFor(triggerId: string): { candidate: Candidate; trigger: Trigger } {
    const candidate = this.host.engine.candidate(triggerId)
    if (!candidate) throw new Error('No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment')
    if (candidate.strength === 'explicit') throw new Error(EXPLICIT)
    const trigger = candidate.triggers.find(item => item.id === triggerId)!
    return { candidate, trigger }
  }
  /** Returns or initializes the read cache for `evalId`, seeded with the trigger's own message and image references; throws if `evalId` has finished. */
  // reads：取或初始化该 Eval 的读取缓存——以 Trigger 自身消息及其图片引用做种子；
  // Eval 已结束则拒绝读取（防止缓存状态滞留）。
  private reads(evalId: string, trigger: Trigger): EvalReads {
    let reads = this.evals.get(evalId)
    if (!reads) {
      // Reject reads after the evaluation ends so completed evaluations do not retain cached state.
      if (!this.live(evalId, trigger)) throw new Error(FINISHED)
      const context = this.host.threadContext(trigger)
      // 消息缓存种子：Trigger 本体（messageId 未知时用空串键）。
      const messages = new Map([[context?.messageId ?? '', trigger.text]])
      reads = { cache: { snapshots: new Map(), images: new Map(), messages, cursors: new Set() } }
      this.evals.set(evalId, reads)
      this.imageReferences(context, trigger, trigger.text, context?.messageId ?? '', reads.cache)
    }
    return reads
  }
  // imageReferences：从文本中提取图片引用，登记进缓存并生成可读的引用描述。
  private imageReferences(context: TriggerContext | undefined, trigger: Trigger, text: string, messageId: string, cache: ReadCache) {
    return (context?.images(text) ?? []).map(imageKey => {
      // 图片 id：<消息id>/<key>，在同一 Eval 内稳定。
      const imageId = `${messageId}/${imageKey}`
      cache.images.set(imageId, { id: messageId, text })
      return { message_id: messageId, image_key: imageKey, read: { trigger_id: trigger.id, resource: 'image', image_id: imageId } }
    })
  }
  /** Loads and caches the initial bounded thread window once per evaluation (including after a host restart). */
  // seed：每个 Eval 只加载一次初始 Thread 窗口（宿主重启后同样会重新加载）。
  private async seed(evalId: string, trigger: Trigger, caller?: AbortSignal): Promise<void> {
    caller?.throwIfAborted()
    const reads = this.reads(evalId, trigger)
    // 已加载或已记错：无需再载。
    if (reads.context || reads.error !== undefined) return
    const thread = this.host.threadContext(trigger)
    if (!thread) { reads.error = NO_CONTEXT; return }
    let loading = reads.loading
    if (!loading) {
      // Guard against concurrent completion or replacement while async context loading is running.
      // current：异步加载期间，Eval 可能结束（release 删除记录）或状态被替换——
      // 用这个守卫确保只有"仍是同一次加载"才写结果。
      const current = () => this.evals.get(evalId)?.loading === loading
      // Defer start until `reads.loading` is assigned below so `current()` holds from the first step.
      // 用 Promise.resolve().then 延迟到 loading 赋值之后才真正开跑，保证 current() 从第一步就成立。
      loading = Promise.resolve().then(async () => {
        try {
          // 超时 + 宿主/调用方中止信号合并。
          const timeout = AbortSignal.timeout(this.host.deployment.admissionContextTimeoutMs.get())
          const signal = AbortSignal.any([this.controller.signal, ...(caller ? [caller] : []), timeout])
          const commands = this.host.commands.withSignal(signal)
          const context = await admissionContext(thread, commands, this.host.deployment.admissionContextMaxPages.get())
          if (!current()) return
          reads.context = context
          // Allow pagination to continue from the end of the initial window.
          // 窗口末尾的游标记入合法游标集合，允许从窗口尾部继续翻页。
          if (context.next) reads.cache.cursors.add(context.next)
          for (const message of context.messages) if (!message.deleted) {
            reads.cache.messages.set(message.id, message.text)
            this.imageReferences(thread, trigger, message.text, message.id, reads.cache)
          }
        } catch (error) {
          // 调用方已中止就不写错误（换一次请求的结果没意义）。
          caller?.throwIfAborted()
          if (current()) reads.error = `Thread context unavailable: ${String(error).slice(0, 300)}. Use orchestrator_eval_read before deciding based on missing context.`
        }
      }).finally(() => { if (current()) delete reads.loading })
      reads.loading = loading
    }
    await loading
    caller?.throwIfAborted()
    // 加载完成后再核一次：Eval 可能已结束。
    if (!this.live(evalId, trigger)) throw new Error(FINISHED)
  }
  /**
   * Returns the `orchestrator_eval` payload: the trigger's text once (up to `TRIGGER_CHARS`), batch peers, related tickets
   * on the thread, the Policy version its Eval was built from, and the initial thread window (first five messages and five
   * on either side of the trigger, truncated to `WINDOW_CHARS` or `NEAR_CHARS` for its two nearest neighbours with total
   * length and image IDs, plus other loaded messages as `STUB_CHARS` previews; `orchestrator_eval_read` reads any message
   * in full by ID).
   * Assessment instructions live in the main Session's prompt (`prompts/admission.md`), not in this payload.
   */
  // context：orchestrator_eval 的返回——
  // Trigger 文本（一次、至多 4000 字）、同批其余 Trigger、Thread 上相关 Ticket、Policy 版本、
  // 以及初始 Thread 窗口（Trigger 前后各五条；邻近两条放宽到 1200 字，其余 400 字，超长附 chars；
  // 其余已加载消息只给 50 字存根，全文按 id 用 orchestrator_eval_read 读）。
  // 注意：这里只给事实（context），不给评估指令——指令在 prompts/admission.md。
  async context(triggerId: string, signal?: AbortSignal) {
    const { candidate, trigger } = this.evalFor(triggerId)
    await this.seed(candidate.evalId, trigger, signal)
    const { context, error } = this.evals.get(candidate.evalId) ?? {}
    const source = this.host.threadContext(trigger)
    const images = (text: string) => source?.images(text) ?? []
    const imageIds = (id: string, text: string) => { const keys = images(text); return keys.length
      ? { images: keys.map(key => `${id}/${key}`) } : {} }
    // cut：截断并附总字数。
    const cut = (text: string, limit: number) => text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length }
    // thread：组装窗口视图。shown = 窗口内的消息映射；at = Trigger 在消息列表中的下标。
    const thread = context ? (() => {
      const shown = new Map(context.window.entries.map(entry => [entry.message.id, entry]))
      const at = context.messages.findIndex(message => message.id === source?.messageId)
      const messages = context.messages.map((message, index) => {
        const author = { id: message.id, from: message.from, ...message.bot ? { bot: true } : {} }
        // 已删除的消息只报 deleted。
        if (message.deleted) return { ...author, deleted: true }
        // 窗口外的已加载消息：50 字存根（可按 id 展开全文）。
        if (!shown.has(message.id)) return { ...author, preview: message.text.replace(/\s+/g, ' ').slice(0, STUB_CHARS) }
        // The trigger's own text is already included once at the top level.
        // Trigger 本体已在顶层给过一次，窗口内只做位置标记。
        if (index === at) return { ...author, at: message.at, trigger: true }
        // 距 Trigger 至多两条的放宽到 1200 字，其余 400 字。
        const near = at >= 0 && Math.abs(index - at) <= 2
        return { ...author, at: message.at, ...cut(message.text, near ? NEAR_CHARS : WINDOW_CHARS), ...imageIds(message.id, message.text) }
      })
      return { complete: context.complete, loaded_messages: context.messages.length, source_found: context.window.source_found,
        ...context.next ? { next_cursor: context.next } : {}, messages }
    })() : { error: error ?? 'Call orchestrator_eval to load initial context', complete: false }
    const settings = this.host.settings()
    // batch：同批其余 Trigger（400 字预览，超长附读取路径）。
    const others = candidate.triggers.filter(item => item.id !== trigger.id)
    return { trigger_id: trigger.id, strength: candidate.strength, mode: settings.eval.mode,
      source: { kind: trigger.source, actor: trigger.actor.id, thread: threadKey(trigger.threads[0]!), ...(trigger.url
        ? { url: trigger.url } : {}) },
      ...cut(trigger.text, TRIGGER_CHARS), ...imageIds(source?.messageId ?? '', trigger.text),
      ...others.length ? { batch: others.map(item => {
        const text = cut(item.text, WINDOW_CHARS)
        return { trigger_id: item.id, actor: item.actor.id, at: item.at, ...text, ...'chars' in text ? { read: `trigger/${item.id}` } : {} }
      }) } : {},
      // The rules are in the main Session's Policy section, which names the version the candidate's Eval was built from.
      // 相关 Ticket + Policy 版本（规则正文在主会话的 Policy 提示段里）。
      ...relatedTickets(candidate.tickets), policy_version: candidate.policyVersion,
      thread }
  }
  /**
   * Serves bounded paginated text or image attachments from the evaluation's thread context or repository for
   * `orchestrator_eval_read`; `agent` is the main Session, which receives images as attachments.
   */
  // read：orchestrator_eval_read 的实现——从 Thread 上下文或仓库读有界分页文本/图片附件；
  // agent 是主会话（图片作为附件发进去）。
  async read(agent: Agent, read: EvalRead, signal: AbortSignal) {
      const { candidate, trigger } = this.evalFor(read.trigger_id)
      await this.seed(candidate.evalId, trigger, signal)
      const { cache } = this.reads(candidate.evalId, trigger)
      const { snapshots, images, messages, cursors } = cache
      const commands = this.host.commands.withSignal(AbortSignal.any([this.controller.signal, signal]))
      if (read.resource === 'image') {
        // 图片不分页。
        if (read.offset !== 0) throw new Error('Images are not paginated; use offset 0')
        const image = images.get(read.image_id!)
        if (!image) throw new Error('Unknown image reference. Read the source/root/thread for this trigger first and copy its image read arguments.')
        const source = this.host.threadContext(trigger)
        if (!source) throw new Error(NO_CONTEXT)
        // image_id 形如 <消息id>/<key>——还原出 key 交给 Source 读取。
        const key = read.image_id!.slice(read.image_id!.indexOf('/') + 1)
        return source.image(agent, commands, image, key, this.host.deployment.stateDir, signal)
      }
      // snapshots：文本读取的快照缓存——offset>0 的翻页必须基于此前 offset 0 的同一资源。
      const cacheKey = JSON.stringify([read.resource, read.path, read.cursor, read.message_id])
      if (read.offset > 0) {
        const cached = snapshots.get(cacheKey)
        if (cached === undefined) throw new Error('Read this resource at offset 0 first')
        return textPage(read.resource, cached, read.offset, 4000)
      }
      let body: string
      const source = this.host.threadContext(trigger)
      if (read.resource === 'message') {
        // message：读缓存里的单条消息全文（缺省为 Trigger 本体）。
        const message = messages.get(read.message_id ?? source?.messageId ?? '')
        if (message === undefined) throw new Error('Unknown message reference. Use resource=root/parent or read the thread first; copy a returned message read call.')
        body = message
      }
      else if (read.resource === 'thread' || read.resource === 'root' || read.resource === 'parent') {
        // thread/root/parent：经 Source 读取器取一页；登记消息、图片与下一页游标。
        if (!source) throw new Error(NO_CONTEXT)
        if (read.cursor !== undefined && !cursors.has(read.cursor)) throw new Error('Unknown thread cursor. First call {resource:"thread"}; then copy the returned next_read exactly.')
        const result = await source.read(commands, read.resource, read.cursor)
        const references = result.messages.filter(message => !message.deleted).flatMap(message => {
          messages.set(message.id, message.text)
          return this.imageReferences(source, trigger, message.text, message.id, cache)
        })
        if (result.next) cursors.add(result.next)
        const next = result.next ? { trigger_id: trigger.id, resource: 'thread', cursor: result.next } : null
        body = JSON.stringify({ images: references, next_read: next, ...result.body })
      }
      else {
        // file/directory：读仓库路径（有界，防止越权读）。
        body = await readRepositoryPath(commands, read.path!, read.resource === 'directory' ? 'directory' : 'file')
      }
      // 快照入缓存，支持后续翻页。
      snapshots.set(cacheKey, body)
      return textPage(read.resource, body, read.offset, 4000)
  }
  /** Converts the assessment into an outcome under current settings and passes it to `Engine.decide` for policy verification. */
  // decide：把主会话的评估结论转成 AssessmentOutcome（按当前设置），交给 Engine.decide——
  // Policy 会再次核验（比如 inferred 接受要求 auto 模式与启用规则）。
  async decide(triggerId: string, result: z.infer<typeof AssessmentSchema>, signal?: AbortSignal): Promise<{ state: string; ticket_id?: string; reason: string }> {
    const { candidate } = this.evalFor(triggerId)
    signal?.throwIfAborted()
    let outcome: AssessmentOutcome = assessmentOutcome(result, this.host.settings(), candidate.strength)
    // 确认文本过一遍 IM 词数校验。
    if (outcome.kind === 'accept' && outcome.acknowledgement) outcome = { ...outcome, acknowledgement: checkedImText(outcome.acknowledgement) }
    const decision = this.host.engine.decide(triggerId, { ...outcome, evalId: candidate.evalId })
    return { state: decision.kind, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), reason: reasonText(decision.reason) }
  }
  /** Aborts any in-flight thread context or repository read commands when the runtime stops. */
  // stop：Runtime 停止时中止所有进行中的上下文/仓库读取。
  stop(): void { this.controller.abort() }
}
