# Browser Copilot：工作流生成 Operator Selection + Goal Contract 自动实现 Spec

> 目标：让 Workflow Generation 从“LLM 直接在大量 `wf_op_*` 中试错”升级为“先定义目标与成功标准 → 基于语义与页面证据快速检索少量候选算子 → 原生算子优先执行 → 失败自动分型与升级 → 形成带 Goal/Success Criteria 的完整 Workflow → 最终按 Workflow Goal 验证”。
>
> 本文面向 AI Coding Agent，可直接执行。实现时必须以当前 `develop` 分支代码为准，不假设文件位置；若目录结构发生变化，先通过符号/引用搜索定位对应模块，再实施修改。

---

## 1. 背景与当前问题

当前 Workflow Generation 的核心机制是：`wf_op_*` 工具真实执行 Block，只有执行成功才把节点追加到会话 Draft。这保证了“记录下来的节点确实执行过”，但也让模型同时承担任务理解、页面探索、算子选择、参数构造、Workflow 结构构造等职责。

当前仓库已经存在：

- Block Capability Catalog
- `use_operators` 分类加载
- JS escape hatch
- Workflow GoalSpec / postconditions
- Reliability / Goal verification
- Unified Repair / Replay
- AI-prefill 对动态文案自动插入 `ai-agent` 的机制

这些能力必须整合为一条真正的 Workflow Generator 主链路，而不是继续依赖 Prompt 让模型自行记忆规则。

本 Spec 解决以下具体问题：

1. `find_workflow_operators` 找到的候选算子全部执行失败时，如何继续可靠地完成任务，而不是随机换工具或直接使用 JS。
2. 控制流/数据流/验证/浏览器能力不能依赖少数中文关键词；需要中文 + 英文、词组 + 语义模式 + 页面证据的组合判定。
3. `ai-agent` 不能作为默认万能工具，但对于动态生成文案、基于页面内容生成回复/摘要/个性化文本等任务必须能够被快速发现和使用。
4. 每个生成节点必须具备结构化 Goal，并且用户在 Workflow 编辑器中可以看到 Goal；Goal 不能只存在于不可见的 `description`。
5. Workflow 在开始生成前必须先建立完整的 Workflow Goal Contract。
6. 最终成功判断必须是“Workflow Goal 成功”，而不是“最后一个 Block 没报错”。
7. AI Repair 必须同时依据 Node Goal / Node Success Criteria / Workflow Goal / Evidence 进行修复和验证。

---

# 2. 总体设计原则

## 2.1 核心原则

### Principle A：LLM 决定“做什么”，系统决定“用哪个可执行实现”

LLM 负责：

- 任务理解
- Workflow Goal
- Success Criteria
- Required Capabilities
- 当前步骤的语义意图
- 在少量候选中的选择
- 修复假设

系统负责：

- Operator Registry
- 候选排序
- 参数约束
- Tool Schema 加载
- 页面 Target grounding
- Node metadata
- Graph 编译
- Validation
- Goal Verification
- Repair Replay

禁止让 LLM 直接从完整 Block Catalog 中自由搜索并自行决定所有底层细节。

---

## 2.2 Native-first 原则

算子选择必须遵循以下优先级：

```text
原生确定性 Operator
    >
多个原生 Operator 组合
    >
AI Agent（语义推理/动态文案/动态内容生成）
    >
JavaScript Escape Hatch
```

### JavaScript 规则

- `javascript-code` 不能进入普通 Operator Discovery 候选池。
- 不允许模型因为“觉得 JS 更方便”而选择 JS。
- JS 只能在：
  1. 没有现有原生 Operator 能表达目标；或
  2. 原生 Operator 组合也无法表达目标；或
  3. 经过明确能力缺口判定后，确实需要自定义 DOM/计算逻辑；
  才可以进入候选。
- JS 使用必须记录结构化 justification：
  - `missingCapability`
  - `triedOperators[]`
  - `whyInsufficient`
  - `expectedResult`
- 如果只是“找元素、填写、点击、读取、等待、条件、循环、数据转换”等已有能力，必须拒绝 JS。

---

## 2.3 AI Agent 不是普通默认工具，但属于正式 Capability

`ai-agent` 不应在默认工具面板中和 `click/forms/get-text` 平级无限制暴露，但必须作为 `semantic_generation` / `semantic_reasoning` 能力存在。

### 必须主动考虑 AI Agent 的场景

中文：

- 写一段
- 生成文案
- 生成回复
- 撰写回复
- 根据页面内容回复
- 根据客户信息生成个性化内容
- 总结后生成文本
- 改写
- 润色
- 翻译后生成
- 根据上下文组织答案
- 自动拟定邮件正文
- 自动填写需要推理/创作的内容
- 根据网页内容决定应该填写什么

英文：

- write
- draft
- compose
- generate text
- generate a reply
- draft a response
- personalized message
- personalized email
- summarize and write
- rewrite
- rephrase
- polish
- translate and compose
- formulate an answer
- decide what to enter based on page content
- generate content from page/context
- create a response

### 不应使用 AI Agent 的场景

- 直接填入用户提供的固定值
- 直接读取元素文本
- 从属性中读取 URL
- 简单字符串拼接
- 简单 regex
- slice / sort / map / filter 等确定性数据处理
- 简单日期/数字转换（已有确定性 Operator 可以表达时）

### 动态文案生成的数据流

标准形态必须是：

```text
页面/变量数据
    ↓
ai-agent
    ↓
output variable
    ↓
forms / insert-data / save-local / etc.
```

不得再次把动态生成内容冻结成硬编码 literal。

必须复用并统一现有 AI-prefill 机制：当模型明确表示填充值是“模型生成内容”时，系统自动插入一个 `ai-agent` Producer，再让 `forms` 消费其变量。

---

# 3. 新的 Workflow Generation 主流程

最终流程：

```text
User Request
    ↓
prepare_workflow_goal
    ↓
WorkflowGoalSpec
    ↓
derive_required_capabilities
    ↓
page grounding / snapshot
    ↓
find_workflow_operators
    ↓
Top 3-5 candidates
    ↓
execute selected operator
    ↓
Node Contract Verification
    ├─ success → record Node + continue
    └─ failure → failure classification
                    ↓
              recovery / retry / re-ground
                    ↓
              expanded operator search
                    ↓
              composition / AI Agent / JS
    ↓
Workflow IR
    ↓
Static Validation
    ↓
Workflow Replay
    ↓
Workflow Goal Verification
    ↓
Certified Workflow
```

### 强制要求

在第一个 `wf_op_*` 之前必须已经存在：

- workflow name
- goal
- success criteria
- required capabilities

如果没有 Goal Contract，所有 `wf_op_*` 必须被 dispatcher 拒绝，并要求先调用 `prepare_workflow_goal`。

---

# 4. Workflow Goal Contract

新增或升级 Workflow Intent / Goal Contract，建议结构：

```ts
export interface WorkflowGoalSpec {
  summary: string
  successConditions: WorkflowCondition[]
  terminalStateConditions?: WorkflowCondition[]
  constraints?: string[]
  requiredCapabilities?: WorkflowCapability[]
  expectedInputs?: WorkflowInputSpec[]
}
```

如果仓库已有 `WorkflowGoalSpec` 类型，优先扩展现有类型，禁止创建第二套并行类型。

## 4.1 `prepare_workflow_goal`

新增 Workflow-only tool：

```ts
prepare_workflow_goal({
  name,
  summary,
  successConditions,
  terminalStateConditions?,
  constraints?,
  requiredCapabilities?,
  expectedInputs?
})
```

### 工具职责

- 校验 Goal Contract
- 设置 Workflow Draft name
- 设置 Trigger Goal
- 保存 Workflow Intent
- 为后续 operator discovery 提供检索上下文
- 不执行页面操作
- 不记录 Workflow Action Node

### 强制规则

以下任何情况都必须拒绝：

- `summary` 为空
- `successConditions` 为空
- `name` 是 `workflow-*` / `test` / `new workflow` 等无意义名称
- Goal 与用户请求明显不一致

### Workflow Name 规则

名称必须表达任务结果，不允许随机 ID 名称。

推荐格式：

```text
创建客户记录并验证创建成功
抓取商品列表并保存为 CSV
提交采购申请并确认提交成功
批量检查订单状态并标记异常订单
Generate and verify customer reply draft
Extract product data and save to CSV
```

名字应优先由 GoalSpec 自动生成，再允许模型提供候选名称；系统做最终规范化。

---

# 5. Trigger Goal Contract

Trigger 节点必须保存：

```ts
trigger.data.workflowGoal = {
  summary,
  successConditions,
  terminalStateConditions,
}
```

同时保留现有 `description` 作为展示兼容字段，但它不是 canonical source。

触发器展示必须明确：

```text
Workflow Goal
创建一个新的客户记录

Success Criteria
✓ 客户创建成功提示出现
✓ 新客户记录存在
✓ 不发生重复提交
```

如果触发器 description 为空，生成完成前必须自动由 GoalSpec 渲染并补齐。

---

# 6. Node Goal Contract

不要只扩充普通 `description`，新增统一 metadata namespace，推荐：

```ts
export interface WorkflowNodeGoalContract {
  version: 1
  goal: string
  successCriteria: WorkflowCondition[]
  preconditions?: WorkflowCondition[]
  failureMeaning?: string[]
  evidence?: EvidenceSpec[]
  repairHints?: RepairHint[]
}
```

存储于：

```ts
node.data.__workflowAi.goalContract
```

不得把这些字段散落在 block-specific params 中。

## 6.1 每个生成 Node 必须有 Goal

例如：

```json
{
  "goalContract": {
    "goal": "打开创建客户表单",
    "successCriteria": [
      {
        "type": "element-exists",
        "target": "create-customer-form"
      }
    ],
    "preconditions": [
      {
        "type": "element-exists",
        "target": "create-customer-button"
      }
    ],
    "failureMeaning": [
      "创建按钮不存在",
      "创建按钮不可点击",
      "点击后未进入创建表单"
    ]
  }
}
```

