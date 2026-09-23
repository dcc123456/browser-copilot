/**
 * Integration layer that wires the pure engine to a tracked "running task".
 *
 * Starts a `running-tasks` entry so the run appears on the board, streams every
 * engine step into its progress log, and finishes it with the settling outcome.
 * This is the entry point callers (chat, scheduler, Feishu bot, manual run)
 * use to actually execute a workflow.
 *
 * @module background/workflow-engine/run-workflow
 */

import type { Workflow } from '../../lib/workflow/types'
import { recordCheckpoint, resumePointOf } from '../../lib/workflow/checkpoints'
import { seedFromTrigger } from '../../lib/workflow/workflow-inputs'
import {
  createChromeCheckpointStore,
  findNewestPersistedRunId,
  indexPersistedRun,
  prunePersistedCheckpoints,
  readPersistedCheckpoints,
} from '../checkpoint-store'
import {
  addStep,
  finishRun,
  recordSnapshot,
  setRunWorkflow,
  startRun,
  type RunSource,
  type RunningTask,
} from '../running-tasks'
import {
  countElements,
  elementSelectorAt,
  execJsOnActiveTab,
  execOnActiveTab,
  resolveAutomationTab,
} from '../driver'
import { normalScopeFromWindowId, type ScopeWindow } from '../automation-scope'
import { BLOCK_BY_ID } from '../../lib/workflow/blocks/palette'
import { unanchoredElementStart } from '../../lib/workflow/runnability'
import { runWorkflow } from './engine'
import type { AiTakeoverHook } from './engine'
import { DEFAULT_WAIT_MS, applyDefaultWaits } from './debug-session'
import type { ReadinessProbe } from './readiness-engine'
import { targetSpecFromSemantic } from '../../lib/workflow/element-fingerprint'
import type { Target } from '../../lib/ops'
import { createDriverConditionProbe, evaluateConditionWithProbe } from './condition-runtime'
import { verifyGoalSpec } from './goal-verifier'
import { workflowFingerprintOf } from '../../lib/workflow/checkpoints'
import { goalSpecOf, isGeneratedStrict } from '../../lib/workflow/reliability'
import { validateGeneratedWorkflow } from '../../lib/workflow/generated-validation'
import { TraceCollector } from '../../lib/workflow/execution-trace'
import { traceFailureFrom } from '../../lib/workflow/repair/failure-classifier'
import type { TraceEntry } from '../../lib/workflow/repair/types'

/**
 * One store for the whole background script: checkpoints are per-run, and the
 * in-memory half is what the rollback path reads synchronously.
 */
let checkpointStore = createChromeCheckpointStore()

/** Exposed for tests and for the debug session's rollback path. */
export function getCheckpointStore(): ReturnType<typeof createChromeCheckpointStore> {
  return checkpointStore
}

/** Replaces the store (tests inject an isolated one). */
export function setCheckpointStore(next: ReturnType<typeof createChromeCheckpointStore>): void {
  checkpointStore = next
}

/**
 * Newest run id per workflow — how the panel finds the run to resume from
 * without having to scan every checkpoint. Populated as runs start, and back-
 * filled from the persisted index by {@link findRunIdFor}.
 */
const lastRunByWorkflow = new Map<string, string>()

/**
 * The most recent run id of `workflowId`, consulting the persisted index when
 * this worker session has not seen a run of it.
 *
 * The session map alone is not enough for the panel: an MV3 worker is evicted
 * once a run settles, so the user's "Resume" click usually lands in a fresh
 * worker that remembers nothing. The persisted copy of the checkpoints is the
 * only durable link from a workflow to its last run, and reading it is what
 * makes the resume point survive a restart. The hit is cached so a poll from
 * the panel does not re-scan storage every time.
 */
