# 生成期失败证据与重跑边界 · Generation failure evidence & rerun boundary

- 日期：2026-10-20
- 状态：设计（未实施）
- 范围：Round A（低风险先行）—— 失败证据包、重跑边界、目标判定落盘
- 不在范围：draft chain 可回改（Round B，见 `2026-10-20-generation-chain-edit-loop-design.md`）、goal 契约可信度（独立主题）

---

## 1. 问题 · What is broken

工作流模式下生成的工作流，**保存后直接运行的成功率极低**。仓库内唯一的真实模型端到端语料
（`tmp/selftest-round*.json`，84 轮，同一"小红书存草稿"目标，gitignored）实测：

| 指标                              | 结果            |
| --------------------------------- | --------------- |
| `verdict.pass`                    | 9 / 84 = 10.7%  |
| `goalCertified`（真达成目标，L3） | 3 / 84 = 3.6%   |
| `verified && proven`              | 19 / 84 = 22.6% |

失败阶段分布（决定优先级）：

| 阶段       | 轮数 | 占比 | 典型原因                                                                                                                                             |
| ---------- | ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`   | 29   | 35%  | `READINESS_TIMEOUT` ×8；目标元素不存在 ×12；`UNRESOLVED_INPUT` ×2；`save-local` 对话框 ×3；AI 智能体 tool-round 耗尽 ×2；`javascript-code` 语法错 ×1 |
| `goal`     | 15   | 18%  | L3 成功条件不成立（4 轮全是 URL 行、4 轮元素不存在、2 轮变量不存在）                                                                                 |
| `generate` | 14   | 17%  | **9 轮图里没有"保存草稿"节点**；3 轮 network error；1 轮 agent 无回答                                                                                |
| `cutoff`   | 12   | 14%  | 试跑在 cutoff 停下，什么都没证明                                                                                                                     |
| `harness`  | 5    | 6%   | 扩展 SW 中途死亡（基础设施）                                                                                                                         |

**关键观察**：22.6% 的轮次"回放无错步"却仍不达成目标。也就是说，**失败的主因不是"算子执行失败"，
而是"目标与图不匹配"和"失败后无人接手"**。Round A 处理的是后者：**让失败之后的接手变得可能**。

---

## 2. 目标与非目标

### 目标

1. **失败证据包**：算子执行失败时，把诊断所需的证据回传给模型（失败码、locator 解析结果、
   CSS 候选命中数、页面状态、可重跑边界），使模型能区分"当前算子错"与"前序算子错"。
2. **重跑边界**：把"可以安全重跑到哪里"变成一个**可静态判定**的事实，并随证据回传。
3. **目标判定落盘**：把"试跑/回放之后目标是否达成"结构化写进工作流，取代当前只有一条
   `saveWarnings` 文本的状态；**不阻断保存**。

### 非目标（明确拒绝）

- **不做 draft chain 回改**：链仍是 append-only，回改属 Round B。
- **不做 DOM 级 rewind / 状态复位**：本仓库的 checkpoint 只恢复变量不恢复 DOM
  （`src/lib/workflow/checkpoints.ts:123` `restoreVariables`），本轮不引入第二套回滚机制。
- **不修 goal 幻觉**：模型凭空写的成功条件（`.publishBtn, .btn.submit, [class*='submit']`）
  属 goal 契约主题。本轮只让"目标未达成"**可见**，不改变 goal 条件的可信度。
- **不降低"保存永不失败"这条既有 spec**（`src/background/operator-tool-handler.ts:790-794`）。

---

## 3. 现状取证 · Current state

| 事实                                                                                               | 锚点                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 录制期算子**已经真跑**页面，成功才记节点，失败不记                                                 | `src/background/operator-tool-run.ts:509-527`                                                                                        |
| 失败时**只回一个 error 字符串**；`outcome.resolution` 与 CSS probe 命中数算了但**不回传**          | `src/background/operator-tool-run.ts:519-527`（`resolution` 在 `:520-522` 消费，probe 在 `:424-436` 消费）                           |
| 工具层已有粗分类（`ELEMENT_NOT_FOUND` / `STALE_REF` / `TIMEOUT` / …）与固定恢复建议                | `src/lib/tool-error.ts:15-49`、`:56-75`                                                                                              |
| 已有的失败富化只带 `errorType` / `suggestedRecovery` / `previousAttempts` / `pageStateSummary.url` | `src/background/agent.ts:5302` `enrichToolOutputError`、`:6005`                                                                      |
| 试跑跑的是**已装配的图**，在第一个 unsafe 步前 `stopBefore` 掐断                                   | `src/background/workflow-engine/repair/generation-trial.ts:180`、`src/lib/workflow/trial-run.ts:199-203`                             |
| unsafe 判定基于 `idempotencyOf`；"提交类"算子另有 `COMMIT_BLOCK_IDS`                               | `src/lib/workflow/trial-run.ts:206-208`、`:221-230`                                                                                  |
| 试跑结果**不阻断保存**，失败只进 `saveWarnings`                                                    | `src/background/operator-tool-handler.ts:849-869`、`:876-891`                                                                        |
| 目标判定（L1/L2/L3）在**回放之后**才算，生成期不判                                                 | `src/background/workflow-engine/goal-verification.ts:23`、`:333-345`；`src/background/workflow-generation-bridge.ts:633`、`:665-700` |
| draft chain 严格 append-only，唯一的原地编辑是 trigger head                                        | `src/background/operator-tool-handler.ts:242-283`                                                                                    |
| prompt 明文禁止回头改步                                                                            | `src/background/agent.ts:412`（"EVERY STEP IS REPLAYED: no detours"）                                                                |

### 缺口小结

现状是**"失败 = 一个字符串"**。模型拿到 `元素尚未可见` 这类文本时，**无法区分**：

- 目标元素确实不在页面上（换定位器也救不了）
- 目标元素在，但前一步没做完（该回去补前一步）
- 目标元素在且可见，但被遮挡/不可交互（该换交互方式）

这三类的处置完全不同，而现状把三者压成同一句话。这是 Round A 存在的全部理由。

---

## 4. 选型与证据 · Options considered

### 4.1 证据传递方式

| 方案                                             | 说明                                                 | 结论                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A. 扩 `error` 字符串                             | 把诊断塞进一段文本                                   | ❌ 否决：不可解析，模型仍要猜；且破坏 `recentFailedAttempts` 的截断逻辑（`src/lib/tool-error.ts:122` 截 200 字符）    |
| B. **结构化 `evidence` 字段**（与 `error` 并列） | 工具结果变成 `{error, evidence}`，evidence 是纯 JSON | ✅ **采纳**：与既有 `agent.ts:4417-4434` 的结构化返回风格一致；`error` 保留以兼容既有消费方                           |
| C. 失败时附整页 snapshot 文本                    | 把页面 A11y 树塞进工具结果                           | ❌ 否决：token 成本高（`tests/agent-payload-size.spec.ts` 有 byte 预算）；且模型已有 `snapshot_page` 工具，需要时自取 |

### 4.2 重跑边界

| 方案                  | 说明                                | 结论                                                                                        |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| A. 全程允许重跑       | 任何失败都可从头重跑                | ❌ 否决：产生重复副作用（真实语料已有 R09 "submit executes TWICE"）                         |
| B. **按幂等性切边界** | 边界 = 链中最后一个"不幂等"节点之后 | ✅ **采纳**：复用现成的 `idempotencyOf`（`src/lib/workflow/trial-run.ts:207`），不新造判定  |
| C. 引入 DOM 级 rewind | 失败时把页面恢复到某点              | ❌ 否决：本仓库无 DOM 回滚设施（`checkpoints.ts` 只恢复变量），属新增基础设施，超出本轮范围 |
| D. 全程禁止重跑       | 维持现状                            | ❌ 否决：把可救的失败也判死                                                                 |

**采纳 B 的理由**：`isUnsafeNode` / `idempotencyOf` 已经在试跑里承担"不重放提交类动作"的职责
（`src/lib/workflow/trial-run.ts:199-208`）。把它提升为**生成期的通用边界**，是既有能力的复用而非新造
（`agents.md` §5.1 / §5.2）。`trial-run.ts:213-220` 已记录 `isUnsafeNode` 过度分类的既有问题
（上传步骤因句子里有"发布"被判 unsafe），本轮**不修**这个过度分类，但**必须**在证据包里把
"该节点被判 unsafe 的理由"一并给出，让模型知道边界为什么落在这里。

### 4.3 目标判定

| 方案                                          | 说明   | 结论                                                                                                                       |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| A. 目标未达成 → 拒绝保存                      | 硬门控 | ❌ 否决：违反既有 spec"saving must never be blocked"；且 goal 条件本身可能不可信（洞 3），硬门控会把假 goal 变成"无法保存" |
| B. **目标未达成 → 标记未认证 + 继续生成预算** | 软门控 | ✅ **采纳**：兼容既有 spec；未认证状态是 Round B 的输入信号                                                                |

---

## 5. 设计 · Design

### A1. 失败证据包 `OperatorFailureEvidence`

**新文件** `src/lib/workflow/operator-failure.ts`（chrome-free，放 `src/lib/**` 以便 server 侧共用，
符合 `agents.md` §5.7）。

```ts
export interface OperatorFailureEvidence {
  /** 复用 lib/workflow/failure-code.ts 的失败码；无法归类时为 'UNKNOWN'。 */
  failureCode: string
  /** 粗分类：locator / readiness / contract / goal / safety / environment / workflow。 */
  category: FailureCategory
  /** 该类失败通常意味着什么（来自同一张 FAILURE_TABLE）。 */
  failureHint: string
  /** 有限次重试 / 重新观察是否可能解决。 */
  recoverable: boolean
  /** AI 修复环是否可以对它改参数。 */
  aiRepairable: boolean
  errorMessage: string
  /** 执行器回报的实际命中 spec（usedSpec / usedFallback / matched），白名单三字段。 */
  locatorResolution?: { usedSpec: string; usedFallback: boolean; matched: number }
  /** 录制前在真实页面上 probe 出的 CSS 候选命中数，截断到前 8 条。 */
  candidateCounts?: { selector: string; count: number }[]
  /** 失败时的页面状态：URL + 标题。 */
  pageState?: { url: string; title?: string }
  /** 链中最后一个可安全重跑点。 */
  safeRerunBoundary?: RerunBoundary
}
```

**`errorType` / `suggestedRecovery` 不在证据包里**：那两���字段由工具结果信封统一提供
（`src/background/agent.ts:5288` `enrichToolError` → `src/lib/tool-error.ts`），与所有其他
工具失败保持同一形状。证据包只补充**领域分类**（失败码 + 该类失败的通常含义），
同一条事实不出现两份。

**改动点**

| 文件                                                  | 改动                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/workflow/operator-failure.ts`                | 新增。纯函数：把 `outcome` + `probeCounts` + `draft` 折叠成证据包                                                                      |
| `src/background/operator-tool-run.ts`（失败分支）     | 失败分支改为 `return { ok: false, error, evidence }`。`outcome.resolution` 与 `probeCounts` 从"只消费"改为"消费并回传"                 |
| `src/background/operator-tool-run.ts`（其他拒绝分支） | JS 权限拒绝 / 定位解析为空 / 未产出的大块数据 / 必填参数缺失（前后两道）五处前置拒绝同样带上证据，保证"拒绝"与"执行失败"对模型是同构的 |
| `src/background/agent.ts`                             | `JSON.stringify({ error: out.error, evidence: out.evidence })`                                                                         |
| `src/lib/tool-error.ts`                               | 不改。`buildToolErrorContext` / `classifyToolError` 由工具结果信封继续提供 `errorType` / `suggestedRecovery`                           |

