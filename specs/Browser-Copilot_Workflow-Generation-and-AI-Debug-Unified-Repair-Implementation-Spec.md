# Browser-Copilot 工作流生成 + AI 调试统一修复架构实施 Spec

> 文档状态：Implementation Ready  
> 适用范围：Chrome MV3 扩展端的工作流生成模式、工作流面板 AI 调试、执行验证、补丁预览、回放与保存  
> 核心目标：建立唯一的 `WorkflowRepairEngine`，让生成模式和 AI 调试复用同一套失败诊断、根因定位、最小补丁、Replay 与 Verification 逻辑，从而提高首次生成成功率和调试修复成功率。

---


## 0. 执行摘要

当前系统已经具备以下基础能力：

- 工作流生成模式通过 `wf_op_<blockId>` 直接执行算子并记录草稿；
- 工作流执行器拥有逐节点日志、变量、checkpoint、snapshot 和 AI takeover 挂点；
- 工作流面板已有 `workflows.debug`、`runDebugSession`、参数补丁、整图 rewrite、pending working copy 和用户确认后保存；
- 保存链路已有结构完整性检查、selector probe、selector hardening、默认等待和保存卡片；
- AI 调试已经遵守“无 AI 接管的独立运行才算 verified”。

但目前生成模式与 AI 调试仍是两套不完整的可靠性链路：

1. 生成模式主要依赖“算子执行成功后记录 + 保存前结构检查”，没有统一的失败分析与修复循环；
2. AI 调试主要围绕失败节点和 takeover fix 工作，缺少统一的变量血缘、数据流根因分析和受约束 Patch Engine；
3. 执行证据分散在 `steps`、`checkpoints`、`snapshots`、`variables` 中，没有统一 `ExecutionTrace`；
4. 当前 `patchNodeParams` 仅保护 `blockId` / `disableBlock`，其余字段缺少按根因范围、参数语义和数据流约束的校验；
5. 调试失败签名对节点区分不足，可能把不同节点的相同错误文本误判为重复死路；
6. 整图 rewrite 仍是兜底路径，但在 apply 前缺少与生成路径一致的最终结构校验和差异审计。

本次改造的最终形态：

```text
                     Workflow Repair Engine
                              │
              ┌───────────────┴───────────────┐
              │                               │
       Generation Agent                  Debug Agent
              │                               │
          Generate                          Execute
              │                               │
              └───────────────┬───────────────┘
                              ↓
                       Execution Trace
                              ↓
                       Failure Analyzer
                              ↓
                    Root Cause Analyzer
                              ↓
                      Data Flow Analysis
                              ↓
                        Repair Agent
                              ↓
                       Workflow Patch
                              ↓
                         Patch Engine
                              ↓
                    Checkpoint / Full Replay
                              ↓
                         Verification
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
                 Success              Failure
                    ↓                   ↓
                  Commit         Next Repair / Draft
```

**最重要的不变量：**

> “生成模式”和“AI 调试模式”只是入口不同。对同一个 Workflow、同一个 `ExecutionTrace` 和同一个失败，必须得到语义一致、可稳定序列化比较的 `FailureAnalysis`。

---

## 1. 改造目标与成功定义

### 1.1 产品目标

将工作流生成模式从：

```text
生成 / 录制 → 验证失败 → 整体失败或只能人工处理
```

改造成：

```text
生成完整 Workflow
→ 真实执行验证
→ 收集 ExecutionTrace
→ 定位症状节点
→ 追踪变量与控制依赖
→ 找到一个或多个根因节点
→ 生成最小 WorkflowPatch
→ Patch 校验
→ 从安全 checkpoint 重放或完整重放
→ 独立验证
→ 成功后提交；预算耗尽则保留 Draft
```

将工作流面板 AI 调试从：

```text
失败节点 → AI takeover / 修改失败节点 → 再运行
```

改造成：

```text
执行 → 统一诊断 → 展示症状与根因 → 受约束补丁
→ working copy → replay → 独立验证 → 用户确认提交
```

### 1.2 技术目标

必须实现：

- 一个共享的 `WorkflowRepairEngine`；
- 一个共享的 `ExecutionTrace` 数据模型；
- 一个共享的 `FailureAnalyzer` 和 `RootCauseAnalyzer`；
- 一个共享的变量生产者、消费者、转换关系索引；
- 一个共享的 `WorkflowPatch` 和 `PatchEngine`；
- 一个共享的 Replay / Verify 入口；
- 生成模式和 AI 调试各自只保留入口编排、UI 和提交策略差异；
- 所有正式保存前都经过结构校验；
- 所有自动修复都必须留下可解释、可预览、可回滚的 patch 与 evidence。

### 1.3 可量化成功指标

发布前建立基线，至少记录以下指标；不得只以“模型看起来更聪明”作为验收：

| 指标                         | 定义                                       | 验收方向            |
| -------------------------- | ---------------------------------------- | --------------- |
| Generation Verified Rate   | 生成后在预算内完成无 AI 接管验证的比例                    | 不低于改造前基线，目标显著提升 |
| Debug Verified Repair Rate | AI 调试产生补丁后，无 AI 接管 replay 成功且 goal 通过的比例 | 不低于改造前基线，目标显著提升 |
| Root Cause Precision       | 测试集内 `rootCauseNodeIds` 与标注根因一致的比例       | P0 测试集 100%     |
| Wrong-Node Patch Rate      | patch 修改非根因且无依赖证据节点的比例                   | P0 测试集 0%       |
| Collateral Change Rate     | patch 后无关节点发生变化的比例                       | 0%              |
| Draft Preservation Rate    | 非结构失败且预算耗尽时草稿可恢复比例                       | 100%            |
| False Verified Rate        | 有 AI 接管或 goal 未通过却标记 verified 的比例        | 0%              |
| Repair Loop Termination    | 所有失败路径都在预算内结束                            | 100%            |

生产遥测必须区分：

- 首次验证成功；
- 临时重试后成功；
- patch 后 replay 成功；
- rewrite 后成功；
- 保存 Draft；
- 结构错误阻止提交；
- 用户拒绝 patch；
- 用户应用 patch 后回滚。

---

## 2. 非目标与边界

本次不做：

- 不重写现有 workflow kernel、执行器和所有节点类型；
- 不把 AI takeover 当作 verified；
- 不允许 AI 自动绕过 CAPTCHA、2FA、登录或安全确认；
- 不默认将整个 Workflow 交给模型自由重写；
- 不把 selector probe 失败等同于结构错误；
- 不承诺任意网页、任意非幂等业务都可以自动 replay；
- 不新增第二套工作流格式；
- 不破坏手工创建、录制、导入和历史 Workflow 的兼容性；
- 不在第一阶段先重做 UI；核心诊断与 repair loop 单测通过后再接界面。

---

## 3. 现状映射：必须复用的真实代码

Coding Agent 开始前必须核对以下真实入口，不得按旧文档猜路径，也不得重复创建已有职责模块。


### 3.1 工作流生成模式

| 职责                         | 当前文件与关键符号                                                                     |
| -------------------------- | ----------------------------------------------------------------------------- |
| workflow 模式工具广告、分类分发、算子调用  | `src/background/agent.ts`：`advertiseTools`、`runOneToolCall`、`executeTool`     |
| 算子工具定义                     | `src/lib/workflow/operator-tools.ts`                                          |
| 算子分类单一真相源                  | `src/lib/workflow/operator-categories.ts`、`blocks/catalog.ts`                 |
| 执行分类                       | `src/lib/workflow/operator-class.ts`                                          |
| 执行并记录                      | `src/background/operator-tool-run.ts`：`runOperatorToolWithExecution`          |
| 复用运行时执行器                   | `src/background/workflow-engine/operator-exec.ts`：`executeOperatorNode`       |
| 草稿拼接与持久化                   | `src/background/operator-tool-handler.ts`、`src/lib/workflow/draft-storage.ts` |
| 回合结束保存决策                   | `src/background/history-compile.ts`：`resolveWorkflowForSave`                  |
| 保存卡片                       | `src/sidepanel/ChatTab.tsx`：`maybePromptSaveWorkflow`                         |
| 结构完整性                      | `src/lib/workflow/integrity.ts`：`checkWorkflowIntegrity`                      |
| selector probe / hardening | `src/lib/workflow/selector-probe.ts`、`src/background/selector-probe.ts`       |
| 默认等待与可运行性                  | `src/lib/workflow/runnability.ts`                                             |
| 保存命令                       | `src/background/index.ts`：`workflows.save`                                    |

