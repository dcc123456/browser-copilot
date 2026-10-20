# 实施计划 · Plan — 密钥与个人资料的批量导出/导入

设计见 `specs/2026-10-20-data-export-import-design.md`。一次只推进一步，每步都能单独验证。

## Step 1 · 纯逻辑层

- `src/lib/data-export.ts`：信封类型、`buildDataExport` / `isDataExport`、
  `coerceImportedProfile` / `coerceImportedSecret`。
- `src/lib/download-json.ts`：`downloadJSONFile`（走 `export-answer.ts` 的 `downloadBlob`）。
- `src/sidepanel/WorkflowsTab.tsx`：删掉局部 `downloadJSON`，改调公共层。

**验证**：`tests/data-export.spec.ts` 覆盖信封生成、判别、两种 coercion 的正常与拒绝分支。

## Step 2 · 交互与文案

- `src/lib/i18n.ts`：`dataSelectAll` / `dataExportSelected` / `dataImport` /
  `dataExportDone` / `dataImportDone` / `dataImportFailed` / `dataExportPlaintext` /
  `dataSelectItem`，en + zh-CN 双侧。
- `src/sidepanel/DataTab.tsx`：
  - 两个分区各自的勾选集合、全选、导出选中、导入；
  - 一个隐藏 file input 供两个分区共用；
  - 导入时逐条 `profiles.save` / `passwords.save`（新 id），完成后刷新列表并报 banner。

**验证**：`tests/data-tab-export.spec.tsx`（jsdom，mock `sendCommand`）覆盖
「勾选后导出只含选中项」与「导入创建新条目、不覆盖同标签旧条目」。

## Step 3 · 门禁与证据

- `pnpm typecheck` / `pnpm test` / eslint + prettier（git ls-files）/ `pnpm build`。
- `tmp/preview` 复用上一轮的 vite + playwright harness，把 `DataTab` 也渲染出来，
  截图确认勾选框、导出/导入按钮在真实构建 CSS 下的样子。

## 不做 · Not doing

- 不做「导出全部」按钮（用户口径：仅勾选导出）。
- 不做导出文件的加密 / 密码保护。
- 不做与 Runner 控制台（`server/web`）的联动——Runner 侧没有凭据存储
  （`server/src/executors.ts` 明确只从环境变量取 `BC_SECRET_*`）。
- 不做跨设备自动同步。
