# 请求投影管线 · 设计（R6a）

> 状态：设计草案，待产品经理合入
> `specs/2026-11-20-agent-loop-and-token-cache-design.md` 的 R6a / AC-15 / AC-16。
> 三次组合回归（retire×压缩、hardCap×落盘、hardCap×retire）说明：三个各自正确的投影
> 分别返回数组、再由循环拼装，**组合行为没有单一 owner**。本文把"这一轮发什么"
> 收成一条管线。

## 1. 现状（要被这条管线取代的三段）

| 阶段   | 现在                                                                   | 问题                                                      |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| 压缩   | `projectCompaction(history) → messages`，循环里用 `compactedView` 粘滞 | 状态（视图 + 偏移）散落在循环变量里，重组时机靠调用点自觉 |
| 硬截断 | `projectHardCap(messages, budget) → messages`                          | 只对"传进来的数组"负责，传错对象就改到落盘对象上          |
| 回收   | `retireOldPageReads(messages, retireAll) → messages`                   | 依赖前一步的产物形态（截断后 JSON 失效就漏回收）          |

调用顺序写在 `agent.ts` 的循环体里，三处 `compactedView` 赋值、两处 budget 计算，
任何一个调用点漏一次，就复现一次本轮回归。

## 2. 目标形态

一个纯函数 + 一个显式状态：

```ts
interface ProjectionState {
  /** 上一次成功压缩的投影快照，以及它覆盖到的 history 下标。 */
  compacted: { messages: readonly WireMessage[]; fromIndex: number } | null
}

interface ProjectionInput {
  history: readonly WireMessage[] // 只读，永远不写
  state: ProjectionState
  retireAfterNavigation: boolean
  /** 本次请求的 token 预算；null = 不截断（默认窗口足够时）。 */
  budgetTokens: number | null
}

interface ProjectionResult {
  messages: WireMessage[] // 这一次真正发出去的
  state: ProjectionState // 粘滞压缩视图，下一轮原样传回
  events: {
    summarized: boolean // 压缩真的执行了
    capped: boolean // 硬截断真的执行了
    retired: number // 被回收的消息数
  }
}

function projectRequest(input: ProjectionInput): ProjectionResult
```

规则：

1. **顺序固定且唯一**：`压缩 → 硬截断 → 回收`。顺序不再由调用点决定。
   回收必须最后，因为硬截断会让读取不再是合法 JSON，回收要按工具名兜住它。
2. **只读输入**：`history` 只读；所有替换都是 copy-on-write。管线永不写 `history`。
3. **状态显式**：压缩视图只在 `ProjectionResult.state` 里流动，循环持有它并原样传回；
   不需要"记得在 400 分支里塞一次"。
4. **事件必报**：`summarized / capped / retired` 是返回值的一部分。
   “花 token 必须生效”由调用方断言：`summarized=true` 时本次 `messages` 必含摘要。
5. **预算由调用方给**：管线不读全局窗口状态；`budgetTokens` 来自循环（proactive
   阈值或 400 报出的限），这样 400 重试与主动压缩走同一条路径。
6. **失败可见**：压缩返回空（无可压缩段）时 `summarized=false`，调用方不得发
   “已压缩”状态；截断后仍超预算时 `capped=true` 且标记为未完全适配，由调用方决定
   是否继续（当前行为：继续发送，让 provider 决定）。

## 3. 与循环的接线

```ts
let projection: ProjectionState = { compacted: null }
for (round ...) {
  const result = projectRequest({
    history,
    state: projection,
    retireAfterNavigation: ctx.navigated,
    budgetTokens: budgetFrom(knownContextWindow, lastInputTokens),
  })
  ctx.navigated = false
  projection = result.state
  if (result.events.summarized) deps.send({ type: 'status', text: compactionText.status })
  const messages = [{ role: 'system', content: systemPrompt }, ...result.messages]
  ...
}
```

- 400 分支：把 provider 报的限写进 `budgetTokens`，调用同一个 `projectRequest`，然后
  `continue`——粘滞由 `projection` 自然保证。
- 手动压缩（`compactConversationOnRequest`）**不走**这条管线：它是用户意图，要写回
  transcript 并落盘；继续使用会变更历史的 `compactHistory`。

## 4. AC-16 矩阵与这条管线的关系

8 组合 = {compaction, cap, retire} 开关。管线落地后，矩阵直接调 `projectRequest` 的
三个开关（不传 budget / 传 budget / 传 retireAfterNavigation），断言：

- 任意组合下 `history` 逐字节不变；
- `retire` 开时请求内最多一条原始页面读取，且被硬截断的读取不会遗留；
- `cap` 开时 `[context-truncated]` 只允许出现在保留的那一条读取里；
- 压缩触发的那一格必须真的 `summarized=true`（不能空跑通过）。

此外保留一条**真循环 100 轮**用例（`tests/agent-request-pipeline.spec.ts`），
按 QA 的界：逐轮增量 ≤1KB、rawReads ≤1、落盘无 `retired`/摘要/硬截断标记。
矩阵测组合，真循环测状态机——两者缺一不可。

## 5. 不做

- 不改压缩架构（R6b 已关闭，压缩只作逃生路径）。
- 不引入新的持久化状态：压缩视图只在 turn 内存在，落盘仍是原文。
- 不做 provider 特化：预算与判断都由调用方给，管线不感知 provider。
