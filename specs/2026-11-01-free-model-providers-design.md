# 免费模型接入：免费 API 预设 + DeepSeek / ChatGPT 网页版 · 设计与证据

日期：2026-11-01 · 分支：`feat/free-model-providers`

## 1. 背景与目标

用户要在插件自己的对话里免费使用模型，明确要求：

- 用 DeepSeek / ChatGPT 的免费网页聊天，但**不要让界面跳转到网页**；
- 对话留在插件面板里，后台标签只是执行引擎；
- 网页版没有 function calling，**只用于 chat / 纯文本**；
- 同时保留免费 API 供应商作为兜底。

目标拆成两条并行能力：

1. **Track A · 免费 API**：Pollinations（免密钥）+ 官方免费额度（Gemini / Groq / Cerebras / SambaNova / Chutes / OpenRouter `:free` / GitHub Models / 智谱 GLM-4-Flash）。
2. **Track B · 免费网页版**：在独立后台窗口里驱动 `chat.deepseek.com` / `chatgpt.com`，把回复流式回传到插件对话；仅 chat 与纯文本调用点。

## 2. 选型与证据

### 2.1 接入方式候选

| 候选                            | 结论                | 理由                                                                                  |
| ------------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| **扩展直连 HTTP 免费 API**      | **采用（Track A）** | MV3 service worker 已有 `<all_urls>`，请求直接发往厂商；只装插件即可用                |
| **后台标签驱动免费网页聊天**    | **采用（Track B）** | 网页聊天没有公开 API；用现有 driver/kernel 像用户一样操作 UI，对话仍留在插件          |
| 自托管转发代理（WebAI2API 等）  | 否决                | 需要常驻 Node/Camoufox 进程；只装插件的用户跑不起来（2026-10-15 已因此回退）          |
| 第三方公共免费中转              | 否决                | 可用性、隐私、ToS 不可控；提示词会经过不受信任的第三方                                |
| 私有网页接口 + 会话 token + PoW | 否决                | 需要读登录 token、解反机器人挑战；脆弱且违反服务条款。网页版一律不绕过验证码          |
| iframe 嵌入网页聊天             | 否决                | 站点通常用 `X-Frame-Options` / CSP `frame-ancestors` 拦截；跨源 iframe 也无法可靠读取 |

### 2.2 本机实测证据（2026-11-01）

| 项目                                                             | 结果                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST https://text.pollinations.ai/openai/chat/completions`      | **200**，无需 key；空 `Authorization` 也可                                      |
| Pollinations SSE                                                 | 标准 `chat.completion.chunk`；`stream_options.include_usage` 被接受并返回 usage |
| Pollinations 工具调用                                            | 正常返回增量 `tool_calls`（index/id/name/arguments）                            |
| `GET https://text.pollinations.ai/openai/models`                 | `{object:"list",data:[{id:"openai-fast"}]}`，与 `listModels` 期望一致           |
| 匿名档当前模型                                                   | `openai-fast`（别名 `openai`，GPT-OSS 20B，tools:true，无视觉）                 |
| OpenRouter `/models`                                             | 公开可读；当前 14 个 `:free` 模型，多数支持 tools；目录会轮换                   |
| Groq / Cerebras / SambaNova / Chutes                             | 域名可达（无 key 返回 401/403/公开列表），本机无法做真实补全                    |
| Gemini `generativelanguage.googleapis.com` / Mistral / HF Router | 本机 egress 超时，**无法实测**                                                  |
| `models.github.ai`                                               | 本机为 captive-portal 假 200 `text/plain OK`，**不可用**，不能作为本机验收项    |
| `resolveAutomationTab(preferredTabId)`                           | 指定 tab 优先返回（driver.ts:131），后台 tab 可定向操作                         |
| `Target.primary + fallbacks`                                     | 多候选选择器直接映射（ops.ts），`OpResult.usedSpec/found/matched` 可做诊断      |
| kernel `fill` / `get_text`                                       | contenteditable + CDP 回退；`get_text` 用 `innerText`                           |
| `advertiseTools` 在 chat 模式                                    | 返回 `[]`（agent.ts:1907），网页版走 chat 语义天然无工具                        |

### 2.3 免密钥判定

采用**按 host 精确匹配**（`isKeylessEndpoint` / `webSiteOf`），而不是持久化一个 `keyless` 布尔：

