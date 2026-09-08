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
import type { TakeoverFix, TakeoverReport } from '../../lib/workflow/ai-takeover'
import type { GoalVerdict, NodeAudit } from '../../lib/workflow/debug-rewrite'
import { patchNodeParams, type WorkflowDebugResult } from '../../lib/workflow/auto-debug-patch'
import type { Workflow } from '../../lib/workflow/types'
import type { AiTakeoverHook } from './engine'

/** Default number of run→fix→verify rounds per session. */
export const DEFAULT_MAX_ROUNDS = 2

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
 * A debug-run copy of the workflow with element waits force-enabled on
 * interaction blocks. Pure: the input is never mutated. Blocks that already
 * set `waitForSelector` keep the user's own timeout.
 */
export function withWaitFor(workflow: Workflow, ms = DEBUG_WAIT_MS): Workflow {
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
  run: (workflow: Workflow, opts: { aiTakeover?: AiTakeoverHook | null }) => Promise<DebugRunResult>
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
  replay?: (workflow: Workflow, onStep: (kind: 'tool' | 'status' | 'result' | 'error', text: string) => void) => Promise<ReplayResult>
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
  saveRewrite?: (workflowId: string, runId: string, rewrite: { workflow: Workflow; changes: string[]; diagnosis: string }) => Promise<void>
  /**
   * Goal-completion judge: "no error" is NOT success — decide whether a
   * finished run actually achieved the workflow's goal. Returns null when
   * unavailable (no provider) and the session falls back to the no-error
   * standard. Called on EVERY ok run outcome (first pass, verify, rewrite).
   */
  goalCheck?: (workflow: Workflow, evidence: { runId: string; summary?: string; steps: { kind: string; text: string }[]; variables: Record<string, unknown> }) => Promise<GoalVerdict | null>
  /** Live session log sink (the panel's debug modal). */
  onDebugStep?: (kind: 'info' | 'status' | 'error' | 'result', text: string) => void
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
  let lastError: string | undefined
  let roundsSeen = 0

  /** Plain-failure result (no escalation available / escalation failed). */
  const failedResult = (
    summary: string,
    extra: Partial<WorkflowDebugResult> = {},
  ): WorkflowDebugResult => ({
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
    ...extra,
  })

  /**
   * Phase 2+3 (复演 + 图审计): the node-level path failed, so a full agent
   * re-does the task like the first chat run, then a model call audits the
   * graph (wrong/missing/redundant/fallback nodes) and — when its corrected
   * graph validates — the rewrite is VERIFY-RUN (no takeover) before it is
   * offered to the user. Nothing is saved when the verify run fails.
   */
  const escalateToReplay = async (failure: {
    error?: string
  }): Promise<WorkflowDebugResult> => {
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
        trace.push(`${kind === 'tool' ? '→' : kind === 'result' ? '←' : kind === 'error' ? '!' : '·'} ${text}`)
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
      log('info', `节点审计「${node.nodeLabel}」：${node.verdict}${node.note ? ` — ${node.note}` : ''}`)
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
      v = await deps.run(outcome.rewritten, { aiTakeover: null })
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
      log('error', `新工作流验证仍失败：${lastError ?? '(无详情)'}——不保存修改，请参考节点审计自行调整`)
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
    log('result', `新工作流验证通过${goal ? `，目标已达成（${goal.reason}）` : ''}（${outcome.changes.length} 项变更待确认）`)
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
      })
    } catch {
      return null
    }
  }

  for (let round = 1; round <= maxRounds; round++) {
    roundsSeen = round
    log('status', `开始第 ${round}/${maxRounds} 轮调试运行${round > 1 ? '（已应用上一轮修复）' : '（交互节点自动等待 4 秒）'}…`)
    const reports: TakeoverReport[] = []
    let r: DebugRunResult
    try {
      r = await deps.run(current, {
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
      log('result', `调试通过：${goal ? `目标已达成（${goal.reason}）` : r.summary || '运行成功（无需修复）'}`)
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
      v = await deps.run(patched.workflow, { aiTakeover: null })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      log('error', `验证运行异常：${text}`)
      return {
        ok: r.outcome === 'ok',
        attempts,
        summary: r.outcome === 'ok' ? (r.summary || '运行成功') : (r.error ?? '运行失败'),
        ...(r.error ? { error: r.error } : {}),
        ...(lastRunId ? { lastRunId } : {}),
        verified: false,
        rounds: round,
        takeovers,
        pendingChanges: [],
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
