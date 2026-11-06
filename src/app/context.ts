/** Built-in prompt sections, role policies, and transcript projections for orchestrator and worker Sessions. */
// 内置提示词（prompt）段落、角色策略，以及 orchestrator（调度者）与 worker（执行者）Session（会话）的对话记录（transcript）投影。
import { bundledSkills, promptFile } from './skill-files.ts'
// SessionEvent：来自 dsh-session 库的会话事件类型，仅作类型使用
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 转发导出 cards.ts 的 textPage（文本分页工具），方便调用方从本模块统一取用
export { textPage } from './cards.ts'

/** Built-in host-delivery and tool-usage rules shared by all Sessions; a team may override them (`builtInParts`). */
// 所有 Session 共用的内置"宿主消息投递与工具使用"规则；团队可通过 `builtInParts` 覆盖
export const sharedPrompt = promptFile('shared')
// orchestrator（调度者）角色的内置提示词全文
export const masterPrompt = promptFile('orchestrator')
// worker（执行者）角色的内置提示词全文
export const workerPrompt = promptFile('worker')
/** Built-in policy sections referenced by role prompts; a team may override them. */
// 角色提示词引用的内置策略段落（订阅 subscriptions、回复 replies、派发 dispatch、工作 work）；团队可覆盖
export const guides: Readonly<Record<string, string>> = Object.fromEntries(['subscriptions', 'replies', 'dispatch', 'work']
  .map(name => [name, promptFile(name)]))
/** Bundled Source skills registered by dsh-superagent; a team may override their text. */
// dsh-superagent 注册的内置 Source 技能（Skill）正文（feishu 与 github 两个）；团队可覆盖其文本
export const sourceSkills: Readonly<Record<'feishu' | 'github', string>> = { feishu: bundledSkills.feishu.content, github: bundledSkills.github.content }
// CLI 使用说明提示词片段
export const cliNotes = promptFile('cli')
/** Default text for the team-editable prompt sections (communication, ticket scope, and PR delivery). */
// 团队可编辑提示词段落的默认文本：communication 沟通方式、scope 工单（Ticket）范围、delivery PR 交付规范
export const teamDefaults = {
  communication: promptFile('team/communication'), scope: promptFile('team/scope'), delivery: promptFile('team/delivery'),
}

// 主准入策略（admission policy）提示词：约束 orchestrator 决定接单还是拒绝
export const mainAdmissionPolicy = promptFile('admission')

// handoff（交接）策略文本：shared 为两角色共用部分，orchestrator / worker 为各自角色专属部分
const handoff = { shared: promptFile('handoff'), orchestrator: promptFile('handoff-orchestrator'), worker: promptFile('handoff-worker') }
// 按角色拼接完整的交接策略文本（共用段 + 该角色专属段，以换行相连）
export const handoffPolicy = (role: 'orchestrator' | 'worker'): string => `${handoff.shared}\n${handoff[role]}`

// 生成"自动合并阈值"描述句：告诉模型当改动少于 lines 行（新增与删除合计）时允许自动合并
export const autoMergeThreshold = (lines: number): string => `it changes fewer than ${lines} lines (additions plus deletions);`

/** Retains message content while omitting streamed chunks, usage accounting, and reasoning blocks. */
// 对话记录投影函数：保留消息内容本身，剔除流式分块、用量统计与推理（reasoning）块
export function transcriptEntry(event: SessionEvent) {
  // 只保留三类事件：用户消息、工具结果、助手消息；其余事件不进入对话记录（返回 undefined 表示丢弃）
  if (event.type !== 'user/message' && event.type !== 'tool/result' && event.type !== 'assistant/message') return undefined
  // 取出消息体：用户消息事件的数据本身就是消息，另外两类事件的消息体挂在 data.message 上
  const message = event.type === 'user/message' ? event.data : event.data.message
  // 返回精简条目：事件类型 + 只保留角色与内容（过滤掉 reasoning 块）的消息
  return { type: event.type, message: { role: message.role, content: message.content.filter(block => block.type !== 'reasoning') } }
}
