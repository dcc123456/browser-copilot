/**
 * Workflow execution engine.
 *
 * A pure, chrome-free interpreter that walks a `Workflow` graph, dispatching
 * each node's block label to its executor in {@link EXECUTORS}. Keeping this
 * layer free of any `chrome` / storage / running-task coupling makes the
 * routing, branching, cancellation and loop-guard logic directly unit-testable.
 *
 * @module background/workflow-engine/engine
 */

import type { Workflow, WorkflowEdge, WorkflowNode } from '../../lib/workflow/types'
import { getWorkflow } from '../../lib/workflow/storage'
import { interpolateParams } from '../../lib/workflow/interpolate'
import {
  ambiguityPolicyOf,
  idempotencyOf,
  isGeneratedStrict,
  nodeReliabilityOf,
  STRICT_MIN_MARGIN,
  STRICT_MIN_SCORE,
} from '../../lib/workflow/reliability'
import { describeCondition } from '../../lib/workflow/conditions'
import { checkPageContext, pageContextOf } from '../../lib/workflow/page-context'
import { ELEMENT_OP_BLOCKS } from '../../lib/workflow/generated-validation'
import type { DebugStepLine } from '../../lib/workflow/auto-debug-patch'
import type { ScopeWindow } from '../automation-scope'
import type { BlockExecutor, WorkflowExecCtx } from './executors'
import { EXECUTORS } from './executors'
import { LoopBreakpointError } from './loop-breakpoint'
import {
  prepareNodeExecution,
  verifyPostActionReadiness,
  type ReadinessProbe,
} from './readiness-engine'
import { withFailureVerdict } from './failure-classifier'

export type EmitKind = 'tool' | 'status' | 'result' | 'error' | 'info'

/**
 * Everything the AI takeover needs to complete ONE failed node's function.
 * `variables` is the run's LIVE store: the hook may write the step's output
 * into it (e.g. the node's `variableName`) so downstream references resolve.
 */
export interface AiTakeoverRequest {
  workflow: Workflow
  failingNodeId: string
  failedBlockId: string
  failedParams: Record<string, unknown>
  failedError: string
  /** Last node that completed BEFORE the failure (the takeover anchor). */
  previousNodeId?: string
  /** Engine step lines up to the failure (tail-capped), oldest first. */
  steps: DebugStepLine[]
  /** Live run variables (mutable — the takeover may write outputs). */
  variables: Record<string, unknown>
  signal: AbortSignal
  scope?: ScopeWindow
  tabId?: number
}

/** What the takeover reports back to the engine. */
export interface AiTakeoverOutcome {
  completed: boolean
  /** One-line summary of what the AI did (Chinese). */
  summary?: string
  /** Why the step could not be completed (feeds the run's failure). */
  reason?: string
  /** Classified failure reason (auth/captcha ⇒ already fast-failed upstream). */
  reasonKind?: import('../../lib/workflow/ai-takeover').TakeoverReasonKind
}

/** Engine-side hook: run the AI takeover for one failed node. */
export type AiTakeoverHook = (request: AiTakeoverRequest) => Promise<AiTakeoverOutcome | null>

