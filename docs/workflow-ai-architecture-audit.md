# Browser Copilot Workflow AI 架构审计（Architecture Audit）

> 对应计划：`browser-copilot-workflow-ai-executable-plan.md`，任务 T00.1–T00.4。
> 审计对象：`develop` 分支当前代码。
> 方法：仓库全文检索 + 实际阅读源码；本文所有结论均给出 `文件:行号` 与符号名，不做文件名猜测。

---

## 1. 总览：三条真实链路

Browser Copilot 当前存在 **两条生成路径** 与 **一条执行链路**，以及 **两套已接线的 AI 修复产品**：

1. **生成路径 A（主路径，operator-draft）**：模型在对话中调用 `wf_op_<blockId>` 工具，工具调用时**真实执行**对应 block 并把节点追加进内存 draft；保存时 draft 直接组装为 Workflow。
2. **生成路径 B（兜底，chat-history）**：模型只调用普通浏览器工具（无 `wf_op_*`），动作进入 action history；draft 为空时由 `workflowFromHistory` 把历史编译为 Workflow。
3. **执行链路**：`executeWorkflow`（run 包装 + checkpoint + trace）→ `runWorkflow`（图解释器）→ executor（真实 CDP 动作）。
4. **AI 修复产品 A（AI Debug session）**：`workflows.debug` —— 带 AI takeover 跑 → 收集参数修复 → **无接管验证跑** → pending → 用户应用。
5. **AI 修复产品 B（Unified repair）**：`workflows.repair`（ANALYZE / SUGGEST / AUTO_REPAIR）—— 始终无接管执行 → 确定性诊断 → AI 最小补丁集 → replay → verify，verified 副本存内存待 `repairCommit`。

> 关键事实：当前代码**没有**“Planner 硬门槛”，主产品路径就是“先在真实浏览器执行，后生成 Workflow”，与计划 §0.3 一致，后续改造保持该路径。

---

## 2. 真实入口文件

| 角色 | 文件 | 说明 |
|---|---|---|
| Service Worker 总入口 | `src/background/index.ts` | 所有 `workflows.*` 消息命令的集中分发（switch 在 `:844` 起；workflow 命令在 `:1161` 起） |
| Agent / 对话编排 | `src/background/agent.ts`、`src/background/orchestrator.ts`、`src/background/task-runner.ts` | 聊天回合、工具执行 |
| Operator 工具（生成路径 A） | `src/background/operator-tool-run.ts`、`src/background/operator-tool-handler.ts` | `wf_op_*` 工具的执行、draft 存储与组装 |
| History 编译（生成路径 B） | `src/background/history-compile.ts`、`src/lib/storage.ts:1900 workflowFromHistory` | draft 为空时的兜底编译 |
| Run 外层包装 | `src/background/workflow-engine/run-workflow.ts:316 executeWorkflow` | run 登记、变量播种、checkpoint、trace、L3 goal gate |
| 图解释器 | `src/background/workflow-engine/engine.ts:377 runWorkflow`（内部 `runCore:392`） | 节点遍历、分支/循环、重试、AI takeover |
| Block 执行器 | `src/background/workflow-engine/executors.ts`（3065 行） | 全部 block 的真实实现 |
| Operator 节点执行 | `src/background/workflow-engine/operator-exec.ts:124 executeOperatorNode` | 生成会话内 block 的真实执行包装 |
| Readiness 运行时 | `src/background/workflow-engine/readiness-engine.ts` + `src/lib/workflow/readiness.ts` | poll + fresh observation |
| 条件运行时 | `src/background/workflow-engine/condition-runtime.ts` + `src/lib/workflow/conditions.ts` | pre/postcondition、goal 条件求值 |
| Goal 验证 | `src/background/workflow-engine/goal-verifier.ts` | 确定性 goalSpec 验证 |
| AI Debug 会话 | `src/background/workflow-engine/debug-session.ts:234 runDebugSession` | 修复产品 A |
| 统一修复 | `src/background/workflow-engine/repair/unified-debug.ts:61 runUnifiedDebug` | 修复产品 B |
| 失败分类 | `src/lib/workflow/failure-code.ts`、`src/background/workflow-engine/failure-classifier.ts` | 错误文本 → code/category/hint |
| Block 目录 | `src/lib/workflow/blocks/catalog.ts:91 BLOCK_CATALOG` | 56 个 block 的唯一注册源 |

