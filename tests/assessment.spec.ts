/** Main-session assessor per-eval state and context loading. */
// 主 Session 评估器（MasterAssessor）的逐 Eval 状态与上下文加载。
/**
 * 本测试文件覆盖主 Session 的评估器（src/app/assessment.ts 的 MasterAssessor）：
 * 每个 Eval 的临时状态在决定/超时后必须清空、晚到的上下文读取必须失败、
 * 经 Source 读取线程上下文（给不出上下文的 Source 报错但触发器原文仍可读）、
 * 显式候选直接路由而不评估、评估 schema 只接受其工具声明的决定（不再收 reopen/stop）、
 * 有界上下文窗口（触发器原文只给一次、窗口内消息截断并带原长、窗口外是可续读的占位）、
 * 从窗口末尾游标续读，以及被跳过的批量消息指向其全文。测试策略：内存仓库 + 假 gh 命令
 * （Issue/评论/文件读取，闸门 Promise 控制挂起），起真实 Engine 与 MasterAssessor，
 * 直接调用 context 与评估工具，断言返回内容与在留状态计数。
 */
import { expect, it, vi } from 'vitest'
// vitest 断言与用例；vi 造假命令函数。
import type { Agent } from '@deepseek-ai/dsh-agent'
// Agent 类型：assessor.read 的首参（测试里传空对象）。
import { AssessmentSchema, EvalReadSchema, MasterAssessor, type AssessorHost } from '../src/app/assessment.ts'
// 被测模块：MasterAssessor、评估决策/读取 schema 与宿主接口。
import { mainAdmissionPolicy } from '../src/app/context.ts'
// mainAdmissionPolicy：主 Session 的准入策略文本（校验其不再要求 reopen/stop）。
import { Engine, MemoryRepositories, type Executor, type Policy, type Trigger } from '../src/core/index.ts'
// core：引擎与内存仓库，及 Executor/Policy/Trigger 类型。
import type { Commands } from '../src/infra/commands.ts'
// Commands：命令封装（测试用假对象整体顶替）。
import { SettingsSchema } from '../src/policy.ts'
// SettingsSchema：把空配置解析成最小合法设置。
import { testDeployment } from './fixtures/deployment.ts'
// testDeployment：部署信息 fixture。
import { deferred } from './fixtures/async.ts'
// deferred：手工控制 resolve/reject 的 Promise（让 gh 请求挂起）。
import { githubKind } from '../src/sources/github.ts'
// githubKind：GitHub 来源（提供线程上下文）。
import { SourceRegistry } from '../src/sources/registry.ts'
// SourceRegistry：来源注册表（默认 threadContext 经它分发）。

