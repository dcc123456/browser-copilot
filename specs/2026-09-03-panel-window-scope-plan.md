# 插件窗口作用域（Panel Window Scope）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面板（侧边栏）所在窗口成为所有面板发起操作的唯一目标窗口；其他浏览器窗口零打扰；无面板时保持现有全局行为。

**Architecture:** 新模块 `automation-scope.ts` 提供 `ScopeWindow`（校验后的 `{windowId}`）与面板窗口登记；入口（port/onMessage/触发器）采集 `windowId` 并校验为 `normal` 窗口；`ScopeWindow` 作为可选尾参显式贯穿 driver/page/agent/workflow 执行器；visit-web 自动触发器用面板登记做守卫。service worker 无异步上下文，故不用模块级"当前窗口"变量。

**Tech Stack:** TypeScript / Chrome MV3 / vitest（chrome 全局 stub，风格同 `tests/last-tab.spec.ts`）。

**Spec:** `specs/2026-09-03-panel-window-scope-design.md`（实现细节偏差：WorkflowExecCtx 携带 `scope?: ScopeWindow` 对象而非裸 windowId，避免执行器逐块重复异步校验）。

---

### Task 1: `automation-scope` 模块（TDD）

**Files:**
- Create: `src/background/automation-scope.ts`
- Test: `tests/automation-scope.spec.ts`

- [ ] **Step 1: 写失败测试**（`normalScopeFromWindowId`：normal→scope、popup→undefined、窗口不存在→undefined、未传→undefined、无 chrome→undefined；登记表：register/unregister/hasPanelWindows/isPanelWindow 多 port 记账；`shouldTriggerVisitWeb` 真值表）

```ts
// 核心断言示例（完整文件按 tests/last-tab.spec.ts 的 makeChrome 风格写）
expect(await mod.normalScopeFromWindowId(1)).toEqual({ windowId: 1 })        // type:'normal'
expect(await mod.normalScopeFromWindowId(2)).toBeUndefined()                 // type:'popup'
expect(await mod.normalScopeFromWindowId(99)).toBeUndefined()                // 不存在
expect(await mod.normalScopeFromWindowId(undefined)).toBeUndefined()
mod.registerPanelWindow(1, portA); mod.registerPanelWindow(1, portB)
expect(mod.hasPanelWindows()).toBe(true); expect(mod.isPanelWindow(1)).toBe(true)
mod.unregisterPort(portA); expect(mod.isPanelWindow(1)).toBe(true)           // B 还在
mod.unregisterPort(portB); expect(mod.hasPanelWindows()).toBe(false)
expect(mod.shouldTriggerVisitWeb(true, true)).toBe(true)
expect(mod.shouldTriggerVisitWeb(true, false)).toBe(false)
expect(mod.shouldTriggerVisitWeb(false, false)).toBe(true)
```

- [ ] **Step 2: 运行确认失败** — `pnpm vitest run tests/automation-scope.spec.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现**

```ts
/**
 * Panel-window automation scope.
 *
 * The side panel's window is the ONLY window a panel-driven turn may read or
 * act on; other windows belong to the user. A `ScopeWindow` is a window id
 * validated to still exist and be a `normal` window — the standalone workflow
 * editor is a `popup`-type window, so senders from it degrade to the legacy
 * global resolution (undefined scope) instead of scoping to a window with no
 * injectable tabs.
 *
 * Also tracks which windows currently host a connected panel (port-keyed), so
 * automatic visit-web triggers can stay quiet while the user browses in a
 * window that has no panel. Registry state is module scope = disposable: after
 * a worker eviction triggers fall back to global listening until the panel
 * reconnects. Accepted degradation.
 *
 * @module background/automation-scope
 */

/** 面板窗口作用域；undefined = 无作用域 = 现有全局行为。 */
export interface ScopeWindow {
  windowId: number
}

