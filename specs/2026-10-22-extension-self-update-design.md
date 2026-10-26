# Extension self-update (GitHub Releases, zero server) · Design

日期：2026-10-22  
范围：Chrome 114+ / MV3，GitHub Release ZIP + “Load unpacked” 分发方式。Firefox 与商店安装只做版本提示，不做覆盖更新。

## 1. 目标与非目标

**目标**

- 插件后台定时检查 `dcc123456/browser-copilot` 的 GitHub 最新 Release，并在侧边栏提示新版本。
- Chrome unpacked 安装可由用户在插件内完成：首次选择一次安装目录 → 下载对应 ZIP → 校验 GitHub 提供的 SHA-256 → 解压、备份将被替换的旧文件、覆盖安装目录 → 用户点 “Reload now” 后生效。之后更新自动复用已保存的目录，不再询问。
- 不依赖任何自建服务器；不执行远端脚本；不静默更新。

**非目标**

- 不在运行时 `importScripts()` / `eval()` 下载的代码，不实现远端 loader。
- 不替换 Chrome Web Store 的自动更新；不上架、不签名 CRX、不配置企业 `update_url`。
- 不自动删除安装目录里的旧文件（Vite 资源名带 hash，旧文件不影响新版本）。
- 不覆盖用户数据：聊天、工作流、设置仍在扩展存储/用户数据目录，不在安装目录。

## 2. 为什么原方案（loader.js + importScripts）不可行

原方案的三步在 MV3 里都被硬性拦住：

1. **CSP**：本仓库 `manifest.config.ts` 的 `extension_pages` 是 `script-src 'self'`。`importScripts(blob:)` 和远端脚本都会被浏览器拒绝；`blob:` 不在允许的 script source 内。
2. **商店政策**：Chrome Web Store 明确禁止“从远端抓取字符串并执行”的远程代码；即使把 loader 固定在安装包里，下载并执行新逻辑仍属于 remote hosted code。
3. **没有安装目录写权限**：扩展 JS 没有文件系统 API 可以写自己的安装目录；`chrome.runtime.reload()` 只从原目录重新加载，不会把 Downloads 里的 ZIP 变成已加载的扩展。`chrome.downloads` 只能写入下载目录，不能解压覆盖安装目录。

因此“热替换运行时”不可实现。能实现的是：**用户选择安装目录后，扩展作为普通网页把新文件写进去，再由 Chrome 从磁盘重新加载**。这等价于用户手动解压覆盖 + 点 Reload，只是把下载/校验/解压自动化。

## 3. 取证与实测

### 3.1 官方文档

- Chrome Web Store MV3 政策：远端托管代码、`eval` / 执行远端字符串被禁止。
  <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
- Chrome 自托管更新：需要签名 `.crx` + 含 `update_url` 的 XML；该方式**只支持 Linux**，Windows/macOS 不支持普通用户自托管。
  <https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux>
- MV3 扩展页 CSP：`script-src 'self'`；本仓库 manifest 已按此配置（`manifest.config.ts:100-104`）。

### 3.2 本机 spike（临时扩展，位于 gitignored `tmp/fs-spike/`）

1. **File System Access API 在扩展页可用**：`typeof showDirectoryPicker === 'function'`；带用户手势点击后返回 pending（原生目录选择器打开），没有被 CSP/权限策略立即拒绝。
2. **扩展页可跨域拉 GitHub API 与 Release 资产**（manifest 声明 `<all_urls>` host permission）：
   - API 200，`tag_name = v0.6.7`；
   - 下载 `browser-copilot-0.6.7-no-ocr.zip` 863,548 bytes；
   - GitHub 返回 `digest = sha256:e47f…ea4`，浏览器 `crypto.subtle.digest` 计算值完全一致。
3. **`chrome.runtime.reload()` 是仓库既有能力**：`src/background/agent-api.ts:124` 已用于本地 Agent 桥的 `reload_extension`，selftest 依赖它。Playwright 的命令行 `--load-extension` 环境在 reload 后把扩展标记为“未开启开发者模式”并禁用（`disable_reasons = 16777216`），这是测试通道的限制，不是真实 “Load unpacked” 安装的行为；真实流程仍以用户点击 Reload / 现有 `reload_extension` 为准。
4. **写目录能力在仓库已生产使用**：侧边栏已调用 `showDirectoryPicker` / `showSaveFilePicker`，并通过 `createWritable()` 写入用户选定目录（`src/lib/fs-store.ts`、`src/lib/download-dir.ts`、`src/sidepanel/App.tsx`）。更新器只是把目标换成了安装目录。

