# 供应商多模型 · One provider, several models — design

日期 / Date: 2026-10-20
关联 / Related: `specs/2026-10-20-provider-multi-model-plan.md`
相邻主题 / Adjacent: `specs/2026-10-20-thinking-effort-design.md`（思考强度挂在同一份档案上）

## 1. 需求原文 · Requested behaviour

- 「添加模型时 取消默认值 有默认值会导致获取到下拉值时 被默认值过滤掉」
- 「支持添加多个模型 现在一个模型提供商只能选择一个模型 我希望一个模型提供商能同时添加不同模型」

拆成两条可验收的行为：

1. **不再预填默认模型**：新建供应商时，模型输入框必须是空的。预填的默认值会让「获取模型」拉回来的下拉建议按输入框当前值做前缀过滤，用户看不到其他模型。
2. **一个供应商可同时持有多个模型**：档案里保存一组模型，并且其中有一个是「使用中」的——所有请求仍只发一个模型名，所以必须有明确的当前模型。

## 2. 现状取证 · Evidence about the current code

### 2.1 默认模型是怎么把下拉值筛掉的

- 新建供应商：`profileFromPreset`（`src/lib/providers.ts:333-342`）把预设的 `defaultModel` 写进 `model`；预设清单里 19 个预设**每一个**都带 `defaultModel`（`providers.ts:78-278`）。
- 面板表单态 `Draft` 直接继承 `profile.model`（`src/sidepanel/SettingsTab.tsx:66-77`），渲染成
  ```tsx
  <input id="p-model" list="model-options" value={draft.model} />
  ```
  （`SettingsTab.tsx:1295-1301`），同一个 `<datalist id="model-options">` 里装的是 `provider.models` 命令（`src/background/index.ts:1362-1369` → `listModels`）拉回来的全部模型名。
- 结论：模型输入框**一打开就带着值**，而 Chrome 的 `<input list>` 建议列表按输入框当前值做前缀过滤——于是「获取模型」的结果里只剩与默认值同前缀的那几条。用户看到的现象就是「获取到的下拉值被默认值过滤掉」。
- 因此修复点在**预填**，不在过滤：输入框永远为空 → 建议列表不被过滤。

### 2.2 一个供应商为什么只能有一个模型

- `ProviderProfile.model`（`src/lib/providers.ts:37`）是**单值字符串**，档案里没有第二个槽位。
- 所有模型请求都读这一个字段：聊天（`src/background/agent.ts:4848`）、审查（`workflow-engine/workflow-review.ts:187`）、节点修复（`node-fix-engine.ts:151`）、执行器（`executors.ts:2164`）、修复提案（`repair/repair-provider.ts:42`）、图像识别兜底（`src/lib/vision.ts:61-66`）、接管模型（`src/lib/workflow/ai-takeover.ts:555-566`）等，共 15 处 `provider.model`。
- 档案是**整对象替换**落盘（`src/lib/storage.ts:460-473`），`normalizeStoredSettings`（`:188-191`）不重建字段，只按 `id` 过滤——所以新增一个可选数组字段不需要改持久化白名单，旧档案缺该字段时按缺省处理即可。

### 2.3 校验消息的语言问题

- `validateProfile`（`providers.ts:298-330`）返回英文硬编码消息（`'Model is required.'` 等），面板原样显示（`SettingsTab.tsx:761`），worker 也直接抛（`src/background/index.ts:1325-1327`）。
- 封闭 `Messages` 接口（`src/lib/i18n.ts`）要求 en + zh-CN 同时赋值；本次要新增「至少一个模型」「使用中的模型必须在已添加列表内」两条校验文案，因此 `validateProfile` 整体改为从 `Messages` 取文案（既满足 §3，也不留一半英文一半中文的混合输出）。

## 3. 设计 · Design

### 3.1 数据契约

```ts
export interface ProviderProfile {
  ...
  /** 使用中的模型；一定是 {@link models} 之一。 */
  model: string
  /** 该供应商持有的全部模型；`model` 指向其中之一。 */
  models?: string[]
}
```

- 不变式：**`model` 非空 ⟺ `models` 非空，且 `model ∈ models`**。
- 旧档案只有 `model` → 归一化后 `models = [model]`，行为完全不变。
- `models` 可选（`?`），旧版本读到的档案仍是合法 `ProviderProfile`；缺省时按 `[model]` 解释。

### 3.2 预设不再预填模型

- `ProviderPreset.defaultModel` → `ProviderPreset.suggestedModel`：语义从「默认使用的模型」变成「建议用户添加的模型」。
- 它**只**用作「添加模型」输入框的 placeholder，**永远不写进档案**。
- `profileFromPreset` 产出 `model: ''`、`models: []`。

### 3.3 归一化 · `normalizeProviderModels`

