/** Coordinates periodic and on-demand orchestration passes that drive due effects and Engine evaluations. */
// Passes：编排节拍器——协调周期性与按需的编排 pass（轮次），驱动到期的 Effects 与 Engine 的评估。
import type { Engine, ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

// PassesHost：Passes 依赖的宿主能力。
export interface PassesHost {
  readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  // configured：setup 是否完成（没完成前不评估、不分发、不发送）。
  configured(): boolean
  // closing：宿主是否正在关闭。
  closing(): boolean
}

const now = (): string => new Date().toISOString()

/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * `Runtime` manages its lifecycle, while sources, tools, `Settings`, and HTTP routes trigger immediate passes when new work arrives or state changes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass succeeds.
 */
// Passes：调度并串行化编排 pass（每约 2 秒一次，或有新工作时立即触发）——
// 每个 pass 先踢一下到期 Effects，再推进 Engine 评估。
// Source、工具、设置保存、HTTP 路由都会触发"立即 pass"。
// pass 失败写 runtime 健康条目；后续成功即恢复。
export class Passes {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private pumping?: Promise<void>
  private pumpAgain?: Promise<void>
  constructor(private readonly host: PassesHost) {}
  // start：每 2 秒请求一次 pass。
  start(): void { if (!this.stopped) this.timer = setInterval(() => { this.request() }, 2000) }
  // stop：停表并等待进行中的 pass 结束。
  stop(): Promise<unknown> {
    this.stopped = true
    clearInterval(this.timer)
    return Promise.allSettled([this.pumping, this.pumpAgain])
  }
  // receive：Source 交 Trigger 的入口——接收成功就请求一次立即 pass（不等到下一个 2 秒）。
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error('Orchestrator is stopping')
    const result = this.host.engine.receive(trigger)
    if (result === 'stored') this.request()
    return result
  }
  // request：发起 pass；成功后若 runtime 健康条目还是 error（上一次 pass 失败遗留）则恢复。
  request(): void {
    const { health } = this.host
    this.pump().then(() => {
      if (health.get()?.state !== 'error' || this.host.lifetime.aborted) return
      health.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    }, (error: unknown) => { health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() }) })
  }
  /** Wait until no pass or effect that can start now is running. */
  // idle：等"没有 pass 在跑、且效果队列已清空"——用于测试与关机。
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain])
      await this.host.effects.idle()
      if (!this.pumping && !this.pumpAgain) return
    }
  }
  /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
  // pump：运行一个 pass，并把并发调用合并为"紧随其后的一次"——
  // 同一时刻只有一个 pass 在跑；期间的新请求排队为一次补跑，不会并发也不会堆积。
  async pump(): Promise<void> {
    // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
    // setup 未完成或正在关闭：什么都不做；排队的工作等完成 setup 的重启。
    if (!this.host.configured() || this.host.closing()) return
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    const next = () => { this.pumpAgain = undefined; return this.pump() }
    return this.pumpAgain ??= this.pumping.then(next, next)
  }
  // pumpOnce：单次 pass——先踢 Effects（到期的开始跑），再推进 Engine 评估。
  private async pumpOnce(): Promise<void> {
    this.host.effects.kick()
    if (this.host.closing()) return
    // While processing is paused, the Engine only records the pause on active Evals so they do not expire.
    // 暂停期间 Engine 只给进行中的 Eval 记暂停标记（不过期）。
    this.host.engine.evaluateDue()
  }
}
