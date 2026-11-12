# 工作流面板 / 编辑器六项改进 · 设计

日期：2026-11-11 · 范围：`src/sidepanel/**`、`src/workflow-editor/**`、`src/lib/**`、`src/background/index.ts`

## 0. 范围与纪律

用户一次提出六项围绕工作流面板与编辑器的改动。按 AGENTS.md §0「一次只推进一个主题」与 §8.2
「一个功能一次提交」，拆成六个独立阶段，逐阶段写代码 → 跑门禁 → 提交推送 `main`（见配套 `-plan.md`）。
本文件是这六个主题的**共同设计记录**；每个阶段的验收命令与文件清单在计划里。

共同约束：

- 不新增第二套同类基础设施（§5.6）：会话记录复用 `fileStorageArea` + `withKeyLock`，走既有
  `sendCommand` 通道；终止复用既有 `cancelRun` / `AbortController`；日志删除复用既有
  `tasks.finished.delete`；变量候选复用唯一口径 `producedVariableNames`。
- 新文案一律 en + zh-CN 双写（§3），UI 样式只用 Tailwind 语义 token（§2）。
- 跨端逻辑只放 `src/lib/**`（§5.7）；不改 `workflow-engine/**`、不改注入内核、不改 `executeScript` 内联函数体
  → 收尾自检 ②③④ 不触发。

## 1. 下线工作流面板的 AI 修复按钮

### 证据（本机读源码）

- 唯一入口：`src/sidepanel/WorkflowsTab.tsx:1729-1743` 的 `failureCenterAiRepair` 按钮，
  仅当最近一次运行失败时出现；`:1867-1877` 挂 `FailureCenterDialog`；`:563-567` 是其 state。
- 全仓 grep `FailureCenter|workflows.recovery` 确认：该协议的唯一调用方是
  `src/sidepanel/FailureCenter.tsx:51-67`，后台 handler 在 `src/background/index.ts:3141`。
- i18n：`src/lib/i18n.ts:795-830`（`Messages` 声明）、`:2588-2605`（en）、`:4327-4344`（zh）
  的 `failureCenter*` 一族。

### 选型与证据

| 候选                                                                        | 结论                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A. 只删按钮 + 其 state/import/dialog 渲染 + 该按钮专用的 i18n key           | **采用**                                                           |
| B. 连 `FailureCenter.tsx`、`workflows.recovery` 协议、后台 handler 一并删除 | 否决                                                               |
| C. 保留按钮但置灰                                                           | 否决：用户要求「删除」，置灰仍占位置且会引发「为什么不能点」的疑问 |

否决 B 的理由：

1. AGENTS.md §8.5 明确「删文件」不在长期授权内、要先问；`FailureCenter.tsx` 是物理文件。
2. 后台 `workflows.recovery` handler 与 `createAiRepairProposer` / `startBackgroundAutoRepair` 共处同一
   文件区段，而 `workflows.autoRepair*` 是 run 路径与 ChatTab 仍在使用的**另一套**能力；大范围删改的
   牵连面无法靠静态 grep 完全判定，风险与本次「隐藏入口」的收益不匹配。
3. 用户诉求是「功能修不成功，别再让用户点」；按钮消失即达成。遗留的孤儿组件与协议在交付说明里
   显式标注，可作为后续单独主题清理。

**决策**：A。删除 `WorkflowsTab.tsx` 的 import、state、按钮、dialog 渲染；删除 `lib/i18n.ts` 中
`failureCenterAiRepair` 的声明/en/zh（按钮文案已无消费方）。其余 `failureCenter*` 文案保留给仍存在的
`FailureCenter.tsx`（否则该文件编译失败），不制造半成品。

> §7.1 说明：本主题没有引入项目里没有的能力，取证方式为**本机源码 grep + 引用链核对**（上文列出的
> 文件与行号），不涉及第三方 API 形态，无需外部文档或 spike。

## 2. AI 算子助手：多会话历史，绑定工作流

用户已确认形态：**每个工作流可保存多份历史会话，可切换 / 新建 / 删除**。

### 证据

- `src/workflow-editor/ai/OperatorChatDock.tsx:13` 文件头明示「transcript lives only in this
  component's state」；`:408` `const [turns,setTurns]=useState<Turn[]>([])`；`:518-529`
  `startNewSession()` 只清空内存。
