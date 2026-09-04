# 控制台日志工具 list_console_messages 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 browser-copilot 智能体新增只读工具 `list_console_messages`：默认返回控制台 error/warning，参数 `level:"all"` 返回全部级别日志，任何模式不弹审批。

**Architecture:** 扩展既有 CDP 被动监控器（`cdp-monitor.ts`）抓取全部 console 级别（缓冲 50→200），新增导出 `getConsoleEntries`；`agent.ts` 增加工具 schema + dispatch（与 `list_network_requests` 同构，不进审批集合）；`tool-catalog.ts` + `i18n.ts` 提供设置页元数据；`mcp-server.mjs` 的 `STATIC_TOOLS` 同步兜底条目。

**Tech Stack:** TypeScript、React 19（仅设置页自动渲染）、chrome.debugger CDP、Vitest、pnpm。

**规格文档:** `specs/2026-09-04-console-log-tool-design.md`（已获用户批准）

**验证命令:** `pnpm exec vitest run <file>`（单文件）、`pnpm typecheck`、`pnpm test`（全量）。每个任务结束时代码库必须保持 typecheck + 相关测试全绿（每个 commit 可独立构建）。

---

### Task 1: 监控器抓取全部级别 + `getConsoleEntries`（TDD）

**Files:**
- Create: `tests/cdp-console-log.spec.ts`
- Modify: `src/background/cdp-monitor.ts`

**背景知识（给零上下文工程师）：** `cdp-monitor.ts` 在模块 import 时向 `chrome.debugger.onEvent` 注册一次性监听器（有 `typeof chrome !== 'undefined'` 守卫），事件按 `source.tabId` 路由进模块级 `monitors` Map。测试要在**动态 import 之前**给 `globalThis.chrome` 装 stub，并用 `vi.resetModules()` 让每个测试拿到全新模块状态。Vitest 环境是 node（`vite.config.ts` test.include 为 `tests/**/*.spec.ts`）。

- [ ] **Step 1: 写失败测试**

创建 `tests/cdp-console-log.spec.ts`，完整内容：

