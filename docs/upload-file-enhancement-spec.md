# Workflow `upload-file` 节点增强 Spec

## 1. 文档定位

本 Spec 用于直接指导 AI Coding Agent 对 Browser Copilot 现有 `upload-file` Workflow 节点进行增强。

本次**只增强现有文件上传节点，不新增独立上传节点**，让同一个 `upload-file` 支持两种来源：

1. **用户选择文件**：用户在 Browser Copilot UI 点击“选择文件”，打开系统文件选择器，选择文件后由 Workflow 自动将文件上传到当前网页。
2. **自动上传 Workflow 文件**：文件已经存在于 Workflow 变量中，例如截图、JavaScript 生成图片、其他 Binary Artifact；不打开系统文件选择器，直接在浏览器页面上下文构造 `File + DataTransfer` 并注入 `input[type=file]`。

两种模式最终必须汇聚到同一个页面上传执行函数。

---

## 2. 核心目标

### 2.1 功能目标

完成后，`upload-file` 必须能够：

- 用户选择本地单文件并上传
- 用户选择多个本地文件并上传
- 从 Workflow 变量读取已生成文件并自动上传
- 支持 Data URL 图片
- 支持结构化 Workflow File/Binary Artifact
- 将文件直接注入网页 `<input type="file">`
- 对常见 Drop Zone 提供自动注入能力
- 上传后验证文件是否真正进入网页上传控件
- 支持后续 Workflow 验证业务上传成功
- 兼容历史 Workflow

### 2.2 非目标

本次不实现：

- 新增 `upload-generated-file` 节点
- 让 Workflow 自动操作 OS 文件选择器
- 通过 `/Users/...`、`C:\...` 本地绝对路径作为自动上传机制
- 通过键盘模拟向系统文件对话框输入路径
- 让 AI Agent 使用 JS 自己实现上传
- 改造其他文件节点的核心职责

---

## 3. 当前问题

实现前必须确认并修复以下问题：

1. `upload-file` Catalog 与 executor 当前存在字段漂移，例如 `filePaths` 与 `fileData`。
2. 当前实现存在把 data URL 当成普通字符串通过 `fill` 写入文件 input 的风险，这不是正确的 `<input type=file>` 上传方式。
3. 自动上传不能依赖 OS 文件选择器。
4. 用户文件与 Workflow 生成文件没有统一数据模型。
5. Screenshot / JavaScript 等输出需要能直接成为上传输入。
6. 节点需要结构化 Goal / Success Criteria / Failure Context。

---

## 4. 最终产品行为

### 4.1 配置模型

```ts
type UploadFileSourceMode =
  | 'user-select'
  | 'workflow-file'

interface UploadFileConfig {
  sourceMode: UploadFileSourceMode
  selector: string
  fileVariable?: string
  accept?: string
  multiple?: boolean
  waitForSelector?: string
  waitSelectorTimeout?: number
  verifyAfterUpload?: boolean
}
```

字段要求：

| 字段 | 必填 | 说明 |
|---|---:|---|
| `sourceMode` | 是 | `user-select` / `workflow-file` |
| `selector` | 是 | 文件 input 或上传目标选择器 |
| `fileVariable` | workflow-file 时 | Workflow 文件变量 |
| `accept` | 否 | 文件类型过滤 |
| `multiple` | 否 | 是否支持多文件 |
| `waitForSelector` | 否 | 上传前等待目标 |
| `waitSelectorTimeout` | 否 | 等待超时 |
| `verifyAfterUpload` | 否 | 是否做节点级验证 |

默认：

```ts
{
  sourceMode: 'user-select',
  multiple: false,
  verifyAfterUpload: true,
  waitSelectorTimeout: 10000
}
```

---

## 5. 文件统一数据模型

新增或统一为：

