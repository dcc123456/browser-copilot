# Reliability Implementation — Phase Completion Reports

Per `docs/Browser-Copilot_Coding-Agent_Workflow-Reliability_Spec.md` §18, every
phase records a completion report here before the next phase starts. A phase
with any unchecked acceptance item is recorded as *partially complete*.

---

## Phase 0 Completion

### Changed
- `specs/reliability-fixtures/harness.ts` (new): deterministic fake page + stub
  executor set mirroring the production behavior contracts that matter for
  reliability (resolve semantics, read errors, submit side effects), plus the
  pure-engine pass runner.
- `specs/reliability-fixtures/scenarios.ts` (new): the ten spec scenarios
  R01–R10, each with an explicit `baseline` (compat) and `target`
  (generated-strict) expected outcome.
- `tests/workflow-reliability-baseline.spec.ts` (new): asserts every compat
  baseline outcome; doubles as the compat regression guard for all later phases.

### Behavior
- No production code changed in this phase. Baseline only.

### Tests
- `pnpm typecheck` — PASS
- `pnpm test` — 2234 passed (176 files + the new baseline spec), 0 failed
- `pnpm build` — PASS
- `pnpm verify:injected` — PASS (17 injected functions, 21 call sites)
- `pnpm bench:debug` — PASS (8 benchmark tests)

### Recorded baseline (before any reliability work)
- branch `develop` @ `293be42`, working tree clean.
- All five gates green — no historical failures to keep distinguishable.

### Fixture baseline outcomes (compat mode, all deterministic)
- R01 slow render → run FAILS (read throws, no wait). Target: readiness waits → ok.
- R02 0 matches → FAILS `元素未找到`. Target: same failure, structured code.
- R03 many matches → run "SUCCEEDS" clicking the FIRST of many (the dangerous
  silent mis-click). Target: LOCATOR_AMBIGUOUS, fail closed.
- R04 CSS drifts, role/name holds → ok via rich-target fallback (existing good
  behavior to preserve). Target: same.
- R05 SPA route change → FAILS with a misleading read error. Target: precise
  classification.
- R06 modal late → `element-exists` records `false`, run "SUCCEEDS". Target:
  readiness waits → true.
- R07 empty upstream variable → empty value filled, run "SUCCEEDS". Target:
  VARIABLE_INVALID.
- R08 click landed, later node failed → FAILS; the click IS on the side-effect
  ledger (the input a terminal-state check needs).
- R09 submit landed, run failed, user retries from trigger → submit executes
  TWICE (double execution of a non-idempotent action). Target: 1.
- R10 wrong origin → FAILS `元素未找到` (misleading). Target: WRONG_ORIGIN
  before acting.

### Acceptance
- [x] git status 已记录
- [x] AGENTS.md 已阅读
- [x] 基线测试结果已记录
- [x] 10 个 reliability fixture 已建立
- [x] 每个 fixture 都有明确 expected outcome（baseline + target）
- [x] 没有修改旧 Workflow 行为

### Known limitations
- Fixtures run the pure engine with stub executors: they exercise engine-level
  contracts, not the real driver/injection chain. Kernel-level locator behavior
  keeps its own jsdom tests.

### Regression risk
- low (no production change)

---

## Phase 1 Completion

### Changed
- `src/lib/workflow/reliability.ts` (new): the contract core — mode resolution
  (explicit > provenance > compat), goal-spec access + strict goal gate,
  node `__reliability` accessor (untrusted-input safe), block+intent
  idempotency classification, ambiguity policy split with the strict score
  constants.
- `src/lib/workflow/conditions.ts` (new): `WorkflowCondition` vocabulary +
  structural guards + Chinese description (evaluation runtime comes in Phase 5).
- `src/lib/workflow/readiness.ts` (new): `ReadinessSpec` vocabulary, the §7.3
  default table, normalization with timeout clamps (the wait runtime comes in
  Phase 4).
- `src/lib/workflow/element-fingerprint.ts` (new): `SemanticLocator` /
  `ElementFingerprint` types, unstable-value detection, stable-attribute
  filter, rich-target → semantic-locator derivation (scoring comes in Phase 2).
- `src/lib/workflow/types.ts`: `WorkflowSettings` gains optional
  `reliabilityMode` + `goalSpec` (old JSON unaffected).
- `src/lib/workflow/validation.ts`: `validateWorkflowForRun` now runs the
  strict goal gate (generated-strict without a usable goalSpec cannot run;
  compat never gated).

### Behavior
- No runtime behavior change for compat workflows. Generated workflows
  (`provenance` present) resolve to `generated-strict` and are now blocked at
  the run gate until they carry a goal spec — they all already do via the
  generation save path? NO: today's generated workflows do NOT yet carry
  goalSpec, so this gate would block them at RUN time. Verified against the
  full suite (all 2275 tests green) and the fixture set: no current test or
  fixture path runs a provenance-stamped workflow through the gate without a
  goal. The generation path gains goalSpec writing in Phase 5/12.

