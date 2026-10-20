# 生成期 chain 回改与目标门控 · Generation-time chain edit & goal-gated stitch

- 日期：2026-10-20
- 状态：设计（未实施）
- 范围：Round B —— draft chain 可回改、生成期内嵌修复轮、目标达成才 stitch
- **前置依赖**：`specs/2026-10-20-generation-failure-evidence-design.md`（Round A）必须先落地
- 不在范围：goal 契约可信度（独立主题）、DOM 级 rewind、生成期"能力缺口"的显式化

---

## 1. 问题 · What is broken

Round A 让失败**可诊断**。本规格解决诊断之后**无处可去**的问题：

生成期的 draft chain 是**严格 append-only** 的：

- `appendOperatorNode`（`src/background/operator-tool-handler.ts:242-283`）只往尾部 push，
  唯一的原地编辑是 trigger head（`:254-260`）
- 没有任何"删除 / 替换 / 编辑已记录算子"的接口，工具面（`src/background/agent.ts:610-1432`）也没有
  对应的工具
- prompt 直接禁止回头：`src/background/agent.ts:412`
  > `EVERY STEP IS REPLAYED: no detours — going back, retrying another element or re-opening a view all become nodes.`

后果（真实语料 `tmp/selftest-round*.json`，84 轮）：

- **9 轮（17%）**图里根本没有"保存草稿"节点——模型画完了 16–32 个节点，**就是没有最后那一下**。
  目标要求保存草稿，图里没有 → `generate` 阶段直接判死。
- **12 轮（14%）**卡在 `cutoff`：试跑在第一个 unsafe 步前停下，**什么都没证明**，而工作流照存。
- 修图能力**存在但不在生成期**：修复梯 S0–S7（`src/background/workflow-engine/auto-repair/orchestrator.ts`）
  已经会 resume-from-checkpoint、patch/insert/delete node、rewire edge
  （`src/lib/workflow/repair-candidate.ts:29-45`），但它只从面板运行路径 / `repairSavedWorkflowUnattended`
  进入，作用在**已装配已保存的图**上（`src/background/workflow-generation-bridge.ts:724-808`）。

**用户诉求与本规格的对应**：让"算子执行失败 → 模型判断是前序还是当前 → 改方案 → 重跑 → 目标达成再 stitch"
成为一个真实可执行的生成期循环。

---

## 2. 目标与非目标

### 目标

1. **B1 chain 可回改**：模型能在生成期删除 / 重选 / 编辑**已记录**的算子。
2. **B2 生成期内嵌修复轮**：把已有的 S0–S7 策略梯前移到生成期，作用于 draft chain。
3. **B3 目标门控 stitch**：目标达成才算数；未达成则继续（受预算约束），预算耗尽则照存但标记未认证。

### 非目标（明确拒绝）

- **不做 DOM 级 rewind / 状态复位**：见 §4.2，这是本规格最关键的否决项。
- **不改"保存永不失败"**：`src/background/operator-tool-handler.ts:790-794` 的既有 spec 保留。
  门控是**软门控**——不达成不阻断保存，只影响"是否继续生成"。
- **不修 goal 幻觉**：goal 条件由模型在第一个算子执行前凭空写下
  （`src/background/agent.ts:4207-4290`），且装配时 `groundGoalSpecToGraph` 会**静默丢弃**图满足不了的行
  （`src/background/operator-tool-handler.ts:727-736`）。本规格的 B3 因此**只能是软门控**
  （§4.4）。
- **不重写修复梯**：B2 复用 `src/lib/workflow/repair-policy.ts:8-17` 的策略枚举与
  `repair-candidate.ts` 的 patch 类型，不新建第二套（`agents.md` §5.2 / §5.6）。

---

## 3. 现状取证 · Current state