export interface WorkflowRunOptions {
  /** Node id to start from. Defaults to the first trigger or, failing that, the first node. */
  startAt?: string
  /** Initial runtime variables. */
  variables?: Record<string, unknown>
  /** Shared abort signal; aborting requests a `'cancelled'` outcome. */
  signal?: AbortSignal
  /**
   * Panel-window scope threaded onto every block executor's ctx. Runs started
   * from the side panel scope to the panel's window; unattended runs omit it
   * for the legacy global resolution.
   */
  scope?: ScopeWindow
  /** Called for every status/result/error/info a block emits, plus engine errors. */
  onStep?(kind: EmitKind, nodeId: string, text: string): void
  /**
   * The readiness probe for generated-strict runs (see
   * `readiness-engine`). When absent, readiness waits are skipped for the
   * run — the engine never fails merely because no probe was wired.
   */
  readinessProbe?: ReadinessProbe
  /**
   * Evaluates one reliability condition against the live page + variables
   * (generated-strict pre/postconditions). Absent → conditions are skipped.
   */
  evaluateCondition?: (
    condition: import('../../lib/workflow/conditions').WorkflowCondition,
  ) => Promise<boolean>
  /**
   * Observes the CURRENT page (url/title) for the page-context guard (§11).
   * Absent → no guard. Refreshed whenever the automation tab changes.
   */
  getPageContext?: () => Promise<
    import('../../lib/workflow/page-context').CurrentPageContext | undefined
  >
  /** Override / inject the block-executor map. When omitted, the browser
   * executors are lazy-loaded (they pull the chrome-coupled driver chain);
   * Node-based runners such as the server runner always pass their own map,
   * so that chain is never loaded there. */
  executors?: Partial<Record<string, BlockExecutor>>
  /**
   * Resolves a sub-workflow id for `execute-workflow` blocks. Defaults to the
   * chrome-backed `storage.getWorkflow`; Node-based runners (the server
   * runner) inject a file-backed resolver so the pure engine stays
   * chrome-free.
   */
  resolveWorkflow?: (id: string) => Promise<Workflow | null>
  /**
   * Workflow ids already on the `execute-workflow` call stack, used to guard
   * against a→a self-loops. Filled in by recursive `runCore` calls.
   */
  parentWorkflowIds?: Set<string>
  /**
   * Resolves how many page elements a `loop-elements` block should iterate.
   * Injected by the integration layer so the pure engine stays chrome-free; in
   * tests a stub or a literal `count` value in the node data may be used.
   */
  loopElementCounter?: (cssSelector: string, signal: AbortSignal) => number | Promise<number>
  /**
   * Resolves a CSS selector for the `index`-th element matched by
   * `cssSelector`, or null when the page cannot express it.
   *
   * A `loop-elements` body needs to act on the CURRENT element, and the only
   * way to express that through a block's `selector` string is a token that
   * resolves to a real selector — so each iteration publishes its element as
   * `variables['loopElementSelector']` and a body node written as
   * `'{{loopElementSelector}} .price'` targets the right one. Without this hook
   * the token stays literal and every iteration acts on the same element.
   */
  loopElementSelector?: (
    cssSelector: string,
    index: number,
    signal: AbortSignal,
  ) => string | null | Promise<string | null>
  /**
   * Evaluates a JS condition/expression against the run's variables. Injected
   * by the integration layer so the pure engine stays chrome-free; in the real
   * MV3 build it runs the code in the page (the service worker CSP forbids
   * `eval`/`new Function`). Tests may omit it, in which case the engine falls
   * back to a local `new Function` evaluation (valid in Node).
   */
  evaluateExpression?: (code: string, vars: Record<string, unknown>) => unknown | Promise<unknown>
  /**
   * Debug mode: when set, the engine captures a snapshot of the run variables
   * after each executed block (keyed by node id), so a logs viewer can inspect
   * them. Receives the node id, the resolved block label, and a CLONE of the
   * variables at that point.
   */
  onSnapshot?: (nodeId: string, label: string, variables: Record<string, unknown>) => void
  /**
   * M4 checkpoints: called after EVERY node settles — success, failure or
   * cancellation — so a durable backend can persist a resume point per step.
   *
   * The engine stays chrome- and fs-free: it only reports the step; the
   * integration layer (`run-workflow.ts`, the server runner) supplies the run
   * id and writes to its own store. Omitted ⇒ no checkpoints (default).
   */
  onCheckpoint?: (entry: {
    stepIndex: number
    nodeId: string
    status: 'ok' | 'failed' | 'cancelled'
    variables: Record<string, unknown>
    /**
     * Whether the variable snapshot was captured (spec §5.1). False when the
     * variables could not be deep-copied; the integration layer must then not
     * treat the point as an empty-variable / resumable state.
     */
    snapshotAvailable: boolean
    /** Fine-grained phase (spec §14) — set on side-effect-safety entries. */
    phase?: import('../../lib/workflow/checkpoints').CheckpointPhase
  }) => void
  /**
   * AI takeover (AI 接管): when a block fails, the engine hands that ONE node
   * to the injected hook before failing the run. The hook completes the node's
   * function on the live page (seeing the page through the agent's tools); on
   * success the engine continues with the node's downstream, on failure the
   * run fails with the takeover's reason appended. Chrome-free: the real
   * hook lives in `workflow-engine/ai-takeover`.
   */
  aiTakeover?: AiTakeoverHook
  /**
   * Sub-workflow nesting notifications (P3, spec §15 Phase 8): called with
   * 'enter' before an `execute-workflow` runs its child and 'exit' after it
   * returns. The integration layer uses this to keep one trace spanning the
   * full parent→child chain. Omitted ⇒ no nesting events.
   */
  onSubWorkflow?: (phase: 'enter' | 'exit', workflowId: string) => void
}

export interface WorkflowRunResult {
  outcome: 'ok' | 'cancelled' | 'failed'
  completedNodeIds: string[]
  summary?: string
  /** Full failure detail when outcome is 'failed'; may be multi-line. */
  error?: string
  /**
   * The run's final variable store (the same object the blocks mutated).
   * Evidence for the debug session's goal-completion check — "no error" does
   * not mean "goal achieved", and what the nodes PRODUCED is the proof.
   */
  variables?: Record<string, unknown>
  /** Tail of the run's step lines (oldest last), for the same evidence. */
  steps?: DebugStepLine[]
}

/** Guards against infinite/long loops in mis-wired graphs. */
const MAX_STEPS = 2000

/** Guards a `while-loop` whose body never progresses toward a false condition. */
const MAX_WHILE_ITERATIONS = 1000

/** Block ids that represent launch triggers; used to pick a start node. */
const TRIGGER_BLOCK_IDS = new Set([
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
])

/** Cloud-only blocks that cannot run locally. */
const CLOUD_BLOCK_IDS = new Set([
  'ai-workflow',
  'block-package',
  'google-sheets',
  'google-sheets-drive',
  'google-drive',
])

/** onError action payload Automa stores per block. */
interface OnErrorPolicy {
  enable?: boolean
  retry?: boolean
  toDo?: 'retry' | 'fallback' | 'error' | 'continue'
  retryTimes?: number
  retryInterval?: number
  errorMessage?: string
}

