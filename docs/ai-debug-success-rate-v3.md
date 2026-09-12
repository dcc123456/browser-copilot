# AI 调试成功率提升方案 v3（度量先行 + 企业级加固）

> 目标：提高 `workflows.debug`（失败节点 AI 接管）的**真实**成功率，并把"调试成功但下次普通运行仍失败"的落差收敛掉。
> 状态：**已实施 M0（度量）+ M1 的 P0 部分**；typecheck / 全量测试 / 离线基准通过。
> 量化口径：**度量先行**——先建可复现的离线基准测出真实基线，再验证每项收益。文中收益数字均为**待基准验证的假设**。

---

## 0. 交付物

- 本文档（分析 + 方案 + 路线图）。
- **离线基准**：`tests/bench/{scenarios,harness,debug-bench.spec}.ts` + `pnpm bench:debug`（无浏览器 / 无模型 / 无网络，可进 CI）。
- **会话级遥测**：`src/lib/workflow/takeover-stats.ts` 扩展 + `workflows.debugStats` 命令 + 面板展示。
- **P0 代码修复**：见 §5。

---

## 1. 现状链路（一句话版）

`workflows.debug`（`src/background/index.ts`）给引擎挂 `aiTakeover` 钩子 → 节点失败时 `createAiTakeover`（`src/background/workflow-engine/ai-takeover.ts`）接管，最多 3 次尝试 × 25 轮工具 → `runDebugSession`（`src/background/workflow-engine/debug-session.ts`）收集修复并应用到**内存副本** → **无接管验证运行** → 仍失败则升级「复演（FULL 智能体重做）+ 图审计（产出修正图）+ 验证」→ 目标达成判定。

---

## 2. 根因（按代码事实）

| 类         | 表现                                        | 代码证据                                                                                                                            |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A 时序     | 慢页面「元素未找到」                        | 交互块轮询**默认关闭**（`executors.ts` `withWait`）；仅调试首轮强制 4s（`debug-session.ts` `withWaitFor`），**普通/定时运行不等待** |
| B 定位     | 选择器过期、目标在快照外                    | `snapshot_page` 默认 120，但 `summarizeSnapshot` **硬截断 80**，模型请求 200 也被丢弃；导航后 ref 失效无专门引导                    |
| C 环境     | 登录墙/验证码                               | 快速失败需第 1 次尝试**之后**才触发                                                                                                 |
| E 配置     | 服务端无 tab 钉定                           | `server/src/agent/takeover.ts`                                                                                                      |
| F 闭环     | 修复只落 pending；服务端解析 patch 却不应用 | `server/src/agent/takeover.ts`、`run-service.ts`                                                                                    |
| G 韧性     | 单次 5xx/网络抖动直接失败                   | `llm.ts` `streamCompletion` 无瞬时重试；两个 agent loop 均无重试                                                                    |
| H 误判     | 残缺 verdict 被当成功                       | `parseTakeoverVerdict` 的 `/"completed":\s*true/` 正则兜底                                                                          |
| I 无检查点 | 崩溃/重载需从头                             | 引擎有 `MAX_STEPS`，但无中间检查点                                                                                                  |

### 对既有「四层框架」的校准

外部提案中的部分判断与本仓库不符，已在合并时修正：

- **不存在 ~12,000 字符上限**：实际是 `compactSnapshot` 的 3000 字符文本 + **80 元素硬上限**（提案所述 12000 实为无关的 120000ms 超时）。
- **并非「单点脆弱、无多 Agent」**：链路已有复演 Agent + 图审计 + 目标判定三段协作。
- **`temperature` 已是 per-provider 可选字段**（`providers.ts`），未设时由厂商默认（常为 1.0）。

---

## 3. 外部 13 项提案的处置

