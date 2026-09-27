# Browser Copilot：AI 生成工作流高准确率/高成功率改造实施规范

**文档类型：Coding Agent 可直接执行的工程实施任务书**  
**仓库：`dcc123456/browser-copilot`**  
**基线：2026-09-21 检查到的 GitHub `main` 分支**  
**目标：提高 AI 生成 Workflow 的定位准确率、首跑成功率、重放成功率、目标达成率和自动恢复率。**

---

## 0. 给 Coding Agent 的总指令：先执行，再汇报

> 下面这部分可以原样复制给 Claude Code / Codex / Trae / 其他 Coding Agent。

你正在维护 `dcc123456/browser-copilot`。你的任务不是重写 Workflow Engine，而是在当前 `main` 分支实现一套“AI 生成 Workflow Reliability”能力，使 AI 生成的 Workflow 在首次独立运行时更准确、更可预测、更容易自动恢复。

### 0.1 强制规则

1. 开始前必须完整阅读仓库根目录 `AGENTS.md`；`CLAUDE.md` 指向 `AGENTS.md`，以 `AGENTS.md` 为最终规则。
2. 必须先检查当前工作树、分支、HEAD 和现有测试状态。不要假设当前代码等于本规范里的历史描述。
3. 修改前必须定位真实符号和调用链：不要只按“可能存在的文件名”写代码。若路径不同，以当前 `main` 的真实实现为准。
4. 不要重写整个 Workflow Engine。必须增量扩展现有 `kernel / target-to-selector / selector-probe / validation / runnability / executors / engine / run-workflow / debug-session / ai-takeover / operator-tool-run`。
5. 现有手工编辑、录制、导入 Workflow 必须保持兼容。新严格规则默认只作用于 AI 生成 Workflow。
6. 不允许通过扩大 Prompt、增加随机重试、增加固定 sleep 来掩盖 Runtime 问题。
7. AI 修复默认只能生成“局部 Patch”，不得默认重写整张 Workflow 图。
8. 非幂等动作不得盲目 replay。登录、提交、发送、创建、支付、删除等动作必须先做终态检查或使用安全恢复策略。
9. “executor 返回成功”不等于“业务目标成功”。所有 generated-strict Workflow 必须有 Goal Verification。
10. 不得把密码、Cookie、token、session、secret 或其他敏感值写入 Workflow、failure evidence 或普通日志。
11. 每完成一个 Phase，先运行该 Phase 的测试和门禁，再进入下一 Phase。
12. 没有通过最终验收清单，不得声称“可靠性改造完成”。
13. 不要为了本任务顺手重构无关模块；无关问题单独记录。
14. 除非用户要求，不要自动提交 commit。若确实需要 commit，必须遵守 `AGENTS.md` 的英文 Conventional Commit 规则。

### 0.2 最终目标

实现以下执行链：

```text
User Goal
   -> AI Planner / Operator
   -> Reliability Contract
   -> Generated Workflow Hardening
   -> Static Validation
   -> Runtime Precheck
   -> Wait / Resolve / Act
   -> Postcondition
   -> Checkpoint
   -> Goal Verification
   -> Success
             |
             +-> Failure Classifier
                    |
                    +-> deterministic recovery
                    +-> local AI patch
                    +-> verify without AI
                    +-> resume
                    +-> fail closed
```

### 0.3 Definition of Done

本项目只有同时满足以下条件才算完成：

```text
[ ] AI 生成 Workflow 默认进入 generated-strict
[ ] generated-strict 不允许 ambiguous locator 静默 first-visible
[ ] 所有关键 action 有前置条件/等待/后置条件
[ ] non-idempotent action 有终态检查
[ ] Workflow 有结构化 goal
[ ] Runtime 能输出结构化 FailureCode + Evidence
[ ] AI 只能局部 patch，patch 必须 schema 校验
[ ] patch 必须经过“应用后、无 AI takeover”验证
[ ] resume 不重复已经落地的副作用
[ ] 错误达到熔断阈值会 fail closed
[ ] benchmark 能区分 execution success 与 goal success
[ ] generated Workflow 通过静态校验后才能保存/运行
[ ] 旧 Workflow 的 compat 行为不被破坏
[ ] pnpm typecheck 通过
[ ] pnpm test 通过
[ ] pnpm build 通过
[ ] pnpm verify:injected 通过
[ ] pnpm bench:debug 通过或有明确已知限制
```

---

# 1. 当前 main 分支基线：不要重复已经完成的工作

本节只记录本次方案设计时检查到的基线事实。Coding Agent 实施前仍必须以本地 `main` 实际代码为准。

## 1.1 当前已有的可靠性基础

当前 `main` 已经有一轮针对“保存后直接重放失败”的改造，设计文档 `specs/2026-09-19-first-run-success-design.md` 已标记为“已实施”。其核心包括：读取类块增加轮询等待；内核解析优先选择“恰好命中一个”的候选；录制期 selector 做 live probe 并记录 `selectorVerified`；生成 Workflow 保存时固化默认等待；记录 `generationOriginUrl` 和 `provenance`；保存后可选择走现有 debug/repair 流程；运行前提示没有导航锚点的风险。

因此，本任务不要再次实现这些基础功能，而应在这些能力之上继续提高可靠性。

## 1.2 当前关键实现事实

### `src/lib/workflow/types.ts`

当前 Workflow 的核心结构是 `drawflow.nodes / drawflow.edges / trigger / settings / variables` 等。`WorkflowSettings` 已包含 `defaultWaitMs`、`provenance`、`generationOriginUrl` 等字段，Workflow 本身已有 `plan` 字段。新增可靠性元数据时，优先使用可选字段，不破坏现有 JSON。

### `src/inpage/kernel.ts`

内核是“同步、单次注入”的 DOM 操作层。`runOp()` 每次注入页面执行一个观察或动作；等待与重试由 driver/runtime 负责。当前 resolver 已支持 `testid / id / name / css(xpath:...) / role / text` 等策略以及 open shadow roots；`resolve()` 已有唯一命中优先，但 strict 模式仍需要把“多命中”从兼容 fallback 提升为明确失败。

### `src/lib/workflow/target-to-selector.ts`

当前已经保存 rich `target`，并根据候选 selector 做 live probe。`RecordedLocator` 已有 `verified` 字段。role/text 无法稳定转换为纯 CSS 时会保留 rich locator，这是后续 Semantic Locator 的良好入口。

