# 思考强度配置 · Thinking effort in model settings — design

日期 / Date: 2026-10-20
关联 / Related: `specs/2026-10-20-thinking-effort-plan.md`

## 1. 需求原文 · Requested behaviour

- 「这个项目的模型设置中 增加思考强度配置 如果模型不支持配置 需要提示用户」

拆成两条可验收的行为：

1. **可配**：在「模型设置」= 供应商档案编辑器（`src/sidepanel/SettingsTab.tsx`）里，能为某个供应商选一个思考强度；该选择随该档案一起保存，并对该档案发起的所有模型请求生效。
2. **不支持时提示**：当所选模型不支持思考强度时，用户必须看到明确提示——不是等请求静默失败，也不是只丢一句英文 API 报错。

## 2. 现状取证 · Evidence about the current code

### 2.1 「模型设置」在哪、它能改什么

- 供应商档案是唯一的模型配置载体：`ProviderProfile`（`src/lib/providers.ts:23-43`）只有 `id/label/presetId/baseUrl/apiKey/model/headers?/temperature?/maxTokens?`。
- 档案是**整对象替换**落盘的：`saveProvider`（`src/lib/storage.ts:460-473`）按 id 覆盖整个 profile，`normalizeStoredSettings`（`:188-191`）只过滤 `id` 是否为字符串，**不重建字段**。所以新增一个可选字段不需要改持久化白名单，也不会被旧版本读丢。
- `temperature` / `maxTokens` 的编辑面在供应商弹窗的「高级」折叠块（`src/sidepanel/SettingsTab.tsx:1275-1308`），表单态是 `Draft`（`:45-61`），转换在 `toDraft` / `fromDraft`（`:51-109`）。
- 「连接测试」按钮（`runTest`，`:758-773`）→ `provider.test` 命令（`src/background/index.ts:1309-1321`）→ `testConnection`（`src/lib/llm.ts:785-814`）。这条链路**今天不发送 temperature/maxTokens**，只发 `model/messages/max_tokens:1/stream:false`。

### 2.2 请求体只有一个装配点

- 全部 12 个 `streamCompletion` 调用点最终都汇到 `src/lib/llm.ts:649-660` 的 body 装配：
  ```ts
  const body = { model, messages, stream: true, stream_options: { include_usage: true } }
  if (request.tools?.length) body.tools = request.tools
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens
  ```
  参数**缺省即不下发**，让厂商自己的默认值生效——这是本项目既有的约定，新参数必须沿用。
- 现有 reasoning 相关能力只有**输出侧**：`TokenUsage.reasoningTokens`（`llm.ts:268`）、`StreamResult.reasoning`（`:276`）、`reasoning_content` 的 SSE 解析（`:495-502`）。**输入侧**（让模型多想一会儿）今天完全没有。

### 2.3 错误怎么回到用户面前

- 命令通道：`handleCommand` 抛错 → `sendResponse({ok:false, error: error.message})`（`src/background/index.ts:1044-1049`）→ 面板 `sendCommand` 抛 `new Error(response.error)`（`src/lib/messages.ts:1011-1016`）。**跨边界传的是字符串**，所以结构化错误码必须编码进字符串。
- 已有先例：`skill:nameRequired,nameTaken`（`src/background/index.ts:1252` 抛 → `src/sidepanel/SkillsTab.tsx:111-124` 面板本地化）。本设计沿用同一协议。
- 聊天通道：`src/background/index.ts:3511-3518` 把 `error.message` 原样 `sendWithTracking({type:'error'})`。
- 后台**本来就能本地化**：`messagesFor(effectiveLocale(settings.locale, navigator.language))`（`src/background/index.ts:523-524`、`src/background/agent.ts:4891`、`task-runner.ts:13`、`window-policy.ts:35`）。
- `describeHttpFailure`（`src/lib/llm.ts:823-855`）目前只按状态码给一句英文通用句，**不认识**「厂商说这个参数不支持」这种 400。

