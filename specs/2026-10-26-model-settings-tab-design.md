# 2026-10-26 · 模型设置独立菜单 + 模型列表多选 + 推理 token 修复

## 1. 背景

侧边栏「设置」页长期把三类模型配置混在通用设置里：

- 模型服务（providers 卡片 + 新建/编辑对话框）
- 图片识别模型
- AI 接管模型（含两个运行开关）

用户反馈四条：

1. 这三部分应从「设置」抽出，放进单独菜单「模型设置」。
2. 「添加模型服务」下拉里，自定义项应在最下方。
3. 获取模型列表后，模型选择要支持多选。
4. 聊天底部 token 条里的「推理」一直是 0。

## 2. 目标 / 非目标

目标：把模型相关配置整体迁到一个新 tab；修正预设排序；把「获取模型列表」的
单选 datalist 升级为可批量勾选；修正推理 token 的解析字段。

非目标：不改 `Settings` 数据结构、不改 provider 命令协议、不改 Runner 侧；
不重做 token 条布局；不动未配置 provider 的其它设置卡片。

## 3. 菜单拆分

- `App.tsx`：`TabId` 新增 `models`，放进 `MORE_TABS` 且排在 `settings` 之前；
  `TAB_LABEL.models = 'tabModels'`。
- i18n（封闭 `Messages`）：`tabModels` en `Model settings` / zh-CN `模型设置`。
- 新组件 `src/sidepanel/ModelsTab.tsx`：承载 provider 卡片与编辑器、图片识别卡片与
  对话框、AI 接管卡片与对话框（含 `takeoverOnRun` / `autoRepairOnRun` 两个 switch
  和 OCR 语言选择）。
- `SettingsTab.tsx` 只保留：窗口策略、Agent 行为（提示词 / 工具）、最大步数、语言、
  页面权限、存储位置、下载目录、本地 agent、更新卡片。

### 3.1 共享 settings 读取

两个 tab 都需要「读 settings → 归一化 → 命令后回写 settings」与 storage 变更订阅。
按 AGENTS §5.2 抽 `src/sidepanel/hooks/useSettings.ts`：

- `settings`：归一化后的设置或 `null`（首帧）。
- `error` / `clearError`：加载或命令失败文本。
- `applySettings(next)`：命令结果回写。
- `mutate(command)`：发送命令，成功返回应用的 settings，失败写入 `error` 并返回 `null`。
- 挂载时 `settings.get` 一次，并订阅 `onStoreChanged('settings')` 重读。

`SettingsTab` 的 `banner` 继续负责成功类提示（保存成功、页面检查结果），失败走 hook 的
`error`。两个 tab 的草稿（本地 agent URL/token、图片/接管模型选择）通过 `settings`
变化后的 effect 同步；模型卡片上的「当前值」直接读已保存的 `settings.imageModel` /
`settings.takeoverModel`，不再依赖草稿（旧实现首帧会误显示「自动」）。

## 4. 预设顺序

`PROVIDER_PRESETS` 原本把 `custom` 夹在中间（ollama/lmstudio 之后、zhipu 之前）。
把它移到数组末尾，并在数组内注明「自定义固定最后」；`findPreset` 与其它逻辑不受影响。
测试补一条「custom 是最后一个 id」。

## 5. 模型多选

现状：`<input list="model-options">` + datalist + 单次「添加模型」。

改为：获取模型列表后，在输入框下方渲染一个复选框列表（`models` 全集）。
勾选即加入 `draft.models`，取消即移除；第一个加入的仍自动成为「使用中」。
底部「已添加模型」列表（单选使用中 + 移除）保留，作为唯一决定实际请求模型的位置。
手动输入 +「添加模型」保留，用于网关不提供 `/models` 的情况。
取消/移除使用中的模型时，沿用既有回退（下一个模型接管）。

多选复用现有 `settingsModelsAvailableToAdd` 的计数提示，只把文案从「请添加需要的模型」
改成「勾选要添加的模型」，两侧同步。

## 6. 推理 token 一直为 0

根因在 `src/lib/llm.ts` 的 `extractUsage`：它只从
`usage.prompt_tokens_details.reasoning_tokens` 和顶层 `reasoning_tokens` 取推理数，
但 OpenAI / DeepSeek / 多数兼容网关把思考 token 放在
`usage.completion_tokens_details.reasoning_tokens`（OpenAI Chat Completions /
DeepSeek Chat API 的 usage 说明）。因此真实流式响应中该字段永远读不到，界面恒为 0。

修复：按 `completion_tokens_details` → `output_tokens_details` → `prompt_tokens_details`
→ 顶层 `reasoning_tokens` / `reasoningTokens` 的顺序取第一个数字；
`tests/sse.spec.ts` 的用例改为标准位置，并保留一条兼容旧位置的断言。

## 7. 测试与验收

- `tests/sse.spec.ts`：`completion_tokens_details.reasoning_tokens` 被解析；
  旧 `prompt_tokens_details` 位置仍可读。
- `tests/providers.spec.ts`：`custom` 位于 `PROVIDER_PRESETS` 末尾。
- `tests/settings-provider-models-ui.spec.tsx` / `tests/settings-thinking-ui.spec.tsx`：
  改为渲染 `ModelsTab`；新增「勾选多个模型一次加入」用例。
- 真实浏览器（`tmp/preview`）：Tab 栏「更多 → 模型设置」可进入；添加服务下拉最后一项
  是自定义；获取模型后勾选两个 → 已添加列表出现两个；token 条「推理」显示非零
  （用构造的 usage 帧验证渲染链路）。
- 门禁：`pnpm typecheck` / `pnpm test`（`TZ=UTC`）/ `pnpm lint`（git ls-files）/
  `pnpm format:check` / `pnpm build`。
