# 上传“最新下载文件”与 Excel 解析算子 · 设计

## 1. 背景与已定决策

本设计同时覆盖两个需求，但实现按“一次一个主题”推进：

1. `upload-file` 增加「自动上传最新下载文件」来源：运行到该节点时不再弹系统文件框，
   而是从用户配置的下载目录（设置 → 下载目录）与扩展内部下载目录
   （`browser-copilot-downloads`，无人值守写入位置）中，按类型/文件名模式挑出
   **修改时间最新**的文件并自动上传。可选：没有匹配文件时转为现场选择。
2. 新增 `parse-excel` 算子：用户在运行时选择一个 `.xlsx` / `.csv`（或从上游文件变量
   读取），解析为 JSON，写入两个变量供后续节点使用：
   - `variableName`：对象数组（首行表头 → 每行一个对象）；
   - `rawVariableName`：原始二维数组（含表头行）。

已通过对话确认的选项：

- 上传来源：运行时自动取最新文件（不是编辑时嵌入，也不是只弹手动列表）。
- Excel 输入：算子内置运行时选择器，同时也接受上游 `fileVariable`
  （原“仅上游变量”的选择在确认“本地文件无上游生产者”后改为内置选择器）。
- Excel 格式：`.xlsx` + `.csv`；`.xls` 明确拒绝并提示转换。
- 输出形状：对象数组 + 原始二维数组，两者都写变量。

## 2. 现状审计

- `upload-file` 已支持 `user-select`（侧边栏 `UserFilePickerCard`，真实手势打开系统
  选择器）与 `workflow-file`（变量中的 `WorkflowFileArtifact` / data URL），两种来源
  汇聚到 `requestUserFiles` / `normalizeWorkflowFiles` 与内核 `upload_files`。
- 下载落盘有两条扩展侧路径（`lib/download-dir.ts`）：
  - 设置中配置的下载目录句柄（IndexedDB key `download`）；
  - OPFS 内部目录 `browser-copilot-downloads`（无人值守兜底）。
    两者都由 service worker 直接读写，因此执行器可以枚举并读取，不需要侧边栏参与。
- Runner 侧下载落在本次 run 的 `artifactsDir`（`server/src/driver.ts` 的
  `saveDownload`），另有 `RunDriver.waitForDownload` 记录最近下载。
- 仓库目前没有任何“把本地文件读进变量”的算子（`handle-download` 只存
  id/filename/url；截图只存 data URL），这是 Excel 算子必须自带选择器的原因。
- 没有现成的 xlsx/csv 解析依赖；`package.json` 无 zip/XML 库。

## 3. 需求一：`upload-file` 的 `latest-download` 来源

### 3.1 配置模型

```ts
type UploadFileSourceMode = 'user-select' | 'workflow-file' | 'latest-download'

interface UploadFileData {
  sourceMode: UploadFileSourceMode
  selector: string
  fileVariable?: string
  accept?: string // 类型过滤，沿用现有字段
  filePattern?: string // 新增：文件名 glob，如 report-*.xlsx；空 = 不限
  fallbackToPicker?: boolean // 新增：无匹配时是否打开系统选择器，默认 false
  multiple?: boolean // 该来源固定上传 1 个文件；字段保留只为兼容
  waitForSelector?: boolean
  waitSelectorTimeout?: number
  verifyAfterUpload?: boolean
}
```

`latest-download` 的执行流程：

```text
upload-file(latest-download)
  → 枚举候选：
      配置下载目录（若已授权可读）
      + OPFS browser-copilot-downloads（若存在）
      + Runner：本次 run 的下载记录 / artifactsDir
  → 按 accept（扩展名或 MIME，含 image/* 通配）与 filePattern（glob）过滤
  → 按 lastModified 倒序取第 1 个
  → artifactFromFile(file, source='download')
  → 与 user-select / workflow-file 共用 upload_files 内核入口与节点验证
```

无匹配时：