/** Assessor fixture backed by in-memory repositories and fake GitHub Issue and file reads. */
// 评估器 fixture：内存仓库 + 假 GitHub Issue/文件读取。
function setup(strength: 'explicit' | 'inferred' = 'inferred', bodies = Array.from({ length: 5 }, (_, i) => `comment ${i}`),
  threadContext?: AssessorHost['threadContext']) {
  // 搭好评估器宿主与引擎：默认 5 条评论，可指定准入强度与自定义线程上下文。
  const comments = bodies.map((body, i) => ({ id: i, html_url: `https://github.com/acme/widgets/issues/1#c${i}`,
    user: { login: 'bob' }, created_at: '2026-09-09T00:00:00Z', body }))
  // 评论列表 fixture：与 bodies 一一对应，挂在 Issue #1 下。
  const gate = { issue: undefined as Promise<void> | undefined }
  // 闸门：issue 请求会先等这个 Promise，用来人为挂起上下文读取。
  const commands = {
    repository: 'acme/widgets', deployment: testDeployment(),
    withSignal() { return commands },
    gh: vi.fn(async (args: string[]) => {
      // 假 gh：等闸门放行后按 URL 分流——评论列表或 Issue 本体。
      await gate.issue
      const number = Number(/issues\/(\d+)/.exec(args[1]!)?.[1])
      return args[1]!.includes('/comments') ? comments : { id: 100 + number, number, state: 'open',
        html_url: `https://github.com/acme/widgets/issues/${number}`,
        user: { login: 'bob' }, created_at: '2026-09-09T00:00:00Z', title: 'Issue', body: 'body' }
    }),
    run: vi.fn(async () => 'export const value = 1\n'),
    // 假 run：文件读取一律返回同一行导出。
    // A string first argument is a raw file path; otherwise validate the fake gh response against the schema.
    // 首参是字符串时即原始文件路径；否则把假 gh 的应答过一遍 schema 校验再返回。
    api: vi.fn(async (schema: unknown, ...rest: string[]) => typeof schema === 'string' ? 'export const value = 1\n'
      : (schema as { parse(value: unknown): unknown }).parse(await (commands as unknown as { gh(args: string[]): Promise<unknown> }).gh(['api', rest[0]!]))),
  } as unknown as Commands
  const repo = new MemoryRepositories()
  // 内存仓库：不落盘。
  const sources = new SourceRegistry(() => SettingsSchema.parse({}))
  sources.register(githubKind)
  // 注册 GitHub 来源，供默认 threadContext 解析线程上下文。
  let engine!: Engine
  const host: AssessorHost = {
    // 评估器宿主：引擎 getter、命令、部署、设置、线程上下文与效果/投递的最小实现。
    get engine() { return engine }, commands, deployment: testDeployment(), settings: () => SettingsSchema.parse({}),
    threadContext: threadContext ?? (trigger => sources.threadContext(trigger)),
    effects: { enqueue: () => {}, handle: () => {} }, paused: () => false, deliver: async () => {}, candidateCard: async candidate => ({ eval_id: candidate.evalId }),
  }
  const assessor = new MasterAssessor(host)
  // 被测对象：主 Session 评估器。
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 600_000, gate: () => ({ admissible: true, strength, basis: { via: 'followup' } }),
    revalidate: () => true, admitsInferred: rules => rules.length > 0 }
  // 策略：一律放行，强度来自参数（explicit 则评估器直接路由）。
  const executor: Executor = { start: async () => {}, deliver: async () => {}, stop: async () => {} }
  // 空执行器：不会真正派工。
  const scope = { scope: () => ({ listened: true as const, observed: true }) }
  // 范围判定：一律“已监听、可观察”。
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  // 空出站箱。
  engine = new Engine({ repo, policy: () => policy, scope, assessor, executor, outbox })
  // 引擎装配：把上面的假件接起来。
  const tools: Record<string, (args: unknown, signal: AbortSignal) => Promise<unknown>> = {}
  tools.orchestrator_eval_read = (args, signal) => assessor.read({} as Agent, EvalReadSchema.parse(args), signal)
  // 评估读取工具：参数过 schema 后转发给 assessor.read。
  tools.orchestrator_eval_decide = (args, signal) => {
    const { trigger_id, ...result } = args as { trigger_id: string }
    return assessor.decide(trigger_id, AssessmentSchema.parse(result), signal)
  }
  // 评估决策工具：拆出 trigger_id，其余过 AssessmentSchema 后转发给 assessor.decide。
  // Per-Eval state retained by the assessor and released when the Eval ends.
  // 评估器按 Eval 保留的内部状态，Eval 结束时应释放。
  const kept = assessor as unknown as { evals: Map<string, unknown> }
  const size = () => kept.evals.size
  // 在留状态计数：各用例借它断言清理行为。
  return { repo, engine, assessor, tools, size, gate }
}
const issue = (n: number): Trigger => ({ id: `issue-${n}`, source: 'github', threads: [{ source: 'github', id: String(n) }], actor: { source: 'github', id: 'bob' }, human: true,
  at: new Date(Date.UTC(2026, 8, 9, 0, 0, n)).toISOString(), text: `issue ${n}`, url: `https://github.com/acme/widgets/issues/${n}`, meta: { number: n } })
// 构造第 n 个 GitHub Issue 触发器（时间戳随 n 递增）。
const signal = new AbortController().signal
// 通用中止信号（用例里不会真正中止）。

