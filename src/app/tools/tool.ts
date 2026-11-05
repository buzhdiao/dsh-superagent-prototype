/** Shared tool primitives and schemas for the main and executor Sessions. */
// 主会话与 worker 会话共享的工具原语与 schema。
import { z } from 'zod'
import { IM_WORDS, wordCount } from '../../infra/text.ts'
import { resourceGrammar } from '../resources.ts'

// Tool：工具的统一形状——名称、描述、zod 校验 schema、执行函数（带中止信号）。
export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>
}
// RegisterTool：向 DSH agent 注册工具的函数签名（泛型保持 schema 类型）。
export type RegisterTool = <S extends z.ZodType>(name: string, description: string, schema: S, execute: Tool<S>['execute']) => void
// tool：定义工具的便捷函数（类型擦除到非泛型 Tool，注册时再还原）。
export const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition as unknown as Tool

/** Human-facing acknowledgement text, constrained to `IM_WORDS` regardless of which channel it is posted to. */
// AcknowledgementSchema：面向人的确认文本——无论发到哪个渠道，都限制在 IM_WORDS（100）词以内。
export const AcknowledgementSchema = z.string().trim().min(1)
  .refine(text => wordCount(text) <= IM_WORDS, `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`)
/**
 * Builds the `orchestrator_read` tool, scoping allowed resource patterns to the main Session or to an
 * Executor Session (which may read only its own ticket and messages that reached it).
 */
// readTool：构造 orchestrator_read 工具——
// executor=true 时资源语法限定为该 worker 自己的 Ticket 与到达它的消息；
// offset/limit 控制分页（文本按字符、列表按条）。
export function readTool(description: string, executor: boolean,
  read: (resource: string, offset: number, limit: number | undefined, signal: AbortSignal) => Promise<unknown>): Tool {
  return tool({
    name: 'orchestrator_read',
    description,
    schema: z.object({
      resource: z.string().min(1).describe(`The resource, one of: ${resourceGrammar(executor)}.`),
      offset: z.number().int().min(0).default(0).describe('Copy next_offset from the previous page; it counts characters of a text and items of a list.'),
      limit: z.number().int().min(1).max(8000).optional()
        .describe('Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.'),
    }).strict(),
    execute: async (args, signal) => read(args.resource, args.offset, args.limit, signal),
  })
}
