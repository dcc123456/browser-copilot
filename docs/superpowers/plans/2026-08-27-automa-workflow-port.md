# Automa 工作流编辑器移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Automa 的工作流编辑功能（块目录/图标/画布布局/侧边栏/元素吸取器/专用表单/录制/引擎）完整移植到 browser-copilot。

**Architecture:** 编辑器 UI 用 React + @xyflow/react 原生重写（Automa Vue SFC 作为视觉/行为规格）；块目录用 Node 脚本从 `automa/src/utils/shared.js` 机械提取生成 TS；页面世界脚本（picker/recorder）用 vanilla TS + Shadow DOM，经 `chrome.scripting.executeScript` 按需注入；消息经 background 桥接。设计依据：`docs/superpowers/specs/2026-08-27-automa-workflow-port-design.md`。

**Tech Stack:** React 19, @xyflow/react 12, TypeScript 5.9, Vite 7, remixicon (新增), vitest, chrome MV3 (`chrome.scripting`/`windows`/`tabs`/`webNavigation`/`action`)。

**Automa 源路径前缀（下文简称 A:）：** `D:\works\deep-seek-workspace\automa\src\`
**目标路径前缀（简称 B:）：** `D:\works\deep-seek-workspace\browser-copilot\src\`

**通用约定：**
- 每个 Task 结束跑 `pnpm typecheck`（在 browser-copilot 目录），通过后 commit；commit 信息用 `feat(workflow): ...` / `feat(editor): ...` / `feat(picker): ...` / `feat(record): ...`。
- 测试用 vitest（`pnpm test`），新测试放 `tests/`（参照现有 tests 目录结构）。
- 云块 id 黑名单常量：`['ai-workflow','block-package','google-sheets','google-sheets-drive','google-drive']`。
- Automa 块的 `data` 默认值是节点 data 的事实源；表单组件用 `v-model:data` 等价的受控 props（`data` + `onChange(patch)`）。

---

## 文件结构（新建/修改）

```
B:lib/workflow/blocks/
  types.ts          # BlockCatalogEntry / BlockCategory(automa 7 类) / CloudBlock 类型
  catalog.ts        # 【生成】~55 块完整定义（脚本从 shared.js 提取）
  catalog.gen.mjs   # 生成脚本（Node，读 automa shared.js → catalog.ts）
  cloud-blocks.ts   # 云块黑名单 + isCloudBlock()
  icons.tsx         # <RemixIcon name size/> 组件（remixicon sprite）+ CustomPathIcon
  palette.ts        # PALETTE_BLOCKS（过滤 cloud）、BLOCK_BY_ID、CATEGORIES（配色亮/暗）
B:lib/workflow/
  migrate.ts        # 旧工作流/旧节点 data → Automa 形态；Automa JSON 导入转换
  types.ts          # 修改：WorkflowNode.data 放宽为 Automa 形态（加 selector/findBy/description...）
B:workflow-editor/
  App.tsx           # 重写：popup 编辑器壳（三栏 + 工具条 + 主题）
  theme.css         # 亮/暗 CSS 变量（:root + prefers-color-scheme）
  flow/
    FlowCanvas.tsx      # ReactFlow 容器、连线、drop、快捷键、viewport 持久化
    BlockNode.tsx       # 通用节点（BlockBasic 等价）：图标块+名称+描述+Handle
    BranchNode.tsx      # conditions/element-exists 多输出节点
    SpecialNodes.tsx    # Note/Delay/RepeatTask/LoopBreakpoint/Group 节点
    CustomEdge.tsx      # smoothstep + 箭头 + 选中/邻接高亮 + updater
    MiniMap.tsx         # 分类色 minimap
  sidebar/
    Sidebar.tsx         # 可折叠 + 拖拽调宽容器
    WorkflowDetails.tsx # 工作流详情卡（名称/描述/触发器/设置/全局数据）
    BlockEditForm.tsx   # 节点表单壳（返回箭头+块名+文档链接 + 动态 Edit 组件）
    BlockPalette.tsx    # 块面板（分类折叠 + 2 列网格卡片 + 图钉）
    EditorLogs.tsx      # 运行日志标签页
  toolbar/
    TopToolbar.tsx      # 浮动工具条（侧边栏切换/Editor-Logs/保存/运行/录制/设置）
    SearchBlocks.tsx    # 左下画布节点搜索定位
    ZoomControls.tsx    # 右下适应视图/缩放
  blocks/             # ~55 个块表单（Edit*.tsx），按批次
    shared/
      InteractionBase.tsx  # 描述/findBy/选择器+吸取+验证/selector options
      ElSelectorActions.tsx# 吸取(riFocus3Line)/验证(riCheckDoubleLine) 按钮 + picker 消息
      Field.tsx           # Input/Textarea(autoresize)/Select/Checkbox/Switch/Expand/Tooltip
      CodeField.tsx       # JS/JSON 代码字段（升级现有 CodeInput）
      BlockSettingsModal.tsx # 齿轮弹窗：description/disableBlock/timeout/onError
      Autocomplete.tsx    # {{变量}} 自动补全
      ConditionBuilder.tsx# 条件构建器（A:components/newtab/shared/SharedConditionBuilder/）
    EditForms.ts          # editComponent 名 → React 组件映射表
    (EditTrigger.tsx, EditForms.tsx[forms块], EditNewTab.tsx, ... 逐块)
B:inpage/
  element-picker/
    index.ts          # startPicker() 注入入口（Shadow DOM 容器 + 卡片挂载）
    card.ts           # 悬浮卡片 UI（vanilla DOM，移植 elementSelector/App.vue）
    build-selector.ts # 选择器生成（id/class/tag/attr 开关 + xpath），纯函数可单测
    highlight.ts      # 悬停高亮/遮罩/锁定/父子导航
    frame-bridge.ts   # iframe postMessage 通信（移植 selectorFrameContext.js）
    styles.ts         # Shadow DOM 内样式字符串（亮/暗）
  record/
    index.ts          # startRecorder() 注入入口 + 浮动控制条
    record-events.ts  # click/change/input/keydown/scroll 监听 → flows（移植 recordEvents.js）