- `getContext()` 里有 `workflowId?`（`:116`），但那是**发送时**读取；`App.tsx:231` 自己持有
  `workflowId` state，`:1979` 装配 Dock 时未传。
- 工作流删除统一收口在 `src/lib/workflow/storage.ts:317 deleteWorkflows(ids)`：单删（`:313`）、
  批量、分组删除（`background/index.ts:1965`）三条路径都经此，是唯一可靠的级联点。
- 既有会话持久化模板 `src/lib/storage.ts:848 conversationKey()` / `:1092 deleteConversation()` 使用
  `area.get/set/remove` + `withKeyLock`；`src/lib/fs-store.ts:588 fileStorageArea()` 的 `get/set` 依赖
  `resolveHandle()`，未配置目录时退回 `chrome.storage.local`。

### 选型与证据

| 候选                                                                                                                                                            | 结论     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A. 新建 `src/lib/workflow/operator-chat-sessions.ts`，按 `operatorChat:<workflowId>` 存会话数组，UI 经 `sendCommand` 读写，`deleteWorkflows` 级联 `area.remove` | **采用** |
| B. UI 组件直接 import 该存储模块读写                                                                                                                            | 否决     |
| C. 复用侧边栏 `conv:<id>` / `conversations` 会话体系                                                                                                            | 否决     |

否决 B：仓库所有 UI→持久化访问（ChatTab、HistoryTab、WorkflowsTab）都走 `sendCommand`；
`fileStorageArea` 的文件句柄 / outbox 由后台持有，UI 页面各起一个 `sharedArea` 会让同一 key 的写入
落到不同层（文件层 vs `chrome.storage.local` 镜像），产生读写分裂。走消息通道与既有惯例一致。

否决 C：`conv:` 存的是 `WireMessage[]`（侧边栏聊天），`Turn` 是编辑器助手的富文本行（proposals、
landing、reasoning、截图报告），字段与语义都不同；塞进 `conversations` 会污染侧边栏会话列表与
history，且 `conversationId` 与 `workflowId` 的绑定关系要另造索引，反而多一套映射。

**新增文件**（§5.3 要求说明理由）：`src/lib/workflow/operator-chat-sessions.ts`。理由：会话类型与
序列化属于 chrome-free 的 `src/lib/**` 领域层，若塞进 `OperatorChatDock.tsx`，`background/index.ts`
与 `workflow/storage.ts` 就要反向 import 一个 React 组件；若塞进已 1300+ 行的 `lib/storage.ts`，
会把「工作流附属数据」混进通用设置存储。`workflow/storage.ts` 已 import `newId` from `../storage`
（`:14`），新模块只依赖 `fs-store` / `key-lock`，不产生循环。

### 数据结构

```
key: `operatorChat:<workflowId>`  →  OperatorChatSession[]
OperatorChatSession {
  id, workflowId, title, createdAt, updatedAt,
  turns: unknown[]      // UI transcript 的 JSON 快照
}
```

`turns: unknown[]` 是**刻意**的：存储层不需要理解每条消息（提案、落地回执、思考过程）的语义，
避免在 lib 层复制一套 `OperatorChatDock.tsx` 的 `Turn` 类型、或让 `OperatorLanding` 等 UI 类型反向
泄漏到存储层。加载时在 UI 侧做边界校验（只接受 `role: user|assistant` 且 `content: string` 的行，
丢掉不可恢复的 `offer` 交互态）——校验放在系统边界，符合 §5.5。

### 协议（扩展 `src/lib/messages.ts`，不新建协议族）

```
operatorChat.sessions          { workflowId }              → sessions: OperatorChatSession[]
operatorChat.sessions.save    { workflowId, session }     → ok
operatorChat.sessions.delete  { workflowId, sessionId }   → ok
```

后台 handler 落在 `background/index.ts` 既有 command switch，直接调存储函数。

### 级联删除

`deleteWorkflows(ids)` 在写完 `workflows` 后，对每个 id 调
`deleteOperatorChatSessionsForWorkflow(id)`（`area.remove(key)`）。单删 / 批量 / 分组删除自动覆盖，
无需改三处 UI 或后台 case。