### 3.3 可复用资产

- ZIP 中央目录解析 + `DecompressionStream('deflate-raw')` 已在 `src/lib/workflow/excel-parse.ts`，更新器不新增第二个 ZIP 解析器，先抽成 `src/lib/zip/zip-archive.ts`。
- 目录句柄的 IndexedDB 持久化已有两处重复（`fs-store` key `root`、`download-dir` key `download`）；本次抽成 `src/lib/directory-handle-store.ts`，更新目录用 key `install`。
- 对话框用现有 `src/ui/FormDialog.tsx`；文案走 `src/lib/i18n.ts` 的 en / zh-CN 双语封闭字典。
- Release 资产命名由 `scripts/build-zip.mjs` / `.github/workflows/release.yml` 固定：
  `browser-copilot-<version>-ocr.zip`、`-no-ocr.zip`、`-firefox.xpi`；ZIP 根目录含 `manifest.json`。

## 4. 采用方案

```
GitHub Releases/latest
        │  (background alarm, 12h + on install/startup)
        ▼
UpdateState（chrome.storage.local）
        │
        ▼
侧边栏 banner / Settings 卡片
        ├─ 选择（仅首次）/复用安装目录句柄（用户手势）
        │
        ├─ 读取目录 manifest.json，校验 name + version
        ├─ 按构建变体选择资产（ocr / no-ocr / firefox）
        ├─ 下载（进度），校验 GitHub SHA-256
        ├─ 解压（路径安全校验）
        ├─ 在安装目录内创建 browser-copilot-backup-<旧版本>-<时间>/，备份将被覆盖的旧文件（根 manifest 存为 manifest.json.bak）
        ├─ 先写哈希资源，再写稳定入口（service-worker-loader.js / index.html），最后写 manifest.json
        └─ 写 pendingReload 标记 → “Reload now” / 用户手动 Reload
```

### 4.1 安装类型门禁

- 仅当 `chrome.management.getSelf().installType === 'development'`（真实 “Load unpacked”）且 `showDirectoryPicker` 存在时，才显示覆盖更新按钮。
- CWS 安装（`normal`）、CRX sideload、企业安装一律只显示 “打开 Release 页面”。
- **该能力不能随 CWS 版本发布**：CWS 政策不允许自更新代码，且商店版本由 Chrome 自动更新。若未来上架，必须移除/关闭此路径（门禁之外再加构建开关也不迟，但当前不分发到商店）。

### 4.2 构建变体与资产

- `manifest.version_name` 含 `(no OCR)` → `no-ocr` 资产；否则 → `ocr`。
- Firefox（`showDirectoryPicker` 缺失）→ 只提示，不下载覆盖；资产如需直接下载则用 `-firefox.xpi`。
- 资产必须同时满足：
  - 文件名以 `browser-copilot-<latestVersion>-<variant>.zip` 结尾；
  - `digest` 以 `sha256:` 开头、64 位十六进制；
  - `browser_download_url` 是 `https://github.com/dcc123456/browser-copilot/releases/download/` 前缀。
- Release 版本必须是纯 `X.Y.Z`（拒绝 RC/带后缀的 tag 自动覆盖；避免把预发布版写进安装目录）。`/releases/latest` 本身已排除 GitHub 标记的 prerelease/draft。

### 4.3 版本比较

- 从 `chrome.runtime.getManifest().version` 取当前版本；从 `tag_name` 去掉一个前导 `v`。
- 按点分数字逐段比较，缺失段补 0；非数字段直接拒绝自动更新。
- `latest <= current` → up-to-date；`latest > current` → available。

### 4.4 状态与命令

`src/lib/update/types.ts`（chrome-free）：

