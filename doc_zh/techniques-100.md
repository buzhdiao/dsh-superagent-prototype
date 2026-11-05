# TypeScript 高级技法与重要库 100 讲

本讲结合 dsh-superagent 仓库的真实代码（`src/`、`package.json`、`cordis.patch.yml`、`tests/`），恰好 100 条。术语保留英文，首次出现附中文解释。真实依赖：`zod@4`、`proper-lockfile`、`@deepseek-ai/cordis`（DI 容器与插件机制）、`@deepseek-ai/dsh-*`（DeepSeek Harness 宿主包）、`react@18`、`tsdown`、`vitest`、TypeScript 6、Node ≥22（`node:sqlite` 内置）。

## 一、类型系统与类型体操（1–20）

1. **`satisfies`：校验而不拓宽**。`USER_ERRORS` 用 `as const satisfies Record<string, readonly ['missing' | 'refused', string]>`（`src/core/errors.ts:50`）——既保留每个 key 的字面量类型（`keyof typeof USER_ERRORS` 可用），又强制每项形如 `[类别, 文案]`。`ADMISSION_OPTIONS` 同法（`src/admission.ts:19`）。
2. **由字符串模板派生参数类型**。路由键 `"GET tickets/:id"` 经 `Path<K>`/`Params<P>` 两个条件类型递归抽出 `{ id: string }`（`src/app/api.ts` 底部），调用方拿到的参数类型与路由字符串永远一致。
3. **`as const` + 索引访问造字面量联合**。`TICKET_FILTERS = [...] as const`，再 `type TicketFilter = typeof TICKET_FILTERS[number]`（`src/app/api.ts:16`）——数组和类型共用一份清单，测试可校验两者不漂移。
4. **`Extract` 收窄联合**。`Extract<AssessmentOutcome, { kind: 'accept' }>`（`src/core/engine.ts:120`）从四态结论中精确取出 accept 形状，避免重复声明。
5. **`Exclude` 从键集中剔除非字段**。`type Field = Exclude<keyof RouteItem, 'kind' | 'trigger_id'>`（`src/app/tools/main.ts:59`），随后用它建 `FIELDS` 表，编译器保证表覆盖所有字段。
6. **函数返回类型作类型来源**。`type AssessmentContext = Awaited<ReturnType<typeof admissionContext>>`（`src/app/assessment.ts:40`）——不手写上下文类型，实现改了类型自动跟。
7. **`Pick` 做角色接口**。Engine 对外只给 `EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>` 等五个子集（`src/core/engine.ts:321`）；`ExecutorHost`、`SessionsHost` 同法——窄接口即最小权限。
8. **`Omit<Api[K], 'response'>` 组装请求类型**。`ApiRequest<K> = RouteParams<K> & Omit<Api[K], 'response'>`（`src/app/api.ts`）——契约表一个键同时描述请求与响应。
9. **可辨识联合（discriminated union）建模领域**。`TicketInput`、`AssessmentOutcome`、`GateResult`、`MandateBasis` 全是带 `kind`/`via`/`admissible` 判别键的联合（`src/core/model.ts`、`src/core/ports.ts:7`）；`switch` + `never` 检查穷尽性。
10. **交叉类型组合 basis**。`MandateBasis = Received & { sender?; rules? } & ( | { via: 'addressed'; ... } | ... )`（`src/core/model.ts:116`）——公共字段写一次，每个 `via` 分支只写差异。
11. **`(string & {})` 允许"自定义枚举"**。`Reason { code: ReasonCode | (string & {}) }`（`src/core/reasons.ts:29`）——IDE 仍会补全 `REASONS` 的键，但不拒绝任意字符串（Source 会给自己的代码）。
12. **泛型约束保住 schema 推断**。`tool = <S extends z.ZodType>(d: Tool<S>): Tool => d as unknown as Tool`（`src/app/tools/tool.ts:17`）——定义处保留 schema 类型供注册器 `schema.parse(args)` 用，注册时擦到统一 `Tool`。
13. **显式注解让 zod 推断"受控"**。`AdmissionRowSchema: z.ZodType<AdmissionRow>`（`src/admission.ts:11`）——先写目标类型再写 schema，zod 推断与手写类型互相校验，防止宽松推断。
14. **`readonly` 与 `ReadonlyMap` 防写**。`policyChanged(from, to, effects: ReadonlyMap<string, PolicyEffect>)`（`src/core/engine.ts:266`）、`REASONS` 等表用 `as const`——核心不允许调用方顺手改参数。
15. **`nullish` 三态参数**。worker 报告的 `question?: string | null | undefined`（`src/core/assignments.ts:15`）：`undefined`=保持、`null`=清除、字符串=更新——一个可选字段表达三种指令。
16. **类型谓词守卫**。`transient(error): boolean`（`src/executor/dsh.ts:50`）与 `directionAllowed(value): value is AdmissionDirection`（`src/policy.ts:26`）把"运行时检查"提升为"类型收窄"。
17. **`WeakSet`/`WeakMap` 挂元数据不拦 GC**。`cancelled = new WeakSet<Agent>()`、`joins = new WeakMap<Agent, Promise<boolean>>`（`src/executor/background.ts:46-48`）——agent 被销毁后这些记录自动消失。
18. **`declare module` 扩宿主事件表**。`declare module '@deepseek-ai/cordis' { interface Events { 'agent-preset/selected'(...) } }`（`src/app/sessions.ts:49`）——TS 的声明合并让第三方事件获得完整类型。
19. **`import type {}` 只触发副作用与类型环境**。`import type {} from '@deepseek-ai/dsh-host-webserver'`（`src/app/http.ts:5`）——不引入运行时依赖，只为 `ctx.webServer` 带来类型。
20. **内容派生幂等键**。`key(...values) = sha256(JSON.stringify(values)).slice(0, 32)`（`src/core/ids.ts:6`）——用内容哈希代替自增 id，Input/reply 的去重靠"同内容同 id"免费获得。

