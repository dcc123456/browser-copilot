# 聊天工具结果状态 / Chat tool outcomes

## 现状与目标

工具卡片已经由 `groupEntries` 放进对应的助理消息气泡，完成的 `<details>` 也默认收起。
当前缺口是 `tool.result` 只有名称和摘要，面板无法可靠区分成功与失败；空摘要还会被当成不可展开的普通行。

本次只补结果状态和展示，不重做消息布局：

- 工具执行中显示运行状态；完成后显示“成功”或“失败”，失败使用错误色边框、浅底和文字。
- 完成卡片始终使用默认关闭的 `<details>`，展开后查看工具摘要；空结果显示状态标签而不是永久执行中。
- `tool.result` 增加结构化 `ok`，失败分支（参数错误、模式/权限阻止、用户拒绝、工具异常及 `{ok:false}` / `{error}` 输出）必须传 `false`。旧消息没有该字段时按成功处理，以兼容重连期间的旧事件。
- 恢复消息直接携带 `toolOk`，由同一份原始工具结果判定；不从 `Failed`、`Blocked` 等摘要文字猜测。旧恢复消息同样按成功处理。
- 状态标签加入 `en` / `zh-CN` 字典，样式只使用现有 Tailwind 语义 token。

## 实现

1. 在 `src/lib/tool-error.ts` 提供原始工具输出的成功判定，Agent 与恢复链路共用。
2. 扩展 `AgentServerMessage`、恢复消息和面板 `Entry`，在事件接收时保存结果状态。
3. `ToolCallCard` 使用 `data-state="running|success|error"` 和 `data-ok`，显示双语状态标签；所有完成卡片均可展开。
4. 组件测试覆盖气泡内默认折叠、展开、成功、失败、空结果、重连和恢复失败；恢复映射测试覆盖结构化错误。

## 验证

- `pnpm typecheck`、`TZ=UTC pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build`。
- 真实扩展加载后触发一次成功读取和一次失败点击，确认二者都在同一助理气泡内，默认收起，失败为红色且展开可见摘要。

2026-11-13 实证：`tmp/chat-tool-outcomes-probe.mjs` 用真实 Chrome、当前构建和本地假模型依次执行
`read_current_page`（成功）与 `click ref=e999`（结构化失败）。7 项检查全部通过：两张卡片都在同一
助理气泡内且默认关闭；状态分别为 `success` / `error`；失败卡片边框计算样式为 `rgb(188, 50, 50)`、
浅红底可展开并显示 `Unknown ref`；面板刷新恢复后仍保持两个状态且默认关闭。截图与判定 JSON 保存在
`tmp/chat-tool-outcomes-probe/`，不进入提交。
