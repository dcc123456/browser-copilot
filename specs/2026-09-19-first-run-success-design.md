# 设计：提高生成工作流的一次运行成功率

日期：2026-09-19
状态：**已实施**

## 1. 问题

用户反馈：工作流模式下生成的工作流，保存后**直接运行几乎必然失败**，做不到一次运行成功。

生成期每一步都真实执行成功过（算子桥接只在执行成功后记录节点），失败发生在**重放环境与
生成环境的差异**上。诊断结论（每条都已对照代码确认）：

| # | 根因 | 证据（实施前） |
| - | ------ | ---------------- |
| 1 | **读取类块完全没有元素等待**：`get-text` / `attribute-value` / `read-page` 只做一次 `querySelectorAll`，0 命中直接抛错。`applyDefaultWaits` 只覆盖交互块。生成期靠 LLM 节奏天然间隔几秒，重放是背靠背执行——点击触发跳转后紧跟一个读取节点必挂 | `executors.ts` getText、`debug-session.ts` WAIT_BLOCKS |
| 2 | **CSS 选择器优先压制富定位**：录制 `selector` 取"最能转成 CSS 的 spec"（常是 `:nth-child` 位置长链），role/text 富定位降为 fallback；内核 `resolve()` 取**第一个命中任意元素**的 spec——位置 CSS 漂移后命中多个错误元素时照样选它，静默点错 | `target-to-selector.ts`、`kernel.ts` resolve |
| 3 | **没有导航锚点**：图以"直接操作当前页元素"开头（无 new-tab），trigger 默认 manual，重放驱动"当前活动标签页"——不在生成时的页面就从第一步失败，且报错只说"element not found" | `run-workflow.ts` |
| 4 | **首跑没有安全网**：`workflows.run` 的 AI 接管默认关；强大的验证-修复循环（`workflows.debug`）只能从工作流列表手动触发，不在交付链路上 | `index.ts` |
| 5 | 保存卡片的 AI 审查只做节点取舍；选择器探测只展示、无修复 | `workflow-review.ts`、`selector-probe.ts` |

## 2. 用户拍板的两个默认行为

- **验证运行默认关闭**：保存卡片提供勾选「保存后验证运行」，不勾选不执行。理由：验证
  运行会真实执行工作流（下单/发帖等副作用真实发生）并消耗一次模型调用。
- **导航锚点只提示不改图**：不自动补 new-tab 节点。保存卡片文案 + 运行前警告 + 引擎提示
  三层提示，图的结构保持用户审阅时的原样。

## 3. 实施

### A. 引擎重放健壮性

**A1 读取块轮询等待**（`background/workflow-engine/executors.ts`）

- 新增 `readWaitMsOf` + `pollRead`：读取注入按 120ms 间隔轮询，直到非空或窗口到期。
  窗口取节点 `waitSelectorTimeout`，未设置时 `DEFAULT_READ_WAIT_MS = 5000`；节点显式
  `waitForSelector: false` 退出（单次，旧行为）。
- 应用：`get-text`（query 循环）、`read-page`（html 元素读/元素正文/整页正文三路；
  selection 路不轮询——空选区本就合法非致命）、`attribute-value`（把窗口写进 `op.waitFor`，
  由内核轮询元素存在性）。
- 只对**空结果**重试；注入抛错（受限页、标签页已关）立即传播——重试救不了那些。
- 设计偏差说明：原计划把读取块加进 `WAIT_BLOCKS` 让 `applyDefaultWaits` 覆盖。实施时
  改为**执行器层默认轮询**，原因：`applyDefaultWaits` 会把窗口写成 2000ms（普通运行），
  反而**拉低**读取窗口；执行器层默认不受它影响，两条路径都落在 5000ms。

**A2 内核两段式目标解析**（`inpage/kernel.ts` resolve）

- 第一层：候选 spec（primary → fallbacks 顺序）中**命中数恰为 1** 的直接胜出；一层遍历
  内完成，首个多命中结果被记住。
- 第二层：没有任何 spec 恰好命中 1 个时，回落旧行为（第一个命中任意元素的 spec，
  取第一个可见元素）。
- 效果：位置 CSS 漂移后命中多个元素时，不再压过仍然精确的 id/testid/语义 spec。
- 内核自包含铁律未破（`pnpm verify:injected` 通过）。

### B. 录制保真

**B1 已验证选择器**（`lib/workflow/target-to-selector.ts` + `background/selector-probe.ts`
+ `background/operator-tool-run.ts`）

- `selectorCandidatesOf(locator)`：显式 selector + 富定位各 spec 的 CSS 映射，去重、按
  优先序、上限 8 个。
- `chooseRecordedSelector(locator, countOf)`：第一个**命中恰为 1** 的候选胜出并标记
  verified；全不恰一时退而保留"至少有命中"的候选（verified=false）；连命中都没有时
  **录空 selector**——回放以富定位（role/text）为主定位，这正是位置 CSS 只会误导的场景。
