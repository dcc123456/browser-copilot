# 分组算子：组内子链与画布打包 · blocks-group: nested child chain and canvas packing — design

日期 / Date: 2026-10-19
关联 / Related: `specs/2026-10-19-workflow-group-block-plan.md`、`specs/2026-10-15-notification-feishu-and-goal-free-design.md` §3.1（目标位 `goalBearing`）、`specs/workflow-generation-operator-selection-spec.md:2591`（`blocks-group` 待办行）

## 1. 需求原文 · Requested behaviour

- 「分组算子节点功能没有实现。」
- 「分组算子节点不需要目标与成功条件。」
- 方向由用户定：按 Automa 的**嵌套子链**语义实现；子块列表**画在画布节点内**（Automa 样式，不是侧栏表单）；并额外提供「选中多个节点 → 打包成组 / 解组」。
- `note` 与分组同属非动作块，一起去掉「目标与成功条件」区。

## 2. 现状取证 · Evidence about the current code

以下都是读代码与读上游一手源码得到的事实，不是推测。

**目录里有，渲染/执行/校验全都没有。**

- 目录条目 `src/lib/workflow/blocks/catalog.ts:1057-1074`：`component: 'Group'`、`disableEdit: true`、默认 `data: { disableBlock:false, name:'', blocks:[] }`；`BlockComponent` 里已声明 `'Group'`（`src/lib/workflow/blocks/types.ts:26`）。
- 渲染层**从不读 `block.component`**：节点类型只在 `App.tsx:116` 与 `:129` 按 `blockId === 'note' ? 'NoteNode' : 'BlockNode'` 选，`nodeTypes` 只有两个键（`src/workflow-editor/flow/BlockNode.tsx:356-359`）。所以组节点退化成一个普通算子盒。
- `disableEdit: true` 让编辑面板只显「This block has no editable settings.」（`src/workflow-editor/sidebar/BlockEditForm.tsx:177`），且该块没有 `editComponent`。
- 执行器空转：`src/background/workflow-engine/executors.ts:3121-3124` 与镜像 `server/src/executors.ts:1951` 都是 `return null`，注册于 `executors.ts:3519` / `server/src/executors.ts:2234`。
- 分类现状：`blocks-group` 在 `PLACEHOLDER_BLOCK_IDS`（`src/lib/workflow/operator-class.ts:89`，理由「执行器还是占位」），并对 AI 隐藏（`src/lib/workflow/operator-registry.ts:165`）。
- 校验层**零感知**：`validation.ts` / `integrity.ts` / `runnability.ts` / `generated-validation.ts` / `save-gate.ts` 中没有任何 `blocks-group` 引用。测试只有 `tests/block-icons.spec.ts:47` 断言图标。

**导入的 Automa 组现在是静默丢步骤。**

- `fromAutomaExport`（`src/lib/workflow/migrate.ts:328-358`）把每个节点的 `data` 原样搬进来（`data: { ...data, blockId }`），`migrateNodeData:74-92` 是「默认值 < values < 平铺字段」的覆盖顺序，已存在的 `blocks` 数组会保留。也就是说子块确实进了本地工作流，但没有任何消费者 → 运行时组是透传，组内的真实动作全部不执行。

**引擎侧的硬约束决定了实现位置。**

- `runNode(nodeId)` 只认 `nodeById`，查不到就返回 null 并**终止这条链**（`engine.ts:784-785`）；`nodeById` / `outBySource` 是 `runCore` 在派发前建好的局部量（`:591-600`）。
- 执行器签名只能返回**单个** next 节点 id（`executors.ts:226-229`）——这正是循环之所以由引擎自己解释的原因（`engine.ts:418-424` 注释）。现成机制：`runSegment(startId, stopAt)`（`:1290-1299`）、`runLoopBody`（`:1310-1315`）、以及「跑一段序列化子图」的模板 `runSubWorkflow`（`:1527-1566`，复用同一 `variables` / `executorsMap` / `onStep`）。
- 参数插值只有一个入口：`interpolateParams(paramsOf(current), variables)`（`engine.ts:869`），`src/lib/workflow/interpolate.ts:178-203` 会递归进嵌套数组/对象。
- **nodeId 是有主台账**，子块不得伪装成画布节点 id 混进去：checkpoint `engine.ts:682-706` → `src/lib/workflow/checkpoints.ts:130`，续跑把 `cp.nodeId` 拿去 `drawflow.nodes` 里解析（`checkpoints.ts:224` → `run-workflow.ts:590-614` → `engine.ts:1569-1572`）；日志与 trace `engine.ts:605` / `execution-trace.ts:125-127,310-318`；`failure-memory.ts:22,65-68` 的 `nodeId::signature` 键；repair 定位 `debug-session.ts:132` → `auto-debug-patch.ts:122`。合成 id 一旦泄漏，续跑会静默空转、repair 会打不存在的节点。
- 两侧宿主共用同一份引擎文件：`server/src/run-service.ts:24` 直接 `import` `../../src/background/workflow-engine/engine`，经 `server/tsconfig.json:24-25` 编译。**引擎改一处即可**，只有执行器表是两份镜像。

