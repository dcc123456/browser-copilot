# Browser Copilot Workflow AI 可执行改造计划

> 目标：在不破坏现有 Workflow、执行引擎和用户工作方式的前提下，提高 **Workflow 生成成功率**、**Workflow 首次执行成功率**、**目标达成率**、**AI Debug 修复成功率** 与 **长期重复运行稳定性**。
>
> 本文不是概念设计，而是交给 AI Coding Agent 执行的工程计划。Agent 必须按 Task 顺序推进；每个 Task 具有明确的输入、修改范围、测试、验收标准和 Commit 边界。

---

## 0. 文档依据与重要结论

### 0.1 输入资料

本计划基于以下两部分材料：

1. `browser-copilot-workflow-ai-improvement-spec.md`
2. `dcc123456/browser-copilot` 的 `develop` 分支代码

原始规范定义的核心目标是提升：

- Workflow 首次生成成功率
- Workflow 首次直接执行成功率
- AI Debug 修复成功率
- Workflow 可复用性

并提出 Intent → Planner → Grounding → Validator → Patch Debug → Replay → Reliability 的总体方向。

### 0.2 对 develop 分支的反向审查结论

本仓库 `develop` **已经实现了相当一部分原规范中的 Reliability 基础设施**，不能再按照“从零开始”的 8 个 Phase 重做。

已经确认存在：

- `WorkflowSettings.reliabilityMode`
- `WorkflowSettings.goalSpec`
- `WorkflowSettings.provenance`
- `WorkflowSettings.generationOriginUrl`
- `WorkflowSettings.saveWarnings`
- `node.data.__reliability`
- Semantic Locator / Element Fingerprint
- Readiness Contract / Readiness Runtime
- Goal Spec / Terminal State
- Generated Workflow 六层静态验证
- L1/L2/L3 Reliability Metrics
- Reliability Certification 状态机
- Reliability Benchmark R01-R10
- Offline AI Debug Benchmark

因此本计划采用：

> **“增量增强 + 接管现有基础设施”，而不是重新设计一套平行 Workflow 系统。**

### 0.3 最重要的架构调整

原规范存在一个需要优化的地方：它把主要链路写成：

```text
User
  ↓
Intent
  ↓
Planner
  ↓
Grounding
  ↓
Compiler
  ↓
Workflow
```

但 Browser Copilot 当前真实产品能力已经支持：

```text
User Request
   ↓
AI 在真实浏览器中执行任务
   ↓
Action History / Trace
   ↓
Save as Workflow
```

并且代码中的 `WorkflowSettings.provenance` 已明确区分：

- `chat-generate`：operator draft
- `chat-history`：compiled action history

因此：

> **不要为了实现 Planner 而废弃“先执行、后生成 Workflow”的产品路径。**

本计划将它定义为第一优先级主路径：

```text
用户需求
  ↓
任务理解（非阻塞）
  ↓
AI 首次执行
  ↓
结构化 Action Trace
  ↓
Trace Normalizer
  ↓
Workflow IR
  ↓
Grounding / Stability / Dataflow 校验
  ↓
Workflow Compiler
  ↓
Generated Workflow
  ↓
Replay Verification
  ↓
Publish / Reuse
```

Planner 不应该成为正常执行前的硬门槛，而应该成为：

- Trace 的解释层
- 复杂任务的结构化规划层
- Debug 的诊断上下文
- Workflow 的长期维护元数据

这样既符合当前产品行为，也避免为了架构“漂亮”而改变已有用户路径。

---

# 1. 工程目标

## 1.1 最终目标

最终系统应将 Workflow 看成一个：

> **有目标、有前置条件、有动作、有定位、有状态、有副作用保护、有验证证据的可执行程序。**

而不是简单的：

```text
Click A
Fill B
Click C
Wait 2s
```

## 1.2 核心指标

必须同时观测以下指标：

| 指标 | 定义 |
|---|---|
| Generation Parse Rate | 原始 Trace 是否成功转换为合法 Workflow IR |
| Generation Compile Rate | Workflow IR 是否成功编译为合法 Workflow |
| First Run Success | 生成后第一次执行是否完成 |
| First Run Goal Success | 第一次执行后业务目标是否真正达成 |
| Verification Success | 是否存在可机器验证的成功证据 |
| Debug Recovery Rate | 无人工介入情况下是否修复并验证成功 |
| Repair Precision | 修复是否只修改故障相关节点 |
| Replay Stability | 重复运行成功率 |
| Unsafe Duplicate Rate | submit/create/send/pay/delete 等副作用是否被重复执行 |
| Human Takeover Rate | 需要人工接管的比例 |
| Avg Repair Rounds | 一次失败平均需要多少修复轮次 |
| Avg LLM Calls | 一个 Workflow 生成/修复平均调用模型次数 |
| Generation Latency | 生成 Workflow 所需时间 |

### 重要要求

不能直接把“成功率 +30% / +40%”当成验收标准而不建立 Baseline。

必须先测量：

```text
Baseline
   ↓
代码改造
   ↓
Same Benchmark
   ↓
Δ Improvement
```

所有目标指标都要同时记录：

- absolute value
- relative uplift
- sample size
- scenario distribution

---

# 2. 当前 develop 已有能力清单

## 2.1 Workflow Model

`src/lib/workflow/types.ts` 已存在：

- Workflow metadata
- Workflow parameters
- provenance
- generationOriginUrl
- reliabilityMode
- goalSpec
- saveWarnings
- workflow plan

其中 `plan` 已用于记录“这个工作流做什么、按什么顺序做”，用于 AI Debug 的复演/审计上下文。

## 2.2 Reliability Contract

`src/lib/workflow/reliability.ts` 已存在：

- `WorkflowReliabilityMode`
- `WorkflowGoalSpec`
- `NodeReliabilitySpec`
- `NodeLocatorSpec`
- `IdempotencyLevel`
- ambiguity policy
- unsafe action classification

其中 generated-strict 默认用于 AI 生成 Workflow。

## 2.3 Semantic Locator

`src/lib/workflow/element-fingerprint.ts` 已存在：

- role
- accessibleName
- text
- label
- placeholder
- testId
- stableAttributes
- relation
- ElementFingerprint
- unstable token detection

因此不应该再另造一套 `GroundingTarget` 类型，而应该以现有 Semantic Locator 为基础扩展。

## 2.4 Readiness

`src/lib/workflow/readiness.ts` 与 `src/background/workflow-engine/readiness-engine.ts` 已存在。

支持：

- present
- visible
- enabled
- stable
- navigation-settled
- value-committed
- data-ready

并采用 polling + fresh observation，而不是固定 sleep。

## 2.5 Deterministic Goal Verification

`src/lib/workflow/conditions.ts`

`src/background/workflow-engine/condition-runtime.ts`

已经提供条件词汇和运行时验证能力。

目标是继续强化 deterministic verification，禁止把“模型说成功”当作成功证据。

## 2.6 Generated Validation

`src/lib/workflow/generated-validation.ts` 已存在六层检查：

1. Graph
2. Data Flow
3. Locator
4. Readiness
5. Side Effect
6. Goal

这是后续改造的核心入口，不应该另写第二套 Validator。

## 2.7 Reliability Certification

`src/lib/workflow/reliability-certification.ts` 已存在：

```text
Draft
 ↓
Validated
 ↓
Verified
 ↓
Certified
```

发生 graph change 或 benchmark regression 后进入 `Stale`。

这一点应继续保留，并成为“Workflow 是否允许进入长期自动运行”的依据。

## 2.8 Benchmark

已有：

- `tests/reliability-benchmark.spec.ts`
- `tests/bench/debug-bench.spec.ts`
- `specs/reliability-fixtures/scenarios.ts`
- `scripts/bench-workflow-reliability.mjs`
- `scripts/bench-debug.mjs`

因此后续任何影响 reliability 的改动都必须先扩展 benchmark，再实现代码。

---

# 3. 当前代码中必须优先修复的问题

以下不是“可选优化”，而是本次计划中的 P0/P1 问题。

## 3.1 Data Flow Validator 不是控制流感知的

当前 `generated-validation.ts` 的实现会先遍历全部节点，将所有潜在 writer 收集到一个 `written` Set，然后再检查全部变量引用。

这意味着：

```text
Node A: use {{customer}}
Node B: set customer
```

