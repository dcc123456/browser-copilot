# 设计：运行前检查不再阻塞，报错落到运行日志并点名算子节点

日期：2026-10-06
状态：代码已落地。离线门禁全绿（见 §6 实测行），⑤「编辑器里点一次运行」的浏览器证据拿不到（本环境无法打开或脚本化扩展自己的页面），标 BLOCKED。

## 1. 问题

在工作流编辑器里点运行，弹出一条 toast：

```
无法运行该工作流：
· 节点 "Get text: 读取草稿箱列表里各篇图文草稿的标题文本存入变量 draftTitles，…" 缺少必填参数 selector：
  缺少元素定位：请传 snapshot 的 ref，或非空 selector，或 target（primary 的 how 与 value 都必须非空）。三者有其一，否则本节点不会记录。
```

对用户毫无用处，三条独立缺陷叠在一起：

1. **它阻止了运行**。整张图一个节点缺参，20 个节点一步都不执行。
2. **它不进运行日志**。这条信息只存在于一个几秒后消失的 toast 里；「日志」面板里这次运行根本没有记录（引擎从未启动）。
3. **它不指向节点**。用户面对的是画布上一堆长得几乎一样的 `Get text` 节点 + 一句转述内部契约措辞的长文本（`snapshot 的 ref` 是**录制期** agent 工具的概念，编辑器里根本没有这个输入口），无法定位到出问题的那一个。

代码事实：

- `src/background/index.ts:1547-1550`：`workflows.run` 在启动前跑 `validateWorkflowForRun`，`errors` 非空直接 `throw`。
- `src/workflow-editor/App.tsx:551-555`：编辑器把这个 throw 当成 `runFailed` toast 的正文，同时塞进 `error` banner——一屏墙字，无节点定位。
- `src/lib/workflow/validation.ts:289-302`：报错文本由 `missingRequirements()`（结构化：`key`/`message`/`severity`）拼成**纯字符串**后返回，nodeId 在拼接那一刻丢失，所以下游想定位也没有句柄。

## 2. 现状里已经存在的“不阻塞”先例（本轮沿用，不新造口径）

- `run-workflow.ts:615-634`：`validateGeneratedWorkflow` 的发现项**明确不阻塞**，写成一行 `status` 日志「可靠性校验发现以下待确认问题（不阻止运行，如运行失败可用 AI 调试修复）」，条目形如 `- [LOCATOR_MISSING] message`。
- `src/lib/i18n.ts:1621` `chatWorkflowRunIssuesNonBlocking`：保存卡片已经告诉用户「你仍然可以保存，保存后用 AI 调试修」。而 `chatWorkflowRunIssuesBlocked`（“禁止保存”口径）**已无任何引用**，是当年回退留下的死 key。
- `flow/BlockNode.tsx:55,156`：`runState?: 'done' | 'error'`、`.wf-node-error` 样式、`TriangleAlert` 徽标全部写好了，卡在 `const hasError = false // validation wired in P4`。**给节点标红的管道是现成的，只是没接线。**
- `lib/workflow/generated-validation.ts:39-53`：结构化发现的既有形状 `{code, severity, nodeId?, path?, message, suggestedFix?}`。

结论：把手动运行这条唯一还在硬拦的路径改成同一种口径，是收敛而非新方针。

## 3. 决策

### 3.1 坏节点执行到它时怎么办（已拍板：**跑到该节点即止**）

| 候选                              | 结论                                                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 跑到该节点前干净停住           | **采纳**。缺必填参数的节点不可能干活：停在它之前，日志点名它，页面不被触碰。                                                                                                                                                                    |
| B. 跳过该节点，继续跑完整张图     | 否决。跳过一步后，后续步骤是在「缺失步骤本应造成的状态」上执行：`forms` 填写被跳过 → 后面的 `event-click` 提交照样把空表单交出去；`get-text` 采集被跳过 → 后面的 `export-data` 导出错数据。**用一次可能有害的续跑换一次不完整的运行，不划算。** |
| C. 读类节点跳过续跑、写类节点停止 | 否决（本轮）。要引入按幂等性分类的跳过判定，判定面与测试面都翻倍；且 A 已经消除了「完全无法运行」这个真正的痛点。                                                                                                                               |