### `src/background/operator-tool-run.ts`

AI 实时操作采用“resolve -> execute -> record”：只有真实执行成功后才记录节点。该原则必须保留，因为它能避免将从未成功执行过的步骤写入 Workflow。

### `src/lib/workflow/validation.ts`

已经有结构验证和 `validateWorkflowForRun()`。当前 run gate 能检查 trigger、required params、manual trigger + 无导航锚点、固定业务值、分支孤儿端口、export 数据源等。下一步是新增“generated Workflow 专用静态校验”，而不是推翻现有 validation。

### `src/background/workflow-engine/engine.ts`

当前 engine 已支持 per-block retry、变量快照恢复、fallback/continue、AI takeover、loop/sub-workflow，以及 checkpoint sink。现有 retry 会恢复失败前的变量快照，但这不应被误认为已经解决所有非幂等副作用问题：浏览器外部状态不会被变量快照回滚。

### `src/background/workflow-engine/run-workflow.ts`

当前运行入口负责 running-task、checkpoint、resume、manual trigger 的 generation-origin warning，并将 `aiTakeover` 注入 engine。resume 会使用最后一个干净 checkpoint 后的节点和变量继续执行。

### `src/background/workflow-engine/debug-session.ts`

当前已有“带 AI takeover 跑一轮 -> 应用内存 patch -> 关闭 AI takeover 验证”的闭环，默认调试轮数为 2，并已有 `alreadySatisfied` 终态逃逸和重复失败熔断。

### `src/lib/workflow/ai-takeover.ts`

当前已有 `auth / captcha / notfound / timeout / network / other` 等高层错误分类、结构化 takeover verdict、低温度默认值以及“只做当前失败节点”的 Prompt 约束。下一步重点不是继续增加长 Prompt，而是让 Runtime 提供结构化 Evidence 和更细粒度的 FailureCode。

### `package.json`

当前脚本包含：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm verify:injected
pnpm bench:debug
pnpm lint
pnpm format:check
```

本任务不得绕过这些现有门禁。

---

# 2. 总体改造原则：把 Workflow 当成“程序”，而不是“动作列表”

当前最容易出现的问题是：AI 生成了一个“看起来合理”的 click/fill/read 序列，但第二次运行时页面状态、DOM、数据、tab、登录态或业务状态不同，导致失败或者更严重的“点错目标但仍然成功”。

因此需要把每一个关键节点从：

```text
Action
```

升级成：

```text
Precondition
   -> Readiness
   -> Target Resolution
   -> Action
   -> Postcondition
```

整个 Workflow 再增加：

```text
Workflow Goal
   -> Goal Verification
```

最终 Runtime 成为：

```text
Validate
 -> Guard
 -> Wait
 -> Resolve
 -> Act
 -> Verify
 -> Checkpoint
 -> Next
```

AI 只负责：

```text
Intent / Planning / Diagnosis / Local Patch
```

Runtime 负责：

```text
Safety / Determinism / Synchronization / Verification / Recovery
```

---

# 3. Phase 0：建立基线、测试夹具和失败分类样本

**目标：在修改代码前先知道“现在的成功率是多少”，并防止后续改动把旧能力弄坏。**

## 3.1 Coding Agent 执行步骤

### Step 0.1：读取仓库规则

```bash
git status --short
git branch --show-current
git rev-parse HEAD
cat AGENTS.md
cat CLAUDE.md
cat package.json
```

要求：工作树状态必须记录；如果存在用户未提交修改，不要覆盖。

### Step 0.2：运行基线门禁

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm verify:injected
pnpm bench:debug
```

若某项基线失败：

```text
1. 记录失败命令
2. 记录失败测试
3. 判断是否与本任务相关
4. 不要将历史失败伪装成本任务回归
5. 后续验收时保持可区分
```

### Step 0.3：建立最小可靠性场景集

新增：

```text
specs/reliability-fixtures/
tests/workflow-reliability-baseline.spec.ts
```

最少覆盖 10 个场景：

```text
R01 页面慢加载
R02 selector 命中 0 个
R03 selector 命中多个
R04 CSS 漂移但 role/name 不变
R05 SPA 路由改变
R06 modal 延迟出现
R07 upstream variable 为空
R08 click 实际发生但后续节点失败
R09 submit 已成功但运行结果在后续节点失败
R10 wrong origin / wrong tab
```

这些场景必须能给出确定性结果；优先使用 jsdom/纯 engine fixture，不要一上来引入新的大型 E2E 依赖。

## 3.2 Phase 0 验收

```text
[ ] git status 已记录
[ ] AGENTS.md 已阅读
[ ] 基线测试结果已记录
[ ] 10 个 reliability fixture 已建立
[ ] 每个 fixture 都有明确 expected outcome
[ ] 没有修改旧 Workflow 行为
```

---

# 4. Phase 1：增加 Workflow Reliability Contract

**目标：让系统知道“哪些 Workflow 需要严格可靠执行”。**

## 4.1 新增文件

```text
src/lib/workflow/reliability.ts
```

建议最小类型：

```ts
export type WorkflowReliabilityMode =
  | 'compat'
  | 'generated-strict'

export type IdempotencyLevel =
  | 'safe'
  | 'conditional'
  | 'unsafe'

export type AmbiguityPolicy =
  | 'error'
  | 'score'
  | 'first-visible'

export interface WorkflowGoalSpec {
  summary: string
  successConditions: WorkflowCondition[]
  terminalStateConditions?: WorkflowCondition[]
}

export interface NodeReliabilitySpec {
  intent?: string
  idempotency: IdempotencyLevel
  preconditions?: WorkflowCondition[]
  postconditions?: WorkflowCondition[]
  readiness?: ReadinessSpec
  locatorPolicy?: LocatorPolicy
}
```

把 Workflow 级配置放在：

```ts
workflow.settings.reliabilityMode?: WorkflowReliabilityMode
workflow.settings.goalSpec?: WorkflowGoalSpec
```

把节点级配置放在：

```ts
node.data.__reliability?: NodeReliabilitySpec
```

原因：现有节点业务参数结构仍然保持原样，旧 Workflow 不需要迁移。

## 4.2 兼容策略

### `compat`

用于：

```text
手工创建
旧版本 Workflow
Automa 导入
无来源信息的历史 Workflow
```

