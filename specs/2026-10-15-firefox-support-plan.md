# Firefox 支持 · Firefox support — plan

日期：2026-10-15。关联：`specs/2026-10-15-firefox-support-design.md`（本计划实现的即该设计的 §5）。

## 步骤

### Step 1 — 共享 manifest 源（锁步）

- 新建 `scripts/manifest-shared.ts`：`VERSION`、name/short_name/description/author/homepage_url、`ICONS`、
  `CONTENT_SCRIPTS`（matches/run_at/all_frames/源路径）、`WEB_ACCESSIBLE_RESOURCES`、`COMMON_PERMISSIONS`。
- `manifest.config.ts` 改为消费共享源，Chrome 产物保持不变。
- 验收：`pnpm build` 后 `dist/manifest.json` 与改动前逐字段等价（diff 只看路径/权限/版本）。

### Step 2 — FF 构建目标

- `scripts/build-firefox.ts`（Node 24 直接运行 TS）：vite JS API 三段构建（页面+background ESM /
  content-kernel IIFE / floating-button IIFE；`configFile:false`、`target 'firefox128'`、
  `outDir dist-firefox`、`modulePreload:false`、`define {chrome:'browser', __OCR__:false, __BUILD_STAMP__}`）。
  不构建 offscreen。manifest 组装抽到 `scripts/manifest-firefox.ts`（纯函数，测试共用）。
- 收尾：写 FF `manifest.json`（`browser_specific_settings.gecko.id='browser-copilot@dcc123456.github.io'`、
  `strict_min_version:'128.0'`、`sidebar_action`、权限裁剪）→ 删 `tesseract/` → 断言产物清单 → 失败非零退出。
- `package.json`：`"build:firefox": "node scripts/build-firefox.ts"`；`.gitignore`：`dist-firefox/`。
- 验收：`pnpm build:firefox` 输出符合设计 §5.1/§5.2 的目录与 manifest。

### Step 3 — 运行时兼容最小面（设计 §5.4）

1. `background/index.ts`：`openSidePanel()` helper + `setPanelBehavior` 存在性门控。
2. `driver.ts`：剪贴板无 offscreen 分支（事件页直连 + execCommand 兜底）。
3. `pages.ts`：扩展页前缀表补 `'moz-extension://'`。
4. 复核：CDP 门内无裸调用；`SettingsTab.tsx:557` / `App.tsx:231` 的能力探测；`keepalive.ts` FF 行为。

- 验收：`pnpm typecheck` + 全量 spec 绿（既有行为零回归）。

### Step 4 — 锁步守卫测试

- `tests/firefox-manifest.spec.ts`：两侧共享字段相等；FF manifest 禁区/必备键断言。
- 验收：`pnpm test` 通过。

### Step 5 — 门禁与静态验证

- `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm build && pnpm build:firefox`，
  `pnpm verify:injected`，`npx web-ext lint --source-dir dist-firefox`（记录告警面与豁免理由）。
- 证据落点：命令输出粘贴进回复；web-ext lint 退出码。

### Step 6 — 真机 Firefox（待裁定，本机未安装）

- 安装 Firefox 后：`about:debugging#/runtime/this-firefox` 临时加载 `dist-firefox/` → 查 background 无错
  → 工具栏点击开侧栏 → 打开一个网页让助手读页面 → 跑一条工作流 → 本地桥（agent-client）连通。
- 不安装则如实标 BLOCKED，不假装全绿。

## 本轮不做（登记，防遗忘）

- AMO 签名/上架、`data_collection_permissions`、README（en+zh）Firefox 安装说明、CI 加 FF job、
  selftest 适配 FF、floating.expand 手势拒绝后的双语提示、OCR 在事件页的重建。

## 验收口径

- Chrome 侧零回归：既有门禁全绿，`dist/manifest.json` 语义不变。
- FF 侧：`dist-firefox/` 可被 Mozilla 官方 lint 通过（error 级为零），manifest 与源码锁步有测试守卫；
  真机结论按 Step 6 的两种口径之一如实记录。

## 验证记录（2026-10-15，本机）

- `pnpm typecheck` ✓；`pnpm test` 361 文件 / 4135 用例全绿（含新增 `tests/firefox-manifest.spec.ts` 8 例）。
  同步修掉一处回归：`tests/fs-store.spec.ts` 的 `unlimitedStorage` 断言原为"读 `manifest.config.ts` 源文本正则"，
  改为断言解析后的 manifest 对象，以适配权限迁入 `COMMON_PERMISSIONS` 展开。
- `pnpm build`（Chrome）✓ 语义不变；`pnpm build:firefox` ✓（`dist-firefox/` 7 个必需路径断言通过）。
- tracked 文件门禁：eslint 0 errors（20 条既有 warning）；prettier 全绿——本地 `pnpm format:check`
  报红仅因未跟踪的 `server/data/**` 与 `server/workflows.json`，属既有基线（tracked 数为 0）。
- `pnpm verify:injected` ✓（20 个注入函数、24 处调用点全部自包含）。
- `npx web-ext lint --source-dir dist-firefox` 退出码 0：errors 0 / warnings 29。
  UNSUPPORTED_API 11 条全部落在运行期有 `typeof` 门控的 `debugger.*`、`offscreen.*`（设计 §5.5 的降级面）；
  sidePanel 相关告警已经由本地类型视图重构消除；DANGEROUS_EVAL 8 / UNSAFE_VAR_ASSIGNMENT 9 /
  MISSING_DATA_COLLECTION_PERMISSIONS 1 属既有代码或本轮不做项（AMO 上架相关）。
- Step 6 真机 Firefox：本机未安装 Firefox → 该项 **BLOCKED**，未假装验证。
