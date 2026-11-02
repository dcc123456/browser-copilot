# 免费模型接入：免费 API 预设 · 设计与证据

日期：2026-11-01 · 分支：`feat/free-model-providers`

## 1. 背景与目标

用户希望在自己的插件对话里免费使用模型。最终采用**免费 API** 路线：

- Pollinations（免密钥，默认启用）；
- Gemini / Groq / Cerebras / SambaNova / Chutes / Hugging Face / ModelScope /
  Together / Novita / Nebius / Fireworks / OpenRouter `:free` / GitHub Models /
  智谱 GLM-4-Flash 等官方免费额度或免费模型。

只有 Pollinations 是 `free: 'direct'`（免密钥、直接可用）；其余是 `free: 'quota'`
（需要 key，有免费额度/每日赠送/速率限制）。

DeepSeek Web / ChatGPT Web 两个“驱动网页聊天”的 provider 已被**删除**：用户要求“零标签页 +
直接调用网页版私有接口”，而这在技术上不可靠、也不合规（见 §2.1）。

## 2. 选型与证据

### 2.1 接入方式候选

| 候选                                     | 结论       | 理由                                                                                                |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| **扩展直连 HTTP 免费 API**               | **采用**   | MV3 service worker 已有 `<all_urls>`；只装插件即可用，零标签页                                      |
| 后台标签页驱动免费网页聊天               | **已删除** | 用户明确要求不打开任何标签页；且依赖网页 UI，站点改版即失效                                         |
| 私有网页接口 + 会话 token + PoW/Sentinel | **否决**   | 后台读不到页面 localStorage token；反机器人 token 只能由页面 JS 生成；重写/绕过不稳定且违反服务条款 |
| 自托管转发代理（WebAI2API 等）           | 否决       | 需要常驻 Node/Camoufox 进程；只装插件的用户跑不起来                                                 |
| 第三方公共免费中转                       | 否决       | 可用性、隐私、ToS 不可控；提示词会经过不受信任的第三方                                              |
| iframe 嵌入网页聊天                      | 否决       | 站点用 `X-Frame-Options` / CSP 拦截；跨源 iframe 也无法可靠读取                                     |

### 2.2 本机实测证据（2026-11-01）

| 项目                                                        | 结果                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST https://text.pollinations.ai/openai/chat/completions` | **200**，无需 key；空 `Authorization` 也可                                      |
| Pollinations SSE                                            | 标准 `chat.completion.chunk`；`stream_options.include_usage` 被接受并返回 usage |
| Pollinations 工具调用                                       | 正常返回增量 `tool_calls`（index/id/name/arguments）                            |
| `GET https://text.pollinations.ai/openai/models`            | `{object:"list",data:[{id:"openai-fast"}]}`，与 `listModels` 期望一致           |
| 匿名档当前模型                                              | `openai-fast`（别名 `openai`，GPT-OSS 20B，tools:true，无视觉）                 |
| OpenRouter `/models`                                        | 公开可读；当前 14 个 `:free` 模型，多数支持 tools；目录会轮换                   |
| Groq / Cerebras / SambaNova / Chutes                        | 域名可达（无 key 返回 401/403/公开列表），本机无法做真实补全                    |
| Gemini / Mistral / HF Router                                | 本机 egress 超时，**无法实测**                                                  |
| `models.github.ai`                                          | 本机为 captive-portal 假 200 `text/plain OK`，**不可用**                        |

### 2.3 免密钥判定

按 **host 精确匹配**（`isKeylessEndpoint`），不持久化 `keyless` 布尔：

- 旧数据、降级、手改 baseUrl 都能正确工作；
- 防止 lookalike 域名（`text.pollinations.ai.evil.com`）误丢认证头。

## 3. 设计

### 3.1 Provider 数据模型

`ProviderPreset` 新增：`free`（`direct` / `quota`）、`keyless`、`tools`、`hintKey`。
`ProviderProfile` 不再有 `transport` 字段——所有 provider 都走 HTTP。

新增 helper（`src/lib/providers.ts`）：

- `isKeylessEndpoint(baseUrl)`：`text.pollinations.ai` 精确 host；
- `providerNeedsKey` / `providerHasCredentials`；
- `freeAccessOf(profile, model)`：返回 `'direct'` / `'quota'` / `undefined`，驱动聊天模型下拉的标签；
- `findPresetByBaseUrl`：卡片徽标与自定义编辑后仍能识别。

