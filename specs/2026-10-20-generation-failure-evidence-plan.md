# Round A 落地计划 · Generation failure evidence & rerun boundary

- 日期：2026-10-20
- 对应设计：`specs/2026-10-20-generation-failure-evidence-design.md`
- 状态：**实施中** —— Step 0–5 已完成（未提交），Step 6 待做
- 范围：Round A —— 失败证据包、重跑边界、目标判定落盘
- 不含：Round B（`specs/2026-10-20-generation-chain-edit-loop-design.md`）、goal 契约可信度

---

## 0. 落地前必须知道的三个坑 · Read before touching code

这三个都是**静默失败**型的：代码能编译、测试能绿、功能却没生效。

### 坑 1：`settings` 是白名单持久化的 —— 新字段不加就丢

`src/lib/workflow/storage.ts:96-177` 的 `asWorkflow` 对 `settings` **逐 key 白名单**重建：
`saveLog` / `debugMode` / `notification` / `reuseLastState` / `defaultColumnName` /
`provenance` / `reliabilityMode` / `goalSpec` / `generationOriginUrl` / `pageContext` /
`defaultWaitMs` / `saveWarnings` / `generationStages` / `certificationStatus` /
`seededFrom` / `takeoverOnRun` / `degradeReplay` / `trialRun`。

**白名单外的 key 在 `saveWorkflow`（`storage.ts:238` 走 `asWorkflow`）时被丢弃。**
A3 要写的 `settings.goalVerification` 若不同时加进白名单，会出现"运行时写进去了、
存盘后没了、UI 读不到"的假成功。**Step 5 必须同时改 `types.ts` 与 `storage.ts`，并有一条
save→load 往返测试兜底。**

### 坑 2：`COMMIT_BLOCK_IDS` 不是 export —— 且**不需要**导出

- `src/lib/workflow/trial-run.ts:221` `const COMMIT_BLOCK_IDS` —— 未导出
- `src/lib/tool-error.ts:25` `const RECOVERY` —— 未导出

实施结论：两者**都不需要导出**。

- 边界判定直接复用已导出的 `isUnsafeNode`（`trial-run.ts:206`）与 `isDraftSaveNode`
  （`trial-run.ts:563`）——它们正是试跑截断用的那一对判据，导出即可用，
  **不必**再把 `COMMIT_BLOCK_IDS` 拉进来造第二套"提交类"定义（`agents.md` §5.2）。
- `RECOVERY` 不再需要：证据包只带**领域分类**（`failureCode` / `category` / `failureHint` /
  `recoverable` / `aiRepairable`），粗分类与固定恢复建议仍由工具结果信封
  （`src/background/agent.ts:5288` → `src/lib/tool-error.ts`）统一提供，
  同一条事实不出现两份（见 Step 1 的"导出形状"）。

### 坑 3：仓库的 `pnpm lint` 裸跑会硬失败

`pnpm lint` 会扫到 `tmp/ci-surface` 的 tsconfig 而硬失败（既有状态，非本轮引入）。
**门禁必须按 `git ls-files` 圈定范围**：

```bash
git ls-files -z 'src/**' 'server/**' 'tests/**' 'scripts/**' | xargs -0 npx eslint
```

prettier 同理用 `npx prettier --check .`（`tmp/` 已在 `.prettierignore` 之外，但 `tmp/` 在
`.gitignore`，prettier 默认忽略 gitignored 目录，裸跑是安全的）。

---

## 1. 阶段划分 · Steps

每一步**独立可交付、独立可回退**，按顺序做，不合并提交。

### Step 0 — 基线可复现化（不改产品代码）

**为什么先做**：验收要对比 before/after，而 before 现在只存在于 84 个 gitignored 的 JSON 里，
无法复算。

| 项   | 内容                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 | `scripts/selftest-corpus-stats.mjs` —— 读 `tmp/selftest-round*.json`，输出：轮数 / `verdict.pass` / `goalCertified` / `verified&&proven` / stage 分布 / `repairStatus` 分布 / 失败原因 Top-N |
| 约束 | 零依赖、只读、不写文件；读不到 `tmp/` 时打印一行提示并 `exit 0`（不阻塞任何门禁）                                                                                                            |
| 产出 | 把当前输出贴进设计文档，作为 before 基线                                                                                                                                                     |

**测试**：手工跑一次，输出与本计划 §3 的基线表一致。