---

## 3. Generation Path Trace（T00.2）

### 3.1 链路 A：operator-draft（主路径）

```text
用户消息
  → 聊天 agent 回合（src/background/agent.ts / orchestrator.ts）
  → 模型调用工具 wf_op_<blockId>
  → runOperatorTool（src/background/operator-tool-handler.ts:299）
      ├─ 真实执行对应 block（executeOperatorNode，operator-exec.ts:124）
      └─ appendOperatorNode（operator-tool-handler.ts:214）把节点追加进 draft
  → remember(draft)（:137，内存）+ persistDraft（:173，chrome storage 持久化）
  → 用户在保存卡片确认
  → composeWorkflowFromDraft（:593）
      ├─ autoCompleteReliability（:615）补全 __reliability
      ├─ declareMissingInputs（:618）提升 dangling {{ref}} 为 run input
      ├─ 组装 Workflow（provenance / generationOriginUrl / goalSpec 戳印，:619-643）
      ├─ validateWorkflowForRun + validateGeneratedWorkflow（:652-665）→ saveWarnings
      └─ saveWorkflow（:672）→ clearDraft（:674）
```

要点：

- `wf_op_trigger` 不是追加而是**原地编辑** trigger 头（`appendOperatorNode` 注释 `:223`；`ensureTriggerHead:96`）。
- 执行 + 记录在同一次工具调用内完成，因此 draft 里的每个节点都是“被真实验证过一次”的动作。
- draft 类型：`WorkflowDraft { conversationId, name, nodes, edges, tail, source, ... }`（`operator-tool-handler.ts:66` re-export；分支悬挂点 `PendingBranch`、来源 `DraftSource = 'chat-generate' | 'chat-history'`）。

### 3.2 链路 B：action-history 编译（兜底）

```text
用户消息
  → agent 使用普通浏览器工具（click/fill/…，非 wf_op_*）
  → 每次动作写入 HistoryEntry（src/lib/types.ts:407）并持久化（listHistory，src/lib/storage.ts）
  → workflows.draft.get（index.ts:1192）
  → resolveWorkflowForSave（history-compile.ts:147）
      ├─ composeWorkflowFromDraft(save:false) → draft 为空
      └─ compileConversationHistory（history-compile.ts:168）
           ├─ listHistory → 过滤本会话 + ok !== false（usable :104）
           ├─ 按 at 升序（history 最新优先存储）
           ├─ workflowFromHistory(entries, name)（src/lib/storage.ts:1900）
           ├─ 戳印 provenance='chat-history'、generationOriginUrl（:186-188）
           └─ applyDynamicData（:70）：业务字面量 → {{ref}} 并在 trigger 声明 input
```

来源选择优先级（`resolveWorkflowForSave:147`）：**operator draft 赢 → history 编译 → 报告空因（all-failed / no-actions）**。

### 3.3 Action history schema（真实类型）

`src/lib/types.ts:407`：

```ts
export interface HistoryEntry {
  id: string
  at: number                    // Wall-clock ms
  conversationId: string        // 所属会话 / task run
  action: string                // 工具/动作名
  summary: string               // History tab 展示的人类可读摘要
  host?: string                 // 动作所在 host
  approved: boolean             // 用户是否批准
  ok: boolean                   // driver 报告的成败
  detail?: string[]             // 审计子行（输入值脱敏、按钮标签、URL 等）
  args?: Record<string, unknown> // 原始工具参数（用于事后重建 workflow）
}
```

### 3.4 保存 / 编译入口（消息与处理器）

