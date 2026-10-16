# 非聊天模式首响应耗时 30s+ 的体感修复 — 设计记录

日期：2026-10-16 ｜ 影响面：`src/lib/llm.ts`、`src/lib/messages.ts`、`src/background/agent.ts`、`src/sidepanel/ChatTab.tsx`、`src/lib/i18n.ts`
裁定来源：用户提问（"聊天中从输入到看到响应 30s+ 为什么"）+ AskUserQuestion（落 P1+P2+P3 全套）

## 1. 背景与根因

链路：`ChatTab` 发 `chat` → `background/index.ts` 组装 → `runAgentTurn`（agent.ts）→ 多轮 `streamCompletion`（llm.ts）→ 逐 token `delta` 事件回传面板。

流式本身是真实的（agent.ts 的 `onText` → `delta`）。30s+ 来自三层叠加：

1. **默认 `semi` 模式（非 chat）每轮带全量工具走 agent 循环**：模型先吐 tool call（无可见文本），工具执行（页快照 + `waitForNetworkIdle` 最长 3s + 导航后固定 2s sleep），第二轮 completion 才流式出答案。
2. **推理模型的思考阶段完全静默**：`SseAccumulator` 只读 `delta.content`，丢弃 `delta.reasoning_content`（model-output.ts 头部注释已点明"SSE client already ignores"）。整段思考期前端只有一个 `thinking` phase 行。
3. **工具卡在 `tool.start` 到 `tool.result` 之间是空白**：`tool.start` 只带 `name`，运行中的工具卡只显示一个裸名字 + `running…`，没有"正在做什么"的意图，也没有耗时。

本方案只做**体感**（感知延迟）修复，不碰"真实压缩首字延迟"的技术线（首轮 prompt 精简、减少静默轮次、TTFT 预热）——那条线改动面大、有回归风险，另行立项。

## 2. 三项改动

### P1 — 阶段与工具卡实时耗时（纯 UI）

- `ChatTab` 在 `busy` 期间用 1s 间隔的 `now` tick（`useEffect` 监听 `busy`，`turnStartedAtRef` 记录起点；只在 busy 时 setInterval，渲染用 `now - startedAt` 推导，**不**每秒重写 entries 数组）。
- phase 行（`showPhase` 生成的透明 status entry）在 `entry.id === phaseRef.current && busy` 时并排渲染 `elapsedSeconds` 淡色 chip。chip 带 `data-elapsed-seconds` 便于测试断言数值。
- **每轮重置**：`showPhase` 只在当前无 phase 行（`phaseRef.current` 为空）时把 `turnStartedAtRef` 重置为 `Date.now()`。即"模型有响应后计时才重置"——上一行是被模型输出（`delta`/`tool.start`/`status` 触发 `clearPhase`）清掉的，新一轮的 `phase` 消息重开一行 → 归零重数，量的是本轮等待而非整轮累计。`preparing→sending→thinking` 复用同一行（有输出前不 `clearPhase`），所以不逐 phase 归零。`turnStartedAtRef` 仅在 `busy` 由 false→true 的 effect 里首次赋值，跨 turn 天然归零。
- 工具卡 `ToolCallCard` 增加 `now` prop + 运行中卡显示 `elapsedSeconds`；`Entry` 增加 `startedAt`（`tool.start` / 无 start 配对直接 append `tool.result` 时写入 `Date.now()`）。工具卡计时独立于 phase 行，从其自身 `startedAt` 起算，不受上面重置影响。

### P2 — reasoning_content 透传（复用既有 ThinkBlock）

- `llm.ts`：`SseAccumulator` 增加 `reasoning` 缓冲；`consumePayload` 读 `delta.reasoning_content` 累加并触发新 handler `onReasoning`（`StreamHandlers` 新增字段，`StreamResult` 新增 `reasoning` 便于测试）。content 与 reasoning 分开：**不**把 reasoning 折进 `content`，避免下一轮把思考原文重发回 provider（上下文膨胀）。
- `agent.ts`：`streamCompletion` handlers 加 `onReasoning: (d) => deps.send({ type: 'thinking', text: d })`。绝不动 `phase`（reasoning 期间 phase 仍是 `thinking`，首个 `content` delta 才翻 `responding`，语义正确）。
- `messages.ts`：`AgentServerMessage` 加 `| { type: 'thinking'; text: string }`。
- `ChatTab`：`Entry` 角色加 `'thinking'`；`groupEntries` 把 `thinking` 视同 `tool` 折进同一 agent turn；`thinking` 消息流进 `thinkingRef` 指向的临时 entry；首个 `delta` / `tool.start` / `done` / `error` 把该 entry 标记 `closed`。渲染复用已有 `ThinkBlock`（`closed`、`live` 传给既有组件），实时思考默认展开、turn 结束自动收起。
- 不被持久化：思考只进面板 entries，不进 transcript，`restore` 不涉及。

### P3 — tool.start 带意图摘要

- `messages.ts`：`tool.start` 增加可选 `summary?: string`。
- `agent.ts`：把 `tool.start` 的 emit 从流式时机的 `onToolCallStart`（此时 args 未到齐、无法描述意图）**移到 `runOneToolCall`**：在 `parseArgs` + `delete args.withScreenshot` + `hydrateRecordArgs`（ref→target 解析）之后、disabled/escape 等拒绝分支之前，发 `deps.send({ type: 'tool.start', name, summary: describeAction(name, args, ctx.snapshotTargets) })`。复用现有 `describeAction`（已有人话映射，未覆盖的工具/算子回退为裸名字）与 `ctx.snapshotTargets`，让摘要点名真实目标而非裸 ref。
- 时机损失可忽略（onToolCallStart 到 runOneToolCall 只是剩余流式 args 时长，<1s），换来内容；phase 行被清除的时机也顺延到工具真正开始执行，更准确。
- `agent-unattended.ts` / `orchestrator.ts` / `index.ts` 只读 `tool.start.name`，新增可选字段向后兼容；新增 `thinking` 消息被它们的 `if (type === …)` 过滤自然忽略。

## 3. i18n

新增 key 走 `src/lib/i18n.ts` 封闭 `Messages` 类型（en + zh-CN 两侧赋值，`pnpm typecheck` 机检）：

- `elapsedSeconds: ({ s }: { s: number }) => string` — en `\`${s}s\`` / zh `\`${s} 秒\``。（思考块 Header 复用既有 `chatThinking`，不新增。）

## 4. 收尾自检（待实现后逐条核）

① `pnpm typecheck` / `test` / `lint` / `format:check`（改 UI 再加 `build`）；② 无 Runner 改动；③ 不涉及 ai-takeover/workflow-engine；④ 不动 `executeScript` 内联函数体；⑤ 浏览器可见行为证据或 BLOCKED；⑥⑦⑧⑨⑩ 遵循 AGENTS.md。
