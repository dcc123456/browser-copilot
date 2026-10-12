# 设计：任务面板及时刷新 + 编辑改弹窗

日期：2026-10-10　区域：sidepanel（任务面板）　状态：已实现——验收行 1–2、4–8 由 `tests/tasks-tab.spec.tsx` 钉住，3 由现成的 `tests/store-events.spec.ts` 钉住，9 全绿；10（真 Chrome）待用户按 §6 验收

## 1. 问题

用户提了两条：

1. **聊天里生成的定时任务，任务面板不能及时看到**——希望面板能及时刷新。
2. **任务列表点「编辑」应该弹窗编辑**，现在不是弹窗。

代码事实（根因）：

- 侧边栏的每个 tab **常驻挂载**，切换 tab 不会重新挂载：`src/sidepanel/App.tsx:307-310` 的注释写明「Every tab stays mounted: the chat holds a live port and streaming transcript that must survive the user editing a skill mid-answer」。因此 `TasksTab` 里 `useEffect(() => void load(), [load])`（`src/sidepanel/TasksTab.tsx:85-87`）只在面板文档活着的那一次执行；之后切到「任务」页并不会重拉列表。
- `TasksTab` 只有两个刷新时机：挂载时一次，以及存储目录重连事件 `STORAGE_RECONNECTED_EVENT`（`:93-99`）。**没有订阅存储变更**。
- 对比同一套面板里的 `WorkflowsTab`：它既有 `useEffect(() => onStoreChanged('workflows', () => void load()), [load])`（`src/sidepanel/WorkflowsTab.tsx:300`），又有一个 5 秒轻量轮询（`:302-317`）。所以「聊天里另存为工作流」能立刻出现在工作流页，任务页却不行——差别只在有没有那个订阅，不是协议缺件。
- 写入侧本来就会发通知：聊天里的 `create_scheduled_task` 走 `src/background/agent.ts:3270` 的 `saveTask(task)` → `src/lib/task-store.ts:159-166`（key 是 `KEY_TASKS = 'scheduledTasks'`，`:36`）→ `fileStorageArea().set()` → `src/lib/fs-store.ts` 在落盘后 `notifyStoreChanged(key)`（`:484`；非文件路径的写入也在 `fileStorageArea` 里补发，见 `:598-608` 模块说明）。`lib/store-events` 双通道（window CustomEvent + `chrome.runtime.sendMessage`）正是为「同一 frame 内的 tab 之间」和「worker → 面板」这两种通知准备的。
- 编辑交互现状：列表项的「编辑」按钮 `onClick={() => setDraft({ ...task })}`（`src/sidepanel/TasksTab.tsx:326`），`draft` 存在时在列表**上方内联**渲染 `<TaskEditor>`（`:225-234`），组件自带保存/取消按钮（`:715-727`）。
- 弹窗外壳仓库里已经有现成的：`src/ui/FormDialog.tsx`——模块头写明它是「the shared shell behind every "edit in a dialog instead of on the page" surface」，带 backdrop/Escape 关闭、滚动 body、可选 footer；且已有 `SkillEditDialog.tsx` / `AgentEditDialog.tsx` 两个「每个编辑面一个 *EditDialog」的先例，footer 用 `FormDialogCancelButton` / `FormDialogPrimaryButton`。

## 2. 现状里已经存在的可复用件（不新造同类设施）

