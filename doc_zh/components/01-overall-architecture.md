# 01 总体架构：bundle、Router+Worker 与 Harness 的关系

dsh-superagent 是一个运行在 DeepSeek Harness（下称 DSH）之上的 **bundle**（以插件形式打包进宿主的应用）。它监听一个 GitHub 仓库（可选加飞书），把被授权的请求变成 Ticket（工单 / work item），在独立会话与目录里完成，并在原会话里回复（例如开一个 PR）。核心思想：**占用尽可能少的人类注意力，产出尽可能多的价值**（见 `docs/000-philosophy.md`）。

## 双会话模型

整个系统由两类 DSH Session（会话）构成：

- **主会话（Router / main Session）**：编排者。它不写代码，只做四件事——接收评估候选（MasterAssessor 转发来的卡片）、路由决策（accept/attach/stop/ignore）、处理人的追问转发、回答工单的问题。工具面在 `src/app/tools/main.ts:183`（14 个 `orchestrator_*` 工具），创建时使用 `dsh-superagent-router` preset（`src/app/sessions.ts:60`）。
- **worker 会话（执行会话）**：每个 Ticket 一个，命名 `worker-<ticketId>`（`src/executor/dsh.ts:31`）。它在自己隔离的目录里干活，只允许工作类工具（`WORK_TOOLS`，`src/app/sessions.ts:84`），使用 `dsh-superagent-worker` preset。

## 分层

代码分四层，依赖单向（`docs/007-architecture.md` 的 "What may import what"）：

1. `src/core/`——领域核心，零 I/O：Engine（`src/core/engine.ts:32`）是唯一写入点，内部拆成 Intake / Evals / Tickets / Assignments / Replies 五个部件，每个命令在一个事务内完成。
2. `src/app/`——应用服务：Runtime（组合根）、Store（SQLite）、Effects（持久化副作用队列）、Sessions、MasterAssessor、Outbox 等。
3. `src/sources/` 与 `src/executor/`——Source 插件（GitHub / 飞书）与执行器实现。
4. `src/client/`——web 面板（React），只 import 宿主侧的类型（`src/app/api.ts`）。

## 与 Harness 的关系

- bundle 的接入点由 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，它向宿主注入三个插件：主插件、`./github-watch`、`./feishu-watch`（默认禁用飞书）。
- Runtime（`src/app/runtime.ts`）是组合根：锁状态目录、开 Store、构建各部件、注册管理路由与 Source host，启动后装钩子、恢复中断的 Assignment。
- Source 插件通过 `inject: ['orchestrator']` 拿到 Runtime（以窄接口 `SourceHost` 暴露，`src/sources/host.ts`），再注册自己的 `SourceKind`（`src/sources/kind.ts:122`）。

一句话总结：**DSH 提供会话与运行时，core 保证一致性与授权，Source 负责"听见"，Executor 负责"干活"，panel 负责"让人看见"**。
