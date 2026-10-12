# Token 看板的实体命名与跳转 — 设计与计划（2026-10-12）

## 1. 问题

「token 用量」看板按实体（会话 / 任务 / 工作流…）拆分花费，但行名现在经常是裸 key
（`task:9f3c1a…`），用户看不出是哪个任务、哪个流程出问题；名字也不能点击，定位到对应
任务/工作流/会话要手动切标签页去找。

## 2. 事实核对（源码取证）

- 行的 label 是**写入时快照**：`TokenUsageRecord.entityLabel` →
  `TokenDailyEntity.label`（`src/lib/token-ledger.ts:145,458`）。
- 解析只覆盖聊天标题：`resolveLabel` 只在 `entityKey.startsWith('chat:')` 时读
  `getConversationMeta`，其余一律回落成裸 key（`src/background/token-accounting.ts:78-93`）。
- **定时任务必然显示裸 key**：`runUnattendedPrompt(prompt, \`task:${task.id}\`)`
（`src/background/task-runner.ts:305`）→ `turnAttribution`给出`entityKey=task:<id>`且不带`entityLabel`；工作流侧则都传了名字（`engine.ts:584`、`workflow-review.ts:191`、
`auto-repair/background-adapter.ts:138`、`index.ts:1930/2123/2209/2528`）。
- 实体 kind 共 6 个：`chat | task | workflow | run | session | external`
  （`src/lib/token-ledger.ts:60`）。面板里实际出现的：
  - `chat:<id>` 真会话；`chat:external-gen:<id>`——MCP `generate_workflow` 的 run id
    会被拼成这种 key（`startGenerationRun` 用 `external-gen:` 前缀
    `src/background/workflow-generation-bridge.ts:943`，`TURN_CONSUMERS` 没有该前缀，
    于是落到 `turnAttribution` 的 else 分支按 `chat:` 归键 `src/background/token-accounting.ts:58-61`）。
    **这条 key 指向的对象不存在**，不能当会话跳转（本次由 §4.3 的 `external-gen:` 归键修正）。
  - `task:<id>` 定时任务；`workflow:<id>` 工作流；`session:<id>` Node Fix 会话
    （`node-fix-engine.ts:206`）；`external:<id>` 外部/飞书一次性运行
    （`agent-api.ts:469`、`feishu-bot.ts:545`）。后三类在面板里没有可跳转的宿主对象。
- 面板已有的跳转机制（复用，不新建第二套）：
  - 切标签页 = `window` CustomEvent，App 只负责 `setActive`
    （`src/sidepanel/App.tsx:157-161` 的 `bc:open-conversation`、`:188-192` 的 `bc:open-history`）；
  - 目标标签自己监听 detail 并定位：`HistoryTab.tsx:144-152` 用 `focusRunId`
    展开 + 高亮 + `scrollIntoView`；`ChatTab.tsx:2550-2556` 收 `bc:open-conversation`
    后 `openConversation(id)`；
  - 任务列表已有短暂高亮：`TasksTab.tsx:51-58,244` 的 `justSavedId` + `task-item-saved`。
- 名称来源已在面板可达：`tasks.list` / `workflows.list` / `conversations.list`
  （`src/lib/messages.ts:166,184,160`），`TasksTab.tsx:63-67` 就是一次拿全量任务与工作流。

## 3. 选型与决策

- **名字以“当前值”为主，快照为辅**：行渲染时用 `tasks.list` / `workflows.list` /
  `conversations.list` 的现名替换快照名——这样改名后看板跟着变，也顺带回答“这个目标还
  存在吗”。查不到才退回快照 label，再退回按 kind 本地化的 `类型 · 短 id`。
  否决：只做写侧解析（历史行永远显示裸 key，且改名的任务名会分叉成两个）。
- **可跳转 = 目标存在**：只有能在上述三个列表里找到 id 的行才是按钮；
  `session:` / `external:` / 已删除对象的行保持纯文本，tooltip 显示原始 key 便于排查。
  否决：无条件跳转（`chat:external-gen:x` 会让 ChatTab 打开一个不存在的会话）。