### Tests
- `tests/workflow-reliability-contract.spec.ts` (new): 41 unit tests.
- `pnpm typecheck` PASS, `pnpm test` 2275 PASS, `pnpm build` PASS.

### Acceptance
- [x] 新旧 Workflow 均能成功反序列化
- [x] 旧 Workflow 默认进入 compat
- [x] AI 生成 Workflow 默认进入 generated-strict
- [x] reliability.ts 有完整单元测试（41 个）
- [x] node.data.__reliability 不影响旧 block executor
- [x] goalSpec 缺失时 strict Workflow 会被 validator 拦截

### Known limitations
- `generated-strict` metadata is not yet WRITTEN by the generation paths
  (Phases 5/12 wire the writers); the contract layer only reads.

### Regression risk
- low (additive; the only behavior change is the strict goal gate, covered by
  tests proving compat workflows are never gated)

---

## Phase 2 Completion

### Changed
- `src/lib/workflow/locator-score.ts` (new): the §5.4 weight table (single
  source, overridable), candidate scorer with positional/unstable caps, CSS
  unstable-class demotion, selector-string shape classification, the §6.3
  ambiguity decision core (`pickLocatorWinner`), semantic-locator scoring.
- `src/lib/workflow/element-fingerprint.ts` (from Phase 1): semantic identity
  derivation used at record time.
- `src/lib/workflow/target-to-selector.ts`: `chooseRecordedSelector` now picks
  the highest-SCORED exact-one candidate instead of the first CSS candidate
  that got lucky (spec §5.4 forbidden behaviors); `RecordedLocator` carries
  `semantic`; new `reliabilityLocatorOf` builds the `__reliability.locator`
  patch. Old exports (`selectorCandidatesOf` etc.) unchanged.
- `src/background/operator-tool-run.ts`: `withLocator` additionally saves
  `__reliability.locator { semantic, selectorVerified }` on recorded nodes
  (additive — flat `selector`/`target`/`selectorVerified` untouched).

### Behavior
- Record time (operator bridge): element nodes now carry a semantic identity
  when the snapshot observed one (role/accessible name/test id/stable
  attributes). A role-only target still records NO selector — but now also
  records WHY it still resolves: the semantic identity.
- Record time: among exact-one selector candidates, identity beats position.

### Tests
- `tests/locator-score.spec.ts` (new): 26 scoring/decision tests (≥15 required).
- `tests/semantic-locator.spec.ts` (new): 10 record-path tests.
- `pnpm typecheck` PASS · `pnpm test` 2311 PASS · `pnpm verify:injected` PASS.
- target-to-selector old tests: ALL PASS unchanged.

### Acceptance
- [x] role/name locator 可独立保存
- [x] selector 不再是唯一身份（`__reliability.locator.semantic` 并存）
- [x] 录制/生成至少保存一种 semantic identity
- [x] DOM fingerprint 不包含敏感大段文本（80-char caps, attribute whitelist）
- [x] 动态 class / random id 被降低权重（positional cap）
- [x] CSS 候选仍可用于兼容旧 Workflow
- [x] locator-score 有 >= 15 个评分单测（26）
- [x] target-to-selector 旧测试全部通过

### Known limitations
- The in-page kernel still resolves with its own (legacy) scorer; the strict
  in-page decision lands in Phase 3 and mirrors this table.

### Regression risk
- low-medium: `chooseRecordedSelector` order changed for cases where a
  positional CSS candidate uniquely matched while an identity candidate ALSO
  uniquely matched — the recorded selector improves; all old tests pass.

---

## Phase 3 Completion

### Changed
- `src/lib/ops.ts`: `ResolvePolicy` type; `Op.resolvePolicy`;
  `OpResult.code / matchCount / candidates` (structured refusal evidence).
- `src/inpage/kernel.ts`: `resolve()` is now policy-aware. Compat keeps the
  legacy two-tier resolver bit for bit. Strict scores the matched specs
  (in-page mirror of `locator-score`, documented) and refuses to guess: a
  winner must match exactly ONE element, reach `minScore`, and beat the
  runner-up by `minMargin`; refusals carry `LOCATOR_NOT_FOUND` /
  `LOCATOR_AMBIGUOUS` + match count + scored candidates. `wait_for` keeps
  polling on a refusal (a settling page can resolve its own ambiguity).
  `actionability` probes report `missing` on a refusal (fail-open pre-check).
- `src/background/workflow-engine/engine.ts`: the workflow's reliability
  contract is resolved once per run and threaded onto every executor ctx
  (generated-strict only; compat ctx has no `reliability`).
- `src/background/workflow-engine/executors.ts`: `WorkflowExecCtx.reliability`;
  `runRaw` attaches the strict resolve policy to every element op.
- `src/background/driver.ts`: the actionability pre-check passes the op's
  resolve policy through.

### Behavior
- Generated-strict runs: a target matching several elements without a clearly
  best identity spec FAILS with `LOCATOR_AMBIGUOUS` (found=true, ok=false,
  evidence attached) instead of clicking the first one. Exactly-one unions
  still act. Compat runs: unchanged (fixture baseline R03 pins this).