只要 `Node B` 存在于 graph 中，就可能被认为变量“已写入”。

但真正正确的判断应该是：

> 在 Node A 的所有可能执行路径上，`customer` 是否已经被定义？

需要升级成：

- 顺序可达检查
- CFG / graph dataflow
- branch-aware definite assignment
- loop-aware initialization
- trigger input 作为初始定义

不能只按 `nodes[]` 数组顺序判断。

---

## 3.2 Locator Validator 主要是静态规则，不等于真正 Grounding

当前 Validator 会检查：

- selector 是否存在
- positional selector
- random-looking selector

但生成时仍然必须回答一个更关键的问题：

> **当前 selector 和当前真实元素语义是否匹配？**

所以必须增加：

```text
selector
   +
semantic locator
   +
live page probe
   +
unique match
   +
actionability
```

五层证据。

---

## 3.3 Goal Derivation 需要从“所有 postconditions”升级为“最终目标契约”

当前 `goal.ts` 支持从节点 postconditions 派生 goal，这是正确方向。

但不能简单把所有节点 postconditions 全部并入最终目标。

例如：

```text
填充邮箱
 ↓
postcondition: email = xxx
 ↓
点击提交
 ↓
postcondition: success toast exists
```

如果 `email = xxx` 只是中间态，而最终页面已经离开该页面，那么将其视作整个 Workflow 的终态条件就可能产生错误。

需要明确：

- intermediate assertion
- step postcondition
- terminal goal evidence

三者不是同一个概念。

---

## 3.4 Reliability Score 不能只做“静态加权平均”

后续 Reliability Score 必须从：

```text
locator 0.9
planning 0.8
risk 0.7
=> score 0.86
```

升级成：

```text
Reliability
 = evidence-backed decision
```

评分必须保存：

- 分值
- 证据
- 影响因子
- fail-open / fail-closed 决策
- 推荐动作

尤其对 unsafe action：

> 不允许因为平均分高，就绕过 terminal-state / goal verification。

---

## 3.5 AI Debug 必须进一步收敛到“局部修复”

现有 offline benchmark 已经有 replay / audit / rewrite-verify 等能力，因此下一阶段不是重新做 Debug，而是将：

```text
AI 重写 Graph
```

进一步收敛为：

```text
Failure
 ↓
Deterministic Classification
 ↓
Deterministic Repair Candidate
 ↓
Minimal Patch
 ↓
Replay
 ↓
Goal Verify
 ↓
Patch Commit
```

AI 只在无法由确定性规则处理时参与。

---

# 4. 最终架构

```text
                         ┌────────────────────┐
                         │    User Request     │
                         └─────────┬──────────┘
                                   │
                     ┌─────────────▼─────────────┐
                     │ Task Understanding Layer  │
                     │ intent / constraints     │
                     └─────────────┬─────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ Existing Chat Agent Runtime │
                    │ first execute in real page │
                    └──────────────┬──────────────┘
                                   │
                         Action Trace / History
                                   │
                    ┌──────────────▼──────────────┐
                    │     Trace Normalizer        │
                    │ remove retries/exploration  │
                    │ normalize actions/states    │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │        Workflow IR          │
                    │ intent + dataflow + target │
                    │ pre/post + side effects    │
                    └──────────────┬──────────────┘
                                   │
               ┌───────────────────┼────────────────────┐
               │                   │                    │
      ┌────────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐
      │   Grounding     │  │   Validator    │  │   Risk Engine  │
      │ semantic target │  │ graph/dataflow │  │ idempotency     │
      │ live probe      │  │ goal/readiness │  │ terminal state  │
      └────────┬────────┘  └───────┬────────┘  └───────┬────────┘
               └───────────────────┼────────────────────┘
                                   │
                         ┌─────────▼─────────┐
                         │ Workflow Compiler │
                         └─────────┬─────────┘
                                   │
                            Generated-Strict
                              Workflow
                                   │
                         ┌─────────▼─────────┐
                         │ Preflight Verify  │
                         └─────────┬─────────┘
                                   │
                              First Replay
                                   │
                         ┌─────────▼─────────┐
                         │ Goal Verification │
                         └─────────┬─────────┘
                                   │
                       ┌───────────▼───────────┐
                       │ Certification State   │
                       │ Draft/Validated/...   │
                       └───────────┬───────────┘
                                   │
                              Reusable Run
                                   │
                            Failure / Drift
                                   │
                   ┌───────────────▼────────────────┐
                   │ Failure Classifier + Ledger    │
                   └───────────────┬────────────────┘
                                   │
             ┌─────────────────────┼──────────────────────┐
             │                     │                      │
   ┌─────────▼─────────┐  ┌────────▼────────┐   ┌────────▼────────┐
   │ Deterministic     │  │ Minimal AI Patch│   │ Human Escalation│
   │ Repair Library    │  │ only when needed│   │ when ambiguous  │
   └─────────┬─────────┘  └────────┬────────┘   └─────────────────┘
             └─────────────────────┼──────────────────────┘
                                   │
                              Replay Again
                                   │
                           Verified Improvement
```

---

# 5. AI Coding Agent 总执行规则

在执行任何 Task 前，Agent 必须：

1. 读取 `AGENTS.md`。
2. 读取本计划对应 Task。
3. 使用 `rg` / IDE search 定位真实实现，不允许按本文猜测文件一定存在。
4. 先写/补测试，再改实现，除非 Task 明确是纯重构。
5. 单 Task 单 Commit。
6. 每个 Commit 前至少执行：
   - `pnpm typecheck`
   - `pnpm test`
7. 涉及 UI / manifest / build 时额外运行：
   - `pnpm build`
8. 新增 UI 文案必须同步 `en` / `zh-CN`。
9. Commit message 必须英文并符合 Conventional Commits。
10. 不得修改 `compat` 行为，除非 Task 明确允许。
11. `generated-strict` 是所有新生成 Workflow 的目标运行模式。
12. 不允许以“模型判断成功”替代 deterministic verification。
13. unsafe action 永远优先 terminal-state / postcondition protection，而不是 retry。
14. 修复失败时优先 deterministic repair，再考虑 LLM。
15. 每次 graph mutation 后必须让 certification 进入 `Stale` 或重新验证，禁止保留过期 Verified/Certified 状态。

---

# 6. 分阶段实施路线

## Phase P0：建立 Baseline 和代码地图

### 目标

在改代码前得到：

- 真实 Workflow 生成链路
- 真实执行链路
- 真实 Debug 链路
- 当前基准数据
- 当前主要失败类型

### 任务

- T00.1 Repository Architecture Audit
- T00.2 Generation Path Trace
- T00.3 Execution Path Trace
- T00.4 Debug Path Trace
- T00.5 Benchmark Baseline
- T00.6 Failure Taxonomy

---

## Phase P1：Workflow IR + Capability Catalog

### 目标

建立确定性的中间表示，降低 LLM 直接生成 Workflow JSON 的错误率。

### 任务

- T01.1 Workflow IR
- T01.2 Block Capability Catalog
- T01.3 Variable Definition/Use Model
- T01.4 Side Effect Metadata
- T01.5 Trace-to-IR Adapter

---

## Phase P2：Action Trace → Workflow Compiler

### 目标

强化用户最常用的“先执行、后生成”路径。

### 任务

- T02.1 Trace Event Schema
- T02.2 Trace Normalizer
- T02.3 Exploration/Retry Filter
- T02.4 Semantic Intent Reconstruction
- T02.5 Workflow IR Compiler
- T02.6 Goal Evidence Extraction

---

## Phase P3：Grounding Engine 升级

### 目标

让 Workflow 生成时真正理解“这个按钮/输入框是谁”，而不是只保存当时 selector。

### 任务

- T03.1 Live Locator Probe
- T03.2 Semantic Locator Ranking
- T03.3 Actionability Verification
- T03.4 Ambiguity Handling
- T03.5 Locator Stability Test
- T03.6 Selector Memory

---

## Phase P4：Validator 升级

### 目标

把错误在保存前拦截掉。

### 任务

- T04.1 CFG-aware Dataflow
- T04.2 Branch/Loop Definite Assignment
- T04.3 Graph Structural Verification
- T04.4 Goal Contract Validation
- T04.5 Locator Evidence Validation
- T04.6 Side-effect Safety Validation
- T04.7 Preflight Report

---

