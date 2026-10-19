# 修复反思层设计 · Repair reflection

> 目标：一轮修复失败后，**先反思为什么失败**，再据此改进方案重新修改；
> 反思以真实页面为依据。覆盖三条修复路径，共用一层实现。
> 决策日：2026-10-19。范围由 dcc 拍板：三条全做 + 独立反思调用 + 允许反思改策略。

## 1. 问题

三条修复路径都**丢弃了上一轮失败的信息**：

| 路径           | 入口                             | 丢在哪                                                                                                                                    |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 阶梯式自动修复 | `auto-repair/orchestrator.ts`    | `verification-failed` 后直接 `advance()`；`session.attempts` 只喂给 `nextStrategyOf` 记账，**不进 prompt**。`CandidateContext` 无历史字段 |
| 补丁式生成修复 | `repair/generation-repair.ts`    | `buildRepairContext(..., [])` 恒传空数组；`RepairContext.repairHistory`（`repair/types.ts`）已声明但永远是 `[]`                           |
| AI 接管        | `workflow-engine/ai-takeover.ts` | **唯一有跨轮记忆的**：`attemptNotes` + `lastAttemptTrace` + `failureMemory`，但形状与另两条不共享，各自一套                               |

阶梯式 prompt（`background-adapter.ts`）只有 `failedNode` 六字段，
**没有任何页面证据**——模型在盲猜选择器。补丁式有 `enrichContextWithLivePage`
（`repair-agent.ts`，复用 `page-inspect.ts` 的 `inspectPage`），阶梯式没有。

### 1.1 实测更正：哪条路径真的在生产里跑

写代码时全仓 grep 发现，方案初稿的前提有一处错：

- **`finalizeGeneratedWorkflow`（补丁式生成修复）在生产中没有调用点。** 全仓（含
  `server/`、`scripts/`、`.mjs`）只有它自己的定义、`repair/index.ts` 的 barrel
  re-export，以及测试。`workflow-generation-bridge.ts` 只 import 了
  `generation-trial` 的 `createTrialRunner`。
- 生成的 workflow 真正走的是**阶梯式自动修复**：
  `workflow-generation-bridge.ts:775` → `startBackgroundAutoRepair` →
  `runAutoRepair`；面板路径另有 `background/index.ts:1786-1790`（`autoRepairOnRun`）、
  `:2732`、`:2922`。
- `runUnifiedDebug` 只服务面板诊断（`workflows.repair` / ANALYZE / SUGGEST），
  **不做生成态收尾**。

因此阶梯式是唯一"用户能真实触发"的多轮修复，反思优先接它收益最大。
补丁式仍然接（成本低、字段本就是为此预留的），但如实标注为**当前无生产调用点**。

唯一在文档里被称作「已落地的反思机制」的是 `docs/ai-debug-success-rate-v3.md:52`
引用的 chat agent `system-prompt.ts:29` rule 9——那是侧边栏对话，不是修复。

## 2. 设计

### 2.1 共享层 `src/lib/workflow/repair-reflection.ts`（新增，chrome-free）

三条路径共用，符合 §5.2「同一逻辑第二次出现就抽公共层」。

```ts
/** 一轮修复失败的反思结论。 */
export interface RepairReflection {
  /** 上一轮为什么失败（一句话，模型自己下的判断）。 */
  rootCause: string
  /** 证据：页面上看到了什么具体事实。 */
  evidence: string
  /** 改进方向：下一轮必须换掉什么。 */
  nextApproach: string
  /** 反思建议的下一轮策略；缺省表示沿用阶梯的下一档。 */
  suggestedStrategy?: string
  /** 0–1。低于 REFLECTION_MIN_CONFIDENCE 的策略建议被忽略。 */
  confidence: number
}
```

函数：