## 二、zod 校验与 schema 设计（21–35）

21. **schema 即文档**。每个字段 `.describe('...')` 写清规则与反例（如 `WorktreeNameSchema` 的"1–4 个小写英文单词"，`src/app/assessment.ts:19`），面板直接渲染描述当提示。
22. **`.strict()` 关闭多余键**。全部输入 schema（43 处 `strict()`）拒绝未声明字段——LLM 多吐的字段立刻 400，而不是被静默忽略。
23. **`z.looseObject` 读外部 API**。GitHub 通知、飞书群列表字段多且会变，用 loose（`src/sources/github.ts:21` 的 `NotificationSchema`）只挑所需、放过其余。
24. **`z.catchall` 容纳扩展字段**。`SourcePolicySchema` 声明 `allowed`/`admission` 后 `.catchall(z.unknown())`（`src/policy.ts:77`）——`bots` 等 kind 专属字段原样透传给 kind 校验。
25. **跨字段校验 `superRefine`**。`EvalReadSchema` 检查 `path` 只配 file/directory、`cursor` 只配 thread、`image_id` 只配 image（`src/app/assessment.ts:75`）——把"参数组合"的约束放进行校验，处理器可以放心假设。
26. **`.refine` 承载业务不变量**。接受结论必须"方向成立且至少一条规则命中时给出 worktree 名"（`src/app/assessment.ts:33`）；`assessmentOutcome` 再做第二道覆盖校验（每条启用规则恰一次，`src/policy.ts:44`）。
27. **`z.templateLiteral` 校验路径参数**。`source:<id>` 块名用 `z.templateLiteral(['source:', z.string().regex(...)])`（`src/app/http.ts:177`）——正则与模板字面量类型同源。
28. **`z.coerce` 防脏 query 打 500**。`offset = z.coerce.number().int().nonnegative().catch(0)`（`src/app/http.ts:138`）——字符串转数、非法落默认，面板乱传参数也不崩。
29. **`safeParse` 区分"校验失败"与"程序错误"**。存储配置 `safeParse` 失败回退 schema 默认并禁用实例（`src/sources/registry.ts:134`）；而内部不变量被破坏时用 `parse` 让它大声炸（fail fast）。
30. **先 `safeParse` 后决定是否提交**。`policyPart` 对已存 Policy 部分用 `safeParse`，坏了给空默认（`src/sources/registry.ts:68`）——坏配置不阻塞读路径。
31. **schema 派生默认值**。`FeishuConfigSchema.parse({})` 当禁用时的兜底配置（`src/sources/feishu.ts:128`）——默认值只在 schema 一处声明。
32. **`.default(() => …)` 延迟构造**。`SettingsSchema` 的嵌套块用 `.default(() => PolicyConfigSchema.parse({}))`（`src/policy.ts:102`）——每次缺省新建，避免共享可变默认。
33. **一个表，两种读者**。`ADMISSION_OPTIONS` 同时服务 Policy 校验（可选值集合）与面板表单（下拉选项），`satisfies` 保证两边不漂移（`src/admission.ts:19`）。
34. **zod + JSDoc 双保险**。`tests/model-surface.spec.ts` 校验模型读到的一切（工具、提示、技能）不超大小预算、与词汇表一致——schema 校验运行时，测试校验"表面"不漂移。
35. **错误即数据**。`UserError(code, values)` 携带代码与插值（`src/core/errors.ts:54`），HTTP 层只查 `missing` 标志定 404/400，面板按 code 本地化——错误不是字符串，是可编程的记录。