策略：维持当前行为，只增加非破坏性的 warning 和诊断。

### `generated-strict`

只用于：

```text
chat-generate
chat-history
未来的 agent-generated workflow
```

要求：

```text
strict locator
strict ambiguity
precondition
readiness
postcondition
idempotency
goal verification
failure evidence
```

## 4.3 不要在这一阶段做的事

```text
不要修改所有节点 JSON
不要改 UI 保存逻辑的全部结构
不要立即增加新的 workflow node 类型
不要重写 engine
```

## 4.4 Phase 1 验收

```text
[ ] 新旧 Workflow 均能成功反序列化
[ ] 旧 Workflow 默认进入 compat
[ ] AI 生成 Workflow 默认进入 generated-strict
[ ] reliability.ts 有完整单元测试
[ ] node.data.__reliability 不影响旧 block executor
[ ] goalSpec 缺失时 strict Workflow 会被 validator 拦截
```

---

# 5. Phase 2：把 Target 从“selector”升级成“Semantic Locator”

**目标：降低 DOM 漂移造成的误点和误命中。**

## 5.1 当前问题

当前系统已经保留 rich `target`，但 selector 仍是 Workflow 里非常强的身份。对于：

```text
nth-child
动态 class
随机 id
复杂祖先链
```

即使还能找到元素，也可能找到“错误元素”。

strict 模式下必须优先理解：

```text
用户真正想操作的对象是谁？
```

## 5.2 新增文件

```text
src/lib/workflow/locator-score.ts
src/lib/workflow/element-fingerprint.ts
```

## 5.3 Semantic Locator 类型

```ts
export interface SemanticLocator {
  role?: string
  accessibleName?: string
  text?: string
  label?: string
  placeholder?: string
  testId?: string
  stableAttributes?: Record<string, string>
  relation?: {
    nearText?: string
    parentRole?: string
    containerText?: string
  }
}

export interface ElementFingerprint {
  tagName: string
  role?: string
  accessibleName?: string
  normalizedText?: string
  stableAttributes: Record<string, string>
  ancestorRoles?: string[]
  nearbyTexts?: string[]
}
```

不要保存完整 HTML；只保存轻量结构化特征。

## 5.4 Locator Candidate 评分

建议初始权重：

```text
verified testid                    100
role + accessibleName               95
verified stable id                  90
label                               88
name                                85
role + nearby relation              82
stable data-*                       75
exact visible text                  70
CSS                                 35
XPath                               25
nth-child / nth-of-type             10
```

这些数值不是产品 API，不要写死为不可配置常量；应该集中在 `locator-score.ts`。

### 禁止行为

```text
不要因为 CSS 命中 1 个就无条件胜出
不要因为 CSS 是第一候选就覆盖 semantic target
不要把 nth-child 当成稳定身份
不要把随机 hash class 当高可信 locator
```

## 5.5 生成期必须保存

每个元素 action 至少保存：

```json
{
  "target": {
    "primary": {
      "how": "role",
      "value": "发货"
    },
    "fallbacks": [
      {
        "how": "text",
        "value": "发货"
      }
    ]
  },
  "__reliability": {
    "locator": {
      "semantic": {
        "role": "button",
        "accessibleName": "发货",
        "relation": {
          "nearText": "订单 10001"
        }
      },
      "selectorVerified": true
    }
  }
}
```

## 5.6 修改位置

优先修改：

```text
src/lib/workflow/target-to-selector.ts
src/background/selector-probe.ts
src/background/operator-tool-run.ts
src/inpage/kernel.ts
```

不要删除现在已有 `selector` / `target`；新增 semantic metadata，与旧字段并存。

## 5.7 Phase 2 验收

```text
[ ] role/name locator 可独立保存
[ ] selector 不再是唯一身份
[ ] 录制/生成至少保存一种 semantic identity
[ ] DOM fingerprint 不包含敏感大段文本
[ ] 动态 class / random id 被降低权重
[ ] CSS 候选仍可用于兼容旧 Workflow
[ ] locator-score 有 >= 15 个评分单测
[ ] target-to-selector 旧测试全部通过
```

---

# 6. Phase 3：Strict Resolver：多命中必须可解释，不能静默点错

**目标：宁可返回“定位不确定”，也不要误点。**

## 6.1 修改位置

```text
src/inpage/kernel.ts
src/lib/ops.ts
src/background/workflow-engine/executors.ts
```

先阅读 `Target / TargetSpec / Op / OpResult` 的真实定义，再修改。

## 6.2 增加 Resolve Policy

建议：

```ts
export interface ResolvePolicy {
  mode: 'compat' | 'strict'
  ambiguity: 'error' | 'score' | 'first-visible'
  minScore?: number
  minMargin?: number
}
```

`generated-strict` 默认：

```text
mode = strict
ambiguity = score
minScore = 70
minMargin = 12
```

## 6.3 Strict Resolver 决策树

```text
候选 spec
   |
   +-- 0 命中 ----------> LOCATOR_NOT_FOUND
   |
   +-- 1 命中 ----------> SUCCESS
   |
   +-- >1 命中 ---------> score
                           |
                           +-- 最高分不足 ----------> LOCATOR_AMBIGUOUS
                           |
                           +-- 第一/第二差距不足 --> LOCATOR_AMBIGUOUS
                           |
                           +-- 差距足够 ----------> SUCCESS
```

兼容模式继续保留现有 fallback。

## 6.4 必须返回结构化结果

建议扩展 `OpResult`，至少能表达：

```ts
{
  ok: false,
  found: true,
  error: 'locator ambiguous',
  code: 'LOCATOR_AMBIGUOUS',
  matchCount: 3,
  candidates: [
    { strategy: 'role', score: 91 },
    { strategy: 'css', score: 44 }
  ]
}
```

不要把大量 DOM 原文塞进 error 字符串；日志和 AI Evidence 使用结构化字段。

## 6.5 Phase 3 验收

```text
[ ] strict 模式多命中不会 first-visible
[ ] strict 模式 0 命中有明确 code
[ ] score 足够高且 margin 足够大时可以自动选择
[ ] score 不足或 margin 不足时 fail closed
[ ] compat 模式旧行为保持
[ ] kernel injected 自包含规则未被破坏
[ ] pnpm verify:injected 通过
```

---

# 7. Phase 4：统一 Readiness Engine，不再依赖 sleep