### 2.4 各厂商思考强度的参数形态（一手文档核实）

> 取证方式：逐个抓厂商官方文档原文（agents.md §7.2「文档转述不可信，以实测为准」）。子代理转述的 DeepSeek 结论**是错的**（说成顶层扁平 `reasoning_effort`），已由本文档作者亲自复核并更正。

| 厂商               | 形态                                                                                                                               | 取值                                                                                                                                                                                                                                                                                                                                                                                                   | 一手来源                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| OpenAI             | 顶层扁平 `reasoning_effort`（Chat Completions）；Responses API 是嵌套 `reasoning.effort`                                           | `none/minimal/low/medium/high/xhigh/max`（每模型子集）；不支持的取值 → HTTP 400                                                                                                                                                                                                                                                                                                                        | <https://developers.openai.com/api/docs/guides/reasoning>                                                                 |
| OpenRouter         | 嵌套 `reasoning: { effort }`；**没有**文档化的顶层 `reasoning_effort`                                                              | `none/minimal/low/medium/high/xhigh/max`；`none` 关闭推理；`effort` 与 `max_tokens` 不可并用                                                                                                                                                                                                                                                                                                           | <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>                                                       |
| DeepSeek           | 嵌套 `thinking: { type: "enabled"\|"disabled", reasoning_effort }`                                                                 | `none/low/high/max`（`minimal`→low，`medium`/`xhigh`→high）；`none` 即关闭思考                                                                                                                                                                                                                                                                                                                         | <https://api-docs.deepseek.com/api/create-chat-completion>                                                                |
| 火山方舟 Ark       | `thinking: { type: "enabled"\|"disabled"\|"auto" }` ＋ `reasoning.effort`                                                          | effort 取值随模型不同：豆包 Seed 2.x 支持 `minimal/low/medium/high`；`glm-5-2` 支持 `none/minimal/high/max`；不支持的取值 → `400 InvalidParameter`                                                                                                                                                                                                                                                     | <https://docs.volcengine.com/docs/82379/2662855>、<https://docs.volcengine.com/docs/82379/1956279>                        |
| 阿里百炼 DashScope | 顶层 `enable_thinking`(bool) ＋ `thinking_budget`(int, 1–32768)，**不在** `parameters` 里；**Qwen3.8 系列另认 `reasoning_effort`** | `enable_thinking:false` 关思考；`thinking_budget` 取值 1–32768（默认=模型最大思维链长度）。Qwen3.8（`qwen3.8-max`/`qwen3.8-max-0902`/`qwen3.8-flash`）的 `reasoning_effort` 取 `low/medium/xhigh`（默认 `xhigh`；`none`→`enable_thinking=False`；`max`/`high`→`xhigh`，`minimal`→`low`），且 **`thinking_budget` 与 `reasoning_effort` 不能同时下发**；换算 `low`=4096、`medium`=16384、`xhigh`=262144 | <https://help.aliyun.com/zh/model-studio/deep-thinking>、<https://help.aliyun.com/zh/model-studio/qwen-api-via-dashscope> |
| 智谱 GLM           | `thinking: { type: "enabled"\|"disabled" }`（GLM-5.3 / 5.3-FLASH 强制思考，不可关）                                                | 文档**未**给出 effort 档位                                                                                                                                                                                                                                                                                                                                                                             | <https://docs.z.ai/guides/capabilities/thinking-mode>                                                                     |
| Kimi               | 顶层 `reasoning_effort`（K3 明确）                                                                                                 | K3：`low/high/max`（默认 `max`）；K2 文档未给 effort 字段                                                                                                                                                                                                                                                                                                                                              | <https://platform.kimi.com/docs/guide/thinking>                                                                           |
| MiniMax            | 顶层 `reasoning_effort`（**仅 M3.1-Flash 生效**）＋ `thinking: { type }`                                                           | `thinking.type` 只接受 `disabled`/`adaptive`（**`enabled` 非法**）；省略即默认开启思考。`reasoning_effort` 取 `low/medium/high/xhigh/max`（默认 `max`，`none` 非法 → 400），**仅 `MiniMax-M3.1-Flash` 生效**；M3.1-Flash 强制思考（`disabled` → 400），M3 可关，M2.x 恒思考（关不掉、也接任何档位）                                                                                                    | <https://platform.minimax.cn/docs/api-reference/text-openai-api>                                                          |
| SiliconFlow        | `enable_thinking` ＋ `thinking_budget`(128–32768) ＋ `reasoning_effort`                                                            | effort 仅 `high`/`max`（low/medium 兼容映射到 high，xhigh→max）                                                                                                                                                                                                                                                                                                                                        | <https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions>                                          |
| Groq               | 顶层 `reasoning_effort`                                                                                                            | `low/medium/high`；仅 `openai/gpt-oss-20b`、`openai/gpt-oss-120b`                                                                                                                                                                                                                                                                                                                                      | <https://console.groq.com/docs/openai>                                                                                    |
| xAI                | 顶层 `reasoning_effort`（Responses API 是嵌套 `reasoning.effort`）                                                                 | `low/medium/high`（默认 high），`grok-4.6+` 支持 `xhigh`；**不可关闭推理**                                                                                                                                                                                                                                                                                                                             | <https://docs.x.ai/docs/guides/reasoning>                                                                                 |
| Ollama             | `/api/chat` 的 `think`(bool/string/null)；`/v1/chat/completions` 未在文档中确认                                                    | 字符串档位由模型定义（须与 `/api/show` 一致）                                                                                                                                                                                                                                                                                                                                                          | <https://docs.ollama.com/api/chat>                                                                                        |