| 消息 | 处理器位置 | 作用 |
|---|---|---|
| `workflows.draft.get` | `index.ts:1192` → `resolveWorkflowForSave` | 生成保存卡片内容（不持久化） |
| `workflows.probe` | `index.ts:1228` | 页面侧 selector 命中探测 |
| `workflows.save` | `index.ts:1167` | 实际保存；`fromGeneration` 时先 `hardenWorkflowSelectors` + `persistDefaultWaits` |
| `workflows.draft.fold` | `index.ts:1250` → `foldDraftRun` | 折叠重复运行 |
| `workflows.draft.clear` | `index.ts:1278` | 清空 draft |

### 3.5 戳印位置（Stamping）

| 字段 | 位置 | 函数/说明 |
|---|---|---|
| `settings.provenance` | `operator-tool-handler.ts:629` | `draft.source === 'chat-generate' ? 'chat-generate' : 'chat-history'`（draft 路径） |
| `settings.provenance` | `history-compile.ts:186` | 固定 `'chat-history'`（history 路径） |
| `settings.generationOriginUrl` | `operator-tool-handler.ts:630` | 来自 `draft.originUrl` |
| `settings.generationOriginUrl` | `history-compile.ts:188` | 由 host 重建 `https://<host>`（hint，非保证） |
| `settings.goalSpec` | `operator-tool-handler.ts:635-637` | `deriveGoalSpecFromNodes(draft, goalText)`；无 postcondition 则不生成 |
| `Workflow.plan` | history 路径：`src/lib/storage.ts:2131-2149` 由“目标 + 各节点 description 编号”组装并随返回值带出（`workflowFromHistory` 内）；draft 路径：**`composeWorkflowFromDraft` 不写 plan**（不对称缺口）。持久化透传 `src/lib/workflow/storage.ts:103`；消费点 `debug-rewrite.ts:69 planTextOf`，缺省回退节点 description 拼装 |
| `settings.saveWarnings` | `operator-tool-handler.ts:667-669` | `validateWorkflowForRun` + `validateGeneratedWorkflow` 的非阻断 findings |
| trigger 镜像 | `operator-tool-handler.ts:623` | `triggerFromNodes(nodes) ?? { type:'manual' }` |

---

## 4. Execution Path Trace（T00.3）

### 4.1 调用链（每跳含 file:line）

```text
入口（见 4.2）
  → executeWorkflow（run-workflow.ts:316）
      ├─ startRun / 复用 run（:321-330），登记 runId
      ├─ checkpoint 索引（:338-339）
      ├─ TraceCollector（:347）统一 ExecutionTrace
      ├─ scope 解析（:357-360）
      ├─ applyDefaultWaits（:366，默认 2000ms，defaultWaitMs=0 可关）
      ├─ seedFromTrigger（:379）：trigger 参数 defaults 播种变量
      ├─ 生成同源提示（:388-413，manual + unanchored + 跨 origin）
      ├─ resume 处理（:414-460；SIDE_EFFECT_UNKNOWN 拒绝自动重放）
      ├─ strict 预检 validateGeneratedWorkflow（:467-480，非阻断，写 run log）
      └─ runWorkflow（engine.ts:377 → runCore:392）
           ├─ 构图：outBySource（:448-453）
           ├─ runSegment（:894）while 循环驱动 runNode
           └─ runNode（:518）：
                1. emit('tool')（:527）
                2. 分支/输出 handle 解析（:536-564）
                3. interpolateParams（:574）{{token}} 替换
                4. disableBlock 跳过（:587）
                5. LOOP_BLOCK_IDS → runLoop（:598-603）
                6. execute-workflow → runSubWorkflow（:605-607）
                7. executor 查找（:610）
                8. page-context guard（:642-655）
                9. unsafe 判定 idempotencyOf（:657-658）+ nodeStarted checkpoint
               10. 终态跳过（:661-679）：unsafe 且 postconditions 已成立 → skip
               11. 重试循环（:705-788）：
                    - preconditions（:716-723）
                    - prepareNodeExecution readiness（:724-738）
                    - sideEffectStarted checkpoint（:739）
                    - executor(params, ctx)（:740）← 真实动作
                    - verifyPostActionReadiness（:743-757）
                    - postconditions（:761-768）
                    - sideEffectObserved checkpoint（:769）
               12. 失败路径：onError policy / fallback / AI takeover（:790-873）
               13. 成功：nodeCommitted checkpoint（:886），返回下一节点
      ← WorkflowRunResult { outcome, summary, error, variables, steps }
  → L3 goal gate（run-workflow.ts:663-684）：
      ok 且 goalSpec 存在 → verifyGoalSpec（goal-verifier.ts）→ 不达成则改写为 failed
  → finishRun（:708），返回 ExecuteWorkflowResult（含 trace）
```

