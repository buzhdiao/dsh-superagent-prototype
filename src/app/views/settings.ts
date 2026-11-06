/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
// 设置（Settings）视图：版本化配置块 + 每来源表单与策略元数据 + 执行环境详情的组合视图。
import { SETUP_FIELDS } from '../../deployment.ts'
// 引入各来源"重启敏感"字段清单：改动这些配置需要重启才生效。
import { KV } from '../../kv.ts'
// 引入键值（KV）存取：读取来源的自定义标签。
import { policyVersion } from '../../policy.ts'
// 引入策略版本号计算。
import type { SourceRegistry } from '../../sources/registry.ts'
// 引入来源注册表类型。
import { declaredVariables, executionRoot } from '../execution-environment.ts'
// 引入执行环境工具：声明过的环境变量与执行根目录。
import type { Store } from '../store.ts'
// 引入应用存储类型。
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'
// 引入来源视图工具：健康标题、初始化问题查询及其类型。

// 汇总某个来源实例的策略视图：字段定义、显式配置行与同步（sync）状态。
function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  // 取该来源类型上声明的策略配置；没有则无需附加信息。
  const policy = sources.kind(id)?.policy
  if (!policy) return {}
  // 取策略对应的数据分片（policyPart），断言其必然存在。
  const part = sources.policyPart(id)!
  // 取实例的当前配置，缺省为空对象。
  const config = sources.instance(id)?.config ?? {}
  // 构建同步状态块：标签、就绪判定结果与对应健康项；类型未声明同步时整体为 false。
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  // 返回策略视图：字段定义、显式配置行、可选的配置行函数结果与同步状态。
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
// 构建设置视图：按块（{ value, revision }）组织配置、每来源配置与重启敏感字段，以及执行环境详情（stateDir 提供工单默认工作目录根）。
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  // 读取全局设置。
  const settings = store.settings()
  // 便捷函数：把配置值与其存储修订号（revision）打包成版本化配置块。
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    // 当前策略版本号。
    policyVersion: policyVersion(settings),
    // 三个版本化配置块：策略（policy）、评估（eval）与执行器（executor）。
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    // 遍历每个来源实例，生成其设置卡片。
    sources: sources.instances(settings).map(instance => {
      // 取实例对应的来源类型定义。
      const kind = sources.kind(instance.kind)
      // 查询该来源的初始化问题（如有）。
      const problem = problemOf(instance.id, setup)
      // 取来源健康信息中的 id 与标题。
      const { id, title } = sourceHealth(sources, instance, health)
      // 返回卡片基础字段：id、类型、标题、描述与安装状态。
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        // 当前启用状态、配置值及其修订号。
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        // 重启敏感字段、类型声明的表单字段与部署事实。
        restarts: SETUP_FIELDS[instance.id] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        // 自定义标签、初始化问题与策略视图。
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    // 执行环境：工单默认工作目录根路径与声明过的环境变量。
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
// 设置视图类型：由 settingsView 的返回值推导。
export type SettingsView = ReturnType<typeof settingsView>
// 单个来源设置卡片的类型。
export type SourceSettingsView = SettingsView['sources'][number]
