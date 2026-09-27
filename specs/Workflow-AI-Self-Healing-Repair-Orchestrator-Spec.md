# Workflow AI Self-Healing / Repair Orchestrator Spec

> 项目：`dcc123456/browser-copilot`
>
> 目标分支：`develop`
>
> Spec 类型：AI Coding Agent 可直接执行的工程实施 Spec
>
> 编写日期：2026-09-23
>
> 当前基线：`develop` 当前 `package.json` 版本为 `0.6.3`。本 Spec 不是推翻现有 Workflow/Debug/Checkpoint 能力，而是在其上把“工作流生成”和“工作流运行修复”统一成一个可验证、自愈、可观测的闭环。

---

## 0. Executive Summary

### 0.1 本次要解决的 3 类问题

当前必须同时解决：

1. **工作流生成模式完成率低**
   - 简单任务也经常无法完成。
   - 生成期执行成功 ≠ 保存后的 Workflow 首跑成功。
   - 模型可能完成了页面操作，却没有可靠地产生可复用的工作流终态。
   - 生成链路需要“任务完成优先”，而不是“节点生成优先”。

2. **生成 Workflow 的最终 UI 不应追加在聊天尾部**
   - 当前 `ChatTab.tsx` 直接维护 `workflowPrompt` 状态并渲染生成/保存卡片。
   - 目标改为独立的 **Workflow Generation Dialog / Modal**，通过 Portal/现有 Dialog primitive 打开。
   - Modal 在生成过程中持续存在，生成结束后再切换到“预览/保存/验证”状态。

3. **AI Repair 经常 `HUMAN_TAKEOVER / no patch proposed`**
   - `no patch proposed` 目前本质是 Repair 生成阶段的失败，不应该直接等价于“需要人工修复”。
   - AI Repair 必须由“生成 patch”升级为“自动修复编排器”。
   - Repair 必须自动：诊断 → 制定策略 → 修改候选 → 执行 → 验证 → 失败再诊断 → 下一策略。
   - 只有自动修复策略全部耗尽，或确实存在外部/不可安全自动化的阻塞时，才进入 `HUMAN_TAKEOVER`。

### 0.2 目标体验

用户输入：

> “打开 GitHub，进入某个页面，点击某按钮并填写内容。”

目标行为：

```text
用户输入
  ↓
Workflow Generation Dialog 立即打开
  ↓
阶段 1：理解任务 / 确认终态
  ↓
阶段 2：AI 真正执行任务（不是先猜 Workflow）
  ↓
阶段 3：实时记录成功动作、目标、页面状态、验证证据
  ↓
阶段 4：编译为 Workflow
  ↓
阶段 5：静态 runnability hardening
  ↓
Workflow Preview / Save
  ↓
用户运行 Workflow
  ↓
发生失败？
  ↓
Repair Orchestrator 自动介入
  ↓
Diagnose → Strategy → Candidate → Apply → Resume → Verify
  ↓
失败：换策略，最多 N 轮
  ↓
成功：自动提交修复后的 Workflow revision
  ↓
只有真正无法安全自动化时才显示人工接管
```

### 0.3 非目标

本阶段不做：

- 重写现有 56 类 Workflow block executor。
- 引入 Temporal / 外部 workflow engine。
- 删除现有 `compat` Workflow 行为。
- 把所有人工安全边界都强制改成全自动。
- 自动绕过 CAPTCHA、2FA、明确的授权/登录障碍。

---

# 1. 现有 `develop` 代码基线分析

## 1.1 已经存在的可靠性基础，必须复用

`develop` 已经有一套相当完整的可靠性基础，本次不能重复建设：

### A. Generated workflow 已进入 strict reliability 模式

`src/lib/workflow/reliability.ts` 已定义 `compat` / `generated-strict` 两种 regime；`chat-generate` / `chat-history` provenance 会自动进入 `generated-strict`。节点级 reliability contract 已包含：

- `intent`
- `idempotency`
- `preconditions`
- `postconditions`
- `readiness`
- `locator`

并且 workflow-level `goalSpec` 可表达成功条件和 terminal state。这个设计应直接成为新的 Generator / Repair contract，而不是另起一套 metadata。 

参考：
- `src/lib/workflow/reliability.ts`
- `src/lib/workflow/conditions.ts`
- `src/lib/workflow/readiness.ts`

### B. 生成期已经有“执行成功后才记录节点”的约束

`src/background/operator-tool-run.ts` 当前的设计是：

```text
resolve → execute → record
```

只有 operator tool 真正执行成功才进入 draft；失败动作通过 `ok:false` 返回模型，而不是把坏节点写入草稿。

这是正确方向，但还不够，因为：

> “动作成功”只证明单个动作成功，不证明整个任务成功，也不证明 Replay 成功。

### C. Replay 已经做了第一轮 runnability hardening

`specs/2026-09-19-first-run-success-design.md` 已落地：

- read block 默认轮询等待；
- 元素解析优先精确唯一命中；
- 录制 selector 会做 live-page probe；
- 生成 Workflow 保存时做 selector hardening；
- 元素 wait 会持久化进 graph；
- generation origin URL 会进入 provenance；
- run 前会给 unanchored warning。

所以本 Spec 不重复解决这些问题，而是在其上继续增加 **Task-level completion / Repair loop / UI**。

### D. 已经有 Checkpoint / Failure Memory

`src/lib/workflow/checkpoints.ts` 已具备：

- 每步 checkpoint；
- workflow fingerprint；
- variable snapshot；
- resume point；
- side-effect phase；
- fingerprint mismatch 防护。

`src/lib/workflow/failure-memory.ts` 已具备：

- failure signature；
- occurrence；
- root cause；
- suggested action；
- confidence；
- retry hint。

这些必须成为 Repair Orchestrator 的底层状态，不要再造第二套 retry memory。

### E. 当前 Debug Session 已存在，但仍偏向“AI takeover + 用户确认”

`background/index.ts` 当前 `workflows.debug` 逻辑已有：

- takeover budget；
- sessionId；
- replay / audit；
- rewrite candidate；
- takeover stats；
- fix/rewrite verify phase。

但 `workflows.takeoverApply` 当前仍将 pending fixes 视为正式提交，并且 fix application 与 verification 仍是一个面向“用户确认”的流程。Spec 要把它上收为一个由 Repair Orchestrator 管理的自动候选循环。

### F. 当前保存卡片默认不自动验证

`src/sidepanel/ChatTab.tsx` 当前保存逻辑：

```text
savePromptWorkflowDirect()
  → persistPromptWorkflow()
  → workflows.save(fromGeneration=true)
```

`verifyRun` 当前属于保存卡片的可选开关；勾选后才发送 `workflows.debug`。这对副作用安全是合理的，但它把“生成 → 可运行”验证从默认交付链路里拆出去了。

新设计不要求默认对所有 Workflow 立即真实重放，而是：

- **保存时默认执行廉价静态 runnability gate；**
- **第一次真正运行失败时自动 Repair；**
- 可对低风险 Workflow 提供“保存后验证”的推荐选项；
- 对高副作用 Workflow 不默认自动真实重放。

---

# 2. 总体架构

## 2.1 新增统一的两条闭环

### Workflow Generation

```text
Intent
 ↓
Goal Contract
 ↓
Live Agent Execution
 ↓
Evidence / Action Trace
 ↓
Workflow Compiler
 ↓
Static Validation + Hardening
 ↓
Workflow Candidate
 ↓
Save
```

### Workflow Self-Healing