## 6.2 Node Goal 必须由系统显示给用户

至少提供两个展示位置：

1. Node Card / Node Inspector
2. Workflow Generation 完成预览

Node UI 中建议显示：

```text
Goal
打开创建客户表单

Success
表单已经出现
```

默认显示 Goal；Success Criteria 可以折叠。

用户修改 Goal 后，不能破坏 block execution 参数；Goal metadata 与 block params 分离。

---

# 7. Operator Registry

新增唯一的 AI Operator Registry。

建议文件：

```text
src/lib/workflow/operator-registry.ts
```

每个可生成 Operator 至少描述：

```ts
export interface WorkflowOperatorDefinition {
  blockId: string
  category: OperatorCategory

  goal: string
  successCriteria: SuccessCriterion[]
  preconditions: Condition[]

  semanticIntents: string[]
  semanticIntentsZh: string[]
  semanticIntentsEn: string[]

  preferredWhen: string[]
  avoidWhen: string[]

  inputs: OperatorInputSpec[]
  outputs: OperatorOutputSpec[]

  sideEffect: 'none' | 'reversible' | 'business'
  reliability: 'high' | 'medium' | 'low'

  aiExposure: 'core' | 'on-demand' | 'fallback' | 'hidden'

  repairHints: RepairHint[]
  alternatives: string[]
}
```

### Registry 是 AI Decision Layer 的唯一来源

禁止再从：

```text
PALETTE_BLOCKS category
```

直接推导出“模型该不该使用这个工具”。Palette taxonomy 可以继续存在，但 AI Registry 必须独立描述语义。

---

# 8. Operator 分类

不要只按编辑器 palette 分类；使用 AI-oriented capability 分类，并建立到现有 block 的映射。

建议：

```text
navigation
interaction
page-reading
wait-and-sync
verification
control-flow
data-transform
data-storage
browser-system
semantic-generation
external-services
escape-hatch
editor-only
unsupported
```

## 8.1 Core

默认最小集合：

```text
new-tab
snapshot/read-page（若现有机制需要）
event-click
forms
get-text
```

## 8.2 On-demand

按 Goal/Intent 动态加载：

- page-reading
- browser-system
- wait-and-sync
- verification
- control-flow
- data-transform
- data-storage
- semantic-generation
- external-services

## 8.3 Fallback

- ai-agent
- javascript-code

`ai-agent` 是“语义能力 fallback”，不是“万能逃生”。

`javascript-code` 是“能力缺口 fallback”，优先级最低。

## 8.4 Hidden

至少隐藏：

- `save-assets`（executor 当前未实现/placeholder）
- 纯 editor 结构节点
- 不能被可靠执行的兼容占位节点
- 内部状态节点

只有编辑器仍需要的节点才留在 Palette，不应默认进入 AI Generation Registry。

---

# 9. `find_workflow_operators` 新协议

新增 Workflow-only tool：

```ts
find_workflow_operators({
  stepIntent,
  goal?,
  requiredCapabilities?,
  targetType?,
  language?: 'zh' | 'en' | 'auto',
  excludeOperators?: string[],
  failureReports?: OperatorFailureReport[],
  maxCandidates?: number
})
```

默认返回最多 3 个；当系统处于 recovery mode 时允许返回 5 个。

## 9.1 返回格式

```json
{
  "candidates": [
    {
      "operator": "forms",
      "rank": 1,
      "confidence": 0.96,
      "goal": "填写目标表单字段",
      "successCriteria": ["字段值已写入"],
      "whySelected": ["任务是填写表单"],
      "requiredTarget": true,
      "requiredInputs": ["target", "value"],
      "knownFailureModes": ["target-not-found", "disabled"],
      "recovery": ["refresh-target", "retry"]
    }
  ],
  "activation": {
    "mode": "candidate-only",
    "advertisedToolsNextRound": ["wf_op_forms"]
  }
}
```

### 重要：Discovery 必须同时完成 Tool Activation

不要让模型再执行：

```text
find_workflow_operators
→ use_operators
→ wf_op_xxx
```

正确路径：

```text
find_workflow_operators
→ server 激活 Top N tool schema
→ 下一轮直接调用
```

这样避免额外一轮。

现有 `use_operators` 保留兼容，但新 Generator 默认优先 `find_workflow_operators`。

---

# 10. Candidate Ranking

候选评分不要使用单一关键词匹配，至少综合：

```text
score =
  semanticFit
+ goalFit
+ targetFit
+ inputFit
+ preconditionFit
+ reliabilityBonus
+ nativeBonus
+ historicalSuccessBonus
- sideEffectRisk
- complexityPenalty
- fallbackPenalty
```

权重不要硬编码在 Prompt 中；放到 Registry / deterministic scorer 中。

禁止因为一个关键词直接把 candidate 排到第一。

---

# 11. Top 3 全部失败时怎么办

这是本 Spec 的关键要求。

## 11.1 禁止策略

禁止：

```text
Top3 失败
→ 随机选第 4 个
→ 继续试
→ JS
→ 宣布任务失败
```

禁止连续尝试多个 Operator 而不分析失败原因。

---

## 11.2 每次 Operator Failure 必须结构化

新增：

```ts
interface OperatorFailureReport {
  operator: string
  phase:
    | 'target-resolution'
    | 'precondition'
    | 'parameter'
    | 'execution'
    | 'postcondition'
    | 'unsupported'
    | 'unknown'

  code: string
  message: string
  evidence?: EvidenceSpec[]

  targetState?: {
    found: boolean
    ambiguous?: boolean
    stale?: boolean
  }

  retryable: boolean
  suggestedRecovery: RecoveryAction[]
}
```

---

## 11.3 Failure Matrix

### A. `target-resolution`

表现：元素不存在、ref 失效、selector 找不到。

动作：

```text
不要立即换 Operator
→ 重新 snapshot/ground target
→ 重新验证页面状态
→ 同 Operator retry 1 次
```

如果重新定位后仍失败，再进入 candidate expansion。

### B. `precondition`

例如按钮尚不可见、页面还未加载。

动作：

```text
选择 wait/navigation/tab/operator
→ 满足 precondition
→ retry 原 Operator
```

### C. `parameter`

例如 forms 参数缺失、值类型错误。

动作：

```text
修正参数
→ 不换 Operator
→ retry
```

### D. `execution`

例如 executor 抛异常。

动作：

```text
retry <= 1
→ 如果仍失败，查看 error code
→ 再决定是否扩展候选
```

### E. `postcondition`

Operator 本身执行成功，但 Node Goal 不满足。

动作：

```text
不要记录为成功 Node
→ 查找缺少的后置步骤
→ 优先补 wait / verify / follow-up operator
→ 如果 operator 本身选择错误，再扩大 candidate search
```

### F. `unsupported`

明确表明能力不存在。

动作：

```text
exclude failed operators
→ find_workflow_operators(recovery=true)
→ 搜索相邻 capability
```

### G. `unknown`

动作：

```text
获取最小页面证据
→ 重新分类 failure
→ 最多一次 AI diagnosis
→ 再进入 recovery
```

---

# 12. Top 3 都失败后的 Recovery State Machine

必须实现确定性状态机：

```text
DISCOVERY
  ↓
TRY_CANDIDATE
  ↓
CLASSIFY_FAILURE
  ├─ target/precondition/parameter/transient
  │      ↓
  │   RECOVER_LOCAL
  │      ↓
  │   RETRY_SAME_OPERATOR
  │
  └─ unsupported/semantic-mismatch
         ↓
      EXPAND_SEARCH
         ↓
   NEXT 3 CANDIDATES
         ↓
      TRY AGAIN
         ↓
  ┌──────┴────────┐
  │               │
成功          仍失败
  │               ↓
  │       CHECK_COMPOSITION
  │               ↓
  │       native composition
  │               ↓
  │            失败
  │               ↓
  │      CHECK_SEMANTIC_AI
  │               ↓
  │    dynamic/semantic task?
  │          ├─ yes → ai-agent
  │          └─ no
  │               ↓
  │      CHECK_NATIVE_GAP
  │               ↓
  │          JS allowed?
  │          ├─ yes → JS
  │          └─ no → fail with capability-gap report
  ↓
NODE_SUCCESS
```

### 最大搜索预算

单个 Workflow step 默认：

- 同一个 Operator 最多 retry 1 次
- 第一批最多 3 个候选
- Recovery 扩展最多再取 3 个候选
- 不允许超过 6 个不同 Operator 的盲试
- 超过后必须进入 composition / AI-agent / JS / capability-gap diagnosis

目标是减少“多尝几个”导致的慢和 token 浪费。

---

# 13. 丰富的语义分类：中文 + English

不要继续扩展为一个超长关键词数组。实现为：

```text
Semantic Intent Lexicon
+
Phrase Pattern Rules
+
Page Structure Signals
+
GoalSpec Signals
```

三者共同决定 capability loading。

---

## 13.1 Control Flow Intent

### 中文信号

#### 遍历 / For Each

```text
每个
每一项
每一条
每一行
每一列
每一个
逐个
逐项
逐条
逐行
逐页
逐条处理
依次处理
挨个处理
遍历
批量处理所有
针对所有
对所有
对每个
对每一项
```

#### 全量 / All

```text
全部
所有
全量
每一个
所有符合条件的
所有记录
所有商品
所有订单
全部结果
全部列表项
```

#### While / Until

```text
直到
直至
当……时
只要
持续到
一直到
没有更多
直到没有
直到出现
直到满足
直到成功
```

#### If / Else

```text
如果
若
假如
当……则
满足……时
符合条件时
不满足时
否则
不然
如果……否则
```

#### Repeat / Retry

```text
重复
再次
重试
重新执行
再试一次
循环
反复
连续执行
失败后重试
最多尝试
尝试 N 次
```

#### Pagination / Iteration

