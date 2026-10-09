# 设计：定时任务链条化——一次性定时 + 上游产出传递

日期：2026-10-28
状态：设计定稿，待实现。用户已拍板四项决策（见 §2）。

## 1. 问题

小红书推广的实际节奏是三段，且三段的**时刻性质完全不同**：

1. 聊天里让 Agent 写推广文章并存成草稿——**随机时刻**，人在场。
2. 草稿要在**黄金发布时间**发出去——**一次性、指定日期时刻**。
3. 发布之后要定时互动评论——**周期性**，并且必须知道第 2 步产出的那篇笔记的 URL。

今天三段串不起来。代码事实：

- **表达不出「指定时刻跑一次」**。`Schedule` 只有 `none | daily | weekdays | weekly | interval`（`src/lib/scheduler-types.ts:8-26`），`create_scheduled_task` 的校验器同样只认这五种（`src/background/agent.ts:2929-2981`）。黄金时间是一次性的，用 daily 表达会变成每天发一次。
- **任务之间没有任何关系字段，也不带入参**。`ScheduledTask` 只有 `prompt` / `workflowId`（`scheduler-types.ts:45-73`）。
- **引擎的入参注入口早就存在，只是没有调用方用它**。`ExecuteWorkflowOptions.variables`（`src/background/workflow-engine/run-workflow.ts:125`）在 `:546` 经 `seedFromTrigger` 合入变量袋且**优先于**触发器默认值；`ExecuteWorkflowResult.variables`（`:220`）返回最终变量袋。而 `runWorkflowTask` 调用时既没传 `variables`，也没取回变量袋（`src/background/task-runner.ts:234-243`）。
- **运行产出只活下来一行摘要**。`TaskRunLog` 落 `summary` 与 `steps[]`，`scheduler-types.ts:86-91` 明确写了「调试变量快照不落库」。

一个决定设计形态的既有限制：**聊天回合刻意不进运行日志**。`recordFinishedRun` 对 `source === 'chat'` 直接 `return null`（`src/lib/task-store.ts:322-324`），`listRuns` 再过滤一次（`:248-250`）。所以「第 1 步的草稿 id」不可能被第 2 步在运行时解析出来——它压根没有可寻址的运行记录。

## 2. 决策（用户拍板，不再重开）

| 议题           | 决策                                                                                         | 被否决的候选                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关联形态       | 在 `ScheduledTask` 上加显式链条字段 + 产出传递                                               | 新建 Pipeline 实体（要第三套存储+调度+界面，超出需求，AGENTS §5.5）；只靠 Agent 把值拼进 prompt（发布后的 noteUrl 事先不存在，拼不出来）          |
| 数据传递       | 工作流运行结束的变量袋落库到**运行记录**，下游用 `{{upstream.<key>}}` 在**自己运行时**解析   | 链条级共享上下文存储（多一套存储与淘汰策略）；「下游自己去草稿箱/主页读」（依赖页面状态，多草稿时挑错）                                           |
| 黄金时间       | 规则写进内置技能，由 Agent 算出具体时刻                                                      | 引擎内置时段目录（这类表会过时，且属于领域知识不是基础设施）                                                                                      |
| 宿主           | **仅 Chrome 扩展**（`chrome.alarms` + 现有 ScheduledTask）                                   | 双侧锁步落地（AGENTS §5.6 的镜像契约针对 driver/内核，调度不是；翻倍的是验证成本不是收益）                                                        |
| 链条父任务类型 | **必须 `kind:'workflow'`**，创建时校验拒绝其他                                               | 也接受 `agent-prompt` 父：它只有 `runUnattendedPrompt` 返回的 `answer` 文本（`src/background/agent-unattended.ts:29-36`），URL 混在散文里不是契约 |
| 断链行为       | 父存在但尚无成功运行 → 子任务 `skipped` 且不触碰页面；父被删 / 父成功但缺声明字段 → 响亮失败 | 一律 failed：周期性子任务会在发布窗口到来前每 N 分钟刷一条错误；一律 skipped：父被删这种永不自愈的损坏会变得看不见                                |

## 3. 宿主声明与 §5.6（必须先说清，避免被当成新增第三套调度）

仓库里已有两条定时路径：

1. `src/background/scheduler.ts` 的 `task:` / `workflow:` 前缀，一次 ScheduledTask 一条 one-shot alarm（文件头 `:4-11` 解释了为何不用 periodic）。
2. `src/background/workflow-triggers.ts` 的 `wftrigger:` 前缀，服务于工作流 trigger 节点，其中 `{kind:'once', epoch}` 的一次性武装在 `:299-331,347`。
3. `server/src/scheduler.ts` 用 croner 跑服务端 cron。

