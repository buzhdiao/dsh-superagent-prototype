/** Computes structured settings diffs across saved revisions for display in the management panel. */
// 计算已保存修订之间结构化的设置差异（diff），供管理面板展示。
// FieldSpec：数据源字段规格类型
import type { FieldSpec } from '../sources/kind.ts'
// SourceRegistry：数据源（Source）注册表类型
import type { SourceRegistry } from '../sources/registry.ts'
// KV：内部键族定义
import { KV } from '../kv.ts'
// Store / SettingsVersion：存储与设置版本类型
import type { Store, SettingsVersion } from './store.ts'

// SourceSettings：某个数据源实例的设置形状
type SourceSettings = SettingsVersion['settings']['sources'][string]
/** Change codes localized by the web panel as `change.<code>`. */
// 变更码集合：Web 面板按 `change.<code>` 本地化显示
export type SettingsChangeCode = 'ruleAdded' | 'ruleRenamed' | 'ruleInstruction' | 'ruleEnabled' | 'ruleDisabled' | 'ruleRemoved'
  | 'sourceEnabled' | 'sourceDisabled' | 'sourceField' | 'sourceRowsAdded' | 'sourceRowsRemoved' | 'sourceRowsChanged' | 'sourceAdmission'
  | 'mode' | 'timeout' | 'evalModel' | 'executorModel' | 'maxWorkers' | 'paused' | 'resumed' | 'executionDirectory' | 'prepareCommand'
  | 'blockedCommands'