- 旧数据、降级、手改 baseUrl 都能正确工作；
- 防止 lookalike 域名（`text.pollinations.ai.evil.com`）误丢认证头；
- `transport: 'web'` 是唯一持久化的新字段，未知值归一为 HTTP。

## 3. 设计

### 3.1 Provider 数据模型

`ProviderPreset` 新增：`transport?: 'http' | 'web'`、`free`、`keyless`、`tools`、`hintKey`。
`ProviderProfile` 新增 `transport?: 'http' | 'web'`。

新增 helper（`src/lib/providers.ts`）：

- `isKeylessEndpoint(baseUrl)`：`text.pollinations.ai` 精确 host；
- `webSiteOf(baseUrl)`：`chat.deepseek.com → deepseek`、`chatgpt.com → chatgpt`；
- `providerNeedsKey` / `providerHasCredentials` / `providerCanCallTools`；
- `findPresetByBaseUrl`：卡片徽标与自定义编辑后仍能识别。

`validateProfile` 对免密钥 / 网页版跳过 API key 校验；网页版 baseUrl 必须命中已知站点。
`profileFromPreset` 对 keyless / web 预填唯一合理模型，其余 preset 保持“不预填”的契约。

**默认启用**：`DEFAULT_SETTINGS` 与 `ensureSchema` 的 v8 迁移会在没有任何 provider 时种入并
激活 Pollinations；显式 `providers: []` 不会被每次读取重新加回，用户第一次添加自己的 provider
时会接管 active。这样全新安装打开即可聊天，同时保留“删除即删除”的语义。

### 3.2 传输分层

- `src/lib/llm.ts` 保持**纯 HTTP**，Runner 继续复用它。
- 新增 `src/background/model-transport.ts` 的 `streamModel(profile, call, handlers)`：
  - `transport === 'web'` → `streamWebChat`；
  - 否则 → `streamCompletion`，凭证与 headers 从 profile 取。
- 扩展侧持有 `ProviderProfile` 的调用点改走 `streamModel`：
  agent、index（audit / goal check）、operator-advise、executors（ai-prompt）、
  node-fix、workflow-review、context-compaction summarizer。
- `repair-provider` / `auto-repair` 仍走 HTTP；`repairProviderOf` 对 web provider 返回
  `undefined`，即 v1 不把网页版交给自动修复。
- 这**不是第三条浏览器驱动**：网页版 transport 复用现有 `driver.ts` + `inpage/kernel.ts`。

### 3.3 后台窗口与站点适配

- 每个站点一个独立、不抢焦点的窗口，缓存于 `chrome.storage.session`（`bc:webChatTabs`），
  跨 turn 复用；同一站点的请求串行，避免两次发送写进同一对话。
- 新建窗口后先等 tab 的 URL 变为 http(s) 再注入；否则 driver 会看到 `chrome://newtab`
  并报“没有可操作的网页标签页”。窗口丢失/不可注入统一转成 `window-unavailable` 错误，
  提示用户打开窗口登录或切回 Pollinations / API 服务商。
- 网页版 provider 是 **opt-in**：新增它不会自动接管 active；只有显式“使用这个”才切过去。
  ChatTab 在 active 是 web provider 时显示常驻提示，说明如何切回插件内聊天。
- 站点适配器集中在 `src/background/web-chat/adapters.ts`：composer / send / newChat /
  reply / stop / login 全部是**候选数组**，转成 kernel 的 `Target` 主选择器 + fallbacks。
- 初次使用若未登录：检测 login 元素 → 把窗口置前，提示用户登录后重试；不读 token、不自动登录。
- 每次请求先点“新对话”，没有该控件就重载站点根 URL，避免上一轮上下文串味。
- 诊断（`diagnoseWebChat`）报告每个候选的 `found / matched / usedSpec`；站点改版只改适配器表。

### 3.4 提示词与流式

- `WireMessage[]` 拍平成 `[Instructions] / [User] / [Assistant]` 文本，末尾要求只回答最后一条
  用户消息；上限 16,000 字符，先裁最旧的 assistant 内容，尽量保留所有 user 轮次。
- 附件（图片/文件）v1 不支持，直接报 `WebChatAttachmentsUnsupported`，不静默丢弃。
- 发送后每 250ms 读最后一个 assistant 节点的 `innerText`，用增量回调 `onText`；
  `stop` 消失且文本 1.5s 稳定（或 3s 稳定）即结束，最长 180s。