必须保持以下现有不变量：

1. 算子真实执行成功后才记录草稿；失败必须可见，不能把失败节点记成成功节点；
2. 工作流模式不得重新广告原生 `click` / `fill` / `open_url` 等动作工具；
3. `resolveWorkflowForSave` 仍是保存卡片 Workflow 来源的唯一决策点；
4. 保存卡片先出现，selector probe 异步回填，不因 probe 不可用静默阻塞；
5. 生成数据必须遵守动态数据规则，不能把网页快照冻结成静态默认值；
6. 文件写入节点必须把失败抛给引擎，不能只 `emit('error')`。


### 3.2 工作流面板 AI 调试

| 职责                                     | 当前文件与关键符号                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| AI 调试按钮、实时日志、确认弹窗                      | `src/sidepanel/WorkflowsTab.tsx`：`debugNow`                                       |
| 保存后可选验证入口                              | `src/sidepanel/ChatTab.tsx`                                                       |
| 消息协议                                   | `src/lib/messages.ts`：`workflows.debug`、`workflows.takeoverApply` 等               |
| 后台装配                                   | `src/background/index.ts`：`case 'workflows.debug'`                                |
| 调试循环                                   | `src/background/workflow-engine/debug-session.ts`：`runDebugSession`               |
| 参数补丁                                   | `src/lib/workflow/auto-debug-patch.ts`：`patchNodeParams`                          |
| replay / audit / rewrite / goal prompt | `src/lib/workflow/debug-rewrite.ts`                                               |
| takeover 判定与错误分类                       | `src/lib/workflow/ai-takeover.ts`、`src/background/workflow-engine/ai-takeover.ts` |
| 执行入口                                   | `src/background/workflow-engine/run-workflow.ts`：`executeWorkflow`                |
| 引擎 hook                                | `src/background/workflow-engine/engine.ts`                                        |
| working copy / pending                 | `src/lib/workflow/takeover-pending.ts`                                            |
| 指标                                     | `src/lib/workflow/takeover-stats.ts`                                              |

必须保留以下现有安全边界：

1. 调试过程先修改内存 working copy / pending，不直接覆盖正式 Workflow；
2. 无 AI 接管的独立执行成功且 goal 通过，才允许 `verified: true`；
3. 用户确认后才执行 `workflows.takeoverApply`；
4. 非幂等流程和重复失败必须有熔断；
5. provider 不可用时必须显式降级，不得伪装成完整 AI 调试成功；
6. pending 记录必须支持应用、拒绝和恢复原版本。

### 3.3 当前执行证据

现有证据已经足以构造统一 trace，但目前分散：

- `engine.ts` 的 `onStep`；
- `engine.ts` 的 `onCheckpoint`；
- `engine.ts` 的 `onSnapshot`；
- `WorkflowRunResult.completedNodeIds / variables / steps`；
- `running-tasks.ts` 的 `RunStep[]`；
- `checkpoints.ts` 的 `RunCheckpoint[]`。

**实施要求：优先在 `run-workflow.ts` 聚合这些回调，不先大改引擎。**

---

## 4. 核心原则

1. **Failed Node 不等于 Root Cause Node。**
2. **Verification Failure 不等于 Generation Failure。**
3. **无法证明正确不等于证明错误。**
4. **先检查瞬态错误，再做结构修复。** 页面未就绪、网络短暂错误应先执行有界 retry。
5. **先追踪数据血缘，再决定修复节点。**
6. **优先修 root cause，不默认修症状节点。**
7. **Repair 必须输出最小 Patch，不默认输出整个 Workflow。**
8. **修复 producer / transform 后，必须重新生成变量并重放消费者。**
9. **AI takeover 成功不等于 Workflow 已修好。** 必须关闭 takeover 后独立 replay。
10. **分析、建议、应用、验证、提交必须分层。**
11. **非结构错误预算耗尽时保存 Draft / working copy，不丢结果。**
12. **同一输入必须产生一致诊断。** 生成模式与 AI 调试不得各自发明根因。
13. **任何 patch 都必须可解释。** 至少包含症状、根因、证据、变更、风险和回放起点。
14. **AI 只提案，Patch Engine 决定是否允许落地。**

---

## 5. 统一领域模型


### 5.1 ExecutionTrace

新增：

```text
src/lib/workflow/execution-trace.ts
```

建议类型：

```ts
interface ExecutionTrace {
  traceId: string
  workflowId: string
  sessionId?: string
  runId: string
  entry: "GENERATION" | "DEBUG" | "VERIFY" | "REPLAY"

  startedAt: number
  finishedAt?: number
  outcome: "ok" | "failed" | "cancelled"

  events: TraceEvent[]
  nodeExecutions: NodeExecutionTrace[]
  checkpoints: TraceCheckpoint[]

  finalVariables: Record<string, VariableValueSummary>
  failedNodeId?: string
  failure?: TraceFailure

  currentUrl?: string
  currentTabId?: number
  currentFramePath?: string[]
}

interface TraceEvent {
  sequence: number
  at: number
  kind: "tool" | "status" | "result" | "error" | "info" | "checkpoint"
  nodeId?: string
  text: string
}

interface NodeExecutionTrace {
  nodeId: string
  blockId?: string
  attempt: number
  status: "running" | "ok" | "failed" | "cancelled" | "skipped"
  startedAt?: number
  finishedAt?: number

  inputVariables: VariableUseEvidence[]
  outputVariables: VariableProductionEvidence[]
  error?: TraceFailure
}

interface TraceCheckpoint {
  checkpointId: string
  stepIndex: number
  nodeId?: string
  status: "running" | "ok" | "failed" | "cancelled"
  variableSummaries: Record<string, VariableValueSummary>
  pageState?: unknown
  at: number
}

interface TraceFailure {
  code: VerificationFailureType
  message: string
  nodeId?: string
  retryable: boolean
  source: "EXECUTOR" | "CONTRACT" | "POSTCONDITION" | "GOAL" | "STRUCTURE"
}
```

约束：

- 完整 trace 必须在执行时实时聚合；不得依赖现有被截断的 `steps.slice(-40)` 事后重建；
- trace 中可以保留节点 ID 和变量名，但敏感值必须只保留摘要；
- checkpoint 的变量快照深拷贝失败时必须记录 `snapshotAvailable: false`，不能静默当作空变量；
- 子工作流事件要携带 `workflowPath` 或 `parentNodeId`，不能假设 `stepIndex` 与顶层节点一一对应；
- 历史调用方允许 `trace` 为可选，确保兼容旧代码和旧记录。


### 5.2 Variable Provenance 与 Data Flow

新增：

```text
src/lib/workflow/dataflow-analyzer.ts
src/lib/workflow/variable-provenance.ts
```

建议类型：

