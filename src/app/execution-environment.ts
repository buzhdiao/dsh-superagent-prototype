/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
// 执行环境（Execution environment）变量：暴露给 prepare 命令、并写入 worker Session 说明文档；其中绝不包含凭据（credentials）。
import { join } from 'node:path'
// 核心域类型：工单（Ticket）与触发器（Trigger）
import type { Ticket, Trigger } from '../core/index.ts'
// Deployment：部署信息类型
import type { Deployment } from '../deployment.ts'
// Settings：全局设置类型
import type { Settings } from '../policy.ts'
// Localized：双语描述类型；VariableSpec：变量声明规格
import type { Localized, VariableSpec } from '../sources/kind.ts'
// SourceRegistry：数据源（Source）注册表类型
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
// 执行器（Executor）注册的变量清单；标记 `ticket: true` 的变量只有存在工单时才有值
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  // DSH_SUPERAGENT_DIR：本工单的执行目录，执行器 Session 在其中工作
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  // DSH_SUPERAGENT_NAME：工单短名，同时就是执行目录的名字
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  // DSH_SUPERAGENT_TICKET：工单 id
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  // DSH_SUPERAGENT_BLOCKED_COMMANDS：本环境禁止调用的命令清单（空格分隔），提示模型绝不要运行
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
// 单个环境变量：键、值、双语描述、归属方（owner：executor 或某个数据源）
export interface Variable { key: string; value: string; description: Localized; owner: string }

// 执行根目录：优先用设置里配置的执行器目录；未配置则退回状态目录下的 `work` 子目录
export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
// 按归属方（owner）列出所有已声明的变量；`enabled` 为 false 表示对应数据源（Source）当前处于关闭状态
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  // 计算当前设置下已启用的数据源种类集合
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  // 第一项固定为执行器自带变量（始终启用）；其后追加各数据源声明的变量，并标注其启用状态
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

// 汇总一个执行环境的全部变量：执行器变量 + 各已启用数据源提供的变量
export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  // 解构输入：部署、数据源注册表、设置、可选工单信息与触发器
  const { deployment, sources, settings, ticket, trigger } = input
  // 执行器变量取值：禁止命令清单来自设置；三个工单相关变量仅在有工单时注入
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id } : {} }
  // 先生成执行器变量：过滤掉"需要工单但没有工单"的声明；缺失值以空串占位，保证清单完整
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  // 遍历当前设置下每个已启用的数据源环境
  for (const { kind, environment, config } of sources.environments(settings)) {
    // 让该数据源根据部署、其配置（以及可选的触发器上下文）计算变量取值
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    // 把该数据源声明的每个变量加入结果（取不到值时同样以空串占位）
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  // 返回完整的环境变量列表
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
// 组合工单固定的目录、短名与来源触发器，以及部署当前的设置，得到该工单的执行环境
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  // 拆出工单与触发器，其余字段（deployment/sources/settings）原样传给 environmentOf
  const { ticket, trigger, ...rest } = input
  // 从工单上提取执行信息：id 恒有；name/directory 取执行快照，缺失时以空串兜底
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  // 委托 environmentOf 生成完整变量列表（有触发器时一并传入）
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
// 把变量列表渲染为人类可读的 Markdown 清单行：`- KEY = "value": 英文描述.`
export function environmentLines(variables: Variable[]): string {
  // 值用 JSON.stringify 序列化（可见引号与转义），描述取英文；逐行拼接
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
