# Token 消耗看板 · Token consumption dashboard — design

日期 / Date: 2026-10-12
涉及模块 / Areas: `agent`（计量）、`sidepanel`（看板）、`storage`、`i18n`、`runner`
配套计划 / Plan: `specs/2026-10-12-token-usage-dashboard-plan.md`

## 1. 需求原文 · Requested behaviour

1. 新增一个独立菜单，放在 side panel 的「更多 / More」下拉里。
2. 点开后能看到本项目**所有消耗 token 的地方**：聊天、工作流、定时任务等。
3. 查看方式支持**表格**与**平滑折线图**两种。
4. 统计区间：**今日 / 近 7 天 / 近一个月 / 使用以来**（可扩展）。
5. 能下钻到**具体某个聊天、某个任务、某个工作流**的用量。

## 2. 总目标 · Overall goal

把「这个扩展到底把 token 花在哪了」变成一个可回答的问题，并且答案**可信**。

可信意味着两件事，缺一不可：

- **采集完整**：仓库里每一个会向模型付费的调用都必须记账。少记一个功能，看板就是一个
  撒谎的仪表盘——用户看到 1.2M 而真实账单是 4M，比没有看板更糟。
- **口径唯一**：一条 LLM 请求只记一次，记的是**该请求自己的** usage，不是某个累计快照。

### 交付物 · Deliverables

| #   | 交付物                                                              | 位置                                                           |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| D1  | 记账模型 + 纯聚合逻辑（区间、分桶、按消费者/实体分组）              | `src/lib/token-ledger.ts`                                      |
| D2  | 账本持久化（明细 + 日汇总）与失效广播                               | `src/lib/storage.ts`                                           |
| D3  | 统一采集层：一次改动覆盖全部 LLM 调用                               | `src/lib/llm.ts` 观察者 + `src/background/token-accounting.ts` |
| D4  | `tokens.stats` / `tokens.clear` 命令                                | `src/lib/messages.ts`、`src/background/index.ts`               |
| D5  | 「更多」下的 Token 看板 Tab：区间切换、KPI、表格 / 平滑折线图、下钻 | `src/sidepanel/TokensTab.tsx`、`App.tsx`                       |
| D6  | en + zh-CN 全量文案                                                 | `src/lib/i18n.ts`                                              |
| D7  | Runner 侧同一口径的独立账本 + 只读统计端点                          | `server/src/token-accounting.ts`、`GET /api/tokens/stats`      |
| D8  | 单元 + 组件测试                                                     | `tests/token-ledger.spec.ts`、`tests/tokens-tab.spec.tsx`      |

## 3. 现状取证 · Evidence about the current code

以下是本设计的事实基础，全部由代码位置支撑（不是推测）：

- `streamCompletion`（`src/lib/llm.ts:442`）已经请求 `stream_options.include_usage`
  （`llm.ts:463`），并把 usage 放进 `StreamResult.usage` 与 `handlers.onUsage`
  （`llm.ts:156/164/300`）。**传输层不缺能力，缺的是消费。**
- 全仓库只有 **一处** 真正消费 usage：聊天 agent turn
  （`src/background/agent.ts:5081`（onUsage，逐轮累加进 `totalUsage`）、`5091`（向 port 推累计值）、
  `5143/5150`（本轮结果）。
- 其余调用点全部丢弃 usage：`agent.ts:4734` 上下文压缩摘要、`index.ts:1904` 调试审计/改写、
  `index.ts:2092` 调试目标判定、`workflow-engine/executors.ts:2084` `ai-agent` 块、
  `workflow-engine/node-fix-engine.ts:124` AI 修节点、`workflow-engine/workflow-review.ts:182` 工作流评审、
  `workflow-engine/repair/repair-provider.ts:32` 与 `repair/auto-repair/background-adapter.ts:129` 自动修复、
  `src/lib/vision.ts:145` 视觉/OCR（非流式，响应里带 usage 但从未读）。
  另外工作流生成、定时任务、外部 API、飞书机器人、子 agent 委派都经由
  `runUnattendedPrompt`（`src/background/agent-unattended.ts:127`），它**丢弃** `runAgentTurn` 的返回值。