```ts
interface WorkflowFileArtifact {
  type: 'file'
  name: string
  mimeType: string
  size?: number
  dataUrl: string
  width?: number
  height?: number
  source:
    | 'user'
    | 'screenshot'
    | 'javascript'
    | 'download'
    | 'generated-image'
    | 'other'
}
```

要求：

- 支持单个 data URL
- 支持单个 Artifact
- 支持 Artifact 数组
- 非法数据在上传前失败
- 不保存本地绝对路径作为 Workflow 数据

---

## 6. 用户选择模式

执行流程：

```text
Upload File
  ↓
sourceMode=user-select
  ↓
Workflow Executor
  ↓
发出 user-file-required
  ↓
Browser Copilot UI
  ↓
用户点击“选择文件”
  ↓
系统文件选择器
  ↓
用户选择文件
  ↓
读取 File 对象
  ↓
转换为 WorkflowFileArtifact[]
  ↓
uploadFilesToPage()
  ↓
节点验证
  ↓
Workflow 继续
```

### 硬性要求

系统文件选择器**只能由真实用户手势触发**。

禁止：

```text
Workflow Background → 自动打开 native file picker
Workflow → 键盘输入本地路径 → OS dialog
```

---

## 7. 用户选择 UI

在 SidePanel / Workflow Runner 提供隐藏 file input：

```html
<input
  type="file"
  hidden
  accept="..."
  multiple
/>
```

用户点击“选择文件”时，在该用户 gesture 中执行 `input.click()`。

选择后读取 `input.files`，转换为：

```ts
{
  name: file.name,
  mimeType: file.type,
  size: file.size,
  dataUrl: ...,
  source: 'user'
}
```

---

## 8. 自动上传模式

执行流程：

```text
Upload File
  ↓
sourceMode=workflow-file
  ↓
ctx.variables[fileVariable]
  ↓
normalizeWorkflowFiles()
  ↓
WorkflowFileArtifact[]
  ↓
uploadFilesToPage()
  ↓
节点验证
```

支持：

### 8.1 Data URL

```text
data:image/png;base64,...
```

### 8.2 单个 Artifact

```json
{
  "type": "file",
  "name": "generated.png",
  "mimeType": "image/png",
  "dataUrl": "data:image/png;base64,...",
  "source": "generated-image"
}
```

### 8.3 Artifact 数组

支持一次上传多个文件。

---

## 9. 页面端文件注入

### 9.1 禁止

禁止：

```ts
fill(selector, dataUrl)
```

禁止：

```text
input.value = dataUrl
input.value = localFilePath
click upload → native file picker → 输入路径
```

### 9.2 正确方案

页面上下文使用：

```text
dataUrl
  ↓
Blob
  ↓
File
  ↓
DataTransfer
  ↓
input.files
  ↓
input event
  ↓
change event
```

推荐核心实现：

```ts
async function uploadFilesToInput(
  selector: string,
  files: WorkflowFileArtifact[]
) {
  const input = document.querySelector(selector)

  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Upload target is not an input element')
  }

  if (input.type !== 'file') {
    throw new Error('Upload target is not input[type=file]')
  }

  if (!input.multiple && files.length > 1) {
    throw new Error('Target does not support multiple files')
  }

  const dataTransfer = new DataTransfer()

  for (const fileData of files) {
    const response = await fetch(fileData.dataUrl)
    if (!response.ok) {
      throw new Error(`Failed to decode file: ${response.status}`)
    }

    const blob = await response.blob()
    const file = new File(
      [blob],
      fileData.name,
      {
        type:
          fileData.mimeType ||
          blob.type ||
          'application/octet-stream',
        lastModified: Date.now()
      }
    )

    dataTransfer.items.add(file)
  }

  input.files = dataTransfer.files

  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))

  return {
    count: input.files.length,
    files: Array.from(input.files).map(file => ({
      name: file.name,
      type: file.type,
      size: file.size
    }))
  }
}
```

具体实现可以根据当前 page kernel / content-script 架构调整，但必须保持以上语义。

---

