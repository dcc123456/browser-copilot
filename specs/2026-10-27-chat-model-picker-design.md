# 聊天面板支持切换模型（2026-10-27）

## 1. 诉求（dcc 原话）

> 聊天界面中 将新对话和发送这个两个按钮的文案使用icon 替换
> 在新对话按钮的前面 增加模型选择下拉框 用户可以选择已经在模型设置中设置的模型 然后使用该模型进行对话

两件事：composer 里「新对话」「发送」由文字改成图标按钮；在「新对话」左侧加一个模型下拉框，
选项来自「模型设置」里已经配置好的 provider / model，选完就用该模型对话。

## 2. 现状取证

- token / 模型对回合的唯一影响点是 `runAgentTurn` 的 `provider`
  （`src/background/agent.ts:4946`：`deps.getProvider?.() ?? getActiveProvider()`）。
  面板会话的 deps 没有传 `getProvider`（`src/background/index.ts:3748`），
  所以聊天用的就是 `settings.activeProviderId` 指向的 profile，`provider.model` 是它的当前模型。
- provider 列表、每个 profile 的候选模型都在 `Settings.providers`（`src/lib/types.ts:109`）：
  `ProviderProfile.models?: string[]` + `model`（`src/lib/providers.ts:24`）。
  旧档案可能只有 `model` 没有 `models`；`ModelsTab` 里已有兼容读法
  `providerModels(profile)`（`src/sidepanel/ModelsTab.tsx:58`）。
- 切 active provider 已有命令 `provider.activate`（`src/lib/messages.ts:154` →
  `src/background/index.ts:1478` → `setSettings({ activeProviderId })`），返回完整 `Settings`。
  **但没有切「同一 provider 内的模型」的入口**——Settings 里只能整份 profile 重新保存。
- composer 底行：`.composer-row` 左侧是模式选择，右侧 `.actions` 依次是附件、压缩、
  `＋ 新对话`、`停止`、发送/补充（`src/sidepanel/ChatTab.tsx:4373-4446`）。
  面板已在挂载时读一次 settings 取 `mode`（`ChatTab.tsx:2677`），但没有 provider 信息。
- 面板各 tab 常驻挂载（`src/sidepanel/App.tsx:353`），在 Models 里改完 provider 后 ChatTab
  不会自动重读 settings；`MarketplaceTab` 已有 `active` 布尔 prop 的先例（`App.tsx:377`）。
- 测试里按文字找发送按钮：`tests/chat-save-dialog.spec.tsx:762,806` 用
  `textContent === 'Send'`，图标化后会失效，需改成按 `aria-label` 找。

## 3. 决策

**D1 下拉框切的是全局「当前模型」，不是每个会话各存一份。** 选中的就是
`Settings.activeProviderId` + 该 profile 的 `model`——与 Settings 面板里的「使用此模型」是同一份状态，
所以「设置里选的模型」和「聊天里选的模型」永远一致，worker 无需改动取值链路。
否决「每个会话记住自己的模型」：那要给 `ConversationMeta` 加字段、在 worker 侧按会话解析
provider（`AgentDeps.getProvider` 目前只有 unattended 用），并且与 Settings 的单一 active
语义分叉；本次诉求只要求"选一个模型然后用它对话"，全局切换足以满足，改动面小一个数量级。
代价：在一个会话里切模型，其它会话也切过去——见 §5 边界。

**D2 命令是 `provider.activate` 的扩展，不新增第二套设置写入。** Command 增加可选 `model`，
worker 交给 `activateProvider(id, model?)`（`src/lib/storage.ts`，紧挨 `saveProvider`）：
在 settings 锁内一次写入 `providers`（目标 profile 的 `model`）与 `activeProviderId`。
否决「面板自己拼整份 providers 再 `settings.set`」：面板拿到的是快照，并发（另一窗口改了 provider）
会整份覆盖，且两次 `settings.set` 可能只落一半。`model` 只有在
`providerModels(profile)` 里存在时才写入，避免破坏「`model` 属于 `models`」的档案不变量。

**D3 选项按 provider 分组，option 文案是模型名。** `<optgroup label={profile.label}>` +
`<option>{model}</option>`：side panel 很窄，模型名比「火山方舟 Volcengine Ark · doubao-…」更可读，
provider 名仍然可见（分组标题）。value 用 `providerId + '\u001f' + model`，选中后回查 choices 拿
provider/model。没有配置任何 provider 时不渲染下拉框（发送本来就会报"没有配置模型"）。
`providerModels` 从 `ModelsTab` 提取到 `src/lib/providers.ts` 导出，两处共用（AGENTS §5.2）。

**D4 图标化只改这两个按钮。** 新对话 → `SquarePen`，发送 → `ArrowUp`，两者都是
`icon-btn`（文字换成 `aria-label`/`title`，沿用 `t.chatNewChat` / `t.chatSend`）；
发送按钮保留 `.primary`，配 `.icon-btn` 得到 28px 的强调色方形图标按钮（复用现有类，不新增 CSS）。
回合进行中 composer 里的那个按钮显示的是「补充」（interject），是另一个动作，保留文字，避免
两个只差图标的按钮让用户猜。`停止` 同理不在本次范围内。

**D5 下拉框常驻但回合中禁用。** 位置在 `.actions` 里、新对话按钮之前；`disabled={busy}`
（回合开始时已解析 provider，中途改设置不会影响本回合，禁只是为了不给出"立即生效"的错觉）。
切换成功后用返回的 `Settings` 刷新本地状态；失败时回滚选中值并 toast
（`chatModelSwitchFailed`），不静默。

**D6 面板重新可见时重读。** 新增可选 prop `active?: boolean`（默认 `true`，测试无感），
`App.tsx` 传 `active === 'chat'`；effects 在 `active` 为真时重读 settings，于是 Models 里
新增/删除 provider 后回到聊天页即可看到新选项。

## 4. 测试与验收

- `tests/storage-activate-provider.spec.ts`：`activateProvider` 同时写 `model` 与
  `activeProviderId`；`model` 不在该 profile 的 `models` 里时只切 provider、不改 `model`；
  未知 id 时指针回落到第一个 profile（沿用 `setSettingsLocked` 的既有行为）。
- `tests/chat-model-picker.spec.tsx`：真实 ChatTab + mock `sendCommand`。settings 里两个 profile
  （一个多模型），渲染出两个 optgroup 与全部模型；选中另一个模型发出
  `{ type:'provider.activate', id, model }`；失败时选中值回滚且 toast 报错。
- 既有 `tests/chat-save-dialog.spec.tsx` 的发送按钮查找从文字改为 `aria-label`。
- 门禁：`pnpm typecheck`、`TZ=UTC pnpm test`、改动文件 eslint + prettier、`pnpm build`。
- 浏览器实证：Chrome for Testing 加载 `dist/`，在 Models 里预置两个模型，聊天页下拉框列出二者，
  选另一个后新一轮请求打到新模型（用本地假 SSE 端点记录 `model` 字段），且 Settings 里显示同一个
  active 模型；截图落 `tmp/`。
