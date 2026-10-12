# Token 消耗看板 · implementation plan

日期 / Date: 2026-10-12
设计 / Design: `specs/2026-10-12-token-usage-dashboard-design.md`
执行方式：按 Step 顺序推进，每步完成后按该步「步骤验收」自检；全部完成后走末尾「总验收列表」。

## 总目标（重述）

在 side panel 的「更多」下拉中新增一个 Token 消耗看板，展示本项目**所有**消耗 token 之处
（聊天 / 工作流生成 / 工作流运行 / AI 调试与自动修复 / 定时任务 / 上下文压缩 / 视觉识别 / Runner），
支持表格与平滑折线图两种视图、今日 / 7 天 / 近一个月 / 使用以来四个区间，
并且可以下钻到具体某个聊天、某个任务、某个工作流的用量。

前提事实（见设计 §3）：当前**没有任何 token usage 被持久化**，11 个 LLM 调用点里只有 1 个消费 usage。
所以本计划的第一步不是画图表，而是把数据采集补齐。

---

## Step 0 · 记账模型与纯聚合（`src/lib/token-ledger.ts`）

目标：定义唯一的数据口径，并把所有统计计算做成不依赖 chrome 的纯函数，让「区间 / 分桶 /
分组」这类最容易出错的部分可被单元测试钉住。

产物：

- `TokenConsumer`、`TokenUsageRecord`、`TokenRange`、`TokenBucketUnit` 类型；
- `coerceTokenRecord(raw)`：存储值不可信，逐字段校验（沿用 `asHistory` 的写法）；
- `recordOf(usage, attribution)`：把一次请求的 usage + 归属拼成记录（total 缺失时用输入+输出兜底）；
- `applyRecordToDaily(daily, record, dayKey)`：日汇总累加（与明细同一函数，保证两视图同源）；
- `rangeWindow(range, now)`：本地时区区间边界（today = 本地 00:00）；
- `bucketSeries(...)`：today→按小时、7d/30d→按天、all→按周/月自适应，缺数据的桶补 0，保证折线连续；
- `groupByConsumer(...)` / `groupByEntity(..., topN)`：后者把超出 topN 的合并成 `other`；
- `buildDashboard(records, daily, range, now)`：一次产出面板要的全部结构；
- `MAX_TOKEN_RECORDS`、`MAX_DAILY_ENTITIES` 常量。

步骤验收：

- [x] 文件不 import 任何 `chrome.*`，可被 `server/tsconfig.json` 的 `src/lib/**` 白名单覆盖
      （Runner 侧 `server/src/token-accounting.ts` 就是这么 import 的）；
- [x] 纯函数无副作用、无 I/O；
- [x] 累计等价：多条记录求和 = 逐条相加，且同 `entityKey` 的记录能聚成一个实体行
      （`tests/token-ledger.spec.ts`，26 例）。

## Step 1 · 账本持久化（`src/lib/storage.ts`）

目标：把 Step 0 的模型落成可写可读的两份数据，且写入路径与仓库既有集合一致
（`withKeyLock` + `area` + `notifyStoreChanged`），不开第二套存储基础设施（AGENTS.md §5.6）。

产物：`recordTokenUsage(records: TokenUsageRecord[])`（明细头部追加并截断 + 日汇总累加，一次锁内完成）、
`readTokenUsage()`（返回 `{ records, daily }`）、`clearTokenUsage()`。
写成功后 `notifyStoreChanged('tokenUsage')`，让打开的面板实时刷新（与 TasksTab 同一机制）。

步骤验收：

- [x] 明细严格截断到 `MAX_TOKEN_RECORDS`，日汇总不被截断（“使用以来”始终全量）
      （`tests/storage-token-usage.spec.ts`、`server/test/token-accounting.test.ts` 各钉一遍）；
- [x] 单次 RMW 在锁内完成，两个并发写入不会互相丢记录（`tests/storage-token-usage.spec.ts`「keeps every record from two concurrent appends」；Runner 用进程内链式串行）；
- [x] 读到脏数据（缺字段 / 字符串数字 / 非数组）时被 `coerceTokenRecord` 丢弃而不是抛错（`tests/token-ledger.spec.ts`；Runner 侧连文件损坏都读成空账本）；
- [x] 不新增 storage key 之外的镜像路径，`chrome.storage.sync` 仍不使用（只多两个 key：`tokenUsage`、`tokenUsageDaily`）。