it('keeps nothing for an Eval once it is decided, as for one that timed out', async () => {
  // Eval 一经决定就不得保留逐 Eval 状态；超时的 Eval 同样清空。
  const s = setup()
  for (let n = 1; n <= 3; n++) {
    // 逐个受理并评估 3 个 Issue：读取期间状态在留，决定后清零。
    s.engine.receive(issue(n)); s.engine.evaluateDue()
    await s.assessor.context(`issue-${n}`, signal)
    await s.tools.orchestrator_eval_read!({ trigger_id: `issue-${n}`, resource: 'file', path: 'src/value.ts', offset: 0 }, signal)
    expect(s.size()).toBeGreaterThan(0)
    // 评估中：状态在留。
    s.engine.decide(`issue-${n}`, { kind: 'ignore', reason: 'not a request' })
    expect(s.size()).toBe(0)
    // 决定即释放。
  }
  s.engine.receive(issue(9)); s.engine.evaluateDue()
  await s.assessor.context('issue-9', signal)
  const thread = s.repo.threads.get('github:9')!
  s.repo.threads.save({ ...thread, expired: 2, evaluating: { ...thread.evaluating!, delivered: '2000-01-01T00:00:00.000Z', deadline: '2000-01-01T00:00:00.000Z' } })
  // 把评估期限改到遥远的过去，模拟评估超时。
  s.engine.evaluateDue()
  expect(s.size()).toBe(0)
  // 超时同样不留下任何在留状态。
})

it('keeps nothing from a context read that finishes after its Eval was decided', async () => {
  // 上下文读取在 Eval 已被决定之后才完成：结果作废（reject），状态清空。
  const s = setup()
  const hold = deferred()
  s.gate.issue = hold.promise
  // 闸门挂起 issue 请求，让 context 停在半路。
  s.engine.receive(issue(1)); s.engine.evaluateDue()
  const details = s.assessor.context('issue-1', signal)
  s.engine.decide('issue-1', { kind: 'ignore', reason: 'not a request' })
  // 决定先于读取完成。
  hold.resolve()
  await expect(details).rejects.toThrow('This assessment has finished')
  // 迟到的读取以“评估已结束”失败。
  expect(s.size()).toBe(0)
  // 状态依然清空。
})

it('reads the context of a Trigger through its Source, and none for a Source that gives none', async () => {
  // 触发器上下文经其 Source 读取；给不出线程上下文的 Source 报错，但触发器原文仍可读。
  const s = setup()
  s.engine.receive(issue(1)); s.engine.evaluateDue()
  const context = await s.assessor.context('issue-1', signal)
  expect(context.thread).toMatchObject({ complete: true, loaded_messages: 6, source_found: true })
  // Issue 本体 + 5 条评论全部载入，且标记找到了 Source 上下文。
  const page = await s.tools.orchestrator_eval_read!({ trigger_id: 'issue-1', resource: 'thread', offset: 0 }, signal) as { text: string }
  expect(JSON.parse(page.text)).toMatchObject({ next_read: null,
    messages: expect.arrayContaining([expect.objectContaining({ text: 'comment 0' })]) })
  // thread 资源返回消息页：没有下一页，且包含评论内容。
  const other: Trigger = { ...issue(2), id: 'other-2', source: 'probe', threads: [{ source: 'probe', id: '2' }], actor: { source: 'probe',
    id: 'bob' } }
  s.engine.receive(other); s.engine.evaluateDue()
  expect((await s.assessor.context('other-2', signal)).thread).toMatchObject({ error: expect.stringContaining('gives no Thread context') })
  // 未注册的 probe 来源给不出线程上下文：上下文里带错误说明。
  await expect(s.tools.orchestrator_eval_read!({ trigger_id: 'other-2', resource: 'thread', offset: 0 },
    signal)).rejects.toThrow('gives no Thread context')
  // The Trigger's own text is still readable when its Source provides no Thread context.
  // Source 给不出线程上下文时，触发器自己的原文仍可读。
  expect(await s.tools.orchestrator_eval_read!({ trigger_id: 'other-2', resource: 'message', offset: 0 },
    signal)).toMatchObject({ text: 'issue 2' })
})
it('routes an explicit candidate instead of assessing it: each eval tool names the routing tools', async () => {
  // 显式候选不进入评估而直接路由：每个评估工具都报错并指明应改用的路由工具。
  const s = setup('explicit')
  s.engine.receive(issue(1)); s.engine.evaluateDue()
  const routed = 'orchestrator_route with its trigger_id and kind accept, attach, stop or ignore'
  // 报错信息固定指向 orchestrator_route 及其可用的 kind。
  await expect(s.assessor.context('issue-1', signal)).rejects.toThrow(routed)
  await expect(s.tools.orchestrator_eval_read!({ trigger_id: 'issue-1', resource: 'message', offset: 0 }, signal)).rejects.toThrow(routed)
  const direction = { implementation_requested: false, target_basis: 'undetermined', requires_design_decision: false, evidence: 'chatter' }
  const decision = { trigger_id: 'issue-1', decision: 'ignore', rule_assessments: [], direction, title: 't', scope: 's', reason: 'r' }
  await expect(s.tools.orchestrator_eval_decide!(decision, signal)).rejects.toThrow(routed)
  // 三个评估入口（context/read/decide）对显式候选一律拒绝。
})

