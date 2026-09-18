# 设计：工作流生成模式（Workflow Generation Mode）重构

日期：2026-09-17
状态：已实施并验证（Phase 0–9 全部完成；`pnpm test` 137 文件 / 1675 用例全绿）

## 背景与目标

`AgentMode = 'workflow'`（工作流生成模式）原先只是**纯起草**：模型逐节点挑选算子写入草稿，
算子工具**不执行**，节点是否真能跑通无人验证；`composeWorkflowFromDraft` 硬编码
`trigger: { type: 'manual' }` 且**不生成 trigger 节点**，产出的工作流保存后无法直接运行。

本次把它改为**「真操作 + 真记录」**：

- 基础能力与全自动模式一致：能开网页、点元素、填表单、切换标签页。
- 区别：**每一步都通过工作流算子工具（`wf_op_*`）执行**，执行成功后把该算子节点写入会话草稿。
- 回合结束生成的工作流**必须带触发器**，保证可直接运行。

### 已确认的产品决策

| 决策点                   | 结论                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| 执行模型                 | 算子工具**真的操作页面**，成功才记录节点（"记录即事实"）                                       |
| 触发器                   | 自动插入 `trigger` 头节点（默认 `manual`），保存卡片可改类型                                   |
| 模式归属                 | 改造现有 `'workflow'`，不新增模式                                                              |
| 循环折叠                 | 相同段折 `repeat-task`；**变化段也自动改写为 `loop-elements`**                                 |
| 算子集范围               | 扩充到 66 个目录项（补 `CUSTOM_BLOCKS` 的 `ai-agent` / `ocr` / `set-variable` / `get-secret`） |
| delay / wait-connections | **真执行**（真等待）；**只在需要等待时生成，不需要就不生成**，不自动插入等待节点               |
| element-change 触发器    | 本期实现监听器                                                                                 |
| 凭证                     | 模型只能拿到凭证的**名称**，拿不到值                                                           |

## 方案取舍（已否决的备选）

- **算子工具只记录、不执行**（原状）：草稿里可以出现页面根本点不到的选择器，模型无从发现；
  用户拿到的工作流首次运行才暴露问题。与"记录即事实"矛盾。否决。
- **执行与录制各写一套代码**：两处必然漂移，且漂移是静默的（草稿说做了 A，实际做了 B）。
  改为**共用 `EXECUTORS[blockId]`**（见 3.1）。否决。
- **从历史记录重建草稿**：历史里是 `click`/`fill` 原始动作，重建走
  `workflowFromHistory` 是另一条路径，产出的图与模型逐节点选的算子不一致，
  等于静默替换成一份用户没审过的草稿。否决。
- **变化段折叠直接改写，不做页面验证**：实测会生成跑不通的图（循环迭代到错误的元素）。
  改为**先由页面探测验证出唯一选择器，验证失败即降级为"只提示、不改写"**（见 3.4）。否决。
- **`validateWorkflow()`（结构校验）接进 `saveWorkflow`**：会拒掉存量工作流。否决；
  只把新的 `validateWorkflowForRun` 接到 `workflows.run`（见 3.3）。

## 详细设计

### 3.1 执行桥：记录即事实

```
side panel (ChatTab)
   │  mode='workflow' + 危险确认
   ▼
background: runAgentTurn → runOneToolCall → executeTool(default 分支)
   │        advertiseTools: 动作面算子(24) + 读工具(3) + load_tools
   ▼
runOperatorToolWithExecution                       ← 编排层
   ├─ resolveRecordedLocator(args)                 ← ref/target/selector → 持久 selector
   ├─ executeOperatorNode(blockId, data)           ← 执行桥
   │     └─ EXECUTORS[blockId](data, 合成 ctx)     ← 与工作流回放同一套执行器
   └─ appendOperatorNode(draft, ...)               ← 成功才写草稿
   ▼
draft-storage (L2 持久) ──► composeWorkflowFromDraft ──► 保存卡片（触发器选择）
```

**核心原则：算子工具的执行与工作流回放走同一套 `EXECUTORS`。**
"录制 = 真实发生"由构造保证，不靠两处代码同步。执行失败 → **不写节点**，把错误回灌给模型。

草稿 `draftStore` 是模块级内存 `Map`，MV3 service worker 被回收即丢失 → 新增
`src/lib/workflow/draft-storage.ts` 做 L2 持久化（复用 `fs-store` 的存储区），
`draftStore` 降级为 L1 写穿缓存；`DRAFT_STORE_CAP` 只淘汰缓存，**不删 L2**。