```text
翻页
下一页
分页
逐页
继续下一页
直到没有下一页
加载更多
滚动加载更多
下一批
所有页面
```

### English signals

#### For Each / Iteration

```text
each
every
for each
for every
all items
all rows
all records
all results
one by one
item by item
row by row
iterate
iterate over
loop over
traverse
walk through
process each
handle each
```

#### While / Until

```text
until
while
as long as
keep doing
keep going until
repeat until
stop when
continue until
until no more
until it appears
until it succeeds
```

#### If / Else

```text
if
when
whenever
provided that
in case
if ... then
otherwise
else
unless
when condition is met
when condition fails
```

#### Repeat / Retry

```text
repeat
again
retry
re-run
run again
try again
repeat N times
up to N attempts
retry on failure
keep retrying
```

#### Pagination

```text
next page
paginate
pagination
page through
all pages
load more
until no more results
continue to the next page
```

---

# 14. 其他 Capability 语义也必须扩展

## 14.1 Interaction

中文：点击、单击、点一下、填写、输入、键入、选择、勾选、取消勾选、悬停、上传、提交、展开、收起、滚动、按键。

英文：click, tap, press, type, enter, fill, input, select, choose, check, uncheck, hover, upload, submit, expand, collapse, scroll, keypress。

## 14.2 Reading

中文：读取、获取、查看、提取、抓取、采集、读取文本、读取属性、获取链接、获取 URL。

英文：read, get, extract, scrape, collect, inspect, retrieve, fetch text, read attribute, get URL, capture data。

## 14.3 Data Transform

中文：过滤、筛选、排序、映射、转换、替换、正则、截取、切片、去重、统计、聚合、拆分、合并。

英文：filter, map, transform, convert, replace, regex, slice, split, join, deduplicate, sort, aggregate, count, normalize。

## 14.4 Storage / Output

中文：保存、导出、写入文件、下载、复制到剪贴板、保存本地。

英文：save, export, write file, download, copy to clipboard, persist locally。

## 14.5 Verification

中文：验证、确认、确保、检查是否、判断是否、确认成功、确认出现、确认已登录、确认已提交。

英文：verify, validate, confirm, ensure, check whether, assert, make sure, confirm success, confirm visible, confirm logged in, confirm submitted。

## 14.6 Dynamic Semantic Generation

中文：生成、撰写、拟定、回复、改写、润色、总结并写、个性化、根据上下文填写、根据页面内容填写。

英文：generate, draft, compose, reply, rewrite, polish, personalize, summarize and write, formulate, compose based on context, generate from page content。

---

# 15. 语义检测不能只靠词

必须加入以下第二来源：

## Page Structure Signals

例如页面 Snapshot 发现：

```text
重复的 `.product-card`
重复的 table rows
pagination button
“Next”按钮
“Load more”按钮
```

即使用户只说：

```text
抓取商品名称
```

也应该推断存在：

```text
loop-elements
get-text
pagination / loop-breakpoint
```

但这类推断只能产生 `requiredCapabilities`，不能直接把某个 block 记录进 Workflow，必须由实际执行证明。

---

# 16. AI Agent 的 Discovery 规则

在 `find_workflow_operators` 内增加能力：

```text
semantic-generation
semantic-reasoning
```

满足以下条件之一时，候选中必须出现 `ai-agent`：

1. 输出内容由模型创造，而不是用户给定。
2. 输出需要理解网页上下文后生成。
3. 输出需要个性化措辞。
4. 输出需要总结/重写/改写。
5. 用户要求“帮我写/生成/回复/拟定”。
6. 当前 forms 的 `generated=true`。

但必须通过 deterministic capability matcher 排除纯数据处理场景。

例如：

```text
“把商品名提取出来填写到字段”
→ get-text + forms
```

而：

```text
“读取客户信息后，生成一封个性化邮件并填入正文”
→ get-text + ai-agent + forms
```

---

# 17. Node Goal 的生成规则

每次 `wf_op_*` 成功执行之前，模型/系统必须知道该节点属于哪个 semantic intent。

执行结果中需要返回：

```json
{
  "ok": true,
  "nodeId": "...",
  "goalContract": {
    "goal": "打开创建客户表单",
    "successCriteria": ["创建表单可见"]
  }
}
```

如果模型未提供 Goal：

- 系统通过 Operator Registry 的默认 Goal 生成
- 再结合当前 Workflow Goal / stepIntent 做上下文实例化
- 不允许最终 Node Goal 为空

例如同一个 `forms`：

```text
通用 Operator Goal：填写页面表单字段
```

当前任务实例化后：

```text
Node Goal：填写客户姓名为“张三”
```

Goal 必须是“实例化 Goal”，不能只是工具说明。

---

# 18. Node Success Criteria 必须可验证

不要允许：

```text
“成功填写”
“正常完成”
“操作成功”
```

这种不可机器验证的 Success Criteria。

优先生成：

- element-exists
- element-not-exists
- text-contains
- text-equals
- attribute-equals
- url-contains
- variable-exists
- variable-equals
- count-gte / count-eq
- page-state

如果 Operator Executor 已经返回 evidence，则把 evidence 与 Success Criteria 关联起来。

---

# 19. Workflow Goal 与 Node Goal 的关系

必须遵循：

```text
Workflow Goal
   ↓
Step Intent
   ↓
Node Goal
   ↓
Node Success Criteria
   ↓
Evidence
```

最终 Workflow 成功：

```text
ALL required Workflow Success Criteria satisfied
```

而不是：

```text
last node executed without exception
```

允许 Workflow Goal 的一个 Success Criterion 由多个 Node 共同证明。

---

# 20. Goal Verification

最终 compose 前必须经过：

### L1 Execution

Block 执行成功。

### L2 Node Contract

Node Goal / Success Criteria 满足。

### L3 Workflow Goal

整体 Workflow Goal 成功标准满足。

最终只允许：

```text
L1 = pass
L2 = pass
L3 = pass
```

进入 Certified Workflow。

---

# 21. AI Repair 规则

Repair 不允许只读取 error message。

Repair 输入必须包含：

```text
Workflow Goal
↓
Failed Node Goal
↓
Node Success Criteria
↓
Node Preconditions
↓
Failure Report
↓
Current Evidence
↓
Nearby Graph
↓
Relevant Operator Registry entry
```

## Repair 策略

### Locator failure

优先：

```text
re-ground target
→ 重新运行当前 node
```

### Page state failure

优先：

```text
wait / navigation / tab switch
→ replay node
```

### Parameter failure

优先：

```text
repair parameters
→ replay node
```

### Semantic mismatch

优先：

```text
find_workflow_operators
→ replace minimum affected node
```

### Missing capability

依次：

```text
native composition
→ ai-agent（如果属于语义生成/推理）
→ JS（真正 capability gap）
```

Repair 成功必须同时满足：

```text
Node Contract passes
+
Workflow Goal passes
+
No regression in already-passing nodes
```

---

# 22. Workflow Compiler 要做的事情

LLM 生成的是 semantic actions / intents；Compiler 负责：

- blockId
- 参数结构
- handles
- edge
- variables
- producer / consumer
- goal metadata
- trigger metadata
- evidence mapping
- repair metadata

不要让模型直接构造最终 Workflow JSON graph。

优先路径：

```text
Semantic Action Trace
→ Workflow IR
→ Compiler
→ Workflow JSON
```

如果现有 `WorkflowDraft` 仍作为过渡层，至少确保：

```text
Draft
→ semantic metadata preserved
→ IR/Compiler consumes it
```

不得再次丢失 Goal Contract。

---

# 23. `use_operators` 与 `find_workflow_operators` 的兼容策略

### 新默认行为

```text
prepare_workflow_goal
→ find_workflow_operators
```

### `use_operators`

保留作为：

- 大量相同类别节点连续生成
- 模型主动批量切换能力面
- legacy compatibility

但不能成为默认路径。

### 关键优化

当 `find_workflow_operators` 返回候选时，直接激活候选工具 schema，而不是：

```text
find
→ use_operators
→ load
→ run
```

目标是一次 Discovery，下一轮直接执行。

---

# 24. Tool Schema 预算

生成模式必须继续保持低 Token。

目标：

- 首轮不携带全部 operator schemas
- Discovery 只暴露 Top 3
- Recovery 最多扩到 Top 3 + Next 3
- AI Agent 只在 semantic-generation 命中时加载
- JS 永不默认加载
- 完成当前阶段后可以释放不用的 Operator schema

建议增加 metrics：

```text
workflow.discovery.schemaChars
workflow.discovery.schemaTokens
workflow.discovery.candidateCount
workflow.discovery.retryCount
workflow.discovery.expansionCount
```

---

# 25. 算子质量与 Registry 审计

实现前先完整扫描现有所有 Workflow Block，生成一次机器可读报告：

```text
blockId
category
executorSupported
semanticActions
goal
successCriteria
preconditions
sideEffect
reliability
aiExposure
```

将 Block 分成：

```text
GENERATE_CORE
GENERATE_ON_DEMAND
GENERATE_FALLBACK
EDITOR_ONLY
UNSUPPORTED
```

特别检查：

- `javascript-code`
- `ai-agent`
- `save-assets`
- loops / conditions
- verification blocks
- read-page / get-text / attribute-value
- navigation / tab blocks
- data transform
- save/export

`save-assets` 当前如果仍未实现 executor，必须从 AI Registry 移除；编辑器 Palette 是否保留不属于本次删除范围。

---

# 26. 新增 Verification Operators

为了提高最终成功率，至少保证 Registry 中存在以下语义能力：

```text
verify-element
verify-text
verify-attribute
verify-url
verify-variable
verify-page-state
verify-workflow-goal
```

如果不新增新的 Block，可以先通过现有：

```text
element-exists
get-text
attribute-value
conditions
```

编译出这些语义动作；但 Registry 对模型必须暴露“验证能力”，而不是逼模型理解底层组合。

---

# 27. 缺失的高层算子建议