`validateProfile` 对免密钥端点跳过 API key 校验。
`profileFromPreset` 只对 `keyless` preset 预填唯一合理模型；其余 preset 保持“不预填”的契约。

**默认启用**：`DEFAULT_SETTINGS` 与 `ensureSchema` 的 v8 迁移会在没有任何 provider 时种入并
激活 Pollinations；显式 `providers: []` 不会被每次读取重新加回，用户第一次添加自己的 provider
时会接管 active。

### 3.2 传输

- `src/lib/llm.ts` 保持纯 HTTP，Runner 继续复用。
- `src/background/model-transport.ts` 的 `streamModel(profile, call, handlers)` 只负责把
  profile 的 key / baseUrl / model / headers 映射进 `streamCompletion`，不再有 web 分支。
- 扩展侧的 agent、audit/goal-check、operator-advise、ai-prompt、node-fix、workflow-review、
  context-compaction 都走这一个入口。
- 7 处凭据守卫统一用 `providerHasCredentials`，免密钥 Pollinations 不会被误判为“未配置”。

### 3.3 迁移（v9）

旧设置里可能还存着 `transport: 'web'` 或 `presetId: 'deepseek-web' / 'chatgpt-web'` 的 profile。
`normalizeStoredSettings` / `normalizeSettingsPayload` 会按 `isRemovedWebProvider` 过滤掉它们：

- active 指向被删 profile 时，自动回退到第一个剩余 provider；
- 过滤后列表为空时，`ensureSchema` 的 v8 逻辑种入 Pollinations；
- 用户不需要手动清理旧设置。

### 3.4 UI 与 i18n

- 「免费可用」分组只放 `free === 'direct'` 的 provider（当前为 Pollinations，免密钥）。
- `free === 'quota'` 的 provider 留在「全部服务」，名称后追加 **免费额度** 标签；
  卡片上显示 `免费额度` 徽标。
- ChatTab 模型选择下拉：`direct` 显示 **Free**，`quota` 显示 **免费额度**；
  混合目录只标免费系列（OpenRouter `:free`、Together `-Free`、智谱 `glm-4-flash`），
  付费模型不标。
- 不再有「免费网页聊天」分组、网页版卡片、Test/Open/Diagnose 按钮或 ChatTab 提示。
- 所有文案均在 `src/lib/i18n.ts` 的封闭 `Messages` 中提供 en + zh-CN。

## 4. 供应商矩阵

| id                                                           | baseUrl                                                   | suggestedModel                 | 标记                        | 本机证据                        |
| ------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------ | --------------------------- | ------------------------------- |
| `pollinations`                                               | `https://text.pollinations.ai/openai`                     | `openai-fast`                  | keyless, direct, tools:true | **已实测** 200/SSE/tools/models |
| `gemini`                                                     | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash`             | quota, tools:true           | 文档值，本机不可达              |
| `cerebras`                                                   | `https://api.cerebras.ai/v1`                              | `llama-3.3-70b`                | quota, tools:true           | 未实测                          |
| `sambanova`                                                  | `https://api.sambanova.ai/v1`                             | `Meta-Llama-3.3-70B-Instruct`  | quota, tools:true           | 未实测                          |
| `chutes`                                                     | `https://llm.chutes.ai/v1`                                | `deepseek-ai/DeepSeek-V3-0324` | quota, tools:'varies'       | 未实测                          |
| `huggingface`                                                | `https://router.huggingface.co/v1`                        | `Qwen/Qwen2.5-72B-Instruct`    | quota, tools:'varies'       | 未实测（每月额度）              |
| `modelscope`                                                 | `https://api-inference.modelscope.cn/v1`                  | `Qwen/Qwen2.5-72B-Instruct`    | quota, tools:'varies'       | 未实测（免费额度）              |
| `together`                                                   | `https://api.together.xyz/v1`                             | `…-Free`                       | quota, tools:'varies'       | 未实测（免费模型）              |
| `novita`                                                     | `https://api.novita.ai/v3/openai`                         | `deepseek/deepseek-v3`         | quota, tools:'varies'       | 未实测（起始额度）              |
| `nebius`                                                     | `https://api.studio.nebius.com/v1`                        | `deepseek-ai/DeepSeek-V3`      | quota, tools:'varies'       | 未实测（起始额度）              |
| `fireworks`                                                  | `https://api.fireworks.ai/inference/v1`                   | `…/llama-v3p3-70b-instruct`    | quota, tools:'varies'       | 未实测（起始额度）              |
| `groq` / `openrouter` / `zhipu` / `mistral` / `githubmodels` | 既有                                                      | 既有                           | `quota`                     | 官方免费档位                    |

