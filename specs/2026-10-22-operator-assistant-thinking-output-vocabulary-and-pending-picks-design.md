# 算子助手：思考状态、模型原文可见、全量算子词汇与"拾取待发送"

- 日期：2026-10-22
- 状态：已实施（2026-10-23；回填见 §7）
- 范围：`src/workflow-editor/ai/OperatorChatDock.tsx`、`src/background/operator-advise-engine.ts`、
  `src/lib/workflow/operator-advise.ts`、`src/lib/workflow/operator-registry.ts`、
  `src/lib/messages.ts` / `src/background/index.ts` 的广播联合
- 前置：`specs/2026-10-19-editor-operator-ai-chat-design.md`、
  `specs/2026-10-19-operator-ai-observe-and-edit-design.md`、
  `specs/2026-10-20-operator-ai-screenshot-and-pick-design.md`

## 1. 原始诉求（dcc 原话）

1. 算子助手执行时，思考状态不要显示成"正在挑选算子"，直接写"正在思考"。
2. 模型如果有输出，算子助手界面需要展示出来给用户看到。
3. 算子助手应当能直接调用所有的算子节点。
4. 用户拾取元素后不应该自动发送，用户应该还能修改或取消，点击发送消息时才一起发送出去。

## 2. 现状取证（读代码得到的事实，带 file:line）

**状态文案。** 在飞期间只有一行状态，且完全在 UI 侧：`OperatorChatDock.tsx:695-700` 渲染
`t('operatorAiThinking')`，值在 `src/workflow-editor/i18n.ts:247`（`Choosing operators…`）与
`:553`（`正在挑选算子…`）。`src/background/operator-advise-engine.ts` 里没有任何 emit/progress 通道，
`src/background/index.ts:2615-2656` 只是 await 一次 `runOperatorAdvise` 并返回一个响应对象。

**模型输出被丢掉。** 传输本来就是流：`operator-advise-engine.ts:158-193` 调 `streamCompletion`，
但 handler 参数传的是空对象 `{}`（`:192`），于是 `src/lib/llm.ts:315-333` 的
`onText` / `onReasoning` / `onRetry` / `onUsage` 一个都没接。解析端再丢一次：
`operator-advise.ts:860` 先 `unwrapFencedAnswer(stripThinkBlocks(text))`，`:861-869` 只取
`indexOf('{') .. lastIndexOf('}')` 的切片做 `JSON.parse`——大括号外的散文、think 内容全部蒸发。
进界面的只有 `parsed.reply`（`:918` → dock `:466-499`）；`rationale`（`:907-911`）与 `rejected`
（`:898-917`）解析了但 `src/workflow-editor/**` 里从不渲染。

**广播通道已经现成。** `broadcastToPages`（`index.ts:941-947`）不是 `tabs.sendMessage`，是一次
`chrome.runtime.sendMessage`，其注释（`:934-939`）明写"工作流编辑器标签监听 `runtime.onMessage`，
实时修复日志要搭这条"。编辑器是扩展页 popup（`src/sidepanel/WorkflowsTab.tsx:830-854` 用
`runtime.getURL('src/workflow-editor/index.html')` 打开），所以收得到。编辑器侧已有三个监听器：
`use-repair-events.ts:41-60`（repairEvent）、`NodeFixModal.tsx:370-376`（nodeFixEvent）、
`element-pick.ts:91-97`（按 pickerId 匹配拾取回复）。dock 目前纯 request/response（`sendCommand`，
`messages.ts:1038-1043`），自己没注册监听器。

**助手当前能写的算子。** `aiLandingAllowed()`（`operator-registry.ts:424-431`）拒绝 trigger、cloud 块、
`!allowGeneration`、`aiExposure === 'hidden'`、以及本机缺 OCR 的项。实测计数：注册表 **63** 个算子，
`allowGeneration` 通过 **57**，`aiLandingAllowed` 通过 **56**（被拒 7 个：`trigger`、`proxy`、
`browser-event`、`save-local`、`note`、`blocks-group`、`workflow-state`）。被拒项的真相：

| id               | 执行器                                                                                        | 性质                                                  |
| ---------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `save-local`     | 有：`executors.ts:3180-3222` 真写文件（空值抛错）                                             | 只是被标 `hidden`（`registry:167`），因写盘副作用     |
| `workflow-state` | 有：`executors.ts:3035-3063` 读写运行变量（stop-* 抛错）                                      | `hidden`（`registry:186`）                            |
| `note`           | 半：`executors.ts:3280-3285` 只 `emit('info', text)`                                          | `hidden` + `placeholder`（`operator-class.ts:91-95`） |
| `blocks-group`   | **无执行器**：引擎按 `blockId === GROUP_BLOCK_ID` 解释子节点（`engine.ts:960-962,1360-1395`） | 图结构容器，子节点在 `data.blocks` 里                 |
| `proxy`          | 抛"未实现"（`executors.ts:3224-3235`；Runner `server/src/executors.ts:2114-2120`）            | 占位，5 个参数全 inert                                |
| `browser-event`  | 只 emit"占位实现"并返回 null（`executors.ts:3140-3144`）                                      | 占位，7 个参数全 inert                                |