### 4.2 Run 入口

| 入口 | 位置 | 备注 |
|---|---|---|
| 手动运行 | 消息 `workflows.run`，`index.ts:1309-1370` | 先 `validateWorkflowForRun`（errors 阻断，warnings 仅 console）；可选 `settings.takeoverOnRun` 挂单次 AI takeover |
| Resume | `workflows.resumePoint`（`index.ts:1372`）/ `workflows.resume`（`:1400`） | 基于 checkpoint 恢复 |
| 定时调度 | `src/background/scheduler.ts` → `executeWorkflow` | 经过 alarm |
| 页面触发 | `src/background/workflow-triggers.ts`（visit-web / element-change / context-menu / shortcut） | `index.ts:369` 等处 |
| AI Debug / 修复 | `debug-session.ts`、`repair/*` 经 `background-runner.ts` 调用同一 `executeWorkflow` | |

### 4.3 Preflight / selector / readiness / postcondition / goal

- **Preflight**：手动运行走 `validateWorkflowForRun`（`index.ts:1319`；实现在 `src/lib/workflow/runnability.ts`）；`executeWorkflow` 内对 strict 工作流再跑 `validateGeneratedWorkflow`（`run-workflow.ts:467`）。两者均**非阻断**于引擎层（手动入口的 runnability errors 阻断）。
- **Selector resolve**：节点参数经 `interpolateParams`（`engine.ts:574`）；executor 内部通过 target/sel 辅助把 selector 转成 kernel target（另见 `src/lib/workflow/target-to-selector.ts`、`src/background/selector-probe.ts`）。
- **Readiness**：`prepareNodeExecution` / `verifyPostActionReadiness`（`engine.ts:725,744`）→ `readiness-engine.ts`，每次 poll 由 `createDriverReadinessProbe`（`run-workflow.ts:217`）做**新鲜观测**。支持状态：`present / visible / enabled / stable / navigation-settled / value-committed / data-ready`（`readiness.ts:20`）。默认窗口 8000ms、间隔 150ms（`readiness.ts:53-56`）。
- **Postcondition**：`engine.ts:761-768`，通过 `evaluateCondition`（`run-workflow.ts:539` → `condition-runtime.ts`）对 `nodeSpec.postconditions` 逐条求值。
- **Goal verify**：run 成功后 L3 gate（`run-workflow.ts:671-684`）调用 `verifyGoalSpec`（`src/background/workflow-engine/goal-verifier.ts:44`）；确定性条件不达成 → outcome 改 failed。
- **Run result**：`ExecuteWorkflowResult`（`run-workflow.ts:177`）`{ runId, outcome: 'ok'|'cancelled'|'failed', summary, error, variables, steps, resumedFrom, trace }`；失败结构化前缀（如 `READINESS_TIMEOUT(...)`、`SIDE_EFFECT_UNKNOWN`）由 `failure-code.ts` 解析。

### 4.4 Action Ledger 注入点（T00.3 验收）

| # | 注入点 | 可用上下文 | 理由 |
|---|---|---|---|
| 1（推荐） | `engine.ts:740` `resolver = await executor(params, ctx)` 调用前后 | runId（在外层）、`nodeId`、`unsafe`（:658）、`nodeSpec`、attempt 序号、params、成功/异常、变量快照（before/after）、`signal` | 单次真实 side effect 的唯一边界；已有 `sideEffectStarted`(:739)/`sideEffectObserved`(:769) phase checkpoint 可直接复用为 ledger 事件 |
| 2 | `runNode` 的 `emitCheckpoint` 包装（`engine.ts:659,769,872,886`） | nodeId、status、phase、变量快照、stepIndex | checkpoint 已是 per-settle 记录；ledger 可作为其投影，零侵入引擎 |
| 3 | `run-workflow.ts` 的 `onCheckpoint` 回调（`:579-607`） | runId、workflowId、nodeId、status、phase、variables、at | 最外层、chrome 可写；但只在 checkpoints!==false 时可用，throwaway run 会漏 |