**目标：让所有节点基于“状态”同步，而不是基于“猜测时间”。**

## 7.1 新增文件

```text
src/lib/workflow/readiness.ts
src/background/workflow-engine/readiness-engine.ts
```

## 7.2 基本类型

```ts
export type ReadinessState =
  | 'present'
  | 'visible'
  | 'enabled'
  | 'stable'
  | 'navigation-settled'
  | 'value-committed'
  | 'data-ready'

export interface ReadinessSpec {
  before?: ReadinessRequirement[]
  after?: ReadinessRequirement[]
  timeoutMs?: number
  pollIntervalMs?: number
}
```

## 7.3 默认规则

```text
click
  before: present + visible + enabled

fill
  before: present + visible + enabled
  after: value-committed

select
  before: present + visible + enabled
  after: selected-value-confirmed

get-text
  before: present + visible

attribute-value
  before: present

read-page
  before: navigation-settled

navigation
  after: navigation-settled
```

## 7.4 执行器集成方式

不要让每个 executor 自己重新实现一套 wait。

建议在：

```text
engine.ts -> buildExecCtx / executor dispatch
```

附近建立统一入口：

```ts
await prepareNodeExecution(node, ctx)
resolver -> action -> await verifyNodePostcondition(node, ctx)
```

但是要保留特殊块自己的等待，例如下载、tab、webhook、loop 等。

## 7.5 Wait 的三项原则

### 原则 A：命中即返回

不要把 5 秒变成固定等待 5 秒。

### 原则 B：每次 poll 都重新 resolve

不能缓存旧 DOM node。

### 原则 C：navigation 后必须重新建立 page context

不要把旧页面的 element handle、frame 或 selector resolution 状态带进新页面。

## 7.6 Delay block 的地位

`delay` 继续存在，因为兼容 Automa Workflow。

但 generated-strict 不允许依赖 delay 作为唯一同步条件。Validator 应把：

```text
Delay -> Action
```

这种模式标记为 warning；对于关键动作可以标记为 error。

## 7.7 Phase 4 验收

```text
[ ] click/fill/select/get-text/attribute/read-page 使用统一 readiness
[ ] 等待期间重新 resolve
[ ] navigation 后不会复用旧 page context
[ ] wait 超时返回结构化 TIMEOUT / NOT_READY
[ ] delay 仍兼容旧 Workflow
[ ] generated-strict 不再把固定 delay 当主要同步机制
[ ] 慢加载 fixture 的成功率达到 100%（至少 20 次）
```

---

# 8. Phase 5：Precondition / Postcondition / Goal Verification

**目标：把“我点了按钮”与“我完成了任务”彻底区分。**

## 8.1 新增文件

```text
src/lib/workflow/conditions.ts
src/lib/workflow/goal.ts
src/background/workflow-engine/condition-runtime.ts
src/background/workflow-engine/goal-verifier.ts
```

## 8.2 条件类型

```ts
export type WorkflowCondition =
  | { kind: 'urlContains'; value: string }
  | { kind: 'urlMatches'; value: string }
  | { kind: 'elementExists'; target: SemanticLocator }
  | { kind: 'elementVisible'; target: SemanticLocator }
  | { kind: 'elementEnabled'; target: SemanticLocator }
  | { kind: 'elementText'; target: SemanticLocator; expected: string; match: 'exact' | 'contains' }
  | { kind: 'attributeEquals'; target: SemanticLocator; name: string; expected: string }
  | { kind: 'variableEquals'; name: string; expected: unknown }
  | { kind: 'variableExists'; name: string }
  | { kind: 'count'; target: SemanticLocator; op: 'eq' | 'gte' | 'lte'; value: number }
```

## 8.3 Node contract 示例

```json
{
  "blockId": "click-element",
  "__reliability": {
    "intent": "点击订单 10001 的发货按钮",
    "idempotency": "conditional",
    "preconditions": [
      {
        "kind": "elementExists",
        "target": {
          "primary": {
            "how": "text",
            "value": "订单 10001"
          }
        }
      }
    ],
    "postconditions": [
      {
        "kind": "elementText",
        "target": {
          "primary": {
            "how": "text",
            "value": "已发货"
          }
        },
        "expected": "已发货",
        "match": "exact"
      }
    ]
  }
}
```

## 8.4 Goal 必须是可验证的

例如：

```text
用户目标：把订单 10001 标记为已发货
```

生成：

```json
{
  "summary": "订单 10001 已标记为已发货",
  "successConditions": [
    {
      "kind": "elementText",
      "target": {
        "primary": {
          "how": "text",
          "value": "订单 10001"
        }
      },
      "expected": "已发货",
      "match": "contains"
    }
  ]
}
```

## 8.5 Goal Verification 优先级

```text
1. deterministic conditions
2. DOM / URL / variable verification
3. LLM goal judge 作为 fallback
```

不能出现：

```text
LLM 回复“应该成功”
   -> Workflow marked success
```

必须：

```text
LLM judgement
   + evidence available
   + no contradiction
```

## 8.6 Phase 5 验收

```text
[ ] strict Workflow 没有 goalSpec 时保存失败
[ ] 关键 action 没有 postcondition 时 validator 能报告
[ ] executor success 但 goal false 时 Workflow 最终失败
[ ] deterministic goal verifier 可独立运行
[ ] alreadySatisfied 能表示“动作早已发生”
[ ] LLM 不能单独伪造成功
```

---

# 9. Phase 6：Generated Workflow Static Validator

**目标：尽可能在 Workflow 运行之前拦截错误。**

## 9.1 新增文件

```text
src/lib/workflow/generated-validation.ts
```

导出：

```ts
validateGeneratedWorkflow(workflow): GeneratedValidationReport
```

## 9.2 校验层次

### A. Graph

```text
[ ] trigger 存在
[ ] 至少一个 action
[ ] 所有 edge source/target 有效
[ ] 不存在不可达关键节点
[ ] branch 关键分支有去向
[ ] loop 有终止机制或最大次数
[ ] 子 Workflow 无明显循环依赖
```

### B. Data flow

```text
[ ] 所有 {{variable}} 都能找到 producer 或 declared input
[ ] producer 在 consumer 之前或可证明存在
[ ] output variable 不被意外覆盖
[ ] sensitive value 不进入普通 params
```

### C. Locator

