# 设计：工作流生成改为「先跑通一遍，再编译成可执行工作流」

日期：2026-09-18
状态：**待评审**（分析已完成，方案待拍板）

## 1. 问题

用户反馈：聊天中的工作流生成模式下，模型不断试探各种算子节点工具，而不是确定地调用
正确的工具，token 消耗巨大、耗时巨大。

用户诉求：在工作流生成模式下，**先把任务真实跑通一遍**，然后把用到的工具、操作步骤
组合成一个工作流，并**保证这个工作流可以执行**。

## 2. 诊断：模型为什么会试探

### 2.1 实测数字

`npx vitest run tests/agent-payload-size.spec.ts`（2026-09-18 实测）：

| 模式                               | system | tools  | 合计   | 约合 tokens |
| ---------------------------------- | ------ | ------ | ------ | ----------- |
| full auto 第 1 轮                  | 3,976  | 13,084 | 17,060 | ~5,170      |
| workflow 第 1 轮（23 算子）        | 5,781  | 18,132 | 23,913 | ~7,246      |
| workflow 加载 author 后（53 算子） | 5,781  | 33,345 | 39,126 | ~11,856     |

工具 schema 与 system prompt **每一轮都重发**，且对话历史累积。
轮次上限 `DEFAULT_MAX_TOOL_ROUNDS = 20`（`src/background/agent.ts:168`）。

### 2.2 七条根因

**R1 · 决策面宽而信息浅。** 23 个常驻算子平铺，每个只有一句 ≤160 字符的描述
（`operator-tools.ts:306` `MAX_OPERATOR_DESCRIPTION_CHARS`），内容是 catalog 的 UI 文案
——回答"这个块是什么"，不回答"这一步该用哪个"。

**R2 ·「对话动作 → 算子」映射表模型拿不到。** 这张表在 `operator-guide.ts:123`，
但它只以 `workflow-generator` 技能的**正文**存在（`builtin-skills.ts:97`）。
技能的自动匹配只把 `name + description` 放进目录（`skills.ts:110` `renderSkillCatalogue`），
模型要主动 `use_skill` 才能拿到正文；而 workflow 模式的工具面是
`WORKFLOW_READ_TOOLS + workflowLoadTools() + 算子`（`agent.ts:1007`），**不含 `use_skill`**，
`workflowLoadTools` 的组枚举也被钉死为 `['operators_author','operators_escape']`
（`agent.ts:1088`）——**模型在这个模式下没有任何途径加载它**。切模式也不会自动 pin
（`activeSkill` 只来自用户手动选择，`agent.ts:3056`）。
结果：模型拿着 23 个算子名字和一句话描述，靠语义猜。

**R3 · 参数 schema 从默认值推导，看不见枚举。** `dataSchemaFromEntry`（`operator-tools.ts:444`）
用 `entry.data` 的**默认值**推类型，所以 `forms.type` 之类是 `{type:'string'}`，
模型看不到 `'text-field'|'select'|'checkbox'`。填错 → 失败 → 重来一轮。
（`conditions` 和 `forms.getValue` 靠手写 `SCHEMA_OVERRIDES` 补，说明这条路本来就要人工兜底。）

**R4 · 试探的代价被"执行即记录"放大成整轮 LLM 请求。** 失败时
`runOperatorToolWithExecution` 只返回一句 error（`operator-tool-run.ts:321`），
不写节点、不回退、不给替代建议。修正 = 下一轮 = 重发 7,246~11,856 tokens。
没有干跑、没有预演、没有"这个算子能不能用"的查询通道。

**R5 · 17 个 record-only 算子给零反馈。** `executeOperatorNode` 对它们直接返回
`{status:'record-only', note}`（`operator-exec.ts:130`），**不执行但照样记录节点**。
模型调完不知道自己这一步是否真的能工作，后续步骤的参数只能继续猜。

**R6 · 每步都要先 snapshot 才能拿到 ref。** 系统提示要求用 `snapshot_page` 的 ref 定位
（`agent.ts:263`），而算子工具也接受 `selector`（标注"last resort"）。
不看就猜 → 失败率高；看了就得多一轮。20 轮上限下，一个 10 步任务很容易被打断在
`Stopped after 20 tool rounds to avoid a loop.`。