**体积约束**：证据包会进模型上下文。必须硬约束：

- `errorMessage` 截断 200 字符（与 `recentFailedAttempts` 一致，`src/lib/tool-error.ts:122`）
- `candidateCounts` 最多 8 条
- `locatorResolution` 只保留白名单字段，不透传整个对象

`tests/agent-payload-size.spec.ts` 现有 byte 预算**不得**因此超限；若超，优先缩短
`suggestedRecovery` 的文案，而不是砍证据字段。

### A2. 重跑边界 `safeRerunBoundary`

**新文件** `src/lib/workflow/rerun-policy.ts`：

```ts
/**
 * The last node in the chain a replay may safely re-run from.
 *
 * Re-running a node is safe only when nothing between it and the failure
 * committed something the site cannot take back — that is the `idempotencyOf`
 * line the trial already uses.
 */
export function safeRerunBoundaryOf(nodes: readonly WorkflowNode[]): RerunBoundary | undefined

export interface RerunBoundary {
  nodeId: string
  label: string
  intent?: string
  firstCommitNodeId?: string
  firstCommitLabel?: string
}
```

**规则**

1. 沿 chain 的执行顺序遍历（draft 的 `nodes` 即 append 顺序，**不需要**图遍历），找出
   **第一个"提交类"节点**：`isUnsafeNode(node) || isDraftSaveNode(node)`。
   这与试跑自己的截断判据 `trialCutoffNodeId`（`src/lib/workflow/trial-run.ts:199`）
   同源——"试跑愿意跑到的最后一步"就是"可安全重跑点"。
