# 算子助手「说改了但看不到」的可验证落地（2026-10-23）

## 1. 现象（dcc 原话）

> 现在 让智能算子助手修改算子 它说已经修改了 但是页面上没有看到任何变化
> 完全不知道是否是真的修改了

## 2. 现状取证

一条就地修改要走完：`OperatorChatDock.send()` → `workflows.operatorAdvise` →
`runOperatorAdvise` → `parseOperatorAdviseReply` → `onApply` → `App.applyNodeActionFromAi` →
`applyOperatorAction` → `installPatchedNode`。机械链路是通的（节点 `data` 确实会被替换），
但**结果汇报**有三处会把"没有变化"说成"改好了"，或干脆不说：

1. **零改动也算成功。** `editNodeParams`（`src/lib/workflow/operator-advise.ts:408`）无条件用
   `{...target.data, ...proposal.data, blockId}` 覆盖并返回 `before`。模型回 `data: {}`、
   或回一组与当前值相同的参数时：`App.applyNodeActionFromAi` 看不到 `problem`，
   照样 `pushHistory()`、写 undo、把认证状态置为 `unverified`，并 toast
   `operatorAiEdited`「助手已更新所选步骤。」——一次什么都没改的"成功"。
2. **改了什么看不见。** `BlockNode` 的卡片摘要只渲染
   `description || 条件分支数 || selector || url`（`src/workflow-editor/flow/BlockNode.tsx`）。
   改 `value`、`waitFor`、`pressKey`、`timeout` 等参数时卡片纹丝不动；落地行只有一句
   `operatorAiChangedInPlace`「已更新所选步骤」，不列键名、不给新旧值。
   用户无法区分"真改了但卡片不显示"和"模型什么都没改"。
3. **空链回答完全静默。** `send()` 只在 `!chain || proposals.length > 0` 时调用 `onApply`；
   `action: "append"` 且 `proposals: []` 的回答既不落地、也没有任何状态行，模型 reply 是唯一输出。
   修改请求被模型降级成空 append 时，画布与 UI 都没有反馈。
4. **拒绝只有一行小字。** `edit`/`replace` 被拒时 `Landing` 只渲染一条 `text-warn` 原因，
   上面的模型回复仍写着"已修改"，容易被读成成功；链式落地里"全部被拒"（`added: 0` +
   `skipped` 非空、无 `problem`）时 `Landing` 在 `!applied` 直接 `return null`，连原因都不显示。

## 3. 决策

**D1 零改动不再算落地。** `editNodeParams` 逐键比较 `proposal.data` 对当前值的影响
（`undefined` / `null` / `''` 统一视为"空"，其余用深比较）；没有任何键真的变化时返回
`problem: 'no-change'`，不产生 `before`——不写 undo、不改认证状态、不弹成功 toast。
空对象、原值回填都会被这条挡住。

**D2 落地行必须给出证据。** `OperatorNodePatch` 增：

- `changed: OperatorParamChange[]` —— `{ key, before, after }`，只含值真的变了的键；
  secret 命名的键（`isSecretKey`）在纯层就把两端替换成 `MASK`，秘密值不进入 UI 层。
- `swapped?: { from, to }` —— `replace` 的算子显示名前后对。

Dock 的成功行在「已更新所选步骤」下再列 `key: 旧值 → 新值`（字符串加引号、长值截断、
多个用 `·` 连接）；`replace` 的行直接写 `已将 A 替换为 B`，不再只说"已更新"。

**D3 没落地就明说。** 所有 `problem` 行统一加前缀「未改动 — {原因}」；`!applied` 且无 problem
（全部算子被拒）也渲染「画布上没有放置任何步骤」+ 被拒名单；`append` + 空 proposals 不再跳过
`onApply` 的语义分支，而是直接落一个 `added: 0 / applied: false` 的链式 landing，
让中性状态行「画布上没有放置任何步骤」出现在回答下方。问句回答同样显示这行——它是状态，不是告警，
用 `text-faint`。

**D4 复用相等性实现。** `deepEqual` 原本是 `repair/patch-engine.ts` 的私有函数，现提到
`src/lib/workflow/equality.ts`，patch-engine 与 operator-advise 各 import 一次（AGENTS §5.2；
新文件只放这一个函数，理由即"第二处调用点出现"）。

**D5 提示词补一条。** `buildOperatorAdvisePrompt` 的 Rules 增加：请求已被满足时返回空
proposals 并说明，不得报告回答里不存在的改动。UI 的 D1/D3 是确定性兜底，不依赖模型自觉。

## 4. 否决项

- **改卡片摘要，把所有参数都印上去**：每个算子外观都会变，画布噪音大；证据行已经能回答
  "改了什么"，不必牺牲卡片可读性。
- **成功时改写模型 reply**：reply 是模型的输出，编辑器不替它说话；由编辑器生成的状态行/证据行
  与 reply 并列，矛盾时用户能看到是哪一边在说。
- **只加 toast**：toast 会消失，且这次投诉正是"提示说改了、画布没变"；证据要留在会话里。
- **在 `parseOperatorAdviseReply` 里丢弃空 `data` 的 edit**：会把"零改动"变成"没有回答"，
  丢掉更准确的 `no-change` 原因。

## 5. 测试与证据

- 纯层（`tests/operator-advise.spec.ts`）：空对象 / 原值回填 → `no-change`；部分相同部分变化
  → 只报变化的键；secret 键两端为 `MASK`；`replace` 的 `swapped` 名称正确；零改动不产生 `before`。
- Dock 验收（`tests/acceptance-operator-chat-dock.spec.tsx`）：`changed` 行渲染新旧值；
  `no-change` 渲染「未改动」且不出现 `operatorAiChangedInPlace`；`append` + 空 proposals
  不调用 `onApply` 且出现「画布上没有放置任何步骤」；`replace` 行渲染前后算子。
- 门禁：`pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm format:check` / `pnpm build`。
- 浏览器可见证据 **BLOCKED**：`chrome-extension://` 页面无法被 MCP 脚本化；本主题是纯逻辑 +
  React 渲染，以上两层测试是当前可得的确定性证据。