| 现成件                      | 位置                                                                 | 本次怎么用                                                                              |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 存储变更总线                | `src/lib/store-events.ts`（`notifyStoreChanged` / `onStoreChanged`） | TasksTab 订阅 `'scheduledTasks'`，不新造轮询、不新造广播消息类型                        |
| 同款订阅范例                | `src/sidepanel/WorkflowsTab.tsx:300`                                 | 照抄结构，key 换成任务 key                                                              |
| 弹窗外壳                    | `src/ui/FormDialog.tsx`                                              | 任务编辑表单放进 shell，footer 复用两个按钮组件                                         |
| 「每面一个 EditDialog」范式 | `src/sidepanel/SkillEditDialog.tsx`、`AgentEditDialog.tsx`           | 新建 `TaskEditDialog.tsx`，title 由调用方给                                             |
| 存储 key                    | `KEY_TASKS = 'scheduledTasks'`（`src/lib/task-store.ts:36`）         | 直接引用字面量（与 WorkflowsTab 用 `'workflows'` 字面量同一口径），并由单测钉住两侧一致 |

## 3. 决策

### 3.1 刷新：订阅存储事件，不加轮询（已拍板）

只做 `onStoreChanged('scheduledTasks', load)`。

- 候选 A：订阅 `'scheduledTasks'`。**采纳**。写侧本来就在每个写入路径上发通知，缺的只是听的人；一次通知即一次 `load()`，面板常驻挂载也及时。任务的 `lastStatus/lastRunAt` 由 `recordTaskRun` 写同一个 key，所以「跑完之后状态徽章刷新」顺带一起解决。
- 候选 B：像 WorkflowsTab 那样再加 5 秒轮询。**否决**。工作流页轮询是为了兜住「运行状态」这类没有显式通知的收敛；任务的每次写都带通知，加轮询等于同一件事做两遍，还多一个定时器（§5.5 不做超出需求的事）。
- 候选 C：让后台在 `create_scheduled_task` 之后广播一条 `tasks.changed` 新消息。**否决**。`WorkerBroadcast`（`src/lib/messages.ts:670`）是 skills/agents 的历史遗留双轨，存储类变更的统一通道已经是 `lib/store-events`；再加一种广播就是 §5.6 明令禁止的「同类设施再加一套」。
- 候选 D：切 tab 时重新挂载 / 靠 `visibilitychange` 重拉。**否决**。常驻挂载是 ChatTab 流式输出的硬前提（App.tsx 注释），为刷新去动它代价错位。

### 3.2 编辑改弹窗（已拍板）

新增 `src/sidepanel/TaskEditDialog.tsx`：把现在 `TasksTab` 文件里的 `TaskEditor` 原样搬进去，外面套 `FormDialog`，保存/取消从表单内部移到 dialog footer。

- `TasksTab` 继续持有 `draft` 状态与 `persistTask`（校验、落库、高亮刚保存的卡片都在调用方），dialog 只管字段编辑——与 `SkillEditDialog` 的分工一致（「The dialog owns the FIELD state only; persistence stays with the caller」）。这里更进一步：draft 状态本来就在父组件，dialog 连字段 state 都不持有，只做外壳 + footer，改动面最小。
- title：编辑已有任务用任务名，新建用既有的 `t.taskNew`。不新增文案 key（`t.taskSave` / `t.cancel` 都已存在，en + zh-CN 两侧现成）。
- 内联卡片样式去掉 `card`（弹窗面板本身就是卡片容器），保留 `task-editor` 的 flex 列布局。
- 空列表占位不再被 `!draft` 抑制：弹窗浮在列表之上，后面显示空状态才是对的。
- 列表按钮在弹窗打开时仍然禁用（`disabled={busy || !!draft}` 原样保留），避免「弹窗没关又在下面改另一条」。

## 4. 落点

