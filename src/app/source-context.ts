/** Scoped runtime context exposed to each Source kind, isolating Sources from direct Store or Engine access. */
// 暴露给各数据源（Source）种类的受限运行时上下文：把数据源隔离开，使其不能直接访问 Store 或 Engine。
// 核心类型：EngineForSources 引擎的源侧子集、ReceiveResult 接收结果、Trigger 触发器
import type { EngineForSources, ReceiveResult, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
// SetupProblem：setup 阶段发现的问题描述
import type { SetupProblem } from '../setup.ts'
// SourceContext：数据源上下文的端口类型
import type { SourceContext } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

// SourceContextDeps：构建数据源上下文所需的依赖
export interface SourceContextDeps {
  // store 的窄化视图：原子事务、KV 读/写/删/枚举、线程/工单/触发器与只读查询
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'>
  // Outbox：仅需发送消息的能力
  readonly outbox: Pick<Outbox, 'send'>
  // 引擎的源侧子集：绑定线程与线程关闭
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  // 命令执行器
  readonly commands: Commands
  // 数据源注册表
  readonly sources: SourceRegistry
  /** Throws when accessed before initial setup completes. */
  // 部署信息：初始 setup 完成前访问会抛错
  readonly deployment: Deployment
  // setup 完成的 Promise（数据源可等待它）
  readonly ready: Promise<void>
  // 是否已完成基础配置
  configured(): boolean
  /** Setup problem whose `place` matches the Source kind receives it on `context.problem`. */
  // setup 问题：place 与该数据源种类匹配的那个会通过 context.problem 暴露
  readonly setupProblem?: SetupProblem | undefined
  /** Why setup found no Feishu bot even though the Feishu Source names a CLI. */
  // 飞书专属问题：setup 未找到飞书机器人时的原因（尽管飞书源声明了 CLI）
  readonly feishuProblem?: SetupProblem | undefined
  /** Hands a Trigger to the Engine and schedules the pass that assesses it. */
  // 把触发器交给引擎，并安排评估它的处理轮
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}

/**
 * Builds the context for one Source kind. Health reports are restricted to entries declared by the kind and
 * bound to the active registration, becoming no-ops once unregistered.
 */
// 为某个数据源种类构建上下文。健康上报被限制在该种类声明的条目内，且绑定当前注册——注销后即变成空操作。
export function sourceContextOf(deps: SourceContextDeps, kind: { kind: string; health: readonly string[] }): SourceContext {
  const { store } = deps
  // 预取该种类允许使用的健康条目
  const health = deps.sources.healthEntries(kind.health)
  return {
    // 部署信息（getter：setup 未完成前由 deps.deployment 抛错）
    get deployment() { return deps.deployment },
    // 命令执行器
    commands: deps.commands,
    // setup 完成信号
    ready: deps.ready,
    // 是否已完成基础配置
    configured: () => deps.configured(),
    // setup 问题：取 place 与本种类匹配的那个（飞书专属问题优先检查）
    get problem() { return [deps.feishuProblem, deps.setupProblem].find(problem => problem?.place === kind.kind) },
    // config：取某实例的配置（仅当该实例已启用），否则 undefined
    config: <C extends Record<string, unknown>>(id: string) => {
      const instance = deps.sources.instance<C>(id)
      return instance?.enabled ? instance.config : undefined
    },
    // receive：把触发器交给引擎并安排评估
    receive: trigger => deps.receive(trigger),
    // atomic：暴露原子事务能力
    atomic: work => store.atomic(work),
    // state：数据源私有的 KV 状态存取（set 传 undefined 即删除）
    state: {
      get: name => store.get(name),
      set: (name, value) => { if (value === undefined) store.delete(name); else store.set(name, value) },
      keys: prefix => store.keys(prefix),
    },
    // threads：线程查询、订阅列表、描述与元数据补丁
    threads: {
      get: key => store.threads.get(key),
      subscribed: source => store.read.subscribedThreads(source),
      describe: (key, description) => store.threads.describe(key, description),
      patch: (key, meta) => { store.threads.patchMeta(key, meta) },
    },
    // tickets：工单查询/打开、线程绑定与线程关闭（经引擎）
    tickets: {
      get: id => store.tickets.get(id),
      open: () => store.tickets.open(),
      bindThread: (id, thread, own) => { deps.engine.bindThread(id, thread, own) },
      threadClosed: (thread, outcome, at) => { deps.engine.threadClosed(thread, outcome, at) },
    },
    // triggers：触发器查询与某线程最新一条
    triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
    // notify：经 Outbox 发送出站消息
    notify: message => { deps.outbox.send(message) },
    // report：健康上报——条目必须在该种类声明之列，否则抛错
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
      health.get(entry)?.set(value)
    },
  }
}
