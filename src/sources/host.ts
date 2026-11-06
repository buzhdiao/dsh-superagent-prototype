/** Host and context interfaces connecting Source plugins to the application; also imported by the web panel, so it must not import Node-only modules. */
// 连接来源（Source）插件与应用的宿主与上下文接口；网页面板也会导入本文件，因此不得引入仅限 Node 的模块。
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.ts'
// 核心领域类型。
import type { Commands } from '../infra/commands.ts'
// Commands：命令执行器类型。
import type { Deployment } from '../deployment.ts'
// Deployment：部署信息。
import type { SourceRegistry } from './registry.ts'
// SourceRegistry：来源注册表。
import type { SetupProblem } from '../setup.ts'
// SetupProblem：初始化问题。
import type { Family, Key } from '../kv.ts'
// 类型化 KV 键与键族。
import { fill } from '../infra/text.ts'
// fill：模板填充。

/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
export const HEALTH_TEXT = {
  // 固定英文健康模板（含 {name} 占位符）；面板按 code 用界面语言本地化。
  setupPending: 'Waiting for the deployment check',
  // 等待部署检查。
  sourceOff: 'Off',
  // 来源已关闭。
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  // 来源开启但未设置 bot lark-cli。
  feishuBotMissing: 'Waiting for the Feishu bot',
  // 等待飞书机器人校验。
  pollFailures: '{count} consecutive failed polls; last: {error}',
  // 连续轮询失败次数与最后一次错误。
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
// HealthCode：健康文案码。
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string> }
// Health：健康状态、详情、时间、文案码与插值。
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  // 按文案码构造健康条目。
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
  // detail 为填充后的英文模板；有插值时附带 values 供面板本地化。
}
export interface SourceHost {
  // 来源宿主接口。
  readonly sources: SourceRegistry
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
  // 返回某来源类型的上下文；其 report 只能写该类型声明的健康条目。
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
// 来源发布在线程上的展示信息：标签、URL 与事实（null 表示删除某事实）。
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
export interface SourceContext {
  // 提供给来源类型的应用能力：读状态、摄入触发、管理线程/工单、报告健康。
  readonly deployment: Deployment
  // 当前部署信息。
  readonly commands: Commands
  // 命令执行器。
  readonly ready: Promise<void>
  // 初始化完成的 Promise。
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean
  // 初始化已解析出仓库与账号后为 true；来源只在此之后轮询。
  /** Setup problem keeping this Source's account from running; only the Feishu bot check reports one. */
  readonly problem?: SetupProblem | undefined
  // 阻碍该来源账号运行的初始化问题；目前只有飞书 bot 检查会报告。
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  // 来源启用时返回其配置；停用或未安装返回 undefined。
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  // 把触发摄入引擎并安排下一次评估；调用方应等完成后再前移读取游标。
  atomic<T>(work: () => T): T
  // 原子执行一段仓储操作。
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  // 来源专属 KV 记录（如读取游标）；写入 undefined 即删除。
  threads: {
    // 线程管理。
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    // 某来源已订阅的线程。
    describe(key: string, description: ThreadDescription): void
    // 发布线程的展示信息。
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void
    // 重读线程后设置/删除（undefined）meta 键；线程不存在则不动。
  }
  tickets: {
    // 工单管理。
    get(id: string): Ticket | undefined
    /** Open tickets, newest first. */
    open(): Ticket[]
    // 打开中的工单，最新在前。
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    // 把打开的工单绑定跟随某来源线程（own 表示由该工单发起），线程关闭（而非就绪报告）才是结束工单的信号。
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
    // 报告被跟随的线程已关闭；跟随它的每个打开工单在没有 own 线程保持打开且无续跑工作时结束。
  }
  triggers: { get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */ latest(thread: string): Trigger | undefined }
  // 触发查询：按 id 取、按线程取最新。
  notify(message: OutboundMessage): void
  // 投递出站消息。
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void
  // 报告本类型声明的某个健康条目；未声明的名字会抛错。
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)
// 便捷函数：从宿主取来源上下文。