| 文件                               | 改动                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sidepanel/TaskEditDialog.tsx` | 新增：`FormDialog` 外壳 + 搬进来的任务表单（原 `TaskEditor`）。                                                                                                             |
| `src/sidepanel/TasksTab.tsx`       | 加 `onStoreChanged('scheduledTasks', load)` 订阅；删内联 `<TaskEditor>` 与其定义，改渲染 `TaskEditDialog`；空状态条件去掉 `!draft`。                                        |
| `tests/tasks-tab.spec.tsx`         | 新增：① `notifyStoreChanged('scheduledTasks')` 触发重拉并渲染出新任务，别的 key 不触发；② 点「编辑」出现 `role="dialog"`，标题是任务名，保存走 `tasks.save`，取消不发命令。 |
| `src/lib/i18n.ts`                  | 不改：复用 `taskNew` / `taskSave` / `cancel` / `edit`。                                                                                                                     |

## 5. 验收行

1. 任务面板挂载后，收到 `'scheduledTasks'` 的存储通知 → 重新 `tasks.list`，聊天里刚生成的任务出现在列表里（不需要关面板再开）。
2. 其他 key 的通知（`'settings'`、`'workflows'`）不触发任务列表重拉。
3. 通知走的是 `lib/store-events` 的双通道：同 frame（window CustomEvent）和 worker→面板（runtime message）两种来源都能刷新。
4. 点列表里的「编辑」→ 渲染 `role="dialog"` 的弹窗，标题为该任务名；表单字段带出这条任务的现有值（名称 / 类型 / 排程 / 上限轮数 / Feishu）。
5. 弹窗里保存 → 发 `tasks.save`，成功后弹窗关闭、列表刷新、该卡片短暂高亮（沿用 `justSavedId`）。
6. 弹窗里取消 / Escape / 点遮罩 → 关闭且**不发** `tasks.save`。
7. 新建任务（「+ 新建任务」）同样走弹窗，标题为 `taskNew`。
8. 弹窗打开期间列表上的编辑/删除/立即执行按钮仍禁用。
9. 纯逻辑层门禁：`pnpm typecheck` / `test` / `lint` / `format:check` / `build` 全绿并贴输出。
10. 浏览器证据（收尾自检 ⑤）：本环境无法脚本化扩展自身页面（side panel），标 **BLOCKED**，附人工复现步骤。

## 5.1 实现状态（钉住了什么）

`tests/tasks-tab.spec.tsx`（6 例，真实组件 + mock 命令通道）覆盖验收行 1、2、4、5、6、7、8，其中：

- 5 行只断言「保存走 `tasks.save`、弹窗关闭」，卡片高亮（`justSavedId`）是既有行为，未新增断言。
- 6 行只断言 Cancel 按钮路径；Escape / 点遮罩由现成的 `ui/FormDialog` 自己保证，不在本文件重复钉。
- 3 行的双通道（window CustomEvent / `chrome.runtime`）在 `tests/store-events.spec.ts` 里已经钉住，本测试通过 `notifyStoreChanged` 走的是同一条 window 通道。

判别检查：临时去掉 `onStoreChanged('scheduledTasks', …)` 那行订阅 → 「shows a task created after the panel mounted」失败（`expected 1 to be 2`，即 `tasks.list` 没被重新调用），还原后 6 例全绿。也就是说 key 字面量写错同样会被这例抓到。

## 6. 人工验证步骤（待用户在真 Chrome 上跑）

1. `pnpm build` → chrome://extensions → 重新加载 unpacked `dist/`。
2. 停在「聊天」页，说一句会生成定时任务的话（例如「每天 9 点检查 Hacker News 热帖并总结」），等回合里出现「已创建任务」的确认。
3. 不关面板，直接切到「任务」页：期望新任务**已经在列表里**（这是本次要修的点：以前要重开面板才看得到）。
4. 反向验证：任务留在「任务」页时，让它在后台跑完一轮（或等 `recordTaskRun` 写入），期望状态徽章自己更新，无需重开。
5. 点这条任务的「编辑」：期望居中弹窗（带遮罩、可 Escape 关），不是把列表撑开一段内联表单。
6. 弹窗里改排程时间/上限轮数后保存：期望弹窗关闭、列表出现更新后的排程描述、卡片短暂高亮。
7. 再点「编辑」，按 Escape 或点遮罩：期望直接关闭，列表内容不变。
8. 「+ 新建任务」：期望同样以弹窗出现。
