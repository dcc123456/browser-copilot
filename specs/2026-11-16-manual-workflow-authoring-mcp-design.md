# 手工编排工作流 MCP 工具 / Manual workflow authoring MCP tool

## 现状与目标 / Context and goal

当前 MCP bridge 暴露的工作流工具里，`generate_workflow` 用"边操作页面边录节点"的方式生成，对**有页面动作**的段（采集/点击）效果好（实测 WF-1 加选择器约束后 6/6 通过），但对**纯数据段**（parse-excel / loop-data / conditions / insert-data / export-data）力不从心：没有页面动作可录，模型硬凑步骤，实测耗时 907 秒且结构崩坏、验证失败（见 `specs/2026-11-16-xiaohongshu-follow-workflow-split-design.md` 实测验证章节）。

`load_tools` / `wf_op_*` 手动逐节点录制路径在当前 MCP 通道不可用，于是 AI 没有任何办法**直接给出一份 workflow JSON 并保存**。

目标：新增一个 bridge-only MCP 工具 `save_workflow`，让调用方直接提交完整的 workflow 图（节点 + 边 + 触发器），工具补齐必需字段、做结构 + 语义校验、保存为项目原生工作流并返回 id 与非阻断的 warnings。这样纯数据段可以精确编排，不再依赖生成器的"页面动作录制"。

## 选型与证据 / Options and evidence

| 方案                                                | 结论 | 理由                                                                                                                                                                              |
| --------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展 `generate_workflow`，加一个"直接给 JSON"的模式 | 否决 | 它是长任务 start/poll 结构（`agent-api.ts:370-448`），手工编排是同步操作，混进去会污染轮询契约；职责也不同（生成 vs 落盘）。                                                      |
| 复用 `compose_workflow`，允许它接外部 JSON          | 否决 | `composeWorkflowFromDraft(conversationId, …)`（`operator-tool-handler.ts:671`）只认会话草稿，没有 conversationId 就无法工作；改造它要同时兼顾草稿语义，风险大。                   |
| **新增独立同步工具 `save_workflow`**                | 采用 | 走 `runToolStandalone` 默认分发（`agent-api.ts:449`），不碰长任务分支；纯逻辑放 `src/lib/**`（§5.7），复用现成的 `asWorkflow` + `validateWorkflow` + `saveWorkflow`；改动面最小。 |

一手证据（源码实测）：

- `asWorkflow(value)` 纯函数（`src/lib/workflow/storage.ts:66-243`）：校验 + 白名单规范化，chrome-free。
- `validateWorkflow(value): string[]`（`src/lib/workflow/validation.ts:35-113`）：结构校验（id/name/drawflow/settings/timestamps）。
- `validateWorkflowForRun(workflow)`（同文件 `:284`）：运行级校验，返回 `{errors, warnings}`；`validateGeneratedWorkflow`（`generated-validation.ts:565`）为生成级 gate。
- `saveWorkflow(workflow, opts?)`（`storage.ts:264-292`）：async，内部再走 asWorkflow + migrate + shedBulkDataUrls + withKeyLock 串行写。
- Workflow 完整模板见 `operator-tool-handler.ts:773-797`（compose 时的组装逻辑）。
- 边 handle 约定：`<sourceLabel>-output-N` / `<targetLabel>-input-N`（`tests/trigger-patch.spec.ts:20-21`），引擎按 handle 路由（`engine.ts`）。
- 工具描述为**内联双语**（`agent.ts:1418`），不需 i18n key；tool-catalog 复用 `toolOperator`/`toolOperatorWarn` 可零字典改动。

## 实现 / Implementation

### 1. 新工具的输入契约（JSON Schema）

工具名：`save_workflow`。参数：

- `workflow`（object, required）：待保存的图，形状：
  - `name`（string, required）：显示名。
  - `nodes`（array, required）：`[{ id, label, position:{x,y}, data:{ blockId, ...blockParams } }]`；`label` 与 `data.blockId` 应一致（结构校验不强制，但编排器应提醒）。
  - `edges`（array, required）：`[{ id, source, target, sourceHandle?, targetHandle? }]`。
  - `trigger`（object, optional）：触发器 spec，默认 `{ type:'manual', enabled:true }`。
  - `description`（string, optional）。
  - `id`（string, optional）：**不接受**——工具始终生成新 id，避免覆盖用户已有工作流（覆盖走未来单独的 update 工具，或显式 `replaceId` 另议）。