## Step 2 · 采集层与调用点全覆盖（`src/lib/llm.ts` 观察者 + `src/background/token-accounting.ts`）

目标：**一处**采集实现覆盖所有 LLM 请求，保证口径不漂移；补齐今天被丢弃的调用点。

产物：

- `TokenAttribution = { consumer; entityKey; entityLabel? }`，作为 `StreamRequest.attribution` 随请求传下去；
- 采集在传输层：`llm.ts` 每完成一次带署名的请求就 `observeUsage(request, usage)`，宿主各自
  `setUsageObserver()` —— `src/background/token-accounting.ts`（写扩展 storage）与
  `server/src/token-accounting.ts`（写 Runner 自己的 `server/data/token-usage.json`）；
- 非流式视觉调用复用 `extractUsage(payload)`（同一套字段规则）后走同一个观察者；
- 记账是旁路：观察者抛错在 `observeUsage` 内吞掉，不影响模型调用返回；
- 计划里最初设想的 `accountedStreamCompletion` 包裹函数**没有采用**——它要求每个调用点换用新
  函数名，漏一处即静默漏记账；改为「调用点只声明归属」后，采集口径仍只有一处实现（设计 §4.2）。

改造清单（逐行替换， consumer 归属如下；每个都要在代码里留下正确的 entityKey/label 来源）：

| 调用点                                                                                                                                              | consumer                                                                                                                         | 归属来源                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `agent.ts:5057`（turn 内每轮）                                                                                                                      | `chat` 或 `workflow-generation`（按 turn mode）                                                                                  | `deps.conversationId` + 会话标题                                  |
| `agent.ts:4734`（转写摘要）                                                                                                                         | `context-compaction`                                                                                                             | 同一 conversation                                                 |
| `index.ts:1904`（调试审计/改写）、`index.ts:2092`（目标判定）、`node-fix-engine.ts:124`、`workflow-review.ts:182`                                   | `ai-debug`                                                                                                                       | `sessionId`/`runId` + workflow 名                                 |
| `repair-provider.ts:32`、`auto-repair/background-adapter.ts:129`                                                                                    | `auto-repair`                                                                                                                    | run/workflow                                                      |
| `workflow-engine/executors.ts:2084`（`ai-agent` 块）                                                                                                | `workflow-run`                                                                                                                   | `workflow.id` + 名                                                |
| `vision.ts:145`（非流式）                                                                                                                           | `vision`                                                                                                                         | 所属 conversation/entity                                          |
| `task-runner.ts:305`、`feishu-bot.ts:545`、`ai-agent-executor.ts:284`、`workflow-generation-bridge.ts:248/293`、`agent-api.ts:469`、`index.ts:1868` | 经由 `runUnattendedPrompt`→`runAgentTurn`，由 turn 的 attribution 决定 `scheduled-task` / `workflow-generation` / `external-api` | 各自的合成 conversationId（`task:<id>`、`workflow-replay:<id>`…） |

> 注意：`runUnattendedPrompt` 的调用方**不需要**改返回值——记账发生在请求层（设计 §4.2）。
> 但 attribution 必须能从 `runAgentTurn` 的 deps 拿到（消费者种类 + 实体），
> 因此 `agent-unattended.ts` 与 `agent.ts` 需要把已有的 conversationId/mode 传进包裹函数，
> 而不是新造一条上下文通道。

步骤验收：

- [x] `grep -rn "streamCompletion(" src server/src` = 12 处，逐一核对：11 处带 `attribution`
      （`agent.ts:4750` 的摘要调用通过 `...config` 展开带上），唯一例外是
      `server/src/http-api.ts:505` 的 `POST /api/config/test-llm` —— 设置页连通性探测，
      按设计 §4.2 **故意不记账**（`src/lib/llm.ts` 的 `testConnection` 同理）；
