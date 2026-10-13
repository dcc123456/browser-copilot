# 中断的 tool 轮次污染会话 · Aborted tool rounds poison the transcript — design

日期 / Date: 2026-10-13
涉及模块 / Areas: `lib`（出网口）、`agent`（全自动循环）、`background`（停止按钮）、`storage`（转写落盘）

## 1. 需求原文 · Requested behaviour

用户报告（全自动模式聊天）：

1. 模型正在输出时点击「停止 / Stop」；
2. 之后再发送任何请求，报错
   `MiniMax request failed (500): data: {"type":"error","error":{"type":"server_error","message":"unknown error (1000)",...}}`；
3. **该会话从此无法继续**，每一条后续消息都以同样的 500 失败。

期望：停止是一次可恢复的动作——按停止之后，同一个会话还能继续聊。

## 2. 根因取证 · Evidence about the current code

以下均由代码位置支撑，不是推测。

- 停止按钮发 `{ type: 'cancel', conversationId }`（`src/sidepanel/ChatTab.tsx:4180`），worker 侧
  `channel.controller.abort()`（`src/background/index.ts:3020-3031`）。Tasks 看板的取消复用同一个
  controller（`index.ts:3059`、`running-tasks.ts:369`），所以「看板里取消」与「点停止」后果完全一致。
- 全自动循环 `runAgentTurn`（`agent.ts:4769`）里，每一轮先落 assistant 轮再执行工具：
  - `agent.ts:5156-5160` 无条件 `history.push({ role:'assistant', content: …, tool_calls: result.toolCalls })`；
  - `agent.ts:5162-5166` 在**执行任何工具之前**检查 `deps.signal?.aborted`，命中就 `return`——
    此时那条 assistant 已经进了 history，**一个 `role:'tool'` 结果都没有**；
  - `agent.ts:5172-5175` 在**工具执行中途**被 abort：`runOneToolCall` 里 `executeTool` 抛 AbortError
    （`agent.ts:5922/5948`）会跳过 `pushResult`（`agent.ts:5302-5304`），于是同一轮的
    第 k+1…n 个调用**永远没有结果**。
- `abort` 落在流式增量阶段是安全的：读流直接 reject，`agent.ts:5107` 捕获后返回 `null`，**不 push**。
  所以本 bug 的现场是「输出完这一轮、工具还没（全部）跑完」这个窗口——正好是用户看到的
  「正在输出时按停止」。
- 半成品被**永久落盘**：`index.ts:3246-3262` 的 `finally` 原样 `saveConversation(conversationId, history)`，
  注释本身就写着 "Persist whatever was accumulated, including partial tool exchanges"。
- 出网口**不做任何校验**：`toApiMessages`（`src/lib/llm.ts:88-90`）对非 user 消息原样 `return message`。
- 落盘裁剪只管另一个方向：`trimConversation`（`src/lib/storage.ts:763-771`）保证窗口**开头**不是孤儿
  `tool` 结果，对**结尾**悬挂的 `tool_calls` 无感；且 `messages.length <= 200` 时是 no-op。
- 因此每次发送都会重放这个非法结构 → provider 报错 → 会话彻底锁死。500 还在
  `RETRYABLE_STATUS`（`llm.ts:414`）里，会被**白重试 3 次**（`LLM_MAX_ATTEMPTS = 3`）才抛给用户。
- 报错文案形状可复核：`describeHttpFailure`（`llm.ts:683-715`）对 SSE 错误体 `JSON.parse` 失败，
  退化成 `text.slice(0, 300)`，于是出现 `…request failed (500 ): data: {"type":"error",…}`；
  同形状的既有断言见 `tests/agent-length-error.spec.ts:6`。
- 另一条同源污染路径（本次一并兜住，但不改因）：`SseAccumulator` 允许
  `{ index, id: '', name: '', arguments: '' }`（`llm.ts:373`）与流被截断的半截 `arguments` 进入
  `toolCalls`，`finishReason`（`llm.ts:315/354`）**全仓库无人消费**（`grep` 确认）。

MiniMax 在代码里没有任何特判：它是 OpenAI 兼容 preset（`src/lib/providers.ts:203-214`），
走同一个 `POST {baseUrl}/chat/completions`。所以「补全配对」修的是协议层，不是 vendor 补丁。

## 3. 方案决策 · Options considered

| 候选                                                   | 结论                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 落盘时就不再保存悬挂轮次（改 `index.ts` 的 `finally`） | **否决**：只救扩展聊天一条路；`runner` / `agent-unattended` / 委派子 agent 都不经过它；且用户**当前已经坏掉的会话**仍然要靠新建会话或清数据才能恢复。                                                  |
| 直接丢掉末尾未配对的 assistant `tool_calls` 轮         | 可行但更粗暴：那一轮的意图从模型视野里消失，模型可能重复执行已被停止的动作。                                                                                                                           |
| **出网口补合成 tool 结果（选定）**                     | 单一咽喉点 `toApiMessages`（`llm.ts:511` 是全仓库唯一的出网构造点，`grep` 确认）覆盖全部宿主；已损坏的转写在下一次发送时**自动 heals**，无需数据迁移；模型能明确看到「这个调用被用户中断、并未执行」。 |

