# 生成评测语料与全链路打分 · Generation eval corpus & attempt scoring

- 日期：2026-10-27
- 状态：设计
- 范围：真实模型生成语料入库、统一 attempt 记录、离线回归
- 不在范围：Best-of-N、prompt 进化、policy-tuner 接线、任何 RL / 微调

---

## 1. 问题 · What is broken

工作流生成的成功率是全仓库的瓶颈，但唯一的真实模型语料在 **gitignored** 的
`tmp/selftest-round*.json` 里；所有 committed bench 都是 scripted（无模型、无浏览器）。
因此：

- 文档里的成功率无法复算，任何 prompt / 修复改动都无法证明变好；
- 84+ 轮混入 provider 429 与并发在途代码后，差点被当成产品变化归因；
- 已存在的失败分类（`failure-taxonomy.ts` 16 类）、目标判定（`goalVerification`）、
  修复日志（`repair-metrics.ts`）互不相连，没有一条可比较的“一次生成尝试”。

按实际存在的 1–83 区间（**82 轮，round 1 缺失**）复算的基线：

| 指标                    | 值            |
| ----------------------- | ------------- |
| `verdict.pass`          | 9/82 (11.0%)  |
| `goalCertified`（L3）   | 3/82 (3.7%)   |
| `verified && proven`    | 19/82 (23.2%) |
| generation coverage gap | 40/82 (48.8%) |

stage 分布：verify 28 · goal 15 · generate 14 · cutoff 11 · ok 9 · harness 5。
更早设计文档的 10.7%（9/84）是另一个轮次口径，不与本基线混用。

---

## 2. 目标与非目标

### 目标

1. **可复算语料**：把 2–83 轮脱敏后提交，CI 离线复算基线与回归。
2. **统一记录**：每次生成尝试一条 `GenerationAttemptRecord`，跨 compose → verify → repair 合并。
3. **可比较分数**：0–1 序数适应度（不是成功率），供后续 Best-of-N / 进化 / 调参共用。
4. **面板也留痕**：落点在 `composeWorkflowFromDraft`，面板聊天与 bridge 都覆盖。

### 非目标（明确拒绝）

- 不做 RL / 微调：没有本地权重、logprobs、seed/n，动作空间是工具调用录制的图，不是可采样序列。
- 不把分数当成功概率：n=82 时二值 pass 只能检出大幅变化（11%→30% 约 z=3.1；11%→20% 仅 z≈1.6）。
- 不新增第二套指标 / 存储设施：复用 `fileStorageArea` 与 `repair-metrics` 的 capped-log 模式。
- 不改生成行为：记录 best-effort，写失败不得改变任何返回值或保存结果。

---

## 3. 现状取证 · Current state

| 事实                                      | 锚点                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 面板聊天与 bridge 共用同一个 compose 落点 | `src/background/agent.ts:4256` → `composeWorkflowFromDraft`；`workflow-generation-bridge.ts:318` 同函数 |
| compose 已算静态校验、试跑、目标判定      | `operator-tool-handler.ts:805-890`；`workflow.settings.goalVerification` 在 :890                        |
| replay/verify 已算 trial + L1/L2/L3       | `workflow-generation-bridge.ts:612-700`                                                                 |
| 历史轮次带 trialRun / nodes / buildStamp  | 77/111 有 trialRun；72/111 有 nodes；111/111 有 buildStamp                                              |
| bridge-only 工具不进 round-1 预算         | `tests/agent-payload-size.spec.ts:58-72`                                                                |
| 失败分类已有 16 类与两套旧词表适配器      | `src/lib/workflow/failure-taxonomy.ts`                                                                  |
| capped-log 存储先例                       | `src/lib/workflow/repair-metrics.ts`、`takeover-stats.ts`                                               |

---

## 4. 设计 · Design

### 4.1 记录形状

`src/lib/workflow/generation-attempt.ts`（chrome-free，纯函数）：

```ts
interface GoalFacts {
  level: 'L1' | 'L2' | 'L3' | 'NONE'
  certified: boolean
  unmetCount: number
}
interface TrialFacts {
  outcome: string
  full: boolean
  coveredSteps: number
  totalSteps: number
  failureCode?: string
  draftSaved?: boolean
  degradedSteps?: number
}
interface ComposeFacts {
  saved: boolean
  nodeCount: number
  staticOk: boolean
  staticCodes: string[]
  staticErrorCount: number
  staticWarningCount: number
  terminalStepMissing?: boolean
  coverageGap?: number
  blockCounts?: Record<string, number>
  trial?: TrialFacts
  goal?: GoalFacts
}
interface ReplayFacts {
  ran: boolean
  ok: boolean
  verified: boolean
  proven?: boolean
  outcome: string
  coveredSteps: number
  totalSteps: number
  failureCode?: string
  goal?: GoalFacts
  repair?: { attempted: boolean; status: string; attempts: number; committed: boolean }
}
interface GenerationAttemptRecord {
  at: number
  attemptId: string
  round?: number
  buildStampHash?: string
  model?: { name?: string; temperature?: number }
  origin?: string
  compose?: ComposeFacts
  replay?: ReplayFacts
  failureKind?: WorkflowFailureKind
  pass: boolean
  score: number
}
```

