# 实施计划：定时任务链条化（一次性定时 + 产出传递）

日期：2026-10-28
配套设计：`2026-10-28-scheduled-task-chain-design.md`（决策、契约、预算算术、已知限制都在那里，本文只排任务与验收口径）。

## 0. 范围

仅扩展侧。改动文件：`src/lib/{scheduler-types,schedule,persist-budget,task-chain,task-store,i18n,builtin-skills}.ts`、`src/lib/workflow/interpolate.ts`（仅导出一个既有函数）、`src/background/{scheduler,task-runner,running-tasks,index,agent}.ts`、`src/sidepanel/TasksTab.tsx`，加对应测试。
`src/background/workflow-engine/**`、`src/background/workflow-triggers.ts`、`server/**` 一行不动。

## 1. 类型与纯函数（先做，后面全部依赖它）

| #   | 文件                              | 动作                                                                                                                                                                                                                                                    | 验收                                                                                                  |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1.1 | `src/lib/scheduler-types.ts`      | `Schedule` 加 `{kind:'once'; at:number}`；`ScheduledTask` 加 `followsTaskId/chainId/variables/outputs`；`TaskRunLog` 加 `outputs`；删除 `:86-91` 过期的"快照不落库"说明                                                                                 | `pnpm typecheck`（`describeSchedule` 等读 `schedule.hour` 的处会立刻报错，正是我们要的提醒）          |
| 1.2 | `src/lib/schedule.ts`             | 新增 `coerceOnceAt`（紧邻 `coerceIntervalMinutes`）；`normalizeSchedule` 加显式 `once` 分支且**非法值 → `{kind:'none'}`**；`nextRunAt` `once` → `at > from ? at : null`；`describeSchedule` 分支必须在读 `hour` 之前，`at <= now` 加"已过期/passed"前缀 | `tests/schedule.spec.ts`：未来/过去/数字串/垃圾四类；**垃圾必须断言不等于 daily 09:00**（最高危回归） |
| 1.3 | `src/lib/persist-budget.ts`       | `capPersistedStrings(value, limit = MAX_PERSISTED_STRING)` 可选参数                                                                                                                                                                                     | 既有调用方行为不变（默认参数）                                                                        |
| 1.4 | `src/lib/workflow/interpolate.ts` | 导出既有 `leftoverTokens`（`:43`，原 private）                                                                                                                                                                                                          | 无新逻辑，typecheck 即可                                                                              |
| 1.5 | `src/lib/task-chain.ts`（新）     | `buildUpstream(parentRun)` → `{...outputs, summary(截 512)}`；`resolveTaskInputs(task, bag)` → `{variables, prompt?, missing[]}`；只有根为 `upstream` 的残 token 计入 missing                                                                           | 新建 `tests/task-chain.spec.ts`；chrome-free（§5.7 红线），新文件理由见设计 §5                        |

## 2. 存储

| #   | 文件                    | 动作                                                                                                                                                                                                                                                                   | 验收                                                                                                                              |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | `src/lib/task-store.ts` | `asTask` 白名单 + `createDraft` **两处都**透传四个新字段；`asRun` 保留 `outputs`，新增 `MAX_OUTPUT_KEYS=8`/`MAX_OUTPUT_STRING=512`/`MAX_RUN_OUTPUTS_BYTES=4096`，`isSensitiveName` 滤键、`capPersistedStrings(v, MAX_OUTPUT_STRING)` 滤值；`FinishedRunInput.outputs?` | `tests/task-store-runs.spec.ts` + `tests/run-log-serialization.spec.ts`：outputs 往返存活、三个上限生效、无新字段的旧记录仍可解析 |
| 2.2 | 同上                    | 给停用一次性任务用的加锁更新操作（不裸 `saveTask`，见设计 §7.3）                                                                                                                                                                                                       | `tests/workflow-scheduler.spec.ts` 覆盖                                                                                           |

**已知陷阱**：只改类型不改 `asTask`/`asRun` = 功能看着能用、worker 一重启就静默丢字段。1.1 与 2.1 必须同批完成。

## 3. 后台