## 10. Drop Zone 支持

如果页面是自定义拖拽上传区域，需要支持：

```ts
dropFiles(selector, files)
```

要求：

1. 构造 `DataTransfer`
2. 添加 `File`
3. 触发 `dragenter`
4. 触发 `dragover`
5. 触发 `drop`
6. 将 `dataTransfer` 绑定到事件
7. 验证页面状态变化

如果页面存在隐藏的 `input[type=file]` 并可直接定位，优先使用 `input.files` 注入。

---

## 11. 统一页面上传入口

必须有统一入口：

```ts
uploadFilesToPage({
  selector,
  files,
  ctx
})
```

内部逻辑：

```text
resolve target
    ↓
input[type=file] ?
    ├─ yes → uploadFilesToInput()
    └─ no
         ↓
      drop-zone ?
         ├─ yes → dropFiles()
         └─ no → explicit error
```

用户选择模式与自动上传模式必须共用这个入口。

---

## 12. 节点 Goal / Success Criteria

节点必须增加结构化 Contract：

```ts
{
  goal: '将指定文件放入网页上传控件',
  successCriteria: [
    'target resolved',
    'expected file count injected',
    'filename matches expected',
    'mime type matches expected',
    'input/change event dispatched'
  ]
}
```

必须区分：

```text
Node Success
= 文件已经进入网页上传控件

Workflow Goal Success
= 业务页面已经确认上传完成
```

因此后续可以通过 Wait / Verify Upload Result 完成业务验证。

---

## 13. AI Operator 描述

只向 Workflow Generator 暴露一个 `upload-file` Operator。

推荐描述：

```text
Upload File

Goal:
将用户选择的本地文件，或 Workflow 中已经生成的文件，
上传到网页指定上传控件。

Modes:

user-select:
用户需要从系统文件选择器选择本地文件。
适合：
- 用户要求上传本地文件
- Workflow 需要人工选择文件

workflow-file:
从 Workflow 变量读取已经生成的文件。
适合：
- 截图上传
- JavaScript 生成图片
- 已生成的文件
- 其他 Workflow File Artifact

禁止：
- 使用 fill 给 input[type=file] 赋值
- 使用本地绝对路径作为自动上传方式
- 自动操作 OS 文件选择器
- 让 JS 节点自己重新实现上传逻辑
```

---

## 14. UI 要求

编辑器中的 Upload File 节点必须显示：

```text
上传方式
(•) 用户选择文件
( ) 自动上传 Workflow 文件
```

### 用户选择模式

显示：

- 文件类型
- 是否多文件
- 目标选择器

### 自动模式

显示：

- 文件变量
- 目标选择器
- 是否多文件

变量选择器应优先显示：

- WorkflowFileArtifact
- Data URL
- Screenshot output
- JavaScript generated file

---

## 15. 运行时 UI

执行到 `user-select` 时，SidePanel / Runner 必须显示：

```text
Workflow 正在等待选择文件

[选择文件]
```

用户行为：

- 选择完成 → 继续 Workflow
- 取消 → 节点 `cancelled`
- 超时 → 节点 `timeout`

建议错误码：

```text
USER_FILE_SELECTION_CANCELLED
USER_FILE_SELECTION_TIMEOUT
```

---

## 16. 错误模型

至少支持：

```text
UPLOAD_TARGET_NOT_FOUND
UPLOAD_TARGET_NOT_FILE_INPUT
UPLOAD_FILE_VARIABLE_NOT_FOUND
UPLOAD_FILE_VARIABLE_INVALID
UPLOAD_FILE_DATA_INVALID
UPLOAD_MULTIPLE_NOT_SUPPORTED
UPLOAD_USER_SELECTION_CANCELLED
UPLOAD_USER_SELECTION_TIMEOUT
UPLOAD_FILE_INJECTION_FAILED
UPLOAD_FILE_VERIFICATION_FAILED
UPLOAD_DROPZONE_UNSUPPORTED
```