**这张表说明三件事：**

1. **没有统一参数名**：扁平 `reasoning_effort`（OpenAI/Groq/xAI/Kimi/MiniMax）、嵌套 `reasoning.effort`（OpenRouter）、嵌套 `thinking.*`（DeepSeek/Ark）、布尔+预算（DashScope/SiliconFlow）、`thinking.type`（GLM）——五种形态。
2. **档位词表不统一**：DeepSeek 没有 `medium`，Kimi 只有 `low/high/max`，GLM 完全没有档位，xAI 不能关闭。
3. **同一个厂商的不同模型也不一样**：Ark 的豆包 Seed 与 `glm-5-2` 档位不同；DeepSeek 的 `deepseek-chat` 不支持思考而 `deepseek-reasoner` 总是思考；OpenAI 只有 o 系列与 gpt-5 支持 `reasoning_effort`，给 `gpt-4o-mini` 发会 400；**Qwen3.8 用 `reasoning_effort` 而老 Qwen3 用 `thinking_budget`（两者不可并用）**；**MiniMax 的档位只有 M3.1-Flash 接，M3 只能开关，M2.x 恒思考**。

结论：**厂商级静态表只能覆盖参数形态，模型级是否支持必须靠运行时 400 兜底**，而模型级已知的少数情况可以静态点名（见 §3.4）。

> **2026-10-22 补充（千问 / MiniMax 复核）**：上面两条「同厂商不同模型」的差异在 2026-10-22 重新抓取官方文档复核后确认成立，因此 §3.2 的厂商表从「一厂商一行」升级为「一厂商一行 ＋ 若干按模型名匹配的子形态」——厂商级形态表只描述参数形态，**档位与请求体片段必须按模型取**，否则会对 MiniMax M3.1-Flash 发 `thinking.type=disabled`（400）或对 Qwen3.8 发它不认的 `thinking_budget`。

### 2.5 MiniMax 实测（2026-10-27，真实 API）