被否决的第四个方案：**什么都不改，让 executor 自己在空 selector 上炸**。不可行——generated-strict 的 readiness 会先对空定位轮询到超时（`READINESS_TIMEOUT`，实测最长 8 s × retry），报的是「页面没有该元素」这个假根因，而真相是「这个节点压根没填定位」。停在引擎里的检查正是为了**不烧这段等待、不产生假根因**。

### 3.2 画布标红 + 从日志定位节点（已拍板：**要**）

报错进了日志仍然要回答「是哪个节点」。日志行按节点分组显示块名，但画布不会滚过去；所以：坏节点在画布上标红 + 徽标，运行日志的错误行提供「定位」动作，点了选中并居中该节点。复用 §2 里未接线的管道。

### 3.3 检查报错文本谁负责本地化

`block-requirements.ts` 的契约文案是存量的单语种（中文）常量，且被录制门、LLM 工具 schema 共用（同一张表三处读，§5.6 明令不得另立）。本轮**不改写这些文案**，只做两件事：

- 把 nodeId / blockId / param 以**结构化字段**带出来，定位靠字段，不靠解析文本；
- 新增的用户可见 UI 文案（toast、定位按钮）走 en + zh-CN 双语 key。

`validation.ts` 里 `工作流缺少触发器…` 这类自己新写的句子按原样保留（存量），避免因文案重写把 `errors: string[]` 的断言测试全冲一遍。文案双语化是独立的 i18n 任务，见 §6 后续。

## 4. 契约

### 4.1 运行门返回结构化发现（`src/lib/workflow/validation.ts`）

```ts
/** 一条运行前发现，带它归责到哪个节点。 */
export interface WorkflowRunIssue {
  severity: 'error' | 'warning'
  /** 归责节点；图级发现（缺触发器、悬空连线）没有节点，为 undefined。 */
  nodeId?: string
  blockId?: string
  /** 节点显示名，让日志行不查图也能读。 */
  nodeName: string
  /** 出问题的参数名（selector / url / …）。 */
  param?: string
  /** 不含节点前缀的问题描述（就是 block-requirements 的那句话）。 */
  message: string
}

export interface WorkflowRunValidation {
  errors: string[] // 由 issues 经 formatRunIssue() 派生；唯一字面差异：固定值警告少了连接用的「的」
  warnings: string[] // 同上
  issues: WorkflowRunIssue[]
}

/** 单节点的那一半判定：必填参数契约 + 残留固定值。门与编辑器画布共用同一个规则。 */
export function nodeRunIssuesOf(node: WorkflowNode): WorkflowRunIssue[]
```

要点：`issues` 是唯一事实源，`errors`/`warnings` 是它的 `formatRunIssue()` 投影。既有调用方（ChatTab 保存卡片、`required-steps.ts`、`repair/patch-engine.ts`、`operator-tool-handler.ts`、以及 `tests/workflow-run-validation.spec.ts` 的字符串断言）一字不改仍然成立；`'error'` 的语义从「拒绝运行」收敛为「这个节点当前不可能干活」，判定强度不变，只是执行不再被它挡住。`nodeRunIssuesOf` 之所以对外：编辑器要在用户敲字的当下就把同一个节点标红，规则放两处就会和运行日志吵架（§5.2）。

### 4.2 引擎新增停止点（`engine.ts`）

```ts
/** 运行门已证明干不了活的节点：nodeId → 该节点的报错行。 */
preflightBlockers?: Record<string, string>
```

位置在 `emit('tool', nodeId, '')` 之后、`disableBlock` 之后、loop / sub-workflow 递归与 executor 之前，命中即 `emit('error', nodeId, reason)` + `outcome='failed'` + 返回 `null` —— 与 `CLOUD_BLOCK_IDS`（`engine.ts:812-818`）同一形状：不碰页面、不进 readiness、不烧重试等待。引擎保持 chrome-free，纯新增一条早退分支，Runner 侧不传该选项即行为不变（不新增第三条驱动路径，§5.6 无恙）。

`reason` 取 `issue.message`（**不带** `节点 "名字"` 前缀）：引擎的这条 error 落在该节点自己的块头下面，再加前缀就是同一行里把名字写两遍。带前缀的 `formatRunIssue()` 只用在没有块头的行上（§4.3）。