## Phase P5：Execution Guard + Evidence Ledger

### 目标

即使 Workflow 失败，也不能产生“已经完成但不知道”的错误状态，更不能重复执行 unsafe action。

### 任务

- T05.1 Action Ledger
- T05.2 At-most-once Unsafe Guard
- T05.3 Terminal State Guard
- T05.4 Pre/Post Evidence Capture
- T05.5 Resume Safety
- T05.6 Result Verification

---

## Phase P6：AI Debug Minimal Patch

### 目标

把 Debug 从“修改整个 Workflow”升级成“局部补丁 + Replay + Goal Verify”。

### 任务

- T06.1 Failure Taxonomy Runtime
- T06.2 Deterministic Repair Library
- T06.3 Workflow Patch Schema
- T06.4 Patch Scope Guard
- T06.5 AI Patch Generator
- T06.6 Replay Verification
- T06.7 Regression Detection

---

## Phase P7：Replay / Stability / Learning

### 目标

把“一次成功”升级成“可重复成功”。

### 任务

- T07.1 Replay Compiler
- T07.2 DOM Perturbation Fixtures
- T07.3 Multi-run Stability Benchmark
- T07.4 Selector Success Memory
- T07.5 Failure Memory
- T07.6 Workflow Version Diff

---

## Phase P8：Reliability Score + Certification Gate

### 目标

把可靠性真正接入产品流程，而不是只输出一个分数。

### 任务

- T08.1 Evidence-based Reliability Report
- T08.2 Certification Gate
- T08.3 Generated Workflow Save Gate
- T08.4 Scheduled Run Gate
- T08.5 Regression → Stale
- T08.6 Metrics Dashboard Data Model

---

## Phase P9：Benchmark + CI Quality Gate

### 目标

让 AI Workflow 可靠性改造拥有持续回归能力。

### 任务

- T09.1 Generation Benchmark
- T09.2 First-run Benchmark
- T09.3 Debug Benchmark Expansion
- T09.4 Stability Benchmark
- T09.5 Mutation Benchmark
- T09.6 CI Quality Gate

---

# 7. Task List

以下 Task 是实际执行顺序。除非 Task 明确标注可并行，否则必须按编号执行。

---

## T00.1 Repository Architecture Audit

### 目标

确认 develop 分支实际代码结构，建立生成、执行、Debug 三条链路的真实调用图。

### Agent 操作

```bash
rg -n "chat-generate|chat-history|save workflow|workflow.*generate|generate.*workflow" src tests specs
rg -n "executeWorkflow|workflow.*run|runWorkflow|workflow-engine" src tests
rg -n "debug|replay|rewrite|patch|takeover|audit" src tests
rg -n "goalSpec|__reliability|reliabilityMode|saveWarnings" src tests
```

### 输出

创建：

```text
docs/workflow-ai-architecture-audit.md
```

必须记录：

- 真实入口文件
- 真实生成入口
- 真实 Trace 数据结构
- 真实 Workflow 保存入口
- 真实执行入口
- 真实失败记录结构
- 真实 Debug 入口
- 已存在模块与本文计划的映射

### 验收

- 不得出现凭文件名猜测的模块
- 所有后续 Task 的目标代码入口都能追溯到 audit

### Commit

```text
docs(workflow): document ai workflow architecture
```

---

## T00.2 Generation Path Trace

### 目标

确认“先执行后生成”的真实链路，明确 action history 如何进入 Workflow。

### 输出

在 audit 文档中补充：

```text
user request
 → agent action
 → action history
 → save workflow
 → workflow JSON
```

### 验收

必须定位：

- action history schema
- action capture
- workflow save
- provenance stamping
- plan stamping

---

## T00.3 Execution Path Trace

### 目标

梳理从 `Workflow` 到真实 browser operator 的执行路径。

### 输出

记录：

- preflight
- selector resolve
- readiness
- action execute
- postcondition
- goal verify
- run result

### 验收

必须能够指出：

> “在哪一个函数之后可以注入 Action Ledger”。

---

## T00.4 Debug Path Trace

### 目标

确认当前 offline debug benchmark 背后的真实 Debug Session loop。

### 验收

必须明确：

```text
failure
 → classifier?
 → takeover?
 → replay?
 → audit?
 → rewrite?
 → verify?
```

并标记哪些环节已经存在、哪些仅在 benchmark 中存在。

---

## T00.5 Benchmark Baseline

### 目标

建立当前基线，不先改业务代码。

### 执行

```bash
pnpm typecheck
pnpm test
pnpm bench:debug
pnpm bench:reliability
```

并新增：

```text
tests/bench/baseline-report.spec.ts
```

### 输出

```json
{
  "commit": "...",
  "generation": {
    "parseRate": 0,
    "compileRate": 0
  },
  "execution": {
    "firstRunSuccess": 0,
    "goalSuccess": 0
  },
  "debug": {
    "verifiedRecoveryRate": 0
  },
  "stability": {
    "replaySuccessRate": 0
  }
}
```

如果真实 Generation Benchmark 尚不存在，先建立 fixture-driven baseline，不允许虚构生产数据。

### 验收

- 有固定 baseline artifact
- 同一 commit 重跑结果一致

---

## T00.6 Failure Taxonomy

### 目标

统一失败分类，为 Validator、Repair、Benchmark 共用。

### 类型

```ts
type WorkflowFailureKind =
  | 'intent'
  | 'planning'
  | 'graph'
  | 'dataflow'
  | 'locator-not-found'
  | 'locator-ambiguous'
  | 'locator-unstable'
  | 'readiness'
  | 'page-state'
  | 'wrong-origin'
  | 'navigation'
  | 'side-effect'
  | 'goal-verification'
  | 'runtime'
  | 'environment'
  | 'unknown'
```

### 要求

失败分类对象必须包含：

```ts
interface WorkflowFailure {
  kind: WorkflowFailureKind
  nodeId?: string
  runId?: string
  evidence: Record<string, unknown>
  retryable: boolean
  repairable: boolean
  unsafeToRetry: boolean
}
```

### 验收

所有后续 repair 必须接收这个统一对象。

### Commit

```text
feat(workflow): add unified failure taxonomy
```

---

# P1：Workflow IR

## T01.1 Workflow IR

### 目标

LLM / Trace 不直接生成最终 Workflow JSON。

### 新增

建议：

```text
src/lib/workflow/ir.ts
```

### 核心结构

```ts
interface WorkflowIR {
  version: number
  goal: GoalIR
  inputs: InputIR[]
  steps: WorkflowStepIR[]
  edges: StepEdgeIR[]
  metadata: WorkflowIRMetadata
}

interface WorkflowStepIR {
  id: string
  intent: string
  action: SemanticAction
  target?: SemanticTarget
  inputs?: ValueRef[]
  outputs?: ValueRef[]
  preconditions?: ConditionIR[]
  postconditions?: ConditionIR[]
  idempotency: 'safe' | 'conditional' | 'unsafe'
  sourceTraceIds: string[]
}
```

### 原则

IR 解决：

- 语义
- 数据流
- 控制流
- 目标
- 风险

Workflow JSON 负责：

- Block
- block params
- editor graph

### 验收

- 可以从 IR 编译 Workflow
- Workflow 不可反向污染 IR 语义模型
- import/export 不受影响

### Commit

```text
feat(workflow): add workflow intermediate representation
```

---

## T01.2 Block Capability Catalog

### 目标

不要让 LLM 自己记 56 个 Block。

### 新增

```text
src/lib/workflow/block-capabilities.ts
```

### 每个 Block 必须描述

```ts
interface BlockCapability {
  blockId: string
  actions: string[]
  inputVars: string[]
  outputVars: string[]
  sideEffect: 'none' | 'conditional' | 'unsafe'
  targetType: 'none' | 'element' | 'page' | 'variable'
  readiness?: ReadinessSpec
  defaultVerification?: ConditionIR[]
}
```

### 实现

从现有 `BLOCK_BY_ID` / palette 定义衍生，不重复维护一份人工列表。

### 验收

所有 Workflow Compiler 选择 Block 必须通过 catalog。

### Commit

```text
feat(workflow): add block capability catalog
```

---

## T01.3 Variable Definition/Use Model

### 目标

建立真正的变量 Def-Use 模型。

### 要求

每个 Step 明确：

```text
defs
uses
mutates
```