```text
Workflow Run
 ↓
Failure Classifier
 ↓
Failure Snapshot
 ↓
Repair Orchestrator
 ↓
Repair Strategy Ladder
 ↓
Candidate Workflow / Candidate Action
 ↓
Resume From Checkpoint
 ↓
Execute
 ↓
Goal Verification
 ├─ PASS → Commit revision
 └─ FAIL → Failure memory + next strategy
 ↓
Budget exhausted / external blocker
 ↓
Human takeover only when necessary
```

## 2.2 两套系统共享的核心契约

```text
GoalSpec
ReliabilitySpec
ElementLocator
ReadinessSpec
FailureSnapshot
Checkpoint
WorkflowFingerprint
RepairCandidate
VerificationResult
```

原则：

> **Generation 产生 Repair 所需要的信息；Repair 产生 Generation 下一版本所需要的稳定性信息。**

---

# 3. Workflow Generation：从“生成节点”改成“完成任务后编译 Workflow”

## 3.1 核心产品原则

### 当前思路

```text
用户任务
 ↓
模型操作
 ↓
每次成功动作记录 node
 ↓
停止
 ↓
Workflow
```

### 新思路

```text
用户任务
 ↓
定义 Success Contract
 ↓
AI 必须继续执行，直到 goal satisfied
 ↓
记录完整成功 execution trace
 ↓
从 trace 编译 Workflow
 ↓
校验 Workflow 能否表达原任务
```

### 关键变化

> **“Workflow generated” 不应等价于“生成了一串节点”，而应等价于“原任务完成 + 可复用 Workflow Candidate 已从成功轨迹编译出来”。**

---

# 4. Generation State Machine

```text
IDLE
 ↓
STARTING
 ↓
UNDERSTANDING
 ↓
EXECUTING
 ├─ TOOL_CALL
 ├─ OBSERVING
 ├─ RECOVERING
 └─ GOAL_CHECK
       │
       ├─ NOT_SATISFIED → EXECUTING
       └─ SATISFIED
             ↓
          COMPILING
             ↓
      HARDENING / VALIDATING
             ↓
         READY_TO_SAVE
        /             \
      SAVE             CANCEL
       ↓                 ↓
    SAVED              END
       ↓
   READY_FOR_RUN
```

如果执行阶段发生普通页面问题：

```text
EXECUTING
   ↓
ACTION_FAILURE
   ↓
LOCAL_GENERATION_RECOVERY
   ↓
retry / inspect / alternate locator / wait / re-observe
   ↓
EXECUTING
```

**生成阶段不应直接因为一次 action failure 结束整个 generation。**

只有达到生成预算或确实无法完成任务时才进入：

```text
GENERATION_BLOCKED
```

---

# 5. Generation Data Model

新增 `src/lib/workflow/generation-session.ts`。

```ts
export type WorkflowGenerationPhase =
  | 'starting'
  | 'understanding'
  | 'executing'
  | 'compiling'
  | 'hardening'
  | 'ready-to-save'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'cancelled'

export interface WorkflowGenerationSession {
  id: string
  conversationId: string
  workflowId?: string

  phase: WorkflowGenerationPhase

  userGoal: string
  goalSpec: WorkflowGoalSpec

  originUrl?: string
  startedAt: number
  updatedAt: number

  actionCount: number
  successfulActionCount: number

  actionTrace: GenerationActionTrace[]
  observations: GenerationObservation[]
  failures: GenerationFailure[]

  workflowCandidate?: Workflow
  hardening?: WorkflowHardeningResult

  progress: GenerationProgress
}
```

### 5.1 Progress

```ts
export interface GenerationProgress {
  stage:
    | 'understanding'
    | 'working'
    | 'verifying'
    | 'building'
    | 'finishing'
  messageKey: string
  detailKey?: string
  current?: number
  total?: number
}
```

### 5.2 Action Trace

```ts
export interface GenerationActionTrace {
  index: number
  nodeId: string
  blockId: string
  intent: string

  page: {
    url?: string
    title?: string
  }

  target?: Target
  params: Record<string, unknown>

  startedAt: number
  completedAt?: number

  result: 'success' | 'failed'

  verification?: {
    kind: 'action' | 'navigation' | 'read' | 'goal'
    passed: boolean
    evidence?: string
  }
}
```

---

# 6. Goal Contract：生成前就必须知道“什么叫做完成”

## 6.1 生成模型必须输出 GoalSpec

```ts
export interface WorkflowGoalSpec {
  summary: string
  successConditions: WorkflowCondition[]
  terminalStateConditions?: WorkflowCondition[]
}
```

### 示例

用户：

> “打开 GitHub 的某个 issue 并给它加一个 label。”

Goal：

```json
{
  "summary": "Issue 已成功增加指定 label",
  "successConditions": [
    {
      "type": "element-text-exists",
      "text": "bug"
    }
  ],
  "terminalStateConditions": [
    {
      "type": "url-matches",
      "pattern": "github.com/.*/issues/.*"
    }
  ]
}
```

### 目标

模型不能因为：

```text
click label menu
```

就认为任务完成。

必须验证：

```text
label actually appears
```

---

# 7. Generation Prompt 设计

## 7.1 System Prompt

```text
You are the Workflow Generation Agent.

Your job is NOT to invent a workflow from the user's sentence.
Your job is to complete the user's task in the real browser first,
then compile the successful execution into a reusable workflow.

Rules:

1. Identify the user's actual end goal before acting.
2. Define concrete success conditions that can be checked on the page.
3. Inspect the current page before making assumptions.
4. Prefer semantic targets and robust element identities over positional selectors.
5. After every meaningful action, observe the resulting page state when needed.
6. Do not stop because one action failed. Diagnose and recover.
7. Use alternate locators, readiness waits, scrolling, navigation recovery,
   frame recovery, or another action strategy when appropriate.
8. Do not record failed actions into the workflow trace.
9. Do not conclude the task is finished until the success conditions are satisfied.
10. Only after the goal is satisfied, compile the successful trace into a workflow.
11. The compiled workflow MUST contain a machine-checkable goalSpec.
12. Generated workflows MUST preserve intent, readiness, idempotency and locator metadata.
13. Never return a workflow candidate that has not completed the original task.
14. If the task is blocked by authentication, CAPTCHA, 2FA or another explicit
    external gate, report the blocker instead of fabricating a workflow.
```

## 7.2 Recovery Prompt

发生 action failure 后：

```text
The last action failed.
Do not give up and do not end workflow generation.

First classify the failure:
- selector / target
- timing / readiness
- visibility / interactionability
- navigation
- frame / tab
- data / input
- state mismatch
- external blocker
- unknown

Then perform the smallest safe recovery:
1. inspect current page state;
2. test the previous target;
3. search for semantic alternatives;
4. add readiness / scroll / navigation recovery when justified;
5. execute the repaired action;
6. verify the result.

Only continue when the action is actually successful.
```

---

# 8. Generation Reliability Improvements

## 8.1 简单任务必须优先走确定性路径

对于：

- click
- fill
- select
- open URL
- navigate
- read text
- download
- checkbox/radio

优先：

```text
page snapshot
→ deterministic target resolution
→ action
→ verify
```

AI 不应为已经确定的 DOM target 反复推理。

## 8.2 生成阶段增加局部恢复，而不是重启完整任务

失败：

```text
Step 7 fails
```

不要：

```text
restart generation from step 1
```

使用：

```text
checkpoint before step 7
→ inspect
→ repair step 7
→ continue step 7
```

这可以直接复用 `checkpoints.ts` 的 checkpoint abstraction。

