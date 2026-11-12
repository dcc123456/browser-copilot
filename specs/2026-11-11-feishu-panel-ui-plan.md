# 飞书集成面板 UI 优化

日期：2026-11-11 · 范围：`src/sidepanel/TasksTab.tsx`、`src/lib/i18n.ts`、`tests/**`

## 1. 现状与问题

面板不在设置页，而是「任务」Tab 底部默认折叠的 `<details className="collapsible">` 中的 `FeishuSection`（`TasksTab.tsx:408-493`）。当前 100% 使用 `styles.css` 的 legacy 自定义 class（`card/field/hint/actions/banner-error-inline`），未使用项目现行的 Tailwind 语义 token 体系（§2）。

已确认的问题：

1. **无分组**：Webhook 推送 与 Bot 触发 两套配置平铺在同一卡片，仅一条裸 `<hr />` 分隔；`.collapsible > .card`（styles.css:1627）还会抹掉卡片边框，分组感更弱。
2. **标题重复**：折叠头「飞书集成」+ 卡内 `<h3>飞书`，两个标题平级且无样式区分。
3. **状态反馈离得远**：保存/测试的结果只显示在页面**顶部** `Banner`，与面板相隔整个任务列表；成功文案直接复用 `t.save`（「保存」），语义不明。
4. **无 loading 文案**：只有 `disabled={busy}` 让按钮变灰，没有「保存中…/发送中…」。
5. **按钮无层级**：3 个按钮（2 个保存 + 1 个测试）全是默认次级样式，项目已有 `PRIMARY_BUTTON` / `SECONDARY_BUTTON` 却未用。
6. **保存逻辑不一致**：`dirty` 只约束分区 A 的保存；分区 B 的保存无条件可点；`botEnabled` 单独切换时 A 区禁用而 B 区可保存同一份 config。
7. **警告不醒目**：`tasksFeishuBotWarn` 用 `.banner-error-inline`（仅 `color: var(--warn)`，类名却是 error），没有背景/边框/图标；与紧邻的 `tasksFeishuBotHint` 挤成两行 11px 灰字。
8. **敏感字段处理不统一**：`webhookSecret` 明文，`appSecret` 为 `type="password"`。
9. **折叠头无状态概要**：看不出是否已配置。

## 2. 选型与证据（§7）

不引入新组件库 / 新 API，样式参考全部取自仓库内已落地且使用语义 token 的组件，均已在本地读源码核对：

| 参考                                    | 路径                                                                                        | 取用的模式                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 卡片 + 状态色 + 主次按钮 + loading 文案 | `src/sidepanel/update/UpdateSettingsCard.tsx:50-106`                                        | `rounded-[10px] border border-border bg-panel p-3`、`text-ok/text-err/text-warn`、`PRIMARY_BUTTON`/`SECONDARY_BUTTON`、`checking ? t.updateChecking : ...` |
| 分组容器                                | `src/sidepanel/components/CardSection.tsx:40-66`                                            | `rounded-lg border border-border` + `border-t border-border` 内部分组 + `flex flex-col gap-1.5`                                                            |
| 就地状态条                              | `src/sidepanel/ModelsTab.tsx:648-660`                                                       | `border-ok/30 bg-ok-surface text-ok` / `border-err bg-err-surface text-err` + `role=status\|alert`                                                         |
| 按钮常量                                | `src/ui/button-styles.ts:9-13`                                                              | 直接复用，不新写按钮类                                                                                                                                     |
| 设计 token                              | `src/ui/design-system.css:26-73`（`@theme inline`）、`:76-120`（dark）、`:124-163`（light） | 颜色 token 齐全，**无需新增 `--bc-*` 变量**；正文色是 `text-ink` 不是 `text-text`                                                                          |

被否决的候选：

| 候选                                               | 否决理由                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 在 `styles.css` 里给飞书面板新增 `.feishu-*` class | 违反 §2「禁止为一次性样式手写新 class」，且与新组件体系进一步分叉。                                   |
| 保留 legacy class 只微调间距                       | 不解决主次按钮、状态反馈、分组这三个主要问题；且 §2 要求「新增或**修改**的 UI 样式必须用 Tailwind」。 |
| 把面板搬到设置页                                   | 超出「优化样式」的范围，且会改变 `feishu.get/save/test` 的挂载点与用户既有入口。                      |
| 加「连接状态」实时探测（轮询 bot 在线状态）        | 需要新的后台命令与长连接查询，属于新功能而非 UI 优化；本次只做「已配置 / 未配置」的本地静态徽标。     |
| 用 `toast()` 替代就地状态条                        | toast 3.4s 自动消失，表单类错误需要可停留、可重试的就近反馈（ModelsTab 的注释已明确此约定）。         |

## 3. 设计

### 3.1 结构

`FeishuSection` 整体改写为 Tailwind 语义 token，保留原有 `config` / `onChange` / `onSave` / `onTest` 数据契约与 `feishu.save` / `feishu.test` 命令不变：