offer 侧还有一层：`adviseCandidates`（`operator-advise.ts:691-708`）= 发现短名单（`DISCOVERY_LIMIT = 12`）+
`generationOperators('core')` 兜底（core 只有 6 个，`registry:127-153`），每轮最多 6 个
（`OPERATOR_ADVISE_MAX_OPERATORS`，`:58`）。

**会被推动的机检。** `tests/acceptance-registry.spec.ts:64` 钉住"`allowGeneration` ⇒ `aiExposure ≠ hidden`"
这条不变量——诉求 3 正好要反转它；`tests/operator-tool-tiers.spec.ts:125`（core ≤ 5）、`:264`（工具描述 ≤ 260
字符）、`tests/acceptance-operator-loading.spec.ts:6,12`（候选 ≤ 5）、`tests/operator-param-coverage.spec.ts:98-147`
（proxy/browser-event/workflow-state 的 inert 参数台账：一旦真被 honored，陈旧条目就失败）、
`tests/agent-payload-size.spec.ts:31,79,112,126,141,154`（6 处字符预算，词汇表变长会直接顶到）。

**拾取之后发生什么。** `pickElement()`（`dock:403-418`）await `requestElementPick()` 成功后：写
`picked` state（`:323,411`）、往会话里加一条"已拾取"行（`:413-416`）、然后调用 `fillOfferWith(element)`
（`:417`，实现 `:374-399`）——**这一步会立刻把 `selector`/`findBy` 写进被扣住的批次，并在没有别的缺口时
直接落地**（不经过模型）。发送只在 `send()`（`:420-450`）发生，picks 作为 `pickedElements` 随请求带出
（`:447`）并清空（`:431-434`）。待发 picks 的界面只有一个计数徽标（`:756-760`）+ 会话里的已拾取行，
**没有逐条删除、也没有编辑入口**。相关既有断言：`tests/acceptance-operator-chat-dock.spec.tsx:660-731`。

## 3. 决策

### D1 文案直接叫"正在思考"，key 不动

`operatorAiThinking` 改成 `Thinking…` / `正在思考…`。key 名保留（它描述的正是这行状态），
不新增第二个 key（§3 一文案一 key）。

### D2 模型原文用流式展示，复用既有广播，不新建传输

新增一个 `PageBroadcast` 成员 `workflows.operatorAdviseEvent`（与 `nodeFixEvent` 同形：
`{ requestId, phase, text }`），engine 把 `streamCompletion` 的 `onText`/`onReasoning` delta
按节流推给它；dock 注册一个 `runtime.onMessage` 监听，按 `requestId` 过滤，实时追加到"思考"区，
结束后折叠成可展开的"模型原文"。理由：编辑器已经是这条广播的订阅者（`index.ts:934-939` 的注释就是为此写的），
再开一条 port / 第二套 store 才违反 §5.6。节流常量放在 `src/lib/workflow/operator-advise.ts`
（跨端纯逻辑，§5.7），不要散在 UI 里。

### D3 解析丢弃的那部分也要显示

`reply`（模型自己给用户的话）与 `rationale`（每个 offer 的理由）现在解析了却不渲染——本轮把它们接进界面，
`rejected`（被消毒掉的行）只在"模型原文"里出现，不另造列表。

### D4 词汇放开到"除结构与占位之外全部"，落地闸门与 prompt 一起改

按 dcc 表态：把 4 个 `aiExposure: 'hidden'` 项加回来，继续拒绝 `trigger` 与两个真占位项
（`proxy`、`browser-event`：执行器一个抛未实现、一个只 emit 占位信息，允许助手写出它们等于让它写出跑不动的步骤）。
于是 `aiLandingAllowed()` 的判据从"exposure/allowGeneration 一堆条件"收敛为**显式拒绝清单**
（`trigger` + `PLACEHOLDER_BLOCK_IDS` 里的 `proxy`/`browser-event`），cloud 的排除保留。
prompt 侧 `adviseCandidates` 的词汇表变成全量 `- id — name`（实测 63 − 3 = **60** 行；
带 schema 的 offer 仍按现有 `DEFAULT_VALUE_CAP = 400` 逐条截断，不给全部算子都塞 schema）。
`tests/acceptance-registry.spec.ts:64` 那条不变量随之反转改写，不是绕过。

