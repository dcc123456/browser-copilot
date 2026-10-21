# 算子助手：往前插算子、"AI 优化"（可换算子）与编辑面板 Ctrl+Z

- 日期：2026-10-21
- 状态：设计（待实施）
- 范围：`src/lib/workflow/operator-advise.ts`（append/prepend 词表与纯图补丁）、
  `src/lib/workflow/node-fix.ts` + `src/background/workflow-engine/node-fix-engine.ts`（"AI 优化" 可换算子）、
  `src/workflow-editor/App.tsx`（撤销栈）、`src/workflow-editor/sidebar/BlockEditForm.tsx` / `NodeFixModal.tsx`（改名与换算子落地）、
  `src/workflow-editor/ai/OperatorChatDock.tsx`（新 refusal 文案）
- 前置：`specs/2026-10-19-editor-operator-ai-chat-design.md`（切片 1）、
  `specs/2026-10-19-operator-ai-observe-and-edit-design.md`（读优先 / edit / replace）、
  `specs/2026-10-20-operator-ai-screenshot-and-pick-design.md`（截图 / 手_pick / 拾取修复）、
  `specs/2026-10-16-node-fix-from-prompt-only-design.md`（无 contract 的节点修复）

## 1. 原始诉求（dcc 原话）

1. 现在算子助手只能在算子后面增加算子，我希望它能根据需要也能在算子前面增加算子。
2. AI 算子中的"修复"改成"AI 优化"：用户可以粘贴错误日志、可以说修复建议、可以说当前算子要实现什么等各种话术，
   AI 通过用户要求来修改算子参数，甚至可以更换算子，但是支持用户撤销修复。
3. 工作流编辑面板要支持 ctrl+z 来实现撤销操作。

## 2. 现状取证（读代码得到的事实，不是推测）

### 2.1 落地只有"往后接"

- `appendOperatorChain()`（`operator-advise.ts:1033`）：anchor = `options.anchorNodeId` 或 `tailNodeOf(graph)`
  （最深 BFS 层，`:1011`）；借出 anchor 的**唯一**正常出边（`:1051-1061`），把 continuation 改挂到链尾（`:1096-1114`）；
  `outgoing.length > 1` 时整批拒绝为 `'branch-anchor'`（`:1052`）。
- 唯一已经在做"往前插"的先例是 `replaceNodeOperator()` 的入边重挂（`:443-450`）与
  `ensureSecretProducer()`（`var-suggestions.ts:275-341`）。**没有任何"在某节点之前插入一段"的入口。**
- undo 记录 `OperatorSplicedEdge` 目前只记 `{id, source, sourceHandle?}`（`:489-493`），
  `edgesAfterBatchRemoved()`（`:506`）只还原 source 一侧。往前插要还原的是 **target 一侧**，所以这个结构必须加宽。
- action 词表只有三个值：`'append' | 'edit' | 'replace'`（`:92`），解析在 `:826-839`，
  分发在 `applyOperatorAction()`（`:341`）与 `App.tsx:1189`；dock 的 refusal 文案表 `PROBLEM_KEY`（`OperatorChatDock.tsx:142`）。
- anchor 只有一个来源：`operatorChatContext()`（`App.tsx:1106-1128`），且**只有恰好选中一个节点**才算选中（`:1114`）。

### 2.2 "AI 修复" = 单节点有界修复，已经能听懂三种话术，但不能换算子

- 入口只有一个：block inspector 头部的 `Wand2` 按钮（`BlockEditForm.tsx:153-162`），且只在
  `!cloud && goalBearing` 时渲染（`:142`）。
- **改名陷阱**：tooltip 是硬编码字面量 `title={bt('AI Fix')}`（`:157`），而真正的 i18n key `nodeFixButton`
  （`workflow-editor/i18n.ts:195` 'AI Fix' / `:499` 'AI 修复'）**没有任何引用**（死 key）。
