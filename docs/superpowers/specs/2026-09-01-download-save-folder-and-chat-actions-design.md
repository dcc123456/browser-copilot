# 下载目录 + 工作流保存算子 + 对话按钮 设计

日期：2026-09-01
状态：待用户评审

## 目标

1. 在自动化工作流中，通过一个“保存到本地”算子节点，把数据/变量生成文件并保存到本地。
2. 提供可配置的“下载文件保存目录”：未设置时需用户确认保存位置（另存为）；设置后默认自动保存，但可关闭自动保存。
3. 单个工作流算子可单独覆盖“是否自动保存”。
4. 调整对话消息按钮：仅“最后一个总体回复”（助手的最终回复，排除思考/操作过程）常显 复制/下载/token 按钮；用户消息仅常显复制按钮、且在消息框下方。

## 关键架构约束

- 工作流在 `background`（MV3 service worker）中执行，而 `showDirectoryPicker` / `showSaveFilePicker` 必须在**带用户手势的页面**中调用（侧面板）。
- 已授权的 `FileSystemDirectoryHandle` 允许 service worker 直接读写（沿用现有 `fs-store` 的读写通道）。
- 因此：**自动保存**从 worker 直接写入句柄；**另存为/确认保存**路由到侧面板调用 `showSaveFilePicker`。

## A. 下载目录设置（设置页）

仿照现有“存储位置”卡片（`SettingsTab.tsx` 的 `chooseFolder/reconnectFolder/removeFolder` 逻辑）新增“下载目录”卡片：

- **选择目录**：`showDirectoryPicker` 获取目录句柄，存到 IndexedDB 的**独立 key**（如 `download-dir`，与 `fs-store` 的 root 区分，避免冲突）。
- **自动保存开关**：`Settings` 新增字段 `downloadAutoSave: boolean`，默认 `true`。无目录时开关置灰或隐藏。
- **操作按钮**：选择目录 / 更换目录 / 断开（回到未设置）。

新增设置项：`Settings.downloadAutoSave`。

### IndexedDB 句柄存储

- 目录句柄持久化到 IndexedDB，仿 `fs-store` 的 `IDB_DB/IDB_STORE/IDB_KEY`，但使用独立 key（例如 `download`）以免与存储目录混淆。
- 权限查询/恢复沿用现有方式的封装；worker 侧只消费已授权句柄。

## B. 工作流算子「保存到本地」 (save-local)

新增一个 block/算子，把变量/数据内容写入本地文件。

### 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `value` | string | 文件内容，支持 `{{变量}}` 插值 |
| `filename` | string | 文件名（含扩展名），支持插值 |
| `saveMode` | `'auto' \| 'force' \| 'manual'` | 默认 `auto` |

### 保存决策

```
hasDir = 下载目录句柄存在且已授权
globalAuto = settings.downloadAutoSave
switch (saveMode) {
  case 'force': auto → 静默写入目录（若无目录则回退另存为并提示）
  case 'manual': manual → 另存为
  case 'auto':
    auto = hasDir && globalAuto
    auto ? 静默写入 : 另存为
}
```

### 另存为（确认保存）实现

- worker 通过 `runtime.sendMessage` 发送保存请求给**侧面板**，由侧面板调用 `showSaveFilePicker` 并返回所选的 `FileSystemFileHandle` / 结果。
- 若侧面板未开启 / 无响应：回退为通知用户（工作流日志 emit 提示手动保存），不失败静默。

### 自动保存实现

- worker 直接用已授权目录句柄 `getFileHandle(filename, {create})` + `createWritable()` 写入内容。
- 写入成功后 emit `result` 记录保存路径。
- 文件名冲突策略：默认直接覆盖同名文件（v1 不做 uniquify/prompt，保持简单；如需可在后续迭代扩展）。

## C. 对话消息按钮（ChatTab）

- **助手消息**：仅 `lastAssistantId`（对话最后一条 `assistant` 回复，`role: 'tool'` 的思考/操作过程不算）显示 复制 + 下载 + token 按钮；其余助手消息在非 busy 时也**不显示**这些按钮。
- **用户消息**：仅显示 复制 按钮。
- **常显**：移除 `styles.css` 中悬停/聚焦才显示 `msg-actions` 的规则；按钮固定在**消息框下方**常显。
- 流式生成期间：为避免用户在思考/操作过程看到半成品按钮，最后一条 reply 在完成前的行为保持与现状一致（busy 时隐藏非最终中间消息；最终回复完成后常显按钮）。

## 测试

- 新增/调整：
  - 保存决策纯函数（`resolveSavePath` / 决策逻辑）——根据 `saveMode`/全局开关/有无目录返回 `auto|manual`。
  - 自动保存写入（用 mock 句柄断言写内容/文件名/覆盖策略）。
  - 设置 `downloadAutoSave` 读写。
  - ChatTab 按钮可见性：仅最后一条 assistant 显示三类按钮、用户消息仅复制、非最后回复无按钮。
- 运行 `pnpm typecheck` 与现有单测，保证不回归。

## 后续步骤

- 评审通过后，用 `writing-plans` skill 生成实现计划。