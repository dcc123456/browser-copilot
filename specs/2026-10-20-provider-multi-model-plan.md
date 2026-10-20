# 供应商多模型 · plan

日期 / Date: 2026-10-20
设计 / Design: `specs/2026-10-20-provider-multi-model-design.md`

## 1. 已知的坑 · Traps

1. **`validateProfile` 的消息语言**：错误消息在面板与 worker 两边都直接显示。新增校验文案必须双语（§3），所以 `validateProfile` 改为接收 `Messages`——面板传 `useT()`，worker 传 `workerMessages()`（`src/background/index.ts` 已有该入口）。测试里用 `messagesFor('en')`。
2. **归一化函数的落点**：`providers.ts` 与 `storage.ts` 互相之间已经有一边是 type-only 依赖；把 `normalizeProviderModels` 放进 `types.ts`（两边都已 value-import 它），避免引入运行时环。
3. **datalist 过滤**：`<input list>` 的建议按输入框当前值做前缀过滤。修复不是「改过滤」，而是**永远不给这个输入框预填值**。
4. **请求面不能动**：15 处 `provider.model` 全部保持指向「使用中的模型」，不改成数组。

## 2. 切片 · Slices

| #   | 切片                                                                                                                           | 落点                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 1   | 数据契约：`ProviderProfile.models`、`ProviderPreset.suggestedModel`、`profileFromPreset` 不预填、`validateProfile(profile, t)` | `src/lib/providers.ts`                                                      |
| 2   | 归一化：`normalizeProviderModels`，面板侧与 worker 侧都套用                                                                    | `src/lib/types.ts` / `src/lib/providers.ts` / `src/lib/storage.ts`          |
| 3   | 文案：13 个新 i18n key（en + zh-CN）                                                                                           | `src/lib/i18n.ts`                                                           |
| 4   | 面板：添加模型输入框（永远为空）+ 已添加模型清单（单选=使用中）+ 移除；卡片列出全部模型                                        | `src/sidepanel/SettingsTab.tsx`                                             |
| 5   | 测试：数据契约、归一化、校验消息、面板交互（jsdom）                                                                            | `tests/providers.spec.ts` / `tests/settings-thinking-ui.spec.tsx` 或新 spec |

## 3. 验收 · Acceptance

- 新建供应商：模型输入框为空；「获取模型」后下拉里能看到拉回来的**全部**模型。
- 一个供应商可添加 ≥2 个模型，其中恰有一个是「使用中」；切换使用中后请求发的是新模型。
- 移除使用中的模型 → 使用中自动落到剩余第一个；全部移除 → 保存被拦下并给出双语提示。
- 旧档案（只有 `model`）打开、编辑、保存后行为不变。

## 4. 浏览器实测 · Browser evidence

侧边栏是扩展页面、不可脚本化，因此用 `tmp/provider-models-ui/` 的 vite + playwright harness 渲染真实的 `SettingsTab`（`tmp/` 不入库）：

- 打开供应商编辑器后，`#p-model` 的 `value` 为空字符串，`list="model-options"` 指向的 `<datalist>` 在「获取模型」后包含端点返回的**全部 4 个**模型名（`deepseek-chat` / `deepseek-reasoner` / `qwen-plus` / `gpt-4o`）——预填值已消失，按前缀过滤无从发生。
- 已添加模型清单渲染为两行，第一行的单选钮选中并带「In use」标记，右侧是 Remove 按钮；深色 / 浅色两套主题都截图确认，无 console / page 错误。
- 过程中发现并修掉两个只有真浏览器才暴露的问题：`.checkbox` 复用（见设计 §3.5）与「添加模型」输入框的 placeholder 改用 `settingsModelAddPlaceholder`（明确是示例，不再像预填的默认值）。

## 5. 门禁 · Gates

- `TZ=UTC pnpm typecheck`
- `TZ=UTC pnpm test`
- `pnpm lint` / `pnpm format:check`（按 `git ls-files` 限定，见项目记忆：裸 `pnpm lint` 会被 `tmp/ci-surface` 弄红）
- `pnpm build`
- `pnpm server:typecheck` / `pnpm server:test`（Runner 不改，但 `src/lib/**` 变了要确认仍能编译）
- `pnpm bench:debug`（本次不改 `src/background/workflow-engine/**`，但 `src/lib/**` 变了，跑一遍确认基线 0.6667 未动）
