# 通知算子：飞书通道 + 免目标契约 · plan

日期 / Date: 2026-10-15
设计 / Design: `specs/2026-10-15-notification-feishu-and-goal-free-design.md`

## 切片

| #   | 步骤                                                | 落点                                                                                                                | 验收                                                                                                 |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | 注册表新增 `goalBearing` 位与 `operatorCarriesGoal` | `src/lib/workflow/operator-registry.ts`                                                                             | 新单测：三个 id 为 false，`event-click`/`forms` 为 true，未知 id 为 true                             |
| 2   | 契约产生处短路"编造"，保留模型自带契约              | `src/lib/workflow/node-goal-instantiation.ts:109-149`                                                               | 单测：`resolveNodeGoalContract('notification', {title,message})` → undefined；传 supplied → 原样返回 |
| 3   | 编辑器按同一谓词隐藏目标区与 AI 修复入口            | `src/workflow-editor/sidebar/BlockEditForm.tsx:135-179`                                                             | 单测/组件断言：三个 id 无 `nodeGoalSection`、无 Wand2 按钮；`forms` 仍有                             |
| 4   | 通知块数据 + 表单勾选框（en/zh）                    | `src/lib/workflow/blocks/catalog.ts:1409-1416`、`blocks/batchD/EditNotification.tsx`、`src/workflow-editor/i18n.ts` | `pnpm typecheck`（封闭字典两侧同时赋值）+ 表单渲染断言                                               |
| 5   | 扩展执行器发飞书，失败只 `emit('error')`            | `src/background/workflow-engine/executors.ts:1837-1851`                                                             | 单测：未配置→警告且节点不抛；HTTP 抛错→警告且节点不抛；正常→调用 sendWebhookText 且带 title/body     |
| 6   | Runner 执行器镜像（用 `config.feishu`）             | `server/src/executors.ts:1087-1093`                                                                                 | `pnpm server:typecheck` + Runner 侧同语义单测                                                        |
| 7   | 回归：目标契约消费方与生成校验                      | `tests/**`                                                                                                          | `pnpm test` 全绿；`generated-validation` 的 `NODE_GOAL_MISSING` 不再落在这三个 id 上                 |

## 门禁（收尾自检对应）

- ① `pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`（tracked 文件口径）、涉及 UI/catalog 额外 `pnpm build`。
- ② `pnpm server:typecheck`、`pnpm server:test`（Step 6 动 Runner）。
- ③ 不涉及 `ai-takeover.ts` / `workflow-engine/**` 的调试成功率口径？——Step 5 改的是 `workflow-engine/executors.ts`，按 §收尾自检 ③ 跑 `pnpm bench:debug` 取 before/after。
- ⑤ 真实浏览器：扩展侧勾选飞书跑一次含通知节点的工作流，观察运行日志出现「已通知」且飞书群收到消息（未配置时应出现警告行且运行仍判成功）。拿不到就标 BLOCKED。
