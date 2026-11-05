/**
 * Per-scope admission matrix classifying incoming messages as explicit requests, inferred candidates, or ignored.
 * A listed sender who addresses the agent always makes an explicit request (no table cell); an unaddressed message cannot be explicit.
 */
// admission.ts：准入表（admission table）的取值与默认——
// 按接收范围（每个 Source 的每个"行"）把消息分为：明确请求（explicit）/ 推断候选（inferred）/ 忽略（ignore）。
// 不变量：名单内且点名的发送者永远是明确请求（不查表）；没点名的消息不可能是明确请求。
// 该文件是纯数据 + 类型，panel（web 面板）与 policy 共用。
import type { AdmissionCell } from './core/model.ts'

export type { AdmissionCell }
// Admission：格子的三种取值。
export type Admission = 'explicit' | 'inferred' | 'ignore'
// ADMISSION_OPTIONS：每个格子允许的取值——
// listedUnaddressed（名单内未点名）：inferred 或 ignore；
// unlistedAddressed（名单外点名）：explicit、inferred 或 ignore；
// unlistedUnaddressed（名单外未点名）：inferred 或 ignore。
export const ADMISSION_OPTIONS = { listedUnaddressed: ['inferred', 'ignore'], unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore'] } as const satisfies Record<AdmissionCell, readonly Admission[]>
// AdmissionRow：一行的形状——每个格子可选填（不填 = 用默认值）。
export type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number] }
/** Default admission rules (matching pre-table behavior): unaddressed messages from listed senders are inferred candidates; unlisted senders are ignored. */
// ADMISSION_DEFAULTS：默认准入规则（与"没有表"时的行为一致）——
// 名单内未点名 = inferred 候选；名单外一律忽略。
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' }