```ts
interface UpdateAssetInfo {
  name: string
  url: string
  size: number
  digest: string
}
interface UpdateReleaseInfo {
  version: string
  tag: string
  name: string
  htmlUrl: string
  notes: string
  publishedAt: string
}
interface UpdateState {
  checkedAt: number
  currentVersion: string
  latest: UpdateReleaseInfo | null
  asset: UpdateAssetInfo | null
  available: boolean
  error: UpdateCheckError | null
  /** 连续瞬时失败次数；旧状态里可能不存在。 */
  failures?: number
  /** 下一次自动重试的时间戳；`null` 表示没有安排重试。 */
  retryAt?: number | null
}
```

- 后台 `src/background/update-checker.ts`：`update-check` alarm（12h，安装/启动时立即检查一次）、`checkForUpdates({force})`、写入 `chrome.storage.local` key `update.state`。
- 瞬时失败（`network` / `rate-limited`）安排一次性 `update-retry` alarm：优先用 GitHub 响应头里的 `x-ratelimit-reset` 或 `Retry-After`，否则按 15 分钟起步、逐次翻倍、上限 6 小时的退避；重试时间被夹在「当前 +30s」到「当前 +6h」之间。成功检查清除 `failures` / `retryAt` 与重试 alarm。`update-retry` 触发时强制绕过新鲜度守卫；重试到期前，启动检查与面板挂载都复用已存状态，不再消耗共享 IP 配额。
- 侧边栏通过 `chrome.storage.onChanged` 读取状态；手动检查发 `{ type: 'update.check', force: true }`，返回 `{ type: 'update.state', state }`。
- 免责/关闭：`update.dismissedVersion` 存 `chrome.storage.local`；新版本出现时自然重新显示。
- 已写入待重载：`update.pendingReloadVersion`；banner 显示 “已下载，Reload 生效”，重载后新版本发现 `pending <= current` 时清除。

### 4.5 覆盖流程的安全不变量

- 仓库 owner/repo 硬编码，不接受用户输入 URL。
- 下载后必须校验 GitHub API 提供的 SHA-256；缺失或不匹配 → 不写任何文件。
- 先校验安装目录：根 `manifest.json` 的 `name` 与当前扩展一致，`version` 等于当前版本或目标版本；否则拒绝。
- 先校验 ZIP 内的根 `manifest.json`：`manifest_version === 3`、`name` 一致、`version === latestVersion`、no-ocr 标记与当前构建一致。
- ZIP 路径安全：拒绝绝对路径、`..`、反斜杠、空段、控制字符、重复条目；目录条目只用于建目录；`manifest.json` 最后写。
- 解压上限复用通用 ZIP reader：单文件 64 MiB、总计 128 MiB、条目数上限；超过即中止。
- 覆盖前先备份：在安装目录内创建 `browser-copilot-backup-<旧版本>-<ISO 时间>/`，把本次将被替换的现存文件按原相对路径复制进去；根 `manifest.json` 存为 `manifest.json.bak`，这样备份目录**不能被当作第二个扩展加载**（避免扩展管理里出现重复条目）。备份失败（`backup-failed`）即中止，保证“没有备份就不覆盖”。
- 写入使用 `createWritable()`（写入 swap 文件，close 时提交）；所有内容文件成功后才写 manifest，失败时旧 manifest 仍指向旧文件。
- 不删除旧文件；不触碰 `browser-copilot/` 数据目录。备份目录由用户在更新确认可用后手动删除。
- 用户必须点击 Update 并（首次）选择/授权目录；没有任何后台自动写入。

## 5. UI

- **全局 banner**（`src/sidepanel/update/UpdateCenter.tsx`，挂在 `App.tsx` 的 tab 栏下方）：
  - 有更新：`Browser Copilot vX.Y.Z available` + 图标按钮：下载（打开对话框）、忽略（X）。
  - 已下载待重载：`Update downloaded — reload to finish` + 旋转箭头图标按钮（Reload）。
  - 横幅上的两个动作都是纯图标按钮：文案只放在 `aria-label` / `title`，不显示按钮文字。
  - 关闭只影响该版本；下一次新版本仍显示。