| #   | 提案                       | 处置                                      | 落点                                 |
| --- | -------------------------- | ----------------------------------------- | ------------------------------------ |
| 1   | 结构化错误上下文           | **已落地**                                | `src/lib/tool-error.ts` + `agent.ts` |
| 2   | 反思机制                   | **已落地**                                | `system-prompt.ts` 规则 9            |
| 3   | 全局重试 + 逃生舱          | 待办（M2）                                | —                                    |
| 4   | 降低温度                   | **已落地（修正版）**                      | `takeoverProviderOf` 补默认 0.2      |
| 5   | 精简 DOM 快照              | 已存在；真正痛点是 80 硬上限 → **已落地** | `agent.ts` 快照上限                  |
| 6   | 性能追踪语义摘要           | 待办（M2）                                | —                                    |
| 7   | Observer 侦察 Agent        | 待办（M3，可选增强）                      | —                                    |
| 8   | Validator 验证 Agent       | 部分已存在；结构化结果待办（M2）          | —                                    |
| 9   | 可逆推理/回滚              | 待办（M4）                                | —                                    |
| 10  | 持久化执行引擎（Temporal） | **改为轻量本地检查点**（M4）              | —                                    |
| 11  | 状态检查点                 | 待办（M4）                                | —                                    |
| 12  | 自愈机制                   | 部分已存在（接管 + patch + pending）      | —                                    |
| 13  | 可观测性指标               | **已落地（会话级）**                      | `takeover-stats.ts` + 面板           |

---

## 4. M0 · 度量（已落地）

### 4.1 会话级遥测

`src/lib/workflow/takeover-stats.ts` 新增第二存储 `debugSessionStats`：

- `DebugSessionStatRecord`：`sessionId / workflowId / ok / verified / goalAchieved / judgeAvailable / rounds / attempts / durationMs / phases / failedPhase / reasonKind`。
- `summarizeDebugSessions()`：**严格成功率**（verified/total）、p50/p90 耗时、按失败原因与失败阶段的分布、各阶段平均耗时。
- 逐 episode 记录补 `phase / sessionId / durationMs`。

**冻结的指标定义**：`sessionSuccessRate = verified sessions / total`，其中 **verified = 无接管验证运行通过且目标达成**；`judgeAvailable === false` 时才退回「无报错」标准，并如实记录该标志，防止回退悄悄抬高数字。

接线：`src/background/index.ts` 的 `workflows.debug` 用 `performance.now()` 包裹会话，`finally` 中**成功与失败都记录**；按阶段计时（takeover / verify / replay / audit / rewrite-verify）。命令 `workflows.debugStats`；面板调试弹窗底部展示。

### 4.2 离线基准（CI 回归门）

`pnpm bench:debug` 驱动**真实的 `runDebugSession`**（依赖全注入），8 个场景：S1 慢页面、S2 选择器过期、S3 登录墙、S4 多窗口 scope、S5 结构性坏图、S6 瞬时 5xx、S7 残缺 verdict、S8 无 provider。

**基线结果（当前代码）**：

- 场景总数 8，已验证 5，**会话成功率 62.5%**
- 断言的不变量：登录墙**恰好 1 次**接管尝试（快速失败生效）；无 provider **0 次**尝试；**接管"完成"但无可验证修复不得计为成功**；结构性坏图必须经「复演 → 审计 → rewrite-verify」并验证通过。

> 这 62.5% 是**当前代码的真实基线**，而非目标。后续每项改造都应让同一组场景的成功率上升（且 `goalAchieved` 不下降）。

---

## 5. M1 · 已落地的 P0 修复

