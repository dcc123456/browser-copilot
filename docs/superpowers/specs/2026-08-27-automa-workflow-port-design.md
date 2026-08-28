# Automa 工作流编辑器完整移植 — 设计文档

日期：2026-08-27
状态：已确认设计方向，待实现计划

## 1. 目标与范围

将 Automa（Vue 3 + Vue Flow 浏览器扩展）的工作流编辑功能完整移植到 browser-copilot（React 19 + @xyflow/react）：

1. **编辑工作流使用独立弹窗**：`chrome.windows.create({ type: 'popup' })` 打开无地址栏独立窗口。
2. **CSS 选择器支持页面手动吸取**：注入 content script，在页面上悬停高亮、点击锁定元素，生成选择器回填表单；含选择器验证。
3. **每个算子节点功能一致、图标一致**：移植 Automa 全部本地可运行算子（约 55 个），英文名 + RemixIcon 图标与 Automa 完全相同；云服务算子（google-sheets、google-sheets-drive、google-drive、ai-workflow、block-package）**不出现在块面板中**（catalog 中标记 `cloud: true` 并在面板/目录导出时过滤掉；引擎遇到旧数据中的这些块 id 时给出明确「不支持」报错而非静默跳过）。
4. **编辑页面排版布局一致**：复刻 Automa 编辑器——左→右节点连接、顶部浮动工具条、左下角搜索、右下角缩放/MiniMap、右侧可折叠可拖拽宽度的侧边栏（工作流详情 / 节点参数表单 / 块面板）。
5. **主题跟随浏览器**：`prefers-color-scheme` 亮/暗双主题，色板对齐 Automa 的 Tailwind 灰阶与分类色。
6. **录制工作流（Record）**：页面操作（点击、输入、改下拉、按键、滚动、链接跳转、切标签页、导航）自动录制为块序列，停止后生成新工作流在编辑器中打开。

非目标（YAGNI）：
- Google Sheets / Google Drive、AI Workflow、block-package 等云服务块：**不移植、不在面板展示**。
- Automa 云账号、团队共享、Marketplace 包、云备份。
- Automa 的 i18n 多语言体系（界面保持 browser-copilot 现有中文；算子名用英文原名）。

## 2. 现状侦察结论

| 维度 | Automa（源） | browser-copilot（目标） |
|---|---|---|
| 框架 | Vue 3 + Vue Flow (@vue-flow/core) | React 19 + @xyflow/react（同作者，API 一一对应） |
| 块目录 | `src/utils/shared.js` 的 `tasks`（~60 块：id/name/description/icon/category/inputs/outputs/editComponent/data 默认值） | `src/lib/workflow/registry.ts`（~50 块，中文 label，无图标，通用 params schema） |
| 节点组件 | `components/block/BlockBasic.vue` 等：左 target / 右 source Handle，分类色图标块 + 名称 + 描述 | `workflow-editor/App.tsx` 内联 CustomNode：上/下 Handle，无图标 |
| 编辑器布局 | `newtab/pages/workflows/[id].vue` + `WorkflowEditor.vue`：顶部浮动工具条、左侧搜索、右侧边栏（WorkflowDetailsCard / WorkflowEditBlock 切换）、块面板抽屉 | 独立页 `src/workflow-editor/`：顶栏 + 左侧块面板常驻 + 右侧参数常驻 |
| 块表单 | `components/newtab/workflow/edit/Edit*.vue`（~55 个专用表单） | App.tsx 内通用 schema 表单 |
| 元素吸取 | `content/elementSelector/`（Shadow DOM Vue 注入层 + selectorFrameContext iframe 支持 + generateElementsSelector） | 无 |
| 录制 | `content/services/recordWorkflow/`（recordEvents.js 监听 click/change/input/keydown/scroll + background tab/webNavigation 事件） | 无 |
| 执行引擎 | workflowEngine + content blocksHandler | `background/workflow-engine/`（~45 执行器 + 5 占位：loop-data/repeat-task/while-loop/loop-elements/execute-workflow） |
| 页面注入 | webpack 打包 content bundle | `chrome.scripting.executeScript` 按需注入 `inpage/kernel.ts`（allFrames，函数序列化） |
| 图标 | v-remixicon（RemixIcon） | 无 |
| 主题 | Tailwind dark: 类 | 单一主题 |