> 端点 `https://api.minimaxi.com/v1`（用户自己配置的 key），模型 `MiniMax-M3.1-Flash` / `MiniMax-M3` / `MiniMax-M2.5`，
> 问题用「球棒与球共 1.10，球棒贵 1.00，球多少钱」。以下都是**实测返回**，不是文档转述。

| 模型       | 发的参数                             | HTTP    | 思考量（`usage.completion_tokens_details.reasoning_tokens`）                                  |
| ---------- | ------------------------------------ | ------- | --------------------------------------------------------------------------------------------- |
| M3.1-Flash | 无                                   | 200     | 82 / 124 / 85                                                                                 |
| M3.1-Flash | `reasoning_effort:"low"`             | 200     | 56 / 54 / 65                                                                                  |
| M3.1-Flash | `reasoning_effort:"medium"`          | 200     | 50 / 86 / 59                                                                                  |
| M3.1-Flash | `reasoning_effort:"xhigh"`           | 200     | 82 / 58 / 62                                                                                  |
| M3.1-Flash | `reasoning_effort:"none"`            | **400** | `model "MiniMax-M3.1-Flash" requires adaptive thinking; reasoning effort none is not allowed` |
| M3.1-Flash | `thinking:{type:"disabled"}`         | **400** | `thinking.type="disabled" … is not allowed`                                                   |
| M3         | 无                                   | 200     | 思考写在 **content 的 `<think>` 块**里（`reasoning_content` 为空）                            |
| M3         | `thinking:{type:"disabled"}`         | 200     | **没有 `<think>` 块了** ⇒ 关闭思考真的生效                                                    |
| M3         | `reasoning_effort:"high"`            | 200     | 仍然思考 ⇒ 该参数被接受但无效                                                                 |
| M2.5       | `reasoning_effort` / `thinking.type` | 200     | 仍然思考 ⇒ 两者都被接受但无效（M2 恒思考）                                                    |

三条结论：

1. **M3.1 的档位"被接受但不明显改变思考量"**——多轮采样里 `low/medium/xhigh` 与不发的区间完全重叠
   （换一道更费思考的题再测三轮：low 209/159/187，xhigh 201/343/182，不发 223/158/470）。
   M3.1-Flash 是 **adaptive thinking**，思考长度由模型自己决定；`reasoning_effort` 不像 OpenAI 那样
   是硬档位。因此面板的档位对 M3.1 只是"请求被接受"，不是"多想/少想"的保证。
2. **M3 的 "off" 是唯一可验证生效的 MiniMax 思考设置**：`thinking.type=disabled` 真的让 `<think>` 块消失。
3. **"off" 对 M3.1 是 400**（两种写法都 400），所以档位表必须**按模型**给：M3.1 不给 off，M3 只给 off。

> **国际端点的漏洞（2026-10-27 修）**：`thinkingVendorOf` 原本只认 `.minimaxi.com` / `.minimax.cn` /
> `.minimax.chat`，**不认 `.minimax.io`**——而项目自己的 MiniMax 预设就列着"国际 `https://api.minimax.io/v1`"。
> 落在国际端点的用户会被判成 `unknown` 厂商，于是面板给出全部四档、且 "off" 会被翻成通用的
> `reasoning_effort:'none'`——按上表，这正是 M3.1 必 400 的那个值。现已把 `.minimax.io` 并入 minimax 厂商判定。

## 3. 设计 · Design

### 3.1 供应商中立的语义层

用户不该知道 `reasoning_effort` 还是 `thinking_budget`。面板只给四个档位：

| 语义档位 | 含义     |
| -------- | -------- |
| `off`    | 关闭思考 |
| `low`    | 少想     |
| `medium` | 中等     |
| `high`   | 多想     |

外加「**使用默认**」= 档案里不存这个字段，请求体**完全不下发**该参数，让厂商自己的默认生效（沿用 §2.2 里 temperature/maxTokens 的既有约定）。

### 3.2 厂商形态表（数据，不是分支代码）