---

### Step 1 — 失败证据包（纯函数，零行为改变）✅ 已完成

| 项   | 内容                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 | `src/lib/workflow/operator-failure.ts`                                                                                                            |
| 改动 | 无（`src/lib/tool-error.ts` **不需要**改：证据包不带走 `errorType` / `suggestedRecovery`）                                                        |
| 依赖 | `classifyFailureMessage`（`failure-code.ts:220`）与 `FAILURE_TABLE` → `failureCode` / `category` / `failureHint` / `recoverable` / `aiRepairable` |

**导出形状**（与设计文档 §A1 一致）：

```ts
export interface OperatorFailureEvidence {
  failureCode: OperatorFailureCode
  category: FailureCategory
  failureHint: string
  recoverable: boolean
  aiRepairable: boolean
  errorMessage: string
  locatorResolution?: { usedSpec: string; usedFallback: boolean; matched: number }
  candidateCounts?: { selector: string; count: number }[]
  pageState?: { url: string; title?: string }
  safeRerunBoundary?: RerunBoundary
}
```

**体积上限（硬约束）**：

- `errorMessage` 截断 **200 字符**（与 `tool-error.ts:122` `recentFailedAttempts` 对齐）
- `candidateCounts` 最多 **8** 条
- `locatorResolution` **只透传白名单字段**，不整体透传 `outcome.resolution`

**导出函数**：

```ts
export function buildOperatorFailureEvidence(input: {
  errorMessage: string
  code?: OperatorFailureCode
  resolution?: { usedSpec: string; usedFallback: boolean; matched: number }
  candidateCounts?: readonly number[] | null
  candidateSelectors?: readonly string[]
  pageState?: { url: string; title?: string }
  safeRerunBoundary?: RerunBoundary
}): OperatorFailureEvidence
```

**测试**（`tests/operator-failure.spec.ts`，12 例全绿）：

- [x] 错误文本 `READINESS_TIMEOUT(visible): …` → `failureCode` 命中 `FAILURE_TABLE` 里的既有码
- [x] `errorMessage` 超过 200 字符时被截断到 200
- [x] `candidateCounts` 超过 8 条时被截断到 8，且 `selector` 与 `count` 不错位
- [x] `locatorResolution` 只含白名单键（断言 `Object.keys` 精确匹配）
- [x] 不可分类的错误 → `failureCode === 'UNKNOWN'` 且不抛异常
- [x] 调用方指定的码（前置拒绝）从同一张表取分类，不另造一份判定

---

### Step 2 — 重跑边界计算（纯函数）✅ 已完成

| 项   | 内容                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------- |
| 新增 | `src/lib/workflow/rerun-policy.ts`                                                                      |
| 改动 | 无——`isUnsafeNode`（`trial-run.ts:206`）与 `isDraftSaveNode`（`trial-run.ts:563`）已是 export，直接复用 |

**关键简化**：draft 的 `nodes` **就是 append 顺序**（`src/lib/workflow/draft-types.ts:44`
"Nodes in append order"），所以链序 = 数组序，**不需要** `trial-run.ts:154` `executionPath`
那种图遍历。保持简单。

```ts
export function safeRerunBoundaryOf(nodes: readonly WorkflowNode[]): RerunBoundary | undefined
```

**判定**：第一个"提交类"节点 = `isUnsafeNode(node) || isDraftSaveNode(node)`
（与 `trialCutoffNodeId` 同源）；边界 = 它**之前**的那个节点；没有提交类时取最后一个动作节点；
第一个动作即提交类 → `undefined`。

**测试**（`tests/rerun-policy.spec.ts`，10 例全绿）：

- [x] 链 A(click) → B(forms fill) → C(submit)：边界是 **B**
- [x] 链含 `javascript-code`：边界在它**之前**
- [x] 链含 draft-save：边界在它**之前**
- [x] 空链 / 只有 trigger：返回 `undefined`
- [x] 全是幂等节点：返回**最后一个**节点
- [x] `idempotencyOf` 的 `spec.idempotency` 覆盖生效

---

### Step 3 — 接入 operator-tool-run 与 agent ✅ 已完成