本次**只给第 1 条的 `Schedule` 联合类型加一个变体**，复用 `scheduleTask()` 与既有 `task:` 闹钟，不新增前缀、不新增存储、不新增第三条时间轴；第 2、3 条一行不动。因此不构成 §5.6 禁止的「再加一套同类基础设施」。

**已知债务（本文明确记下，防止再叠第三份）**：一次性语义现在存在于两处——`workflow-triggers.ts` 的局部 `{kind:'once',epoch}` 与本次的 `Schedule.once`。下一个需要一次性定时的一方必须合入 `Schedule`，不得再造第三份。

## 4. 数据模型

`src/lib/scheduler-types.ts`：

```ts
export type Schedule =
  | { kind: 'none' }
  | { kind: 'once'; at: number } // epoch ms；触发一次后立即解除
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; days: number[]; hour: number; minute: number }
  | { kind: 'interval'; minutes: number }
```

`at` 用 epoch ms 而非 `{date, hour, minute}` 三元组：单一表示没有歧义，而「本地时刻」的语义由**计算它的人**保证——与 `workflow-triggers.ts:324-328` 里 `new Date(\`${date}T${time}:00\`)`（不带 `Z` 即本地解析）同一形态。

`ScheduledTask` 新增四个字段，全部可选（存量记录零迁移）：

```ts
followsTaskId?: string                      // 上游任务：本任务的 {{upstream.*}} 取自它最近一次成功运行
chainId?: string                            // 仅 UI 分组，无引擎行为
variables?: Record<string, unknown>         // 注入运行的变量袋 / 插值进 prompt
outputs?: string[]                          // 声明本次运行要交出哪些字段名
```

`TaskRunLog` 新增 `outputs?: Record<string, unknown>`，同时**删除** `:86-91` 那句「变量快照不落库」的说明——它将被本契约取代，留着就是 §5.4 说的死文档。

## 5. `{{upstream.*}}` 引用契约

**命名根选 `upstream`，不选 taskId。** 理由：任务 id 由 `newId()` 生成、含 `-`，而仓库的变量名清洗器会剥掉 `-`（`src/lib/workflow/dynamic-data.ts:206-211` `sanitizeName`），以 id 为根的引用不可能由任何既有路径产生，出现在 prompt 里像个外来物种；`upstream` 与代码里既有词汇一致（`DataRewrite.via: 'upstream'`，`dynamic-data.ts:123`）。

**复用，不新写解析器**：

- 插值：`interpolate()`（`src/lib/workflow/interpolate.ts:136`），它已支持点路径（`getByPath:83`），所以 `{{upstream.stats.likes}}` 免费可用；解析不到的 token **原样留在文本里**（`:151`）——这正是我们检测失败的手段。
- 检测残 token：`leftoverTokens`（`interpolate.ts:43`，当前 private → 导出），不重写一份 token 扫描。
- **只有根为 `upstream` 的残 token 才算断链**。其他 `{{...}}` 一律原样保留，与引擎今天的口径一致；否则所有正文里带字面 `{{json}}` 的既有 prompt 会集体开始报错。

解析发生在 `task-runner` 的 `executeTask` 入口，两个 kind 共用一份袋：

- `kind:'workflow'`：解析后的 `variables` 交给 `executeWorkflow({variables})`。引擎侧**零改动**——`run-workflow.ts:546` + `seedFromTrigger`（`workflow-inputs.ts:134`）已经让 payload 压过触发器默认值，生成图里的 `{{noteUrl}}` 因此可解析；`upstream` 本身也在袋里，节点内可直接写 `{{upstream.noteUrl}}`。
- `kind:'agent-prompt'`：`task.prompt` 先用同一份袋插值（今天原样使用，`task-runner.ts:200-209`）。

**创建时拒绝保留名**：`variables` 里不许出现 `upstream`（本契约的根）与 `refData`（已被 `interpolate.ts:149` 占用）。

## 6. 两种时刻的传递：创建时 vs 运行时

这是本设计最容易被误解的地方，写死成规则：

| 上游                      | 可引用性                                                      | 传递方式                                                          |
| ------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| 聊天回合（第 1 步存草稿） | **不可**：`source==='chat'` 不落库（`task-store.ts:324,250`） | 创建时把草稿 id/标题**写成字面量**放进 publish 任务的 `variables` |
| 定时任务（第 2 步发布）   | 可：`listRuns(parentTaskId)[0]`                               | `followsTaskId` + `{{upstream.noteUrl}}`，**子任务运行时**解析    |

好处正在于此：评论任务可以在发布**之前**就建好（此时 noteUrl 还不存在），运行时才取值。若反过来要求"发布成功后再生成评论任务"，就得引入 spawn-on-finish，把一次性任务的生命周期和任务创建耦合起来——更大且没必要。