2. 边界 = **该提交节点之前的那一个**。边界之后的步骤在重跑时必须被视为已发生，不得重放。
3. 链中没有提交类节点时，边界 = 最后一个动作节点。
4. 第一个动作本身就是提交类 → 返回 `undefined`（无任何可重放的步骤）。
5. 链为空 / 只有 trigger → 返回 `undefined`。
6. 附带回报 `firstCommitNodeId` / `firstCommitLabel`：模型据此知道"要重录的是哪一步"。

**交付形态**：本轮**只计算并回传**，不强制（强制需要回改能力，属 Round B）。
但 prompt 必须同步给出规则（`src/background/agent.ts:406-456` 的 workflow-mode 段落）：

> A failed step may only be re-run from the last safe point; never re-run a step that already
> committed something (submit, publish, save draft). If the failure is caused by an earlier step,
> say which one — do not repeat the identical call.

**为什么不直接禁止**：因为 draft 是 append-only，"回到某点重跑"在 Round A 无从表达
（见 §3 末两行）。本轮把"边界是什么"变成模型可见的事实，Round B 才让它可执行。

### A3. 目标判定落盘 `goalVerification`

**现状**：目标判定只在 `certifyReplayGoal`（`src/background/workflow-generation-bridge.ts:633`、`:665-700`）
里算，结果**不写进工作流**；`composeWorkflowFromDraft` 只在 trial 失败时加一条 `saveWarnings` 文本
（`src/background/operator-tool-handler.ts:862-868`）。

