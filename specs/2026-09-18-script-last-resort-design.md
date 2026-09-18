# 代码节点是最后手段（工作流生成模式）· 设计

日期：2026-09-18 · 状态：已落地

## 需求与判据

用户原话：

> 工作流模式非常喜欢使用 js 脚本来操作页面数据，但这样后续维护必须要求使用者懂代码。
> 我需要生成的工作流，不到万不得已禁止使用脚本；只有一种情况允许：现有算子节点工具
> 无法完成当前任务时。

所以这不是"删掉 `javascript-code`"，而是三条同时成立的约束：

1. **默认不可见**——模型平时看不到这个工具，不能顺手拿它当便利工具；
2. **必须自证**——真要用，得说清楚试过哪些算子、为什么不行；
3. **理由留存**——理由要跟着节点进工作流，让维护者看得见。

判据：一次生成里出现代码节点，必须是"有意为之 + 有据可查"，而不是"顺手"。

## 为什么不是直接禁用

`javascript-code` 有真实不可替代的场景（调用页面自带 API、读算子读不到的页面内部状态、
按页面自己的加密/序列化规则算提交值）。删掉它会把这类需求逼到"做不到"。
所以做的是**摩擦**，不是**禁止**：把"默认顺手用"变成"必须走一段流程"。

## 三层设计

### 1. 可用性层：escape 分组（不进任何常驻广告）

`operator-tools.ts` 新增第三个分层 `WORKFLOW_ESCAPE_BLOCK_IDS = {javascript-code}`：

| 分层               | 数量  | 何时出现在模型面前                                        |
| ------------------ | ----- | --------------------------------------------------------- |
| action（常驻）     | 23    | 每一轮                                                    |
| author（按需）     | 30    | `load_tools({groups:['operators_author']})` 之后          |
| **escape（按需）** | **1** | **只有 `load_tools({groups:['operators_escape']})` 之后** |

关键点：escape 是**独立分组**，不是塞进 author。否则"载入循环/数据处理"会顺带把代码节点
一起带进来，摩擦就没了。`advertiseTools` 的工作流分支从"二选一"改成三段拼装
（action + 已载入的 author + 已载入的 escape）。

`operators` 这个历史分组是全集超集，所以载入它时 escape 也一并算作已载入——
否则会出现"分组自报的工具列表里有它，但广告集合里没有"的自相矛盾。

### 2. 调用门禁：`justification` 必填

schema 层：escape 工具是**唯一**带 `required` 的算子工具（`REQUIRED_ARGS`），
参数说明写明"必须说明试过哪些算子、它们为什么不行"。

运行层：`scriptJustification(args)`（纯函数，放在 `operator-tools.ts` 以免两个调用方各写一份）
校验非空且 ≥ `MIN_SCRIPT_JUSTIFICATION_CHARS`(12)；不达标就在**任何副作用之前**返回
`SCRIPT_REFUSAL`——不碰页面、不写草稿，所以草稿里不会留下半个节点。

拒绝文案里逐个点名替代算子（get-text / attribute-value / forms / event-click /
conditions / element-exists / set-variable …）。实测"请优先用算子"这种泛泛提示会被忽略，
模型需要看到自己跳过的那几级台阶。

两条记录路径（`operator-tool-run` 执行路径、`operator-tool-handler` 纯记录路径）都加了门禁：
"没有任何路径能记录一个没理由的脚本"比"某条路径不能"更容易守住。

### 3. 可见性层：理由跟着节点走

- 理由写进节点的 `data.description`（画布卡片显示它；模型自己写了 description 时以模型为准）。
- `stripDraftOnlyKeys` 把 `justification` 从块参数里剔除——它是理由，不是积木参数。
- 工具结果回传 `scriptJustification` + `scriptNote`，要求模型在收尾总结里主动告诉用户
  "哪一步用了代码、为什么"。
- 保存卡片新增"需要代码的步骤"区块（`codeNodesOf` + 双语词条
  `chatWorkflowCodeNodesTitle/Hint/NoReason`）：用户**在保存前**就知道这版工作流哪几处要懂代码，
  可以当场要求重写。这是最后一道人肉闸门。

