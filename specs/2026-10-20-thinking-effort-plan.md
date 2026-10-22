# 落地计划 · Thinking effort in model settings

- 日期：2026-10-20
- 对应设计：`specs/2026-10-20-thinking-effort-design.md`
- 状态：**待实施**
- 范围：扩展侧（`src/`）。Runner（`server/`）不在范围内，见设计 §4。

---

## 0. 实施前必须知道的四个坑 · Read before touching code

### 坑 1：`llm.ts` 是 chrome-free 的共享层，**不能**塞面板文案

`src/lib/llm.ts` 同时被扩展与 Runner 编译（`server/tsconfig.json` 的 `include` 允许 `../src/lib/**/*.ts`）。
所以 400 的识别结果只能以**结构化 code**（`LlmError.code`）存在，本地化句子必须由 worker 侧
（`src/background/index.ts`，那里已有 `messagesFor`）拼。**不要**在 `llm.ts` 里写中文字符串。

### 坑 2：跨边界的错误只传字符串

命令通道 `handleCommand` → `sendResponse({ok:false, error: error.message})`
（`src/background/index.ts:1044-1049`）→ 面板 `sendCommand` 抛 `new Error(response.error)`
（`src/lib/messages.ts:1011-1016`）。**`LlmError.code` 到不了面板**，
所以 worker 必须把 code 转成**消息前缀**再发（沿用 `skill:nameRequired` 的既有协议）。

### 坑 3：`testConnection` 的 `max_tokens: 1` 对思考模型必然失败

思考模型的推理 token 也计入 `max_tokens`，压到 1 会得到「reasoning 超出上限」之类的报错，
和「模型不支持思考强度」长得很像——**会把用户引向错误结论**。
所以带了思考参数时不能再压 `max_tokens: 1`（见设计 §3.6）。

### 坑 4：改了 `src/background/workflow-engine/**` 就要跑 `pnpm bench:debug`

本功能要往 `node-fix-engine.ts` / `workflow-review.ts` / `executors.ts` /
`auto-repair/background-adapter.ts` 传 `thinking`，这些文件都在 `workflow-engine/**` 下，
触发 agents.md §收尾自检 ③：**必须**跑 `pnpm bench:debug` 并对比基线
（`tests/bench/baseline.json`），否则不能声称完成。

---

## 1. 实施切片 · Slices

### Step 1 — 语义层与厂商表（`src/lib/thinking.ts`，新建）

- `ThinkingLevel`、`THINKING_LEVELS`、`THINKING_PARAM_NAMES`。
- `VENDOR_THINKING`（设计 §3.3 全表）+ `resolveVendor(baseUrl)`（按 host+port，**不看 presetId**）。
- `thinkingShapeFor(baseUrl, model)`：厂商行 ＋ 按模型名匹配的 `families`（Qwen3.8、MiniMax M3/M3.1-Flash 各是一种形态）。
- `thinkingBodyFor(baseUrl, model, level)`、`thinkingLevelsFor(baseUrl, model)`、`thinkingShapeVerified(baseUrl, model)`、`thinkingParamSummary(baseUrl, model, level)`。
- `thinkingModelSupport(baseUrl, model)`：`'supported' | 'unsupported' | 'unknown'`，只含设计 §3.4 那几条已证实的静态结论。
- 测试：`tests/thinking.spec.ts` —— 每家厂商的档位集合与请求体片段、host 判定（含 `custom` 档案仍能按 host 认出厂商）、未知厂商的通用兜底、静态不支持的模型前缀。

### Step 2 — 数据契约与文案

- `src/lib/providers.ts`：`ProviderProfile.thinkingEffort?: ThinkingLevel`。
- `src/lib/storage.ts` / `normalizeSettingsPayload`：**非法值收敛为 `undefined`**（手改存储不能让面板打不开）。
- `src/lib/i18n.ts`：设计 §3.8 的 9 个键，en 与 zh-CN **同时**赋值（封闭 `Messages` 类型会机检）。

### Step 3 — 请求下发与 400 识别（`src/lib/llm.ts`）

