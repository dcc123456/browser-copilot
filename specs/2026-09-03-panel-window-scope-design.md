# 设计：插件窗口作用域（Panel Window Scope）

- 日期：2026-09-03
- 状态：已批准（待实现）
- 相关模块：`src/background/driver.ts`、`src/background/page.ts`、`src/background/agent.ts`、
  `src/background/index.ts`、`src/background/workflow-engine/*`、`src/background/workflow-triggers.ts`

## 1. 问题

当前所有"当前标签页"的解析都以**最近聚焦窗口**为准，而不是侧边栏面板所在的窗口：

- `page.ts` 的 `activeTab()` → `chrome.tabs.query({ active: true, lastFocusedWindow: true })`
- `driver.ts` 的 `listTabs()`/`switchTab()` → `chrome.tabs.query({ currentWindow: true })`
  （service worker 语境下即最近聚焦窗口）
- `newTab()` → `chrome.tabs.create(...)` 未指定 `windowId`
- `agent.ts` 的 `open_url` 工具 → `chrome.tabs.update({ url })` 更新最近聚焦窗口的活动标签
- `resolveAutomationTab()` 的回退链（lastFocused → 全部窗口搜索 → last-tab 记忆）全部跨窗口

于是出现用户报告的场景：开着两个浏览器窗口，一个打开了 Browser Copilot 侧边栏，另一个没有。
在面板里让助手"新开标签 / 切换标签 / 读取页面"时，操作可能落在另一个窗口（最近聚焦的那个），
干扰了用户在那个窗口的正常使用。

## 2. 目标语义（已经用户确认）

1. **插件窗口** = 侧边栏面板所在窗口。聊天回合的所有操作（读页面、点击、填写、`open_url`、
   `tab_new`、`tab_switch`、`tab_close`、截图、`run_javascript` 等）以及从面板发起运行的工作流，
   全部锁定在该窗口内。
2. **其他窗口零打扰**：不被读取、不被操作、不触发 visit-web 自动触发器、不被抢焦点
   （`tab_switch` 只在插件窗口内部激活标签，不调用 `chrome.windows.update({focused:true})`）。
3. **自动监听同样限定窗口**：当存在面板窗口时，visit-web 触发器（"打开 URL 匹配指定模式的
   页面时运行工作流"）只监听面板窗口中的导航；导航发生在其他窗口时不触发。
4. **无面板时保持现状**：定时任务、飞书远程指令、浏览器启动触发器等无人值守路径没有窗口可绑定，
   继续走现有全局解析链路。
5. **双面板各自为政**：两个窗口都打开面板时，每个聊天回合绑定发送该消息的面板所在窗口
   （通过 `port.sender.tab.windowId` 判定）。
6. **显式手势不限窗口**：键盘快捷键、右键菜单触发工作流属于用户在某个窗口的主动操作，
   按"手势发生的窗口"生效。

## 3. 非目标

- 不改变 `pin_tab`/`unpin_tab`、显式 `preferredTabId` 的语义（模型显式钉住的标签仍然优先）。
- 不改变从独立工作流编辑器弹窗运行工作流、元素拾取的现有全局回退行为。
- 不引入"每回合驱动实例"之类的驱动层重构。

## 4. 核心机制：`ScopeWindow` 显式传参

MV3 service worker 没有异步上下文传播（无 `AsyncLocalStorage`），模块级"当前窗口"变量在
两个面板并发对话时会互相覆盖。因此采用**显式参数**贯穿调用链：

新模块 `src/background/automation-scope.ts`：

```ts
/** 面板窗口作用域。undefined 表示"无作用域"= 现有全局行为。 */
type ScopeWindow = { windowId: number }

/** 校验窗口存在且 type === 'normal'；否则返回 undefined（降级为无作用域）。 */
async function normalScopeFromWindowId(windowId?: number | undefined): Promise<ScopeWindow | undefined>

/** 面板窗口登记（供 visit-web 触发器守卫判断"是否存在面板窗口"）。 */
function registerPanelWindow(windowId: number, port: chrome.runtime.Port): void
function unregisterPort(port: chrome.runtime.Port): void
function hasPanelWindows(): boolean
function isPanelWindow(windowId: number | undefined): boolean
```

要点：

- `type === 'normal'` 校验让编辑器弹窗（`chrome-extension://` popup 类型窗口）自动降级为
  无作用域，现有 lastNormal/last-tab 回退链路原样保留；同时防止"scoped 查询落在弹窗里解析
  不到可注入标签"把编辑器运行搞坏。