**改动**

1. `src/background/workflow-engine/goal-verification.ts` 导出一个可序列化的判定结果形状：
   `{ level: 'L1' | 'L2' | 'L3' | 'NONE', certified: boolean, reason?: string, unmet: string[] }`。
2. `src/background/operator-tool-handler.ts:875` 附近，把该结果写进 `workflow.settings.goalVerification`
   （与 `withTrialRecord` 同级）。
3. **未达成时**追加一条结构化 `saveWarnings`（人类可读），并让"试跑通过但目标未达成"与
   "试跑失败"在卡片上**可区分**——现在两者都只是字符串。
4. **不阻断保存**。`saveWorkflow` 的调用（`:879-891`）不变。

**与 Round B 的接口**：Round B 需要一个信号"目标未达成 → 继续生成/修复"。
本轮把该信号以 `settings.goalVerification.certified === false` 的形式落到工作流上，
Round B 直接读它，不新增第二套判定。

---

## 6. 影响面与兼容性

- **对 server 侧**：`src/lib/workflow/operator-failure.ts` 是 chrome-free，但 server 侧
  `server/tsconfig.json` 的 `include` 已含 `../src/lib/**/*.ts`（`agents.md` §5.7），无需改白名单。
- **对既有消费方**：`OperatorRunResult` 新增 `evidence?` 字段（可选），既有 `out.ok` 判断不变。
  工具结果 JSON 多一个 `evidence` 键，模型侧无感。