export async function normalScopeFromWindowId(windowId?: number): Promise<ScopeWindow | undefined> {
  if (typeof windowId !== 'number') return undefined
  if (typeof chrome === 'undefined' || !chrome.windows?.get) return undefined
  try {
    const win = await chrome.windows.get(windowId)
    return win.type === 'normal' ? { windowId } : undefined
  } catch {
    return undefined
  }
}

const portsByWindow = new Map<number, Set<chrome.runtime.Port>>()
const windowByPort = new Map<chrome.runtime.Port, number>()

export function registerPanelWindow(windowId: number, port: chrome.runtime.Port): void {
  if (typeof windowId !== 'number') return
  windowByPort.set(port, windowId)
  const set = portsByWindow.get(windowId)
  if (set) set.add(port)
  else portsByWindow.set(windowId, new Set([port]))
}

export function unregisterPort(port: chrome.runtime.Port): void {
  const windowId = windowByPort.get(port)
  if (typeof windowId !== 'number') return
  windowByPort.delete(port)
  const set = portsByWindow.get(windowId)
  if (!set) return
  set.delete(port)
  if (set.size === 0) portsByWindow.delete(windowId)
}

export function hasPanelWindows(): boolean {
  return portsByWindow.size > 0
}

export function isPanelWindow(windowId: number | undefined): boolean {
  return typeof windowId === 'number' && portsByWindow.has(windowId)
}

/** 窗口关闭时清理登记。Safe to call multiple times / in tests (guarded). */
export function initScopeWindowCleanup(): void {
  if (typeof chrome === 'undefined' || !chrome.windows?.onRemoved) return
  chrome.windows.onRemoved.addListener((closedWindowId) => {
    portsByWindow.delete(closedWindowId)
    for (const [port, windowId] of windowByPort) {
      if (windowId === closedWindowId) windowByPort.delete(port)
    }
  })
}

/** 纯函数守卫：无面板→全局监听（现状）；有面板→只允许面板窗口内的导航。 */
export function shouldTriggerVisitWeb(hasPanels: boolean, isPanel: boolean): boolean {
  return !hasPanels || isPanel
}
```

- [ ] **Step 4: 运行测试通过** → PASS
- [ ] **Step 5: Commit** `feat(scope): automation-scope 模块——面板窗口校验与登记`

### Task 2: `last-tab.ts` 支持窗口过滤

**Files:**
- Modify: `src/background/last-tab.ts`（`getLastInjectableTab(preferWindowId?, onlyWindowId?)`：`onlyWindowId` 存在时先 `filter((t) => t.windowId === onlyWindowId)` 再按 `updatedAt` 排序返回）
- Test: 追加到 `tests/last-tab.spec.ts`（窗口 A 记忆 2 个、窗口 B 记忆 1 个 → `getLastInjectableTab(undefined, A)` 只返回 A 的最新；A 无记忆 → undefined）

- [ ] 实现 + 测试通过 + Commit `feat(scope): last-tab 支持仅本窗口过滤`

### Task 3: `page.ts` 作用域

**Files:**
- Modify: `src/background/page.ts`

```ts
export async function activeTab(scope?: ScopeWindow): Promise<chrome.tabs.Tab | undefined> {
  if (scope) {
    const [scoped] = await chrome.tabs
      .query({ active: true, windowId: scope.windowId })
      .catch(() => [])
    // 窗口已被关闭（面板随之消失）才降级为全局解析；其余情况绝不跨窗口。
    if (scoped) return scoped
  }
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (focused) return focused
  const [anyActive] = await chrome.tabs.query({ active: true })
  return anyActive
}
```

- `readActivePage(maxChars, scope?)` / `readActiveSelection(scope?)` → `activeTab(scope)`。
- [ ] 实现 + `pnpm vitest run tests/pages.spec.ts` 回归 + Commit `feat(scope): page 读取作用域化`

### Task 4: `driver.ts` 作用域贯穿

**Files:**
- Modify: `src/background/driver.ts`
- Test: `tests/driver-scope.spec.ts`（新建，chrome stub 风格同 last-tab.spec，需含 `windows.get/getAll`、`tabs.query/get/update/create/remove` 与事件注册表）

关键改动（其余为机械透传）：

1. 缓存带作用域键（防无作用域回合与作用域回合互相污染）：

```ts
let cachedAutomationTab: chrome.tabs.Tab | undefined
let cachedAutomationScopeWindowId: number | undefined