## 8.3 生成 trace 必须保存 intent

不能只记录：

```json
{ "blockId": "event-click", "selector": "..." }
```

必须至少有：

```json
{
  "intent": "Click the Submit Order button",
  "target": {
    "primary": ...,
    "fallbacks": ...
  }
}
```

后续 Repair 才能知道“这个节点究竟想做什么”。

---

# 9. Workflow Compiler

新增/扩展：

```text
src/lib/workflow/workflow-compiler.ts
```

输入：

```ts
{
  goalSpec,
  actionTrace,
  observations,
  originUrl,
}
```

输出：

```ts
Workflow
```

### Compiler 必须生成

- `settings.provenance = 'chat-generate'`
- `settings.generationOriginUrl`
- `settings.reliabilityMode = 'generated-strict'`
- `settings.goalSpec`
- 每个元素节点的 `__reliability.intent`
- `idempotency`
- `preconditions`
- `postconditions`
- `readiness`
- `locator`

### 编译禁止

- 把 failed action 写进 Workflow。
- 把没有被验证过的 selector 标成 verified。
- 忽略目标终态。
- 自动覆盖用户已经明确修改过的 selector。

---

# 10. Save / Modal UX 重构

## 10.1 当前问题

当前 `ChatTab.tsx`：

- 用 `workflowPrompt` 维护生成状态；
- 保存后 append status 到 transcript；
- Workflow 卡片属于聊天内容树的一部分。

这导致：

```text
生成过程
      ↓
聊天滚动
      ↓
Workflow UI 堆到回复底部
```

不适合一个需要持续操作的长流程。

## 10.2 新交互

### 用户发送生成请求的瞬间

**立即打开 Modal。**

不能等 Workflow 全部生成完以后再显示。

```text
Chat
 │
 └── User: “生成一个可以执行的 Workflow...”
          ↓
      WorkflowGenerationDialog OPEN
```

### Modal 状态

```text
┌──────────────────────────────────────┐
│ 生成工作流                           │
│                                      │
│ ● 理解任务                           │
│ ✓ 读取当前页面                       │
│ ⟳ 正在执行任务                       │
│                                      │
│ 已完成 4 个操作                      │
│                                      │
│ 正在点击「提交」...                   │
│                                      │
│                         [取消]       │
└──────────────────────────────────────┘
```

生成完成：

```text
┌──────────────────────────────────────┐
│ 工作流已生成                         │
│                                      │
│ ✓ 原任务已完成                       │
│ ✓ 8 个步骤                           │
│ ✓ 已完成可运行性检查                 │
│                                      │
│ 工作流：提交 GitHub Issue             │
│                                      │
│ [编辑] [保存工作流]                   │
└──────────────────────────────────────┘
```

## 10.3 Modal 必须通过 Portal

新增：

```text
src/sidepanel/components/WorkflowGenerationDialog.tsx
```

渲染：

```tsx
createPortal(dialog, document.body)
```

或复用仓库已有 Dialog primitive。

要求：

- fixed / overlay；
- 不参与 chat log layout；
- 不因为聊天滚动而移动；
- Esc 可取消/关闭非运行状态；
- 正在执行时关闭按钮变成最小化/后台运行语义；
- 生成完成后用户仍能继续查看 Workflow 候选；
- 关闭后生成过程不得被 UI unmount 意外取消。

---

# 11. Generation Progress：必须让用户感知“生成有延时”

## 11.1 目标

解决：

```text
点击生成
↓
几秒没有 UI
↓
用户以为没反应
```

必须满足：

> **100–300ms 内给出明确反馈。**

不需要真的等 LLM 返回第一 token。

## 11.2 Progress Event

新增：

```ts
export type WorkflowGenerationEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'stage'; sessionId: string; stage: string; messageKey: string }
  | { type: 'action-started'; sessionId: string; description: string }
  | { type: 'action-completed'; sessionId: string; description: string }
  | { type: 'recovery'; sessionId: string; description: string }
  | { type: 'goal-check'; sessionId: string; passed: boolean }
  | { type: 'compiling'; sessionId: string }
  | { type: 'hardening'; sessionId: string }
  | { type: 'ready'; sessionId: string; workflowId?: string }
  | { type: 'failed'; sessionId: string; reason: string }
```

## 11.3 UI Progress 规则

### Stage 1

`正在理解任务…`

### Stage 2

`正在执行任务…`

实时展示最近动作：

```text
✓ 打开页面
✓ 定位“用户名”输入框
✓ 填写用户名
⟳ 正在点击“登录”
```

### Stage 3

`正在验证任务是否完成…`

### Stage 4

`正在编译可复用工作流…`

### Stage 5

`正在进行可运行性检查…`

---

# 12. AI Repair Orchestrator

## 12.1 核心原则

旧模型：

```text
FAIL
 ↓
AI propose patch
 ↓
没有 patch
 ↓
HUMAN_TAKEOVER
```

新模型：

```text
FAIL
 ↓
Diagnose
 ↓
Repair Strategy Ladder
 ↓
Candidate
 ↓
Sandbox Apply
 ↓
Resume
 ↓
Verify Goal
 ↓
PASS → Commit
FAIL → Next Strategy
```

### `no patch proposed` 新语义

```text
NO_PATCH_PROPOSED
```

只能是：

> 当前策略没有产出候选修复。

不能是：

> 立即转人工。

---

# 13. Repair State Machine

```text
IDLE
 ↓
PRECHECK
 ↓
DIAGNOSING
 ↓
PLANNING
 ↓
CANDIDATE_GENERATED
 ↓
CANDIDATE_VALIDATING
 ↓
CANDIDATE_APPLYING
 ↓
RESUMING
 ↓
VERIFYING
 ├─ PASS → COMMITTING
 │          ↓
 │       SUCCESS
 │
 └─ FAIL → CLASSIFY_FAILURE
               ↓
          FAILURE_MEMORY
               ↓
          NEXT_STRATEGY
               ↓
          PLANNING

All strategies exhausted
        ↓
REPAIR_EXHAUSTED
        ↓
HUMAN_TAKEOVER (only when genuinely required)
```

## 13.1 Repair Phase 枚举

新增：

```ts
export type RepairPhase =
  | 'precheck'
  | 'diagnosing'
  | 'planning'
  | 'candidate'
  | 'applying'
  | 'resuming'
  | 'verifying'
  | 'committing'
  | 'success'
  | 'exhausted'
  | 'blocked'
```

---

# 14. Repair Session Data Model

新增：

```text
src/lib/workflow/repair-session.ts
```

```ts
export interface RepairSession {
  id: string
  workflowId: string
  runId: string
  failedNodeId: string
  sessionId?: string

  phase: RepairPhase

  originalWorkflowFingerprint: string
  currentWorkflowFingerprint: string

  failure: FailureSnapshot
  attempts: RepairAttempt[]

  startedAt: number
  updatedAt: number

  budget: RepairBudget

  final?: RepairFinalResult
}
```

## 14.1 Failure Snapshot

```ts
export interface FailureSnapshot {
  nodeId: string
  blockId: string
  errorType: string
  errorMessage: string

  intent?: string

  page: {
    url?: string
    title?: string
  }

  locator?: unknown
  candidateElements?: unknown[]

  screenshotRef?: string
  pageSnapshot?: string

  previousNode?: {
    nodeId: string
    result?: unknown
  }

  checkpoint?: RunCheckpoint

  failureMemory?: FailureMemoryEntry[]
}
```

## 14.2 Repair Attempt

