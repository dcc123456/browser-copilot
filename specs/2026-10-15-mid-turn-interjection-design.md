# 回合内补充说明与卡片叠弹 · Mid-turn interjection and card stacking — design

日期 / Date: 2026-10-15
涉及模块 / Areas: `sidepanel`（ChatTab 输入区与卡片渲染）、`background`（agent-channel、agent、index）、`lib`（messages、i18n）

关联计划 / Plan: `specs/2026-10-15-mid-turn-interjection-plan.md`

## 1. 需求原文 · Requested behaviour

dcc 在 2026-10-15 的三条命题（按提出顺序）：

1. **聊天中模型正在操作/输出时也要支持用户输入补充说明**，这样用户不必"点停止 → 再发一条"。
2. **发出补充指令后，工作流生成的后续输出要按这条指令调整** —— 即补充说明必须被**同一个回合**读到，而不是等到下一回合。
3. **卡片不要连续弹那么多**：已经弹出第二张卡片时，又弹出第三张。

原始痛点（停止→继续这条路径本身已损坏，本设计的目标是让用户不需要走它，缺陷另列 §5 记录）：

- 停止后继续，保存为工作流的弹窗有概率不再出现（`src/sidepanel/ChatTab.tsx:1962` 的 `promptedRef` 静默抑制）。
- 询问卡片（ask_user）点了以后整回合 pending（后台已强制结算、面板卡片未清，答案打到死 requestId 上）。

## 2. 现状取证 · Evidence about the current code

以下均由改动前的代码位置支撑，不是推测。

**一回合只允许一条消息，是硬门禁而非 UI 习惯。** `channels` 以 conversationId 为键（`src/background/agent-channel.ts:89`），`openTurnChannel` 撞上已有通道直接返回 `undefined`（`:115`），面板侧表现为 `index.ts:3136-3138` 的 `Still working on the previous message.`。所以今天"运行中再发一条"在协议层就不存在。

**面板输入区的禁用点只有一处判断。** `send()` 首行 `if (busy) return`（`ChatTab.tsx:2703`），textarea 本身没有 `disabled`/`readOnly`，所以用户**已经能打字**，只是回车与主按钮被 `disabled={busy || …}`（`:4185-4193`）吃掉。停止按钮是独立的 `:4180-4184`。改造成本低。

**回合内每轮实时读后台是既有先例。** `deps.getMode()` 在每个工具分发处 `await`（`agent.ts:5433, 5485, 5536, 5627, 5699, 5944`），注释明写"read freshly per action"（`index.ts:3288-3291`）。因此在轮边界再读一次"有没有新的用户补充"不引入新范式。

**往活回合的 `history` 里插 `role:'user'` 有既有实现。** `compactHistory` 就在轮边界原地插入 user 摘要（`src/lib/context-compact.ts:203-273`，插入点 `agent.ts:5092`）；user 轮是"脊椎"，压缩与硬截断都只动非 user 消息（`context-compact.ts:99-127`、`src/lib/storage.ts:757, 792-802`）。轮边界的安全性有注释背书：每个轮边界 `tool_call` 与 `tool` 结果都已配对（`agent.ts:5081-5082`）。

**计划门禁不会被注入误触发。** "one user message = one task = one plan" 的装填发生在进入循环**之前**（`agent.ts:5040-5042`），循环体内注入 user 轮不会重新武装 gate。

**取消不是错误路径。** `agent.ts:5253-5265` 对 abort 是 `return`（正常返回），`index.ts:3326` 照样发 `done`；`declineInteractions`（`agent-channel.ts:227-234`）把 ask_user/confirm/plans 三张待答请求全部强制结算并清空 map。但**没有任何消息通知面板撤掉已渲染的卡片**，面板只在点击（`ChatTab.tsx:2831`）或切会话（`:2537/2569/2607`）时清 `askUsers/confirms/plans`，`done`（`:2285`）与 `error`（`:2312`）分支都不清。→ 停止后旧卡片仍可点，点了就是死 requestId；`index.ts:3056` 忽略 `answerPending` 的返回值，静默丢弃。

**卡片叠弹的三处来源（都要治）。**

