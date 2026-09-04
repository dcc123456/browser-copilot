# 对话生成工作流的 AI 节点审查 + 默认算子 skill 设计

日期：2026-09-04
状态：已与用户确认（方案 A）

## 背景与问题

对话结束后点「保存为工作流」时，`workflowFromHistory()` 把本次会话所有已批准且成功
的动作确定性映射成算子节点（click→event-click、fill→forms、open_url→new-tab…），并
自动插入 `wait-connections`、`ai-agent`、`ocr` 等辅助节点，然后在聊天流里弹确认卡片。
现状问题：

1. 探索性点击、来回导航、页面内试错、一次性读取等"垃圾步骤"全部进入工作流；确认卡片
   只有 AI 预填写复选框，没有节点取舍能力。
2. AI 在对话中生成/整理工作流时缺少一份"该用什么算子、怎么用算子"的默认知识。

历史页的「保存为工作流」按钮（`rebuild()`）同样直接全量入库，需要一并接入审查。

## 目标

- 保存确认时由 AI 总结并判断哪些步骤有效：卡片先弹出（不阻塞），AI 审查后台进行；
  结果到达后展示中文总结 + 步骤勾选清单（默认勾选 = AI 判定），用户可微调后保存。
- 提供默认内置 skill `workflow-generator`：正文为算子使用指南（算子目录、对话动作到
  算子的映射、图结构规则、垃圾节点判定标准），同时作为审查提示词的单一事实源。
- 审查不可用（未配置 provider / 失败 / 超时 / 不可解析）时保留全部节点并提示。
- 两个入口都生效：聊天页保存确认卡片、历史页「保存为工作流」。

## 非目标

- 不给聊天 agent 新增直接编写/保存工作流的工具（`save_workflow`），仍走历史映射生成。
- 不做本地启发式兜底剔除（用户已选"保留全部 + 提示"）。
- 不改变工作流引擎、编辑器、`workflowFromHistory` 的映射逻辑本身。

## 架构总览

```
ChatTab / HistoryTab
  └─ workflowFromHistory()  → 候选 Workflow
       └─ sendCommand({type:'workflows.review', workflow})
            └─ background: workflow-review.ts
                 ├─ reviewStepsOf(workflow)        (lib/workflow/review-patch.ts, 纯)
                 ├─ buildReviewPrompt(steps)       (内嵌 OPERATOR_GUIDE)
                 ├─ streamCompletion(...)          (复用 provider，25s 超时)
                 └─ parseReview(text)              (防御性，缺省=keep)
       └─ 卡片/对话框：AI 总结 + 步骤勾选（默认=AI 判定）
            └─ 保存时 applyNodeKeepSelection(base, keep) → applyAiPrefillOptions(...)
```

## 1. 步骤分组与保留集应用（新文件 `lib/workflow/review-patch.ts`，纯函数）

生成的图是 trigger 起点的线性链，节点分两类：主步骤（用户可理解的动作）与附属节点
（自动插入的机制节点）。代码先把图切成"步骤"，AI 与 UI 只面对步骤。

```ts
export interface ReviewStep {
  /** 主节点 id，同时是审查 verdict 的 key */
  id: string
  blockId: string
  description: string
  params: Record<string, unknown>
  /** 随主节点一起取舍的附属节点 id */
  satelliteIds: string[]
  /** 附属节点的人类可读摘要（行内灰字展示用） */
  satelliteSummary: string[]
}

export function reviewStepsOf(workflow: Workflow): ReviewStep[]
export function applyNodeKeepSelection(
  workflow: Workflow,
  keepStepIds: Record<string, boolean>,
): Workflow
```

### 附属归属规则（沿链扫描）

- `wait-connections` → 随**前一个**主步骤（节奏等待）。
- `ai-agent` 预填写（有 `variableName` 且无 `purpose`）→ 随**后面第一个**消费
  `{{变量}}` 的节点（forms）。
- OCR 识别簇（`set-variable`(OCR 图片地址) + `ocr` + `ai-agent`(purpose=`ocr-extract`)）
  → 随**后面第一个**消费其输出变量的 forms 步骤。
- trigger 不进任何步骤，永不参与取舍。

### `applyNodeKeepSelection` 规则

- `keep[stepId] === false` → 整组删除（主节点 + 附属节点）。
- 其余节点按链序重连边，handle 约定与 `workflowFromHistory` 一致
  （`<blockId>-output-1` → `<blockId>-input-1`）。