- 录制路径：`runOperatorToolWithExecution` 在执行前用 `verifyRecordedSelector` 一次性
  注入数出候选命中数（复用 `countMatchesInPage`），选中者写入节点；`selectorVerified`
  随节点落盘。**无法探测时保持原 locator 不变**——"未验证"绝不能静默降级一个能用的定位。
- 历史编译路径：保存时（`workflows.save` 且 `fromGeneration`）用 `hardenWorkflowSelectors`
  一次性批量为整图重选 selector（上限 200 个 selector，超出部分不动）。
- 编辑器/导入的保存**不做**硬化——手调的选择器绝不能在用户背后被改写。

**B2 生成期页面来源**（`operator-tool-run.ts`、`draft-types.ts`、`types.ts`）

- 会话首个元素操作算子成功后，读一次目标标签页 URL（仅 http(s)）存进草稿 `originUrl`。
- `composeWorkflowFromDraft` 把它写进 `settings.generationOriginUrl`，同时写入
  `settings.provenance`（`chat-generate` / `chat-history`），为后续成功率统计留数。
- 历史编译路径尽力而为：用首条 entry 的 `host` 重构 `https://<host>`（只有 host，无
  scheme/path——是提示不是保证）。

**B3 保存期参数固化**（新 `lib/workflow/runnability.ts`）

- `persistDefaultWaits(workflow)`：把运行路径本就会强制的元素等待**持久化**进图（只写
  `waitForSelector` / `waitSelectorTimeout`，不增删任何节点/边），幂等、纯函数。server /
  scheduler 等不经 `applyDefaultWaits` 的消费方直接受益。持久窗口 5000ms（轮询是超时
  上限而非固定延时，命中即返回， happy path 不变慢）。

### C. 交付链路：可选验证运行（`ChatTab.tsx` + `background/index.ts`）

- 保存卡片新增勾选「保存后验证运行」（默认关，双语 + 副作用提示）。
- 勾选后保存成功即发送现有 `workflows.debug` 命令：带接管运行 → 失败节点 AI 接管修复 →
  无接管复验。进度走运行面板实时日志，结论（通过/待确认/失败）以聊天条目落地。
- 已有安全网沿用：终态逃逸（`judgeAlreadySatisfied`）、同错误熔断
  （`REPEAT_FAILURE_LIMIT`）、修复须经 `workflows.takeoverApply` 确认后才落盘。
- `workflows.save` 新增可选 `fromGeneration` 标记（仅生成卡片发送），承载 B1/B3 硬化。

### D. 运行前提示（`validation.ts`、`run-workflow.ts`）

- `validateWorkflowForRun` 新增 warning：manual trigger + 图无导航锚点
  （`unanchoredElementStart`）+ 有 `generationOriginUrl` → "运行前请先打开生成时的页面，
  或在图前加一个 new-tab 节点"。
- 运行启动时（`executeWorkflow`）：manual + 未锚定 + 当前标签页与生成页面**不同源** →
  运行日志一条 status 提示，不阻断（用户可能故意在同类页面运行）。
- `unanchoredElementStart` 按 trigger→节点数组顺序判断（生成图是单链）；手编图里"第一个
  元素动作之后才开页面"的分支同样算未锚定——语义上正确。

## 4. 测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/executors-read-wait.spec.ts`（新） | 轮询重试、退出开关、窗口到期仍按原文报错、`op.waitFor` 传递 |
| `tests/kernel-resolve-exact.spec.ts`（新） | 恰一命中压过多命中、全多命中回落旧行为 |
| `tests/target-to-selector.spec.ts`（扩展） | `chooseRecordedSelector` 全决策树 + `selectorCandidatesOf` 顺序 |
| `tests/runnability.spec.ts`（新） | 等待固化幂等不改结构、锚点判定正反例、保存期硬化与不可探测回退 |
| `tests/workflow-run-validation.spec.ts`（扩展） | 锚点警告正/反例 |
| `tests/chat-save-dialog.spec.tsx`（扩展） | 生成保存带 `fromGeneration`、验证运行默认不发、勾选后发一次 `workflows.debug` 且 id 正确 |
| `tests/visible-failure.spec.ts` / `read-page.spec.ts` | 空读失败契约测试补小窗口（轮询后语义不变，只是更晚失败） |
| `tests/operator-param-coverage.spec.ts` | 分析器正则补 `async function`（`pollRead` 曾对它不可见）；`attribute-value`/`get-text` 的 `waitForSelector` 出惰性清单 |

## 5. 明确不做

- 验证运行默认开启（用户已否）。
- 自动补 new-tab 节点（用户已否——只提示）。
- 循环折叠、子工作流等智能改写；算子工具面与 token 预算变更。

## 6. 已知边界

- 选择器探测只覆盖 CSS；role/text 富定位的"精确性"由 A2 的内核两段式解析在回放时兜底。
- 历史编译路径的 `generationOriginUrl` 只有 host 级精度。
- 未锚定警告按节点数组顺序判断，不遍历边（生成图是单链，手编多分支图的首个元素动作
  语义上仍成立）。