```ts
export interface RepairAttempt {
  attempt: number
  strategy: RepairStrategy

  diagnosis?: RepairDiagnosis
  plan?: RepairPlan

  candidate?: RepairCandidate

  applyResult?: RepairApplyResult
  verification?: VerificationResult

  startedAt: number
  finishedAt?: number

  outcome:
    | 'candidate'
    | 'no-candidate'
    | 'invalid-candidate'
    | 'apply-failed'
    | 'verification-failed'
    | 'verified'
}
```

---

# 15. Repair Strategy Ladder

必须顺序执行，避免每次都让 LLM 自由发挥。

## Strategy 0 — Terminal State Check

先判断：

```text
goal already satisfied?
```

如果已经满足：

```text
SUCCESS
```

不要重新执行危险动作。

这直接复用现有 `judgeAlreadySatisfied` 思路。

---

## Strategy 1 — Deterministic Readiness Recovery

适用于：

- page loading；
- lazy load；
- SPA route；
- element not visible；
- transient interaction failure。

操作：

```text
wait
scroll
focus
re-observe
retry
```

无需 LLM patch。

---

## Strategy 2 — Locator Repair

优先级：

```text
verified selector
 → testid
 → aria-label
 → role + name
 → text
 → semantic locator
 → existing fallback
```

利用现有：

- `target-to-selector.ts`
- `selector-probe.ts`
- `inpage/kernel.ts`

目标：

> 找到同一语义元素，而不是随便找到一个“能点”的元素。

---

## Strategy 3 — Parameter Repair

修复：

- input value；
- timeout；
- select option；
- key sequence；
- wait settings；
- variable interpolation。

候选必须经过 schema validation。

---

## Strategy 4 — Local Graph Repair

允许：

- insert block；
- delete block；
- replace block；
- reconnect edge；
- add wait/navigation step；
- change branch condition。

范围必须优先限制在：

```text
failed node ± 2 nodes
```

避免小问题导致全图重写。

---

## Strategy 5 — Section Re-plan

如果局部 repair 连续失败：

```text
current workflow section
+
original intent
+
current page evidence
```

重新生成失败 section。

---

## Strategy 6 — Full Workflow Re-plan

只有在：

- 页面结构发生大面积变化；
- 多个节点连续失效；
- local repair 已耗尽；
- goalSpec 与当前页面状态严重不一致；

才允许全图 rewrite。

现有 `rewriteRisk` 必须继续保留。

---

## Strategy 7 — Agent Rescue

使用现有 `AI agent` / agent loop 能力作为最后自动化策略。

目标不是返回一段解释，而是：

```text
inspect page
→ act
→ achieve goal
→ record recovery path
→ compile replacement workflow section
```

---

# 16. Repair Prompt

## 16.1 Planner Prompt

```text
You are the Workflow Repair Planner.

Your job is to restore a failed workflow to an executable state WITHOUT human intervention.

You MUST attempt an automatic repair before considering the workflow exhausted.

Inputs:
- original workflow
- failed node
- node intent
- failure type and message
- current URL and page state
- DOM / semantic target evidence
- checkpoint state
- previous repair attempts
- failure memory
- workflow goalSpec

Rules:

1. Never repeat a strategy that already failed with the same evidence.
2. Prefer the smallest repair that can restore execution.
3. Prefer deterministic actions over model-generated rewrites.
4. Preserve workflow intent.
5. Preserve goalSpec.
6. Preserve sensitive credential references.
7. Do not blindly replay unsafe side effects.
8. A missing patch from one strategy is NOT a terminal failure.
9. Select the next strategy when the current strategy cannot produce a candidate.
10. The final result must be an executable candidate or an explicit machine-readable blocker.

Possible strategies:
- readiness recovery
- locator repair
- parameter repair
- local graph repair
- section re-plan
- full workflow re-plan
- agent rescue
```

## 16.2 Candidate Prompt

```text
Produce an executable repair candidate.

Required fields:
- strategy
- reason
- changed nodes
- changed edges
- changed parameters
- expected postcondition
- verification plan

Do not return prose-only advice.
Do not return "no patch proposed" when another automatic strategy remains available.
Do not modify unrelated workflow sections.
```

---

# 17. Patch / Candidate Contract

当前系统的 legacy `paramsPatch` 不够表达 graph repair。

新增：

```ts
export interface RepairCandidate {
  strategy: RepairStrategy
  reason: string

  nodePatches: NodePatch[]
  edgePatches: EdgePatch[]

  replacementSection?: {
    nodeIds: string[]
    workflow: Partial<Workflow>
  }

  expectedPostconditions: WorkflowCondition[]

  confidence?: number
}
```

### Patch 操作

```ts
export type NodePatch =
  | { op: 'update-node'; nodeId: string; changes: Record<string, unknown> }
  | { op: 'insert-node'; node: WorkflowNode }
  | { op: 'delete-node'; nodeId: string }

export type EdgePatch =
  | { op: 'connect'; source: string; target: string; sourceHandle?: string }
  | { op: 'disconnect'; source: string; target: string; sourceHandle?: string }
```

不要直接让模型返回完整 Workflow JSON 作为默认修复路径。

完整 rewrite 只用于 Strategy 6。

---

# 18. Candidate Apply / Rollback

所有 Repair candidate 必须进入：

```text
Original Workflow
       ↓
Candidate Workflow (in-memory)
       ↓
Static Validate
       ↓
Execute
       ↓
Verify
```

只有 Verify PASS 才：

```text
commitWorkflowRevision(..., { source: 'ai-repair' })
saveWorkflow(...)
```

失败：

```text
rollback
```

禁止：

```text
AI patch generated
→ immediately overwrite saved Workflow
```

---

# 19. Repair API / Message Contract

在 `src/lib/messages.ts` 的 command/result union 中增加或统一以下命令。

## 19.1 `workflows.repair`

```ts
{
  type: 'workflows.repair'
  workflowId: string
  runId: string
  mode?: 'auto'
}
```

返回：

```ts
{
  type: 'workflows.repair'
  sessionId: string
  status: 'started'
}
```

## 19.2 `workflows.repair.status`

```ts
{
  type: 'workflows.repair.status'
  sessionId: string
}
```

返回当前 `RepairSession` 的只读快照。

## 19.3 `workflows.repair.cancel`

仅取消 AI repair，不回滚已经验证通过并提交的 revision。

## 19.4 `workflows.repair.apply`

保留兼容性，但新的自动 Repair 不再依赖 UI confirmation。

```ts
{
  type: 'workflows.repair.apply'
  sessionId: string
  attempt: number
}
```

行为：

- 仅允许内部 Repair Orchestrator 调用；
- Candidate 已通过 schema / graph / risk gate；
- Apply 到 in-memory candidate；
- 不直接 commit。

## 19.5 `workflows.repair.verify`

```ts
{
  type: 'workflows.repair.verify'
  sessionId: string
}
```

实际实现中可以由 Orchestrator 内部直接串联，不一定暴露给 UI。

---

# 20. `workflows.debug` 的角色重构

现有 `workflows.debug` 不删除。

改成：

```text
workflows.debug
    ↓
Debug Session Adapter
    ↓
Repair Orchestrator
```

即：

> Debug Session 负责“运行并收集失败证据”；Repair Orchestrator 负责“自动修复并验证”。

不要再让 `debug-session.ts` 同时承担：

- failure classification；
- repair planning；
- patch generation；
- candidate lifecycle；
- UI pending state。

拆开职责。

---

# 21. `HUMAN_TAKEOVER` 新定义

## 21.1 允许进入 HUMAN_TAKEOVER 的情况

