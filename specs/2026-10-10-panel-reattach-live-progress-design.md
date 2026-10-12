# 设计：面板重开后聊天进度不断流（minimize → reopen 仍能看到实时进度）

日期：2026-10-10
状态：设计定稿，实现随本文同批落地。

## 1. 问题

聊天里 AI 正在执行任务时把侧边栏最小化（或关掉），再重新打开：**任务确实在后台继续跑**，但聊天窗口里进度不再更新——只剩一个 spinner 一直转，直到这一回合结束才一次性跳出最终答案。中间执行了哪些动作、写了哪些字，重开之后全看不到。

代码事实（根因）：

- 最小化会真正关闭 Chrome 侧边栏，面板端口随之断开：`src/background/panel-minimize.ts:1-20` 模块头明确写了「The Chrome side panel is closed in the process, which disconnects the panel port」。
- 回合的输出管道是在收到 `chat` 那一刻闭包捕获的**那个 port**：`src/background/index.ts:2902`（`send`）与 `:3035`（`sendWithTracking`，`runAgentTurn` 的 `deps.send` 就是它，`:3184`）。端口死后 `postMessage` 抛错被 `:2905-2907` 的 `catch {}` 咽掉，于是重开后的新端口**永远收不到**后续 `delta` / `tool.*` / `status` / `done`。
- 这一点代码里已经自认：`src/background/index.ts:3264-3268` 注释「The turn's stream went to the port that existed when it started; a panel reopened mid-turn is watching a different (or no) port」，`:3269` 的补救只是回合结束时广播 `conversation.ended` 让面板重新拉一次**最终**转录——所以用户看到的是「卡住 → 突然完成」。
- 重开时面板确实发了 `resume`（`src/sidepanel/ChatTab.tsx:2349-2358`），后台也确实回了 `restore` + `running`（`src/background/index.ts:2965-2994`），但**只回快照，没有把流改道**。`restore` 的快照来自 `liveHistories`（`:2870`），而 `liveHistories` 里是 `runAgentTurn` 正在原地 mutate 的那个 `history` 数组——它只在**每个模型回合结束时**才被 push（`src/background/agent.ts:5149`、`:5153`），所以快照永远缺着正在生成的那一段。
- 顺带同源的第二个缺陷：`confirm` / `ask_user` / `present_plan` 的 resolver 表也在端口闭包里（`src/background/index.ts:2884-2899`），请求走同一个死 `send`（`:3200`、`:3210`、`:3220`）。最小化**之前**挂起的请求会在断开时被当作拒绝解开（`:3290-3297`，这是刻意设计）；但最小化**之后**新起的请求没人能答——面板上压根不出现卡片，回合一直吊在那里。
- 面板侧的重连渲染也不对：`src/sidepanel/ChatTab.tsx:2127-2128` 把 `streamingRef` 重新挂到「最后一条 assistant」上，而重开后到来的增量属于**下一个**回合，会被拼进上一回合已完成的段落里。

## 2. 现状里已经存在的可复用件（不新造同类设施）

- `chrome.runtime.Port` 的注册表已经在按窗口维护活端口：`src/background/automation-scope.ts:57-116`（`registerPanelWindow` / `unregisterPort` / `broadcastPanels`）——但它服务的是「同一窗口所有面板端口」的广播（review log 用的就是 `broadcastPanels`），不是「某个会话的某个回合该发给谁」。
- `liveHistories` + `activeTurns` 两个模块级 Map/Set（`src/background/index.ts:2799`、`:2870`）已经是「按会话 id 索引回合状态」的注册表，只是字段太薄：只有 transcript，没有 sink、没有 pending、没有重放。§5.6 要求配置/状态类设施只许收敛——本次把这两处**合成一个**回合通道注册表，而不是再加第三个 Map。
- 面板侧 `tool.result` 已经能处理「没有 live start 的结果」（重连场景）单独成卡：`src/sidepanel/ChatTab.tsx:2201-2227` 注释即「A result without a live start (reconnected mid-turn) appends its own completed card」。
- 面板侧 transient 进度行机制现成：`showPhase` / `clearPhase`（`src/sidepanel/ChatTab.tsx:2039-2056`），首条真实内容到达即自动消失。
- 渲染分组现成：`groupEntries`（`src/sidepanel/ChatTab.tsx:182-198`）把连续的 assistant/tool 条目折成**一个** turn 气泡，所以重连时新起一段 assistant 文本不会被渲染成两个气泡（`tests/chat-think-tools.spec.tsx:115-179` 已钉住这个契约）。

## 3. 决策

### 3.1 输出管道改道（已拍板：会话级通道 + resume 时换 sink）

