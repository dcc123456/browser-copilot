# 条件分支算子：多 path 输出 + fallback + 弹窗编辑

裁定来源：用户反馈「工作流中条件分支算子功能不完善」——期望语义为
"When this block is executing, it will check every condition you have built. If it matches
the condition, the workflow continues to the block that connects with the condition output. If
there's no match, the workflow will continue to the block connects with the fallback output."

## 1. 现状与根因（实测）

三处模型互不一致——这是「只有 true/false、名称不对、不能按 path 连线」的根因：

| 层           | 位置                                                | 现状                                                                                                                    |
| ------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 编辑表单     | `workflow-editor/blocks/batchC/EditConditions.tsx`  | **已**按 `ConditionPath[]{id,name,conditions:OrGroup[]}` 存取（但写进 `data.conditions`），path 列表 + 内联展开 builder |
| 画布句柄     | `workflow-editor/flow/BlockNode.tsx:115-136`        | `BRANCH_HANDLES.conditions` 硬编码 `[output-1:'true', output-2:'false']`，与 path 无关                                  |
| 引擎         | `background/workflow-engine/executors.ts:3328-3360` | 把 path 数组当 `ConditionGroup[]` 整体求值成**一个布尔**，`outputs['true']??['output-1']` vs `['false']??['output-2']`  |
| 引擎句柄映射 | `background/workflow-engine/engine.ts:805-812`      | `BRANCH_KEYS.conditions = ['true','false']` 固定二元组；`branchSlot` 只认 `output-[12]`                                 |

后果：表单头注释声称「canvas 每 path 一个 handle `<blockId>-output-<pathId>`」，但画布与引擎都不实现；path 数组被当成 OR 组整体求值，多 path 无法分别路由，标签恒为 true/false。

另：`element-exists`、`loop-*` 的两端口（exists/not-exists、loop/end）**不在本次范围**，保持固定。

## 2. 数据模型（裁定）

新增专用字段 `paths`，**不复用** `conditions`：

- `while-loop` 也用 `conditions`（存迭代判定 `OrGroup[]`），复用会让两形状不可区分。
- 专用字段让迁移幂等：一旦 `paths` 存在，迁移即 no-op。

```ts
interface ConditionPath {
  id: string // 稳定 id，建 path 时一次性生成；画布句柄只认它
  name: string // 用户可见名，直接作为画布句柄标签
  conditions: OrGroup[] // 复用 ConditionBuilder 的 OR(AND) 条件树
}
```

读取统一走 `conditionPathsOf(raw)`（`lib/workflow/condition-tree.ts`）：无 id 的条目丢弃——句柄以 id 为键，无 id 的 path 无法连线。表单、画布、匹配器共用这一份定义（§5.2）。

**单一事实源**：`paths` 一旦存在即为权威（含空数组＝未配置任何分支）。`hasConditionsContent`（`block-requirements.ts`）与 `executors.conditionsBlock` 都先看 `paths`，只有完全没有该键的节点才回落到旧 `conditions`；迁移在提升时 `delete data.conditions`，不留可复活的旧树。

catalog 默认值同步改为 `paths: []`（新块从一开始就是权威形状）。

## 3. 句柄与路由

句柄 id（path.id 稳定 → 改名/重排不丢线）：

- 每 path：`${blockId}-output-${path.id}`
- 「无一命中」：恒存在 `${blockId}-output-none`

`output-none` **不用** `output-fallback`：`${blockId}-output-fallback` 已占用于 `onError.toDo==='fallback'`（引擎第 1194 行按 `outputs['fallback']` 路由），同块渲染两个同 id 句柄会让 React Flow 的连线错乱、且一次执行错误被误当成「无命中」。画布上该端口的**显示名**仍是 `fallback`（对齐用户口径与 Automa）。

`BRANCH_HANDLES.conditions` 静态项删除，改为 `branchHandlesFor(block, blockData)`（`BlockNode.tsx` 导出）：

