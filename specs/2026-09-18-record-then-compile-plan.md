# 计划：工作流生成改为「先跑通一遍，再编译」

> ## ⚠️ 已被推翻（2026-09-18 晚）
>
> 本文描述的「动作工具 + 回合结束编译」方案**已不是当前实现**。用户明确要求回到
> **算子直出**（模型用 `wf_op_*` 真实执行，每步既操作页面也记录节点），并用
> **按分类分发工具**来解决本文要解决的 token 问题。
>
> 推翻原因：动作工具不记录任何节点，所以只要它们在工具面里，模型就会用它们，
> 草稿永远是空的、保存卡片永远不弹 —— 主产出路径被架空。
> 另外算子工具名本身就是动作语义（`wf_op_event-click` 就是"点击"），
> 本文假设的「模型猜不出算子」并不成立，真正的问题是**一次广告了 54 个**。
>
> **当前设计见 `specs/2026-09-18-operator-direct-category-dispatch-design.md`。**
> 本文保留作为历史记录；其中「动态数据必须接」「选择器探测」「引用完整性」
> 三项工作被继承下来（探测与完整性检查仍保留，只是不再阻塞弹窗）。

日期：2026-09-18
设计：`specs/2026-09-18-record-then-compile-design.md`
状态：**已废弃（superseded）**

## 已确认的既有资产（实施时复用，不要重写）

| 资产                           | 位置                         | 用途                                            |
| ------------------------------ | ---------------------------- | ----------------------------------------------- |
| `TOOLS`（32 个，动作语义直白） | `agent.ts:373`               | 新流程的执行工具面                              |
| `ACTION_TO_BLOCK`              | `storage.ts:1023`            | 动作 → 块映射，9 类                             |
| `workflowFromHistory`          | `storage.ts:1808`            | 编译器（trigger / wait / OCR / AI 预填 / 描述） |
| `hydrateRecordArgs`            | `agent.ts:3413`              | 已把短 ref 换成持久 target 落历史               |
| `maybePromptSaveWorkflow`      | `ChatTab.tsx:1456`           | 回合结束弹卡片；已预留 `source: 'history'` 字段 |
| `workflows.draft.get`          | `index.ts:1165`              | 卡片的数据来源命令                              |
| `scriptJustification`          | `operator-tools.ts:162`      | 代码节点门禁，复用                              |
| `validateWorkflowForRun`       | `lib/workflow/validation.ts` | 静态校验                                        |

## 里程碑划分

### M1 — 最小可用闭环（工具面 + 编译接线）

目标：workflow 模式改成"用原生工具真实跑通 → 回合结束从历史编译 → 卡片确认保存"。

- **M1.1 工具面**（`agent.ts`）
  - `advertiseTools` 的 workflow 分支改为返回 `TOOLS - {compose_workflow, run_javascript}`
    - `workflowLoadTools()`。
  - `TOOL_GROUPS.operators_escape` 从 `['wf_op_javascript-code']` 改为 `['run_javascript']`
    —— 代码仍然是最后手段，只是换了入口工具；`operators_author` 保留 `wf_op_*` 全集作逃生舱。
  - `workflowLoadTools` 的组枚举改为 `['operators_author', 'operators_escape']`（不变），
    描述里把"载入剩余算子"改成对应语义。
- **M1.2 系统提示**（`agent.ts:257` workflow 段）
  - 删掉"每步都走 `wf_op_*`"的要求。
  - 改为：真实完成任务；动作会自动记录；**避免探索性操作**（反复点开又返回、试错后改点别处），
    因为它们会被编译进工作流。
  - 保留：代码节点最后手段、动态数据、凭证、结束回合不调保存工具的规则。
- **M1.3 编译接线**（`index.ts` / `ChatTab.tsx`）
  - `workflows.draft.get`：草稿无动作节点时，回落到
    `workflowFromHistory(历史条目, 会话标题)`，返回 `source: 'history'`。
  - `ChatTab.maybePromptSaveWorkflow` 已能处理 `source`，确认 UI 不假设 draft。