- 同一会话连续多张待答卡片：面板 append 型（`AskUserCard`/`PlanCard`/confirm 渲染于 `:3885-3911`），旧卡不清 + 新卡继续 append，就会"第二张已弹、第三张又来"。
- 保存卡片本身会在**同一回合未结束时被覆盖重建**：`maybePromptSaveWorkflow` 每次 `done` 都跑，`setWorkflowPrompt` 直接换整个对象（`:1969`），`modalOpenedForRef` 只在 `send()` 里复位（`:2763/2808`），因此停止→继续之间新回合会再次弹层（这正是 §1.1 用户走停止路径的副作用）。
- 弹出层没有互斥：generation loading（`WorkflowGenerationDialog`，`:4204`）、preparing 弹窗（`:4231`，z-9999）、save card 弹窗（`:4288`，z-9999）、AI refine 弹窗（`:3956`，注释明写"opens ON TOP of the save-card popup"）。层与层之间靠 z-index 叠加而不是排队。

**回合边界注入对工作流生成确实生效（对应需求 2）。** 工作流生成模式下每个节点放置都是一次工具调用（`runOneToolCall`，`agent.ts:5258`），下一轮请求重建 `messages = [{system}, ...history]`（`agent.ts:5098`）。把补充说明插进 `history` 顶端，模型在**下一个工具调用之前**就会读到它，后续放置的节点随之调整——这正是需求 2 的机制，不依赖"停止后继续"。

## 3. 设计 · Design

### 3.1 补充说明进活回合：队列放 channel，注入放轮边界

`ChatTurnChannel` 增加 `interjections: Interjection[]`（`{ id, text }`，它已经是每回合状态容器：`controller`/`transcript`/三张待答 map/`replay`/`latestUsage`，`agent-channel.ts:58-87`）。新增 `queueInterjection(conversationId, note)`（无活回合返回 `false`，不新建通道）与 `takeInterjections(channel)`（`splice(0)` 一次取空，天然幂等）。

协议三条（`src/lib/messages.ts`，封闭联合，漏处理由 `pnpm typecheck` 机检）：

- client `chat.interject { conversationId, text, noteId }` —— `noteId` 由面板生成，是这条便签的唯一身份。
- server `chat.interject.ack { conversationId, noteId, queued }` —— `queued:false` 表示回合刚好收尾，面板按普通新消息重发。
- server `chat.interjection.applied { conversationId, noteIds }` —— 回合把这些便签写进了 transcript，面板由此撤掉"待生效"标记。
- server `interactions.dismissed { conversationId }` —— 见 §3.3，与便签同属"回合边界状态收敛"。

`REPLAYABLE`（`delta`/`tool.start`/`tool.result`/`status`）**刻意不加 `chat.interjection.applied`**：注入会让 transcript 变长，重放缓冲被裁剪后这条 echo 可能已经不在缓冲里；便签的真正归宿是 `restore` 带回来的 user 轮，面板用 `restoredUserTexts` 对账即可（`ChatTab.tsx:2231`）。

注入逻辑收在 `agent.ts` 的 `applySupplements()`（`:5065`）里，两个消费点：

1. 轮边界（`:5111`，abort 检查之后、压缩与 `retireOldPageReads` 之前）：下一个工具调用尚未决定，模型在这里读到补充。
2. 最终答复处（`:5296`）：模型这轮不再调工具，但队列非空就说明还有指令没读——`continue` 让**同一个回合**继续跑，绝不返回。队列空了才返回 usage。

第 2 点是需求"只要队列非空，这个回合就不能结束"的落点。它放在 `runAgentTurn` 内部而不是 `index.ts` 再调一次：同一通道、同一 `history`、同一 usage 累加器，面板不闪断，也不会出现"我发了但没人接"。`AgentDeps.takeInterjections`（`:2278`）可选，未接线（无头 / 定时任务）时 `?? []`，一条注入都不会发生。

每条便签 push 成 `{ role:'user', content: wrapInterjection(note.text), displayContent: note.text }`：

- **user 轮**而非 tool 轮：user 轮是脊椎（§2），压缩与硬截断都不动它；tool 轮会被 retire。
- **`content` 带信封**（`src/lib/llm.ts:98`）：模型必须知道这句话是对**在飞任务**的补充，而不是新请求——不写清楚它就会重启任务。信封是本轮新增的决策，取代了本文初稿"原始文本直塞"的设想。
- **`displayContent` 存原话**：面板展示、持久化、`restore` 对账用的都是用户自己的字，信封只存在于模型上下文里。
- 不改写、不合并已有 user 轮；便签是独立的一条。
- 生效时并发一条 `status`（复用 worker 侧字典 `messages.chatInterjectionApplied`，`agent.ts:5081`）——用户看得到"这一步用上了我的补充"。