优先评估新增：

## `extract-record`

用于：

```text
从重复页面元素提取结构化记录
```

例如：

```json
{
  "target": ".product-card",
  "fields": {
    "name": {"type": "text"},
    "price": {"type": "text"},
    "url": {"type": "attribute", "name": "href"}
  }
}
```

内部可编译成：

```text
loop-elements
+ get-text
+ attribute-value
+ insert-data
```

模型只表达“提取记录”，系统负责低级编排。

## `verify-page-state`

将常用的：

```text
URL
+ text
+ element
```

验证组合封装成一个高层能力。

## `generate-text`

可以不新增 Block；优先复用 `ai-agent`，在 Registry 中注册为：

```text
semantic-generation
```

避免重复造两个 Agent 节点体系。

---

# 28. UI 要求

## Workflow Generation 完成弹窗

必须作为真正 Modal / Dialog 打开，不应继续追加在最终聊天回复尾部。

弹窗至少显示：

```text
Workflow Name
Workflow Goal
Success Criteria

Steps
1. Node Goal
2. Node Goal
3. Node Goal

Verification
✓ Node checks passed
✓ Workflow goal passed
```

## Node Inspector

显示：

```text
Goal
Success Criteria
Preconditions
Failure meaning
Repair hints
```

并允许用户编辑 Goal / Success Criteria，但修改必须触发重新验证或标记 workflow 为 unverified。

---

# 29. Tests

必须新增/更新测试，不允许只修改 Prompt。

## 29.1 Operator discovery

至少覆盖：

```text
简单点击
表单填写
读取文本
读取属性
等待元素
切换 tab
上传文件
保存数据
验证成功
```

并测试 Top-3 ranking。

## 29.2 All Top-3 failure

场景：

```text
Candidate 1 target-not-found
Candidate 2 unsupported
Candidate 3 parameter-error
```

验收：

```text
系统先分类
→ 修复 target/parameter
→ 再扩大搜索
```

不能直接 JS。

## 29.3 Recovery candidate

测试：

```text
Top3 均 semantic-mismatch
→ 返回 Next 3
```

测试：

```text
Top3 都是 target failure
→ 先 re-ground，而不是盲换 operator
```

## 29.4 AI Agent dynamic text

中文：

```text
读取客户信息，生成个性化邮件并填写到正文
```

English：

```text
Read the customer information, draft a personalized email, and fill it into the message body.
```

必须产生：

```text
read data
→ ai-agent
→ variable
→ forms
```

不得生成硬编码正文。

## 29.5 Deterministic text filling

```text
把用户名填写到输入框
```

不得使用 ai-agent。

## 29.6 Control-flow semantics

中文测试：

```text
遍历所有商品
每一条订单
直到没有更多结果
如果状态是失败，否则继续
最多重试 3 次
翻页直到最后一页
```

英文测试：

```text
process every product
for each order
continue until there are no more results
if the status is failed, otherwise continue
retry up to 3 times
paginate until the last page
```

应加载 control-flow。

## 29.7 Node Goal

生成的每个 action node：

```text
goal != empty
successCriteria.length > 0
```

## 29.8 Workflow Goal

生成前：

```text
GoalSpec exists
successConditions.length > 0
```

生成后：

```text
Workflow Goal verification = pass
```

## 29.9 JS fallback

以下任务不得使用 JS：

```text
click
fill
get text
read attribute
wait
loop
condition
save variable
```

只有明确 capability gap 时才允许。

## 29.10 Save-assets

如果 executor 仍未实现：

```text
find_workflow_operators("download an image")
```

不得返回 `save-assets`。

---

# 30. Metrics

新增：

```text
workflow.operatorSelection.top1Accuracy
workflow.operatorSelection.top3Recall
workflow.operatorSelection.recoverySuccessRate
workflow.operatorSelection.targetRecoveryRate
workflow.operatorSelection.parameterRecoveryRate

workflow.nativeOperatorRate
workflow.aiAgentRate
workflow.javascriptFallbackRate
workflow.blindOperatorRetryRate

workflow.goalSpecCompletionRate
workflow.nodeGoalCompletionRate
workflow.nodeSuccessCriteriaCoverage
workflow.goalVerificationRate

workflow.firstRunGoalSuccessRate
workflow.repairedGoalSuccessRate
workflow.reuseSuccessRate

workflow.discovery.averageCandidates
workflow.discovery.averageToolCalls
workflow.discovery.averageSchemaTokens
workflow.discovery.averageRecoveryRounds
```

---

# 31. Acceptance Targets

在没有历史基线时，先建立 50~100 个真实任务 benchmark，再逐步达成：

### Goal Contract

- 100% generated workflow 有 Workflow Goal
- 100% generated workflow 有至少 1 个 Success Criterion
- 100% generated action nodes 有 Node Goal
- 100% generated action nodes 有可验证 Success Criteria

### Operator Selection

- Top-3 Recall >= 90%
- Top-1 Accuracy 持续记录并逐版本提升
- 同一 step 的盲目不同 Operator 尝试 <= 6
- target failure 的首轮恢复成功率 >= 80%

### Tool / Token

- 默认不加载全部 Operator schema
- 正常步骤优先 1 次 discovery
- Recovery 不超过 1 次 candidate expansion
- AI Agent 不在确定性任务中无故加载

### Generated Workflow

- Native Operator Rate >= 90%
- JS Fallback Rate <= 5%
- 动态文案任务 AI Agent 使用正确率 >= 90%
- Workflow Goal Verification Pass 才允许标记“生成成功”

### Repair

- Node 修复后 Node Contract pass
- 最终 Workflow Goal pass
- 不破坏已通过节点

这些是初始工程门槛，后续应根据 benchmark 实测结果调整，而不是写死为永久指标。

---

# 32. Implementation Task List

## Phase 0 — Inventory

### T0.1 完整盘点现有 Block

修改/新增：

```text
src/lib/workflow/operator-registry.ts
scripts 或 tests/operator-registry-coverage.spec.ts
```

要求：

- 覆盖所有现有 executable blocks
- 标记 executor 是否真实存在
- 标记 aiExposure
- 检查 sideEffect
- 检查 semantic actions

验收：

- 没有 executable block 未分类
- placeholder / cloud-only block 不进入 generation registry

---

## Phase 1 — Goal Contract

### T1.1 新增/统一 `prepare_workflow_goal`

修改：

```text
src/background/agent.ts
src/background/operator-tool-handler.ts
src/lib/workflow/goal.ts
```

验收：

- 未 prepare goal 时 `wf_op_*` 被拒绝
- prepare 后才能执行 operator
- Workflow name 自动产生

### T1.2 Trigger Goal

修改：

```text
operator-tool-handler
workflow compose pipeline
```

验收：

- Trigger 有 goal + success criteria
- description 自动同步

---

## Phase 2 — Node Goal

### T2.1 Node Goal Contract

修改：

```text
src/lib/workflow/reliability.ts
src/lib/workflow/types.ts（仅在真正需要时）
src/background/operator-tool-handler.ts
```

验收：

- 每个生成 Node 带 `data.__workflowAi.goalContract`
- legacy workflow 不崩
- migration 安全

### T2.2 UI 显示

通过 repository search 找到 Workflow Node Card / Inspector / generation preview 组件。

验收：

- Node Goal 用户可见
- Success Criteria 可展开
- 编辑后状态变为需要重新验证

---

## Phase 3 — Operator Registry

### T3.1 Registry

新增：

```text
src/lib/workflow/operator-registry.ts
src/lib/workflow/operator-registry-defaults.ts
```

验收：

- Registry 是唯一 AI operator semantic source
- Block Catalog 与 Registry 可以映射但语义独立

### T3.2 完善 Capability

修改：

```text
src/lib/workflow/block-capabilities.ts
src/lib/workflow/operator-categories.ts
```

至少修正：

- javascript side effect
- read-page semantic actions
- ai-agent semantic-generation
- control-flow actions
- verification semantics

---

## Phase 4 — Operator Discovery

### T4.1 `find_workflow_operators`

新增：

```text
src/background/agent.ts
src/lib/workflow/operator-discovery.ts
```

要求：

- deterministic ranking
- bilingual semantic matching
- page evidence matching
- Goal matching
- failure-aware reranking

### T4.2 Candidate-only activation

修改：

```text
src/background/agent.ts
```

要求：

- finder 直接激活 candidate tool schemas
- 不需要额外 `use_operators`
- 兼容 legacy `use_operators`

验收：

```text
finder
→ next round 直接可调用 candidate
```

---

## Phase 5 — Failure Recovery

### T5.1 Structured Failure

修改：

```text
src/background/operator-tool-run.ts
src/background/agent.ts
```

要求：

- failure phase
- error code
- target state
- retryable
- recovery action

### T5.2 Recovery State Machine

新增：

```text
src/lib/workflow/operator-recovery.ts
```

要求：

- local recovery
- candidate expansion
- composition
- semantic AI
- JS fallback

验收：

- Top3 全失败不能随机试
- 不能直接跳 JS
- 失败原因决定下一步

---

## Phase 6 — Bilingual Semantic Intent

新增：

```text
src/lib/workflow/semantic-intents.ts
src/lib/workflow/semantic-intent-detector.ts
```

要求：

- 中英文 phrase patterns
- 同义词
- 复合句
- control/data/verification/AI generation 全覆盖
- page structure signals
- GoalSpec signals

验收：

中英文 benchmark 均能正确激活对应 capability。

---

## Phase 7 — AI Agent Capability

修改：

```text
src/lib/workflow/operator-registry.ts
src/lib/workflow/ai-prefill.ts
src/background/operator-tool-handler.ts
src/background/agent.ts
```

要求：

- `ai-agent` 注册为 semantic-generation
- 动态文案任务必须能够被发现
- 普通固定值任务不得默认选择 AI Agent
- 保证 AI-prefill producer → consumer 数据流完整

验收：

```text
customer info
→ ai-agent
→ generatedText
→ forms
```

