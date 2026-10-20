# 分组算子：组内子链与画布打包 · plan

日期 / Date: 2026-10-19
设计 / Design: `specs/2026-10-19-workflow-group-block-design.md`

## 切片

**S0｜非动作块不带目标与成功条件**（已完成，先于分组本体）

- `blocks-group` 与 `note` 加入 `NON_GOAL_BEARING_BLOCK_IDS`（`src/lib/workflow/operator-class.ts:78`），注释扩到「外发即完成」与「结构性块」两类理由。
- 效果：编辑器不再显「目标与成功条件」区与 AI Fix（`BlockEditForm.tsx:137`），生成不再编造契约（`node-goal-instantiation.ts:122`），校验不要求 `NODE_GOAL_MISSING`。历史数据里已存在的契约按 `specs/2026-10-15-...-design.md` §3.1 的决定**不追溯清理**。
- 测试：`tests/non-goal-bearing-operators.spec.ts` 钉死清单 + 组/备注不编造契约 + 校验夹具里放一个组节点。

**S1｜数据契约与共享清单**

- `operator-class.ts`：新增 `GROUP_CHILD_EXCLUDED_BLOCK_IDS`（照上游 `shared.js:1655`，注明来源与理由）；`blocks-group` 从 `PLACEHOLDER_BLOCK_IDS` 移到 `ENGINE_INTERPRETED_BLOCK_IDS`，`RECORD_ONLY_REASONS` 文案同步。
- 新文件 `src/lib/workflow/group.ts`：子块类型 `{ id, itemId, data }`、读/写 `data.blocks`、按拓扑序序列化节点+边、还原成节点列表、校验子块合法性。chrome-free，引擎/编辑器/校验共用。
- 测试：线性链识别（接受/拒绝分支）、序列化与还原往返一致、上游形状能读、排除清单命中即拒。

**S2｜引擎解释执行子链**

- `engine.ts`：在派发前的特殊分支（`:907-917` 旁）处理 `blocks-group`；空组透传；非空组按序走「插值 → `disableBlock` 跳过 → 执行器派发 → 逐步日志」，末个子块接组的 `defaultNext`；非法子块报错不静默。
- 两侧执行器表删除 `'blocks-group'` 条目（`src/background/workflow-engine/executors.ts:3121-3124,3519`、`server/src/executors.ts:1951,2234`）。
- 日志键 `${groupId}#${序号}`（子块临时节点 id 同键，跑完即拆）；子块不进 `completedNodeIds`、不写 checkpoint、不记 degradation，因此也不进 trace / failure-memory / repair 台账。注册前先查临时键是否与真实节点冲突，冲突就报错而不是遮蔽。
- 测试：空组透传、三子块按序且变量在子块间传递、`disableBlock` 子块被跳过、子块报错等于组失败、排除清单子块报错；Runner 侧同一引擎文件跑通。

**S3｜画布 `GroupNode`**

- `BlockNode.tsx` 新增 `GroupNode` 并注册 `nodeTypes`；`App.tsx:116/129` 选取谓词改读 `block.component === 'Group'`。
- 节点内：组名输入、子块行（上移/下移/铅笔/删除）、`nowheel` 列表、拖入空态。样式走 `design-system.css` 的 token 类，照 `EditConditions.tsx:83-159` 的列表模板。
- 铅笔复用 `EditForms`，写回 `blocks[i].data`；子块编辑态不显目标区/AI Fix。
- `App.onDrop`：落点在组节点上 → 追加子块（查排除清单），否则维持原行为。
- 目录**保留** `blocks-group` 的 `disableEdit: true`：去掉它等于把分组塞进 `OPERATOR_BLOCK_IDS`（该集合由 `!disableEdit` 推出），而组的编辑面在画布 `GroupNode` 上，不在侧栏表单。详见设计 §3.3。
- i18n：`EDITOR_STRINGS` 增 flat camelCase 键，en + zh-CN 双侧（`src/workflow-editor/i18n.ts`）。

**S4｜打包成组 / 解组**

- 选中 ≥2 → 工具条出现「打包成组」；组节点 `NodeToolbar` 出现「解组」。
- 线性链校验不满足时 toast 说明原因；文案 en + zh-CN。
- 写回沿用 `App.tsx:370-378` 的 `patchNode` 与既有节点/边 setter。

**S5｜校验认识子块**

- `validation.ts` / `integrity.ts`：子块未知 blockId、子块命中排除清单各给明确 issue；钉一个测试证明子块不会被要求目标契约、组节点本身不产生 `NODE_GOAL_MISSING`。

## 门禁（收尾自检对应）