- `buildReflectionMessages(parts)` — 反思 system + user prompt。英文脚手架（模型跟得住）。
- `parseRepairReflection(raw)` — 防御式解析。**任何畸形都降级为 `null`，绝不伪造结论**。
- `renderReflectionHistory(reflections)` — 把多条反思渲染成下一轮 prompt 里的一段，
  takeover 的 `previousAttemptNotes` 换成它（形状收敛，不再各写一套）。

关键约束（写进代码注释，因为反直觉）：

- 反思**不产生补丁**，只产生「下一轮怎么改」的约束。补丁仍走各路径原有的解析/校验/应用。
- 反思调用**失败或降级为空时，路径行为与今天完全一致**——反思是增强，不是新的失败点。
- 反思的 `suggestedStrategy` **只影响选哪一档，不影响预算/安全判定的顺序**。

### 2.2 页面证据

反思的 `evidence` 要求真实页面，所以三条路径统一复用已有的 `inspectPage()`
（`workflow-engine/page-inspect.ts:233`）——不新写第二套 DOM 勘察（§5.6）。

阶梯式目前没有页面勘察，接入时补上：反思失败的那一轮跑完 replay 后，
页面正停在失败现场，此时 `inspectPage(failedSelector)` 拿到的就是"为什么没修好"的现场。
这比在候选生成前勘察更准——那是修复**前**的页面，而反思看的是修复**后**仍然失败的面。

### 2.3 策略覆盖（允许反思改策略）

阶梯式 `advance()` 改为：先问反思要哪一档，再交给 `nextStrategyOf` 校验。

`nextStrategyOf`（`repair-policy.ts:142`）**保持不变**，仍是唯一的策略闸门。
反思只能**提议**，不能绕过：

- 安全阻断（`AUTH`/`CAPTCHA`/`SIDE_EFFECT_UNKNOWN`）→ 反思无权解禁，`:149-157` 先于一切。
- 预算（attempts / modelCalls / duration）→ 照旧由 `nextStrategyOf` 判。
- 死胡同去重（`maxSameFailureSignature`）→ 照旧。

即反思是一次**带依据的策略排序提示**，不是权限提升。这是让「允许改策略」不把
确定性状态机变成不可测的黑盒的关键。

### 2.4 预算

`DEFAULT_REPAIR_BUDGET.maxModelCalls: 8`（`repair-session.ts:181`）。
反思是模型调用，且只在**至少还有下一轮**时发生，所以：

- 反思只在 `verification-failed` 且 `session.attempts.length < budget.maxAttempts` 时发起
  （否则反思完就 exhausted，纯浪费一次调用）。
- `maxModelCalls` 8 → 12。理由：一轮失败现在花 2 次调用（反思 + 候选），
  8 次只够 4 轮；而 `maxAttempts` 是 6。12 覆盖满配。
- **测试友好**：`tests/repair-policy-ladder.spec.ts` 从常量读预算（`:100/:115`），
  没有硬编码 8，改预算不破测试。`tests/page-context-reanchor.spec.ts:223` 断言
  `modelCalls === 0`——那条路径不产生模型调用，反思也不会发生（见下）。

## 3. 三条路径的接入点

### 3.1 阶梯式（`orchestrator.ts` / `background-adapter.ts`）

- `CandidateContext` 加 `reflection?: RepairReflection`（本轮反思结论）+
  `reflections?: RepairReflection[]`（全部历史）。
- `AutoRepairDeps` 加 `reflect: (context) => Promise<RepairReflection | null>`。
- `verification-failed` 分支（`:450-463`）：先 `reflect`，存进 attempt，再 `advance`。
- `no-candidate` / `invalid-candidate` / `apply-failed` **不触发反思**：这三种是
  「没产出可用补丁」，不是「补丁试了没成」，反思无从谈起，也省一次调用。
  这条同时保住了 `page-context-reanchor.spec.ts:223` 的 `modelCalls === 0`。