错误信息必须：

- 人类可读
- 可以被 AI Repair 使用
- 包含 nodeId
- 包含 selector
- 不泄露用户本地绝对路径

---

## 17. Legacy 兼容

历史 Workflow 可能存在：

```text
filePaths
fileData
```

要求：

1. 新 schema 使用 `sourceMode` / `fileVariable`
2. 旧字段继续读取
3. 必要时做兼容转换
4. 新 Workflow 不再写入旧字段
5. 历史 Workflow 不能因升级而失效

旧 `filePaths` 只能作为 legacy compatibility，不能成为 AI 新生成 Workflow 的上传机制。

---

## 18. AI Repair

Upload File 修复输入必须包含：

```text
goal
successCriteria
errorCode
selector
sourceMode
fileMetadata
targetEvidence
```

修复优先级：

1. 重新定位真实 `input[type=file]`
2. 修正 selector
3. 检查 hidden input
4. 检查 Drop Zone
5. 修正 multiple 配置
6. 修正 file variable
7. 最后验证上传

禁止因为 Upload File 失败而直接让 AI Agent / JS 重新实现整套上传逻辑。

---

# 19. 实施步骤

## Phase 0：代码审计与回归保护

目标：准确定位现有 Upload File 的完整执行链。

任务：

- 找到 Catalog
- 找到 executor
- 找到 variable/refData 读取路径
- 找到 SidePanel / Runner 用户交互机制
- 找到 content script / page kernel
- 找到 Screenshot data URL 输出路径
- 找到 legacy Workflow 兼容逻辑

验收：

- [ ] 输出修改文件清单
- [ ] 现有 Upload File 测试可运行
- [ ] 明确 schema / executor / UI / page runtime 四层入口

---

## Phase 1：统一 Upload File Schema

目标：建立稳定的新 schema。

实现：

```text
sourceMode
selector
fileVariable
accept
multiple
waitForSelector
waitSelectorTimeout
verifyAfterUpload
```

验收：

- [ ] TypeScript 类型完整
- [ ] 新 UI 能保存
- [ ] executor 能读取
- [ ] 新 Workflow 不生成 `filePaths`

---

## Phase 2：实现 WorkflowFileArtifact

目标：统一不同来源的文件。

实现：

```ts
normalizeWorkflowFiles()
```

支持：

- [ ] data URL
- [ ] 单 Artifact
- [ ] Artifact array
- [ ] PNG
- [ ] JPEG
- [ ] PDF
- [ ] 非法数据明确失败

---

## Phase 3：实现用户选择模式

目标：用户只操作 Browser Copilot 的“选择文件”，其余自动完成。

实现：

```text
workflow:user-file-required
workflow:user-file-selected
workflow:user-file-cancelled
```

验收：

- [ ] 单文件选择成功
- [ ] 多文件选择成功
- [ ] accept 生效
- [ ] cancel 正确处理
- [ ] timeout 正确处理
- [ ] 用户无需再次点击网页上传按钮

---

## Phase 4：实现自动上传模式

目标：不经过 OS 文件选择器直接上传 Workflow 文件。

支持：

- [ ] Screenshot
- [ ] JavaScript data URL
- [ ] WorkflowFileArtifact
- [ ] Artifact array

验收：

- [ ] 自动模式不打开系统文件选择器
- [ ] 不依赖本地文件路径
- [ ] 自动上传成功

---

## Phase 5：实现 Browser File Injection

目标：使用浏览器内存中的 `File` 完成网页上传。

强制链路：

```text
dataUrl → Blob → File → DataTransfer → input.files → input/change
```

验收：

- [ ] `input.files.length` 正确
- [ ] filename 正确
- [ ] mimeType 正确
- [ ] size 正确
- [ ] input 事件触发
- [ ] change 事件触发
- [ ] React 页面可以识别
- [ ] Vue 页面可以识别
- [ ] 普通 HTML 页面可以识别
- [ ] 禁止 `fill(dataUrl)`
- [ ] 禁止写 `input.value`

