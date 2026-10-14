# 用户轮次骨架 · The user turn is the transcript's spine — design

日期 / Date: 2026-10-14
涉及模块 / Areas: `lib/storage`（落盘裁剪）、`lib/context-compact`（token 兜底裁剪）、`sidepanel`（历史展示）

## 1. 需求原文 · Requested behaviour

用户报告：**「现在聊天中 如果消息过长 最开始的消息记录就不展示了 导致用户无法查看消息历史」**

追问后确认两点：

- 面板顶部**没有**「[上下文已压缩] / [Context compacted]」摘要气泡——早期消息是**直接消失**的；
- 修复边界由用户给定：**「用户输入的消息不压缩」**。即模型上下文该缩仍可缩，但用户自己打字的
  轮次不许被删、也不许被改写。

## 2. 根因取证 · Evidence about the current code

一条展示路径的排除 + 一条落盘路径的复现，都是实测。

- **展示侧没有上限**（所以不是渲染问题）：`ChatTab.tsx` 的 `entries` 只 `append`，全文无
  `.slice` / `MAX_` / 虚拟化；`toRestoreMessages`（`src/background/restore.ts`）与 `resume` 处理
  （`src/background/index.ts`）也不截断。面板是**在 `conversation.ended` 之后重新 `resume`，用
  落盘的转写整体替换可见转写**（`ChatTab.tsx:2397-2423` → `setEntries(restored)`），所以落盘丢什么，
  面板一轮之后就少什么。
- **落盘侧有三条删除路径，全部不区分角色**：
  - `trimConversation`（`src/lib/storage.ts`）超过 `MAX_STORED_MESSAGES = 200` 时从最老的一端整体丢弃；
  - `withinTranscriptBudget`（同文件）超过 `MAX_STORED_CONVERSATION_BYTES = 1_500_000` 时，
    **复用** `trimConversation` 按 80% 反复收缩，同样整条丢，用户消息一起丢；
  - `hardCapHistory`（`src/lib/context-compact.ts`）Pass 2 会**改写 user 消息的正文**
    （`…[truncated]`），并且它就地改 `history`，下一次 `saveConversation` 就存了这个改写结果。
- **实测复现（决定性）**：`saveConversation` / `loadConversation` 真实往返（stub `chrome.storage.local`，
  20 轮 × 60k 汉字页面转储）——
  | 输入                                                                          | 落盘                    | 最老的用户消息                                     |
  | ----------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------- |
  | 80 条 / 1,205,445 B                                                           | 80 条 / 1,205,445 B     | `第1条指令…`（未被裁）                             |
  | 120 条 / ~1.8 MB                                                              | **96 条 / 1,446,565 B** | **`第7条指令…`** —— 第 1～6 条连同用户输入一起没了 |
  | 96 < 200，**条数上限根本没触发**：是 1.5 MB 字节预算从最老端整轮丢弃。        |
  | 这正好对应「消息过长 → 最开始的记录不展示」，也解释了为什么没有压缩摘要气泡。 |
- `.ldb` 侧取证失败并如实记录：Snappy 压缩块里明文扫不到 `conv:` 记录
  （`tmp/probe-conv-caps.mjs` recoverable conv records: 0），因此磁盘现状**不能**作为结论依据，
  上表才是。

## 3. 方案 · The rule

**用户轮次是转写的骨架（spine）：任何收缩只能删非 user 轮次，永远不删、不改写 user 消息。**

落到四处改动，全部在既有模块里改策略，不新增存储、不新增第二套裁剪管线（§5.6）：

1. `trimConversation`：先把转写按**轮次原子分组**（一条 `assistant{tool_calls}` 与它后面连续的
   `tool` 结果为一组；单条 user / assistant 各为一组），user 组**永久保留**，其余从新到旧取到
   `limit - userCount` 条为止。语义保持「总条数受 `limit` 约束」，只是被删的一定是非 user 组。
   分组保证了不会把一轮劈开——那会造出悬挂 `tool_calls` / 孤儿 `tool` 结果（上一份设计
   `specs/2026-10-13-aborted-tool-round-design.md` 刚在出网口修补的正是这类形状）。
   既有不变式「窗口不得以 `tool` 结果开头」继续成立（整组进出，天然满足；对本来就以孤儿结果
   开头的畸形输入仍丢弃该组）。
2. `withinTranscriptBudget`：沿用同一个 `trimConversation`（它是唯一收缩入口），加**进展判定**：
   一轮收缩后条数没变，说明剩下的全是骨架，就**停止收缩并按原样保存**，而不是去动 user 消息。
   代价是极端情况下这个 key 会超预算——写不进数据目录时已有既有告警路径
   （`Could not save this conversation`），比静默删除用户历史诚实，也比无限增长的单 key 安全。