- `conditions` → 由 `paths` 派生 + 末尾 `output-none`；未配置 path 的新块也至少画出 fallback 口。
- 其余块仍走静态表（`element-exists` / `loop-*` / `repeat-task`）。
- `healEdgeHandles` 必须同用该函数，否则未知 path 句柄会被静默改写成 `output-1`（丢线）；无主句柄的回写目标改为「该块最上方的口」（`firstSource`）。

删除 path 时 `App.tsx` 调 `pruneRemovedPortEdges` 删掉挂在该口上的边（React Flow 本就会隐藏它，这里只是不让存档里留一个空句柄）。

引擎路由（`conditionsBlock`，**顺序判定、命中即停**）：

```
无 code 且 data.paths 是数组：
  首个 conditionGroupsMatch 命中的 path → outputs['output-'+path.id] ?? defaultNext ?? null
  无一命中                        → outputs['output-none'] ?? defaultNext ?? null
否则（无 paths 键的旧节点 / 有 code）→ 旧布尔语义，outputs['true'] / ['false']
```

`conditions` 仍在 `EXCLUSIVE_BRANCH_BLOCKS`（命中即停、禁 fall-through，保留 `tests/branch-fallthrough.spec.ts` 语义）。engine.ts 的 out-edge 索引：

- 别名正则放宽为 `-(output-[A-Za-z0-9_]+|fallback|loop|end)$`，`output-p1` / `output-none` 因此被索引。
- `portEdges` 改为「句柄形如 `output-<token>` 即算端口」，所以全部 out-edge 都是口时 `defaultNext` 为 null——命中但未连线的 path 会停住，而不是掉进兄弟分支（`tests/conditions-path-routing.spec.ts` 覆盖）。

## 4. 存量迁移

`migrate.ts`：对**存档里**没有 `paths` 的 conditions 块（判定必须看 `node.data`，因为 `migrateNodeData` 已把 catalog 默认 `paths: []` 合并进来）：

- `paths = [{ id: 'p1', name: 'Path 1', conditions: <旧 conditions 组> }]`，并 `delete data.conditions`
- 边重映射：`output-1` → `${blockId}-output-p1`；`output-2` → `${blockId}-output-none`

## 5. 编辑 UI

- path 列表（改名 / 上下移 / 删除）留在表单内，Tailwind 语义 token 化（§2）；序号徽章 + 条件组数摘要，未配置的 path 明示「尚未配置条件」。
- fallback 口在列表下方以只读行呈现，避免用户以为输出只有上面几行。
- 点击某 path 的编辑 → 共享 `ui/Modal`（`size="lg"`）展示该 path 的 `ConditionBuilder`（复用，不重写条件树 UI），改动实时落库，关闭即完成。
- 删除 path 走 `confirmDialog`（说明其连线会一并删除、运行改走 fallback）。
- 画布节点描述行在无自定义 description 时显示「N 条路径」。

## 6. i18n

`workflow-editor/i18n.ts` 明确：**算子名称与表单标签保持英文**（与 Automa 一致），仅编辑器外壳本地化。path 名 / 句柄标签 / 条件树表单文案沿用该豁免（英文）；新增的弹窗与列表外壳文案（标题、空状态、删除确认、上下移、fallback 说明、节点路径数）进 `EDITOR_STRINGS` en/zh 双语。

## 7. 不在本次范围

- 面向模型的 operator tool schema 仍教 `code` / `conditions`（`SCHEMA_OMIT.conditions = ['paths']` 避免派生出 `string[]` 的假形状）；生成的图在加载时由迁移抬升成单 path + fallback。
- `element-exists` 与各 loop 块的两端口语义未改。

## 8. 门禁

`pnpm typecheck` / `pnpm test` / eslint+prettier（改动文件）/ `pnpm build`；`executors.ts`、`App.tsx`、`block-requirements.ts`、`i18n.ts` 为与并发改动共享的文件，只做定点编辑。`bench:debug` 见收尾自检。浏览器可见行为（画布多口渲染 + 弹窗）需真实加载扩展验证，未做则如实标注 BLOCKED。