建议：以注入点 1 为主（ledger 独立于 checkpoint），并在 ledger 中引用 checkpoint phase 作为证据。

---

## 5. Debug Path Trace（T00.4）

### 5.1 目标循环对照

| 环节 | Runtime 位置 | 仅 Benchmark | 说明 |
|---|---|---|---|
| 失败分类 | `failure-code.ts:163 classifyFailureMessage`；`failure-classifier.ts:63 classifyFailure` / `:95 withFailureVerdict`（在 `engine.ts:827` 调用） | — | 另有第二套词表 `repair/types.ts:22 VerificationFailureType` + `repair/failure-classifier.ts:162`；第三套 `ai-takeover.ts:137 classifyReason` |
| AI takeover | `src/background/workflow-engine/ai-takeover.ts:137 createAiTakeover`（prompt `src/lib/workflow/ai-takeover.ts:308`、parser `:482`）；引擎挂点 `engine.ts:821-868` | — | 这里的“接管”是 AI agent 接管节点，非人工；用户只在最终确认弹窗介入 |
| Pending 暂存 | `src/lib/workflow/takeover-pending.ts:121 savePendingTakeover`（key `aiTakeoverPending`）；应用 `index.ts:1865-1928` | — | |
| Replay（整目标重做） | `debug-session.ts:323 escalateToReplay` → `debug-rewrite.ts:108 buildReplayPrompt`；接线 `index.ts:1481-1512` | harness stub `tests/bench/harness.ts:156` | 是整 agent 复演，非单节点 replay |
| Replay（checkpoint/子集） | `repair/replay-engine.ts:93 planReplay / :191 executeReplay` | — | 引擎支持 `startAt`（`run-workflow.ts:123`），但生产适配器 `repair/background-runner.ts:57-73` 丢弃 `startAt`，实际等同全量跑 |
| 单节点 replay | **不存在** | — | |
| Audit / 上下文 | `background/ai-takeover.ts:200-268`；`repair/repair-agent.ts:41 buildRepairContext`；图审计 prompt `debug-rewrite.ts:147 buildAuditPrompt` | `harness.ts:160` | `TakeoverPromptParts.pageSummary`（`lib/ai-takeover.ts:285`）从未在 `src/` 被填充；`request.failure` 挂了但 prompt 构建未读 |
| LLM 整图 rewrite | `debug-rewrite.ts:244 parseWorkflowAudit`、`:419 buildRewrittenWorkflow`；接线 `index.ts:1517-1557` | harness stub | 校验已知 block / trigger / edges / ≤60 节点 |
| LLM 结构化补丁 | `repair/repair-agent.ts:70 REPAIR_SYSTEM_PROMPT`、`:109 parseRepairProposal`；`repair/patch-engine.ts:94 PatchEngine`；生产 proposer `repair/repair-provider.ts` | — | 原子操作 SET_PARAM/REMOVE_PARAM/REPLACE_TARGET/REPLACE_INPUT_REF/REPLACE_OUTPUT |
| `ReliabilityPatch` | `src/lib/workflow/reliability-patch.ts`（validate/gate/apply/circuit-breaker） | 仅 `tests/reliability-patch.spec.ts` | **无任何 `src/` 引用方**，0.75/0.9 confidence gate 未使用 |
| Path A 实际补丁 | `src/lib/workflow/auto-debug-patch.ts:114 patchNodeParams`（flat merge，保护 blockId/disableBlock） | — | debug-session 与用户应用时使用 |
| Review 补丁（保存卡片 curation） | `workflow-review.ts:167 reviewWorkflow`；`review-patch.ts:154,254` | — | 不属于失败/调试路径 |
| 补丁后验证（pending 前） | `debug-session.ts:649-721`（无接管跑 + goal judge）；`repair/verification-runner.ts:67/197` | `harness.ts:103` | 严格条件：ok && 无 takeover && goal!==false && integrity clean |
| 应用后验证 | `index.ts:1907-1919`（`verify:true` 时内联重跑） | — | `apply-verify.ts:40 verifyAppliedWorkflow` 无 `src/` 引用 |
| Failure memory | `failure-memory.ts:47 createMemoryFailureStore` / `:92 rememberFailure` / `:116 buildFailureMemoryHint`；消费于 `background/ai-takeover.ts:143,...` | — | 仅内存实现，生命周期 = 一个调试会话；无持久化后端 |