---

## Phase 8 — Goal-driven Repair

修改：

```text
src/lib/workflow/reliability.ts
src/lib/workflow/goal.ts
已有 unified repair / replay 模块
```

要求：

- repair context 包含 Node Goal
- repair context 包含 Node Success Criteria
- final verification 使用 Workflow Goal

验收：

- 节点修复成功但 Workflow Goal 未满足时，不能宣布成功

---

## Phase 9 — Compiler / Verification

修改：

```text
src/lib/workflow/ir.ts
src/background/workflow-engine/generation/generation-pipeline.ts
src/lib/workflow/generated-validation.ts
```

要求：

- Goal metadata 不丢失
- IR 保留 node intent
- compiler 负责 graph wiring
- static validation 检查 Goal Contract

验收：

```text
Goal
→ IR
→ Workflow
```

信息完整。

---

## Phase 10 — Benchmark / Metrics

新增：

```text
operator-discovery benchmark
operator-recovery benchmark
semantic-intent benchmark
ai-agent selection benchmark
node-goal benchmark
workflow-goal benchmark
```

验收：

- 能定量比较优化前后
- 统计 Token / Tool rounds / JS rate / Goal success

---

# 33. Implementation Safety Rules

1. 不要删除编辑器需要的 Block，只从 AI Generation Registry 中隐藏。
2. 不要把更多逻辑塞进 System Prompt 解决；可执行约束必须进入 TypeScript deterministic layer。
3. 不要新增第二套 Goal / Reliability / Capability 类型，优先扩展现有实现。
4. 不要因为候选失败就自动扩大到全部 50+ operators。
5. 不要把 AI Agent 当万能 fallback。
6. 不要把 JS 当普通 operator。
7. 不要用不可验证的自然语言 Success Criteria 通过 validation。
8. 不要在最终 save 时才第一次构造 Goal；Goal 必须在第一个 Action 前存在。
9. 任何新的 operator 都必须有：Goal、Success Criteria、Preconditions、semantic intents、Failure/Repair hints。
10. 新增 UI 必须兼容没有 `__workflowAi` metadata 的旧 Workflow。

---

# 34. Definition of Done

本 Spec 全部完成后，一次典型任务应该表现为：

> **最终完成状态必须以第 35 章 `V01–V100` 逐项验收结果为准。第 34 章用于说明完整业务链路，第 35 章用于证明每一项功能确实已经实现并验证。**

```text
用户：读取客户资料，生成一封个性化跟进邮件并发送

1. prepare_workflow_goal
   Goal：发送一封针对当前客户资料生成的个性化跟进邮件
   Success：发送成功提示出现；邮件发送状态成功

2. find_workflow_operators
   → get-text
   → ai-agent
   → forms
   → event-click
   → verification

3. 页面执行
   → 每一步真实执行

4. 每个节点
   → Goal
   → Success Criteria

5. 如果 candidate 执行失败
   → 分析失败原因
   → re-ground / retry / expand search
   → 不随机尝试

6. 动态文案
   → ai-agent producer
   → variable
   → forms consumer

7. 完成 Workflow
   → Trigger Goal
   → meaningful workflow name
   → complete Node Contracts

8. Replay
   → L1 pass
   → L2 pass
   → L3 Workflow Goal pass

9. Save
   → Certified Workflow
```

最终系统的判断标准不是：

> “模型有没有调用很多工具。”

而是：

> “模型是否以尽可能少的 Tool/Token 选择了可验证的原生 Operator，生成了结构完整、用户可理解、可 Replay、可 Repair、最终 Goal 可验证的 Workflow。”

---

# 35. 逐项执行的完整验收清单（AI Coding Agent 必须按顺序确认）

> **本章节是最终验收唯一执行清单。**
>
> AI Coding Agent 完成本 Spec 后，必须严格按照 `V01 → V02 → ...` 的顺序逐项验证，不允许只运行总测试后直接宣布全部完成。
>
> 每一项必须同时满足：
>
> 1. 功能代码已经实现；
> 2. 对应自动化测试已经存在并通过；
> 3. 必要时完成真实浏览器 E2E 验证；
> 4. 记录实际验证证据；
> 5. 只有该项 PASS 后才能进入下一项。
>
> 如果某一项 FAIL：
>
> - 状态标记为 `FAIL`；
> - 说明失败原因、影响范围、涉及文件；
> - 修复后重新执行当前项；
> - 不得把后续项目标记为 PASS；
> - 最终报告必须列出所有 FAIL 项。
>
> 建议验证记录统一格式：
>
> ```text
> [V01] PASS
> 实现：...
> 测试：...
> 实际结果：...
> 证据：...
> ```

---

## 35.1 Phase A：基础盘点与兼容性

### V01 — 所有可执行 Block 完整盘点

**验证目标**：所有当前可执行 Workflow Block 都被发现并进入审计结果。

**检查项**：

- [ ] 枚举所有 executable blocks
- [ ] 每个 Block 都有唯一 ID
- [ ] 每个 Block 都能找到 executor / handler
- [ ] 标记 placeholder / not implemented / cloud-only
- [ ] 标记是否允许 Workflow AI Generation
- [ ] 标记 `aiExposure`
- [ ] 标记 `sideEffect`
- [ ] 标记 semantic capabilities

**通过标准**：不存在“系统实际可执行但 Registry 完全不知道”的 Block。

---

### V02 — Generation Registry 与编辑器 Block Catalog 解耦

**验证目标**：AI Generation Registry 是 AI 工具选择的唯一语义来源，同时不破坏编辑器 Catalog。

**检查项**：

- [ ] Editor Block Catalog 仍然完整
- [ ] AI Registry 可以独立筛选
- [ ] Hidden Block 不出现在 AI discovery
- [ ] Editor 仍可使用 Hidden Block（如果原功能需要）
- [ ] 新增 Block 经过 Registry coverage test

**通过标准**：隐藏 AI 工具不会删除或破坏编辑器能力。

---

### V03 — Legacy Workflow 完整兼容

**验证目标**：没有 `__workflowAi` metadata 的旧 Workflow 仍然可以加载、编辑、运行。

**检查项**：

- [ ] Legacy Workflow 加载成功
- [ ] Legacy Node 没有 Goal 时不崩溃
- [ ] Inspector 能处理缺失 Goal
- [ ] Replay 不因缺失 metadata 崩溃
- [ ] Save 后不会破坏旧字段

**通过标准**：已有 Workflow 不需要手动迁移即可继续工作。

---

### V04 — Capability 元数据正确性

**逐项确认至少以下 Block**：

- [ ] `javascript-code`
- [ ] `ai-agent`
- [ ] `read-page`
- [ ] `get-text`
- [ ] `attribute-value`
- [ ] `element-exists`
- [ ] `event-click`
- [ ] `forms`
- [ ] `press-key`
- [ ] navigation 类
- [ ] wait 类
- [ ] condition 类
- [ ] loop 类
- [ ] data transformation 类
- [ ] verification 类

**通过标准**：每个核心 Block 的 `actions / target / input / output / sideEffect / aiExposure` 与真实行为一致。

---

## 35.2 Phase B：Workflow Goal Contract

### V05 — 生成 Workflow 前必须先建立 Goal

**验证目标**：没有 Goal Contract 时，任何 `wf_op_*` 都不能进入真实执行。

**测试**：直接调用 `wf_op_*`，不调用 `prepare_workflow_goal`。

**通过标准**：

- [ ] Dispatcher 拒绝执行
- [ ] 返回明确原因
- [ ] 不创建 Workflow Node
- [ ] 不产生真实页面副作用

---

### V06 — `prepare_workflow_goal` 正常建立 Goal

**检查项**：

- [ ] summary
- [ ] successConditions
- [ ] terminalStateConditions（如需要）
- [ ] constraints
- [ ] requiredCapabilities
- [ ] expectedInputs

**通过标准**：Goal Contract 成功保存并可以被后续 Operator Discovery、Node Goal、Workflow Verification 读取。

---

### V07 — Goal 必须可验证

**测试以下非法 Goal**：

- [ ] 只有自然语言 summary，无 success criteria
- [ ] Success Criteria 为空
- [ ] Success Criteria 无 target / predicate / evidence
- [ ] 条件无法被系统执行

**通过标准**：非法 Goal 被拒绝，不能进入正式 Workflow Generation。

---

### V08 — Workflow Name 自动生成

**测试任务**：创建客户、抓取商品、提交申请、发送邮件等多个任务。

**检查项**：

- [ ] 名称与任务目标相关
- [ ] 名称不是 `workflow-xxxxxx`
- [ ] 名称不是 `new workflow`
- [ ] 名称不是 `test`
- [ ] 名称不包含无意义随机 ID
- [ ] 同一任务多次生成名称语义稳定

**通过标准**：Workflow 名称明确说明“完成什么任务”。

---

### V09 — Trigger Goal Contract

**检查项**：

- [ ] Trigger 保存 Workflow Goal
- [ ] Trigger 保存 Success Criteria
- [ ] Trigger description 包含目标
- [ ] Trigger description 包含成功标准
- [ ] 编辑 Goal 后 Trigger 描述同步

**通过标准**：用户打开 Workflow 时，不看其他节点也能理解 Workflow 最终目标和成功标准。

---

## 35.3 Phase C：Node Goal Contract

### V10 — 每个生成 Action Node 都必须有 Goal

**逐类验证**：

- [ ] click
- [ ] fill
- [ ] select
- [ ] navigation
- [ ] wait
- [ ] read
- [ ] condition
- [ ] loop
- [ ] data processing
- [ ] AI Agent
- [ ] verification

**通过标准**：每个生成 Action Node 都有结构化 `goalContract`。

---

### V11 — Node Goal Contract 字段完整

每个 Node 至少检查：

- [ ] `goal`
- [ ] `successCriteria`
- [ ] `preconditions`
- [ ] `failureMeaning`
- [ ] `evidence`
- [ ] `repairHints`

