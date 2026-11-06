/** Resolves and seeds per-role default models on newly created sessions without mutating the global DSH default. */
// 在新建会话上解析并播种（seed）各角色默认模型；不改动全局 DSH 默认模型。
import type { Context } from '@deepseek-ai/cordis'
// Agent / ModelSelection：DSH agent 与模型选择类型
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
// ReasoningEffortId：把推理力度（reasoning effort）名转为其枚举 id
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// RoleModel：设置中的角色模型路由（provider/model/reasoningEffort）
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
// 经活跃提供方解析配置的模型路由；目录（catalog）里有没有该模型不构成限制
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  // 让 llm 服务解析出真实可用的调用配置（提供方可能做别名或重定向）
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  // 只取实际生效的 provider/model（与可选的 reasoningEffort）返回
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** Seed a role's configured model onto a brand-new session before its first request, leaving later manual or durable selections intact. */
// 在全新会话的首次请求前播种角色配置的模型；此后用户手动选择或持久化的模型选择不受影响
export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  // 该角色未配置模型：无事可做
  if (!model) return
  // 会话已发出过请求（有请求头）或已存在模型选择事件：不播种
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  // 解析出实际可用的模型选择
  const selected = await resolveRoleModel(ctx, model)
  // Avoid selectModel because it mutates the global DSH default; inject the selection for the initial request only.
  // 不能用 selectModel（它会改动全局 DSH 默认）；改为把选择作为事件附加，只作用于首次请求
  agent.session.append('model/selection', selected)
  // initial 标记"尚未发生任何请求"（首播阶段）
  let initial = true
  // 记录最近一次系统提示词组装时用到的选择（供请求覆盖）
  let assembled: ModelSelection | undefined
  // 注册一组相互配合的 effect 钩子
  agent.ctx.effect(() => {
    const disposers = [
      // 钩子 1：系统提示词组装时——首播阶段注入选择的 provider/model 变量，否则原样放行；prepend 保证先于其他钩子
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      // 钩子 2：发起请求时——若刚才组装用了选择，则以其覆盖请求中的模型与推理力度（剥离继承值）
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      // 钩子 3：监听会话事件——一旦出现请求头或模型选择事件，首播阶段结束（此后不再注入）
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    // 返回清理函数：宿主卸载时注销所有钩子
    return () => disposers.forEach(dispose => dispose())
  })
  // 确保播种事件已持久化落盘
  await ctx.sessionPersistence.flush()
}