- [x] 每条记录恰好对应一次请求：一个 N 轮 turn 记 N 条，其和 = 现有 turn 累计 usage
      （证据：`tests/llm-accounting.spec.ts`「writes one record per observed request」+ `tests/token-ledger.spec.ts` 累计等价）；
- [x] 同一 turn 内面板重开 / port 重连不会重复入账（`agent-channel` 只转发累计快照，没有任何写入账本的代码路径；账本唯一写入者是观察者 sink）；
- [x] 任一调用点写不进账本时，模型调用仍成功返回（证据：`tests/llm-accounting.spec.ts`「survives a throwing sink」，Runner 侧 sink 抛错只 `logger.warn`）。

## Step 3 · 命令契约（`src/lib/messages.ts` + `src/background/index.ts`）

目标：面板一次请求拿到全部看板数据，避免 N 次往返；沿用既有 read-only 命令三件套的写法
（`Command` 联合 121–434、`CommandResult` 联合 436–658、`handleCommand` 的 case）。

产物：

- `{ type: 'tokens.stats'; range: TokenRange }` → `{ type: 'tokens.stats'; stats: TokenDashboard }`
- `{ type: 'tokens.clear' }` → `{ type: 'tokens.clear'; ok: true }`

步骤验收：

- [x] 未注册 key 不靠 `any` 绕过；`pnpm typecheck` 通过（命令与结果都在封闭联合里）；
- [x] `tokens.stats` 是只读的（不改状态），`tokens.clear` 有确认交互（`confirmDialog`，取消即不发命令——`tests/tokens-tab.spec.tsx`）；
- [x] 返回体有界：实体行 top-N（`MAX_GROUP_ROWS = 25`）+ `__other__` 合并，明细行由账本上限约束。

## Step 4 · 看板 UI（`src/sidepanel/TokensTab.tsx`、`App.tsx`）

目标：把数据变成能看的看板——区间切换、KPI、表格 ⇄ 平滑折线图、消费者维度与实体维度下钻。

产物与要点：

- `App.tsx`：`TabId` 增加 `'tokens'`，放进 `MORE_TABS`（顺序：`skills, agents, tokens, data, settings`
  ——「更多」下拉里位于数据与设置之前），`TAB_LABEL` 加 `tabTokens`，容器与其余 Tab 一样常驻挂载；
- 区间控件：今日 / 近 7 天 / 近一个月 / 使用以来，四选一；
- 视图切换：表格 / 折线图（默认折线图，两者都能一键切换且保留区间选择）；
- KPI：总 token、输入 / 输出、缓存命中、推理 token、请求数、起始时间（诚实显示“自记账启用起”）；
- 折线图：手写 SVG，单调三次 Hermite（Fritsch–Carlson，折点切线归零）转三次贝塞尔（`C` 段），
  带基线、区域填充、峰值点、hover 所在桶读数；空数据（<2 桶）时不画线；**不引入图表依赖**；
- 表格：两张——按消费者（聊天/工作流/任务/…）、按实体（具体某个聊天、某个任务、某个工作流），
  列含请求数 / 输入 / 输出 / 缓存 / 推理 / 总计 / 最近使用时间；
- 实时刷新：监听 `tokenUsage` 的 store-change（沿用 TasksTab 的总线），跑一次任务后数字会自己动；
- 样式全部 Tailwind + 语义 token（`bg-panel`、`text-muted`、`border-border`、`text-accent` 等），
  颜色不硬编码；空态 / 错误态 / 加载态齐备。

步骤验收：

- [x] 「更多」下拉可见该项（`App.tsx` 的 `MORE_TABS` 含 `tokens`，`TAB_LABEL.tokens = tabTokens`），
      容器常驻挂载所以区间/视图选择不随切换丢失；浏览器内的可见行为按 R14 走人工验证。
- [x] 折线路径字符串含 `C`（三次贝塞尔）而非只有 `L`，且单调不越界（把发射出的路径反解析回贝塞尔段逐点采样，断言渲染 y 不越过数据自身范围——`tests/token-chart.spec.ts`、`tests/tokens-tab.spec.tsx`）；
- [x] 表格能同时看到“聊天”和“某个具体聊天”两层（`tokensByConsumer` / `tokensByEntity`，`tests/tokens-tab.spec.tsx` 断言行名与行合计）；
- [x] 无任何新增 npm 依赖（`git diff --stat package.json pnpm-lock.yaml` 为空）。

