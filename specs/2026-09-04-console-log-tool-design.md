# 设计：`list_console_messages` 控制台日志查看工具

日期：2026-09-04
状态：已确认（用户已批准设计与方案 A）

## 背景与目标

browser-copilot 的智能体（`src/background/agent.ts`）可以读写页面、查看网络请求，但没有按需查看浏览器控制台输出的能力。现有基础设施 `src/background/cdp-monitor.ts` 已经通过 `chrome.debugger` 被动监听每个标签页的 CDP 事件，但只保留 error/warning 级别的控制台条目，普通 `log/info/debug` 被丢弃，且没有任何工具能读取这些数据（`drainConsoleEntries` 只在 action 后的观察里悄悄附带最新 error）。

目标：新增一个只读智能体工具 `list_console_messages`，让助手在排查页面报错时能按需查看控制台输出。

**用户确认的需求决策：**

1. 抓取全部级别（log/info/warning/error/debug），但工具默认只返回报错（error/warning），通过参数查看全部。
2. 审批策略：完全不弹审批（不加入 `ACTION_TOOLS` / `READ_TOOLS`），任何模式下直接可读。
3. 实现方案：方案 A —— 扩展现有 CDP 被动监控器 + 新增只读工具，与 `list_network_requests` 同构。

## 方案取舍（已否决的备选）

- **方案 B（只暴露现有 error/warning 缓冲）**：改动最小，但普通 `console.log` 不可见，与需求 1 矛盾。否决。
- **方案 C（页面注入 console 钩子）**：包装 `console.*` 转发后台。不依赖 debugger 附加，但需要 content script + 消息通道的生命周期链路，无法捕获 document_start 之前的日志，且侵入被测页面，与项目既有 CDP 模式相悖。否决。

## 详细设计

### 2.1 监控器改动（`src/background/cdp-monitor.ts`）

- `ConsoleEntry.level` 类型扩为 `'error' | 'warning' | 'log'`。
- `Runtime.consoleAPICalled`：`error` → error，`warning` → warning，`assert` → error，其余类型（log/info/debug/dir/dirxml/table/trace/startGroup 等）→ log，不再丢弃。
- `Log.entryAdded`：接受全部级别；error/warning 之外记为 log。
- `Runtime.exceptionThrown`：不变，仍记为 error。
- `MAX_CONSOLE_ENTRIES` 50 → 200：防止聊天式页面的普通日志把报错挤出缓冲。文本仍截断 300 字符。
- `drainConsoleEntries`（action 观察专用）语义不变：仍只吐 error 级别、按游标去重。观察流行为不受影响。
- 新增导出 `getConsoleEntries(tabId, level)`：
  - `level === 'errors'`（默认语义）→ 返回 error + warning 条目；
  - `level === 'all'` → 返回全部条目；
  - 返回条目的拷贝（与 `getRecentRequests` 一致），newest last。

### 2.2 新工具（`src/background/agent.ts`）

- 名称：`list_console_messages`（与 chrome-devtools-mcp 命名一致，cdp-monitor 模块注释中已引用此名）。
- Schema：

  ```json
  {
    "name": "list_console_messages",
    "description": "List recent browser console messages of the active tab (errors and warnings by default; pass level:\"all\" to also see log/info/debug). Only captures output after the monitor attached, so run an action first when debugging. Read-only; no approval needed.",
    "parameters": {
      "type": "object",
      "properties": {
        "level": {
          "type": "string",
          "enum": ["errors", "all"],
          "description": "'errors' (default) returns error and warning entries; 'all' returns every captured entry including log/info/debug."
        }
      }
    }
  }
  ```

- Dispatch（与 `list_network_requests` 同构）：
  1. `resolveAutomationTab(undefined, ctx.scope)` 解析当前自动化标签页；无标签页 → `{ ok: false, error: '没有可读取的标签页。' }`。
  2. `await ensureTabMonitor(tab.id)`（尽力附加，失败不阻断——缓冲里可能已有既有内容）。
  3. `getConsoleEntries(tab.id, level)` 读缓冲。
  4. 返回 `{ ok: true, messages: [{ level, text, at }], count }`；缓冲为空时附 note 说明可能尚无输出或监控器附加前日志不可回补。