- `fallbackToPicker: true` → 走现有 `requestUserFiles`，等同于用户现场选文件；
- 否则抛 `UPLOAD_NO_MATCHING_FILE`，错误信息列出扫描过的目录与过滤条件。
- 目录句柄权限为 `prompt` 时不在 worker 里强行请求（需要用户手势），跳过该目录；
  错误信息会提示到设置里重新授权。

### 3.2 选择与排序的纯逻辑

新增 `src/lib/workflow/latest-file.ts`：

- `matchesAccept(accept, fileName, mimeType?)`：支持 `.xlsx`、`image/*`、
  `application/pdf`、`*/*`；复用 `file-artifact` 的扩展名/MIME 推断。
- `pickLatestFile(candidates, { accept, filePattern })`：复用
  `block-output.globMatch` 做 glob，返回 `lastModified` 最大者。
- 候选只携带元数据 + `getFile()` 延迟读取，避免枚举时把大文件读进内存。

### 3.3 UI

编辑器单选组变为三项：

```
上传方式
(•) 用户选择文件
( ) 自动上传 Workflow 文件
( ) 自动上传最新下载文件
```

选中第三项时显示：

- 文件类型（accept）
- 文件名模式（filePattern，可选）
- 没有匹配文件时让我手动选择（fallbackToPicker）
- 共享：等待选择器、上传后验证

### 3.4 明显边界

- 只扫描**扩展可访问**的两个下载目录；Chrome 自身“下载”文件夹无法在无用户手势时
  枚举，不在范围内。
- 只取 1 个最新文件（用户选择的是“取最新”语义）。
- 不把绝对路径写入工作流或结果变量；结果只记录文件名、类型、大小、来源目录种类。

## 4. 需求二：`parse-excel` 算子

### 4.1 目录条目

```ts
{
  id: 'parse-excel',
  name: 'Parse Excel',
  description: 'Parse an .xlsx or .csv file into JSON rows (objects + raw 2-D array)',
  icon: 'lucide:FileSpreadsheet',
  category: 'data',
  editComponent: 'EditParseExcel',
  data: {
    sourceMode: 'user-select',   // 'user-select' | 'workflow-file'
    fileVariable: '',
    sheetName: '',               // 空 = 第一张工作表（仅 xlsx）
    hasHeader: true,             // 首行作为表头
    variableName: 'lastExcelRows',
    rawVariableName: 'lastExcelRawRows',
  }
}
```

### 4.2 解析语义

- 来源：
  - `user-select`：`requestUserFiles({ accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', multiple: false })`；
  - `workflow-file`：`variableNameOf` + `normalizeWorkflowFiles`，必须是单个文件。
- 格式判定：文件名扩展名优先；随后按 MIME；未知时按 zip 魔数 `PK\x03\x04` 猜 xlsx。
  `.xls` 直接拒绝（`EXCEL_LEGACY_FORMAT_UNSUPPORTED`）。
- 数值：数字单元格 → `number`；布尔 → `boolean`；错误值 → 字符串；空 → `null`。
- 日期：按样式判定——内置格式 14–22（日期/时间）、27–31、36、50–54、57–58（日期）、
  32–35、45–47、55–56（时间），以及自定义格式码中的 y/m/d/h/s；
  日期序列值转 UTC；纯日期输出 `YYYY-MM-DD`，含时间输出 ISO 8601。
- 字符串：共享字符串（含富文本多个 `<t>`）、内联字符串、公式缓存值。
- 行列：按单元格 `r` 引用补空位；整行全空的格式行跳过，避免刷格式产生的万行空数据。
- 工作表：`sheetName` 精确匹配；为空取工作簿第一张；找不到时错误信息列出可用表名。
- 表头：`hasHeader=true` 时首行转字符串作为键；空表头 → `column1`、`column2`…；
  重名 → `name_2`；数据行缺列补 `null`，超出表头的列补 `columnN`。
- 输出：
  - `ctx.variables[variableName] = objects`
  - `ctx.variables[rawVariableName] = rows`（含表头行，值已做类型转换）
  - 同步写 `lastExcelSheet`（选中的工作表名）供调试/后续节点引用。