### Step 4b · 看板视觉重做（2026-10-12 追加，dcc：「这个 token 看板页面样式太丑了」）

Step 4 首版把数据接上了，但外观是「六个等大灰盒子 + 一张裸表」——没有层次，也没有可读的相对量。
重做只动 `src/sidepanel/TokensTab.tsx` 的表现层：命令、账本、聚合、i18n key 一律不变。

方向：**台面仪器（bench instrument）**。整个面板读作一台嵌在侧栏里的仪表，而不是网页卡片堆。

- 字体分工：标签一律 `font-mono` + 大字距 micro caption，数字一律 `font-mono tabular-nums`，
  正文名称保持 sans——层级靠字距与颜色分，不靠字号乱跳；
- 控件：区间与视图各自一条 `bg-sunken` 内凹导轨，选中槽位用 `bg-accent-soft` +
  `shadow-[inset_0_0_0_1px_var(--bc-accent-border)]` 的描边点亮（物理按压感）；
- 读数窗：总量做成一只发光 odometer（`text-[34px]` + `[text-shadow:0_0_26px_var(--bc-accent-soft)]`），
  右上是窗口日期跨度（同日折叠成一个日期，不写「Oct 12 — Oct 12」）；
  输入/输出/缓存/请求数落在同一块面板的 1px 发丝分隔栅格里，不再是六个独立盒子；
- 折线图：底板换成点阵方格纸（`bg-sunken` + `radial-gradient` 点阵 + `[background-size:9px_9px]`），
  区域填充改成 `linearGradient`（accent 34% → 0），补 3 条虚线刻度、峰值环 + 落基线虚影、
  hover 十字线与光斑；`vectorEffect="non-scaling-stroke"` 保证线宽不被 `preserveAspectRatio="none"` 拉歪；
  `h-36` 让 y 缩放与 x 缩放相等，标记点保持正圆；光标 `cursor-crosshair`；
- 表格：`table-fixed` + `<colgroup>`（名称 36 / 输入 15 / 输出 15 / 请求 15 / 合计 19）——
  首版名称列会随内容变宽，把合计列挤出卡片；每行名称下画一条 2px 量条（`bg-border/60` 轨道 +
  `bg-accent/70` 填充，宽度 = 该行占窗口总量的比例，运行时计算才用内联 style），
  用长度代替「占比」第六列，窄栏里比数字好读；
- 动效：三块板按 0 / 70 / 140 ms 错峰 `animate-[dialog-pop_280ms_ease-out_both]` 进场，
  切区间时读数窗 `key={range}` 重新落表；`prefers-reduced-motion` 由 design-system 全局兜底。

约束核对：未新增 `--bc-*` token（只消费既有语义色，含 `--bc-accent-border`、`--bc-border-strong`），
故 `server/web/src/styles.css` 无需同步；未新增 i18n key；无内联静态样式；无新依赖。

步骤验收：

- [x] `tests/tokens-tab.spec.tsx` 7 条断言零修改通过（折线视图仍恰好 2 个含 `C` 的 `svg path`、
      表格视图仍无 `svg`、hover 读数仍是唯一含「总 token」的 `<span>`）；
- [x] 视觉证据：`tmp/tokens-preview/`（一次性预览台架：vite + `@source` 指向本组件 +
      桩化 `chrome.runtime.sendMessage` + 真实 `buildTokenDashboard` 造一个月用量），
      `shot.mjs` 出 9 张截图——明/暗双主题、en/zh 双语、折线/表格双视图、hover 读数、
      空账本态、320px 窄栏；三处真实缺陷（合计列溢出、表头挤在一起、占比色块发糊）由截图发现后修掉；
- [x] 门禁：`pnpm typecheck`、`npx vitest run`（3990 passed）、tracked-file eslint（exit 0）、
      tracked-file `prettier --check`、`pnpm build` 全绿，且新工具类（`table-fixed`、`width:36%`、
      `letter-spacing:.05em`、`bg-accent/70`、`height:2px`、`text-shadow`、`animation-delay`）
      均在 `dist/assets/design-system-*.css` 里确认已发射。