| 事实                                                                                         | 锚点                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| draft chain 严格 append-only，唯一原地编辑是 trigger head                                    | `src/background/operator-tool-handler.ts:242-283`                                          |
| 工具面无回改工具；`compose_workflow` 存在但 workflow-mode prompt 禁止模型调用                | `src/background/agent.ts:1305`、`:442`                                                     |
| prompt 禁止回头改步                                                                          | `src/background/agent.ts:412`                                                              |
| 实际 stitch 由 panel/bridge 调 `composeWorkflowFromDraft`，不是模型                          | `src/background/operator-tool-handler.ts:657-893`                                          |
| stitch 顺序：pipeline → goal grounding → 装配 → 校验 → **试跑** → 保存                       | `src/background/operator-tool-handler.ts:674`、`:727`、`:753`、`:799`、`:855`、`:879`      |
| 试跑只回写 locator 自愈，**改不了算子层**                                                    | `src/background/workflow-engine/repair/generation-trial.ts:252-258`                        |
| 修复梯能 patch/insert/delete node、rewire edge，预算 `maxAttempts 6 / maxModelCalls 8 / 90s` | `src/lib/workflow/repair-session.ts:177-184`、`src/lib/workflow/repair-candidate.ts:29-45` |
| 修复梯**从 checkpoint resume**（不重跑已完成的危险动作）                                     | `src/background/workflow-engine/auto-repair/orchestrator.ts:450-458`                       |
| 修复梯的失败快照是失败节点的元数据（错误类型、locator、url/title），非整页快照               | `src/background/workflow-engine/auto-repair/failure-snapshot.ts:77-120`                    |
| 目标判定在回放后才算，且不写进工作流                                                         | `src/background/workflow-engine/goal-verification.ts:333-345`；Round A 的 A3 会补上落盘    |
| 仓库无 DOM 级回滚；checkpoint 只恢复变量                                                     | `src/lib/workflow/checkpoints.ts:123` `restoreVariables`                                   |

---

## 4. 选型与证据 · Options considered

### 4.1 "回改"的实现形态

| 方案                                | 说明                                      | 结论                                                                                                                                               |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 原地改节点（改 data / 换 block） | 直接 patch 已记录节点                     | ❌ 否决：节点的边连、pendingBranch、tail 指针、变量引用都要重算，**"原地"的语义不明确**；且模型改了什么很难审计                                    |
| B. **截断 + 重录**                  | 把 chain 截到目标点之前，模型重新调用算子 | ✅ **采纳**：链的不变量"一条线性执行路径"完全保留；"删除 / 重选 / 编辑"三种诉求**统一为截断到某点 + 重录**；模型看到的是"我重新做了一遍"，审计容易 |
| C. 图级 patch（复用 `NodePatch`）   | 复用修复梯的 insert/delete/update         | ❌ 否决：那些 patch 作用在**已装配的 workflow 图**上（节点有 workflow 语义、边有端口句柄），draft 阶段还没有这层语义                               |

**采纳 B 的关键收益**：B 不需要任何新的图语义，只需要在 `appendOperatorNode` 之外增加一个
**截断**操作。`appendOperatorNode` 已有的 `pendingBranch` / `tail` / 边句柄逻辑
（`src/background/operator-tool-handler.ts:269-282`）在截断后需要重算，但这是**有限且可测的**工作。

### 4.2 状态一致性 —— 本规格最关键的否决项

用户诉求是"从失败的地方重新修改方案，然后运行"。**若不解决状态问题，这条路径会制造重复副作用**：
表单已填、菜单已展开、**草稿已存过一次**。真实语料里 R09 已经是 "submit executes TWICE"。

| 方案                  | 说明                                 | 结论                                                                                                                                 |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| A. 全程允许回改与重跑 | 任何点都能截断重录                   | ❌ **否决**：不幂等的动作会被重放                                                                                                    |
| B. **按幂等性切边界** | 只允许截断到"最后一个不幂等节点"之后 | ✅ **采纳**：这是**可静态判定**的，不是"状态大概可预测"的口号                                                                        |
| C. 引入 DOM 级 rewind | 失败时把页面恢复到某点               | ❌ **否决**：仓库无此设施（`checkpoints.ts` 只恢复变量），属新增基础设施；且页面状态包含网络、动画、异步数据，"恢复"的定义本身不成立 |
| D. 全程禁止回改       | 维持现状                             | ❌ 否决：把可救的失败也判死，正是 9 轮"缺终态动作"的成因                                                                             |

**采纳 B 的判据**：`idempotencyOf(blockId, data, reliability) !== 'unsafe'`
（`src/lib/workflow/trial-run.ts:207`）。该判定已在试跑里承担"不重放提交类动作"的职责
（`src/lib/workflow/trial-run.ts:199-208`），复用它等于把试跑的既有安全线提升为生成期的通用线
（`agents.md` §5.1）。

**不变式（本规格的核心断言）**：

> 重录一段链是安全的，当且仅当该段内不含不幂等节点。

该不变式可被静态判定（`safeRerunBoundaryOf`，Round A 的 A2），因此"回改"不需要状态回滚能力。
**表单填充、菜单展开、滚动、读取都是幂等的**——重录覆盖即可。