关键对应关系：Vue Flow 与 React Flow 概念一一对应（Handle/Position、Background、MiniMap、Controls、useVueFlow→useReactFlow、screenToFlowPosition、smoothstep 边、markerEnd 箭头）。

## 3. 架构总览

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│ workflow-editor popup window│     │ sidepanel (WorkflowsTab)     │
│ React + @xyflow/react       │     │ 新建/编辑 → windows.create   │
│  ├─ FlowCanvas (节点/边)    │     │ 录制 → background: record:start
│  ├─ TopToolbar              │     └──────────────────────────────┘
│  ├─ Sidebar                 │◄──┐
│  │   ├─ WorkflowDetails     │   │ chrome.runtime 消息
│  │   ├─ BlockEditForm       │   │ (workflows.* / picker:* / record:*)
│  │   └─ BlockPalette        │   │
│  └─ SearchBlocks / ZoomBar  │   │
└──────────────┬──────────────┘   │
               │ picker:start     │
┌──────────────▼──────────────┐   │
│ background service worker   │───┘
│  ├─ workflows storage       │
│  ├─ workflow-engine         │
│  ├─ picker-bridge (转发)    │
│  ├─ record-controller       │
│  └─ driver (executeScript)  │
└──────────────┬──────────────┘
               │ chrome.scripting.executeScript (allFrames)
