# 工作流分组、批量导出与统一开关组件 · Workflow groups, batch export and a shared switch

- 日期：2026-10-20
- 状态：设计（已实施于同批次）
- 范围：侧边栏工作流库（分组 + 批量导出）、跨端开关组件（`src/ui/Switch.tsx`）
- 不在范围：Runner 控制台的工作流分组、跨端（chrome.storage ↔ 磁盘）分组同步、工作流标签（tag）

---

## 1. 需求 · What was asked

1. 工作流支持勾选后**批量导出**。
2. 工作流支持**分组**：用户可以把多个工作流移入一个分组；分组可导出，导出时**连同组内工作流一起导出**。
3. 任务面板的启用/禁用不用勾选框，改用 **switch**；switch 组件**自己实现**；项目里所有「启用/禁用」都换成它。

口径由用户拍板（对话确认）：

- 替换范围 = **扩展 + 工作流编辑器 + Runner 控制台**（三个宿主共用一个实现）。
- 判定口径 = **只换「能力开关」**：多选、偏好项、条目勾选仍保留复选框。
- 分组形态 = **可折叠分组区块**（含「未分组」区）。

---

## 2. 现状取证 · Current state

### 2.1 工作流库

| 事实                                                                    | 锚点                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 唯一的工作流列表面是侧边栏「工作流」页                                  | `src/sidepanel/WorkflowsTab.tsx:174`（`WorkflowsTab`）                           |
| 勾选状态已存在，但只喂给批量删除                                        | `WorkflowsTab.tsx:545`（`selectedIds`）、`:565`（`removeSelected`）              |
| 逐个导出 = 直接把内存里的 `Workflow` 记录 `JSON.stringify` 成文件       | `WorkflowsTab.tsx:664-676`（`downloadJSON` / `exportWorkflow`）                  |
| 全量导出 = 一个 JSON 数组                                               | `WorkflowsTab.tsx:678-680`（`exportAll`）                                        |
| 导入接受「单个对象」或「对象数组」                                      | `WorkflowsTab.tsx:682-721`（`importFiles`）、`:1036`（`coerceImportedWorkflow`） |
| 存储只有一个 key，值是 `Workflow[]`                                     | `src/lib/workflow/storage.ts:30`（`KEY_WORKFLOWS`）、`:224`（`listWorkflows`）   |
| `Workflow` 上**已经有一个从未被写过、也没被读过**的 `folderId?: string` | `src/lib/workflow/types.ts:298`；白名单在 `src/lib/workflow/storage.ts:192`      |
| 没有任何分组注册表 / 标签 / 集合概念                                    | 全仓 grep `folderId` 仅 2 处命中；无 `workflowGroups` 之类 key                   |

### 2.2 开关控件

| 事实                                                                                         | 锚点                                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 任务列表的启用是原生 `<input type="checkbox">`                                               | `src/sidepanel/TasksTab.tsx:250-258`                                                                                |
| 任务编辑弹窗里还有一处启用勾选框                                                             | `src/sidepanel/TaskEditDialog.tsx:391-400`                                                                          |
| 设置页有接管/自愈/本地智能体/工具启停等勾选框                                                | `src/sidepanel/SettingsTab.tsx:1538,1553,1835,2070,2220`                                                            |
| 编辑器**已有一个** `Switch`，但它是 `input[type=checkbox]` + `.wf-switch` 皮肤，只服务编辑器 | `src/workflow-editor/blocks/shared/Field.tsx:215-240`；样式 `src/workflow-editor/editor.css:929-987`                |
| 全仓没有任何 `role="switch"` / `aria-checked`                                                | grep 命中 0                                                                                                         |
| Runner 控制台的定时启停是一个**文字按钮**（`启用`/`停用`）                                   | `server/web/src/pages/Schedules.tsx:39-58,98-103`                                                                   |
| Runner 控制台另有两处能力勾选框                                                              | `server/web/src/pages/Settings.tsx:232`（飞书机器人）、`server/web/src/pages/Workflows.tsx:616-620`（启用定时触发） |
| `server/web` 是独立 vite 应用，但**同样用 Tailwind v4 且镜像了同一套 `--bc-*` token**        | `server/vite.config.ts`、`server/web/src/styles.css:8`（`@import 'tailwindcss'`）                                   |