只保留明确需要人工处理的情况：

```text
1. side-effect-unknown
2. CAPTCHA / 2FA
3. 外部授权/权限 gate
4. 当前页面根本无法自动化
5. 所有 Repair Strategy 耗尽
```

### 特别说明

`side-effect-unknown` 不能为了“全自动”而盲目重放。

`checkpoints.ts` 已明确要求：如果 unsafe side effect 已经触发但结果未知，禁止盲重放。这条安全约束必须保留。

## 21.2 明确禁止

以下都不能直接 HUMAN_TAKEOVER：

```text
no patch proposed
selector stale
element not found
wrong selector
ambiguous selector
timeout
not visible
not interactable
missing wait
navigation race
wrong target
parameter mismatch
local graph mismatch
```

这些必须进入自动 Repair Ladder。

---

# 22. Repair Budget

建议默认：

```ts
export const DEFAULT_REPAIR_BUDGET = {
  maxAttempts: 6,
  maxSameFailureSignature: 2,
  maxStrategyRepeats: 1,
  maxModelCalls: 8,
  maxToolRoundsPerAttempt: 8,
  maxTotalDurationMs: 90_000,
}
```

不要无限重试。

策略顺序优先于重复次数。

例如：

```text
Attempt 1 readiness
Attempt 2 locator
Attempt 3 parameter
Attempt 4 local graph
Attempt 5 section re-plan
Attempt 6 agent rescue
```

如果 Attempt 2 / 3 已明确证实相同 dead-end，提前跳过。

---

# 23. Repair Resume

优先复用现有 `resumePointOf()`。

规则：

```text
Node 1 ✓
Node 2 ✓
Node 3 ✓
Node 4 ✗
```

Repair Node 4 后：

```text
resume from Node 4
```

而不是：

```text
restart Node 1
```

对于：

```text
Node 4 = login / submit / pay / send / create
```

必须保留现有 side-effect safety phase。

---

# 24. Goal Verification

Repair 成功标准不是：

```text
patched node did not throw
```

而是：

```text
workflow goal is satisfied
```

### 三层验证

#### L1 Node verification

```text
node operation returned success
```

#### L2 Postcondition verification

```text
node.data.__reliability.postconditions
```

#### L3 Goal verification

```text
workflow.settings.goalSpec.successConditions
```

只有 L3 PASS：

```text
AUTO_REPAIRED
```

---

# 25. 新增 Repair Orchestrator 模块

建议目录：

```text
src/lib/workflow/
  repair-session.ts
  repair-policy.ts
  repair-candidate.ts
  failure-classification.ts
  repair-verification.ts

src/background/workflow-engine/
  repair-orchestrator.ts
  repair-context.ts
  repair-executor.ts
```

其中：

### `repair-policy.ts`

纯函数：

```ts
nextStrategyOf(failure, attempts): RepairStrategy | undefined
```

### `repair-context.ts`

负责拼装：

```text
workflow
+
failed node
+
page snapshot
+
checkpoint
+
failure memory
+
goal spec
```

### `repair-orchestrator.ts`

负责状态机。

### `repair-executor.ts`

负责：

```text
candidate → in-memory workflow → execute → verify
```

这样 Repair 不会污染 `index.ts`。

---

# 26. Failure Taxonomy

新增标准化 classifier：

```ts
export type WorkflowFailureType =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_AMBIGUOUS'
  | 'ELEMENT_NOT_VISIBLE'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'SELECTOR_STALE'
  | 'PAGE_NOT_READY'
  | 'NAVIGATION_TIMEOUT'
  | 'FRAME_NOT_FOUND'
  | 'TAB_NOT_FOUND'
  | 'INPUT_REJECTED'
  | 'INVALID_PARAMETER'
  | 'STATE_MISMATCH'
  | 'POSTCONDITION_FAILED'
  | 'GOAL_NOT_SATISFIED'
  | 'WORKFLOW_GRAPH_INVALID'
  | 'MODEL_NO_CANDIDATE'
  | 'MODEL_OUTPUT_INVALID'
  | 'AUTH_REQUIRED'
  | 'CAPTCHA_REQUIRED'
  | 'MFA_REQUIRED'
  | 'SIDE_EFFECT_UNKNOWN'
  | 'MODEL_ERROR'
  | 'UNKNOWN'
```

### 分类优先级

```text
deterministic classifier
 ↓
known error mapping
 ↓
DOM evidence
 ↓
LLM diagnosis only if needed
```

不要所有失败都交给 LLM。

---

# 27. 修复“no patch proposed”的根治方案

## 27.1 Parse Layer

任何模型结果都必须先进入：

```text
parseRepairResponse()
```

区分：

```text
valid candidate
invalid output
empty output
strategy refusal
```

## 27.2 Empty Candidate Recovery

如果：

```text
model response = no patch proposed
```

执行：

```text
attempt++
record MODEL_NO_CANDIDATE
nextStrategy()
```

### 不执行

```text
throw HUMAN_TAKEOVER
```

## 27.3 Invalid Candidate Recovery

如果模型返回：

```text
missing nodeId
bad blockId
invalid edge
invalid data
```

不保存。

执行：

```text
candidate rejected
→ model self-correct prompt
→ or next strategy
```

最多 1 次 correction，不要无限同 prompt retry。

---

# 28. Generation 与 Repair 共用 Locator Abstraction

现有 `target-to-selector.ts` 已经拥有：

- selector candidates；
- recorded selector；
- rich locator；
- reliability locator。

新增统一 API：

```ts
resolveRepairTarget(
  target: Target,
  page: PageEvidence,
): Promise<ResolvedRepairTarget>
```

结果：

```ts
interface ResolvedRepairTarget {
  status: 'exact' | 'semantic' | 'ambiguous' | 'missing'
  target?: Target
  evidence: TargetEvidence[]
}
```

Repair 先尝试这个 deterministic layer，再使用 LLM。

---

# 29. Generation Save Gate

Workflow 保存前必须经过：

```text
1. Graph validation
2. Goal gate
3. Reliability gate
4. Selector probe / hardening
5. Wait persistence
6. Generated strict mode check
7. Origin provenance check
```

新增统一：

```ts
validateGeneratedWorkflowForSave(workflow)
```

输出：

```ts
interface WorkflowSaveGateResult {
  ok: boolean
  blockers: ValidationIssue[]
  warnings: ValidationIssue[]
  hardenedWorkflow: Workflow
}
```

---

# 30. 默认策略重新定义

## Generation

默认：

```text
Goal-first
Live execution
Auto recovery enabled
Compile after success
Static hardening enabled
```

## Save

默认：

```text
Static validation = ON
Selector hardening = ON (generation only)
Persisted waits = ON
Real replay = OFF by default
```

## Run

默认：

```text
Auto repair = ON for generated-strict workflows
Repair budget = bounded
Resume from checkpoint = ON
Goal verification = ON
```

## Repair

默认：

```text
No user confirmation for ordinary low/medium risk repairs
No direct commit before verification
Human takeover only for genuine blockers
```

---

# 31. Sidepanel UI 状态

## 31.1 Generation Modal

状态：

```text
GENERATING
RECOVERING
COMPILING
VALIDATING
READY
SAVING
SAVED
ERROR
```

## 31.2 Run Failure UI

失败时不要立即显示：

```text
HUMAN_TAKEOVER
```

应该：

```text
┌─────────────────────────────────┐
│ Workflow 运行遇到问题            │
│                                 │
│ AI 正在自动修复…                │
│                                 │
│ ✓ 分析失败节点                  │
│ ✓ 检查当前页面                  │
│ ⟳ 正在寻找可用目标              │
│                                 │
│ [查看详情]                       │
└─────────────────────────────────┘
```

