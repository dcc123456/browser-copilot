# 编辑器 AI 助手：总超时改为空闲超时 + 断线自动重连（2026-10-23）

## 1. 诉求（dcc 原话）

> 把"总超时"改成"空闲超时"——持续有 delta 就不杀，连续 120s 没有任何输出才断开
> 并且 如果真断开 也要自动重试 10 次 每次间隔 10s

## 2. 现状取证

- 改前 `src/background/operator-advise-engine.ts:73` 是 `OPERATOR_ADVISE_TIMEOUT_MS = 60_000`，
  在请求里写作 `signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)])`：**总预算**，
  与模型是否正在输出无关。
- `src/lib/llm.ts` 的 `streamCompletion` 只把 `name === 'AbortError'` 当作用户取消；
  `AbortSignal.timeout()` 抛的是 **`TimeoutError`**，于是走进通用包装：
  `Cannot reach <url>: signal timed out. Check the base URL, your network, and whether the endpoint
allows browser-extension requests.` —— 即 dcc 看到的那条误导性报错。
- 实测（本机，2026-10-22）：该端点 `/models`、`/chat/completions` 都在 ~0.1s 内返回 401，
  网络与 base URL 均正常；断的是我们自己的 60s 预算。
- 既有能力已具备：`StreamRetryPolicy { retries, delayMs }`、部分回复用 `STREAM_CONTINUE_PROMPT`
  续写（助手消息放已得文本 + 用户"继续"），且 `AbortError` 永不重试。本轮不新造任何重试设施。

## 3. 决策

**D1 空闲按 attempt 计。** `StreamRequest` 增 `idleTimeoutMs?: number`；每个 attempt 新建一个
`createIdleWatchdog(ms)`（`src/lib/llm.ts`），`onText` / `onReasoning` 的每个非空 delta 都 `touch()`
重置时钟。超时的 abort reason 是 `TimeoutError`（不是 `AbortError`），因此按 transient 走既有重试；
用户手动取消仍是 `AbortError`，立即结束。

**D2 信号合并与清理。** attempt 的 fetch signal 为 `AbortSignal.any([request.signal, idle.signal])`
（无外部 signal 时直接用 idle.signal）。成功返回前与进入 catch 的第一件事都 `dispose()` 看门狗——
一次 attempt 一个，旧信号不会污染后续 attempt，退避等待期间也不留计时器。

**D3 助手预算。** `operator-advise-engine.ts` 改为
`OPERATOR_ADVISE_IDLE_TIMEOUT_MS = 120_000` + `retry: { retries: 10, delayMs: 10_000 }`；外部
`signal` 原样传入，不再套 `AbortSignal.timeout`。断开后的第 2 次请求是**续写**而不是重放：已显示
的正文作为 assistant 消息 + 一个"从中断处继续"的 user 指令。

**D4 终态文案。** 重试用尽后，`TimeoutError` 的报错改为
`<provider> stopped sending output: No output for 120 seconds.`，不再冒充"无法连接 / 检查 base URL"。

**否决项。** 只把总上限调大：仍在杀掉一个正常输出的慢调用，且 10 次重试要 11 × 上限。
另写一套重试循环：违反 AGENTS §5.6。把空 keep-alive 帧当活动：需求口径是"有输出才算"，
空帧只证明 TCP 还活着，证明不了模型还在写。

## 4. 边界

- 重置时钟的只有正文 / 推理 delta；空 keep-alive 帧与 tool-call 参数片段不重置。助手不使用工具，
  chat 路径也未启用 `idleTimeoutMs`，故本轮无行为影响。
- 空闲窗口按 attempt 重新计时：每次重连都有完整的 120s，不是全局共享。
- 期间收到的增量照常广播给编辑器，续写接在同一会话里，不重置已显示内容。

## 5. 测试与证据

`tests/llm-stream-retry.spec.ts` 新增 3 例（真实 `Response` + `ReadableStream`，`fetch` 打桩；
stalled 流把 `init.signal` 的 abort 接到 `controller.error(signal.reason)`，与真实 fetch 一致）：

1. 首个 attempt 已输出 `Hello ` 后静默：119s 时仍不杀，120s 触发看门狗 → 10s 后第二个请求，
   body 带 `assistant: 'Hello '` + 续写指令，最终 `Hello world`，`onRetry` 报 `continuing: true`、
   `message` 含 `stopped sending output`。
2. 每 100s 一个 delta、总时长 300s（远超 120s）：一次请求、无重试、`abc` 完整返回。
3. 全程静默且 `retries: 0`：终态 `LlmError.transient === true`，消息含 `stopped sending output`、
   不含 `Cannot reach`。

门禁实测（2026-10-23，工作区还带着并行 loop 主题的未提交改动）：`TZ=UTC npx vitest run`
**434 文件 / 5,055 测试通过**；`tsc --noEmit`（src + tests）、eslint、prettier 全绿；
`tests/llm-stream-retry.spec.ts` 13 例全绿（原 10 + 新 3）。

**未取得的证据（如实记）。** ⑤浏览器可见行为本轮 **BLOCKED**：扩展页面不可脚本化，且真实慢模型
的长思考需要消耗 dcc 的 provider 额度，未在无人工确认下发起。③未触发（未改 `workflow-engine/**`
或 `ai-takeover.ts`）。④未触发（未改 `executeScript({func})` 内联函数体）。
