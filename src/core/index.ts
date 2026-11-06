/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
// 可复用的主动式代理（proactive agent）核心：模型、端口（ports）、引擎与内存仓储。
export * from './model.ts'
// 导出领域模型。
export * from './ports.ts'
// 导出端口接口。
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForSettings, type EngineForSources,
  type EngineOptions, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
// 导出引擎及其面向各使用方的能力切片类型。
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
// 导出用户可见错误。
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
// 导出原因结构与文案。
export { MemoryRepositories } from './memory.ts'
// 导出内存仓储实现。
export { canRetry, ticketStage, type TicketStage } from './stage.ts'
// 导出工单阶段与重试判断。
export { key } from './ids.ts'
// 导出 id 生成工具。