```text
[ ] element action 有 target
[ ] generated-strict 不接受 empty rich target
[ ] selectorVerified=false 且没有 semantic target -> warning/error
[ ] ambiguity policy != first-visible
[ ] 禁止高风险 nth-child 作为唯一 locator
```

### D. Readiness

```text
[ ] action 有 readiness
[ ] read block 有 present 等待
[ ] fill 有 value-committed 验证
[ ] navigation 后有 settle
```

### E. Side effect

```text
[ ] unsafe action 有 terminal-state check
[ ] retry policy 与 idempotency 一致
[ ] checkpoint policy 存在
```

### F. Goal

```text
[ ] goalSpec 存在
[ ] goalSpec 至少有一个 successCondition
[ ] Workflow 有明确 final verification
```

## 9.3 Hook 点

不要只在 import 时调用。

必须至少接入：

```text
1. workflows.save(fromGeneration=true)
2. workflow manual run
3. scheduled run
4. debug-session verify run
5. import 后如果 mode=generated-strict
```

旧 Workflow 在 `compat` 下继续走已有 `validateWorkflow()` / `validateWorkflowForRun()`。

## 9.4 Validation Report

```ts
interface GeneratedValidationIssue {
  code: string
  severity: 'error' | 'warning' | 'info'
  nodeId?: string
  path?: string
  message: string
  suggestedFix?: string
}
```

不要只返回字符串数组；需要 machine-readable code，UI 才能展示、Agent 才能自动修复。

## 9.5 Phase 6 验收

```text
[ ] 至少 25 个 validator unit tests
[ ] 缺 locator 能在 run 前拦截
[ ] 缺 variable producer 能在 run 前拦截/告警
[ ] unsafe action 无 terminal state 会拦截
[ ] 缺 goal 会拦截
[ ] invalid graph 不会启动浏览器操作
[ ] compat Workflow 不被 strict 规则误杀
```

---

# 10. Phase 7：Failure Classifier + Evidence Bundle

**目标：失败后不要只给 LLM 一句“element not found”，而要告诉它为什么失败。**

## 10.1 新增文件

```text
src/lib/workflow/failure-code.ts
src/lib/workflow/execution-evidence.ts
src/background/workflow-engine/failure-classifier.ts
```

## 10.2 建议 FailureCode

```ts
export type FailureCode =
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_AMBIGUOUS'
  | 'LOCATOR_STALE'
  | 'PAGE_NOT_READY'
  | 'WRONG_ORIGIN'
  | 'WRONG_TAB'
  | 'WRONG_FRAME'
  | 'NAVIGATION_TIMEOUT'
  | 'ACTION_REJECTED'
  | 'POSTCONDITION_FAILED'
  | 'GOAL_NOT_ACHIEVED'
  | 'VARIABLE_INVALID'
  | 'AUTH_REQUIRED'
  | 'CAPTCHA_REQUIRED'
  | 'NETWORK_ERROR'
  | 'SIDE_EFFECT_UNKNOWN'
  | 'EXECUTOR_ERROR'
```

保留现有 `TakeoverReasonKind` 作为高层 UI/统计分类：

```text
auth / captcha / notfound / timeout / network / other
```

内部使用更细的 FailureCode。

## 10.3 Evidence Bundle

```ts
interface ExecutionEvidence {
  runId: string
  workflowId: string
  nodeId: string
  failureCode: FailureCode
  errorMessage?: string
  currentUrl?: string
  expectedOrigin?: string
  currentTitle?: string
  currentTabId?: number
  frameUrl?: string
  targetSummary?: unknown
  matchCount?: number
  matchedCandidates?: unknown[]
  recentSteps: DebugStepLine[]
  relevantVariables: Record<string, unknown>
  preconditionResults?: ConditionResult[]
  postconditionResults?: ConditionResult[]
  pageSummary?: string
  failureMemory?: string
}
```

### 敏感信息规则

```text
[ ] password/token/cookie 不写入 evidence
[ ] secret variable 不进入 model prompt
[ ] 页面大段 HTML 不直接发送
[ ] relevantVariables 只包含本节点所需变量
[ ] 日志字符串做长度上限
```

## 10.4 分类优先级

```text
CAPTCHA / AUTH
 > WRONG_ORIGIN / TAB / FRAME
 > LOCATOR_AMBIGUOUS / NOT_FOUND
 > PAGE_NOT_READY
 > VARIABLE_INVALID
 > NETWORK
 > ACTION_REJECTED
 > POSTCONDITION
 > OTHER
```

不要仅靠关键词。关键词只能是 fallback；优先使用 Runtime 真实状态。

## 10.5 Phase 7 验收

```text
[ ] 每个 failed node 至少有一个 FailureCode
[ ] locator failure 能区分 0 命中和多命中
[ ] wrong origin 能区分
[ ] page not ready 能区分 timeout
[ ] postcondition failure 不再被误报为 selector failure
[ ] evidence 不含 secret
[ ] AI takeover prompt 可以消费结构化 evidence
```

---

# 11. Phase 8：AI Local Patch，不允许默认重写 Workflow

**目标：AI 只修“最小必要变化”。**

## 11.1 修改位置

```text
src/lib/workflow/auto-debug-patch.ts
src/lib/workflow/ai-takeover.ts
src/background/workflow-engine/debug-session.ts
```

## 11.2 Patch 类型

建议增加：

```ts
export type ReliabilityPatch =
  | {
      kind: 'locator'
      nodeId: string
      target?: SemanticLocator
      selector?: string
    }
  | {
      kind: 'readiness'
      nodeId: string
      readiness: ReadinessSpec
    }
  | {
      kind: 'condition'
      nodeId: string
      preconditions?: WorkflowCondition[]
      postconditions?: WorkflowCondition[]
    }
  | {
      kind: 'parameter'
      nodeId: string
      paramsPatch: Record<string, unknown>
    }
```

## 11.3 明确禁止

AI Patch 不允许：

```text
[禁止] 修改 blockId
[禁止] disableBlock=true 静默关闭节点
[禁止] 删除其他节点
[禁止] 改 edges
[禁止] 改 trigger
[禁止] 改 variables declaration
[禁止] 直接改 secret
[禁止] 一次 patch 多个无关节点
```

特殊情况：如果证据明确表明 upstream producer 才是根因，可以 `nodeId` 指向 upstream 节点，但一次只允许修一个“根因节点”。

## 11.4 Patch 应用链