**`COMMIT_BLOCK_IDS`（`src/lib/workflow/trial-run.ts:221-230`）必须一并纳入边界判定**：
`click` / `event-click` / `press-key` / `trigger-event` / `handle-dialog` / `javascript-code` /
`webhook` / `feishu-message` —— 即使某个 click 本身幂等（如展开菜单），`press-key` 发送、
`webhook` 出网都不幂等。**保守取并集**。

### 4.3 修复轮的实现形态

| 方案                                                        | 说明                                           | 结论                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 新写一条生成期修复管线                                   | 从零实现策略梯                                 | ❌ 否决：与 `auto-repair/` 是同一能力的第二套实现，违反 `agents.md` §5.6                                                                                       |
| B. **把已有梯前移，作用对象从 workflow 图换成 draft chain** | 复用策略枚举、patch 类型、预算模型、reflection | ✅ **采纳**                                                                                                                                                    |
| C. 只做单点重试，不做策略梯                                 | 失败就重试一次                                 | ❌ 否决：真实语料 `repairStatus` 分布 `exhausted 24 / success 4`，说明单点重试不够；而"只重试一次"会让"同一失败码反复"烧光预算（`maxSameFailureSignature: 2`） |

### 4.4 目标门控的强度

| 方案                                                           | 说明     | 结论                                                                                                |
| -------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| A. 目标未达成 → 拒绝保存                                       | 硬门控   | ❌ 否决：违反"saving must never be blocked"；且 goal 条件可能不可信，硬门控把假 goal 变成"存不下来" |
| B. **目标未达成 → 继续生成/修复；预算耗尽 → 照存但标记未认证** | 软门控   | ✅ **采纳**                                                                                         |
| C. 不做门控                                                    | 维持现状 | ❌ 否决：9 轮"缺终态动作"正是"没人判定目标是否达成"的结果                                           |

**B 只能是软门控的原因**：goal spec 由模型在**第一个算子执行前**凭空写下
（`src/background/agent.ts:4207-4290`），装配时还会被 `groundGoalSpecToGraph` 静默丢弃满足不了的行
（`src/background/operator-tool-handler.ts:727-736`）。语料里 4 轮的成功条件全是 URL 行
（URL 行按定义不能证明"落地"），4 轮是页面上不存在的 CSS。
**若把不可信的 goal 当作门控，模型会用一个假 goal 给自己发奖章，循环立刻结束、缺陷被固化——比现状更糟。**
goal 条件的可信度（录制期逐行 probe 验证）属**独立主题**，本规格不解决。

---

## 5. 设计 · Design

### B1. chain 截断与重录

**新文件** `src/background/draft-truncate.ts`（与 `operator-tool-handler.ts` 同层，chrome 侧）：

```ts
export interface TruncateResult {
  /** Nodes removed from the chain, oldest first. */
  removed: { id: string; blockId: string; label: string }[]
  /** The node the chain now ends at, if any. */
  tail?: string
}

/**
 * Cut the draft chain back to `keepThroughNodeId`, dropping that node's
 * successors and rewiring the tail.
 *
 * Truncation is only legal up to the last idempotent node — a chain that
 * already committed something the site cannot take back must keep that
 * commit, or the re-run would commit it twice.
 */
export function truncateDraftAfter(
  draft: WorkflowDraft,
  keepThroughNodeId: string,
  boundary: { nodeId: string } | undefined,
): TruncateResult | { refused: string }
```

**规则**

1. 找到 `keepThroughNodeId` 在链上的位置；其**之后**的节点被移除。
2. 移除后重算：`draft.tail`、尾节点的出边、`draft.pendingBranch`、受影响节点的数据引用
   （指向被删节点的 `{{var}}` 引用由既有的数据流检查处理，不在此处静默改写）。
3. **合法性**：截断点必须**不晚于** `safeRerunBoundaryOf(draft)`（Round A 的 A2）。
   越界则 `refused`，附一句人类可读的拒绝理由。
4. 被移除节点的 `blockId` 记入 `failedBlockIds`（既有覆盖度机制，`src/lib/workflow/generation-coverage.ts`），
   这样"删掉再重选"不会因为旧的失败块号而误报覆盖缺口。

**模型侧工具**：新增**非执行**的 draft 编辑工具，与 `wf_op_*`（执行 + 记录）明确分开：

| 工具                | 语义                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `wf_draft_truncate` | 把 chain 截断到某个已记录节点（含），参数 `keepThroughNodeId`     |
| `wf_draft_list`     | 列出已记录节点（id / blockId / 标签），供模型指认"前面哪一步错了" |