**通过标准**：核心字段完整，且不是空字符串占位。

---

### V12 — Node Goal 与实际执行语义一致

**示例**：

`event-click` 不得生成：

```text
Goal = 创建客户成功
```

而应生成局部目标，例如：

```text
Goal = 打开创建客户表单
```

**通过标准**：Node Goal 描述的是当前节点负责完成的局部目标，而不是直接复制 Workflow Goal。

---

### V13 — Node Goal 用户可见

**检查 UI**：

- [ ] Workflow Node Card 显示 Goal
- [ ] Node Inspector 显示 Goal
- [ ] Success Criteria 可查看
- [ ] Preconditions 可查看（允许折叠）
- [ ] 用户不需要打开 JSON 才能看到 Goal

**通过标准**：用户可以在正常 Workflow 编辑界面理解每个节点“为什么存在”。

---

### V14 — Node Contract 编辑后的验证失效

**测试**：修改 Node Goal 或 Success Criteria。

**通过标准**：

- [ ] 系统识别该节点 Contract 已变更
- [ ] 原验证状态失效
- [ ] 必要时要求重新 Replay / Verify
- [ ] 不继续显示旧的“已验证”状态

---

## 35.4 Phase D：Operator Registry 与分类

### V15 — 所有 Generation Operator 完成分类

至少确认：

- [ ] Core
- [ ] On-demand
- [ ] Fallback
- [ ] Hidden

**通过标准**：无默认状态不明确的 AI Operator。

---

### V16 — Core Operator 最小集合正确

验证常用能力至少包括：

- [ ] 页面快照 / 当前页读取
- [ ] 目标定位
- [ ] 点击
- [ ] 输入/表单
- [ ] 基础读取
- [ ] 基础等待/页面状态判断
- [ ] Workflow Goal / Node verification 所需基础能力

**通过标准**：简单任务无需加载完整 Operator Catalog 即可完成。

---

### V17 — Hidden Operator 不参与普通 Discovery

至少确认：

- [ ] `save-assets`（若尚未可靠实现）
- [ ] `note`
- [ ] `blocks-group`
- [ ] 内部 Workflow State 节点
- [ ] editor-only 节点
- [ ] JS 默认不进入普通搜索池

**通过标准**：普通任务不会因为这些节点污染候选空间。

---

### V18 — AI Agent 属于正式 Capability

确认：

- [ ] `semantic-generation`
- [ ] `semantic-reasoning`（如实现）
- [ ] 有 Discovery intent
- [ ] 有输入/输出
- [ ] 有成功标准
- [ ] 有与其他 Operator 的 dataflow 描述

**通过标准**：AI Agent 可以被按需发现，而不是只能靠 Prompt 特殊处理。

---

## 35.5 Phase E：`find_workflow_operators` Discovery

### V19 — Discovery 输入完整

检查 Discovery 是否接收：

- [ ] Workflow Goal
- [ ] 当前 Node Goal / step intent
- [ ] Required Capabilities
- [ ] 页面 Snapshot / grounding evidence
- [ ] 当前已加载 operator
- [ ] 历史失败信息

**通过标准**：候选选择不是只依赖用户原始文本。

---

### V20 — Discovery 返回可执行 Candidate

每个 Candidate 至少包含：

- [ ] operatorId
- [ ] capability
- [ ] why
- [ ] preconditions
- [ ] expectedSuccess
- [ ] requiredTarget
- [ ] confidence / ranking

**通过标准**：返回结果足以让 LLM 在 3~5 个候选中做可靠选择。

---

### V21 — Discovery 同时完成 Tool Activation

**测试**：调用 `find_workflow_operators` 后，下一轮直接调用其中一个 Operator。

**通过标准**：

- [ ] 不需要再次调用 `use_operators`
- [ ] Candidate schema 已激活
- [ ] Legacy `use_operators` 仍然可兼容

---

### V22 — 正常任务 Candidate 数量受控

验证：

- [ ] 不默认返回 20+ Operator
- [ ] 默认 Top 3~5
- [ ] 候选具有明确排序
- [ ] 低相关 Operator 不返回

**通过标准**：普通 step 的 Tool Selection 空间显著小于完整 Catalog。

---

### V23 — Native-first 排序正确

对于已有原生能力的任务：

- [ ] native operator 优先
- [ ] native composition 次之
- [ ] AI Agent 再次
- [ ] JS 最后

**通过标准**：同一个确定性任务不会优先选择 AI Agent / JS。

---

## 35.6 Phase F：Top-3 全部失败后的恢复

### V24 — 单次 Operator Failure 结构化

每次失败至少记录：

- [ ] phase
- [ ] errorCode
- [ ] targetState
- [ ] retryable
- [ ] recoveryAction
- [ ] operatorId
- [ ] Node Goal
- [ ] Node Success Criteria

**通过标准**：后续 Recovery 不需要从自然语言错误中猜失败类型。

---

### V25 — Target Resolution Failure 恢复

**测试场景**：selector 错误、元素不存在、元素不唯一。

**期望顺序**：

```text
re-ground
→ semantic locator
→ retry same operator
→ candidate expansion
```

**通过标准**：不因为 target 错误直接切换到 JS。

---

### V26 — Preconditions Failure 恢复

**测试场景**：按钮存在但页面尚未加载、Modal 尚未出现、元素 disabled。

**期望顺序**：

```text
wait/state recovery
→ retry
```

**通过标准**：确定是页面状态问题时不扩大 Operator 搜索。

---

### V27 — Parameter Failure 恢复

**测试场景**：缺少参数、参数格式错误、变量类型错误。

**期望顺序**：

```text
repair parameters
→ retry
```

**通过标准**：不因为参数错误错误地判断“缺失 capability”。

---

### V28 — Transient Execution Failure 恢复

**测试场景**：偶发 timeout / tab state race。

**通过标准**：

- [ ] 最多有限 retry
- [ ] retry 次数受预算约束
- [ ] 不进入无限循环

---

### V29 — Unsupported Capability Failure

**测试场景**：候选 Operator 技术上无法表达任务。

**期望顺序**：

```text
mark unsupported
→ expand discovery
→ composition
→ AI Agent / JS fallback
```

**通过标准**：只有真正的 capability mismatch 才扩大搜索。

---

### V30 — Top 3 全部失败后的 Candidate Expansion

**测试**：人为构造 Top 3 全部失败。

**必须验证**：

- [ ] 系统读取 3 次失败原因
- [ ] 判断是 capability mismatch 还是执行问题
- [ ] 不是随机选择第 4 个工具
- [ ] 下一批候选来自不同 capability / ranking 区域
- [ ] 已知失败原因用于重新排序

**通过标准**：Recovery 是 failure-aware search，而不是 blind retry。

---

### V31 — Top 3 全失败且扩大搜索仍失败

**必须进入**：

```text
candidate expansion
→ composition
→ semantic AI capability
→ JS capability-gap gate
→ controlled failure
```

**通过标准**：最终失败必须是“明确不可完成”，而不是生成一个表面成功的错误 Workflow。

---

### V32 — Recovery Budget

检查：

- [ ] 单 Node 最大 retry 次数
- [ ] candidate expansion 次数
- [ ] 全局 Operator attempt budget
- [ ] 全局 tool/token budget
- [ ] 超预算后的终止状态

**通过标准**：不得无限探索 Operator。

---

## 35.7 Phase G：中文 + English Semantic Intent

### V33 — Control Flow 中文语义覆盖

至少验证：

- [ ] 每个
- [ ] 每一项
- [ ] 每一条
- [ ] 每一行
- [ ] 逐个
- [ ] 逐项
- [ ] 依次
- [ ] 挨个
- [ ] 遍历
- [ ] 批量
- [ ] 针对所有
- [ ] 所有
- [ ] 直到
- [ ] 直至
- [ ] 持续到
- [ ] 只要
- [ ] 当……时
- [ ] 如果
- [ ] 若
- [ ] 除非
- [ ] 否则
- [ ] 不然
- [ ] 重复
- [ ] 再次
- [ ] 反复
- [ ] 重试
- [ ] 继续尝试
- [ ] 最多尝试 N 次
- [ ] 翻页
- [ ] 下一页
- [ ] 加载更多
- [ ] 直到没有更多

**通过标准**：能正确推导 control-flow capabilities。

---

### V34 — Control Flow English 语义覆盖

至少验证：

- [ ] each
- [ ] every
- [ ] for each
- [ ] for every
- [ ] all
- [ ] all items
- [ ] one by one
- [ ] item by item
- [ ] iterate
- [ ] loop over
- [ ] traverse
- [ ] process each
- [ ] until
- [ ] while
- [ ] as long as
- [ ] when
- [ ] whenever
- [ ] if
- [ ] unless
- [ ] otherwise
- [ ] else
- [ ] repeat
- [ ] again
- [ ] repeatedly
- [ ] retry
- [ ] try again
- [ ] up to N attempts
- [ ] paginate
- [ ] next page
- [ ] load more
- [ ] until no more results

**通过标准**：英文任务产生与中文等价的 Capability 推导。

---

### V35 — Control Flow 同义表达

**测试**：同一任务用至少 5 种不同表达描述。

**通过标准**：候选 Capability 与最终 Workflow 结构保持语义一致。

---

### V36 — 数据处理中文/英文语义

至少覆盖：

- [ ] 提取
- [ ] 筛选
- [ ] 过滤
- [ ] 排序
- [ ] 映射
- [ ] 转换
- [ ] 截取
- [ ] 去重
- [ ] 合并
- [ ] 拆分
- [ ] extract
- [ ] filter
- [ ] sort
- [ ] map
- [ ] transform
- [ ] slice
- [ ] deduplicate
- [ ] merge
- [ ] split

**通过标准**：正确加载 data transformation capability。

---

### V37 — Verification 中文/英文语义

至少覆盖：

