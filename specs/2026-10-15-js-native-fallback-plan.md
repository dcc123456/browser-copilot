# JS 原生阶梯回退 · Native-rung evidence unlocks the JS escape hatch — plan

设计：`specs/2026-10-15-js-native-fallback-design.md`（判定顺序、合成 gap、降级契约、风险都在那份里）。
本文件只列逐项改动与验收条目。

## 1. 逐项改动

| #   | 文件                                          | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/lib/workflow/capability-gap.ts`          | 抽出 `nativeRungFor(stepIntent)`（合并 `:190-202` 与 `:285-295` 两处重复的原生早退）；新增内部 `nativeAttemptsProvenInsufficient(rung, failedIds)` 与 `gapFromFailedNativeAttempt(rung, tried)`；`nativeRefusalReason(rung)` 统一拒绝文案并写明解锁条件；`justificationOf(gap)` 收敛三处拼接。两个入口新增可选入参 `nativeAttemptFailedBlockIds?: readonly string[]`（共享文档类型 `NativeAttemptEvidence`），`evaluateJsPermission` 的原生判定改为委托 `evaluateCapabilityGap`。**不新增导出**（`nativeOperatorsForIntent` 不落地，避免 §5.4 死导出）。 |
| 2   | `src/background/agent.ts:4464`                | 传 `nativeAttemptFailedBlockIds: failedBlockIdsOf(ctx.conversationId)`（新增 import）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | `src/background/operator-tool-run.ts:363`     | 同上，`conversationId` 已在作用域内；import 补 `failedBlockIdsOf`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | `src/background/operator-tool-handler.ts:349` | 同上（`failedBlockIdsOf` 已 import）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | `tests/js-permission-gate.spec.ts`            | 新增 `describe('a recorded native failure unlocks the same intent')`（5 条，P1/P2/P3/P4/P5）；不改动任何既有断言。                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | `tests/script-escape-hatch.spec.ts`           | 新增 `describe('a native operator that failed on the page unlocks its own intent')`：真实走 `runOperatorToolWithExecution`（先失败 click → 放行脚本，并核对 `scriptJustification` 与卡片描述优先级）与 `runOperatorTool` 记录路径 ⇒ P6 的两个调用点由测试锁住；`ev-ok` 一条锁住"原生跑通就仍然拒绝"。                                                                                                                                                                                                                                                    |

`server/**` 零改动（Runner 无生成路径，§5.6 镜像不受影响）；无 UI、无文案 key、无 i18n 改动（错误串面向模型，不是 `Messages` 用户可见文案）。

## 2. 验收 · 新增行为

- [x] P1 `evaluateJsPermission({ stepIntent:'点击发布按钮', args:{code}, nativeAttemptFailedBlockIds:['event-click'] })` → `allowed:true`，`justification` 含 `event-click` 与 `sanctioned capability gap`。（`js-permission-gate` 第 1 条）
- [x] P2 同一入参走 `evaluateCapabilityGap` → `allowed:true`，`capabilityGap.triedOperators` 等于 `['event-click']`（来自证据，不是模型自述）。（第 2 条）
- [x] P3 交集只取该意图的原生 blockId：`stepIntent:'填写邮箱'` + `['event-click']` → 仍拒绝（fill 的 `forms` 没有失败记录）。（第 3 条，断言 `nativeBlockIds` 等于 `['forms']`）
- [x] P4 原生算子后来跑成功就不解锁：证据集里没有该 blockId（`markOperatorRecovery` 已清除）→ 拒绝，等于今天的行为。（第 4 条 + `script-escape-hatch` 的 `refuses again once the native operator works`）
- [x] P5 拒绝文案写明解锁条件（含原生算子 blockId 与"先真实执行/失败记录解锁"字样），面向模型的 `error`/`reason` 两侧一致（同一 `nativeRefusalReason`）。（第 5 条）
- [x] P6 三个调用点都把本会话证据传进闸门：`agent.ts`（MCP 派发层，读代码核对）、`operator-tool-run.ts`、`operator-tool-handler.ts` 各有测试锁住。

## 3. 验收 · 不得改变的既有拒绝

以下断言所在测试必须原样通过，**禁止为过测而修改**：

- [x] E1 `tests/js-permission-gate.spec.ts`：`refuses regardless of gap when a native operator covers the intent`（无证据 ⇒ 四字段 gap 也拒）。
- [x] E2 同文件：`refuses a call carrying neither` + `refuses a partial capabilityGap (%s)` 四条 + `still refuses a native intent that merely shares words with a gap`。
- [x] E3 同文件 `native intent keywords are word-bounded`：四条误判用例仍拒绝，且 `nativeBlockIds` 为 `[]`；`fill the coupon form` 仍指向 `forms`。
- [x] E4 同文件 `the script body is evidence of an image artifact`：图片缺口三条（含 `still refuses a click-worded description whose script only acts on the page`）不变。
- [x] E5 `tests/js-fallback.spec.ts` 29.9 四条、`tests/acceptance-js-gate.spec.ts` V45/V46/V47 全部不变。
- [x] E6 `tests/script-escape-hatch.spec.ts`：无 justification / justification 过短仍拒绝。
- [x] E7 图片类 sanctioned gap 仍排在最前（判定顺序第 1 条不因新分支改变优先级）。

证据：`pnpm typecheck` 通过；`pnpm test` = 359 files / 4117 tests 全绿（E1–E7 所在文件一条未改）；
改动文件 `npx eslint` 无输出、`npx prettier --check` 通过。

## 4. 收尾自检（AGENTS.md）

- [x] G1 `pnpm typecheck`、`pnpm test`、`npx eslint <改动文件>`、`npx prettier --check <改动文件>`（lint/format 全仓基线红，按 `git ls-files` 口径只判改动文件）。
- [x] G2 Runner 侧：本次无 `server/**` 改动 ⇒ 不适用（工作树里 `server/**` 的改动属于另一条线，不随本次提交）。
- [x] G3 无 `ai-takeover.ts` / `workflow-engine/**` 改动 ⇒ `bench:debug` 不适用；无新 `executeScript({func})` 内联函数体 ⇒ `verify:injected` 不适用。
- [ ] G4 真实浏览器证据（验收 ⑤）：BLOCKED 直到 dcc 跑 `pnpm selftest`。判定口径：生成含"原生 click 点不动"的步骤时，观察 `wf_op_event-click` 先真实失败、随后 `wf_op_javascript-code` 被放行且工具结果带 `sanctioned capability gap` 的 `scriptJustification`；保存卡上应同时出现"生成覆盖缺口"警告（设计 §6 的代价显示）。
- [x] G5 死代码 / 命名 / 注释：无新增未调用导出（`NativeAttemptEvidence` 被两个入口消费，其余为内部函数）；注释写"为什么"（证据来源、近似性、降级等于今天）。
- [ ] G6 提交英文 Conventional Commits；暂存区无 `tmp/` 产物。

## 5. 回滚

闸门是纯函数 + 可选入参：把三个调用点的 `nativeAttemptFailedBlockIds` 去掉即回到今天的行为，
`capability-gap.ts` 内的新分支自动失效，无需回滚数据（本设计零新增存储）。