```ts
interface VariableProvenance {
  variable: string
  producerNodeId?: string
  producerKind:
    | "WORKFLOW_INPUT"
    | "NODE_OUTPUT"
    | "ENGINE_ALIAS"
    | "TRANSFORM"
    | "LOOP_CONTEXT"
    | "UNKNOWN"
  sourcePath?: string
  sourceVariable?: string
}

interface VariableUseEvidence {
  variable: string
  consumerNodeId: string
  paramPath: string
  resolved: boolean
  summary: VariableValueSummary
}

interface VariableProductionEvidence {
  variable: string
  producerNodeId: string
  summary: VariableValueSummary
  contract?: VariableContractResult
}

interface VariableValueSummary {
  exists: boolean
  isEmpty?: boolean
  type?: string
  length?: number
  redacted: boolean
  hash?: string
}

interface DataFlowGraph {
  producers: Map<string, VariableProvenance[]>
  consumers: Map<string, VariableUseEvidence[]>
  edges: DataDependencyEdge[]
}

interface DataDependencyEdge {
  fromNodeId?: string
  variable: string
  toNodeId: string
  relation: "PRODUCES" | "CONSUMES" | "TRANSFORMS" | "CONTROL_DEPENDENCY"
}
```

必须覆盖：

- `node.data.variableName`；
- `{{variable}}` 和 `{{a.b.0}}`；
- trigger parameters；
- 引擎固定变量，如 `lastText`、`lastValue`、`dataTable`、`loopIndex` 等；
- transform / set-variable / regex / slice / mapping 等变量转换；
- 条件表达式、URL、selector、form value、AI Agent 输入；
- loop / branch 上下文；
- 多 producer 冲突；
- 悬空引用和循环依赖。

第一阶段应复用并扩展：

- `src/lib/workflow/integrity.ts` 的变量扫描；
- `src/lib/workflow/interpolate.ts` 的 token 规则；
- `src/lib/workflow/dynamic-data.ts` 的 rewrite 记录；
- `src/lib/workflow/data-params.ts` 的数据/结构参数分类；
- `src/lib/workflow/block-requirements.ts` 的必填契约。

不得另写一套不一致的 `{{variable}}` 解析器。

### 5.3 Variable Contract

```ts
interface VariableContract {
  type?: "string" | "number" | "boolean" | "array" | "object"
  required?: boolean
  allowEmpty?: boolean
  minLength?: number
  pattern?: string
}

interface VariableContractResult {
  valid: boolean
  violations: string[]
}
```

Contract 的用途：

- producer 执行后尽早产生 repair signal；
- 区分“变量存在但为空”“变量类型错误”“变量未生成”；
- 为 Failure Analyzer 提供证据。

Contract 无法证明时只能产生 `unknown` / warning，不能单独阻止保存。

### 5.4 FailureAnalysis

```ts
interface FailureAnalysis {
  analysisVersion: 1
  failedNodeId: string
  rootCauseNodeIds: string[]
  failureType: VerificationFailureType

  repairTarget:
    | "FAILED_NODE"
    | "UPSTREAM_NODE"
    | "MULTIPLE_NODES"
    | "NO_SAFE_REPAIR"

  dependencyChain: DependencyNode[]
  variableEvidence: VariableEvidence[]
  pageEvidence: PageEvidence[]
  alternatives: RootCauseCandidate[]

  explanation: string
  confidence: number
  retryRecommended: boolean
  replayFromNodeId?: string
}

interface RootCauseCandidate {
  nodeId: string
  reason: string
  confidence: number
  evidenceIds: string[]
}

interface DependencyNode {
  nodeId?: string
  variable?: string
  relation:
    | "USES_VARIABLE"
    | "PRODUCES_VARIABLE"
    | "TRANSFORMS_VARIABLE"
    | "CONTROL_DEPENDENCY"
}
```

`FailureAnalysis` 必须可以稳定序列化。相同 workflow + trace 的结果比较时，`rootCauseNodeIds`、`dependencyChain`、evidence 顺序必须确定，禁止依赖 Map 插入偶然顺序。

### 5.5 VerificationResult

```ts
interface VerificationResult {
  success: boolean
  verified: boolean
  goalAchieved?: boolean

  trace: ExecutionTrace
  failedNodeId?: string
  failureType?: VerificationFailureType
  error?: string

  executedNodes: string[]
  skippedNodes: string[]
  warnings: VerificationWarning[]

  checkpointId?: string
  usedAiTakeover: boolean
  usedFallbackReplay: boolean
}
```

规则：

```text
verified = success
        && usedAiTakeover === false
        && goalAchieved !== false
        && structural validation clean
```

### 5.6 WorkflowPatch

`WorkflowPatch` 必须支持一个分析对应多个原子操作：

```ts
interface WorkflowPatchSet {
  patchSetId: string
  analysisId: string
  operations: WorkflowPatchOperation[]
  reason: string
  confidence: number
  expectedEffect: string
  replayFromNodeId?: string
}

interface WorkflowPatchOperation {
  operationId: string
  nodeId: string
  kind:
    | "SET_PARAM"
    | "REMOVE_PARAM"
    | "REPLACE_TARGET"
    | "REPLACE_INPUT_REF"
    | "REPLACE_OUTPUT"
    | "INSERT_NODE"
    | "REMOVE_NODE"
    | "REWIRE_EDGE"
  path?: string
  before?: unknown
  after?: unknown
  reason: string
  evidenceIds: string[]
}
```

`before` 必须由 Patch Engine 从 working copy 校验，不能只信模型；若当前值与 `before` 不一致，patch 必须拒绝并重新诊断，防止并发或陈旧 patch 覆盖新修改。


### 5.7 统一 Repair Engine

```ts
interface WorkflowRepairEngine {
  diagnose(
    workflow: Workflow,
    trace: ExecutionTrace
  ): Promise<FailureAnalysis>

  propose(
    workflow: Workflow,
    analysis: FailureAnalysis,
    context: RepairContext
  ): Promise<WorkflowPatchSet | null>

  validatePatch(
    workflow: Workflow,
    analysis: FailureAnalysis,
    patch: WorkflowPatchSet
  ): PatchValidationResult

  apply(
    workflow: Workflow,
    patch: WorkflowPatchSet
  ): PatchApplyResult

  replay(
    workflow: Workflow,
    analysis: FailureAnalysis,
    options?: ReplayOptions
  ): Promise<VerificationResult>

  verify(
    workflow: Workflow,
    options?: VerificationOptions
  ): Promise<VerificationResult>
}
```

建议代码结构：

```text
src/background/workflow-engine/repair/
  repair-engine.ts
  failure-analyzer.ts
  root-cause-analyzer.ts
  repair-agent.ts
  replay-engine.ts
  verification-runner.ts

src/lib/workflow/repair/
  types.ts
  dataflow-analyzer.ts
  variable-provenance.ts
  patch-engine.ts
  patch-policy.ts
  failure-classifier.ts
  redaction.ts
```

原则：纯函数、图分析、patch 校验放 `src/lib`；依赖浏览器、执行器、模型 provider 的编排放 `src/background`。

---

## 6. Failure Analyzer 与根因算法

### 6.1 两阶段分析

必须分成：

1. **确定性分析阶段**：使用结构、trace、变量证据、contract、selector 结果和 checkpoint；
2. **AI 补充阶段**：只在确定性证据不足时解释页面证据或提出修复，不得推翻硬证据。

AI 不负责决定“哪个节点执行过”“变量是否为空”“producer 是谁”。这些必须由代码提供。

### 6.2 分析顺序

```text
1. 校验 Workflow 结构
2. 分类失败是否为瞬态错误
3. 锁定 failedNodeId
4. 检查 failed node 自身参数、selector、URL、tab、frame、action
5. 提取 failed node 的所有输入变量
6. 检查每个变量的 resolved / exists / empty / type / contract
7. 反向找到最近 producer
8. 若 producer 是 transform，继续追踪其输入
9. 找到首个实际违反输出契约或执行失败的节点
10. 收集所有独立异常链，支持多个 root cause
11. 计算可安全 replay 的最早节点和 checkpoint
12. 输出确定性排序的 FailureAnalysis
```

