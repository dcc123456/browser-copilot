/**
 * Execute a workflow operator against the live page.
 *
 * In workflow-generation mode every `wf_op_<id>` call does what the block would
 * do at replay time, then records the node. This module is the bridge: it runs
 * the SAME {@link EXECUTORS} entry the engine uses, so "what got recorded is
 * what actually happened" holds by construction rather than by keeping two
 * implementations in sync.
 *
 * Two things do not run inline:
 *
 *   - Blocks the engine interprets itself (loops, sub-workflows, the trigger):
 *     a single-node call cannot express them.
 *   - Blocks whose side effects the user never asked for (real HTTP requests,
 *     notifications, disk writes, nested agent runs). Firing those during a
 *     drafting session would be a surprise, so they are recorded with a note.
 *
 * Failure is reported, never thrown: the caller records nothing and hands the
 * error back to the model so it can correct itself.
 *
 * @module background/workflow-engine/operator-exec
 */

import { interpolateParams } from '../../lib/workflow/interpolate'
import { OPERATOR_BLOCK_IDS } from '../../lib/workflow/operator-tools'
import { operatorExecClass, recordOnlyReason } from '../../lib/workflow/operator-class'
import type { ScopeWindow } from '../automation-scope'
import { EXECUTORS, type BlockExecutor, type WorkflowExecCtx } from './executors'

export { OPERATOR_BLOCK_IDS }
// Re-exported so callers that already depend on the bridge keep one import; the
// classification itself lives in `lib/workflow/operator-class` so the tool
// catalogue can share it without reaching into the background layer.
export { operatorExecClass, recordOnlyReason }
export type { OperatorExecClass } from '../../lib/workflow/operator-class'

/** Which output port a branch block actually took. */
export type OperatorBranch = 'true' | 'false' | 'exists' | 'notExists' | 'loop' | 'end'

/** Blocks that route on an output port and so report which branch was taken. */
const BRANCH_BLOCK_IDS: ReadonlySet<string> = new Set(['conditions', 'condition', 'element-exists'])

/**
 * Sentinel node ids fed to a branch block as its `outputs`. The executor
 * returns whichever one it routed to, which tells us the branch it took without
 * the engine and without the model having to declare it. Each branch gets a
 * distinct sentinel so the mapping back is unambiguous.
 */
const SENTINEL_OUTPUTS: Readonly<Record<string, string>> = {
  true: '__bcBranchTrue',
  'output-1': '__bcBranchTrue',
  false: '__bcBranchFalse',
  'output-2': '__bcBranchFalse',
  exists: '__bcBranchExists',
  notExists: '__bcBranchNotExists',
  loop: '__bcBranchLoop',
  end: '__bcBranchEnd',
}

const SENTINEL_TO_BRANCH: Readonly<Record<string, OperatorBranch>> = {
  __bcBranchTrue: 'true',
  __bcBranchFalse: 'false',
  __bcBranchExists: 'exists',
  __bcBranchNotExists: 'notExists',
  __bcBranchLoop: 'loop',
  __bcBranchEnd: 'end',
}

export interface OperatorExecDeps {
  signal: AbortSignal
  scope?: ScopeWindow
  /** Tab to act on; undefined lets the driver resolve the active one. */
  tabId?: number
  /**
   * Generation-time variable bag. Mutated in place by blocks like
   * `set-variable` / `get-secret` so later calls can reference the values.
   */
  variables?: Record<string, unknown>
  /** Called when a navigation block pins a new tab, so later calls follow it. */
  setTab?: (tabId: number) => void
  /** Executor registry override, for tests. Defaults to the real registry. */
  executors?: Record<string, BlockExecutor>
}

export interface OperatorExecResult {
  status: 'executed' | 'record-only' | 'failed'
  /** Lines the executor emitted, echoed back to the model. */
  lines: string[]
  /** The port a branch block routed to, when it is one. */
  branch?: OperatorBranch
  error?: string
  /** Why a block was recorded without running (record-only status). */
  note?: string
}

/** Build a single-node execution context for the bridge. */
function buildCtx(
  deps: OperatorExecDeps,
  lines: string[],
  outputs: Record<string, string> | undefined,
): WorkflowExecCtx {
  const ctx: WorkflowExecCtx = {
    variables: deps.variables ?? {},
    refData: undefined,
    signal: deps.signal,
    emit: (_kind, text) => {
      if (text) lines.push(text)
    },
  }
  if (outputs) ctx.outputs = outputs
  if (typeof deps.tabId === 'number') ctx.tabId = deps.tabId
  if (deps.scope) ctx.scope = deps.scope
  if (deps.setTab) ctx.setTab = deps.setTab
  return ctx
}

/**
 * Run one operator against the live page.
 *
 * Never throws: a failure comes back as `status: 'failed'` with the executor's
 * message, so the caller can leave the draft untouched and let the model retry
 * with a better locator.
 */
export async function executeOperatorNode(
  blockId: string,
  data: Record<string, unknown>,
  deps: OperatorExecDeps,
): Promise<OperatorExecResult> {
  const cls = operatorExecClass(blockId)
  if (cls === 'record-only') {
    return {
      status: 'record-only',
      lines: [],
      note: recordOnlyReason(blockId),
    }
  }

  const registry = deps.executors ?? EXECUTORS
  const executor = registry[blockId]
  if (!executor) {
    return {
      status: 'record-only',
      lines: [],
      note: `no executor registered for "${blockId}"; recorded without running`,
    }
  }

  const variables = deps.variables ?? {}
  const params = interpolateParams(data, variables)
  const isBranch = BRANCH_BLOCK_IDS.has(blockId)
  const lines: string[] = []
  const ctx = buildCtx(deps, lines, isBranch ? { ...SENTINEL_OUTPUTS } : undefined)

  // A branch block with nothing to evaluate silently routes to its false port;
  // say so instead of recording a mystery edge.
  if (blockId === 'conditions' && !hasConditions(params)) {
    return {
      status: 'failed',
      lines,
      error:
        'conditions has neither a `code` expression nor any condition rows; nothing to evaluate. ' +
        'Provide `code` (a JS expression evaluated in the page) or `conditions` rows.',
    }
  }

  try {
    const next = await executor(params, ctx)
    const result: OperatorExecResult = { status: 'executed', lines }
    const branch = isBranch && typeof next === 'string' ? SENTINEL_TO_BRANCH[next] : undefined
    if (branch) result.branch = branch
    return result
  } catch (error) {
    return {
      status: 'failed',
      lines,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Whether a `conditions` node carries anything to evaluate. */
function hasConditions(params: Record<string, unknown>): boolean {
  const code = params['code']
  if (typeof code === 'string' && code.trim()) return true
  const groups = params['conditions']
  if (!Array.isArray(groups)) return false
  return groups.some(
    (group) =>
      !!group &&
      typeof group === 'object' &&
      Array.isArray((group as { conditions?: unknown }).conditions) &&
      (group as { conditions: unknown[] }).conditions.length > 0,
  )
}