## 三、异步、事务与错误处理（36–50）

36. **同步事务模型**。Engine 所有方法同步，`repo.atomic(() => …)` 包住一个命令（`src/app/store.ts:140`）——不需要 async 事务协调，副作用在事务内"入队"、提交后才执行（`afterCommit`），天然避免半提交。
37. **副作用队列兜住"提交后执行"**。`Effects.enqueue` 在事务内写一行，提交后处理器才跑（`src/app/effects.ts:46`）；抛 `Later` 表示"稍后再来"不计失败（worker 槽位满、处理暂停）。
38. **`Promise.allSettled` 隔离并行循环**。飞书三个后台循环互不拖垮（`src/sources/feishu-loops.ts:18`）；GitHub 一轮里每个 Issue/PR 独立失败（`pollRound`，`src/sources/github.ts:391`）。
39. **`Promise.race` 实现可中止等待**。`until(work, signal, ms)`（`src/executor/background.ts:36`）——一个手动 resolve 的"停止 Promise"与工作竞速，finally 里清理监听。
40. **指数退避与放弃窗口**。effect 重试 `retry: [5000, 300_000]`；GitHub 通知重试 24 小时后放弃（`RETRY_WINDOW_MS`，`src/sources/github.ts:156`）——不让永久坏掉的目标把健康钉死在 error。
41. **错误分类决定重试**。`transient()` 识别 408/429/5xx 与连接类错误（`src/executor/dsh.ts:50`）；瞬态重试三次，`PrepareFailed` 这类"重试会错上加错"的立即标 failed。
42. **`AggregateError` 汇总部分失败**。杀多个 shell 作业时收集全部失败再统一抛（`src/executor/background.ts:157`）——一个失败不吞掉其他失败的信息。
43. **`AbortSignal.any` + `AbortSignal.timeout` 组合取消源**。prepare 命令同时听宿主生命周期、调用方信号与超时（`src/executor/dsh.ts:343`）——Node 22 的取消原语让"谁可以叫停"显式化。
44. **`timer.unref()` 不拦进程退出**。重试定时器与后台查看定时器都 unref（`src/executor/dsh.ts:668`、`src/executor/background.ts:42`）——关机路径不被散落的 timer 拖住。
45. **`afterCommit` 防幽灵取消**。停止 worker 的动作放在 `store.afterCommit(() => …)`（`src/executor/dsh.ts:478`）——事务回滚时 worker 继续干活，同事务入队的 launch 也先于此执行。
46. **串行化事件流**。飞书事件逐行到达，用 `chain = chain.then(...)` 串成链（`src/sources/feishu-loops.ts:87`）——单个事件失败报健康，不乱序、不断流。
47. **"守卫函数"模式**。`live()`、`current()` 这类闭包在每个 await 之后重读最新状态并校验授权（`src/executor/dsh.ts:556` 的 `current`）——长流程里每一步都重新确认"这事还该不该做"。
48. **失败降级为记录而非崩溃**。逃出轮询循环的异常记入 Source 健康（`src/sources/github.ts:130`）——未处理 rejection 会杀死 DSH 进程，所以宁记勿抛。
49. **404 vs 400 的语义分层**。`UserError.missing`（引用不存在的状态）→ 404；`refused`（规则拒绝）→ 400（`src/app/http.ts:88`）——调用方（agent）能从状态码分辨"重试无用"还是"换个做法"。
50. **结构化错误的本地化**。面板按 `code` 显示中英文文案，英文模板供日志与 agent（`src/core/errors.ts`）——同一条错误，三种读者（人/agent/日志）各取所需。