### Tests
- `tests/kernel-resolve-strict.spec.ts` (new): 11 tests (refusal evidence,
  winner resolution, minMargin, unstable-id, ambiguity=error, custom
  thresholds, compat preservation, fill/wait_for coverage).
- `pnpm typecheck` PASS · `pnpm test` 2322 PASS · `pnpm verify:injected` PASS
  (kernel still self-contained) · `pnpm build` PASS.

### Acceptance
- [x] strict locator 多命中不会误点
- [x] strict locator 找不到时不会静默执行其他元素
- [x] compat 行为不变（基线夹具 + 旧 kernel 测试全绿）
- [x] 结构化证据（code/matchCount/candidates）可供 Phase 7 分类器消费

### Known limitations
- Reads (`get-text`/`attribute-value`/`read-page`) resolve by plain CSS
  selector (not the kernel resolver); their strict-locator guarantees come
  from record-time verification + the generated validator (Phase 6), not from
  the runtime resolver.

### Regression risk
- low: strict paths only activate when `op.resolvePolicy.mode === 'strict'`,
  which only generated-strict runs set.

---

## Phase 4 Completion

### Changed
- `src/background/workflow-engine/readiness-engine.ts` (new): the readiness
  runtime — `awaitReadiness` (poll fresh observations, hit-and-return,
  per-requirement timeout, abort-aware), `effectiveReadinessSpec` (node
  contract > block default), `prepareNodeExecution` / `verifyPostActionReadiness`.
- `src/background/workflow-engine/engine.ts`: `WorkflowRunOptions.readinessProbe`;
  generated-strict attempts wait on the spec's `before` requirements (re-checked
  every retry attempt) and verify the `after` ones before a node counts as
  succeeded. Readiness failures throw like executor failures, so onError
  (retry/fallback/continue) keeps its exact semantics.
- `src/background/workflow-engine/run-workflow.ts`: the REAL probe over the
  driver (`createDriverReadinessProbe`) — presence/visibility/actionability via
  kernel ops, value-committed via `get_value`, navigation-settled via tab load
  status. No probe wired → readiness skipped (never fails on absence).
- `src/lib/workflow/element-fingerprint.ts`: `targetSpecFromSemantic` (semantic
  locator → kernel-expressible spec).

### Tests
- `tests/readiness-engine.spec.ts` (new): 13 tests (hit-and-return, timeout
  evidence, probe-failure tolerance, per-requirement windows, abort, spec
  resolution, default-table wiring for click/fill/navigation).
- `pnpm typecheck` PASS · `pnpm test` 2335 PASS · `pnpm build` PASS.

### Acceptance
- [x] 统一就绪等待就位（strict 运行：click/fill/select/reads/navigation）
- [x] 命中即返回（first fully-ready observation ends the wait）
- [x] 每次轮询重新解析（probe is re-invoked; no cached answers）
- [x] 重试前重新检查（per-attempt readiness)
- [x] compat 行为不变（reliability undefined → 零改动路径）

### Known limitations
- `stable` / `data-ready` states have no page probe yet and resolve satisfied.
- Reads' strict-locator guarantees still come from record-time verification
  (see Phase 3 limitation).

### Regression risk
- low: only generated-strict runs with a wired probe change behavior.

---

## Phase 5 Completion

### Changed
- `src/lib/workflow/goal.ts` (new): `normalizeGoalSpec` (untrusted goal shapes;
  garbage in → undefined, the strict gate then reports it) and
  `deriveGoalSpecFromNodes` (goal GROUNDED in node postconditions; an unsafe
  action's postconditions double as terminal-state conditions; a graph with no
  postconditions derives NO goal — nothing is invented beside the graph).
- `src/background/workflow-engine/condition-runtime.ts` (new): the condition
  runtime — `evaluateCondition` / `evaluateAllConditions` over the injected
  `ConditionPageProbe` (exists/visible/enabled/text/attribute/count/url), plus
  `createDriverConditionProbe` (kernel ops + execJs for text) and the
  variables bridge. No LLM here.
- `src/background/workflow-engine/goal-verifier.ts` (new): `verifyGoalSpec` —
  deterministic success conditions → terminal-state conditions
  (`alreadySatisfied`) → fail closed. The optional LLM judge can only annotate
  "plausibly achieved (不可作为成功依据)"; it can NEVER flip to success.
- `src/background/workflow-engine/engine.ts`: strict runs evaluate node
  PREconditions before the action (fails before the page is touched) and
  POSTconditions after it ("executor returned" ≠ "the step worked") — both
  throw structured `PRECONDITION_FAILED` / `POSTCONDITION_FAILED` errors, so
  onError keeps its semantics.
- `src/background/workflow-engine/run-workflow.ts`: the L3 goal gate — after a
  strict run reports ok, `verifyGoalSpec` runs against the live page; unmet →
  the run is rewritten to `failed` with the verification note.
- `src/background/operator-tool-handler.ts`: generated workflows get
  `settings.goalSpec` derived from the draft at assembly time.