### 6.3 瞬态错误必须先分流

以下错误默认先有界重试，不立即调用 Repair Agent：

- `PAGE_NOT_READY`；
- 短时 `TARGET_NOT_FOUND`，且 DOM / URL 仍在变化；
- `FRAME_NOT_READY`；
- 可重试网络错误；
- 等待条件未满足。

策略：

```ts
const transientPolicy = {
  maxRetries: 2,
  retryDelayMs: [500, 1500],
  requireStableUrlBeforeRepair: true,
  requireStableDomProbeBeforeSelectorPatch: true
}
```

若重试后成功，记录 `TRANSIENT_RECOVERY`，不生成 patch。

### 6.4 根因规则

#### Case A：失败节点自身错误

```text
Node5 selector 唯一性验证失败
且 Node5 无异常输入变量
→ failedNodeId = Node5
→ rootCauseNodeIds = [Node5]
```

#### Case B：直接上游变量错误

```text
Node3 produces captcha=""
Node5 consumes {{captcha}}
Node5 failed
→ failedNodeId = Node5
→ rootCauseNodeIds = [Node3]
```

#### Case C：转换节点错误

```text
Node3 produces rawCaptcha="123456"
Node6 transforms rawCaptcha → captcha=undefined
Node8 consumes captcha
→ rootCauseNodeIds = [Node6]
```

不得继续向上错误地把 Node3 当根因，因为 Node3 的输出证据有效。

#### Case D：多个根因

```text
Node3 produces username=""
Node4 produces password=""
Node5 consumes both and fails
→ rootCauseNodeIds = [Node3, Node4]
```

#### Case E：变量有效但消费者配置错误

```text
Node3 produces captcha="123456"
Node5 input path 写成 {{captch}}
→ rootCauseNodeIds = [Node5]
```

#### Case F：无安全自动修复

```text
Node5 失败原因涉及 CAPTCHA / 2FA / 权限确认
→ repairTarget = NO_SAFE_REPAIR
→ 保留 working copy / Draft
→ 显示用户操作建议
```

### 6.5 循环与多 producer

- 递归必须使用 `visitedVariables` 和 `visitedNodes`；
- 检测到循环依赖后返回 `STRUCTURAL_ERROR` 或明确的 dataflow warning，不得无限递归；
- 同一变量有多个可达 producer 时，必须结合控制流、实际执行顺序和 checkpoint 判断“最后实际生产者”；
- 无法唯一判断时，返回多个 candidate 和较低 confidence，不自动 patch。

---

## 7. Repair Agent Prompt 契约

Repair Agent 输入必须是结构化、最小化、已脱敏的 context：

```ts
interface RepairContext {
  failedNodeId: string
  rootCauseNodeIds: string[]
  failureType: VerificationFailureType
  dependencyChain: DependencyNode[]
  variableEvidence: VariableEvidence[]
  pageEvidence: PageEvidence[]
  allowedNodeIds: string[]
  allowedParamPaths: Record<string, string[]>
  recentTrace: TraceEvent[]
  repairHistory: RepairRoundSummary[]
}
```

必须提供：

- failed node 与 root cause node 的区别；
- 每条变量链的 producer / transform / consumer；
- 变量只提供是否存在、类型、长度、是否为空、contract 结果；
- 页面证据只提供修复所需的局部 DOM / locator 候选；
- 本轮允许修改的节点和参数路径；
- 已尝试 patch，防止重复建议；
- 强制 JSON schema 输出。

不得提供：

- password、cookie、token、API key、2FA secret；
- CAPTCHA 真实值；
- 与根因无关的大段页面文本；
- 完整浏览历史；
- 未经脱敏的 variables dump。

AI 输出不得直接落盘。解析失败、schema 不合法、越权修改或无 evidence 的 patch 一律拒绝。

---

## 8. Patch Engine 与安全策略

### 8.1 允许范围

默认只允许修改：

```text
rootCauseNodeIds
+ 为保持数据依赖完整而必须同步修改的直接依赖节点
```

如果 patch 修改 `failedNodeId`，必须满足至少一个条件：

- `failedNodeId` 本身就是 root cause；
- 修改的是与根因变量引用直接相关的 consumer 参数；
- `FailureAnalysis` 明确列出该节点为允许依赖节点。

### 8.2 禁止规则

- 禁止无理由修改失败链之外节点；
- 禁止默认整图重写；
- 禁止批量删除节点；
- 禁止修改 `blockId`、`disableBlock`、Goal、Trigger，除非分析明确授权；
- 禁止修改已经验证成功且不受根因数据影响的节点；
- 禁止把 `onError` 改成 continue 来伪造成功；
- 禁止删除 postcondition / goal check 来伪造成功；
- 禁止将动态数据替换成生成时静态值；
- 禁止创建悬空变量、孤儿节点和不可达节点；
- 禁止绕过 CAPTCHA、2FA、授权或危险确认；
- 禁止通过整图 rewrite 绕过原子 patch 限制。

### 8.3 Patch 校验顺序

```text
1. JSON schema
2. patchSetId / operationId 唯一
3. target node 存在
4. target node 位于 allowedNodeIds
5. path 位于 allowedParamPaths
6. before 与 working copy 当前值相等
7. operation 对该 blockId 合法
8. 数据参数/结构参数语义合法
9. apply 到 clone
10. checkWorkflowIntegrity
11. validateWorkflowForRun
12. 动态数据门禁
13. selector / locator 静态规则
14. 计算 diff，确认无额外变化
15. 输出 PatchValidationResult
```

### 8.4 整图 rewrite 兜底

保留现有 `debug-rewrite.ts`，但降低优先级：

```text
原子 patch 尝试失败
+ 根因证据表明结构需要调整
+ 用户允许或自动策略允许
→ rewrite proposal
```

rewrite 必须：

- 在生成时通过 `buildRewrittenWorkflow`；
- 保存 pending 前再次校验；
- `workflows.takeoverApply` 正式写入前再次运行结构、blockId 白名单、边、trigger、动态数据和 diff 校验；
- UI 显示整图 rewrite 与原子 patch 的风险差异；
- 独立 verify 失败时不得覆盖正式 Workflow。

---

## 9. Checkpoint、Replay 与副作用安全

### 9.1 Replay 起点

修复 Node3 后，不得直接从症状 Node5 开始：

```text
Node1 ✓
Node2 ✓  ← safe checkpoint
Node3 ✗  ← root cause
Node4
Node5 ✗  ← symptom
```

正确重放：

```text
Checkpoint(Node2)
→ Node3'
→ Node4
→ Node5
```

### 9.2 Replay 起点算法

1. 找到所有 root cause 节点；
2. 取控制流上最早受影响根因；
3. 找其前一个状态为 `ok` 的 checkpoint；
4. 检查 checkpoint 的页面、tab、frame 和变量快照是否可恢复；
5. 检查从 checkpoint 到失败节点的路径是否包含不可安全重复的副作用；
6. 安全则 checkpoint replay；否则 full replay 或请求用户确认；
7. 任何恢复不确定性不得伪装成成功恢复。

### 9.3 副作用分类

为 block 增加或复用 side-effect metadata：

```ts
type ReplaySafety =
  | "SAFE"
  | "IDEMPOTENT"
  | "REQUIRES_STATE_CHECK"
  | "REQUIRES_CONFIRMATION"
  | "FORBIDDEN_AUTO_REPLAY"
```

例如提交订单、发送消息、删除数据、支付、发布内容，不得自动 full replay。必须先检查“是否已完成”，无法判断时要求用户确认。

### 9.4 独立验证

Replay 后必须关闭 AI takeover，再运行一次：

```text
patched working copy
→ execute without AI takeover
→ postconditions
→ goal check
→ structural validation
→ verified
```

仅“AI 在执行过程中把任务做完”不能证明 Workflow 已修复。