成功：

```text
✓ Workflow 已自动修复

修复：重新定位「提交」按钮
验证：8 / 8 steps passed

[查看修复]
```

真正 blocked：

```text
需要人工操作

原因：当前页面需要完成 MFA

[人工接管]
```

---

# 32. UI i18n 要求

当前 `AGENTS.md` 明确要求所有用户可见文案同时提供 `en` + `zh-CN`，并由 TypeScript `Messages` 类型保证两侧同步。

因此本 Spec 的所有新增 UI 文案必须：

- 在 `src/sidepanel/i18n.tsx` 增加 en / zh-CN；
- workflow editor 如涉及编辑器 UI，则同步 `src/workflow-editor/i18n.ts`；
- 禁止 JSX 硬编码字符串；
- 遵守 flat camelCase key 命名。

建议 key：

```text
workflowGenerationTitle
workflowGenerationUnderstanding
workflowGenerationWorking
workflowGenerationRecovering
workflowGenerationCompiling
workflowGenerationValidating
workflowGenerationReady
workflowGenerationSaved
workflowGenerationCancel
workflowGenerationBackground
workflowRepairStarting
workflowRepairDiagnosing
workflowRepairApplying
workflowRepairVerifying
workflowRepairSuccess
workflowRepairExhausted
workflowRepairBlocked
workflowRepairNeedHuman
```

---

# 33. Modal 生命周期与后台运行

由于 README 已经支持“关闭 panel 后答案继续后台运行”的模型，应沿用这一原则。

Generation Modal 关闭时：

```text
UI state detached
      ≠
Generation session cancelled
```

需要：

```ts
WorkflowGenerationSession
    ↓
background-owned session
    ↓
sidepanel subscribes to events
```

而不是：

```text
React unmount
→ abort controller
→ generation lost
```

除非用户明确点击“取消生成”。

---

# 34. Persistence

Generation / Repair session 是否持久化必须分级：

### 强制持久化

- final Workflow
- Repair committed revision
- checkpoints
- history / audit
- failure memory

### 可恢复但不需要永久保存

- active generation session
- active repair session
- progress events

推荐：

```text
active session → memory + durable session snapshot
completed session → history artifact
```

---

# 35. Workflow Revision 语义

生成：

```text
Workflow v1
```

Repair：

```text
Candidate v2
```

Verification PASS：

```text
Workflow v2 committed
source = ai-repair
```

失败：

```text
Candidate v2 discarded
```

必须避免：

```text
AI 尝试一次
→ 把 v2 写进去
→ v2 又失败
→ 再覆盖 v3
```

只有 verified candidate 才是正式 revision。

---

# 36. Reliability Contract 扩展

在现有 `NodeReliabilitySpec` 上补充：

```ts
interface NodeReliabilitySpec {
  intent?: string
  idempotency?: IdempotencyLevel
  preconditions?: WorkflowCondition[]
  postconditions?: WorkflowCondition[]
  readiness?: ReadinessSpec
  locator?: NodeLocatorSpec

  repairHints?: {
    preferredStrategies?: RepairStrategy[]
    allowGraphEdit?: boolean
    allowReplan?: boolean
  }
}
```

这样生成期就能告诉 Repair：

```text
这个节点优先修 selector
```

或者：

```text
这个节点 selector 修复价值低，直接做 semantic target
```

---

# 37. Generation Benchmark

仓库已经有：

```text
pnpm bench:reliability
```

并且 debug 已经有离线 benchmark。

新增：

```text
pnpm bench:workflow-generation
pnpm bench:workflow-repair
```

## 37.1 Generation Metrics

### G1 Task Completion Rate

```text
completed tasks / generation attempts
```

### G2 Workflow Compile Rate

```text
compiled valid workflows / completed tasks
```

### G3 First Replay Success Rate

```text
first-run passed / saved generated workflows
```

### G4 Goal Verified Rate

```text
goal-satisfied runs / workflow runs
```

### G5 Generation Recovery Rate

```text
tasks recovered after an action failure / generation tasks with failure
```

### G6 Median generation latency

记录：

- TTI
- TTFG
- TTReady
- TTSaved

定义：

```text
TTI = 用户提交到 Modal 出现
TTFG = 用户提交到第一次 progress event
TTReady = 用户提交到 workflow ready
TTSaved = 用户提交到 save completed
```

## 37.2 Repair Metrics

### R1 Auto Repair Success Rate

```text
auto-repaired runs / repair-triggered runs
```

### R2 First Strategy Success Rate

统计不同 strategy 的真实通过率。

### R3 no-candidate Rate

```text
MODEL_NO_CANDIDATE / total repair attempts
```

### R4 Human Takeover Rate

必须区分：

```text
necessary blocker takeover
vs
repair exhausted takeover
```

不能简单看一个总数字。

---

# 38. Test Matrix

## 38.1 Generation

### G-01

简单打开 URL。

验收：

- generation modal 立即打开；
- 页面实时进度；
- workflow 保存成功。

### G-02

打开页面 + click。

验收：

- 点击成功；
- workflow 有唯一 locator；
- goalSpec 存在。

### G-03

打开页面 + fill。

验收：

- 输入动作成功；
- postcondition 验证通过。

### G-04

click 后页面延迟加载。

验收：

- generation agent 恢复；
- 不因一次 action failure 直接结束；
- compiled workflow 带 readiness。

### G-05

生成后关闭 Modal。

验收：

- session 仍运行；
- 重新打开可看到实时状态；
- 不重复生成。

---

# 39. Repair Test Matrix

### R-01

selector stale。

期望：

```text
Strategy 2 Locator Repair
→ pass
→ auto commit
```

### R-02

element not ready。

期望：

```text
Strategy 1 Readiness
→ pass
```

### R-03

no patch proposed。

期望：

```text
NO_CANDIDATE
→ next strategy
```

禁止：

```text
HUMAN_TAKEOVER
```

### R-04

第一轮 patch invalid。

期望：

```text
candidate rejected
→ correction / next strategy
```

### R-05

局部 patch 不成功，全图仍可修。

期望：

```text
local repair fail
→ section re-plan
→ verify
```

### R-06

页面大改。

期望：

```text
full workflow re-plan
→ rewriteRisk
→ verify
```

### R-07

non-idempotent action 已执行但结果未知。

期望：

```text
side-effect-unknown
→ NO blind retry
→ HUMAN_TAKEOVER
```

### R-08

Goal already satisfied。

期望：

```text
terminal-state check
→ SUCCESS
```

不重新执行危险动作。

---

# 40. Required Files / Modules

## 40.1 必查/必改

```text
src/background/index.ts
src/background/operator-tool-run.ts
src/background/selector-probe.ts
src/background/workflow-engine/executors.ts
src/background/workflow-engine/debug-session.ts
src/inpage/kernel.ts
src/lib/workflow/reliability.ts
src/lib/workflow/runnability.ts
src/lib/workflow/checkpoints.ts
src/lib/workflow/failure-memory.ts
src/lib/workflow/target-to-selector.ts
src/lib/messages.ts
src/sidepanel/ChatTab.tsx
```

## 40.2 新模块