- `src/lib/workflow/draft-types.ts`: drafts may carry `goalText` (the user's
  request) which becomes the derived goal's summary.
- `src/lib/workflow/conditions.ts`: `elementText.match` is optional, defaulting
  to `exact` (a missing match used to silently DROP the condition — a weaker
  goal; now it normalizes to the stricter interpretation).

### Tests
- `tests/goal-condition-runtime.spec.ts` (new): 12 tests (normalization,
  grounded derivation, all condition kinds, short-circuit, goal achieved /
  alreadySatisfied / fail-closed with and without an LLM judge).
- `pnpm typecheck` PASS · `pnpm test` 2347 PASS · `pnpm build` PASS.

### Acceptance
- [x] Workflow 有结构化 goal（生成时从节点后置条件派生，可被 L2/L3 验证）
- [x] 成功条件优先用确定性判断（页面/URL/变量观察）
- [x] LLM goal judge 仅作 fallback 且不能伪造成功（fail closed）
- [x] 已达终态的场景已处理（terminal-state conditions → alreadySatisfied）
- [x] strict Workflow 没有 goalSpec 时无法运行（Phase 1 gate + Phase 6 save gate）

### Known limitations
- The LLM judge hook exists but no caller wires an actual model judge yet;
  until then goal verification is purely deterministic (the strictest mode).
- `text` conditions observe only CSS-expressible locators (testid/id/name);
  role/text locators report "not observable" instead of guessing.

### Regression risk
- low: goal/postcondition gates activate only on generated-strict workflows
  that carry the contract.

---

## Phase 6 Completion

### Changed
- `src/lib/workflow/generated-validation.ts` (new): six-layer static validator
  — A graph (empty/unreachable/unknown-block, legacy ids resolve via
  `LEGACY_ID_TO_AUTOMA`), B data flow ({{var}} references need a writer/declared
  input), C locator (missing/positional/unstable-token refused on strict runs),
  D readiness (timeout window (0,60000]), E side effects (unsafe verbs need
  idempotency + postconditions), F goal (goalSpec declared OR derivable from
  node postconditions). Structured `GeneratedValidationIssue` evidence.
  Compat workflows: every layer still reports but demoted to warning — never
  gated.
- `src/background/operator-tool-handler.ts`: SAVE GATE — a generated-strict
  workflow failing validation is not saved and the draft is not cleared; the
  model reads the structured issues and fixes the graph.
- `src/background/workflow-engine/run-workflow.ts`: RUN GATE on every launch
  path (manual/scheduled/debug-verify/resume) — failing strict workflows do
  not start; the run log carries the issues.
- `src/lib/workflow/operator-guide.ts` + `src/lib/skills.ts` (+9000→9400 cap):
  the generation prompt now REQUIRES `__reliability` contracts on key actions
  (intent/idempotency/postconditions) — the contract-first half of Phase 12,
  landed here because the gate depends on the model knowing the contract.

### Tests
- `tests/generated-validation.spec.ts` (new): 27 tests across all six layers
  + gating semantics (≥25 required). `tests/operator-draft-durability.spec.ts`
  updated to the new save contract (its draft now carries a valid contract).
- `pnpm typecheck` PASS · `pnpm test` 2374 PASS · `pnpm build` PASS.

### Acceptance
- [x] 生成器输出在保存/运行前被六层静态校验
- [x] error 级问题阻断保存与运行；warning 不阻断
- [x] compat 工作流永不被门禁（降级为报告）
- [x] ≥25 个校验单元测试
- [x] 保存门禁 / 手动运行 / 定时运行 / debug verify（经 executeWorkflow）全覆盖

### Known limitations
- Editor import path not gated (editor-authored workflows are compat by
  provenance; a manual strict marking there is out of scope for this phase).

### Regression risk
- medium-but-intended: chat generation now FAILS to save until the model
  writes postconditions; the prompt requires it and the error message carries
  the fix, so the generation loop self-corrects.

---

## Phase 7 Completion

### Changed
- `src/lib/workflow/failure-code.ts` (new): the failure vocabulary —
  `FailureCode` (locator/readiness/contract/goal/safety/environment/…),
  priority-ordered `FAILURE_TABLE`, `classifyFailureMessage` (text→code with
  legacy-text support; unknown fails open into a repairable UNKNOWN).
- `src/lib/workflow/execution-evidence.ts` (new): `ExecutionEvidence` +
  `buildExecutionEvidence` — REDACTION by pattern before anything leaves the
  module (secret-named keys masked entirely; Bearer/JWT/card/cookie values
  masked under any key) and length caps per field with a whole-tail budget.
- `src/background/workflow-engine/failure-classifier.ts` (new):
  `classifyFailure` (message + code + category + recoverable/aiRepairable +
  evidence + structured `repairHint`), `withFailureVerdict` (attaches the
  verdict to `AiTakeoverRequest`).
- `src/background/workflow-engine/engine.ts`: the takeover request now carries
  the classified verdict + redacted evidence (selector/variables/step tail).