function onErrorPolicy(params: Record<string, unknown>): OnErrorPolicy | null {
  const raw = params['onError']
  if (!raw || typeof raw !== 'object') return null
  const p = raw as OnErrorPolicy
  // Normalize the editor's Automa-style shape ({retry:true, toDo:'error'|
  // 'continue'|'fallback', retryInterval in SECONDS}) onto the engine's
  // internal shape ({toDo:'retry', retryInterval in ms}). Legacy data stored
  // toDo:'retry' directly with ms intervals and keeps working.
  const wantsRetry = p.retry === true || p.toDo === 'retry'
  let interval = Number(p.retryInterval ?? 0)
  // Automa's UI enters the interval in whole seconds; treat small values (< 60)
  // as seconds (the old ms form was typically >= 500).
  if (wantsRetry && interval > 0 && interval < 60) interval = interval * 1000
  return {
    ...p,
    toDo: wantsRetry ? 'retry' : p.toDo === 'continue' ? 'error' : (p.toDo ?? 'error'),
    retryInterval: interval,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolve the canonical block id for a node. Newer workflows store it under
 * `data.blockId`; legacy nodes only have `label` (which was once the English
 * block id and later became the localized display name). Fall back in that
 * order so old saved graphs still dispatch, and so a Chinese display label
 * never reaches the executor registry.
 */
function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  if (typeof fromData === 'string' && fromData) return fromData
  return node.label
}

/**
 * Resolve the parameter bag for a block. The editor persists user-entered
 * values under `data.values`; some legacy / programmatically-built graphs
 * store params directly on `data`. We prefer `values` when present so
 * executors can keep reading `data['url']` etc. without knowing the layout.
 */
function paramsOf(node: WorkflowNode): Record<string, unknown> {
  const values = node.data?.['values']
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    return values as Record<string, unknown>
  }
  return node.data ?? {}
}

/**
 * Loop blocks the engine interprets directly (they recurse through their body
 * via {@link runSegment}, exactly like `loop-data`). An executor cannot drive a
 * loop body because it returns a single next-node id, so the loop semantics
 * live here in the interpreter. Keyed by block id.
 */
const LOOP_BLOCK_IDS = new Set(['loop-data', 'repeat-task', 'while-loop', 'loop-elements'])

const CANCELLED_SUMMARY = '运行已取消'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Evaluates a condition expression against the run's variables. Prefers the
 * injected evaluator (which runs the code in the page — the MV3 service worker
 * CSP forbids `eval`/`new Function`); falls back to a local `new Function`
 * evaluation in environments where that is allowed (pure-engine tests / Node).
 */
async function evalCondition(
  code: string,
  vars: Record<string, unknown>,
  evaluate?: (code: string, vars: Record<string, unknown>) => unknown | Promise<unknown>,
): Promise<boolean> {
  if (evaluate) {
    try {
      return Boolean(await evaluate(code, vars))
    } catch {
      return false
    }
  }
  try {
    const test = new Function('vars', 'refData', `return (${code})`)
    return Boolean(test(vars, undefined))
  } catch {
    return false
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: string }).name === 'AbortError'
}

/**
 * Export the default ref data value so run layers can opt out of it. The pure
 * engine has no table row, so refData is `undefined` unless the caller mutates
 * the shared context afterwards (engines do not persist across blocks beyond
 * `variables`).
 */
function buildExecCtx(
  variables: Record<string, unknown>,
  signal: AbortSignal,
  currentId: string,
  outputs: Record<string, string>,
  defaultNext: string | null,
  onStep: (kind: EmitKind, nodeId: string, text: string) => void,
  tabId: number | undefined,
  setTab: (id: number) => void,
  scope: ScopeWindow | undefined,
  reliability: WorkflowExecCtx['reliability'],
): WorkflowExecCtx {
  return {
    variables,
    refData: undefined,
    signal,
    outputs,
    defaultNext,
    tabId,
    setTab,
    ...(scope ? { scope } : {}),
    ...(reliability ? { reliability } : {}),
    emit: (kind, text) => onStep(kind, currentId, text),
  }
}

/**
 * Run a workflow to completion (or cancellation / failure).
 *
 * Pure and dependency-free so tests can exercise routing, branching, abort and
 * loop-guard behaviour without mocking `chrome`.
 */
export async function runWorkflow(
  workflow: Workflow,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  return runCore(workflow, options)
}

/** Sentinel returned by the loop body runner when it reaches the loop node. */
const LOOP_EXIT = '\u0000loop-exit'

/**
 * Internal interpreter shared by the top-level entry point and recursive
 * `execute-workflow` runs. The loop body and sub-workflow both reuse the same
 * node-walking logic so steps are counted against one shared MAX_STEPS.
 */