- `save`（boolean, optional, default true）：false 时只校验并返回警告，不落盘（dry-run）。

工具内部组装完整 Workflow（参照 `operator-tool-handler.ts:773-797`）：

- `id = newId()`、`createdAt/updatedAt = Date.now()`；
- `settings` 用默认（`saveLog/debugMode/notification/reuseLastState: false`），调用方可在 `workflow.settings` 里覆盖白名单字段；
- `drawflow = { nodes, edges }`、`table: []`、`trigger` 默认 manual。

### 2. 校验分层（全部复用现成函数，不新写校验器）

1. **结构校验**：对组装后的对象跑 `validateWorkflow`，任一 error → 返回 `{ok:false, errors:[...]}`，不保存。
2. **图语义校验**（新增纯函数 `validateAuthoredGraph`，放 `src/lib/workflow/authored-graph.ts`）：
   - `nodes` 非空且至少有一个 `blockId === 'trigger'` 或存在 `trigger` spec；
   - 每条边的 `source`/`target` 必须对应存在的 node id；
   - `data.blockId` 必须在 `CATALOG_BY_ID`（palette 内置块 + custom 数据块）中；
   - `sourceHandle`/`targetHandle` 形如 `<label>-output-N` / `<label>-input-N`（宽松：不强行校验 N）；
   - 重复 node id / edge id 报错。
   - 返回 `string[]` errors（阻断）与 `string[]` warnings（如"边未指定 handle，按默认边路由"）。
3. **运行/生成级检查**（非阻断，转 warnings）：`validateWorkflowForRun(workflow)` 与 `validateGeneratedWorkflow` 的 findings 收进 `saveWarnings`，与 `compose_workflow` 行为一致（保存永不阻断）。
4. `asWorkflow` 在 `saveWorkflow` 内部会再次执行，作为最后一道规范化。

### 3. 工具注册改动点（按序）

1. `src/background/agent.ts:1413-1555` 的 `TOOLS` 数组加 `save_workflow` schema（内联 `English / 中文` 描述）。
2. `src/background/agent.ts` 的 `executeTool`（3660-4833）加 `case 'save_workflow'`：解析 args → 调 `saveAuthoredWorkflow`（见下）→ `JSON.stringify({ok, workflowId, name, nodeCount, warnings, errors})`。
3. 新模块 `src/background/workflow-authoring.ts`：`saveAuthoredWorkflow(args): Promise<{...}>`，组装 + 两层校验 + saveWorkflow 调用。纯逻辑部分（组装 + `validateAuthoredGraph`）放 `src/lib/workflow/authored-graph.ts`（chrome-free，遵守 §5.7）。
4. `src/lib/tool-catalog.ts:38-43` 的 `BRIDGE_ONLY_TOOLS` 加 `save_workflow`；`:251-281` 的 `TOOL_META` 加一条（复用 `toolOperator`/`toolOperatorWarn` 标签，不新增 i18n key）。
5. **不改** `public/mcp-server.mjs` 的 `STATIC_TOOLS`：实测该文件里没有 compose/generate/verify 等 bridge-only 工具，它们由插件连接后动态返回；`save_workflow` 作为 bridge-only 工具保持一致，不进静态兜底。
6. **不改** `agent-api.ts`：`save_workflow` 是同步工具，走 `runToolStandalone` 默认路径（`agent-api.ts:449`）。
7. **不加** `AI_AGENT_FORBIDDEN_TOOLS`：现有 bridge-only 工具（generate/verify/repair）都只靠 BRIDGE_ONLY 机制防止 ai-agent 节点使用，保持一致，不引入新策略。

### 4. 与现有工具的关系