| 候选                                                                | 结论                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 回合输出经**会话级通道**的 `sink`，`resume` 时把 sink 换成新端口 | **采纳**。改动集中在「谁持有 sink」这一层：sink 是通道上的可变字段，回合代码只调 `emitToPanel(channel, msg)`，换端口不需要动 `runAgentTurn` 或任何调用点。顺带把 confirm/ask_user/plan 的 resolver 一起搬进通道，第 1 节的吊死缺陷同批消除。                                                       |
| B. 直接复用 `broadcastPanels()` 广播给该窗口所有端口                | 否决。①`broadcastPanels` 是**全窗口**扇出（`automation-scope.ts:107` 遍历所有窗口所有端口），会把 A 会话的流漏给别的会话面板；②换窗口重开（用户在另一个窗口打开面板）仍然接不上，因为回合捕获的是旧 windowId；③resolver 仍在死端口闭包里，卡片能显示但答不了——进度「看得见、点不动」比现在更迷惑。 |
| C. 把正在生成的 assistant 文本实时写进 `history`（快照自带）        | 否决。`history` 是**喂给模型**的线协议数组，中途塞进半截 assistant 会让下一轮请求带上未完成的段落，也会污染 `saveConversation` / compaction 的语义。为了 UI 去改模型侧数据契约，代价与收益不匹配。                                                                                                 |

### 3.2 断线期间丢掉的进度怎么办（已拍板：重放到「当前未完成回合」为止）

只做快照换 sink（3.1-A）不够：重开后看到的是「上一个已完成回合」，随后的增量属于下一个回合，中间那段（最小化期间流的字）永远缺失，而且会与快照错位。

| 候选                                                                        | 结论                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 通道里缓存**尚未进入 transcript** 的展示事件，`resume` 时随 restore 重放 | **采纳**。缓存的失效判据用现成的结构事实：transcript 每变一次（`agent.ts` 的 push），上一段事件就已经被快照覆盖，直接清空重放缓冲。因此重放内容恒等于「快照之后的未完成部分」，天然幂等（面板每次 reconnect 都会先 `restore` 整体替换再重放，重复 reconnect 不会重复上屏）。 |
| B. 重放整回合所有事件                                                       | 否决。已经在 transcript 里的文本/工具卡会被渲染两遍。                                                                                                                                                                                                                        |
| C. 不重放，只保证此后实时                                                   | 否决。用户明确要「重开还能看到进度」，缺头的一截答案 + 缺失的动作卡（尤其 workflow 生成模式下那段长长的动作序列）正是他抱怨的东西。                                                                                                                                          |

只重放 `delta` / `tool.start` / `tool.result` / `status`，外加**最新一条** `usage`（它是回合累计快照，重放最新值即可复原 token 条）；`phase` 是瞬时态，不重放。缓冲按条数上限淘汰最旧，防止长回合无界占内存。

一个例外必须由实现补上（原设计在这里写错了一次，是单测把它抓出来的）：**断线之后新产生的** `confirm.request` / `ask_user.request` / `plan.request` 在重开时要重新送到活端口。否则卡片只落到哑 sink，resolver 永远吊在通道上，回合卡死而面板毫不知情——这正是旧实现里已经存在的缺陷。所以 `handOff` 除了重放缓冲，还会重发通道上仍挂起的请求；面板侧按 `requestId` 去重，重复 `resume` 不会叠出两张一样的卡片。而**断开那一刻已经挂在屏幕上**的卡片仍按拒绝/取消解开（3.4 之下的 6 行验收），因为用户已经看过并错过它们了。

transcript 变短（`agent.ts` 的压缩 / `hardCapHistory` 裁掉旧回合）也会触发缓冲清空：这是外观层面的损失（重开时少看到一段已经不在快照里的中间文本），换来的是永不重复上屏，可以接受。

### 3.3 面板侧（已拍板）

- `restore(running)` 时不再把 `streamingRef` 挂回最后一条 assistant，而是留空让首条（重放的或实时）增量新起一段——`groupEntries` 仍折进同一个 turn 气泡，段落不会错位。
- 「已重新接上」提示改走现成的 transient phase 行（`showPhase`），首条重放内容一到就消失；否则它作为普通 status 条目插在快照与重放内容之间，会把同一回合折成两个气泡。

### 3.4 归属规则（记录，不重开）

同一 conversationId 的流**归最后 `resume` 它的那个端口**（跨窗口重开、或面板内切换会话再切回，都是这一条）。这是 `resume` 携带 conversationId 的直接推论，也修好了「面板切走会话时那个回合的流无处可去」的老毛病。

### 3.5 `cancel` 必须跟着换语义（实现时定）

旧实现里 `cancel` 不带会话 id，中止的是「本端口最后一次 `chat` 起的那个 controller」。回合的 AbortController 搬到通道上之后，若继续按端口归属来中止，会出现两个新问题：一个面板同时看着多个会话的流时，Stop 会把不相干的会话一起打死；反过来，谁 `resume` 过就不再是「发起者」的面板会失去停止自己回合的能力。

所以 `cancel` 加上 `conversationId`，语义变成「停掉这个会话正在跑的回合」——与 Stop 按钮的可见对象（屏幕上那个会话）严格一致，且 `busy` 本来就是按会话存的。协议里仅此一处改动，`resume` / `restore` / 增量类消息一概不动。