### 3.2 算子分类 `operatorExecClass`

`src/lib/workflow/operator-class.ts`（纯 block-id 数据，无 chrome 依赖，供 lib 层复用）：

```ts
export type OperatorExecClass = 'execute' | 'record-only'
export function operatorExecClass(blockId: string): OperatorExecClass
export function recordOnlyReason(blockId: string): string
```

实测分布：**54 个算子工具**（`BLOCK_CATALOG` 62 条 + `CUSTOM_BLOCKS` 4 条 = 66 条目录项，
其中 cloud-only 与无编辑表单的占位块不暴露为工具），其中 **37 个 `execute`、17 个 `record-only`**。

`record-only` 的两类原因：引擎解释执行的块（单个节点调用表达不了，如 `trigger`、
`execute-workflow`）与纯副作用块。分类**单一来源**：UI 警告与执行桥都从它取，
不再各自维护映射表——本次修掉了 `OPERATOR_META` 与 `operatorExecClass`
**双向不一致 20 处**的历史问题（`proxy`/`browser-event`/`save-local` 被误报警告，
`conditions`/`clipboard`/`delay` 真执行却没警告）。

### 3.3 触发器：双份状态与运行前校验

触发器状态在代码里是**两份**，这是最容易出错的地方：

| 位置                           | 谁读它                                                      |
| ------------------------------ | ----------------------------------------------------------- |
| `workflow.trigger`（顶层镜像） | `visit-web` / `context-menu` 运行时                         |
| 图里的 trigger 节点            | `workflowAutoTrigger` / `effectiveTriggerKind` / 定时 alarm |

`triggerFromNodes()`（`src/lib/workflow/migrate.ts`）把图内节点派生到顶层镜像，
但 **`saveWorkflow()` 不会调它**（只有编辑器 `handleSave` 会）。
因此面板保存路径必须自己 patch：`applyTriggerSelection(workflow, sel)`
（`src/lib/workflow/trigger-patch.ts`）找到或创建 trigger 节点 → 写 `data.type`
与类型专属字段 → **同时**回写顶层镜像。漏掉任何一半，定时 alarm / 上下文菜单注册都会错位。

可用触发器类型 `OFFERED_TRIGGER_TYPES` 共 **9 类**：`manual` / `on-startup` /
`keyboard-shortcut` / `context-menu` / `visit-web` / `interval` / `specific-day` /
`date` / `element-change`。`scheduled` 未挂 alarm，不提供。
`validateWorkflowForRun(wf)` 只接 `workflows.run`：检查触发器存在且启用、类型在可用集、
类型必填参数齐全、至少一个非 trigger 节点、每条边端点存在。

### 3.4 循环折叠

线性记录 + 把重复段折叠为循环块。三个新增能力缺一不可，任一不成立产出的工作流就跑不通：

**a. 引擎参数插值**（`src/lib/workflow/interpolate.ts`）
原先 `sel(data)` / `targetFrom(data)` **不做插值**，所以 `{{loopElementSelector}}`
会原样留在选择器里。改为在 `engine.ts` 的 `runNode` 里**集中插值一次**
（而不是改 60 个执行器的 `sel()`），任何含 `{{` 的字符串按 `variables` 展开。
`interpolateParams` 在**无变化时返回原对象引用**（几乎每个节点都有嵌套的
`target`/`onError`，逐层复制会让恒等契约失效）。

**b. `loop-elements` 注入当前元素**
引擎原先只设 `variables['loopIndex']`。新增注入依赖
`loopElementSelector(selector, index, signal)`，在页面内求第 index 个匹配元素的唯一
CSS 选择器，写入 `variables['loopElementSelector']`；求不出时**发出错误并写空串**，
绝不静默复用第 0 个元素。

**c. 折叠算法**（`src/lib/workflow/loop-collapse.ts`，纯函数）

- `collapseAdjacentDuplicates` / `detectRepeatRuns` → `RepeatSuggestion[]`，
  区分**完全相同段**（折 `repeat-task`）与**变化段**（折 `loop-elements`）。
- `applyRepeatTaskFold` / `applyLoopElementsFold` 负责改图与改 handle。
- loop 节点的 `output-1` 是循环体、`output-2` 是循环后；**体尾必须指回 loop 节点**。