- `normalizeGenerationAttempt`：非法即丢弃，不抛。
- `mergeGenerationAttempt`：`compose` / `replay` 分块覆盖，重算 `pass` / `failureKind` / `score`。
- `attemptId`：已保存 workflow 的 id，否则 conversationId；一轮 compose→verify→repair 合并成一条。

### 4.2 分数

| 项       | 权重 | 条件                                                                   |
| -------- | ---- | ---------------------------------------------------------------------- |
| 保存     | 0.10 | `compose.saved`                                                        |
| 静态校验 | 0.15 | `compose.staticOk`                                                     |
| 试跑进度 | 0.15 | `coveredSteps / totalSteps`（有 replay 用 replay，否则 compose trial） |
| 回放通过 | 0.20 | `replay.verified`（干净、完整、非 cutoff）                             |
| 目标达成 | 0.40 | 仅在 `replay.verified` 时计：L3=1 · L2=0.6 · L1=0.3 · NONE=0           |

- `score = round(value * 1000) / 1000`，保证离线复算严格相等。
- `pass = replay.ok && replay.verified && (goal === undefined || goal.certified)`；
  legacy 语料行直接沿用 `verdict.pass`。

### 4.3 失败归类

优先级：`replay.failureCode`（去掉 `(visible)` 等后缀后走 `kindFromFailureCode`；
`UNRESOLVED_INPUT` 显式补 `dataflow`）→ goal 未达成 → `goal-verification` →
generate 且缺终止保存 → `intent` → compose 错 → `graph` → cutoff → `side-effect` →
harness / 配额 / 网络 → `environment` → ok 无标签。

### 4.4 存储

`src/lib/workflow/generation-attempt-store.ts`：`fileStorageArea()`、key `bc_generation_attempts`、
500 条 / 30 天、按 `attemptId` upsert、best-effort 绝不抛。写失败返回内存合并结果，调用方不受影响。

### 4.5 发射点

- **主落点** `composeWorkflowFromDraft`（面板 + bridge）：静态报告、错误/警告数、trial、goal、
  saveWarnings、graph 统计折叠成 compose 记录。
- **补充** `workflow-generation-bridge.ts`：取消、compose 失败、`replayOnce` 的 replay 事实、
  `repairOnce` 的 repair 合并。compose 成功不重复写。
- 面板“运行”按钮的 auto-repair 不记：那是运行遥测，与“一次生成尝试”不是同一单位。

### 4.6 语料与脱敏

- 导出 `tmp/selftest-round{2..83}.json` → `tests/fixtures/generation-eval/round-NNN.json` + `manifest.json`。
- legacy 映射：trial←`trialRun`；static←`saveWarnings` 方括号码与已知短语码；
  verify←`verdict.verified/proven`；goal←`goalLevel/goalCertified`；
  repair←`repairStatus/repairAttempts/repairCommitted`；graph←`nodeCount` 与 nodes（58/82 轮存在）。
- 丢弃：墙钟、conversation / workflow / node / run / failed / cutoff id、名称、goal summary、
  node intent / words / label 文本、saveWarnings 自由文本、verification 句子、goal reason / unmet 文本、
  URL 的 path/query/hash。
- 保留：blockId / action / sourceMode / 去字面量的 selector、block 计数、trial 计数与失败码、
  goal level / certified / unmetCount、repair 状态、`sha256(buildStamp)` 前 12 位、model 名与温度、round 号。
- `assertFixtureSafe` 拦截 UUID、邮箱/手机号、带 query 的 URL、`id/conversationId/runId` 键、超长 CJK 串。

### 4.7 报告与回归

- `scripts/generation-eval.mjs`（`pnpm eval:generation`）：读 fixtures，打印计数、tier 命中、
  平均分、failureKind 分布、Wilson 95% 区间（pass/L3）、种子固定的 bootstrap 95% 区间（平均分）。
- 脚本通过 `scripts/load-ts-module.mjs`（Vite SSR）复用 TS 评分，不复制逻辑。
- `tests/generation-eval.spec.ts`：fixture 可 normalize、分数复算相等、summary 与 manifest golden 严格相等、
  脱敏扫描全绿、五类 legacy 映射断言。

---

## 5. 影响面与兼容性

