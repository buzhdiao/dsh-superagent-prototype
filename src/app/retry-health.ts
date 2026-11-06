/** Projects active model budget retry waits from session event streams without modifying retry policy or logs. */
// 从会话事件流中投影"模型预算重试等待"的活跃状态；不修改重试策略，也不产生日志。
// RetryHealthEvent：喂入的事件快照结构（类型、序号、时间、数据）
export interface RetryHealthEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }
// BudgetRetryStatus：某会话当前预算重试状态的对外投影
export interface BudgetRetryStatus { sessionId: string; provider: string; attempts: number; since: string; lastAt: string }
// Chain：一条活跃的重试链（重试 id、提供方、对外状态）
type Chain = { id: string; provider: string; status: BudgetRetryStatus }
// State：每个会话的内部追踪状态：已见最大序号/轮次/步骤、turn 是否已结束、预算失败是否已了结、当前活跃的重试链
type State = { seq: number; turn: number; step: number; ended: boolean; settled: boolean; active?: Chain }
// record：把未知值安全收窄为普通对象（null 与数组不算对象记录）
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
// ordinal：校验"非负安全整数"（用于序号/轮次/步骤号）
const ordinal = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Identify model budget exhaustion from structured failure metadata without inspecting assistant message content. */
// 判断失败元数据是否为"模型预算耗尽"：只看结构化字段与错误文本，不窥探助手消息内容
function budgetFailure(value: unknown): boolean {
  // 必须是对象形式的失败信息
  const failure = record(value)
  if (!failure) return false
  // 认证/限流/上下文超限类错误不是预算问题（状态码 401/403/429，或错误码命中这些模式）→ 明确排除
  if ([401, 403, 429].includes(Number(failure.status)) || typeof failure.code === 'string' && /AUTH|RATE_LIMIT|CONTEXT|TOKEN_LIMIT/i.test(failure.code)) return false
  // 结构化字段直接标明预算超限：判定成立
  if (failure.type === 'budget_exceeded' || failure.code === 'budget_exceeded') return true
  // 消息字段必须是字符串才继续分析
  if (typeof failure.message !== 'string') return false
  // 只检查消息前 8192 字符（防超长文本拖慢正则）
  const message = failure.message.slice(0, 8192)
  try {
    // 尝试把消息解析为 JSON（从第一个 { 开始），取 error 子对象或整个 body
    const body = record(JSON.parse(message.slice(message.indexOf('{'))))
    const error = record(body?.error) ?? body
    // JSON 中的 error.type/code 标明预算超限：判定成立
    if (error?.type === 'budget_exceeded' || error?.code === 'budget_exceeded') return true
  } catch { /* Some providers expose only the known plain-text budget error. */ }
  // 兜底：识别已知的纯文本预算错误句式
  return /\bBudget has been exceeded(?:!|[.:]|$)/i.test(message)
}

/**
 * Tracks which managed sessions are currently blocked on model budget retries by observing session lifecycle and retry events.
 * `Sessions` feeds session events into it and mirrors the aggregated retry state into the `models` health entry, while `resources` and views attach per-session retry status to ticket cards.
 */
// RetryHealth：通过观察会话生命周期与重试事件，追踪哪些受管会话当前阻塞在"模型预算重试"上。
// Sessions 把会话事件喂给它，并把聚合的重试状态镜像到 models 健康条目；resources 与视图把每会话的重试状态挂到工单卡片上。
export class RetryHealth {
  // 每个会话的追踪状态表
  private readonly sessions = new Map<string, State>()

  /** Replay an ordered native event snapshot; the caller must clear idle or disposed agents afterwards. */
  // 重放一份有序的原生事件快照（用于恢复/初始化）；空闲或已销毁 agent 的清理由调用方随后完成
  restore(sessionId: string, events: readonly RetryHealthEvent[]): void {
    // 先清掉旧状态，从头重放
    this.sessions.delete(sessionId)
    for (const event of events) this.observe(sessionId, event)
  }