---

## 10. 两种入口的统一流程


### 10.1 Generation Agent

```ts
async function finalizeGeneratedWorkflow(session: GenerationSession) {
  let workingCopy = normalizeWorkflow(session.workflow)

  for (let round = 0; round < session.policy.maxRepairRounds; round++) {
    const verification = await repairEngine.verify(workingCopy, {
      entry: "GENERATION",
      allowAiTakeover: false
    })

    if (verification.verified) {
      return commitVerifiedWorkflow(workingCopy, session, verification)
    }

    const analysis = await repairEngine.diagnose(
      workingCopy,
      verification.trace
    )

    if (analysis.failureType === "STRUCTURAL_ERROR") {
      return blockCommitWithRecoverableSession(session, analysis)
    }

    if (analysis.retryRecommended) {
      const retried = await retryTransientFailure(workingCopy, analysis)
      if (retried.verified) {
        return commitVerifiedWorkflow(workingCopy, session, retried)
      }
    }

    const patch = await repairEngine.propose(
      workingCopy,
      analysis,
      buildRepairContext(workingCopy, verification, analysis)
    )

    if (!patch) break

    const validation = repairEngine.validatePatch(
      workingCopy,
      analysis,
      patch
    )
    if (!validation.ok) break

    workingCopy = repairEngine.apply(workingCopy, patch).workflow

    const replay = await repairEngine.replay(workingCopy, analysis, {
      allowAiTakeover: false
    })
    if (replay.verified) {
      return commitVerifiedWorkflow(workingCopy, session, replay)
    }
  }

  return commitDraftWorkflow(workingCopy, session)
}
```

生成模式要求：

- 原有算子执行并记录流程不变；
- repair loop 作用于已形成的 working copy；
- 运行时失败不能让整个生成结果消失；
- 非结构失败保存为 Draft，并显示诊断与下一步；
- 只有结构不合法、安全策略失败才阻止正式保存；
- 首次生成成功与 repair 后成功必须在遥测中区分。

### 10.2 Debug Agent

提供三个明确动作：

```text
[运行]
[AI 分析]
[AI 自动修复]
```

#### AI 分析

```text
Execute
→ Build ExecutionTrace
→ Diagnose
→ 展示 FailureAnalysis
```

不调用 Repair Agent，不修改 working copy，不产生 pending patch。

#### AI 建议修复

```text
Execute / 使用同一失败 trace
→ Diagnose
→ Propose Patch
→ Validate Patch
→ 保存为 pending proposal
→ UI 预览
```

不自动 apply 到正式 Workflow。

#### AI 自动修复

```text
Execute
→ Diagnose
→ Propose
→ Validate
→ Apply 到 Debug Working Copy
→ Replay
→ Verify without AI takeover
→ 成功后进入待确认状态
```

自动修复可以跳过“应用到 working copy”的人工确认，但不能跳过 Patch Engine、Replay、Verify 和最终正式提交确认。

### 10.3 一致性保证

新增纯函数一致性测试：

```ts
const generationAnalysis = await engine.diagnose(workflow, trace)
const debugAnalysis = await engine.diagnose(workflow, trace)

expect(canonicalize(generationAnalysis))
  .toEqual(canonicalize(debugAnalysis))
```

两个入口不得把 mode 注入到 Analyzer 中影响根因结果。入口信息只用于日志和提交策略。

---

## 11. Session、Working Copy 与提交语义

### 11.1 统一 Repair Session

```ts
interface WorkflowRepairSession {
  sessionId: string
  workflowId: string
  entry: "GENERATION" | "DEBUG"
  status: RepairSessionStatus

  originalWorkflow: Workflow
  workingCopy: Workflow

  rounds: RepairRound[]
  pendingPatch?: WorkflowPatchSet
  lastVerification?: VerificationResult
  lastAnalysis?: FailureAnalysis

  policy: RepairPolicy
  createdAt: number
  updatedAt: number
}

type RepairSessionStatus =
  | "EXECUTING"
  | "ANALYZING"
  | "DIAGNOSED"
  | "PATCH_PROPOSED"
  | "PATCHING"
  | "REPLAYING"
  | "VERIFYING"
  | "VERIFIED"
  | "DRAFT"
  | "FAILED"
  | "CANCELLED"
```

### 11.2 保存规则

#### 生成模式

- verify 成功：保存为 `VERIFIED`；
- repair 预算耗尽：保存为 `DRAFT`；
- selector probe 不可用：保留 locator + warning，可保存 Draft；
- 结构错误：阻止提交，但保留 generation session，允许继续修复；
- 不得因为单个运行时错误丢弃已生成 Workflow。

#### AI 调试

- 分析阶段：不修改正式 Workflow；
- patch proposal：保存 pending；
- apply：只应用到 working copy；
- replay 成功：标记 verified，但仍等待用户确认正式提交；
- replay 失败：保留 working copy、分析和 patch 历史；
- 用户可选择应用、拒绝、继续调试、恢复原版本；
- 正式 apply 前重新校验 pending 内容，防止过期或被篡改。

### 11.3 并发保护

当前 pending 以 workflowId 覆盖最新记录，需增加：

- `sessionId`；
- `baseWorkflowUpdatedAt` 或内容 hash；
- apply 时乐观锁检查；
- 若正式 Workflow 已变化，拒绝旧 patch 并要求重新分析；
- 同一 Workflow 同时只能有一个 active repair session，或 UI 明确允许用户选择会话。

---

## 12. AI 调试 UI

### 12.1 诊断卡片

当 Node5 失败而 Node3 是根因时：

```text
执行失败

失败节点
└── Node5：提交登录

根因节点
└── Node3：获取验证码

数据链路
Node3 → captcha → Node5

证据
captcha 已生成，但值为空，不满足 required + allowEmpty=false

建议修改
将 Node3 的读取方式从元素文本改为 input.value

[查看修改] [应用修复] [取消]
```

必须同时展示：

- Failed Node；
- Root Cause Node(s)；
- Variable Dependency；
- Failure Type；
- Evidence；
- Patch Diff；
- Replay 起点；
- Verification Result。

### 12.2 多根因

```text
失败节点：Node5
根因节点：Node3、Node4

Node3 → username → Node5
Node4 → password → Node5
```

Patch 预览按 node 分组，但底层属于同一 `WorkflowPatchSet`，必须原子应用；不允许只应用一半后把 session 当作完整修复。

### 12.3 状态进度

```text
✓ 已执行工作流
✗ Node5 执行失败
… 正在分析根因
✓ 发现 Node3 的 captcha 输出为空
✓ 已生成最小补丁
✓ 补丁校验通过
↻ 从 Node2 checkpoint 重放
✓ Node3
✓ Node4
✓ Node5
✓ Goal 验证成功
```

### 12.4 文案与样式

- 新增可见文案必须同时更新 `src/lib/i18n.ts` 的 `Messages`、`en`、`zh-CN`；
- UI 使用 Tailwind 语义 token，不写硬编码 hex；
- 不依赖颜色单独表达失败/成功，必须带文字和图标/状态；
- 错误详情默认脱敏；
- “AI 完成了任务”和“工作流已独立验证”必须使用不同文案。

---

## 13. Repair Budget 与终止条件

```ts
interface RepairPolicy {
  maxVerifyRounds: number
  maxRepairRounds: number
  maxRepairPerNode: number
  maxSameFailureSignature: number
  maxTransientRetries: number
  maxProbePerNode: number
  maxTotalDurationMs: number
  allowWholeWorkflowRewrite: boolean
}

const defaultRepairPolicy: RepairPolicy = {
  maxVerifyRounds: 6,
  maxRepairRounds: 5,
  maxRepairPerNode: 2,
  maxSameFailureSignature: 2,
  maxTransientRetries: 2,
  maxProbePerNode: 1,
  maxTotalDurationMs: 120_000,
  allowWholeWorkflowRewrite: true
}
```

