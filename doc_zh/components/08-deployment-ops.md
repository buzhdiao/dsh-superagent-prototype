# 08 部署与运维要点

完整的手工部署步骤在 [SETUP.md](../SETUP.md) 与 [docs/006-deployment.md](../docs/006-deployment.md)；本篇讲清"为什么这么部署"——每个要求对应的代码机制。

## 前置与账号

- **Node 版本**：`package.json` 的 engines 要求 `^22.19.0 || >=24.0.0`，包管理器钉死 `pnpm@11.7.0`；DSH 宿主版本 `^0.2.1-alpha.2`。
- **两个账号，两条 CLI**：GitHub 用 gh 包装脚本（`GH_CONFIG_DIR` 登录 agent 账号）；飞书用 strict mode bot 的 lark-cli。部署原理：`src/deployment.ts` 的 `resolveDeployment` 像 worker shell 那样实际调用 CLI 验证（能读到登录账号、能推送目标仓库），`SETUP_FIELDS` 列出 setup 关心的字段——**这些字段只能从面板改**（`USER_ERRORS.panelOnlyAccounts`），改动会触发 dsh-superagent 重启以重跑 setup。
- **状态目录**：`stateDir` 是唯一非易失配置。Runtime 启动先拿目录锁（`proper-lockfile`），防止第二个进程迁移/写同一个库（docs/007 "Store"）；SQLite 库 `<stateDir>/orchestrator.sqlite` 只由 Store 打开。

## 配置如何生效

除 `stateDir` 外所有插件配置都是易失的（volatile）：宿主改 `cordis.patch.yml` 的值就地更新，dsh-superagent 每次使用时重读（docs/007 "Configuration reload"）——改轮询间隔、并发上限等**不需要重启**。设置面板的保存带修订号（乐观锁），冲突返回 409。

## 健康与排障

- 健康条目一人一条、一人一写（`HealthBoard`，`src/infra/health.ts`）：runtime、evals、models、每个 effect kind、worker、每个 Source kind、`sync:<id>`。面板的 overview 与 `scripts/dsh-superagent status`（读 `/orchestrator/api/state`）都能看到。
- **GitHub 轮询失败**：单次网络中断自动重试；连续失败达 `failuresBeforeError` 才报 error（`pollFailure`，`src/sources/github.ts:136`）。永久读不了的 Thread 24 小时后放弃重试，不把健康钉死在 error。
- **模型预算重试**：`models` 健康条目列出在等预算的会话（`RetryHealth`，`src/app/sessions.ts`）。
- **暂停**：处理暂停时 launch/delivery/评估全部挂起，Eval 不过期（deadline 顺延暂停时长，`src/core/evals.ts:35`）——恢复后不丢工作。

## 升级与数据

- Schema 迁移只有一条路：schema 10 → 11 的一次性转换（`src/app/migration.ts`），更老的库拒绝启动；`SCHEMA_VERSION` 只增不减。
- 无自动清理：trigger/disposition/decision、已结束工单、发件箱回执、设置历史都无限增长——运维上要留意磁盘。
- 用真实数据复查改动：把 `DSH_HOME` 指到临时目录，拷贝备份库、禁用全部 Source、暂停处理、删除主会话 id，给两个 CLI 只读替身（docs/007 末节）。