### UI 行为

- Dock 新增 `workflowId: string | null` prop（`App.tsx` 传入）。`null` 时会话能力不可用（不读写）。
- 打开 Dock / 切换 workflowId → 拉会话列表，选中 `updatedAt` 最新的一份并载入其 turns；
  列表为空时不预先建空会话，第一条消息落地时才创建（避免一堆空记录）。
- `turns` 变化 → 保存当前会话（标题取第一条用户消息截断）；`startNewSession()` 改为新建会话；
  新增「历史」按钮展开会话列表，可切换、删除单份（确认弹窗）。
- 请求在途时切换会话沿用现有 `sessionGenerationRef` 防串答。

## 3. 运行日志：单条与批量删除

### 证据

- `src/workflow-editor/sidebar/LogsModal.tsx:92-114` 每 1200 ms 轮询 `workflows.running`；
  `:86` `boards = {runs, finished}`；`:32-68` `RunRow` 每行是一个 `<button>`，无删除入口。
- 存储侧已有 `src/lib/task-store.ts:459 deleteRun(id)`；命令 `tasks.finished.delete`
  （`background/index.ts:1807-1811`）同时 `forgetFinished(runId)` + `deleteRun(runId)`。
- 批量删除 UI 模板：`src/sidepanel/HistoryTab.tsx:266-307 BatchBar`、`:579-621 removeOne/removeSelected`、
  `confirmDialog()`（`src/ui/confirm.tsx:24`）；`App.tsx:2002` 已挂 `<ConfirmHost/>`。

### 选型与证据

| 候选                                                                                     | 结论                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A. 仅对 `boards.finished` 开放多选与删除，复用 `tasks.finished.delete` + `confirmDialog` | **采用**                                              |
| B. 允许删除运行中的 run                                                                  | 否决                                                  |
| C. 新增「清空全部」按钮                                                                  | 否决：需求只要单个 + 批量，不做超出需求的功能（§5.5） |

否决 B：调研确认 `forgetFinished` 只清 `finished[]`，在途 run 结束时 `finishRun` 会重新
`unshift` 并经 `persistFinished` 写回 `scheduledTaskRuns`，出现「删了又回来」；要根治得引入
tombstone 集合，属于新建状态设施（§5.6）且没有必要。运行中的行禁用勾选即可。

**改动**：`RunRow` 增加 checkbox（仅 `run.outcome !== undefined` 可选）与单条删除按钮；
列表上方全选 + 「删除所选 (N)」；确认弹窗后循环发 `tasks.finished.delete`，随后立即 `load()`
并把已删 id 从选中集移除。运行中持续追加与删除不冲突（两者作用于不同集合）。

## 4. 脚本算子的输出变量（需求 4 + 5）

### 根因证据（关键）

调研发现「AI 助手」指编辑器右下角 `OperatorChatDock`，它的生成路径与 workflow generation mode
**不是同一套 prompt**：

- `src/background/operator-advise-engine.ts:404` 用 `buildOperatorAdvisePrompt()`
  （`src/lib/workflow/operator-advise.ts:982-1143`），**完全不加载** `OPERATOR_GUIDE`；
  Rules 在 `:1123-1135`，只说「上游变量写 `{{variableName}}`」（`:1130`），没有脚本产变量规则。
- `adviseCandidates()`（`:859-878`）把 discovery shortlist 与 core 标为 `detailed=true`（打印完整
  JSON Schema），其余 `allOperators()` 为 `detailed=false`；prompt `:1088-1096` 对 compact 行**只打印
  参数名**。`javascript-code` 的 `aiExposure:'fallback'`，几乎总是 compact 行 → 模型看不到
  `SCHEMA_OVERRIDES[JAVASCRIPT_BLOCK_ID]` 里 `code` 字段那段「`automaSetVariable(name, value)`
  writes a variable later blocks read as `{{name}}`」（`operator-tools.ts:449-456`）。
- 全仓 grep：没有任何 prompt 明说「`return` / 裸表达式只写 `lastResult`，**不产生**具名变量」。
  `OPERATOR_GUIDE`（`operator-guide.ts:106-112`）只在图片上传特例里提 `automaSetVariable`。
