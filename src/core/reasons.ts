/**
 * Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
 * Policy gates and source scopes may also emit their own literal reason codes.
 */
// 结构化的原因代码与模板：用于 Decision、被过滤的 Trigger、结束的 Assignment 等。
// 除了 core 的这些代码，Policy 的门（gate）与各 Source 的 scope 也会给出自己的字面量代码（如 not_a_member）。
export const REASONS = {
  said: '{text}', // 原样引用评估者或人写下的话（模板即占位符本身）。
  timeout: 'Assessment timed out', // 评估超时。
  policyChanged: 'Policy changed during assessment', // 评估期间 Policy 变了。
  noAdmissible: 'No admissible trigger', // 没有任何可准入的 Trigger。
  startedTicket: 'Already started ticket {ticket}', // 这条 Trigger 已经开过 ticket 了。
  acceptedBefore: 'Trigger {trigger} was accepted before', // 该 Trigger 之前已被接受。
  routed: 'Routed to ticket {ticket}', // 已被手工路由到某个 ticket。
  explicitRouted: 'Explicit request from an allowed sender routed by the orchestrator', // 名单发送者的明确请求被主会话路由。
  humanStop: 'Human asked to stop', // 人要求停止。
  legacyImport: 'Imported from the pre-domain-model task record', // 从领域模型之前的旧 task 记录导入。
  forwarded: 'Forwarded to the worker of the Ticket already on this Thread', // 转给该 Thread 上已有 Ticket 的 worker。
  senderNotMember: 'The sender is not on the Source\'s list', // 发送者不在 Source 的允许名单上。
  retried: 'Retried by a person', // 被人重试。
  hostRestarted: 'dsh-superagent restarted', // dsh-superagent 重启导致中断。
  stopUnknown: 'Stop target is unknown or already ended', // 要停的对象不存在或已结束。
  stopNotExplicit: 'A stop needs an explicit request from a sender on the list', // 停止指令必须来自名单上的明确请求。
  directionUnsettled: 'Implementation intent or target direction is not established, or a product/design decision is still required', // 实现意图或方向未定，仍需产品/设计决策。
  noRuleMatched: 'No enabled admission rule matched', // 没有命中的启用准入规则。
  ignoredFromCard: 'Ignored from its card, without a rule assessment', // 从候选卡片上直接忽略，未做规则评估。
  observed: 'Observe mode: would accept ({text})', // observe 模式：本会接受，但只记录。
} as const
export type ReasonCode = keyof typeof REASONS
/** Reason code and template values; `triggerId` identifies the trigger in a batch that the reason applies to. */
// Reason：原因代码 + 模板值；批次评估时用 `triggerId` 标明这条原因针对的是哪一条 Trigger。
export interface Reason { code: ReasonCode | (string & {}); values?: Record<string, string>; triggerId?: string }
// said：把一句自由文本包装成 `said` 原因（code 用 (string & {}) 允许自定义字符串代码）。
export const said = (text: string): Reason => ({ code: 'said', values: { text } })
/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
// reasonText：把原因格式化为英文文本（供 agent 阅读）；带 triggerId 的加前缀；多条用 "; " 连接。
export function reasonText(reasons: readonly Reason[] | Reason | undefined): string {
  return [reasons ?? []].flat().map(reason => {
    const template: string = REASONS[reason.code as ReasonCode] ?? reason.code
    // 用 values 填充 {xxx} 占位符；没有对应值时保留原样。
    const text = template.replace(/\{(\w+)\}/g, (match, name: string) => reason.values?.[name] ?? match)
    return reason.triggerId ? `${reason.triggerId}: ${text}` : text
  }).join('; ')
}