**关键结论**：不存在「同一能力的两套实现」问题——这次是把三个宿主里**形状不同**的启停控件收敛到一个组件。

---

## 3. 设计 · Design

### 3.1 开关组件 `src/ui/Switch.tsx`

放在 `src/ui/`（扩展侧已有 `FormDialog.tsx` / `toast.tsx` 等跨 surface 的 React 基建），因为它必须被
**三个宿主**共用，而 `src/lib/**` 按 AGENTS.md §5.7 是 chrome-free 的纯逻辑层，不放 React 组件。

**实现方式**：`<button role="switch" aria-checked>` + Tailwind 工具类，不依赖原生 checkbox 外观，
不写一次性 CSS class（AGENTS.md §2）。滑块位移用 `translate-x-*`，轨道底色用 token
（`bg-accent` / `bg-panel-2` / `border-border` / `bg-ink`），因此深浅色主题自动跟随。

**API**：

```ts
Switch({ checked, onChange, disabled?, label?, title?, 'aria-label'? })
```

- `label` 省略 → 只渲染轨道（图标按钮场景）。
- 文案用 `htmlFor` + `useId` 关联，**不把 button 包进 `<label>`**：label 包裹 button 时浏览器会把
  点击转发成 label 激活，在部分实现上会造成一次点击切两次。
- 键盘可达：button 天然响应 Enter / Space；`role="switch"` + `aria-checked` 供读屏识别。

**跨端共享**：`server/tsconfig.json` 的 `include` 增加 `../src/ui/Switch.tsx`（AGENTS.md §5.7 要求
新增跨包依赖显式加行）。`server/web` 的 Tailwind 主题已镜像同一套 token，所以同一个组件在两侧
视觉一致，不需要第二份实现。

**替换清单（只换能力开关，多选/偏好保持复选框）**：

| 宿主      | 位置                      | 语义                                                       |
| --------- | ------------------------- | ---------------------------------------------------------- |
| sidepanel | `TasksTab.tsx` 任务行     | 任务启用/禁用                                              |
| sidepanel | `TasksTab.tsx` 飞书机器人 | 机器人启用                                                 |
| sidepanel | `TaskEditDialog.tsx`      | 任务启用                                                   |
| sidepanel | `SettingsTab.tsx`         | 接管/自愈/本地智能体总开关/允许重载/单工具启停             |
| editor    | `blocks/shared/Field.tsx` | 块设置里的开关（改为复用共享组件，保留 `bt()` 文案本地化） |
| runner    | `Schedules.tsx`           | 定时任务启停（原来是文字按钮）                             |
| runner    | `Settings.tsx`            | 飞书机器人启用                                             |
| runner    | `Workflows.tsx`           | 启用定时触发                                               |

保留复选框：多选（工具/技能/星期/条目勾选）、偏好项（自动保存下载、显示密钥、飞书通知、
技能自动匹配、代理可委派、「保存后复跑」、AI 步骤预填）、条目保留（生成步骤 keep/drop）。

### 3.2 分组数据模型

复用 `Workflow.folderId`（**已存在且已在 `asWorkflow` 白名单里**），不新增第二套归属字段：

```ts
interface WorkflowGroup {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}
```

存放在**同一存储区**的新 key `workflowGroups`（`fileStorageArea()` → `workflowGroups.json`），
与 `workflows` 并列，`withKeyLock('workflowGroups')` 保护读改写。

**为什么不用数组型「组内 workflowId 列表」**：`folderId` 已经在工作流记录上，双向存一份会产生
两个事实源（哪一边先写决定归属）。归属只存在工作流一侧，分组表只存分组元数据。

**删除分组** = 删分组记录 + 把组内工作流的 `folderId` 清空（**不删工作流**）。

**移动工作流** = 改 `folderId` 字段，**不 bump `updatedAt`、不写 revision**：移动是归类动作，
不是内容编辑，不该在审计线里留一笔，也不该把列表顺序打乱。