| #   | 文件                                                          | 动作                                                                                                                                                                                                                                                                                                                                                  | 验收                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | `src/background/scheduler.ts`                                 | `handleScheduledRun`：`once` → **先**停用+清闹钟**再**运行；非 `once` 保持"先再武装再跑"原顺序；修正 `scheduleTask` 里 `when===null` 的过期注释                                                                                                                                                                                                       | `tests/workflow-scheduler.spec.ts`：一次性只跑一次 + `enabled:false` + 无二次 create；随后 `rescheduleAll()` 不复活；pending 一次性 `when===at` 且临近时 `>= now+60_000`；**同时钉住 daily/interval 的顺序不被回归** |
| 3.2 | `src/background/running-tasks.ts` + `src/background/index.ts` | `FinishOptions.outputs?` → `FinishedTask.outputs?`，persister 转发 `recordFinishedRun`；不新建存储路径                                                                                                                                                                                                                                                | 2.1 的往返测试                                                                                                                                                                                                       |
| 3.3 | `src/background/task-runner.ts`                               | `RunOutcome.outputs?`；`executeTask` 入口解析上游袋（父被删 / 成功但缺声明字段 → 响亮失败；父存在但无成功运行 → `skipped` 且不触碰页面，复用 `runReviewRequests:170-179` 的双语 skipped 写法）；`runAgentPrompt` 插值 prompt；`runWorkflowTask` 传 `variables`、取回 `outcome.variables`、按 `task.outputs` 过滤并对缺失的声明键补一条 `'error'` step | `tests/workflow-task-run.spec.ts`：variables 被传入、outputs 被提出；skipped 路径断言 `expect(engine.runWorkflow).not.toHaveBeenCalled()`（证明没碰页面）                                                            |

失败文本要求：点名 token、上游任务名、上游实际产出的**键名**（值只给 `summarizeValue` 摘要）；绝不填空串。

## 4. 模型可见表面

| #   | 文件                             | 动作                                                                                                                                                                                                                                                                           | 验收                                                            |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 4.1 | `src/background/agent.ts` schema | `schedule.at`（number 或本地 `YYYY-MM-DDTHH:mm`，描述禁止 `Z`）、`variables`、`outputs`、`followsTaskId`、`chainId`；description 补链条与一次性各一行                                                                                                                          | `tests/agent-scheduled-task-tool.spec.ts`                       |
| 4.2 | `parseScheduleArg`               | `once` 分支加在最终拒绝**之前**；本地解析形态复用 `workflow-triggers.ts:324-328`；更新末尾错误文案的 kind 列表                                                                                                                                                                 | 同上：垃圾 `at` 拒绝且**什么都没落库**                          |
| 4.3 | `createScheduledTaskFromArgs`    | `followsTaskId` 必须存在且 `kind==='workflow'`（拒绝并提示先存工作流）；挡「父=自己」与「父的父=本任务」；`variables` 扁平 + `MAX_BULK_LITERAL_CHARS` 上限 + 拒 `upstream`/`refData` 键名；`outputs` 过 `/^[A-Za-z_][A-Za-z0-9_]*$/`；返回值带 `follows`/`outputs`/`nextRunAt` | 同上：非 workflow 父被拒、非法 outputs 名被拒、超 bulk 上限被拒 |
| 4.4 | `list_scheduled_tasks`           | **去掉 enabled-only 过滤**并返回 `enabled`（否则一次性父任务触发后从模型视野消失，子任务无从引用）；返回链条字段与 `lastOutputKeys`；同步工具 description                                                                                                                      | 同上：能看到已停用的父任务                                      |

`src/lib/tool-catalog.ts`、`src/lib/messages.ts` 无需改（无新工具；`tasks.save` 按类型携带整个 `ScheduledTask`）。

## 5. 技能与 UI

