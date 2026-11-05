# 02 Ticket 生命周期与域模型

Ticket（工单）是本项目的核心聚合：一份**被授权的**工作事项。授权由 Mandate（`src/core/model.ts:193`）承载——它记录强度（explicit/inferred）、Policy 版本、准入依据（`MandateBasis`）与范围，一旦产生永不修改；执行越界时以它为界，复核失败时工单无法恢复。

## 一生的时间线

1. **创建**：Eval 结论为 accept 时，`Tickets.create`（`src/core/tickets.ts:43`）在同一事务里落 Ticket、首个 Assignment、订阅批次 Trigger 的所有 Thread、发送确认消息，并入队启动。`ticketId = key('ticket', evalId)`（`src/core/evals.ts:348`）由 Eval id 派生，天然防重复开工。
2. **执行**：Assignment（`src/core/model.ts` 的 `Assignment`）经历 pending → running → ended。worker 通过 `orchestrator_report`（`src/app/tools/executor.ts:80`）报告 progress/waiting/ready/blocked/failed/dropped。
3. **输入**：来自 Thread 的新消息、主会话的 attach、策略变更通知都以 Input（`src/core/model.ts` 的 `TicketInput` 联合类型）进入 `undelivered` 队列，由 Executor 逐条投递（`src/executor/dsh.ts` 的 `deliverQueued`）。
4. **结束**：四条路径——`ready` 报告（无跟随 Thread 时 completed）、跟随 Thread 全部关闭（`followsDone`，`src/core/tickets.ts:131`）、`dropped` 报告、人工停止（`stopTicket`）。结束时"放手"（`letGo`，`src/core/tickets.ts`）：worker 从未收到的、没读过也没接下的真人消息回到 Eval 队列，不丢消息。
5. **恢复（resume）**：已结束的工单被其 Thread 上的真人消息唤醒（`Tickets.wake`，`src/core/tickets.ts:270`）——前提是 Mandate 复核仍通过；被人工停止的（`ended.by === 'human'`）永不自动恢复。

## 阶段与不可变量

- 阶段判定在 `ticketStage`（`src/core/stage.ts:14`），按 docs/003 的表逐行匹配：person（delivery/answer/review/blocked/failed）→ working/queued → idle → ended。面板据此决定把工单摆在哪个列表。
- 关键谓词：`waitsForPerson`（blocked/failed 后无真人消息，`src/core/model.ts:349`）、`followupOwners`（一条追问归哪些工单的 worker 决定，`src/core/model.ts:118`）、`reached`（Trigger 是否到达过某工单，`src/core/model.ts:326`）。

## 域模型纪律

- **一个状态一个写者**：Ticket/Thread/Trigger/Decision 只由 Engine 写；Source 的元数据只由该 Source 经 `SourceContext` 写（docs/007 的 "One writer per state"）。
- **幂等键**：Input id、reply id 都由 `key()`（SHA-256 截断，`src/core/ids.ts:6`）从内容派生，重复请求自然去重。
- **请求与事实**：命令用祈使句命名（`stopTicket`），适配器上报的事实用过去式（`assignmentStarted`，`src/core/engine.ts:288`）。