### 5.2 现有循环 A：AI Debug session

1. 面板发 `workflows.debug`（`index.ts:~1425` 起构建依赖）→ `runDebugSession`（`debug-session.ts:234`）。
2. `withWaitFor`（`:244`）给交互块强制 4s 等待。
3. `deps.run(current, { aiTakeover: createAiTakeover(...) })`（`:539`）→ 真实 `executeWorkflow`。
4. 节点失败：`engine.ts:827` 先 `withFailureVerdict` 分类并附带 redacted evidence，再调 takeover hook。
5. `createAiTakeover`（`background/ai-takeover.ts:137`）：每会话最多 3 次尝试 × 40 工具轮；prompt → `runUnattendedPrompt` → verdict 解析；写 output、构建 `TakeoverFix`（root-cause 路由 `fixNodeId`）；非完成即 `rememberFailure`。
6. 快速失败：登录墙/验证码等 hopeless kind 一次即停（`lib/ai-takeover.ts:113`，3 次同签名判定）。
7. 收集 fixes（`:589`）→ `applyTakeoverFixes`（`:631/111`）→ **无接管验证跑**（`:652`）。
8. 每次 ok 跑做 goal judge（`:478` → `debug-rewrite.ts:347/399`）；终态路径 `judgeAlreadySatisfied`（`:503`）。
9. 验证通过才 `savePending`（`takeover-pending.ts:121`）；用户 `workflows.takeoverApply`（`index.ts:1865`）再次应用补丁并 `saveWorkflow`，可选应用后验证。

升级路径 A′（节点级修复无效时）：**replay（整目标重做）→ graph audit → 重写图 → 无接管验证 → pending rewrite**（`debug-session.ts:323`、`index.ts:1481/1517`）。

### 5.3 现有循环 B：Unified repair

`runUnifiedDebug`（`repair/unified-debug.ts:61`）：

1. `verify`（无接管）→ `background-runner` → 真实 `executeWorkflow`。
2. `diagnose` → `failure-analyzer.ts:192 analyzeFailure`（结构/完整性、瞬时分类、`dataflow-analyzer.ts` 变量链、根因节点）。
3. ANALYZE 返回；SUGGEST/AUTO_REPAIR → `buildRepairContext`（最小化脱敏 + allowedNodeIds/allowedParamPaths）。
4. `propose` → model → `parseRepairProposal`。
5. `validatePatch` → `PatchEngine` 15 步流水线；SUGGEST 返回预览。
6. AUTO_REPAIR：`applyPatch` → `replay` → verify。
7. verified 副本经 `repair-session-store` 存内存；仅 `workflows.repairCommit`（`index.ts:1833`）才 `saveWorkflow` 持久化。

### 5.4 Benchmark 场景

离线 debug bench（`tests/bench/scenarios.ts:81-209`，全部驱动**真实** `runDebugSession`，IO 全部 stub，见 `tests/bench/harness.ts:81-191`）：