### 验收

后续 CFG validator 可直接消费 IR，而不是再次解析 Workflow JSON 字符串。

---

## T01.4 Side Effect Metadata

### 目标

将 unsafe action 从字符串关键词判断升级为结构化 metadata。

### 要求

保留现有 `idempotencyOf` 兼容路径，但新增优先级：

```text
explicit contract
  > block capability
  > action metadata
  > intent keyword fallback
```

### 验收

所有 submit/create/send/pay/delete 类型步骤都能被明确识别。

---

## T01.5 Trace-to-IR Adapter

### 目标

让当前 Action History 成为 Workflow IR 的第一来源。

### 要求

Adapter 不做 DOM guessing。

它只做：

```text
raw trace
 → normalized semantic action
```

Grounding 独立处理 element identity。

### Commit

```text
feat(workflow): compile action traces into workflow ir
```

---

# P2：Trace → Workflow

## T02.1 Trace Event Schema

### 目标

统一 Action Trace 数据。

### 最小字段

```ts
interface WorkflowTraceEvent {
  id: string
  timestamp: number
  type: string
  nodeAction: string
  page: {
    origin: string
    url: string
    urlPattern?: string
    domHash?: string
  }
  target?: {
    selector?: string
    semantic?: SemanticLocator
    fingerprint?: ElementFingerprint
  }
  input?: unknown
  output?: unknown
  result: 'success' | 'failed' | 'skipped' | 'retry'
  error?: string
  retryOf?: string
}
```

### 验收

支持从现有历史数据迁移。

---

## T02.2 Trace Normalizer

### 目标

把用户执行过程中的“过程噪声”与稳定 Workflow 分离。

### 删除

- failed attempts
- exploratory actions
- duplicate clicks
- transient waits
- retries

### 保留

- meaningful successful action
- navigation
- variable production
- result verification
- terminal evidence

### 额外规则

不能简单删除所有 retry：

如果 retry 包含成功后新增的信息，例如新 selector 或成功状态证据，必须保留它作为 evidence，而不是作为执行节点。

---

## T02.3 Exploration / Retry Filter

### 目标

显式识别探索行为。

### 规则

例如：

```text
click A failed
click B failed
click C success
```

Workflow 只能保留 C。

但 Trace 内应记录：

```text
A/B = exploration evidence
C = stable action
```

### 验收

导出的 Workflow 不包含失败探索动作。

---

## T02.4 Semantic Intent Reconstruction

### 目标

从 Trace 恢复：

- 该步骤为什么存在
- 它完成了什么语义动作
- 后一步为什么依赖它

### LLM 使用边界

LLM 可以生成：

- intent
- step description
- expected state

LLM 禁止直接输出最终 selector 和 Workflow JSON。

### 验收

Trace 中存在：

```text
“点击保存按钮”
```

而不是仅：

```text
click('#btn-7f23')
```

---

## T02.5 Workflow IR Compiler

### 目标

把 IR 编译成现有 Workflow JSON。

### 编译规则

```text
IR action
  ↓
Block Capability
  ↓
Block ID
  ↓
Block Params
  ↓
Node Reliability Contract
```

### 强制自动生成

- readiness
- idempotency
- postcondition
- goal evidence
- provenance
- plan

### 验收

生成结果必须通过现有 `validateGeneratedWorkflow`。

---

## T02.6 Goal Evidence Extraction

### 目标

区分：

```text
step postcondition
```

与：

```text
global terminal goal
```

### 规则

至少保留三个层级：

```text
Step Evidence
Terminal Evidence
Business Goal Evidence
```

### 不允许

把所有 postconditions 自动当 global success condition。

### 验收

复杂流程中间态消失后，Workflow 仍可判断最终成功。

### Commit

```text
feat(workflow): derive goal evidence from execution trace
```

---

# P3：Grounding

## T03.1 Live Locator Probe

### 目标

生成 Workflow 时现场验证 target。

### 流程

```text
Semantic Target
  ↓
Candidate Search
  ↓
Candidate Ranking
  ↓
Actionability
  ↓
Live Probe
  ↓
Verified Locator
```

### Probe 条件

- exists
- visible
- enabled
- unique
- stable
- correct role
- correct accessible name/text

### 验收

未经过 live probe 的 strict locator 默认不得进入 Verified 状态。

---

## T03.2 Semantic Locator Ranking

### 目标

在现有 SemanticLocator 基础上建立排序。

### 推荐优先级

```text
exact testId
 > exact role + accessibleName
 > exact label / placeholder
 > stable attribute
 > semantic relation
 > stable CSS
 > XPath
```

注意：这只是候选优先级，不是绝对规则。

### 评分必须包含 evidence

```ts
interface LocatorCandidateScore {
  score: number
  reasons: string[]
  matchedSignals: string[]
  riskSignals: string[]
}
```

### 验收

多候选时不能静默选择第一个。

---

## T03.3 Actionability Verification

### 目标

在 selector 正确之外，验证元素“现在能不能操作”。

### 要检查

- DOM attached
- displayed
- enabled
- not obscured
- correct frame
- correct shadow-root path
- not stale

### 验收

元素存在但不可点击时，必须明确失败原因。

---

## T03.4 Ambiguity Handling

### 目标

把 ambiguity 作为一等失败类型。

### strict 行为

```text
0 match  → LOCATOR_NOT_FOUND
1 match  → candidate
>1 match → rank
            ↓
       sufficient margin?
          /      \
        yes       no
         ↓         ↓
      accept     fail/escalate
```

禁止：

```text
>1 match → first-visible
```

### 验收

R03 必须继续保持 target outcome。

---

## T03.5 Locator Stability Test

### 目标

将“当前能找到”与“以后还能找到”分开。

### Mutation Fixtures

至少包括：

- random class changed
- DOM sibling reordered
- row reordered
- wrapper added
- unrelated element inserted
- SPA rerender

### 验收

selector 在 mutation 后仍能命中相同语义元素。

---

## T03.6 Selector Memory

### 目标

从历史成功执行中学习稳定 locator。

### 新增

```text
src/lib/learning/selector-memory.ts
```

### Key

```text
origin
+ page shape
+ semantic locator
```

### Value

```text
candidate selector
success count
failure count
last success
stability evidence
```

### 规则

只允许高质量成功样本写入。

禁止把错误命中写成学习样本。

### Commit

```text
feat(workflow): learn stable selectors from verified runs
```

---

# P4：Validator

## T04.1 CFG-aware Dataflow

### 目标

修复当前全局 `written` Set 造成的 false positive。

### 算法要求

对 graph 建立：

```text
IN[n]
OUT[n]
```

对于变量：

```text
IN[n] = intersection(OUT[predecessors])
OUT[n] = IN[n] ∪ defs[n]
```

对于多分支：

只有所有可能路径都已定义，才能认为变量 definitely assigned。

### Loop

loop 初始化变量必须显式定义，否则 strict 失败。

### 验收

必须新增至少：

- straight-line use-before-set
- branch-only writer
- loop writer
- trigger input
- branch merge

### Commit

```text
fix(workflow): make generated dataflow validation control-flow aware
```

---

## T04.2 Branch/Loop Definite Assignment

### 目标

在 T04.1 基础上补齐：

- true/false branch
- loop entry
- loop back edge
- break path
- early termination

### 验收

不存在“某条分支定义了变量，所以所有路径都能用”的错误。

---

## T04.3 Graph Structural Verification

### 检查

- orphan node
- unreachable node
- dangling edge
- invalid handle
- accidental cycle
- missing terminal path
- impossible branch

### 额外

识别：

```text
trigger → action
        ↘ dead branch
```

### 验收

Graph issue 必须在 save/run 前报告。

---

## T04.4 Goal Contract Validation

### 目标

强化 goal：

```text
User goal
 ↓
Goal evidence
 ↓
Terminal evidence
```

### 新规则

unsafe Workflow 必须至少具备：

- terminal state guard
- postcondition
- goal evidence

### 验收

创建、提交、发送、支付、删除类动作缺任何一项都不能获得 Verified。

---

## T04.5 Locator Evidence Validation

### 目标

Validator 不仅检查 selector 格式，还检查 Grounding Evidence。

### Strict 错误