新文件 `src/lib/thinking.ts`（chrome-free 纯逻辑，Runner 侧也编译得到）持有：

- `ThinkingLevel = 'off' | 'low' | 'medium' | 'high'`
- `THINKING_LEVELS` 顺序数组
- `VENDOR_THINKING`：厂商 → 形态描述
  ```ts
  interface VendorThinking {
    /** 该厂商能表达的语义档位（不含"使用默认"）。 */
    levels: ThinkingLevel[]
    /** 语义档位 → 请求体片段。 */
    body: Record<ThinkingLevel, Record<string, unknown>>
    /** 形态是否有官方文档背书；false 表示"通用兜底，未验证"。 */
    verified: boolean
    /** 只对部分模型生效的子形态；按模型名匹配，第一个命中的生效。 */
    families?: ThinkingFamily[]
  }
  interface ThinkingFamily {
    /** 匹配这些模型的形态。 */
    models: RegExp[]
    levels: ThinkingLevel[]
    body: Record<ThinkingLevel, Record<string, unknown>>
    verified: boolean
  }
  ```
  用「档位 → 请求体片段」而不是「档位 → 厂商值 + 参数名」，是因为 `off` 在多数厂商要用**另一个**参数表达（`reasoning_effort:'none'` vs `thinking.type:'disabled'`），单一「参数名 + 值」的模型表达不了。
- `resolveVendor(baseUrl)`：**按 baseUrl 的 host(+port) 判定厂商，不看 `presetId`**。理由：`presetId` 在用户改过 base URL 后会变成 `custom`（`SettingsTab.tsx:1192-1193`），而厂商其实没变；host 才是稳定信号。
- `thinkingShapeFor(baseUrl, model)`：先按厂商取形态，再用**模型名**在该厂商的 `families` 里匹配子形态；都没有就用厂商自身那一行。
- `thinkingBodyFor(baseUrl, model, level)`：返回请求体片段或 `undefined`。
- `thinkingLevelsFor(baseUrl, model)` / `thinkingShapeVerified(baseUrl, model)` / `thinkingParamSummary(baseUrl, model, level)`：**都带模型**，因为档位与片段是模型级的。
- `thinkingModelSupport(baseUrl, model)`：模型级静态判定（§3.4）。命中「不支持」时，档位列表为空——面板不再给一个注定 400 的选项。

### 3.3 厂商 → 语义档位映射（表即文档）