| ID | 场景 | 度量点 |
|---|---|---|
| S1-timing | 慢页面元素未渲染 | wait 参数修复经无接管验证 |
| S2-locating | 选择器过期 | 稳定选择器修复验证 |
| S3-environment | 登录墙 | 恰好 1 次接管尝试后如实失败 |
| S4-scope | 多窗口 | 接管钉到运行 tab 完成 |
| S5-structural | 结构性坏图 | 升级 replay+audit 重建并验证 |
| S6-resilience | 瞬时 5xx | 零接管首跑成功（LLM 重试由单测覆盖） |
| S7-misjudge | 残缺 verdict | fixless “完成”不计 verified |
| S8-no-provider | 未配置模型 | 零尝试即报不可用 |
| S9-non-idempotent | 已登录 | 终态满足即成功，不重试 |

门槛：`successRate ≥ 0.6`，且每个 verified 必须 goal-achieving + takeover-free（`tests/bench/debug-bench.spec.ts:30-41`）。

Reliability bench（`tests/reliability-benchmark.spec.ts`，fixtures `specs/reliability-fixtures/scenarios.ts`）：R01–R10（慢渲染 / 0 匹配 / 歧义 / CSS drift / SPA / 延迟 modal / 空上游变量 / click 成功后后续失败 / submit 恰好一次 / wrong origin），经 `computeBenchmarkMetrics` 的 L1/L2/L3 与 `Draft/Validated/Verified/Certified/Stale` 状态机度量；使用脚本 fixture，非生产引擎。

---

## 6. 已有模块 ↔ 计划能力映射

| 计划能力 | 状态 | 现有落点 |
|---|---|---|
| Workflow IR | MISSING | 无（draft 是最接近物：`operator-tool-handler.ts WorkflowDraft`，但仍直接等于节点 JSON） |
| Block Capability Catalog | PARTIAL | `src/lib/workflow/blocks/catalog.ts:91 BLOCK_CATALOG`（56 块，含 data 默认值/handle 数），但无 actions/inputVars/outputVars/sideEffect 语义字段 |
| 变量 Def-Use | PARTIAL | `src/lib/workflow/dynamic-data.ts`（字面量→ref、引用提取 `referencesIn`）、`repair/dataflow-analyzer.ts`（producer/consumer 图）；无 IR 级 def/use/mutate |
| Trace Event Schema | PARTIAL | `HistoryEntry`（types.ts:407）、`repair/types.ts ExecutionTrace/NodeExecutionTrace`；缺计划要求的统一 `WorkflowTraceEvent`（page/target/result/retryOf） |
| Trace Normalizer | PARTIAL | `history-compile.ts` 过滤失败/按 at 排序；无 exploration/重试噪声分离与 evidence 保留 |
| Live Locator Probe | PARTIAL | `workflows.probe`（index.ts:1228）、`selector-probe.ts`、保存时 `hardenWorkflowSelectors`（index.ts:1179）；非五层证据、非生成时强制 |
| Semantic Locator Ranking | PARTIAL | `src/lib/workflow/locator-score.ts`、`reliability.ts STRICT_MIN_SCORE/MARGIN`；缺带 reasons/matchedSignals 的评分结构 |
| Actionability | PARTIAL | kernel `actionability` op（`run-workflow.ts:254`）；无独立 actionability 结果结构（obscured/frame/shadow） |
| Ambiguity Handling | PARTIAL | strict 歧义策略 `score` + margin（`reliability.ts:348-353`）、R03 基准；无“margin 不足→fail/escalate”完整产品流 |
| Selector Memory | MISSING | 无（`failure-memory.ts` 是失败记忆，非 selector 成功记忆） |
| CFG-aware Dataflow | MISSING | 当前 `validateDataFlow`（`generated-validation.ts:212`）用全局 `written` Set，**非控制流感知**（计划 P0 缺陷，已确认） |
| Preflight Report | PARTIAL | `runnability.ts validateWorkflowForRun`；无统一 `WorkflowPreflightReport`（blockers/warnings/evidence/recommendedActions） |
| Action Ledger | PARTIAL | checkpoint 带 side-effect phase（engine.ts:739/769、checkpoints.ts CheckpointPhase）；无独立账本与 run 内 at-most-once 查询 |
| At-most-once Guard | PARTIAL | 终态跳过（engine.ts:661-679）、resume 的 SIDE_EFFECT_UNKNOWN 拒绝（run-workflow.ts:419-440）、R09；无 run 内 ledger check 的统一前置守卫 |
| Terminal State Guard | EXISTS | `goalSpec.terminalStateConditions`（reliability.ts:66）、终态跳过逻辑、S9 |
| Pre/Post Evidence Capture | PARTIAL | `execution-evidence.ts`、TraceCollector 的 before/after 变量、checkpoint phase；无受控的高风险节点 evidence 清单（URL/text/attr） |
| Resume Safety | EXISTS/PARTIAL | `run-workflow.ts:414-460` + checkpoints 指纹校验；依赖 checkpoints 开启 |
| Failure Taxonomy Runtime | PARTIAL | 三套并行词表（见 §5.1），缺统一 `WorkflowFailure` 对象 |
| Deterministic Repair Library | PARTIAL | Path B 有确定性 diagnose；Path A 无确定性 repair，分类 hint 未被消费 |
| Patch Schema | PARTIAL | `repair/types.ts WorkflowPatchSet`（在用）+ `reliability-patch.ts`（未接线）；无统一 patch 的 preview/rollback 元数据 |
| Patch Scope Guard | PARTIAL | `patch-policy.ts` allowedNodeIds/allowedParamPaths、PROTECTED_PARAMS；Path A 的 `patchNodeParams` 无 scope guard |
| Regression Detection | PARTIAL | R01–R10 / debug bench 回归；补丁后自动跑 certified 子集的产品机制缺失 |
| Replay Compiler | PARTIAL | `repair/replay-engine.ts`；`startAt` 被生产适配器丢弃 |
| DOM Perturbation Fixtures | MISSING/PARTIAL | R 系列覆盖部分漂移；无计划列举的 10 类 mutation fixture |
| Workflow Version Diff | MISSING | 无 patch history 版本链 |
| Reliability Report | PARTIAL | `saveWarnings` / 验证报告；无 evidence+blockers+recommendedAction 的结构化报告 |
| Certification Gates | PARTIAL | 状态机 `reliability-certification.ts:24-109` 完整；未接入 schedule/trigger 产品门槛 |
| Run Metrics | PARTIAL | takeover-stats、benchmark metrics；无统一 `WorkflowRunMetrics`（l1/l2/l3/aiCalls/…） |