┌──────────────▼──────────────┐
│ inpage (注入页面世界)        │
│  ├─ kernel.ts (现有 ops)     │
│  ├─ element-picker/ (新增)   │  Shadow DOM 悬浮层
│  └─ record/ (新增)           │  事件监听 + 选择器生成
└─────────────────────────────┘
```

原则：
- **编辑器 UI 原生 React 重写**（不嵌 Vue/iframe）；Automa 的 Vue SFC 作为视觉/行为规格逐组件移植。
- **页面世界脚本用 vanilla TS**（picker、recorder），与现有 kernel.ts 一样函数序列化注入，Shadow DOM 隔离样式，不引入框架。
- **块目录是单一事实源**：`lib/workflow/blocks/catalog.ts` 同时驱动面板、节点渲染、表单解析、引擎默认值。

## 4. 块目录与图标

### 4.1 catalog 数据模型（对齐 Automa tasks）

```ts
// src/lib/workflow/blocks/types.ts
export interface BlockCatalogEntry {
  id: string                       // Automa block id，如 'click-element'、'new-tab'
  name: string                     // 英文原名，如 'Click element'
  description: string
  icon: string                     // RemixIcon 名，如 'riCursorLine'；'http...' 为图片 URL；'path:...' 为自定义 SVG path
  category: BlockCategory          // Automa 7 分类
  component: 'BlockBasic' | 'BlockConditions' | 'BlockDelay' | 'BlockElementExists'
    | 'BlockGroup' | 'BlockLoopBreakpoint' | 'BlockNote' | 'BlockPackage'
    | 'BlockBasicWithFallback' | 'BlockRepeatTask'
  editComponent: string            // 如 'EditForms'，映射到 React 表单组件
  inputs: number                   // 输入连接点数（0/1）
  outputs: number                  // 输出连接点数（1 或更多，分支块）
  allowedInputs?: boolean
  maxConnection?: number
  disableEdit?: boolean            // 如 active-tab 无表单
  tag?: string                     // 如 'AI'
  refDataKeys?: string[]
  cloud?: boolean                  // 云服务块（google-sheets 等）：true 时不进入面板/可选目录，引擎对旧数据报「不支持」
  data: Record<string, unknown>    // Automa 默认 data（节点 data 的初始值）
}
```

分类（Automa 7 类，含亮/暗色）：

| id | 名称 | 亮色 | 暗色 |
|---|---|---|---|
| interaction | Web interaction | green-200 | green-300 |
| browser | Browser | orange-200 | orange-300 |
| general | General | yellow-200 | yellow-300 |
| onlineServices | Online services | red-200 | red-300 |
| data | Data | lime-200 | lime-300 |
| conditions | Control flow | blue-200 | blue-300 |
| package | Packages | cyan-200 | cyan-300 |

onlineServices / package 两个分类的块全部是云服务块，本期不展示——面板渲染时空分类不显示；分类色定义保留以便未来使用。

`trigger` 块归 general 分类（Automa 即如此）。browser-copilot 现有分类（navigation 等）映射：navigation→browser，control-flow→conditions，integration→general/onlineServices（按 Automa 原分类为准，逐块核对 shared.js）。

### 4.2 块清单（本地可运行 ~55 个，id 以 shared.js 为准）

- general：trigger、execute-workflow、delay、javascript-code、webhook、notification、note、blocks-group、workflow-state、parameter-prompt
- browser：active-tab、new-tab、switch-tab、new-window、proxy(占位)、go-back、forward-page、close-tab、reload-tab、tab-url、handle-dialog、handle-download、clipboard、cookie、save-assets、wait-connections(占位)、take-screenshot、upload-file
- interaction：event-click、forms、link、trigger-event、browser-event、element-scroll、get-text、attribute-value、hover-element、press-key、create-element、element-exists、loop-elements、switch-to
- data：export-data、insert-data、delete-data、sort-data、data-mapping、log-data、increase-variable、slice-variable、regex-variable
- conditions：conditions、loop-data、repeat-task、while-loop、loop-breakpoint

**不展示**（catalog 中 `cloud: true`，面板与可选目录过滤）：ai-workflow、block-package、google-sheets、google-sheets-drive、google-drive。

### 4.3 图标

- 新增依赖 `remixicon`（npm 包，含 SVG sprite / 字体）。用 `<RemixIcon name="riFlashlightLine" size={20} />` 组件（sprite `<use href="#ri-flashlight-line">` 或内联 SVG 字典；编辑器与 sidepanel 共用）。
- Automa 中 `icon: 'path:...'` 的块：解析 path 字符串内联渲染 `<svg><path d="..."/></svg>`（见 WorkflowBlockList.getIconPath）。
- `icon` 为 http URL 的：`<img>` + 暗色 invert（本期云块不展示，此逻辑仅作通用支持保留）。
- 块目录的 icon 字段从 shared.js 机械搬运，保证完全一致。

### 4.4 与现有 registry/引擎的兼容

- `registry.ts` 保留为薄兼容层：re-export catalog，并提供旧 id → Automa id 别名映射（click→event-click、fill→forms、scroll→element-scroll、hover→hover-element、condition→conditions 等）。
- 节点存储 data 结构迁移为 Automa 风格（`selector/findBy/description/...`）；`storage.ts` 加载旧工作流时做一次迁移（旧 `cssSelector`→`selector`、旧 `values` 打平到 `data`），引擎执行器双读两种字段名。

## 5. 编辑器 UI（popup 窗口）

### 5.1 窗口打开方式

`WorkflowsTab.openEditor` 改为：

```ts
await chrome.windows.create({
  type: 'popup',
  url: chrome.runtime.getURL('src/workflow-editor/index.html' + (id ? `?edit=${id}` : '')),
  width: 1280, height: 860,
})
```

录制完成后同样用 popup 打开 `?edit=<newId>&fromRecord=1`。

### 5.2 布局（复刻 [id].vue + WorkflowEditor.vue）

```
┌──────────────────────────────────────────────────────────┐
│ [浮]  [≡] [Editor|Logs] ............ [Save][Run][▮][⚙]    │  顶部浮动工具条
│                                                          │
│  ╭─ React Flow 画布 ─────────────────────────────╮ ╭────╮ │
│  │  (节点左→右连接, 点阵 Background)              │ │ 侧 │ │
│  │   ●─[icon Name]──→●                           │ │ 边 │ │
│  │                          ╭MiniMap╮            │ │ 栏 │ │
│  │ [🔍 搜索]                ╰───────╯  [⛶][−][+]│ │ w80│ │
│  ╰───────────────────────────────────────────────╯ ╰────╯ │
└──────────────────────────────────────────────────────────┘
```

- **节点**（移植 BlockBasic/BlockBase）：
  - 左 target Handle（trigger 无输入）、右 source Handle；分支块（conditions 2 输出 true/false、element-exists 2 输出、loop 类 loop/end 双输出、onError fallback 额外底部 Handle）多 Handle 带标签。
  - 内容：分类色圆角图标块（`rounded-lg p-2`，暗色 `text-black`）+ 粗体名称行 + 灰色描述行（data.description，如选择器/URL 摘要）；`disableBlock` 时图标块变灰；块校验错误显示红色 riAlertLine；loop 块右下角显示 loopId（点击复制）。
  - 双击节点 → 侧边栏打开该块表单；节点上齿轮按钮 → BlockSettings 弹窗；右键菜单（复制/粘贴/删除/禁用，移植 EditorLocalCtxMenu）。
  - 特殊节点组件：BlockConditions（分支标签）、BlockElementExists、BlockDelay、BlockNote（便签样式）、BlockRepeatTask、BlockLoopBreakpoint、BlockGroup（容器）。
- **边**：移植 EditorCustomEdge——smoothstep、选中高亮、箭头 marker（可配）、`connected-edges` 高亮（选中节点时邻接边高亮）、边可拖拽重连（edgeUpdater）。
- **顶部浮动工具条**（pointer-events-none 容器，子元素 pointer-events-auto）：
  - 左：侧边栏切换按钮（riSideBarFill/Line）、Editor/Logs 标签页。
  - 右：操作按钮组（移植 EditorLocalActions）：Save（riSaveLine，未保存状态点）、Run（riPlayLine）、Stop（录制/调试时）、调试相关、设置、块面板入口（riAddLine/riApps2Line 打开块面板抽屉）。
- **左下**：搜索块按钮（riSearch2Line），展开输入框；功能复刻 EditorSearchBlocks——搜索画布上已有节点（非面板），选中后居中定位并高亮（ring-4），快捷键触发。
- **右下**：适应视图（riFullscreenLine）、缩放 −/+ 白色分段控件；MiniMap（节点按分类色着色，pannable/zoomable）。
- **画布交互**：Delete 删除、Ctrl/Meta 多选、拖拽连线、从块面板拖入生成节点（DroppedNode 逻辑：data 取 catalog 默认值深拷贝，label=block.id，type=component）、网格吸附设置。
- **快捷键**：对齐 Automa EditorCommands（搜索、切侧边栏、保存等；mousetrap 风格，用原生 keydown 实现）。

### 5.3 右侧边栏（可折叠 + 可拖拽宽度）

- 默认 w-80（~320px），左边框有拖拽手柄（custom-drag，mousedown 调宽）；折叠时画布全宽。
- 三种状态（与 Automa 一致）：
  1. **工作流详情**（未选中节点，移植 WorkflowDetailsCard）：工作流图标/名称/描述编辑、触发器选择（manual/interval/cron/date/specific-day/context-menu/shortcut/visit-web/element-change/on-startup）、全局数据（WorkflowGlobalData）、工作流设置（SettingsGeneral：debugMode、saveLog、notification、onError 默认、snapToGrid、箭头开关）。
  2. **块编辑表单**（双击节点，移植 WorkflowEditBlock）：sticky 顶栏 = 返回箭头（riArrowLeftLine）+ 块名 + 文档链接；下方为该块的专用 Edit 组件。
  3. **块面板**（工具条「添加块」打开，移植 WorkflowBlockList + EditorLocalSavedBlocks）：分类折叠分组（彩色圆点 + 分类名 + +/-），每组 2 列网格卡片（图标 24px + 英文名 + hover 显示文档/图钉按钮 + tag 角标），卡片 draggable，dragstart 写 `application/json` block 数据；图钉块置顶。
- Logs 标签页：移植 EditorLogs（运行日志/块执行状态，对接现有 RunningBoard/run log 数据）。

### 5.4 主题

- 所有颜色用 CSS 变量定义亮/暗两套（`--bc-bg`, `--bc-bg-soft`, `--bc-border`, `--bc-text`, `--bc-text-dim`, `--bc-accent` 等），`:root` 亮色、`@media (prefers-color-scheme: dark)` 暗色；弹窗、sidepanel、inpage 悬浮层统一。
- 分类色提供亮/暗双值（见 4.1 表）。
- 编辑器页监听 `matchMedia('(prefers-color-scheme: dark)')` 变化即时切换（popup 窗口跟随系统/浏览器主题）。

## 6. 块专用编辑表单

目录 `src/workflow-editor/blocks/`，按 Automa `Edit*.vue` 逐个移植为 React 组件，注册表：

```ts
// editComponents.ts: 'EditForms' → EditForms, ...
```

共享基件（`workflow-editor/blocks/shared/`）：
- **InteractionBase**（对齐 EditInteractionBase）：描述 Textarea；findBy 下拉（cssSelector/xpath）；选择器行 = Textarea(自动增高) + **吸取按钮（riFocus3Line）** + **验证按钮（riCheckDoubleLine，无选择器时禁用）**；「Selector options」折叠：multiple 复选、markEl 复选、waitForSelector 复选 + 超时输入。
- **ElSelectorActions**：吸取/验证两个按钮（见第 7 节消息链）。
- **BlockSettings 弹窗**（EditBlockSettings + BlockSettingGeneral/Lines/OnError）：description、disableBlock、blockTimeout、onError（retry 次数/间隔、fallback 分支、error 通知）。
- 控件库：Textarea（autoresize）、Input、Select、Checkbox、Switch、Expand（折叠）、Tooltip、CodeInput（JS/JSON，现有 CodeInput 套 Automa 样式）。
- **EditAutocomplete**：变量自动补全——输入 `{` 弹出变量列表（上游块输出、内置变量 loopIndex/loopItem/lastText 等、工作流变量），选中插入 `{{var}}`。

移植批次（按使用频率）：
1. 交互基件 + event-click、forms、link、get-text、attribute-value、hover-element、press-key、element-scroll、trigger-event、element-exists、loop-elements、create-element、upload-file、switch-to。
2. 导航/浏览器：new-tab、new-window、switch-tab、close-tab、go-back/forward-page、reload-tab、tab-url、active-tab、take-screenshot、clipboard、cookie、handle-dialog、handle-download、delay。
3. 数据：insert-data、export-data、delete-data、sort-data、data-mapping、log-data、increase/slice/regex-variable、workflow-state。
4. 控制流：conditions（SharedConditionBuilder 条件构建器）、loop-data、repeat-task、while-loop、loop-breakpoint。
5. 集成/高级：javascript-code、webhook、notification、execute-workflow、parameter-prompt、trigger（EditTrigger 全套触发类型）、workflow-parameters。

云服务块不展示、无表单；若旧工作流数据中残留这些块 id，侧边栏显示「该块需要云服务，不受支持」提示，引擎运行时返回明确错误。

## 7. 元素吸取器（inpage element-picker）

### 7.1 注入与消息链

- `src/inpage/element-picker/`：vanilla TS，构建为可注入函数（同 kernel.ts 模式，`executeScript({ func, args, allFrames: true })`）。
- 主框架：创建 `#bc-element-picker` 容器，**attachShadow open**，Shadow DOM 内渲染悬浮卡片（样式字符串注入，不受页面 CSS 影响）。
- 子框架（iframe）：注入精简高亮脚本（虚线 outline），通过 `window.postMessage` 与主框架 picker 通信（移植 selectorFrameContext：跨框架元素选择/高亮）。

消息链：

```
编辑器 [吸取按钮]
  → chrome.runtime.sendMessage { type: 'picker:start', pickerId }
background: tabs.query active tab → executeScript(func: startPicker, args:[pickerId])
页面 picker: 用户选元素 → 生成选择器
  → chrome.runtime.sendMessage { type: 'picker:result', pickerId, selector }
background: 转发给请求方窗口（记录 opener windowId/tabId）
  → 编辑器收到回填 selector
```

- 验证按钮：`picker:verify` → 注入后 `document.querySelectorAll(selector).length`（xpath 用 document.evaluate），结果返回，0 个时 toast「Element not found」。
- 编辑器窗口可能失焦（用户点页面时 popup 窗口在后）——结果靠 runtime 消息转发，不依赖窗口焦点。

### 7.2 悬浮卡片功能（移植 elementSelector/App.vue）

- 卡片可拖拽（riDragMoveLine 手柄）；标题 Browser Copilot；眼睛按钮切换遮罩隐藏（riEyeLine/Off）；关闭按钮（riCloseLine）/ Esc 取消。
- **选择模式**：鼠标移动 → 高亮当前元素（实色 outline + 半透明遮罩），卡片显示实时生成的选择器；点击锁定（不再跟随鼠标）；锁定后可：
  - 父/子层级导航（up/down 按钮）。
  - CSS / XPath 切换。
  - 选择器设置开关：include id、tag name、class name、attributes（+ 属性名输入）、nth-child 等（移植 getSelectorOptions + generateElementsSelector）。
  - 匹配元素列表（listSelector：选择器命中多个时列出，可逐个高亮、可切换 multiple 模式）。
  - 「Select Element」确认按钮 → 回传选择器。
- 选择器生成：移植 `generateElementsSelector.js`（基于 css-selector-generator 思路的短选择器算法：优先 id→唯一 class→tag+nth-child，受设置开关控制）+ `@medv/finder` 风格备选；不引新依赖，用 ~150 行 TS 实现同等算法（Automa 自身也是自研 generateElementsSelector）。
- iframe 元素：主框架 picker 收到 postMessage 后生成带 frame 路径的上下文（browser-copilot driver 已 allFrames 注入，引擎侧选择器在子框架内解析；记录 frameSelector）。

## 8. 录制工作流（Record）

### 8.1 录制控制

- 入口：WorkflowsTab「● 录制」按钮 + 编辑器工具条录制按钮。
- background `record-controller`：
  - `record:start`：写 `{ isRecording, recording: { flows: [new-tab(当前URL)], activeTab, name } }` 到 storage；action badge 红色「rec」；向所有 http 标签页 `executeScript` 注入 recorder（allFrames）；监听 `tabs.onCreated/onActivated`、`webNavigation.onCommitted/onCompleted`（新导航的标签页补注入 recorder）。
  - `record:stop`：清除 badge/监听/存储标志；把 recording.flows 转换为工作流（节点 + 顺序边），保存为新工作流；打开编辑器 popup `?edit=<id>&fromRecord=1`。
- 页面 recorder（`src/inpage/record/`，vanilla TS + Shadow DOM 小控制条，移植 recordWorkflow/App.vue）：录制中页面右下角显示浮动条（暂停/继续/停止/计数），Shadow DOM 隔离。

### 8.2 录制的事件 → 块（移植 recordEvents.js）

| 用户操作 | 生成块 | data |
|---|---|---|
| 点击元素 | `event-click` | selector, waitForSelector, description |
| 点击 `<a>` 链接 | `link`（优先） | selector, newTab 判断 |
| 输入框 input/change | `forms` (type: text-field) | selector, value（focusout 时取值） |
| select change | `forms` (type: select) | selector, value |
| checkbox/radio change | `forms` (type: checkbox/radio) | selector, selected |
| 文件选择 | `upload-file` | selector（文件路径不可得，留待用户补） |
| 按键（Enter/Tab 等） | `press-key` | key |
| 滚动 | `element-scroll` | selector/scrollY |
| 自定义事件 | `trigger-event` | eventType |
| 打开新标签页（background tabs.onCreated） | `new-tab` | url, description=title |
| 切换标签页（tabs.onActivated） | `switch-tab` | url, matchPattern, createIfNoMatch |
| 页面导航（webNavigation.onCommitted, link/typed） | `new-tab` | url, updatePrevTab |

- 选择器生成复用 element-picker 的选择器算法（同一份 `buildSelector` 模块，inpage 内共享）。
- 去抖/合并：连续 input 合并为一次 forms（focusout 提交）；导航补全前一个空 url 的 new-tab。
- 录制 flows 是线性序列；保存时按 Automa convertWorkflowData 思路生成 drawflow 节点（dagre 自动布局或简单纵向阶梯布局）+ 顺序边，trigger 块为首节点。

## 9. 引擎对齐（background/workflow-engine）

- 节点 data 统一 Automa 字段名；执行器读取加 `pick(data, 'selector', 'cssSelector')` 兼容。
- 补齐占位执行器为真实实现：
  - `loop-data`：遍历 data（JSON/表格列/变量/loop 元素），循环体走 loopId 分支（Automa loop-breakpoint 语义：loop 块输出到循环体，breakpoint 块汇合）。
  - `loop-elements`：querySelectorAll 逐元素，循环体内 selector 相对当前元素（注入 kernel 支持，参考 Automa handlerLoopElements）。
  - `repeat-task` / `while-loop`：重复 N 次 / JS 条件为真。
  - `execute-workflow`：子工作流执行（变量传递 insertAllVars/globalData）。
  - `save-assets`（下载元素资源，downloads API 已有权限）、`wait-connections`（网络空闲，best-effort）、`proxy`（PAC 提示不支持则明确报错）、`browser-event`/element-change trigger（注入 MutationObserver content script）。
- 块设置生效：`disableBlock` 跳过、`onError`（retry N 次/间隔、fallback 边走 fallback 输出、error 停止/通知）、`waitForSelector`（执行前轮询等待）、`markEl`（执行时高亮元素，复用 showExecutedBlock 思路）、`multiple`。
- 触发器补全：keyboard-shortcut（chrome.commands，动态命令用 commands.onCommand 有限支持→用 content script 快捷键或 commands API 固定槽位）、on-startup（chrome.runtime.onStartup）、date/specific-day/interval/cron（接现有 scheduler/alarms）、context-menu（已有 contextMenus 权限）、visit-web（webNavigation 已有）。

## 10. 数据模型与持久化

```ts
// WorkflowNode.data 迁移为 Automa 形态：
interface AutomaNodeData {
  blockId: string          // = catalog id（旧字段保留兼容）
  values: Record<string, unknown>  // 旧结构（迁移期双写）
  // Automa 风格字段直接平铺：
  description?: string
  selector?: string
  findBy?: 'cssSelector' | 'xpath'
  // ...块各自 data 字段
  disableBlock?: boolean
  onError?: { enable: boolean; toDo: 'retry'|'fallback'|'error'; retryTimes?: number; retryInterval?: number }
  loopId?: string
}
```

- 加载时 `migrateWorkflow(wf)`：旧 `{blockId, values}` → 平铺 Automa data；旧 id 别名映射；迁移结果惰性保存。
- 引擎与编辑器共用 catalog 默认值，新建节点 = `structuredClone(catalog.data)`。
- WorkflowsTab 导入/导出格式不变（JSON），额外支持导入 Automa 导出的工作流 JSON（`drawflow.Home.data` 格式 → 转换为本项目 drawflow.nodes/edges，识别 Automa block id）。

## 11. 测试策略

- **catalog 完整性**（vitest）：每个面板块 id 非空、icon 合法（ri* 或 path/http）、category 合法、editComponent（非 disableEdit）有对应 React 表单组件；自动对比 Automa shared.js 解析出的 id 列表（测试 fixture 存一份 id 快照），本地块缺漏即失败，云块（cloud: true）断言不出现在面板目录中。
- **选择器算法单测**：jsdom 构造 DOM（id/class/嵌套/重复元素），断言 buildSelector 输出稳定、设置开关生效；xpath 生成。
- **录制转换单测**：flows 序列 → 节点/边图的转换（含 new-tab 合并、switch-tab、forms 合并）。
- **引擎**：loop-data/loop-elements/repeat-task/while-loop/conditions 分支/onError retry-fallback 的执行测试（mock driver）。
- **迁移**：旧格式工作流加载后字段正确。
- **构建/类型**：`pnpm typecheck` + `pnpm build` 通过。
- **手工验收**（浏览器实测）：popup 编辑器布局与 Automa 对照截图；吸取器在真实页面（含 iframe）回传选择器；录制一次「搜索→点击→输入」流程生成工作流并成功运行。

## 12. 实施分期

- **P1 基础**：catalog 移植（~60 块数据+图标，RemixIcon 接入）；类型与迁移；popup 窗口打开；主题变量双套。
- **P2 画布复刻**：React Flow 布局（左→右节点、图标节点组件族、自定义边、工具条、搜索、缩放/MiniMap、侧边栏壳+拖拽调宽+块面板）。
- **P3 元素吸取器**：inpage picker（Shadow DOM 卡片、高亮、选择器算法、xpath、设置、iframe）、消息桥、InteractionBase 吸取/验证按钮。
- **P4 块表单**：共享基件 + 55 个 Edit 组件分批移植 + BlockSettings 弹窗 + 变量自动补全。
- **P5 录制**：record-controller + inpage recorder + 事件映射 + flows→图转换 + badge/控制条。
- **P6 引擎对齐**：循环/分支/子工作流/onError/等待逻辑 + 触发器补全 + Automa JSON 导入。
- **P7 验证打磨**：测试补齐、typecheck/build、与 Automa 逐项对照验收、暗色走查。

## 13. 风险与对策

- **工作量大（~55 表单 + 60 块）**：表单按批次移植，catalog 先行；通用 InteractionBase 覆盖约半数交互块，实际专用逻辑集中在 ~20 个表单。
- **popup 窗口与页面间消息**：picker/recorder 结果经 background 转发，用 pickerId/sessionId 关联，窗口失焦不影响。
- **iframe 吸取**：allFrames 注入 + postMessage，driver 已有 allFrames 排名机制可复用。
- **选择器算法与 Automa 有细微差异**：以「稳定唯一定位元素」为验收标准，不追求逐字符相同；同时支持 xpath。
- **旧工作流兼容**：迁移函数 + 引擎双读字段，旧数据不破坏。