```text
LOCATOR_MISSING
LOCATOR_POSITIONAL
LOCATOR_UNSTABLE
LOCATOR_UNVERIFIED
LOCATOR_AMBIGUOUS
LOCATOR_SEMANTIC_MISMATCH
```

### 验收

`selector` 存在但完全没有 semantic evidence 的 generated strict workflow 默认不通过。

---

## T04.6 Side-effect Safety Validation

### 目标

所有 unsafe action 的 retry policy 必须自动升级为安全策略。

### 禁止

```text
submit failed
 → retry immediately
```

### 必须

```text
check terminal state
 ↓
already done → success
not done → maybe execute once
```

### 验收

R09 submit exactly once 保持通过。

---

## T04.7 Preflight Report

### 新增

建议：

```text
src/lib/workflow/preflight.ts
```

### 输出

```ts
interface WorkflowPreflightReport {
  runnable: boolean
  blockers: Finding[]
  warnings: Finding[]
  evidence: Evidence[]
  recommendedActions: RepairSuggestion[]
}
```

### 目标

用户点击 Run 前即可看到：

```text
Ready to run
```

或者：

```text
Blocked: selector ambiguous
Fix: choose unique semantic target
```

### Commit

```text
feat(workflow): add generated workflow preflight report
```

---

# P5：Execution Guard

## T05.1 Action Ledger

### 目标

建立每一次真实 browser side effect 的审计账本。

### 字段

```ts
interface ActionLedgerEntry {
  runId: string
  nodeId: string
  actionFingerprint: string
  startedAt: number
  completedAt?: number
  sideEffect: 'none' | 'conditional' | 'unsafe'
  outcome: 'started' | 'success' | 'failed' | 'unknown'
  evidence?: Evidence[]
}
```

### 验收

失败后可以回答：

> submit 到底有没有发出去？

---

## T05.2 At-most-once Unsafe Guard

### 目标

对 unsafe action 建立 Run 内的 at-most-once 保护。

### 算法

```text
before unsafe action
 ↓
terminal state check
 ↓
ledger check
 ↓
execute once
 ↓
record outcome
```

### 特别要求

如果 action 状态是 `unknown`：

> 默认不能直接再次执行。

应该进入：

```text
verification / user escalation
```

### Commit

```text
feat(workflow): guard unsafe actions with execution ledger
```

---

## T05.3 Terminal State Guard

### 目标

充分利用现有 `terminalStateConditions`。

### 场景

```text
login
already logged in
```

应：

```text
terminal state true
 → skip login
 → verify goal
```

### 验收

保持 S9 non-idempotent benchmark：

- 只运行 1 round
- 不 replay
- verified true

---

## T05.4 Pre/Post Evidence Capture

### 目标

每个高风险节点保存：

```text
before evidence
action result
after evidence
```

### Evidence 类型

- URL
- element exists
- visible
- text
- attribute
- variable
- network/result marker（如已有能力）

不允许把完整 DOM 作为默认 evidence，控制 payload 与隐私风险。

---

## T05.5 Resume Safety

### 目标

用户 retry / resumed run 时，不从 trigger 无脑重放整个 graph。

### 新规则

根据 Action Ledger + terminal state：

```text
safe node
 → can replay

conditional node
 → verify state first

unsafe node
 → terminal state first
```

### 验收

任何 resume 不得导致已经成功提交的动作再次提交。

---

## T05.6 Result Verification

### 目标

执行成功 ≠ 业务目标成功。

必须明确：

```text
L1 execution
L2 evidence verification
L3 goal achievement
```

并继续沿用现有 reliability-certification 定义。

---

# P6：AI Debug Minimal Patch

## T06.1 Runtime Failure Classifier

### 目标

运行时错误必须先分类，再决定修复方式。

### 优先级

```text
Deterministic signal
   >
Rule-based classification
   >
AI classification
```

### 输出

使用 T00.6 的统一 `WorkflowFailure`。

---

## T06.2 Deterministic Repair Library

### 目标

常见错误不要花 LLM token。

### 第一版规则

| Failure | Repair |
|---|---|
| not found | re-ground locator |
| ambiguous | request stronger relation / semantic constraint |
| unstable | replace locator |
| readiness timeout | adjust readiness based on observed state |
| wrong origin | add/repair navigation |
| unwritten variable | add writer or turn input into parameter |
| missing verification | add deterministic condition |
| unsafe retry | terminal-state guard |
| navigation unsettled | add navigation readiness |

### 验收

至少 60% 的简单失败可以不调用 LLM。

这一数字必须由 benchmark 测量，不可硬编码生产承诺。

---

## T06.3 Workflow Patch Schema

### 新增

建议：

```text
src/lib/workflow/workflow-patch.ts
```

### Patch Operation

```ts
type WorkflowPatch =
  | ReplaceLocatorPatch
  | AddConditionPatch
  | ReplaceReadinessPatch
  | AddNavigationPatch
  | AddVariableDefinitionPatch
  | UpdateNodeParamPatch
  | RemoveNodePatch
  | AddNodePatch
```

每个 Patch 必须包含：

```ts
interface PatchBase {
  nodeId?: string
  reason: string
  evidence: Evidence[]
  expectedEffect: string
}
```

### 验收

Patch 可以：

- preview
- validate
- apply
- rollback

---

## T06.4 Patch Scope Guard

### 目标

防止 AI 越修越大。

### 规则

```text
locator failure
 → locator patch only

readiness failure
 → readiness patch only

dataflow failure
 → dataflow patch only

goal failure
 → verification/goal patch only
```

如果 AI 申请修改超过 scope：

```text
PATCH_SCOPE_VIOLATION
```

必须拒绝并要求重新生成局部 patch。

---

## T06.5 AI Patch Generator

### AI 输入

只能看到：

- failure
- relevant node
- nearby graph
- current locator evidence
- page evidence
- relevant workflow plan

不要把整个历史上下文和整个 DOM 全量塞给模型。

### AI 输出

严格 structured output：

```json
{
  "patches": [
    {
      "operation": "replace_locator",
      "nodeId": "save",
      "reason": "old selector no longer matches",
      "expectedEffect": "resolve unique save button"
    }
  ]
}
```

### 验收

AI 永远不直接输出完整 Workflow JSON。

---

## T06.6 Replay Verification

### 流程

```text
Patch
 ↓
Static Validate
 ↓
Replay
 ↓
L1
 ↓
L2
 ↓
L3
```

Patch 只有在目标验证成功后才能持久化。

### 验收

失败 patch 不得污染原 Workflow。

---

## T06.7 Regression Detection

### 目标

Patch 修复本节点，但破坏其他节点时必须自动识别。

### 要求

Patch 后至少执行：

- current scenario
- affected branch
- unsafe action checks
- previous certified benchmark subset

### 验收

出现 regression 时：

```text
Patch rejected
Workflow remains unchanged
Certification → Stale
```

### Commit

```text
feat(workflow): repair failures with verified minimal patches
```

---

# P7：Replay / Stability / Learning

## T07.1 Replay Compiler

### 目标

从一次成功执行 Trace 编译出稳定 Workflow。

### 必须删除

- retry nodes
- exploration nodes
- temporary waits
- failure branches that never contributed to success

### 必须保留

- stable actions
- semantic locators
- required navigation
- required readiness
- final goal verification

---

## T07.2 DOM Perturbation Fixtures

### 目标

测试 Workflow 是否依赖偶然 DOM。

### Fixture mutation

至少支持：

1. dynamic class change
2. random id change
3. sibling reorder
4. extra wrapper
5. extra button
6. delayed rendering
7. modal delayed appearance
8. SPA route transition
9. duplicate text
10. hidden decoy element

### 验收

同一 Workflow 在稳定 mutation 后仍成功。

---

## T07.3 Multi-run Stability Benchmark

### 目标

把单次通过升级为 N 次重复测试。

### 初始建议

```text
N = 10
```

在 CI 成本过高时允许本地扩展到 30/50。

### 指标

```text
replaySuccessRate
sameTargetRate
unsafeDuplicateRate
locatorDriftRate
```

---

## T07.4 Selector Success Memory

### 目标

将经过 Verified Run 的 selector 写入 memory。

### 写入条件

必须满足：

- L1 success
- L2 verification
- locator unique
- goal not violated

### 不写入

只执行成功但未验证成功的 selector。

---

## T07.5 Failure Memory

### 目标

记录：

```text
site
page shape
old locator
failure kind
successful replacement
```