---

## 7. 本次审计确认的 P0/P1 问题（与计划 §3 对齐）

1. **Dataflow validator 非控制流感知**：`generated-validation.ts:215` 全局 `written` Set 先收集所有 writer，再检查全部引用 —— “某节点在图中写过”即被当作已定义。需升级为 CFG IN/OUT 的 definite assignment（T04.1）。
2. **Locator validator 只是静态规则**：无 selector + semantic + live probe + unique + actionability 五层证据（T03）。
3. **Goal derivation 把所有 postcondition 并入终态**：缺 intermediate / step / terminal 三层区分（T02.6）。
4. **Reliability score 仍是静态视角**：未保存 evidence / 决策 / 推荐动作（T08.1）。
5. **Path A 无 deterministic repair 前置**，且存在三套失败词表、dead classifier evidence（T00.6/T06）。
6. **Checkpoint replay 在生产中退化为全量跑**（`background-runner.ts` 丢弃 `startAt`），无单节点 replay（T06/T07）。
7. **多个已实现但未接线的模块**：`reliability-patch.ts`、`apply-verify.ts`、`page-inspect.ts`、`generation-repair.ts`。

---

## 8. 未决事项 / Open Questions

- `Workflow.plan` 戳印不对称（已确认，见 §3.5）：history 路径在 `workflowFromHistory` 写入，draft/operator 路径不写 —— 需要在 P1/P2 为 draft 路径补齐 plan stamping。
- `generationOriginUrl` 在 history 路径仅由 host 重建（无 scheme/path），跨路径一致性需在 Grounding 阶段评估。
- 统一修复（Path B）目前 UI 只暴露 ANALYZE / AUTO_REPAIR，SUGGEST 仅命令可达；产品整合范围待后续 Task 明确。