function invalidateAutomationTabCache(): void {
  cachedAutomationTab = undefined
  cachedAutomationScopeWindowId = undefined
}
```

`resolveAutomationTab(preferredTabId?: number, scope?: ScopeWindow)`：pin/preferredTabId 语义不变；缓存仅当 `cachedAutomationScopeWindowId === scope?.windowId` 时命中；未命中走 uncached 并记录 scopeKey。

2. uncached 链头部插入作用域分支：

```ts
async function resolveAutomationTabUncached(scope?: ScopeWindow) {
  if (scope) {
    const win = await chrome.windows.get(scope.windowId).catch(() => undefined)
    if (win) {
      const [active] = await chrome.tabs
        .query({ active: true, windowId: scope.windowId })
        .catch(() => [])
      if (active && isInjectablePage(active.url)) return active
      const remembered = await getLastInjectableTab(undefined, scope.windowId).catch(() => undefined)
      if (remembered) return remembered
      // 窗口在、但没有可注入页面：绝不跨窗口回退。
      return undefined
    }
    // 窗口已关闭：降级为下方全局链路。
  }
  // …现有链路不变…
}
```

3. 标签管理函数加 `scope?` 尾参：

```ts
listTabs(scope?)            // query(scope ? { windowId } : { currentWindow: true })
switchTab(index, scope?)    // listTabs(scope) → update({active:true})（不聚焦窗口）
newTab(url?, scope?)        // create({ url, active:true, ...(scope && { windowId }) })
closeActiveTab(scope?)      // activeTab(scope) → remove
goBack/goForward(scope?)    // activeTab(scope)
listAllTabUrls(scope?)      // 同 listTabs 的 query 分歧
getActiveTabInfo(scope?)    // activeTab(scope)
pinActiveTab(tabId?, scope?) // resolveAutomationTab(undefined, scope)
settleAfterNavigation(ms?, signal?, scope?) // activeTab(scope)
snapshotActiveTab(maxChars, maxElements, scope?)
execOnActiveTab(op, signal?, preferredTabId?, scope?)      // resolveAutomationTab(preferredTabId, scope)
execJsOnActiveTab(code, args, signal?, preferredTabId?, scope?)
execWorkflowJsOnActiveTab(...同上...)
elementExists(selector, signal?, scope?) / countElements(selector, signal?, scope?)
```

4. 新增：

```ts
/** open_url 的原语：scoped 时导航本窗口活动标签（不要求可注入，chrome://newtab 也可被导航）。 */
export async function updateActiveTabUrl(url: string, scope?: ScopeWindow): Promise<void> {
  if (!scope) {
    await chrome.tabs.update({ url })
    return
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId: scope.windowId }).catch(() => [])
  if (!tab || typeof tab.id !== 'number') throw new DriverError('插件窗口内没有可导航的标签页。')
  await chrome.tabs.update(tab.id, { url })
}
```

5. `execOnActiveTab` 无 tab 时报错文案：scope 存在时用"插件窗口内没有可操作的网页标签页（不跨窗口查找）。请先在插件窗口打开一个普通 http(s) 页面。"，否则保留原文案。

- [ ] 测试要点：scoped `newTab` 传 `windowId`；`listTabs/switchTab` 查询本窗口；`resolveAutomationTab` 有 scope 时不命中其他窗口（stub 返回 B 窗口活动页也必须返回 undefined/本窗口结果）；窗口已关 → 走全局链；`updateActiveTabUrl` 两分支。
- [ ] `pnpm vitest run tests/driver-scope.spec.ts tests/last-tab.spec.ts` 通过
- [ ] Commit `feat(scope): driver 标签解析与标签管理作用域化`

### Task 5: `agent.ts` 贯穿

**Files:**
- Modify: `src/background/agent.ts`

- `AgentDeps` + `scopeWindowId?: number`；`ToolContext` + `scope?: ScopeWindow`。
- `runAgentTurn`：`ctx` 构造时 `...(deps.scopeWindowId !== undefined ? { scope: await normalScopeFromWindowId(deps.scopeWindowId) } : {})`（`runToolStandalone` 不传 → 全局，本地 agent 桥保持现状）。
- 调用点补 scope（全部显式，无省略）：
  - `read_current_page` → `readActivePage(maxChars, ctx.scope)`
  - `snapshot_page` → `snapshotActiveTab(maxChars, maxElements, ctx.scope)`
  - `resolveToolImage(..., scope?)`：内部 `execOnActiveTab` 与 `activeTab(scope)`（`recognize_image`/`take_screenshot` 调用点传 `ctx.scope`）
  - `list_network_requests` → `resolveAutomationTab(undefined, ctx.scope)`
  - `list_tabs` → `listTabs(ctx.scope)`
  - `run_javascript` → `execOnActiveTab(op, signal, undefined, ctx.scope)`
  - `click/fill/select_option/set_checkbox/press_key/scroll/wait_for` → `execOnActiveTab(op, signal, undefined, ctx.scope)`
  - `get_secret` 的 fill → 同上
  - `open_url` → `await updateActiveTabUrl(url, ctx.scope)`（替换 `chrome.tabs.update({url})`）
  - `tab_new` → `newTab(url || undefined, ctx.scope)`；`tab_switch` → `switchTab(index, ctx.scope)`；`tab_close` → `closeActiveTab(ctx.scope)`；`pin_tab` → `pinActiveTab(tabId, ctx.scope)`
  - `waitForPageStable(signal?, timeout?, scope?)` → `resolveAutomationTab(undefined, scope)` + `execOnActiveTab(..., undefined, scope)`
  - `settleAfterNavigation` 三处调用带 scope（open_url/tab_new/afterAction）
  - `captureObservation`：`waitForPageStable(signal, undefined, ctx.scope)`、`snapshotActiveTab(1500, 40, ctx.scope)`、`resolveAutomationTab(undefined, ctx.scope)`
- 工具描述：`open_url`（"Navigate the active tab of the panel's window…"）、`tab_new`、`tab_switch`（"…in this window"已对）、`list_tabs`（"in the panel's window; indices refer to that window"）补窗口语义。
- [ ] `pnpm run typecheck` 通过；`pnpm vitest run tests/agent-*.spec.ts` 回归
- [ ] Commit `feat(scope): agent 工具层按面板窗口执行并更新工具描述`

### Task 6: workflow 引擎与 run 层

**Files:**
- Modify: `src/background/workflow-engine/engine.ts`、`src/background/workflow-engine/run-workflow.ts`
- Test: `tests/workflow-engine.spec.ts` 追加（stub executor 断言 `ctx.scope` 到达执行器；`execute-workflow` 子流程继承 scope）

- `WorkflowExecCtx` + `scope?: ScopeWindow`（executors.ts 中定义）。
- `WorkflowRunOptions` + `scope?: ScopeWindow`；`runCore` 解构并传给 `buildExecCtx`（新尾参）与 `runSubWorkflow` 的子 `runCore`。
- `ExecuteWorkflowOptions` + `scopeWindowId?: number`；`executeWorkflow` 开头 `const scope = opts.scopeWindowId === undefined ? undefined : await normalScopeFromWindowId(opts.scopeWindowId)`，传入 `runWorkflow` options、`countElements(selector, signal, scope)`、`execJsOnActiveTab(code, {vars}, signal, undefined, scope)`。
- [ ] 测试通过 + Commit `feat(scope): workflow 引擎上下文携带面板窗口作用域`

### Task 7: workflow 执行器贯穿

**Files:**
- Modify: `src/background/workflow-engine/executors.ts`、`src/background/workflow-engine/ai-agent-executor.ts`

逐处把 `ctx.scope` 追加为尾参（`grep -n "execOnActiveTab\|activeTab(\|driverNewTab\|driverSwitchTab\|closeActiveTab\|goBack(\|goForward(\|listAllTabUrls\|getActiveTabInfo\|elementExists(\|countElements(\|resolveAutomationTab\|execJsOnActiveTab\|execWorkflowJsOnActiveTab" executors.ts` 全覆盖）：
`runRaw`、滚动平滑、`waitFor`、`takeScreenshot`（两分支）、`getText`、`openUrl`、`newTabExec`、`switchTabExec`、`closeTabExec`、`reloadTabExec`、`elementExistsExec`、`linkBlock`（3 处）、`attributeValueExec`、`goBackExec`/`forwardPage`、`tabUrlExec`/`activeTabExec`、`uploadFileExec`、`waitConnections`、`getForm`、JS 块（199）；`ai-agent-executor.ts:68` → `resolveAutomationTab(ctx.tabId, ctx.scope)`。
- [ ] `pnpm vitest run tests/workflow-executors.spec.ts tests/automa-executors.spec.ts tests/ai-agent-block.spec.ts tests/workflow-engine.spec.ts` 回归
- [ ] Commit `feat(scope): workflow 块执行器按面板窗口执行`

### Task 8: 背景入口接线

**Files:**
- Modify: `src/background/index.ts`、`src/background/workflow-triggers.ts`

1. index.ts 模块加载处 `initScopeWindowCleanup()`。
2. `onConnect`：`const senderWindowId = port.sender?.tab?.windowId`；数值时 `registerPanelWindow(senderWindowId, port)`；`onDisconnect` → `unregisterPort(port)`。chat 回合：`const scope = await normalScopeFromWindowId(senderWindowId)`，deps 带 `...(scope ? { scopeWindowId: scope.windowId } : {})`。
3. `onMessage` listener：`_sender` → `sender`；`page.read`/`page.check` 用 `normalScopeFromWindowId(sender.tab?.windowId)`；`workflows.run` 传 `scopeWindowId: sender.tab?.windowId`。
4. `runWorkflowKeepalive(workflowId, scopeWindowId?)`；visit-web 监听器头部加 `if (!shouldTriggerVisitWeb(hasPanelWindows(), isPanelWindow(details.windowId))) return`，触发时 `runWorkflowKeepalive(wf.id, details.windowId)`；右键菜单 `runWorkflowKeepalive(wf.id, info.tab?.windowId)`；`setWorkflowRunner((workflowId, scopeWindowId) => …)`。
5. workflow-triggers.ts：`setWorkflowRunner(fn: (workflowId: string, scopeWindowId?: number) => void)`；`handleShortcutPressed(message, sender?)` → `runWorkflowRef?.(match.wf.id, sender?.tab?.windowId)`；**alarm 路径（342/357）保持不传 scope（无人值守）**。
- [ ] `pnpm run typecheck` 通过；`pnpm vitest run tests/workflow-triggers.spec.ts` 回归
- [ ] Commit `feat(scope): 背景接线——端口登记、visit-web 守卫与手势窗口`

### Task 9: 文档与全量验证

**Files:**
- Modify: `README.md`、`README.zh-CN.md`（「使用说明」加"窗口作用域"条目；「已知限制」同步）；spec 文档偏差备注回填
- [ ] `pnpm run typecheck && pnpm run test && pnpm run build` 全部通过
- [ ] Commit `docs: 窗口作用域使用说明`

## Self-Review 记录

- Spec 覆盖：§2 六条语义 → Task 1(守卫/校验)、3/4(标签操作)、5(agent)、6/7(工作流)、8(触发器)；§7 错误表 → Task 4 作用域分支与 Task 8 降级路径；§8 测试 → 各 Task。
- 类型一致性：`ScopeWindow` 仅由 `normalScopeFromWindowId` 产生；engine/ctx 用对象、入口用裸 id（`ExecuteWorkflowOptions.scopeWindowId`）已在文中注明。
- 无占位符：机械透传处以显式清单列出（Task 5/7），逐处可核对。