被禁用的节点（`disableBlock`）在检查之前就被跳过，所以它缺不缺参数都不会停住运行——画布上的红标用同一条规则跳过它。

### 4.3 集成层落日志（`run-workflow.ts`）

`ExecuteWorkflowOptions` 增 `preflight?: WorkflowRunIssue[]`（仅手动运行路径传；alarm / 右键 / 快捷键 / `workflows.resume` 保持宽松，理由见 `index.ts:1540-1551` 的原注释）。运行开始处，按归责对象分三种行：

- **图级 error**（缺触发器、触发器被禁用、没有算子、悬空连线）→ 一行 `工作流级问题 N 处（没有对应的算子可定位）：` + 逐条 message。没有 nodeId，也就没有定位按钮。
- **节点级 error** → 先一行汇总 `运行前检查：N 个算子缺少必填参数，无法执行。运行已照常启动，并会在第一个这样的算子前停止（不触碰页面）。`，再**每个节点一行** `节点 "名字" message`，`addStep` 带上 `{ nodeId, label: nodeName }`——这一批行在任何块头之前，所以名字必须写在正文里，而 nodeId 让日志行能把画布滚到它。超过 20 个截断成 20 行 + 一行「……另有 K 个算子同样缺参」。
- **warning** → 从只写 `console.warn` 改成同样落到运行日志（用户要求「报错打到日志里」，警告没道理只进控制台），一行汇总，逐条 `- 节点 "名字" message`，同样 20 条截断。
- 节点级 error 折成 `preflightBlockers: Record<nodeId, message>` 传给引擎（同一节点多条发现按 `\n` 拼接）。

## 5. 改动清单

