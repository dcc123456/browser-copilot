# 密钥与个人资料的批量导出/导入 · Batch export & import for secrets and profiles

## 1. 背景与目标 · Context and goals

侧栏「数据」页有两个分区：**个人资料**（`UserProfile`，带 `custom` 自定义字段）与
**密钥与字段**（`PasswordEntry`，每条含任意 `SecretField[]` 键值对）。目前两者只能
逐条新建 / 编辑 / 删除，没有任何搬迁、备份、跨机同步的手工路径。

目标：两个分区都支持**勾选后批量导出**与**从文件导入**。

用户口径（本次对话确认）：

| 决策点             | 结论                                          |
| ------------------ | --------------------------------------------- |
| 导出范围           | **仅勾选导出**（不做「导出全部」按钮）        |
| 导入遇到同标签条目 | **总是新建，不覆盖**（新 id，不动本机旧条目） |
| 覆盖范围           | **密钥 + 个人资料都做**                       |

## 2. 现状取证 · Current state

| 事实                        | 锚点                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 个人资料 / 密钥列表与增删改 | `src/sidepanel/DataTab.tsx`（`ProfilesSection` / `PasswordsSection`）                                      |
| 列表项模型                  | `src/lib/types.ts`：`UserProfile` / `PasswordEntry` / `SecretField`                                        |
| 存储 key                    | `src/lib/storage.ts`：`profiles` / `passwords`（`fileStorageArea()` → `profiles.json` / `passwords.json`） |
| 命令通道                    | `src/lib/messages.ts`：`profiles.list                                                                      | save | delete`、`passwords.list | save | delete` |
| 现成的下载原语              | `src/lib/export-answer.ts` 的 `downloadBlob()`（有 chrome.downloads 就用它，否则 anchor 兜底）             |
| 现成的复选框样式            | `src/sidepanel/styles.css`：`.wf-item-check`（行内复选框）、`.wf-select-all`（全选）                       |
| 已有 JSON 导出先例          | `src/sidepanel/WorkflowsTab.tsx` 的 `downloadJSON()`（**局部函数，未抽公共层**）                           |

**缺口**：`DataTab` 没有任何 import/export；`downloadJSON` 是 WorkflowsTab 的私有实现，
再加一份就是同一逻辑的第二处（AGENTS.md §5.2）。

## 3. 方案 · Design

### 3.1 文件格式

单个信封，两类数据都是可选数组：

```json
{
  "type": "browser-copilot-data",
  "version": 1,
  "exportedAt": 1712345678901,
  "profiles": [/* UserProfile[] */],
  "secrets": [/* PasswordEntry[] */]
}
```

- 从个人资料分区导出 → `profiles` 有值、`secrets` 为空数组；密钥分区反之。
- 导入按**文件实际内容**走：里面有什么就导什么，导入按钮放在两个分区里都能用，
  落地后用 banner 报「导入 N 个个人资料 / M 条密钥」。
- 导入**总是新建**：`id` 重新生成、`createdAt/updatedAt` 刷新、`useCount` 归零，
  绝不用导入文件的 id 覆盖本机条目（用户明确要求）。

### 3.2 纯逻辑层

新建 `src/lib/data-export.ts`（chrome-free，可在 Node 直测）：

| 导出                                       | 职责                                                     |
| ------------------------------------------ | -------------------------------------------------------- |
| `DATA_EXPORT_TYPE`                         | `'browser-copilot-data'`                                 |
| `buildDataExport({profiles, secrets, at})` | 生成信封                                                 |
| `isDataExport(value)`                      | 判别信封（`type` + `version` + 两个数组）                |
| `coerceImportedProfile(raw, now)`          | 任意 JSON → 合法 `UserProfile`（新 id / 新时间戳）       |
| `coerceImportedSecret(raw, now)`           | 任意 JSON → 合法 `PasswordEntry`（新 id / `useCount` 0） |

`coerceImportedSecret` 复用 `entryFields()`（`src/lib/types.ts`）处理 `username/password/notes`
旧字段迁移，避免再写一份迁移逻辑。

### 3.3 下载原语抽公共层

新建 `src/lib/download-json.ts`：`downloadJSONFile(filename, data)` → 走
`downloadBlob()`，`application/json`。`WorkflowsTab` 的局部 `downloadJSON` 删除、改调它
（AGENTS.md §5.2：同一逻辑第二处必须抽公共层）。

### 3.4 UI

`DataTab.tsx`：

- 每个分区头部一排操作：`[添加…] [导入] [导出选中]`；`导出选中` 在未勾选时 disabled。
- 每张卡片头部加一个复选框（复用 `.wf-item-check`），分区标题行加「全选」复选框
  （复用 `.wf-select-all`）。
- 一个隐藏 `<input type="file">`，两个分区的「导入」按钮都触发它。
- 导出文件名：`profiles-selected.json` / `secrets-selected.json`。
- 密钥分区额外提示：导出文件里是**明文**密钥值（`t.dataExportPlaintext`）。

### 3.5 安全边界

导出的文件包含明文密钥，等价于把凭据复制到磁盘上。UI 明说这一点；导入端只接受本项目
自己的信封（`type` + `version` 匹配），避免把任意 JSON 写进存储。

## 4. 影响面与风险 · Impact & risks

| 风险                          | 处理                                             |
| ----------------------------- | ------------------------------------------------ |
| 导出文件含明文密钥            | 密钥分区加明文提示文案                           |
| 导入覆盖本机条目              | 语义固定为「总是新建」，`id` 重新生成            |
| 勾选状态与列表不同步          | 勾选集合存 id；列表刷新后自动剔除已不存在的 id   |
| `downloadJSON` 出现第二份     | 抽 `src/lib/download-json.ts`，WorkflowsTab 改调 |
| 旧的 `username/password` 密钥 | 复用 `entryFields()` 迁移成 `fields`             |

## 5. 验收 · Acceptance

- [ ] 个人资料分区勾选 2 条 → 导出文件 `profiles` 有 2 项、`secrets` 为空。
- [ ] 密钥分区勾选 1 条 → 导出文件含该条的全部字段（`fields` 原样）。
- [ ] 导入密钥文件 → 新增对应条目（**新 id**），本机同名条目不受影响。
- [ ] 导入个人资料文件 → `custom` 自定义字段一并导入。
- [ ] 导入非本项目 JSON → 报错 banner，不写入存储。
- [ ] 门禁：`pnpm typecheck` / `pnpm test` / eslint+prettier（git ls-files）/ `pnpm build`。