```ts
/**
 * Console-capture side of the passive CDP monitor (src/background/cdp-monitor.ts).
 *
 * The module registers its chrome.debugger.onEvent listener once at import
 * time (guarded by a chrome global), so each test stubs globalThis.chrome
 * BEFORE dynamically importing a fresh module instance — that yields a clean
 * monitor map plus a captured listener we can feed CDP events through, with
 * no real chrome.debugger involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type CdpListener = (source: unknown, method: string, params?: Record<string, unknown>) => void

interface Stub {
  listeners: CdpListener[]
  commands: string[]
}

/** Installs a fake chrome.debugger on globalThis; optional attach rejection. */
function stubChromeDebugger(attachError?: Error): Stub {
  const listeners: CdpListener[] = []
  const commands: string[] = []
  const debuggerStub = {
    onEvent: { addListener: (fn: CdpListener) => listeners.push(fn) },
    onDetach: { addListener: (_fn: (source: unknown) => void) => undefined },
    attach: async () => {
      if (attachError) throw attachError
      return undefined
    },
    detach: async () => undefined,
    sendCommand: async (_target: unknown, method: string) => {
      commands.push(method)
      return undefined
    },
  }
  ;(globalThis as { chrome?: unknown }).chrome = { debugger: debuggerStub }
  return { listeners, commands }
}

/** Fresh module instance per test: resetModules + chrome stub already installed. */
async function loadFreshModule(attachError?: Error) {
  const stub = stubChromeDebugger(attachError)
  vi.resetModules()
  const mod = await import('../src/background/cdp-monitor')
  return { ...stub, mod }
}

function emit(
  listeners: CdpListener[],
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): void {
  for (const listener of listeners) listener({ tabId }, method, params)
}

const consoleCall = (type: string, text: string) => ({
  method: 'Runtime.consoleAPICalled',
  params: { type, args: [{ value: text }] },
})

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
})

describe('console capture levels', () => {
  it('maps consoleAPICalled: error/assert→error, warning→warning, others→log', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(1)
    for (const [type, text] of [
      ['error', 'boom'],
      ['assert', 'assertion failed'],
      ['warning', 'careful'],
      ['log', 'hello'],
      ['info', 'info text'],
      ['debug', 'debug text'],
      ['table', 'tabular'],
    ] as const) {
      const { method, params } = consoleCall(type, text)
      emit(listeners, 1, method, params)
    }
    const all = mod.getConsoleEntries(1, 'all')
    expect(all.map((e) => e.level)).toEqual([
      'error',
      'error',
      'warning',
      'log',
      'log',
      'log',
      'log',
    ])
    expect(all[0]!.text).toBe('boom')
  })

  it('captures Log.entryAdded at every level', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(2)
    emit(listeners, 2, 'Log.entryAdded', { entry: { level: 'error', text: 'net::ERR_ABORTED 404' } })
    emit(listeners, 2, 'Log.entryAdded', { entry: { level: 'warning', text: 'deprecated API' } })
    emit(listeners, 2, 'Log.entryAdded', { entry: { level: 'info', text: 'loaded' } })
    const all = mod.getConsoleEntries(2, 'all')
    expect(all.map((e) => [e.level, e.text])).toEqual([
      ['error', 'net::ERR_ABORTED 404'],
      ['warning', 'deprecated API'],
      ['log', 'loaded'],
    ])
  })

  it('records uncaught exceptions as errors', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(3)
    emit(listeners, 3, 'Runtime.exceptionThrown', {
      exceptionDetails: { exception: { description: 'TypeError: x is not a function' } },
    })
    expect(mod.getConsoleEntries(3).map((e) => e.text)).toEqual([
      'TypeError: x is not a function',
    ])
  })
})

describe('getConsoleEntries', () => {
  it('defaults to errors-only (error + warning, no plain logs)', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(4)
    emit(listeners, 4, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'noise' }] })
    emit(listeners, 4, 'Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'w1' }] })
    emit(listeners, 4, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'e1' }] })
    expect(mod.getConsoleEntries(4).map((e) => e.text)).toEqual(['w1', 'e1'])
    expect(mod.getConsoleEntries(4, 'all').map((e) => e.text)).toEqual(['noise', 'w1', 'e1'])
  })

  it('returns [] for a tab without a monitor', async () => {
    const { mod } = await loadFreshModule()
    expect(mod.getConsoleEntries(99, 'all')).toEqual([])
  })

  it('keeps only the newest 200 entries', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(5)
    for (let i = 0; i < 205; i += 1) {
      emit(listeners, 5, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: `m${i}` }] })
    }
    const all = mod.getConsoleEntries(5, 'all')
    expect(all.length).toBe(200)
    expect(all[0]!.text).toBe('m5')
    expect(all[199]!.text).toBe('m204')
  })
})

describe('attach resilience', () => {
  it('tolerates "already attached" and still records', async () => {
    const { mod, listeners } = await loadFreshModule(
      new Error('Another debugger is already attached to this target'),
    )
    await mod.ensureTabMonitor(6)
    emit(listeners, 6, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'e2' }] })
    expect(mod.getConsoleEntries(6).map((e) => e.text)).toEqual(['e2'])
  })

  it('treats other attach failures as no monitor (best-effort)', async () => {
    const { mod, listeners } = await loadFreshModule(new Error('Permission denied'))
    await mod.ensureTabMonitor(7)
    emit(listeners, 7, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'x' }] })
    expect(mod.getConsoleEntries(7, 'all')).toEqual([])
  })
})

describe('drainConsoleEntries (action-observation path)', () => {
  it('still yields only fresh errors, consumed once — logs invisible', async () => {
    const { mod, listeners } = await loadFreshModule()
    await mod.ensureTabMonitor(8)
    emit(listeners, 8, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'noise' }] })
    emit(listeners, 8, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'E1' }] })
    expect(mod.drainConsoleEntries(8).map((e) => e.text)).toEqual(['E1'])
    expect(mod.drainConsoleEntries(8)).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试，确认按预期失败**

Run: `pnpm exec vitest run tests/cdp-console-log.spec.ts`
Expected: FAIL——首个用例即报 `mod.getConsoleEntries is not a function`（当前模块不导出它，且 log 级别被丢弃）。

- [ ] **Step 3: 实现监控器改动**

对 `src/background/cdp-monitor.ts` 做 4 处修改：

(a) 缓冲容量（第 28 行）：

```ts
const MAX_CONSOLE_ENTRIES = 200
```

(b) `ConsoleEntry` 接口（第 31-35 行）扩级：

```ts
export interface ConsoleEntry {
  level: 'error' | 'warning' | 'log'
  text: string
  at: number
}
```

(c) 事件路由中两个分支改为全级别捕获（`chrome.debugger.onEvent.addListener` 内，原 145-166 行）。注意 `Runtime.consoleAPICalled` 分支跳过 `clear/profile/profileEnd` 三种控制类型——它们没有可读文本，会渲染成空条目；其余非 error/assert/warning 一律记 log：

```ts
    if (method === 'Runtime.consoleAPICalled') {
      const type = String(p?.type ?? '')
      // Control types without message text would render as empty entries.
      if (type === 'clear' || type === 'profile' || type === 'profileEnd') return
      const level: ConsoleEntry['level'] =
        type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : 'log'
      const args = Array.isArray(p?.args) ? (p!.args as { value?: unknown; description?: string }[]) : []
      const text = args
        .map((arg) => arg.description ?? (arg.value === undefined ? '' : String(arg.value)))
        .join(' ')
        .slice(0, 300)
      push(monitor.console, MAX_CONSOLE_ENTRIES, { level, text, at: Date.now() })
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = p?.entry as { level?: string; text?: string } | undefined
      const raw = entry?.level
      if (!raw) return
      push(monitor.console, MAX_CONSOLE_ENTRIES, {
        level: raw === 'error' ? 'error' : raw === 'warning' ? 'warning' : 'log',
        text: String(entry?.text ?? '').slice(0, 300),
        at: Date.now(),
      })
      return
    }
