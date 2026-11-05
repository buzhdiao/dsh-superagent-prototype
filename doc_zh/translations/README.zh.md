# dsh-superagent（README 中文翻译）

> 本文件是仓库根 [README.md](../../README.md) 的完整中文翻译；如有出入以英文原文为准。

> **研究原型，仅供参考，非 DeepSeek 官方产品。** 这份代码源自我们团队的日常工作，其中大量工程由编码 agent 完成。请把它当作研究代码，而非可用于生产的软件。它可能仍包含缺陷，其代码风格与工程实践也可能不一致。在自己的环境中使用前，请先审阅并调整。
>
> 我们为发布做了适配，因此它与我们的内部版本、以及《探索超级智能体设计：迈向更自主的智能体系统》一文所描述的实现并不完全一致。文中讨论的部分设计是未来方向，本原型尚未实现。

dsh-superagent 是面向单个 GitHub 仓库的主动式编码 agent（proactive coding agent），以 bundle 形式打包进 [DeepSeek Harness](https://www.deepseek.com/en/harness/)。它监听 GitHub，可选监听飞书。当被允许的人向 agent 提出工作请求时，它会开一个工单（work item），在自己的 agent 会话与目录中完成它，并在原会话里答复——例如给出一个 pull request。一个 web 面板展示需要人来处理的事情。

它也是一种与 agent 共事的方式：**占用尽可能少的人类注意力，给出尽可能多的价值。** 一个能为整个团队行动的 agent，也能浪费整个团队的注意力；因此它只在被要求时、或在团队写下的规则允许时行动，只在必须有人行动、或有人能用到结果时发言。[docs/000-philosophy.md](../../docs/000-philosophy.md) 解释了这条原则以及对运营者的要求。

## 安装

安装步骤很多，所以由 agent 陪你完成。对你的编码 agent 说：

> 读这个仓库里的 SETUP.md，和我一起安装配置 dsh-superagent。

它一次只问一个简短的问题，先完整展示计划，然后安装并配置一切。[SETUP.md](../../SETUP.md) 就是它遵循的脚本。

## 文档

按编号顺序阅读；每篇只建立在它之前的那些之上。

- [000 哲学](000-philosophy.zh.md)（[英文](../../docs/000-philosophy.md)）
- [001 领域模型](../../docs/001-domain.md)
- [002 授权](../../docs/002-authorization.md)
- [003 执行](../../docs/003-execution.md)
- [004 提示词](../../docs/004-prompts.md)
- [005 面板](../../docs/005-panel.md)
- [006 部署](../../docs/006-deployment.md)：手工安装、配置、升级与排障
- [007 架构](007-architecture.zh.md)（[英文](../../docs/007-architecture.md)）
- [008 烹饪书](../../docs/008-cookbook.md)：添加一个 Source

## 开发

`pnpm check` 依次运行类型检查、测试与构建。

## 许可证

[MIT](../../LICENSE)

---

## 中文学习文档（doc_zh）

本仓库还包含一套中文学习文档，见 [doc_zh/README.md](../README.md)：组件原理 8 篇、本 README 与两篇核心文档的中文翻译、以及「TypeScript 高级技法与重要库 100 讲」。
