# dsh-superagent 中文文档（doc_zh）

本目录是 [dsh-superagent](../README.md) 的中文学习文档工程，包含四部分：

1. **[components/](components/)** —— 8 篇组件原理讲解，每篇 300–800 字，附 `文件:行号` 引用，可对照源码阅读：
   - [01 总体架构：bundle、Router+Worker 与 Harness 的关系](components/01-overall-architecture.md)
   - [02 Ticket 生命周期与域模型](components/02-ticket-lifecycle.md)
   - [03 授权模型：谁能让 agent 干活](components/03-authorization.md)
   - [04 Source 与监听：GitHub 通知、飞书事件与轮询窗口](components/04-sources-and-listening.md)
   - [05 执行流：agent session、目录隔离与 gh / lark-cli](components/05-execution-flow.md)
   - [06 web 面板与人工介入](components/06-web-panel.md)
   - [07 与 DeepSeek Harness 的 preset 集成](components/07-preset-integration.md)
   - [08 部署与运维要点](components/08-deployment-ops.md)
2. **[translations/](translations/)** —— 仓库根 [README.md](translations/README.zh.md)、[docs/000-philosophy.md](translations/000-philosophy.zh.md)、[docs/007-architecture.md](translations/007-architecture.zh.md) 的完整中文翻译。
3. **[techniques-100.md](techniques-100.md)** —— 「TypeScript 高级技法与重要库 100 讲」，恰好 100 条，每条结合仓库真实代码（`src/`、`package.json`、`cordis.patch.yml`、测试）讲解。

## 阅读顺序建议

先读 components/01 建立整体图景，再按兴趣跳读；translations/000-philosophy 与 translations/README.zh 适合第一次接触本项目时读；techniques-100.md 适合边读源码边对照。

## 术语表（首次出现的英文术语在此统一解释）

| 术语 | 含义 |
| --- | --- |
| Ticket | 工单 / work item：一份被授权的工作事项，agent 在自己的会话与目录里完成它 |
| Source | 消息来源：GitHub、飞书等接入端，负责把外部事件变成 Trigger |
| Trigger | 来源产生的一条不可变事件（评论、Issue、CI 变化等），是最小触发单位 |
| Thread | 会话线程：一个 Issue / PR / 飞书话题，Trigger 挂在其上 |
| Eval | 对一个 Thread 上排队的 Trigger 的批量评估过程 |
| Decision | Eval 的结论（accept / ignore / stop / unavailable） |
| Mandate | accept 产生的不可变授权，界定 agent 能做什么、为谁做 |
| Assignment | Ticket 与一次执行实例（worker 会话的一次运行）的绑定 |
| Session | DeepSeek Harness（DSH）里的 agent 会话；分主会话与 worker 会话 |
| preset | DSH 的 agent 预设（模型、工具等待上限等），本项目定义了 router 与 worker 两个 |
| bundle | 以 DSH 插件形式打包的完整应用（本仓库经 `cordis.patch.yml` 接入宿主） |
| Router / main Session | 主会话：编排者，决定开不开工、路由消息，不写代码 |
| Worker | 执行会话：每个 Ticket 一个，在自己的目录里真正干活 |

## 代码中文注释说明

本工程的另一部分产出是 `src/` 核心代码的逐行中文注释（Router / Worker / Ticket / Source 四大块与授权、面板数据接口，共 32 个文件、约 1600 行注释）。注释只增不改，剥离注释后与上游代码完全一致；术语保留英文，首次出现处附中文解释。