| 厂商                                   | 识别 host                             | 形态                                   | off                              | low                                           | medium                                     | high                                       |
| -------------------------------------- | ------------------------------------- | -------------------------------------- | -------------------------------- | --------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| OpenAI                                 | `api.openai.com`                      | 扁平 `reasoning_effort`                | `none`                           | `low`                                         | `medium`                                   | `high`                                     |
| OpenRouter                             | `openrouter.ai`                       | 嵌套 `reasoning.effort`                | `none`                           | `low`                                         | `medium`                                   | `high`                                     |
| DeepSeek                               | `api.deepseek.com`                    | 嵌套 `thinking`                        | `{type:'disabled'}`              | `{type:'enabled',reasoning_effort:'low'}`     | `{type:'enabled',reasoning_effort:'high'}` | `{type:'enabled',reasoning_effort:'high'}` |
| Ark                                    | `*.volces.com`                        | `thinking.type` ＋ `reasoning.effort`  | `{thinking:{type:'disabled'}}`   | `{reasoning:{effort:'low'}}`                  | `{reasoning:{effort:'medium'}}`            | `{reasoning:{effort:'high'}}`              |
| DashScope（老 Qwen3）                  | `dashscope*.aliyuncs.com`             | `enable_thinking` ＋ `thinking_budget` | `{enable_thinking:false}`        | `{enable_thinking:true,thinking_budget:1024}` | `{…,thinking_budget:8192}`                 | `{…,thinking_budget:32768}`                |
| DashScope（Qwen3.8 系列）              | 同上，模型名 `qwen3.8*`               | `reasoning_effort`（不与 budget 并用） | `{enable_thinking:false}`        | `low`                                         | `medium`                                   | `xhigh`                                    |
| GLM                                    | `open.bigmodel.cn` / `api.z.ai`       | `thinking.type`                        | `{type:'disabled'}`              | —                                             | —                                          | `{type:'enabled'}`                         |
| Kimi                                   | `api.moonshot.cn` / `api.kimi.com`    | 扁平 `reasoning_effort`                | —                                | `low`                                         | `high`                                     | `max`                                      |
| MiniMax M3.1-Flash                     | `api.minimaxi.com` / `api.minimax.cn` | 扁平 `reasoning_effort`（仅此模型）    | —（强制思考，`disabled` 会 400） | `low`                                         | `medium`                                   | `xhigh`                                    |
| MiniMax M3                             | 同上，模型名 `MiniMax-M3`             | `thinking.type`                        | `{thinking:{type:'disabled'}}`   | —                                             | —                                          | —                                          |
| MiniMax M2.x                           | 同上，模型名 `MiniMax-M2*`            | —（恒思考，接任何参数都无意义）        | —                                | —                                             | —                                          | —                                          |
| SiliconFlow                            | `api.siliconflow.cn`                  | `enable_thinking` ＋ `thinking_budget` | `{enable_thinking:false}`        | `{enable_thinking:true,thinking_budget:1024}` | `{…,thinking_budget:4096}`                 | `{…,thinking_budget:16384}`                |
| Groq                                   | `api.groq.com`                        | 扁平 `reasoning_effort`                | —                                | `low`                                         | `medium`                                   | `high`                                     |
| xAI                                    | `api.x.ai`                            | 扁平 `reasoning_effort`                | —                                | `low`                                         | `medium`                                   | `high`                                     |
| 其它（含 Ollama / LM Studio / 自定义） | —                                     | 通用扁平 `reasoning_effort`            | `none`                           | `low`                                         | `medium`                                   | `high`                                     |

「—」表示该厂商（或该模型）表达不了这个语义档位：面板**不显示**该档位，而不是显示一个会被降级的假选项。降级只发生在厂商自己缺档位但语义可近似时（DeepSeek 的 `medium`→`high`、Kimi 的 `medium`→`high`），并且厂商文档本身就这么写（DeepSeek 明确 `medium`/`xhigh` 归一为 `high`）。

MiniMax M3.1-Flash 的 `high`→`xhigh` 也算这一类降级：它的 `max` 是**默认档**（`reasoning_effort` 默认 `max`），发 `max` 等于没发，所以「最多想」落在 `xhigh`——这是唯一一个真正改变默认行为的档位。

> 实测修正（§2.5）：M3.1-Flash 是 **adaptive thinking**，`reasoning_effort` 被接受但不控制思考长度
> （多轮采样里三档的思考量区间完全重叠）。所以 M3.1 的档位语义是"请求被厂商接受"，
> 不是"多想/少想"的保证；真正可验证生效的 MiniMax 思考设置是 M3 的 `off`（`thinking.type=disabled`）。

Qwen3.8 的换算方向相反但结论一样：它把 `thinking_budget` 的三段区间（0–4096 / 4097–16384 / 16385–262144）命名为 `low/medium/xhigh`，所以直接发档位名即可，不必自己折算预算。

「其它」一档标记 `verified:false`：面板会提示「该端点无厂商信息，无法确认模型是否支持」，由运行时 400 兜底。

### 3.4 「模型不支持」的判定：静态点名 ＋ 运行时兜底

**静态（模型级）**——只写文档明确说过的，宁缺毋滥：