- **更新对话框**（`UpdateDialog.tsx` + `FormDialog`）：当前版本 → 目标版本、Release notes（纯文本）、覆盖/备份说明、进度（下载/校验/解压/备份/写入）、错误；所有动作按钮均为图标按钮（取消/关闭/下载并安装/重试/稍后/立即重新加载/打开发布页/更换目录），无按钮文字。
- **安装目录行**：首次更新提示“请选择当初「加载已解压的扩展程序」时使用的目录”，之后自动复用；已保存时显示目录名 + “更换”图标按钮。浏览器没有 API 能查询扩展自身的安装目录，因此首次必须由用户选一次；路径句柄保存在 IndexedDB，后续更新直接复用，权限过期时在点击内重新授权。选错目录不会自动产生第二个扩展，但会写到 Chrome 并未运行的那份文件里——所以提示语要求选择当初加载的那个目录。
- **Settings 卡片**（`SettingsTab.tsx` 末尾）：当前版本、`Check now`、上次检查/已是最新/有更新；有更新时提供按钮触发全局更新对话框（自定义事件 `bc:open-update`）。
- 所有文案 en + zh-CN；颜色/间距只用 Tailwind token 类。

## 6. 失败与恢复

- GitHub 限流（403 + `x-ratelimit-remaining: 0` / 429）：保留上次成功结果，状态卡显示错误与「将在 … 自动重试」；到点由 `update-retry` alarm 自动复查，无需用户操作。
- 下载/校验/解压失败：不写任何文件；对话框给出错误 + “打开 Release 页面”。
- 目录选择取消：静默返回，不报错。
- 目录校验失败：提示选择含 `manifest.json` 的安装文件夹；不下载。
- 备份失败（无法创建备份目录或写入备份文件）：不覆盖任何文件；提示检查目录权限后重试。
- 写入中途失败：稳定入口（`service-worker-loader.js`、各 `index.html`）在全部哈希资源之后才写，`manifest.json` 最后写；因此旧版本仍可运行（或新资源已完整落盘），且被替换的文件都能从备份目录恢复，提示检查目录写权限并重试。
- 写入成功但用户不重载：文件已更新，旧版本继续运行；banner 保留 “Reload to finish”。
- Reload 失败/面板关闭：用户可在 `chrome://extensions` 点 Reload；文件已就位。
- GitHub 限流：显示可读提示，保留 Release 链接；12h 后再试。

## 7. 测试与验收

- 纯逻辑单测：版本比较、release 解析/资产选择/digest 校验、ZIP 路径安全、稳定入口与 manifest 的写入顺序、错误码。
- 通用 ZIP reader 单测 + 现有 `excel-parse` 全套回归。
- 目录句柄存储抽取后，现有 fs-store / download-dir 测试回归。
- UI 逻辑单测（状态/文案）或组件测试；至少覆盖 banner 的 available/pending/up-to-date 三态。
- 真实浏览器 primitive 已验证（见 §3.2）；完整 E2E 需要人工：加载一个版本号较低的测试构建 → 点 Update → 选安装目录 → 等下载/写入 → 点 Reload → 确认版本变化。若无法在 CI 自动选择原生目录，必须在交付说明中标注 BLOCKED 并给出这段手工步骤。
- 门禁：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm server:typecheck`（`src/lib/zip` 被 Runner 传递引用时）。

## 8. 已知限制

- Chrome unpacked 专属；Firefox / CWS / 企业安装不覆盖。
- 浏览器没有“读取自身安装目录”的 API，首次更新必须由用户手动选一次目录；句柄保存后可复用，浏览器重启后可能需要重新授权（点击 Update 时 `requestPermission`）。
- 安装目录在只读位置（如 `/Applications`）会写入失败。
- 不清理旧文件；目录会随版本累积带 hash 的旧资源。每次更新的备份目录（`browser-copilot-backup-*`）需要用户确认新版本正常后手动删除。
- **扩展管理出现两个同名插件的排查**：每次 “Load unpacked” 都按目录注册一个扩展。若在扩展管理看到两个同名条目，通常是同时加载了旧目录与新目录（例如 `dist/` 与解压出的另一个文件夹）；打开任一卡片的 “详情 → 来源/已加载自” 对比路径，移除多余的那个即可。更新器只覆盖用户选定的那个目录，不会注册新扩展；备份目录里的根 manifest 已改名为 `manifest.json.bak`，本身也不会被 Chrome 当作扩展加载。
- 不解决供应链信任：GitHub 账号/Release 被攻破时，SHA-256 也只能证明“下载与 GitHub 发布的一致”。这是与手动下载 ZIP 相同的信任边界。
- 若未来上架 CWS，必须删除此路径；CWS 的静默更新才是普通用户的正确方案。