## 四、进程管理与 Node API（51–62）

51. **子进程即事件流**。飞书事件消费者 `spawn(cli, ['event','consume',...])` + `createInterface` 逐行读 stdout/stderr（`src/sources/feishu-loops.ts:70`）——把长连接事件流当文本协议处理，调试可用 `cat`。
52. **就绪探测与强杀**。45 秒内 stderr 未出现 `[event] ready` 就 SIGTERM 重启（`src/sources/feishu-loops.ts:78`）——不信任"看起来在跑"的子进程。
53. **`node:sqlite`（DatabaseSync）内置数据库**。Store 直接用 Node 22+ 的同步 SQLite（`src/app/store.ts:2,60`）——零原生依赖，`atomic` 用其事务，避免 better-sqlite3 的编译成本。
54. **目录锁防双进程**。Runtime 启动先 `lockSync(stateDir)`（`src/app/runtime.ts:15`，proper-lockfile）——迁移与写入前先独占，第二个进程起不来而不是坏数据。
55. **`Intl.Segmenter` 正确数中文词**。`IM_WORDS` 词数上限用 `new Intl.Segmenter('zh', { granularity: 'word' })`（`src/infra/text.ts:2`）——正则按空格分词对中文失效，这是确认类消息 100 词上限的基础。
56. **`Intl.RelativeTimeFormat` 本地化时间**。面板"3 分钟前"用 `Intl.RelativeTimeFormat`（`src/client/text.ts:51`）。
57. **`structuredClone` 做内存仓储的深拷贝**。`MemoryRepositories` 的每次读写都克隆（`src/core/memory.ts:5`）——测试里模拟"存储返回独立副本"的语义。
58. **环境变量的进程级隔离**。worker 的 git/gh 身份经 `runAsWorker` 与命令 shim 注入环境（`src/infra/environment.ts`），prepare 命令拿到 `DSH_SUPERAGENT_*` 变量（`src/sources/github.ts:100`）——权限收敛靠环境，不靠提示词自觉。
59. **`--include` 抓 HTTP 头**。gh api 的轮询用原始输出拆出 `x-poll-interval` 与 `etag`（`src/sources/github.ts:219`）——尊重 GitHub 的速率建议、复用条件请求。
60. **ETag 条件请求省配额**。游标未变时带 `If-None-Match`，304 直接返回（`src/sources/github.ts:211`）——轮询系统的成本控制写在读取路径里。
61. **`replaceAll` 与正则的边界**。中文 @ 名替换用 `replaceAll(mention.key, ...)`（`src/sources/feishu-trigger.ts:20`）；老记录字段重命名用带 `\b` 与 lookbehind 的正则（`src/app/migration.ts:279`）——字面替换与模式替换各取所长。
62. **`setTimeout` 的可测试性**。轮询停顿 `pause()` 刻意用全局 setTimeout 而非 `timers/promises`（`src/sources/poll.ts:33`）——vitest 的假时钟才能驱动整个轮询循环。

## 五、事件驱动、DI 与插件机制（63–74）