### 3.2 面板：输入框是唯一的补充入口，停止语义不变

- `busy` 时 textarea 本来就可输入（§2）；回车与主按钮改走 `interject()`（`ChatTab.tsx:2952`），主按钮文案换成"补充 / Supplement"，仅在草稿为空时禁用；停止按钮（`:4414` 附近）不动。
- `interject()` 生成 `noteId` 并**用它当本地 entry 的 id**，于是 echo、对账、退回输入框都只靠这一个身份：`notesRef`（`noteId → text`）记候选，`append({ id: noteId, role:'user', text, interjection:'queued' })`，清空草稿，**不**重置 `busy`、不动 generation dialog。
- **不做卡片内输入框**：ask_user / confirm / plan 三张卡片各自加一个文本框的话，协议要加三套"答案 + 便签"载荷，而"卡片等待时发的补充"最终也要在下一个轮边界被同一队列消费——语义完全重合。所以运行中唯一的补充入口就是输入框；卡片等待期间敲回车，便签照样入队，在用户答完之后的第一个边界被读到。
- 竞态回退：ack `queued:false`（回合刚好收尾）时，先撤掉乐观 entry 再把同一段文本按普通新回合发出（`startTurn(text)`，`:2358`），副本只会有一份。
- 回合收尾时仍有未被读取的便签：`reclaimUnappliedNotes()`（`:2103`）把它们标成 `interjection:'unapplied'`、文本退回草稿，用户能改能重发。**后台不额外发"未生效"消息**——没有 echo 就是没生效，缺位即信号，多一条消息只会多一个能发不出的分支。
- 附件与技能中途发送**不做**（`chat.interject` 只带文本）：中途换任务是另一件事，不属于补充说明。
- 面板看板上 `queued` 是 `text-muted`、`unapplied` 是 `text-warn`（`Entry.interjection`，`:177`，只活在前端视图，不进 transcript）。

### 3.3 卡片不叠弹：一张待答卡片 + 回合边界撤卡

规则：**一个会话同一时刻最多一张等待用户回答的卡片**。

- 三张待答 map 各带一个 `seq`（到达顺序，`cardSeqRef`，`:1574`），面板用纯函数 `headPendingCard()`（`:301`）按 `seq` 取队首，只渲染那一张（`:3550`）。后台的 pending map 是并发发出的（`requestAskUser` 等只 `emitToPanel`），排队放在面板，不改后台协议。
- 停止 / 回合结束撤卡：`declineInteractions()` 在强制结算三张待答请求的同时，向面板补发 `interactions.dismissed`（`agent-channel.ts`），面板 `clearPendingCards()`（`:2377`）；`done` 与 `error` 分支同样撤卡（`:2425, :2454`）并顺带 `reclaimUnappliedNotes()`。这消灭了"第二张已弹、第三张又来"里最坏的一类：旧卡不再永久挂着，也就不会再点到死 requestId 上。
- 撤卡消息只在**真有待答卡片**时发出（无待答 → 不发），否则面板会在没有卡片时收到无意义的信号；单测锁住这条（`tests/agent-channel.spec.ts`）。
- 弹出层（generation loading / preparing / save card / refine）维持现有"materialize 即撤上一层"的锁步（`ChatTab.tsx:1926-1938`）：保存卡片一弹就撤掉 loading 层，且 `modalOpenedForRef` 保证**一张卡片只弹一次**——后续 probe / review 更新不会把它强行重新弹起。保存卡片本身只在 `done`（回合已结束）时才会被 offer，因此不会与正在进行的生成叠层；`startTurn` 复位该 ref（`:2895`、`:3003`），所以真正的新回合仍能正常弹一次。

### 3.4 进度弹层：只显示进度，停止要有终态

- `WorkflowGenerationViewState` 增加 `'STOPPED'`，标题走 `workflowGenerationStopped`（"生成已停止 / Generation stopped"）；停止按钮把已打开的弹层置成这个状态（`ChatTab.tsx:4414` 区块），`generationStages` 把 `STOPPED` 计入 `warn`。
- 动作日志 `<details>` 不再默认展开：弹层的职责是上方的进度，不是把日志冻在那儿。

## 4. 否决的方案 · Rejected alternatives

