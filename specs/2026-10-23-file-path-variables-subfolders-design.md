# upload-file / parse-excel：路径变量与下载子目录

日期：2026-10-23
状态：已实现

## 背景

用户提出两件事：

1. 上传文件（`upload-file`）和 Excel 解析（`parse-excel`）的 `file-path` 路径要支持变量。
2. 项目能否自动上传下载目录下**子文件夹**里的文件。

## 现状与证据

- 执行器已经支持路径变量：`downloadPathFile` 先做
  `interpolate(rawPath, ctx.variables, ctx.refData)`，再 `normalizeDownloadFilePath`，
  最后 `readDownloadedFileAtPath`（`src/background/workflow-engine/executors.ts:2497`）。
  `tests/file-path-source.spec.ts:89` 已覆盖 `reports/{{year}}-{{month}}/sales.csv`。
- 预检不会误杀变量：`normalizeDownloadFilePath` 只拒绝绝对路径、盘符、`..` 和
  Windows 非法字符，`{{`、`}}` 都能通过（`block-requirements.ts:353`、`:513`）。
- 子目录读取本来就支持：`readDownloadedFileAtPath` 按 `/` 逐段
  `getDirectoryHandle`，`tests/file-path-source.spec.ts` 的路径就是
  `reports/2026-10/sales.csv`。
- 真正的缺口有两处：
  - 编辑器里路径输入框用 `noSlash` 关掉了 `/` 变量菜单，也没有任何提示，
    用户不知道可以手写 `{{var}}`。
  - `latest-download`（自动上传最新下载）调用
    `listDownloadedFileCandidates()` 时没传 `recursive`，默认只看下载根目录，
    子文件夹里更新的文件不会被选中（`executors.ts:2565`）。
- Runner 侧不受影响：无头宿主只记录本次运行的扁平下载，
  `findDownloadedFileByPath` 自带扁平文件名回退
  （`server/src/executors.ts:1596`），两处路径都已插值。

## 方案

### 1. 路径字段的按需变量菜单

路径里的 `/` 是分隔符，不能像普通字段那样用 `/` 触发菜单（输入 `reports/` 就弹菜单
会干扰输入）。因此复用现有菜单基础设施，增加“按需打开”：

- `useFieldSlashMenu` 新增 `open()`：把光标位置作为空查询（`start = end = caret`），
  打开完整建议列表；选项写入仍然走 `applySlashInsert`，结果就是在光标处插入
  `{{name}}`。
- `TextInput` 新增 `variableMenu` 属性：渲染一个 `{}` 按钮打开菜单，`noSlash`
  仍然生效（`/` 不触发、键入 `/` 不弹菜单）。输入过程中如果菜单开着，关闭它。
- `DownloadFilePicker` 启用该属性，并加一行说明：路径可以包含变量，
  子文件夹里的文件也会列出来。

### 2. latest-download 扫描子目录

`upload-file` 的 `latest-download` 改为
`listDownloadedFileCandidates({ recursive: true })`。深度上限 4、条目上限 500
保持不变；`pickLatestFile` 仍按文件名过滤与 mtime 选最新，子目录文件与根目录文件
公平竞争。

`listDownloadedFileCandidates` 的默认值仍是 `recursive: false`——扫描范围是调用方的
决定，不改默认行为。

### 3. 文案

- 新增 `Insert variable`（中文：插入变量）与路径字段提示、latest-download 提示，
  中文写入 `BLOCK_FORM_STRINGS.zh`；`bt()` 的英文源字符串即 key。

## 否决的替代方案

- **直接在路径字段打开 `/` 菜单**：`/` 是路径分隔符，输入 `reports/` 会弹出菜单；
  而且用户不会想到用 `/` 插入变量，发现性反而更差。
- **为变量路径单独做一种 sourceMode**：路径仍是一个字符串，执行器已经插值，
  新增模式只会扩大状态空间。
- **把递归扫描改成库的默认值**：其他调用方（编辑器选择器已显式递归）不需要这个
  默认，保持调用点显式更安全。

## 安全边界

- 插值结果仍然经过 `normalizeDownloadFilePath`：变量展开出绝对路径、`..` 或
  盘符时照常拒绝。
- 递归只扩大两个已授权下载根（用户配置的下载目录 + 扩展内部下载目录）内部的扫描
  深度，不触达其他目录。

## 测试

- `tests/upload-latest-download.spec.ts`：断言扫描带 `{ recursive: true }`；
  子目录候选（`relativePath: 'reports/2026-10/nested.pdf'`）可以成为最新文件并被上传。
- `tests/var-slash-menu.spec.tsx`：`noSlash + variableMenu` 时 `/` 仍不弹菜单；
  点击 `{}` 按钮打开菜单，选项插入到光标处。
- `tests/upload-file-source-select.spec.tsx`：file-path 模式下渲染 `{}` 按钮与提示。
- `tests/editor-i18n.spec.ts`：新增中文条目非空（既有约束）。

## 手工验证

1. 打开工作流编辑器 → 添加「上传文件」→ 上传方式选「指定文件路径」。
   预期：路径输入框右侧有 `{}` 按钮；点击后出现变量列表，选中后路径里出现
   `{{变量名}}`；直接输入 `reports/` 不会弹出菜单。
2. 把 `report.pdf` 放进下载目录的子文件夹 `reports/`，构造 `latest-download`
   （accept `.pdf`）的工作流并运行。预期：上传的是子文件夹里的文件。
3. 用 `file-path` 填写 `reports/{{folder}}/report.pdf`（`folder` 由上游变量产生），
   运行后应读取对应子目录文件；变量缺失时报 `UPLOAD_NO_MATCHING_FILE`，
   错误信息里保留未解析的 token。