## Step 5 · i18n（`src/lib/i18n.ts`）

目标：所有新文案 en + zh-CN 双侧齐备，由封闭 `Messages` 类型机检。

产物：`tabTokens`、区间标签、视图切换、KPI 标签、消费者名（9 个）、表头、空态/错误态、
清理确认等 key，flat camelCase，带 `tokens` 前缀；插值用函数式 value。

步骤验收：

- [x] `pnpm typecheck` 通过（两侧不对齐必挂）——41 个 `tokens*` key 双侧齐备；
- [x] 组件 JSX 内无用户可见硬编码字符串（含 `__other__` 哨兵走 `tokensOther`、图表 aria-label 走 `tokensTrend`）；
- [x] 数字统一走 `Intl.NumberFormat(locale)`、时间走 `Intl.DateTimeFormat(locale)`，
      集中在 `TokensTab.tsx` 顶部的 `formatNumber/formatDateTime/formatBucket` 三个函数里。

## Step 6 · Runner 侧同口径账本（`server/src/token-accounting.ts`）

目标：Runner 的三个调用点（`agent-loop.ts:113`、`executors.ts:1161`、`http-api.ts:492`）不再丢 usage，
账本落 `server/data/`，面板在本地 agent 桥可达时合并并标注来源。

产物：Runner sink（写自己的 JSON 账本，复用 Step 0 的纯聚合）+ 只读统计入口 +
面板合并逻辑（不可达时降级为“仅扩展数据”，不报错、不空屏）。

步骤验收：

- [x] `pnpm server:typecheck`、`pnpm server:test` 通过（11 files / 86 tests，含 `server/test/token-accounting.test.ts` 4 例）；
- [x] 跨包依赖仍走 `server/tsconfig.json` 白名单：只新增对 `../src/lib/token-ledger.ts`、`../src/lib/llm.ts` 的引用，两者都已被 `../src/lib/**/*.ts` 覆盖，白名单未放宽；
- [x] Runner 与扩展用**同一**聚合函数：`readTokenDashboard()` 直接调 `buildTokenDashboard()`，没有第二套区间/分桶实现；
- [x] 看板仍可用：面板只读扩展账本，不依赖 Runner 是否在线。Runner 数据的**面板合并未实现**——
      扩展侧没有通往 Runner HTTP 的通道，需要先新增「Runner 地址」设置项，属于产品决定，
      2026-10-12 dcc 拍板：**先不动，保持只读端点**，不加「Runner 地址」设置、不新增跨端通道
      （Runner 用量自行查 `GET /api/tokens/stats`）。此项已闭环，不再是待决。

## Step 7 · 测试（`tests/token-ledger.spec.ts`、`tests/storage-token-usage.spec.ts`、`tests/llm-accounting.spec.ts`、`tests/tokens-tab.spec.tsx`）

目标：把最容易撒谎的三处钉住——口径（重复/遗漏）、时区（今日边界）、下钻（实体归属）。

覆盖：

落地文件：`tests/token-ledger.spec.ts`（26）、`tests/token-chart.spec.ts`（8）、
`tests/storage-token-usage.spec.ts`（4）、`tests/llm-accounting.spec.ts`（7）、
`tests/tokens-tab.spec.tsx`（7）、`server/test/token-accounting.test.ts`（4）。

1. 累计等价（N 轮 turn = N 条记录，和等于累计快照）—— `llm-accounting` + `token-ledger`；
2. `rangeWindow` 本地日界（含跨日、非 UTC 时区）—— `token-ledger`；
3. 分桶连续性（无数据日补 0；今日小时序列长度 24；all 的周/月自适应）—— `token-ledger`；
4. 明细截断但日汇总不截断 →「使用以来」仍全量—— `storage-token-usage` + Runner 侧各一遍；
5. `coerceTokenRecord` 对脏数据的丢弃行为（含 Runner 的缺失/损坏文件读成空账本）；
6. 实体分组 top-N + `other` 合并，缓存/推理字段可缺省；
7. 采集层旁路语义：未署名不上报、sink 抛错不影响请求返回（`llm-accounting`）；
   另加：平滑曲线不越过数据范围（`token-chart`，把路径反解析成贝塞尔逐点采样）；