B:background/
  picker-bridge.ts    # picker:start/verify/result 消息：注入 + 转发回请求窗口
  record-controller.ts# record:start/stop：storage 标志、badge、tabs/webNavigation 监听、注入
  workflow-engine/    # 引擎对齐（见 Task 群 E）
B:sidepanel/WorkflowsTab.tsx  # 修改：windows.create popup 打开编辑器；「● 录制」按钮
tests/
  catalog.test.ts         # catalog 完整性 + 云块过滤 + 与 Automa id 快照对比
  build-selector.test.ts  # 选择器算法（jsdom）
  record-convert.test.ts  # flows → 节点/边图
  migrate.test.ts         # 旧格式迁移
  engine-loops.test.ts    # 循环/分支/onError
scripts/
  sync-automa-catalog.mjs # catalog 生成脚本的 package.json 入口包装
```

---

## P1 — 基础：catalog / 图标 / 主题 / popup 壳

### Task 1: 安装 remixicon 依赖

**Files:**
- Modify: `B:package.json`

- [ ] **Step 1:** 在 browser-copilot 目录执行 `pnpm add remixicon`。
- [ ] **Step 2:** 验证 `node_modules/remixicon` 存在（含 `fonts/remixicon.css`、`icons/` 单 SVG）。
- [ ] **Step 3:** `pnpm typecheck` 通过后 commit：`chore: add remixicon dependency`。

### Task 2: catalog 生成脚本 + 首次生成

**Files:**
- Create: `B:src/lib/workflow/blocks/catalog.gen.mjs`
- Create: `B:src/lib/workflow/blocks/types.ts`
- Create: `B:src/lib/workflow/blocks/cloud-blocks.ts`
- Generate: `B:src/lib/workflow/blocks/catalog.ts`
- Reference: `A:utils/shared.js`（tasks 1–1505 行、categories 1506–1544）

- [ ] **Step 1: 写 types.ts**

```ts
// src/lib/workflow/blocks/types.ts
export type AutomaCategory =
  | 'interaction' | 'browser' | 'general'
  | 'onlineServices' | 'data' | 'conditions' | 'package'

export type BlockComponent =
  | 'BlockBasic' | 'BlockBasicWithFallback' | 'BlockConditions'
  | 'BlockDelay' | 'BlockElementExists' | 'BlockGroup' | 'BlockGroup2'
  | 'BlockLoopBreakpoint' | 'BlockNote' | 'BlockPackage' | 'BlockRepeatTask'

export interface BlockCatalogEntry {
  id: string
  name: string
  description: string
  icon: string                       // RemixIcon 名 'riXxxLine' | 'path:...' | 'http...'
  category: AutomaCategory
  component: BlockComponent
  editComponent?: string             // 'EditForms' 等；disableEdit 时无
  inputs: number
  outputs: number
  allowedInputs?: boolean
  maxConnection?: number
  disableEdit?: boolean
  tag?: string
  refDataKeys?: string[]
  cloud?: boolean
  data: Record<string, unknown>
}
```

- [ ] **Step 2: 写 cloud-blocks.ts**

```ts
export const CLOUD_BLOCK_IDS = [
  'ai-workflow', 'block-package', 'google-sheets',
  'google-sheets-drive', 'google-drive',
] as const
export const isCloudBlock = (id: string): boolean =>
  (CLOUD_BLOCK_IDS as readonly string[]).includes(id)
