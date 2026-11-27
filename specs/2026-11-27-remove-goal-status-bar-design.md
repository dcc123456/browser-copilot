# 移除对话区的「任务进行中」目标条 · 设计与计划

日期：2026-11-27 · 分支：`main`

## 1. 背景与决策

用户明确要求：**对话模式下输入一句话后不要出现「任务进行中」的信息框**。

这个框是 R10 目标对象留下的最后一块 UI：对话区底部（composer 上方）的一条目标摘要 +
状态行（`任务进行中` / `已完成`）。2026-11-27 移除轮次预算时，目标条上的预算进度、暂停态、
调整预算输入、续期与「结束并新建」按钮已经删除，只留下这行状态提示；用户现在要求把这一行也去掉。

| 候选                                     | 结论     | 理由                                                                 |
| ---------------------------------------- | -------- | -------------------------------------------------------------------- |
| 保留目标条，只藏起「任务进行中」四个字   | 否决     | 用户不想要的是这个框本身，摘要行 + 状态行都属于它                    |
| 加设置项让用户自己关闭                   | 否决     | 为一个用户明确不要的提示增加配置面，属于过度设计                     |
| 保留广播、只删 UI                        | 否决     | `goal.state` 协议只有这一个消费者，留下就是无主死代码                |
| 删除目标条及其独有协议，保留目标生命周期 | **采用** | 目标仍驱动长任务续跑、恢复注记、成本统计与完成声明；删掉的只是展示层 |

## 2. 保留 / 删除边界

**保留**（任务机制本身）：

- `TaskProgress` / `TaskGoal` 的创建、恢复注记、步骤与不可逆操作记录、成本统计、`goal_complete`
  工具与归档历史。目标仍然是「同一任务继续、新消息开新任务」的判据。
- 面板的 `goal_complete` 工具入口（模型显式声明完成）。

**删除**（只服务于目标条展示的协议与 UI）：

- `ChatTab` 的 `goalState` 状态、`resetGoalUi` 与三处调用、`goal.state` 分支、目标条 JSX。
- `AgentServerMessage` 的 `goal.state`；`agent.ts` 的 `broadcastGoal`（回合开头刷新目标条）与
  `goal_complete` 工具里推送的 `goal.state`；`index.ts` 的 `broadcastGoalState` 及其在
  `goal.complete` / `goal.abandon` 命令里的调用。
- 只由目标条按钮使用、已无发送方的 `goal.complete` / `goal.abandon` 面板命令与
  `goal.update` 响应（`Command` / `CommandResult` / `AgentClientMessage` 三处联合类型）。
- i18n 的 `goalStatusActive`（任务进行中 / Task in progress）与 `goalStatusDone`（已完成 / Done）。

## 3. 改动清单

| 文件                                  | 改动                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `src/sidepanel/ChatTab.tsx`           | 删目标条状态、重置函数、`goal.state` 分支与渲染块                       |
| `src/lib/i18n.ts`                     | 成对删除 `goalStatusActive` / `goalStatusDone`（en + zh-CN）            |
| `src/lib/messages.ts`                 | 删 `goal.state` / `goal.update` / `goal.complete` / `goal.abandon` 类型 |
| `src/background/agent.ts`             | 删 `broadcastGoal` 与完成工具里的 `goal.state` 推送                     |
| `src/background/index.ts`             | 删 `broadcastGoalState`、目标命令分支与随之无用的导入                   |
| `tests/agent-turn-resilience.spec.ts` | 长任务用例改为断言「不再广播目标状态」                                  |

## 4. 验收

- `pnpm typecheck` / `test` / `lint` / `format:check` / `build` 全绿。
- 对话区不再出现目标摘要 / 「任务进行中」/「已完成」行；切换、新建、删除会话不再需要清它。
- 长任务仍然不因轮次暂停；`goal_complete` 仍然能结束目标；目标续跑与恢复注记不受影响。
- 无残留 `goalStatus*` i18n key、无 `goal.state` 广播、无未调用的目标条状态。