- 审批：不加入 `ACTION_TOOLS` 也不加入 `READ_TOOLS` → `needsConfirmation` 恒为 false；只读（readonly）模式可用；chat 模式本就不暴露工具，沿用现状。
- 审计与展示：`describeAction`/`describeDetail` 的 switch 已有 `default: return name` 兜底，类型上无需新 case；顺手加一个 `case 'list_console_messages': return 'Read browser console messages'` 让历史记录更可读（非必需）。

### 2.3 元数据与界面（`src/lib/tool-catalog.ts` + `src/lib/i18n.ts`）

- `TOOL_META` 在 `list_network_requests` 之后插入：

  ```ts
  {
    name: 'list_console_messages',
    category: 'read',
    labelKey: 'toolConsoleLog',
    warningKey: 'toolConsoleLogWarn',
  }
  ```

- i18n（en / zh-CN 各一对，`Messages` 接口同步加键）：
  - `toolConsoleLog`：en `Read browser console logs` / zh `查看控制台日志`
  - `toolConsoleLogWarn`：en `Disabled: the assistant cannot inspect console errors or logs when debugging page issues.` / zh `关闭后：助手无法查看页面控制台的报错与日志，排查页面脚本问题会变难。`
- 设置页（`SettingsTab.tsx`）的工具开关列表读 `TOOL_META` 自动渲染，无需改动。

### 2.4 MCP 兜底清单（`examples/local-agent/mcp-server.mjs`）

`STATIC_TOOLS`（插件离线时 `tools/list` 的静态兜底）追加：

```js
{ name: 'list_console_messages', description: 'List recent console messages of the active tab (errors/warnings by default; pass level:"all" for every log).', properties: { level: { type: 'string' } } },
```

插件在线时工具列表由扩展实时上报，自动包含新工具。

### 2.5 错误处理与边界

| 场景 | 行为 |
| --- | --- |
| 无可读标签页 | `{ ok: false, error: '没有可读取的标签页。' }` |
| debugger 不可用（chrome:// 页、用户拒绝 infobar） | `ensureTabMonitor` 静默失败，返回缓冲现状或空 note；不阻断工具 |
| 监控器附加前的日志 | 无法回补（CDP 固有限制）；工具描述与空结果 note 明示 |
| 缓冲超 200 条 | 丢弃最旧（现有 ring-buffer 行为） |
| 文本超长 | 截断 300 字符（现有行为） |
| 内存 | 仅 service-worker 内存缓冲，不落盘 |

### 2.6 测试

- 新增 `tests/cdp-console-log.spec.ts`：在动态 import 模块前向 `globalThis` 注入 fake `chrome.debugger`（捕获 `onEvent`/`onDetach` 监听器、stub `attach/detach/sendCommand`），覆盖：
  - `Runtime.consoleAPICalled` 各类型 → level 映射（error/assert→error，warning→warning，log/info/debug/table→log）；
  - `Log.entryAdded` 全级别、`Runtime.exceptionThrown` → error；
  - `getConsoleEntries(tabId, 'errors' | 'all')` 过滤行为；
  - 容量 200 淘汰最旧；
  - `drainConsoleEntries` 仍只吐 error、游标去重语义不变。
- 现有测试自动覆盖：
  - `tests/tool-config.spec.ts`：目录覆盖每个已声明工具、无重复、label/warning 键非空；
  - `tests/i18n.spec.ts`：双语言键集合一致、无空文案。
- 验收：`pnpm typecheck` 与 `pnpm test` 全绿。

## 影响面

| 文件 | 改动 |
| --- | --- |
| `src/background/cdp-monitor.ts` | 级别扩展、容量 200、`getConsoleEntries` |
| `src/background/agent.ts` | 工具 schema + dispatch；不进审批集合 |
| `src/lib/tool-catalog.ts` | `TOOL_META` 一条 |
| `src/lib/i18n.ts` | `Messages` 类型 + en/zh 各两条 |
| `examples/local-agent/mcp-server.mjs` | `STATIC_TOOLS` 一条 |
| `tests/cdp-console-log.spec.ts` | 新增 |

不改 `manifest.config.ts`（`debugger` 权限已存在）、不改设置页组件。