| #   | 文件                         | 动作                                                                                                                                                                                                                                                                                     | 验收                                                    |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 5.1 | `src/lib/builtin-skills.ts`  | 新增 `builtin-xiaohongshu-pipeline`（`autoMatch:true`）：黄金时间决策规则写成 prose；两步 `create_scheduled_task` 的**字面 JSON 形状**；「聊天值创建时写字面量 / noteUrl 运行时解析」规则；先 `load_tools({groups:["ops"]})`（沿用 `:114` 指针写法）；诚实边界"看不到草稿 id 就别建任务" | `tests/builtin-skill-seed.spec.ts`：当前版本装机被 seed |
| 5.2 | `src/sidepanel/TasksTab.tsx` | 分段控件加 `once` + `datetime-local` 编辑器（本地↔epoch 换算）；`sched` 归一让 `once` 原样透传、别掉进 weekly 分支；卡片只读 chips：`已过期`/follows/chain/outputs。新 markup 用 Tailwind 语义 token，不往 `styles.css` 加手写 class；不做 `variables` 的 JSON 编辑器                    | **BLOCKED**（扩展页面不可脚本化）→ 人工步骤见 §7        |
| 5.3 | `src/lib/i18n.ts`            | `Messages` + en + zh-CN 同批：`taskSchedOnce`、`taskOnceHint`、`taskOncePassed`、`taskFollows`、`taskChain`、`taskOutputs`、`taskUpstreamPending`、`taskUpstreamMissing`                                                                                                                 | `pnpm typecheck` 机检两侧对齐（封闭类型）               |

## 6. 提交切分（AGENTS §1 英文 Conventional Commits）

1. `docs(spec): design chained and one-shot scheduled tasks`
2. `feat(lib): add one-shot schedule and task chain fields`
3. `feat(lib): resolve upstream task outputs at run time`
4. `feat(background): persist workflow run outputs for task handoff`
5. `feat(background): disarm one-shot scheduled tasks before running`
6. `feat(agent): expose one-shot and chain arguments for scheduled tasks`
7. `feat(sidepanel): edit and show one-shot and chained scheduled tasks`
8. `test: pin one-shot schedule, run handoff and chain resolution`

## 7. 验收口径（收尾自检）