**R7 · 三道执行前门禁扩大了拒绝面。** `scriptJustification`、`unproducedBulkData`、
`credentialFillPath` 都在**任何副作用之前**拒绝（`operator-tool-run.ts:270/305/286`）。
拒绝本身是对的，但每次拒绝同样是一整轮 token，而模型只能从错误文本里反推边界
（比如"内容 >400 字或 >200 字且换行 ≥8"这种阈值它无从得知）。

### 2.3 根因汇总

> 模型不是在"试探"，它是在**用整轮 LLM 请求做本来该由一次查表完成的事**：
> "点这个按钮" → 该调哪个算子、参数怎么填。
> 而查表所需的那张映射表，恰好被挡在了这个模式的工具面之外（R2）。

## 3. 目标与非目标

### 目标

- **G1** 一个 10–15 步的任务能在轮次预算内跑完，token 消耗显著下降。
- **G2** 生成的工作流**可执行**：节点参数来自真实发生过的动作，不是模型想象。
- **G3** 交付前给出**可验证**的可执行性证据，而不是"应该能跑"。
- **G4** 沿用现有动态数据 / 凭证脱敏 / 代码节点最后手段三条硬约束。

### 非目标

- 不追求生成"最优"的工作流图（不引入循环折叠等智能改写，保留为后续）。
- 不改变工作流引擎与执行器本身。
- 不删除现有算子直出能力（见决策点 D1）。

## 4. 方案：执行 → 编译 → 校验 → 交付

### 4.1 三阶段总览

```
阶段 A 执行 Execute
  模型用原生动作工具（click / fill / open_url / press_key / scroll / run_javascript …）
  真实跑通任务。工具名即动作语义，无需映射；每轮 5,170 tokens。
  动作自动进 action history，且 `hydrateRecordArgs`（agent.ts:3413）已把
  短 ref 换成**持久 target** —— 可重放的选择器已经在数据里了。

阶段 B 编译 Compile
  会话结束 → workflowFromHistory(entries) → 图
    ├─ 已有：ACTION_TO_BLOCK 映射、trigger 头节点、导航后 wait-connections、
    │        AI 预填、OCR hand-off、fill 形 JS 转 forms、description 生成
    ├─ 新增 B1：剔除探索性步骤
    └─ 新增 B2：动态数据改写 + 凭证脱敏（现在这条路径完全没有接）

阶段 C 校验 Verify
    ├─ C1 静态：validateWorkflowForRun（已有）
    ├─ C2 选择器存活探测：页面还开着，逐节点验证选择器命中唯一元素
    └─ C3 试运行（用户手动触发，默认关闭）

交付：保存卡片，逐节点展示校验结论
```

### 4.2 为什么这条路可行（既有资产）

| 资产                            | 位置                                | 状态                                           |
| ------------------------------- | ----------------------------------- | ---------------------------------------------- |
| `ACTION_TO_BLOCK` 动作→块映射   | `storage.ts:1023`                   | 已有，覆盖 9 类动作                            |
| `workflowFromHistory` 编译器    | `storage.ts:1808`                   | 已有，含 trigger / wait / OCR / AI 预填 / 描述 |
| 持久 target 落历史              | `agent.ts:3413` `hydrateRecordArgs` | 已有                                           |
| 历史→工作流的 UI 入口 + AI 审查 | `HistoryTab.tsx:907`                | 已有（用户手动触发）                           |
| `validateWorkflowForRun`        | 验证模块                            | 已有，目前只接 `workflows.run`                 |
| 选择器身份+顺序校验             | `collapse-probe.ts`                 | 已有，C2 可复用其 `matches` 思路               |

**缺口**：`workflowFromHistory` 整条路径**没有接**
`rewriteDataParams` / `declareWorkflowInputs` / `secret-guard`
（grep `storage.ts` 无相关 import；只有 `operator-tool-run.ts` / `operator-tool-handler.ts` 接了）。
直接切过去会得到一份**全是死数据**的工作流——违反 2026-09-17 的硬约束。
**B2 是必须做的一阶段，不是可选项。**

### 4.3 新增 B1：剔除探索性步骤