- 输入侧已经齐了：`userSuggestion`（自由话术，`node-fix.ts:84`）+ `errorLog`（粘贴日志，`:89`，prompt 段落 `:163-169`）
  - 存下来的 goal/contract（`:119-148`）。**"等各种话术"不需要新代码**，只需要把入口文案从"修复"改成"优化"。
- 输出侧被明确禁止换算子：`NODE_FIX_RESERVED_KEYS` 把 `blockId` 从模型返回里剥掉（`:97-100`），
  prompt 规则写着 `Do NOT change the block id`（`:185`）。
- 落地是**纯数据替换**：`NodeFixModal.tsx:361-369` → `workflows.nodeFix` → `background/index.ts:2530` →
  `runNodeFix()`；`applyNodeFix()`（`App.tsx:519-534`）→ `replaceNodeData()`（`:495-499`，整块替换不 merge）。
- 撤销**已经有了**，但只是数据级：`fixSnapshotsRef: Map<nodeId, blockData[]>`（`:503`，上限 10），
  `canRevert` → `revertNodeFix()`（`:536-548`）→ 按钮 `BlockEditForm.tsx:212-221`。
  **它救不回 blockId 的变化**，也不管边。
- 引擎侧换算子是可行的：`executeNode(blockId, data)`（`node-fix-engine.ts:63-66`）本来就按 blockId 试跑，
  `operatorExecClass(blockId)==='record-only'` 会跳过试跑（`:105`）。所以"候选算子真的被试跑过"不需要新机制。

### 2.3 编辑面板没有全局历史

- 只有三处局部撤销：`aiUndoRef`（`App.tsx:1104`，深度恰好 1，只在内存）、`fixSnapshotsRef`、CodeMirror 自己的 `history()`。
- **没有 mutation funnel**：约 15 个调用点直接 `setNodes` / `setEdges`（`onNodesChange:360`、`onEdgesChange:364`、
  `onConnect:373`、`onEdgeDoubleClick:393`、`onDrop:423+`、`setGroupChildren:404`、`deleteNode:552`、
  `duplicateNode:563`、`toggleNodeDisabled:584`、`patchNode:483`、`replaceNodeData:496`、`handleAutoLayout:892`、
  pack/unpack、AI 落地 `:1205/1211/1137`）。
- 窗口级 keydown 已经存在（`App.tsx:919-944`，绑 Ctrl/Cmd+S、Enter、Shift+F、B、W），**没有 Ctrl+Z，也没有焦点守卫**。
  守卫写法有先例：`use-space-select.ts:37-43`。
- React Flow v12 没有内置 undo。`deleteKeyCode={['Delete','Backspace']}`（`:1379`）走的是 `onNodesChange` 的 `remove` 变更，
  不经过 `deleteNode()`——两条删除路径都要覆盖。
- 持久化只有手动保存（`handleSave:638`），`setDirty` 由 `useEffect([nodes, edges, meta])`（`:333-335`）驱动，
  撤销会自然把 dirty 置回 true。**历史不需要（也不应）落盘。**

## 3. 决策

### D1 往前插是第四个 action，不是 `append` 的一个开关

`OperatorAction` 扩成 `'append' | 'prepend' | 'edit' | 'replace'`。
否决方案：`append` + 旁挂 `placement: 'before'` —— 两个字段互相无效（`edit`/`replace` 用不上 placement），
会造出 `action:'edit' + placement:'before'` 这种必须额外拒绝的非法组合；一个枚举值天然没有非法组合。
模型不需要（也不允许）指名节点：`prepend` 的目标永远是编辑器自己的选中项，和 `edit`/`replace` 同一条红线。

### D2 插进去的链只接"一条入边"，分叉与汇聚一律拒绝

`prependOperatorChain()` 与 `appendOperatorChain()` 共用同一套判定：
anchor 无入边（孤立节点，"之前"不存在）→ `prepend-no-incoming`；anchor 是 trigger（前面没有东西可跑）→ `prepend-entry-point`；
anchor 有多条**正常**入边（汇聚点）→ `join-anchor`——选一条切进去就是在替用户改他没选的那条路，和 `branch-anchor` 是同一个理由的镜像。
fallback / loop-back 边不算入边（`isFallbackHandle` + `loopBackEdgeIds`，与 `normalOutgoing()` 对称）。

