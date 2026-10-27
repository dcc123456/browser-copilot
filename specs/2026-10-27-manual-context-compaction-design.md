# 聊天面板支持手动压缩上下文（2026-10-27）

## 1. 诉求（dcc 原话）

> 同时需要支持可以手动压缩上下文

即在已有的「到 90% 自动压缩」之外，用户可以在聊天面板里**主动**触发一次上下文压缩，
不必等到阈值，也不必新开对话。

## 2. 现状取证

- 压缩逻辑全部在 worker 侧：`compactHistory`（`src/lib/context-compact.ts:236`）就地改写
  `history`，摘要由 `agent.ts` 里**模块私有**的 `summarizeTranscript`（`src/background/agent.ts:4847`）
  产出；自动路径有三个入口（usage 驱动 `:5162`、估算驱动 `:5205`、400 补救 `:5336`），
  都复用同一个 marker（`messages.contextCompactedMarker`）与同一个 summarizer 配置。
  → 手动路径必须复用它们，不能再写第二个 summarizer（AGENTS §5.2/§5.6）。
- 面板**不允许**直接写内容键：`tests/panel-no-direct-writes.spec.ts` 把
  `saveConversation` / `touchConversation` / `deleteConversation` 等列成 UI 禁 import 名单，
  写操作必须走 `sendCommand`（`src/lib/messages.ts:1094`）→ `handleCommand`（`src/background/index.ts:1336`）。
  现成的同类先例：`conversations.rename`（`index.ts:1626`）、`conversations.delete`（`:1629`）。
- 重渲染有现成通路：面板向 agent port 发 `{ type:'resume', conversationId }`
  （`index.ts:3487`），worker 读 `channel?.transcript ?? persisted`、回
  `{ type:'restore', messages, running }`，`ChatTab.tsx:2265` 的 `case 'restore'` 整体替换 entries。
  回合结束时 worker 广播 `conversation.ended`（`index.ts:3795`），面板监听器（`ChatTab.tsx:2625`）
  正是用这条 resume 把最终 transcript 拉回来。
  → 回合结束后 channel 已被 `closeTurnChannel`（`index.ts:3790`）关闭，所以**空闲时** resume 读到的
  就是刚写入的持久化 transcript，手动压缩后直接复用这条路即可，不需要新的刷新机制。
- 面板没有 toast：`src/ui/toast.tsx` 的 `toast()` 需要一个 `<ToastHost />`，而它只挂在
  `src/workflow-editor/App.tsx:1903`；`src/sidepanel/App.tsx` 里挂的是 `ConfirmHost`，没有 `ToastHost`。
  连带后果：`src/sidepanel/RunningBoard.tsx:172` 那句 `toast(t.taskRunWindowGone, 'error')` 目前是空操作。
- 为什么不能用 status 行报结果：`case 'restore'` 是 `setEntries(restored)` 整体替换，
  任何先落地的 status 条目都会被抹掉；restore 与 status 的先后只能靠异步时序猜。

## 3. 决策

**D1 手动压缩是一条 Command，不是 port 消息。** `conversations.compact` 与
`conversations.rename/delete` 同族：改的是持久化的会话内容键，必须由 worker 执行。
返回 `{ outcome: 'compacted' | 'nothing' | 'busy', removed }`；`sendCommand` 抛错（没有配置
provider、写盘失败）时面板报失败。结果文案由面板用 `t` 渲染，worker 不参与 i18n 拼装。

**D2 压缩就是自动路径那次压缩，只是更早、由用户触发。** 新增 `compactConversationOnRequest(history, conversationId)`
（导出在 `agent.ts`，紧挨 `summarizeTranscript`）：读 active provider、按同一 `attribution`
（`consumer: 'context-compaction'`）拼 summarizer 配置、用同一个 `contextCompactedMarker`，
调 `compactHistory` 并**沿用默认 `keepRecentTurns = 2`**。
不新增参数、不新增模式、不改摘要 prompt——手动与自动可预期地一致，`user` 回合照旧逐字保留
（`specs/2026-10-14-user-turn-spine-design.md`）。
`summarizeTranscript` 保持私有，只导出这一个入口，避免出现第二条 summarizer 调用路径。

**D3 重渲染复用 `resume` / `restore`。** 命令成功后面板 `post({ type:'resume', conversationId })`，
把 port 通路抽成 `requestResume()`，与 `conversation.ended` 监听器共用一份实现（第二次出现即抽公共层，AGENTS §5.2）。

**D4 回合进行中一律拒绝。** worker 用 `channelFor(conversationId)` 判定：有 channel 就返回 `busy`，
不碰 transcript。原因不是"体验"而是数据正确性——回合的权威 transcript 在内存里（`attachTranscript`），
持久化副本要等 `finally` 才写；此时压缩持久化副本再落盘，会覆盖正在进行的工作。
面板同步把按钮和发送都禁用（`compacting` 状态），把同面板的竞态窗口关掉。