- **worker 侧补 `task:` / `workflow:` 名称解析**：让新写入的记录自带可读名，
  这样 Runner 之外、以及面板加载列表前的首帧也不至于全是裸 key。
  复用既有 `labelCache`（60s TTL）与 `getTask` / `getWorkflow`，不新开缓存。
- **kind 展示名新增三个词条**：一度想复用 `tabChat` / `tabTasks` / `tabWorkflows`，但那是
  标签页标题（复数、大写开头，zh 侧是「聊天 / 定时任务 / 工作流」标签），放进
  「跳转到该会话」这类句子里口径不对；`run` / `session` / `external` 本来就没有对应
  标签，仍借用语更贴切的 `tokensConsumerWorkflowGeneration` / `tokensConsumerAiDebug` /
  `tokensConsumerExternalApi`。
- 新增词条共五个（`Messages` 封闭类型强制双语）：`tokensEntityUnnamed({kind,id})`、
  `tokensJump({kind})`、`tokensKindChat` / `tokensKindTask` / `tokensKindWorkflow`
  （单数名词，行名与跳转 tooltip 共用）。
- **MCP 生成链路不再伪装成会话**：`TURN_CONSUMERS` 补 `external-gen:` →
  `consumer=workflow-generation`、`entityKey=run:<id>`；没有这行时它落到 else 分支被
  归成 `chat:external-gen:<id>`，看板会跳向一个并不存在的会话。
- **样式**：只用 Tailwind 语义 token 工具类（§2）；高亮沿用列表自己的
  `task-item-saved`（任务列表已有，工作流列表复用同一个 class），两行的可点击态用
  `hover:text-accent focus-visible:text-accent`，不往 `styles.css` 加一次性 class。

## 4. 实施步骤

1. `src/lib/token-ledger.ts`：导出纯函数 `entityKindOf(key)`（把 6 个 kind 前缀解析成
   `{kind,id}`，未知前缀返回 `undefined`），供面板与测试复用（chrome-free，§5.7）。
2. `src/background/token-accounting.ts`：`resolveLabel` 由「只认 `chat:`」改成按
   `entityKindOf` 分派 `chat:` → `getConversationMeta().title`、`task:` → `getTask().name`、
   `workflow:` → `getWorkflow().name`，读取失败或查不到都保留裸 key；仍走同一 `labelCache`。
3. `src/background/token-accounting.ts`：`TURN_CONSUMERS` 补 `external-gen:` 一行
   （`entity` 字段类型随之放宽为 `TokenEntityKind`）。
4. `src/sidepanel/TokensTab.tsx`：并行加载任务/工作流/会话三张表 →
   `Record<entityKey, EntityTarget>`（`loadEntities`，挂载、换窗口、
   `STORAGE_RECONNECTED_EVENT` 各刷一次；读失败静默，看板仍要能显示汇总）；
   纯函数 `entityRowView(row, entities, texts)` 按“现名 → 快照 → 本地化兜底”取名，
   只有 `target` 存在才渲染 button，点击 `window.dispatchEvent`：
   `chat` 复用 `bc:open-conversation`，`task` 用新的 `bc:open-task`，
   `workflow` 用新的 `bc:open-workflow`（detail 都是 `{ id }`，与既有事件同形）。
   `GroupTable` 的 `otherLabel` 参数换成 `entityView`，导出供组件测试直接渲染。
5. `src/sidepanel/App.tsx`：两个新事件各加一个 `setActive` 监听（与既有两条同构；
   More 下拉在任意 mousedown 时已自行收起）。
6. `src/sidepanel/hooks/useRowHighlight.ts`（新文件）：把「高亮一行 + 等它渲染后
   `scrollIntoView`」抽成一个 hook，签名 `useRowHighlight(event, attribute)`，
   返回 `{ highlightedId, flash }`。理由是 §5.2——`TasksTab` 的保存闪烁与两个新标签页
   的深链是同一段逻辑的第二次出现；flash 时长沿用原来的 1800ms，样式仍归各列表自己。