### D3 链的构造只有一份实现

`appendOperatorChain()` 与 `prependOperatorChain()` 的差别只有"链头/链尾接到哪一侧"，
proposals→nodes+内部边 的循环（含 `isAppendableBlock` 跳过、`operatorDataOfProposal` 消毒、
`placeClearOfNodes` 让位、`missingParameterProblems` 汇总）必须抽成模块内的 `buildChain()`（§5.2）。
往前插的坐标往**左**放（`anchor.x - NODE_INSERT_GAP * (n - i)`），仍然过 `placeClearOfNodes`。

### D4 "AI 优化" 是原地扩宽 `node-fix`，不是把节点按钮并进聊天dock

否决方案（把节点上的按钮改成打开 `OperatorChatDock` 并预填选中项）：聊天侧的 `edit`/`replace` **没有任何验证**，
而 `node-fix` 的价值恰恰是有界的 observe→execute→diagnose→verify 闭环（`node-fix.ts:34-39`、
`node-fix-engine.ts:188-196`）。并进 dock 等于把验证能力丢掉换成一个更弱的入口，是倒退。
所以：`node-fix` 保留闭环、改名、允许提出"换成另一个算子"，换算子的**图落地复用 `operator-advise` 的
`replaceNodeOperator()`**（§5.3/§5.6，不写第二套重挂边的代码）。

### D5 换算子走独立字段，`data` 的消毒闸门一个字不动

`NODE_FIX_RESERVED_KEYS` 继续剥掉 `data.blockId`（`sanitizeNodeData` 是模型输出进图前的唯一防线，放松它就是放松安全）。
新增的是**顶层**可选字段：`{"blockId":"<new operator id>"}`，只在
① 是字符串、② `!== 当前 blockId`、③ 通过 `aiLandingAllowed()`（见 D7）三条时才接受，否则丢弃并按"只改参数"处理。
prompt 相应从 `Do NOT change the block id` 改为"优先只改参数；只有当这个算子在本页根本无法达成目标时，才可以返回一个新的 `blockId`"。

### D6 撤销修复与 Ctrl+Z 共用一份快照形状和一份恢复逻辑

`fixSnapshotsRef` 从 `Map<nodeId, blockData[]>` 改成 `Map<nodeId, OperatorNodeSnapshot[]>`
（`OperatorNodeSnapshot = {node, edges}`，`operator-advise.ts:279`——它就是为"撤销一次原地改动"设计的）。
`undoAiBatch()` 的 `'node'` 分支和 `revertNodeFix()` 的恢复逻辑是同一件事的第二次出现 → 抽 `restoreNodeSnapshot()`（§5.2），
App 里只留一份实现。原有的"Restore previous version"按钮**保留**（可发现性 + 已测试），Ctrl+Z 是它的键盘等价物。

### D7 "能不能落地这个算子"的判定只有一份

`isAppendableBlock()`（`operator-advise.ts:541`，private）要被两个模块用（operator-advise、node-fix 的 D5 校验），
而 `operator-advise.ts` 已经 import 了 `node-fix.ts` 的 `sanitizeNodeData`，反向 import 会成环。
所以把它**移到 `operator-registry.ts` 并导出为 `aiLandingAllowed(id)`**（registry 是唯一回答"哪些算子可执行、是否 cloud/hidden/allowGeneration"的权威，
它已经 import `PALETTE_BLOCKS`，再补 `OCR_SUPPORTED` / `isCloudBlock` 不引入新方向）；
`operator-advise.ts` 与 `node-fix.ts` 都改为调用它，本地那份删掉（§5.4）。

### D8 Ctrl+Z 覆盖"结构改动"，不覆盖参数输入框里的打字