失败签名至少包含：

```text
workflowId
nodeId
failureType
normalizedError
rootCauseNodeIds
relevantVariableNames
```

不得继续使用固定 `nodeId='session'` 的粗粒度签名判断不同节点是同一死路。

立即终止自动修复的条件：

- CAPTCHA / 2FA / auth 需要用户操作；
- patch 越权；
- 同一根因重复失败达到阈值；
- working copy 与 base 版本冲突；
- 结构错误无法安全修补；
- 副作用节点禁止自动 replay；
- 用户取消；
- 总时间或模型预算耗尽。

终止后：

- 生成模式保存 Draft 或保留不可提交 session；
- AI 调试保留 working copy 与 pending proposal；
- UI 显示具体原因和可执行下一步。

---

## 14. Logging、Explainability 与 Metrics

```ts
interface RepairRoundLog {
  sessionId: string
  round: number
  entry: "GENERATION" | "DEBUG"
  failedNodeId?: string
  rootCauseNodeIds: string[]
  failureType?: VerificationFailureType
  transientRetries: number
  patchSetId?: string
  patchedNodeIds: string[]
  replayFromNodeId?: string
  usedCheckpoint: boolean
  usedAiTakeover: boolean
  goalAchieved?: boolean
  result: "VERIFIED" | "FAILED" | "DRAFT" | "CANCELLED"
  durationMs: number
}
```

日志必须能回答：

1. 哪里失败？
2. 为什么它只是症状或就是根因？
3. 哪条数据依赖证明了根因？
4. AI 建议改什么？
5. Patch Engine 接受或拒绝了什么？
6. 从哪里 replay，为什么安全？
7. 是否关闭 AI takeover 独立验证？
8. goal 是否达成？
9. 为什么最终 commit、保留 Draft 或停止？

不得记录敏感变量原文、完整 cookie、token 或 CAPTCHA 值。

---

## 15. 分阶段实施计划

### Phase 0：仓库勘察与基线

目标：在改代码前固定真实入口、现有成功率和测试基线。

步骤：

1. 阅读 `AGENTS.md` 和以下设计文档：
   - `specs/2026-09-18-operator-direct-category-dispatch-design.md`
   - `specs/2026-09-18-script-last-resort-design.md`
   - `specs/2026-09-17-dynamic-data-design.md`
   - `docs/ai-debug-success-rate-plan.md`
2. 确认第 3 节列出的真实入口仍然有效；
3. 记录现有 `workflows.debug` 请求/响应和 pending 数据结构；
4. 跑基线测试并记录统计：
   - `tests/debug-session.spec.ts`
   - `tests/debug-rewrite.spec.ts`
   - `tests/auto-debug-patch.spec.ts`
   - `tests/dynamic-data-flow.spec.ts`
   - `tests/workflow-integrity.spec.ts`
   - `tests/engine-checkpoints.spec.ts`
   - `tests/bench/debug-bench.spec.ts`
5. 不在此阶段修改 UI。

验收：

- [ ] 产出当前流程图和文件映射；
- [ ] 记录现有通过测试数和 benchmark；
- [ ] 明确 Generation 与 Debug 的重复逻辑；
- [ ] 明确所有会影响兼容性的消息和存储类型。

### Phase 1：统一 ExecutionTrace

目标：不改变执行语义，只把证据聚合成统一 trace。

步骤：

1. 新建 `src/lib/workflow/execution-trace.ts`；
2. 在 `run-workflow.ts` 聚合 `onStep`、`onCheckpoint`、`onSnapshot`；
3. 为每次 node attempt 记录输入变量引用与执行后变量差异；
4. 给 `ExecuteWorkflowResult` 增加可选 `trace`；
5. 保持现有 `steps`、checkpoints、running tasks 不变；
6. 增加 redaction；
7. 对 snapshot 失败显式记录不可用状态。

验收：

- [ ] 线性工作流每个节点都有一条 `NodeExecutionTrace`；
- [ ] retry 产生多个 attempt，不覆盖前一次；
- [ ] failedNodeId 与最后失败节点一致；
- [ ] trace 不依赖截断日志；
- [ ] 敏感变量没有原文；
- [ ] 旧调用方不传/不读 trace 时行为不变。

### Phase 2：Data Flow 与 Variable Provenance

目标：建立确定性 producer / transform / consumer 图。

步骤：

1. 复用 `interpolate.ts` token 规则；
2. 复用 `integrity.ts` producer / input 发现；
3. 建立静态 DataFlowGraph；
4. 使用 trace 补充“实际最后 producer”；
5. 显式标记 engine aliases 和 loop context；
6. 增加 transform 追踪；
7. 检测 dangling、cycle、多 producer 歧义；
8. 提供从 failed node 反向追踪变量链的纯函数。

验收：

- [ ] `Node3 → captcha → Node5` 可反向追踪；
- [ ] `Node3 → rawCaptcha → Node6 → captcha → Node8` 可反向追踪；
- [ ] trigger input 不被误判为悬空；
- [ ] engine alias 不被误判为悬空；
- [ ] 多 producer 能使用实际执行顺序消歧；
- [ ] cycle 在有限步内终止并报告。

### Phase 3：共享 Failure Analyzer

目标：从 trace 和 dataflow 产生唯一 `FailureAnalysis`。

步骤：

1. 将现有错误文本映射为统一 `VerificationFailureType`；
2. 先分类 transient failure；
3. 实现 failed node 自身检查；
4. 实现变量逆向追踪；
5. 实现 transform 停止条件；
6. 支持多个独立根因；
7. 输出 confidence、evidence、replay 起点；
8. 提供 canonicalize，保证两入口比较稳定；
9. 将当前重复失败签名改成节点与根因感知的签名。

验收：

- [ ] Test A-D 的根因完全正确；
- [ ] Generation 与 Debug 对相同 trace 输出一致；
- [ ] 页面暂未加载先 retry，不错误 patch selector；
- [ ] 低 confidence 不自动 patch；
- [ ] CAPTCHA / 2FA 返回 `NO_SAFE_REPAIR`。

### Phase 4：Patch Engine

目标：把 AI 输出限制为可验证的最小 patch。

步骤：

1. 定义 `WorkflowPatchSet` schema；
2. 从 `FailureAnalysis` 计算 `allowedNodeIds`；
3. 根据 block 定义计算 `allowedParamPaths`；
4. 为 `before` 实施乐观锁校验；
5. apply 到 clone；
6. 运行 integrity、run validation、dynamic data 和 diff 校验；
7. 封装现有 `patchNodeParams`，禁止调用方绕过 Patch Engine；
8. 对现有 pending 记录增加 schema version；
9. apply 前再次校验 pending；
10. 整图 rewrite 走单独高风险策略。

验收：

- [ ] patch 只能修改允许节点与路径；
- [ ] `blockId` / `disableBlock` / Goal 默认不可改；
- [ ] 不允许通过 `onError=continue` 伪造成功；
- [ ] 无关节点深比较完全不变；
- [ ] 陈旧 patch 被拒绝；
- [ ] 非法 pending 在 apply 前被拒绝；
- [ ] 多根因 patch 原子应用。

### Phase 5：Replay 与 Verification Runner

目标：共享 checkpoint replay、full replay 和独立验证。

步骤：

1. 复用 `checkpoints.ts` 和 checkpoint-store；
2. 根据根因计算最近安全 checkpoint；
3. 加入 ReplaySafety；
4. 检查 page/tab/frame/变量快照可恢复性；
5. checkpoint 不安全时选择 full replay 或用户确认；
6. replay 后关闭 AI takeover；
7. 运行 postcondition、goal 和结构校验；
8. 输出统一 VerificationResult。

验收：