- 返回 `StreamResult { content, reasoning:'', toolCalls:[], finishReason:'stop', usage:null }`。
  网页版不产生 token 统计。
- 取消时点站点停止按钮并抛 `AbortError`；验证码/人机校验只提示用户手动完成。

### 3.5 能力门控

| 调用点                                                                                            | web provider                              |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Chat 模式主对话                                                                                   | **允许**（无工具）                        |
| readonly / semi / full / workflow 的 agent turn                                                   | **拒绝**，明确提示切 Chat 或换 API 供应商 |
| workflow review / node fix / ai-prompt / operator advice / generation bridge / audit / compaction | **允许**（纯文本）                        |
| ai-agent-executor / ai-takeover                                                                   | **拒绝**（需要工具）                      |
| 图像识别 / vision                                                                                 | **拒绝**（无 key、无视觉）                |
| auto-repair / repair proposer                                                                     | **拒绝**（v1 配置链路仅 HTTP）            |
| Runner                                                                                            | 不适用（仅 HTTP）                         |

7 处凭据守卫统一用 `providerHasCredentials`，因此免密钥 profile 不会被误判为“未配置”。

### 3.6 UI 与 i18n

- Models 页：预设下拉分「免费可用 / 免费网页聊天 / 全部服务」三组，`custom` 最后；
  免费卡片有 `Free` / `Web · free` 徽标；keyless 显示“无需密钥”。
- 默认启用 Pollinations；免费 API 与网页版仍可从预设下拉的「免费可用 / 免费网页聊天」
  分组添加（不再提供额外的快捷按钮）。
- 网页版卡片提供 Test / Open window / Diagnose；编辑弹窗隐藏 key、模型抓取、thinking 与高级项。
- ChatTab 在“active provider 是 web 且 mode ≠ chat”时显示常驻警告。
- 所有新增文案均在 `src/lib/i18n.ts` 的封闭 `Messages` 中提供 en + zh-CN。

## 4. 供应商矩阵

| id                                                           | baseUrl                                                   | suggestedModel                 | 标记                      | 本机证据                        |
| ------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------ | ------------------------- | ------------------------------- |
| `pollinations`                                               | `https://text.pollinations.ai/openai`                     | `openai-fast`                  | keyless, free, tools:true | **已实测** 200/SSE/tools/models |
| `gemini`                                                     | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash`             | free, tools:true          | 文档值，本机不可达              |
| `cerebras`                                                   | `https://api.cerebras.ai/v1`                              | `llama-3.3-70b`                | free, tools:true          | 未实测                          |
| `sambanova`                                                  | `https://api.sambanova.ai/v1`                             | `Meta-Llama-3.3-70B-Instruct`  | free, tools:true          | 未实测                          |
| `chutes`                                                     | `https://llm.chutes.ai/v1`                                | `deepseek-ai/DeepSeek-V3-0324` | free, tools:'varies'      | 未实测                          |
| `deepseek-web`                                               | `https://chat.deepseek.com/`                              | `deepseek-web`                 | web, keyless, tools:false | 需登录人工验证                  |
| `chatgpt-web`                                                | `https://chatgpt.com/`                                    | `chatgpt-web`                  | web, keyless, tools:false | 需登录人工验证                  |
| `groq` / `openrouter` / `zhipu` / `mistral` / `githubmodels` | 既有                                                      | 既有                           | `free:true`               | 官方免费档位                    |

DeepSeek 官方 API 保持收费、不打免费标；免费 DeepSeek 走 Chutes / OpenRouter `:free`。
不收录 Cloudflare（account id 在 URL 里破坏纯数据 preset）、Puter.js（客户端 SDK）、
g4f（不稳定 / ToS）。

## 5. 安全、隐私与服务条款

- 网页版只像用户一样操作 UI：不读 cookie/localStorage、不实现 PoW、不绕过验证码。
- 提示词会进入用户自己的网页会话；免费 API（Pollinations）会把提示词发给第三方。
- 自动化网页聊天可能违反服务商条款；启用界面有双语提示，由用户自行承担。
- API key 仍只存 `chrome.storage.local`（或用户选择的磁盘文件夹），不同步、不加密。

## 6. 测试与验收

### 机检

```bash
pnpm bench:debug            # 基线 66.7%（6/9），改动前后对比
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
pnpm server:typecheck       # providers/llm 与 Runner 共享
pnpm server:test
pnpm bench:debug
```

单元测试（无网络）：