| 厂商     | 模型前缀                                      | 依据                                                              |
| -------- | --------------------------------------------- | ----------------------------------------------------------------- |
| OpenAI   | `gpt-4o`、`gpt-4.1`、`gpt-4-turbo`、`gpt-3.5` | 官方 reasoning 文档只列 o 系列与 gpt-5 支持 `reasoning_effort`    |
| DeepSeek | `deepseek-chat`                               | 官方：只有 `deepseek-reasoner` 是思考模型，`deepseek-chat` 不支持 |
| MiniMax  | `MiniMax-M2*`                                 | 官方：M2 系列恒思考，关闭「被接受但无效果」，且不接受任何档位     |

命中静态不支持时：

- 请求体**不下发**该参数（不让每个请求都 400）；
- 面板显示提示「模型 X 不支持思考强度，保存的配置不会生效」，并且**不再提供任何档位**（给了也是 400）；
- **不静默改写用户已存的值**——换模型回来它还能用。

未命中也不等于「支持」：模型级能力表会腐烂，所以未知模型一律判 `unknown`，UI 措辞是「无法确认」而不是「支持」。

**运行时（兜底）**——厂商对不支持的参数几乎都回 400，且错误文案里带参数名。`src/lib/llm.ts` 增加：

- `LlmError.code?: 'unsupported-thinking'`；
- `describeHttpFailure` 改为返回 `{ message, code? }`：当状态码是 400/422，且厂商 detail 里出现**思考类参数名**（`reasoning_effort` / `reasoning` / `thinking` / `enable_thinking` / `thinking_budget` / `think`）或「unsupported/unknown parameter」类措辞时，标记 `unsupported-thinking`。
- 命中后：worker（`src/background/index.ts` 的 `provider.test` 与聊天 catch）把错误改写成**本地化**句子再送给面板：
  「模型不支持思考强度配置。请把思考强度改回「使用默认」或更换模型。（厂商原文：…）」

参数名清单放在 `src/lib/thinking.ts`（`THINKING_PARAM_NAMES`），`llm.ts` 引用它，**不在 llm.ts 里另抄一份**。

### 3.5 数据契约

`src/lib/providers.ts`：

```ts
export interface ProviderProfile {
  ...
  /** Thinking effort; omitted → the provider's own default applies. */
  thinkingEffort?: ThinkingLevel
}
```

- 落在 `ProviderProfile` 上（不是全局设置），因为它是**某个模型**的能力。
- 档案整对象落盘（§2.1），新增可选字段**不需要**改持久化白名单。
- `normalizeSettingsPayload`（`providers.ts:393-400`）只过滤 `id`，字段原样穿过；`normalizeStoredSettings`（`storage.ts:188-191`）同理。**要补的是「旧档案里存了非法值」时的收敛**：非法值降级为 `undefined`（使用默认），不报错——非法值来自手改存储，不该让面板打不开。

### 3.6 请求下发

`src/lib/llm.ts`：

- `StreamRequest` 新增 `thinking?: ThinkingLevel`；
- body 装配处：`const extra = thinkingBodyFor(request.baseUrl, request.thinking)`；有则 `Object.assign(body, extra)`，**没有就不下发**（沿用 temperature/maxTokens 的既有约定）。
- `testConnection` 同样接受 `thinking` 并下发——这样「连接测试」按钮才能真正验出「这个模型不支持」。

`testConnection` 现有的 `max_tokens: 1` 对思考模型是错的（推理 token 也算进 `max_tokens`，思考模型必然报「reasoning 超出上限」）。因此：**带了思考参数时不再压 `max_tokens: 1`**，改用档案里的 `maxTokens`（若用户设了），否则让厂商自己定上限。这一条是本功能能给出可信提示的前提。

### 3.7 面板

供应商弹窗「高级」块（`SettingsTab.tsx:1275-1308`）新增一栏：

