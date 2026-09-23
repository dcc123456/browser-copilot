/**
 * The AI-debug session loop (调试会话编排).
 *
 * One debug session = up to {@link DEFAULT_MAX_ROUNDS} rounds of:
 *
 *   1. run the (possibly already-patched) workflow WITH the AI-takeover hook —
 *      failed nodes are handed to the agent, which may propose param fixes;
 *   2. collect the completed takeovers' fixes and apply them to an in-memory
 *      copy (the saved workflow is NOT touched here);
 *   3. verify: run that copy once WITHOUT takeover — this is the answer to the
 *      question the user actually cares about ("does it work without AI now?");
 *      a passing verify run is what marks the session `verified`.
 *
 * Fixes are persisted via `savePending` ONLY after a verify run passed — the
 * user still confirms them on the panel (takeover-apply flow). Unverified
 * fixes stay unsaved; the session reports honestly which state it ended in.
 *
 * The module is chrome-free and fully dependency-injected, so the loop is
 * unit-testable end to end (`tests/debug-session.spec.ts`).
 *
 * @module background/workflow-engine/debug-session
 */
import { failureSignature, validationFailure } from '../../lib/workflow/ai-takeover'
import type { TakeoverFix, TakeoverReport } from '../../lib/workflow/ai-takeover'
import type { GoalVerdict, NodeAudit } from '../../lib/workflow/debug-rewrite'
import { patchNodeParams, type WorkflowDebugResult } from '../../lib/workflow/auto-debug-patch'
import type { Workflow } from '../../lib/workflow/types'
import type { AiTakeoverHook } from './engine'

/** Default number of run→fix→verify rounds per session. */
export const DEFAULT_MAX_ROUNDS = 2

/**
 * How many times the SAME failure signature may recur inside one session
 * before the loop refuses to walk into it again.
 *
 * This is the anti-"infinite retry" breaker for NON-IDEMPOTENT workflows
 * (login / submit / send / register): once the side effect has landed, the
 * preconditions are gone forever, so every further round fails with the same
 * "element not found" — retrying is not just useless, it is *wrong*, because
 * it will never reach the page the workflow was written for. Stop and report
 * instead of burning rounds (and model calls) on an identical dead end.
 */
export const REPEAT_FAILURE_LIMIT = 2

/**
 * Interaction blocks whose executors honor `waitForSelector` polling
 * (`withWait` in executors.ts). Debug runs force-enable a short wait on these
 * so slow pages don't fail before the AI takeover ever gets a chance — the
 * single cheapest success-rate lever there is.
 */
export const WAIT_BLOCKS: readonly string[] = [
  'event-click',
  'hover-element',
  'forms',
  'element-scroll',
  // legacy ids (same executors, editor/recorder may emit either)
  'click',
  'fill',
  'select-option',
  'set-checkbox',
  'scroll',
]

/** Default poll window (ms) forced onto interaction blocks in debug runs. */
export const DEBUG_WAIT_MS = 4000

/**
 * Default poll window (ms) forced onto interaction blocks in NORMAL runs
 * (manual / scheduled / chat / Feishu / server). Deliberately shorter than the
 * debug window: it must not noticeably slow the happy path. A workflow can opt
 * out with `settings.defaultWaitMs = 0`, or pick its own value.
 */
export const DEFAULT_WAIT_MS = 2000

/**
 * A copy of the workflow with element waits force-enabled on interaction
 * blocks. Pure: the input is never mutated. Blocks that already set
 * `waitForSelector` keep the user's own timeout. `ms <= 0` disables the
 * rewrite entirely (returns the input unchanged).
 *
 * The single cheapest success-rate lever: a "not found" caused by a slow render
 * never reaches the AI takeover at all.
 */
export function applyDefaultWaits(workflow: Workflow, ms: number): Workflow {
  if (!(ms > 0)) return workflow
  const clone = structuredClone(workflow)
  for (const node of clone.drawflow.nodes) {
    const raw = node.data?.['blockId']
    const blockId = typeof raw === 'string' ? raw : node.label
    if (!blockId || !(WAIT_BLOCKS as readonly string[]).includes(blockId)) continue
    if (node.data['waitForSelector'] === true) continue
    node.data['waitForSelector'] = true
    const existing = node.data['waitSelectorTimeout']
    if (!(typeof existing === 'number' && existing > 0)) node.data['waitSelectorTimeout'] = ms
  }
  return clone
}

