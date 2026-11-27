# 移除轮次预算：长任务不被数字腰斩 · 设计与计划

日期：2026-11-27 · 分支：`main`

## 1. 背景与决策

用户明确要求：**不再设置预算**，任务要能支持长任务，不因一个轮次数字被暂停或腰斩。

当前实现把 `Settings.maxToolRounds`（默认 20）当作新任务的显式轮次预算，耗尽后暂停并弹卡片让用户「续期 / 改预算 / 结束」；无人值守场景另有 `goalAutoRenewals`（K）自动续期。这套机制与用户诉求冲突，整体移除。

| 候选                                   | 结论     | 理由                                                 |
| -------------------------------------- | -------- | ---------------------------------------------------- |
| 保留预算，把默认值调到很大             | 否决     | 仍是预算；用户明确「不希望设置预算」                 |
| 保留隐藏上限，只藏起 UI                | 否决     | 隐藏上限正是「腰斩」，且违背显式预算的设计前提       |
| 彻底删除预算计数、暂停门、续期与设置项 | **采用** | 任务只由自然完成或用户手动停止结束；长任务无轮次上限 |

## 2. 保留 / 删除边界

**保留**（长任务真正需要的能力）：

- 目标摘要、步骤记录、不可逆操作指纹、成本计数、恢复注记、完成声明、归档历史。
- `Agent.maxRounds`（委派子 agent 的硬上限，与任务预算无关）与定时任务 / AI-agent block 各自的 `maxToolRounds`（它们不读 `Settings`，是独立字段）。

**删除**（预算专属）：

- `TaskGoal.maxRounds / renewIncrement / roundsStarted / budgetLog / autoRenewals`；`GoalBudgetChange`；`ArchivedGoal.autoRenewals`。
- `remainingGoalRounds / goalBudgetExhausted / renewGoalBudget / renewIncrementOf / setGoalBudget / goalBudgetDraftProblem / autoRenewDecision / recordGoalRound`；`goalBudgetReport` 改为不含轮次字段的报告。
- `GoalStatus` 的 `'paused'`；`GoalStopReason` 的 `'budget'`。
- `goal.renew` / `goal.setBudget` 命令、`goal.budgetExhausted` 事件、`awaitGoalDecision` / `getGoalAutoRenewals` 依赖。
- `Settings.maxToolRounds` / `Settings.goalAutoRenewals` 及其 coercion、UI、i18n。
- agent loop 的预算门、逐轮计数、`adoptStoredBudget` / `saveProgressKeepingBudget`（退化为直接 `saveTaskProgress`）。

## 3. 数据迁移

`TaskProgress.version` 保持 2，不引入新 schema。`coerceTaskProgress` 读到旧记录时直接忽略预算字段，并把旧 `paused` 归一为 `active`——旧数据自然降级为「无预算的活跃目标」，不需要 bump 版本，也不会因升级丢失步骤或不可逆操作记录。

## 4. 改动清单

| 文件                                                                  | 改动                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/lib/task-progress.ts`                                            | 删预算数据结构与 reducer；报告改为 `goalReport`；coerce 忽略旧字段 |
| `src/lib/types.ts`                                                    | 删 `Settings.maxToolRounds` / `goalAutoRenewals`                   |
| `src/lib/storage.ts` / `src/lib/providers.ts`                         | 删默认值与 coercion                                                |
| `src/background/agent.ts`                                             | 删预算门、逐轮计数、预算合并依赖；`beginTask` 不再收预算参数       |
| `src/background/agent-unattended.ts` / `index.ts` / `orchestrator.ts` | 删预算相关 deps 与命令分支                                         |
| `src/lib/messages.ts`                                                 | 删预算命令与事件类型                                               |
| `src/sidepanel/ChatTab.tsx` / `SettingsTab.tsx`                       | 删预算条、暂停卡、两项设置                                         |
| `src/lib/i18n.ts`                                                     | 成对删除 en / zh-CN 的预算 key                                     |
| `tests/task-goal-budget.spec.ts` 等                                   | 删除预算用例，保留目标生命周期/报告的非预算断言                    |

## 5. 验收

- `pnpm typecheck` / `test` / `lint` / `format:check` / `build` 全绿。
- 设置页不再出现预算与自动续期；对话区不再出现预算条、暂停卡、续期按钮。
- 任务跑过 20 轮及更多时不会暂停、不会发 `goal.budgetExhausted`。
- 旧进度记录（含 `maxRounds` / `paused`）加载后目标仍可见、步骤与不可逆操作不丢失。
- 无残留预算 i18n key、无未调用的预算导出。