- 一个外层卡片 `rounded-[10px] border border-border bg-panel p-3`，标题行用 `font-semibold text-ink`，右侧放「已配置 / 未配置」徽标（`text-ok` / `text-muted` + 对应 surface）。
- 两张子分组（各自 `rounded-lg border border-border bg-panel-2 p-2.5`，带小标题与说明）：
  - **Webhook 推送**：Webhook URL、签名密钥（统一 `type="password"`）、hint、按钮行（主「保存」+ 次「发送测试消息」）。
  - **Bot 触发**：`Switch` 开关 + 状态，展开后 App ID / App Secret / 说明 / 警告块（`border-warn/30 bg-warn-surface text-warn` + 图标）/ 保存按钮。
- 就地状态条：保存成功、测试成功、失败都显示在**面板内部**。落地时改为**不再**写顶部 `Banner`：飞书的保存/测试结果只属于这张卡片，顶部 `Banner` 留给任务列表自身的操作（保存/删除/立即运行），两条同义消息分处两处仍是重复反馈。

### 3.2 状态与交互

- 新增 `pending: 'save' | 'test' | null`（局部 state，替代仅靠全局 `busy`），`saveFeishu` / `testFeishu` 返回 `Promise<FeishuOutcome>`（`{ kind: 'ok' | 'error'; text: string }`）并在 `finally` 复位；按钮在 pending 时 `disabled` 且文案切换为「保存中…」/「发送中…」。
- 新增 `notice: FeishuOutcome | null` 局部 state，由 `submit()` 回填；面板内渲染就近状态条。
- 统一保存逻辑：删除 `dirty` 的 OR 链判断，改为 `canSave = Boolean(config.webhookUrl || config.webhookSecret || config.appId || config.appSecret || config.botEnabled)`，两个分区共用同一个 `onSave(config)`；卡片底部只有**一个**主保存按钮，webhook 分区内只放「发送测试消息」次级按钮。
- 配置状态徽标（已配置 / 未配置）由模块级 `isFeishuConfigured(config)` 判定，折叠头与卡片共用同一个函数。
- `webhookSecret` 改 `type="password"`，配一个「显示密钥」复选框（`revealSecret` 局部 state）。

### 3.3 折叠头

`<summary>` 内除标题外补一个状态概要（`t.tasksFeishuConfigured` / `t.tasksFeishuNotConfigured`），让收起状态也能看出是否配置；`feishu && (...)` 条件保留（配置未加载时不渲染）。

### 3.4 i18n（三处：interface / en / zhCN）

新增 11 个 key：`tasksFeishuWebhookGroup`、`tasksFeishuWebhookGroupHint`、`tasksFeishuBotGroup`、`tasksFeishuConfigured`、`tasksFeishuNotConfigured`、`tasksFeishuSaving`、`tasksFeishuTesting`、`tasksFeishuSaved`、`tasksFeishuTestFailed`、`tasksFeishuReveal`、`tasksFeishuWarnTitle`。
`tasksFeishuTestFailed` 是落地时补的：`feishu.test` 失败但 worker 没带 message 时，原代码回落到硬编码英文 `'failed'`，违反 §3（JSX/文案不得硬编码），改成双语 key。已有 `tasksFeishuTestOk` / `tasksFeishuTitle` / `tasksFeishuBot` 等继续复用；`tasksFeishuTitle` 改作卡片标题行的文字，不再重复渲染成 `<h3>`。

## 4. 改动清单

| 文件                             | 改动                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sidepanel/TasksTab.tsx`     | `FeishuSection` 重写；`saveFeishu`/`testFeishu` 返回结构化结果；折叠头状态概要；新增 `pending`/`notice`/`revealSecret` state；引入 `PRIMARY_BUTTON`/`SECONDARY_BUTTON`/`AlertTriangle` 图标 |
| `src/lib/i18n.ts`                | 10 个 key × 3 处                                                                                                                                                                            |
| `tests/feishu-panel-ui.spec.tsx` | 新建：分组渲染、状态徽标、保存/测试 loading 文案、就地状态条、单一保存按钮                                                                                                                  |

## 5. 验收

- ① `pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build` 全绿。
- ② 未改 Runner 侧，不适用。
- ⑤ 浏览器实证：BLOCKED（本环境未加载 unpacked extension）；给出人工步骤。
- ⑥ 复用 `PRIMARY_BUTTON`/`SECONDARY_BUTTON`、既有 `Banner`/`Switch`、既有 i18n key，未新建 UI 组件文件。
- ⑧ 新增/修改的 UI 全部 Tailwind 语义 token，无硬编码颜色、无内联静态 style、无新 CSS class；10 个新文案 en + zh-CN 对齐（`Messages` 封闭类型机检 + `tests/i18n.spec.ts`）。
- ⑨ 无 `tmp/` 产物入暂存区。
- ⑩⑪⑫ 英文 Conventional Commit、单独提交推送 `main`、交付说明含人工测试步骤。