| 文件                                                                                                                                                                 | 改动                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/workflow/validation.ts`                                                                                                                                     | `WorkflowRunIssue` + `issues`，`errors`/`warnings` 改为 `formatRunIssue()` 派生投影；`nodeRunIssuesOf` 对外，供画布按节点复用同一条规则                                                                                                           |
| `src/background/index.ts`                                                                                                                                            | 删掉 `workflows.run` 的 `throw`；`gate.issues` 交给 `executeWorkflow`；`console.warn` 循环移除                                                                                                                                                    |
| `src/background/workflow-engine/run-workflow.ts`                                                                                                                     | `preflight` 选项、图级/节点级/warning 三类日志行（节点行带 `nodeId`+`label`）、折成 `preflightBlockers`                                                                                                                                           |
| `src/background/workflow-engine/engine.ts`                                                                                                                           | `preflightBlockers` 早退分支                                                                                                                                                                                                                      |
| `src/workflow-editor/App.tsx`                                                                                                                                        | `blockedNodes` memo：随敲字对每个节点跑 `nodeRunIssuesOf`（禁用节点跳过）→ 红标 + toast 计数；`locateNode`（选中 + `setCenter`）；抽出 `toWorkflowNode` 给 memo 与 `buildWorkflow` 共用；运行失败且有坏节点时只给一句短 toast，不再贴整段契约文案 |
| `src/workflow-editor/flow/BlockNode.tsx`                                                                                                                             | `hasError` 接 `data.runState === 'error'`（删掉 P4 占位注释），`blockedReason` 作为角标 tooltip                                                                                                                                                   |
| `src/workflow-editor/sidebar/log-view.tsx`                                                                                                                           | 独立（块头之前）trace 条目带上 `nodeId`；`TraceRow` 有 nodeId 且给了回调时渲染定位按钮                                                                                                                                                            |
| `src/workflow-editor/sidebar/RunDetailModal.tsx`、`LogsModal.tsx`                                                                                                    | 透传 `onLocateNode`；定位先把两层日志弹窗关掉，否则画布还被盖着                                                                                                                                                                                   |
| `src/workflow-editor/i18n.ts`                                                                                                                                        | 新 key `runBlockedNodes` / `locateNode`，en + zh 成对。角标 tooltip 不加新 key——它显示的就是契约本身那句话（§3.3）                                                                                                                                |
| `tests/engine-preflight-stop.spec.ts`、`tests/workflow-run-preflight-log.spec.ts`、`tests/run-preflight-editor-ui.spec.tsx`、`tests/workflow-run-validation.spec.ts` | 新增/扩展，见 §6.2                                                                                                                                                                                                                                |
| `docs/workflow-ai-architecture-audit.md`                                                                                                                             | 手动运行那一行仍写着「errors 阻断」，按新事实更正；`validateWorkflowForRun` 的所在文件也从 `runnability.ts` 纠为 `validation.ts`                                                                                                                  |

## 6. 验收结果（实测）

2026-10-06 在本机 develop 工作区实测。命令与输出：

| 项           | 命令                                                                  | 实测结果                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 类型       | `pnpm typecheck`（`tsc --noEmit` + tests 工程）                       | 通过，0 错误                                                                                                                                                                                                                                                                                                                                                                |
| ① 单测       | `pnpm test`                                                           | **338 files / 3848 tests 全通过**（改动前基线 337/3843，本次新增 `tests/workflow-run-preflight-log.spec.ts` 5 条）                                                                                                                                                                                                                                                          |
| ① 构建       | `pnpm build`                                                          | `✓ built in 2.14s`（仅既有的 chunk >500 kB 提示）                                                                                                                                                                                                                                                                                                                           |
| ① lint       | `npx eslint <14 个触碰文件>`                                          | 通过，0 问题（**按文件跑**：`pnpm lint` 在 develop HEAD 本身就红，见项目记忆「Lint/format baseline is red」，禁止顺手全仓格式化）                                                                                                                                                                                                                                           |
| ① 格式       | `npx prettier --check <每个文件>` 且与 `git show HEAD:<f>` 同文件对比 | **本次没有让任何一个文件由干净变红**：`src/background/index.ts`、`run-workflow.ts`、`engine.ts`、`App.tsx`、`workflow-editor/i18n.ts`、`workflow-run-validation.spec.ts` 在 HEAD 已红、现在仍红（我只把自己写的行修整齐）；`validation.ts`（HEAD 即干净，已 `--write`）与三个**新建** spec、`BlockNode.tsx`、`log-view.tsx`、`RunDetailModal.tsx`、`LogsModal.tsx` 全部干净 |
| ② Runner     | `pnpm server:typecheck`、`pnpm server:test`                           | 通过；**10 files / 82 tests 全通过**（含 `test/e2e/runner.smoke.ts` 5 条）。Runner 未传 `preflight`/`preflightBlockers`，语义不变（§4.2）                                                                                                                                                                                                                                   |
| ③ 调试成功率 | `pnpm bench:debug`（触碰了 `workflow-engine/engine.ts`）              | `{"successRate":0.6666666666666666,"total":9,"verified":6}` = 6/9，与 `tests/bench/baseline.json` 的 `verifiedRecoveryRate: 0.6667` **完全一致，差值 0**；离线 8 条断言全通过                                                                                                                                                                                               |
| ④ 注入函数   | `pnpm verify:injected`                                                | **N/A**：本轮没有新增或修改任何 `executeScript({func})` 内联函数体                                                                                                                                                                                                                                                                                                          |
| ⑤ 浏览器证据 | 见下                                                                  | **BLOCKED**                                                                                                                                                                                                                                                                                                                                                                 |
| ⑥–⑩ 纪律     | §6.1 复用自检、死代码、Tailwind token、暂存区、提交规范               | 见 §6.3                                                                                                                                                                                                                                                                                                                                                                     |

### ⑤ BLOCKED 的确切原因与人工复核步骤

本环境无法把扩展自己的页面交给自动化工具：`tab_new` 对 `chrome-extension://…` 报「only http(s) pages can be automated」，内置浏览器的 `navigate_page` 同样只接受 http/https/本地文件。所以下面这步只能由人在本机做（一步都不能省，因为它验证的正是「编辑器点运行真的能用」）：

1. `pnpm build` 后在 `chrome://extensions` 加载 unpacked 的 `dist/`；
2. 造一个含**空 selector** 的 `get-text` 节点的工作流，前面留一个能干的节点（例如 `new-tab`）；
3. 在编辑器里点「运行」，须依次观察到：
   - 运行**启动了**（不再弹「无法运行该工作流」toast）；
   - 前序节点照常执行；
   - 「日志」里有一行汇总 + 一行点名该 `get-text` 节点的 error 行（`节点 "Get text: …" 缺少必填参数 selector：…`）；
   - 画布上该节点**标红**，鼠标悬停角标能看到同一句话；
   - 点该日志行的「定位算子」按钮，两层日志弹窗关闭，画布选中并把该节点居中。