- `background-adapter.ts` 实现 `reflect`：`streamCompletion` + `attribution.consumer: 'auto-repair'`
  （复用已有的 consumer 枚举，不新增——token dashboard 的 9 个 consumer 已在用）。

### 3.2 补丁式（`generation-repair.ts` / `unified-debug.ts`）

- `GenerationRepairDeps` 加可选 `reflect?`。
- 每轮 replay 未通过（`:225` 之后）先反思，`repairHistory` 填实——这个字段
  本来就是为此预留的，现在终于不再是 `[]`。
- `unified-debug.ts:159` 的 `history` 数组同样填实（它是单次执行，history 至多一条）。
- `RepairContext` 加 `reflection?: RepairReflection`，`buildRepairMessages` 渲染它。

### 3.3 AI 接管（`ai-takeover.ts` / `lib/workflow/ai-takeover.ts`）

这里**不新增反思调用**——接管本来就是 agent 自己在看页面反思，
再插一次调用纯属浪费。改为**形状收敛**：

- `attemptNotes: string[]` → `RepairReflection[]`，用 `renderReflectionHistory` 渲染。
- `lastAttemptTrace` 保留（工具轨迹是接管独有的证据，反思结构里没有对应字段，
  强行塞进去会丢信息）。
- `failureMemory` 保留（跨 episode 的持久记忆，与 episode 内的反思是两层）。

## 4. 会被打破的测试

| 测试                                                        | 原因                                    | 处理                                             |
| ----------------------------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| `tests/page-context-reanchor.spec.ts:175-191`               | `AutoRepairDeps` 构造字面量缺 `reflect` | 补 `reflect: vi.fn(async () => null)`            |
| `tests/ai-takeover.spec.ts` 14 处 `createAiTakeover({...})` | 形状收敛                                | 断言 prompt 文本的用例按新渲染改                 |
| `tests/ai-takeover.spec.ts:392`                             | `runUnattended` 调用次数                | 接管不新增调用，**应仍为 2**；若变了说明改动越界 |
| `tests/repair/unified-debug.spec.ts:286/306/323`            | `GenerationRepairDeps` 加可选成员       | 可选成员不破构造；补一条断言 history 填实        |
| `tests/i18n.spec.ts:67-69`                                  | 若新增 UI 文案                          | 所有 `LOCALES` 必须同步加 key                    |

## 5. 不做的事

- **不新增 `RepairProgressEvent` 类型**。`RepairProgressDialog.tsx` 的 `stepRowsOf`（`:56-121`）
  只认 9 种事件，新类型会被静默丢弃。反思结论通过已有的
  `repair.attempt-failed` 的 `reason` 字段透出，不动 UI。
- **不新增 completion helper**。`src/lib/llm.ts` 只导出 `streamCompletion` 等，
  一次性 JSON 调用在仓库里一律手写局部函数包 `streamCompletion`
  （见 `workflow-review.ts:168`）。沿用这个惯例，不造 `completeJson`（§5.6）。
- **不改 `nextStrategyOf` 的判定顺序**。反思只是排序提示。
- **不给反思单独的 token consumer**。复用 `auto-repair` / `ai-debug`。
- **不改 AI 接管的尝试次数**（`TAKEOVER_MAX_ATTEMPTS = 3`）。

## 6. 验收

- `pnpm typecheck` / `test` / `lint` / `format:check` 全绿。
- `pnpm bench:debug` 前后对比，按 `CONTRIBUTING.md` 报告成功率变化
  （基线 `tests/bench/baseline.json`，口径以 `docs/ai-debug-success-rate-v3.md` 为准）。
- 新增单测覆盖：`parseRepairReflection` 的畸形降级、反思不发起时的短路、
  反思策略建议被 `nextStrategyOf` 拒绝时回落到阶梯档位、
  反思失败/无模型时三条路径行为与改动前一致。
- ⑤ 浏览器真实行为证据：`pnpm selftest` 或手工加载 unpacked；拿不到就标 BLOCKED。