用于未来 Grounding。

### 验收

同类页面再次生成时能够优先尝试过去 verified 的 locator。

---

## T07.6 Workflow Version Diff

### 目标

记录 Workflow 每次自动修复的 patch history。

### 结构

```text
Workflow v1
 ↓ patch P1
Workflow v2
 ↓ patch P2
Workflow v3
```

### 验收

用户可：

- 查看变更
- 回滚
- 比较版本

### Commit

```text
feat(workflow): add replay stability and workflow version history
```

---

# P8：Reliability / Certification

## T08.1 Evidence-based Reliability Report

### 目标

保留现有 certification，同时增加原因解释。

### 输出

```ts
interface ReliabilityReport {
  level: 'low' | 'medium' | 'high'
  score?: number
  evidence: Evidence[]
  blockers: Finding[]
  warnings: Finding[]
  recommendedAction: 'run' | 'verify' | 'repair' | 'ask-user'
}
```

不要只输出一个 0~1 数字。

---

## T08.2 Certification Gate

### 规则

```text
Draft
 ↓ static validation
Validated
 ↓ benchmark
Verified
 ↓ goal achievement
Certified
```

### 新规则

只有：

```text
Certified
```

才允许开启：

- unattended schedule
- automatic page trigger
- high-frequency repeat

具体产品门槛由产品层配置，但不能绕过 reliability state machine。

---

## T08.3 Generated Workflow Save Gate

### 目标

Generated workflow 保存阶段显示：

```text
Generated
Validated
Grounded
Ready
```

不要把 saveWarning 和 blocker 混为一谈。

### 规则

- blocker → 不允许标记 Ready
- warning → 可保存但不能标记 Verified

---

## T08.4 Scheduled Run Gate

### 目标

高风险 Workflow 在 schedule 前重新检查：

- certification
- stale
- goalSpec
- unsafe guard
- origin / trigger

---

## T08.5 Regression → Stale

### 目标

以下情况必须自动 stale：

- graph changed
- patch applied but not reverified
- selector replaced
- certification benchmark regression
- goalSpec changed
- critical environment shape changed（若已有相应检测）

---

## T08.6 Metrics Dashboard Data Model

### 目标

把所有成功率变成可追踪数据。

至少保存：

```ts
interface WorkflowRunMetrics {
  workflowId: string
  workflowVersion: string
  runId: string
  generationSource: 'chat-generate' | 'chat-history' | 'manual' | 'import'
  l1: boolean
  l2: boolean
  l3: boolean
  failureKind?: WorkflowFailureKind
  repairRounds: number
  aiCalls: number
  humanTakeover: boolean
  durationMs: number
}
```

### Commit

```text
feat(workflow): connect reliability certification to run metrics
```

---

# P9：Benchmark / CI

## T09.1 Generation Benchmark

### 场景

### G01

```text
open page → click button
```

### G02

```text
search → read result
```

### G03

```text
fill form → submit → verify
```

### G04

```text
multi-page navigation → form → submit → verify
```

### G05

```text
branch + loop + variable
```

### 指标

- parse rate
- compile rate
- valid workflow rate
- goal spec completeness

---

## T09.2 First-run Benchmark

### 目标

生成后不经过人工编辑，直接执行。

必须单独统计：

```text
firstRunSuccess
firstRunGoalSuccess
firstRunVerificationSuccess
```

---

## T09.3 Debug Benchmark Expansion

在现有 S1-S9 基础上扩展：

- ambiguous locator repair
- readiness repair
- wrong-origin repair
- variable-definition repair
- missing-goal repair
- unsafe retry protection
- patch-scope violation
- regression rejection

### 目标

Verified Recovery Rate 必须持续回归。

---

## T09.4 Stability Benchmark

### 目标

同一 Workflow 在 10 次 mutation replay 中：

- 大部分保持成功
- 不发生 unsafe duplicate
- selector 漂移可检测

---

## T09.5 Mutation Benchmark

### 目标

模拟现实中的页面变化，而不是只测固定 fixture。

### 重点

```text
DOM changes
SPA changes
async rendering
duplicate elements
attribute changes
```

---

## T09.6 CI Quality Gate

### 最低门槛

CI 必须阻断：

- typecheck failure
- existing tests failure
- reliability benchmark regression
- debug benchmark regression
- unsafe duplicate regression

### 允许继续的情况

只有低优先级 UI warning 不应阻断核心 reliability CI。

### Commit

```text
test(workflow): enforce ai reliability regression gates
```

---

# 8. 推荐 Commit 顺序总表

| 顺序 | Task | Commit |
|---:|---|---|
| 1 | T00.1-T00.4 | docs(workflow): document ai workflow architecture |
| 2 | T00.5 | test(workflow): add reliability baseline |
| 3 | T00.6 | feat(workflow): add unified failure taxonomy |
| 4 | T01.1 | feat(workflow): add workflow intermediate representation |
| 5 | T01.2 | feat(workflow): add block capability catalog |
| 6 | T01.3-T01.5 | feat(workflow): compile action traces into workflow ir |
| 7 | T02.1-T02.3 | feat(workflow): normalize workflow action traces |
| 8 | T02.4-T02.6 | feat(workflow): derive goal evidence from execution trace |
| 9 | T03.1-T03.2 | feat(workflow): add live semantic grounding |
| 10 | T03.3-T03.5 | feat(workflow): verify actionable locator stability |
| 11 | T03.6 | feat(workflow): learn stable selectors from verified runs |
| 12 | T04.1 | fix(workflow): make generated dataflow validation control-flow aware |
| 13 | T04.2-T04.3 | fix(workflow): validate workflow control flow and definite assignment |
| 14 | T04.4-T04.6 | fix(workflow): strengthen generated safety validation |
| 15 | T04.7 | feat(workflow): add generated workflow preflight report |
| 16 | T05.1-T05.3 | feat(workflow): guard unsafe actions with execution ledger |
| 17 | T05.4-T05.6 | feat(workflow): capture runtime evidence and verification |
| 18 | T06.1-T06.2 | feat(workflow): add deterministic workflow repair rules |
| 19 | T06.3-T06.4 | feat(workflow): define minimal workflow patches |
| 20 | T06.5-T06.7 | feat(workflow): repair failures with verified minimal patches |
| 21 | T07.1-T07.3 | feat(workflow): add replay stability benchmarks |
| 22 | T07.4-T07.6 | feat(workflow): add workflow learning and version history |
| 23 | T08.1-T08.3 | feat(workflow): add evidence based reliability gating |
| 24 | T08.4-T08.6 | feat(workflow): connect reliability certification to run metrics |
| 25 | T09.1-T09.5 | test(workflow): expand ai workflow reliability benchmarks |
| 26 | T09.6 | test(workflow): enforce ai reliability regression gates |

---

# 9. AI Agent 每个 Task 的标准执行模板

AI Coding Agent 接到 Task 后，必须按照下面模板执行：

## Step A：Read

```text
Read AGENTS.md
Read this Task
Read referenced existing modules
```

## Step B：Locate

```text
rg -n "symbol|entrypoint|type|test" src tests specs
```

禁止根据计划中的“建议文件名”直接新建模块。

## Step C：Understand

输出内部简短结论：

```text
Current implementation
Current gap
Minimal change
Compatibility risk
```

## Step D：Test First

先添加失败测试或扩展现有测试。

## Step E：Implement

只修改本 Task Scope。

## Step F：Verify

至少：

```bash
pnpm typecheck
pnpm test
```

根据 Task 增加：

```bash
pnpm bench:debug
pnpm bench:reliability
pnpm build
```

## Step G：Review

检查：

```text
Did I change compat behavior?
Did I broaden patch scope?
Did I add user-visible copy without i18n?
Did I change generated strict behavior without benchmark?
Did I invalidate certification correctly?
```

## Step H：Commit

只提交本 Task。

---

# 10. 重点技术原则

## 原则 1：执行优先，生成后编译

Browser Copilot 已有真实 browser agent 执行能力，因此：

> 对 action-first 用户路径，最可靠的数据来源不是模型“猜”，而是真实成功执行的 Trace。

因此后续系统应尽可能：

```text
Observe actual success
→ normalize
→ compile
```

而不是：

```text
LLM imagine browser
→ write Workflow
→ hope it works
```

---

## 原则 2：LLM 做语义，不做低级机械编译