### 3.3 导出格式

| 场景                 | 文件                      | 内容                                                                              |
| -------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| 逐个导出（现状）     | `<name>.json`             | 单个 `Workflow` 记录                                                              |
| 全量导出（现状）     | `workflows.json`          | `Workflow[]`                                                                      |
| **批量导出（新增）** | `workflows-selected.json` | 选中工作流的 `Workflow[]`（与全量导出同形，导入已支持数组）                       |
| **分组导出（新增）** | `<分组名>.json`           | `{ type: 'workflow-group', version: 1, name, exportedAt, workflows: Workflow[] }` |

**分组导出必须带包装对象**，否则组名会丢：现在的导入把数组的每个元素当工作流，裸数组导入后
只剩一堆散落的工作流，没有「它们曾同属一组」的信息。

**导入侧新增分支**：`importFiles` 识别 `type === 'workflow-group'` → 新建同名分组 → 逐个工作流
以新 id 落库并挂到该分组下（`coerceImportedWorkflow` 已经在重置 id/时间戳，组归属在其后补写）。
其余分支（单对象 / 数组）行为不变。

### 3.4 列表形态

```
┌ 我的工作流 ─────────────────────────── [全选] [🗑] [⬇] [⊞] [＋] ┐
│ ▾ 分组 A (3)                                     [⬇] [✎] [🗑]      │
│    ☐ 工作流 1   ...                                                  │
│    ☐ 工作流 2   ...                                                  │
│ ▸ 分组 B (1)                                     [⬇] [✎] [🗑]      │
│ ▾ 未分组 (2)                                                     │
│    ☐ 工作流 3   ...                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- 分组区块可折叠（默认展开），折叠状态只存在组件 state，不落盘。
- 分组头部动作是三个图标按钮（导出 / 改名 / 删除，带 aria-label 与 tooltip）——侧栏宽度只有 ~360px，
  三个文字按钮会换行成三行。
- 勾选后，区块头部出现 **批量导出** 与 **移动到分组** 两个批操作。
- 「移动到分组」弹出分组清单（含「移出分组 / 移到未分组」）。
- 分组名可直接在头部就地改名（点名称变输入框，Enter 提交，Esc 取消）。
- 「＋」新建分组（默认名 `分组 N`，新建后立即进入改名态）。

---

## 4. 影响面与风险 · Impact & risks

| 风险                                                                       | 处理                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 分组表与工作流表分两个 key 写入，可能出现「组没了但工作流还挂着 folderId」 | 渲染时把**未知 folderId 的工作流**归入「未分组」区；删除分组时同步清 `folderId`                                   |
| `folderId` 指向已删分组                                                    | 同上，视为未分组                                                                                                  |
| 换开关影响布局                                                             | 开关与原勾选框尺寸相近（轨道 36×20，滑块 16），替换后逐处目视检查；`task-item-head` 的 space-between 布局保持不变 |
| Runner 侧跨包 import                                                       | `server/tsconfig.json` 加白名单行；`server/vite.config.ts` 的 dev server 需要 `fs.allow` 放行仓库根               |
| 编辑器 `.wf-switch` 样式成为死代码                                         | 替换后删除 `editor.css` 的 `.wf-switch` 规则                                                                      |

---

## 5. 验收 · Acceptance

- [ ] 勾选若干工作流 → 批量导出的文件是这些工作流的 JSON 数组，且能被重新导入。
- [ ] 新建分组 → 勾选若干工作流 → 移动到分组 → 工作流出现在该分组区块内。
- [ ] 分组导出文件同时含组名与组内全部工作流；导入该文件后重建出同名分组。
- [ ] 删除分组后，原组内工作流仍在「未分组」区。
- [ ] 任务面板启用/禁用是 switch；设置页能力项、编辑器块开关、Runner 定时启停都是同一个 switch。
- [ ] 门禁：`pnpm typecheck` / `pnpm test` / `pnpm lint`（git ls-files）/ `pnpm format:check` / `pnpm build` /
      `pnpm server:typecheck` / `pnpm server:test`。