- [ ] 确认
- [ ] 验证
- [ ] 检查
- [ ] 判断是否成功
- [ ] 确认提交成功
- [ ] 是否存在
- [ ] verify
- [ ] validate
- [ ] check
- [ ] confirm
- [ ] make sure
- [ ] ensure
- [ ] verify success
- [ ] confirm submission

**通过标准**：任务包含验收语义时，Verification capability 被激活。

---

### V38 — Dynamic Generation 中文/英文语义

至少覆盖：

- [ ] 生成文案
- [ ] 写一段
- [ ] 撰写
- [ ] 回复
- [ ] 个性化回复
- [ ] 个性化邮件
- [ ] 根据页面内容生成
- [ ] 根据上下文填写
- [ ] 改写
- [ ] 润色
- [ ] 总结后生成
- [ ] write
- [ ] draft
- [ ] compose
- [ ] generate text
- [ ] generate a reply
- [ ] personalized message
- [ ] personalized email
- [ ] generate from page/context
- [ ] rewrite
- [ ] rephrase
- [ ] polish
- [ ] summarize and write

**通过标准**：能够正确发现 `ai-agent`，但不会把确定性任务错误地升级到 AI Agent。

---

### V39 — 语义 + Page Structure 联合判断

**测试**：用户没有说“遍历”，但页面存在 20 个重复商品卡片和分页。

**通过标准**：系统可以根据 Page Structure 判断需要 loop / extraction / pagination，而不是只靠关键词。

---

### V40 — 明确要求循环但页面无重复结构

**测试**：用户说“遍历每一项”，页面实际上只有一个目标。

**通过标准**：系统不会盲目生成无意义 Loop，而会结合页面证据判断并在必要时请求/建立正确目标结构。

---

## 35.8 Phase H：AI Agent Dynamic Generation

### V41 — 动态文案任务正确使用 AI Agent

**E2E**：

```text
读取客户姓名 + 客户资料
→ 生成个性化跟进邮件
→ 填写邮件正文
```

**必须验证**：

- [ ] get-text / page data
- [ ] ai-agent producer
- [ ] output variable
- [ ] forms consumer
- [ ] 最终变量值来自 AI Agent

---

### V42 — AI Agent 不处理固定值任务

**测试**：

```text
姓名 = 张三
手机号 = 13800000000
```

**通过标准**：直接使用 deterministic input，不创建多余 AI Agent。

---

### V43 — AI Agent 输出变量可追踪

**检查**：

- [ ] producer node output 定义
- [ ] consumer node input 引用
- [ ] dataflow 可在 IR 中看到
- [ ] Workflow Replay 正常

---

### V44 — AI Agent 失败后的 Recovery

**测试**：模拟模型输出失败 / empty / malformed。

**通过标准**：

- [ ] 不自动改成 JS
- [ ] 可以重试 / 调整生成参数
- [ ] 可以报告 semantic generation failure
- [ ] 不丢失 Workflow Goal

---

## 35.9 Phase I：JavaScript Escape Hatch

### V45 — JS 默认不可见

**测试**：普通确定性任务调用 Discovery。

**通过标准**：`javascript-code` 不在普通候选中。

---

### V46 — 原生能力存在时 JS 必须被拒绝

至少测试：

- [ ] 点击
- [ ] 填写
- [ ] 读取文本
- [ ] 读取属性
- [ ] 元素存在判断
- [ ] 等待
- [ ] 条件
- [ ] 循环

**通过标准**：模型试图用 JS 时 dispatcher 拒绝，并要求选择原生能力。

---

### V47 — JS Capability Gap Gate

**测试**：构造确实没有原生 Operator 的 DOM/计算任务。

必须记录：

- [ ] missingCapability
- [ ] triedOperators[]
- [ ] whyInsufficient
- [ ] expectedResult

**通过标准**：仅在 Capability Gap 时允许 JS。

---

### V48 — JS 使用后可以验证

**通过标准**：即使使用 JS，也必须有：

- [ ] Node Goal
- [ ] Success Criteria
- [ ] Verification
- [ ] Workflow Goal Verification

不能因为“JS 执行成功”就直接视为任务成功。

---

## 35.10 Phase J：Verification Operators 与三层验证

### V49 — L1 Execution Verification

每个 Node：

- [ ] executor completed
- [ ] no runtime error
- [ ] expected execution result captured

---

### V50 — L2 Node Contract Verification

每个 Node：

- [ ] Goal satisfied
- [ ] Success Criteria satisfied
- [ ] Evidence captured

**通过标准**：Block 不报错但 Contract 不满足时，Node 必须标记 FAIL。

---

### V51 — L3 Workflow Goal Verification

完整 Workflow：

- [ ] final success conditions satisfied
- [ ] terminal state satisfied（如定义）
- [ ] required side effects confirmed

**通过标准**：只有 L3 PASS 才能标记 `Certified`。

---

### V52 — 最后一个 Node 成功但 Workflow Goal 失败

**强制测试**：最后一个点击动作成功，但业务结果没有出现。

**通过标准**：Workflow 必须判定失败，不能直接弹出“生成成功”。

---

### V53 — Workflow Goal Success Evidence

**通过标准**：用户可以查看 Workflow 为什么被认为成功，包括：

- [ ] condition
- [ ] evidence
- [ ] verification result
- [ ] timestamp / run reference（若现有体系支持）

---

## 35.11 Phase K：AI Repair

### V54 — Repair Context 必须包含 Node Goal

**通过标准**：Repair 输入中存在：

- [ ] Node Goal
- [ ] Node Success Criteria
- [ ] Preconditions
- [ ] Failure Evidence

---

### V55 — Locator Failure 按 Node Goal 修复

**测试**：按钮 CSS 失效，但目标是“打开创建客户表单”。

**通过标准**：修复后目标仍然是同一个 Node Goal，不允许随意改变业务目标。

---

### V56 — Parameter Failure 按 Success Criteria 修复

**测试**：输入参数错误。

**通过标准**：Repair 只修改必要参数，Node Contract 不被破坏。

---

### V57 — Repair 后必须重新验证 Node

**通过标准**：

```text
patch
→ replay node / segment
→ Node Contract Verification
```

不能仅根据 Patch API 成功判断 repair 成功。

---

### V58 — Repair 后必须验证 Workflow Goal

**强制场景**：Repair 后节点通过，但最终业务目标仍失败。

**通过标准**：Repair 状态不能标记最终成功。

---

### V59 — Repair 不得破坏已通过 Node

**测试**：修改 Node N，Node N-1 已通过。

**通过标准**：

- [ ] N-1 仍然通过
- [ ] 不产生无关节点修改
- [ ] patch 最小化

---

### V60 — Repair 预算限制

**检查**：

- [ ] 最大 repair rounds
- [ ] 最大 patch 数
- [ ] 超预算状态
- [ ] 明确人工介入/失败状态

**通过标准**：不存在无限 AI Repair。

---

## 35.12 Phase L：Workflow IR / Compiler

### V61 — Goal 从 GoalSpec 进入 IR

**通过标准**：Workflow Goal 不因 compile 丢失。

---

### V62 — Node Goal 从 Node Contract 进入 IR

**通过标准**：Node intent / Goal / Success Criteria 在 IR 中完整存在。

---

### V63 — Compiler 正确生成 Workflow Graph

至少验证：

- [ ] node IDs
- [ ] handles
- [ ] edges
- [ ] input/output variables
- [ ] control flow
- [ ] Goal metadata

**通过标准**：LLM 不需要自己精确管理 editor wiring。

---

### V64 — Compile 后 Static Validation

检查：

- [ ] 无孤立节点
- [ ] 无断边
- [ ] 无未定义变量
- [ ] 无未定义 output
- [ ] 无非法 operator
- [ ] 每个 Action Node 有 Goal
- [ ] Workflow 有 Goal
- [ ] Success Criteria 可验证

---

## 35.13 Phase M：Workflow Generation UI

### V65 — 生成过程状态可理解

至少有：

- [ ] Preparing Goal
- [ ] Finding Operators
- [ ] Executing
- [ ] Verifying
- [ ] Repairing（如发生）
- [ ] Certified / Failed

**通过标准**：用户无需猜测系统当前在做什么。

---

### V66 — 最终 Workflow 使用弹窗展示

**通过标准**：

- [ ] Workflow 结果以弹窗/独立 UI 打开
- [ ] 不追加成长文本尾部
- [ ] Workflow Name 可见
- [ ] Goal 可见
- [ ] Success Criteria 可见
- [ ] Certified 状态可见

---

### V67 — Node Goal 在编辑器中可直接查看

**通过标准**：

- [ ] 普通 Node Card 可查看
- [ ] Inspector 可查看完整 Contract
- [ ] 长文本可折叠
- [ ] Goal 不遮挡主要操作

---

### V68 — Verification Evidence 可查看

**通过标准**：用户能够看到某个 Node 为什么成功/失败，而不是只有红绿状态。

---

## 35.14 Phase N：性能与 Token

### V69 — 默认不加载完整 Tool Catalog

**测试**：简单点击/填写任务。

**通过标准**：仅加载必要 Operator schema。

---

### V70 — Discovery 候选规模受控

至少记录：

- [ ] averageCandidates
- [ ] maximumCandidates
- [ ] operator schemas loaded

**通过标准**：不会因为一次任务激活全部 Operator。

---

### V71 — Tool Round 数量验证

对简单任务记录：

- [ ] LLM turns
- [ ] operator calls
- [ ] discovery calls
- [ ] recovery calls

**通过标准**：优化后不会出现“为了选择工具而产生大量无意义回合”。

---

### V72 — Token 使用量验证

记录：

- [ ] candidate schema tokens
- [ ] total tool schema tokens
- [ ] prompt tokens（如现有系统可测）
- [ ] recovery tokens

**通过标准**：与旧实现比较，简单任务 Token 不明显上升，目标任务应下降。

---

### V73 — Blind Operator Retry Rate

**通过标准**：