/**
 * Debug-run alias of {@link applyDefaultWaits} with the longer debug window.
 */
export function withWaitFor(workflow: Workflow, ms = DEBUG_WAIT_MS): Workflow {
  return applyDefaultWaits(workflow, ms)
}

/**
 * Applies takeover fixes to a workflow copy. Pure: `patchNodeParams` clones
 * internally; the input object is never mutated.
 */
export function applyTakeoverFixes(
  workflow: Workflow,
  fixes: TakeoverFix[],
): { workflow: Workflow; changes: string[]; applied: number } {
  let current = workflow
  const changes: string[] = []
  let applied = 0
  for (const fix of fixes) {
    const result = patchNodeParams(current, fix.nodeId, fix.paramsPatch)
    if (result.changed) {
      current = result.workflow
      changes.push(...result.changes)
      applied += 1
    }
  }
  return { workflow: current, changes, applied }
}

/** The slice of `executeWorkflow`'s result the session loop needs. */
export interface DebugRunResult {
  runId: string
  outcome: 'ok' | 'cancelled' | 'failed'
  summary?: string
  error?: string
  /** The actual failed (symptom) node id from the run trace, when known. */
  failedNodeId?: string
  /** Final variable values (goal-check evidence). */
  variables?: Record<string, unknown>
  /** Step tail (goal-check evidence), oldest last. */
  steps?: { kind: string; text: string }[]
}

/** The replay phase's outcome (an agent re-doing the task like in chat). */
export interface ReplayResult {
  completed: boolean
  summary: string
  trace: string[]
}

/** What the audit phase produced: diagnosis + verdicts + a validated rewrite. */
export interface AuditOutcome {
  diagnosis: string
  nodes: NodeAudit[]
  changes: string[]
  /** The validated rewritten workflow, when the audit's graph passed checks. */
  rewritten: Workflow | null
}

export interface DebugSessionDeps {
  /** Runs one workflow pass (executeWorkflow). */
  run: (
    workflow: Workflow,
    opts: { aiTakeover?: AiTakeoverHook | null; sessionId?: string },
  ) => Promise<DebugRunResult>
  /** Builds a fresh takeover hook for one run. */
  createTakeover: (opts: {
    onEvent: (kind: 'tool' | 'status' | 'result' | 'error' | 'info', text: string) => void
    onTakeover: (report: TakeoverReport) => void
  }) => AiTakeoverHook
  /** Persists verified fixes for the user's confirmation (takeover-pending). */
  savePending: (workflowId: string, runId: string, fixes: TakeoverFix[]) => Promise<void>
  /**
   * Phase 2 when everything else failed: an agent re-executes the workflow's
   * goal on the live page exactly like the first chat run. Undefined skips
   * the phase (plain failure).
   */
  replay?: (
    workflow: Workflow,
    onStep: (kind: 'tool' | 'status' | 'result' | 'error', text: string) => void,
  ) => Promise<ReplayResult>
  /**
   * Phase 3: audits the graph against the replay and (when the model's
   * corrected graph validates) returns the rewritten workflow. Receives the
   * failure context so the diagnosis can name the actual breakage.
   */
  audit?: (
    workflow: Workflow,
    replay: ReplayResult,
    failure: { error?: string; takeoverNote?: string },
  ) => Promise<AuditOutcome | null>
  /** Persists a verified WHOLE-GRAPH rewrite (takeover-pending.rewrite). */
  saveRewrite?: (
    workflowId: string,
    runId: string,
    rewrite: { workflow: Workflow; changes: string[]; diagnosis: string },
  ) => Promise<void>
  /**
   * Goal-completion judge: "no error" is NOT success — decide whether a
   * finished run actually achieved the workflow's goal. Returns null when
   * unavailable (no provider) and the session falls back to the no-error
   * standard. Called on EVERY ok run outcome (first pass, verify, rewrite).
   */
  goalCheck?: (
    workflow: Workflow,
    evidence: {
      runId: string
      summary?: string
      steps: { kind: string; text: string }[]
      variables: Record<string, unknown>
      /**
       * The run being judged ENDED IN FAILURE. The judge must then also
       * consider the terminal-state case: a NON-IDEMPOTENT goal (login,
       * submit, send) may already hold, so the "failure" is just the missing
       * precondition — retrying can never re-demonstrate it.
       */
      runFailed?: boolean
    },
  ) => Promise<GoalVerdict | null>
  /** Live session log sink (the panel's debug modal). */
  onDebugStep?: (kind: 'info' | 'status' | 'error' | 'result', text: string) => void
  /**
   * M4: the debug session's id, stamped onto EVERY run this session spawns
   * (takeover pass, fix-verify, rewrite-verify) so the session's runs,
   * checkpoints and takeover stats can be joined after the fact.
   */
  sessionId?: string
  /** Run→fix→verify rounds; the first takeover run counts as round 1. */
  maxRounds?: number
}

