# 聊天回复完整性：长度截断自动续写 + 静默挂起看门狗（2026-10-27）

## 1. 诉求（dcc 原话）

> 现在聊天中 经常会出现回复到一半 还没有回复完成就中途断开了 我希望它能回复 确保一次会话的完整性

追问确认的现象：回复**停在一半，面板里没有任何提示**（既没有「重连中」也没有错误行）；
模型设置里的「最大输出 tokens」**留空**（即由服务端默认上限决定）。

## 2. 现状取证

- `src/lib/llm.ts:944-954`：只有「干净关闭但既无 `[DONE]` 也无 `finish_reason`」才算断流并重试；
  `src/lib/llm.ts:958-967` 一旦 `finishReason` 是任何字符串就直接返回。
  因此 `finish_reason === "length"`（服务端输出上限截断）被当作**回答完成**——不报错、不重试、不提示，
  正好是 dcc 看到的「停在一半，没有任何提示」。
- 全仓 `finishReason` 的唯一消费者就是上面那段启发式判断（`grep finishReason src/**`），
  聊天回合 `src/background/agent.ts:5196` 拿到 `result` 后从不看它，所以截断对上层完全不可见。
- 续写设施**已存在**：`src/lib/llm.ts:857-872` 在 `delivered` 非空时把已得正文作为 assistant 消息 +
  `STREAM_CONTINUE_PROMPT`（`src/lib/llm.ts:772`）重发，`src/lib/llm.ts:984-994` 拒绝续写半截
  tool 调用。本轮不新造第二套重试/续写循环（AGENTS §5.6）。
- 空闲看门狗 `idleTimeoutMs`（2026-10-23 口径：120s 无 delta 才算断，见
  `specs/2026-10-23-llm-idle-timeout-and-retry-design.md` D1/D3）**只接在编辑器助手上**
  （`src/background/operator-advise-engine.ts:217`）。该文档 §4 明确记为边界：
  「chat 路径也未启用 `idleTimeoutMs`」。聊天这条请求因此遇到「代理静默掉线、TCP 不关闭」时
  `reader.read()` 会一直挂着，表现同样是「回复停住不动」。
- 聊天调用点参数：`retry: { retries: 10, delayMs: 5_000 }`（`src/background/agent.ts:5207`）。

## 3. 决策

**D1 长度截断在 `streamCompletion` 内部续写。** `StreamRequest` 增
`continueOnLength?: number`（允许的额外续写请求数，省略/0 = 维持现状原样返回）。
成功读到 `finishReason === 'length'` 时不再返回，而是把本轮正文并入 `delivered`、
`continuations += 1`、进入下一轮循环——下一轮天然走已有的 `continuing` 分支（assistant 已得正文 +
续写指令），因此**不重放**、不重复已显示文字。

**D2 续写不消耗重试预算。** 长度补全不是失败，与 `stream_options` 协商同理不占 attempt 名额；
实现上把 `for (let attempt…; attempt += 1)` 改成 `while` + 末尾显式 `attempt += 1`，
续写分支用 `continue` 跳过自增。每次续写仍是真实计费请求，照常经 `observeUsage` 记账。

**D3 只在可安全续写时续写。** 条件：`finishReason === 'length'` ∧ 本轮 `toolCalls.length === 0`
∧ 本轮 `content` 非空（没有增长就不可能收敛，避免死循环）∧ `continuations < continueOnLength`。
半截 tool 调用的 JSON 参数无法拼接，与既有 `resumable` 判断（`src/lib/llm.ts:988-993`）口径一致。

**D4 上限 3 次，且必须让用户看得见。** 聊天传 `continueOnLength: 3`（≈ 4 倍服务端默认上限）。
新增 `StreamHandlers.onContinue`，聊天据此发一条 status 行（`chatContinuingTruncated`）；
用尽后 `result.finishReason` 仍是 `'length'`，聊天据此再发一条 `chatReplyStillTruncated`，
告诉用户这一轮确实碰到了上限、可以发「继续」拿剩下的部分。不再无声结束。

**D5 聊天补上空闲看门狗。** 同一调用点加 `idleTimeoutMs: 120_000`，与 2026-10-23 的 D1/D3 完全同口径
（只约束 delta 之间的静默，不约束总时长；每个 attempt 重新计时；用户取消仍是 `AbortError` 立即结束）。
这关闭了该文档 §4 记下的「chat 未启用」边界。

**否决项。**

- 把 `max_tokens` 写死成一个大值：各家上限不同、 reasoning 模型会把它吃进思考，且改的是请求侧而不是
  回答侧的完整性；服务端截断照样发生。
- 在 `agent.ts` 的回合循环外面再套一层「发现截断就再问一次」：等于把续写逻辑抄第二遍，违反 AGENTS §5.2/§5.6。
- 只加提示不续写：用户仍要手动发「继续」，不满足「确保一次会话的完整性」。
- 用 `stream_options` 之外的信标判断"真的说完了"：网关实现不一，`finish_reason` 已是唯一可靠信号。

## 4. 边界

- 续写请求的 prompt 会变长（带上了已得正文），因此**输入 token 会增加**；上限 3 次把最坏情况限制在
  3 次额外请求，且只在真的每次都撞上限时才发生。
- 续写沿用同一 `provider` 配置与 `thinking` 参数；不改变温度、不改变工具集。
- 工作流生成、编辑器助手、Runner 侧调用不传 `continueOnLength`，行为不变（opt-in）。
- `finishReason === 'content_filter'` 等其他终态**不**续写：那不是长度问题。

## 5. 测试与验收

`tests/llm-stream-retry.spec.ts` 新增：

1. 首个请求以 `finish_reason: "length"` 结束 → 自动发第 2 个请求，body 带
   `assistant: <已得正文>` + 续写指令，最终 `content` 为两段拼接，`onContinue` 报
   `continuation: 1 / continuations: 3`，且 `finishReason` 为第二次的值。
2. 连续两次 `length` 且 `continueOnLength: 1` → 只多发 1 次，返回时 `finishReason === 'length'`
   （供上层出「仍被截断」提示）。
3. `length` + 半截 tool 调用 → 不续写，按原样返回。
4. 长度续写不吃重试预算：一次 `length` 续写后，随后一次 transient 失败仍能拿到完整退避重试。

验收（收尾自检 ①–⑩）：`pnpm typecheck`、`TZ=UTC pnpm test`、tracked eslint/prettier、`pnpm build`；
⑤浏览器可见行为需要真实长回答，走 `tmp/` 探针或标 BLOCKED；③不触发（未改
`workflow-engine/**`、`ai-takeover.ts`，未改 `executeScript({func})` 内联函数体）。
