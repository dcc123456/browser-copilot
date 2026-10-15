# Firefox 支持 · Firefox support for the extension — design

日期：2026-10-15。范围：`src/`（扩展）的 Firefox 128+ 兼容构建与运行时降级；`server/`（Playwright Runner）与浏览器无关，不在本轮。
关联：`manifest.config.ts`、`vite.config.ts`、`AGENTS.md` §5.6（禁止第三条驱动路径）。`docs/ai-debug-success-rate-v3.md` 的 verified 口径不受影响（FF 不参与 bench）。

## 1. 需求原文 · Requested behaviour

"让这个项目也支持火狐浏览器"。目标形态：`pnpm build:firefox` 产出 `dist-firefox/`，在 Firefox 128+
经 `about:debugging#/runtime/this-firefox` 临时加载即可使用核心链路（读页面、聊天、跑工作流、本地桥、
侧栏面板），Chrome 独占能力（CDP、离屏文档、OCR）按能力降级并给出明确路径，而不是整体不可用。

## 2. 现状取证 · Evidence about the current code

1. 构建：vite + `@crxjs/vite-plugin`（`vite.config.ts:35`），`build.target: 'chrome116'`，产物
   `dist/`（OCR）与 `dist-no-ocr/`（`vite.config.ts:27-29`）；manifest 由 `manifest.config.ts` 的
   `defineManifest` 函数在构建期生成（`service_worker` + `type:'module'`，`manifest.config.ts:120-123`）。
2. Chrome 独占 API 面（侦察计数）：`chrome.debugger` 31 处（真实调用仅 `driver.ts:844/855/864`、
   `cdp-monitor.ts`，且已有 `if (chrome.debugger)` 门控 `driver.ts:607/645/674/714`、`cdp-monitor.ts:151`）；
   `chrome.sidePanel` 5 处（`index.ts:766/778/780/935/936`）；`chrome.offscreen` 2 处
   （`driver.ts:1544/1553`，剪贴板 + Tesseract worker）。
3. 其余 API 面均为 Firefox 已实现：`tabs`/`scripting`（全部 `executeScript`，含 `world:'MAIN'`
   `driver.ts:959/1050`）/`alarms`/`storage`（含 `session`）/`cookies`/`downloads`/`webNavigation`/
   `contextMenus`/`notifications`（`executors.ts:1842`，存在性门控）/`action` badge（`record-controller.ts:53`）。
4. 调用风格：129 处 `await chrome.*`（promise 优先），仅 `run-workflow.ts:394` 一处回调式；
   `typeof chrome` 守卫 21 处（已 grep）。`src/inpage/kernel.ts` 运行期零 `chrome.*` 引用（注释除外）。
5. FS Access：`showSaveFilePicker`（`App.tsx:231`）、`showDirectoryPicker`（`SettingsTab.tsx:557`、
   `fs-store.ts:847` 已有能力探测）；`download-dir.ts:115` 已存在"无需 picker"的兜底路径。
6. 测试：53 个 spec 各自 `vi.stubGlobal('chrome', makeChromeMock())`；vitest 走根 `vite.config.ts`，
   与新增的 FF 构建配置互不干扰。
7. `src/lib/pages.ts:21` 有 `'chrome-extension://'` 前缀字符串（扩展页识别表）。

## 3. 外部取证 · Firefox 平台事实（§7.1 一手来源）

| #   | 事实                                                                                                                                                                                                | 来源                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Firefox 不实现 `background.service_worker`（bug 1573659）；MV3 用 `background.scripts` 事件页；FF 121+ 起即使 manifest 同时写了 `service_worker` 也照常按 `scripts` 启动；`"type": "module"` 受支持 | MDN `manifest.json/background`                                           |
| 2   | Firefox 没有 `sidePanel`/`side_panel`；等价物为 `sidebar_action` + `sidebarAction` API，二者互不兼容；sidebarAction 无 badge 方法                                                                   | MDN `sidebarAction`；Extension Workshop MV3 迁移指南                     |
| 3   | `sidebarAction.open()` 只能在用户手势（user action）处理器内调用                                                                                                                                    | MDN `sidebarAction/open`                                                 |
| 4   | Firefox 不实现 `debugger`(CDP) API（bug 1316741）                                                                                                                                                   | MDN Chrome incompatibilities                                             |
| 5   | Firefox 不实现 offscreen documents                                                                                                                                                                  | Extension Workshop MV3 迁移指南                                          |
| 6   | Firefox 的 `chrome.*` 命名空间为回调式；`browser.*` 原生返回 Promise。FF 无需 polyfill（polyfill 只为"Chrome 用 browser.*"而存在）                                                                  | MDN Chrome incompatibilities                                             |
| 7   | `scripting.executeScript` 的 `world:'MAIN'` 自 Firefox 128 支持                                                                                                                                     | MDN BCD `webextensions/api/scripting.json`（version_added: firefox 128） |
| 8   | Firefox 127+ 安装时即授予 host permissions（此前需用户手动开启）                                                                                                                                    | Extension Workshop MV3 迁移指南                                          |