### 选定方案的规则 · Repair rules

新增纯函数 `closeInterruptedToolRounds(messages): WireMessage[]`，由 `toApiMessages` 在映射前调用：

1. 每个 assistant `tool_calls` 轮后面**必须**跟齐：缺失的调用补
   `{ role:'tool', tool_call_id, content: <中断标记>, name }`，顺序与 `tool_calls` 一致；
2. `function.arguments` 不是合法 JSON（流被截断）→ 修成 `'{}'`，避免 provider 解析失败；
3. `id` 为空的调用（`llm.ts:373` 的半成品）整条丢弃；若该轮因此一个调用都不剩，assistant 降级为纯文本轮；
4. 找不到归属 assistant 轮的孤儿 `tool` 结果丢弃；同一 `tool_call_id` 重复结果只保留第一个；
5. 已配对的转写**逐字节不变**（幂等，不注入任何合成内容）。

边界（有意不做，遵守 §5.5）：不动 `agent.ts` 的中断分支、不改 `saveConversation` 落盘内容、不引入
`finishReason` 消费链路、不加 provider 特判。落盘仍保留真实的「未跑完」现场，面板因此还能显示用户
亲手叫停的那一轮；非法形状只在出网的一瞬间被修补。

## 4. 交付物 · Deliverables

| #   | 交付物                                              | 位置                               |
| --- | --------------------------------------------------- | ---------------------------------- |
| D1  | 本文档                                              | `specs/2026-10-13-…`               |
| D2  | `closeInterruptedToolRounds` + 接入 `toApiMessages` | `src/lib/llm.ts`                   |
| D3  | 单元用例 + 中断复现用例                             | `tests/tool-round-pairing.spec.ts` |

## 5. 验收 · Acceptance

- ① `pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm format:check` 全绿（贴命令与输出）。
- ② 未改 Runner 侧代码，但 `src/lib/llm.ts` 属跨端共享文件：`pnpm server:typecheck` / `pnpm server:test` 一并跑。
- ③ 未触碰 `ai-takeover.ts` 与 `workflow-engine/**` → `bench:debug` 不适用（标 N/A）。
- ④ 未新增 `executeScript({func})` 内联函数体 → `verify:injected` 不适用（标 N/A）。
- ⑤ 浏览器真实行为：本设计的因果链在单测里复现（中断 → 悬挂 → 出网 payload 合法）；
  **用户那条已锁死会话能否恢复需要他本人重发一次**，拿不到该证据前标 BLOCKED。
- ⑥ 复用检查：配对相关既有实现只有 `trimConversation`（只管窗口头部）与
  `context-compact`（删整轮以保证配对），两者都不修补尾部；新逻辑放 `src/lib/llm.ts`
  是因为它是唯一出网咽喉点，不新建模块（§5.3）。
- ⑦ 无未调用导出：`closeInterruptedToolRounds` 由 `toApiMessages` 调用，导出仅为直接测试
  （沿用 `trimConversation` 的既有惯例）。
- ⑧⑨ 无新增 UI 与文案：中断标记是**模型可见、面板不可见**的 tool 结果（合成消息不落盘），
  因此不进 i18n；无临时产物入库。
- ⑩ 提交英文 Conventional Commits；本次不涉及 tag。

### 验收结果 · Results (2026-10-13)

- ① `pnpm typecheck` 无输出通过；`pnpm test` → **350 files / 4012 tests passed**；
  `pnpm build` → `✓ built in 2.31s`；`pnpm format:check` 与 eslint 在**受版本管理的文件**上
  0 error（`pnpm lint` 全量仍红，红点全在 `tmp/**`、`server/data/**` 等未跟踪产物，属既有基线）。
- ② `pnpm server:typecheck` 通过；`pnpm server:test` → **11 files / 86 tests passed**
  （`src/lib/llm.ts` 是跨端共享文件，故 Runner 侧一并跑）。
- ③ N/A：未触碰 `ai-takeover.ts` 与 `workflow-engine/**`。
- ④ N/A：无新增 `executeScript({func})` 内联函数体。
- ⑤ **BLOCKED**：中断现场由单测复现（`runAgentTurn` + 真实 `AbortController`，断言 history
  里确实留下无结果的 `assistant tool_calls`，而 `toApiMessages` 出网 payload 已补齐配对）。
  但「用户那条已经锁死的会话能否恢复」必须由本人在重新加载扩展后于该会话重发一次才能确认；
  扩展已 `pnpm build`，重载入口 chrome://extensions → Browser Copilot ⟳。
- ⑥⑦⑧⑨⑩ 均满足：无新模块、无未调用导出、无 UI 文案、无临时产物入库、提交为英文。

### 后续可收敛项 · Follow-ups（本次有意不做）

- 落盘仍保存未闭合的轮次（`index.ts` 的 `finally`），修复发生在出网一瞬间。若希望
  `saveConversation` 保存的形状本身就合法，应把 `closeInterruptedToolRounds` 同时接到落盘路径。
- `finishReason`（`StreamResult`）全仓库无人消费：被 `length` 截断的工具调用只会在这里被动修补。