---

## Phase 6：实现 Drop Zone

目标：支持非标准 file input 上传区域。

验收：

- [ ] dragenter
- [ ] dragover
- [ ] drop
- [ ] hidden input + custom drop zone
- [ ] 页面成功接收文件

---

## Phase 7：统一执行管线

目标：两种来源最终共享一套页面上传代码。

要求：

```text
user-select ──┐
              ├→ resolve files → uploadFilesToPage → verify
workflow-file ┘
```

验收：

- [ ] 两种模式共用 `uploadFilesToPage`
- [ ] 没有重复的上传实现
- [ ] 自动模式不存在系统文件路径操作

---

## Phase 8：UI

目标：用户能清楚配置上传来源。

验收：

- [ ] 用户选择模式 UI
- [ ] 自动上传模式 UI
- [ ] 模式切换
- [ ] 保存后重新打开配置一致
- [ ] 导入导出保持一致
- [ ] Replay 保持一致

---

## Phase 9：AI Operator Registry

目标：让 Workflow Generator 能稳定选择 `upload-file`。

验收：

准备至少 20 个中文 + 20 个英文任务，覆盖：

- 上传本地头像
- 上传本地简历
- 上传生成的图片
- 上传刚生成的截图
- upload my resume
- upload the generated image
- upload the screenshot

验证：

- [ ] 选择 `upload-file`
- [ ] 正确选择 `sourceMode`
- [ ] 不生成 file path 上传
- [ ] 不生成 fill 上传
- [ ] 不让 JS 重新实现上传

---

## Phase 10：AI Repair

目标：Upload File 失败可以依据 Goal / Success Criteria / Error Context 最小修复。

验收：

- [ ] selector 错误可以修复
- [ ] hidden input 可以修复
- [ ] Drop Zone 可以识别
- [ ] multiple 配置问题可以修复
- [ ] file variable 问题可以修复
- [ ] Repair 后 Node Verification PASS
- [ ] 需要时 Workflow Goal Verification PASS

---

## Phase 11：性能 / 安全 / 兼容性

测试：

- 1 MB
- 5 MB
- 20 MB
- 5 文件批量上传

验收：

- [ ] 不记录用户本地绝对路径
- [ ] 不泄露 API secret
- [ ] 大文件不会产生无界内存增长
- [ ] 历史 Workflow 可以运行
- [ ] 新 Workflow 使用新 schema

---

# 20. 单元测试清单

## Schema

- [ ] U001 sourceMode=user-select
- [ ] U002 sourceMode=workflow-file
- [ ] U003 默认值
- [ ] U004 legacy fileData
- [ ] U005 legacy filePaths

## File Normalization

- [ ] U006 单 data URL
- [ ] U007 单 Artifact
- [ ] U008 Artifact array
- [ ] U009 invalid data URL
- [ ] U010 missing name
- [ ] U011 invalid mime type

## Browser Injection

- [ ] U012 single file
- [ ] U013 multiple files
- [ ] U014 multiple=false
- [ ] U015 filename verify
- [ ] U016 mimeType verify
- [ ] U017 size verify
- [ ] U018 input event
- [ ] U019 change event
- [ ] U020 wrong selector
- [ ] U021 non-file input

## User Selection

- [ ] U022 user selects one file
- [ ] U023 user selects multiple files
- [ ] U024 cancel
- [ ] U025 timeout
- [ ] U026 accept filter

## Drop Zone

- [ ] U027 dragenter
- [ ] U028 dragover
- [ ] U029 drop
- [ ] U030 hidden input

---

# 21. E2E 验收清单

## E01：用户上传单张图片

```text
打开测试上传页面
→ Upload File
→ 用户选择图片
→ Workflow 自动注入
→ 页面显示图片
```

通过条件：