- 面板登记按 port 记账：同一窗口多个 port（理论上）注销单个 port 时不误删窗口；
  `chrome.windows.onRemoved` 时清理。
- 登记状态在 module scope（可丢弃）：worker 被回收后为空，触发器短暂回到全局监听，
  面板重连（onConnect）后重新登记。这是接受的降级，代码注释写明。

## 5. 数据流

```
入口采集 windowId → normalScopeFromWindowId() 校验
  ├─ 聊天回合: port.sender.tab.windowId
  │    → AgentDeps.scopeWindowId (新可选字段)
  │    → ToolContext.scopeWindowId
  │    → 工具实现逐个传 ctx.scopeWindowId
  ├─ onMessage 命令 (page.read / page.check / workflows.run): sender.tab.windowId
  ├─ visit-web 触发器: details.windowId（守卫通过后，scope = 导航所在窗口）
  ├─ 快捷键: sender.tab.windowId（手势窗口）
  ├─ 右键菜单: info.tab.windowId（手势窗口）
  └─ 定时任务 / 飞书 / 启动触发: 不传（undefined = 全局现状）
```

## 6. 改动清单

### 6.1 `src/background/driver.ts`

所有下列函数加可选尾参 `scope?: ScopeWindow`，undefined 时行为与现在完全一致：

- `resolveAutomationTab(preferredTabId?, scope?)`：有 scope 时只在本窗口解析——
  1. 显式 `preferredTabId` / `pin_tab` 优先，语义完全不变（它们是显式决定，允许指向其他窗口）；
  2. 本窗口活动标签（可注入）；
  3. last-tab 记忆中本窗口的最近可注入标签（给 `getLastInjectableTab` 增加第二个可选参数
     `onlyWindowId?: number`，只保留该窗口的候选，优先级仍按 `updatedAt`）；
  4. 仍无 → 返回 undefined（调用方报"没有可操作的标签页"类错误）。
  **绝不跨窗口回退。** 无 scope 时保持现有完整回退链。
- `execOnActiveTab` / `execJsOnActiveTab` / `snapshotPage` / `settleAfterNavigation` /
  `goBack` / `goForward` / `closeActiveTab` / `listAllTabUrls`：透传 scope。
  `settleAfterNavigation` 内部用 `activeTab()` 定位等待的标签，必须跟着 scoped。
- `listTabs(scope?)`：scoped 时 `chrome.tabs.query({ windowId })`，否则现状
  `({ currentWindow: true })`。
- `switchTab(index, scope?)`：scoped 列表内取 index 后 `chrome.tabs.update(id, { active: true })`
  （不聚焦窗口）。索引语义 = `list_tabs` 返回的本窗口索引。
- `newTab(url?, scope?)`：`chrome.tabs.create({ url, active: true, windowId: scope?.windowId })`
  （windowId 仅在 scoped 时携带）。
- 新增 `updateActiveTabUrl(url, scope?)`：供 `open_url` 使用。scoped 时解析本窗口活动标签
  （不要求可注入——`chrome://newtab` 也可以被导航到 http(s)）并 `tabs.update(tabId, { url })`；
  无 scope 时保持现状 `chrome.tabs.update({ url })`。

### 6.2 `src/background/page.ts`

- `activeTab(scope?)`：scoped 时 `chrome.tabs.query({ active: true, windowId })`；查询为空
  （窗口已被关闭）才回退现有全局逻辑（lastFocused → anyActive）。
- `readActivePage(maxChars, scope?)` / `readActiveSelection(scope?)`：透传。

### 6.3 `src/background/agent.ts`

- `AgentDeps` 增加可选 `scopeWindowId?: number`；`ToolContext` 增加同名可选字段；
  `runAgentTurn` 构造 ctx 时带上。
- 工具实现中所有 `execOnActiveTab` / `resolveAutomationTab` / `newTab` / `switchTab` /
  `listTabs` / `closeActiveTab` / `goBack` / `goForward` / `captureObservation` /
  `settleAfterNavigation` 调用带 `ctx.scopeWindowId`（经 `normalScopeFromWindowId` 校验，
  在回合开始处做一次并存入 ctx）。
- `open_url` 改用 `updateActiveTabUrl(url, ctx.scope)`。
- 工具描述更新：`list_tabs` / `tab_new` / `tab_switch` / `open_url` 补充"操作限定在面板所在
  窗口；list_tabs 的 index 即该窗口的标签索引"。