| 项                         | 改动                                                                                                                                                            | 文件                                                                           | 预期（待基准验证）              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| 普通运行默认等待           | 抽出共享 `applyDefaultWaits`，普通/定时/服务端运行也强制交互块等待（默认 2s，用户值优先，`settings.defaultWaitMs = 0` 可关）                                    | `debug-session.ts`、`run-workflow.ts`、`server/src/run-service.ts`、`types.ts` | 时序类失败 −20~35%              |
| LLM 瞬时重试               | `streamCompletion` 对 408/409/425/429/5xx 与网络错误重试 ≤3 次，指数退避 + 抖动，**流式 body 开始消费后不重试**，abort 感知；`LlmError` 携带 `status/transient` | `llm.ts`                                                                       | 抖动型失败 +5~15%               |
| 快照覆盖                   | `summarizeSnapshot` 的 80 硬上限改为尊重请求的 `maxElements`（硬顶 250），`elementsTruncated` 如实上报；`snapshot_page` 在调用内核前先夹取，避免超大请求        | `agent.ts`                                                                     | 定位类失败 −10~20%              |
| 结构化错误上下文（提案 1） | 工具失败（抛出或返回 `ok:false`）都附加 `errorType / suggestedRecovery / previousAttempts / pageStateSummary`                                                   | 新增 `lib/tool-error.ts`、`agent.ts`                                           | 重试循环 −25~40%                |
| 陈旧 ref 引导（提案 5）    | 未知 ref 的报错区分"页面已导航"与"ref 过期"，明确要求重新 snapshot                                                                                              | `agent.ts`                                                                     | 定位类 −5~10%                   |
| verdict 解析收紧（提案 H） | 宽松正则兜底只在**无显式否定且有可用 summary**时生效；显式 `"completed":false` / 未完成 / 失败 一律不兜底                                                       | `lib/workflow/ai-takeover.ts`                                                  | 真实成功率 +5~10%（表观可能 −） |
| 反思机制（提案 2）         | 基础 system prompt 规则 9 增加"先用一行说明为什么失败、再行动"                                                                                                  | `system-prompt.ts`                                                             | 修复成功率 +5~7pp               |
| 低温默认（提案 4）         | `takeoverProviderOf` 在 profile 未显式设温度时补 `0.2`                                                                                                          | `lib/workflow/ai-takeover.ts`                                                  | 多步连续成功 +10~20pp           |
| 尝试间记忆（提案 9）       | 尝试间工具轨迹上限 14 → 40，并新增"历次尝试一句话小结"回喂                                                                                                      | `workflow-engine/ai-takeover.ts`、`lib/workflow/ai-takeover.ts`                | +3~8%                           |

新增/更新测试：`tests/llm-retry.spec.ts`、`tests/tool-error.spec.ts`、`tests/bench/debug-bench.spec.ts`，并扩展 `tests/takeover-stats.spec.ts`、`tests/ai-takeover.spec.ts`、`tests/debug-session.spec.ts`。

---

## 6. 路线图（M2–M4，待数据驱动）

| 阶段   | 内容                                                                                                                                                      | 备注                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **M2** | 快速失败扩面（重复失败签名预检）、全局重试预算 + 逃生舱（提案 3）、服务端 tab 钉定、结构化验证结果（提案 8）、接管上下文增强、性能/网络语义摘要（提案 6） | 由 M0 数据决定优先级                   |
| **M3** | Observer 只读预检（提案 7，可选增强模式）、预算可调                                                                                                       | 默认关，降低对现有用户影响             |
| **M4** | 本地检查点（提案 10/11，**不引入 Temporal**）、状态回滚（提案 9）、失败记忆（提案 12）                                                                    | 扩展与 server 共用 `checkpoints/` 格式 |

### 企业级加固（可与 M1 并行，独立发布）

- **安全**：`server/src/http-api.ts` 用 `crypto.timingSafeEqual`；**移除 `?token=`**；除非显式 `BC_ALLOW_UNAUTHENTICATED=1` 否则要求 token；接入 `@fastify/cors` + `@fastify/rate-limit`；`zod` 校验请求体；`.dockerignore` + 合并重复 Dockerfile；`config.json` 强制 `0600`。
- **工程**：PR/push CI（install → typecheck → test → build → lint → format:check → server 三件套 → `pnpm audit`）；ESLint flat config；`@vitest/coverage-v8`（阈值 60 起）；e2e 冒烟；Dependabot；`SECURITY.md` / `CONTRIBUTING.md` / `CODEOWNERS` / `CHANGELOG.md`。
- **可观测**：`pino` + Fastify logger（替换 `logger:false`）、`onRequest/onResponse`、`setErrorHandler`；替换 `console.*`；`server/src/observability.ts` 统一错误上报（默认 no-op，预留 Sentry）；调试链路全程传播 `sessionId`。