export async function findRunIdFor(workflowId: string): Promise<string | undefined> {
  const known = lastRunByWorkflow.get(workflowId)
  if (known) return known
  const persisted = await findNewestPersistedRunId(workflowId)
  if (persisted) lastRunByWorkflow.set(workflowId, persisted)
  return persisted
}

/** Resolve a node id to a human-readable block label for run logs. */
function nodeLabel(workflow: Workflow, nodeId: string): string {
  const node = workflow.drawflow.nodes.find((n) => n.id === nodeId)
  if (!node) return nodeId
  const blockId = (node.data?.['blockId'] as string) || node.label
  const block = BLOCK_BY_ID.get(blockId)
  const desc = (node.data?.['description'] as string) || ''
  const name = block?.name ?? blockId
  return desc ? `${name}: ${desc}` : name
}

export interface ExecuteWorkflowOptions {
  source: RunSource
  taskId?: string
  feishuChatId?: string
  variables?: Record<string, unknown>
  /**
   * Window id of the panel that launched this run. Validated once here and
   * threaded to every block, so panel-started runs act ONLY inside that
   * window; undefined (scheduler, Feishu, triggers) keeps the legacy global
   * resolution. A non-normal window (standalone editor popup) also degrades
   * to undefined inside {@link normalScopeFromWindowId}.
   */
  scopeWindowId?: number
  /** Node id to start execution from ("run workflow from here"); defaults to the trigger/first node. */
  startAt?: string
  /** Capture per-block variable snapshots for the logs viewer (debug mode). */
  debug?: boolean
  /**
   * AI takeover hook (AI 调试): handed to the engine so a failed node is
   * completed by the AI agent on the live page instead of failing the run.
   */
  aiTakeover?: AiTakeoverHook
  /** Optional caller-side sink for each engine step, fired alongside the run log. */
  onStep?: (kind: string, nodeId: string, text: string) => void
  /**
  /**
   * M4: persist a per-step checkpoint (`checkpoints/<runId>.json`) so a run can
   * be resumed — or rolled back to its last known-good step — after a crash or
   * a service-worker restart. Default true; pass false for cheap throwaway runs.
   */
  checkpoints?: boolean
  /**
   * M4: correlates this run with the debug session that spawned it, so every
   * checkpoint, takeover stat and run row of one session can be joined.
   */
  sessionId?: string
  /**
   * M4: resume a previous run instead of starting from the trigger. The run's
   * checkpoints decide where: execution starts at the node AFTER the last step
   * that settled cleanly, with that step's variables.
   *
   * This is the fix for non-idempotent flows — re-driving a login that already
   * happened can only fail, so a retry must skip what already landed.
   * Unresumable (no checkpoints, node gone) falls back to a normal start.
   */
  resumeFrom?: string
  /**
   * Entry label for the unified {@link ExecutionTrace}. Regular runs classify
   * as `VERIFY`; debug sessions / replay runners override this.
   */
  traceEntry?: TraceEntry
  /**
   * Reuse a run the caller already started instead of opening a second one.
   *
   * The scheduled-task runner already tracks the task as a run; without this,
   * every workflow-kind task produced TWO run records — the task wrapper
   * (carrying only its two "starting" lines) and this engine's own run (carrying
   * the real steps). The two were persisted back-to-back, so the read-modify-
   * write on the shared run log could drop one of them and the surviving card
   * could be the empty wrapper — a task that looks like it never ran.
   *
   * With a reused run the engine records its steps onto that run and the caller
   * keeps ownership of finishing it; the run's `workflowId` is back-filled so
   * the editor's run logs still find it.
   */
  reuseRun?: RunningTask
}

