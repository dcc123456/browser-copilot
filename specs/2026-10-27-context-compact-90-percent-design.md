# 上下文压缩改按「真实窗口的 90%」触发（2026-10-27）

## 1. 诉求（dcc 原话）

> 我希望是当上下文长度到 90% 时 就自动压缩上下文

追问「90% 按哪个窗口算」后选定：**按模型真实窗口的 90%**（零配置，不需要在 Settings 里先填窗口）。

## 2. 现状取证

- 阈值与真实窗口无关：`src/lib/context-compact.ts:19-22` 把窗口写死成
  `CONTEXT_WINDOW_TOKENS = 256_000`，阈值 = `256_000 × 0.8 = 204_800`。
  模型真实窗口是 32K / 128K 时，这个阈值**永远碰不到**，主动压缩形同不存在。
- 主动压缩只有两个入口，都吃同一个常量：
  - usage 驱动 `src/background/agent.ts:5124-5135`（上一轮真实 `prompt_tokens`）；
  - 估算驱动 `src/background/agent.ts:5168-5187`（本轮出网前估算，兜底 `hardCapHistory`）。
- 真实上限其实**已经被读到过**：`inputLimitFromError`（`src/background/agent.ts:1719`）能从
  provider 的 400 文本里解析出 `[1, 983616]` / `maximum context length is 128000 tokens`，
  但只在那一次 400 的补救里用了一下（`× 0.8` 当预算），**用完就丢**，之后再也不参与判断。
- 会话级「最近输入 token」已有现成的存储形状：`lastInputStore`（`src/background/agent.ts:1736`，
  Map + LRU cap 64）。窗口按同样的形状挂一份即可，不新造持久层（AGENTS §5.6）。

## 3. 决策

**D1 触发比例 0.8 → 0.9。** `COMPACT_THRESHOLD_RATIO = 0.9`。阈值仍是**输入侧**阈值：
估算里含 system prompt + history + 序列化工具 schema，不含回答本身，所以 10% 留给回答。

**D2 阈值按窗口算，窗口可传可选参数。** 新增 `compactThresholdFor(contextWindowTokens?)`：
给了窗口就 `window × 0.9`，没给就沿用 256K 假设。`shouldCompact(tokens, contextWindowTokens?)`
加同一个可选参数；`COMPACT_THRESHOLD_TOKENS` 保留为「未学到窗口时」的默认阈值，
Runner 与其他调用方不传参数即行为不变（AGENTS §5.7 跨端逻辑只放 `src/lib/**`）。

**D3 窗口从 provider 自己的报错里学，按 conversationId 记住。** 400 长度错误里解析出的上限
写进新的 `contextWindowStore`（与 `lastInputStore` 同构：Map + LRU cap）。此后这个会话的三条判定
（usage 驱动、估算驱动、`hardCapHistory` 兜底）一律用 `compactThresholdFor(学到的窗口)`。
这正是「零配置」：不需要用户先填任何东西，第一次撞墙就学会，之后不再撞墙。

**D4 补救预算 0.8 不动。** 400 之后的 `budget = providerLimit × 0.8` 是「把请求塞回去」的预算，
不是触发线；触发线是 0.9，预算留在 0.8 才有 system/schema/回答的余量。两者语义不同，不合并。

**D5 顺手删掉两个分支完全相同的 `if (!outcome)`。** 它现在无论结果如何都执行同一句
`hardCapHistory`（`src/background/agent.ts:5305-5310`），属于 AGENTS §5.4 的无用代码。

**D6 顺带修掉一个真实 bug：请求数组在尺寸守卫之前就拼好了。** 写这个测试时发现
估算驱动的那次压缩**从来没生效过**：`const messages = [system, ...history]` 建在守卫之前
（旧 `src/background/agent.ts:5168`），守卫里的 `compactHistory` 改的是 `history`，
发出去的却是旧的 `messages` 拷贝——现象是「明明出了压缩 status 行，请求却还是整份长历史」。
现在 `messages` 在两条守卫之后才拼（`src/background/agent.ts:5216`），压缩结果真的上送。
usage 驱动那条一直有效（它建在守卫之前、`messages` 之后），所以这个 bug 只影响第二条。

**否决项。**

- 只把常量从 0.8 改成 0.9（分母仍是 256K）：dcc 的原始诉求字面上满足了，但小窗口模型依然
  几乎不会主动压缩，等于没解决；已在问答里作为第三选项被否。
- 在 Settings 里加「上下文窗口」输入框：更精确，但要求用户先配置才能生效，与零配置取向冲突
  （问答里的第二选项未被选）。
- 按模型名建窗口对照表：各家命名/别名/版本太杂，猜错反而更糟；provider 自己的报错才是一手事实。
- 把学到的窗口持久化进 `src/lib/storage.ts`：需要新增 Settings 字段 + 迁移 + 面板展示，
  收益只是省掉「SW 重启后第一次撞墙」，而那次撞墙本来就有透明补救路径。

## 4. 边界

- 学到的窗口是**内存态**：background service worker 重启后清空，退回 256K × 0.9，
  再撞一次 400 就重新学会（补救路径已存在，用户看到的是 status 行 + 一次重试，不是失败）。
- 90% 只剩 10% 余量：若单条回答本身超过 10% 窗口，仍可能由 provider 报 400，
  走 D4 的补救；这是选择更晚压缩的必然代价。
- 子代理（`deps.subAgent`）依旧不做主动压缩，与现状一致（回合短、有委托预算兜着）。
- `finish_reason: 'length'` 的输出截断是**另一件事**，由 2026-10-27 的
  `specs/2026-10-27-chat-reply-completeness-design.md` 负责，本文件不碰。

## 5. 测试与验收

`tests/context-compact.spec.ts`：

1. `COMPACT_THRESHOLD_TOKENS` 断言从 204_800 改到 230_400（默认窗口 × 0.9）。
2. `compactThresholdFor(128_000) === 115_200`、`compactThresholdFor(8_000) === 7_200`。
3. `shouldCompact(tokens, window)`：115_200 边界；不传 window 时保持旧签名可用。

`tests/agent-length-error.spec.ts`（新增 agent 级用例）：4. 同一 conversationId 先因 400（`[1, 8000]`）学到窗口，下一回合在估算未超 256K × 0.9
的情况下**仍然主动压缩**——即学到的窗口参与判定，而不是等第二次 400。

门禁：`pnpm typecheck`、`TZ=UTC pnpm test`、tracked eslint/prettier、`pnpm build`。
⑤ 浏览器侧：真实长会话要跑到 90% 窗口不现实，验收口径是「先制造一次 400，
再在同一个会话里继续聊，观察压缩 status 行是否在下一次 400 **之前**就出现」；
拿不到实证就标 BLOCKED。