---

## 7. 风险与回滚

- **默认等待**拖慢正常路径 → 保守 2s、仅交互块、`defaultWaitMs=0` 关闭；用 `debugSessionStats.durationMs` 观测。
- **verdict 收紧**可能减少"侥幸成功" → 对比前后 `takeoverSuccessRate` 与 `goalAchieved`；回滚改一个常量。
- **低温默认**影响创意类任务 → 仅接管/agentic 运行生效，显式用户值优先。
- **LLM 重试**非瞬时错误可能双倍成本 → 白名单状态码、上限 3 次、流式开始后不重试。
- **快照上限提高**增 token → 仅接管上下文，监控 `inputTokens`。

---

## 8. 验收标准

1. `pnpm bench:debug` 输出基线会话成功率、逐场景结果与失败阶段分布，并作为 CI 回归门。
2. 登录墙/验证码 ≤1 次尝试结束；无 provider 0 次尝试；修复无可验证时不得 `verified`。
3. `pnpm typecheck`、`pnpm test`、`pnpm build` 全绿。
4. 面板调试弹窗可见「接管成功率」与「修复后无需 AI 即可跑通率（含中位耗时、失败阶段）」。

---

## 9. 实施进度（累计）

> 严格度量口径：8 场景离线基准，成功 = 无接管跑通且目标达成。当前 **基线会话成功率 62.5%**（5/8）。

### 已完成

- **M0 度量**：会话级遥测 + 离线基准 `tests/bench/*` + `pnpm bench:debug`（CI 回归门）。
- **M1 P0（1–9）**：默认等待、LLM 瞬时重试、快照覆盖、结构化错误上下文、陈旧 ref 引导、verdict 收紧、反思模板、低温默认、尝试间记忆。
- **M1-10(b) 闭环·服务端 patch 应用**：`server/src/agent/takeover.ts` 在 `BC_TAKEOVER_APPLY_PATCH=1` 时把接管建议的 `paramsPatch` 应用到内存副本（`patchNodeParams`）+ 写审计产物；默认关，不静默改图。
- **M1-10(a/c) 闭环·扩展端**：`workflows.takeoverApply` 支持 `verify` 选填，应用修复后（仅当存在活动面板窗口）跑一次无接管验证运行并回传 `verified`/`verifySummary`；定时运行（`takeoverOnRun`）`takeoverBudget` 收紧为 `takeoverAutoRunBudget()`（默认 **1** 次接管，成本封顶，`BC_TAKEOVER_AUTORUN_BUDGET` 可覆盖）。
- **M2-11 快速失败扩面**：`failureSignature` + `isRepeatedHopelessFailure`（同节点同错误连续 3 次即早停）；扩展与服务端双循环接入。
- **M2-12 全局重试预算 + 逃生舱**：`AiTakeoverDeps.takeoverBudget`（= `takeoverMaxAttempts()` × `DEFAULT_MAX_ROUNDS`）接入扩展接管双路径；超出即优雅结束并带原因；服务端对齐。
- **M2-13 服务端 tab 钉定**：`server/src/agent/takeover.ts` 锁定 `request.tabId` 与运行日志一致（接管前断言）。
- **M2-14 结构化验证结果**：`WorkflowDebugResult` 新增 `failureReason` + `suggestedAction`；`debug-session.ts` 从驱动错误推导结构化字段。
- **M2-15 接管上下文增强**：`buildTakeoverPrompt` 新增 `pageSummary`（DOM/ARIA 摘要）槽位并渲染（运行时填充待接 driver 快照）。
- **M3-18 预算可调**：`takeoverMaxAttempts` / `takeoverToolRounds` 经 `BC_TAKEOVER_MAX_ATTEMPTS` / `BC_TAKEOVER_TOOL_ROUNDS` 覆盖（默认 3 / 40）；扩展与服务端统一从此读取。
- **M2-16 性能/网络语义摘要**：`cdp-monitor.ts` 新增纯函数 `summarizePerfNetwork(console, requests)`（含 `PerfNetworkSummary`）→ 单行星号「页面信号：N 个控制台错误…」；`list_network_requests` / `list_console_messages` 工具回传 `summary`；`captureObservation` 回传 `perfNetworkSummary`（控制台错误 + 近期网络失败合并）。
- **M3-17 Observer 只读预检**：新增 `src/lib/workflow/observer.ts`（纯函数 `detectPreflightHints` + 开关 `observerPreflightEnabled()`，env `BC_OBSERVER_PREFLIGHT`，**默认关**）；扩展与服务端 takeover 循环在首轮前预检，命中验证码/登录墙即 **跳过整个 agent 回合**直接 `fail(kind)`（比现有 hopeless 快退早一整轮）；弹窗/超时等线索仅记录 event。

