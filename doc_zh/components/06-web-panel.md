# 06 web 面板与人工介入

panel（web 面板）是 DeepSeek Harness 里注入的一个 React 客户端（`src/client/`），哲学是**只展示需要人的东西**：健康状态不占空间，待办置顶（docs/000-philosophy）。

## 数据接口

- 契约：`src/app/api.ts:27` 的 `Api` 接口，纯类型定义——"METHOD path" 键映射请求/响应类型。面板直接 import 它（只引入类型，不打包宿主代码），`client/api.ts` 用它给每个调用做端到端类型检查。
- 路由：`src/app/http.ts:274` 的 `registerHttp` 在 `/orchestrator/api/*` 注册全部路由。安全三件套：**仅回环监听**（`ctx.webServer.host !== '127.0.0.1'` 直接抛错）、**同源校验**（`sameOrigin`，`src/app/http.ts:75`——Host 必须是 127.0.0.1/localhost，必须带自定义头 `x-orchestrator-request: 1`，Origin 若有必须与 Host 一致，双保险防 CSRF）、**请求体限长**（默认 128 KiB）。
- 错误映射（`failure`，`src/app/http.ts:81`）：UserError 按类别给 404/400 并带 `code`（面板按语言本地化文案）；设置/提示词冲突 409；zod 校验 400 附 issues。

## 视图与人工动作

视图层（`src/app/views/`）从 Store 派生面板数据：

- **overview**（`src/app/views/overview.ts`）：待人事项置顶——待复审的 ready 工单、待回答的 attention、blocked/failed、投递失败、不可用的评估（unavailable Decision）、setup 问题。
- **tickets**（`src/app/views/tickets.ts`）：按阶段列表 + 详情页（授权依据、Inputs、Assignments、执行环境变量）。
- **threads / decisions / sources / settings**：Thread 时间线、评估结论、每个 Source 的健康与过滤统计、设置块（带修订号乐观锁）。

人工介入动作分两类。**面板专属**（没有对应工具）：dismiss 不可用评估、重跑 setup 检查、刷新 Source 显示名、把 worker 持有的追问送回 Eval（`orchestrator_trigger_requeue` 刻意拒绝这种情况）；以及只有 panel 来源能改的字段——执行环境与账号 CLI（`USER_ERRORS.panelOnlyEnvironment/panelOnlyAccounts`，`src/core/errors.ts`）。**与主会话等价**：停止/重试工单、退订 Thread、暂停处理、改设置。

保存类动作的响应里带 `context_delivery`（`src/app/api.ts` 的 `Delivery`）——告诉面板这次变更是"已注入主会话"还是"仍在排队"，让人对 agent 的知情状态有确定预期。