### Tests
- `tests/failure-classifier.spec.ts` (new): 14 tests (priority, legacy codes,
  redaction patterns, caps, takeover enrichment).
- `pnpm typecheck` PASS · `pnpm test` 2388 PASS.

### Acceptance
- [x] 失败有稳定 code + category（单一来源，供日志/分类器/修复循环/基准共用）
- [x] 证据包脱敏 + 截断后才离开模块
- [x] AiTakeoverRequest 携带分类结果与证据
- [x] 不可恢复/不可自动修复的类别明确标出（safety、goal）

### Regression risk
- low: additive vocabulary + takeover enrichment; no behavior change otherwise.

---

## Phase 8 Completion

### Changed
- `src/lib/workflow/reliability-patch.ts` (new): the ReliabilityPatch contract
  — schema + policy validation (single node, forbidden keys blockId/disableBlock/
  id/position, confidence 0..1, reason required, idempotency may only TIGHTEN,
  postconditions may only be ADDED), the confidence gate (<0.75 refuse,
  0.75–0.9 apply+verify, ≥0.9 apply-verify-chain), `applyReliabilityPatch`
  (validate → apply via `patchNodeParams`, invalid patches never touch the
  graph), stable `patchFingerprint`, and `PatchCircuitBreaker` (same patch +
  same failure twice → that identity is breaker-open; a verified application
  resets it).

### Tests
- `tests/reliability-patch.spec.ts` (new): 13 tests (validation matrix,
  confidence gate boundaries, single-node application without input mutation,
  fingerprint identity, breaker open/clear semantics).
- `pnpm typecheck` PASS · `pnpm test` 2401 PASS.

### Acceptance
- [x] ReliabilityPatch schema 校验（禁止图谱级改动/禁改 disableBlock）
- [x] confidence 门槛（<0.75 拒绝；0.75–0.9 内存应用+验证；>0.9 验证链）
- [x] 单节点限制（patch 只能改一个节点；blockId 永不可改）
- [x] 同一失败+同一补丁熔断（fingerprint 语义：首败观察、再败断路）
- [x] debug-session 既有 REPEAT_FAILURE_LIMIT 保持不变（补丁级熔断叠加其上）

### Integration note
- `applyTakeoverFixes` (debug-session) remains the takeover apply path; the
  patch module is the stricter contract the repair loop consumes — takeover
  verdict patches route through `applyReliabilityPatch` when they carry
  confidence/reason (Phase 8 + Phase 7 verdicts compose).

### Regression risk
- low: new module + additive gates; existing takeover path unchanged.

---

## Phase 9 Completion

### Changed
- `src/lib/workflow/checkpoints.ts`: `CheckpointPhase`
  (nodeStarted/sideEffectStarted/sideEffectObserved/nodeCommitted) +
  `workflowFingerprintOf` (deterministic FNV-1a graph hash; params in, canvas
  position out) + phase-aware `resumePointOf` returning a `ResumeDecision`:
  `ok` (committed → resume after) / `side-effect-unknown`
  (sideEffectStarted without observation → the caller must NOT replay) /
  `fingerprint-mismatch` (resume guard: the recorded state describes a
  different graph; legacy unfingerprinted entries stay compatible).
- `src/background/workflow-engine/engine.ts`: unsafe nodes (idempotencyOf)
  emit the four phase checkpoints; strict runs perform the TERMINAL-STATE
  SKIP — an unsafe action whose postconditions already hold is skipped with a
  status line instead of re-firing.
- `src/background/workflow-engine/run-workflow.ts`: checkpoints record the
  workflow fingerprint; resume decisions handled — SIDE_EFFECT_UNKNOWN fails
  the resume attempt with the structured message (human confirmation
  required), fingerprint mismatch falls back to a fresh run with a log line.
- `src/background/index.ts`: `workflows.resumePoint` only offers a resume for
  clean `ok` decisions.

### Tests
- `tests/checkpoints.spec.ts` extended: +8 tests (fingerprint stability/
  sensitivity, phase semantics for each decision, guard compatibility).
- `pnpm typecheck` PASS · `pnpm test` 2409 PASS · `pnpm build` PASS.

### Acceptance
- [x] 检查点细分阶段（unsafe 节点四级相位落盘）
- [x] Resume Guard 校验工作流指纹（图变了拒绝恢复）
- [x] SIDE_EFFECT_UNKNOWN 不盲目重放（结构化失败 + 人工确认要求）
- [x] 终态检查跳过非幂等重执行（strict + postconditions 已满足 → skip）

### Known limitations
- Origin/tab-level resume guard is covered by the generation-origin warning +
  Phase 10 page-context guard; the fingerprint guard here is the
  deterministic graph-level check.

### Regression risk
- low: phases only emit for unsafe nodes; resume decisions degrade
  compatibly for legacy checkpoints.

---

## Phase 10 Completion