```text
src/lib/workflow/generation-session.ts
src/lib/workflow/workflow-compiler.ts
src/lib/workflow/failure-classification.ts
src/lib/workflow/repair-session.ts
src/lib/workflow/repair-candidate.ts
src/lib/workflow/repair-policy.ts
src/lib/workflow/repair-verification.ts
src/background/workflow-engine/repair-context.ts
src/background/workflow-engine/repair-executor.ts
src/background/workflow-engine/repair-orchestrator.ts
src/sidepanel/components/WorkflowGenerationDialog.tsx
```

实际落地时，如果仓库已有同职责模块，应合并进现有模块，禁止产生功能重复文件。

---

# 41. Commit 粒度 Task List

> 所有 commit message 必须使用英文 Conventional Commits；这是当前 `AGENTS.md` 的硬性要求。

## Commit 1

```text
feat(workflow): add generation session state machine
```

### 目标

建立 Generation Session 状态和事件，不改变现有生成业务。

### 修改

- 新增 `generation-session.ts`；
- 增加 phase / progress / event；
- background 创建 session；
- sidepanel 订阅 session。

### 验收

- 用户发起 Workflow generation 后 ≤300ms 出现 started event；
- session 可持续更新；
- no UI regression。

---

## Commit 2

```text
refactor(workflow): move generation progress into background session
```

### 目标

将 generation 生命周期从 `ChatTab` React 生命周期解耦。

### 验收

- Modal unmount 不取消 generation；
- worker restart 后 active session 有恢复路径；
- sessionId 稳定。

---

## Commit 3

```text
feat(ui): add workflow generation dialog
```

### 目标

Workflow generation UI 改为独立 Modal。

### 修改

- `WorkflowGenerationDialog.tsx`；
- Portal；
- overlay；
- progress states；
- cancel/background semantics。

### 验收

- Workflow card 不再追加到聊天末尾；
- 生成一开始 Modal 就打开；
- 支持 en/zh-CN。

---

## Commit 4

```text
refactor(workflow): make generation task-first
```

### 目标

生成流程改为：goal → real execution → verified completion → compile。

### 修改

- Generator prompt；
- goalSpec 强制；
- terminal state check；
- generation recovery loop。

### 验收

- 简单 click/fill/open-url 场景完成率提升；
- 未完成 goal 不得进入 ready-to-save。

---

## Commit 5

```text
feat(workflow): add execution trace compiler
```

### 目标

从成功 execution trace 编译 Workflow。

### 验收

- failed actions 不进入 Workflow；
- trace 保留 intent；
- reliability metadata 完整。

---

## Commit 6

```text
feat(workflow): add generated workflow save gate
```

### 目标

保存前统一执行：

- goal gate；
- reliability gate；
- selector hardening；
- waits persistence；
- origin check。

### 验收

- invalid generated workflow 无法落盘；
- valid generated workflow 正常保存；
- editor/import 语义不被改变。

---

## Commit 7

```text
feat(workflow): add failure classification and repair policy
```

### 目标

把失败从一个 Error 变成结构化 FailureType + Strategy。

### 验收

- `ELEMENT_NOT_FOUND` 等标准分类可用；
- classifier 有单元测试；
- no-candidate 不触发 takeover。

---

## Commit 8

```text
feat(workflow): add repair candidate contract
```

### 目标

支持：

- node patch；
- edge patch；
- insert/delete/replace；
- section replacement。

### 验收

- candidate schema 可严格解析；
- malformed candidate 不可应用；
- legacy paramsPatch 继续兼容。

---

## Commit 9

```text
feat(workflow): add repair orchestrator loop
```

### 目标

实现：

```text
Diagnose → Plan → Candidate → Apply → Resume → Verify → Retry
```

### 验收

- 至少支持 4 个 strategy；
- 每次失败自动进入 next strategy；
- candidate 失败可 rollback。

---

## Commit 10

```text
feat(workflow): make repair verification goal-aware
```

### 目标

把 workflow `goalSpec` 接入 Repair verification。

### 验收

- node pass 但 goal fail → repair 不得结束为 success；
- already satisfied → 不重复执行 unsafe action。

---

## Commit 11

```text
refactor(workflow): route debug sessions through repair orchestrator
```

### 目标

让现有 `workflows.debug` 变为 Debug + Repair 的 orchestration adapter。

### 验收

- 旧 debug 功能不回归；
- auto repair 可以从 debug run 启动；
- stats/sessionId 仍保持。

---

## Commit 12

```text
feat(workflow): enable automatic repair for generated workflows
```

### 目标

Generated-strict workflow 第一次运行失败后自动进入 Repair。

### 验收

- 无需点击“人工修复”；
- selector stale 可以自动修；
- 修复后自动 resume + verify；
- verified 后自动 commit revision。

---

## Commit 13

```text
fix(workflow): remove no-candidate takeover escalation
```

### 目标

根治：

```text
HUMAN_TAKEOVER
no patch proposed
```

### 验收

日志必须表现为：

```text
MODEL_NO_CANDIDATE
→ next strategy
```

而不是：

```text
MODEL_NO_CANDIDATE
→ HUMAN_TAKEOVER
```

---

## Commit 14

```text
feat(workflow): add repair progress events
```

### 目标

UI 能实时显示：

- diagnose；
- strategy；
- applying；
- verifying；
- success/exhausted。

### 验收

- Repair 卡不卡死；
- 用户能看到 AI 正在做什么；
- 长 Repair 不表现为“无响应”。

---

## Commit 15

```text
feat(ui): show autonomous repair progress
```

### 目标

失败时直接展示 auto-repair 状态，而不是立即展示 takeover。

### 验收

成功：

```text
✓ Workflow auto-repaired
```

阻塞：

```text
Human action required
```

---

## Commit 16

```text
feat(test): add generation and repair benchmark suites
```

### 目标

新增离线 benchmark。

### 验收

CI 中可运行：

```text
pnpm bench:workflow-generation
pnpm bench:workflow-repair
```

---

## Commit 17

```text
perf(workflow): optimize generation progress and model round usage
```

### 目标

降低生成 latency。

策略：

- 进度事件先行；
- deterministic checks first；
- 避免重复 snapshot；
- strategy-specific prompts；
- context compaction；
- 失败 memory 摘要。

### 验收

- TTFG 显著低于当前；
- 不牺牲 task completion。

---

# 42. Acceptance Criteria 总表

## A. Workflow Generation

必须全部满足：

- [ ] 用户提交后快速出现 Generation Modal；
- [ ] Modal 不再追加到 chat transcript 尾部；
- [ ] 生成过程中持续有进度；
- [ ] 生成任务以“原始任务完成”为完成条件；
- [ ] 简单任务支持自动 recovery；
- [ ] failed actions 不进入最终 workflow；
- [ ] Workflow 必须带 goalSpec；
- [ ] Workflow 必须进入 generated-strict；
- [ ] selector hardening 生效；
- [ ] waits persistence 生效；
- [ ] save gate 生效。

## B. Repair

必须全部满足：

- [ ] `no patch proposed` 不再直接 takeover；
- [ ] failure 有标准分类；
- [ ] repair 有 strategy ladder；
- [ ] candidate 在内存中验证；
- [ ] fail 自动 rollback；
- [ ] resume 使用 checkpoint；
- [ ] verify 依赖 goalSpec；
- [ ] verified candidate 自动 commit；
- [ ] 普通修复不需要人工确认；
- [ ] unsafe side effect 仍遵守 safety gate；
- [ ] repair budget 有上限；
- [ ] repair progress 可见。

## C. UX

- [ ] Generation Modal 是独立 Portal；
- [ ] Modal 生命周期与 generation session 解耦；
- [ ] 用户能看到阶段；
- [ ] 用户能看到最近动作；
- [ ] 用户能看到修复进度；
- [ ] 所有文案双语；
- [ ] Chat transcript 不再承载长时间 Workflow generation state。