### 待实施（下一步）

- **M4（部分）**：已落地共享模块 `src/lib/workflow/checkpoints.ts`（`RunCheckpoint` + `CheckpointStore` 注入式存储 + `rollbackToLastValid` / `restoreVariables` / `checkpointFileName`）与 `failure-memory.ts`（`rememberFailure` + `buildFailureMemoryHint`）；失败记忆已接入接管循环（attempt 2+ 注入 `failureMemory` 提示）。待补：按步持久化检查点到 `checkpoints/<runId>.json`（扩展用 `chrome.storage`、服务端用 fs）+ `sessionId` 全链路传播（并入 §可观测）。
### 企业级加固（已完成）

> 说明：鉴权（timing-safe Bearer、无 `?token=`、无 token 拒绝启动）、CORS、限流、zod 校验、pino 结构化日志、`config.json` `0600` **在本轮之前已在仓库中落地**；本轮补齐的是剩余部分，并让所有门禁真正可跑通。

- **可观测**：`server/src/observability.ts` 新增统一错误 sink（`reportError` / `setErrorReporter`，默认 no-op、预留 Sentry），保留本地日志兜底；`console.*` 全量迁移到 pino（`feishu-bot` / `scheduler` / `run-service` / `driver` / `browser-pool`，共 16 处）。
- **安全/容器**：新增 `.dockerignore`（root + server），排除 `config.json` / `.env*` / 密钥 / 本地状态；合并重复 Dockerfile——`server/Dockerfile` 与根 `Dockerfile` 内容完全一致且 compose 本就以仓库根为构建上下文，现统一指向根 `Dockerfile`。
- **工程**：ESLint 10 flat config（`eslint.config.js`，**0 error**）+ 清理 10 处失效的 `react-hooks` disable 注释与 1 处死代码；Prettier 全仓格式化（212 文件 + `.prettierignore`）；`vite.config.ts` 配 `@vitest/coverage-v8`（lines/functions 阈值起步 60）；`.github/workflows/ci.yml`（扩展与服务端双 job + `bench:debug` 门禁）、`.github/dependabot.yml`、`.github/CODEOWNERS`；治理文档 `SECURITY.md` / `CONTRIBUTING.md` / `CHANGELOG.md`；`package.json` 新增 `lint` / `lint:fix` / `format` / `format:check` / `coverage`。
- **e2e 冒烟**：`server/test/e2e/runner.smoke.ts`（5 测试）已存在并纳入 `pnpm server:smoke`。

### 本轮校验（M1-10a/c → M2-16 → M3-17 → M4 → 企业级加固）

- **门禁全绿**：`tsc --noEmit`（src / tests / server）三处通过；`eslint .` **0 error**（5 warning）；`prettier --check .` 全仓通过；`vite build` 成功。
- **测试**：扩展全量 **108 文件 / 1245 测试**通过（分 4 批跑完，沙箱对单次长跑有 SIGTERM 限制）；服务端全量 **73** 通过；新增 observer 8 / cdp-monitor 4 / apply-verify 6 / checkpoints 9。
- **离线基准**：**始终 62.5%**（8 场景 5 已验证，7 条基准断言），M1-10(a/c) 到加固全程无回归。