LLM 适合：

- 用户目标
- 约束
- 语义 action
- intent
- ambiguity explanation
- repair hypothesis

LLM 不应该负责：

- 最终 Workflow JSON
- selector 拼装
- 变量 def-use 判定
- graph correctness
- unsafe retry decision
- goal verification

这些应该尽可能由代码完成。

---

## 原则 3：Evidence > Confidence

不要只说：

```text
confidence = 0.94
```

而要记录：

```text
role matched
name matched
unique = true
visible = true
enabled = true
selector live-probe = true
stability test = pass
```

这样 Debug 才知道为什么这个 locator 被接受。

---

## 原则 4：一次成功不等于长期稳定

Workflow 生命周期应当是：

```text
Generated
 ↓
Validated
 ↓
First Run Success
 ↓
Verified
 ↓
Replay Stable
 ↓
Certified
```

不要把“第一次运行成功”直接当作“可靠 Workflow”。

---

## 原则 5：副作用优先保护，而不是追求成功率数字

对于：

- submit
- send
- create
- delete
- pay
- publish
- login

错误重试比失败本身更危险。

所以系统必须优先保证：

```text
No duplicate side effect
```

再追求：

```text
Higher success rate
```

---

## 原则 6：Debug 必须是闭环，不是聊天

正确 Debug 完成定义：

```text
Failure identified
 ↓
Repair generated
 ↓
Patch applied in sandbox/candidate version
 ↓
Replay passed
 ↓
Goal verified
 ↓
No regression
 ↓
Persist
```

缺少最后三个步骤时，不能标记“修复成功”。

---

# 11. 生成质量提升的额外优化建议

## 11.1 Page Understanding Cache

在 Grounding 前增加页面理解缓存：

```text
origin + page shape hash
```

缓存：

- interactive elements
- role/name
- forms
- labels
- landmarks
- semantic clusters

DOM hash 变化时自动失效。

目的：

- 降低 LLM 调用
- 减少重复 DOM 分析
- 提高 grounding 一致性

---

## 11.2 Workflow Template Retrieval

对于重复任务，不必从零生成：

```text
User intent
 ↓
Template retrieval
 ↓
Existing workflow candidate
 ↓
Adapt + verify
```

前提：模板必须已经 Verified / Certified。

这样比每次重新生成更稳定。

---

## 11.3 “最小差异生成”

如果用户请求：

```text
把原来的“创建客户”改成“创建供应商”
```

不要重新生成整个 Workflow。

应：

```text
Existing Workflow
 ↓
Diff Intent
 ↓
Local IR Patch
 ↓
Replay
```

这样可以显著降低生成漂移。

---

## 11.4 Workflow Fingerprint

为 Workflow 生成稳定 fingerprint：

```text
semantic steps
+ topology
+ goal contract
+ locator identity
```

用于：

- 去重
- 版本 diff
- cache
- benchmark
- regression detection

---

## 11.5 Environment Drift Detection

重复运行失败时先判断：

```text
Workflow changed?
Page changed?
Browser changed?
Auth state changed?
Provider/model changed?
```

不要所有失败都归因到 Workflow。

这能显著减少错误 Debug。

---

## 11.6 Provider / Model Quality Tracking

因为项目支持多个 OpenAI-compatible provider，所以必须记录：

```text
provider
model
prompt version
workflow benchmark result
```

这样可以发现：

> 是 Workflow 架构问题，还是某个模型的结构化输出质量问题。

但模型选择不能直接作为“成功率保证”，必须由 benchmark 统计。

---

# 12. Benchmark 场景矩阵

| 类别 | Case | 主要目标 |
|---|---|---|
| Basic | click unique button | 基础 grounding |
| Basic | read text | readiness |
| Form | fill input | data flow |
| Form | select option | actionability |
| Form | submit | unsafe guard |
| Navigation | SPA route | page state |
| Navigation | cross page | origin |
| Async | delayed element | readiness |
| Async | delayed modal | post-click readiness |
| Locator | 0 match | fail precise |
| Locator | 1 match | normal |
| Locator | many match | ambiguity |
| Locator | CSS drift | semantic fallback |
| Locator | unstable id | stability |
| Data | use before set | CFG dataflow |
| Data | branch-only set | branch dataflow |
| Data | loop set | loop dataflow |
| Goal | missing result | goal validation |
| Safety | submit then fail | duplicate prevention |
| Safety | already completed | terminal-state guard |
| Debug | locator failure | minimal patch |
| Debug | readiness failure | minimal patch |
| Debug | wrong origin | repair navigation |
| Debug | regression patch | reject patch |
| Stability | DOM reorder | replay |
| Stability | extra decoy | grounding |
| Stability | delayed render | readiness |

---

# 13. 最终验收标准

## 13.1 Workflow Generation

### 必须满足

- 需求/Trace 可以转换为结构化 IR
- Workflow 编译过程 deterministic
- 生成 Workflow 默认 generated-strict
- provenance 正确
- plan 正确
- goalSpec 可验证
- unsafe actions 有 terminal protection
- element actions 有 semantic locator
- locator 有 live verification
- dataflow 通过 CFG 检查

---

## 13.2 First Run

### 必须满足

- 无人工修改直接运行
- readiness 自动等待
- locator ambiguity 不误点
- unsafe action 不重复
- goal 自动验证
- 失败有结构化原因

---

## 13.3 AI Debug

### 必须满足

- 失败先分类
- deterministic repair 优先
- AI 只输出 structured patch
- patch scope 可验证
- patch 不直接覆盖原 Workflow
- replay 必须通过
- L2/L3 必须通过
- regression 必须拒绝

---

## 13.4 Replay

### 必须满足

- 删除探索动作
- 删除失败动作
- 保留验证节点
- 保留安全 readiness
- 保留 semantic locator
- repeat run 成功率可量化

---

## 13.5 Certification

### 必须满足

```text
Draft
 ↓
Validated
 ↓
Verified
 ↓
Certified
```

每次 graph/critical metadata change 后：

```text
→ Stale
```

未经重新验证的 Workflow 不得继续声称 Certified。

---

# 14. 指标目标

> 注意：下面目标用于工程项目验收方向，不代表当前线上已有数据。

## Phase P0 后

必须拥有真实 Baseline。

## Phase P2 后

目标：

- Trace parse rate >= 99%
- compile validation pass >= 95%

## Phase P3/P4 后

目标：

- simple task first-run success >= 95%
- form task first-run success >= 90%
- locator ambiguity false-action = 0
- use-before-set false-negative = 0

## Phase P5 后

目标：

- unsafe duplicate execution = 0
- unknown side-effect state double retry = 0

## Phase P6 后

目标：

- verified AI repair >= 80%
- fixless takeover counted as success = 0
- patch regression auto-rejected = 100%

## Phase P7 后

目标：

- replay stability >= 90%
- generated workflow certification rate >= baseline + 20%

最终目标仍可沿用原规范的方向：

- Generation：相对 Baseline 显著提升
- First Run：相对 Baseline 显著提升
- Debug：Verified Recovery > 80%
- Replay：稳定运行 > 90%

但任何最终数字都必须以 benchmark 的真实样本和基线测量为准。

---

# 15. Rollout 策略

## Stage 1：Shadow Mode

新增逻辑只计算：

- grounding score
- preflight
- dataflow result
- goal evidence

但不影响现有运行。

仅 `generated-strict` 收集数据。

---

## Stage 2：Generated-Strict 默认

新生成 Workflow 使用：

```text
reliabilityMode = generated-strict
```

旧 Workflow 继续 compat。

---

## Stage 3：Certified Gate

只有 Certified Workflow 才能进入：

- unattended schedule
- repeated trigger
- automatic page trigger

---

## Stage 4：Learning Loop

将 verified selector / failure / repair 写入 local memory。

任何学习数据必须来自 verified run。

---

# 16. 不允许做的事情

## 禁止 1：重写整个 Workflow Debug

不得恢复成：

```text
Failure → LLM → complete new Workflow
```

---

## 禁止 2：用固定 sleep 替代 readiness

已有 readiness runtime，优先继续增强它。

---

## 禁止 3：兼容模式大规模改行为

`compat` 主要用于历史 Workflow。

新增 reliability 机制优先在 `generated-strict` 生效。

---

## 禁止 4：模型直接输出最终 Workflow JSON