  /** Clear active retry status while preserving the sequence watermark against out-of-order events. */
  // 清除活跃重试状态，但保留序号水位（防止迟到的乱序旧事件把状态"复活"）
  clear(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state) { state.active = undefined; state.settled = true }
  }

  // 查询单个会话的活跃重试状态（返回副本，避免外部直接改动内部状态）
  get(sessionId: string): BudgetRetryStatus | undefined {
    const status = this.sessions.get(sessionId)?.active?.status
    return status ? { ...status } : undefined
  }

  // 列出所有会话的活跃重试状态
  list(): BudgetRetryStatus[] {
    return [...this.sessions.values()].flatMap(state => state.active ? [{ ...state.active.status }] : [])
  }

  // observe：核心事件处理——按事件推进状态、识别预算重试的开始与结束
  observe(sessionId: string, event: RetryHealthEvent): void {
    // 事件基础字段合法性：序号为非负安全整数、时间有限且不越界
    if (!ordinal(event.seq) || !Number.isFinite(event.time) || event.time < 0 || event.time > 8.64e15) return
    // 取（或新建）该会话的状态；初始序号/轮次/步骤均为 -1
    let state = this.sessions.get(sessionId)
    if (!state) { state = { seq: -1, turn: -1, step: -1, ended: false, settled: false }; this.sessions.set(sessionId, state) }
    // 乱序或重复事件（序号不比已见的大）：忽略
    if (event.seq <= state.seq) return
    // 推进序号水位
    state.seq = event.seq
    // 数据载荷必须是对象
    const data = record(event.data)
    if (!data) return
    // 轮次开始/结束事件
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      // 轮次号不合法或不比已见的大：忽略
      if (!ordinal(data.turn) || data.turn < state.turn) return
      // 新轮次：重置步骤、结束标记、了结标记与活跃重试链
      if (data.turn > state.turn) Object.assign(state, { turn: data.turn, step: -1, ended: false, settled: false, active: undefined })
      // 轮次结束：清除活跃重试链并标记该轮已结束
      if (event.type === 'turn/end') { state.active = undefined; state.ended = true }
      return
    }
    if (event.type === 'llm/retry-started') return // A retry attempt starting does not mean the budget failure has recovered.
    // 只关心三类事件：步骤开始、LLM 重试、助手消息
    if (!['step/start', 'llm/retry', 'assistant/message'].includes(event.type)) return
    // 轮次/步骤号必须齐全合法
    if (!ordinal(data.turn) || !ordinal(data.step)) return
    // 过期事件（轮次已过，或同轮次中该轮已结束/步骤号偏旧）：忽略
    if (data.turn < state.turn || data.turn === state.turn && (state.ended || data.step < state.step)) return
    // 助手消息事件：判断活跃重试链是否已恢复
    if (event.type === 'assistant/message') {
      // 取消息来源（source）对象
      const source = record(record(data.message)?.source)
      // 同一轮同一步骤、未被中断、来源是模型且提供方与活跃链一致：说明重试已成功恢复
      if (state.active && data.turn === state.turn && data.step === state.step && data.interrupted !== true && source?.kind === 'model' && source.provider === state.active.provider) {
        state.active = undefined; state.settled = true
      }
      return
    }
    // 轮次或步骤前进：重置状态（活跃链清除——新步骤的失败要重新观察）
    if (data.turn > state.turn || data.step > state.step) Object.assign(state, { turn: data.turn, step: data.step, ended: false, settled: false, active: undefined })
    // 步骤开始事件不携带失败信息；已了结的预算失败也不再重开
    if (event.type === 'step/start' || state.settled) return
    // 重试事件字段校验：retryId/provider 为非空字符串、retry 为从 1 开始的整数
    if (typeof data.retryId !== 'string' || !data.retryId || typeof data.provider !== 'string' || typeof data.retry !== 'number' || !Number.isInteger(data.retry) || data.retry < 1) return
    // 失败不是预算问题：清除活跃链
    if (!budgetFailure(data.failure)) { state.active = undefined; return }
    // 尝试次数封顶为安全整数上限
    const attempts = Math.min(data.retry, Number.MAX_SAFE_INTEGER)
    // 同一条重试链（retryId 与提供方都相同）保留其原有 since 起始时间
    const previous = state.active?.id === data.retryId && state.active.provider === data.provider ? state.active.status : undefined
    // 重试次数没有增长：不更新（避免时间戳反复跳动）
    if (previous && attempts <= previous.attempts) return
    // 记录本次事件时间
    const at = new Date(event.time).toISOString()
    // 建立新的活跃重试链：提供方名做格式白名单校验（不合法记为 unknown），since 沿用旧值
    state.active = { id: data.retryId, provider: data.provider, status: {
      sessionId, provider: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(data.provider) ? data.provider : 'unknown', attempts,
      since: previous?.since ?? at, lastAt: at,
    } }
  }
}