DeepSeek 官方 API 保持收费、不打免费标；免费 DeepSeek 走 Chutes / OpenRouter `:free`。
不收录 Cloudflare（account id 在 URL 里破坏纯数据 preset）、Puter.js（客户端 SDK）、
g4f（不稳定 / ToS）。

## 5. 安全与隐私

- 免费 API 的提示词会发给对应厂商；Pollinations 匿名档会把提示词发给第三方。
- 网页版私有接口已删除：不读页面 token、不实现 PoW/Sentinel、不绕过验证码。
- API key 仍只存 `chrome.storage.local`（或用户选择的磁盘文件夹），不同步、不加密。

## 6. 测试与验收

### 机检

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm server:typecheck && pnpm server:test   # providers/types/storage 与 Runner 共享
pnpm bench:debug                            # 改动涉及 workflow-engine 门控
```

单元测试（无网络）：

- `tests/providers.spec.ts`：keyless host 精确匹配、空 key 校验、prefill、hintKey 双语可解析、
  v9 迁移会过滤 web profile 并修复 active 指针。
- `tests/llm-keyless.spec.ts`：Pollinations + 空 key 不发 `Authorization`；DeepSeek 仍拒绝。
- `tests/model-transport.spec.ts`：`streamModel` 的 HTTP 委托。
- UI：免费预设分组、keyless 可选 key、免费徽标。
- `storage-activate-provider` / `settings-legacy-adopt` / `workflow-review-ai` 已适配默认 provider：
  “未配置”是显式空列表；未知 active id 回退到 `providers[0]`；目录不可读时读路径返回默认
  provider 但绝不写回。

### 人工浏览器验收

1. `pnpm build`，Chrome 加载 `dist/` unpacked。
2. Settings → Models：**没有**「免费网页聊天」分组，也没有 DeepSeek Web / ChatGPT Web 卡片。
3. 默认设置下 Pollinations 已激活 → 不填 key，Chat 提问 → 流式回复。
4. 若旧设置里有 web profile：重载后自动消失，active 回退到 Pollinations 或第一个剩余 provider。
5. 点击「添加模型服务」：免费可用分组（Pollinations / Gemini / Groq / Cerebras / SambaNova /
   Chutes / OpenRouter / GitHub Models…）仍在；不再出现网页版选项。
6. ChatTab 不再出现“后台标签页 / 网页聊天”提示。
7. 图像识别模型选择器不出现已删除的 web provider。

> Gemini / Cerebras / SambaNova / Chutes 本机 egress 不通，GitHub Models 被 sinkhole；
> 用卡片里的「测试连接」逐项确认。

## 7. 风险

- **免费目录轮换/限流**：只做徽标与提示，不硬编码“支持模型清单”；429 已有重试。
- **工具调用差异**：`tools:'varies'` 的供应商在 UI 明确警告。
- **未本机实测**：Gemini / Cerebras / SambaNova / Chutes、GitHub Models。
- **跨版本 skew**：旧版本仍会把 web profile 当 HTTP 请求而失败；更新后重载扩展，v9 会清理。

## 8. 明确不做

网页版 provider、私有网页接口 + PoW/Sentinel、后台标签页/窗口、iframe 嵌入、外部代理/中转、
第三条浏览器驱动、g4f / Puter / Cloudflare、Runner 的 web 支持、版本号 / tag / 发布流程。

## 9. 关键文件

- 数据与迁移：`src/lib/providers.ts`、`src/lib/types.ts`、`src/lib/storage.ts`、`src/lib/free-provider-default.ts`
- 传输：`src/lib/llm.ts`、`src/lib/sleep.ts`、`src/background/model-transport.ts`
- 调用点：`src/background/agent.ts`、`src/background/index.ts`、`src/background/operator-advise-engine.ts`、
  `src/background/workflow-engine/{executors,workflow-review,node-fix-engine,ai-agent-executor,ai-takeover}.ts`、
  `src/lib/workflow/ai-takeover.ts`
- UI：`src/sidepanel/ModelsTab.tsx`、`src/sidepanel/ChatTab.tsx`、`src/lib/i18n.ts`、`src/lib/messages.ts`
- 测试：`tests/{providers,llm-keyless,model-transport,settings-provider-models-ui,storage-activate-provider,settings-legacy-adopt,workflow-review-ai}.spec.*`