拿不到这五条观察结果之前，本设计的浏览器可见行为未经证实。

### 6.1 复用自检（§5.1/§5.2）

`GeneratedValidationIssue`（`code`/`path`/`suggestedFix`）服务的是生成期六层静态校验，`WorkflowRunIssue`（`param`/`nodeName`）服务的是每次手动运行的归责行；本轮不合并两者，但**如果后续要在编辑器里统一展示两类发现，就必须收敛成一个 finding 类型**，届时按 §5.2 处理，不得再留第三套。

### 6.2 测试清单

| 文件                                                     | 锁住什么                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/workflow-run-validation.spec.ts`（扩展，26 条）   | `issues` 是唯一事实源：`errors`/`warnings` 恰为 `issues.filter(severity).map(formatRunIssue)` 的投影；每条 error 带 `nodeId`/`blockId`/`param`/`nodeName`；`nodeRunIssuesOf` 与图级门同规则；既有字符串断言一字未改仍然成立（§4.1 的向后兼容承诺）                                                                            |
| `tests/workflow-run-preflight-log.spec.ts`（新建，5 条） | 真实 `executeWorkflow` + 只 mock 引擎/驱动：每个坏节点一行 error 且 `addStep` 带 `{nodeId,label}`、汇总行排在它之前、warning 也进日志（不再死在 console）；图级发现单行且**无** nodeId；折给引擎的 `preflightBlockers` 是 `{g: 不带节点名的 message}`；超过 20 个截断并补「另有 K 个」；没有 preflight 时日志与改动前逐行相同 |
| `tests/engine-preflight-stop.spec.ts`（新建，4 条）      | 引擎的停止语义：阻塞节点**之前**的节点全部执行、停在它面前且不触碰 executor（不烧 readiness/retry，见 §3.1 被否决的第四个方案）；error 行落在该节点自己的块头下；无 blocker 的图行为不变；用户禁用的节点即使缺参也不停                                                                                                        |
| `tests/run-preflight-editor-ui.spec.tsx`（新建，4 条）   | 画布与日志的两处 UI：门不放过的节点卡片加 `wf-node-error` 底色并把契约句作为 tooltip（干净节点不加）；块头之前写入的 trace 条目保住 `nodeId`；只有带 nodeId 的行才出现「定位」按钮                                                                                                                                            |

### 6.3 纪律项自查

- ⑥ 复用：`WorkflowRunIssue` 与 `GeneratedValidationIssue` 的关系见 §6.1；节点归责复用既有 `nodeDisplayNameOf`，画布红标复用 §2 里未接线的 `runState`/`.wf-node-error` 管道，规则函数 `nodeRunIssuesOf` 门与画布共用一份（§5.2）。未新增第二条驱动路径、第二套 i18n、第二套校验（§5.6/§5.7 无恙：新代码全在 `src/lib/**`、`src/background/**`、`src/workflow-editor/**`）。
- ⑦ 死代码：删掉了 `hasError = false // validation wired in P4` 占位与 `index.ts` 里被取代的 `console.warn` 循环；无注释掉的代码块；新增导出（`nodeRunIssuesOf`、`formatRunIssue`、`WorkflowRunIssue`）都有调用方。存量死 key `chatWorkflowRunIssuesBlocked` 不在本次触碰文件里，按 §7 不动。
- ⑧ UI：定位按钮只用现有 token 类（`border-border bg-accent-soft text-accent`），无内联静态样式、无新增 hex；`--bc-*` token 未新增，故无需双侧同步（§2）。
- ⑨ 暂存区：无截图/探针产物；`server/eng.traineddata` 与保存卡片（save-card）那批在制品文件都不是本次产物，提交时不纳入。
- ⑩ 提交：英文 Conventional Commits（本次未提交，等用户点头）。

## 7. 明确不做

- 不改 `block-requirements` 的契约文案，不动录制门与 LLM schema；
- 不改保存卡片的「必须修复」展示（它已经是非阻塞 + 「保存并 AI 调试」）；
- 不做「跳过坏节点续跑」（§3.1 已否决），不做按幂等性分类的跳过；
- 不让 preflight 停住的路径去触发 AI takeover：一个没填定位的节点交给 agent 猜是另一件事，需要单独设计。