历史栈在**改动前**压入 `{nodes, edges, selectedIds}` 快照（Workflow 形状，`toWorkflowNode`/`toWorkflowEdge` 产出，纯数据可 `structuredClone`），
恢复时 `toFlowNode` 重建、再把 `selectedIds` 打回去。覆盖：
连线、删边（双击 + Delete 键的 `remove` 变更）、删节点（`deleteNode()` + Delete 键的 `remove` 变更）、
从面板拖入新节点、节点拖动（**一次拖动只压一条**：第一条 `dragging===true` 的 position 变更压入，`dragging===false` 关闭这轮）、
group 的 pack/unpack/children 改写、自动布局、复制、禁用/启用、AI 落地（append/prepend/edit/replace）、AI 优化应用与还原。
**不覆盖**：`patchNode` / block form 的逐字符参数编辑——它们没有离散边界（每次按键一条记录会把栈冲垮），
而焦点在输入框里时浏览器/CodeMirror 的原生撤销本来就在管这个字段。
因此 Ctrl+Z 处理器必须有**焦点守卫**：`target` 是 `input` / `textarea` / `[contenteditable]` / `.cm-editor` 时直接 return，
把这个键还给正在编辑的字段（守卫谓词从 `use-space-select.ts` 导出为 `isEditableTarget()`，两处共用，§5.2）。
不做 redo（诉求里没提，§5.5）。栈深 50，只在内存，切换/重新载入工作流时清空。

## 4. 切片

- **切片 D（先做，是 F 的地基）**：`restoreNodeSnapshot()` + `isEditableTarget()` 导出 + App 历史栈 + Ctrl/Cmd+Z 绑定 + 各改动点压栈。
  验收：`tests/editor-undo.spec.ts`（纯逻辑：快照/恢复、拖动合并、焦点守卫）+ App 侧 acceptance（若可渲染）。
- **切片 E**：`prepend` 词表/解析/prompt、`buildChain()` 抽取、`prependOperatorChain()`、`OperatorSplicedEdge` 加宽 target 侧、
  dock/App 分发与 refusal 文案（en + zh）。验收：`tests/operator-advise.spec.ts` 追加行。
- **切片 F**：改名（含把 `title={bt('AI Fix')}` 换成 i18n key）、`blockId` 顶层字段解析与校验、
  prompt 规则改写、engine 用候选 blockId 试跑、App 落地走 `applyOperatorAction(..., 'replace', ...)`、
  `fixSnapshotsRef` 换成 `OperatorNodeSnapshot`、Modal 展示"建议换为 X"（en + zh）。
  验收：`tests/node-fix.spec.ts` + `tests/node-fix-engine.spec.ts` + acceptance 行。

## 5. 红线自查

- 不新增第二条 LLM 通道、第二个 agent loop、第二个 port/store（§5.6/§5.7）。
- 换算子的图改动、算子可落地判定、原地快照恢复、链构造各只有一份（D3/D4/D6/D7）。
- 跨端纯逻辑仍留在 `src/lib/**`；历史栈是编辑器 UI 的状态，不进 `src/lib`。
- 新增文案一律 en + zh-CN 成对（§3）；按钮样式仍是既有 class / Tailwind token（§2）。
- 模型输出的 `blockId` 在系统边界校验（D5），不进图就落不到 canvas。

## 6. dcc 的表态（2026-10-21，全部选推荐项）

- **顺序**：D → E → F。先做 Ctrl+Z 地基，再往前插，最后 AI 优化。
- **Ctrl+Z 覆盖范围**：结构改动 + AI 落地（即 D8 列出的全部，参数框打字不压栈，焦点守卫把键还给字段）；不做 redo。
- **AI 修复 → AI 优化**：原地扩宽 `node-fix`（D4），不并进 `OperatorChatDock`。
- **往前插的拒绝口径**：照搬后插的规则（D2）——trigger、无入边、多条正常入边三种情况整批拒绝并给命名文案。

## 7. 实施回填

### 切片 D（Ctrl+Z）已完成

按 D6/D8 落地。与本文的出入：

