# 算子助手：思考强度为什么看不见 · Editor assistant — thinking level and visible reasoning

- 日期 / Date: 2026-10-23
- 关联 / Related: `specs/2026-10-20-thinking-effort-design.md`（思考强度本体）、
  `specs/2026-10-22-operator-assistant-thinking-output-vocabulary-and-pending-picks-design.md`（助手输出可见性）
- 范围 / Scope: `src/background/operator-advise-engine.ts`、`src/lib/workflow/operator-advise.ts`、
  `src/workflow-editor/ai/OperatorChatDock.tsx`、`src/workflow-editor/i18n.ts`

## 1. 原始诉求（dcc 原话）

「思考强度为什么没有应用到 工作流编辑中的AI助手上面」

## 2. 取证（读代码 + 探针测试）

### 2.1 参数其实**下发**了

- 编辑器助手的模型调用是 `defaultCallModel`（`operator-advise-engine.ts`），它读**活跃供应商**档案，
  并把 `provider.thinkingEffort` 作为 `thinking` 传给 `streamCompletion`；`src/lib/llm.ts` 的装配点用
  `thinkingBodyFor(baseUrl, model, level)` 把它翻成厂商参数。
- `workflows.operatorAdvise`（`src/background/index.ts`）**没有**注入 `callModel`，走的就是上面这条默认路径。
- 探针（`tests/operator-advise-thinking.spec.ts`，stub `fetch` 与 `chrome.storage`）：
  DashScope + `qwen3-max` + `high` ⇒ 请求体带 `enable_thinking:true, thinking_budget:32768`；
  OpenAI + `gpt-4o-mini` ⇒ 一个思考参数都没有（模型被文档点名不支持）。

**结论一：思考强度对助手是生效的，参数在请求里。**

### 2.2 真正的问题是「看不见」，而且「不生效」有两种静默形态

1. **思考内容只在请求进行中显示。** `workflows.operatorAdviseEvent` 广播带 `channel:'reasoning'` 的增量，
   助手面板（`OperatorChatDock.tsx`）把它渲染在 `busy` 的那块气泡里；请求一结束 `setStream(null)`，
   落地的这一轮**只留 `raw`（模型原文的 text 部分）**。侧边栏聊天是有完整思考块体系的
   （`ChatTab.tsx` 的 live reasoning entry），编辑器没有——所以同一档思考强度，面板里看得到，
   编辑器里看不到，表现为「没应用」。
2. **档位在模型表达不了时被静默丢弃。** `thinkingBodyFor` 在「模型被文档点名不支持」
   （`deepseek-chat` / `gpt-4o*` / `MiniMax-M2*`）或「该档位厂商表达不了」（MiniMax M3 只有 off）时
   返回 `undefined`，请求体一个参数都不带。面板在**供应商弹窗里**会提示，但编辑器没有设置界面，
   用户在那里看不到任何说明。

## 3. 决策

- **D1 参数不改**：助手继续用活跃供应商档案里的档位，不新增第二条 LLM 通道（§5.6）。
- **D2 思考随结果回传**：引擎在流式增量里收集 `reasoning`，随 `OperatorAdviseResult` 一起返回
  （新增 `reasoning` 字段）；落地的那一轮把它收在折叠块里（`operatorAiReasoning`）。
  实时增量仍然照旧——飞行中看实时，落地后看折叠块。
- **D3 静默丢弃要出声**：引擎在解析活跃供应商时用同一个 `thinkingBodyFor` 判定档位能否下发；
  不能下发时把模型名放进结果（`thinkingSkippedModel`），编辑器显示一行提示
  （`operatorAiThinkingSkipped`）。这补的是 `specs/2026-10-20-thinking-effort-design.md` §3.7
  里「不支持时提示用户」在编辑器这一侧的缺口——编辑器没有设置界面，只能在这里说。

## 4. 改动清单

| 文件                              | 改动                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| `operator-advise-engine.ts`       | 收集 reasoning 增量；解析活跃供应商；判定档位能否下发            |
| `lib/workflow/operator-advise.ts` | `OperatorAdviseResult` 增加 `reasoning` / `thinkingSkippedModel` |
| `ai/OperatorChatDock.tsx`         | 落地轮保留思考（折叠块）；显示未下发提示                         |
| `workflow-editor/i18n.ts`         | `operatorAiReasoning`、`operatorAiThinkingSkipped`（en + zh-CN） |

## 5. 验收

- `tests/operator-advise-thinking.spec.ts`：档位下发、不支持时不下发、思考被保留、
  未下发时被点名、没有档位时不点名。
- `tests/acceptance-operator-chat-dock.spec.tsx`：落地后思考仍在折叠块里；未下发提示出现。
- 机检：`pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm format:check` / `pnpm build`。
- 浏览器实证：**未做**（本轮只有离线门禁与组件测试证据）。