- **没有任何一处持久化 usage**：
  - 会话转写 `saveConversation`（`storage.ts:838`）写的是 `WireMessage[]`，该类型没有 usage 字段；
    ChatTab 里每条消息的 `entry.usage`（`ChatTab.tsx:161`）**只是 React state**，面板一关就没了。
  - `HistoryEntry`（`storage.ts:1133`）、`TaskRunLog`（`scheduler-types.ts:138`）、
    `RunCheckpoint`（`lib/workflow/checkpoints.ts:27`）均无 token 字段。
  - 两处“看起来像”的都是死路：`takeover-stats.ts:54` 声明了 `inputTokens/outputTokens` 但无调用方赋值；
    `generation-metrics.ts` 的 `'tokens'` 事件有字段，但 `recordMetric` 无生产调用方、存储只在内存。
- Runner 侧同样全丢：`server/src/agent/agent-loop.ts:113`、`server/src/executors.ts:1161`、
  `server/src/http-api.ts:492`，`server/src/**` 没有任何 token 字段。

结论：这是一个**采集 + 存储 + 展示**三层都要新建的功能，不存在「已有数据、只差画个图」。
任何把本需求实现成「只读现有 usage 字段」的方案都不可行，因为现有 usage 字段不存在。

## 4. 关键设计决策 · Decisions

### 4.1 记账单位 = 一次 LLM 请求，而不是一个 turn

聊天 turn 的 `totalUsage` 是**跨轮累计**的（`agent.ts:5082` 每次 `onUsage` 都在做加法），
而 port 上推送的也是累计快照（`agent.ts:5091`）。若照此入库，多次刷新会把同一批 token
重复计入总量。因此账本的一条记录 = **一次 `streamCompletion` 自身的 usage**（`onUsage` 回调里
的那一份就是本轮的），turn 级的展示继续沿用现有累计逻辑，两者互不影响。

> 验收必须能证明这一点：一个 3 轮的 turn 产生 3 条记录，其和等于该 turn 的累计值；
> 面板中途重开不改变账本。

### 4.2 采集只写一处：传输层的一个观察者，宿主各自落账

计划最初写的是「导出一个同签名的 `accountedStreamCompletion` 包裹函数」，实现时改成了
**观察者**：`llm.ts` 在每次请求完成处调用 `observeUsage(request, usage)`，只有声明了
`request.attribution` 的请求才上报；宿主各自 `setUsageObserver()` 写自己的账本
（`src/background/token-accounting.ts` → `chrome.storage`，`server/src/token-accounting.ts`
→ `server/data/token-usage.json`）。

- 为什么改：包裹函数要求每个调用点都记得换用新版本，漏一处就是静默漏记账；观察者只需要
  每个调用点声明一次「这次请求是谁的」，采集口径仍是一处实现，且不会把 storage 语义带进
  chrome-free 的传输层。
- 未署名不上报：`attribution` 缺失时宁可没有这条记录，也不猜测归属。漏接的调用点是显式的洞，
  而不是被塞进某个默认桶里假装覆盖——AC-4 的清单核对才有意义。
- 旁路语义：观察者抛错在 `observeUsage` 内部吞掉，记账是侧信道，绝不能让一个已经花掉用户
  token 的请求因统计失败而报错；调用方自己的 `onUsage` 不受影响。
- 非流式的视觉调用（`vision.ts:211`）复用 `extractUsage` 的同一套字段解析后走同一个观察者，
  不另起第二套解析逻辑。
- 设置页的连通性探测**不计入账本**：`src/lib/llm.ts` 的 `testConnection` 与 Runner 的
  `POST /api/config/test-llm` 都不带 `attribution`。那是用户点「测试」，不是任何聊天、
  任务或工作流的消耗，混进去会让看板虚报。
- `runUnattendedPrompt` 不必改返回值：它内部走的仍是 `runAgentTurn` → 已署名的请求，
  记账与返回值无关。**定时任务 / 工作流生成 / 外部 API / 飞书**因此自动被覆盖。

### 4.3 两套视图数据：明细 + 日汇总，各管一件事

单一结构无法同时满足「今日按小时画曲线」和「使用以来的总量」：明细数组必须有上限
（否则一个 key 越写越大、每次 RMW 重写整个数组，`chrome.storage.local` 会被拖死），
一被截断，“使用以来”就变成“最近以来”。