- 纯规则（`CanvasSnapshot`、`EDITOR_UNDO_LIMIT`、`pushCanvasSnapshot`、`removesAnything`、`nodeDragStep`）
  放进了新文件 `src/workflow-editor/graph-history.ts`，而不是留在 App 里。理由：这几条是"什么算一步"的判定，
  只有脱离 React 才能被单测覆盖（⑤ 对扩展页面是 BLOCKED 的，见下），而 App.tsx 本身无法在 jsdom 里渲染；
  它们不含 `chrome`、也不跨端，因此不进 `src/lib`（§5.7 的边界不变）。
- 除本文列出的压栈点外，`insertSecretProducer()`（插入密钥生产节点）也压栈——它同样是对画布的结构性改动。
- 验收：`tests/editor-undo.spec.ts` 10 行（栈序 / 50 上限 / `remove` 识别 / 一次拖动一步 / 焦点守卫）。
  `pnpm typecheck`（两个 tsconfig）、全量 `TZ=UTC npx vitest run`、eslint、prettier、`npx vite build` 均绿。
- **⑤ 浏览器证据：BLOCKED**。`chrome-extension://` 页面不可被脚本化（既有结论），因此"画布上真的按 Ctrl+Z 退一步"
  尚未在真实编辑器里观察到；需要 dcc 加载 unpacked 扩展手工核对一次。

### 切片 E（往前插）已完成

按 D1/D2/D3 落地。与本文的出入：

- `OperatorAction` 四值化后，"落地形态"判别词从 `append` 改为 `chain`：`OperatorLanding.kind`
  与 App 的 `AiUndoRecord.kind` 都改名，因为一条链现在可能落在锚点前也可能落在锚点后，
  再用 `append` 这个名字就是错的（§6.1）。UI 文案不变（"Added N operators" 对两种落点都成立）。
- `OperatorSplicedEdge` 同时记录两端，`edgesAfterBatchRemoved()` 两端一起还原——往前插动的是被借用边的
  **target**，只还原 source 会把线留在一个已被删除的节点上。
- 两处"把一条既有边改挂到别处"的逻辑（append 改 source、prepend 改 target）抽成模块内
  `rewireEdge()` / `splicedEdgeOf()`（§5.2 第二次出现即抽）。
- 新增三个拒绝原因（`prepend-entry-point` / `prepend-no-incoming` / `join-anchor`）在 dock 的
  `PROBLEM_KEY` 里是编译必需的（`Record<OperatorLandingProblem, …>`），文案 en + zh 成对；
  顺带把 dock 顶部 `operatorAiHint` 两句改成"可选中步骤前/后插入"。
- 被扣住的批次（缺页面参数的 offer）现在记住自己原来的 placement（`PendingOffer.action`），
  否则"先拾取元素再落地"会把 prepend 静默变成 append。
- 验收：`tests/operator-advise.spec.ts` 追加 `describe('prependOperatorChain')` 6 行 + 撤销往返 1 行 +
  解析 1 行 + prompt 断言更新；`tests/acceptance-operator-chat-dock.spec.tsx` 追加"落地带 prepend"与
  "offer 保留 placement" 2 行。
- **⑤ 浏览器证据：BLOCKED**（同上）。

### 切片 F（AI 优化）已完成

按 D4/D5/D6/D7 落地。与本文的出入：

- **换算子的闸门比 D5 更严**：接受条件不是 `aiLandingAllowed()` 而是 `isObservableBlock()`。理由是这个闭环的
  承诺是"已验证的结果"——候选算子必须真能被引擎试跑（`execute` 类、可被观察），否则会出现"按一个跑不动的算子
  验证成功"的假阳性。因此引擎里 `runningBlockId` 只接受可观察的 id，并且**试跑也用这个 id**；
  不可观察（或等于当前）的回答被丢弃，该轮仍按"只改参数"处理（`tests/node-fix-engine.spec.ts` 三种落点各一行）。
- **换算子的词汇表不进 `node-fix.ts`**：D7 设想 node-fix 反向调用 registry，但 `swapTargets` 一旦在纯模块里
  自己算，就得 import `operator-advise`（`isObservableBlock` 在那），而后者已经 import `sanitizeNodeData` → 成环。
  所以 `swapTargetsOf()` 放在引擎侧，`swapTargets` 只是 `NodeFixPromptInput` 的一个普通字段；
  纯模块继续 chrome-free、零 registry 依赖（§5.7）。