`workflowFromHistory` 现在的 `collapsesWith` 只合并连续同类动作。需要新增
`pruneExploration(steps)`，规则：

1. **失败动作直接剔除**——history entry 带 `ok` 字段（`recordAction` 已记录）。
2. **同目标重复只留最后一次成功的**——相同 selector + 相同动作的连续尝试。
3. **A → back → A′ 模式**——剔除中间的回退与第一次的 A。
4. **无后续消费的读取**——结果未被任何下游步骤引用的 get-text / read_form 可剔除
   （但要守住反向情形：它是导出/保存/通知的**生产者**时必须保留，否则工作流抓不到数据）。

规则 4 的判定复用 2026-09-17 dynamic-data 里已有的"生产者"概念，不另立标准。

### 4.4 新增 C2：选择器存活探测

页面在编译后仍然开着，这是免费的可执行性证据。

- 对图中每个带 `selector` 的节点，注入页面执行 `querySelectorAll(selector)`，
  记录匹配数。
- 判定：`1` = 命中唯一；`0` = 选择器已失效；`>1` = 有歧义（回放会点错元素）。
- 复用 `collapse-probe.ts` 已验证过的身份+顺序校验思路，不新写一套。
- 结果渲染在保存卡片的每个步骤旁，未命中的节点高亮并提供"重新拾取"。

**C2 解决的是"保证可执行"里最实际的一半**：一个工作流跑不通，绝大多数情况是选择器
失效或歧义，不是图结构错。

### 4.5 收益估算

|                      | 现在（算子直出）                        | 新方案                 |
| -------------------- | --------------------------------------- | ---------------------- |
| 每轮成本             | 7,246 → 11,856 tokens                   | 5,170 tokens           |
| 10 步任务所需轮次    | ~20（每步 snapshot + 算子，常打满上限） | ~10–12（工具自带观察） |
| 10 步任务 input 开销 | ~150k–200k tokens                       | ~55k–60k tokens        |
| 参数正确性           | 靠模型猜 schema                         | 来自真实执行           |
| 可执行性证据         | 无（保存后首次运行才暴露）              | 编译后逐节点验证       |

## 5. 决策点（2026-09-18 已拍板）

**D1 · 接入方式 → 改造现有 `workflow` 模式本体。**
不新增模式，不加设置开关。`workflow` 模式的语义从「模型逐节点选算子」改为
「模型真实跑通任务 → 系统编译」。算子工具（`wf_op_*`）不再常驻广告，降级为
`load_tools({groups:['operators_author']})` 里的逃生舱，保留代码但不再引导使用。

**D2 · 验证强度 → 静态校验 + 选择器探测（C1 + C2）。**
不做试运行（C3）。真实重放留给用户在保存后自行触发，避免重复下单/发帖的副作用。

**D3 · 触发方式 → 弹卡片供确认。**
任务完成后弹出"生成为工作流"卡片，带步骤清单、探索步骤剔除建议、逐节点校验结论，
用户确认后才保存。不自动入库。

**D4 · 探索步骤剔除（B1）的默认强度？**
激进剔除会丢掉用户想要的细节；保守剔除会留下垃圾节点。
建议默认剔除"失败动作"与"同目标重复"，把"A→back→A′"和"无消费读取"做成卡片上可勾选的
清理建议，而不是静默删除。

## 6. 实施阶段（待 D1 确定后细化）

- **P1** 固化诊断：为 R2（workflow 模式拿不到技能）与 R5（record-only 零反馈）补断言测试，
  防止后续改动悄悄绕开。
- **P2** 模式与工具面：按 D1 落地。
- **P3** 编译服务：`workflowFromHistory` + `pruneExploration`（B1）。
- **P4** 动态数据与凭证规则接到编译路径（B2）——**必须**。
- **P5** 选择器存活探测（C2）与保存卡片展示。
- **P6** 试运行（C3，按 D2）。
- **P7** 测试：`pnpm typecheck`（两个 tsconfig）、`pnpm test`、`pnpm build`。

## 7. 参考

- `specs/2026-09-17-workflow-generation-mode-design.md`（现有算子直出设计）
- `specs/2026-09-17-dynamic-data-design.md`（动态数据硬约束）
- `specs/2026-09-18-script-last-resort-design.md`（代码节点最后手段）