**待表态（未解）：`blocks-group` 要不要跟着放。** 它是 hidden 之一，dcc 的"4 个隐藏项加回来"字面上含它，
但它没有执行器、子节点写在 `data.blocks`（一个嵌套节点列表），助手的 offer 形状表达不了；画布已有
pack/unpack 生成它。本文推荐：`blocks-group` 与 `trigger`/`proxy`/`browser-event` 一起拒绝并给命名文案，
即实际可写 59 个。这个歧义要 dcc 自己点头，不自行决定。

### D5 拾取只产生"待发附件"，发送时才落地

去掉 `fillOfferWith()` 的即时写入与即时落地：一次拾取只追加一条附件。附件渲染成可逐条删除、
可内联编辑 `selector`/`findBy` 的列表（沿用 dock 既有 input 样式与 Tailwind token，§2）。
被扣住缺参数的批次在用户点"发送"时才用当前 picks 填缺口并落地（保留 `PendingOffer` 机制，
只把触发时机从"拾取即落"改成"发送才落"）。`operatorAiPicked` 会话行照旧，但不再是"下一步就落地"的暗示。

### D6 本轮不做的事

不新增第二条 LLM 通道 / 第二个 agent loop / 第二个 port / store / driver（§5.6）；不为 Anthropic、
Gemini 的图像形状加代码（既有红线，仓库只走 OpenAI 兼容 `image_url`）；不做 redo；不改
`src/lib/workflow/operator-guide.ts`（字符预算敏感，且它正被并行主题编辑）。

## 4. 切片

- **G1（最小，纯文案 + 已有数据）**：D1 + D3。验收：`tests/acceptance-operator-chat-dock.spec.tsx`
  新增/改写行断言思考文案与 reply/rationale 渲染。
- **G2（流式通道）**：D2。`messages.ts` 的 `Command`/`PageBroadcast` 类型、engine 的 `onText`/`onReasoning`
  接线与节流常量、dock 的监听器。验收：engine 用注入的 fake stream 断言事件序列 + dock acceptance 断言
  思考区随 delta 追加。
- **G3（全量词汇）**：D4。`aiLandingAllowed` 收敛为显式拒绝清单、`adviseCandidates` 词汇表放开、
  相关不变量与预算测试同步（预算上调必须先实测增量再写最小值并留书面理由）。
- **G4（拾取待发送）**：D5。附件列表的可删/可改 UI + 发送时机改造 + 会话行为断言。

## 5. 红线自查

- 广播只加一个 type，走 `broadcastToPages` 既有那一条；监听器放 dock，模式与 `NodeFixModal.tsx:370-376` 一致。
- 跨端纯逻辑（节流常量、词汇表构建、拒绝清单）留在 `src/lib/**`；`chrome` 只在 background/dock。
- 新增/修改文案 en + zh-CN 成对（§3）；样式只用既有 Tailwind token 类（§2）。
- 模型输出的 `blockId`/参数仍走既有消毒闸门，不放松。

## 6. 与并行主题的冲突面（为什么本文先不落地代码）

`src/workflow-editor/i18n.ts` 与 `tests/agent-payload-size.spec.ts` 当前正被 operator-parity 主题
（`specs/2026-10-22-operator-parity-plan.md`，36 个未提交文件）编辑，D1/D4 都要动这两个文件。
按 AGENTS.md 的"一次只推进一个主题"与共享工作区纪律：等那条主题提交干净后，G1→G4 再开工。

## 7. 实施回填

**G1（文案与可见输出）。** `operatorAiThinking` 值改为 `Thinking…` / `正在思考…`（key 不变）。
助手行新增两个渲染：`proposals` 以 `<ul>` 列出"算子名 — rationale"（解析了但从未显示的字段现在可见）；
`raw` 放进 `<details><summary>{operatorAiRaw}</summary><pre>…</pre></details>`，会话结束后仍可展开。
新增 key `operatorAiRaw`（`Model output` / `模型原文`）。顺带修正旧英文文案 `operatorAiNoUndo`
（`撤销` → `Undo`）。

**G2（流式）。** `OperatorAdviseResult` 增 `raw?: string`（模型原文逐字保留，是流丢失时的兜底）。
engine 的 `callModel` 增第三参 `onDelta`，`streamCompletion` 的 `onText` / `onReasoning` 直接转成
`{ channel, delta }`；`runOperatorAdvise` 通过 `deps.stream` 转出。background 侧新增
`adviseStreamToPages(sessionId)`：合并相邻同 channel 的 delta，每 `OPERATOR_ADVISE_STREAM_FLUSH_MS = 80`
经既有 `broadcastToPages` 推一次，`finally` 里强制 flush。dock 在 mount 时注册
`runtime.onMessage`，按 `activeSessionRef`（即本次 `sessionId`）过滤，实时追加进"思考"区，
结束后清空。