- **对 `agent.ts:4411` 的下游**：`enrichToolOutputError`（`:5302`）会继续在 evidence 之上叠加
  `errorType` / `suggestedRecovery` / `previousAttempts`。**需去重**：`evidence` 已含
  `errorType` 与 `suggestedRecovery`，富化层不得重复追加同一组字段。
- **对 prompt 字节预算**：`src/background/agent.ts:406-456` 段落受
  `tests/agent-payload-size.spec.ts` 约束。A2 的新规则句需从现有预算里**合并**文本，不得净增
  （该测试已把四类 ceiling 压到个位数余量）。

---

## 7. 验收标准 · Acceptance

### 机检

- `pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check` 全绿
- `pnpm build`（改动触及 `src/background/**`）
- 新增单测：
  - 失败证据包：五处拒绝分支 + 执行失败分支各自返回非空 `evidence`，且 `failureCode` 正确
  - 体积：证据包序列化后不超过约定上限（`errorMessage` 200 字符 / candidates 8 条）
  - 边界：`safeRerunBoundaryOf` 在"链含提交节点"时返回提交节点**之前**的那个节点；空链返回 `undefined`
  - 目标落盘：`goalVerification.certified === false` 时工作流**仍然被保存**
- `pnpm selftest`（真实浏览器）跑 n ≥ 10 轮，与 `tmp/selftest-round*.json` 基线对比
  （`verdict.pass` 10.7% / `goalCertified` 3.6% / stage 分布），结果写入
  `tmp/` 并在 spec 里记录

### 纪律

- 不得在没有 n ≥ 10 的 before/after 数据前声称"成功率提升"
- 不得把 A2 的边界提示写成"已强制"——本轮是提示 + 证据，强制在 Round B
- 证据包不得携带页面全文或 snapshot（token 成本），需要时模型自己调 `snapshot_page`

### 证据

- 扩展真实行为结论必须来自 `pnpm selftest` / `pnpm server:smoke` / `pnpm test:replay` 之一，
  证据落 `tmp/selftest-report.json`。拿不到就标 BLOCKED 并写明原因。

---

## 8. 风险 · Risks

| 风险                                     | 影响                         | 缓解                                                                                                   |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| 证据包增大模型上下文，诱发更长的重试循环 | 轮次成本上升                 | 保留 `suggestedRecovery` 的"retry once"上限；证据包字段硬截断                                          |
| 模型把"可重跑边界"理解成"可以随便重跑"   | 重复副作用                   | 提示句同时给出**禁止**重放的类别（submit/publish/save draft）                                          |
| `isUnsafeNode` 的过度分类让边界过早前移  | 可重跑范围变小、误伤正常重试 | 已知既有问题（`trial-run.ts:213-220`），本轮在证据包里附上判定理由供模型判断；过度分类本身留给独立主题 |
| 目标判定落盘改变既有保存卡片的展示       | 回归                         | 只**新增** `settings.goalVerification` 与一条 warning，不改动既有字段语义                              |

---

## 9. 与 Round B 的关系

Round A 是 Round B 的**前置**，不实现 Round B 的任何能力。

| Round A 交付                | Round B 消费                                              |
| --------------------------- | --------------------------------------------------------- |
| `OperatorFailureEvidence`   | 生成期修复轮的输入（替代目前只有一个 error 字符串的盲猜） |
| `safeRerunBoundaryOf`       | chain 截断点的合法性判定（截断到 boundary 之后 = 非法）   |
| `settings.goalVerification` | 目标门控的判定来源（Round B 不新建第二套判定）            |

