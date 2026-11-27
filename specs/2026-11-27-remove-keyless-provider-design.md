# 移除免密钥默认 provider（Pollinations）· 设计与计划

日期：2026-11-27 · 分支：`main`

## 1. 背景与决策

用户明确要求：免密钥方案「几乎不可用」，删除该功能。当前全新安装会种入 `default-pollinations`（`apiKey: ''`、`free: 'direct'`），并靠 `KEYLESS_HOSTS` 精确匹配放行无 key 请求。

| 候选                                        | 结论     | 理由                                                       |
| ------------------------------------------- | -------- | ---------------------------------------------------------- |
| 保留 Pollinations 作为可选预设，只取消默认  | 否决     | 用户说「免密钥的也删除」，不是「不再默认」                 |
| 保留免密钥判断骨架                          | 否决     | 无可用 keyless 端点后就是死代码                            |
| 删除默认种子、Pollinations 预设与免密钥判定 | **采用** | 所有 provider 一律要求 key；新装用户到「模型服务」自行添加 |

## 2. 改动范围

- 删除 `src/lib/free-provider-default.ts` 整个文件。
- `src/lib/providers.ts`：删 Pollinations preset、`KEYLESS_HOSTS` / `isKeylessEndpoint` / `providerNeedsKey` / `providerHasCredentials` / `freeAccessOf` 的免密钥分支；preset 的 `free: 'direct'` / `keyless` 字段与相关 hint 一并清理（其余 quota 预设保留，仍按「自带 key + 免费额度」展示）。
- `src/lib/storage.ts`：删 `SCHEMA_VERSION` 的 v8 默认种子分支、`DEFAULT_SETTINGS` 与 `normalizeStoredSettings` 的种子、`LEGACY_EMPTY_SETTINGS` 中的免密判断；`saveProvider` 首个真实 provider 接管逻辑不再需要跳过默认 profile。
- `src/lib/llm.ts` 与 7 处 `providerHasCredentials` 守卫：凭据判断统一退化为「必须有 key」，守卫代码无需改（helper 删掉后改为直接读 `apiKey`）。
- `src/sidepanel/ModelsTab.tsx` / `ChatTab.tsx`：删免密钥 / Free 徽标与「无需 key」提示，保留空 provider 列表引导。
- `src/lib/i18n.ts`：成对删除 `settingsFreeProviders` / `settingsFreeBadge` / `settingsKeyOptional` / `settingsKeyNotRequired` / `settingsNoKeyNeeded` / `presetPollinationsHint` 等 en / zh-CN key。
- 测试：删 `tests/llm-keyless.spec.ts`，清理 `tests/providers.spec.ts` 的 keyless 用例与 UI / 迁移 fixture。
- README（中英）与 `website/index*.html`：删除「默认免费可用」的当前描述；历史 `release-notes/` 与 `CHANGELOG.md` 不动。

## 3. 数据迁移

停止种回默认 profile；对已存在的 `default-pollinations` profile 按 id 精确删除（用户自己改过 label / baseUrl 的同 id 配置视为旧默认，一并清掉，避免留一个发不出请求的空壳）。`activeProviderId` 若指向被删的 id 则清空。若用户还有其他 provider，选中第一个。

## 4. 新装体验

`providers = []`、`activeProviderId = ''`。`ModelsTab` 已有 `settingsNoProvider` 空态，7 处 LLM 守卫安全跳过，不会崩。用户必须自行添加一个带 key 的 OpenAI 兼容 provider 后才能使用。不新增 onboarding 引导（超出本次范围）。

## 5. 验收

- 全量门禁绿（`typecheck` / `test` / `lint` / `format:check` / `build`）。
- 全新安装后模型服务列表为空，无任何 Pollinations / 免密钥文案。
- 带 key 的 provider 可正常添加、选中并调用。
- 旧配置中残留的 `default-pollinations` 被清理，不会自动回来。
- 无残留 keyless i18n key 与死代码。