export interface ExecuteWorkflowResult {
  runId: string
  outcome: 'ok' | 'cancelled' | 'failed'
  summary?: string
  error?: string
  /** Final variable store (goal-check evidence for the debug session). */
  variables?: Record<string, unknown>
  /** Run step tail (goal-check evidence for the debug session). */
  steps?: { kind: string; nodeId?: string; text: string }[]
  /**
   * M4: the step index this run resumed FROM, when `resumeFrom` pointed at a
   * resumable run. Absent for a normal (or a non-resumable) start.
   */
  resumedFrom?: number
  /**
   * Unified execution evidence (spec §5.1), aggregated in real time from the
   * engine callbacks. Optional for legacy callers / records.
   */
  trace?: import('../../lib/workflow/repair/types').ExecutionTrace
}

/**
 * Run `workflow` as a tracked task, mapping engine steps onto the run's log.
 * A thrown engine error (e.g. a cancellation escaping the engine) is treated as
 * a `'cancelled'` abort so the board never shows a crashed run as `'ok'`.
 *
 * When `opts.reuseRun` is given the caller's run is used as-is: the engine's
 * steps land on it and this function does NOT finish it (the caller does), so
 * a scheduled workflow task is ONE run-log entry rather than two.
 */
/**
 * The REAL readiness probe for generated-strict runs, over the driver.
 *
 * Every poll is a FRESH observation (the readiness engine re-invokes this per
 * poll — a cached answer would be the stale-observation bug): element states
 * go through kernel ops on the automation tab, `navigation-settled` reads the
 * tab's load status, and `value-committed` reads the live control value.
 * Probe failures read as "not satisfied" — the wait window decides, the poll
 * never throws the wait away.
 */
export function createDriverReadinessProbe(
  signal: AbortSignal,
  scope?: ScopeWindow,
): ReadinessProbe {
  const targetFor = (
    requirement: import('../../lib/workflow/readiness').ReadinessRequirement,
    nodeSelector: string,
  ): Target | undefined => {
    if (requirement.target) {
      const spec = targetSpecFromSemantic(requirement.target)
      if (spec) return { primary: spec, fallbacks: [] }
    }
    if (nodeSelector.trim()) {
      return { primary: { how: 'css', value: nodeSelector.trim() }, fallbacks: [] }
    }
    return undefined
  }
  return async (requirement, nodeSelector) => {
    switch (requirement.state) {
      case 'present': {
        const target = targetFor(requirement, nodeSelector)
        if (!target) return { satisfied: false, detail: '没有可探测的定位' }
        const result = await execOnActiveTab(
          { action: 'element_exists', target },
          signal,
          undefined,
          scope,
        ).catch(() => undefined)
        const found =
          (typeof result?.data === 'number' && result.data > 0) || result?.found === true
        return found ? { satisfied: true } : { satisfied: false, detail: '元素尚未出现' }
      }
      case 'visible':
      case 'enabled': {
        const target = targetFor(requirement, nodeSelector)
        if (!target) return { satisfied: false, detail: '没有可探测的定位' }
        const result = await execOnActiveTab(
          { action: 'actionability', target },
          signal,
          undefined,
          scope,
        ).catch(() => undefined)
        const state = (result?.data as { state?: string } | undefined)?.state
        if (state === 'ready') return { satisfied: true }
        if (state === 'blocked') {
          // Blocked covers disabled/occluded — precise enough for both waits
          // to keep polling without a second injection.
          return {
            satisfied: false,
            detail: requirement.state === 'enabled' ? '元素暂不可用' : '元素尚未可见或被遮挡',
          }
        }
        return { satisfied: false, detail: '元素尚未出现' }
      }
      case 'navigation-settled': {
        // The tab the automation is bound to must have finished loading.
        try {
          const tab = await resolveAutomationTab(undefined, scope)
          if (!tab) return { satisfied: false, detail: '没有可探测的标签页' }
          const settled = await new Promise<boolean>((resolve) => {
            try {
              void chrome.tabs.get(tab.id ?? 0, (t) => {
                void resolve(!!t && t.status === 'complete')
              })
            } catch {
              resolve(false)
            }
          })
          return settled ? { satisfied: true } : { satisfied: false, detail: '页面尚未加载完成' }
        } catch {
          return { satisfied: false, detail: '标签页状态不可读' }
        }
      }
      case 'value-committed': {
        const target = targetFor(requirement, nodeSelector)
        if (!target) return { satisfied: false, detail: '没有可探测的定位' }
        const result = await execOnActiveTab(
          { action: 'get_value', target },
          signal,
          undefined,
          scope,
        ).catch(() => undefined)
        const value = typeof result?.data === 'string' ? result.data : undefined
        if (value === undefined) {
          return { satisfied: false, detail: '无法读取控件值' }
        }
        const expected = requirement.value ?? ''
        return value === expected
          ? { satisfied: true }
          : { satisfied: false, detail: `控件值尚未提交（期望 "${expected}"，实际 "${value}"）` }
      }
      default:
        // `stable` / `data-ready`: no page-level probe yet — satisfied, so the
        // wait never blocks on a state we cannot observe.
        return { satisfied: true }
    }
  }
}