| 文件                                  | 位置                            | 改动                                                                                          |
| ------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/background/operator-tool-run.ts` | `OperatorRunResult`             | 失败分支加 `evidence?: OperatorFailureEvidence`                                               |
| 同上                                  | JS 权限拒绝                     | 带 evidence（`failureCode: 'PERMISSION_DENIED'`）                                             |
| 同上                                  | 定位解析为空                    | 带 evidence（`failureCode: 'LOCATOR_NOT_FOUND'`）                                             |
| 同上                                  | 未产出的大块数据                | 带 evidence（`failureCode: 'VALIDATION_FAILED'`）                                             |
| 同上                                  | 必填参数缺失（执行前 / 重写后） | 带 evidence（`failureCode: 'VALIDATION_FAILED'`）                                             |
| 同上                                  | 执行失败                        | 带 evidence（`failureCode` 来自 `classifyFailureMessage`，另附 `resolution` 与 probe 命中数） |
| `src/background/agent.ts`             | wf_op_* 结果                    | `JSON.stringify({ error: out.error, evidence: out.evidence })`                                |

**去重的结论（与原计划不同）**：`enrichToolOutputError` **不需要改**。
证据包**不携带** `errorType` / `suggestedRecovery`——那两���字段仍由信封统一提供，
与所有其他工具失败保持同一形状；同一条事实不出现两份。

**这 6 个失败点共用一个构造路径**：`failWithEvidence(...)`（`operator-tool-run.ts` 内），
6 处各调一次（`agents.md` §5.2）。JS 权限拒绝发生在 hydrate 之前，用
`getDraftSnapshot`（只读、不创建）取链快照。

**测试**（`tests/operator-failure-integration.spec.ts`，7 例全绿）：

- [x] 执行失败分支：结果含 `evidence`，`evidence.failureCode` 非空
- [x] 4 类前置拒绝分支：同样含 `evidence`
- [x] 成功路径**不**含 `evidence`
- [x] 证据里的 `safeRerunBoundary` 指向"最后一个没有提交任何东西的步骤"
- [x] 工具结果的 `error` 字段内容与改动前一致（向后兼容）

---

### Step 4 — prompt 规则 ✅ 已完成

`src/background/agent.ts` 的 workflow-mode 段落，加一条边界规则。

**约束**：`tests/agent-payload-size.spec.ts` 的 byte 预算已压到个位数余量。
**净增不得超过现有余量**；超了就从同段落里合并既有句子，**不要**去改测试里的预算数字
（那属于"用改测试来通过"）。

**实际落地文案**：

> NEVER RE-RUN A COMMITTED STEP (submit / publish / save draft): if an earlier step was wrong,
> name it, do not repeat that call.

**为它腾出的字节**（同段落内压缩，规则一条未减）：
`the draft you build IS` → `the draft IS`；`… are not offered here because they would record nothing`
→ `… are not offered because they record nothing`；`when none can express` → `if none can express`；
`which runs AND records the script` → `(it runs AND records)`；`waits — use it when the page must settle`
→ `waits when the page must settle`；`from the first round` → `from round one`；`all become nodes`
→ `become nodes`。

**实测**：system prompt 15_271 → 15_322（**+51**），round-1 总量 59_835 → 59_886（预算 59_900），
单类别最大（interaction）37_080（预算 37_100），全量 60_933（预算 61_000）。**未修改测试里的预算数字。**

**测试**：`tests/agent-payload-size.spec.ts` 仍绿。

---

### Step 5 — 目标判定落盘 `goalVerification` ✅

| 文件                                                  | 行                           | 改动                                                                                                             |
| ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/lib/workflow/goal-verification-record.ts`（新）  | —                            | `WorkflowGoalVerification` 形状 + `normalizeGoalVerification` 守卫（不合法即丢弃，不抛异常）                     |
| `src/lib/workflow/types.ts`                           | `WorkflowSettings`（`:151`） | 新增 `goalVerification?: WorkflowGoalVerification`                                                               |
| **`src/lib/workflow/storage.ts`**                     | **白名单（`:96-177`）**      | **加 `goalVerification` 的 per-key 类型守卫**（坑 1）                                                            |
| `src/background/operator-tool-handler.ts`             | compose 流程                 | 把判定结果写进 `workflow.settings.goalVerification`；新增 `trialFailedWarning` / `goalUnmetWarning` 两条不同文案 |
| `src/lib/workflow/goal-rows.ts`（新）                 | —                            | `unmetGoalRows` 放在 **chrome-free** 的 lib 层：compose 侧与运行侧 bridge 共用同一份"未达成行"的读法，不漂移     |
| `src/background/workflow-engine/goal-verification.ts` | `VerificationReport`         | **不新增类型**，只做裁剪映射；`unmetGoalRows` 已移到 lib 层（否则 bridge 的单测 mock 会缺这个导出）              |