**d. 页面探测是最后一道防线**（`src/background/collapse-probe.ts`）
`loop-elements` 把 `querySelectorAll(selector)` 的第 N 个**匹配**交给第 N 次迭代，
所以选择器必须**精确等于**那批元素且顺序一致。探测按优先级生成候选并逐个验证：

1. 剥掉位置伪类的记录选择器（`.list > li:nth-child(1)` / `(2)` → `.list > li`）；
2. 共同祖先作用域下的 `tag.class`（共有类名）；
3. 共同祖先作用域下的 `tag`；
4. 各元素到共同祖先的**剥壳相对路径**（覆盖 `.rows > div > input` 这类嵌套一层的结构）。

每个候选都要通过同一套校验：匹配数量相等 **且** 逐个身份相同 **且** 顺序相同。
全部失败 → **拒绝折叠**，只出提示。**一个迭代错元素的循环比不折叠的图更糟。**

> 实施修正：计划里这个接口叫 `deriveContainer`（返回"容器选择器"）。实际上引擎迭代的
> `selector` **就是被迭代的元素本身**，不是容器。照计划实现会得到一个只跑一轮的循环，
> 因此改名为 `deriveLoopSelector` 并重定义为"精确匹配这批元素的选择器"。

### 3.5 凭证不出值

规则：**模型只能拿到凭证的名称，拿不到值。** `src/lib/workflow/secret-guard.ts`
（纯函数）封住三条泄漏路径：

- `buildSecretIndex(values, credentialKeys)` → 把凭证字面量映射为 `{{name}}`；
- `redactRecordedParams` → 记录进草稿/历史前把命中值换成占位符；
- `credentialFillPath({ blockId, data, targetType })` → 目标是 `input[type=password]`
  （`isCredentialFieldType`）且要填**字面量**时返回其数据路径（如 `['value']`）：
  聊天里用户亲手给出的账号/密码会被**捕获**成触发器的 `secret` 输入（持久化进
  工作流、重放时通过 `{{name}}` 引用），而不是像旧版那样直接拒绝。审计历史里值
  显示为 `'••••••••'`。

### 3.6 element-change 触发器

对启用了 `element-change` 的工作流，向其 `data.observeElement.selector` 注入
`MutationObserver`（`subtree` / `childList` / `attributes` / `attributeFilter` /
`characterData` 直通）。页面 → `runtime.sendMessage` → 后台派发 `runWorkflowRef`。
注册表由 `rescheduleAllWorkflowTriggers()` 统一刷新；工作流禁用 / 删除 / 改 selector
**必须注销** observer（否则泄漏 + 幽灵触发）。同一工作流的 observer 在运行期间
**不重复触发**（模块级重入闸门，1s 后释放）。

### 3.7 注入函数自包含（硬约束）

`chrome.scripting.executeScript({ func })` 只序列化**函数源码**，
模块作用域的任何引用在页面里都是 `ReferenceError`——`tsc`、打包器、
以及**直接调用该函数的测试**都发现不了（测试里模块作用域仍然可见）。
本功能新增的页面侧代码都落在注入路径上：新增的 `deriveLoopSelectorInPage`
（折叠探测），以及新增的 `element_selector_at` op —— 后者由已被注入的
kernel `runOp`（`func: runOp` / `runOpViaKernel`）处理，同样受此约束。

新增 `scripts/verify-injected-functions.mjs` 静态守卫：用 TypeScript checker 解析
每个 `func: X` 的真实函数体（穿透 import 与 `as unknown as`），体内任何解析进 `src/`
的值引用即报错；`tests/injected-functions.spec.ts` 把它接进 `vitest run`。

**首轮即查出 3 个真缺陷**（其中 2 个在本功能依赖的路径上）：

| 位置                                                     | 症状                                                                                                                   | 处理                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `driver.ts` `runOpViaKernel` → `KERNEL_VERSION`          | 常驻内核快路径**从引入起就没成功过**；`ReferenceError: bl is not defined`（`bl` 是压缩后的 import 绑定，**未被内联**） | 版本改为通过 `args` 传入 |
| `element-capture.ts` `probeTopDocument` → `frameHref`    | 帧探测抛错后被调用点的 `.catch()` 静默降级                                                                             | `frameHref` 移入函数体   |
| `workflow-engine/page-inspect.ts` → `TEXT_CAP` 等 3 常量 | 该文件自述"no closures"却引用了模块级常量                                                                              | 常量移入函数体           |

> 附带发现：`workflow-engine/page-inspect.ts`（约 230 行）**整个模块是死代码**——
> 无任何文件 import，也不在构建产物里。未删除，留待决定。