- 不改 `src/lib/workflow/storage.ts` 的 settings 白名单：记录存独立 key。
- 不改保存语义：`composeWorkflowFromDraft` 的返回值只增 `facts` / `attempt`，既有调用方忽略。
- bridge 结果新增 `attempt`，但 `generate_workflow` / `verify_workflow` / `repair_workflow` 是
  `BRIDGE_ONLY_TOOLS`，不进 round-1 预算；仍跑 `tests/agent-payload-size.spec.ts` 确认。
- `src/lib/**` 是 chrome-free，server 侧白名单已包含，无需改 `server/tsconfig.json`。

---

## 6. 验收标准

- `pnpm typecheck`、`pnpm test`、`pnpm lint`（按 `git ls-files` 圈定）、`pnpm format:check`、
  `pnpm build`、`pnpm server:typecheck`、`pnpm server:test` 全绿。
- 82 个 fixture + manifest；`--check` 确定；无泄漏。
- CLI 输出：pass 9/82、L3 3/82、verified&&proven 19/82、缺口 40/82、平均分与 manifest 相等。
- compose 测试证明面板路径也落记录；bridge 测试证明一轮只落一条合并记录，store 失败不改变结果。
- live `pnpm selftest` 出现 `attempt`，或如实标 BLOCKED 与原因。

---

## 7. 风险

| 风险                 | 缓解                                             |
| -------------------- | ------------------------------------------------ |
| 共享工作树有他人改动 | 隔离 worktree；只 add 明确路径                   |
| 语料泄漏             | 只留结构字段；`assertFixtureSafe` + 全量扫描     |
| legacy 字段稀疏      | static 用已记录警告而非重跑；跨时代分数不可比    |
| 过度解读 n=82        | 文档 + Wilson / bootstrap 区间；只作回归与排序   |
| 权重变化             | 有意让 fixture 回归失败，必须显式重生成 manifest |

---

## 8. 本轮不做

- Best-of-N、课程学习、prompt 进化、`policy-tuner` 接线。
- 面板运行按钮的 auto-repair 运行遥测。
- UI / i18n / 任何 RL 或微调。

---

## 9. 已提交的基线 · Measured baseline

下表的每个数字都由 committed fixtures 离线复算得到，`tests/generation-eval.spec.ts` 会把它与
`manifest.json` 的 `golden` 块逐字段比对：任何评分或语料改动都会让 CI 直接变红，而不是悄悄漂移。

```
generation eval corpus — 82 attempts (rounds 2–83)

pass                9/82      11.0%  Wilson 95% [5.9%, 19.6%]
goal-certified L3   3/82      3.7%  Wilson 95% [1.3%, 10.2%]
verified && proven  19/82     23.2%
coverage gaps       40/82     48.8%
mean score          0.331     bootstrap 95% [27.7%, 38.6%]

certified tiers               L1 0 · L2 0 · L3 3 · NONE 0

failures by kind:
  graph               29
  goal-verification   15
  intent              14
  readiness           6
  environment         4
  dataflow            2
  unknown             2
  side-effect         1
```

对应的 `manifest.json` golden：

```json
{
  "count": 82,
  "missing": [1],
  "excluded": { "from": 84, "to": 112, "reason": "429 quota + concurrent src edits" },
  "golden": {
    "total": 82,
    "pass": 9,
    "passRate": 0.1098,
    "l3Certified": 3,
    "verifiedAndProven": 19,
    "coverageGapRounds": 40,
    "meanScore": 0.331,
    "passInterval": { "low": 0.0588, "high": 0.1956 },
    "l3Interval": { "low": 0.0125, "high": 0.1021 },
    "meanScoreInterval": { "low": 0.2769, "high": 0.3862 },
    "byGoalLevel": { "L1": 0, "L2": 0, "L3": 3, "NONE": 0 }
  }
}
```

读法（不要把 `mean score` 当成功率）：

- `pass 11.0%` 的 Wilson 上界只有 19.6%，所以「11% → 20%」这种量级的改善在这个样本量下**无法**
  与噪声区分；下一刀若声称提升，必须先给出同协议的新轮次。
- 73 个失败里有 29 个是 `graph`、15 个 `goal-verification`、14 个 `intent`：这三类就是下一刀要瞄准的
  「可修」表面，其余 15 个（readiness / environment / dataflow / side-effect / unknown）多数不是单次提示词
  能解决的。
- `mean score 0.331` 高于 `pass 11%` 是设计使然：序数分给保存、静态校验和试跑进度部分信用，它排序尝试，
  不预测通过。
- 跨时代不可比：82 轮全部来自 legacy selftest 协议，部分轮次没有 nodes / replay 明细，
  新协议的轮次只能与同协议轮次比较。