**机检可绿的部分**：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build`（动了 UI）。
**明确不需要**：`server:typecheck`/`server:test`（零 `server/` 改动）、`bench:debug`（不碰 `workflow-engine/**` 与 `ai-takeover.ts`）、`verify:injected`（无新内联 `executeScript`）。

**只能人工 / BLOCKED（拿不到证据就如实标，不得声称验证过）**：

1. `chrome.alarms` 真实行为：加载 unpacked 扩展 → 建一个 2 分钟后的一次性任务 → 观察只触发一次、`chrome.alarms.getAll()` 里 `task:<id>` 已消失、卡片显示已停用；再在 `chrome://extensions` 回收 worker 后确认它没有被复活。
2. Tasks 面板：`once` 时间选择器渲染与回填、卡片上「已过期」与链条 chip。扩展页面不可脚本化 → 预期标 BLOCKED 并写出期望现象。
3. 真实小红书端到端：草稿存在 → 按分钟发布成功 → `noteUrl` 真被工作流写进变量（`block-output.ts` 的变量赋值）→ 子评论任务在活笔记上解析成功。`pnpm selftest` 只能证 generate/replay/repair，证明不了跨任务链条。
4. 模型是否真的执行"存草稿 → 建发布任务 → 建评论任务"三次编排：无自动化证据，一次真实对话记录只是单样本。

## 8. 待办与风险（不在本轮范围）

- `workflow-triggers.ts` 的局部 `{kind:'once',epoch}` 与本设计新增的 `Schedule.once` 是同一语义的两份实现，下一个使用方必须合入 `Schedule`。
- 若实践中"父记录被滚动窗挤掉"真的咬人，再考虑在任务记录上存一份不老化的 `lastOutputs` 快照。
- 若用户坚持把发布做成 agent-prompt 任务，届时才需要讨论 agent 侧的产出捕获工具（本轮明确不做，避免为一个场景造一整套捕获面）。

## 9. 落地偏差（实施后回填，文档与代码以这一节为准）

| 计划                                                                   | 实际                                                                                                                                                                                | 原因                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三个上限常量放 `task-store.ts` 的 `MAX_STORED_RUN_BYTES` 旁            | 放 `src/lib/task-chain.ts`（`MAX_OUTPUT_KEYS` / `MAX_OUTPUT_STRING` / `MAX_RUN_OUTPUTS_BYTES`）                                                                                     | 生产者（task-runner）、落库者（`asRun`）、读取者（`resolveTaskInputs`）三方共用同一组数，避免各写一份"多大算小"                                                                                                                                          |
| 删掉 `scheduler-types.ts:86-91`「变量快照不落库」那句                  | **保留**                                                                                                                                                                            | 那句讲的是 step 级 `vars`，今天仍然成立；被删会让文档反向说谎。运行级 handoff 另写一段说明                                                                                                                                                               |
| 一次性落 `enabled:false` 用「`updateTask`-风格 op 或 `recordTaskRun`」 | 新增 `disableTask(id)` 锁定操作（`task-store.ts`）                                                                                                                                  | `recordTaskRun` 语义是"记一次运行结果"，用它伪装停用会把两个关注点揉在一起；锁内读改写与既有 `saveTask` 同一套                                                                                                                                           |
| i18n 八个 key                                                          | 落地六个：`taskSchedOnce`、`taskOnceHint`、`taskFollows`、`taskChain`、`taskOutputs`，外加计划里没有的 `taskDeleteChained`（边界 6 要求的删除确认提示，父任务被删时列出下游任务名） | `taskOncePassed` 已含在 `describeSchedule` 的字符串里（"已过期 / (passed)"），`taskUpstreamPending` / `taskUpstreamMissing` 是运行期日志文本、走 `task-runner` 既有的 `zh ? … : …` 写法，不是面板可见控件文案。注册成 key 就是死 key（§5.4）             |
| 无需动测试预算                                                         | `tests/agent-payload-size.spec.ts` 的 `MAX_CATALOG_CHARS` 29 800 → 31 400（实测 31 284）                                                                                            | 两个 ops 工具的 schema 长了约 1.5k 字符。ops 组不在 round-1 广播，所以 round-1 各预算不动，只有 catalog 上限付账；算术写进该常量的注释头，与文件既有惯例一致                                                                                             |
| `tests/builtin-skill-seed.spec.ts` 要为新技术补断言                    | 不改                                                                                                                                                                                | 该测试遍历 `BUILT_IN_SKILLS` 断言每个都 seed，新技能自动被钉住                                                                                                                                                                                           |
| §6 的八段切分按列出顺序落地                                            | 提交顺序改为 文档 → lib 字段 → **sidepanel** → task-chain → 运行产出 → 一次性解除 → agent → 测试；`builtin-skills.ts` 并入 agent 提交，`disableTask` 随产出提交落地                 | 可二分性实测出来的：`Schedule` 一旦加上 `once`，`TasksTab` 读 `schedule.minutes` 的分支就编译不过，面板提交必须紧跟类型提交。逐提交 `tsc --noEmit` 是唯一能发现这种顺序问题的检查                                                                        |
| 全部测试放最后一段                                                     | `tests/agent-payload-size.spec.ts`、`tests/agent-scheduled-task-tool.spec.ts` 随 agent 提交落地                                                                                     | 这两份在 agent 那一提交上会真的挂：catalog 上限是机检常量，而 `list_scheduled_tasks` 改走真实 `listRuns`，旧 mock 没有它。把它们留到最后等于留下两个红提交                                                                                               |
| `TasksTab.tsx` 整体属于面板提交                                        | 面板里那行 `sched.kind !== 'none'` 的收窄（改成 `weekly \|\| interval`）随 **lib 字段** 提交落地，面板功能留在后面的提交                                                            | 逐提交 `tsc` 实测：`Schedule` 一旦加上 `once`，编辑器 `interval` 分支的 `sched.minutes` 就编译不过。联合类型的扩张必须和它唯一的收窄调用点同提交，否则那个提交本身不可编译（`isTimeBased` 是别名条件，TS 只能沿着它收窄到 `weekly \| once \| interval`） |

**收尾自检实测**：`pnpm typecheck` 无输出通过；`pnpm test` 340 文件 / 3910 用例全绿；tracked 文件 eslint exit=0（`pnpm lint` 全仓红是 `tmp/` 与 `server/data/` 未跟踪产物，见 memory）；`pnpm format:check` tracked 文件零 warn（残留 `[warn]` 全在 `server/data/**`、`tmp/`）；`pnpm build` 通过。§7 列的四项人工/BLOCKED 证据本轮仍未取得。