### 4.3 解析实现选型（与证据）

候选：

1. **引入 SheetJS (`xlsx`)**：npm 版本停在 0.18.5，含已知 ReDoS/原型污染公告，
   SheetJS 官方已转向自有 CDN；与本仓库“可离线安装、无高危依赖”的取向冲突。否决。
2. **引入 exceljs / read-excel-file**：可用，但为一个算子新增数百 KB 运行时代码与
   传递依赖，且 Excel 解析只用到 OOXML 的一个子集。暂不采用。
3. **自实现 OOXML 子集读取器（采用）**：`.xlsx` 是 zip + XML；只需读取
   `xl/workbook.xml`、rels、`sharedStrings.xml`、`styles.xml`、worksheet XML。
   解压用平台内置 `DecompressionStream('deflate-raw')`（本机 Node 24 已实测可用；
   构建目标 chrome116 支持），XML 用只针对上述元素的容错扫描器。`.csv` 用自写
   RFC-4180 解析。**零新增运行时依赖**，扩展 service worker 与 Runner 共用同一份
   纯 TypeScript。

已知限制（在 UI/错误信息中写明）：

- 不支持 `.xls`（BIFF 二进制）、Zip64、加密工作簿、宏与图表；
- 公式读取缓存值；没有缓存值的公式单元格为 `null`；
- 合并单元格只取左上角值；
- CSV 统一按 UTF-8 解码（自动去 BOM），自动识别逗号/分号/Tab 分隔。

### 4.4 错误模型

新增失败码（`failure-code.ts`）：

- `UPLOAD_NO_MATCHING_FILE`：最新下载来源无匹配文件（environment/workflow，
  可修复：调整 accept/filePattern 或开启手动兜底）。
- `EXCEL_PARSE_FAILED`：文件不是可解析的 xlsx/csv 或结构损坏（workflow，可修复：
  重新选择文件 / 修正 fileVariable）。
- `EXCEL_SHEET_NOT_FOUND`：指定工作表不存在（提示可用表名）。
- `EXCEL_LEGACY_FORMAT_UNSUPPORTED`：`.xls` 不支持（提示另存为 .xlsx/.csv）。

所有错误消息包含节点上下文与可执行修复建议，不包含本地绝对路径。

## 5. 双侧（扩展 / Runner）落地

| 能力                          | 扩展                              | Runner                                                                |
| ----------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `upload-file/latest-download` | 配置下载目录 + OPFS 内部目录      | 本次 run 的下载记录（`RunDriver` 新增按谓词取最新下载）；无匹配时错误 |
| `upload-file/user-select`     | 保留                              | 保留现有“headless 不可用”错误                                         |
| `parse-excel`                 | 选择器 + 变量                     | 仅变量；选择器模式给出明确错误                                        |
| 解析器                        | `src/lib/workflow/excel-parse.ts` | 同一文件                                                              |

Runner 侧修改 `server/src/driver.ts` / `server/src/executors.ts`，不新增第二套解析实现。

节点胶水（`data` 字段读取、data URL 解码、输出变量名默认值与写入）抽在
`src/lib/workflow/excel-node.ts`，扩展与 Runner 两个执行器共用——执行器只保留
“从哪里拿到文件”的宿主差异。文件名 glob 复用 `block-output.globMatch`。

## 6. 安全与隐私

- 不把本地绝对路径写入工作流、变量、日志或 LLM prompt；只保留文件名/类型/大小。
- 最新文件来源只读取扩展已获授权的目录；不请求额外权限、不绕过用户手势。
- 系统文件选择器仍只由真实用户点击触发；`latest-download` 不打开系统对话框。
- Excel 内容进入工作流变量，上游可能来自用户本地文件；不写回磁盘、不发网络。

## 7. 非目标

- 不支持 `.xls`、加密 xlsx、多工作表一次性合并；
- 不在编辑时把文件内容嵌入工作流；
- 不扫描 Chrome 原生下载目录；
- 不新增第三方 Excel/zip 依赖；
- 不改动页面内核 `upload_files` 的注入语义。
