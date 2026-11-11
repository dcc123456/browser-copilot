# 工作流面板 / 编辑器六项改进 · 实施计划

日期：2026-11-11 · 设计见 `specs/2026-11-11-workflow-editor-improvements-design.md`

## 执行纪律

- 六个阶段**串行**，每阶段：改代码 → 跑完整门禁 → `git add` 只加本阶段文件 → 英文 Conventional
  Commit → `git push origin main`。不把无关改动混进同一次提交（§8.2）。
- 门禁命令（每阶段都要跑，`pnpm build` 是硬门禁）：
  `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm build`
- 阶段顺序兼顾依赖：§4 的「斜杠补全识别脚本变量」先于「prompt 修复」，因为后者的
  `outputVariables` 声明要由前者的 `producedVariableNames` 消费。
- 每次推送后在回复里给出 commit hash、「这次改了什么」「人工怎么测」（§8.6）。

## 阶段 1 · 下线 AI 修复按钮 · `fix(sidepanel): remove the AI repair entry from workflow cards`

文件：
- `src/sidepanel/WorkflowsTab.tsx`：删 `FailureCenterDialog` import（:56）、`failureCenter` state（:563-567）、
  按钮块（:1725-1743）、dialog 渲染（:1867-1877）。
- `src/lib/i18n.ts`：删 `failureCenterAiRepair` 声明（:796）、en（:2588）、zh（:4327）。

验收：grep 不到 `failureCenterAiRepair` / `setFailureCenter`；门禁全绿。

## 阶段 2 · AI 助手多会话历史 · `feat(workflow): persist AI assistant chats per workflow`

文件：
- 新增 `src/lib/workflow/operator-chat-sessions.ts`：`OperatorChatSession` 类型、
  `listOperatorChatSessions` / `saveOperatorChatSession` / `deleteOperatorChatSession` /
  `deleteOperatorChatSessionsForWorkflow`，key `operatorChat:<workflowId>`，`withKeyLock` 串行写。
- `src/lib/workflow/storage.ts`：`deleteWorkflows()` 里级联删除会话 key。
- `src/lib/messages.ts`：3 个命令 + 3 个 result 类型。
- `src/background/index.ts`：3 个 command case。
- `src/workflow-editor/ai/OperatorChatDock.tsx`：新增 `workflowId` prop；会话列表 state、
  加载/保存/切换/删除；头部「历史」按钮与列表 UI；`startNewSession` 改为新建会话。
- `src/workflow-editor/App.tsx`：`:1979` 传 `workflowId={workflowId}`。
- `src/workflow-editor/i18n.ts`：`operatorAi*` 历史相关 key（en + zh）。
- 新增 `tests/operator-chat-sessions.spec.ts`。

验收：门禁全绿；类型检查确认 en/zh 两侧 key 数一致（人工，该文件无封闭类型保护）。

## 阶段 3 · 日志删除 · `feat(workflow): allow deleting run logs individually and in bulk`

文件：
- `src/workflow-editor/sidebar/LogsModal.tsx`：checkbox（仅 finished）、全选、单条删除、
  批量删除、`confirmDialog`、删除后 `load()`。
- `src/workflow-editor/i18n.ts`：`logs*` 删除相关 key（en + zh）。

验收：门禁全绿；确认 `tasks.finished.delete` 同时清内存与持久化。

## 阶段 4 · 脚本变量进入斜杠补全 · `fix(workflow): expose script-produced variables to slash suggestions`

文件：
- 新增 `src/lib/workflow/script-outputs.ts`：`scriptOutputVariableNames()` /
  `mergeScriptOutputNames()`。
- `src/lib/workflow/producer-completeness.ts`：`producedVariableNames()` 与 `producesVariable()`
  支持 `javascript-code`（`data.outputVariables` + 静态提取）；`lastResult` 作为脚本节点别名。
- 新增 `tests/script-outputs.spec.ts`；扩充 `tests/var-suggestions.spec.ts`、
  `tests/producer-completeness.spec.ts`。

验收：门禁全绿；单测覆盖 `automaSetVariable` 单/双引号/反引号、`variables.x =`、
`variables['x'] =`、去重、非法名过滤、`{{name}}` 完整性校验不再误报。

## 阶段 5 · 修复 AI 助手生成脚本不设置变量 · `fix(workflow): make the AI assistant emit script output variables`

文件：
- `src/lib/workflow/blocks/catalog.ts`：`javascript-code` 默认 data 增 `outputVariables: []`。
- `src/lib/workflow/operator-tools.ts`：`SCHEMA_OVERRIDES[JAVASCRIPT_BLOCK_ID]` 增
  `outputVariables`，改写 `code` 描述（明确 `return` ≠ 具名变量）。
- `src/lib/workflow/operator-guide.ts`：把 `automaSetVariable` 提升为通用规则。
- `src/lib/workflow/operator-advise.ts`：Rules 增补脚本产变量规则；
  `adviseCandidates()` 对 `JAVASCRIPT_BLOCK_ID` 强制 `detailed=true`；
  `operatorDataOfProposal()` 对脚本节点写入合并后的 `data.outputVariables`。
- 扩充生成/prompt 相关测试（按 `tests/` 现有文件命名）。

验收：门禁全绿；prompt 单测断言 Rules 与 javascript-code 完整 schema 同时出现。

## 阶段 6 · 运行态终止按钮 · `feat(workflow): replace the run button with a stop control while running`

文件：
- `src/lib/messages.ts`：`tasks.cancelWorkflow` 命令与 result。
- `src/background/index.ts`：新 case，`listRunning()` 按 `workflowId` 找 run → `cancelRun()`。
- `src/workflow-editor/toolbar/TopToolbar.tsx`：`cancelling` / `onStop` props，running 时换
  `Square` + `stopRun`，取消中 disabled。
- `src/workflow-editor/App.tsx`：`cancelling` state、`handleStop`、`cancelledByUserRef`、
  `handleRun` 的失败分支与 `finally` 复位。
- `src/workflow-editor/i18n.ts`：`stopRun` / `stoppingRun` / `runStopped` / `runStopFailed`（en + zh）。

验收：门禁全绿；grep 确认 `cancelRun` 是唯一取消入口；人工验证步骤写进交付说明。

## 收尾自检核对表（全部阶段完成后再逐条回答）

① typecheck / test / lint / format:check / build 实际输出；② Runner 侧未改，标 N/A；
③ 未改 `workflow-engine/**` 与 `ai-takeover.ts`，标 N/A；④ 未改 `executeScript({func})`，标 N/A；
⑤ 浏览器实证 BLOCKED + 人工步骤；⑥ 复用检查（本设计 §0）；⑦ 死代码与命名；
⑧ UI/i18n 双语与 Tailwind token；⑨ 暂存区无 `tmp/`；⑩ 英文提交、不打 tag；
⑪ commit hash + 已推送 main；⑫ 「这次改了什么」+「人工怎么测」。

## 风险

- `src/workflow-editor/i18n.ts` 无封闭类型保护，en/zh 漏一条不会被 `tsc` 拦；每阶段改完人工核对。
- 会话保存在扩展存储（可能落盘为明文 JSON），与仓库既有会话一致，不额外加密。
- 六个阶段共享工作树；每阶段 `git status --short` 确认只暂存自己的文件。
