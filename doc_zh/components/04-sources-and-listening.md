# 04 Source 与监听：GitHub 通知、飞书事件与轮询窗口

Source（消息来源）是系统与外界的唯一接口。每种来源实现一个 `SourceKind` 插件契约（`src/sources/kind.ts:122`）：身份与配置 schema、面板表单（`fields`）、监听规则（`scope`）、回写通道（`channel`）、评估用的有界上下文读取器（`threadContext`）、可选的 Policy 部分（允许名单/准入表行/名单同步）。

## 注册与宿主

插件在 Cordis 的 `apply` 里注册：GitHub（`src/sources/github.ts:123`）与飞书（`src/sources/feishu.ts:138`）都注入 `orchestrator`（Runtime 的 `SourceHost` 视图），调 `SourceRegistry.register`（`src/sources/registry.ts:29`）。注册时在 HealthBoard 上独占声明健康条目，注销即失效——注销后再上报是空操作，不会串到重新注册的新条目（`healthEntries`，`src/sources/registry.ts:40`）。

## GitHub：通知为主干，轮询为兜底

一轮轮询（`pollRound`，`src/sources/github.ts:391`）依次做四件事，各步骤独立失败：

1. **通知**（`pollNotifications`，`src/sources/github.ts:409`）：读 agent 账号的通知流，逐个读取其 Issue/PR 的新评论与正文；上轮失败的重试项优先，24 小时后放弃（`RETRY_WINDOW_MS`）。
2. **仓库级流**（`pollRepository`）：观察开关打开时读 `/issues`、会话评论、行内评审评论；游标推进用 `cursorAt`（回拨 5 秒防迟到事件，`src/sources/poll.ts:16`），靠 Trigger id 确定性派生去重；游标未动时带上 ETag，无变化返回 HTTP 304 不耗配额（`readStream`，`src/sources/github.ts:214`）。
3. **工单 PR + CI**（`pollTicketPulls`/`pollChecks`，`src/sources/github.ts:515`）：以检查快照哈希为指纹，变化才发 Trigger。
4. **已订阅 Thread**（`pollThreads`）：窗口内逐个补读。

## 飞书：事件消费 + 历史补收

三个循环并行（`runFeishu`，`src/sources/feishu-loops.ts:18`）：lark-cli 子进程的事件消费者（45 秒未 ready 即重启，`consume`）、每分钟一轮的历史补收（`backfillLoop`，从上次游标拉群与活跃话题的增量）、每分钟的群名刷新。话题表 `{话题id: 最后活跃}` 超过窗口且无人订阅即修剪。

## 共享的窗口逻辑

`src/sources/poll.ts` 提供 GitHub 与飞书共用的三件套：`POLL_HORIZON_MS`（14 天）——没有存活工单的已订阅 Thread 在最后一次活动后仍轮询两周；`polled` 判断是否值得轮；`pause` 用全局 setTimeout（测试的假时钟可驱动）。