```

- [ ] **Step 3: 写 catalog.gen.mjs**

脚本逻辑（Node ESM，无第三方依赖）：
1. 读 `D:\works\deep-seek-workspace\automa\src\utils\shared.js` 全文。
2. 截取从 `export const tasks = {` 到 `export const categories` 之前的文本；把 `export const tasks =` 替换为 `const tasks =`，追加 `export { tasks }`，写入临时 `.mjs` 文件（os.tmpdir），动态 `import()` 后取 `tasks`。
3. 同样方式提取 `categories` 对象（截取 `export const categories = {` 到 `export const tagColors`）。
4. 对 tasks 每个 key：保留字段 name/description/icon/component/editComponent/category/inputs/outputs/allowedInputs/maxConnection/disableEdit/tag/refDataKeys/data；`cloud: isCloudBlock(key)`；输出顺序按 shared.js 原顺序。
5. 生成 `catalog.ts`：文件头注释「AUTO-GENERATED by catalog.gen.mjs — do not edit by hand」，`import type { BlockCatalogEntry, AutomaCategory } from './types'`，`export const CATEGORY_META: Record<AutomaCategory, {name:string; light:{bg:string;border:string}; dark:{...}}> = {...}`（从 categories 对象的 name/color/border 映射；Tailwind 类名 `bg-green-200` 等转换为 hex：green-200=#bbf7d0, orange-200=#fed7aa, yellow-200=#fef08a, red-200=#fecaca, lime-200=#d9f99d, blue-200=#bfdbfe, cyan-200=#a5f3fc；300 档：#86efac/#fdba74/#fde047/#fca5a5/#bef264/#93c5fd/#67e8f9），`export const BLOCK_CATALOG: BlockCatalogEntry[] = <JSON>`。
6. 控制台打印：总块数、云块数、各分类计数、缺 editComponent 且非 disableEdit 的块列表（人工核对）。

- [ ] **Step 4: 运行生成**

`node src/lib/workflow/blocks/catalog.gen.mjs`（workdir=browser-copilot）。检查输出：本地块应 ~55 个；interaction/browser/general/data/conditions 分类都有块；onlineServices/package 全部为 cloud。

- [ ] **Step 5: typecheck + commit**

`pnpm typeconfig`→`pnpm typecheck` 通过；commit `feat(workflow): generate block catalog from Automa shared.js`。

### Task 3: catalog 完整性测试

**Files:**
- Create: `B:tests/catalog.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from 'vitest'
import { BLOCK_CATALOG, CATEGORY_META } from '../src/lib/workflow/blocks/catalog'
import { CLOUD_BLOCK_IDS, isCloudBlock } from '../src/lib/workflow/blocks/cloud-blocks'

describe('block catalog', () => {
  it('every entry has id/name/icon/category/component/data', () => {
    for (const b of BLOCK_CATALOG) {
      expect(b.id).toBeTruthy()
      expect(b.name).toBeTruthy()
      expect(b.icon).toBeTruthy()
      expect(CATEGORY_META[b.category]).toBeTruthy()
      expect(b.component).toBeTruthy()
      expect(b.data && typeof b.data === 'object').toBe(true)
    }
  })
  it('ids are unique', () => {
    const ids = BLOCK_CATALOG.map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('cloud blocks are flagged and every cloud id exists in source data', () => {
    for (const id of CLOUD_BLOCK_IDS) {
      const entry = BLOCK_CATALOG.find(b => b.id === id)
      expect(entry?.cloud).toBe(true)
    }
    for (const b of BLOCK_CATALOG) {
      expect(b.cloud).toBe(isCloudBlock(b.id))
    }
  })
  it('local block count is at least 50', () => {
    expect(BLOCK_CATALOG.filter(b => !b.cloud).length).toBeGreaterThanOrEqual(50)
  })
  it('every editable local block references an editComponent', () => {
    for (const b of BLOCK_CATALOG) {
      if (b.cloud || b.disableEdit) continue
      expect(b.editComponent, `block ${b.id} missing editComponent`).toBeTruthy()
    }
  })
})
```

- [ ] **Step 2:** `pnpm test -- catalog` 全绿；commit `test(workflow): catalog completeness tests`。

### Task 4: RemixIcon 组件 + palette 选择器

**Files:**
- Create: `B:src/lib/workflow/blocks/icons.tsx`
- Create: `B:src/lib/workflow/blocks/palette.ts`

- [ ] **Step 1: icons.tsx**

用 remixicon 字体方案（最小可靠）：
- `import 'remixicon/fonts/remixicon.css'`（Vite 处理字体）。
- `RemixIcon({ name, size=20, className })`：name 形如 `riFlashlightLine` → `<i class="ri-flashlight-line" style={{fontSize:size}}>`（驼峰转 kebab：`riFlashlightLine` → `ri-flashlight-line`，正则 `[A-Z]` → `-$&` 小写）。
- `CustomPathIcon({ path, size })`：`<svg viewBox="0 0 24 24" width={size} height={size}><path d={path}/></svg>`（path 来自 `icon: 'path:M...'`，取冒号后）。
- `BlockIcon({ icon, size })`：`http` 开头 → `<img>`；`path:` → CustomPathIcon；否则 RemixIcon。

- [ ] **Step 2: palette.ts**

```ts
import { BLOCK_CATALOG, CATEGORY_META } from './catalog'
import type { BlockCatalogEntry, AutomaCategory } from './types'

export const PALETTE_BLOCKS: BlockCatalogEntry[] =
  BLOCK_CATALOG.filter(b => !b.cloud)
export const BLOCK_BY_ID: Map<string, BlockCatalogEntry> =
  new Map(PALETTE_BLOCKS.map(b => [b.id, b]))
export const PALETTE_CATEGORIES: AutomaCategory[] =
  [...new Set(PALETTE_BLOCKS.map(b => b.category))]
    // 展示顺序对齐 Automa
    .sort((a, b) =>
      ['general','browser','interaction','data','conditions','onlineServices','package']
        .indexOf(a) - ['general','browser','interaction','data','conditions','onlineServices','package'].indexOf(b))
export { CATEGORY_META }
```

- [ ] **Step 3:** 在 `B:src/workflow-editor/main.tsx` 或 App 入口确认 CSS import 链可达（remixicon.css 在 icons.tsx 内 import 即可）。
- [ ] **Step 4:** typecheck；临时在编辑器页渲染一个 `<BlockIcon icon="riFlashlightLine"/>` 验证字体加载（dev 跑一次目测后移除）；commit `feat(editor): RemixIcon component and palette selectors`。

### Task 5: 主题 CSS 变量（亮/暗跟随浏览器）

**Files:**
- Create: `B:src/workflow-editor/theme.css`
- Reference: Automa Tailwind 灰阶（gray-50 #f9fafb … gray-900 #111827）、accent 色 #6366f1(indigo-500)

- [ ] **Step 1:** 定义变量：`:root{--bc-bg:#fff;--bc-bg-soft:#f9fafb;--bc-bg-input:#f3f4f6;--bc-border:#e5e7eb;--bc-text:#111827;--bc-text-dim:#6b7280;--bc-accent:#6366f1;--bc-danger:#ef4444;...}` + `@media (prefers-color-scheme: dark){:root{--bc-bg:#1f2937;--bc-bg-soft:#111827;--bc-bg-input:#374151;--bc-border:#374151;--bc-text:#f9fafb;--bc-text-dim:#d1d5db;...}}`。分类色变量 `--cat-interaction` 等亮/暗双值（取 Task 2 的 hex）。
- [ ] **Step 2:** theme.css 在 `workflow-editor/main.tsx` import。
- [ ] **Step 3:** typecheck/build；commit `feat(editor): light/dark theme variables following prefers-color-scheme`。

### Task 6: popup 窗口打开方式 + WorkflowsTab 录制入口

**Files:**
- Modify: `B:src/sidepanel/WorkflowsTab.tsx`（openEditor 改 windows.create；加「● 录制」按钮）
- Modify: `B:src/lib/messages.ts`（加 `record:start`/`record:stop`/`picker:*` 消息类型——先占位类型，后续 Task 实现）

- [ ] **Step 1:** openEditor 改为 `chrome.windows.create({ type:'popup', url, width:1280, height:860 })`。
- [ ] **Step 2:** section-actions 加「● 录制」按钮 → `sendCommand({type:'record:start'})`（background 侧 Task 群 D 实现；此时先有类型与按钮，后台未实现时 catch 提示）。
- [ ] **Step 3:** typecheck；commit `feat(editor): open editor in standalone popup window; add record entry`。

### Task 7: 数据模型迁移层

**Files:**
- Create: `B:src/lib/workflow/migrate.ts`
- Create: `B:tests/migrate.test.ts`
- Modify: `B:src/lib/workflow/types.ts`（WorkflowNode.data 加 Automa 字段注释/索引签名兼容）
- Modify: `B:src/lib/workflow/storage.ts`（加载时过 migrateWorkflow）

- [ ] **Step 1:** migrate.ts 导出：
  - `OLD_ID_TO_AUTOMA: Record<string,string>`：click→event-click, fill→forms（type:text-field 由执行器兼容）, select-option→forms, scroll→element-scroll, hover→hover-element, condition→conditions, open-url→new-tab?（不改，open-url 保留为 browser-copilot 扩展块，加进 catalog 作为 extra 块）等——映射表以引擎 EXECUTORS key 与 catalog id 的实际差集为准（实现时打印两边 id 列表核对）。
  - `migrateNodeData(blockId, data)`：旧 `{blockId, values:{cssSelector,value}}` → `{ ...defaults, selector: values.cssSelector ?? values.selector, ... }` 平铺；新格式原样返回。
  - `migrateWorkflow(wf)`：遍历 drawflow.nodes，映射 id + data；返回新对象（不 mutate）。
  - `fromAutomaExport(json)`：识别 `json.drawflow?.Home?.data`（Automa 格式）→ 本项目 `{nodes:[{id,label,position,data:{...node.data, blockId: node.name}}], edges: Object.values 连线}`。Automa 节点结构：`{id, name:blockId, data, positionX, positionY, inputs:{input-1:{conn:{node,output}}}, outputs:{...}}`。
- [ ] **Step 2:** 测试：旧格式 fixture（cssSelector/values）→ 新字段；Automa 导出 fixture（构造最小 drawflow.Home.data）→ nodes/edges；云块节点保留 id 但引擎报错（迁移层不删）。
- [ ] **Step 3:** storage.ts 的 list/get 路径对每个 workflow 调 migrateWorkflow（惰性，不立即回写）。
- [ ] **Step 4:** `pnpm test -- migrate` 绿；typecheck；commit `feat(workflow): migrate legacy node data and import Automa export JSON`。

**P1 完成标志：** `pnpm typecheck && pnpm test && pnpm build` 全绿；catalog 含 ~55 本地块；编辑器仍可打开（popup）。

---

## P2 — 画布复刻（React Flow 布局对齐 Automa）

参考：`A:newtab/pages/workflows/[id].vue`、`A:components/newtab/workflow/WorkflowEditor.vue`、`A:components/block/BlockBasic.vue`、`BlockBase.vue`、`BlockConditions.vue`、`BlockElementExists.vue`、`BlockNote.vue`、`BlockDelay.vue`、`BlockRepeatTask.vue`、`BlockLoopBreakpoint.vue`、`editor/EditorCustomEdge.vue`、`editor/EditorSearchBlocks.vue`、`WorkflowBlockList.vue`、`WorkflowDetailsCard.vue`、`WorkflowEditBlock.vue`。

### Task 8: BlockNode 通用节点组件
- Create `flow/BlockNode.tsx`：左 target Handle（trigger/无 inputs 块不渲染；id=`${id}-input-1`）、右 source Handle（id=`${id}-output-1`）；内容 = 分类色圆角图标块（`background:var(--cat-*)`，p-2 rounded-lg）+ `<BlockIcon>` + 名称粗体行 + 描述灰色行（data.description || 选择器/URL 摘要）；selected 描边；disableBlock 图标块灰化 + 节点降透明度；校验错误（selector 类块空选择器）显示红色 riAlertLine。
- 分支输出：outputs>1 时渲染多个右侧 Handle（output-1/output-2…，纵向均分），conditions 标 true/false、element-exists 标 exists/notExists（标签用 Automa i18n 英文：true/false、exists/not exists、loop/end 等，从 A:locales/en/blocks.json 取词）。
- onError fallback：data.onError?.enable && toDo==='fallback' → 额外底部 source Handle（`output-fallback`）+ fallback 角标。
- 双击 → onEdit(node)；齿轮按钮 → onSettings(node)（BlockSettingsModal 在 P4）。
- Test：节点快照/渲染测试（@testing-library 若已配置，否则纯函数抽 nodeAppearance(block,data) 单测）。
- Commit `feat(editor): Automa-style block node with category icon and handles`。

### Task 9: CustomEdge + 连线规则
- Create `flow/CustomEdge.tsx`：BaseHandle smoothstep 贝塞尔；markerEnd 箭头（MarkerType.ArrowClosed，受 settings.arrow 开关）；选中/邻接高亮 class（connected-edges：选中节点时其入/出边高亮，对齐 WorkflowEditor.watch(getSelectedNodes)）；边中点可拖拽重连（React Flow edge updater，对齐 onEdgeUpdate，禁止 output→output）。
- 连线校验：target 单输入（maxConnection，Automa allowedInputs）；trigger 无输入；禁自连。
- onConnect：edge class `source-${sourceHandle} target-${targetHandle}`、type smoothstep。
- Commit `feat(editor): custom edge with arrow, highlight, and updater`。

### Task 10: FlowCanvas 容器
- Create `flow/FlowCanvas.tsx`：ReactFlow 配置对齐 WorkflowEditor（deleteKeyCode Delete、multiSelectionKeyCode Ctrl/Meta、minZoom/maxZoom、snapToGrid 设置项、defaultEdgeOptions smoothstep+arrow）；Background 点阵；onDrop 从 BlockPalette 拖入（dataTransfer 存 block id，screenToFlowPosition 定位，新节点 data = `structuredClone(catalog.data)` + description:''，对齐 A:utils/editor/DroppedNode.js）；MiniMap（节点 className 用分类色）；viewport 持久化到 drawflow.position/zoom（现有逻辑保留）。
- 节点方向：所有 Handle 左/右（Position.Left/Right）。
- Commit `feat(editor): flow canvas with drop, minimap, viewport persistence`。

### Task 11: Sidebar 容器（折叠 + 拖拽调宽）
- Create `sidebar/Sidebar.tsx`：宽度 state（默认 320，min 240 max 560），左缘 drag handle（mousedown + mousemove 调宽，对齐 [id].vue startDrag）；折叠态（riSideBarLine/Fill 切换）；三态内容：details / edit(blockId) / palette / logs。
- Commit `feat(editor): resizable collapsible sidebar`。

### Task 12: WorkflowDetails 工作流详情卡
- Create `sidebar/WorkflowDetails.tsx`：移植 WorkflowDetailsCard.vue——图标选择（RemixIcon 名输入/选择）、名称、描述；触发器区（类型选择 + 对应 Trigger 表单：manual/interval/cron/date/specific-day/context-menu/shortcut/visit-web/element-change/on-startup，表单字段对齐 A:edit/EditTrigger.vue + Trigger/*.vue，本期触发器表单可先用简化字段，完整在 Task 群 C 补）；全局数据（WorkflowGlobalData：JSON 键值）；设置区（SettingsGeneral：debugMode/saveLog/notification/snapToGrid/arrow/maxZoom）。
- Commit `feat(editor): workflow details sidebar card`。

### Task 13: BlockEditForm 表单壳 + BlockPalette 块面板
- Create `sidebar/BlockEditForm.tsx`：sticky 顶栏（返回箭头 riArrowLeftLine → 回 details、块名、文档链接 `https://docs.extension.automa.site/blocks/{id}.html`）；下方按 block.editComponent 查 EditForms 映射渲染（P4 前用 fallback 通用表单：列出 data 所有键的 Input/Checkbox/Select 自动表单，保证可编辑）；云块残留显示「该块需要云服务，不受支持」。
- Create `sidebar/BlockPalette.tsx`：移植 WorkflowBlockList——分类折叠组（彩色圆点 var(--cat-*) + 分类名 + riAddLine/riSubtractLine）；2 列网格卡片（BlockIcon 24px + 英文名 + hover 显示文档 riInformationLine + 图钉 riPushpin2Line/Fill；图钉存 localStorage 置顶）；卡片 draggable，dragstart setData('application/workflow-block', id)；空分类不渲染。
- Commit `feat(editor): block edit form shell and block palette`。

### Task 14: TopToolbar / SearchBlocks / ZoomControls
- Create `toolbar/TopToolbar.tsx`：浮动条（pointer-events-none 容器 + 子元素 auto）；左：侧边栏切换、Editor/Logs tabs；右：保存（riSaveLine + 未保存圆点）、运行（riPlayLine）、停止、录制开关（● rec 红色态）、设置。逻辑复用现有 handleSave/handleRun。
- Create `toolbar/SearchBlocks.tsx`：移植 EditorSearchBlocks——riSearch2Line 按钮展开输入框；搜索**画布上节点**（name/description/id）；选中项居中定位（setViewport 对齐）+ ring 高亮；快捷键（Ctrl+Shift+F 或对齐 Automa shortcut 配置）。
- Create `toolbar/ZoomControls.tsx`：riFullscreenLine fitView、riSubtractLine/riAddLine 缩放分段控件（白底圆角）。
- Create `sidebar/EditorLogs.tsx`：Logs tab 内容（读 run log，块执行状态列表，对接现有 task runs 数据）。
- Commit `feat(editor): top toolbar, canvas search, zoom controls, logs tab`。

### Task 15: App.tsx 重写组装 + 快捷键
- 重写 `workflow-editor/App.tsx`：组合 TopToolbar/FlowCanvas/Sidebar；状态（nodes/edges/selectedNode/sidebar 态/tab/workflow meta/settings）；保存格式对齐迁移后模型（node.data 直接存 Automa data + blockId）；加载走 migrateWorkflow。
- 快捷键（原生 keydown，对齐 EditorCommands）：Ctrl+S 保存、Ctrl+Enter 运行、Ctrl+Shift+F 搜索、Ctrl+B 切侧边栏、Delete 删除（ReactFlow 自带）。
- `pnpm build` 后浏览器目测：布局与 Automa 编辑器逐项对照（节点方向/工具条/侧边栏/面板/缩放/minimap）。
- Commit `feat(editor): assemble Automa-style editor layout`。

**P2 完成标志：** 编辑器布局与 Automa 视觉一致（亮色 + 暗色）；可拖块、连线、双击开表单壳、保存/运行、搜索定位、图钉。

---

## P3 — 元素吸取器

参考：`A:content/elementSelector/`（App.vue 452 行、generateElementsSelector.js、listSelector.js、selectorFrameContext.js、getSelectorOptions.js、index.js、main.js）、`A:components/newtab/shared/SharedElSelectorActions.vue`、`A:newtab/utils/elementSelector.js`。

### Task 16: 选择器生成纯函数 + 单测
- Create `B:inpage/element-picker/build-selector.ts`：移植 generateElementsSelector.js + getSelectorOptions.js——选项 `{idName, tagName, className, attr, attrNames, nthChild}`；输出 CSS 选择器字符串；`buildXPath(el)`；`countMatches(selector, root)`（CSS: querySelectorAll；xpath: document.evaluate）。
- Create `tests/build-selector.test.ts`：jsdom 构造 DOM（id 元素/class 元素/重复 li/嵌套/div+属性），断言：开 id 时输出 #id；关 id 开 class 输出唯一 class；全关时 tag+nth-child；开关组合稳定；xpath 可 evaluate 命中；countMatches 正确。
- Commit `feat(picker): selector generator with options and xpath`。

### Task 17: Shadow DOM 悬浮卡片 + 高亮交互
- Create `inpage/element-picker/styles.ts`（卡片样式字符串，亮/暗用 #fff/#1f2937 等，z-index 2147483646）、`highlight.ts`（mouseover 高亮：outline 2px solid #6366f1 + 标签；click 锁定；Esc/关闭取消；眼睛切换遮罩；父子导航 up/down；卡片可拖拽）、`card.ts`（vanilla DOM 构建卡片：标题 Browser Copilot、拖拽手柄 riDragMoveLine（内联 SVG，不依赖字体——content script 无构建字体注入，用内联 SVG path）、选择器显示行、CSS/XPath 切换、设置开关列表、父/子按钮、匹配数、Select Element 按钮；列表模式 listSelector 移植：多命中时列出条目可点选高亮）。
- Create `inpage/element-picker/index.ts`：`startPicker({pickerId, mode:'select'|'verify', selector?, multiple?})`——建容器 div#bc-element-picker、attachShadow、挂卡片；锁定确认后 `chrome.runtime.sendMessage({type:'picker:result', pickerId, selector})` 并移除容器；verify 模式直接 countMatches 返回数量。
  - 注意：注入函数经 executeScript func 序列化，模块内不要闭包引用外部变量（参照 kernel.ts 模式）；DOM 辅助函数全部同文件或自包含。
- Commit `feat(picker): shadow-DOM picker card with highlight and lock`。

### Task 18: iframe 跨框架支持
- Create `inpage/element-picker/frame-bridge.ts`：子框架注入精简脚本（outline 高亮 + click 后 postMessage 给 top：{elPath 信息}）；主框架 picker 监听 message，跨框架高亮/选择（移植 selectorFrameContext.js）；executeScript allFrames 注入，主框架跑完整 picker、子框架跑 frame 脚本（用 frameId 区分：注入时 args 带 isTopFrame 标志，或检测 window.top===window.self）。
- Commit `feat(picker): cross-iframe element selection`。

### Task 19: background picker 桥 + 编辑器按钮接线
- Create `background/picker-bridge.ts`：
  - `picker:start`：记录 `{pickerId → requester: {tabId|windowId, sender}}`；`chrome.tabs.query({active:true,lastFocusedWindow:true})` 取活动 tab；`chrome.scripting.executeScript({target:{tabId, allFrames:true}, func: startPicker, args:[{pickerId, mode:'select'}]})`。
  - `picker:verify`：同上 mode:'verify' + selector 参数。
  - 页面 `picker:result` 消息：查 requester，转发（若 requester 是编辑器窗口/tab，用 chrome.tabs.sendMessage 或 runtime 消息带 target；编辑器窗口也是扩展页，监听 chrome.runtime.onMessage 按 pickerId 匹配）。
- Create `workflow-editor/blocks/shared/ElSelectorActions.tsx`：两个按钮（riFocus3Line 吸取 / riCheckDoubleLine 验证，无 selector 禁用）；click 生成 pickerId（nanoid 风格 newId），sendMessage picker:start，监听 picker:result 回填 onSelectorChange；verify 返回 0 → toast/error「Element not found」。
- 注册消息类型到 lib/messages.ts；background/index.ts 引入 picker-bridge 监听。
- 浏览器实测：编辑器打开（popup）→ 活动标签页点吸取 → 页面出现卡片 → 选元素 → 选择器回填 → 验证显示匹配数；iframe 页面（如 wikipedia 嵌入）可吸取。
- Commit `feat(picker): background bridge and editor pick/verify buttons`。

**P3 完成标志：** 真实页面吸取/验证可用，iframe 可用，结果回填表单。

---

## P4 — ~55 个块专用表单

参考：`A:components/newtab/workflow/edit/Edit*.vue`（~55 个）+ `edit/Parameter/*` + `edit/Trigger/*`。

### Task 20: 表单基件库
- Create `workflow-editor/blocks/shared/Field.tsx`：Input、Textarea（autoresize）、Select、Checkbox、Switch、Expand（折叠，riArrowLeftSLine 旋转）、Tooltip（title 属性即可）、Button(icon)。
- Create `shared/CodeField.tsx`：迁移现有 CodeInput.tsx 样式为 Automa 风格（深色编辑区、行高），用于 code/javascript/conditions 表达式。
- Create `shared/Autocomplete.tsx`：移植 EditAutocomplete.vue——输入 `{` 弹变量列表（内置变量 + 上游块输出变量 + 工作流变量，数据来自画布图分析），点击插入 `{{var}}`。
- Create `shared/BlockSettingsModal.tsx`：移植 EditBlockSettings + BlockSettingGeneral/Lines/OnError——description、disableBlock、blockTimeout、onError（enable、toDo: retry/fallback/error、retryTimes、retryInterval、fallback 标签）。
- Create `shared/InteractionBase.tsx`：移植 EditInteractionBase.vue——description textarea；findBy Select(cssSelector/xpath)；ElSelectorActions；selector textarea（Autocomplete 包裹）；Selector options Expand（multiple、markEl[仅 css]、waitForSelector + waitSelectorTimeout）；slots 设计为 props.children 分区（prepend/prependSelector/children）。
- Commit `feat(editor): shared form field primitives and interaction base`。

### Task 21–25: 块表单批次移植（每批一个 Task，可并行 subagent）

每个 Edit 组件统一签名：

```tsx
interface EditProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void  // 合并 patch 到 data
  blockId: string
}
```

- **Task 21（交互块，~14 个）**：EditEventClick、EditForms（移植 EditForms.vue + Parameter/*：text-field/select/checkbox/radio/value 类型）、EditLink、EditGetText、EditAttributeValue、EditHoverElement（用 InteractionBase）、EditPressKey（移植 EditPressKey + USKeyboardLayout 键列表，A:utils/USKeyboardLayout.js 转为 ts）、EditElementScroll、EditTriggerEvent（TriggerEvent* 子组件：mouse/keyboard/touch/wheel/input）、EditElementExists、EditLoopElements、EditCreateElement、EditUploadFile、EditSwitchTo。
- **Task 22（导航/浏览器块，~16 个）**：EditNewTab、EditNewWindow、EditSwitchTab、EditCloseTab、EditGoBack/Forward（无表单用空）、EditReloadTab（无表单）、EditTabURL、EditActiveTab（disableEdit 无表单）、EditTakeScreenshot、EditClipboard、EditCookie、EditHandleDialog、EditHandleDownload、EditDelay、EditProxy（占位说明）、EditWaitConnections（占位）、EditSaveAssets。
- **Task 23（数据块，~11 个）**：EditInsertData（含 InsertWorkflowData）、EditExportData、EditDeleteData、EditSortData、EditDataMapping、EditLogData、EditIncreaseVariable、EditSliceVariable、EditRegexVariable、EditWorkflowState、EditParameterPrompt。
- **Task 24（控制流，~5 个）**：EditConditions（SharedConditionBuilder 移植为 shared/ConditionBuilder.tsx：多行条件 [left][op][right] + AND/OR）、EditLoopData、EditRepeatTask、EditWhileLoop、EditLoopBreakpoint（无表单/说明）。
- **Task 25（集成/触发器，~8 个）**：EditJavascriptCode（CodeField + timeout/everyNewTab）、EditWebhook（method/headers/body/timeout）、EditNotification、EditExecuteWorkflow（工作流选择 + 变量传递）、EditTrigger（+ Trigger/TriggerCronJob/Interval/Date/SpecificDay/ContextMenu/KeyboardShortcut/VisitWeb/ElementChange/ElementOptions）、EditWorkflowParameters、EditBrowserEvent、EditBlockNote（便签文本）。

每批：
1. 建 `workflow-editor/blocks/EditXxx.tsx`（读对应 Automa Vue 文件逐字段移植：label 用英文——可直接从 A:locales/en/blocks.json 取英文字符串）。
2. 在 `workflow-editor/blocks/EditForms.ts` 注册：`{ EditForms, EditNewTab, ... }`。
3. 每批结束 typecheck + 手动在编辑器中拖出该块双击检查表单渲染；commit。

### Task 26: 块表单覆盖率测试
- 测试：遍历 PALETTE_BLOCKS，非 disableEdit/非 cloud 的块，其 editComponent 在 EditForms 映射中存在且为合法组件；渲染每个表单组件（data=catalog 默认值）不抛错（react testing-library render，mock chrome）。
- Commit `test(editor): every local block has a registered, renderable edit form`。

**P4 完成标志：** 所有本地块双击弹出与 Automa 一致的专用表单；吸取按钮在所有 selector 字段可用；设置弹窗可用。

---

## P5 — 录制工作流

参考：`A:content/services/recordWorkflow/`（recordEvents.js 360 行、App.vue、index.js、main.js、addBlock.js、icons.js）、`A:newtab/utils/startRecordWorkflow.js`、`RecordWorkflowUtils.js`。

### Task 27: inpage recorder
- Create `inpage/record/index.ts`：`startRecorder()`——Shadow DOM 浮动控制条（右下：● 录制中/暂停/停止按钮 + 已录块数；样式同 picker 卡片，内联 SVG 图标）；监听 storage isRecording 变化停止。
- Create `inpage/record/record-events.ts`：移植 recordEvents.js——document 捕获阶段监听 click/change/focusin/keydown/focusout/scroll(capture)；映射：click<a>→link、click→event-click、input/change text→forms(text-field, focusout 提交 value)、select→forms(select)、checkbox/radio→forms、文件→upload-file、按键→press-key、滚动→element-scroll；每块用 build-selector 生成 selector；事件去抖（input 合并、导航类由 background 处理）；通过 `chrome.runtime.sendMessage({type:'record:block', block})` 上报或直接写 storage（Automa 用 storage.local recording.flows——MV3 service worker 可随时读写 storage，content 也可，统一走消息让 background 追加更稳）。
- Commit `feat(record): inpage recorder with event-to-block mapping`。

### Task 28: background record-controller
- Create `background/record-controller.ts`：
  - `record:start`：storage 写 `{isRecording:true, recording:{flows:[{id:'new-tab',data:{url:activeTab.url}}], activeTab:{id,url}, name:'unnamed'}}`；`chrome.action.setBadgeText({text:'rec'})` + 红色 badge；tabs.query 所有 http 标签页 executeScript 注入 startRecorder（allFrames）；注册 tabs.onCreated/onActivated、webNavigation.onCommitted/onCompleted 监听（移植 RecordWorkflowUtils：新标签→new-tab 块、切标签→switch-tab 块、link/typed 导航→new-tab 补全、新完成导航的标签补注入 recorder）。
  - `record:block`：追加 recording.flows（去抖合并逻辑同 addBlock）。
  - `record:stop`：移除监听/badge；flows → 工作流图（见 Task 29）；保存 workflows.save；返回新 workflow id。
- background/index.ts 接线。
- Commit `feat(record): background record controller with tab/navigation tracking`。

### Task 29: flows → 工作流图转换 + 测试
- Create `lib/workflow/record-convert.ts`：`flowsToWorkflow(flows, name)`——trigger 块开头；flows 线性排列（dagre 风格阶梯坐标：x = index*220, y 交替或直接纵向；Automa 用 dagre 自动布局——简单实现：每块 x+=240，分支块 y 偏移）；顺序边 output-1→input-1；loop 类块无（录制不产生）；块 data 用上报值 + catalog 默认值合并。
- Create `tests/record-convert.test.ts`：fixture flows（new-tab → event-click → forms → press-key）→ 节点数/边数/顺序/首块 trigger；空 flows；new-tab url 合并逻辑（无效空 url 块被后续导航补全）。
- 停止录制后 WorkflowsTab/编辑器收到 `record:stopped` → windows.create 打开 `?edit=<id>&fromRecord=1`。
- Commit `feat(record): convert recorded flows into workflow graph`。

**P5 完成标志：** 点录制 → 操作页面（打开网站/点链接/输入/按键/滚动/切标签）→ 停止 → 编辑器打开生成的工作流 → 运行成功。

---

## P6 — 引擎对齐

参考：`A:workflowEngine/`（WorkflowEngine.js、WorkflowWorker.js、blocksHandler/*）、`A:content/blocksHandler/*`。

### Task 30: 执行器字段双读 + 块设置生效
- executors.ts：所有 selector 读取走 `pickSelector(data)`（data.selector ?? data.cssSelector；findBy=xpath 时走 xpath 解析——kernel 需支持 xpath：inpage/kernel.ts 选择器解析加 xpath 分支）；description/disableBlock/onError/waitForSelector/markEl/multiple 在 engine.ts 主循环统一处理：
  - disableBlock → 跳过。
  - waitForSelector → 执行前轮询（注入 kernel waitFor，超时 waitSelectorTimeout）。
  - onError：error 时按 toDo 处理（retry：retryTimes 次间隔 retryInterval；fallback：走 output-fallback 边；error：停止+通知）。
  - markEl → 执行时高亮（kernel 加 outline 闪烁）。
- Commit `feat(workflow): honor block settings (disable/wait/onError/mark/multiple)`。

### Task 31: 循环/分支执行器
- 实现 loop-data（遍历 JSON/表格/变量，循环体走 loop 输出、loop-breakpoint 汇合，参考 A:blocksHandler/handlerLoopData.js + WorkflowEngine 循环逻辑）、loop-elements（querySelectorAll 逐元素，循环体内选择器相对当前元素，参考 handlerLoopElements.js）、repeat-task、while-loop（JS 表达式求值）、execute-workflow（子工作流，变量传递 insertAllVars/globalData）。
- engine.ts 支持多输出分支：conditions（true/false 边）、element-exists（exists/notExists）、fallback 边——边的 sourceHandle 决定下一节点。
- Create `tests/engine-loops.test.ts`：mock driver，验证 loop-data 3 次迭代循环体执行 3 次、conditions true 分支、element-exists notExists 分支、onError retry 后成功、fallback 走 fallback 边。
- Commit `feat(workflow): loop/branch/fallback executors and multi-output routing`。

### Task 32: 触发器补全
- keyboard-shortcut：chrome.commands（manifest 声明有限槽位 → 用 `commands.onCommand` + 动态方案不可行时退化为 content script 快捷键监听，在 record/background 文档说明；优先 commands API 注册一个通用槽位 + 用户自定义键在 content 端监听）。
- on-startup：chrome.runtime.onStartup → 跑启用的触发器。
- date/specific-day/interval/cron：接现有 scheduler/alarms（lib/schedule.ts 已有 cron 能力）。
- element-change：background 对匹配标签注入 MutationObserver content script（webNavigation.onCompleted 后按需注入），变化触发工作流。
- browser-event/save-assets/wait-connections/proxy：best-effort 实现或明确错误提示（proxy 在 MV3 不可用 → 表单标注）。
- Commit `feat(workflow): complete trigger types (startup/shortcut/element-change/date)`。

### Task 33: 编辑器运行态联动
- 运行时块高亮（Automa showExecutedBlock：当前执行块在画布高亮——编辑器通过运行日志消息订阅，节点加 running/done/error class）；Stop 按钮接现有 task 取消。
- Commit `feat(editor): live run-state highlighting on canvas nodes`。

**P6 完成标志：** 含循环/条件/onError 的 Automa 风格工作流可运行成功；各类触发器可启用。

---

## P7 — 验证打磨

- [ ] **Task 34:** `pnpm typecheck && pnpm test && pnpm build` 全绿；修复所有类型/测试问题。
- [ ] **Task 35:** 对照验收（浏览器实测 + 截图对比 Automa）：
  1. popup 编辑器布局：工具条/侧边栏/块面板/节点/边/minimap/搜索/缩放，亮+暗。
  2. 每个分类拖 2-3 个块，双击表单与 Automa 对照字段一致。
  3. 吸取器：普通页面 + iframe 页面；css/xpath；验证按钮。
  4. 录制完整流程并运行。
  5. 循环/条件/onError 工作流运行。
  6. 旧工作流（迁移前数据）仍可打开运行；Automa 导出 JSON 可导入。
- [ ] **Task 36:** 文档更新（README 工作流章节如有）；最终 commit。

---

## Self-Review 记录

- Spec 覆盖：块目录/图标(T1-4)、popup(T6)、布局复刻(T8-15)、吸取器(T16-19)、表单(T20-26)、录制(T27-29)、引擎(T30-33)、主题(T5)、迁移(T7)、测试(T3/16/26/29/31/34)——spec 各节均有对应 Task。
- 类型一致性：EditProps `{data, onChange, blockId}` 全表单统一；catalog 字段名与 BlockCatalogEntry 一致；picker 消息 pickerId 贯穿；flows 结构 {id,data,description?} 与 Automa 一致。
- 注意点：inpage 脚本必须自包含（func 序列化）；remixicon 字体在 content script 不可用（picker/recorder 用内联 SVG）；云块不展示但引擎需明确报错（T7/T26）。