8. 面板：四个区间切换发出正确命令、表格/图切换、平滑路径断言、某个聊天/任务行存在、
   空态、ledger 写入触发合流刷新、清空需确认、hover 读出所在桶。

---

## 总验收列表 · Final acceptance checklist

需求逐条对齐（每条要么给出证据，要么标 BLOCKED 并写明原因）：

- [x] **R1 菜单**：`App.tsx` 的 `MORE_TABS` 含 `tokens`（顺序 `skills, agents, tokens, data, settings`），
      标签走 `TAB_LABEL.tokens = 'tabTokens'` 双语；容器常驻挂载，切走再回来不丢区间/视图选择。
      下拉里的**可见行为**证据见 R14（BLOCKED）。`[验收]`
- [x] **R2 全量消费者**：9 个消费者每个都有真实产生点——`chat`、`workflow-generation`、
      `workflow-run`、`ai-debug`、`auto-repair`、`scheduled-task`、`context-compaction`、
      `vision`、`external-api`；`grep` 核对 12 处 `streamCompletion` 调用，除设置页连通性探测外
      全部带 `attribution`（Step 2 验收）。原计划的第 10 个消费者 `runner` 已删除：Runner 的花费
      本来就落在 `workflow-run` / `ai-debug` 名下，宿主身份由账本文件决定，再造一个消费者等于
      同一件事记两次。`[验收]`
- [x] **R3 表格视图**：按消费者 + 按实体两张表，列为 名称 / 输入 / 输出 / 请求数 / 总计。
      原计划的 7 列（再含缓存、推理）在 ~400px 侧栏里读不出来，故缓存命中与推理 token 由窗口级
      KPI 行承担（`tokensCached` / `tokensRequests` 等 6 个 KPI）；下钻表保持可读优先。`[验收]`
- [x] **R4 平滑折线图**：手写 SVG（`lib/token-chart`，单调三次 Hermite → `C` 段，无图表依赖）、
      分桶随区间切换（today→小时 / 7d·30d→日 / all→周·月自适应）、指针悬停读出所在桶的
      总量/输入/输出、离开即复原；配色全部走语义 token，深色为默认可读。
      证据：`tests/token-chart.spec.ts`、`tests/tokens-tab.spec.tsx`。`[验收]`
- [x] **R5 区间**：今日 / 近 7 天 / 近一个月 / 使用以来四个区间可切换，切换即重新向 worker 索取
      该区间看板（面板不自算），命令序列断言为 `['7d','today','all','30d']`。`[验收]`
- [x] **R6 下钻**：`byEntity` 表按 `chat:` / `task:` / `workflow:` / `run:` / `external:` 分组，
      行名用记账时的名字快照（会话被删也仍可辨认）；测试断言「Debug the login form」行合计 3000、
      「Morning digest」任务行存在。`[验收]`
- [x] **R7 口径可信**：账本唯一写入者是 `llm.ts` 观察者里的 sink，每请求一条；`agent-channel` 的
      累计快照路径不写账本，因此面板重开 / port 重连不翻倍（`tests/llm-accounting.spec.ts`）。`[验收]`
- [x] **R8 持久化**：写 `chrome.storage.local` 的两个 key（明细 2000 条上限、日汇总不截断），
      「使用以来」在明细截断后仍为全量（`tests/storage-token-usage.spec.ts`）。
      真实重启浏览器后仍在线的验证属于 R14 的人工步骤。`[验收]`
- [x] **R9 双语**：`tabTokens` + 40 个 `tokens*` key（区间 4、视图 2、KPI 6、表头 5、消费者 9、
      空态/截断/错误/清空等）在封闭 `Messages` 的 en 与 zh-CN 两侧同时注册，`pnpm typecheck` 机检。`[机检]`