**目标位的判定链只有一处。**

- `NON_GOAL_BEARING_BLOCK_IDS`（`operator-class.ts:78`）→ `goalBearing`（`operator-registry.ts:283`，可用 `OVERRIDES` 覆盖 `:86`）→ 两个消费者：`resolveNodeGoalContract`（`node-goal-instantiation.ts:122`，第①步「模型自带契约仍然优先」在它之前）与 `operatorCarriesGoal`（`operator-registry.ts:334`）→ 编辑器 `BlockEditForm.tsx:137` 同时控制 AI Fix 按钮 `:148` 和「目标与成功条件」区 `:188`。
- 无契约不会卡认证：`goal-verification.ts:172` 读不到契约就留空，`:230-236` 的 L2 用 `.every`，空条件不会证伪；认证仍由 L1+L3 决定。

**上游一手证据（Automa main@a4cbe34）。**

- `src/workflowEngine/blocksHandler/handlerBlocksGroup.js`：把 `data.blocks` 的子块按 `child[i] → child[i+1]` 线性接起来，**末个子块指回组节点自身的 id**（于是接上组的出边），从 `data.blocks[0].itemId` 进入；`data.blocks.length === 0` 时按透传处理。子块结构是 `{ id: 块类型, itemId, data }`。注意它是 `Object.assign` 进 `engine.blocks` / `connectionsMap`（全局污染），本设计不照抄这一点。
- `src/components/block/BlockGroup.vue`：组名输入框 + 子块列表（拖拽排序、铅笔打开子块表单、设置、删除、testing 模式下的断点开关）+「拖到这里」空态。
- `src/utils/shared.js:1655` `excludeGroupBlocks` = `trigger, repeat-task, loop-data, loop-breakpoint, blocks-group, conditions, webhook, element-exists, while-loop, block-package`。

## 3. 设计 · Design

### 3.1 数据契约与共享清单（`src/lib/workflow`）

- 子块形状与上游**字面一致**：`{ id: string /* blockId */, itemId: string, data: Record<string, unknown> }`，`itemId` 由既有 `newId()`（`src/lib/storage.ts`）生成。这样导入/导出双向不用转换。
- 组节点 `data` 形状不变：`{ disableBlock, name, blocks }`。
- 「哪些块不能进组」是 block-id 分类，放进入既有分类模块 `operator-class.ts`，新增 `GROUP_CHILD_EXCLUDED_BLOCK_IDS`（照抄上游清单并注明来源），不在别处再抄一份。
- 子块的序列化/还原（节点+边 ⇄ `data.blocks`）是新的跨端纯逻辑，放 `src/lib/workflow/group.ts`：编辑器、引擎、校验三处都要用，按 §5.3 这是唯一新增文件，理由是它谁都不属于现有模块。
- **子块不是画布节点**：不进 `drawflow.nodes`、不进 `edges`，因此不写 checkpoint / trace / failure-memory / repair 台账。它们的日志键按顺序取 `${groupNodeId}#${序号}`（`itemId` 只在报错文案里出现，因为它不参与寻址）。日志键是合成的，所以子块照样有逐步日志，但没有 L2 验证、没有 preflight 门、不能精确断点续跑；子块失败时 `aiTakeover` 仍会跑（拿着 `failedBlockId` 和子块参数），但修复侧按 nodeId 定位不到它，等于只能人工修。

### 3.2 引擎：`blocks-group` 改为引擎解释，和循环同级