让聊天回合落进运行日志以支持 `{{run.<chatRunId>}}` 寻址是候选方案之一，被否决：它会推翻 `task-store.ts:322-324` 这个有注释的设计决定，把每个聊天回合灌进任务运行日志及其字节预算。

## 7. 一次性任务的生命周期

`handleScheduledRun`（`src/background/scheduler.ts:113-121`）今天的顺序是「**先再武装，再运行**」，这个顺序对周期性任务是有意的（文件里 `:117-119` 有注释），必须保持。

一次性任务必须相反：

1. **先**持久化 `enabled: false` 并 `chrome.alarms.clear`，**再**运行。
2. 清闹钟在 chrome 语义上是多余的（`when` 闹钟触发即消失），但它关掉了崩溃窗口：运行中抛错、或 worker 在运行中被回收时，没有任何东西会再武装；`rescheduleAll()` 的 `known` 只收 enabled 任务（`:87`），孤儿清扫（`:89-95`）保证它不被复活。
3. 落 `enabled:false` **必须走 store 的加锁操作**，不能裸 `saveTask`：`task-store.ts:58-67` 记录的正是「两个写者读同一基表、后写覆盖前写」这个竞态，一次运行结算与一次停用并发就会丢。
4. **不自动删除任务**：子任务要靠它的运行记录取值，历史也属于用户。**不新增 `finishedAt` 状态字段**——`enabled:false` + 卡片上的「已过期」标记已经表达完"这趟结束了"。

`nextRunAt({kind:'once'}, from)` 在 `at <= from` 时返回 `null`，`scheduleTask` 现有的 `when === null` 分支已经会清闹钟（`:68-73`），因此无需改动其逻辑，只需修正那处注释（现在写着"只有 manual schedule 才返回 null"，已为假）。

## 8. 预算与脱敏（算术必须留下，防止被人随手抬上限）

落库路径只有一条：`runWorkflowTask` 取得 `outcome.variables` → `RunOutcome.outputs` → `finishRun`（`task-runner.ts:89`）→ `FinishedTask.outputs` → index 的 persister → `recordFinishedRun` → `asRun` → `persistRuns`。

顺序安全性：`runTask` 的 `finally` 在 `executeTask` 返回**之后**才 `finishRun`；且 workflow 任务带 `reuseRun` 时引擎**不会**自己结束这个 run（`run-workflow.ts` 的 `ownsRun` 判定），所以 task-runner 是唯一写者。

新增上限（落在 `src/lib/task-chain.ts`，而不是散在 `task-store.ts` 的 `MAX_STORED_RUN_BYTES` 旁边）：生产者是 task-runner、落库者是 `asRun`、读取者是 `resolveTaskInputs`，三方共用同一组常量才不会各写一份"多大算小"。

```ts
const MAX_OUTPUT_KEYS = 8 // handoff 袋装几个 id/URL，不是数据集
const MAX_OUTPUT_STRING = 512
const MAX_RUN_OUTPUTS_BYTES = 4_096
```

- 敏感键复用 `isSensitiveName`（`src/lib/workflow/repair/redaction.ts`），**不写第三份密钥清单**。注意它是名字级：`noteUrl2` 里塞 cookie 不会被抓住，所以文档口径是「handoff 不是凭道通道，秘密走工作流自己的 secret 触发入参」。
- 值截断复用 `capPersistedStrings`——**给它加可选 `limit` 参数**（`src/lib/persist-budget.ts:62`），而不是复制一份 walker（§5.3「以扩展既有模块接口为荣」）。它的 `MAX_DEPTH=6` 与 bulk data URL 处理正是我们要的：截图永远不会搭 handoff。
- **算术**：100 条 × 4 KB ≈ 400 KB，在 `MAX_STORED_RUN_BYTES = 1_500_000` 之内，与既有 `steps` 共存。
- **硬边界**：一篇 3000 字正文**不放进 handoff**。`{{upstream.summary}}` 会被截到 512 字符（合成的值同样截，防止 `runAgentPrompt` 把整篇回答塞进 summary 再灌进子任务 prompt）；bulk 内容走 `src/lib/workflow/file-artifact.ts`，或由子任务自己回读页面。抬上限会重现 `persistRuns:256-267` 注释记录的故障——整本运行日志丢失。
- **另一处预算**：模型可见表面的增长记在 `tests/agent-payload-size.spec.ts` 的 `MAX_CATALOG_CHARS`（29 800 → 31 400，实测 31 284）。`create_scheduled_task` / `list_scheduled_tasks` 属 `ops` 组、round-1 从不广播，所以只有这份 catalog 上限付账，round-1 各预算不动。