- [ ] 修 Node3 后从 Node2 或更早安全点开始；
- [ ] 下游变量被重新生成；
- [ ] checkpoint 不可恢复时不伪造成功；
- [ ] 非幂等副作用阻止自动 full replay；
- [ ] AI takeover 做完但独立验证失败时 `verified=false`；
- [ ] goal 未达成时 `verified=false`。

### Phase 6：接入 AI Debug

目标：保留现有 UI 和 pending 机制，替换核心诊断/修复逻辑。

步骤：

1. 保留 `workflows.debug` 兼容入口；
2. 增加 analyze / suggest / autoRepair mode；
3. `runDebugSession` 改为调用共享 `WorkflowRepairEngine`；
4. 原有 takeover 作为执行辅助或最后兜底，不再作为根因分析器；
5. `patchNodeParams` 只能由 Patch Engine 内部调用；
6. pending 保存 `FailureAnalysis`、patch、verification、base version；
7. apply 前复验；
8. 保留 legacy result 字段一段迁移期，UI 逐步读取新结构。

验收：

- [ ] AI 分析不修改 Workflow；
- [ ] AI 建议修复产生可预览 patch；
- [ ] AI 自动修复仍不直接覆盖正式 Workflow；
- [ ] failed node 与 root cause node 都能展示；
- [ ] replay 和 verification 状态可见；
- [ ] 旧 pending 数据可读取或安全忽略；
- [ ] 现有 debug-session 测试全部通过或有明确迁移替代。

### Phase 7：接入 Generation Agent

目标：让生成完成后的 working copy 进入同一 repair loop。

步骤：

1. 在草稿形成后创建 `WorkflowRepairSession`；
2. 复用统一 verify / diagnose / propose / apply / replay；
3. 首次验证不允许 AI takeover；
4. 非结构失败预算耗尽时保存 Draft；
5. 结构错误保留 session 并阻止正式提交；
6. 继续使用 `resolveWorkflowForSave` 作为保存来源决策点；
7. 继续使用 `workflows.save` 的 hardening 与默认等待；
8. 避免重复运行相同节点导致副作用。

验收：

- [ ] 生成模式能定位上游根因；
- [ ] 生成模式与 Debug 对同一 trace 的分析一致；
- [ ] repair 成功后保存 VERIFIED；
- [ ] repair 失败后保存 DRAFT；
- [ ] 已生成节点不会因单个运行时失败消失；
- [ ] 保存卡片仍先出现，probe 仍异步；
- [ ] 动态数据规则保持有效。

### Phase 8：UI 与消息协议

目标：把统一诊断、patch 和验证状态呈现给用户。

步骤：

1. 扩展 `src/lib/messages.ts`，增加版本化 result；
2. 在 `WorkflowsTab.tsx` 增加“AI 分析 / AI 自动修复”；
3. 保存后自动验证入口复用同一会话 UI，不再静默长时间运行；
4. 展示症状节点、根因节点、数据链、patch diff、replay 和 verification；
5. 新增双语文案；
6. 保持 pending 恢复、应用、拒绝功能；
7. 提供“恢复原版本”。

验收：

- [ ] 三种操作语义清晰；
- [ ] 用户能区分 AI 临时接管和工作流独立验证；
- [ ] UI 不把 Node5 失败误写成“正在修复 Node5”；
- [ ] 多根因和多 patch 可读；
- [ ] 所有新增文案中英完整；
- [ ] 亮色/暗色主题可读。

### Phase 9：迁移、遥测与清理

步骤：

1. 增加 feature flag，先让 Debug 使用共享 Analyzer，再让 Generation 接入；
2. 双写旧统计与新 repair metrics 一个版本周期；
3. 对比旧 debug session 与新 engine 的离线测试结果；
4. 迁移稳定后删除重复根因 prompt 和直接 patch 路径；
5. 保留 compatibility adapter，直到旧 pending 过期；
6. 更新开发文档和故障排查指南。

验收：

- [ ] 不存在两套可被业务直接调用的 repair 实现；
- [ ] 搜索 `patchNodeParams`，除 Patch Engine 和测试外无直接调用；
- [ ] 搜索 root-cause prompt，只保留统一入口；
- [ ] 指标能按 generation/debug、首次/修复后、patch/rewrite 分组；
- [ ] feature flag 可安全回退。

---

## 16. 必须增加的测试

### 16.1 根因诊断测试

#### Test A：失败节点自身 selector 错误

```text
Node5 failure
Node5 selector 错误
→ rootCauseNodeIds=[Node5]
→ patch Node5
```

#### Test B：直接上游变量为空

```text
Node3 produces captcha=""
Node5 consumes captcha
Node5 failure
→ rootCauseNodeIds=[Node3]
→ patch Node3
→ replay
→ success
```

#### Test C：转换节点错误

```text
Node3 produces rawCaptcha="123456"
Node6 transforms rawCaptcha → captcha=undefined
Node8 consumes captcha
→ rootCauseNodeIds=[Node6]
```

#### Test D：两个上游变量异常

```text
Node3 produces username=""
Node4 produces password=""
Node5 consumes username + password
→ rootCauseNodeIds=[Node3, Node4]
```

#### Test E：变量名引用错误

```text
Node3 produces captcha="123456"
Node5 consumes {{captch}}
→ rootCauseNodeIds=[Node5]
```

#### Test F：循环依赖

```text
A produces x from y
B produces y from x
→ finite termination
→ cycle evidence
→ no auto patch
```

### 16.2 Patch 安全测试

#### Test G：无关节点不变

```text
patch Node3
→ Node1/2/4/5 深比较不变
→ 只有显式授权的边或引用可同步变化
```

#### Test H：越权 patch

```text
rootCause=[Node3]
AI patch Node1
→ Patch Engine rejects
```

#### Test I：伪造成功

```text
AI proposes onError=continue / remove postcondition
→ rejects
```

#### Test J：陈旧 patch

```text
base Workflow 已更新
before 不匹配
→ rejects
→ requires re-diagnosis
```

#### Test K：多根因原子性

```text
PatchSet 包含 Node3 + Node4
Node4 patch 非法
→ 整个 PatchSet 不应用
```

### 16.3 Replay 测试

#### Test L：从最近 checkpoint 重放

```text
Node1 ok
Node2 ok checkpoint
Node3 patched
Node4 downstream
Node5 symptom
→ replay Node3→Node5
```

#### Test M：checkpoint 无效

```text
page state 不可恢复
→ fallback full replay 或要求确认
→ 不标记 checkpoint replay success
```

#### Test N：非幂等副作用

```text
路径包含 send-message / submit-order
→ auto full replay blocked
```

#### Test O：AI takeover 不算验证

```text
takeover 完成任务
独立 replay 失败
→ verified=false
```

### 16.4 Session 与保存测试

#### Test P：Debug 修复失败

```text
→ 正式 Workflow 不变
→ Debug Working Copy 保留
→ 可继续调试或恢复原版本
```

#### Test Q：Generation repair 预算耗尽

```text
→ 保存 DRAFT
→ 保留最后 analysis / patch history
```

#### Test R：结构错误

```text
broken graph
→ block formal commit
→ session 可恢复
```

#### Test S：selector probe 不可用

```text
→ 保持原 locator
→ warning
→ 不因 probe 单独阻止 Draft
```

#### Test T：并发 pending

```text
旧 session patch 应用到新 workflow
→ version conflict
→ rejects
```

### 16.5 入口一致性测试

#### Test U：同一 trace 同一分析

```text
Generation Agent → diagnose(workflow, trace)
Debug Agent      → diagnose(workflow, trace)
→ canonical FailureAnalysis 完全相同
```

#### Test V：同一 patch policy

```text
Generation 与 Debug 对相同 analysis + patch
→ validatePatch 结果相同
```

### 16.6 兼容性测试