```text
Failure
  -> classify
  -> build Evidence
  -> AI local patch
  -> validate patch
  -> apply in memory
  -> run patched workflow WITHOUT AI takeover
  -> verify Goal
  -> only then persist
```

注意：当前 debug session 已经有“in-memory patch -> takeover-free verify -> 用户确认后落盘”的基础，不要破坏该设计。

## 11.5 Patch confidence

建议 Patch 增加：

```ts
confidence: number // 0..1
reason: string
```

规则：

```text
confidence < 0.75 -> 不自动应用
0.75..0.9         -> 应用到内存并验证
>0.9              -> 可进入自动验证链，但仍不得跳过 verification
```

不要让 confidence 单独决定成功；它只决定是否允许进入 patch pipeline。

## 11.6 Phase 8 验收

```text
[ ] AI 只能返回局部 patch
[ ] patch schema 无效会被拒绝
[ ] patch 不允许修改 blockId / disableBlock
[ ] patch 默认只影响一个 node
[ ] patch 必须经过 takeover-free verify
[ ] verify 失败时 patch 不落盘
[ ] 同一失败 + 同一 patch 连续出现会触发熔断
```

---

# 12. Phase 9：幂等、终态检查与 Resume 事务边界

**目标：解决最危险的一类问题：第一次其实已经成功，但后续失败导致系统再次执行有副作用的动作。**

## 12.1 分类

```text
safe
  click tab
  read
  scroll
  navigation

conditional
  fill
  select
  toggle
  update existing data

unsafe
  login
  submit
  send
  create
  delete
  pay
  publish
```

实际分类由 block + intent 决定，不要只按 blockId 硬编码。

## 12.2 Unsafe action 执行前必须检查

```text
terminalStateAlreadySatisfied?
    |
    +-- yes -> alreadySatisfied / skip action
    |
    +-- no -> execute
```

执行后必须：

```text
postcondition
   -> checkpoint commit
```

## 12.3 Checkpoint 语义

当前 engine 已有“节点 settle 就写 checkpoint”。本阶段需要进一步增加：

```text
nodeStarted
nodePrechecked
sideEffectStarted
sideEffectObserved
nodeCommitted
```

不一定全部持久化成独立文件，但至少要有内部状态/日志语义，使恢复时知道：

```text
“这个副作用有没有可能已经发生？”
```

如果是 `SIDE_EFFECT_UNKNOWN`，禁止盲目 replay；先走 terminal-state verification。

## 12.4 Resume Guard

恢复前需要验证：

```text
workflow version / fingerprint
origin
current origin
current tab
current frame
critical variables
checkpoint node still exists
```

如果不匹配：

```text
resume denied
 -> fresh verification / manual recovery
```

而不是直接从 checkpoint 继续。

## 12.5 Phase 9 验收

```text
[ ] login 已成功后后续失败，resume 不会再次 submit login
[ ] submit 已落地后重试会先检查终态
[ ] unknown side effect 不会直接 replay
[ ] checkpoint 包含足够的上下文指纹
[ ] workflow 版本变化后 resume 会被拒绝或重新验证
[ ] 重启 service worker 后恢复逻辑仍有效
```

---

# 13. Phase 10：Origin / Tab / Frame Guard

**目标：防止“在错误页面上正确执行了一遍错误 Workflow”。**

## 13.1 Page Context Fingerprint

新增：

```text
src/lib/workflow/page-context.ts
```

建议：

```ts
interface PageContextFingerprint {
  origin: string
  pathnamePattern?: string
  titleHint?: string
  requiredAnchors?: SemanticLocator[]
}
```

## 13.2 Strict 首次动作前检查

对于：

```text
manual trigger + no navigation anchor
```

不仅 warning，还要做：

```text
origin guard
anchor guard
```

例如：

```text
current origin != generation origin
   -> WRONG_ORIGIN

origin same but required anchor not found
   -> WRONG_PAGE
```

不建议第一阶段把“路径不一样”一律阻断，因为很多 SPA 的 path 会动态变化；优先通过 required anchors 判断。

## 13.3 Tab / Frame

每次：

```text
new-tab
switch-tab
navigation
iframe transition
shadow root transition
```

都要刷新 page context。

## 13.4 Phase 10 验收

```text
[ ] wrong origin 在 strict mode 可阻断
[ ] same origin wrong page 能通过 anchor 识别
[ ] tab 切换后重新绑定 targetTabId
[ ] navigation 后旧 locator context 无法继续使用
[ ] iframe context 错误有明确 FailureCode
```

---

# 14. Phase 11：Workflow Certification + Benchmark

**目标：让“成功率”变成可测量的工程指标，而不是体感。**

## 14.1 指标必须拆开

不要只记录：

```text
run ok / failed
```

至少记录：

```text
executionSuccess
 goalAchieved
 takeoverUsed
 patchApplied
 retries
 terminalStateRecovered
 locatorAmbiguous
 locatorNotFound
 readinessTimeout
 wrongOrigin
 wrongTab
 postconditionFailed
 totalDuration
```

## 14.2 三层成功率

### L1 Runtime Success

所有节点都执行完，没有错误。

### L2 Verification Success

执行完 + Node postconditions 通过。

### L3 Business Goal Success

执行完 + Goal Verification 通过。

生产质量主要看 L3。

## 14.3 Benchmark 设计

建立：

```text
scripts/bench-workflow-reliability.mjs
specs/reliability-benchmark.md
tests/reliability-benchmark.spec.ts
```

每个场景至少跑：

```text
10 次普通运行
10 次慢加载
10 次 DOM 漂移
10 次相同错误 replay
10 次 service-worker restart/resume
```

总样本数按测试时间可缩减，但 CI 至少保留 deterministic smoke set。

## 14.4 目标门槛

建议第一阶段工程门槛：

```text
关键 fixture L3 success >= 95%
locator ambiguity false-positive = 0
wrong-origin accidental action = 0
unsafe action double-execution = 0
patch verification bypass = 0
secret leakage = 0
```

这些是**验收门槛建议**，不是当前系统已有成绩。实施前必须先测 baseline，再用实测结果确认是否达标。

## 14.5 Certification 状态

```text
Draft
  -> Validated
  -> Verified
  -> Certified
  -> Stale
```

`Certified` 至少需要：

```text
最近一次无 AI takeover 成功
Goal 达成
没有 unrecoverable warning
benchmark smoke 通过
page context 未明显漂移
```

