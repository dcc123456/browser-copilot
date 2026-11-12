# 历史面板：可配置保留上限 + 删除 loading 态

日期：2026-11-11 · 范围：`src/lib/{types,storage,task-store,providers,i18n}.ts`、`src/sidepanel/{HistoryTab,SettingsTab}.tsx`、`src/background/index.ts`、`tests/**`

## 1. 需求与现状

用户诉求：历史面板的四类记录默认只存 50 条以节省资源；每类上限可由用户自定义；删除日志时要有 loading 态。

| 历史分区（HistoryTab 的 `Section`） | 存储键                                      | 当前写入裁剪                         | 现状上限                    |
| ----------------------------------- | ------------------------------------------- | ------------------------------------ | --------------------------- |
| 对话记录 `conversations`            | `conversations` (meta 列表)                 | **无**                               | 无上限                      |
| 工作流运行 `workflowRuns`           | `scheduledTaskRuns` (`source=manual\|chat`) | `persistRuns` 条数 + 字节双裁剪      | `MAX_RUN_LOGS = 100`        |
| 任务运行 `taskRuns`                 | 同一个数组 (`source=schedule\|feishu`)      | 同上，**两类共享一个数组与一个上限** | `MAX_RUN_LOGS = 100`        |
| 操作记录 `operations`               | `history`                                   | `addHistory` 中 `slice(0, N)`        | `MAX_HISTORY_ENTRIES = 500` |

补充事实：

- 存储是「用户目录文件 + `chrome.storage.local` 镜像」（`lib/fs-store.ts`），不是 IndexedDB；写入经 `withKeyLock(key, fn)` 串行化。
- `listRuns()` 已过滤 `source === 'chat'`，`recordFinishedRun()` 对 `chat` 直接返回；但 HistoryTab 的 workflowRuns filter 仍含 `chat`。属存量不一致，本次不改行为，只把分类条件抽成共享函数以免 UI 与存储各写一套。
- 单条对话 transcript 的 `MAX_STORED_MESSAGES = 200` 是「一个会话内的消息数」，与本次「会话条数」无关，保持不动。
- 删除操作（单条 / 批量 / 清空）在 3 个 section 共 8 处，全部是裸 `await sendCommand` → `await load()`，没有 busy 态；`t.loading` 文案已存在。
- `BatchBar` 的计数文本 `共 ${total} 条`（HistoryTab.tsx:297）是硬编码中文，属存量违例；本次要改这个组件，顺手走 i18n。

## 2. 选型与证据（§7）

本次不引入任何新依赖、新框架 API 或新存储通道，因此无需外部取证；证据全部来自仓库内既有实现与本机可读源码：

- **归一化范式**：`src/lib/types.ts:297-303` 的 `RUN_WINDOW_LIMITS` + `normalizeRunWindowLimit`，`src/lib/storage.ts:150-163` 的 `coerceMaxToolRounds`。两者都是「常量 + 纯钳制函数」，且被存储读取与 UI 共用。照此实现 `HISTORY_LIMITS` + `normalizeHistoryLimit`。
- **设置 UI 范式**：`src/sidepanel/SettingsTab.tsx:1082-1098`（`RUN_WINDOW_LIMITS` + `NumberInput`）与 `:1311-1325`（`maxToolRounds`）。`src/ui/NumberInput.tsx` 自带失焦 clamp，无需新组件。
- **双归一化写入点**：`storage.ts:normalizeStoredSettings` 与 `providers.ts:normalizeSettingsPayload` 都是白名单式显式构造，新增字段必须两处都补，否则读取丢字段。
- **字节预算**：`task-store.ts:MAX_STORED_RUN_BYTES` 与条数裁剪是正交关注点，保留字节淘汰逻辑，只替换条数裁剪。

被否决的候选：