**落盘时机**：`composeWorkflowFromDraft` 在试跑之后已有判定材料；
`certifyReplayGoal`（`src/background/workflow-generation-bridge.ts`）在**运行侧**算。
本轮把 compose 侧能拿到的判定（试跑结果 + goalSpec 现场求值）落盘；
运行侧的 L3 判定仍由 bridge 负责，**不新增第二套判定**。

**`goal-rows.ts` 为何放 lib 层**：`unmetGoalRows` 需要读 `VerificationReport`，而该类型住在
`src/background/workflow-engine/`（其模块依赖 `driver`，非 chrome-free）。把它放进同一模块会让
bridge 的单测 mock（`tests/workflow-generation-bridge.spec.ts` 手写该模块的替身）缺导出，
在 bridge 里抛错并静默返回 `undefined` —— **一个只报 undefined 的失败**。改为 lib 层后：
`goal-rows.ts` 只依赖结构类型（`GoalRowReport`），无 chrome 依赖、无 mock 缺口，
compose 与 bridge 读的是同一份实现。

**测试**（`tests/goal-verification-persist.spec.ts`，5 条全绿）：

- [x] **`saveWorkflow` → `getWorkflow` 往返后 `settings.goalVerification` 仍在**（防坑 1）
- [x] 目标未达成（`certified === false`）时，工作流**仍然被保存**（不阻断）
- [x] `saveWarnings` 里"试跑失败"与"目标未达成"是两条**不同**的文案
- [x] `goalVerification` 字段非法时（不是对象 / level 不在枚举内）被白名单丢弃，**不抛异常**
- [x] `goalUnmetWarning` 对 `certified === true` 与 `level === 'NONE'` 返回 `undefined`

---

### Step 6 — 真实浏览器验证

| 项   | 内容                                                                                |
| ---- | ----------------------------------------------------------------------------------- |
| 命令 | `pnpm selftest`（真实 Chrome：build → reload → generate → replay/repair → verdict） |
| 轮数 | **n ≥ 10**                                                                          |
| 产物 | `tmp/selftest-report.json` + `tmp/selftest-round*.json`                             |
| 统计 | `node scripts/selftest-corpus-stats.mjs [--from N] [--to N] [--exclude <子串>]`     |
| 对比 | 与 Step 0 的 before 基线并排写进设计文档                                            |

**统计脚本的三个开关**（Step 6 实施时补上）：

- `--from N` / `--to N`：按文件名里的轮号圈定区间。语料是**累积**的，before 与 after 混在一起
  就没有对比可言，轮号是唯一的先后顺序。
- `--exclude <子串>`：剔掉**没走到产品**的轮次（provider 配额耗尽、浏览器掉线）。
  这类轮次量的是环境，不是链路；混进去会让产品对比失去意义。

**判定标准**：本轮**不承诺成功率提升**（Round A 的目标是"让失败可诊断 + 让目标判定可见"，
不是"提高成功率"）。硬性要求是：

- 新的 stage 分布里，`cutoff` 与 `generate` 占比**不上升**（若上升，说明证据包让模型更犹豫了）
- 失败原因 Top-N 里出现**新的可诊断类别**（例如"目标元素不在页面"与"前序步骤缺失"被区分开），
  这才是 Round A 的实际产出
- **不得**在没有 n ≥ 10 的并排数据前写"成功率提升"

#### Step 6 的最终形态：A/B 两臂，而不是"改动前 vs 改动后"

跑完基线才发现：**共享工作区里另一个 agent 正在并发改同一条生成链路**，所以
"改动后的语料"里混着别人的在途代码，直接拿它和 Step 0 的 before 基线比，
测的是两件不同的事（rounds 95–121 就是这么来的：0/20 pass、`cutoff` 占比
14% → 55%，但这个变化**不能**归因到 Round A）。

于是 Step 6 改成两臂对照，两臂都跑在**当前 HEAD** 上：