- 纯函数、幂等、缺省 keep = 原图；trigger 永远保留。
- 与 `applyAiPrefillOptions` 正交：保存时按 `base → keep → aiPrefill` 顺序从 base
  重导出，两个开关互不污染（沿用 ChatTab 现有"从 untouched base 重导出"的幂等模式）。

## 2. 后台审查（新文件 `background/workflow-engine/workflow-review.ts` + `workflows.review` 命令）

完全沿用 `auto-debug-ai.ts` 的模式：

- 输入：面板发来候选 `Workflow`（两个入口都已构建好）。
- 提示词 `buildReviewPrompt(workflow)` = `OPERATOR_GUIDE` + `reviewStepsOf` 步骤清单
  （参数字符串截断 200 字符）+ 输出契约：**只回 JSON**
  `{"summary":"…","steps":[{"id":"…","keep":true,"reason":"…"}]}`。
  `summary` 用中文向用户解释这段操作在做什么、剔除了什么及原因。
- 防御性解析 `parseReview`：没 JSON / id 不认识 / 字段缺失 → 该步骤一律 keep=true，
  绝不因模型输出异常丢步骤；完全不可解析 → 返回 `null`（= 审查不可用）。
- 调用超时 25s（AbortSignal.timeout）；未配置 provider → 直接 `null`。
- `maxTokens: 1000`。

### 垃圾/有效判定标准（写入提示词，与 OPERATOR_GUIDE 同源）

- 垃圾：探索性点击（点了又返回、点开又关闭）、来回导航、页面内试错重试、纯快照/
  读取类一次性动作（`read_current_page` 不映射块，本就不入图；`get-text` 等读取块
  若结果未被后续步骤消费）、同目标重复操作只留最后一次。
- 有效：能确定性重放的业务动作（导航、点击、填表、按键、提交），以及支撑它们的
  识别/变量机制节点。

## 3. 算子使用指南（新文件 `lib/workflow/operator-guide.ts`，单一事实源）

导出中文常量 `OPERATOR_GUIDE`（预算 < 8000 字符，符合 skill 存储上限
`MAX_INSTRUCTIONS_LENGTH`）：

- 图结构规则：trigger 起点、连边 handle 约定、`{{变量}}` 引用、扁平 selector/findBy
  数据形状。
- 全量算子速查：按 6 类（browser / navigation / data / control-flow / integration /
  trigger）一行一个——`id 用途：何时用/关键参数`（与 `registry.ts` 对齐）。
- 对话动作 → 算子映射表（即 `ACTION_TO_BLOCK`：click→event-click、fill→forms、
  wait_for→delay、run_javascript→javascript-code、recognize_image→ocr…）。
- 三种固定搭配范式：导航后接 `wait-connections`；AI 内容预填
  （ai-agent → `{{变量}}` → forms）；验证码识别（set-variable → ocr → 提取 → forms）。
- 垃圾节点判定标准（与 §2 提示词同一份措辞）。

**两处消费**：① 审查提示词内嵌；② 内置 skill `workflow-generator` 正文基础。

## 4. UI 入口

### 4.1 ChatTab 保存卡片

`workflowPrompt` state 扩展（沿用"从 base 重导出"模式）：

```ts
{
  ...现有字段,
  reviewing: boolean,                    // true = 审查进行中
  review: WorkflowReview | null,         // 失败/不可用 = null
  keep: Record<string, boolean> | null,  // null = 未出结果（全保留）
}
```

- 卡片在 `maybePromptSaveWorkflow` 中**立即弹出**，同时后台发 `workflows.review`。
- `reviewing` 时显示一行「AI 正在审查节点有效性…」；结果到达后替换为 AI 总结段落。
- 总结下方是步骤清单：每个 `ReviewStep` 一行复选框（默认 = AI 判定），AI 剔除的步骤
  行内小字显示剔除理由；附属节点不单独成行，以灰色小字附在主步骤行内
  （如 `· 等待页面加载`、`· AI 生成表单内容`）。
- 用户改勾选 → `keep` 更新 → 预览按 `base → keep → aiPrefill` 重导出，标题步骤数同步。
- 现有「AI 预填写」复选框区块不变，与步骤取舍并存（仅被保留的步骤显示预填开关）。
- 保存按钮始终可用（审查未返回时保存 = 全保留，与现状一致）；保存/放弃后关闭卡片，
  迟到的审查结果必须被丢弃，不得让已关闭的卡片复活（沿用 `workflowPrompt` 单一 state）。

### 4.2 HistoryTab「保存为工作流」