/**
 * Runs the debug session loop. `workflow` is never mutated; every patched
 * version is a fresh copy. The saved workflow is only touched through
 * `deps.savePending` (and applied later via the user's confirm action).
 */
export async function runDebugSession(
  workflow: Workflow,
  deps: DebugSessionDeps,
): Promise<WorkflowDebugResult> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS
  const log = (kind: 'info' | 'status' | 'error' | 'result', text: string): void => {
    deps.onDebugStep?.(kind, text)
  }
  // Auto-wait only applies to the FIRST pass; later rounds run the patched
  // copy, which may already carry fixes (incl. wait fixes the AI proposed).
  let current = withWaitFor(workflow)
  const takeovers: TakeoverReport[] = []
  let attempts = 0
  let lastRunId: string | undefined
  /** The most recent run result — the evidence for the terminal-state check. */
  let lastRun: DebugRunResult | undefined
  let lastError: string | undefined
  let roundsSeen = 0
  /**
   * Failure signatures seen this session (ordered, oldest first) — the
   * anti-infinite-retry breaker. A non-idempotent workflow that already landed
   * fails identically on every round, so seeing the same signature again is a
   * signal to STOP (see {@link REPEAT_FAILURE_LIMIT}).
   */
  const seenSignatures: string[] = []

  /**
   * Records a failure signature; returns true when the SAME failure has now
   * recurred enough times that walking into it again is pointless.
   *
   * The signature is node-aware (spec §13): it uses the actual failed node id
   * from the run trace rather than a fixed 'session', so identical error text
   * at DIFFERENT nodes is not misread as the same dead end. Falls back to the
   * run id only when no node evidence exists.
   */
  const isRepeatedDeadEnd = (error: string | undefined, nodeId?: string): boolean => {
    if (!error) return false
    const signature = failureSignature(nodeId ?? lastRunId ?? 'unknown', error)
    seenSignatures.push(signature)
    return seenSignatures.filter((s) => s === signature).length > REPEAT_FAILURE_LIMIT
  }

  /** Plain-failure result (no escalation available / escalation failed). */
  const failedResult = (
    summary: string,
    extra: Partial<WorkflowDebugResult> = {},
  ): WorkflowDebugResult => {
    // Derive a structured failure reason + next-step hint from the error that
    // actually drives the result (explicit extra.error wins over lastError).
    const drivingError = (extra as { error?: string }).error ?? lastError
    const structured = validationFailure(drivingError)
    return {
      ok: false,
      // The final workflow version never passed a takeover-free run here.
      verified: false,
      attempts,
      summary,
      ...(lastError ? { error: lastError } : {}),
      ...(lastRunId ? { lastRunId } : {}),
      rounds: Math.max(roundsSeen, 1),
      takeovers,
      pendingChanges: [],
      ...structured,
      ...extra,
    }
  }

  /**
   * Stops the session when the SAME failure keeps coming back. Retrying a
   * non-idempotent workflow that already fired is not merely useless — it can
   * never return to the starting page, so each round is guaranteed to fail
   * again. Tell the user to reset the state instead of looping.
   */
  const stopOnRepeatedDeadEnd = (error: string | undefined): WorkflowDebugResult => {
    const detail = error ?? '(无详情)'
    log(
      'error',
      `同一错误已连续出现超过 ${REPEAT_FAILURE_LIMIT} 次：${detail} —— 继续重试不会有新结果，停止调试`,
    )
    return failedResult(
      `重复失败：${detail}。连续多次卡在同一个错误，继续重试不会回到初始状态（若是登录/提交类流程，请先手动复位到未登录/未提交状态再调试）`,
      {
        error: detail,
      },
    )
  }

  /**
   * Phase 2+3 (复演 + 图审计): the node-level path failed, so a full agent
   * re-does the task like the first chat run, then a model call audits the
   * graph (wrong/missing/redundant/fallback nodes) and — when its corrected
   * graph validates — the rewrite is VERIFY-RUN (no takeover) before it is
   * offered to the user. Nothing is saved when the verify run fails.
   */
  const escalateToReplay = async (failure: { error?: string }): Promise<WorkflowDebugResult> => {
    // TERMINAL-STATE ESCAPE HATCH (非幂等目标).
    // Before spending a full replay, ask whether the goal ALREADY holds. A
    // login workflow that already logged in cannot be replayed — the login page
    // is gone — so replaying only walks into the same dead end forever. This is
    // the single guard against "already succeeded but keeps retrying".
    if (lastRun && lastRun.outcome !== 'ok') {
      const satisfied = await judgeAlreadySatisfied(lastRun)
      if (satisfied) return alreadySatisfiedResult(satisfied)
    }
    if (!deps.replay || !deps.audit) {
      return failedResult(lastError ?? failure.error ?? 'AI 调试未能修复该工作流')
    }
    const takeoverNote =
      takeovers.length > 0
        ? `完成 ${takeovers.filter((t) => t.completed).length}/${takeovers.length} 个失败节点${
            lastError ? `；最后错误：${lastError}` : ''
          }`
        : undefined
    log('status', '节点级修复未能解决，AI 开始复演：像第一次在聊天里那样在页面上完整执行该任务…')
    const trace: string[] = []
    let replay: ReplayResult
    try {
      replay = await deps.replay(current, (kind, text) => {
        trace.push(
          `${kind === 'tool' ? '→' : kind === 'result' ? '←' : kind === 'error' ? '!' : '·'} ${text}`,
        )
        if (trace.length > 80) trace.splice(0, trace.length - 80)
        log(kind === 'tool' ? 'status' : kind, `🔁 ${text}`)
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      log('error', `复演异常：${text}`)
      return failedResult(`复演失败：${text}`, {
        error: `复演失败：${text}`,
      })
    }
    log('status', '复演结束，正在审计工作流图（哪些节点不对/缺失/多余/需要兜底）…')
    let outcome: AuditOutcome | null = null
    try {
      outcome = await deps.audit(current, replay, { error: failure.error, takeoverNote })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      log('error', `工作流审计异常：${text}`)
    }
    if (!outcome) {
      return failedResult('AI 复演完成，但工作流审计不可用，未能生成修正版工作流', {
        error: '工作流审计不可用',
      })
    }
    log('result', `诊断：${outcome.diagnosis}`)
    for (const node of outcome.nodes) {
      log(
        'info',
        `节点审计「${node.nodeLabel}」：${node.verdict}${node.note ? ` — ${node.note}` : ''}`,
      )
    }
    if (!outcome.rewritten) {
      log('error', 'AI 未能给出可用的修正版工作流（图校验未通过），本次调试不保存任何修改')
      return failedResult(outcome.diagnosis, {
        audit: outcome.nodes,
        error: 'AI 生成的修正版工作流未通过校验',
      })
    }
    log('status', '验证 AI 生成的新工作流（无 AI 接管，独立运行）…')
    let v: DebugRunResult
    try {
      v = await deps.run(outcome.rewritten, {
        ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
        aiTakeover: null,
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      log('error', `新工作流验证运行异常：${text}`)
      return failedResult(outcome.diagnosis, {
        audit: outcome.nodes,
        error: `新工作流验证运行异常：${text}`,
      })
    }
    attempts += 1
    lastRunId = v.runId
    lastRun = v
    if (v.outcome === 'cancelled') {
      log('info', '新工作流验证运行已取消')
      return {
        ok: false,
        cancelled: true,
        attempts,
        summary: '运行已取消',
        ...(lastRunId ? { lastRunId } : {}),
        rounds: Math.max(roundsSeen, 1),
        takeovers,
        pendingChanges: [],
        audit: outcome.nodes,
      }
    }
    if (v.outcome !== 'ok') {
      lastError = v.error ?? v.summary
      log(
        'error',
        `新工作流验证仍失败：${lastError ?? '(无详情)'}——不保存修改，请参考节点审计自行调整`,
      )
      // The rebuild failed — but for a non-idempotent goal that may simply mean
      // it was already done. Ask before declaring defeat.
      const satisfied = await judgeAlreadySatisfied(v)
      if (satisfied) return alreadySatisfiedResult(satisfied)
      return failedResult(outcome.diagnosis, {
        audit: outcome.nodes,
      })
    }
    // The rebuild ran without errors — but the GOAL decides, not the absence
    // of errors. Judge before offering it to the user.
    const goal = await judgeGoal(v)
    if (goal && !goal.achieved) {
      lastError = `目标未达成：${goal.reason}`
      log('error', `新工作流运行无报错，但目标未达成：${goal.reason}——不保存修改`)
      return failedResult(`运行无报错，但目标未达成：${goal.reason}`, {
        audit: outcome.nodes,
        error: lastError,
      })
    }
    // The rewrite runs clean AND achieves the goal: offer it for confirmation.
    // The workflow itself is only replaced when the user applies the pending
    // rewrite (whole-graph swap on takeoverApply).
    await deps
      .saveRewrite?.(workflow.id, v.runId, {
        workflow: outcome.rewritten,
        changes: outcome.changes,
        diagnosis: outcome.diagnosis,
      })
      .catch(() => undefined)
    log(
      'result',
      `新工作流验证通过${goal ? `，目标已达成（${goal.reason}）` : ''}（${outcome.changes.length} 项变更待确认）`,
    )
    return {
      ok: true,
      attempts,
      summary: outcome.diagnosis,
      ...(lastRunId ? { lastRunId } : {}),
      verified: true,
      rounds: Math.max(roundsSeen, 1),
      takeovers,
      pendingChanges: [],
      rewrite: { diagnosis: outcome.diagnosis, changes: outcome.changes },
      audit: outcome.nodes,
      ...(goal ? { goalAchieved: true, goalNote: goal.reason } : {}),
    }
  }

  /**
   * Goal-completion judge (目标达成判定): "no error" is NOT success. Returns
   * null when the judge is unavailable (no provider) — the session then falls
   * back to the no-error standard. Runs against the ORIGINAL workflow's goal.
   */
  const judgeGoal = async (r: DebugRunResult): Promise<GoalVerdict | null> => {
    if (!deps.goalCheck) return null
    try {
      return await deps.goalCheck(workflow, {
        runId: r.runId,
        summary: r.summary,
        steps: r.steps ?? [],
        variables: r.variables ?? {},
        runFailed: r.outcome !== 'ok',
      })
    } catch {
      return null
    }
  }

  /**
   * TERMINAL-STATE ESCAPE HATCH (非幂等目标的"已达成"判定).
   *
   * A failed run is not automatically a broken workflow. For non-idempotent
   * goals (log in / submit / send / register / pay) the goal may ALREADY hold —
   * the login landed on an earlier round, so the username field is gone and the
   * re-run can only fail. Ask the goal judge whether the END STATE holds; when
   * it does, the session is over and successful. Returns null when the judge is
   * unavailable or says the goal does not hold.
   */
  const judgeAlreadySatisfied = async (r: DebugRunResult): Promise<GoalVerdict | null> => {
    const verdict = await judgeGoal(r)
    if (verdict && verdict.achieved && verdict.alreadySatisfied) return verdict
    return null
  }

  /** Success result for a goal that already holds (non-idempotent flow). */
  const alreadySatisfiedResult = (verdict: GoalVerdict): WorkflowDebugResult => {
    log(
      'result',
      `目标已达成（终态已满足，无需再跑）：${verdict.reason} —— 非幂等流程（登录/提交/发送类）已经生效，重试不会回到初始页面，本次调试到此结束`,
    )
    return {
      ok: true,
      attempts,
      summary: verdict.reason || '目标终态已满足（非幂等流程已生效）',
      ...(lastRunId ? { lastRunId } : {}),
      verified: true,
      rounds: Math.max(roundsSeen, 1),
      takeovers,
      pendingChanges: [],
      goalAchieved: true,
      goalNote: verdict.reason,
      alreadySatisfied: true,
    }
  }

  for (let round = 1; round <= maxRounds; round++) {
    roundsSeen = round
    log(
      'status',
      `开始第 ${round}/${maxRounds} 轮调试运行${round > 1 ? '（已应用上一轮修复）' : '（交互节点自动等待 4 秒）'}…`,
    )
    const reports: TakeoverReport[] = []
    let r: DebugRunResult
    try {
      r = await deps.run(current, {
        ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
        aiTakeover: deps.createTakeover({
          onEvent: (kind, text) => log(kind === 'tool' ? 'status' : kind, text),
          onTakeover: (report) => {
            reports.push(report)
            takeovers.push(report)
            log(
              report.completed ? 'result' : 'error',
              report.completed
                ? `AI 接管「${report.nodeLabel}」完成（${report.attempts} 次尝试）：${report.summary ?? ''}`
                : `AI 接管「${report.nodeLabel}」失败：${report.error ?? ''}`,
            )
          },
        }),
      })
    } catch (error) {
      // A thrown run (cancellation escaping, engine crash) ends the session.
      const text = error instanceof Error ? error.message : String(error)
      log('error', `调试运行异常：${text}`)
      return {
        ok: false,
        attempts,
        summary: text,
        error: text,
        ...(lastRunId ? { lastRunId } : {}),
        rounds: round - 1,
        takeovers,
        pendingChanges: [],
      }
    }
    attempts += 1
    lastRunId = r.runId
    lastRun = r
    lastError = r.error

    if (r.outcome === 'cancelled') {
      log('info', '调试运行已取消')
      return {
        ok: false,
        cancelled: true,
        attempts,
        summary: r.summary || '运行已取消',
        ...(lastRunId ? { lastRunId } : {}),
        rounds: round,
        takeovers,
        pendingChanges: [],
      }
    }

    const fixes = reports.flatMap((report) => (report.completed && report.fix ? [report.fix] : []))

    // The pass succeeded as-is: nothing to repair — but "no error" is not
    // yet "goal achieved". Judge the goal before declaring success.
    if (r.outcome === 'ok' && fixes.length === 0) {
      const goal = await judgeGoal(r)
      if (goal && !goal.achieved) {
        log('error', `运行无报错，但目标未达成：${goal.reason} —— 转入复演+图审计修复`)
        return escalateToReplay({ error: `目标未达成：${goal.reason}` })
      }
      log(
        'result',
        `调试通过：${goal ? `目标已达成（${goal.reason}）` : r.summary || '运行成功（无需修复）'}`,
      )
      return {
        ok: true,
        attempts,
        summary: r.summary || '运行成功',
        ...(lastRunId ? { lastRunId } : {}),
        verified: true,
        rounds: round,
        takeovers,
        pendingChanges: [],
        ...(goal ? { goalAchieved: true, goalNote: goal.reason } : {}),
      }
    }

    if (fixes.length === 0) {
      log('error', `运行失败且没有可用的修复建议：${r.error ?? r.summary ?? '(无详情)'}`)
      // A failed run is NOT proof of a broken workflow: for a non-idempotent
      // goal (login / submit / send) the run may be failing precisely because
      // the goal ALREADY holds and its preconditions are gone. Check first.
      const satisfied = await judgeAlreadySatisfied(r)
      if (satisfied) return alreadySatisfiedResult(satisfied)
      if (isRepeatedDeadEnd(r.error ?? r.summary, r.failedNodeId)) {
        return stopOnRepeatedDeadEnd(r.error ?? r.summary)
      }
      // Nothing to patch — escalate straight to replay + graph audit.
      return escalateToReplay({ error: r.error ?? r.summary })
    }

    // Apply the proposed fixes to an in-memory copy and verify WITHOUT AI.
    const patched = applyTakeoverFixes(current, fixes)
    if (patched.applied === 0) {
      log('error', '修复建议未能应用到工作流（节点或参数无效），无法验证')
      if (r.outcome === 'failed') {
        return escalateToReplay({ error: r.error ?? r.summary })
      }
      return {
        ok: true,
        attempts,
        summary: r.summary || '运行成功',
        ...(r.error ? { error: r.error } : {}),
        ...(lastRunId ? { lastRunId } : {}),
        rounds: round,
        takeovers,
        pendingChanges: [],
      }
    }
    for (const change of patched.changes) log('info', `应用修复：${change}`)
    log('status', '验证运行（关闭 AI 接管，验证修复后流程可独立跑通）…')
    let v: DebugRunResult
    try {
      v = await deps.run(patched.workflow, {
        ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
        aiTakeover: null,
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      log('error', `验证运行异常：${text}`)
      return {
        ok: r.outcome === 'ok',
        attempts,
        summary: r.outcome === 'ok' ? r.summary || '运行成功' : (r.error ?? '运行失败'),
        ...(r.error ? { error: r.error } : {}),
        ...(lastRunId ? { lastRunId } : {}),
        verified: false,
        rounds: round,
        takeovers,
        pendingChanges: [],
        ...validationFailure(r.error ?? r.summary),
      }
    }
    attempts += 1
    lastRunId = v.runId

    if (v.outcome === 'cancelled') {
      log('info', '验证运行已取消')
      return {
        ok: false,
        cancelled: true,
        attempts,
        summary: '运行已取消',
        ...(lastRunId ? { lastRunId } : {}),
        rounds: round,
        takeovers,
        pendingChanges: [],
      }
    }

    if (v.outcome === 'ok') {
      // No-error is not success: judge whether the goal was actually achieved
      // before persisting anything for the user.
      const goal = await judgeGoal(v)
      if (goal && !goal.achieved) {
        lastError = `目标未达成：${goal.reason}`
        log('error', `验证运行无报错，但目标未达成：${goal.reason}`)
        if (round < maxRounds) {
          // Next round's takeover sees the patched graph + the goal gap.
          current = patched.workflow
          continue
        }
        return escalateToReplay({ error: lastError })
      }
      // The fixed workflow runs clean AND achieves the goal — persist the
      // fixes as pending for the user's confirmation; the panel applies them.
      await deps.savePending(workflow.id, v.runId, fixes).catch(() => undefined)
      log(
        'result',
        `验证通过：修复后的流程无需 AI 也能跑通${goal ? `，目标已达成（${goal.reason}）` : ''}（${patched.applied} 个修复待确认）`,
      )
      return {
        ok: true,
        attempts,
        summary: r.summary || '运行成功（修复已验证）',
        ...(lastRunId ? { lastRunId } : {}),
        verified: true,
        rounds: round,
        takeovers,
        pendingChanges: fixes,
        ...(goal ? { goalAchieved: true, goalNote: goal.reason } : {}),
      }
    }

    lastError = v.error ?? v.summary
    log('error', `验证运行仍失败：${lastError ?? '(无详情)'}`)
    // THE infinite-retry guard for non-idempotent flows. A login workflow that
    // already logged in CANNOT re-demonstrate the login: the next round lands
    // on the dashboard, the username field is gone, and every round fails the
    // same way. Check the terminal state before burning another round.
    const satisfied = await judgeAlreadySatisfied(v)
    if (satisfied) return alreadySatisfiedResult(satisfied)
    if (isRepeatedDeadEnd(lastError, v.failedNodeId)) {
      return stopOnRepeatedDeadEnd(lastError)
    }
    if (round < maxRounds) {
      // Next round's takeover sees the patched graph + the verify failure.
      current = patched.workflow
      continue
    }
  }

  // All rounds exhausted without a verified fix — escalate to the replay +
  // graph audit phase (a full agent re-execution + a whole-graph rewrite).
  log('error', `调试未能验证修复：${lastError ?? '(无详情)'}`)
  return escalateToReplay({ error: lastError })
}