63. **cordis 的 effect/apply 插件模型**。Source 插件 `apply(ctx)` 里用 `ctx.effect(() => …, 'name')` 注册启动/停止对（`src/sources/github.ts:112`）——DI 容器管生命周期，插件只声明"我要什么、我提供什么"。
64. **`inject: ['orchestrator']` 声明依赖**。插件不 import Runtime，而是声明需要 `orchestrator` 服务，宿主注入（`src/sources/github.ts:111`）——依赖倒置在插件层面的实现。
65. **服务发现用窄接口**。`ctx.get('jobs') as Jobs | undefined`（`src/executor/background.ts:29`）——对 DSH 服务只声明自己用到的方法，服务缺席时优雅降级（没有 jobs 服务 = 没有后台作业）。
66. **事件订阅即登记 disposers**。`DshExecutor.install` 把每个 `ctx.on` 的退订函数推进 `disposers`（`src/executor/dsh.ts:618`）；Sessions 同法（`bindings`）——谁注册谁登记，注销时逆序（LIFO）释放。
67. **注册即认领，重复即拒绝**。`SourceRegistry.register` 在 HealthBoard 上独占健康条目，`sync:` 前缀保留给 Settings（`src/sources/registry.ts:29`）——用"注册时冲突检查"代替运行时互相踩踏。
68. **失效引用优于悬空引用**。注销后再上报健康是 no-op：SourceContext 只持有注册时拿到的条目（`src/sources/registry.ts:40`）——生命周期错序时不产生副作用。
69. **组合根不含规则**。Runtime 只做"构建、接线、启动、停止"（`src/app/runtime.ts`）；领域规则全部在 core——找规则只看 `src/core`。
70. **每两秒一个"心跳 pass"**。`Passes` 合并并发请求为一次补跑（`pumpAgain`，`src/app/passes.ts:56`）——低频轮询 + 按需唤醒，不用事件风暴。
71. **`ordered` effect 保序**。relay/notice 处理器声明 `{ ordered: true }`（`src/app/sessions.ts:104`）——转发主会话的消息必须按入队顺序到达。
72. **同名合并（coalescing）通知**。`Notice` 的 `name` 是合并键：设置连续保存只提醒最新一次（`src/app/notices.ts:22`）；需要每次送达的回执用随机键（`receiptNotice`，`src/app/notices.ts:39`）——用键的形状表达合并策略。
73. **按请求 id 幂等投递**。`AgentDelivery` 用 `key(requestId)` 保证跨恢复的会话也至多投一次（`src/app/delivery.ts`、`src/app/sessions.ts:169`）——幂等键穿透进程重启。
74. **声明合并扩展事件类型**（见第 18 条的机制，应用于实践）：`agent-preset/selected` 事件的发布方在宿主，订阅方在 `sessions.ts:124`——两端类型同源。

## 六、持久化与数据建模（75–85）

75. **生成列 + 索引 = 活跃工作集**。`thread.active`、`ticket.open/active` 由 JSON 生成并建索引（docs/007 Persistence）——`evaluateDue` 每两秒只扫"有活干的"行。
76. **时间戳统一 ISO 字符串比较**。`isoTime` 规范化后，`a.at.localeCompare(b.at)` 即时间比较（`src/core/model.ts:17`、`src/core/tickets.ts:136`）——SQL 与内存共用同一套排序。
77. **游标 = `<时间>|<id>`**。Thread 时间线分页用复合游标，同时刻的 Trigger 不被跳过（docs/007 Persistence 的 `trigger_thread`）。
78. **一个状态一个写者**。每张表/每族 KV 的写者唯一并写进类型（`KV` 家族声明，`src/kv.ts`；测试 `store.spec` 校验键只出现在 `kv.ts` 与迁移中）——并发写冲突在结构上不可能。
79. **数据迁移只有一条路**。schema 10 → 11 一次性转换，更老拒绝启动，`SCHEMA_VERSION` 只增（`src/app/migration.ts`、docs/007）——迁移路径线性，测试覆盖"每条记录的当前形状"。
80. **历史即版本链**。设置与提示词用编号快照（`Versions`，`src/app/versions.ts`）；每个 Session 工作过的提示修订持久化，`mayRead` 用它授权读历史（`src/app/sessions.ts:196`）。
81. **乐观并发控制**。设置保存带 `revision`，冲突 409（`src/app/http.ts:89`、`SettingsConflict`）——面板与 agent 并发编辑靠版本号仲裁。
82. **读查询与写仓储分离**。`storeReads` 提供只读视图查询，类型上就写不了（docs/007 Store）——"看到的数据"与"改动的数据"走不同的门。
83. **KV 记录带所有者**。`KV` 每族记录声明 owner（`src/kv.ts`）——谁的数据谁清理，孤儿键可审计。
84. **无界增长的显式清单**。哪些表会无限增长写进文档（trigger/disposition/decision/回执/设置历史，docs/007 末节）——运维预期是交付物的一部分。
85. **缓存有界且可弃**。`TextCache` 限量、LRU 淘汰、重启即失（`src/app/cache.ts`）——缓存语义（"丢了也不坏"）在类型与文档里都成立。