- **M1.4 载荷预算**（`tests/agent-payload-size.spec.ts`）
  - workflow 模式预期从 23,913 降到 ~17,000；下调 `MAX_WORKFLOW_PAYLOAD_CHARS`
    并让测试**同时断言**:workflow 模式每轮开销不得高于 full auto 的 1.1 倍
    ——这条回归断言就是"模型不再试探"的守门线。

### M2 — 编译质量（剔除探索步骤 + 动态数据）

- **M2.1 `pruneExploration(steps)`**（新，纯函数，`lib/workflow/`）
  - 失败动作剔除（history entry 带 `ok`）。
  - 同目标连续重复只留最后一次成功的。
  - `A → back → A′` 模式剔除回退与首次 A。
  - 无下游消费者的读取可剔除，但**是导出/保存/通知的生产者时必须保留**。
  - 按 D4 默认只做前两条，后两条做成卡片上的可勾选建议。
- **M2.2 动态数据与凭证接到历史编译路径**
  - 对编译结果逐节点跑 `rewriteDataParams` + `declareWorkflowInputs` + `redactRecordedParams`。
  - **这是必须的**：现在这条路径完全没接，直接切过去会产出全是死数据的工作流。

### M3 — 可执行性校验

- **M3.1 `probeWorkflowSelectors(workflow, tabId)`**（新）
  - 注入页面对图中每个带 `selector` 的节点跑 `querySelectorAll`，记录匹配数。
  - 判定 `0` 失效 / `1` 唯一 / `>1` 歧义。
  - 受 `chrome.scripting.executeScript` 自包含硬约束，**改完必须跑
    `pnpm verify:injected`** 与 `node tmp/verify-injected-build.mjs`。
- **M3.2 卡片展示**：逐节点渲染校验结论，未命中高亮 + 提供重新拾取。
- **M3.3 i18n**：新增词条必须同时给 `en` + `zhCN`（`Messages` 是封闭类型）。

## M1 实施结果（2026-09-18 完成）

实测（`npx vitest run tests/agent-payload-size.spec.ts`）：

| 指标                    | 改造前                     | 改造后                          |
| ----------------------- | -------------------------- | ------------------------------- |
| workflow 第 1 轮        | 23,913 chars（~7,246 tok） | **17,939 chars（~5,436 tok）**  |
| workflow 加载编排层后   | 39,126（~11,856 tok）      | **33,152（~10,046 tok）**       |
| 工具 schema / full auto | 1.017×                     | **0.956×**（比 full auto 更小） |
| 每轮总开销 / full auto  | 1.402×                     | **1.052×**                      |

改动文件：`src/background/agent.ts`（工具面 + 系统提示 + load_tools 组菜单）、
`src/background/history-compile.ts`（新增，会话历史编译）、
`src/background/index.ts`（`workflows.draft.get` 回落）、
`src/lib/messages.ts`（`workflows.draft` 增加 `source`）、
`src/sidepanel/ChatTab.tsx`（消费 `source`）、
`tests/agent-payload-size.spec.ts` / `tests/agent-tool-groups.spec.ts` / `tests/history-compile.spec.ts`。

新增守门断言（防止算子面悄悄回来）：

- workflow 的工具 schema 不得超过 full auto 的 1.02 倍；
- workflow 模式首轮不得广告任何算子工具。

**真正的收益在轮次数而非单轮价格**：工具名即动作语义后，一步一次调用即可，
10 步任务从约 20 轮（打满 `DEFAULT_MAX_TOOL_ROUNDS`）降到约 10–12 轮，
总 input 开销从约 180k 降到约 60k tokens。

### 遗留缺口

1. **`read_current_page` 不可重放**（`ACTION_TO_BLOCK` 没有它的映射，且它没有选择器参数）。
   采集页面内容的任务必须走 `operators_author` 组的 `wf_op_get-text`，系统提示已写明，
   但这是"提示要求"而非"能力保障"，模型可能忘记。