- **停止并立刻重启回合（auto stop-then-continue）**：不用改 agent 循环，但要跟 `openTurnChannel` 的互斥（`agent-channel.ts:115`）和面板 `busy` 复位时序打架，并且每次补充都会走 §5 那条已损坏的停止路径；还会把一次任务切成两个"用户消息 = 一个任务"，与计划门禁口径冲突。
- **每条补充都开新回合（前端排队代发）**：面板看起来简单，但工作流生成的草稿是按回合计的，且 `promptedRef` 抑制（§5）会在补充回合上再现"不弹保存卡片"。
- **`index.ts` 里再调一次 `runAgentTurn` 处理残留**：新的一次调用要重新开通道、重新累加 usage、面板会看见回合重启的抖动。队列非空就 `continue`（§3.1 消费点 2）在同一函数里收尾更简单，且"回合不能结束"这条约束只需要在一个地方表达。
- **补充说明直塞原文、不加信封**：本文初稿的判断，最终被推翻——不告诉模型"这是对在飞任务的补充"，它有把任务重新开始的风险。折中是信封进 `content`、原话进 `displayContent`：模型读到约束，用户与持久化看到自己的字。（注意这条约束只由提示词语义支撑，尚无真实浏览器证据，见 §6。）
- **三张卡片各加一个补充输入框**：要在 `AskUserAnswer`/`PlanDecision`/confirm 回执上挂便签载荷，协议面扩大，而这些文本最终仍是入队给同一个 `interjections` 队列——直接用输入框即可（§3.2）。
- **后台补发"未生效"消息**：与 ack 的 `queued:false`、回合结束时的 echo 缺位三处重叠，多一条消息就多一个可能发不出的分支；面板用"没有 applied echo"当唯一判据。

## 5. 已知遗留（本次不修，已记录） · Known defects left open

1. `promptedRef` 的步数抑制（改动后仍在，`ChatTab.tsx:2017, 2022`；改动前位于 `:1962, 1967`）：停止那一轮也会跑 `maybePromptSaveWorkflow`（abort 走正常返回 → `done`），于是记下了当时的节点数；继续那一轮若节点没有净增，就命中 `>= steps` 提前 return —— 既不弹卡片也不给 `saveNotice`，纯静默，用户无法保存。本设计让用户不再需要走"停止→继续"，但没有消除这条路径。修法（下轮）：抑制条件从"步数没增长"改成"上一张卡片已被用户明确处理（保存/跳过）"。
2. `index.ts:3070-3080` 把 `answerConfirmation`/`answerAskUser`/`answerPlan` 的返回值丢掉：死 requestId 静默丢弃（`answerPending`，`agent-channel.ts:369`）。§3.3 的撤卡让它不再可达，但后台仍应把"答案无效"变成可见信号。

这两条都是"该随回合结束一起死掉的状态没死掉"的同一个形状，与 §3.3 同源，下一主题一并收。

## 6. 已接受的窄竞态 · Accepted race

ack `queued:false` 的判定与旧回合的 `done` 是两条独立消息，面板可能先收到 ack、再收到 `done`：`startTurn()` 已把 `busy` 置真，随后旧回合的 `done` 把 `busy` 清零。后果只是那一条新回合在面板上看起来"没在跑"；用户在框里再打一句发出去，要么被 `chat.interject` 接进正在跑的通道，要么命中后台的一回合互斥（`index.ts:3175`，硬编码的 `Still working on the previous message.`，那条消息今天已不被 `REPLAYABLE` 重放，所以面板不会卡死）。不丢消息、不会双跑。修法要么在 `startTurn` 里带回合代际（generation）标记、`done` 只清当代，要么让 ack 与 `done` 走同一通道顺序保证——都属于回合状态机收口，与 §5 同源，本次不为它加一层。

## 7. 证据状态 · Evidence status

离线门禁（`pnpm typecheck` / `test` / `lint` / `format:check` / `build`）全绿，注入顺序、echo 对账、撤卡与单卡片串行都由单测/组件测试覆盖（`tests/agent-interjection.spec.ts`、`tests/agent-channel.spec.ts`、`tests/workflow-generation-dialog-fix.spec.tsx`）。

真实浏览器证据：**BLOCKED**。side panel 是扩展页，CDP 驱动不了（项目既有结论），因此 §3.1 消费点 2「队列非空回合不能结束」在真实模型面前的表现、§3.4 弹层终态与 §4 的信封有效性尚未在浏览器里观察到。加载 unpacked 后需覆盖：运行中发补充 → 后续工具调用按补充调整 → 停止按钮仍可用 → 最终保存卡片只弹一次 → 运行中不再出现第二、第三张待答卡片。