```

`Runtime.exceptionThrown` 分支（原 167-172 行）不动。

(d) 文件末尾（`getRecentRequests` 之后）新增导出：

```ts
/**
 * Recent console entries for the tab (newest last). `level: 'errors'`
 * (default) keeps only error/warning entries; 'all' returns everything
 * captured, including plain log/info/debug output.
 */
export function getConsoleEntries(
  tabId: number,
  level: 'errors' | 'all' = 'errors',
): ConsoleEntry[] {
  const monitor = monitors.get(tabId)
  if (!monitor) return []
  const list = level === 'all' ? monitor.console : monitor.console.filter((e) => e.level !== 'log')
  return list.map((e) => ({ ...e }))
}
```

`drainConsoleEntries`（观察流用）**保持原样**——仍只吐 error，测试里已锁定该语义。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/cdp-console-log.spec.ts`
Expected: PASS（全部用例）；再跑 `pnpm typecheck` 确认无类型错误。

- [ ] **Step 5: 提交**

```bash
git add tests/cdp-console-log.spec.ts src/background/cdp-monitor.ts
git commit -m "feat(monitor): 被动捕获全部 console 级别并导出 getConsoleEntries"
```

---

### Task 2: i18n 双语词条

**Files:**
- Modify: `src/lib/i18n.ts`（三处：`Messages` 接口 ~390 行、en 字典 ~1011 行、zh-CN 字典 ~1596 行）

**背景知识：** `Messages` 是全部文案键的 TS 接口（en 是键的来源），下方有两个字典对象 `en` 与 `zh-CN`。`tests/i18n.spec.ts` 运行时比对双语言键集合一致性并检查无空文案。文案风格沿用现有约定：en 警告用 "When off: ..." 前缀，zh 用 "关闭后：..."。

- [ ] **Step 1: `Messages` 接口加键**（紧跟 `toolNetworkRequestsWarn: string` 之后，第 390 行后插入）

```ts
  toolConsoleLog: string
  toolConsoleLogWarn: string
```

- [ ] **Step 2: en 字典加词条**（紧跟 `toolNetworkRequestsWarn` 的 en 值之后，第 1011 行后插入）

```ts
  toolConsoleLog: 'Read browser console logs',
  toolConsoleLogWarn:
    'When off: the assistant cannot inspect console errors or logs when debugging page issues.',
```