- 位置：`engine.ts` 在派发前的特殊分支（与 `:907-917` 的循环/子工作流同处），不再走执行器表。
- 空组：直接 `defaultNext`（与现状一致，也与上游一致）。
- 非空组：按序对每个子块走**与单节点动作完全相同的那条内部路径**。实现方式是把子块临时注册进 `nodeById` / `outBySource`（键 `${group.id}#${序号}`，出边只有「下一个子块，末个子块接组的 `defaultNext`」这一条），再用 `runGroupChildren` 内部自己的走链循环逐个 `runNode`——这样插值、`disableBlock` 跳过、重试策略、readiness、逐步日志全部是同一条路径，没有第二条执行通道（§5.6）。跑完在 `finally` 里把临时条目全部删掉，两个映射表任何时候只认真实节点。
- **不能把首个子块的返回值交回外层 `runSegment`**：那样 `finally` 会在第二个子块被查表前就把注册拆掉，组只剩第一个子块执行。必须在本函数内走完这条链。
- **临时键不得覆盖真实节点**：注册前先查 `nodeById.has(key)`，命中即失败报错（文案含「冲突」）而不是静默改名——按 id 查表的引擎一旦被遮蔽，画布上那个节点会被 reroute 并在 teardown 时消失。
- 子块合法性：命中 `GROUP_CHILD_EXCLUDED_BLOCK_IDS` 的子块**报错**而不是静默跳过——静默跳过就是现在导入丢步骤的那个 bug 的形状。
- 子块失败 = 组失败：子块走的就是 `runNode`，所以重试策略、`toDo='continue'`、fallback、`aiTakeover` 全都按现有语义发生，只是 `failingNodeId` 是那个临时键；链条中断后 `runGroupChildren` 返回 `null`，组不会漏到 `defaultNext`，运行以子块的错误结束。组本身非目标块，`node-fix-engine.ts:201-212` 的「无契约且无证据」分支已经会拒绝修复自动补丁，这是预期行为，不另造豁免。
- 两侧镜像：引擎只有一份，改一处；两侧执行器表里的 `'blocks-group'` 条目变成死代码，按 §5.4 **同批删除**（`executors.ts:3121-3124,3519` 与 `server/src/executors.ts:1951,2234`）。
- 分类修正：`blocks-group` 从 `PLACEHOLDER_BLOCK_IDS` 移到 `ENGINE_INTERPRETED_BLOCK_IDS`（它现在真的由引擎展开执行），`RECORD_ONLY_REASONS` 文案改成「组由引擎展开执行，不是单节点动作」；生成期仍是 record-only，与循环族口径一致。

### 3.3 画布：`GroupNode` 在节点内渲染子块列表（Automa 样式）

- 新增 `GroupNode` 组件并注册进 `nodeTypes`（`BlockNode.tsx:356-359`）；`App.tsx:116/129` 的选取谓词改为读 `block.component === 'Group'`（这是 `types.ts:26` 已声明的键，比再加一个 `blockId` 三元更正）。`note` 维持现状以压小改动面。
- 节点内自上而下：组名输入（写 `data.name`）→ 子块行（图标 / 名称 / 描述 + 上移 / 下移 / 铅笔 / 删除）→「把算子拖到这里」空态。列表容器带 `nowheel`，滚动不吃掉画布缩放。
- 排序用上下按钮，**不引入拖拽库**（仓库无 dnd 依赖；`EditConditions.tsx:83-159` 的 ArrowUp/ArrowDown + `wf-btn-accent` + 虚线空态就是既有样式模板，照它抄）。
- 拖入：`App.onDrop`（`App.tsx:333-350`）先用 `reactFlow.getNode` 判断落点在不在组节点上；是 → 追加子块（并检查排除清单），否 → 保持现有建节点行为。
- 编辑子块：铅笔复用 `BlockEditForm` / `EditForms`（`blocks/EditForms.tsx:21-25` 的 `EditFormProps = { data, onChange, blockId }`，全表 55 个表单都不碰图/选择态），`onChange` 写回 `blocks[i].data`。子块编辑态隐藏「目标与成功条件」区与 AI Fix：引擎不读子块契约，给了也验不了——和 §3.1「不给假目标」是同一条理由。
- **目录条目保持 `disableEdit: true`**（落地时对 §3.3 原计划的修正）：`OPERATOR_BLOCK_IDS` 是从 `!entry.disableEdit` 推出来的（`operator-tools.ts:67-78`），去掉它会让分组变成一个 MCP 可调用的「算子」，而组真正的内容在 `data.blocks`，不是面板表单。分组的可编辑性由画布上的 `GroupNode` 提供，侧栏表单继续显「无可编辑设置」；这条同时把 `blocks-group` 挡在生成期算子表外，与 §3.2 的 record-only 分类一致。