- 无人值守入口 `agent-unattended.ts` 不传 scopeWindowId（自动全局）。

### 6.4 `src/background/workflow-engine/`

- `WorkflowExecCtx` 增加 `scopeWindowId?: number`；`buildExecCtx` 透传；
  `WorkflowRunOptions` 与 `ExecuteWorkflowOptions` 增加 `scopeWindowId?`。
- executors 中所有 driver 调用（`driverNewTab` / `driverSwitchTab` / `closeActiveTab` /
  `goBack` / `goForward` / `activeTab` / `resolveAutomationTab` / `execOnActiveTab` /
  `execJsOnActiveTab`）带 `ctx.scopeWindowId`。
- `run-workflow.ts` 把 `opts.scopeWindowId` 传入引擎。

### 6.5 `src/background/index.ts`

- port connect：取 `port.sender?.tab?.windowId`，`registerPanelWindow`；聊天回合 deps 附带
  `scopeWindowId`（校验后）。
- port disconnect：`unregisterPort`。
- onMessage listener：`_sender` 改为 `sender`；`page.read` / `page.check` / `workflows.run`
  按 `sender.tab.windowId` 传 scope（校验后）。`record.*`（来自编辑器弹窗）不传。
- visit-web 触发器：守卫 `hasPanelWindows() && !isPanelWindow(details.windowId)` → 忽略；
  否则运行时 scope = `details.windowId`（无面板时 undefined）。
  守卫逻辑提取为纯函数 `shouldTriggerVisitWeb(panelWindowCount, windowId)` 便于单测。
- 快捷键触发：`handleShortcutPressed` 增加 sender 参数，scope = `sender.tab?.windowId`。
- 右键菜单触发：scope = `info.tab?.windowId`。
- 定时任务 / 飞书 / 启动触发：不传 scope（现状）。

### 6.6 工具目录文案

`src/lib/tool-catalog.ts`（或 agent.ts 内 TOOLS 定义）中涉及标签页的工具描述与
`src/lib/system-prompt.ts`（若有相关表述）同步补充窗口作用域说明。

## 7. 错误处理

| 场景 | 行为 |
| --- | --- |
| 面板窗口被中途关闭 | scoped 查询为空 → driver/page 回退全局链路；chrome 调用抛错则照常上报。面板已随窗口关闭，回合结果仍持久化（现有 finally 逻辑）。 |
| 插件窗口内无可注入页面（全是 chrome:// 等） | `resolveAutomationTab` 返回 undefined，报"插件窗口内没有可操作的网页标签页"；模型可转述；**绝不**跳到其他窗口操作。 |
| worker 回收后面板登记丢失 | 触发器短暂回到全局监听；面板重连后恢复。注释写明接受的降级。 |
| 编辑器弹窗运行工作流 / 元素拾取 | `normalScopeFromWindowId` 对 popup 窗口返回 undefined → 现有全局链路，行为不变。 |
| `tab_new`/`open_url` 目标窗口恰好刚被关闭 | chrome 调用抛错，错误信息上报给模型/面板。 |

## 8. 测试

- 新增 vitest 单测（chrome mock，沿用现有测试基建）：
  - `automation-scope`：`normalScopeFromWindowId`（normal / popup / 不存在 / 未传）、
    面板登记与注销（多 port 记账）、`shouldTriggerVisitWeb` 纯函数。
  - `driver`：`newTab` / `listTabs` / `switchTab` / `closeActiveTab` / `updateActiveTabUrl`
    的 scope 分支断言（收到正确的 windowId 参数）；`resolveAutomationTab` 有 scope 时
    **不**触发跨窗口回退。
  - `page`：`activeTab` scope 分支与"scoped 为空回退全局"。
- 回归：`pnpm run typecheck`、`pnpm run test` 全量通过。

## 9. 文档

- `README.md` / `README.zh-CN.md`：「使用说明」与「已知限制」补充窗口作用域说明
  （面板窗口为控制目标；其他窗口零打扰；无面板时定时/飞书任务维持全局行为）。

## 10. 风险与权衡

- 改动面涉及约 8 个文件的函数签名（均为可选尾参，默认值即旧行为），风险可控。
- worker 回收后触发器守卫短暂失效是已接受的降级（见 §7）。
- `port.sender.tab` 理论上可能缺失（防御式判空），缺失时不传 scope = 现状。