- 执行侧口径：`src/background/workflow-engine/executors.ts:2018-2028` 只合并
  `run.data.variables` 并写 `lastResult`；`src/inpage/kernel.ts:2916-2918` 的
  `automaSetVariable(name,value)` 就是 `variables[String(name)] = value`。
- 静态口径：`producedVariableNames()`（`src/lib/workflow/producer-completeness.ts:107-128`）对
  `javascript-code` 返回空（既不在 `VARIABLE_PRODUCER_FIELD`，catalog `data` 也没有输出字段）。
  它被 `var-suggestions.collectSuggestions:142`（`/` 菜单）、`integrity.ts:115`、
  `generated-validation.ts:205`、`variable-provenance.ts:142` 共同消费，是**唯一**口径。

### 选型与证据

| 候选                                                                                                                                                                                   | 结论     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A. 修 prompt（助手 Rules + 强制 detailed + schema/guide 补规则 + `outputVariables` 声明），落图写 `data.outputVariables`；`producedVariableNames` 认识脚本节点并从 code 静态提取变量名 | **采用** |
| B. 执行器兜底：对 `data.outputVariables` 里未设置的变量用脚本返回值填充                                                                                                                | 否决     |
| C. 落图时把模型写的 `return X` 字符串改写成 `automaSetVariable('name', X)`                                                                                                             | 否决     |

否决 B：改 `src/background/workflow-engine/executors.ts` 触发收尾自检 ③（`bench:debug` before/after），
且 `server/src/executors.ts` 是镜像实现（§5.6），双侧都要改与测；更重要的是它会让「脚本声明了变量但
没赋值」这种错误静默成功，掩盖根因。

否决 C：脚本体可以是裸表达式、语句体、`await`、`automaNextBlock()` 提前结束；字符串改写无法覆盖
多行/多分支，包装 IIFE 会改变 `automaNextBlock()` 的中断语义（`kernel.ts` 的 finish 流程），风险远大于收益。

### A 的落点

1. **新模块** `src/lib/workflow/script-outputs.ts`（§5.3 说明理由：静态提取逻辑有两个消费者——
   `producedVariableNames` 与落图归一化，按 §5.2 第二次出现就抽公共层，不能内联两份）：
   - `scriptOutputVariableNames(code: string): string[]`：识别
     `automaSetVariable('name'|"name"|`name`, …)`、`variables.name =`、`variables['name'] =`；
     只取合法变量名，去重、保持出现顺序。
   - `mergeScriptOutputNames(declared, code)`：声明 + 静态提取合并。
2. **`producer-completeness.ts`**：`producedVariableNames()` 对 `blockId === 'javascript-code'` 合并
   `data.outputVariables`（字符串数组）与从 `data.code` 提取的名字；
   `producesVariable()` 对脚本节点不再因「不在 `VARIABLE_PRODUCER_FIELD`」直接 `return false`，
   改走 `producedVariableNames().includes(name)`。→ `/` 菜单、完整性校验、provenance 同时打通。
3. **`operator-tools.ts` / `catalog.ts`**：`javascript-code` 增加 `outputVariables` 参数（schema
   override + catalog 默认 `[]`），改写 `code` 描述，明写「`return` / `automaNextBlock` 只写
   `lastResult`；后续节点要用 `{{name}}`，必须 `automaSetVariable('name', value)` 并在
   `outputVariables` 里列出该名字」。
4. **`operator-guide.ts`**：把 `automaSetVariable` 从「图片上传特例」提升为通用规则。
5. **`operator-advise.ts`**：`buildOperatorAdvisePrompt` 的 Rules 增补同口径规则；
   `adviseCandidates()` 对 `JAVASCRIPT_BLOCK_ID` 强制 `detailed=true`（否则规则仍看不到 schema）；
   `operatorDataOfProposal()` 对脚本节点写入合并后的 `data.outputVariables`。
6. **测试**：`tests/script-outputs.spec.ts`（新增）+ 扩充 `tests/var-suggestions.spec.ts` /
   `tests/producer-completeness.spec.ts`，覆盖静态提取、斜杠候选、完整性校验；prompt 文本断言放
   `tests/operator-advise*.spec.ts`。

### 为什么这能满足需求 4

