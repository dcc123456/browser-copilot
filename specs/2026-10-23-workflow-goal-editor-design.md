# 工作流目标编辑器：让「目标未达成」可以被用户自己修改

- 日期：2026-10-23
- 范围：`src/workflow-editor/App.tsx`、`src/workflow-editor/toolbar/TopToolbar.tsx`、
  新增 `src/workflow-editor/sidebar/WorkflowGoalModal.tsx`、`src/workflow-editor/i18n.ts`
- 关联：`specs/2026-10-23-operator-dock-session-badge-and-composer-design.md`、
  `src/lib/workflow/reliability.ts`、`src/lib/workflow/goal.ts`、
  `src/background/workflow-engine/goal-verifier.ts`

## 1. 问题

运行结束后弹出「运行失败：目标未达成：……」，但编辑器里找不到任何修改目标的地方。
用户无法回答两个问题：这条提示从哪来？我怎么改它？

**提示不是可配置文案，是运行时的判定结果。** 链路：

1. `workflow.settings.goalSpec` 保存目标：`summary` + `successConditions`
   （可选 `terminalStateConditions`）。
2. 运行最后一步成功后，`run-workflow.ts` 的 L3 门调用 `verifyGoalSpec`。
3. 未满足的条件经 `describeCondition` 逐条转成文字，
   `goal-verifier.ts` 拼成 `目标未达成：<未满足条件；…>`。
4. 该 note 成为运行结果的 `summary` / `error`，编辑器 `App.handleRun` 用
   `runFailed` toast 显示：`运行失败: 目标未达成：…`。

`goalSpec` 目前只有生成链路会写：`deriveGoalSpecFromNodes` 从各节点
`__reliability.postconditions` 派生。编辑器此前从未引用过 `goalSpec`（只有节点级
「目标」是可在 `NodeGoalInspector` 里改的）。所以手改工作流后目标过期、条件写错、
或想为手工工作流补一个目标，都没有入口。

## 2. 做法

### 2.1 入口

`TopToolbar` 左侧页签区在「日志」旁新增「目标」页签（`Target` 图标，
`title` 说明用途），点击打开 `WorkflowGoalModal`。与「日志」一致：都是模态，
不是画布视图切换。

**否决：放进触发器算子的 `WorkflowInfoFields`。** 那里改的是名称/描述/运行设置，
目标需要完整的条件行编辑器；塞进侧栏表单会挤成两行输入框。而且触发器节点可能
不在当前视口，入口不可见。工具栏页签始终可见。

**否决：改 toast 文案。** Toast 是判定结果，不是模板；改文案解决不了「目标写错
却无法修正」。

### 2.2 模态内容

新增 `src/workflow-editor/sidebar/WorkflowGoalModal.tsx`，复用现有 `Modal` 与
`ConditionEditor`：

- 目标说明：`textarea`（`workflowGoalSummary`，带 `aria-label`）。
- 成功条件：`ConditionEditor` —— 与节点级目标完全同一套行编辑器（元素名 +
  选择器拾取、URL、变量、控件值），不新造第二套条件 UI。
- 说明文案：运行结束会逐条校验，任一不满足即判定「目标未达成」。
- 已有 `terminalStateConditions` 时显示一行提示：这些条件原样保留，本编辑器不改写。

**保留终态条件**：生成链路会把不可逆动作的 postconditions 同时写进
`terminalStateConditions`（「已经登录过」「订单已提交」）。编辑器只编辑 summary 与
成功条件；保存时把原有终态条件带回。丢掉它们会让「动作早已发生」的工作流永远
判失败。否决「也开放终态条件编辑」：用户很难理解两组条件的区别，且本轮诉求是
改目标，不是重做整个目标语义。

### 2.3 校验与保存

复用 `src/lib/workflow/goal.ts` 的 `normalizeGoalSpec`（不新增平行校验）：

- 保存按钮仅在以下都成立时可用：
  - `summary.trim()` 非空；
  - 至少一条条件；
  - 每一行都「填完整」。
- 行完整性在 UI 层判定（`isWorkflowCondition` 对空 `accessibleName: ''` 是放行的，
  因为那是观察层的宽松契约；编辑器不能把一行没填的占位条件存成会命中的条件）：
  - 行本身通过 `isWorkflowCondition`；
  - 元素行至少有非空的 `accessibleName` 或选择器；
  - `elementText` 的 `expected` 非空。
- 保存时 `normalizeGoalSpec({ summary: summary.trim(), successConditions,
terminalStateConditions: 原有终态 })`，结果为 `undefined` 时按钮本就不可用。
- 未满足时在底部显示 `workflowGoalIncomplete` 提示，不能靠点了没反应猜原因。

