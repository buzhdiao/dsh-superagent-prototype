# 07 与 DeepSeek Harness 的 preset 集成（dsh-superagent-worker / router）

preset（预设）是 DSH 的 agent 配置单元：模型、工具集、命令与作业的等待上限等。本项目自带两个 preset，定义在 `cordis.patch.yml`（bundle 补丁），代码里以常量引用：`ROUTER_PRESET = 'dsh-superagent-router'` 与 `WORKER_PRESET = 'dsh-superagent-worker'`（`src/app/sessions.ts:60`）。

## 谁用哪个

- 会话创建时按角色选择：`sessions.ensure`（`src/app/sessions.ts:188`）里 `agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET`。主会话 id 来自机器设置（`masterId`），worker 会话 id 是 `worker-<ticketId>`。
- **首回合前的守护**：在 Web UI 里打开一个尚未开始回合的 Session 可能把 preset 改成默认值——`agent-preset/selected` 事件钩子（`src/app/sessions.ts:166`）检测到非本项目的 preset 时自动改回。首回合之后 DSH 拒绝任何再选择，就随它去了。
- `tests/bundle-patch.spec.ts` 会把 `cordis.patch.yml` 按 DSH 的读法重新解析，校验两个 preset 的定义与 worker preset 的工具等待参数——文档与代码不同步会直接红测试。

## router preset 的等待上限与 noWait 守卫

Router preset 把 shell 命令与作业等待都压到 **5 秒**返回。原因：报告、追问转发、新候选、后台作业的结束都会自动到达主会话——等待只会推迟新候选的处理。双保险是 `noWait` 守卫（`src/app/sessions.ts:101`）：拒绝命令位置的 `sleep`（正则 `SLEEP`，`src/app/sessions.ts:92`）、超过 30 秒的 bash 超时、超过 5 秒的 `job_output` 等待。对仍运行在 `standard` preset 的旧主会话，命令必须显式限时或后台运行（`DEFAULT_WAIT` 提示）。

## worker preset 与工具收窄

worker preset 保留 DSH 的工作工具（文件、搜索、shell 及其作业、web、技能、todo、subagent）。运行时的收窄在 `decorate` 里完成：`workOnly`（`src/app/sessions.ts:356`）按"父 scope 里实际存在的"工作工具生成白名单（preset 的工具必须经父 scope 读取，全局视图看不见），并加守卫——工单结束即拒绝一切工具调用。worker 的 subagent 沿父链上溯找到所属工单，套用同样的白名单（`limitSubagent`，`src/app/sessions.ts:370`）。

## prompt 与技能的动态注入

preset 之外，每个模型请求都会重新合成系统提示段（`decorate` 里的 `systemPrompt.section`，`src/app/sessions.ts:308`）：按当前 prompt 版本合成角色文本 + 执行环境变量 + inferred 授权限制，并关闭变量插值以保住团队提示里的字面 `${{ ... }}`。技能按 prompt 版本注册（`bindSkills`，`src/app/sessions.ts:411`），版本切换即原子替换。