- [ ] **Step 3: zh-CN 字典加词条**（紧跟 `toolNetworkRequestsWarn` 的 zh 值之后，第 1596 行后插入）

```ts
  toolConsoleLog: '查看控制台日志',
  toolConsoleLogWarn: '关闭后：助手无法查看页面控制台的报错与日志，排查页面脚本问题会变难。',
```

- [ ] **Step 4: 验证**

Run: `pnpm exec vitest run tests/i18n.spec.ts && pnpm typecheck`
Expected: PASS（键集合一致、无空文案）、typecheck 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/lib/i18n.ts
git commit -m "feat(i18n): 控制台日志工具的双语词条 toolConsoleLog"
```

---

### Task 3: 工具目录元数据

**Files:**
- Modify: `src/lib/tool-catalog.ts`（`TOOL_META` 数组，第 53-57 行 `list_network_requests` 条目之后）

**背景知识：** 设置页（`SettingsTab.tsx`）直接遍历 `TOOL_META` 渲染工具开关列表，无需改动 UI 组件。`tests/tool-config.spec.ts` 校验 `TOOL_META` 覆盖 agent 声明的每个工具、无重复、label/warning 键非空。

- [ ] **Step 1: 在 `list_network_requests` 条目后插入**

```ts
  {
    name: 'list_console_messages',
    category: 'read',
    labelKey: 'toolConsoleLog',
    warningKey: 'toolConsoleLogWarn',
  },
```

- [ ] **Step 2: 验证**

Run: `pnpm exec vitest run tests/tool-config.spec.ts && pnpm typecheck`
Expected: PASS、typecheck 无错误（`toolConsoleLog` 键在 Task 2 已存在）。

- [ ] **Step 3: 提交**

```bash
git add src/lib/tool-catalog.ts
git commit -m "feat(catalog): 注册 list_console_messages 工具元数据"
```

---

### Task 4: agent 工具 schema + dispatch + 审计描述

**Files:**
- Modify: `src/background/agent.ts`（四处：import 块 ~86-91 行、`TOOLS` 数组 ~575 行后、`describeAction` ~1247 行后、dispatch switch ~1643 行后）

**背景知识：** `TOOLS` 是发给模型 OpenAI 风格的工具 schema 数组；dispatch 是 `executeToolCall` 的 switch（`args: Record<string, unknown>`，返回 JSON 字符串）。审批集合 `ACTION_TOOLS`/`READ_TOOLS` **都不加**本工具——`needsConfirmation` 对两者之外的名称恒为 false，即任何模式不弹审批、只读模式可用。`describeAction` 在执行审计路径（recordAction）被调用，现有 `default: return name` 兜底，加 case 仅为历史记录可读性。

- [ ] **Step 1: import 加 `getConsoleEntries`**（`./cdp-monitor` import 块，第 86-91 行，改为）

```ts
import {
  drainConsoleEntries,
  ensureTabMonitor,
  getConsoleEntries,
  getRecentRequests,
  waitForNetworkIdle,
} from './cdp-monitor'
```

- [ ] **Step 2: `TOOLS` 数组加 schema**（紧跟 `list_network_requests` 条目之后，原 575 行 `},` 后插入）

```ts
  {
    type: 'function',
    function: {
      name: 'list_console_messages',
      description:
        'List recent browser console messages of the active tab (errors and warnings by default; pass level:"all" to also see log/info/debug). Only captures output emitted after the monitor attached, so run an action first when debugging. Read-only; no approval needed.',
      parameters: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['errors', 'all'],
            description:
              "'errors' (default) returns error and warning entries; 'all' returns every captured entry including log/info/debug.",
          },
        },
      },
    },
  },
```

- [ ] **Step 3: `describeAction` 加可读 case**（紧跟 `case 'snapshot_page':` 的 return 之后，原 1247 行后插入）

```ts
    case 'list_console_messages':
      return 'Read browser console messages'
