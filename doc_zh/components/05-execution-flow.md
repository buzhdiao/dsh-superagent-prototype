# 05 执行流：agent session、目录隔离与 gh / lark-cli

一个被 accept 的 Trigger 如何变成一个 PR？这条执行链路全部在 `src/executor/dsh.ts`（DshExecutor，`src/executor/dsh.ts:277`）与 `src/app/sessions.ts`（Sessions，`src/app/sessions.ts:123`）。

## 启动：launch

1. `Engine` 在 accept 事务里调用 `executor.start`——只是入队一个 `launch` effect（持久化，重启可恢复）。
2. `launchQueued`（`src/executor/dsh.ts:360`）先同步预留 worker 槽位（`WorkerSlots`，`src/executor/dsh.ts:230`——防止两个启动抢最后一个槽位），再进入 `launch`（`src/executor/dsh.ts:553`）：
   - **目录准备**：工作目录不存在时跑配置的 `prepare` 命令（在父目录、带执行环境变量、限时 10 分钟），随后以 worker 视角校验目录（`prepareDirectory`，`src/executor/dsh.ts:332`）。目录已存在即视为已就绪——prepare 失败不自动重试，直接把工单标 failed。
   - **会话确保**：`sessions.ensure` 创建/解析 `worker-<ticketId>` 会话，绑定 worktree 目录，用 `dsh-superagent-worker` preset（`src/app/sessions.ts:188`）。
   - **任务投递**：首条消息带任务说明（≤1500 字）、源 Trigger 卡片与批次摘要；清理收件箱里的旧副本，保证正式投递的那份是唯一份。

## 目录隔离

每个 Ticket 一个独立 worktree（`ticketExecution`，`src/executor/dsh.ts:132`：`executionRoot(settings, stateDir)/<短名>-<ticketId 前 12 位>`）。worker 的 git 身份、gh 凭据经 `runAsWorker` 与命令 shim 收敛为 agent 账号（`src/infra/environment.ts`），GitHub 操作只走 agent 的 `gh`（环境变量 `DSH_SUPERAGENT_GITHUB_*`，`src/sources/github.ts:121`）。

## 工具面

worker 只有 6 个编排工具（`executorTools`，`src/app/tools/executor.ts:29`）：`orchestrator_read`（只读自己工单的资源）、`orchestrator_ack`、`orchestrator_report`、`orchestrator_thread_unrelated`、`orchestrator_thread_follow`、`orchestrator_trigger_handback`。加上 DSH preset 里的工作工具（文件/搜索/shell/作业/web/技能/subagent，`WORK_TOOLS`，`src/app/sessions.ts:84`）。工单一结束，守卫拒绝一切工具调用。

## 回收与恢复

- 回合结束不等于工单结束：`workerIdle`（`src/executor/dsh.ts:700`）等后台 shell 作业与 subagent 安静（至多 30 分钟），然后报 waiting、释放槽位；移交给人的作业被"收集"而非唤醒（`handOff`）。
- 瞬态网络/提供方错误退避重试（15s×2ⁿ，至多 3 次）；宿主重启后 `resume`（`src/executor/dsh.ts:677`）逐工单对账：中断的带恢复说明重启，pending 的重新入队。
- 关机时 `shutdown`（`src/executor/dsh.ts:514`）限时 10 秒停掉全部后台工作并保留收件箱。