- [ ] 用户只需在 Browser Copilot 点击一次“选择文件”
- [ ] 不需要再次操作网页上传按钮
- [ ] 页面收到图片

## E02：用户上传多个文件

```text
multiple=true
→ 选择 3 个文件
→ 页面收到 3 个文件
```

- [ ] `input.files.length === 3`

## E03：Screenshot 自动上传

```text
Screenshot → variable → Upload File(workflow-file)
```

- [ ] 不打开系统文件选择器
- [ ] 页面成功接收截图

## E04：JavaScript 图片自动上传

```text
JavaScript → generatedImage → Upload File(workflow-file)
```

- [ ] 不写本地路径
- [ ] 不打开系统文件选择器
- [ ] 页面成功接收图片

## E05：图片生成后自动上传

```text
AI Agent → JavaScript image generation → Upload File → Verify Upload
```

- [ ] AI Agent 产生 Prompt
- [ ] JS 产生文件 Artifact
- [ ] Upload File 成功
- [ ] Verify Upload PASS
- [ ] Workflow Goal PASS

## E06：用户取消

- [ ] 节点状态为 cancelled
- [ ] Workflow 不误判成功

## E07：目标错误

- [ ] 明确错误
- [ ] 错误码正确
- [ ] AI Repair 可以定位问题

## E08：文件变量不存在

- [ ] `UPLOAD_FILE_VARIABLE_NOT_FOUND`
- [ ] 不尝试系统文件选择器
- [ ] 不进行无意义 retry

## E09：multiple 不支持

- [ ] 明确失败
- [ ] 不静默丢文件

## E10：Drop Zone

- [ ] 不打开系统文件选择器
- [ ] Drop Zone 收到文件
- [ ] 页面显示上传结果

---

# 22. 性能验收

记录：

```text
uploadResolutionMs
fileNormalizationMs
pageInjectionMs
verificationMs
totalUploadMs
```

建议目标：

### User Select

从用户完成文件选择，到文件进入 `input.files`：

```text
P95 < 2s
```

不计算用户选择文件本身的耗时。

### Workflow File

5 MB 以下单文件：

```text
P95 < 2s
```

不把网站服务器最终网络上传耗时算入该指标。

---

# 23. 安全验收

必须满足：

- [ ] 不把本地绝对路径发给 LLM
- [ ] 不把本地绝对路径写入 Workflow JSON
- [ ] 不在日志记录完整本地路径
- [ ] API Key / secret 不进入页面 JS
- [ ] 用户文件只在必要 runtime context 中处理
- [ ] 用户选择文件由真实用户手势触发
- [ ] 自动上传不绕过浏览器安全模型

---

# 24. 最终逐项验收总表

AI Coding Agent 必须按顺序执行，不允许使用“基本完成”“理论支持”等描述替代实际验证。

## Schema

- [ ] A01 `sourceMode` 完成
- [ ] A02 `selector` 完成
- [ ] A03 `fileVariable` 完成
- [ ] A04 `accept` 完成
- [ ] A05 `multiple` 完成
- [ ] A06 timeout 完成
- [ ] A07 legacy `fileData` 兼容
- [ ] A08 legacy `filePaths` 兼容
- [ ] A09 新 Workflow 不生成 legacy 字段

## 用户选择

- [ ] B01 有“用户选择文件”模式
- [ ] B02 用户点击可以打开系统文件选择器
- [ ] B03 单文件选择成功
- [ ] B04 多文件选择成功
- [ ] B05 accept 生效
- [ ] B06 cancel 正确
- [ ] B07 timeout 正确
- [ ] B08 无需再次操作网页上传按钮

## 自动上传

- [ ] C01 支持 data URL
- [ ] C02 支持 Artifact
- [ ] C03 支持 Artifact array
- [ ] C04 Screenshot 可直接上传
- [ ] C05 JavaScript 图片可直接上传
- [ ] C06 自动模式不打开系统文件选择器
- [ ] C07 自动模式不依赖本地路径