放在 `src/lib/types.ts`（与 `normalizeRunWindowLimit` / `normalizeLocalAgentUrl` 同居，是共享归一化的既有落点；`providers.ts` 与 `storage.ts` 都已依赖 `types.ts`，而 `types.ts` 对 `providers.ts` 只有 type-only 依赖，不构成运行时环）。

规则：

1. `models` 只保留去空白后的非空字符串，重复项去重（保持顺序）；
2. `model` 去空白；若不在 `models` 里则补进列表首位；
3. `model` 为空但 `models` 非空 → 取 `models[0]`。

面板侧（`normalizeSettingsPayload`）与 worker 侧（`normalizeStoredSettings`）都套用，保证两端看到同一份档案。

### 3.4 校验 · `validateProfile(profile, t)`

- 签名增加 `t: Messages`，消息全部走 i18n key（`errorProviderLabel` / `errorProviderBaseUrlRequired` / `errorProviderBaseUrlScheme` / `errorProviderBaseUrlInvalid` / `errorProviderApiKey` / `errorProviderModelRequired` / `errorProviderModelNotAdded`）。
- 面板传 `useT()`；worker 传 `await workerMessages()`（`src/background/index.ts` 里思考强度功能已引入的同一入口）。
- 规则：`model` 为空 → 「至少添加一个模型」；`model` 不在 `models` 内 → 「使用中的模型必须来自已添加的模型」。

### 3.5 面板 · 供应商弹窗的模型区

原来「一个输入框 = 档案的模型」，改成「一个输入框 = 添加模型的入口 + 一份已添加模型清单」：

- **添加输入框**（`#p-model`）：**永远为空**，placeholder = 预设的 `suggestedModel`（无预设建议时用 `doubao-seed-code, deepseek-chat, ep-…`）；`list="model-options"` 继续挂「获取模型」拉回来的 `<datalist>`——输入框为空 → 建议不被过滤，用户能看到全部模型，也可以直接手输（Ark 的 `ep-…` 端点 ID 就是手输的）。
- **添加按钮**：把输入框里的名字加入 `draft.models`；重复则不重复添加；加入后清空输入框；若是第一个模型，自动设为使用中。
- **已添加模型清单**：每行一个单选钮（= 使用中的模型）+ 模型名 + 移除按钮。移除使用中的模型时，使用中自动落到剩余的第一个；一个都不剩时 `model` 置空，保存被校验拦下。
- **档案卡片**：模型一行改为列出全部模型（使用中的排前面）。

行内的单选钮复用侧边栏既有的 `.checkbox` class（`src/sidepanel/styles.css`）：该 surface 的 `label` / `input` 元素规则是**未分层**的（`label { display:block; text-transform:uppercase }`、`input { width:100% }`），而 Tailwind 工具类在 `@layer utilities` 里——按 CSS 层的规则，未分层声明压过分层声明，所以工具类改不动这些元素样式。用既有的 `.checkbox`（它已经把 label 变成 flex 行、把 input 恢复成 `width:auto`）既符合 §5 的复用，也避开了自己手写一次性 class（§2）。

### 3.6 请求路径

- **不变**。所有请求点继续读 `provider.model`（= 使用中的模型），请求体装配（`src/lib/llm.ts`）不动。
- 思考强度的能力判定（`thinkingModelSupport(baseUrl, model)`）也继续针对使用中的模型。

### 3.7 文案 · i18n

`src/lib/i18n.ts` 封闭 `Messages` 接口，en + zh-CN 必须同时赋值（§3 机检）。新增键：

- `settingsModelAdd`（添加模型）
- `settingsModelRemove`（移除）
- `settingsModelActive`（使用中）
- `settingsModelActiveHint`（被标记为「使用中」的模型是实际发起请求的模型）
- `settingsModelEmpty`（尚未添加模型）
- `settingsModelsAdded`（已添加 {count} 个模型）
- `settingsModelsAvailableToAdd`（共 {count} 个可用模型，请添加需要的模型；与图像/接管模型弹窗里「从下拉列表中选择」的 `settingsModelsAvailable` 分开）
- `errorProviderLabel` / `errorProviderBaseUrlRequired` / `errorProviderBaseUrlScheme` / `errorProviderBaseUrlInvalid` / `errorProviderApiKey` / `errorProviderModelRequired` / `errorProviderModelNotAdded`

## 4. 边界与非目标 · Scope

- **不做**：给每个模型单独配 temperature / 思考强度 / maxTokens（仍是档案级）；不做「模型档案」实体；不改 Runner（`server/`）——它有自己独立的 provider 配置，不读本档案；不改请求体装配。
- **兼容性**：旧档案（只有 `model`）打开即用；`models` 缺失时归一化为 `[model]`。
- **不引入**新的一层抽象：模型清单就是档案上的一个字符串数组。