Round B 见 `specs/2026-10-20-generation-chain-edit-loop-design.md`。

---

## 10. Round A 的实测记录 · Measured record

### 10.1 Before 基线（Step 0，84 轮真实生成）

`node scripts/selftest-corpus-stats.mjs`（corpus = `tmp/selftest-round*.json`，gitignored）：

| 指标                  | 值            |
| --------------------- | ------------- |
| `verdict.pass`        | 9/84 (10.7%)  |
| `goalCertified`（L3） | 3/84 (3.6%)   |
| `verified && proven`  | 19/84 (22.6%) |

失败阶段分布：`verify` 29（34.5%）· `goal` 15（17.9%）· `generate` 14（16.7%）· `cutoff` 12（14.3%）·
`ok` 9（10.7%）· `harness` 5（6.0%）。

失败原因 Top-10：目标未达成 14 · replay stopped at cutoff 12 · L3 failed 11 · missing terminal save action 9 ·
replay ran clean 9 · READINESS_TIMEOUT(visible) 5 · L2 failed 4 · network error 3 · reload refused 3 ·
save-local failed 3。

### 10.2 A3 的真实浏览器证据

`settings.goalVerification` 在真实 Chrome 的扩展存储里出现（`Local Extension Settings/<ext-id>/021682.log`），
说明**白名单持久化在真实扩展里成立**（坑 1 的直接防线）：

```json
{"certified":false,"level":"NONE","reason":"The trial stopped before the last step, so the goal is unproven.","unmet":[]}
{"certified":false,"level":"NONE","reason":"The pre-save trial failed at step 2/8.","unmet":["AI : MiniMax rate limit or quota reached (429) …"]}
```

两条 reason 不同（"试跑停在最后一步之前" vs "试跑在第 2/8 步失败"），对应设计里"试跑失败"与"目标未达成"
两种可区分的读法；`unmet` 在有具体原因时带上那一条。

### 10.3 After（Step 6，n ≥ 10 轮）

**尚无数据，因此本节不做任何成功率结论。** 已就绪的是对照协议（详见
`specs/2026-10-20-generation-failure-evidence-plan.md` §Step 6）：

| 臂       | 代码                         | 轮次    | 源码指纹           |
| -------- | ---------------------------- | ------- | ------------------ |
| `arm-a2` | `4fd3ae1` + Round A 改动     | 120–129 | `74168001377b003f` |
| `arm-b2` | `4fd3ae1`（无 Round A 改动） | 130–139 | `71bd364678147554` |

两臂都在 `4fd3ae1` 上重新构建（此前的 `62f571f` 两臂作废），补丁已 typecheck，
每轮开始前把该臂的 `dist/` 覆盖到扩展的 unpacked 路径，再用该臂自己的 worktree 跑
`--skip-build`。

2026-10-20 18:38 的第一次尝试（round 120，arm-a2）在生成前 10 秒被 MiniMax 429
拒绝——配额未恢复，A/B 在换到可用 provider 之前无法产生可归因的数据。两臂必须使用
**同一个** provider，否则对照里混入 provider 变量。

### 10.4 过程中的外部阻塞 · External blockers met on the way

| 阻塞                                                                                                 | 性质                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 另一个 agent 在同一工作区并发改 `src/`（源码指纹每分钟变化，某一刻共享树甚至构建不过）               | 环境：任何"build → reload → 比对指纹"的闭环都无法收敛，轮次会测到别人在途的代码                                                                                                     |
| 扩展 service worker 在 reload 后长时间不回连适配器（"插件未连接"），`chrome://extensions` 不可脚本化 | 环境：需要人在浏览器里点一次 reload                                                                                                                                                 |
| MiniMax 429「已达到 Token Plan 用量上限」                                                            | 外部账号配额：连续 11 轮秒挂在生成前（rounds 84–94），加 150s 退避后恢复（rounds 95+ 正常生成）；2026-10-20 18:38 配额再次耗尽，A/B 第一轮即被拒，需先在 Settings 换到可用 provider |