**D5 入口是 composer 动作行的一个图标按钮，不加确认弹窗。** 位置在附件按钮与「新会话」之间
（`ChatTab.tsx:4331` 的 `.actions`），`disabled={busy || compacting || entries.length === 0}`，
进行中复用既有的瞬时 phase 行（`showPhase(t.chatCompactRunning)`）。
不弹确认：自动压缩本来就会静默做同样的改写，手动触发反而要求确认，口径不一致；
且 user 回合不动、信息以摘要形式保留，丢失面与自动路径同量。
结果用 toast 报（成功带条数 / 无可压缩 / 忙 / 失败），因此本切片顺带把
`<ToastHost />` 挂进 `src/sidepanel/App.tsx`——复用既有设施，同时修好 RunningBoard 那条现在不响的 error toast。

**否决项。**

- 新增 `chat.compact` port 消息 + `chat.compact.result` 回包：能解决 status 与 restore 的顺序，
  但要为一次性反馈新增一对 port 消息类型和面板分支；命令 + toast + resume 全部走现成通路。
- 面板本地"就地改写可见 entries"：等于在 UI 里重算一遍 transcript，违反 §5.2，且和 worker 持久化的
  内容对不上，下次 resume 又翻回去。
- 加「压缩到多少 token」的输入框或预览：需要新参数、新 UI、新口径；手动路径的正确定义就是
  「现在执行那次本来会自动执行的压缩」。
- 用 confirmDialog 做二次确认：见 D5，与自动路径不一致。
- 复用 `conversation.ended` 广播触发重渲染：语义是"回合结束了"，借用它会让其他面板在无关时刻重拉历史。

## 4. 边界

- **跨面板竞态**：另一块面板在压缩在途时发起回合，仍可能读到压缩前的持久化副本。
  这与 `conversations.rename` 的暴露面相同（现有代码没有跨面板互斥），本切片不新造锁。
- **无 provider**：`getActiveProvider()`（`src/lib/storage.ts:451`）直接抛错，命令失败 → 失败 toast。
  不会因为"没有 LLM"而退化成机械摘要去重写用户的历史。
- **有 provider 但摘要请求失败**：`compactHistory` 内部的 digest 兜底照旧生效（与自动路径一致），
  压缩仍会完成，摘要质量降级。
- **可压缩性**：不足 3 回合（`segments.length - keep <= 0`）时 `compactHistory` 返回 null，
  面板报"还没有可压缩的内容"，不写盘。
- 只作用于当前会话；`subAgent`、定时任务、Runner 的 transcript 不受影响（没有面板入口）。

## 5. 测试与验收

`tests/agent-compact-manual.spec.ts`（新增）：

1. 用 4 个完整回合的历史调用 `compactConversationOnRequest`：`removed > 0`，
   `user` 回合逐字保留，最早的非 user 消息被一条带 marker 的摘要替换（就地改写的契约）。
2. 摘要请求确实是同一条通路：mock `streamCompletion`，断言 system prompt 命中
   `You compress the earlier part`，且不带 tools、`maxTokens` 与自动路径一致。
3. 未配置 provider（`getActiveProvider` reject）时**抛出**，历史未被改写（不退化成 digest）。
4. 回合数不足时返回 null，且没有发起任何摘要请求。

`tests/chat-compact-button.spec.tsx`（新增，jsdom 渲染真实 ChatTab）：

5. 点按钮发出的是 `conversations.compact` 命令（面板不自己改写 transcript），成功后
   在 port 上补发一次 `resume` 重拉 transcript，并把条数报给用户。
6. `outcome:'nothing'` 时**不**重拉、不改写，只报"还没有可压缩的内容"。
7. 回合进行中（`restore` 带 `running:true`，面板 busy）按钮 `disabled`。

门禁：`pnpm typecheck`、`TZ=UTC pnpm test`（475 files / 5538 tests 全绿）、tracked eslint/prettier、`pnpm build`。

⑤ 浏览器实证（2026-10-27，`tmp/manual-compact-probe.mjs`，Playwright + Chrome for Testing 加载
`dist/` 真实扩展，打开真实 sidepanel 页面；provider 指向 probe 起的 `127.0.0.1` SSE 假端点）：
播种 5 回合会话（`conv:default` 10 条消息）→ composer 出现 `压缩上下文` 按钮且 enabled →
点击后假端点收到**恰好 1 次**请求（system prompt 命中 `You compress the earlier part`）→
ok toast「上下文已压缩：较早的 3 条消息已合并为一段摘要。」→
视图 `[data-role]` 统计由 `user 5 / assistant-turn 5` 变成 `user 6 / assistant-turn 2`
（多出的那条 user 就是摘要，`[Context compacted] Summary of the earli…`，5 个提问一个不少），
`ANSWER-1/2/3` 消失、`ANSWER-4/5` 保留 → 存储里 `conv:default` 变成 8 条 →
再点一次得到 info toast「暂时还没有可压缩的内容——至少需要三轮以上的回复。」，视图不变。
另外实证了失败路径：provider 未配置时命令返回
「No model provider configured…」，面板出 error toast，历史 10 条**未被改写**；
`<ToastHost />` 挂上后面板里的 toast 才真的渲染（此前 `RunningBoard` 那句 error 是空操作）。
截图 `tmp/manual-compact-after.png`。