- `StreamRequest.thinking?: ThinkingLevel`；body 装配处按需 `Object.assign`。
- `testConnection` 接受 `thinking`，且带思考参数时不再压 `max_tokens: 1`。
- `LlmError.code?: 'unsupported-thinking'`；`describeHttpFailure` 返回 `{message, code?}`，
  命中 400/422 且 detail 里有思考类参数名 → 打 code。
- 测试：`tests/llm-thinking.spec.ts` —— body 片段正确、不带时不出现该键、400 识别命中/不命中。

### Step 4 — worker：下发到各调用点 ＋ 本地化错误

- 档案驱动的调用点逐个传 `thinking: provider.thinkingEffort`（设计 §3.9 表）。
- `RepairModelConfig` 与自动修复 config 加 `thinking?: ThinkingLevel`，构造处从档案带下来。
- `provider.test` 与聊天 catch：命中 `unsupported-thinking` 时改写成本地化句子再发面板。
- 测试：`tests/…` 覆盖「档案带 thinking → 请求体含该参数」与「400 → 面板收到本地化提示」。

### Step 5 — 面板（`src/sidepanel/SettingsTab.tsx`）

- `Draft` / `toDraft` / `fromDraft` 带上 `thinkingEffort`。
- 高级块新增下拉（只列该厂商支持的档位）+ 参数提示行 + 三种提示状态。
- 档案卡片加「思考强度」一行。
- 样式走 Tailwind 语义 token（agents.md §2），文案走 i18n（§3）。

### Step 6 — 门禁

- `TZ=UTC pnpm typecheck`
- `TZ=UTC pnpm test`
- eslint + prettier **只对 `git ls-files` 里的文件**（裸 `pnpm lint` 会因为 `tmp/ci-surface` 硬失败，见项目记忆）
- `pnpm build`（改了 UI，必须）
- `pnpm bench:debug`（改了 `workflow-engine/**`，必须；对比 `tests/bench/baseline.json`）

---

## 2. 收尾自检对应 · Mapping to agents.md

| agents.md 条目    | 本次怎么满足                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| §1 英文提交       | 提交信息用英文 Conventional Commits                                                                         |
| §2 Tailwind       | 面板新增样式只用既有语义 token 类，不写 hex                                                                 |
| §3 双语文案       | 9 个新键 en + zh-CN 同时赋值，靠封闭 `Messages` 类型机检                                                    |
| §5 复用           | 厂商表只存在于 `src/lib/thinking.ts`；参数名清单不抄第二份；档位→请求体的映射只有一处                       |
| §5.7 跨端逻辑     | 新文件放 `src/lib/**`（chrome-free），Runner 侧不消费也不破坏编译                                           |
| §7 方案先行       | 设计 + 计划已落 `specs/2026-10-20-thinking-effort-design.md` / `-plan.md`，「选型与证据」含逐家官方文档链接 |
| 收尾 ①/②/③        | 见 Step 6；③ 强制 `pnpm bench:debug`                                                                        |
| 收尾 ⑤ 浏览器证据 | 手工验证步骤见下                                                                                            |

---

## 3. 手工验证（扩展侧）· Manual verification

1. `pnpm build` 后加载 unpacked 扩展，打开侧栏 → 设置 → 模型设置 → 编辑任一供应商。
2. 选 DeepSeek 预置，模型填 `deepseek-reasoner`，思考强度选「高」→ 保存 → 聊天发一句话，
   观察请求体（开发者工具）含 `thinking: {type:'enabled', reasoning_effort:'high'}`。
3. 同一家，模型填 `deepseek-chat` → 面板应提示「模型 deepseek-chat 不支持思考强度，保存的配置不会生效」，
   且聊天请求体**不含** `thinking`。
4. OpenAI 预置 + `gpt-4o-mini` + 思考强度「高」→ 点「连接测试」→ 期望看到本地化提示
   「模型不支持思考强度配置…」，而不是英文 API 原文。
5. 把思考强度改回「使用默认」→ 再次测试 → 请求体不含任何思考参数。

拿不到上述证据就如实标 BLOCKED，不许用「脚本绿了」代替。