async function runCore(
  workflow: Workflow,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  const {
    startAt,
    variables = {},
    signal,
    scope,
    onStep,
    executors,
    resolveWorkflow,
    parentWorkflowIds = new Set<string>(),
    loopElementCounter,
    loopElementSelector,
    evaluateExpression,
    onSnapshot,
    onCheckpoint,
    aiTakeover,
    readinessProbe,
    evaluateCondition,
    getPageContext,
    onSubWorkflow,
  } = options

  // The browser executors are statically imported above. Node-based runners
  // (server runner) always pass their own `executors` map, so the browser
  // chain is never invoked there — only the default browser build uses it.
  // NOTE: dynamic `import()` is disallowed in ServiceWorkerGlobalScope per
  // the HTML spec, so we must use a static import instead.
  const executorsMap: Partial<Record<string, BlockExecutor>> = executors ?? EXECUTORS

  // The workflow's reliability contract, resolved once and threaded onto every
  // executor ctx. Generated-strict runs attach the strict resolve policy to
  // every element op (the kernel refuses ambiguous matches); compat runs get
  // `undefined` and keep the legacy resolver bit for bit.
  // Page-context guard state (§11): the expected fingerprint is derived ONCE
  // (generation origin or explicit settings.pageContext); the CURRENT page is
  // observed lazily and re-observed whenever the automation tab changes.
  const expectedPageContext = isGeneratedStrict(workflow) ? pageContextOf(workflow) : undefined
  let pageContextCheckedForTab: number | undefined | 'none' = 'none'

  const reliability: WorkflowExecCtx['reliability'] = isGeneratedStrict(workflow)
    ? {
        mode: 'generated-strict',
        ambiguity: ambiguityPolicyOf(workflow),
        minScore: STRICT_MIN_SCORE,
        minMargin: STRICT_MIN_MARGIN,
      }
    : undefined

  const nodes = workflow.drawflow.nodes
  const edges = workflow.drawflow.edges
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const outBySource = new Map<string, WorkflowEdge[]>()
  for (const edge of edges) {
    const list = outBySource.get(edge.source)
    if (list) list.push(edge)
    else outBySource.set(edge.source, [edge])
  }

  // Every engine line is recorded for the AI-takeover context (the takeover
  // prompt shows the run tail starting at the previous node).
  const stepLines: DebugStepLine[] = []
  const emit = (kind: EmitKind, nodeId: string, text: string) => {
    stepLines.push({ kind, ...(nodeId ? { nodeId } : {}), text })
    onStep?.(kind, nodeId, text)
  }
  const signalToUse = signal ?? new AbortController().signal

  const completedNodeIds: string[] = []
  let outcome: WorkflowRunResult['outcome'] = 'ok'
  let summary: string | undefined
  let error: string | undefined
  let steps = 0
  let currentNodeId = ''
  // The tab this run drives. Undefined until the first driver call resolves it;
  // navigation blocks pin it so steps follow the opened/navigated page rather
  // than the extension popup that launched the run.
  let targetTabId: number | undefined

  /**
   * M4 checkpoints: 0-based index of the step being recorded, incremented for
   * every node that SETTLES (ok / failed / cancelled) so a durable backend can
   * rebuild the run's progress in order.
   */
  let checkpointStep = 0

  /**
   * Reports one settled node to the checkpoint sink (no-op when unwired). The
   * variables are structurally cloned: a snapshot must be serializable, and it
   * must not alias the live store the next block is about to mutate.
   */
  const emitCheckpoint = (
    nodeId: string,
    status: 'ok' | 'failed' | 'cancelled',
    phase?: import('../../lib/workflow/checkpoints').CheckpointPhase,
  ): void => {
    if (!onCheckpoint) return
    let snapshot: Record<string, unknown> = {}
    let snapshotAvailable = true
    try {
      snapshot = JSON.parse(JSON.stringify(variables ?? {})) as Record<string, unknown>
    } catch {
      // A non-serializable bag must NOT be silently presented as empty vars
      // (spec §5.1). Mark the point unusable for a snapshot resume.
      snapshot = {}
      snapshotAvailable = false
    }
    onCheckpoint({
      stepIndex: checkpointStep++,
      nodeId,
      status,
      variables: snapshot,
      snapshotAvailable,
      ...(phase ? { phase } : {}),
    })
  }

  /** Overwrites `target` in place with `from` (keeps the object identity). */
  const restoreVariables = (
    target: Record<string, unknown>,
    from: Record<string, unknown>,
  ): void => {
    for (const key of Object.keys(target)) delete target[key]
    Object.assign(target, from)
  }

  /** Run exactly one node; returns the next node id or `null` to finish. */
  async function runNode(nodeId: string): Promise<string | null> {
    if (signalToUse.aborted) throw new DOMException('Aborted', 'AbortError')

    const current = nodeById.get(nodeId)
    if (!current) return null
    currentNodeId = nodeId

    // Emit a per-block marker so run logs show every block entered, even ones
    // that produce no status/result line of their own (click, delay, trigger).
    emit('tool', nodeId, '')

    if (++steps > MAX_STEPS) {
      emit('error', nodeId, '步骤超限，疑似死循环')
      outcome = 'failed'
      error = '步骤超限，疑似死循环'
      return null
    }

    const outEdges = outBySource.get(nodeId) ?? []
    const outputs: Record<string, string> = {}
    // Semantic branch keys by block, mapped to positional output handles:
    //   conditions   -> output-1 true / output-2 false
    //   element-exists -> output-1 exists / output-2 not exists
    //   loop blocks  -> output-1 loop body / output-2 after-loop
    const BRANCH_KEYS: Record<string, [string, string]> = {
      conditions: ['true', 'false'],
      'element-exists': ['exists', 'notExists'],
      'loop-data': ['loop', 'end'],
      'loop-elements': ['loop', 'end'],
      'while-loop': ['loop', 'end'],
      'repeat-task': ['loop', 'end'],
    }
    for (const edge of outEdges) {
      const handle = edge.sourceHandle ?? 'next'
      outputs[handle] = edge.target
      // Index by bare suffix: `${blockId}-output-1` -> `output-1`. `loop`/`end`
      // cover handles migration normalized from imported bare semantic keys.
      const m = /-(output-\d+|fallback|loop|end)$/.exec(handle)
      if (m) outputs[m[1]!] = edge.target
      // Index semantic keys for this block's branch handles.
      const pair = BRANCH_KEYS[blockIdOf(current)]
      if (pair) {
        if (handle.endsWith('-output-1')) outputs[pair[0]] = edge.target
        if (handle.endsWith('-output-2')) outputs[pair[1]] = edge.target
      }
      if (handle.endsWith('-output-fallback')) outputs['fallback'] = edge.target
    }
    const defaultNext = outEdges[0]?.target ?? null

    const blockId = blockIdOf(current)
    // One interpolation pass over the whole bag, before anything reads it: the
    // executors' shared locator helpers (`sel` / `targetFrom`) resolve
    // `{{token}}` out of `data`, so a node carrying
    // `selector: '{{loopElementSelector}} .price'` reaches the driver with a
    // real selector. The loop / sub-workflow interpreters below read the same
    // bag, so their `selector` and `workflowId` resolve too.
    const params = interpolateParams(paramsOf(current), variables)

    // Cloud blocks are never executable locally.
    if (CLOUD_BLOCK_IDS.has(blockId)) {
      const text = `Block "${blockId}" requires Automa's cloud service and is not supported.`
      emit('error', nodeId, text)
      outcome = 'failed'
      error = text
      return null
    }

    // A disabled block is skipped (Automa's disableBlock) but the flow
    // continues along its default out-edge.
    if (params['disableBlock'] === true) {
      completedNodeIds.push(nodeId)
      return defaultNext
    }

    // Loop and sub-workflow blocks are handled by the engine itself, not by an
    // executor in the registry, so sub-runs and loop bodies recurse here too.
    // Body entry / after-loop exit resolve by handle semantics, not edge
    // order: `loop` (output-1) starts the body, `end` (output-2) runs once
    // after the loop finishes. A bare unlabeled edge still works as the body
    // (legacy / programmatic graphs), but only when no end edge exists.
    if (LOOP_BLOCK_IDS.has(blockId)) {
      completedNodeIds.push(nodeId)
      const endId = outputs['end'] ?? outputs['output-2'] ?? null
      const bodyStart =
        outputs['loop'] ?? outputs['output-1'] ?? (endId === null ? defaultNext : null)
      return runLoop(current, params, bodyStart, endId)
    }
    if (blockId === 'execute-workflow') {
      completedNodeIds.push(nodeId)
      return runSubWorkflow(current, params, defaultNext)
    }

    const executor = executorsMap[blockId]
    if (!executor) {
      const text = `没有找到块执行器: ${blockId}`
      emit('error', nodeId, text)
      outcome = 'failed'
      error = text
      return null
    }

    const ctx = buildExecCtx(
      variables,
      signalToUse,
      nodeId,
      outputs,
      defaultNext,
      emit,
      targetTabId,
      (id) => {
        targetTabId = id
      },
      scope,
      reliability,
    )
    const policy = onErrorPolicy(params)

    // Phase checkpoints for SIDE-EFFECT safety (spec §14): an unsafe node
    // (login/submit/send/create/delete/pay — classified by idempotencyOf)
    // records WHERE it got to, so a resume can tell "never fired" (safe to
    // re-run) from "fired but unobserved" (must never blind-replay).
    // Page-context guard (§11): before a strict run touches a page, the
    // current page must BE the page the workflow was made for. Checked on
    // the first page-acting node and refreshed whenever the tab changed.
    const pageActing =
      ELEMENT_OP_BLOCKS.has(blockId) || blockId === 'open-url' || blockId === 'new-tab'
    if (
      expectedPageContext &&
      getPageContext &&
      pageActing &&
      pageContextCheckedForTab !== (targetTabId ?? undefined)
    ) {
      const current = await getPageContext()
      const verdict = checkPageContext(expectedPageContext, current ?? {})
      if (!verdict.ok) {
        throw new Error(`${verdict.code}: ${verdict.message}`)
      }
      pageContextCheckedForTab = targetTabId ?? undefined
    }

    const unsafeSpec = nodeReliabilityOf(current)
    const unsafe = idempotencyOf(blockId, params, unsafeSpec) === 'unsafe'
    if (unsafe) emitCheckpoint(nodeId, 'ok', 'nodeStarted')

    // Terminal-state skip (spec §8.6/§14): on a strict run, an UNSAFE action
    // whose declared postconditions ALREADY hold must not re-fire — the goal
    // end state is there, and re-executing a submit/login to "prove" it is
    // the exact bug class the contract forbids. Skip the node, log why.
    if (unsafe && reliability && evaluateCondition && unsafeSpec?.postconditions?.length) {
      let terminalStateHolds = true
      for (const condition of unsafeSpec.postconditions) {
        if (!(await evaluateCondition(condition))) {
          terminalStateHolds = false
          break
        }
      }
      if (terminalStateHolds) {
        emit('status', nodeId, `终态已满足（${blockId} 动作早已生效），跳过该节点`)
        completedNodeIds.push(nodeId)
        emitCheckpoint(nodeId, 'ok', 'nodeCommitted')
        return defaultNext
      }
    }

    // Execute with Automa's onError semantics: retry up to retryTimes (with
    // retryInterval between attempts), then either route to the fallback handle
    // or fail.
    const maxAttempts =
      policy?.enable && policy.toDo === 'retry'
        ? 1 + Math.max(0, Number(policy.retryTimes ?? 0))
        : 1
    let resolver: string | null | undefined
    let lastError: unknown
    let succeeded = false
    // M4: a retry must NOT inherit the half-written state of the failed
    // attempt (a form already partially filled, a counter already bumped, a
    // variable overwritten with a truncated value). Restoring the pre-node
    // snapshot before attempt 2+ makes per-node retries IDEMPOTENT — without
    // it, a re-run of a non-idempotent block (submit / send / login) starts
    // from a state that is neither the original nor a clean one.
    let beforeNode: Record<string, unknown> | undefined
    if (maxAttempts > 1) {
      try {
        beforeNode = JSON.parse(JSON.stringify(variables ?? {})) as Record<string, unknown>
      } catch {
        beforeNode = undefined
      }
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0 && beforeNode) restoreVariables(variables, beforeNode)
        // Generated-strict readiness: the page must be READY before the action
        // (§7), re-checked on every attempt — a retry re-observes, it does not
        // assume. The readiness failure throws like any executor failure, so
        // onError (retry/fallback/continue) keeps its exact semantics.
        // Generated-strict preconditions: facts that must hold BEFORE the
        // action (spec §8.3). A failed precondition throws before the page is
        // touched — the retry path re-observes instead of blindly re-acting.
        const nodeSpec = nodeReliabilityOf(current)
        if (reliability && evaluateCondition && nodeSpec?.preconditions?.length) {
          for (const condition of nodeSpec.preconditions) {
            if (await evaluateCondition(condition)) continue
            throw new Error(`PRECONDITION_FAILED: ${describeCondition(condition)}`)
          }
        }
        if (reliability && readinessProbe) {
          const before = await prepareNodeExecution({
            node: current,
            blockId,
            params,
            nodeSelector: String(params['selector'] ?? params['cssSelector'] ?? ''),
            signal: signalToUse,
            probe: readinessProbe,
          })
          if (!before.ok) {
            throw new Error(`READINESS_TIMEOUT(${before.state}): ${before.detail ?? '页面未就绪'}`)
          }
        }
        if (unsafe) emitCheckpoint(nodeId, 'ok', 'sideEffectStarted')
        resolver = await executor(params, ctx)
        // Generated-strict post-action readiness (value committed, navigation
        // settled): verified BEFORE the node can count as succeeded.
        if (reliability && readinessProbe) {
          const after = await verifyPostActionReadiness({
            node: current,
            blockId,
            params,
            nodeSelector: String(params['selector'] ?? params['cssSelector'] ?? ''),
            signal: signalToUse,
            probe: readinessProbe,
          })
          if (!after.ok) {
            throw new Error(
              `READINESS_TIMEOUT(${after.state}): ${after.detail ?? '动作后状态未确认'}`,
            )
          }
        }
        // Generated-strict postconditions: the step's own claim about what its
        // success MEANS (spec §8). "Executor returned" is not "the step worked" —
        // only the declared facts make it so.
        if (reliability && evaluateCondition && nodeSpec?.postconditions?.length) {
          for (const condition of nodeSpec.postconditions) {
            if (await evaluateCondition(condition)) continue
            throw new Error(`POSTCONDITION_FAILED: ${describeCondition(condition)}`)
          }
        }
        if (unsafe) emitCheckpoint(nodeId, 'ok', 'sideEffectObserved')
        succeeded = true
        break
      } catch (e) {
        lastError = e
        if (isAbort(e)) break
        // A loop-breakpoint unwinds past per-block onError handling: the
        // enclosing loop catches it, not the retry/fallback machinery.
        if (e instanceof LoopBreakpointError) throw e
        if (attempt < maxAttempts - 1) {
          const waitMs = Math.max(0, Number(policy?.retryInterval ?? 1000))
          emit(
            'info',
            nodeId,
            `Retrying (${attempt + 1}/${maxAttempts - 1}) after failure: ${message(e)}`,
          )
          await sleep(waitMs)
        }
      }
    }

    if (!succeeded) {
      const e = lastError
      const text = message(e)
      emit('error', nodeId, text)
      if (isAbort(e)) {
        outcome = 'cancelled'
        summary = CANCELLED_SUMMARY
        emitCheckpoint(nodeId, 'cancelled')
        return null
      }
      // Automa toDo='continue': swallow the error and keep flowing down the
      // normal (non-fallback) edge instead of failing the whole run.
      if (policy?.enable && policy.toDo === 'continue') {
        emit('info', nodeId, `Continuing despite error: ${text}`)
        completedNodeIds.push(nodeId)
        return defaultNext
      }
      // Fallback routing: follow the edge from the `fallback` handle.
      if (policy?.enable && policy.toDo === 'fallback' && outputs['fallback']) {
        completedNodeIds.push(nodeId)
        return outputs['fallback']
      }
      // Custom error message for toDo='error'.
      if (policy?.enable && policy.toDo === 'error' && policy.errorMessage) {
        error = policy.errorMessage
        emit('error', nodeId, policy.errorMessage)
      }
      // AI takeover (AI 接管): before the run fails, hand the failed node to
      // the AI. It sees the page, completes THIS node's purpose; on success
      // the run continues with the node's downstream as if nothing happened.
      let takeoverReason: string | undefined
      if (aiTakeover && !isAbort(e) && !signalToUse.aborted) {
        const previousNodeId = completedNodeIds[completedNodeIds.length - 1]
        emit('status', nodeId, '运行失败，AI 开始接管该节点…')
        let outcome: AiTakeoverOutcome | null = null
        try {
          outcome = await aiTakeover(
            withFailureVerdict(
              {
                workflow,
                failingNodeId: nodeId,
                failedBlockId: blockId,
                failedParams: params,
                failedError: text,
                ...(previousNodeId ? { previousNodeId } : {}),
                steps: stepLines.slice(-25),
                variables,
                signal: signalToUse,
                ...(scope ? { scope } : {}),
                ...(targetTabId !== undefined ? { tabId: targetTabId } : {}),
              },
              {
                selector: String(params['selector'] ?? params['cssSelector'] ?? '') || undefined,
                variables,
                stepLines: stepLines.map((line) => line.text),
              },
            ),
          )
        } catch (takeoverError) {
          outcome = { completed: false, reason: message(takeoverError) }
        }
        if (outcome?.completed) {
          completedNodeIds.push(nodeId)
          emit(
            'result',
            nodeId,
            outcome.summary ? `AI 接管完成该步骤：${outcome.summary}` : 'AI 接管完成该步骤',
          )
          if (onSnapshot) {
            try {
              onSnapshot(nodeId, blockId, JSON.parse(JSON.stringify(variables ?? {})))
            } catch {
              onSnapshot(nodeId, blockId, {})
            }
          }
          return defaultNext
        }
        takeoverReason = outcome?.reason || 'AI 接管未完成该步骤'
        emit('error', nodeId, `AI 接管失败：${takeoverReason}`)
      }
      outcome = 'failed'
      error = error || (takeoverReason ? `${text}（AI 接管未完成：${takeoverReason}）` : text)
      emitCheckpoint(nodeId, 'failed')
      return null
    }

    const nextResult = resolver ?? defaultNext
    completedNodeIds.push(nodeId)
    if (onSnapshot) {
      try {
        // A structural clone strips non-serializable values for the viewer.
        onSnapshot(nodeId, blockId, JSON.parse(JSON.stringify(variables ?? {})))
      } catch {
        onSnapshot(nodeId, blockId, {})
      }
    }
    emitCheckpoint(nodeId, 'ok', unsafe ? 'nodeCommitted' : undefined)
    return nextResult
  }

  /**
   * Walk from `startId`, dispatching nodes, until the flow ends (null) or — when
   * a `stopAt` is given (the enclosing loop node) — the flow routes back to it.
   */
  async function runSegment(startId: string, stopAt?: string): Promise<string | null> {
    let currentId: string | null = startId
    while (currentId) {
      const next = await runNode(currentId)
      if (next === null) return null
      if (stopAt !== undefined && next === stopAt) return LOOP_EXIT
      currentId = next
    }
    return null
  }

  /**
   * Runs one loop-body segment, translating a `LoopBreakpointError` from the
   * body into a `'break'` signal when THIS loop owns it (no loopId = the
   * innermost loop; a loopId must match the loop node's values/data `loopId`
   * or the node id), rethrowing otherwise so an outer loop can claim it.
   * `'ok'` = the body finished with the run still ok; `'failed'` = the run
   * outcome flipped to failed/cancelled (the loop stops without following
   * `endId`; the run result reports the outcome unchanged).
   */
  async function runLoopBody(
    loopNode: WorkflowNode,
    startId: string,
  ): Promise<'ok' | 'break' | 'failed'> {
    try {
      await runSegment(startId, loopNode.id)
    } catch (e) {
      if (e instanceof LoopBreakpointError) {
        const wanted = e.loopId ?? ''
        const owners = [paramsOf(loopNode)['loopId'], loopNode.data?.['loopId'], loopNode.id].map(
          (v) => (v === undefined || v === null ? '' : String(v)),
        )
        if (wanted === '' || owners.includes(wanted)) return 'break'
      }
      throw e
    }
    return outcome === 'ok' ? 'ok' : 'failed'
  }

  /**
   * Runs the body of a loop block once per iteration, dispatching on the loop
   * block's label:
   * - `loop-data`: once per parsed JSON array item (exposes loopIndex/loopItem)
   * - `repeat-task`: a fixed number of times
   * - `while-loop`: until its `code` expression evaluates to false
   * - `loop-elements`: once per page element matched (exposes loopIndex)
   */
  async function runLoop(
    loopNode: WorkflowNode,
    params: Record<string, unknown>,
    startId: string | null,
    endId: string | null,
  ): Promise<string | null> {
    const label = blockIdOf(loopNode)

    if (label === 'loop-data') {
      let items: unknown[] = []
      try {
        // `loopData` is the catalog + tool-schema key; `data` is the engine
        // shape. Reading only the latter made a generated loop iterate nothing.
        const parsed = JSON.parse(String(params['data'] ?? params['loopData'] ?? '[]'))
        if (Array.isArray(parsed)) items = parsed
      } catch {
        emit('error', loopNode.id, 'loop-data: 数据解析失败')
        return null
      }
      emit('status', loopNode.id, `开始循环，共 ${items.length} 项`)
      if (startId === null) return endId
      for (let i = 0; i < items.length; i++) {
        if (signalToUse.aborted) throw new DOMException('Aborted', 'AbortError')
        variables['loopIndex'] = i
        variables['loopItem'] = items[i]
        const seg = await runLoopBody(loopNode, startId)
        if (seg === 'failed') return null
        if (seg === 'break') return endId
      }
      return endId
    }

    if (label === 'repeat-task') {
      // `count` is the engine/chat shape; the editor catalog seeds and edits
      // `repeatFor` (string) — accept both so editor-built loops repeat.
      const count = Math.max(0, Number(params['count'] ?? params['repeatFor'] ?? 1))
      emit('status', loopNode.id, `重复执行 ${count} 次`)
      if (startId === null) return endId
      for (let i = 0; i < count; i++) {
        if (signalToUse.aborted) throw new DOMException('Aborted', 'AbortError')
        variables['loopIndex'] = i
        const seg = await runLoopBody(loopNode, startId)
        if (seg === 'failed') return null
        if (seg === 'break') return endId
      }
      return endId
    }

    if (label === 'while-loop') {
      const code = String(params['code'] ?? 'false')
      if (startId === null) return endId
      let iterations = 0
      while (await evalCondition(code, variables, evaluateExpression)) {
        if (signalToUse.aborted) throw new DOMException('Aborted', 'AbortError')
        variables['loopIndex'] = iterations
        const seg = await runLoopBody(loopNode, startId)
        if (seg === 'failed') return null
        if (seg === 'break') return endId
        if (++iterations > MAX_WHILE_ITERATIONS) {
          const text = 'while-loop: 迭代超限，疑似死循环'
          emit('error', loopNode.id, text)
          outcome = 'failed'
          error = text
          return null
        }
      }
      return endId
    }

    // loop-elements
    const selector = String(params['selector'] ?? params['cssSelector'] ?? '')
    let count = 0
    if (loopElementCounter) {
      count = await loopElementCounter(selector, signalToUse)
    } else {
      // Non-browser contexts (pure engine tests) fall back to a literal count.
      count = Math.max(0, Number(params['count'] ?? 0))
    }
    emit('status', loopNode.id, `遍历 ${count} 个元素`)
    if (startId === null) return endId
    for (let i = 0; i < count; i++) {
      if (signalToUse.aborted) throw new DOMException('Aborted', 'AbortError')
      variables['loopIndex'] = i
      // Publish the CURRENT element as a selector the body can splice into its
      // own (`'{{loopElementSelector}} .price'`). Resolution failure is not
      // fatal: the body then fails on a literal token and the log says why,
      // which beats silently re-targeting iteration 0's element every round.
      if (loopElementSelector) {
        let current: string | null = null
        try {
          current = await loopElementSelector(selector, i, signalToUse)
        } catch (error) {
          if (isAbort(error)) throw error
          current = null
        }
        if (current === null) {
          emit('error', loopNode.id, `无法为第 ${i + 1} 个元素生成唯一选择器，循环体可能定位失败`)
        }
        variables['loopElementSelector'] = current ?? ''
      }
      const seg = await runLoopBody(loopNode, startId)
      if (seg === 'failed') return null
      if (seg === 'break') return endId
    }
    return endId
  }

  /**
   * Executes a referenced workflow as a nested run, then follows the edge.
   * A loop-breakpoint thrown inside the child is contained by the child's own
   * top-level catch — it can never break a loop in the parent.
   */
  async function runSubWorkflow(
    execNode: WorkflowNode,
    params: Record<string, unknown>,
    defaultNext: string | null,
  ): Promise<string | null> {
    const childId = String(params['workflowId'] ?? '')
    if (parentWorkflowIds.has(childId)) {
      emit('error', execNode.id, `execute-workflow: 检测到工作流自循环 ${childId}`)
      return defaultNext
    }
    const child = resolveWorkflow ? await resolveWorkflow(childId) : await getWorkflow(childId)
    if (!child) {
      emit('error', execNode.id, `execute-workflow: 未找到工作流 ${childId}`)
      return defaultNext
    }

    const childStack = new Set(parentWorkflowIds)
    childStack.add(childId)
    onSubWorkflow?.('enter', childId)
    await runCore(child, {
      variables,
      signal: signalToUse,
      scope,
      executors: executorsMap,
      ...(resolveWorkflow ? { resolveWorkflow } : {}),
      parentWorkflowIds: childStack,
      loopElementCounter,
      loopElementSelector,
      evaluateExpression,
      onSnapshot,
      // A child run shares the parent's checkpoint sink: it is the same
      // logical run, and the parent's integration layer owns the run id.
      onCheckpoint,
      // Keep one trace spanning the full parent→child nesting (P3).
      onSubWorkflow,
      onStep: onStep ? (kind, nodeId, text) => onStep(kind, nodeId, `[子] ${text}`) : undefined,
    })
    onSubWorkflow?.('exit', childId)
    return defaultNext
  }

  try {
    let startId = startAt
    if (!startId) startId = nodes.find((n) => TRIGGER_BLOCK_IDS.has(blockIdOf(n)))?.id
    if (!startId) startId = nodes[0]?.id
    if (startId) await runSegment(startId)
  } catch (e) {
    if (e instanceof LoopBreakpointError) {
      // A loop-breakpoint fired outside any loop (or its loopId matched
      // nothing): benign — stop the chain here and keep the run 'ok'.
      emit('info', currentNodeId, 'loop-breakpoint: 不在循环内，已忽略')
    } else {
      // Top-of-loop abort check (or an unexpected engine error) surfaced here.
      const text = message(e)
      emit('error', currentNodeId, text)
      if (isAbort(e)) {
        outcome = 'cancelled'
        summary = CANCELLED_SUMMARY
      } else {
        outcome = 'failed'
        error = text
      }
    }
  }

  return {
    outcome,
    completedNodeIds,
    summary,
    ...(error ? { error } : {}),
    variables,
    steps: stepLines.slice(-40),
  }
}