`rebuild()` 改为：构建 workflow → 打开审查对话框（新组件，内部复用共享展示组件
`WorkflowReviewList`：总结 + 步骤勾选清单）→ 后台审查 → 勾选确认 → 确认才
`saveWorkflow`。降级时对话框只显示提示行 + 确认/取消。

### 4.3 共享组件（新文件 `sidepanel/WorkflowReviewList.tsx`）

纯展示：AI 总结 + `ReviewStep[]` 勾选清单（勾选态、理由、附属灰字）+ 可用性提示行。
ChatTab 卡片与 HistoryTab 对话框都以它渲染清单部分。

## 5. 内置 skill `workflow-generator`（`lib/builtin-skills.ts`）

与 `skill-generator` 并列的第二个内置条目，走既有 `seedBuiltInSkills` 幂等种子机制
（同名不存在才插入；id 匹配且 `updatedAt === 0` 的未编辑副本随升级刷新）：

- `id`: `builtin-workflow-generator`
- `name`: `workflow-generator`
- `description`（触发器）：把对话操作或需求整理成正确的工作流：讲解各算子节点的用途
  与用法、对话动作到算子的映射、哪些步骤值得进工作流并剔除探索性动作。Use when the
  user asks to 生成工作流/保存为工作流/做成自动化，or asks which operator/block to
  use for something.
- `instructions`: `OPERATOR_GUIDE` + 收尾指引（生成前先列步骤清单并标注去留及理由 →
  给出图节点/连边 JSON 形状 → 说明保存卡片会再做一次 AI 审查，判定标准一致）。
- `autoMatch: true`：对话中说"把刚才的操作做成工作流"时 agent 经 `use_skill` 加载。

## 6. 命令与类型（`lib/messages.ts`）

```ts
// Command
| { type: 'workflows.review'; workflow: Workflow }
// CommandResult
| { type: 'workflows.review'; review: WorkflowReview | null }
```

`WorkflowReview` 类型放在 `lib/workflow/review-patch.ts`：

```ts
export interface WorkflowReview {
  /** 中文总结：这段操作在做什么、剔除了什么 */
  summary: string
  /** 每个步骤的取舍判断（key = ReviewStep.id） */
  steps: { id: string; keep: boolean; reason?: string }[]
}
```

## 7. 降级与错误处理（两入口一致）

| 情况 | 行为 |
|---|---|
| 未配置 provider | 后台短路返回 `review: null`（不调模型），UI 显示「AI 审查不可用，已保留全部节点」 |
| 超时(25s)/网络失败 | 同上提示，全保留 |
| 返回不可解析 | 同上提示，全保留 |
| 部分 step id 不认识 | 该步骤按 keep 处理，可用部分照常展示 |
| trigger | 永远保留，不进步骤清单 |

## 8. i18n（`lib/i18n.ts`，zh/en 各一份）

`chatWorkflowReviewing`、`chatWorkflowReviewUnavailable`、
`chatWorkflowReviewDropped({count})`、`chatWorkflowReviewKept`、
`workflowReviewDialogTitle`、`workflowReviewDialogConfirm`、
`workflowReviewDialogCancel`。

## 9. 测试（tests/ 下 vitest spec）

- `review-steps.spec.ts`：分组正确性（wait 随前步、预填 agent 随 forms、OCR 簇随消费
  forms、trigger 排除、无附属的独立主步骤）。
- `review-patch.spec.ts`：删中间步骤后连边完整、整组删除、空 keep = 原图、幂等、
  trigger 保护、handle 命名与 `workflowFromHistory` 一致。
- `workflow-review-ai.spec.ts`：`buildReviewPrompt` 包含步骤 id / 算子指南 / JSON 契约、
  长参数截断；`parseReview` 对合法 JSON / 带围栏 / 缺 id / 纯噪声的行为。
- 既有 `workflow-from-history`、`ai-prefill-storage` 回归不破坏。

## 涉及文件

新增：`lib/workflow/operator-guide.ts`、`lib/workflow/review-patch.ts`、
`background/workflow-engine/workflow-review.ts`、`sidepanel/WorkflowReviewList.tsx`、
`tests/review-steps.spec.ts`、`tests/review-patch.spec.ts`、
`tests/workflow-review-ai.spec.ts`

修改：`lib/messages.ts`、`background/index.ts`、`lib/builtin-skills.ts`、
`sidepanel/ChatTab.tsx`、`sidepanel/HistoryTab.tsx`、`lib/i18n.ts`