- 历史 Workflow 没有新 evidence 字段仍能加载和运行；
- 旧 `workflows.debug` 响应仍能被迁移期 UI 处理；
- 旧 pending 记录可安全读取、迁移或丢弃，不得错误 apply；
- 手工创建、录制、导入流程不受影响；
- workflow 模式算子分类、动态数据门禁、保存卡片行为不回退；
- 服务端执行若暂不支持完整 trace，必须显式标记 capability，不得伪造字段。

---

## 17. 完整验收清单

### 17.1 架构验收

- [ ] 只有一个 `WorkflowRepairEngine`；
- [ ] Generation Agent 与 Debug Agent 都调用同一 `diagnose / propose / validatePatch / apply / replay / verify`；
- [ ] Failure Analyzer 不依赖入口 mode 改变根因；
- [ ] 变量 token 解析复用现有规则；
- [ ] Patch Engine 是所有 AI patch 的唯一写入口；
- [ ] 整图 rewrite 仅是受约束兜底；
- [ ] 正式保存前统一运行结构校验。

### 17.2 诊断验收

- [ ] UI 和日志同时区分 failed node 与 root cause node；
- [ ] 支持直接上游变量根因；
- [ ] 支持多级 transform 根因；
- [ ] 支持多个根因；
- [ ] 支持变量名拼写错误归因到 consumer；
- [ ] 支持循环检测；
- [ ] 支持 transient failure 先 retry；
- [ ] 低置信度不自动 patch；
- [ ] CAPTCHA / 2FA / auth 不自动绕过。

### 17.3 Patch 验收

- [ ] Patch 可预览；
- [ ] Patch 带 before / after / reason / evidence；
- [ ] Patch 范围受 root cause 和 dependency 限制；
- [ ] 无关节点保持不变；
- [ ] 多根因 patch 原子应用；
- [ ] 陈旧 patch 被拒绝；
- [ ] patch 后 graph、schema、dynamic data 均合法；
- [ ] 禁止通过忽略错误或删除 goal 伪造成功。

### 17.4 Replay 与 Verification 验收

- [ ] 修上游后从根因之前的安全 checkpoint 重放；
- [ ] 下游变量重新计算；
- [ ] checkpoint 不安全时正确 fallback；
- [ ] 非幂等副作用有保护；
- [ ] AI takeover 后必须独立验证；
- [ ] goal 未达成不能 verified；
- [ ] replay、verify 和最终结果在 UI 可见。

### 17.5 保存与恢复验收

- [ ] Generation 成功保存 VERIFIED；
- [ ] Generation 预算耗尽保存 DRAFT；
- [ ] Debug 分析不改正式 Workflow；
- [ ] Debug patch 先进入 working copy / pending；
- [ ] Debug replay 失败不覆盖正式 Workflow；
- [ ] 用户可应用、拒绝、继续调试、恢复原版本；
- [ ] pending apply 前重验；
- [ ] 并发修改有版本冲突保护；
- [ ] 结构错误阻止正式提交但不丢 session；
- [ ] selector probe 失败不被误判成不可保存。

### 17.6 UI 与国际化验收

- [ ] 提供“AI 分析”“AI 自动修复”；
- [ ] 展示 Failed Node、Root Cause Node、Variable Dependency、Patch、Replay、Verification；
- [ ] 多根因可读；
- [ ] AI 临时接管和独立验证文案不同；
- [ ] 所有新文案同时提供英文和简体中文；
- [ ] 使用 Tailwind 语义 token；
- [ ] 亮色、暗色主题都可读；
- [ ] 不依赖颜色单独表达状态。

### 17.7 测试与质量验收

必须执行仓库约定的完整验证：

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.tests.json
npx eslint src tests
npx prettier --check <本次改动文件>
npx vitest run
```

如果修改注入函数，必须额外执行：

```bash
pnpm verify:injected
```

如果修改 UI、manifest 或构建配置，必须额外构建。构建前按项目约定先移走既有产物目录，避免 `emptyDir` 触发批量删除护栏；两个变体分开执行。

如果保留 benchmark，必须执行并记录改造前后结果：

```bash
pnpm bench:debug
```

验收要求：

- [ ] 两个 TypeScript 配置均通过；
- [ ] ESLint 只检查 `src tests`；
- [ ] 全量 Vitest 通过；
- [ ] 新增核心测试全部通过；
- [ ] 不通过提高 timeout 掩盖动态 import 或性能问题；
- [ ] 无新增单语 UI 文案；
- [ ] 无硬编码 UI 颜色；
- [ ] 无执行器只 emit error 而不 throw 的回归；
- [ ] `tests/operator-param-coverage.spec.ts` 通过；
- [ ] 需要时 `verify:injected` 通过。

---

## 18. Definition of Done

只有同时满足以下条件，任务才算完成。

### 18.1 核心链路

```text
Generation:
generate / operator record
→ verify
→ build ExecutionTrace
→ diagnose
→ root cause
→ propose minimal patch
→ validate patch
→ apply to working copy
→ replay
→ verify without AI takeover
→ commit VERIFIED or preserve DRAFT
```

```text
AI Debug:
execute
→ build ExecutionTrace
→ diagnose
→ show symptom + root cause
→ propose previewable patch
→ validate patch
→ apply to debug working copy
→ replay
→ verify without AI takeover
→ user confirms commit
```

### 18.2 必须证明的两个关键场景

场景一：失败节点就是根因。

```text
Node5 selector 错误
→ failedNode=Node5
→ rootCause=[Node5]
→ patch Node5
→ replay
→ verified
```

场景二：失败节点只是症状。

```text
Node3 produces captcha=""
Node5 consumes captcha and fails
→ failedNode=Node5
→ rootCause=[Node3]
→ patch Node3
→ replay from Node2 checkpoint
→ regenerate captcha
→ Node5 success
→ verified
```

### 18.3 统一性证明

对于场景二，同一 workflow + trace：

```text
Generation Agent FailureAnalysis
===
Debug Agent FailureAnalysis
```

并且：

- patch policy 相同；
- replay 起点相同；
- verification 语义相同；
- 唯一差异是生成模式可自动提交 VERIFIED / DRAFT，而 Debug 模式正式覆盖前需要用户确认。

### 18.4 用户最终体验

用户不应再遇到：

```text
AI 生成了大部分工作流
→ 一个下游节点失败
→ 整个工作流消失或无法保存
```

也不应再看到：

```text
Node5 报错
→ AI 未分析数据依赖就修改 Node5
→ 看似修复，实际根因仍在 Node3
```

用户应得到：

```text
生成 / 执行
→ 失败证据可见
→ 症状与根因分离
→ 数据链路可解释
→ 最小补丁可预览
→ 安全重放
→ 独立验证
→ 成功提交，或保留可继续处理的 Draft / Working Copy
```

---

## 19. 实施优先级

```text
P0
├── ExecutionTrace
├── Data Flow / Variable Provenance
├── Shared Failure Analyzer
├── WorkflowPatchSet + Patch Engine
├── Debug 接入统一 Repair Engine
├── Generation 接入统一 Repair Engine
└── 入口一致性测试

P1
├── Checkpoint Replay Safety
├── Debug Working Copy 版本冲突保护
├── 多根因原子 patch
├── UI 诊断卡片与 patch diff
└── Repair metrics

P2
├── Variable Contract 扩展
├── 低置信度人工确认
├── Rewrite 风险分级
└── 离线失败样本回归集

P3
├── Data Flow 性能优化
├── 跨子工作流 trace
├── 服务端 trace 对齐
└── 基于生产遥测的 repair policy 调优
```

**实施顺序硬约束：**

> 先统一证据和根因分析，再统一 Patch Engine 和 Replay，最后接 UI。禁止先堆新的 AI prompt 或新增“生成专用 repair”“调试专用 repair”文件来继续扩大双轨逻辑。
