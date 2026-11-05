# 03 授权模型：谁能让 agent 干活

授权（authorization）回答一个问题：**谁、以何种强度、在哪范围内**能让 agent 开工。它由三层机制共同回答，全部实现在 `src/policy.ts` 与 `src/admission.ts`。

## 第一层：Source 的监听范围（scope）

一条消息先要被"听见"。`SourceRegistry.scope`（`src/sources/registry.ts:244`）把判断委托给各 kind：GitHub 靠通知（天然只收点名）加四个"观察"开关（`src/sources/github.ts:77` 的 `scope`）；飞书靠群配置（仅 @ / 全部消息）与私聊开关（`src/sources/feishu.ts:74`）。未被监听的消息只留下 `filtered` 记录，不进领域。

## 第二层：准入表（admission table）

被听见的消息再由"门"（gate，`settingsPolicy` 返回的 `gate`，`src/policy.ts:221`）分类。格子按 **发送者是否在名单 × 是否点名 agent** 划分（`src/admission.ts`）：

- `listedUnaddressed`（名单内、未点名）：inferred 或 ignore；
- `unlistedAddressed`（名单外、点名）：explicit / inferred / ignore；
- `unlistedUnaddressed`：inferred 或 ignore。
- **不变量**：名单内且点名的发送者永远构成 explicit（`via: 'addressed'`），不查表；未点名的消息永远不可能是 explicit。

强度之外还有追问路径：消息到达已有真工单（非仅上下文）的 Thread 时，`via: 'followup'` 直接放行给该工单的 worker——但 inferred 追问在 eval 模式为 off 时不成立（`src/policy.ts:236`）。

## 第三层：评估结论校验与 Mandate 复核

- 主会话的评估必须覆盖每条启用规则恰一次、方向成立（`directionAllowed`，`src/policy.ts:26`）、有意图证据（`assessmentOutcome`，`src/policy.ts:52`）。**inferred 候选只在 `auto` 模式接受**，observe 模式记 `would_accept` 不开工。
- Mandate 复核（`revalidate`，`src/policy.ts:243`）：工单恢复、被附加消息前，按当初的准入依据（`via`）在当前 Policy 下重验——名单还在吗、规则还启用吗、模式还是 auto 吗。失败则工单保持结束并"放手"。

## 变更的传播

Policy 改版由 `policyVersion`（规则+模式+各 Source 部分，`src/policy.ts:148`）哈希捕捉；`policyEffects`（`src/policy.ts:187`)逐工单算影响（规则变更/失效、发送者失权、inferred 停收），`Engine.policyChanged`（`src/core/engine.ts:266`）把影响作为 policy-changed Input 送进 worker，进行中的 Eval 作废重评。

人的控制权贯穿始终：面板可暂停（paused）、停止工单、重评、退订；主会话对人可以做的事永远小于或等于面板能做的事（docs/007 的 "Panel-only actions"）。