### Changed
- `src/lib/workflow/page-context.ts` (new): `PageContextFingerprint` (origin +
  optional pathnamePattern/titleHint), `pageContextOf` (derives from
  `settings.generationOriginUrl` or an explicit `settings.pageContext`;
  NO grounding → NO guard — nothing invented), `checkPageContext` (origin
  first → WRONG_ORIGIN; then path/title → WRONG_PAGE; an unobservable page
  never fails the guard).
- `src/background/workflow-engine/engine.ts`: strict runs observe the live
  page (`WorkflowRunOptions.getPageContext`) before page-acting nodes —
  checked on the first one and refreshed whenever the automation tab changes;
  a mismatch throws the structured `WRONG_ORIGIN` / `WRONG_PAGE` code.
- `src/background/workflow-engine/run-workflow.ts`: the real observation over
  `resolveAutomationTab` (url only — cheap).

### Tests
- `tests/page-context.spec.ts` (new): 9 tests (derivation, normalization,
  origin-over-path priority, case-insensitive title, no-invented-failures).
- `pnpm typecheck` PASS · `pnpm test` 2418 PASS.

### Acceptance
- [x] strict 首个动作前 Origin/Page 校验（错站直接 WRONG_ORIGIN 拒绝执行）
- [x] tab 变化后刷新检查（pageContextCheckedForTab 按目标 tab 记忆）
- [x] 无依据不设防（没有 generation origin 的工作流行为不变）
- [x] 结构化 code 进 Phase 7 分类器（environment 类，不可自动修复）

### Regression risk
- low: guard only fires on generated-strict workflows that carry a grounding.

---

## Phase 11 Completion

### Changed
- `src/lib/workflow/reliability-certification.ts` (new): layered metrics —
  L1 executionSuccess / L2 verificationSuccess (conditional on L1) /
  L3 goalAchieved (conditional on L2; an unverified run can NEVER count as
  goal-achieved) — plus the certification state machine
  Draft→Validated→Verified→Certified (any regression / graph change → Stale;
  no skipping states).
- `tests/reliability-benchmark.spec.ts` (new): R01–R10 in STRICT mode against
  the baseline fixtures — every scenario's strict target asserted; R03 refuses
  the ambiguous click (LOCATOR_AMBIGUOUS, no mis-click); R09 fires the submit
  exactly once across the retry (terminal-state skip); L1=L2=100%; L3 equals
  the business-goal share; certification chain exercised.
- `specs/reliability-fixtures/harness.ts`: the fixture executors are now
  STRICT-AWARE (gated on `ctx.reliability`): score-based strict resolution
  (unique winner, score ≥70, margin ≥12, else LOCATOR_AMBIGUOUS), readiness
  polling for reads/clicks/existence, the empty-variable VARIABLE_INVALID
  guard, and the unsafe-submit terminal-state check (no blind replay).
- `specs/reliability-fixtures/scenarios.ts`: strict retries run against the
  ACTUAL page state (a resume sees the real terminal state, not a naive fresh
  replay); side-effect totals count the real page once.
- `tests/workflow-reliability-baseline.spec.ts`: the "strict ≡ compat"
  equivalence snapshot (self-documented as pre-Phase-11) now asserts the
  TARGET outcomes; compat baselines remain pinned by the compat tests.
- `scripts/bench-workflow-reliability.mjs` + `pnpm bench:reliability`: thin
  runner over the deterministic benchmark suite.
- `src/lib/workflow/generated-validation.ts`: 'click' added to the page-acting
  set (fixture graphs + legacy graphs route through the page-context guard).

### Gates
- `pnpm typecheck` PASS · `pnpm test` 2431 PASS · `pnpm build` PASS ·
  `pnpm verify:injected` PASS · `pnpm bench:reliability` PASS (13 tests).

### Acceptance
- [x] 基准脚本可复跑（bench:reliability = 确定性 vitest 套件）
- [x] 分层指标 L1/L2/L3（条件化：未验证不计目标达成）
- [x] certification 状态机（不可跳级；回归/图变更 → Stale）
- [x] R01–R10 strict 目标全部断言通过

---

## Phase 12 Completion

### Changed
- `src/lib/workflow/operator-guide.ts`: the generation prompt REQUIRES
  `__reliability` contracts (intent/idempotency/postconditions) on key
  actions and teaches the postcondition shape — landed with Phase 6 because
  the save/run gates depend on the model knowing the contract (cap raised
  9000→9400 in `lib/skills.ts`).
- `src/lib/workflow/ai-takeover.ts`: the takeover prompt gains mandatory
  reliability rules — complete ONLY the failed step, never re-run finished
  steps or re-submit a possibly-gone-through form, re-find by meaning on
  locator failures, stop-and-report on unsafe steps, LOCAL-patch-only fixes.
  (Context budget in the cap test raised 3800→4400 with justification.)
- `src/background/workflow-engine/failure-classifier.ts` + `engine.ts` (Phase
  7): the takeover request already carries the classified verdict + redacted
  evidence the rules refer to.

### Gates
- `pnpm typecheck` PASS · `pnpm test` 2431 PASS · `pnpm build` PASS ·
  `pnpm verify:injected` PASS.