## 14.6 Phase 11 验收

```text
[ ] benchmark 输出结构化统计
[ ] execution success 与 goal success 分开
[ ] 能统计 failure code
[ ] 能统计 AI takeover 次数
[ ] unsafe double execution 有专门测试
[ ] 有 Certification 状态
```

---

# 15. Phase 12：把 AI 生成 Prompt 改成“契约式生成”

**目标：减少生成阶段产生低质量 Workflow 的概率。**

注意：这一阶段必须放在 Runtime Contract 已实现之后。不要指望 Prompt 代替 Runtime。

## 15.1 生成 Prompt 必须明确

```text
你不是 CSS/XPath 生成器。
你是 Browser Workflow Planner。

你必须为每个关键动作定义：
1. intent
2. target semantic identity
3. precondition
4. readiness
5. action
6. postcondition
7. idempotency
8. failure recovery

规则：
- 不允许把 nth-child 作为唯一 target
- 不允许使用固定 sleep 作为关键同步
- 不允许在没有 goal verification 时宣称成功
- 非幂等 action 必须有 terminal-state check
- 每个 target 必须来自当前页面真实观察
- 遇到多命中目标，必须重新观察并缩小范围
- 生成后必须通过 Workflow Validator
```

## 15.2 生成流程

推荐：

```text
Observe page
  -> identify semantic targets
  -> perform live action
  -> verify action
  -> record node
  -> attach reliability contract
  -> validate partial graph
  -> continue
```

而不是：

```text
LLM 一次输出整张 Workflow JSON
```

## 15.3 关键策略

生成时每执行一个 action：

```text
真实执行成功
 + 目标存在
 + action outcome 已验证
 + 下一步依赖信息可用
 -> 才允许记录/继续
```

这与当前 `operator-tool-run.ts` 的“成功才记录”原则一致，应继续强化。

## 15.4 Phase 12 验收

```text
[ ] Prompt 不再鼓励纯 selector-first
[ ] 每个关键 action 都要求 outcome
[ ] unsafe action 必须有 terminal state
[ ] 生成后的 graph 自动 validator
[ ] validator fail 时不得直接保存成 generated-strict
```

---

# 16. 推荐的最终 Runtime 状态机

Coding Agent 实现完成后，逻辑应接近：

```text
                    +------------------+
                    |      PENDING     |
                    +---------+--------+
                              |
                              v
                    +------------------+
                    |      VALIDATE    |
                    +---------+--------+
                              |
                    invalid   | valid
                       +------v------+
                       |   PRECHECK  |
                       +------+------+
                              |
                              v
                    +------------------+
                    |     READINESS   |
                    +---------+--------+
                              |
                              v
                    +------------------+
                    |     RESOLVE     |
                    +----+--------+---+
                         |        |
                      unique   ambiguous
                         |        |
                         v        v
                 +----------+  FAILURE
                 |   ACT    |     |
                 +----+-----+     v
                      |       CLASSIFY
                      v          |
                 +----------+    +------------------+
                 |  VERIFY  |    | deterministic    |
                 +----+-----+    | recovery        |
                      |          +--------+---------+
                 success                  |
                      |                   v
                      v             +-----------+
                 +----------+       | AI Patch  |
                 |CHECKPOINT|       +-----+-----+
                 +----+-----+             |
                      |                   v
                      v             verify without AI
                 +----------+             |
                 |   NEXT   |<------------+
                 +----+-----+
                      |
                    final
                      |
                      v
                 +-----------+
                 | GOAL VERIFY|
                 +-----+-----+
                       |
               +-------+-------+
               |               |
            achieved        not achieved
               |               |
             SUCCESS         FAILURE
```

---

# 17. 文件级实施清单

下面是 Coding Agent 最终应逐项核对的文件清单。路径是“优先修改/新增位置”，如果当前 main 有同职责的不同路径，先定位真实模块再修改。

## 17.1 核心新增

```text
src/lib/workflow/reliability.ts
src/lib/workflow/locator-score.ts
src/lib/workflow/element-fingerprint.ts
src/lib/workflow/readiness.ts
src/lib/workflow/conditions.ts
src/lib/workflow/goal.ts
src/lib/workflow/generated-validation.ts
src/lib/workflow/failure-code.ts
src/lib/workflow/execution-evidence.ts
src/lib/workflow/page-context.ts
src/background/workflow-engine/readiness-engine.ts
src/background/workflow-engine/condition-runtime.ts
src/background/workflow-engine/goal-verifier.ts
src/background/workflow-engine/failure-classifier.ts
```

## 17.2 核心修改

```text
src/lib/workflow/types.ts
src/lib/workflow/validation.ts
src/lib/workflow/runnability.ts
src/lib/workflow/target-to-selector.ts
src/lib/workflow/ai-takeover.ts
src/lib/workflow/auto-debug-patch.ts
src/background/selector-probe.ts
src/background/operator-tool-run.ts
src/inpage/kernel.ts
src/background/workflow-engine/executors.ts
src/background/workflow-engine/engine.ts
src/background/workflow-engine/run-workflow.ts
src/background/workflow-engine/debug-session.ts
src/background/index.ts
```

## 17.3 测试新增/修改

```text
tests/workflow-reliability-contract.spec.ts
tests/locator-score.spec.ts
tests/semantic-locator.spec.ts
tests/kernel-resolve-strict.spec.ts
tests/readiness-engine.spec.ts
tests/workflow-conditions.spec.ts
tests/goal-verifier.spec.ts
tests/generated-validation.spec.ts
tests/failure-classifier.spec.ts
tests/evidence-redaction.spec.ts
tests/reliability-patch.spec.ts
tests/unsafe-action-resume.spec.ts
tests/page-context.spec.ts
tests/workflow-reliability-benchmark.spec.ts
```

---

# 18. Coding Agent 每个 Phase 的固定执行模板

每个 Phase 都必须按以下流程执行，不得直接跳到下一 Phase：

```text
Step A 读取相关代码
Step B 列出当前真实调用链
Step C 写/更新测试
Step D 实现最小改动
Step E 跑相关测试
Step F 跑 typecheck
Step G 复查 diff
Step H 写本 Phase completion report
Step I 再进入下一 Phase
```

## Completion Report 模板