## 4. 落点

| 文件                              | 改动                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/background/agent-channel.ts` | 新增：回合通道注册表（`openTurnChannel` / `closeTurnChannel` / `channelFor` / `emitToPanel` / `handOff` / `detachOwner` / `declineInteractions` / 三类请求的 `request*` 与按 requestId 路由的 `answer*`）。独立成模块沿用 `background/restore.ts:1-9` 的理由——`index.ts` 一 import 就注册监听，测试没法碰。 |
| `src/background/index.ts`         | 删掉 `activeTurns` + `liveHistories` 两个注册表（合并进通道）与端口闭包里的 `pending*`/`controller`；回合输出全部走 `emitToPanel`；`resume` 换 sink + 重放；`confirm`/`ask_user.answer`/`plan.decision` 按 requestId 跨通道路由；`cancel` 按 conversationId 中止；`onDisconnect` 走 `detachOwner`。         |
| `src/sidepanel/ChatTab.tsx`       | 3.3 两条 + 卡片按 `requestId` 去重（重发不叠卡）+ Stop 带上当前会话的 `conversationId`。                                                                                                                                                                                                                    |
| `src/lib/messages.ts`             | 只有 `cancel` 加 `conversationId`（3.5）。其余**不改协议**：`resume` / `restore` / `delta` / `tool.*` / `status` / `usage` 全是既有类型，重放复用同一批消息。                                                                                                                                               |
| `tests/agent-channel.spec.ts`     | 通道单测：换 sink、重放内容与 transcript 变化后的清空、上限淘汰、`usage` 取最新、断开时 pending 解开、断线期间新产生的请求重发且不重复投递、requestId 路由、回合结束关通道。                                                                                                                                |
| `tests/chat-think-tools.spec.tsx` | 复用该文件已有的 ChatTab 端口 mock，加一例：`restore(running)` + 重放增量 → 同一气泡里继续实时更新，且不重复上屏。                                                                                                                                                                                          |

## 5. 验收行

1. 回合进行中面板断开（模拟 `port.onDisconnect`）→ 通道保留、sink 变哑、后续事件进缓冲，回合继续跑完并落库（沿用既有「不 abort」设计 `index.ts:3282-3301`）。
2. 同一 conversation 重新 `resume` → 先收到 `restore`（快照含已完成回合，`running: true`），紧接着收到缓冲里的 `delta`/`tool.*`/`status` 与最新 `usage`，此后的实时事件继续到达新端口。
3. 断开期间 transcript 变过（有 push）→ 缓冲在下一个事件发出时清空；`resume` 时若 transcript 已增长同样先清 → 重放不重复快照已含内容。
4. 面板在同一端口上重复 reconnect 并重复 `resume` → 每次都是 restore（整体替换）+ 重放，屏上不出现重复段落。
5. `confirm` / `ask_user` / `plan` 请求在**重开之后**产生 → 卡片到达活端口，用户点批准后 resolver（在通道上）被解开，回合继续（不再吊死）。
6. 断开时**已挂起**的请求仍按拒绝/取消解开（保持 `:3290-3297` 既有语义）。
7. `cancel` 带 conversationId → 只中止该会话通道的 AbortController，并解开它挂起的请求；别的会话不受影响（3.5）。
8. 回合 `finally` 关闭通道并清空缓冲（不随 worker 生命周期泄漏）；`conversation.ended` 广播保留作兜底。
9. 纯逻辑层：`pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm format:check` / `pnpm build` 全绿并贴输出。
10. 浏览器证据（⑤）：本环境无法脚本化扩展自身页面（side panel），标 **BLOCKED**，附人工复现步骤。
11. 断线期间新产生的请求卡片在重开后到达活端口（重放缓冲之外的独立一路），同一张卡重复投递不会在屏上叠成两张。

## 6. 人工验证步骤（待用户在真 Chrome 上跑）

1. `pnpm build` → chrome://extensions → 重新加载 unpacked `dist/`。
2. 打开侧边栏，发一句会跑很久且必然调工具的话（例如「打开 news.ycombinator.com，把前 10 条标题读出来并逐条说明」）。
3. 进度刚开始滚动时点最小化（收成页面浮钮）。
4. 等 10–20 秒后从浮钮/工具栏重新打开侧边栏。
5. 期望：立刻看到此前跑完的动作卡与文本（重放），并且**新的动作卡与文字继续逐条上屏**；token 条数值不为 0 且继续增长；回合结束时正常收敛并弹出保存卡片。
6. 反向检查：第 4 步之后再最小化一次并重开，不应看到重复段落。
7. 权限确认路径：让任务触发一次需要批准的操作（例如写类工具），在等待期间最小化并重开，期望卡片出现且点「批准」后任务真的继续。
8. Stop 只停当前会话：开两个会话各跑一个长任务（另一个用第二个窗口/第二个面板看），在看着 A 时点 Stop，期望只有 A 收敛为「已取消」，B 的进度继续在 B 那边滚动。