## 影响面

**新增**

| 文件                                                       | 职责                                         |
| ---------------------------------------------------------- | -------------------------------------------- |
| `src/background/workflow-engine/operator-exec.ts`          | 执行桥 + 分类 + 哨兵分支                     |
| `src/background/operator-tool-run.ts`                      | 编排层（resolve → execute → append）         |
| `src/background/operator-tool-handler.ts`                  | 草稿写入、trigger 头节点、折叠入口           |
| `src/background/collapse-probe.ts`                         | 页面选择器探测（生产 `CollapseProbe`）       |
| `src/lib/workflow/operator-class.ts`                       | `operatorExecClass` 分类（纯数据）           |
| `src/lib/workflow/interpolate.ts`                          | 模板插值 + `EMPTY_INTERP_KEY`                |
| `src/lib/workflow/loop-collapse.ts`                        | 去重 / 检测 / 折叠（纯函数）                 |
| `src/lib/workflow/secret-guard.ts`                         | 凭证不落值                                   |
| `src/lib/workflow/trigger-options.ts` / `trigger-patch.ts` | 可用触发器集 / 状态回写                      |
| `src/lib/workflow/draft-storage.ts`                        | 草稿 L2 持久化                               |
| `src/lib/workflow/target-to-selector.ts`                   | 定位解析（从 `storage.ts` 搬出并 re-export） |
| `scripts/verify-injected-functions.mjs`                    | 注入函数自包含性守卫                         |

**主要改动**

| 文件                                                | 改动                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/background/agent.ts`                           | 工具面分层（动作面 24 + 读 3 + `load_tools`）、`operators_author` 组、系统提示、审计脱敏 |
| `src/lib/workflow/operator-tools.ts`                | 纳入 `CUSTOM_BLOCKS`、schema 派生、动作/编排分层常量                                     |
| `src/background/workflow-engine/engine.ts`          | `runNode` 集中插值、`loop-elements` 注入 `loopElementSelector`                           |
| `src/background/workflow-engine/executors.ts`       | 空插值不误清表单（`EMPTY_INTERP_KEY`）                                                   |
| `src/background/workflow-triggers.ts`               | `element-change` 注册表刷新 + 重入闸门                                                   |
| `src/background/driver.ts` / `src/inpage/kernel.ts` | `element_selector_at` op（唯一选择器）                                                   |
| `src/lib/tool-catalog.ts`                           | `OPERATOR_META` 分类改由 `operatorExecClass` 决定                                        |
| `src/sidepanel/ChatTab.tsx`                         | 模式切换危险确认、保存卡片触发器选择器 + 折叠建议 + 脱敏提示                             |
| `src/lib/i18n.ts`                                   | 双语词条（`Messages` 是封闭类型，interface + `en` + `zhCN` 必须同时改）                  |

## 测试

新增：`operator-exec-bridge` / `operator-tool-exec` / `operator-draft-branch` /
`workflow-draft-storage` / `workflow-trigger-patch` / `workflow-run-validation` /
`loop-collapse` / `collapse-probe`（真实 DOM，jsdom） / `workflow-trigger-element-change` /
`secret-guard` / `injected-functions`。

关键断言：

- `operatorExecClass` 对全部算子完备，且与 `OPERATOR_META` 分类一致（防再次漂移）；
- `collapse-probe` 的**拒绝**用例占多数：剥壳后过宽、顺序与文档顺序不符、
  同一元素重复、标签不一致、旁有同款兄弟元素 → 一律返回 null；
- 注入函数的自包含性：把函数**从自己的源码重建**后在干净作用域跑（直接调用抓不到越界引用）。

## 验证

`tsc --noEmit`（`tsconfig.json` + `tsconfig.tests.json` 两个都要跑）0 错误；
`eslint src tests scripts` 干净；`pnpm test` **137 文件 / 1675 用例全绿**；
`vite build` 通过，并从产物中抽出注入函数逐一重跑行为检查。

## 后续修订

- **2026-09-18**：算子分层由"动作面 / 编排面"两段扩为**三段**——新增
  `operators_escape`（只含 `javascript-code`），并给它加了 `justification` 必填门禁，
  使生成的工作流默认不含代码节点。设计见
  `specs/2026-09-18-script-last-resort-design.md`（改这条前先读它）。
  本文下面提到的"动作面 24"已变为 **23**（代码节点被移出常驻广告层）。