**删除目标**：分两步。第一次点「删除目标」进入确认态并显示说明（删除后运行不再
校验目标）；第二次点「确认删除」才生效。删除 = 从 `settings` 里移除 `goalSpec`
键，而不是写 `goalSpec: undefined`——`patchMeta` 的浅合并删不掉键。

**接线（App）**：新增 `applyGoalSpec(next: WorkflowGoalSpec | null)`：

```ts
setMeta((m) => {
  const settings = { ...m.settings }
  delete settings.goalSpec
  return {
    ...m,
    settings: {
      ...settings,
      ...(next ? { goalSpec: next } : {}),
      certificationStatus: 'unverified',
    },
  }
})
```

- 不进入 `patchMeta` 的 settings 合并路径：删除需要真正的键移除。
- 改目标后把认证状态置为 `unverified`：旧认证是针对旧目标测出来的，不能继续冒充。
- `meta` 变化已在 `App` 的 dirty effect 里，保存按钮会亮。
- `draft` 只在模态内；取消不会写 `meta`。

### 2.4 持久化

现有路径无需改动：

- 编辑器保存 `settings: meta.settings`；`carryStoredWorkflowFields` 是顶层浅合并，
  `settings` 整块以更新为准，所以「删掉键」能真正落盘。
- `asWorkflow` 的白名单把 `goalSpec` 以对象原样保留。
- 运行侧 `goalSpecOf` / `L3` 门读取同一字段；删除后则没有目标可校验（不再报
  「目标未达成」）。

### 2.5 文案

`src/workflow-editor/i18n.ts` 的 en / zh 两侧同时新增：

| key                              | en                                 | zh-CN                    |
| -------------------------------- | ---------------------------------- | ------------------------ |
| `workflowGoalTab`                | Goal                               | 目标                     |
| `workflowGoalTitle`              | Workflow goal                      | 工作流目标               |
| `workflowGoalHint`               | 说明校验时机与失败结果             | 同义中文                 |
| `workflowGoalSummary`            | Goal summary                       | 目标说明                 |
| `workflowGoalSummaryPlaceholder` | 示例占位                           | 同义中文                 |
| `workflowGoalConditions`         | Success conditions (all must hold) | 成功条件（必须全部满足） |
| `workflowGoalIncomplete`         | 保存条件说明                       | 同义中文                 |
| `workflowGoalTerminalKept`       | 终态条件保留说明                   | 同义中文                 |
| `workflowGoalDelete`             | Remove goal                        | 删除目标                 |
| `workflowGoalDeleteWarning`      | 删除后果说明                       | 同义中文                 |
| `workflowGoalDeleteConfirm`      | Confirm removal                    | 确认删除                 |

保存/取消复用既有 `save` / `cancel`。

## 3. 测试

- `tests/workflow-goal-modal.spec.tsx`（jsdom，沿用
  `tests/condition-editor-picker.spec.tsx` 的根节点与 chrome stub 写法）：
  1. 无目标的空态：保存禁用；填说明、加一条带元素名的条件后保存，`onSave` 收到
     trim 过的 summary 与该条件；
  2. 已有目标：字段回填；只改说明保存，`terminalStateConditions` 原样带回；
  3. 只加一行空条件：保存仍禁用（空行不能被存成一条恒真条件）；
  4. 删除：第一次点击不回调，第二次点击 `onSave(null)`。
- 纯校验不另写实现，`normalizeGoalSpec` 已有单测覆盖；模态测的是「行完整性 +
  按钮启用 + 回调形状」。

## 4. 手工验证

1. 打开任意工作流 → 工具栏「目标」→ 填说明、添加「元素存在」并命名元素 → 保存
   → 保存工作流（Ctrl+S）→ 重新打开「目标」，内容仍在。
2. 运行该工作流，让条件不成立 → toast 出现「运行失败：目标未达成：元素存在 …」，
   且列出的正是刚才写的条件。
3. 把条件改成必然成立（如 URL 包含当前域名）→ 再运行 → 不再报目标未达成。
4. 「删除目标」→ 第一次点击出现确认说明 → 第二次点击后保存 → 重新打开「目标」
   为空态；再运行不再做目标判定。
5. 生成型工作流（带目标）打开「目标」，确认原条件可见、只改说明保存后终态条件
   仍在（如原目标有 `terminalStateConditions`）。

扩展页面（`chrome-extension://`）无法被 MCP 脚本化，浏览器实证若拿不到将标 BLOCKED。