### 3.4 打包 / 解组（画布命令）

- **打包成组**：选中 ≥2 个节点，且它们在选中子图里构成**一条线性链**（每个选中点至多 1 条来自选中集的入边、至多 1 条到选中集的出边，恰好一头一尾）。不满足 → toast 拒绝并说明「组内只支持线性链，请先用分支/循环或分开打包」。满足 → 按拓扑序序列化进新组节点的 `data.blocks`，删除原节点，组的入边 = 从选中集外部指进来者、出边 = 从选中集指出去者，组位置取选中包围盒左上角。
- **解组**：把 `data.blocks` 还原成画布节点（沿组出边方向依次排开），重接 组入边 → 首个子块、末个子块 → 组出边，删除组节点。子块的 `itemId` 直接用作新节点 id，便于人工比对。
- 入口：选中数 ≥2 时在既有工具条（`toolbar/TopToolbar.tsx` / `toolbar/CanvasControls.tsx`）出现「打包成组」；组节点的 `NodeToolbar`（`BlockNode.tsx:70-112`）出现「解组」。**不新增快捷键**——space-select 与删除键已有归属。
- 复用既有写回通道：`App.tsx:370-378` 的 `patchNode`（浅合并进 `blockData`）与节点/边集合的既有 setter，不新开一条状态通道。

### 3.5 校验与兼容

- `validation.ts` / `integrity.ts` 认识子块，各自给明确 issue：子块 `id` 不在目录、子块命中排除清单、（可选）空组只给提示。子块**不得**被要求 `NODE_GOAL_MISSING`——校验只遍历 `drawflow.nodes`，天然满足，但要加测试钉住。
- 导入方向自动受益：`fromAutomaExport` 已经保留 `data.blocks`，引擎开始执行子链后，原先静默跳过的组会真的跑起来。这是本设计顺带修掉的既有缺陷。
- `seed-recall.ts:270` 的 `isActionNode` 会把组当成一步（名字显示为「分组」）。v1 保持不变——宁可多一步占位也不要丢信息；「把子块展开成步骤」列为后续。

## 4. 不做 · Out of scope

- 组套组（`blocks-group` 作子块，上游也排除）。
- 子块级 L2 目标验收、checkpoint 精确续跑到某个子块、子块级 repair 定位。
- 分支/循环/trigger 作为子块。
- React Flow `parentId` 画布容器分组（在 §5 中被否决）。
- 组节点对 AI 可见或可由 AI 生成（`aiExposure` 保持 `hidden`）。
- 顺手清理 `note` 的渲染选取方式（仍走 `blockId === 'note'`）。

## 5. 选型与证据 · Alternatives and evidence

- **A｜Automa 嵌套子链（采纳）**。一手证据：上游 `handlerBlocksGroup.js` 的执行语义、`BlockGroup.vue` 的嵌套列表 UI、`shared.js:1655` 的排除清单。本仓库目录默认 `data` 已是 `{ name, blocks }` 形状（`catalog.ts:1071`），`fromAutomaExport` 原样保留（`migrate.ts:348-357`）→ 双向 JSON 兼容，并顺带修掉「导入的组静默丢步骤」。执行位置由 `executors.ts:226-229`（单返回值）+ `engine.ts:418-424`（循环因此由引擎解释）锁定为引擎解释。
- **B｜React Flow `parentId` 画布容器（否决）**。否决理由：与上游 `data.blocks` 不互通，导入的组继续静默丢步骤；并且要给持久化形状加 containment 字段（`App.tsx:820-831` 的 `buildWorkflow` 目前只写 `{id,label,position,data}`），跨端契约面比 A 大。它解决的「大画布整理」在 A 里由 §3.4 的打包/解组覆盖大半。
- **C｜只做占位渲染（否决）**。否决理由：不修导入丢步骤，也不满足「功能没有实现」这句诉求。
- **子块编辑位置**：选 A 的「画布节点内列表」是用户明确点的方向；侧栏表单内编辑（改动面更小、`EditConditions` 有现成内联范式）作为被否决的备选记录在此。
- **不引入拖拽库**：排序用上下按钮。引入 dnd 依赖属于新增同类基础设施，且仓库现有内联列表（`ConditionBuilder.tsx`）没有先例。
- **本机实测结论**：见 plan 的门禁一节，逐条附命令与输出；当前尚未跑真实浏览器验证（引擎改动需要 `bench:debug` before/after，编辑器 UI 需要 `tmp/` harness 或 `selftest` 证据）。