## 七、React 面板与前端工程（86–92）

86. **类型化 API 客户端**。`client/api.ts` 以 `Api` 契约类型化每个调用与轮询——后端改路由，前端编译错（`src/app/api.ts` + `src/client/api.ts`）。
87. **Context 收敛宿主能力**。`provider.tsx` 把 copy/调用/导航/通知/轮询/重启放进一个 Context（`src/client/provider.tsx:82`），页面只 `useContext`。
88. **`useMemo` 稳定回调对象**。`const call = useMemo(() => caller(...), [])`（`src/client/provider.tsx:82`）——轮询注册只发生一次。
89. **草稿状态用 reducer**。设置草稿 `draftReducer` 管状态机（编辑/保存中/冲突/合并新修订），保存栏文案是状态的纯函数（`src/client/draft.tsx`）。
90. **控件本地副本解耦上游**。`controls.tsx` 复刻 DSH 控件的标记与键盘行为，因为 bundle 不 import 上游 primitives 包（`src/client/controls.tsx`）——用测试（`controls.spec.tsx`）锁住行为一致。
91. **纯函数做视图计算**。`prompt-config.ts` 的分段配置与行级 diff 全是纯函数，`prompt-config.spec.ts` 直接测（`src/client/prompt-config.ts`）。
92. **样式即文本模块**。`client.css` 经 `css.d.ts` 声明为字符串模块加载（`src/client/css.d.ts`）——面板样式走宿主注入而非构建器。

## 八、工程化：构建、测试与包管理（93–100）

93. **多入口构建**。`tsdown.config.ts` 产出主入口 + `github-watch`/`feishu-watch`/`client`，与 `package.json` 的 `exports` 一一对应（`package.json` 的 `files` 同时声明 `prompts/`、`skills/`、`locale/` 为运行时资产）。
94. **peerDependencies 声明宿主**。20+ 个 `@deepseek-ai/dsh-*` 包全部是 peer（`package.json`）——bundle 不自带宿主，版本对齐由安装环境保证。
95. **pnpm 精确锁版本**。依赖一律精确版本（`"zod": "4.4.3"`），`packageManager: "pnpm@11.7.0"` 钉住包管理器——研究原型的可复现优先。
96. **测试金字塔按"表面"组织**。60 个测试文件：领域规则（内存仓储）、HTTP 契约、面板页面（假管理 API 按路由应答）、迁移、并发、以及 `docs.spec` 校验文档链接与表格完整性（docs/007 Tests 表）。
97. **假宿主做集成测试**。`tests/fixtures/host.ts` 模拟 DeepSeek Harness 宿主——`runtime.spec` 经工具与 HTTP 测整个应用，不启真宿主。
98. **元测试防漂移**。`class-docs.spec` 强制每个类有 JSDoc；`bundle-patch.spec` 按 DSH 的读法解析 `cordis.patch.yml` 校验 preset；`model-surface.spec` 限制模型表面大小（docs/007）——约定写成测试。
99. **`pnpm check` 一条命令三件事**。`typecheck && test && build`（`package.json` scripts）——CI 与本地同一入口，构建失败也算 check 失败。
100. **文档与代码同仓演进**。编号文档（000–008）只链接更早的篇章、`docs.spec` 校验链接可解析且架构文档的模块/测试表穷尽——学习文档是仓库的一等公民，而不是外部 wiki。
