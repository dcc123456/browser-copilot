# Chat 流式重连与摘要块过滤 · Chat stream resilience design

日期：2026-10-21 · 状态：实施中

## 1. 问题 · Problem

两个用户可见的聊天问题：

1. **模型输出出错时聊天直接停住。** 现有 `streamCompletion` 只在响应体被消费**之前**重试
   （429 / 5xx / 网络，3 次、指数退避）。流读到一半断掉时：
   - `reader.read()` 抛错 → 原样冒泡，面板收到 `error`，本轮结束；
   - provider 在流里发 `{"error":…}` 帧 → `SseAccumulator` **静默忽略**，本轮以半截文本
     正常收尾；
   - 连接干净关闭但既无 `[DONE]` 也无 `finish_reason` → 同样以半截文本收尾。
     用户要的是：**自动重连 10 次、每次间隔 5s**。
2. **全自动模式的输出里混入 `<details><summary>Summary</summary>…</details>` 摘要块。**
   这类块是会话/交接摘要的格式，不是本轮回答的一部分；它会被写进历史，下一轮模型
   继续模仿，越滚越多。用户要的是它不再出现在回复里。

## 2. 设计 · Design

### A. 重连（`src/lib/llm.ts`）

- `StreamRequest` 新增可选 `retry?: { retries: number; delayMs: number }`（`retries` = 首次请求之外
  的重连次数）。不传时保持现状（3 次、指数退避 + 抖动）；聊天主循环传 `{ retries: 10, delayMs: 5000 }`，
  即首次请求失败后最多重连 10 次、间隔固定 5s。
- 把「取响应」与「读流」合并进同一个重试循环，重试单位是**一次完整请求**：
  1. **未出字**（没有任何 `onText` delta、没有 tool call）：原样重发同一请求；
  2. **已出字、且尚未宣布 tool call**：**续写**——把已输出文本作为 `assistant` 消息、
     再追加一条简短 `user` 指令（"continue from the exact point… do not repeat"），
     重新请求；新 delta 继续追加到面板，最终 `content` = 已输出 + 续写；
  3. **已宣布 tool call**：不续写（半截的 tool-call 参数无法安全续接），视为终态失败。
- 永久错误（非 408/409/425/429、非 5xx、非网络）不重试，保持丢出。
- **流内错误帧**：`SseAccumulator` 解析到 `{"error": …}` 时抛 `LlmError(transient: true)`，
  不再静默吞掉。
- **截断检测**：读取结束但 `[DONE]` 与 `finish_reason` 都没有、且已有文本、且无 tool call
  → 按可续写的瞬态中断处理（同一续写路径）。该启发只在传入 `retry` 时启用：未传策略的
  调用方保持「拿到多少返回多少」的旧契约。
- 每次请求的 usage 都通过 `onUsage` 上报（token 账本按真实请求计费）；`result.usage`
  取**最后一次**请求的值——`agent` 用它记录「当前上下文大小」（`recordLastInputTokens`），
  各次求和会让下一轮误判上下文膨胀数倍而多余压缩。
- 新增 `StreamHandlers.onRetry`，聊天层用它发一条状态行（i18n 双语，含第几次/共几次）。

### B. 摘要块过滤（`src/lib/chat-output.ts`）

- `stripSessionSummaryBlocks(text)`：删除 `<summary>` 文本为 `Summary`（大小写/空白不敏感）
  的 `<details>` 块。
- `createSessionSummaryFilter()`：流式版本。跨 delta 的标签要缓冲；判定为非 Summary 的
  `<details>`（例如技能说明）原样放行；Summary 块整体丢弃；流结束时未闭合的块按已判定
  状态处理（未判定为 Summary 的缓冲内容 flush）。
- 接入点：`runAgentTurn` 的 `onText` 与写回 `history` 的 assistant 内容都用过滤后的文本，
  保证「面板看到的」与「下一轮模型读到的」一致，块不会经历史扩散。
  推理（`onReasoning`）不过滤。

## 3. 影响面 · Blast radius

- `streamCompletion` 的所有调用方共享新重试框架；默认策略不变，只有显式传 `retry` 的
  聊天主循环变成 10×5s。
- `SseAccumulator` 仅 `llm.ts` 与测试使用；新增错误帧抛错会改变「静默吞掉」的旧行为。
- 过滤只作用于聊天回复文本，不动工具结果、工作流节点与技能内容。

## 4. 测试 · Tests

| 文件                               | 覆盖                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tests/llm-stream-retry.spec.ts`   | 未出字重发、已出字续写（消息形态/拼接结果）、tool call 后不重试、10×5s、截断检测、流内 error 帧 |
| `tests/chat-output-filter.spec.ts` | 整块删除、跨 delta 标签、非 Summary `<details>` 保留、未闭合块、大小写                          |
| `tests/agent-chat-output.spec.ts`  | 聊天主循环确实传 10×5s、重连状态行、过滤同时作用于面板增量与写回历史                            |

既有门禁：`pnpm typecheck`、`pnpm test`、`pnpm build`、eslint/prettier、server 侧
（改了 `src/lib/**`）。

## 5. 验收 · Acceptance

- 模拟流中断后（已输出一半），面板继续出现后续文本，最终回答完整、无重复；
- 首次请求失败后最多自动重连 10 次、每次间隔 5s，全失败后仍按现状报错；
- 回复中不再出现 `<details><summary>Summary</summary>` 块，历史里也不存在该块；
- 普通 `<details>`（非 Summary）不受影响。