it('asks the assessment only for decisions its tool accepts, which no longer include reopen or stop', () => {
  // 评估只要求其工具接受的决定：reopen/stop 已不在评估 schema 中。
  expect(mainAdmissionPolicy).not.toMatch(/reopen|decision=stop/)
  // 准入策略文本不再提 reopen 或 decision=stop。
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'e' }
  const result = (decision: string, extra = {}) =>
    AssessmentSchema.safeParse({ decision, rule_assessments: [], direction, title: 't', scope: 's', reason: 'r', ...extra }).success
  // 用 safeParse 逐个决定值试 schema。
  expect([result('ignore'), result('unavailable'), result('reopen'), result('stop')]).toEqual([true, true, false, false])
  // ignore/unavailable 可解析，reopen/stop 被拒。
  expect(result('ignore', { ticket_id: 't' })).toBe(false)
  // 评估阶段不允许自带 ticket_id（工单由受理产生）。
})

it('loads a window without the assessment instructions: the trigger once, cut messages with their length, and stubs for the rest',
  async () => {
  // 有界窗口不含评估指令：触发器原文只在顶层给一次，窗口内消息截断并带原长，窗口外是可续读的占位。
  const bodies = Array.from({ length: 30 }, (_, i) => `comment ${i}: ${'the label reads oddly on the settings page. '.repeat(i % 4 === 0
    ? 40 : 3)}`)
  // 30 条评论：每 4 条掺一条超长的。
  const s = setup('inferred', bodies)
  const trigger = { ...issue(1), id: 'c15', text: bodies[15]!, url: 'https://github.com/acme/widgets/issues/1#c15', meta: { number: 1,
    kind: 'comment' } }
  // 触发器取第 15 条评论。
  s.engine.receive(trigger); s.engine.evaluateDue()
  const result = await s.assessor.context('c15', signal) as Record<string, unknown> & { thread: { messages: Record<string, unknown>[] } }
  expect(result).not.toHaveProperty('instructions')
  // 上下文不内嵌评估指令（指令属于 Session 提示词）。
  expect(result.text).toBe(bodies[15])
  // 触发器原文在顶层给出。
  const messages = new Map(result.thread.messages.map(message => [message.id as string, message]))
  const at = (i: number) => messages.get(`https://github.com/acme/widgets/issues/1#c${i}`)!
  // 按评论 URL 建索引，方便逐条断言。
  // The trigger's own text is given once at top level; its two nearest neighbours keep more text than the rest of the window.
  // 触发器自己的文本只在顶层给一次；紧邻的消息比窗口其余部分保留更多文本。
  expect(at(15)).toEqual({ id: expect.any(String), from: 'bob', at: expect.any(String), trigger: true })
  // 触发器消息只留元信息（正文已由顶层 text 提供，不再重复）。
  expect(at(16)).toMatchObject({ chars: bodies[16]!.length, text: `${bodies[16]!.slice(0, 1200)}…` })
  expect(at(12)).toMatchObject({ chars: bodies[12]!.length, text: `${bodies[12]!.slice(0, 400)}…` })
  // 截断消息带原长（chars）并以省略号收尾：越近保留越多。
  expect(at(14)).toMatchObject({ text: bodies[14] })
  expect(at(14)).not.toHaveProperty('chars')
  // 窗口内的短消息保全文且不带 chars。
  // Messages outside the window are stubs that orchestrator_eval_read can read in full.
  // 窗口外消息是占位，可经 orchestrator_eval_read 读取全文。
  expect(at(8)).toEqual({ id: expect.any(String), from: 'bob', preview: bodies[8]!.slice(0, 50) })
  const whole = await s.tools.orchestrator_eval_read!({ trigger_id: 'c15', resource: 'message', message_id: at(8).id }, signal)
  expect(JSON.stringify(whole)).toContain(bodies[8]!.slice(-40))
  // 续读拿到全文（断言包含结尾片段）。
  expect(JSON.stringify(result).length).toBeLessThan(9000)
  // 整个上下文有界：序列化后小于 9KB。
})