## 4. 选型与证据 · Options considered

| 候选                                                                      | 处置     | 理由                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 全量重写为 `browser.*` + webextension-polyfill                         | **否决** | 400+ 调用点改写 + 新增运行时依赖；而 Firefox 原生就提供 promise 版 `browser.*`，polyfill 的价值只在"Chrome 侧模拟 browser"，与本需求无关。                                                              |
| B. 运行时 shim 覆盖 `globalThis.chrome`                                   | **否决** | 依赖 FF 全局 `chrome` 可写且执行时序正确，行为不可靠；且无法处理"回调式 chrome 对象被误用"的语义混杂。                                                                                                  |
| C. 构建期 define `chrome → browser` + 独立 FF manifest + 少量手写兼容分支 | **采纳** | 零调用点重写、零新依赖；编译期确定性替换。已复核边界：无 `globalThis.chrome`/`self.chrome`/`window.chrome` 直接引用；无名为 `browser` 的局部变量；字符串里的 `'chrome-extension://'` 不受 define 影响。 |

被否决后仍保留的一条：`typeof chrome` 守卫在 FF 构建下自然变为 `typeof browser`（FF 全局存在）→ 语义等价，无需逐处改写。

## 5. 设计 · Design

### 5.1 构建目标 · `dist-firefox/`

- 单一编排脚本 `scripts/build-firefox.ts`（Node 24 直接运行 TS；根 tsconfig 加
  `allowImportingTsExtensions` 并把它纳入 include）用 vite JS API 顺序执行三段构建
  （全部 `configFile: false`，同一 outDir；首段 `emptyOutDir: true` 并拷 `public/`，内容脚本两段
  `emptyOutDir: false` + `copyPublicDir: false`）：
  1. 页面 + background：html 入口 `src/sidepanel/index.html`、`src/workflow-editor/index.html`
     （输出路径保持 `src/...`，`runtime.getURL` 与 `sidebar_action.default_panel` 不变），background
     作 ESM 入口（`entryFileNames` 固定 `background.js`，其余 chunk 走 assets 哈希）；
     `build.target 'firefox128'`、`modulePreload: false`；**不构建** `src/offscreen/index.html`。
  2. `content-kernel.ts`、`floating-button.ts` 各以 lib 模式（IIFE）建单文件产物
     `content-kernel.js` / `floating-button.js` —— FF 的 `content_scripts` 是经典脚本，不能带 import。
- 三段共享同一份 `define { chrome: 'browser', __OCR__: false, __BUILD_STAMP__ }`。
- 随后：写 `manifest.json`、删 `tesseract/`（FF 构建即 no-ocr 语义）、断言产物清单存在、失败即非零退出。
- `package.json` 新增 `"build:firefox": "node scripts/build-firefox.ts"`；`.gitignore` 加 `dist-firefox/`。

### 5.2 manifest 变体（锁步 · §5.2）

抽取 `scripts/manifest-shared.ts`（Node/TS 双端可 import 的可擦除语法），输出两侧必须一致的部分：
`VERSION`、`name/short_name/description/author/homepage_url`、`icons`、`content_scripts` 源与匹配、
`web_accessible_resources`、共同权限集。`manifest.config.ts`（Chrome）与 `scripts/manifest-firefox.ts`
（纯函数，构建脚本与测试共用）都从它组装。

| 键                        | Chrome（现状不变）                                   | Firefox                                                                   |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `background`              | `service_worker` + `type:'module'`                   | `scripts:['background.js']` + `type:'module'`（事件页）                   |
| 面板                      | `side_panel.default_path`                            | `sidebar_action.default_panel`（含 title/icon）                           |
| `permissions`             | 现状全量                                             | 去掉 `sidePanel`/`offscreen`/`debugger`，其余一致                         |
| `host_permissions`        | `<all_urls>` + http/https + ws:// 三条（可读性注释） | 仅 `<all_urls>`（FF 构建剥离 ws:// 条目）                                 |
| `minimum_chrome_version`  | `'116'`                                              | 无；改 `browser_specific_settings.gecko.{id, strict_min_version:'128.0'}` |
| `content_security_policy` | OCR 版含 `'wasm-unsafe-eval'`                        | `script-src 'self'; object-src 'self'`（FF 构建无 wasm）                  |
| `version_name`            | no-ocr 变体标记                                      | 省略（FF 无此语义）                                                       |

`tests/firefox-manifest.spec.ts` 做机检：两侧共享字段逐项相等；FF manifest 不含
`service_worker`/`side_panel`/`debugger`/`minimum_chrome_version`，含 `sidebar_action` 与 gecko id。

### 5.3 命名空间别名