## 9. 已知限制（诚实列出，别等用户发现）

1. 运行日志是 100 条滚动窗：月度子任务可能在触发前就等不到父记录了；debug 模式父运行的 `steps` 很大，字节裁剪循环可能把父**整条记录**挤掉（虽然它的袋很小）。届时子任务响亮失败并提示"重跑上游"。备选方案是在任务记录上存一份永不老化的 `lastOutputs` 快照——本轮按用户决策（存运行记录）不做，若实践中咬人再收敛。
2. 60 秒闹钟下限（`MIN_ALARM_DELAY_MS`）：距离现在不足 1 分钟的一次性任务会晚约 1 分钟触发；已过去的时刻也会被 clamp 后触发一次即停用。**不**"修"成内联立即触发。
3. 已触发的一次性任务被用户重新 enable 时，`scheduleTask` 因 `at` 已过而清空闹钟——看起来像"开关坏了"，UI 必须把「改时间才能再跑」说清楚。
4. `interval` 子任务 + `once` 父：首个 tick 落在创建时刻之后的 interval 网格上，不是"发布后 5 分钟"。技能文本要让 Agent 有意识地设这个值。
5. 删父任务会连带 `clearRuns(taskId)`（`src/background/index.ts:1293-1297`）→ 子任务永久断链（属预期，走响亮失败），但删除确认要提示"存在下游任务"。
6. 从 Feishu 手动跑一次父任务同样会覆盖其 outputs 并被子任务消费——合法但可能意外。
7. 链条只覆盖"父是工作流"。若发布步骤是 agent-prompt，创建即被拒，需要 Agent 先把发布操作存成工作流——这一步靠技能文本引导，无机械保证。

## 10. 选型与证据（§7.1）

| 候选                                               | 结论     | 依据                                                                                                                |
| -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| 新建 Pipeline 实体 + 独立编辑 UI                   | 否决     | 需要第三套存储/调度/界面；用户的链路是线性的三步，`ScheduledTask` 加四个可选字段即可表达                            |
| 只在 Agent 侧拼 prompt，运行时不做解析             | 否决     | noteUrl 在创建时不存在；且链条在 UI 里不可见                                                                        |
| 在单个运行里用子工作流 + 延时等待数小时            | 否决     | MV3 service worker 会被回收，引擎不能睡 6 小时；`execute-workflow` 是**同一次运行内**的数据交接，跨小时不成立       |
| 运行记录落最终变量袋 + `{{upstream.*}}` 运行时解析 | **采纳** | 引擎注入口与产出都已存在（`run-workflow.ts:125,220,546`），改动集中在调度层；插值与 token 检测复用 `interpolate.ts` |
| 让聊天回合进运行日志以支持按 run id 寻址           | 否决     | 推翻 `task-store.ts:322-324` 的既有设计决定，把每个聊天回合灌进任务日志与字节预算                                   |

一手来源与既有形状验证：以上引用的 file:line 均为本轮逐文件读源码确认（含 `asTask:69-99` 与 `asRun:174+` 的白名单重建行为、`interpolate.ts` 的 `TOKEN:12` / `getByPath:83` / `leftoverTokens:43` / `refData:149`、`persist-budget.ts:35-68` 的 walker）。`normalizeSchedule`（`schedule.ts:77-79`）与 `describeSchedule`（`:136,148`）的 fallthrough 经阅读确认：前者入参是 `unknown`，tsc **拦不住**漏加 `once` 分支——未处理的一次性记录会静默变成「每天 09:00」，这是本次最高危缺陷，必须用回归测试钉住。

## 11. UI 与文案

- Tasks 面板：分段控件加「一次性」+ `<input type="datetime-local">`；卡片只读展示 `已过期` / 上游任务名 / chain / 声明的 outputs。
- **不在面板里做 `variables` 的 JSON 编辑器**（§5.5，手改一个 URL 的 footgun）；Agent 写入的字段能存活面板编辑，因为编辑器是 spread over draft（`src/sidepanel/TasksTab.tsx:364-380`）。
- 新 markup 用 Tailwind 语义 token（§2），**不往 `src/sidepanel/styles.css` 加手写 class**。已知不一致：TasksTab 今天是 legacy class CSS（`banner-*` / `task-chip` / `schedule-field`），本轮只让新增块用 token，转换整个面板不在范围内。
- 文案 en + zh-CN 成对（§3），新增 key：`taskSchedOnce`、`taskOnceHint`、`taskOncePassed`、`taskFollows`、`taskChain`、`taskOutputs`、`taskUpstreamPending`、`taskUpstreamMissing`。