必须通过：

```text
LLM
→ Intent / Plan / Patch
→ IR / Deterministic Compiler
→ Workflow
```

---

## 禁止 5：把成功执行等于业务成功

必须区分：

```text
L1 Execution
L2 Verification
L3 Goal
```

---

## 禁止 6：patch 未 replay 就持久化

所有自动修复必须 candidate → replay → verify → persist。

---

## 禁止 7：不测 benchmark 就改 reliability

所有 reliability 相关功能必须带 fixture / benchmark。

---

# 17. 最终系统形态

完成全部 Phase 后，Browser Copilot Workflow 系统应该形成以下闭环：

```text
               USER TASK
                   │
                   ▼
           ┌───────────────┐
           │  Real Browser │
           │    Execute    │
           └───────┬───────┘
                   │
                   ▼
              Action Trace
                   │
          ┌────────▼────────┐
          │ Trace Normalize │
          └────────┬────────┘
                   │
                   ▼
             Workflow IR
                   │
        ┌──────────┼──────────┐
        │          │          │
        ▼          ▼          ▼
    Grounding   Dataflow    Goal/Risk
        │          │          │
        └──────────┼──────────┘
                   ▼
              Compiler
                   │
                   ▼
          Generated Workflow
                   │
                   ▼
               Preflight
                   │
                   ▼
              First Replay
                   │
             ┌─────▼─────┐
             │ L1/L2/L3  │
             └─────┬─────┘
                   │
                   ▼
              Certification
                   │
                   ▼
             Reusable Run
                   │
              ┌────▼────┐
              │ Failure │
              └────┬────┘
                   │
            Failure Classifier
                   │
        ┌──────────┼──────────┐
        │          │          │
        ▼          ▼          ▼
      Rule      AI Patch   Escalation
        │          │
        └────┬─────┘
             ▼
            Replay
             │
             ▼
        Goal Verification
             │
       ┌─────┴─────┐
       │           │
     Pass        Fail
       │           │
       ▼           ▼
   Persist      Rollback
       │
       ▼
  Learning Memory
       │
       └───────────────→ Future Generation
```

最终系统的核心不是“让 LLM 更聪明”，而是：

> **让 LLM 只做它擅长的语义工作，让 Workflow Engine、Validator、Grounding、Evidence Ledger、Replay 和 Certification 把不确定性变成可检查、可恢复、可学习的工程约束。**

---

# 18. Source / Implementation Notes

## 原始规范

`browser-copilot-workflow-ai-improvement-spec.md`

核心定义：

- 目标：生成成功率、首次执行成功率、Debug 修复率、可复用性
- 8 个原始 Phase：Model / Intent / Planner / Grounding / Validator / Patch Debug / Replay / Reliability

## develop 分支关键实现

以下模块已确认存在，可作为本计划的主要复用基线：

```text
src/lib/workflow/types.ts
src/lib/workflow/reliability.ts
src/lib/workflow/conditions.ts
src/lib/workflow/readiness.ts
src/lib/workflow/element-fingerprint.ts
src/lib/workflow/goal.ts
src/lib/workflow/generated-validation.ts
src/lib/workflow/reliability-certification.ts
src/background/workflow-engine/readiness-engine.ts
src/background/workflow-engine/condition-runtime.ts
tests/reliability-benchmark.spec.ts
tests/bench/debug-bench.spec.ts
specs/reliability-fixtures/scenarios.ts
scripts/bench-workflow-reliability.mjs
scripts/bench-debug.mjs
```

## Repository coding rules

必须遵守：

```text
AGENTS.md
```

重点：

- Commit message 全英文
- Conventional Commits
- UI 全部 Tailwind
- 用户可见文案 en + zh-CN
- `pnpm typecheck`
- `pnpm test`
- UI/manifest/build 修改后 `pnpm build`

---

# 19. Definition of Done

该项目只有在以下全部成立时，才认为本次 Workflow AI Reliability 改造完成：

### A. 生成

- [ ] Action-first path 保持不变
- [ ] Trace → IR → Workflow 编译完成
- [ ] LLM 不直接生成最终 Workflow JSON
- [ ] generated-strict 默认开启

### B. Grounding

- [ ] Semantic Locator
- [ ] live probe
- [ ] actionability
- [ ] ambiguity detection
- [ ] stability check
- [ ] verified selector memory

### C. Validator

- [ ] graph validation
- [ ] CFG-aware dataflow
- [ ] locator evidence
- [ ] readiness validation
- [ ] side-effect safety
- [ ] goal contract
- [ ] preflight report

### D. Runtime

- [ ] Action ledger
- [ ] terminal-state guard
- [ ] unsafe at-most-once
- [ ] pre/post evidence
- [ ] resume safety
- [ ] L1/L2/L3 verification

### E. Debug

- [ ] failure taxonomy
- [ ] deterministic repair
- [ ] minimal patch
- [ ] patch scope guard
- [ ] replay verification
- [ ] regression rejection

### F. Learning

- [ ] replay compiler
- [ ] mutation benchmark
- [ ] stability benchmark
- [ ] selector memory
- [ ] failure memory
- [ ] workflow version diff

### G. Quality Gate

- [ ] baseline established
- [ ] generation benchmark
- [ ] first-run benchmark
- [ ] debug benchmark
- [ ] stability benchmark
- [ ] CI regression gate

### H. Certification

- [ ] Draft → Validated → Verified → Certified
- [ ] graph change → Stale
- [ ] patch → reverify
- [ ] schedule trigger respects certification

---

# 20. 给 AI Coding Agent 的总执行指令

执行本计划时必须遵循：

```text
You are implementing the Browser Copilot Workflow AI reliability roadmap.

Primary product principle:
The existing action-first user journey is preserved:
user asks → agent executes in the real browser → successful trace → workflow compilation.
Do not replace this with a mandatory plan-first flow.

Engineering principle:
LLM handles semantic interpretation, intent, explanations and bounded patch proposals.
Deterministic code handles graph correctness, dataflow, locator probing, readiness,
side-effect safety, goal verification, compilation, replay and certification.

Compatibility:
Do not regress compat workflows. New generated workflows should run in generated-strict.

Reliability:
A workflow is successful only when the defined evidence proves it.
L1 execution success is not L2 verification and L2 verification is not L3 goal achievement.

Safety:
Unsafe actions must never be blindly replayed after an unknown outcome.
Use terminal-state checks and an execution ledger.

Debug:
Prefer deterministic repair. AI must produce minimal structured patches, never a
replacement workflow. Every patch must be statically validated, replayed, verified,
and regression-checked before persistence.

Development:
Read AGENTS.md first. Follow one-task-one-commit discipline.
Run relevant tests before committing. Keep all new user-visible UI strings bilingual.
Never invent file paths; locate actual implementation with repository search.
```

---

# 21. 预期最终收益

本计划相比原始 8 Phase 方案的核心增强点在于：

1. **不破坏“先执行、后生成”的真实产品路径。**
2. **把 Trace 变成 Workflow 生成的第一等数据源。**
3. **用 Workflow IR 把 LLM 与最终 JSON 解耦。**
4. **用真实页面 Grounding 替代纯 selector 猜测。**
5. **修复当前 Dataflow Validator 对顺序/分支理解不足的问题。**
6. **把 L1/L2/L3 继续向生成和 Debug 全链路贯彻。**
7. **用 Action Ledger 阻止 unsafe action 重复执行。**
8. **把 Debug 收敛为 Minimal Patch + Replay + Goal Verify。**
9. **增加 Mutation / Stability Benchmark，让“成功一次”变成“可复用”。**
10. **让 Verified Workflow 的 selector / failure / repair 形成可验证学习闭环。**
11. **让 Certification 真正决定 Workflow 能否长期无人值守运行。**
12. **所有可靠性提升都通过 benchmark 数据证明，而不是依赖主观判断。**

---

**执行顺序固定为：**

```text
P0 Baseline
 → P1 IR
 → P2 Trace Compiler
 → P3 Grounding
 → P4 Validator
 → P5 Execution Guard
 → P6 Minimal Patch Debug
 → P7 Replay & Learning
 → P8 Reliability & Certification
 → P9 Benchmark & CI
```

**禁止跳过 P0，也禁止在 P0 未确认真实生成/执行/Debug 调用链之前大规模新建模块。**
