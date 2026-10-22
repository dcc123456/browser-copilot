# 实施计划 · 最新下载上传 + Excel 解析

对应设计：`specs/2026-10-22-latest-download-upload-and-excel-parse-design.md`

## Step 1 · 纯逻辑层（无 chrome / 无 DOM）

新增：

- `src/lib/workflow/latest-file.ts`
  - `matchesAccept(accept, name, mimeType?)`
  - `pickLatestFile(candidates, { accept, filePattern })`
- `src/lib/workflow/excel-parse.ts`
  - `parseSpreadsheet(bytes, fileName, { sheetName, hasHeader })`
  - 内部：zip 读取、OOXML 读取、CSV 读取、表头/对象化、日期转换
- `src/lib/workflow/file-artifact.ts`
  - `artifactFromFile(file, source?)`
  - MIME 映射补充 xlsx / xls

测试：

- `tests/latest-file.spec.ts`：accept 扩展名/MIME/通配、glob、时间倒序、无匹配。
- `tests/excel-parse.spec.ts`：
  - 自建 xlsx fixture（`tests/helpers/xlsx-fixture.ts`，node:zlib 写 zip）
  - 共享字符串/富文本/内联字符串、数字、布尔、日期样式、空单元格、跳行
  - 多工作表与按名选择、找不到表名
  - CSV：BOM、引号、换行、分号/Tab、空行
  - 非法 zip / .xls / 损坏 XML → 明确错误

验收：`pnpm test -- tests/excel-parse.spec.ts tests/latest-file.spec.ts`

## Step 2 · 上传算子 `latest-download`

修改：

- `src/lib/workflow/file-artifact.ts`：错误码 `UPLOAD_NO_MATCHING_FILE`
- `src/lib/download-dir.ts`：`getUnattendedDownloadDir(create=false)` 支持只读枚举
- `src/background/workflow-engine/executors.ts`
  - `upload-file` 增加 `latest-download` 分支
  - 枚举配置下载目录（`getDownloadDir`）与内部目录，异常跳过
  - `fallbackToPicker` 走 `requestUserFiles`
- `src/lib/workflow/blocks/catalog.ts`：`sourceMode` 注释与默认字段
- `src/workflow-editor/blocks/batchA/EditUploadFile.tsx`：第三项单选与字段
- `src/workflow-editor/i18n.ts`：新增中文表单文案
- `src/lib/workflow/operator-tools.ts`：schema enum / filePattern / fallbackToPicker
- `src/lib/workflow/operator-registry.ts`：语义短语与 goal contract
- `src/lib/workflow/block-requirements.ts`：latest-download 不要求 fileVariable
- `src/lib/workflow/failure-code.ts`：`UPLOAD_NO_MATCHING_FILE` 分类
- `src/lib/workflow/operator-guide.ts`：来源说明
- `server/src/driver.ts`：按谓词取最新下载（扩展 `waitForDownload` 或新增方法）
- `server/src/executors.ts`：latest-download 分支（读取文件字节 → data URL）
- `server/test/`：Runner 侧 latest-download 单测

测试：

- `tests/upload-latest-download.spec.ts`（mock driver + mock 目录枚举）：
  - 取最新匹配文件并上传
  - accept / filePattern 过滤
  - 无匹配 → `UPLOAD_NO_MATCHING_FILE`
  - `fallbackToPicker` → 调用选择器
  - 结果变量不含绝对路径

## Step 3 · Excel 算子 `parse-excel`

修改：

- `src/lib/workflow/blocks/custom.ts`：新增 `parse-excel` 目录条目
- `src/workflow-editor/blocks/batchC/EditParseExcel.tsx` + `index.ts`：表单
- `src/workflow-editor/i18n.ts` / `block-i18n.ts`：名称、描述、表单文案
- `src/background/workflow-engine/executors.ts`：`parse-excel` 执行器
- `src/lib/workflow/operator-tools.ts`：schema 与 enum
- `src/lib/workflow/operator-registry.ts`：语义短语、goal contract
- `src/lib/workflow/operator-guide.ts`：映射表 + 固定搭配说明
- `src/lib/workflow/block-requirements.ts`：sourceMode / 变量必填
- `src/lib/workflow/data-params.ts`：`parse-excel: []`（全部结构性）
- `src/lib/workflow/producer-completeness.ts`：两个输出变量都算生产者
- `src/lib/workflow/failure-code.ts` / `failure-taxonomy.ts` / `repair/recovery-model.ts`：解析失败码分类
- `src/lib/workflow/excel-node.ts`：扩展与 Runner 共用的节点胶水（字段读取、data URL 解码、写变量）
- `src/lib/workflow/repair/patch-policy.ts`：`parse-excel: 'SAFE'`
- `src/lib/workflow/reliability.ts`：安全块
- `server/src/executors.ts`：Runner 执行器（仅变量来源）
- `server/test/`：Runner 解析单测

不需要改 `loop-collapse` / `validation` / `operator-class`：显式 `variableName` 已被现有规则覆盖；
`parse-excel` 与 `upload-file` 一样在生成时现场执行（生成时用户在场，可响应文件选择器），
不进入 record-only 集合。

测试：

- `tests/parse-excel-executor.spec.ts`：
  - user-select 选择 csv → 两个变量写入
  - workflow-file xlsx → 对象数组/二维数组
  - sheetName 命中 / 未命中
  - `.xls` / 损坏文件 → 明确错误
  - 缺失变量 / 多文件 → 明确错误
- `tests/operator-class.spec.ts` / `tests/operator-tools.spec.ts` 等既有测试按新块更新。

## Step 4 · 门禁与证据

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
pnpm verify:injected      # 未改动注入内联函数也跑一次确认
pnpm server:typecheck
pnpm server:test
```

- 浏览器可见行为：优先用 `pnpm selftest` 或加载 unpacked extension 手工验证；
  若环境无法完成，明确报告 BLOCKED 与原因，不用单测冒充浏览器证据。
- 收尾逐条回答 AGENTS.md「收尾自检」①–⑩。

## Step 5 · 交付说明

- 修改文件清单
- 新增算子参数与示例工作流片段
- 已知限制：`.xls`、Zip64、加密工作簿、Chrome 原生下载目录不可枚举