- ① `TZ=UTC pnpm typecheck`、`TZ=UTC pnpm test`（CI runner 是 UTC，本地必须带 `TZ=UTC`）；`pnpm lint` / `pnpm format:check` 只对 `git ls-files` 覆盖的文件跑（裸 `pnpm lint` 会被 `tmp/ci-surface` 的 tsconfig 硬失败）。S3/S4 动 UI 与目录 → 额外 `pnpm build`。
- ② `pnpm server:typecheck`、`pnpm server:test`（S2 删的是两侧镜像的执行器条目）。
- ③ 动了 `src/background/workflow-engine/**` → `TZ=UTC pnpm bench:debug` 取 before/after，按 `CONTRIBUTING.md` 报告相对 `tests/bench/baseline.json` 的成功率变化。
- ④ 若新增/修改 `executeScript({func})` 内联函数体 → `pnpm verify:injected`（不在 CI，手动跑）。目前预计不涉及。
- ⑤ 浏览器可见行为证据：S2 用真实 Chrome 需要一条含组的工作流——优先 `pnpm selftest`（build → reload → generate → replay）里塞一条手工含组的工作流；拿不到就把 `pnpm test:replay` 的产物或手工步骤写清楚，否则标 **BLOCKED**。S3/S4 的画布渲染用 `tmp/` 里的 vite+playwright harness 渲染单个组件（扩展页面本身不可脚本化），并写明哪些交互（拖拽落点、nowheel）只能人工验证。
- ⑥ 复用检查：子块序列化/还原只允许在 `src/lib/workflow/group.ts` 一处；`GROUP_CHILD_EXCLUDED_BLOCK_IDS` 只允许一份；不新增第三条浏览器驱动路径，也不引入拖拽依赖。
- ⑦ 无死代码：`'blocks-group'` 执行器条目随 S2 一并删除；无注释掉的代码块。
- ⑧ UI 用 Tailwind + `@theme inline` token 类，新增文案 en + zh-CN 成对。
- ⑨ 探针/截图/一次性素材只留 `tmp/`，不 `git add -f`。
- ⑩ 提交一律英文 Conventional Commits，本主题按 S0/S1..S5 分层提交；工作区可能有并行 agent 的改动（已观察到 `flow/BlockNode.tsx`、`flow/connections.ts`、`src/lib/workflow/block-ports.ts`、`specs/2026-10-19-editor-operator-ai-chat-design.md` 被他人修改），暂存前必须重新核对 `git status` 并只挑本主题的文件与 hunk。

## 实施记录（S1–S5 已落地）

- **S3 落点**：`src/workflow-editor/flow/GroupNode.tsx`（新）+ `App.tsx` 的 `flowTypeOf`/`nodeTypes`/`onDrop` 命中组框即追加子块 / `childEditFor` + `BlockEditForm` 的 `hideGoal`。子块行的按钮用紧凑 Tailwind 工具类而非 `wf-icon-btn`（32px），节点宽度 `w-80`：harness 截图证明沿用 32px 按钮时算子名被截成 `Click ele…` 且无可读余量；名称与描述补了 `title` 兜住长名。`disableBlock` 的子块整行 `opacity-60`，与画布上禁用节点的观感一致（引擎本来就跳过它）。
- **S4 落点**：`TopToolbar` 在 `selectedCount >= 2` 时出现「打包成组」；「解组」挂在组节点共用的 hover 菜单里——`BlockNode` 的 `NodeToolbar` 导出并新增 `extra` 插槽，避免第二份工具条实现（§5.2）。
- **边的手数**：`App.tsx` 里给分组规划器用的 `toEdgeForGroup`（原样 spread React Flow 的 Edge）换成 `toCanvasEdge`，复用 `flow/connections.ts` 的 `newEdge`——画布边的形状只有一处定义，`type: 'custom'` 也不会因为规划器重新锚定而丢失。
- **修掉的真实缺陷**：`setGroupChildren` 早期版本只按 `block.id` 过滤，往一个组里追加子块会重写**所有**组的列表；现按 `nodeId` 命中。
- **死代码**：`group.ts` 的 `withGroupChildren` 无调用点，已删除；写回 `blocks` 由 `App.setGroupChildren` 承担。
- **i18n**：`EDITOR_STRINGS` 新增 13 个 `group*` 键，en + zh 成对（`groupPack`、`groupUnpack`、`groupUnpacked`、`groupDefaultName`、`groupNamePlaceholder`、`groupChildrenEmpty`、`groupChildMoveUp/Down/Edit/Delete`、`groupPackTooFew/NotAChain/StrayConnection/ForbiddenChild`）。注意该字典不受封闭 `Messages` 类型保护，成对靠人工。
- **证据**：离线门禁在隔离克隆 `tmp/verify-group` 跑（工作区有并行 agent 写入）——`tsc --noEmit`（src + tests）0 错、`TZ=UTC vitest run` 393 文件 / 4528 用例全绿、`eslint` 0 error（4 条 warning 全是 kernel/benchmark 存量）、本主题文件 `prettier --check` 干净、`vite build` 成功、Runner 侧 `tsc` 0 错 + 12 文件 / 102 用例全绿；`node scripts/bench-debug.mjs` = `{"successRate":0.6667,"total":9,"verified":6}`，与 `tests/bench/baseline.json` 一致（分组不在 bench 场景内，属无变化确认）。
- **⑤ 画布渲染证据**：`tmp/group-ui/`（vite + playwright harness，只渲染组件，不进主干）以真实 Chromium 渲染 `GroupNode`：dark/light 两主题、en/zh 双语、空态、禁用子行、组节点 2 个 handle 且与下游节点连线正常，`console`/`pageerror` 为空。交互同样在真实浏览器里点出来（每个动作断言节点内 `data.blocks` 的实际顺序）：首行下移 → `get-text,event-click,delay`；第 2 行铅笔 → 回调收到 `index=1`；第 3 行删除 → 只剩 `get-text,event-click`；组名输入写回 `Renamed group`；hover 菜单 7 项且末位是「解组/Ungroup」，点击触发 `onUnpack`，相邻普通 `BlockNode` 只有 6 项（没有解组）。截图与标题 tooltip 一并核对（`Click element` 这类长名在 320px 宽度下仍会省略号，靠 `title` 兜底）。
- **仍为 BLOCKED**：拖拽落点命中判定（`onDrop` 的组框命中）、`nowheel` 滚动手感、打包/解组在真实画布上的选区交互，以及 S2 的「含组工作流在真实 Chrome 上跑通」——扩展页面不可脚本化，需要 `pnpm selftest` 一轮（要 dcc 点头才跑）。