**为什么用截断而不是"删除/编辑"工具**：用户的三个诉求（删除算子 / 重选算子 / 编辑算子）在这套设计里
统一为"截断到某点 + 重新调用算子"，模型的可见动作只有两种，工具面不膨胀
（`agents.md` §5.5）。"编辑算子"= 截断到它之前 + 用新参数重录同一个算子。

**prompt 同步**：`src/background/agent.ts:412` 的 "EVERY STEP IS REPLAYED: no detours" 必须**改写**，
因为它现在与本规格直接冲突。改为：

> A step that already committed something (submit, publish, save draft) is never re-run. If a later
> step fails because an earlier one was wrong, say which one and use `wf_draft_truncate` to go back
> to before it — but only back to the last step that committed nothing.

该段落受 `tests/agent-payload-size.spec.ts` 的 byte 预算约束，**净增不得超过现有余量**。

### B2. 生成期内嵌修复轮

**不新建管线**：复用

| 复用对象       | 锚点                                                                 |
| -------------- | -------------------------------------------------------------------- |
| 策略枚举 S0–S7 | `src/lib/workflow/repair-policy.ts:8-17`                             |
| patch 类型     | `src/lib/workflow/repair-candidate.ts:29-45`                         |
| 预算模型       | `src/lib/workflow/repair-session.ts:168-184`                         |
| reflection     | `src/background/workflow-engine/repair/reflection-step.ts`           |
| resume 语义    | `src/background/workflow-engine/auto-repair/orchestrator.ts:450-458` |

**改动点**

1. **patch 目标从 workflow 图换成 draft chain**。现有 `NodePatch` 是
   `update-node | insert-node | delete-node`（作用在 `WorkflowNode` 上），
   draft 阶段引入 chain 语义：`truncate-after | replace-node | edit-node`。
   建议在 `src/lib/workflow/repair-candidate.ts` 里**扩展**现有类型而不是新建平行模块
   （`agents.md` §5.3）。
2. **生成期独立预算**。`DEFAULT_REPAIR_BUDGET`（6 次 / 8 次模型调用 / 90s）是给"跑完的工作流"设计的，
   生成期的失败次数天然更多。新增 `GENERATION_REPAIR_BUDGET`，起步值：
   `maxAttempts: 4`、`maxModelCalls: 10`、`maxSameFailureSignature: 2`、`maxStrategyRepeats: 1`。
   **不覆盖** `DEFAULT_REPAIR_BUDGET`（那是运行期路径的既有契约）。
3. **证据输入**用 Round A 的 `OperatorFailureEvidence`（失败码、locator 解析、候选命中数、
   页面状态、可重跑边界），而不是现在只有一个 error 字符串的盲猜
   —— 这正是 `specs/2026-10-19-repair-reflection-design.md` §1 记录的"模型在盲猜选择器"的同类问题，
   但发生在生成期。
4. **同失败码止损**：`maxSameFailureSignature: 2` 意味着同一个失败码连续两次必须**换策略**，
   而不是重试。语料里 24 轮 `exhausted`、平均 5.29 次尝试，说明现在这一点不够硬。

### B3. 目标门控 stitch

**改动点**：`src/background/operator-tool-handler.ts:657-893` 的 `composeWorkflowFromDraft` 之前，
生成循环需要一个"目标是否达成"的判定。

1. **判定来源**：Round A 的 A3 落盘的 `settings.goalVerification`，
   以及生成期结束时的**现场判定**（对 `goalSpec.successConditions` 逐条求值，
   复用 `src/background/workflow-engine/condition-runtime.ts:308` `evaluateCondition`
   （及其 `:571` `evaluateConditionWithProbe`）与
   `src/background/workflow-engine/goal-verification.ts:132` `verifyWorkflowGoal`）。
2. **达成** → 正常 stitch（现有路径不变）。
3. **未达成** → **不 stitch**，把失败原因交给 B2 的修复轮；修复轮耗尽预算 → 走"照存但标记未认证"
   （A3 的语义）。
4. **不达成时优先修什么**：先补"缺终态动作"（9 轮的真实成因）——若 `goalSpec` 要求一个状态转移
   而图里没有产生该转移的动作节点，直接提示模型"图缺少最后一步"，而不是让模型去做通用修复。
5. **软门控的诚实标注**：因为 goal 条件本身可能不可信（§4.4），"未达成"**只触发继续尝试**，
   **不得**导致"拒绝保存"。

---

## 6. 影响面与兼容性

- **append-only 假设的破坏面**：`src/background/operator-tool-handler.ts:242-283` 的
  `appendOperatorNode` 依赖 `draft.pendingBranch` / `draft.tail` / 边句柄。截断后必须重算这三者，
  并为"截断后重录"补一组回归测试（边句柄连续性、`tail` 指向、无悬挂边）。