it('lets the main Session read on from the cursor its loaded window ends with, and points a cut batch message at its whole text', async () => {
  // 主 Session 可从窗口收尾的游标续读；被跳过的长批量消息带 read 指针指向全文。
  // Every page returns a next cursor so the bounded window ends with a continuation cursor.
  // 每页都返回 next 游标，让有界窗口以续读游标收尾。
  const page = (cursor?: string) => {
    const n = Number(cursor ?? 0)
    const message = { id: `m${n}`, from: 'bob', at: new Date(Date.UTC(2026, 8, 9, 0, 0, n)).toISOString(), text: `message ${n}` }
    return { messages: [message], next: String(n + 1), body: { messages: [message] } }
  }
  // 假分页：每页一条消息，游标递增。
  const context = { messageId: 'm0', read: async (_commands: Commands, _part: string, cursor?: string) => page(cursor), images: () => [],
    image: async () => { throw new Error('No images') } }
  // 自定义 threadContext：替换默认的 GitHub 读取。
  const s = setup('inferred', undefined, () => context)
  s.engine.receive(issue(1))
  const long = { ...issue(2), id: 'long', threads: issue(1).threads, text: 'a long follow-up. '.repeat(40) }
  // 同线程上的长跟进触发器（作为被评估对象）。
  s.engine.receive(long); s.engine.evaluateDue()
  const result = await s.assessor.context('long', signal) as { thread: { next_cursor?: string }, batch: Record<string, unknown>[] }
  expect(result.thread.next_cursor).toBe('10')
  // 窗口收在游标 10。
  const more = await s.tools.orchestrator_eval_read!({ trigger_id: 'long', resource: 'thread', cursor: '10' }, signal)
  expect(JSON.stringify(more)).toContain('message 10')
  // 从游标 10 续读能拿到后续消息。
  const shorter = { trigger_id: 'issue-1' }
  expect(result.batch).toEqual([expect.objectContaining(shorter)])
  // batch 汇总同线程上更早的触发器 issue-1（正文很短，直接内联、无需指针）。
  const s2 = setup('inferred', undefined, () => context)
  s2.engine.receive(long); s2.engine.receive({ ...issue(3), threads: issue(1).threads }); s2.engine.evaluateDue()
  const other = await s2.assessor.context('issue-3', signal) as { batch: Record<string, unknown>[] }
  expect(other.batch).toEqual([expect.objectContaining({ trigger_id: 'long', chars: long.text.length, read: 'trigger/long' })])
  // 更早的长触发器以占位进 batch：带原长（chars）与 read 指针，可读取全文。
})