- `tests/providers.spec.ts`：keyless host 精确匹配、web 站点映射、空 key 校验、prefill、
  hintKey 双语可解析、transport 归一化。
- `tests/llm-keyless.spec.ts`：Pollinations + 空 key 不发 `Authorization`；DeepSeek 仍拒绝。
- `tests/model-transport.spec.ts`：HTTP / web 分发。
- `tests/web-chat-prompt.spec.ts`：角色拍平、附件报错、超长裁剪保留 user 轮次。
- `tests/web-chat-adapters.spec.ts`：候选顺序与 Target fallback。
- `tests/web-chat-transport.spec.ts`：登录、流式回复、超时、abort。
- UI：免费/网页版预设分组、keyless 可选 key、网页版隐藏 key 与模型抓取、卡片动作。
- `storage-activate-provider` / `settings-legacy-adopt` / `workflow-review-ai` 已适配默认 provider：
  “未配置”现在是显式空列表；未知 active id 回退到 `providers[0]`（默认 provider）；目录不可读时
  读路径返回默认 provider 但绝不写回；新增 web provider 不会自动接管 active。

### 人工浏览器验收（拿不到就标 BLOCKED）

1. `pnpm build`，Chrome 加载 `dist/` unpacked。
2. Settings → Models → “启用 DeepSeek 网页版” → 后台窗口打开 `chat.deepseek.com`，不抢焦点。
3. 未登录时在该窗口登录，插件里点“测试” → 返回模型回复。
4. 模式切 **Chat**，选 DeepSeek 网页版，在插件对话提问 → 回复流式出现在插件里。
5. 模式切 **Semi** 再提问 → 明确提示网页版不支持工具调用。
6. ChatGPT 重复 2–5。
7. “诊断” → 列出每个选择器候选的命中情况。
8. 默认设置（新安装）下 Pollinations 已激活 → 不填 key，Chat 提问 → 流式回复。
9. 图像识别模型选择器 → 不出现 web provider。

> 线上站点需要登录且可能限流，**选择器与真实回复无法离线自动化验证**；未实测项必须
> 在交付说明里标 BLOCKED，不得用“应该可以”代替。

## 7. 风险

- **选择器失效**：站点改版是最大风险；多候选 + Diagnose 是维护入口。
- **登录/验证码**：只提示用户手动完成，不绕过。
- **后台窗口**：不抢焦点但任务栏可见；被最小化/关闭会暂停，需重建。若站点在后台暂停生成，
  验收时确认，必要时置前（不做隐藏窗口的绕过）。
- **无工具调用**：网页版永远 `toolCalls: []`；非 chat 模式明确拒绝。
- **无 token 统计**：web 调用 `usage: null`，仪表盘不计费。
- **附件**：v1 不支持上传图片/文件。
- **上下文**：每轮新会话 + 拍平全文；超长截断。
- **跨版本 skew**：旧版本会把 web profile 当 HTTP 请求而失败；更新后重载扩展。
- **未本机实测**：Gemini / Cerebras / SambaNova / Chutes（egress）、GitHub Models（sinkhole）、
  DeepSeek / ChatGPT 线上选择器（需登录）。

## 8. 明确不做

外部代理/中转服务、私有网页接口 + PoW、iframe 嵌入、第三条浏览器驱动、g4f / Puter / Cloudflare、
Runner 的 web 支持、版本号 / tag / 发布流程。

## 9. 关键文件

- 数据与传输：`src/lib/providers.ts`、`src/lib/llm.ts`、`src/lib/types.ts`、`src/lib/storage.ts`、`src/lib/sleep.ts`
- 网页版：`src/background/model-transport.ts`、`src/background/web-chat/{adapters,prompt,window,transport,diagnose}.ts`
- 调用点与门控：`src/background/agent.ts`、`src/background/index.ts`、`src/background/operator-advise-engine.ts`、
  `src/background/workflow-engine/{executors,workflow-review,node-fix-engine,ai-agent-executor,ai-takeover}.ts`、
  `src/lib/workflow/ai-takeover.ts`
- UI：`src/sidepanel/ModelsTab.tsx`、`src/sidepanel/ChatTab.tsx`、`src/lib/i18n.ts`、`src/lib/messages.ts`
- 测试：`tests/{providers,llm-keyless,model-transport,web-chat-prompt,web-chat-adapters,web-chat-transport,settings-provider-models-ui}.spec.*`