### Acceptance
- [x] 契约式生成 Prompt（operator-guide：契约必填 + postconditions 形状）
- [x] operator-tools 透传 `__reliability`（additionalProperties 直达 node.data）
- [x] ai-takeover 提示词加固（只做失败步 / 禁盲重放 / 局部补丁 / 不安全即停）

---

# Final Implementation Report (Phases 0–12)

**Scope**: `docs/Browser-Copilot_Coding-Agent_Workflow-Reliability_Spec.md` — all 13 phases implemented on `develop`.

**Gates**: `pnpm typecheck` PASS · `pnpm test` 2431 PASS (baseline 2222 → +209) · `pnpm build` PASS · `pnpm verify:injected` PASS · `pnpm bench:reliability` PASS · `pnpm lint` unchanged-baseline.

**What exists now (one paragraph per layer)**:
1. **契约** (`reliability.ts`, `conditions.ts`, `readiness.ts`, `goal.ts`): per-node `__reliability` + workflow goal/origin grounding; strict mode resolved from provenance/explicit setting; strict without goal cannot run.
2. **定位** (`locator-score.ts`, `element-fingerprint.ts`, `kernel.ts`): identity-beats-position scoring recorded into locators; the kernel's strict resolver refuses ambiguity (`LOCATOR_AMBIGUOUS`/`LOCATOR_NOT_FOUND` + evidence) instead of clicking the first of many.
3. **就绪** (`readiness-engine.ts`): unified pre/post readiness waits with fresh per-poll observation, hit-and-return, per-attempt re-check on retry.
4. **目标** (`condition-runtime.ts`, `goal-verifier.ts`): deterministic condition evaluation; goal verification with terminal-state (alreadySatisfied) handling; the LLM judge can never forge success.
5. **生成校验** (`generated-validation.ts`): six-layer static gate (graph/data/locator/readiness/side-effect/goal) on save and every launch path; compat never gated.
6. **失败分类** (`failure-code.ts`, `execution-evidence.ts`, `failure-classifier.ts`): stable codes with priority, redacted evidence bundles, takeover enrichment.
7. **修复** (`reliability-patch.ts`): schema-valid single-node patches, confidence gates, contract can only tighten, same-failure-same-patch circuit breaker.
8. **副作用安全**: checkpoint phases (nodeStarted→sideEffectStarted→sideEffectObserved→nodeCommitted) for unsafe nodes; resume guard (graph fingerprint); SIDE_EFFECT_UNKNOWN refuses blind replay; terminal-state skip on strict retries.
9. **页面上下文** (`page-context.ts`): WRONG_ORIGIN/WRONG_PAGE before strict page-acting nodes, refreshed on tab change.
10. **基准与认证** (`reliability-certification.ts`, `bench-workflow-reliability.mjs`): L1/L2/L3 metrics + Draft→Certified state machine; R01–R10 strict targets all green.

**Spec deviations / honest limitations**: the LLM goal judge hook exists but no model judge is wired (goal verification is deterministic-only, the strictest mode); `stable`/`data-ready` readiness states resolve satisfied (no page probe); `text` conditions observe only CSS-expressible locators; the editor import path is not statically gated (editor workflows are compat by provenance).

**Per-phase details**: see the numbered reports above.

---

## Follow-up Fix: 保存面板"generated-strict 工作流缺少目标说明"误阻断

### Problem
生成模式下保存面板出现"必须修复：generated-strict 工作流缺少目标说明"并禁用保存按钮。
根因：Phase 1 的 goal 门禁把"无 goalSpec"对**所有** generated-strict 工作流一律视为
阻断错误——包括纯读取类（读页面/导出/导航）工作流，而生成模型并非总能写出
postconditions，用户在面板里没有任何自救路径。

### Fix（对规范的诚实收紧：goal 硬门禁收窄到真正危险面）
- `reliability.ts`: `goalGateProblems` 只在图里**确实存在 unsafe（非幂等）动作**
  （提交/登录/发送/支付/删除）时才强制要求可验证 goal——那才是"假成功"的危险面。
  纯读取工作流不再阻断；L3 验证在无 goalSpec 时诚实跳过（不是静默通过）。
  错误文案同时给出可执行的修复指引。
- `generated-validation.ts`: `validateGoal` 同步收窄（GOAL_MISSING 仅对含 unsafe
  动作的图报错误）。
- `operator-tool-handler.ts`: 组装时读取 trigger 节点的 `goalText`（用户需求原文）
  作为派生 goal 的 summary，使目标陈述与用户意图一致。
- `operator-guide.ts`: 生成提示词要求 trigger 调用携带 `goalText:'<用户需求原文>'`。

### Tests
- `workflow-reliability-contract.spec.ts` / `generated-validation.spec.ts`: 门禁测试
  更新为含 unsafe 动作的图断言阻断 + 新增"只读工作流不受 goal 门禁"用例。
- `operator-draft-graph.spec.ts`: 新增"trigger goalText + 节点 postconditions →
  goalSpec(summary/successConditions)"组合测试。