```

- [ ] **Step 4: dispatch switch 加 case**（紧跟 `case 'list_network_requests'` 块的结束 `}` 之后、`case 'list_tabs':` 之前，原 1643 行后插入）

```ts
    case 'list_console_messages': {
      throwIfAborted()
      // Reads the passive CDP monitor's console buffer; attaching here
      // (best-effort) makes the tool useful even when called before any
      // action ran. Never requires approval: pure read of an in-memory buffer.
      const tab = await resolveAutomationTab(undefined, ctx.scope)
      if (!tab || typeof tab.id !== 'number') {
        return JSON.stringify({ ok: false, error: '没有可读取的标签页。' })
      }
      await ensureTabMonitor(tab.id)
      const level = args.level === 'all' ? 'all' : 'errors'
      const messages = getConsoleEntries(tab.id, level)
      return JSON.stringify({
        ok: true,
        messages,
        count: messages.length,
        ...(messages.length === 0
          ? {
              note:
                'No console messages captured yet. The monitor only sees output emitted after it attached — run an action first, then call again.',
            }
          : {}),
      })
    }
```

- [ ] **Step 5: 验证**

Run: `pnpm exec vitest run tests/tool-config.spec.ts && pnpm typecheck`
Expected: PASS（`TOOLS` 与 `TOOL_META` 覆盖校验含新工具）、typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/background/agent.ts
git commit -m "feat(agent): 新增 list_console_messages 只读控制台日志工具"
```

---

### Task 5: MCP 兜底清单同步

**Files:**
- Modify: `examples/local-agent/mcp-server.mjs`（`STATIC_TOOLS` 数组，第 337 行 `list_network_requests` 条目之后）

**背景知识：** 该文件是本地 MCP 适配器（stdio），插件离线时 `tools/list` 回落到 `STATIC_TOOLS` 静态清单；插件在线时工具列表由扩展实时上报（自动含新工具）。`tests/mcp-tools-format.spec.ts` 只断言 `tools.length >= 23`，加条目安全。

- [ ] **Step 1: 加兜底条目**（原 337 行后插入）

```js
  { name: 'list_console_messages', description: 'List recent console messages of the active tab (errors/warnings by default; pass level:"all" for every log).', properties: { level: { type: 'string' } } },
```

- [ ] **Step 2: 验证**

Run: `pnpm exec vitest run tests/mcp-tools-format.spec.ts`
Expected: PASS（工具数断言 `>= 23` 仍成立，wire 格式不变）。

- [ ] **Step 3: 提交**

```bash
git add examples/local-agent/mcp-server.mjs
git commit -m "feat(mcp): STATIC_TOOLS 兜底清单补充 list_console_messages"
```

---

### Task 6: 全量验证

**Files:** 无新改动（如有回归则修复后重跑）

- [ ] **Step 1: 全量类型检查与测试**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 两个 tsconfig 均无错误；全部 vitest 用例 PASS（含既有 76 个 spec 与新增 `tests/cdp-console-log.spec.ts`）。

- [ ] **Step 2: 构建冒烟**

Run: `pnpm build`
Expected: vite 构建成功（确认扩展产物可打包，无新工具引入的打包错误）。

- [ ] **Step 3:（如有修复）提交**

```bash
git add -A
git commit -m "fix: 控制台日志工具全量验证修复"
```

无修复则跳过本步。

---

## 自审记录

1. **规格覆盖**：设计文档 2.1（监控器）→ Task 1；2.2（agent 工具 + 审批）→ Task 4；2.3（目录 + i18n）→ Task 2/3；2.4（MCP 兜底）→ Task 5；2.5（错误边界：无标签页/附加失败/容量/截断）→ Task 1 测试与 Task 4 dispatch；2.6（测试）→ Task 1 + 既有 spec 自动校验。无缺口。
2. **占位符**：所有代码步骤均为完整代码，无 TBD/TODO。
3. **类型一致性**：`getConsoleEntries(tabId, level)` 在 Task 1 定义、Task 4 import 使用，签名一致；`ConsoleEntry.level` 联合类型在 Task 1 收窄后，`drainConsoleEntries` 的 `e.level === 'error'` 过滤与 `captureObservation` 的 `[${entry.level}]` 模板均兼容；i18n 键名 `toolConsoleLog`/`toolConsoleLogWarn` 在 Task 2/3/4 间一致。