### 4. 提示词与指南

- `agent.ts` 工作流模式段落新增硬规则（SCRIPTS ARE A LAST RESORT），并写明载入方式与
  `justification` 要求；`load_tools` 描述里单独说明 escape 组。
- `operator-guide.ts`（同时是生成技能说明 + 保存前 AI 审查的领域知识）新增
  "代码节点是最后手段（默认禁止）"一节：允许的唯一情形、强制流程 4 步、**替代速查表**
  （把"想用代码做的事"逐条映射到算子）。映射表与速查里的 JS 条目改为指向该节。
- 顺手修掉指南里两个**不存在的算子**引用（`get-form`、`get-variable`）——那会让模型去找
  根本不存在的积木；读变量本来就直接写 `{{变量名}}`。

## 接线点

| 文件                                            | 改动                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/workflow/operator-tools.ts`            | escape 分层常量、`buildWorkflowEscapeTools`、`JAVASCRIPT_BLOCK_ID`、`SCRIPT_JUSTIFICATION_ARG`、`MIN_SCRIPT_JUSTIFICATION_CHARS`、`scriptJustification`、`SCRIPT_REFUSAL`、`REQUIRED_ARGS` |
| `src/background/agent.ts`                       | `TOOL_GROUPS.operators_escape`、`advertiseTools` 三段拼装、`load_tools` 菜单与描述、非工作流模式的三组过滤、模式提示词、`scriptNote`                                                       |
| `src/background/operator-tool-run.ts`           | 门禁（执行前）、理由落 description、结果回传 `scriptJustification`                                                                                                                         |
| `src/background/operator-tool-handler.ts`       | 门禁（纯记录路径）、`stripDraftOnlyKeys` 剔除 `justification`                                                                                                                              |
| `src/lib/workflow/operator-guide.ts`            | 新增"最后手段"节 + 替代速查表；修掉失效算子引用                                                                                                                                            |
| `src/sidepanel/ChatTab.tsx` / `src/lib/i18n.ts` | 保存卡片代码节点区块 + 双语词条                                                                                                                                                            |

## 验证

| 项目                                                   | 结果                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `tsc --noEmit` + `tsc --noEmit -p tsconfig.tests.json` | 0 错误                                                                                         |
| `eslint src tests`                                     | 干净                                                                                           |
| `prettier --check`（改动文件）                         | 干净                                                                                           |
| `vitest run`                                           | **143 文件 / 1763 用例全绿**（新增 `script-escape-hatch.spec.ts` 9 例，tiers/groups 各加若干） |
| 载荷（工作流第 1 轮）                                  | 23 个算子 · 23866 字（预算 24000，余量 134）                                                   |
| 载荷（载入 author 后）                                 | 53 个算子 · 39349 字（预算 40000）                                                             |
| 算子指南                                               | 6666 字（技能 8000 上限内）                                                                    |

载荷说明：把 `javascript-code` 移出常驻层省下的 schema 恰好抵掉新增提示词，但余量从 ~460 降到
134 字。**下次再动工作流模式提示词，先跑 `tests/agent-payload-size.spec.ts`**；
优先删重复句，而不是抬预算。

## 自审

- **可用性 ≠ 强制力**：只做分层，模型仍会在"顺手"时先 `load_tools` 再调用。所以门禁必须存在，
  而且必须在**副作用之前**——放在执行后就成了"先污染再道歉"。
- **门禁不能只挡一条路径**：纯记录路径（`runOperatorTool`）目前只有测试在用，但它同样是"记录"。
  规则放在共享的纯模块里，两条路径共用，避免漂移。
- **拒绝文案是产品的一部分**：它要能把模型推回算子，所以点名了具体替代项；泛泛的
  "prefer operators" 在实测里被无视。
- **测试承重检查**（变异实测）：把 `MIN_SCRIPT_JUSTIFICATION_CHARS` 从 12 改成 0
  （等于关掉"太短不算理由"这一半门禁），`script-escape-hatch.spec.ts` 里**恰好 2 个用例失败**
  （纯函数的"one-word answer"用例 + 调用级的"too short"用例），其余 7 个照旧通过——
  说明这两条断言真的卡在门禁上，而不是在复述实现。
  分层侧同理：`WORKFLOW_ACTION_OPERATOR_IDS` / `WORKFLOW_AUTHOR_OPERATOR_IDS`
  对 `javascript-code` 是显式 `not.toContain`，把它放回常驻层会直接失败。

## 遗留

1. ~~**`forms.getValue` 没有执行实现**~~ → **已修（2026-09-18 当日）**。见下节。
2. **保存前 AI 审查（`workflow-review`）没有针对 JS 步骤的判定**：审查现在只能"保留/剔除"，
   没有"这步本该用算子重写"的表达。共享指南已含规则，审查总结可能自发提到，但未固化。
3. **`README` / `website` 未提及本规则**：面向用户的"生成的工作流尽量不含代码"这句话还没写。
4. **载荷余量 132 字**（见上）。

## 修订：接通 `forms.getValue`（读表单实时值）

门禁再严也拦不住"有正当理由"的脚本，而**读输入框的实时值**原本恰恰是无算子可用的需求，
模型写 JS 的理由永远成立。补上它，比继续收紧门禁更有效。

三层同时缺失，缺一层都不算修好：

| 层     | 缺陷                                                                          | 修法                                               |
| ------ | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| 暴露   | `getValue` 在 `UI_ONLY_KEYS` 里，模型看不到                                   | 移出，并在 `SCHEMA_OVERRIDES` 给出说明             |
| 执行器 | `formsBlock` 不读 `getValue`，走进写入分支，用空的 `value` **清空**要读的字段 | 读取分流**置于写入路径之前**，转 `readFormValue()` |
| 内核   | 没有读单个控件实时值的 op（只有按 `name` 聚合的批量 `read_form`）             | 新增 `get_value`，`readControlValue()` 分类型取值  |

几个承重决定：

- **读实时值而非 `value` 属性**。`value` 属性停在初始默认值，会报陈旧内容——这正是
  "用 JS 读"与"用算子读"的差别所在，否则算子读出来的值不可信。
- **分流必须在写入之前**。写入路径会填 `value`（读取模式下为空），先走它就把字段清了。
  这是本次修复里唯一"顺序错了就静默破坏数据"的地方。
- **缺 `variableName` 报错而非 no-op**。读取必须有落点；静默跳过会让下游 `{{name}}` 解析成
  空串，正是动态数据那轮踩过的坑。
- **值保留原生类型**（checkbox→boolean、多选→数组），因为下游 `conditions` 按类型比较。
- **`KERNEL_VERSION` 3→4**。老内核没有这个分支，扩展重载但页面未导航时驻留的旧内核会把
  `get_value` 当未知 action。版本号是内核重建的唯一触发器。
- **`skipWhen` 而非改 `DATA_PARAMS` 结构**。读取模式下 `forms.value` 是残留字段、不是业务
  数据；不改分类表本身，避免影响写入模式。
- **历史审计记 `read_form` 而非 `fill`**。记成 `fill` 会让历史编译出的节点**清空**它本该
  读的字段——同一个块的正反两个方向必须在审计层也分开。

顺带修了 `getText` 只写 `lastText`、从不写节点声明的 `variableName` 的同类缺陷
（命名了变量却解析成空串），现在写声明名并保留 `lastText` 兼容既有工作流。

测试：`tests/kernel-form-value.spec.ts`（7 例，jsdom，各控件类型 + 非控件报错 + 实时值）、
`tests/forms-get-value.spec.ts`（10 例，含"不清空字段""缺 variableName 报错""写进声明变量"）、
`tests/operator-history.spec.ts` / `tests/workflow-from-history.spec.ts` /
`tests/dynamic-data-flow.spec.ts` 各补读取模式用例。