- 下拉：使用默认 / 关闭 / 低 / 中 / 高——四个档位**全部列出**，但**当前模型**表达不了的档位（如 DeepSeek 没有 `medium`、MiniMax M3.1-Flash 强制思考所以没有「关闭」）置 `disabled`。这样已存盘的档位在换厂商后依然可见可辨，而不是凭空消失。
- 提示行（`hint`）：显示**将要下发的实际参数**，例如「将下发：`thinking.reasoning_effort=high`」。用户能直接核对厂商文档，也便于反馈。
- 三种状态提示：
  - 静态不支持 → 「模型 X 不支持思考强度，保存的配置不会生效」；
  - 厂商未知 → 「该端点无厂商信息，无法确认模型是否支持思考强度；若请求失败，请改回「使用默认」」；
  - 运行时 400 → 「模型不支持思考强度配置…（厂商原文）」。

档案卡片（`:1061-1080` 的 `provider-meta`）加一行「思考强度」，让用户不必开弹窗就能看到当前值。

### 3.8 文案

`src/lib/i18n.ts` 的封闭 `Messages` 接口要求 en 与 zh-CN **同时**赋值，否则 `pnpm typecheck` 直接失败（agents.md §3）。新增键（扁平 camelCase，`settings` 前缀）：

- `settingsThinkingEffort`
- `settingsThinkingEffortDefault`
- `settingsThinkingLevelOff` / `settingsThinkingLevelLow` / `settingsThinkingLevelMedium` / `settingsThinkingLevelHigh`
- `settingsThinkingParamNote`（函数式，参数 `{ param }`）
- `settingsThinkingModelUnsupported`（函数式，参数 `{ model }`）
- `settingsThinkingUnverified`
- `settingsThinkingUnsupportedError`（函数式，参数 `{ detail }`）

### 3.9 生效范围

该设置属于**档案**，因此对该档案发起的所有模型请求生效。已知的 provider 驱动调用点（`src/background`）：

| 调用点                                                      | 用途                                           |
| ----------------------------------------------------------- | ---------------------------------------------- |
| `agent.ts:5152`                                             | 聊天主路径                                     |
| `index.ts:2073` / `:2266`                                   | AI 调试审计 / 目标检查                         |
| `index.ts:2350` / `:2762`                                   | 修复提案（`RepairModelConfig`）                |
| `operator-advise-engine.ts:125`                             | 算子建议                                       |
| `workflow-engine/node-fix-engine.ts:149`                    | 节点修复                                       |
| `workflow-engine/workflow-review.ts:185`                    | 流程审查                                       |
| `workflow-engine/executors.ts:2162`                         | ai-prompt 算子                                 |
| `workflow-engine/auto-repair/background-adapter.ts:145,230` | 自动修复（config 形态，需带上档案的 thinking） |
| `workflow-generation-bridge.ts:492`                         | 流程生成                                       |

`RepairModelConfig` / 自动修复的 config 形态没有档案字段，需要加一个 `thinking?: ThinkingLevel` 由构造处（`index.ts:2350/2762`）从档案带下来。

## 4. 边界与非目标 · Non-goals

- **Runner（`server/`）不参与**：Runner 的 `LlmConfig`（`server/src/config.ts:18-23`）今天连 temperature/maxTokens 都没有，Runner 侧设置页是独立的硬编码中文界面（已知存量违例）。本次只做扩展侧。
- **不按模型名做能力推断**：除了 §3.4 那两条文档明说的，其余一律 `unknown` + 运行时兜底。模型清单会腐烂，静态表烂掉时用户会拿到一个**假的「不支持」**，比「无法确认」更糟。
- **不改 `takeover` 的温度策略**：`src/lib/workflow/ai-takeover.ts:545` 的 `TAKEOVER_TEMPERATURE` 是接管策略的一部分，与思考强度无关。
- **不做「档位 → 预算」的跨厂商统一数值**：DashScope/SiliconFlow 的 `thinking_budget` 是 token 预算，不同厂商的 token 语义不可比，所以只在本厂商内部用固定档位映射（1024 / 4096 / 16384，均在文档区间内）。