- **`proposedOf()` 一个函数管两种结果形状**：未换算子时返回 `{...input.blockData, ...working}`（节点原有数据
  打底），换算子时只返回 `working` + `proposedBlockId`——因为落地侧是助手的 replace patcher，它会重新推导新块
  该带什么参数，把旧算子的字段硬并过去只会留一堆死键。
- **prompt 成本**：`## Operators this step may be switched to` 一节是本构建里 `isObservableBlock` 允许的算子
  清单（切片 F 实测 35 行 `- id — name`）。刻意不塞带 schema 的 `adviseCandidates` offer——那是几十倍的字，
  而这里需要的只是"哪些 id 合法"。无候选时该节整体不出现，规则退回 `Do NOT change the block id.`。
- **修掉一个既有的静默破坏**：`replaceNodeOperator()` 过去会把节点的 goal contract 一起丢掉（它的注释声明会保留，
  代码里 `key.startsWith('__')` 把整个 `__workflowAi` 命名空间剥掉了）。换算子若删掉判据，等于"AI 优化"把自己
  被评判的目标抹了，还会悄悄让认证失效。现改为只剥命名空间里不该随行的部分、用 `withNodeGoalContract()` 把
  `goalContract` 重新挂上，而 `addedBy` 溯源**故意不随行**（那一步现在是 AI 优化落地的，不是助手新增的）。
  两个既有用例（`tests/operator-advise.spec.ts:942/:947`）之所以一直没暴露这个 bug，是因为它们的 fixture 没有契约。
- **改名覆盖面**：编辑器 i18n（按钮/标题/占位/开始/停止/成功/失败/应用中的提示全部改为"优化"口径）+ 侧栏镜像的
  `workflowFixLogTitle`（同一个功能不能在两个界面叫两个名字）+ `operatorAiReplaced` 改成不写施动者的中性文案
  （现在换算是 AI 优化落地的，复用原文案会说谎）+ 修正 `goalHelpGoal`/`goalHelpEmpty` 里"没有目标契约就拒绝"
  这句**已经过时**的描述（实际是无契约时依据用户的话或粘贴的报错日志起步）。
- **撤销**：`applyNodeFix` 与数据分支共用 `recordFixSnapshot`，换算子时压的是 `patch.before`（节点 + 边），
  所以"Restore previous version"和 Ctrl+Z 都能把算子类型与连线一起退回去；patcher 拒绝时**什么都不改**，
  只给一条命名了目标算子的失败提示（`nodeFixSwapRefused`）。
- **Modal 前置披露**：成功页在"应用"之前显示 `nodeFixSwapProposed`（已验证的结果是把这一步按 X 跑通的），
  因为应用会改变算子类型而不只是参数。
- 验收：`tests/node-fix.spec.ts` 新增 6 行（prompt 提供/不提供清单、顶层 `blockId` 解析、非字符串忽略、
  日志显示回答里的换算子即便会被拒、请求里的可选清单），`tests/node-fix-engine.spec.ts` 新增 3 行，
  `tests/operator-advise.spec.ts` 新增 1 行，`tests/acceptance-node-fix-modal.spec.tsx` 新增 2 行；
  改名波及的 3 个既有 acceptance 文件（按钮 title、goal 说明、日志标题）断言同步更新。
  切片 F 文件集：`npx tsc --noEmit`（两个 tsconfig）、全量 `TZ=UTC npx vitest run` 411 文件 / 4749 行、
  eslint、prettier、`npx vite build` 均绿。
- **⑤ 浏览器证据：BLOCKED**（同切片 D/E）：`chrome-extension://` 页面不可脚本化，"节点按钮真的叫 AI 优化、
  换算子真的在画布落地且能被撤销"尚未在真实编辑器里观察到，需要 dcc 加载 unpacked 扩展手工核对。