- [x] **R10 无新依赖 / 无第二套基础设施**：`git diff --stat package.json pnpm-lock.yaml` 为空；
      存储仍走 `lib/storage.ts`（只多两个 key），刷新通知走 `lib/store-events` 总线，
      区间/分桶/聚合只有一份实现（`src/lib/token-ledger.ts`，Runner 直接 import）；
      删掉了 `storage.ts` 里重复的账本接口，改用共享的 `TokenLedger`。`[验收]`
- [x] **R11 扩展侧门禁**（本机实跑，输出摘录见交付说明）：`pnpm typecheck` 无输出即通过；
      `npx vitest run` → **348 files / 3987 tests passed**；`npx eslint --quiet` 对
      `git ls-files '*.ts' '*.tsx'` → **exit 0**；`npx prettier --check` 对
      `git ls-files '*.ts' '*.tsx' '*.md' '*.css'` → **All matched files use Prettier code style**；
      `pnpm build` → **✓ built**。（lint/format 以 tracked 文件为口径：本地 `tmp/` 与
      `server/data` 里的探针产物不在 CI 的检出集内。）`[机检]`
- [x] **R12 Runner 侧门禁**：`pnpm server:typecheck` 通过；`pnpm server:test` →
      **11 files / 86 tests passed**（含新增 `test/token-accounting.test.ts` 4 例）。`[机检]`
- [x] **R13 注入函数校验**：本次未新增任何 `executeScript({func})` 内联函数体 → **N/A**；
      仍实跑 `pnpm verify:injected` → **OK - every injected function is self-contained**
      （其中 `ai-agent-executor.ts:108` 的 `func` 静态不可解析属存量提示，与本次改动无关）。`[验收]`
- [ ] **R14 真实浏览器证据**：**BLOCKED** —— side panel 页面不可被脚本驱动（仓库既有红线），
      本轮拿不到人工证据，禁止用 vitest 全绿冒充扩展可用。人工步骤（交付说明同步给出）：
      `pnpm build` → Chrome → 扩展 → 加载 `dist/` unpacked → 打开 side panel →
      「更多」下拉应出现「令牌用量 / Tokens」→ 进去后依次点四个区间，确认 KPI 数字随区间变；
      切「表格」看两张表与「其他」行、某个聊天的行合计；切回「折线图」确认深色下曲线可读、
      鼠标划过有点与读数、离开复原；跑一轮聊天后停留在看板，确认数字自己涨；
      点「清空用量记录」确认取消不删、确认后才删；切 zh-CN 与 en 各看一遍，确认无缺串。`[验收]`
- [x] **R15 死代码与复用**：过程中删了三处自己写出来的多余东西——`storage.ts` 里与
      `token-ledger` 重复的账本接口、未经使用的 `TokenLedgerSource`/`mergeDailyStores`/
      `dashboardFromLedgers`（面板合并那套在扩展侧没有可用通道，属于为假想需求铺路）、
      无法被任何代码路径产生的 `runner` 消费者；`TOKEN_RANGES` 由面板与 `?range=` 校验共用一份；
      聚合与分桶在两个宿主间只有一份实现。`[纪律]`
- [x] **R16 暂存区干净**：本轮没有截图/探针产物入库；一次性验证脚本与输出只落在 `tmp/`（已 gitignore），
      未使用 `git add -f`。`[纪律]`
- [ ] **R17 提交规范**：**未提交**——本轮只在用户要求时才提交。提交计划（全英文 Conventional Commits，
      分层落地）：`feat(lib): add token ledger aggregation and smooth chart paths` →
      `feat(background): record every attributed llm request` →
      `feat(sidepanel): show token usage under more` →
      `test(tokens): pin accounting, persistence and panel behaviour` →
      `feat(runner): keep a token ledger beside the runner` → `docs(specs): record token dashboard design`。
      本功能不打算打 tag；若打则先按 AGENTS.md §4 同步 `website/` 与 `package.json` 版本。`[纪律]`

诚实边界（必须随交付说明一起给出）：

1. 看板统计的是**记账功能上线之后**的用量，历史无法回填（设计 §4.6）；面板必须把这一点显示出来。
2. 不做成本（钱）换算；如需要，是另一个需求。
3. 未拿到 R14 的人工证据时，本功能状态为「代码 + 自动化测试完成，扩展内实际显示待人工确认」。