export async function executeWorkflow(
  workflow: Workflow,
  opts: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowResult> {
  const ownsRun = opts.reuseRun === undefined
  const run =
    opts.reuseRun ??
    startRun({
      label: workflow.name,
      source: opts.source,
      taskId: opts.taskId,
      workflowId: workflow.id,
      feishuChatId: opts.feishuChatId,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    })
  const runId = run.runId
  lastRunByWorkflow.set(workflow.id, runId)
  // The reused run was opened by the task runner, which knows the task but not
  // the workflow: back-fill the id so the editor's run logs still match it.
  if (!ownsRun) setRunWorkflow(runId, workflow.id)
  // M4: register the run in the persisted-checkpoint index so the pruner can
  // retire the oldest runs once enough of them have accumulated.
  const wantCheckpoints = opts.checkpoints !== false
  if (wantCheckpoints) void indexPersistedRun(runId)
  // Hoisted so the outer catch (engine error / cancellation) can still build a
  // trace against the seeded variable bag.
  let variables: Record<string, unknown> = {}
  // Hoisted: the catch path below reports it too (see `resumedFrom`).
  let resumedFrom: number | undefined
  // Unified trace (spec §5.1): every engine step / checkpoint is fed here in
  // real time, independently of the tail-capped steps returned by the engine.
  const traceCollector = new TraceCollector({
    workflowId: workflow.id,
    runId,
    entry: opts.traceEntry ?? 'VERIFY',
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  })

  try {
    // Validate the panel scope once for the whole run; every block then reads
    // the same ScopeWindow (no per-block window lookups).
    const scope =
      opts.scopeWindowId === undefined
        ? undefined
        : await normalScopeFromWindowId(opts.scopeWindowId)
    // Force-enable a short element wait on interaction blocks for EVERY run —
    // the cheapest fix for "element not found" caused by a slow render, which
    // otherwise costs a whole AI takeover. A workflow opts out with
    // `settings.defaultWaitMs = 0`; a block that already set its own wait keeps
    // it (applyDefaultWaits never overrides a user value).
    const effective = applyDefaultWaits(
      workflow,
      workflow.settings?.defaultWaitMs ?? DEFAULT_WAIT_MS,
    )
    // M4 resume: continue a previous run after its last clean step instead of
    // re-driving the whole graph. A login workflow re-run from its trigger hits
    // a login form that no longer exists; resuming skips what already landed.
    let startAt = opts.startAt
    // The scope a run starts with. Declared inputs (the trigger's `parameters`)
    // are seeded as DEFAULTS under whatever the caller supplied, so a trigger
    // payload wins over them. Without this a generated workflow's `{{keyword}}`
    // references — which is how it records business data instead of freezing it
    // — would resolve to nothing and drive the page with empty values.
    variables = seedFromTrigger(effective.trigger, opts.variables)
    // Generated-graph page hint: before the run starts, check whether the tab
    // it will drive is even the same origin as the page the graph was
    // generated on — the cheapest possible explanation for "first step says
    // element not found". Only fires for a manual trigger on an UNANCHORED
    // graph (no new-tab before the first element action), so a graph that
    // opens its own page is never bothered with it. Informational: the run
    // proceeds, because acting on a similar page may be exactly what the
    // user intends.
    const generationOriginUrl = effective.settings?.generationOriginUrl
    if (
      (effective.trigger?.type ?? 'manual') === 'manual' &&
      typeof generationOriginUrl === 'string' &&
      generationOriginUrl.trim() !== '' &&
      unanchoredElementStart(effective)
    ) {
      const tab = await resolveAutomationTab(undefined, scope).catch(() => undefined)
      const originOf = (url: string): string | null => {
        try {
          return new URL(url).origin
        } catch {
          return null
        }
      }
      const currentOrigin = typeof tab?.url === 'string' ? originOf(tab.url) : null
      const generatedOrigin = originOf(generationOriginUrl)
      if (currentOrigin && generatedOrigin && currentOrigin !== generatedOrigin) {
        addStep(
          runId,
          'status',
          `提示：当前页面（${currentOrigin}）与生成该工作流的页面（${generatedOrigin}）不同源，` +
            '元素定位很可能失效。若运行失败，请先打开生成时的页面再运行。',
        )
      }
    }
    if (opts.resumeFrom) {
      const inMemory = checkpointStore.load(opts.resumeFrom)
      const checkpoints =
        inMemory.length > 0 ? inMemory : await readPersistedCheckpoints(opts.resumeFrom)
      const point = resumePointOf(effective, checkpoints)
      if (point?.kind === 'side-effect-unknown') {
        // SIDE_EFFECT_UNKNOWN (spec §14): the unsafe action fired but its
        // outcome was never observed. A replay could double-submit; only a
        // human can confirm what happened. Fail the resume attempt with the
        // structured code the classifier maps to safety.
        const text = `SIDE_EFFECT_UNKNOWN: 节点 ${point.nodeId} 的不可逆动作已触发但结果未知（中断在恢复前）。请人工确认页面状态后重新运行；本次拒绝自动重放。`
        addStep(runId, 'error', text)
        const traceEarly = traceCollector.build('failed', variables ?? {}, traceFailureFrom(text))
        if (ownsRun)
          finishRun(runId, {
            outcome: 'failed',
            summary: '副作用结果未知，拒绝自动重放',
            error: text,
          })
        return {
          runId,
          outcome: 'failed',
          summary: '副作用结果未知，拒绝自动重放',
          error: text,
          trace: traceEarly,
        }
      }
      if (point?.kind === 'fingerprint-mismatch') {
        // Resume guard (spec §14): the recorded state describes a DIFFERENT
        // graph — replaying it onto the current one is undefined behavior.
        const text = `RESUME_GUARD: 检查点属于修改前的工作流（图指纹不一致），无法恢复；本次从头运行。`
        addStep(runId, 'status', text)
      } else if (point?.kind === 'ok') {
        startAt = point.nodeId
        // Layered over the SEEDED bag, not over `opts.variables`: resuming must
        // not drop the declared-input defaults the rest of the graph reads.
        variables = { ...(variables ?? {}), ...point.variables }
        resumedFrom = point.fromStepIndex
        addStep(
          runId,
          'status',
          `从第 ${point.fromStepIndex + 1} 步之后恢复运行（已跳过的步骤不再重复执行）`,
        )
      } else {
        addStep(runId, 'status', '没有可恢复的检查点，本次从头运行')
      }
    }
    // Reliability findings on every launch path (manual / scheduled / debug
    // verify / resume — they all come through here, spec §9). These are
    // NON-BLOCKING: findings are written to the run log as warnings, then the
    // workflow still runs. Saving and running must never be blocked; if the
    // graph genuinely fails, the execution surfaces the real error and AI
    // debug can repair it.
    if (isGeneratedStrict(effective)) {
      const report = validateGeneratedWorkflow(effective)
      if (!report.ok) {
        const lines = report.errors
          .slice(0, 6)
          .map((i) => `- [${i.code}] ${i.message}`)
          .join('\n')
        addStep(
          runId,
          'status',
          `可靠性校验发现以下待确认问题（不阻止运行，如运行失败可用 AI 调试修复）：\n${lines}`,
        )
      }
    }
    // --- Trace node state machine ----------------------------------------
    // The engine reports 'tool' (node entered), 'info' (retrying),
    // 'result'/'error' (settled via a block emit) and 'checkpoint' (durable
    // settle). We reduce those into per-node NodeExecutionTrace records.
    const traceNodeById = new Map(effective.drawflow.nodes.map((n) => [n.id, n]))
    let traceActiveNodeId: string | undefined
    /** Best-effort clone of the variable bag when a node started. */
    let traceBefore: Record<string, unknown> = {}
    const cloneVars = (): Record<string, unknown> => {
      try {
        return JSON.parse(JSON.stringify(variables ?? {})) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    /** Blocks that settle WITHOUT a checkpoint / result emit. */
    const TRACE_SILENT_BLOCKS = new Set([
      'trigger',
      'manual',
      'schedule',
      'scheduled',
      'visit-web',
      'context-menu',
      'on-startup',
      'keyboard-shortcut',
      'date',
      'specific-day',
      'element-change',
      'loop-data',
      'repeat-task',
      'while-loop',
      'loop-elements',
      'execute-workflow',
    ])
    const closeTraceNode = (
      nodeId: string,
      status: 'ok' | 'failed' | 'cancelled' | 'skipped',
      failure?: import('../../lib/workflow/repair/types').TraceFailure,
    ): void => {
      const node = traceNodeById.get(nodeId)
      if (!node) {
        traceActiveNodeId = undefined
        return
      }
      traceCollector.finishNode(node, status, traceBefore, variables ?? {}, failure)
      if (traceActiveNodeId === nodeId) traceActiveNodeId = undefined
    }
    const result = await runWorkflow(effective, {
      startAt,
      variables,
      signal: run.controller.signal,
      ...(scope ? { scope } : {}),
      ...(opts.aiTakeover ? { aiTakeover: opts.aiTakeover } : {}),
      // Generated-strict readiness: the real probe reads live page state per
      // poll (element presence/visibility, committed values, tab settle).
      readinessProbe: createDriverReadinessProbe(run.controller.signal, scope),
      // Generated-strict pre/postconditions and (after the run) goal
      // verification run through the same driver-backed page probe.
      evaluateCondition: (condition) =>
        evaluateConditionWithProbe(
          condition,
          variables,
          createDriverConditionProbe(run.controller.signal, scope),
        ),
      // Page-context guard (§11): observe the live tab cheaply; the engine
      // checks it before strict page-acting nodes (first + after tab change).
      getPageContext: async () => {
        try {
          const tab = await resolveAutomationTab(undefined, scope)
          return tab ? { url: tab.url ?? '' } : undefined
        } catch {
          return undefined
        }
      },
      loopElementCounter: (selector, signal) => countElements(selector, signal, scope),
      // Each iteration of a `loop-elements` body needs its own element; the
      // body references it as `{{loopElementSelector}}`.
      loopElementSelector: (selector, index, signal) =>
        elementSelectorAt(selector, index, signal, scope),
      // JS conditions run in the page: the service worker CSP forbids eval.
      evaluateExpression: async (code, vars) => {
        const result = await execJsOnActiveTab(
          `return (${code});`,
          { vars },
          run.controller.signal,
          undefined,
          scope,
        )
        return result.ok ? result.data : undefined
      },
      onSnapshot: opts.debug
        ? (nodeId, _blockId, variables) => {
            recordSnapshot(runId, nodeId, nodeLabel(workflow, nodeId), variables)
          }
        : undefined,
      // M4 checkpoints: one entry per settled node, persisted to
      // `checkpoints/<runId>.json`. The engine only reports the step; the run
      // id and the durable write live here so the engine stays chrome-free.
      onCheckpoint: ({
        stepIndex,
        nodeId,
        status,
        variables: checkpointVars,
        snapshotAvailable,
        phase,
      }) => {
        if (wantCheckpoints) {
          recordCheckpoint(checkpointStore, {
            runId,
            workflowId: workflow.id,
            stepIndex,
            nodeId,
            status,
            variables: checkpointVars,
            // Bind the resume guard + the snapshot-availability signal to this
            // point; a point with snapshotAvailable=false is never resumed.
            ...(snapshotAvailable === false ? { snapshotAvailable: false } : {}),
            // Resume guard (spec §14): the recorded state is bound to THIS
            // graph; a resume onto a different fingerprint is refused.
            workflowFingerprint: workflowFingerprintOf(effective),
            at: Date.now(),
            ...(phase ? { phase } : {}),
          })
        }
        // Trace: intermediate side-effect phases are recorded as events, but
        // only the node-settled entry (phase undefined) closes the attempt.
        traceCollector.recordCheckpoint(
          stepIndex,
          nodeId,
          status,
          checkpointVars,
          snapshotAvailable,
          ...(phase !== undefined ? [phase] : []),
        )
        if (phase === undefined && nodeId && traceActiveNodeId === nodeId) {
          closeTraceNode(nodeId, status === 'ok' ? 'ok' : status)
        }
      },
      onSubWorkflow: (phase, subWorkflowId) => {
        // Keep ONE trace spanning the parent→child nesting (P3, spec §15
        // Phase 8). Node executions inside the child carry workflowPathIndex.
        if (phase === 'enter') traceCollector.enterSubWorkflow(subWorkflowId)
        else traceCollector.exitSubWorkflow()
      },
      onStep: (kind, nodeId, text) => {
        // Trace state machine (see helpers above).
        traceCollector.recordStep(kind, nodeId || undefined, text)
        if (kind === 'tool') {
          // A new node entered: resolve the previous attempt.
          if (traceActiveNodeId && traceActiveNodeId !== nodeId) {
            const prior = traceNodeById.get(traceActiveNodeId)
            const priorBlock =
              typeof prior?.data?.['blockId'] === 'string'
                ? (prior.data['blockId'] as string)
                : (prior?.label ?? '')
            if (prior && TRACE_SILENT_BLOCKS.has(priorBlock)) {
              closeTraceNode(prior.id, 'ok')
            } else if (prior?.data?.['disableBlock'] === true) {
              closeTraceNode(prior.id, 'skipped')
            } else if (prior) {
              closeTraceNode(
                prior.id,
                'failed',
                traceFailureFrom('node interrupted by next step', prior.id),
              )
            }
          }
          const entered = traceNodeById.get(nodeId)
          if (entered) {
            traceActiveNodeId = nodeId
            traceBefore = cloneVars()
            traceCollector.startNode(entered, variables ?? {})
          }
          // Per-block header: resolved block name, not the raw node id.
          addStep(runId, 'tool', nodeLabel(workflow, nodeId), {
            nodeId,
            label: nodeLabel(workflow, nodeId),
          })
        } else if (kind === 'info' && traceActiveNodeId === nodeId && /retrying/i.test(text)) {
          // Engine retry: close the failed attempt, then start attempt N+1.
          closeTraceNode(nodeId, 'failed', traceFailureFrom(text, nodeId))
          const retried = traceNodeById.get(nodeId)
          if (retried) {
            traceBefore = cloneVars()
            traceCollector.startNode(retried, variables ?? {})
            traceActiveNodeId = nodeId
          }
          addStep(runId, kind, text, { nodeId, label: nodeLabel(workflow, nodeId) })
        } else {
          if (kind === 'error' && traceActiveNodeId === nodeId && text.startsWith('AI 接管失败')) {
            // Takeover failure settles the node; run completion follows.
            closeTraceNode(nodeId, 'failed', traceFailureFrom(text, nodeId))
          }
          addStep(runId, kind, text, { nodeId, label: nodeLabel(workflow, nodeId) })
        }
        // Surface to the caller (e.g. Feishu streaming) alongside the run log.
        opts.onStep?.(kind, nodeId, text)
      },
    })
    // L3 gate (spec §8.4): a strict run that "succeeded" must still prove the
    // GOAL. Deterministic conditions decide; the terminal-state path marks
    // alreadySatisfied; the LLM can never forge success. Failure rewrites the
    // outcome — execution success is not goal success.
    let goalNote: string | undefined
    let outcome: ExecuteWorkflowResult['outcome'] = run.controller.signal.aborted
      ? 'cancelled'
      : result.outcome
    if (outcome === 'ok') {
      const goal = goalSpecOf(effective)
      if (goal) {
        const verification = await verifyGoalSpec(goal, {
          variables: result.variables ?? variables ?? {},
          probe: createDriverConditionProbe(run.controller.signal, scope),
        })
        goalNote = verification.note
        addStep(runId, 'status', goalNote)
        if (!verification.achieved) {
          outcome = 'failed'
        }
      }
    }
    const summary = goalNote && outcome === 'failed' ? goalNote : result.summary
    // For a failed run, prefer the dedicated error field; fall back to summary
    // so legacy failures still show something in the history error block.
    const error = outcome === 'failed' ? (result.error ?? summary) : undefined
    // Finalize the trace: close any still-open attempt (trigger nodes, loop
    // bodies and blocks whose settle has no checkpoint) and build.
    if (traceActiveNodeId) {
      closeTraceNode(
        traceActiveNodeId,
        outcome === 'ok' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'failed',
        ...(outcome === 'failed'
          ? [traceFailureFrom(error ?? 'run failed', traceActiveNodeId)]
          : []),
      )
    }
    const trace = traceCollector.build(
      outcome,
      result.variables ?? variables ?? {},
      // failedNodeId is inferred by the collector from its failed record.
      ...(outcome === 'failed' ? [traceFailureFrom(error ?? 'run failed')] : []),
    )
    // A reused run is the caller's to finish — it may still add lines (e.g. a
    // notification step) after the engine settles.
    if (ownsRun) finishRun(runId, { outcome, summary, error })
    // Retire the oldest runs' checkpoints so repeated debugging cannot fill
    // the data directory. Fire-and-forget: pruning must never hold the run.
    if (wantCheckpoints) void prunePersistedCheckpoints()
    return {
      runId,
      outcome,
      summary,
      error,
      trace,
      ...(result.variables ? { variables: result.variables } : {}),
      ...(result.steps ? { steps: result.steps } : {}),
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    }
  } catch (e) {
    // A cancellation or engine error that leaked out of runWorkflow.
    const aborted =
      run.controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')
    if (aborted) {
      const trace = traceCollector.build('cancelled', variables ?? {})
      if (ownsRun) finishRun(runId, { outcome: 'cancelled' })
      return {
        runId,
        outcome: 'cancelled',
        trace,
        ...(resumedFrom !== undefined ? { resumedFrom } : {}),
      }
    }
    const text = e instanceof Error ? e.message : String(e)
    const trace = traceCollector.build('failed', variables ?? {}, traceFailureFrom(text))
    if (ownsRun) finishRun(runId, { outcome: 'failed', summary: text.split('\n')[0], error: text })
    if (wantCheckpoints) void prunePersistedCheckpoints()
    return {
      runId,
      outcome: 'failed',
      summary: text.split('\n')[0],
      error: text,
      trace,
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    }
  }
}