---

# 43. 回归测试要求

每个 PR / commit group 至少执行：

```bash
pnpm typecheck
pnpm test
```

涉及 UI：

```bash
pnpm build
```

涉及 injected / kernel：

```bash
pnpm verify:injected
```

涉及 benchmark：

```bash
pnpm bench:debug
pnpm bench:reliability
pnpm bench:workflow-generation
pnpm bench:workflow-repair
```

---

# 44. 风险与防回归策略

## Risk 1：Repair 无限循环

解决：

- maxAttempts；
- same failure signature breaker；
- strategy repeat guard；
- total duration budget。

## Risk 2：Repair 把正确 Workflow 改坏

解决：

- in-memory candidate；
- fingerprint；
- static validation；
- goal verification；
- revision commit only on pass。

## Risk 3：Repair 重复执行危险操作

解决：

- idempotency；
- terminal state check；
- checkpoint phase；
- side-effect-unknown gate。

## Risk 4：生成 UI 看起来“卡住”

解决：

- TTI < 300ms；
- progress event；
- stage + latest action；
- active session independent from Modal lifecycle。

## Risk 5：为了提升成功率引入过多模型调用

解决：

```text
deterministic → existing evidence → small model repair → larger model re-plan → agent rescue
```

只有必要时才升级。

---

# 45. 建议的最终产品语义

## Workflow Generation

用户感知：

> **“AI 正在替你完成这个任务，并把刚才成功完成的操作转换成可重复执行的 Workflow。”**

而不是：

> “AI 正在生成几个 Workflow 节点。”

## Workflow Repair

用户感知：

> **“Workflow 出错了，AI 正在自动修复并重新验证。”**

而不是：

> “AI 给了一个 patch，你要不要自己修。”

## HUMAN_TAKEOVER

用户只在真正的自动化边界看到：

> **“当前问题需要人工操作。”**

而不是因为内部 Repair pipeline 某一步没有产出 patch 就被迫接管。

---

# 46. 最终技术路线图

```text
                    USER INTENT
                         │
                         ▼
               ┌──────────────────┐
               │ Generation Modal │
               └────────┬─────────┘
                        │
                        ▼
                Goal Contract
                        │
                        ▼
               Live Agent Execute
                        │
          ┌─────────────┼─────────────┐
          │             │             │
          ▼             ▼             ▼
       Observe       Recover       Record
          │             │             │
          └─────────────┼─────────────┘
                        ▼
                  Goal Satisfied
                        │
                        ▼
               Workflow Compiler
                        │
                        ▼
             Static Runnability Gate
                        │
                        ▼
                    SAVE
                        │
                        ▼
                  WORKFLOW RUN
                        │
                     failure?
                    /         \
                  no           yes
                  │             │
                  ▼             ▼
                SUCCESS   Repair Orchestrator
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                    Diagnose        Failure Memory
                         │                 │
                         └────────┬────────┘
                                  ▼
                           Strategy Ladder
                                  │
                                  ▼
                            Candidate Patch
                                  │
                                  ▼
                         Static Validate
                                  │
                                  ▼
                         Resume From Checkpoint
                                  │
                                  ▼
                              Execute
                                  │
                                  ▼
                              Verify Goal
                              /          \
                           pass           fail
                            │               │
                            ▼               ▼
                       Commit Revision   Next Strategy
                                            │
                                            ▼
                                      Section Re-plan
                                            │
                                            ▼
                                       Full Re-plan
                                            │
                                            ▼
                                       Agent Rescue
                                            │
                                  exhausted / blocked
                                            │
                                            ▼
                                     HUMAN_TAKEOVER
```

---

# 47. 对本次实施的最终判断

本次不是单纯增加一个“AI 修复按钮”，也不是简单把 `HUMAN_TAKEOVER` 改成自动点击。

真正应该完成的是：

```text
Workflow = executable artifact
Generation = successful execution + compilation
Repair = bounded autonomous experiment loop
Success = goal verified
Commit = verified candidate only
Human = true boundary, not failed AI fallback
```

这会把项目从：

```text
AI 操作网页
+
Workflow 记录器
+
Workflow Debug
```

提升为：

```text
AI Task Executor
+
Workflow Compiler
+
Workflow Runtime
+
Workflow Self-Healing System
```

而且最大限度复用了当前 `develop` 已有的：

- generated-strict reliability；
- goalSpec；
- selector probe；
- runnability hardening；
- checkpoint/resume；
- failure memory；
- debug session；
- rewrite risk；
- workflow revision。

核心新增只有一个真正缺失的中枢：

> **Repair Orchestrator。**

以及一个新的产品入口：

> **Workflow Generation Dialog + 明确、持续的生成进度。**

---

# 48. 代码基线参考

本 Spec 编写时对 `develop` 当前公开代码做了核对，重点参考：

- `package.json`：版本 `0.6.3`、现有 benchmark / typecheck / test / build 命令。
- `AGENTS.md`：commit 必须英文 Conventional Commits；UI 使用 Tailwind；用户文案必须 en + zh-CN；收尾必须 typecheck/test，UI 改动需 build。
- `src/background/workflow-engine/executors.ts`：executor failure contract、rich target、strict resolve policy、read wait 等。
- `src/background/operator-tool-run.ts`：生成动作采用 `resolve → execute → record`，成功后才记录节点。
- `src/lib/workflow/reliability.ts`：generated-strict、goalSpec、node reliability contract。
- `src/lib/workflow/runnability.ts`：generated workflow save-time wait normalization。
- `src/lib/workflow/checkpoints.ts`：checkpoint、workflow fingerprint、resume、side-effect-unknown。
- `src/lib/workflow/failure-memory.ts`：failure signature、retry memory。
- `src/background/selector-probe.ts`：生成/保存前的 selector probe。
- `src/background/index.ts`：当前 debug/takeover session、pending takeover、rewrite verify、takeoverApply。
- `src/sidepanel/ChatTab.tsx`：当前 workflow save / review / verify-run 交互和 `workflowPrompt` 生命周期。
- `specs/2026-09-19-first-run-success-design.md`：已经实施的“一次运行成功率”改造。

> 注意：本 Spec 是针对当前 `develop` 基线的下一阶段实施方案；已有 9/19 first-run-success 设计视为已存在能力，不应重复实现。

---

# 49. Definition of Done

当且仅当以下条件全部成立，才能认为本 Spec 完成：

```text
[Generation]
✓ 简单任务可以稳定完成并生成 Workflow
✓ 用户在生成期间始终能感知状态
✓ Workflow UI 独立 Modal
✓ Workflow 有 GoalSpec / ReliabilityContract
✓ Save gate 生效

[Repair]
✓ ordinary failure 自动修复
✓ no patch proposed 不再直接 takeover
✓ repair strategy 自动升级
✓ candidate 可 rollback
✓ resume 不重复已完成危险动作
✓ goal-aware verification
✓ verified candidate 自动提交 revision

[Safety]
✓ side-effect-unknown 不盲重放
✓ CAPTCHA / 2FA / external auth 仍正确阻断
✓ repair budget 有界

[Observability]
✓ generation progress 可见
✓ repair progress 可见
✓ failure memory 可追踪
✓ repair attempt 有 audit
✓ generation / repair metrics 可统计

[Engineering]
✓ pnpm typecheck
✓ pnpm test
✓ UI 改动 pnpm build
✓ injected 改动 pnpm verify:injected
✓ benchmark 全部通过
```