```md
## Phase X Completion

### Changed
- path/to/file.ts: ...

### Behavior
- ...

### Tests
- pnpm test -- ...
- pnpm typecheck

### Acceptance
- [x] ...
- [ ] ...

### Known limitations
- ...

### Regression risk
- low / medium / high
```

如果有任何 `[ ]`，不要写“Phase 完成”，应该写“Phase partially complete”。

---

# 19. 最终验收清单：Coding Agent 交付前逐项勾选

## A. 生成准确性

```text
[ ] 生成 Workflow 有明确 goal
[ ] 每个关键 action 有 intent
[ ] 每个 element action 有 semantic locator
[ ] selectorVerified 状态真实反映 live probe
[ ] 不以 nth-child 作为唯一定位
[ ] 生成阶段不存在空 role / 空 target
[ ] 变量引用全部可追踪
```

## B. 执行准确性

```text
[ ] strict locator 多命中不会误点
[ ] strict locator 找不到时不会静默执行其他元素
[ ] 页面慢时通过 readiness 恢复
[ ] navigation 后会重新解析目标
[ ] tab/frame 切换不会继续使用旧 context
```

## C. 结果正确性

```text
[ ] 每个关键 action 有 postcondition
[ ] Workflow 有最终 goal verification
[ ] executor success 但 goal false 会失败
[ ] alreadySatisfied 能识别早已完成的业务目标
```

## D. 恢复能力

```text
[ ] transient error 可 deterministic retry
[ ] locator error 走 re-resolve
[ ] wrong page 走 context recovery
[ ] auth/captcha 不会无限消耗 AI rounds
[ ] repeated failure 会熔断
[ ] unsafe action 不会盲目 replay
[ ] resume 使用 checkpoint + context guard
```

## E. AI 修复安全

```text
[ ] AI 只能生成局部 patch
[ ] patch 有 schema
[ ] patch 有 allowlist
[ ] patch 必须验证
[ ] 验证失败 patch 不落盘
[ ] AI 不能修改 blockId / disableBlock / edges / trigger
```

## F. 安全与隐私

```text
[ ] password 不写日志
[ ] secret 不进入 Evidence
[ ] cookie/token 不进入 Prompt
[ ] page dump 有大小限制
[ ] evidence 脱敏测试通过
```

## G. 回归

```text
[ ] compat Workflow 回归通过
[ ] generated-strict Workflow 回归通过
[ ] recorder 回归通过
[ ] imported Automa Workflow 回归通过
[ ] scheduler/manual/debug 三条入口都通过
[ ] server runner 仍能运行
```

## H. 工程门禁

```text
[ ] pnpm typecheck
[ ] pnpm test
[ ] pnpm build
[ ] pnpm verify:injected
[ ] pnpm bench:debug
[ ] pnpm lint
[ ] pnpm format:check
```

---

# 20. 完成后必须给用户的最终报告格式

Coding Agent 完成后，只能按以下结构汇报：

```md
# Workflow Reliability Implementation Report

## 1. Result
- generated-strict implemented: yes/no
- current main compatibility: pass/fail

## 2. Implemented phases
- Phase 0: ...
- Phase 1: ...
- ...

## 3. Key files changed
- ...

## 4. Runtime behavior changes
- ...

## 5. Reliability metrics
- baseline first-run goal success: ...
- current first-run goal success: ...
- locator ambiguity rate: ...
- unsafe double-execution count: ...
- takeover-free verification rate: ...

## 6. Tests
- pnpm typecheck: PASS/FAIL
- pnpm test: PASS/FAIL
- pnpm build: PASS/FAIL
- pnpm verify:injected: PASS/FAIL
- pnpm bench:debug: PASS/FAIL

## 7. Known limitations
- ...

## 8. Remaining unchecked acceptance items
- ...
```

禁止只输出：

```text
“已完成，测试通过。”
```

必须提供真实测试命令和结果。

---

# 21. 实施优先级建议

如果 Coding Agent 无法一次完成全部 Phase，不允许随意挑选，必须按以下顺序：

```text
P0
  1. Reliability Contract
  2. Strict Resolver
  3. Readiness
  4. Postcondition + Goal Verification
  5. Generated Validator

P1
  6. Failure Evidence
  7. Local AI Patch
  8. Unsafe action / terminal-state recovery

P2
  9. Origin / tab / frame guard
  10. Benchmark / certification
  11. Prompt hardening
```

原因：

```text
P0 解决“错定位、没等到、做了但不知道是否成功”
P1 解决“失败以后如何安全恢复”
P2 解决“如何量化和规模化”
```

不要在 P0 未完成时先做大量 UI 优化或 Prompt 调优。

---

# 22. 关键设计结论

整个改造最终要形成四层职责边界：

```text
AI Planner
  负责：意图、计划、目标、诊断

Workflow Compiler / Hardener
  负责：semantic locator、wait、conditions、可靠性元数据

Workflow Runtime
  负责：resolve、wait、action、verify、checkpoint、resume

AI Repair Agent
  负责：Failure Diagnosis + Local Patch
```

最重要的工程原则只有一句：

> **让 AI 可以犯“可修复的错”，而不是让 Runtime 必须相信 AI 永远正确。**

只要 generated-strict 最终满足：

```text
错误定位 -> 不执行
页面未就绪 -> 等待
多命中 -> 重新判断
副作用可能已发生 -> 查终态
节点失败 -> 提供 Evidence
AI 修复 -> 只改一个局部点
修复后 -> 无 AI 独立验证
目标不满足 -> 不报告成功
```

这个系统才真正从“AI 生成自动化脚本”升级成了“可验证、可恢复的浏览器自动化运行时”。

---

# 23. 参考基线文件

以下是本次方案校验时重点参考的当前 `main` 文件：

```text
README.md
AGENTS.md
CLAUDE.md
package.json
specs/2026-09-19-first-run-success-design.md
src/lib/workflow/types.ts
src/lib/workflow/target-to-selector.ts
src/lib/workflow/validation.ts
src/lib/workflow/auto-debug-patch.ts
src/lib/workflow/ai-takeover.ts
src/inpage/kernel.ts
src/background/operator-tool-run.ts
src/background/workflow-engine/executors.ts
src/background/workflow-engine/engine.ts
src/background/workflow-engine/run-workflow.ts
src/background/workflow-engine/debug-session.ts
```

仓库：`https://github.com/dcc123456/browser-copilot`

---

**文档结束。**