`define: { chrome: 'browser' }` 仅作用于 FF 构建产物；根 `vite.config.ts` 与 vitest 不受影响（测试仍
stub `chrome`）。`src/lib/pages.ts` 的扩展页前缀表补 `'moz-extension://'`（纯字符串，唯一需要手改的
lib 处）。

### 5.4 运行时兼容（手改，最小面）

1. **侧栏打开**（`background/index.ts:766/768-788/925-951`）：新增 `openSidePanel({windowId?,tabId?})`
   helper —— `chrome.sidePanel?.open` 优先，否则 `chrome.sidebarAction.open()`；`setPanelBehavior`
   调用改为存在性门控。点击工具栏图标是用户手势，满足 §3.3。
2. **剪贴板**（`driver.ts:1539-1579`）：`chrome.offscreen` 不存在时走 FF 直连 —— 读
   `navigator.clipboard.readText()`（FF 事件页是真实 DOM 页 + `clipboardRead` 权限），写
   `navigator.clipboard.writeText()`，失败兜底 textarea + `execCommand('copy')`；不用
   `browser.clipboard`（FF 127+ 才有且仅 readText，换取 128 下限内的统一路径）。失败抛含文案的 DriverError。
3. **CDP 四能力**（信任输入 / 闭合 shadow / CSP-eval / console+network 监控）：既有 `if (chrome.debugger)`
   门在 FF 下自动为 false → 优雅降级。实现期逐点复核门内无裸调用（`driver.ts:844/855/864` 与
   `cdp-monitor.ts` 的 `onEvent` 注册均在门内）。
4. **OCR**：FF 构建 `__OCR__=false`，UI 经既有 `OCR_SUPPORTED` 置灰；不构建 offscreen 页。
5. **FS Access**：复核 `SettingsTab.tsx:557`、`App.tsx:231` 调用点先做能力探测，缺能力走既有
   downloads 兜底（`export-answer.ts:387` 已有探测样例）/明确报错文案。
6. **keepalive**（`keepalive.ts:41-52`，Chrome SW `getPlatformInfo` 保活）：FF 事件页门控或保留无害，
   真机实测后定稿。

### 5.5 能力矩阵（本轮口径）

| 能力                  | Chrome              | Firefox 128+ 本轮          |
| --------------------- | ------------------- | -------------------------- |
| 侧栏面板              | `sidePanel`         | `sidebar_action` ✓         |
| 读/写页面（内核注入） | ✓                   | ✓（`world:'MAIN'` ≥128）   |
| 工作流运行            | ✓                   | ✓                          |
| 运行期信任输入        | CDP 增强            | 降级为既有合成事件路径     |
| 闭合 shadow DOM 深读  | CDP 增强            | 降级（开放 shadow 仍可读） |
| 页面 console/网络监控 | CDP                 | 不可用（明确降级）         |
| 剪贴板算子            | 离屏文档            | 事件页直连                 |
| OCR                   | 离屏 + Tesseract    | 关闭（UI 置灰）            |
| 截图                  | `captureVisibleTab` | ✓                          |
| 本地 WS 桥            | ✓                   | ✓（事件页可开 WS）         |
| 另存为 / 下载目录     | FS Access           | 既有 downloads 兜底        |

### 5.6 不做的事

- **不新增第三条浏览器驱动路径**（§5.6 红线）：FF 与 Chrome 共用同一 `driver.ts`（`chrome.scripting`
  注入内核）；CDP 只是门控增强层，FF 上为 no-op。
- Runner（`server/`）不动：Playwright 自身支持 Firefox，与本轮解耦。
- 不改 `src/lib/**` 的 chrome-free 红线（`pages.ts` 前缀表是纯字符串表，唯一例外）。

## 6. 风险与开放项

- **floating.expand 无用户手势**：内容脚本消息触发的 `sidebarAction.open()` 预计被拒（用户手势不跨
  `runtime.sendMessage` 传播）。本轮 = 尝试打开、失败记明确日志；Phase 2 给浮动按钮加双语提示
  （"点击工具栏图标重新打开面板"）。真机实测确认。
- **事件页生命周期 vs 长任务/WS 保活**：FF 事件页在 WS 打开期间是否保活待实测；`alarms` 已具备唤醒。
- **captureVisibleTab / contextMenus / notifications** 在 FF MV3 的细节行为待真机验证。
- **AMO 上架**（签名、gecko.id 固定、新版 `data_collection_permissions`）不在本轮，仅临时加载。

## 7. 验证计划（§收尾自检）

- 本地门禁：`pnpm typecheck` / `test` / `lint` / `format:check` / `build`（Chrome 产物不变）。
- FF 构建：`pnpm build:firefox` 产物清单 + `node scripts/verify-injected-functions.mjs`。
- 静态验证：`npx web-ext lint --source-dir dist-firefox`（Mozilla 官方校验器，无需本机 Firefox）。
- 真机：本机未装 Firefox（`/Applications` 只有 Chrome）——安装后 `web-ext run` 或 about:debugging
  临时加载走核心链路；不安装则如实标 BLOCKED。