| 候选                                                            | 否决理由                                                                                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 个上限合并成 1 个全局值                                       | 用户明确要求「每个历史能存多少条」，且 workflow/task runs 共享数组时仍需按 source 分别计数，一个值无法满足「每类独立」。                                                     |
| 只在读取时 `slice(0, limit)`                                    | 旧数据仍占磁盘（每条 transcript 最多 1.5MB），与「节省资源」的核心诉求相反。必须写入时真删。                                                                                 |
| 把上限作为参数从 background 传入 `addRun` / `recordFinishedRun` | 调用点分散（task-runner / index / running-tasks），容易漏传导致上限失效；`task-store.ts` 已 import `./storage` 的 `newId`，直接复用 `getSettings()` 无循环依赖，改动面更小。 |
| 用嵌套对象 `historyLimits: {...}`                               | `settings.set` 是 `Partial<Settings>` 浅合并，嵌套对象会被整体替换；且仓库设置 schema 全为扁平字段。                                                                         |
| 依赖 `SCHEMA_VERSION` bump 触发迁移                             | 旧记录里多出的字段会被白名单归一化静默丢弃，读取不报错；bump 还会触发 built-in 播种等无关副作用。                                                                            |
| 每个 section 各写一份 `deleting` state                          | 同一逻辑在 3 个 section 重复 3 次，违反 §5.2「第二次出现就抽公共层」。                                                                                                       |

## 3. 设计

### 3.1 设置 schema（`src/lib/types.ts`）

```ts
export const HISTORY_LIMITS = { default: 50, min: 1, max: 500 } as const
export function normalizeHistoryLimit(value: unknown): number
```

`Settings` 新增 4 个扁平字段（默认全部 50）：
`historyLimitConversations` / `historyLimitWorkflowRuns` / `historyLimitTaskRuns` / `historyLimitOperations`。

`DEFAULT_SETTINGS` 补默认值；`normalizeStoredSettings` 与 `normalizeSettingsPayload` 各补 4 行钳制。旧存储缺字段 → 归一化为 50；多余字段 → 静默丢弃。

### 3.2 写入时裁剪

- **操作记录**：`addHistory` 读 `getSettings().historyLimitOperations` 后 `slice(0, limit)`。删除导出常量 `MAX_HISTORY_ENTRIES`（仅本处使用，无测试引用），改由设置驱动。
- **对话记录**：`touchConversation` 抽出内部 `persistConversationMeta(list)`，统一做「按 `updatedAt` 降序 → `slice(0, limit)` → 写回」，并对被淘汰的会话调用 `clearConversation(id)` 删除 `conv:<id>` transcript，否则留下最多 1.5MB/条的孤儿文件，省不了资源。`renameConversation` / `deleteConversation` 不新增记录，无需裁剪。
  - 必须重排序后再裁：现有 `list.push(created)` 把最新会话放在数组末尾，直接 `slice(0, N)` 会丢掉刚创建的会话。
- **运行记录**：`task-store.ts` 导出 `isWorkflowRunSource(source)`（`manual|chat`），供裁剪与 HistoryTab 的两个 filter 共用。`persistRuns` 改为读设置、按 source 分两组各保留前 N 条（保持原时间序），再走既有字节淘汰。删除 `MAX_RUN_LOGS` 导出。

### 3.3 设置变更即时生效

只在写入时裁剪时，用户把上限从 50 调成 10 后旧记录会一直留到下次新增。为此在后台 `settings.set` 分支（`src/background/index.ts`）检测 patch 是否含任一 `historyLimit*` 键，命中则调用三个导出函数主动裁剪一次：
`trimConversationsToLimit()` / `trimActionHistoryToLimit()`（storage.ts）与 `trimRunsToLimits()`（task-store.ts）。三个函数内部各自持锁、读设置、写回，与写入路径复用同一裁剪函数。组合调用放在 background（而非 storage.ts）以避免 `storage ↔ task-store` 循环依赖。

### 3.4 设置 UI（`SettingsTab.tsx`）

在「每条回复最多操作步数」卡片之后新增一张 `history retention` 卡片：标题 + 说明 + 4 个 `NumberInput`（复用 `HISTORY_LIMITS` 的 min/max/default，写入走 `mutate({type:'settings.set', patch})`），Tailwind 语义 token 类名。全部文案走 i18n。

落地修正两处：