- [ ] 不允许没有 failure classification 的重复尝试
- [ ] `blindOperatorRetryRate` 接近 0

---

## 35.15 Phase O：核心 E2E 业务场景

### V74 — 简单导航任务

示例：

```text
打开指定网站
```

验证：

- [ ] Goal
- [ ] navigation operator
- [ ] Node Goal
- [ ] terminal URL verification
- [ ] Workflow Certified

---

### V75 — 简单填写任务

示例：

```text
打开注册页并填写姓名和邮箱
```

验证：

- [ ] forms
- [ ] variables
- [ ] Node Goal
- [ ] success criteria

---

### V76 — 点击 + 状态验证任务

示例：

```text
点击提交并确认出现成功提示
```

验证：

- [ ] click
- [ ] wait/state
- [ ] verify
- [ ] Workflow Goal

---

### V77 — 单条件任务

示例：

```text
如果出现错误提示则停止，否则继续
```

验证：

- [ ] if / condition capability
- [ ] branch graph
- [ ] terminal behavior

---

### V78 — Loop 任务

示例：

```text
遍历所有商品，提取名称和价格
```

验证：

- [ ] loop-elements
- [ ] get-text / attribute
- [ ] data record
- [ ] output collection
- [ ] final verification

---

### V79 — Pagination 任务

示例：

```text
遍历所有分页直到没有下一页
```

验证：

- [ ] pagination intent
- [ ] loop
- [ ] next page
- [ ] termination condition
- [ ] no infinite loop

---

### V80 — Dynamic Content Generation 任务

示例：

```text
读取客户资料，生成个性化回复并发送
```

验证：

- [ ] read
- [ ] ai-agent
- [ ] variable
- [ ] forms/send
- [ ] final send verification

---

### V81 — Candidate Top-3 全失败任务

必须人为构造一个测试场景，使 Top 3 均失败。

验证：

- [ ] failure classification
- [ ] re-ground / retry
- [ ] expanded discovery
- [ ] alternative capability
- [ ] no blind JS
- [ ] final success or explicit controlled failure

---

### V82 — Repair 后恢复任务

构造一个初次失败、Repair 后可成功的任务。

验证：

- [ ] Failure Evidence
- [ ] Node Goal
- [ ] Repair
- [ ] Node Verification
- [ ] Workflow Goal Verification
- [ ] Certified

---

### V83 — 不可完成任务

构造一个 Registry 中确实不存在所需 capability 的任务。

验证：

- [ ] Discovery 无合适 Operator
- [ ] composition 失败后能够识别 capability gap
- [ ] JS gate 按规则判断
- [ ] 如果仍不可完成，则明确失败
- [ ] 不生成伪成功 Workflow

---

## 35.16 Phase P：回归测试

### V84 — 原有 Workflow Generation Benchmark 全部通过

**通过标准**：现有 benchmark 不因本 Spec 改造发生回归。

---

### V85 — 原有 Repair Benchmark 全部通过

**通过标准**：Unified Repair / Replay 相关测试全部通过。

---

### V86 — 原有 Operator Tool 测试全部通过

**通过标准**：所有已有 `wf_op_*` 相关测试全部通过。

---

### V87 — Workflow Compiler / Validation 测试全部通过

**通过标准**：现有 compiler / generated-validation / IR 测试全部通过。

---

### V88 — UI 回归

至少确认：

- [ ] Workflow Editor 加载
- [ ] Node Card
- [ ] Inspector
- [ ] Workflow Generation Popup
- [ ] Save
- [ ] Replay
- [ ] Repair
- [ ] Legacy Workflow

---

## 35.17 Phase Q：指标验收

### V89 — Goal 指标

必须测量：

- [ ] workflowGoalCompletionRate
- [ ] nodeGoalCompletionRate
- [ ] nodeSuccessCriteriaCoverage
- [ ] goalVerificationRate

---

### V90 — Operator Selection 指标

必须测量：

- [ ] top1Accuracy
- [ ] top3Recall
- [ ] recoverySuccessRate
- [ ] targetRecoveryRate
- [ ] parameterRecoveryRate
- [ ] unsupportedDetectionRate

---

### V91 — Operator Usage 指标

必须测量：

- [ ] nativeOperatorRate
- [ ] aiAgentRate
- [ ] javascriptFallbackRate
- [ ] blindOperatorRetryRate

---

### V92 — Performance 指标

必须测量：

- [ ] averageCandidates
- [ ] averageToolCalls
- [ ] averageSchemaTokens
- [ ] averageRecoveryRounds
- [ ] averageGenerationLatency

---

### V93 — Repair 指标

必须测量：

- [ ] repairSuccessRate
- [ ] repairedGoalSuccessRate
- [ ] regressionRate
- [ ] averageRepairRounds

---

## 35.18 Phase R：最终完整链路验收

### V94 — 完整正常任务链路

必须一次性跑通：

```text
User Request
→ prepare_workflow_goal
→ GoalSpec
→ capability inference
→ find_workflow_operators
→ candidate activation
→ operator execution
→ Node Goal Verification
→ next step
→ Workflow IR
→ compile
→ static validation
→ replay
→ Workflow Goal Verification
→ Certified Workflow
```

**通过标准**：链路无人工介入。

---

### V95 — 完整失败恢复链路

必须一次性跑通：

```text
Goal
→ candidate
→ failure
→ classify
→ recovery
→ re-ground / retry
→ candidate expansion
→ composition / AI Agent / JS gate
→ verification
→ final goal verification
```

**通过标准**：系统遵循 Recovery State Machine，而不是随机试错。

---

### V96 — 完整 Repair 链路

必须一次性跑通：

```text
Workflow
→ Node failure
→ Node Goal analysis
→ Success Criteria analysis
→ Repair patch
→ replay
→ Node Verification
→ Workflow Verification
→ Certified
```

---

### V97 — 生成结果用户可理解

最终检查：

- [ ] Workflow Name 有意义
- [ ] Trigger Goal 可见
- [ ] Trigger Success Criteria 可见
- [ ] 每个 Node Goal 可见
- [ ] 每个 Node Success Criteria 可见
- [ ] Workflow Certified 状态明确
- [ ] Verification Evidence 可查看

---

### V98 — 生成结果可复用

至少执行两次相同 Workflow：

- [ ] 第一次生成成功
- [ ] 保存成功
- [ ] 第二次 Replay 成功
- [ ] Goal 再次通过
- [ ] 不需要重新依赖原始对话上下文

---

### V99 — 失败结果不可伪装成功

强制检查：

- [ ] Node 执行成功但 Goal 失败 → Workflow FAIL
- [ ] Node Contract 失败 → Workflow 不 Certified
- [ ] Goal Verification 失败 → Workflow 不 Certified
- [ ] Repair 未验证 → Workflow 不 Certified
- [ ] Compile 失败 → Workflow 不 Certified

---

### V100 — 最终总验收

只有以下所有条件同时满足，才能将本 Spec 标记为 `DONE`：

- [ ] V01–V99 全部 PASS
- [ ] 无 P0/P1 已知缺陷
- [ ] 现有回归测试全部通过
- [ ] 新增 benchmark 全部通过
- [ ] 关键 E2E 任务通过
- [ ] JS fallback rate 达到 Acceptance Target
- [ ] Native Operator Rate 达到 Acceptance Target
- [ ] Goal Contract Coverage = 100%
- [ ] Node Contract Coverage = 100%
- [ ] Workflow Goal Verification 覆盖率 = 100%
- [ ] 没有未经验证却标记 Certified 的 Workflow

**最终状态必须输出：**

```text
WORKFLOW_GENERATION_SPEC_STATUS: DONE / BLOCKED

Validation:
V01: PASS/FAIL
V02: PASS/FAIL
...
V100: PASS/FAIL

Summary:
- Total: 100
- Passed: X
- Failed: Y
- Blocked: Z

Critical Failures:
- ...

Changed Files:
- ...

Tests:
- ...

E2E Evidence:
- ...

Metrics:
- Native Operator Rate: ...
- AI Agent Rate: ...
- JS Fallback Rate: ...
- Top-3 Recall: ...
- Goal Verification Rate: ...
- Repair Success Rate: ...
```

---

# 36. AI Coding Agent 执行纪律

1. 必须先实现 Phase 0，再进入 Phase 1，不允许跳阶段。
2. 每完成一个 `Vxx`，立即运行该项对应测试并记录结果。
3. `Vxx` FAIL 时不得继续把后续项目标记为 PASS。
4. 如果测试环境缺失，标记 `BLOCKED`，不得伪造 PASS。
5. 对于需要真实浏览器的项目，必须执行真实 E2E，而不能只用 Unit Test 代替。
6. 任何新增 Operator 必须同步增加 Registry、语义、Goal、Success Criteria、Failure/Repair hints 和测试。
7. 任何新增 Recovery 分支必须增加 failure fixture 和 benchmark。
8. 最终必须提交逐项 `V01–V100` 验收报告。
9. “代码已实现”不等于“功能已验收”；只有测试和实际结果都满足才算 PASS。
10. “测试通过”但没有验证真实 Workflow Goal 的任务，也不能标记 Workflow Generation 完成。

---

# 37. 最终产品级验收原则

整个功能最终必须满足以下事实：

```text
模型先明确目标
    ↓
系统快速找到合适的原生能力
    ↓
只执行必要的工具
    ↓
每个节点知道自己为什么存在
    ↓
每个节点知道什么叫成功
    ↓
节点失败根据失败原因恢复
    ↓
动态文案使用 AI Agent，而不是滥用 JS
    ↓
真正缺能力时才进入 JS Escape Hatch
    ↓
最终根据 Workflow Goal 判断任务是否完成
    ↓
只有验证通过才能产生 Certified Workflow
```

**因此，本 Spec 的最终完成条件不是“增加了几个工具、几个 Prompt 或几个字段”，而是 V01–V100 全部可验证通过，并且生成出来的 Workflow 在真实页面上能够完成目标、通过验证、可复用、可修复。**
