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

## 子 Agent 进度修正（追加）

问题：`orchestrator.ts` 把子 Agent 的 `tool.start` 转成 `[search-expert] open_url` 独立状态行，
同时丢弃 `tool.result`，因此执行中不断出现气泡外的工具名字符串。

修正：子 Agent 的 `tool.start` / `tool.result` 原样保留事件类型和结构化结果，只把工具显示名改为
`[agent] tool`，让现有 `ToolCallCard` 在同一助理气泡里展示运行、成功、失败及折叠详情。
子 Agent 的普通状态文本、回答 delta 和 token 用量仍不转发，保持上下文与界面隔离。
回合结束后的父 transcript `restore` 会保留当前面板里的子 Agent 卡片；它们不写入父模型上下文，
普通刷新或切换会话仍只恢复父 transcript，不制造无匹配 tool call 的历史消息。

真实 Chromium 实测（`tmp/subagent-tool-cards-probe.mjs`，配合本地模拟模型和最小 Agent 配置）：
supervisor 实际委派 search-expert，子 Agent 实际执行 `open_url`。最终面板中
`[search-expert] open_url` 为 `success` / `ok=true`、默认关闭且位于 `assistant-turn` 内；
遍历全部文本节点未发现卡片外的同名字符串。四项断言全部 PASS，截图与判定 JSON 保存在
`tmp/subagent-tool-cards-probe/`，不进入提交。

## 结果图标轻量化（追加）

成功与失败卡片统一使用普通边框和背景，不再通过绿色/红色边框、底色、工具名或结果详情表达状态。
已完成卡片只显示中性 `✓` / `×` 图标，不显示“成功 / 失败”或“Succeeded / Failed”可见文字；
图标仍保留双语无障碍名称，执行中状态和工具执行详情不变。

真实 Chromium 复测同时生成一个成功 `read_current_page` 和一个失败 `click`：两张卡片计算后的边框均为
`rgb(220, 226, 235)`、背景均为 `rgb(250, 251, 253)`，图标分别为 `✓` / `×`，卡片文本不包含
`Succeeded` / `Failed`；失败详情可展开，刷新恢复后状态和折叠行为保持。九项断言全部 PASS，
证据保存在 `tmp/chat-tool-outcomes-probe/`，不进入提交。