- `tokenUsage`：**明细**，append 到头部、`MAX_TOKEN_RECORDS = 2000` 截断。
  用途：近期事件表格、今日的小时曲线。
- `tokenUsageDaily`：**按本地日 + 消费者 + 实体的累计**，`dayKey → { 总量, byConsumer, byEntity }`。
  用途：区间总量、7/30 天与“使用以来”的折线、任意实体（某个聊天/任务/工作流）的下钻。
  体积有界（一天最多 9 个消费者 × 有限实体，实体按当日总量保留 top-N），且**永不被截断**，
  所以“使用以来”是真实的全量。

派生而不是二次真相：日汇总是从同一批 `TokenUsageRecord` 用同一个纯函数
`applyRecordToDaily()` 累加出来的，两者可互相校验（测试要 pin 这条）。

### 4.4 归属实体：记录时快照名字

下钻要显示「哪个聊天 / 哪个任务」。用 `entityKey`（`chat:<conversationId>`、`task:<taskId>`、
`workflow:<workflowId>`、`run:<runId>`、`external:<id>`…）+ `entityLabel`（记账那一刻的会话标题 /
任务名 / 工作流名）。存快照而非读取时联表：会话与任务会被删掉，删掉之后历史用量仍需可读、
仍需认得出是谁。

### 4.5 折线图手写 SVG，不引图表库

`package.json` 没有任何图表依赖（React 19 + CodeMirror + @xyflow/react + lucide + tesseract）。
为一条曲线引入 recharts/echarts（数十 KB、且要适配 Tailwind token 与深色主题）不符合本仓库
“不新增同类基础设施 / 不做超出需求的东西”的约束，平滑折线本身是 Catmull-Rom 转三次贝塞尔的
几十行数学。实现要求：单调、不产生过冲——用的是 Fritsch–Carlson 单调三次 Hermite
（数据折点处切线归零），而不是会在尖峰处下穿过基线的普通 Catmull-Rom；并保证 hover
命中最近的桶。

### 4.6 不做的事 · Non-goals

- **成本换算（钱）**：各 provider 定价、缓存计价、汇率都在变，且需要用户维护价格表；
  第一版只报 token 数与请求数。价格表如果要做，是独立需求。
- **回填历史**：本功能上线前的调用没有留下任何 usage 数据（见 §3），无法追溯。
  看板必须诚实：统计范围显示「自记账启用起（`firstRecordedAt`）」，不假装是全生命周期。
- **把 usage 塞进会话转写**：`WireMessage` 是给 provider 看的线格式，往里加统计字段会污染
  请求体并触发第 4 点里那些 400 问题；账本独立于转写。
- **改造现有 token bar 的显示口径**：聊天里逐条消息的 token 展示保持原样。

### 4.7 Runner 侧：同口径、同类型，独立账本，只读端点

Runner（`server/`）是另一个宿主，不能写扩展 storage（§5.7 跨端逻辑只放 `src/lib/**`，
且 Runner 对扩展文件的依赖走白名单）。已实现：Runner 复用 D1 的**纯**类型与聚合
（`server/src/token-accounting.ts` 只 import `src/lib/token-ledger`，不存在第二套区间/分桶实现），
落到 `server/data/token-usage.json`（它已有的数据目录约定，写临时文件再 rename，进程内串行追加），
并由 `http-api.ts` 暴露只读的 `GET /api/tokens/stats?range=`（走同样的 bearer token）。
Runner 侧的消耗来自三处：工作流 `ai-prompt` 块与 ai-agent turn（`workflow-run`）、
共享引擎的 takeover 评审（`ai-debug`）。

**面板不合并 Runner 数据（2026-10-12 dcc 拍板：先不动，保持只读端点）**：扩展侧没有任何通往
Runner HTTP 端的通道——本地 agent 桥是扩展**向外拨**到 `ws://127.0.0.1:8765` 的连接，而 Runner 的
HTTP 在 8787，`src/**` 从不访问它。合并必须新增一个「Runner 地址」设置项（以及随之而来的来源标注），
代价是一条新的跨端耦合。所以本步只交付端点本身：看板永远只用扩展账本，不会因为 Runner 没起来而
报错，也不会假装统计已含 headless 侧；Runner 的用量自行查 `GET /api/tokens/stats`。日后若要合并，
落点是扩展已有的 agent 通道（由 Runner 把账本推过来），而不是让面板去连 HTTP。