2. **凭证捕获在历史路径上做不到**：算子路径靠 `credentialFillPath` 读 `locator.type`
   判断 `input[type=password]`，而 history entry 不记录字段类型。密码只会被当成普通
   业务数据声明成输入（明文默认值）。修法是在 `hydrateRecordArgs` 时把字段 type 一并落历史。
3. **选择器探测只在保存前做一次**，不覆盖"页面会变"的长期情况；也探测不了
   `target`（rich locator）里非 CSS 的策略。

## M2 / M3 实施结果（2026-09-18 完成）

### M2.2 动态数据接到编译路径 —— 完成（必须做的那一项）

这是"先跑一遍再编译"能成立的前提。没有它，编译出的工作流就是一份**死录像**：
把生成当天用户说的关键词永远填进去。

- 把 trigger 参数合并抽成 `mergeTriggerInputs`（`lib/workflow/dynamic-data.ts`），
  **算子路径与历史编译路径共用同一份实现**——两处各写一份必然漂移。
  `declareWorkflowInputs` 改为调用它。
- `history-compile` 新增 `applyDynamicData`：逐节点跑 `rewriteDataParams`，
  把业务字面量换成 `{{引用}}`，并把图里无法自产的声明成触发器输入。
  变量索引**故意为空**——原生动作不产生会话变量，所以每个业务字面量确实没有生产者，
  声明成输入是正确答案而非偷懒。

实测：`fill #q "iPhone"` + `open_url https://a.com` →
节点里是 `{{formsValue}}` / `{{newTabUrl}}`，触发器上声明两个输入且
`defaultValue` 保留观测值（开箱即跑，仍可编辑）。结构化参数（selector 等）保持字面量。

### M2.1 探索步骤剔除 —— 决定不单独实现

原计划写一套 `pruneExploration` 启发式。复核后判定**不该做**：

- 连续重复（同 selector 同值）编译器已有 `collapsesWith` 覆盖；
- 非连续重复（A → B → A）无法区分"探索"与"真实需求"，删错代价高于留着；
- 保存卡片上的 AI 审查（`workflows.review` + `OPERATOR_GUIDE` 的"节点取舍"一节）
  本来就承担这件事，判定标准还更全（含"无下游消费的读取"的反向情形）。

再写一套启发式只会与它冲突。失败动作的剔除已做（`ok === false` 不入编译）。

### M3 选择器存活探测 —— 完成

- `lib/workflow/selector-probe.ts`：类型 + `statusOf` / `selectorsOf` / `failingProbes`（纯函数）。
- `background/selector-probe.ts`：注入 `countMatchesInPage` 统计每个选择器的命中数。
  判定 **1 = 唯一（唯一的好答案）/ 0 = 失效 / >1 = 歧义 / -1 = 选择器非法**。
  返回 `null` 表示**无法探测**，语义是"未经验证"而**不是**"全部通过"。
- `workflows.draft.get` 对两个来源都探测，结果随卡片返回。
- 卡片展示：全部命中显示一行汇总；未命中/歧义逐条列出算子名 + 原因 + 选择器；
  探测不可用显示"未经验证"。
- i18n 五条词条（`en` + `zhCN` 同步，靠 `Messages` 封闭类型守住）。

验证：`pnpm verify:injected` 通过（16 个注入函数 / 18 个调用点）；
`node tmp/verify-injected-build.mjs dist/assets` 通过；`vite build` 成功。

## 不做（本次）

- 试运行（D2 已排除）。
- 循环折叠、子工作流等智能改写。
- 删除算子直出能力（保留为 `operators_author` 逃生舱）。

## 每阶段收尾自检

```
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.tests.json
npx eslint src tests
npx prettier --check <改动文件>
npx vitest run
```

改动涉及注入函数时追加：`pnpm verify:injected`，并 `vite build` 后
`node tmp/verify-injected-build.mjs dist/assets`。

**M1–M3 全部完成后的实测**：148 文件 / 1828 用例全绿；两个 tsconfig 0 错；
`eslint src tests` 干净；改动文件 prettier 干净；`vite build` 成功；
注入函数静态与产物两层验证均通过。
