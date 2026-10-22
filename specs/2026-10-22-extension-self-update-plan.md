# Extension self-update (GitHub Releases, zero server) · Plan

日期：2026-10-22  
设计：`specs/2026-10-22-extension-self-update-design.md`

## 0. 范围回顾

只实现 Chrome unpacked（`installType === 'development'`）的覆盖更新：

1. 后台定时查 GitHub Releases → 侧边栏提示。
2. 用户在插件内选择安装目录 → 下载 ZIP → 校验 SHA-256 → 解压覆盖 → Reload 生效。

不实现远端脚本、`.crx` 自托管、商店/Firefox 覆盖更新。

## 1. 实施顺序与文件清单

按“先抽公共能力，再做无 chrome 逻辑，最后接 UI”的顺序推进，每步可独立通过门禁。

### Step 1 — 复用层抽取（先行，避免第二套基础设施）

| 文件                                | 动作 | 说明                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/zip/zip-archive.ts`        | 新增 | 从 `src/lib/workflow/excel-parse.ts` 抽出通用 ZIP reader：EOCD/中央目录解析、`DecompressionStream('deflate-raw')`、解压预算、路径与重复条目校验。导出 `ZipArchive`、`ZipEntryInfo`、`ZipError`（带稳定 `code`）；excel-parse 的错误文案在包装层保持不变。                                   |
| `src/lib/workflow/excel-parse.ts`   | 修改 | 删除内部 ZIP 实现，改用 `ZipArchive`；保留 `SpreadsheetParseError` 与现有错误文案（对 `ZipError.code` 做映射）。行为零变化。                                                                                                                                                                |
| `src/lib/directory-handle-store.ts` | 新增 | 抽出 `fs-store` / `download-dir` 重复的 IndexedDB 逻辑：`readDirectoryHandle(key)`、`writeDirectoryHandle(key, handle)`、`deleteDirectoryHandle(key)`、`openDirectoryDatabase()`。DB 名/store 名保持 `browser-copilot-fs` / `directory`，key 不变（`root`、`download`），新 key `install`。 |
| `src/lib/fs-store.ts`               | 修改 | 改用 `directory-handle-store`，行为与 key 不变。                                                                                                                                                                                                                                            |
| `src/lib/download-dir.ts`           | 修改 | 同上；key `download` 不变。                                                                                                                                                                                                                                                                 |
| `tests/zip-archive.spec.ts`         | 新增 | 中央目录/本地头、deflate-raw、目录条目、重复名、路径穿越、超预算、截断、不支持方法。                                                                                                                                                                                                        |
| 现有 `tests/excel-parse*.spec.ts`   | 回归 | 不改断言。                                                                                                                                                                                                                                                                                  |
| 现有 fs-store / download-dir 测试   | 回归 | 不改断言。                                                                                                                                                                                                                                                                                  |

**验收**：`pnpm typecheck && pnpm test`，excel-parse 与目录句柄相关测试全绿；`rg "DecompressionStream" src` 只剩 ZIP reader 一处。

### Step 2 — 无 chrome 的更新逻辑（`src/lib/update/**`）

| 文件                                | 内容                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/update/types.ts`           | `UpdateAssetInfo` / `UpdateReleaseInfo` / `UpdateState` / `UpdateCheckError` / `UpdateProgress`；`UPDATE_REPO_OWNER`、`UPDATE_REPO_NAME`、storage key 常量。 |
| `src/lib/update/version.ts`         | `parseSemver`、`compareSemver`；拒绝非 `X.Y.Z`。                                                                                                             |
| `src/lib/update/release.ts`         | `parseLatestRelease(json, { currentVersion, variant })`：校验 tag、资产命名、`digest`、下载 URL 前缀；返回 `UpdateReleaseInfo + asset + available`。         |
| `src/lib/update/asset.ts`           | `pickReleaseAsset`、`expectedAssetName`、`validateAsset`（纯函数）。                                                                                         |
| `src/lib/update/install-plan.ts`    | ZIP 条目的路径安全校验、重复条目与根 `manifest.json` 定位、变体标记校验（`manifest_version`、`name`、`version`、`version_name` 的 `(no OCR)`）。             |
| `src/lib/update/sha256.ts`          | `sha256Hex(bytes)`，复用 `crypto.subtle.digest`。                                                                                                            |
| `tests/update-version.spec.ts`      | 1.2.3 vs 1.2.10、缺段补 0、前导 v、RC 拒绝、非数字拒绝。                                                                                                     |
| `tests/update-release.spec.ts`      | 正常 release、资产缺失、digest 缺失/非法、URL 非 GitHub、no-ocr 选择、prerelease 已在 API 侧排除。                                                           |
| `tests/update-install-plan.spec.ts` | 路径拒绝矩阵、重复条目、根 manifest 与变体/版本不匹配。                                                                                                      |

**验收**：`src/lib/update/**` 不 import `chrome`；单测覆盖纯逻辑。

### Step 3 — 后台检查与状态（`src/background/update-checker.ts`）

| 文件                               | 动作                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/background/update-checker.ts` | 新增：`checkForUpdates({ force })`（fetch `api.github.com/repos/.../releases/latest`，15s 超时、`Accept` + `X-GitHub-Api-Version` 头、429/403 限流与网络/HTTP/JSON 错误分类），写 `chrome.storage.local` `update.state`；`UPDATE_CHECK_ALARM = 'update-check'`；`ensureUpdateAlarm()`；单飞去重。只用 GitHub API 与 `chrome.storage`，不做写盘。 |
| `src/background/index.ts`          | 修改：`onInstalled`/`onStartup` 调 `ensureUpdateAlarm()` + 立即检查；alarms 监听器处理 `update-check`；`handleCommand` 新增 `update.check`。                                                                                                                                                                                                     |
| `src/lib/messages.ts`              | 修改：`Command` 增 `{ type: 'update.check'; force?: boolean }`；`CommandResult` 增 `{ type: 'update.state'; state: UpdateState }`。                                                                                                                                                                                                              |
| `src/lib/update/variant.ts`        | 新增：从 manifest 判断变体：`browser_specific_settings`（Firefox）→ `firefox`；`version_name` 含 `(no OCR)` → `no-ocr`；否则 `ocr`。                                                                                                                                                                                                             |
| `tests/update-check.spec.ts`       | 新增：请求新鲜度、版本变化、失败保留上次成功状态、变体选择（后台 fetch 壳层由 e2e/手测覆盖）。                                                                                                                                                                                                                                                   |

**验收**：`update.check` 返回类型化状态；后台不写安装目录。

### Step 4 — 应用流程（侧边栏，用户手势内完成）

| 文件                          | 动作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/update/apply.ts`     | 新增：`applyUpdate({ directory, asset, currentVersion, targetVersion, expectedName, variant, signal, onProgress })`：读目录 `manifest.json` 校验、下载（`fetch` + `content-length` 进度 + `AbortSignal`）、`sha256Hex` 比对 `digest`、`ZipArchive.open`、`planInstall`；在安装目录内创建 `browser-copilot-backup-<当前版本>-<时间>/`，先备份将被替换的现存文件（根 manifest 存为 `manifest.json.bak`），备份失败即 `backup-failed` 中止；随后逐文件 `createWritable()`，先写哈希资源，再写稳定入口（`service-worker-loader.js`、各 `index.html`），最后写 `manifest.json`。返回 `{ filesWritten: number, backupFolder: string }`。 |
| `src/lib/update/directory.ts` | 新增：`pickInstallDirectory()`（`showDirectoryPicker` + `queryPermission`）、`resolveInstallDirectory()`（复用已保存句柄，点击内 `requestPermission`）、`peekInstallDirectory()`（只读标签）、`rememberInstallDirectory()`、`forgetInstallDirectory()`、`verifyInstallDirectory()`。                                                                                                                                                                                                                                                                                                                                               |
| `src/lib/update/state.ts`     | 新增：读取/写入 `update.dismissedVersion`、`update.pendingReloadVersion`；`markPendingReload`、`clearPendingReload`、`readPendingReloadVersion(currentVersion)`；`getInstallType()`、`canApplyInPlace()`。                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tests/update-apply.spec.ts`  | 新增：内存版 `FileSystemDirectoryHandle` fake（记录完整相对路径）；验证校验失败不写文件、稳定入口与 manifest 的写入顺序、备份先于任何覆盖且包含旧 manifest（`manifest.json.bak`）、备份目录不可加载、备份失败零写入、写中途失败旧 manifest 保留、digest 不匹配零写入、Abort。                                                                                                                                                                                                                                                                                                                                                      |

**约束**：`applyUpdate` 只接受调用方传入的目录句柄与已校验的 release；不自己发起“自动更新”。

### Step 5 — UI 与 i18n

| 文件                                          | 动作                                                                                                                                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sidepanel/update/use-update-snapshot.ts` | 新增：读 storage 状态、pending/dismissed、installType；`checkNow(force)`、`dismiss(version)`、`reloadNow()`；监听 `chrome.storage.onChanged`；状态为空的首次打开自动非强制检查。                                                                               |
| `src/sidepanel/update/UpdateCenter.tsx`       | 新增：nav 下方横幅；available（下载图标 / 忽略图标）与 pending（重新加载图标）两态；按钮全部为纯图标，文案只作为 `aria-label` / `title`。点击下载图标打开对话框。                                                                                              |
| `src/sidepanel/update/IconButton.tsx`         | 新增：banner 与对话框共用的图标按钮（`primary` / `secondary` / `ghost`、`sm` / `md`），`label` 同时写入 `aria-label` 与 `title`。                                                                                                                              |
| `src/sidepanel/update/UpdateDialog.tsx`       | 新增：基于 `FormDialog`；当前/目标版本、纯文本 release notes、覆盖/备份说明、首次目录提示 / 已保存目录复用 / 更换目录、进度、错误；所有动作（取消、关闭、下载并安装、重试、稍后、重新加载、打开发布页、更换目录）均为图标按钮；非 unpacked 只给 Release 链接。 |
| `src/sidepanel/update/UpdateSettingsCard.tsx` | 新增：当前版本、`Check now`、上次检查、已是最新/有更新/等待重载、安装类型门禁提示；可打开同一对话框。                                                                                                                                                          |
| `src/sidepanel/update/error-text.ts`          | 新增：把检查/应用错误码映射为 en + zh-CN 文案。                                                                                                                                                                                                                |
| `src/sidepanel/update/open-release.ts`        | 新增：`chrome.tabs.create` 打开发布页（带 `window.open` 回退）。                                                                                                                                                                                               |
| `src/sidepanel/App.tsx`                       | 修改：nav 下方挂 `UpdateCenter`。                                                                                                                                                                                                                              |
| `src/sidepanel/SettingsTab.tsx`               | 修改：主面板末尾挂 `UpdateSettingsCard`。                                                                                                                                                                                                                      |
| `src/lib/i18n.ts`                             | 修改：`Messages` + `en` + `zhCN` 同步新增 `update*` keys（flat camelCase，函数式插值）。                                                                                                                                                                       |
| `tests/update-ui.spec.tsx`                    | 新增：横幅 available/pending/dismiss、非 development 门禁只给 Release 链接、设置卡片状态与手动检查。                                                                                                                                                           |

**约束**：只用 Tailwind 语义 token 类；无硬编码可见文案；en + zh-CN 双侧。

### Step 6 — 门禁与证据

2026-10-22 执行结果：

- `pnpm typecheck`、`pnpm test`（425 files / 4942 tests）、`pnpm build`、`pnpm server:typecheck`：通过。
- ESLint（tracked + 新增文件）：0 error（26 个存量 warning）；Prettier（同范围，仅受支持扩展名）：通过。
- `pnpm verify:injected`：本方案未新增 `executeScript({func})` 内联函数体，未跑（预期不受影响）。

真实浏览器证据（Playwright 自带 Chrome for Testing，加载 `tmp/bc-update-verify` 构建，version 0.6.6 → GitHub latest 0.6.7）：

1. **primitive（已实测）**：扩展页 `showDirectoryPicker` 可用；GitHub API/资产下载 + `crypto.subtle` digest 与 GitHub `digest` 一致；`chrome.runtime.reload()` 是仓库既有能力。
2. **check → banner → dialog（已实测）**：`installType === 'development'`；后台真实请求 GitHub `/releases/latest` 后 `chrome.storage.local["update.state"]` 为 `available: true`、`latest.version: "0.6.7"`、OCR 资产带 GitHub `digest`。侧边栏显示「新版本 0.6.7 可用。」。
3. **图标按钮（2026-10-22 第二轮，已实测）**：横幅只有两个纯图标按钮（下载 / 忽略），`textContent === ''`，`aria-label` / `title` 分别为「更新」「忽略」；忽略按钮的 14px X 图标为 `text-ink`（#18202c）且可见。对话框底部只有「取消」「下载并安装」两个 16px 图标按钮，同样无文字。主按钮计算样式为 `background: rgb(40, 96, 207)`、`color: rgb(255, 255, 255)`、32×32（横幅为 24×24）。截图：`tmp/banner-element.png`、`tmp/dialog-element.png`。
4. **首次目录提示（已实测）**：无已保存句柄时对话框显示「首次更新请选择当初「加载已解压的扩展程序」时使用的目录；之后会自动复用。」，且不显示「更换」按钮（只有已保存句柄时才出现）。
5. **选择目录 → 下载写入 → reload（BLOCKED）**：`showDirectoryPicker` 是系统级目录选择器，CDP/Playwright 无法驱动，无法在自动化浏览器中授予真实目录句柄。该段由 `tests/update-apply.spec.ts` 的 fake handle 覆盖（digest 不匹配零写入、备份先于覆盖、备份失败零写入、manifest 最后写、写到一半失败保留旧 manifest、Abort），未做真实浏览器验证。

**样式坑（本轮修复）**：`src/sidepanel/styles.css` 的全局 `button { padding: 6px 12px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text) }` 是**未分层**规则，优先级高于 Tailwind 的 `@layer utilities`，会把图标按钮压成 24px 宽、横向内边距 24px，SVG 被 flex 压到 0 宽。`IconButton` 对尺寸、内边距、背景、边框、文字颜色使用 `!` 后缀（与 `ChatTab.tsx` 现有图标按钮同一写法），并给图标加 `flex-none`。

## 2. 关键决策记录

- **不做热加载**：MV3 CSP + 商店政策 + 无安装目录 API，三条都不可绕过（设计 §2）。
- **不做 `.crx` / CRX3 签名**：自托管 `update_url` 实际只支持 Linux；普通用户无法用。
- **不做静默更新**：必须用户点击并选择目录；这是浏览器能力边界，也是安全边界。
- **首次选一次目录，之后自动复用**：浏览器没有查询自身安装目录的 API；`install` 句柄存 IndexedDB，之后 `resolveInstallDirectory()` 直接复用，权限过期时在点击手势内 `requestPermission`，不再弹目录选择器。
- **覆盖前先备份，备份失败不覆盖**：备份写入安装目录内的 `browser-copilot-backup-<旧版本>-<时间>/`；根 manifest 改名为 `manifest.json.bak`，保证备份目录不会被 Chrome 当成第二个扩展加载。用户确认更新正常后可手动删除。
- **图标按钮必须带 `!` 修饰符**：侧边栏的全局 `button` 规则未进 Tailwind layer，普通工具类会被它覆盖；纯图标按钮如果不加 `!`，会出现“有按钮框、没有图标”的假象（见 Step 6 的样式坑记录）。
- **不清理旧文件**：Vite 产物带 hash，旧文件无害；删除目录内容风险高于收益。
- **GitHub digest 强制**：缺失即拒绝；不自行计算“预期值”。
- **manifest.json 最后写，稳定入口紧随其后写**：先落盘所有哈希资源，再写 `service-worker-loader.js` 与各 `index.html`，最后写 manifest。任何中途失败时，旧 manifest 的入口要么仍指向旧文件，要么新入口所需的哈希资源已完整存在。
- **只信硬编码仓库**：owner/repo 不接受输入；资产 URL 必须匹配 GitHub release 前缀。

## 3. 风险与回退

| 风险                               | 处理                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 目录权限在浏览器重启后失效         | 点击 Update 时 `queryPermission` → `requestPermission`（用户手势内）；失败则重新选目录。                                     |
| 写入只读目录失败                   | 中途失败不写 manifest；提示换目录。                                                                                          |
| GitHub API 限流                    | 显示可读错误 + Release 链接；12h 后重试；手动 Check 失败不清空上次成功状态。                                                 |
| 新版本资产缺失（如 no-ocr 未发布） | 状态标错误，不提供覆盖按钮，只给 Release 链接。                                                                              |
| 用户把目录选成数据目录             | 根 manifest 校验失败，拒绝写入。                                                                                             |
| 用户选错安装目录（另一份解压副本） | 根 manifest 校验能通过，但更新写到了 Chrome 未运行的那份；提示语要求选择当初加载的目录。                                     |
| 扩展管理出现两个同名条目           | “Load unpacked” 每次按目录注册一个扩展；更新器不注册新扩展，备份目录的 manifest 已改名。对比「已加载自」路径后移除多余条目。 |
| 未来上架 CWS                       | 该路径不能随商店版本发布；上架前移除或构建期关闭。                                                                           |

## 4. 文档与提交

- 本 plan 与 design 先提交（`docs(update): ...`）。
- 实现按 Step 分提交，提交信息全英文 Conventional Commits。
- 不改 `website/` 版本号（本功能不涉及打 tag）。