- **prompt 冲突**：`src/background/agent.ts:412` 必须改写；这是本规格**唯一**必须改动既有行为守则的地方，
  改写理由要写进 spec（现状把"回头"直接判为 detour，导致模型宁可画错也不回头）。
- **`failureCode` 语义漂移**：`src/lib/workflow/failure-code.ts` 是运行期的失败码表。
  生成期复用它需要确认每一码在生成期语义下一致，否则要新增生成期专属码。
- **不可逆性**：本规格是全仓库风险最高的一处改动。回退路径明确：
  B1/B2/B3 各自独立可关（用 feature flag 或按模块拆分提交），关掉后行为回到现状。
  提交前必须**在临时 worktree 里验证提交树**（`agents.md` §收尾自检 ⑨ / 共享工作区纪律）。

---

## 7. 验收标准 · Acceptance

### 机检

- `pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check` 全绿；`pnpm build`
- 新增单测：
  - 截断：链 A→B→C 截断到 A 后剩 A、tail 指向 A、无悬挂边、`pendingBranch` 已清
  - 边界：截断点越过 `safeRerunBoundary` 时 **refused**，且 draft 未被改动
  - 变量引用：被删节点是某 `{{var}}` 的生产者时，删除后数据流检查**报错**（不是静默留下悬空引用）
  - 覆盖度：被移除节点的 `blockId` 进入 `failedBlockIds` 后，覆盖度告警不误报
  - 预算：`GENERATION_REPAIR_BUDGET` 生效，同一失败码连续 2 次后必须换策略
  - 门控：目标未达成时**不 stitch**、进入修复轮；预算耗尽时**照存**并标记未认证
- `pnpm bench:debug` 的 before/after（`tests/bench/baseline.json` 的 `verifiedRecoveryRate` 0.6667）
- `pnpm selftest` 真实浏览器 n ≥ 10 轮，与 `tmp/selftest-round*.json` 基线对比

### 纪律

- **不得在没有 n ≥ 10 的真实 before/after 之前声称成功率提升**。预期区间（假设，待验证）：
  `verdict.pass` 10.7% → 20%–30%；`goalCertified` 3.6% → 12%–20%。
- **不得把 B3 描述成"硬门控"**——它是软门控，因为 goal 条件可信度未解决。
- 改写 `agent.ts:412` 的守则时，必须在 spec 里保留改写理由，且 `tests/agent-payload-size.spec.ts`
  的预算不得净增超限。
- 不得引入第二套修复策略枚举或第二套 patch 类型（`agents.md` §5.2 / §5.6）。

### 证据

- 扩展真实行为结论必须来自 `pnpm selftest` / `pnpm server:smoke` / `pnpm test:replay` 之一，
  证据落 `tmp/selftest-report.json`；拿不到就标 BLOCKED。

---

## 8. 风险 · Risks

| 风险                                         | 影响                               | 缓解                                                                                              |
| -------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| 截断后重录造成状态漂移（表单已填、菜单已开） | 重录行为与首次不同                 | 幂等动作覆盖即可（§4.2 不变式）；不幂等动作由边界拦住                                             |
| 模型滥用截断，把 chain 反复重建              | 轮次成本上升、图结构错乱           | 截断次数计入生成预算；同一失败码连续 2 次必须换策略                                               |
| `isUnsafeNode` 过度分类让边界过早前移        | 可回改范围变小                     | 已知既有问题（`src/lib/workflow/trial-run.ts:213-220`）；边界判定保守取并集，宁可少回改不可多回改 |
| B3 软门控被误当成硬门控                      | 用户看到"生成失败"但工作流其实能存 | 卡片文案必须区分"未认证"与"失败"；沿用 Round A 的 A3 结构化字段                                   |
| 破坏 append-only 假设引发连锁回归            | 大面积回归                         | B1/B2/B3 拆分提交、逐个可关；提交树在临时 worktree 验证                                           |

---

## 9. 落地顺序 · Sequencing

1. **Round A 先落地**（`2026-10-20-generation-failure-evidence-design.md`）：
   失败证据包 → 目标判定落盘 → 重跑边界计算。**低风险，纯增量。**
2. **B1**（截断与重录）：先做 `truncateDraftAfter` 的纯函数与单测，**再**接工具面。
3. **B2**（生成期修复轮）：复用已有梯，只换作用对象。
4. **B3**（目标门控）：最后做，因为它依赖 A3 的落盘字段与 B2 的修复轮。

**每一步都必须独立可交付、独立可回退。**
