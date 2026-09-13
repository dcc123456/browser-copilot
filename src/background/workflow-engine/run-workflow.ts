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
import {
  createChromeCheckpointStore,
  findNewestPersistedRunId,
  indexPersistedRun,
  prunePersistedCheckpoints,
  readPersistedCheckpoints,
} from '../checkpoint-store'
import { addStep, finishRun, recordSnapshot, startRun, type RunSource } from '../running-tasks'
import { countElements, execJsOnActiveTab } from '../driver'
import { normalScopeFromWindowId } from '../automation-scope'
import { BLOCK_BY_ID } from '../../lib/workflow/blocks/palette'
import { runWorkflow } from './engine'
import type { AiTakeoverHook } from './engine'
import { DEFAULT_WAIT_MS, applyDefaultWaits } from './debug-session'

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
}

/**
 * Run `workflow` as a tracked task, mapping engine steps onto the run's log.
 * A thrown engine error (e.g. a cancellation escaping the engine) is treated as
 * a `'cancelled'` abort so the board never shows a crashed run as `'ok'`.
 */
export async function executeWorkflow(
  workflow: Workflow,
  opts: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowResult> {
  const run = startRun({
    label: workflow.name,
    source: opts.source,
    taskId: opts.taskId,
    workflowId: workflow.id,
    feishuChatId: opts.feishuChatId,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  })
  const runId = run.runId
  lastRunByWorkflow.set(workflow.id, runId)
  // M4: register the run in the persisted-checkpoint index so the pruner can
  // retire the oldest runs once enough of them have accumulated.
  const wantCheckpoints = opts.checkpoints !== false
  if (wantCheckpoints) void indexPersistedRun(runId)
  // Hoisted: the catch path below reports it too (see `resumedFrom`).
  let resumedFrom: number | undefined

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
    let variables = opts.variables
    if (opts.resumeFrom) {
      const inMemory = checkpointStore.load(opts.resumeFrom)
      const checkpoints =
        inMemory.length > 0 ? inMemory : await readPersistedCheckpoints(opts.resumeFrom)
      const point = resumePointOf(effective, checkpoints)
      if (point) {
        startAt = point.nodeId
        variables = { ...(opts.variables ?? {}), ...point.variables }
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
    const result = await runWorkflow(effective, {
      startAt,
      variables,
      signal: run.controller.signal,
      ...(scope ? { scope } : {}),
      ...(opts.aiTakeover ? { aiTakeover: opts.aiTakeover } : {}),
      loopElementCounter: (selector, signal) => countElements(selector, signal, scope),
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
      onCheckpoint: wantCheckpoints
        ? ({ stepIndex, nodeId, status, variables }) => {
            recordCheckpoint(checkpointStore, {
              runId,
              workflowId: workflow.id,
              stepIndex,
              nodeId,
              status,
              variables,
              at: Date.now(),
            })
          }
        : undefined,
      onStep: (kind, nodeId, text) => {
        if (kind === 'tool') {
          // Per-block header: resolved block name, not the raw node id.
          addStep(runId, 'tool', nodeLabel(workflow, nodeId), {
            nodeId,
            label: nodeLabel(workflow, nodeId),
          })
        } else {
          addStep(runId, kind, text, { nodeId, label: nodeLabel(workflow, nodeId) })
        }
        // Surface to the caller (e.g. Feishu streaming) alongside the run log.
        opts.onStep?.(kind, nodeId, text)
      },
    })
    const outcome: ExecuteWorkflowResult['outcome'] = run.controller.signal.aborted
      ? 'cancelled'
      : result.outcome
    const summary = result.summary
    // For a failed run, prefer the dedicated error field; fall back to summary
    // so legacy failures still show something in the history error block.
    const error = outcome === 'failed' ? (result.error ?? summary) : undefined
    finishRun(runId, { outcome, summary, error })
    // Retire the oldest runs' checkpoints so repeated debugging cannot fill
    // the data directory. Fire-and-forget: pruning must never hold the run.
    if (wantCheckpoints) void prunePersistedCheckpoints()
    return {
      runId,
      outcome,
      summary,
      error,
      ...(result.variables ? { variables: result.variables } : {}),
      ...(result.steps ? { steps: result.steps } : {}),
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    }
  } catch (e) {
    // A cancellation or engine error that leaked out of runWorkflow.
    const aborted =
      run.controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')
    if (aborted) {
      finishRun(runId, { outcome: 'cancelled' })
      return {
        runId,
        outcome: 'cancelled',
        ...(resumedFrom !== undefined ? { resumedFrom } : {}),
      }
    }
    const text = e instanceof Error ? e.message : String(e)
    finishRun(runId, { outcome: 'failed', summary: text.split('\n')[0], error: text })
    if (wantCheckpoints) void prunePersistedCheckpoints()
    return {
      runId,
      outcome: 'failed',
      summary: text.split('\n')[0],
      error: text,
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    }
  }
}