| 臂       | 代码                | 轮次    | 位置                         |
| -------- | ------------------- | ------- | ---------------------------- |
| `arm-a2` | HEAD + Round A 改动 | 120–129 | `tmp/arm-a2`（git worktree） |
| `arm-b2` | HEAD（无 Round A）  | 130–139 | `tmp/arm-b2`（git worktree） |

两臂原建在 `62f571f` 上；因为切 provider 需要 `4fd3ae1` 的多 provider Settings UI，
两臂已整体重建在 **`4fd3ae1`** 上（补丁无冲突重放，关键文件 `src/lib/workflow/storage.ts`
的 `normalizeGoalVerification` import 补齐）。源码指纹必须不同
（`74168001377b003f` vs `71bd364678147554`），否则这个对照测的是同一份代码。
扩展从 `dist/` 加载，而 `dist/` 是**共享**的，所以每轮开始前把该臂的 `dist/` 覆盖过去，
轮次用该臂自己的 worktree 跑 `scripts/selftest.mjs --skip-build`。

**A/B 直接抓到的缺陷**：`arm-a` 的补丁漏了 `src/lib/workflow/storage.ts` 里
`normalizeGoalVerification` 的 import。`vite build` 不做类型检查（esbuild 只剥类型），
所以构建**成功**、扩展照常加载，直到第 16 个节点之后的 compose 阶段才抛
`normalizeGoalVerification is not defined`——一轮 20 分钟白跑。

> 教训（写进流程，不写进代码）：**worktree 补丁要先 typecheck 再进 A/B**。
> arm-a 漏掉的那一行，在共享树上 `pnpm typecheck` 是绿的——因为共享树有这行，
> 补丁没有。缺陷在"补丁"里，不在产品里。

#### 语料里能读到的唯一算子级指标

语料只保存组合出来的 workflow 与 verdict，**不保存算子调用的 tool result**，
所以"证据包有没有让模型更会诊断"不能直接从语料读出来。语料里唯一留存的算子级
痕迹是 `saveWarnings` 里的**生成覆盖缺口**：

```
Generation coverage gap: N operator step(s) failed during generation and were not retried
```

这正是"生成期失败、且没有重试成功"的算子步数——证据包要影响的正是它
（模型拿到了失败分类 + 可重跑边界，才有机会把失败的步救回来，而不是把洞留在
工作流里）。统计脚本已加一行 `generation gaps`（多少轮有缺口 / 一共多少个未救回的步）。
该 warning 是 B1 既有机制，**两臂都有**，所以它可对比。

**实施中遇到的外部阻塞**（不属于产品缺陷，但要记进结论）：

- 同一工作区有另一个 agent 并发改 `src/` → 源码指纹每分钟变化，"build → reload → 比对指纹"的
  闭环无法收敛，轮次会测到在途代码。
- 扩展 service worker 在 reload 后长时间不回连适配器 → 需要人在浏览器点一次 reload。
- MiniMax 429「已达到 Token Plan 用量上限」→ 连续 11 轮秒挂在生成前；加 150s 退避后恢复。
  **2026-10-20 18:38 再次撞墙**：两臂重建到 `4fd3ae1` 后第一次（round 120）仍在 10 秒内
  被同一 429 拒绝，说明配额没有恢复。A/B 需要先换 provider（Settings → 模型 Provider），
  两臂必须用同一个 provider，否则对照混入变量。
- 已实测的语料事实：`failureHint` / `candidateCounts` **不落盘**（bridge 驱动的生成不持久化
  会话，LevelDB 里只有 action history 与 `saveWarnings`），所以"证据包是否让模型更会诊断"
  只能通过上文的生成覆盖缺口与 verdict/stage 分布间接观察。

---

## 2. 提交切分 · Commits

按 `agents.md` §1，提交信息用英文 Conventional Commits。

| #   | 提交                                                               | 包含                                                              |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | `chore(workflow): add selftest corpus stats script`                | Step 0                                                            |
| 2   | `feat(workflow): compute safe rerun boundary for generation`       | Step 2（先于 Step 1：证据包 type-only 引用它，反序过不了 tsc）    |
| 3   | `feat(workflow): add operator failure evidence bundle`             | Step 1                                                            |
| 4   | `feat(workflow): return failure evidence to the generating model`  | Step 3 + Step 4                                                   |
| 5   | `feat(workflow): persist goal verification on generated workflows` | Step 5                                                            |
| 6   | `docs(workflow): record round A baseline and A/B protocol`         | Step 6 的文档（after 数据仍 BLOCKED，只有协议与阻塞记录）         |