## 5. 数据结构 · Shapes

```ts
// src/lib/token-ledger.ts（chrome-free，扩展与 Runner 共用）
export type TokenConsumer =
  | 'chat' // 聊天 agent turn（含其工具轮）
  | 'workflow-generation' // 生成工作流的 turn
  | 'workflow-run' // 运行中的 ai-agent 块
  | 'ai-debug' // 调试审计/改写、目标判定、AI 修节点、工作流评审
  | 'auto-repair' // 自动修复候选生成
  | 'scheduled-task' // 定时任务触发的 unattended run
  | 'context-compaction' // 转写摘要压缩
  | 'vision' // 图像识别 / OCR 的模型调用
  | 'external-api' // 本地 agent 桥 / 外部调用方

export interface TokenUsageRecord {
  id: string
  at: number // epoch ms
  consumer: TokenConsumer
  entityKey: string // 'chat:<id>' | 'task:<id>' | ...
  entityLabel: string // 记账时的名字快照
  model: string
  providerId?: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export type TokenRange = 'today' | '7d' | '30d' | 'all'
```

聚合输出（面板一次拿全）：`totals`（含请求数、缓存/推理命中）、`series`
（按 `TokenBucketUnit` 分桶：today→hour、7d/30d→day、all→week/month 自适应）、
`byConsumer[]`、`byEntity[]`（top-N + 「其他」合并，保证表格不无限长）、
`firstRecordedAt`。宿主身份不进入账本：Runner 的消耗本来就记在 `workflow-run` / `ai-debug`
这类**功能**名下，它属于哪个宿主由账本文件本身决定，再加一个 `runner` 消费者只会把同一件事
记两次。

区间边界一律用**本地时区**日历日（`today` = 本地 00:00 起），与用户在面板上看到的时间一致；
测试必须覆盖跨日与 UTC 偏移场景。

## 6. 验收标准 · Acceptance criteria（设计层）

| ID    | 标准                                                                                                       | 由什么证明                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| AC-1  | 「更多」下拉出现 Token 看板项，点击可进入；其余菜单项不受影响                                              | 组件测试 + 人工步骤                                         |
| AC-2  | 四个区间（今日/7 天/近一个月/使用以来）都能切换并给出对应总量                                              | `tests/tokens-tab.spec.tsx`                                 |
| AC-3  | 表格视图与平滑折线图视图可切换，折线为平滑曲线（路径含三次贝塞尔段），无新增依赖                           | 同上 + `package.json` diff 为空                             |
| AC-4  | 聊天、工作流、定时任务、AI 调试/修复、上下文压缩、视觉识别每个消费者都能出现在表里                         | 采集点清单逐项核对 + `llm-accounting` 测试                  |
| AC-5  | 能下钻到具体某个聊天 / 某个任务 / 某个工作流的用量                                                         | `byEntity` 断言 + 组件测试                                  |
| AC-6  | 记账不重复、不遗漏：一条 LLM 请求恰好一条记录，turn 累计值 = 其请求记录之和                                | `tests/token-ledger.spec.ts` 的累计等价测试                 |
| AC-7  | 关掉面板 / 重启浏览器后历史仍在；明细到上限只截明细，「使用以来」仍为全量                                  | storage 测试 + AC-6 的等价校验                              |
| AC-8  | 所有可见文案 en + zh-CN 双侧注册                                                                           | `pnpm typecheck`（封闭 `Messages` 类型机检）                |
| AC-9  | 颜色全部走语义 token，深色为默认可读，样式为 Tailwind                                                      | 代码审查 + `pnpm build`                                     |
| AC-10 | Runner 侧调用同样记账，且与扩展共用同一聚合函数；只读端点可达时返回看板，账本缺失/损坏时返回空看板而不抛错 | `server/test/token-accounting.test.ts` + `pnpm server:test` |

浏览器真实行为的证据要求见计划文档的收尾清单：side panel 页面不可被脚本驱动，
因此 UI 项按仓库既有红线以「组件测试 + 人工验证步骤」交付，拿不到人工证据的行标 BLOCKED，
不得以“测试全绿”冒充“扩展能用”。