3. `hardCapHistory`：删掉 Pass 2。非 user 消息全部削完仍不fit，就把超长的用户输入交给
   provider 的 400 → 既有反应式压缩（`compactHistory` 本身就保留 user 消息，见既有断言
   「keeps user messages even inside compacted turns」）。
4. `withoutOversizePayloads` / `retireOldPageReads` / `compactHistory`：**不动**。它们只改
   payload 与非 user 消息，已经符合骨架规则（附件 data URL 仍按既有约定丢弃并留标记）。

面板侧无需改动：骨架进转写后，`toRestoreMessages` 自然就渲染得出最早的用户输入。

### 明确不做 · Out of scope

- 不做「完整版转写 vs 模型上下文版」双视图拆分，也不新增 `convlog:` 追加式存储。用户只要求
  自己输入的消息不丢；把最早的**回答**与页面转储丢掉是既有设计（省 token、省配额），保留。
- 不提高 `MAX_STORED_CONVERSATION_BYTES`：1.5 MB 是被 storage 兜底单 entry 预算
  （`fs-outbox.ts` 的 2 MB）决定的，不是随意值。

## 4. 交付物 · Deliverables

| #   | 交付物                                           | 位置                                                                                                            |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| D1  | 本文档                                           | `specs/2026-10-14-…`                                                                                            |
| D2  | 轮次原子分组 + user 骨架 + 字节预算进展判定      | `src/lib/storage.ts`                                                                                            |
| D3  | 取消 `hardCapHistory` 改写 user 正文的 Pass 2    | `src/lib/context-compact.ts`                                                                                    |
| D4  | 骨架策略单测（含 1.5 MB 复现用例）与既有断言更新 | `tests/conversation.spec.ts`、`tests/conversation-size-bound.spec.ts`、`tests/context-compact-estimate.spec.ts` |

## 5. 验收 · Acceptance

- ① `pnpm typecheck` / `pnpm test` / `pnpm lint`（跟踪文件）/ `pnpm format:check`，涉及构建则 `pnpm build`。
- ② `src/lib/**` 属跨端共享：`pnpm server:typecheck` / `pnpm server:test`。
- ③ 未触碰 `ai-takeover.ts` / `workflow-engine/**` → `bench:debug` N/A。
- ④ 无新增 `executeScript({func})` 内联函数体 → `verify:injected` N/A。
- ⑤ 浏览器可见行为：**BLOCKED**——需用户重载扩展后，在原来那条变短的会话里确认最早的输入回来了。
- ⑥ 复用检查：收缩仍只有 `trimConversation` 一个入口，字节预算继续调它；未新增第二套裁剪/存储管线。
- ⑦ 无新增死代码；`groupTranscriptRounds` 仅被 `trimConversation` 使用（不导出）。
- ⑧ 无新增 UI 文案（不涉及 i18n / Tailwind）。
- ⑨ 探针脚本 `tmp/probe-conv-caps.mjs` 只留 `tmp/`，不入库。
- ⑩ 提交英文 Conventional Commits；不涉及 tag。

### 验收结果 · Results (2026-10-14)

- ① `pnpm typecheck` 通过；`pnpm test` → **354 files / 4054 tests passed**；`pnpm build` →
  `✓ built in 2.50s`；受版本管理文件上 eslint **0 error**（4 个既有 warn）、prettier
  `All matched files use Prettier code style!`。
- ② `pnpm server:typecheck` 通过；`pnpm server:test` → **11 files / 87 tests passed**。
- ③④ N/A（未触碰 `ai-takeover.ts` / `workflow-engine/**`，无新增注入函数体）。
- ⑤ **BLOCKED，且有一条必须说清的前提**：本改动只保证**从现在起**不再删用户轮次；已经因为字节预算
  被删掉的早期消息**无法找回**（`conv:<id>` 是整键覆写，无归档、无分页，代码里也确实没有第二份）。
  用户侧验证方式：重载扩展后在一个长会话里继续发送，确认最顶上的原始输入不再消失。
- ⑥ 收缩入口仍只有 `trimConversation` 一个（`withinTranscriptBudget` 调它，`saveConversation` 调它），
  没有新增第二套裁剪或第二套存储。
- ⑦ `groupTranscriptRounds` 为模块内私有，仅 `trimConversation` 使用；`hardCapHistory` 的 Pass 2
  已随策略删除，无残留死分支。
- ⑧ 无 UI 与文案改动。⑨ 探针脚本只留 `tmp/`。