根因是**模型根本没看到这条规则**（compact 行 + 不加载 guide），不是执行器缺能力。把规则放进
单条 user prompt 的 Rules、并让脚本算子的完整 schema 出现在候选列表里，生成的代码就会显式调用
`automaSetVariable`；`data.outputVariables` 只是让静态图知道「这个节点会写哪些名字」，供 `/` 与
完整性校验使用，不改变执行语义。

## 5. 运行态：启动按钮替换为终止按钮

### 证据

- `TopToolbar.tsx:251-259`：running 时按钮 `disabled` 且只显示 `LoaderCircle`。
- `App.tsx:250` `running` 是局部 state；`handleRun`（`:951-1014`）靠 `workflows.run` 这个**长 Promise**
  的 `finally` 复位（`:1007-1010`），运行期间拿不到 `runId`（`background/index.ts:2290-2300` 只在
  结束时返回 `outcome.runId`）。
- 引擎已有完整取消通道：`running-tasks.ts:423-439 cancelRun()` → `task.controller.abort()`；
  `RunningTask.workflowId?`（`:62`）已存在；`run-workflow.ts:555-560` 用 `AbortSignal.any` 监听。
- `ExecuteWorkflowResult.outcome`（`run-workflow.ts:275-326`）含 `'cancelled'`，但 `workflows.run`
  的返回（`messages.ts:774-777`）把它压成了 `{ok, skipped, summary, error, runId}`，取消时
  `summary === ''` → 编辑器会误报 `runFailed`。

### 选型与证据

| 候选                                                                                                        | 结论                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A. 新增 `tasks.cancelWorkflow { workflowId }`，后台用 `listRunning()` 找到该工作流的 run 并复用 `cancelRun` | **采用**                                                           |
| B. UI 先发 `workflows.running` 查 `runId` 再发 `tasks.cancel`                                               | 否决：两次往返，短任务可能在查询返回前结束；查询与取消之间存在竞态 |
| C. 改 `workflows.run` 让后台在开始时先回一个 `runId`                                                        | 否决：破坏长 Promise 的单返回值协议，牵动所有调用方与消息类型      |

A 复用既有 `cancelRun`，不新增取消设施；`RunningTask.workflowId` 已是现成字段，无需改引擎。

### UI

- `TopToolbar` 新增 `cancelling` / `onStop` props：running 时按钮由 `Play` 变 `Square`，
  title 由 `run` 变 `stopRun`，`disabled={cancelling}`，不再 `disabled={running}`。
- `App.tsx` 新增 `cancelling` state 与 `handleStop()`：发 `tasks.cancelWorkflow`，
  用 `cancelledByUserRef` 标记；`handleRun` 的失败分支据此跳过 `runFailed` toast，
  改显「运行已终止」。`workflows.run` 的 `finally` 负责把 `running`/`cancelling` 一起复位。
  终止失败（没有在途 run）时提示并返回 idle。

## 6. 新增文案清单（en + zh-CN 一一对应）

`src/workflow-editor/i18n.ts` 的 `EDITOR_STRINGS`（注意：该文件不受 `Messages` 封闭类型保护，
必须人工核对 en/zh 两侧同时补齐）：

| key                              | en                                                | zh                                            |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| `stopRun`                        | Stop run                                          | 终止运行                                      |
| `stoppingRun`                    | Stopping…                                         | 正在终止…                                     |
| `runStopped`                     | Run stopped                                       | 运行已终止                                    |
| `runStopFailed`                  | Could not stop the run                            | 终止运行失败                                  |
| `logsDeleteOne`                  | Delete this log                                   | 删除这条日志                                  |
| `logsDeleteSelected`             | Delete selected ({count})                         | 删除所选（{count}）                           |
| `logsSelectAll`                  | Select all                                        | 全选                                          |
| `logsDeleteTitle`                | Delete run logs                                   | 删除运行日志                                  |
| `logsDeleteConfirm`              | Delete {count} run log(s)? This cannot be undone. | 确定删除 {count} 条运行日志？此操作不可撤销。 |
| `logsDeleted`                    | {count} run log(s) deleted                        | 已删除 {count} 条运行日志                     |
| `operatorAiHistory`              | Chat history                                      | 会话记录                                      |
| `operatorAiHistoryEmpty`         | No saved chats yet                                | 还没有保存的会话                              |
| `operatorAiSessionUntitled`      | New chat                                          | 新会话                                        |
| `operatorAiSessionDelete`        | Delete this chat                                  | 删除该会话                                    |
| `operatorAiSessionDeleteConfirm` | Delete this chat and all its messages?            | 删除该会话及其全部消息？                      |
| `operatorAiHistoryLoadFailed`    | Could not load chat history                       | 会话记录加载失败                              |