## Browser File Injection

- [ ] D01 使用 Blob
- [ ] D02 使用 File
- [ ] D03 使用 DataTransfer
- [ ] D04 设置 `input.files`
- [ ] D05 触发 input
- [ ] D06 触发 change
- [ ] D07 验证 filename
- [ ] D08 验证 mimeType
- [ ] D09 验证 size
- [ ] D10 验证 files.length
- [ ] D11 禁止 `fill(dataUrl)`
- [ ] D12 禁止 `input.value` 文件路径

## Drop Zone

- [ ] E01 Drop Zone 定位
- [ ] E02 dragenter
- [ ] E03 dragover
- [ ] E04 drop
- [ ] E05 页面成功响应

## Node Goal / Verification

- [ ] F01 Goal 结构化
- [ ] F02 Success Criteria 结构化
- [ ] F03 Error Code
- [ ] F04 Node Verification
- [ ] F05 上传证据

## AI Repair

- [ ] G01 selector Repair
- [ ] G02 hidden input Repair
- [ ] G03 Drop Zone fallback
- [ ] G04 multiple Repair
- [ ] G05 file variable Repair
- [ ] G06 不使用 JS 重写上传
- [ ] G07 Repair 后 Node Verification PASS
- [ ] G08 必要时 Workflow Goal Verification PASS

## AI Generation

- [ ] H01 本地文件任务正确选择 Upload File
- [ ] H02 Workflow 文件任务正确选择 Upload File
- [ ] H03 正确选择 sourceMode
- [ ] H04 不生成 file path 上传
- [ ] H05 不生成 fill 上传
- [ ] H06 中文任务测试通过
- [ ] H07 英文任务测试通过

## E2E

- [ ] I01 本地图片
- [ ] I02 多文件
- [ ] I03 Screenshot 自动上传
- [ ] I04 JS 图片自动上传
- [ ] I05 图片生成后上传
- [ ] I06 用户取消
- [ ] I07 selector 错误
- [ ] I08 文件变量错误
- [ ] I09 multiple 错误
- [ ] I10 Drop Zone

## 性能 / 安全 / 兼容

- [ ] J01 1 MB
- [ ] J02 5 MB
- [ ] J03 20 MB
- [ ] J04 5 文件批量
- [ ] J05 不记录本地绝对路径
- [ ] J06 不泄露 secret
- [ ] J07 历史 Workflow 可运行
- [ ] J08 新 Workflow schema 正确
- [ ] J09 全部相关 unit tests PASS
- [ ] J10 核心 E2E 全部 PASS

---

# 25. 最终完成标准

只有同时满足以下条件才能将任务标记为完成：

1. 用户选择模式可用。
2. 自动 Workflow 文件模式可用。
3. 两种模式共用同一页面上传执行管线。
4. 自动模式完全不依赖系统文件选择器。
5. 浏览器端使用 `File + DataTransfer` 注入文件。
6. 不再通过 `fill(dataUrl)` 设置 `input[type=file]`。
7. Screenshot / JavaScript 生成文件可以直接上传。
8. Drop Zone 至少支持一套真实 E2E 场景。
9. Node Goal / Success Criteria 已结构化。
10. AI Repair 可以依据失败上下文完成最小修复。
11. 历史 Workflow 继续可执行。
12. Unit Test 全部通过。
13. 核心 E2E 全部通过。
14. 性能、安全、兼容性验收通过。

最终 Coding Agent 必须输出：

```text
UPLOAD_FILE_ENHANCEMENT_STATUS: DONE
```

并附：

- 修改文件列表
- 测试命令
- 测试结果
- E2E 结果
- A01-J10 全部 PASS 状态
- 如存在 BLOCKED / FAIL，必须列出原因和对应日志

禁止仅用以下表述作为完成证明：

```text
基本完成
应该可以
理论上支持
未测试但实现了
```
