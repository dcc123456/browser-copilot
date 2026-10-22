# 实施计划 · Workflow groups, batch export and shared switch

- 日期：2026-10-20
- 配套设计：`specs/2026-10-20-workflow-groups-and-switch-design.md`
- 一次一个主题：本轮只做「分组 + 批量导出」与「统一开关」两件事，不夹带其它重构。

---

## 步骤

### Step 1 — 共享开关组件

1. 新建 `src/ui/Switch.tsx`：`role="switch"` + Tailwind token 轨道/滑块，`useId` 关联文案。
2. 扩展侧替换：`TasksTab.tsx`（任务启用、飞书机器人）、`TaskEditDialog.tsx`（任务启用）、
   `SettingsTab.tsx`（接管、自愈、本地智能体总开关、允许重载、单工具启停）。
3. 编辑器：`blocks/shared/Field.tsx` 的 `Switch` 改为复用共享组件，保留 `bt()` 本地化；
   删除 `editor.css` 里已无引用的 `.wf-switch` 规则。
4. Runner：`server/web/src/pages/Schedules.tsx`（启停按钮）、`Settings.tsx`（飞书机器人）、
   `Workflows.tsx`（启用定时触发）改用共享组件；`server/tsconfig.json` 白名单加
   `../src/ui/Switch.tsx`；`server/vite.config.ts` 放行 dev server 的 fs 范围。

### Step 2 — 分组存储与后台命令

1. `src/lib/workflow/groups.ts`：`WorkflowGroup` 类型、`asWorkflowGroup` 归一化、
   分组增删改查、导出/导入纯函数。
2. `src/lib/workflow/storage.ts`：`setWorkflowGroup(ids, groupId)`（只改 `folderId`，
   不动 `updatedAt` / `revision`）。
3. `src/lib/messages.ts`：新增 `workflowGroups.list` / `workflowGroups.save` / `workflowGroups.delete` /
   `workflows.assignGroup` 命令与结果。
4. `src/background/index.ts`：实现上述命令。

### Step 3 — 侧边栏分组 UI

1. `WorkflowsTab.tsx`：列表按分组区块渲染（可折叠）+「未分组」区。
2. 分组头部：导出 / 改名 / 删除；顶栏「＋」新建分组。
3. 勾选后出现「批量导出」「移动到分组」批操作。
4. 导入侧识别分组导出文件，重建分组。
5. i18n：`src/lib/i18n.ts` 两侧同时补 key（`Messages` 是封闭类型，漏一侧编译不过）。

### Step 4 — 测试与门禁

1. `tests/`：分组归一化/导出/导入纯函数测试；`Switch` 渲染与 `aria-checked` 测试。
2. `pnpm typecheck` / `pnpm test` / `pnpm lint`（对 `git ls-files` 跑，见项目记忆里的基线约定）/
   `pnpm format:check` / `pnpm build` / `pnpm server:typecheck` / `pnpm server:test`。
3. 浏览器可见行为（分组区块、开关交互）以 `pnpm selftest` 或人工加载 unpacked 验证为准；
   拿不到证据就标 BLOCKED。

---

## 不做的事

- 不给工作流加 tag / 集合 / 多维分类。
- 不做跨端（扩展 ↔ Runner）分组同步：Runner 读 `workflows.json`，`folderId` 对它无害。
- 不动多选、偏好类复选框。
- 不重命名 `folderId`：它是既有字段，复用比新增 `groupId` 更省事（白名单已就位）。

---

## 2026-10-21 增量 · 分组交互修正

设计见配套文档 §6。只改侧边栏工作流库的交互与分组顺序持久化。

### Step A — 排序数据通路

1. `src/lib/workflow/groups.ts`：`listWorkflowGroups` 去掉按 `createdAt` 排序（数组顺序即顺序）；
   新增纯函数 `orderWorkflowGroups` 与落盘函数 `reorderWorkflowGroups`（`withKeyLock`）。
2. `src/lib/messages.ts`：新增 `workflowGroups.reorder`（ids → groups）命令与结果。
3. `src/background/index.ts`：实现该命令，委托 `reorderWorkflowGroups`。

### Step B — 侧边栏交互

1. `WorkflowsTab.tsx`：默认只展开第一个区块（首次 load 应用一次，轮询不重置）。
2. 分组名称按钮改为折叠/展开；铅笔保留改名。
3. 抽出 `GroupMoveMenu`，批量工具栏与每张工作流卡片共用。
4. 分组头部加 `GripVertical` 拖动把手；section 作为 drop 目标，乐观重排 + 失败回滚。
5. i18n：`workflowsMoveToGroupSingle`、`workflowsGroupReorder` 双侧补齐。

### Step C — 测试与门禁

1. `tests/workflow-groups.spec.ts`：`orderWorkflowGroups` 三种情形。
2. `tests/workflows-tab-groups.spec.tsx`：默认展开、未分组开合、名称/铅笔语义、卡片移动、
   拖动排序；测试结束卸载 root 以清掉 5s 轮询定时器。
3. 门禁同 Step 4；浏览器可见行为拿不到证据则标 BLOCKED。