`src/lib/i18n.ts`：删除 `failureCenterAiRepair` 的声明 + en + zh（`Messages` 封闭类型会机检两侧对齐）。

## 7. 测试与验收

- 新增/扩充：`tests/script-outputs.spec.ts`、`tests/var-suggestions.spec.ts`、
  `tests/producer-completeness.spec.ts`、`tests/operator-advise-prompt.spec.ts`（按实际文件名），
  会话存储 `tests/operator-chat-sessions.spec.ts`（纯函数 + mock storage area）。
- 每阶段门禁：`pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm build`。
- 未改 `workflow-engine/**`、`ai-takeover.ts`、`executeScript({func})` → 自检 ②③④ 不触发。
- 浏览器实证：本环境无法加载 unpacked extension 并操作真实 Chrome；相关 UI 行为标 **BLOCKED**，
  交付说明里给可复制的人工验证步骤与预期现象（§8.6），不写「应该可以」。

## 8. 已知取舍

- AI 修复的后台 recovery 协议与 `FailureCenter.tsx` 保留为孤儿代码（见 §1），待用户确认后单独清理。
- 新建但未保存的工作流若产生会话，其 `workflowId` 不会进入 `deleteWorkflows`，会留下少量孤儿会话
  key；不做惰性清理（§5.5 不为假想问题加设施），需要时可在后续主题按 `listWorkflows()` 收敛。
- 日志删除只作用于已结束的运行；运行中的行不可勾选（见 §3）。

## 9. 实施记录（2026-11-12 收尾）

| No. | Commit                                                                                 | 与设计的偏差                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `465cbc4` `fix(sidepanel): remove the AI repair entry from workflow cards`             | 按计划                                                                                                                                                                                                                                                                                            |
| 2   | `cdd6314` `feat(workflow): persist AI assistant chats per workflow`                    | 按计划                                                                                                                                                                                                                                                                                            |
| 3   | `2bc974c` `feat(workflow): allow deleting run logs individually and in bulk`           | 按计划                                                                                                                                                                                                                                                                                            |
| 4   | `80e1041` `fix(workflow): expose script-produced variables to slash suggestions`       | `producedVariableNames` 对脚本节点额外发布引擎 `lastResult` 别名（设计未提；下游引用脚本返回值的常见写法需要它）                                                                                                                                                                                  |
| 5   | `f2d594a` `feat(workflow): make the assistant's script steps declare output variables` | §4 落点 1-5 全部落地；guide 的图片特例按计划升格为通用规则                                                                                                                                                                                                                                        |
| 6   | `9eedfcb` `feat(workflow): turn the editor's Run button into Stop while a run is live` | §5 选了被否决的 B 的变体：编辑器从 `workflows.running` 观察自己发起的 run 拿 `runId`，再走既有 `tasks.cancel`。否决理由（两次往返的竞态）不成立——发起方本来就在长 Promise 里等待，观察轮询与 run 生命周期同起同终；且 A 需要新增协议族，B 复用两个既有命令，零后台改动（§5.6 不加第二套取消设施） |

每阶段提交前门禁：`pnpm typecheck` / `vitest`（新增 spec 全绿）/ `pnpm lint`（0 errors；
8 条存量 warning）/ `pnpm format:check` / `pnpm build`。

已知存量问题（与本系列无关，干净 HEAD 工作树复现确认）：
`tests/agent-turn-resilience.spec.ts` 的 "round budget > ends a silent panel ceiling with a
count-free reason" 在 HEAD 上即失败。

浏览器实证（加载扩展手工验证终止按钮、斜杠补全、会话记录）**BLOCKED**：本环境无法操作真实
Chrome 会话；§8.6 的人工验证步骤见各阶段提交说明。