**每次提交前跑全绿**（见 §4），且**在临时 worktree 里验证提交树**
（`agents.md` 收尾自检 ⑨；本仓库是共享工作区，可能有并发改动）。

---

## 3. 测试清单 · Test checklist

### 单测（新增文件）

| 文件                                         | 覆盖                                               |
| -------------------------------------------- | -------------------------------------------------- |
| `tests/operator-failure.spec.ts`             | Step 1：码归类、截断、体积上限、白名单键           |
| `tests/rerun-policy.spec.ts`                 | Step 2：边界判定六条                               |
| `tests/operator-failure-integration.spec.ts` | Step 3：6 个失败点、去重、向后兼容                 |
| `tests/goal-verification-persist.spec.ts`    | Step 5：**save→load 往返**、不阻断保存、文案可区分 |

### 既有测试必须仍绿

- `tests/agent-payload-size.spec.ts`（Step 4 的 byte 预算）
- `tests/workflow-storage.spec.ts`（`asWorkflow` 白名单改动会牵动它）
- `tests/workflow-generation-benchmark.spec.ts`、`tests/bench/baseline-report.spec.ts`
  （生成链路被动了，这两个必须重跑并**记录新值**）
- `tests/reliability-benchmark.spec.ts`（`l3GoalAchieved` 断言）

### 门禁命令（每个提交前）

```bash
pnpm typecheck
pnpm test
pnpm build
git ls-files -z 'src/**' 'server/**' 'tests/**' 'scripts/**' | xargs -0 npx eslint
npx prettier --check .
pnpm server:typecheck     # 动了 src/lib/**，server 白名单含 ../src/lib/**/*.ts
pnpm server:test
```

---

## 4. 验收标准 · Acceptance

- [ ] §3 的门禁命令全绿，输出贴在 PR 描述里
- [ ] Step 0 与 Step 6 的统计并排（before / after），写进设计文档
- [ ] 新增 4 个测试文件覆盖上表全部条目
- [ ] `settings.goalVerification` 的 **save→load 往返测试存在**（坑 1 的直接防线）
- [ ] 未达成目标时工作流**仍然保存**（"保存永不失败"未被破坏）
- [ ] prompt 净增在 byte 预算内，**未修改测试里的预算数字**
- [ ] 提交信息全英文、Conventional Commits
- [ ] `git ls-files` 范围内无临时产物（探针输出、截图留在 `tmp/`）

---

## 5. 风险与回退 · Risks & rollback

| 风险                            | 触发信号                              | 缓解 / 回退                                                                                                                     |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 证据包撑爆 prompt 预算          | `agent-payload-size` 挂               | 先砍 `suggestedRecovery` 文案长度，不砍字段                                                                                     |
| 模型拿到证据后陷入长重试        | 轮次成本上升、`generate` 阶段占比升高 | 保留 `suggestedRecovery` 的 "retry once" 上限；观察 n≥10 的轮次分布                                                             |
| `goalVerification` 白名单漏加   | 往返测试失败                          | Step 5 的测试直接暴露；回退只需去掉该字段                                                                                       |
| `asWorkflow` 改动影响既有工作流 | `workflow-storage.spec.ts` 挂         | 白名单是**新增**键，不改既有键的守卫                                                                                            |
| 回退                            | 任何一条                              | 每个 Step 独立提交，`git revert` 单个 commit 即可回到上一状态；Round A 全量回退后行为与现状**完全一致**（不新增任何持久化行为） |

---

## 6. 本轮不做 · Explicitly out of scope

1. **draft chain 回改**（Round B）
2. **goal 契约可信度**：goal 成功条件仍由模型凭空写下、仍会被 `groundGoalSpecToGraph` 静默丢弃
   （`src/background/operator-tool-handler.ts:727-736`）。本轮只让"未达成"**可见**，不改变其可信度。
   → 这意味着 B3 的目标门控**只能是软门控**，且 goal 幻觉类失败（语料 15 轮）**不会被本轮治好**。
3. **定位稳定性**：位置型 CSS、就绪等待、异步元素——属独立主题。
4. **能力缺口**：`javascript-code` 逃生舱、`save-local` 对话框限制——属独立主题。
5. **DOM 级 rewind**：明确拒绝（设计文档 §4.2）。