/** A single settings diff entry rendered by the panel using `change.<code>` and field labels from the Source listing. */
// 单条设置差异：面板用 `change.<code>` 与数据源清单里的字段标签渲染
// （items 为受影响项列表，from/to 为前后值，name 为规则名，source/field/part 标明归属）
export interface SettingsChange {
  code: SettingsChangeCode; items?: string[]; from?: string | number | boolean; to?: string | number | boolean; name?: string; source?: string
  field?: string; part?: true
}
// same：用 JSON 序列化比较两个值是否深度相等（对原型无要求的小对象足够）
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
// fieldChanges：按字段规格逐项比较两个数据源配置，产出差异列表
function fieldChanges(id: string, fields: readonly FieldSpec[], a: Record<string, unknown>, b: Record<string, unknown>, part?: true): SettingsChange[] {
  const changes: SettingsChange[] = []
  // 差异归属标签：数据源 id；part: true 表示属于"源专属策略"部分
  const at = { source: id, ...part ? { part } : {} }
  // 遍历声明过的字段
  for (const field of fields) {
    // 前后两版的字段值
    const from = a[field.key], to = b[field.key]
    // 值未变：跳过
    if (same(from, to)) continue
    // rows 型字段（表格）：按首列（行键）比较行的增删改
    if (field.type === 'rows') {
      // 行键取列定义的第一列
      const rowKey = field.columns[0]!.key
      // 把数组值转成"行键 → 行"的映射（非数组安全退化为空表）
      const rows = (value: unknown) => new Map((Array.isArray(value) ? value as Record<string, unknown>[] : []).map(row => [String(row[rowKey]), row]))
      // Prefer the second column (human-readable label) over the row key when naming changed rows.
      // 行名优先取第二列（人类可读标签），取不到退回行键
      const label = (row: Record<string, unknown> | undefined, item: string) => String((field.columns[1] && row?.[field.columns[1].key]) || item)
      // 前后两个版本的行映射
      const old = rows(from), next = rows(to)
      // 计算新增与删除的行名列表
      const added = [...next.keys()].filter(item => !old.has(item)).map(item => label(next.get(item), item)), removed = [...old.keys()].filter(item => !next.has(item)).map(item => label(old.get(item), item))
      // 计算内容有修改的行名列表
      const changed = [...next.keys()].filter(item => old.has(item) && !same(old.get(item), next.get(item))).map(item => label(next.get(item), item))
      // 依次输出三类差异（有内容才输出）
      if (added.length) changes.push({ code: 'sourceRowsAdded', ...at, field: field.key, items: added })
      if (removed.length) changes.push({ code: 'sourceRowsRemoved', ...at, field: field.key, items: removed })
      if (changed.length) changes.push({ code: 'sourceRowsChanged', ...at, field: field.key, items: changed })
    } else changes.push({ code: 'sourceField', ...at, field: field.key, from: from as string | number | boolean, to: to as string | number | boolean })
  }
  return changes
}
// sourceChanges：单个数据源实例的差异（启用状态 + 逐字段）
function sourceChanges(id: string, before: SourceSettings | undefined, after: SourceSettings | undefined, sources: SourceRegistry): SettingsChange[] {
  // 查该实例的种类定义（可能已不存在）
  const kind = sources.kind(id)
  const changes: SettingsChange[] = []
  // 启用状态变化：输出 sourceDisabled / sourceEnabled
  if ((before?.enabled ?? true) !== (after?.enabled ?? true)) changes.push({ code: after?.enabled === false ? 'sourceDisabled' : 'sourceEnabled', source: id })
  // 用 schema 归一化两侧配置（缺失按空对象解析），保证对比口径一致
  const fill = (value: SourceSettings | undefined) => kind ? kind.schema.parse(value?.config ?? {}) : value?.config ?? {}
  // 追加逐字段差异
  return [...changes, ...fieldChanges(id, kind?.fields ?? [], fill(before), fill(after))]
}
// settingsChanges：两个完整设置版本间的全部差异
function settingsChanges(before: SettingsVersion['settings'], after: SettingsVersion['settings'], sources: SourceRegistry): SettingsChange[] {
  const changes: SettingsChange[] = []
  // 逐条检查新版本的策略规则
  for (const rule of after.policy.rules) {
    // 在旧版本中找同 id 规则
    const old = before.policy.rules.find(item => item.id === rule.id)
    // 旧版没有：新增规则
    if (!old) { changes.push({ code: 'ruleAdded', name: rule.name }); continue }
    // 名称 / 指令 / 启用状态各自的变化
    if (old.name !== rule.name) changes.push({ code: 'ruleRenamed', from: old.name, to: rule.name })
    if (old.instruction !== rule.instruction) changes.push({ code: 'ruleInstruction', name: rule.name })
    if (old.enabled !== rule.enabled) changes.push({ code: rule.enabled ? 'ruleEnabled' : 'ruleDisabled', name: rule.name })
  }
  // 旧版有而新版没有的规则：删除
  for (const rule of before.policy.rules) if (!after.policy.rules.some(item => item.id === rule.id)) changes.push({ code: 'ruleRemoved', name: rule.name })
  // 两侧数据源策略键的并集，逐个比较
  for (const id of new Set([...Object.keys(before.policy.sources), ...Object.keys(after.policy.sources)])) {
    // 该数据源种类的策略定义
    const policy = sources.kind(id)?.policy
    // Validate source-specific policy fields separately from the shared admission table.
    // 源专属策略字段与共享准入表分开校验（fill 先剥掉 admission，再按 schema 解析其余字段）
    const fill = (value: Record<string, unknown> | undefined) => { const { admission: _admission, ...rest } = value ?? {}; return policy ? policy.schema.parse(rest) : rest }
    // 逐字段差异（part: true 标明属于策略部分）
    changes.push(...fieldChanges(id, policy?.fields ?? [], fill(before.policy.sources[id]), fill(after.policy.sources[id]), true))
    // Admission tables map receiving scopes rather than form fields, so summarize any table change as one entry per Source.
    // 准入表映射的是接收范围而非表单字段，因此整表有任何变化就按数据源汇总为一条
    if (JSON.stringify(before.policy.sources[id]?.admission ?? {}) !== JSON.stringify(after.policy.sources[id]?.admission ?? {})) changes.push({ code: 'sourceAdmission', source: id, part: true })
  }
  // 以下为全局设置各字段的差异
  if (before.eval.mode !== after.eval.mode) changes.push({ code: 'mode', from: before.eval.mode, to: after.eval.mode })
  if (before.eval.timeoutSeconds !== after.eval.timeoutSeconds) changes.push({ code: 'timeout', from: before.eval.timeoutSeconds, to: after.eval.timeoutSeconds })
  if (!same(before.eval.model, after.eval.model)) changes.push({ code: 'evalModel' })
  if (!same(before.executor.model, after.executor.model)) changes.push({ code: 'executorModel' })
  if (before.executor.maxWorkers !== after.executor.maxWorkers) changes.push({ code: 'maxWorkers', from: before.executor.maxWorkers, to: after.executor.maxWorkers })
  if (before.paused !== after.paused) changes.push({ code: after.paused ? 'paused' : 'resumed' })
  if (before.executor.directory !== after.executor.directory) changes.push({ code: 'executionDirectory', from: before.executor.directory, to: after.executor.directory })
  if (before.executor.prepare !== after.executor.prepare) changes.push({ code: 'prepareCommand' })
  if (!same(before.executor.blockedCommands, after.executor.blockedCommands)) changes.push({ code: 'blockedCommands', from: before.executor.blockedCommands.join(' '), to: after.executor.blockedCommands.join(' ') })
  // 两侧数据源实例键的并集，逐个比较实例级差异
  for (const id of new Set([...Object.keys(before.sources), ...Object.keys(after.sources)])) changes.push(...sourceChanges(id, before.sources[id], after.sources[id], sources))
  return changes
}
/** Compute changes between two revisions, returning null if a historical revision fails current source schema validation. */
// 计算两修订间差异；历史修订无法通过当前数据源 schema 校验时返回 null（面板显示为不可比较）
function changesOf(before: SettingsVersion['settings'], after: SettingsVersion['settings'], sources: SourceRegistry): SettingsChange[] | null {
  try { return settingsChanges(before, after, sources) } catch { return null }
}
/** Return recent settings revisions newest-first with their computed diffs and notified tickets. */
// 返回最近的设置修订（最新在前），附计算出的差异与被通知的工单
export function policyHistory(store: Store, sources: SourceRegistry, policyVersionValue: string) {
  // 取最近 30 条修订
  const versions = store.settingsHistory(30)
  return { current: store.get(KV.settings.revision) ?? 0, policyVersion: policyVersionValue,
    // 逐条构造视图：修订号、保存时间、来源、所在块、策略版本、策略是否变化、被通知的工单（附标题）、与上一修订的差异
    items: versions.map((version, index) => {
      // 列表按新到旧排列，index+1 即更早一版
      const previous = versions[index + 1]
      return { revision: version.revision, savedAt: version.savedAt, source: version.source, block: version.block, policyVersion: version.policyVersion, policyChanged: version.policyChanged, notified: version.notified.map(id => ({ id, title: store.tickets.get(id)?.title ?? id })),
        // 仅当上一条恰为紧邻的更早修订时才计算差异，否则置 null
        changes: previous && previous.revision === version.revision - 1 ? changesOf(previous.settings, version.settings, sources) : null }
    }) }
}
// HistoryView：管理面板使用的设置历史视图类型（由返回值推导）
export type HistoryView = ReturnType<typeof policyHistory>