7. `src/sidepanel/TasksTab.tsx`：删除本地 `justSavedId` state 与其定时器，改用
   `useRowHighlight('bc:open-task', 'data-task-id')`；`persistTask` 调 `flash(savedId)`。
8. `src/sidepanel/WorkflowsTab.tsx`：只用 `highlightedId`（本标签不会链向自己的行），
   行上加 `data-workflow-id` 与同一个 `task-item-saved` class
   （打开编辑器仍是用户自己点 Edit，避免看板点击弹出编辑器）。
9. `src/lib/i18n.ts`：五个新词条双侧赋值（en 小写名词 / zh「会话·定时任务·工作流」）。
10. 测试：`tests/token-ledger.spec.ts` 补 `entityKindOf`（6 个 kind 与 `entityKeyFor`
    互逆、嵌套 id `chat:external-gen:r7Kx`、`__other__`/空串/未知前缀/`:abc` 返回
    `undefined`）；`tests/llm-accounting.spec.ts` 补 `external-gen:` 归键与
    「seed `scheduledTasks` / `workflows` 后 `buildRecord` 写出真名」；
    新增 `tests/token-board-naming.spec.tsx`（纯函数 8 例：现名优先、已删除回落快照、
    无名兜底、只给活对象加链接、`__other__` 说明，外加 `renderToStaticMarkup(GroupTable)`
    断言活行渲染成带 `title` 的 button、死行不渲染 button）。
    `tests/tasks-tab.spec.tsx` 在 `beforeAll` 里补 `Element.prototype.scrollIntoView`
    空实现——jsdom 没有该 API，沿用仓库既有做法，不给生产代码加兜底分支。

## 5. 验收

- ① 实测结果：`pnpm typecheck`（src + tests）通过；`pnpm test` 349 个文件 / 4002 个用例
  全绿且无游离报错；`pnpm lint` 对本次涉及的 12 个文件 0 问题（仓库整体 lint 红是未跟踪
  `tmp/` 的既有基线）；`git ls-files '*.ts' '*.tsx' '*.css' '*.md' '*.json' | xargs prettier
--check` 全绿；`pnpm build` 成功产出 `dist/`。
- ② 无 Runner 侧改动（`server/**` 不动）。
- ③ 未触 `ai-takeover.ts` 与 `workflow-engine/**` → 不需要 `bench:debug`。
- ④ 未新增 `executeScript({func})` 内联函数体 → `verify:injected` 不适用。
- ⑤ 真实浏览器：side panel 不可脚本驱动（仓库红线），**标注 BLOCKED**。
  已有的替代证据是 `tests/token-board-naming.spec.tsx` 里对真实 `GroupTable` 的
  `renderToStaticMarkup` 渲染断言（活行是 button + `title="Jump to this task"` + 现名，
  死行是纯 `div` + `title` 为原始 key），以及 `tests/tasks-tab.spec.tsx` 用 `createRoot`
  驱动真实 `TasksTab`（保存后行上出现 `task-item-saved` 与 `data-task-id`）。
  跨标签跳转（点看板行 → 切到任务/工作流标签 → 目标行高亮）仍需人工
  `pnpm build` → 加载 `dist/` 验证一次。
- ⑥ 复用检查：跳转沿用既有 CustomEvent + `setActive` 机制；名称解析复用既有
  `labelCache` / `getTask` / `getWorkflow`；高亮+滚动逻辑第二次出现即抽
  `useRowHighlight`；kind 名只加三个单数名词词条，不建第二套词条表。
- ⑦ 无未调用导出；`justSavedId` 已随抽取删除，无残留；`GroupTable` 的 `otherLabel`
  参数被 `entityView` 取代而非并存。
- ⑧ 文案双语（`Messages` 机检）；样式只用既有语义 token 工具类。
- ⑨ 探针与截图只留 `tmp/`。
- ⑩ 英文 Conventional Commits；不打 tag，不涉及 `website/` 版本同步。