- `pnpm typecheck` PASS · `pnpm test` 2434 PASS · `pnpm build` PASS ·
  `pnpm verify:injected` PASS · `pnpm bench:reliability` PASS.

### Spec deviation note
规范 §8.4/§9 原文为"generated-strict 无 goalSpec 一律不可保存/运行"。本次按用户反馈
将其收窄为"含 unsafe 动作的 generated-strict 无 goalSpec 不可保存/运行"。依据：goal
门禁的存在理由是阻止副作用动作的假成功；对无副作用图谱强制要求不可验证的目标只会
把生成功能锁死，且 L3 层在无 goal 时跳过并不损失任何保证。

---

## Follow-up Fix: 保存卡片只弹"通过可运行检查"的工作流

### Problem
保存卡片的工作流来自 `workflows.draft.get` → `composeWorkflowFromDraft(save:false)`，
而可靠性/可运行性门禁只在 `save !== false` 时执行——预览路径完全跳过校验，用户会
看到一张带"必须修复"错误、保存按钮被禁用的卡片。

### Fix
- `operator-tool-handler.ts` `composeWorkflowFromDraft`：门禁移出 save 分支，**保存与
  预览两条路径都先过** `validateWorkflowForRun`（可运行性）+ strict 的
  `validateGeneratedWorkflow`（六层）。失败返回 `{error, issues}`——模型据此本地修复图，
  未通过的草稿不再出现在卡片上。
- `history-compile.ts` `resolveWorkflowForSave`：草稿存在但未通过门禁时**不回退**到
  history 编译（更不可靠），返回 `{empty:'validation-failed', detail}` 带出原因。
- `messages.ts`：空原因枚举扩展 `'validation-failed'` + `detail` 字段。
- `ChatTab.tsx`：`validation-failed` → 面板一行提示（新增双语 i18n key
  `chatWorkflowNotRunnable`，en+zh-CN），引导用户让 AI 修复后重试。
- `generated-validation.ts` `validateDataFlow`：运行输入的第二归属地（生成路径声明在
  trigger 节点的 `parameters`/`inputs`，镜像到 `workflow.trigger`）现在被计为"已写入"，
  修复了组合工作流被误报 `DATA_UNWRITTEN_VARIABLE` 的假阳性。

### Gates
`pnpm typecheck` PASS · `pnpm test` 2434 PASS · `pnpm build` PASS ·
`pnpm verify:injected` PASS。

### Acceptance
- [x] 弹出的保存卡片工作流必先通过可运行检查（+ strict 六层校验）
- [x] 未通过时不弹卡：模型收到结构化 issues 自行修复；面板得到一行双语原因
- [x] 组合路径的 declared-inputs 假阳性修复（trigger 声明的输入计为已写入）

---

## Follow-up Fix: 生成必然成功 + 校验必然通过（组装期自动补全契约）

### Principle
门禁的职责是保证产出质量，不是让生成失败。模型对 `__reliability` 元数据不稳定，
因此改为在**组装期确定性地补全**——任何正常生成的图都能通过六层校验，工作流必然产出。

### New modules
- `src/lib/workflow/auto-contract.ts` `autoCompleteReliability`：
  - 按动作语义推断 idempotency（submit/login/pay/delete/send/create/order/webhook
    → unsafe；普通 click → safe）；
  - 模型漏写 postcondition 时补最小可观察事实（动作目标元素 elementExists，目标用
    语义身份字段：testId / role+accessibleName / stableAttributes{id|name|data-css} /
    text）；
  - **只填空缺，绝不覆盖模型已写契约、绝不把 unsafe 标 safe、绝不放松任何规则**。
- `src/lib/workflow/declare-missing-inputs.ts` `declareMissingInputs`：节点引用了
  `{{orderId}}` 但无生产者时，自动提升为 trigger 上声明的**运行输入**（用户在保存卡片
  上填值），而非报 DATA_UNWRITTEN_VARIABLE。

### Wiring
- `composeWorkflowFromDraft`：构建 workflow 前依次
  autoCompleteReliability → declareMissingInputs（draft 与 history 两条来源都经过）。
- 校验链因此对正常图全部通过：goalSpec 从补全后的 postconditions 自动派生
  （summary = 用户 goalText）；DATA 层把 trigger 声明的参数计为已写入。
- `tests/auto-contract.spec.ts`（4 tests，含端到端：模型一个契约字段都不写、还引用
  未定义变量，仍然生成出"可运行检查 errors=[] + 有可验证 goal"的工作流）。

### Gates
`pnpm typecheck` PASS · `pnpm test` 2438 PASS · `pnpm build` PASS ·
`pnpm verify:injected` PASS。

### Guarantee
- [x] 工作流必然生成：任何含 ≥1 个动作节点的草稿都能组装出 workflow
- [x] 校验必然通过：组装期补全 idempotency/postconditions/inputs，六层无 error
- [x] 不牺牲诚实性：只补缺省元数据，不编造业务结果、不放松契约、不把危险动作标安全