**与 D2 的偏差（有意）。** 事件形状没有采用草案的 `{ requestId, phase, text }`，而是
`{ type: 'workflows.operatorAdviseEvent', sessionId, channel: 'text' | 'reasoning', delta }`：
`sessionId` 是请求里已经存在的关联键（`requestId` 会是一根新桩），`channel` 让"推理"与"正文"在 UI
上分层显示，`delta` 表明载荷是增量而不是快照（合并端与消费端都不会误把它整段替换）。

**G3（全量词汇）。** `aiLandingAllowed()` 改为显式拒绝清单（`trigger` / `proxy` / `browser-event`），
保留 cloud 与本机缺 OCR 的排除，不再读 `allowGeneration` / `aiExposure`。按 dcc 的"再加回 4 个隐藏项"
表态，`blocks-group` **予以放行**——§3 D4 的"待表态"自此关闭，实际可写 **60 / 63**（原 56）。
`adviseCandidates()` = 发现短名单 + `generationOperators('core')`（这两部分 `detailed: true`，
带完整 schema）+ 其余可写算子（`detailed: false`，prompt 只渲染 `[params: …; required: …]`），
按 id 去重。实测（`tmp/` 探针，未入库）：全量 schema 合计 26,718 字符（均 467，最大 get-text 1,450）；
改前 6 候选 prompt 7,495 字符，改后全量 prompt 13,077 字符（compact 尾巴），未触任何字符预算测试
（`tests/agent-payload-size.spec.ts` 等全部原样通过，无预算上调）。
`tests/acceptance-registry.spec.ts:64` 的 `allowGeneration ⇒ aiExposure ≠ hidden` 不变量**未反转**：
本轮没有动这两个注册表标志，放开的只是"落地闸门"对它们的读取；该测试原样通过。

**G4（拾取待发送）。** 删掉 `fillOfferWith()`（拾取即填、缺口填完即落地）。取而代之：拾取只追加
一条 `PickedElement` 附件；页脚渲染附件条（`findBy` 下拉 + `selector` 输入框 + 逐条删除），
编辑、删除都只改 state，不碰画布。存在被扣住批次时，发送按钮换成 `operatorAiPickApply`
（`Add with picked elements` / `用已拾取元素添加`），点击才把当前 picks 按缺口顺序写入并落地；
仍有缺口则留在 offer 里继续等，超出的 picks 不被消耗、留给下一条消息。无 offer 时行为不变：
picks 随下一条消息作为 `pickedElements` 发出并被消耗。新增 key：`operatorAiPicksTitle`、
`operatorAiPickRemove`、`operatorAiPickByCss` / `ByXpath` / `ByText`、`operatorAiPickApply`。

**测试。** `tests/acceptance-operator-chat-dock.spec.tsx` 31 行全绿：新增流式（错误 sessionId 被丢弃、
reasoning/text 实时显示、结束后 raw 折叠）、rationale 渲染、拾取"发送才落地"、附件可改/可删；
`tests/operator-advise.spec.ts` 钉住 60 行全量词汇、4 个隐藏项在列、3 个拒绝项不在列、
只有短名单 + core 是 `detailed`、compact 行只带参数名。全量 `TZ=UTC npx vitest run`：**425 文件 /
4,949 测试通过**；`tsc --noEmit`（src + tests）、eslint、prettier、`vite build` 全绿。

**未取得的证据（如实记）。** ⑤浏览器可见行为本轮 **BLOCKED**：没有加载 unpacked extension 手工
走一遍流式显示与拾取附件；MCP 进不了 `chrome-extension://` 页，本轮也未用可加载真实构建的
Playwright 通道。③未触发（未改 `workflow-engine/**` 或 `ai-takeover.ts`，不跑 `bench:debug`）。
④未触发（未改 `executeScript({func})` 内联函数体）。

**顺带记录（非本轮诉求）**：`cbfd565 refactor(editor): drop AI optimize and save-time AI review entries`
（2026-10-22 09:38）删除了每节点"AI 优化"入口与它的还原栈，`specs/` 里没有对应的设计或计划文档，
提交 body 也未写理由。删除后 `src/workflow-editor/sidebar/NodeFixModal.tsx` 已无任何 importer
（`App.tsx` / `BlockEditForm.tsx` 均不再引用），而 `src/lib/workflow/node-fix.ts`、
`src/background/workflow-engine/node-fix-engine.ts`、`workflows.nodeFix` 命令与
`tests/node-fix*.spec.ts` / `tests/acceptance-node-fix-modal.spec.tsx` / `tests/acceptance-live-fix-log.spec.tsx`
仍在——功能不可达，代码与测试继续绿。Ctrl+Z（`graph-history.ts`）未被删除，仍在 `App.tsx` 接好。
处置（重新接回入口 / 连模块一起删）等 dcc 表态，本文不自行决定。