- `generate_workflow`：生成（有页面动作的段）；`save_workflow`：精确落盘（纯数据段 / 手工编排）。
- `compose_workflow`：把会话草稿收尾；`save_workflow`：把外部给的图落盘。两者互不使用，共享 `saveWorkflow` 与校验函数。
- `verify_workflow`：保存后可用它试跑；`save_workflow` 本身不试跑（同步工具，试跑是长任务）。

## 验证 / Verification

### 实现说明

当前交付的 dry-run 只校验并返回警告，不返回 workflow JSON；输入始终新建 id、不覆盖已有工作流。纯数据块的合法性以 `CATALOG_BY_ID` 为准，避免误拒 `parse-excel` 等 custom 块。

- 单测 `tests/workflow-authored-graph.spec.ts`（新）：
  - `validateAuthoredGraph` 接受合法的 trigger → data 算子链；拒绝：悬空边端点、未知 blockId、重复 id、无 trigger、非法 handle。
  - 组装函数补齐 id/settings/timestamps；`save:false` 不落盘。
- handler 测试 `tests/workflow-authoring.spec.ts`：mock storage 后验证落盘一次、返回 workflowId；非法图返回 errors 且未落盘，dry-run 不落盘。
- 配置测试 `tests/tool-config.spec.ts`：新工具是 bridge-only、section 唯一、TOOL_META 完整（加完自动覆盖）。
- 门禁：`pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm build` 全绿。
- 浏览器实证：扩展加载后通过 MCP 调 `save_workflow` 保存一条纯数据工作流，再到工作流编辑器确认节点/边正确、可用 `verify_workflow` 试跑。

## 风险与取舍 / Risks and trade-offs

| 风险                                                         | 说明                                                           | 缓解                                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 接受任意 JSON 可能写入不可运行图                             | 图级校验只能查结构，不能保证语义正确                           | 分层告警但不阻断（与 compose_workflow 一致），返回 warnings 让调用方/用户知情                                                   |
| `save_workflow` 被 ai-agent 节点在无人值守运行里调用写工作流 | 会改变用户数据                                                 | 加入 `BRIDGE_ONLY_TOOLS`，与 generate/verify/repair 一样不对面板和 ai-agent 节点 advertise                                      |
| 用户已有工作流被覆盖                                         | 工具始终生成新 id，不接外部 id                                 | 需要更新已存在工作流时另做 update 工具，本次不做                                                                                |
| MCP bridge 工具列表不同步                                    | 静态 STATIC_TOOLS 只含常规工具，bridge-only 工具由插件动态返回 | save_workflow 与其他 bridge-only 工具一致，不进静态列表；靠 `tests/tool-config.spec.ts` 校验 TOOL_META/bridge-only/section 覆盖 |
| 新增工具扩大 bridge 攻击面                                   | 入参是任意 JSON                                                | 校验 + 白名单规范化（asWorkflow）+ 大小上限（nodes/edges 各 ≤ 500，避免超大图拖垮存储）                                         |

### 实测结果（2026-11-17）

- `NODE_OPTIONS="" node_modules/.bin/vitest run`：524 个文件、6024 个测试全部通过。
- 两次 tsc（源码 + tests）、改动文件 ESLint、Prettier、`vite build` 均通过。
- 全量 `eslint .` 被既有 `tmp/*` 多 tsconfig 与构建产物扫描问题阻断（9825 个解析错误）；本次功能文件单独 ESLint 为零错误。
- 构建重载后 MCP `tools/list` 已返回 `save_workflow`；通过 stdio MCP 实际保存测试流成功。
- 自包含纯数据流 `mwk3z8ef-ivucihkb`：set-variable → export-data(plain-text 变量) → parse-excel(file-path) → export-data(csv 变量)，`verify_workflow` 4/4 步通过，无页面操作。
- 另两条烟测流 `mwk3wa35-95u8dutw`（空表导出被拒绝）、`mwk3xzum-0fv0zkql`（旧采集文件不可用）为失败样例，不是交付工作流。

## 交付 / Hand off

提交信息英文 Conventional Commits：`feat(mcp): add save_workflow tool for manual workflow authoring`。推送后按 §8.6 给出"这次改了什么"与"人工怎么测"两段说明。