- 四行输入是同一逻辑的第四次复制（§5.2），改为 `historyLimitFields: { field, label }[]` + 一个 `setHistoryLimit(field, value)`，JSX 里 `map` 一次；`field` 用模块级 `HistoryLimitField` 联合类型约束，钳制仍走 `normalizeHistoryLimit`。
- `NumberInput` 渲染的是无 class 的裸 `<input>`（面板全局 `input{width:100%}` 会撑满整行），沿用既有 `style={{maxWidth:96}}` 属 §2 禁止的静态内联样式，改为外层 `<span className="w-24 shrink-0">` 限定槽宽。

`isWorkflowRunSource` 只用在 workflowRuns 这一侧 filter：taskRuns 的 filter 保持字面 `schedule|feishu`，因为 `source` 是可选字段，改成取反会让**没有 source 的历史记录**从「两个分区都不显示」变成「显示在任务运行里」，属行为改动而非抽公共层。写入侧的分组仍按「非 workflow 即 task」计（与存量 `MAX_RUN_LOGS` 行为一致）。

### 3.5 删除 loading 态（`HistoryTab.tsx`）

抽 `useDeletion()` hook：`{ deleting, run }`，`run(action)` 在执行期间置 `deleting=true`，`finally` 复位；防御重复点击（进行中直接 return）。三个 section 的 `removeOne` / `removeSelected` / `clearAll` 全部经 `run` 包装。

视觉反馈：

- `BatchBar` 新增 `deleting` prop：删除按钮 `disabled={count === 0 || deleting}`，文案切换为 `t.histDeleting`；`extra`（清空全部）按钮同步禁用。
- 单条删除 `×` 按钮 `disabled={deleting}`。
- 顺手把 `共 ${total} 条` 换成 `t.histRecordCount({ count })` 双语 key。

### 3.6 i18n（`src/lib/i18n.ts`，三处：interface / en / zhCN）

新增：`settingsHistoryRetentionTitle`、`settingsHistoryRetentionHint`、`settingsHistoryLimitConversations`、`settingsHistoryLimitWorkflowRuns`、`settingsHistoryLimitTaskRuns`、`settingsHistoryLimitOperations`、`histDeleting`、`histRecordCount({count})`。

## 4. 改动清单

| 文件                                      | 改动                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/lib/types.ts`                        | `HISTORY_LIMITS` + `normalizeHistoryLimit` + 4 个 `Settings` 字段                                      |
| `src/lib/storage.ts`                      | 默认值 / 归一化；`addHistory`、`touchConversation` 裁剪；导出 2 个 trim 函数；删 `MAX_HISTORY_ENTRIES` |
| `src/lib/task-store.ts`                   | `isWorkflowRunSource`；`persistRuns` 分组裁剪；`trimRunsToLimits`；删 `MAX_RUN_LOGS`                   |
| `src/lib/providers.ts`                    | `normalizeSettingsPayload` 补 4 字段                                                                   |
| `src/background/index.ts`                 | `settings.set` 检测 limit patch 并触发 3 个 trim                                                       |
| `src/lib/i18n.ts`                         | 8 个 key × 3 处                                                                                        |
| `src/sidepanel/SettingsTab.tsx`           | 新增保留上限卡片                                                                                       |
| `src/sidepanel/HistoryTab.tsx`            | `useDeletion` + 8 处 handler + `BatchBar` + 计数文案                                                   |
| `tests/history-retention.spec.ts`         | 新建：钳制 / 各类裁剪 / 设置变更 trim / 分组计数                                                       |
| `tests/history-deletion-loading.spec.tsx` | 新建：删除期间按钮禁用与文案切换                                                                       |

## 5. 验收

- ① `pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build` 全绿。
- ② 未改 Runner 侧（`server/`），`server:typecheck` / `server:test` 不适用。
- ⑤ 浏览器实证：BLOCKED（本环境未加载 unpacked extension）；给出人工步骤代替。
- ⑥ 复用：`normalizeHistoryLimit` 照 `normalizeRunWindowLimit`；4 个 trim 复用同一裁剪函数；`useDeletion` 一处定义三处用；分类条件抽 `isWorkflowRunSource`。
- ⑧ 全部新增文案 en + zh-CN；新增 UI 只用 Tailwind 语义 token，未新增 CSS class / token。
- ⑨ 无 `tmp/` 产物入暂存区。
- ⑩⑪⑫ 英文 Conventional Commit、单独提交推送 `main`、交付说明含人工测试步骤。
