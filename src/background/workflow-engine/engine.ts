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
import type { ScopeWindow } from '../automation-scope'
import {
  EXECUTORS,
  type BlockExecutor,
  type WorkflowExecCtx,
} from './executors'
import { LoopBreakpointError } from './loop-breakpoint'

export type EmitKind = 'tool' | 'status' | 'result' | 'error' | 'info'

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
  /** Override / inject the block-executor map (falls back to {@link EXECUTORS}). */
  executors?: Partial<Record<string, BlockExecutor>>
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
}

export interface WorkflowRunResult {
  outcome: 'ok' | 'cancelled' | 'failed'
  completedNodeIds: string[]
  summary?: string
  /** Full failure detail when outcome is 'failed'; may be multi-line. */
  error?: string
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
  return (
    error instanceof DOMException
      ? error.name === 'AbortError'
      : (error as { name?: string }).name === 'AbortError'
  )
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
    executors = EXECUTORS,
    parentWorkflowIds = new Set<string>(),
    loopElementCounter,
    evaluateExpression,
    onSnapshot,
  } = options

  const nodes = workflow.drawflow.nodes
  const edges = workflow.drawflow.edges
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const outBySource = new Map<string, WorkflowEdge[]>()
  for (const edge of edges) {
    const list = outBySource.get(edge.source)
    if (list) list.push(edge)
    else outBySource.set(edge.source, [edge])
  }

  const emit = (kind: EmitKind, nodeId: string, text: string) => onStep?.(kind, nodeId, text)
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
      // Index by bare suffix: `${blockId}-output-1` -> `output-1`.
      const m = /-(output-\d+|fallback)$/.exec(handle)
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
    const params = paramsOf(current)

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
      const bodyStart = outputs['loop'] ?? outputs['output-1'] ?? (endId === null ? defaultNext : null)
      return runLoop(current, params, bodyStart, endId)
    }
    if (blockId === 'execute-workflow') {
      completedNodeIds.push(nodeId)
      return runSubWorkflow(current, params, defaultNext)
    }

    const executor = executors[blockId]
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
    )
    const policy = onErrorPolicy(params)

    // Execute with Automa's onError semantics: retry up to retryTimes (with
    // retryInterval between attempts), then either route to the fallback handle
    // or fail.
    const maxAttempts = policy?.enable && policy.toDo === 'retry'
      ? 1 + Math.max(0, Number(policy.retryTimes ?? 0))
      : 1
    let resolver: string | null | undefined
    let lastError: unknown
    let succeeded = false
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        resolver = await executor(params, ctx)
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
          emit('info', nodeId, `Retrying (${attempt + 1}/${maxAttempts - 1}) after failure: ${message(e)}`)
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
      outcome = 'failed'
      error = error || text
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
        const parsed = JSON.parse(String(params['data'] ?? '[]'))
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
      const count = Math.max(0, Number(params['count'] ?? 1))
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
    const child = await getWorkflow(childId)
    if (!child) {
      emit('error', execNode.id, `execute-workflow: 未找到工作流 ${childId}`)
      return defaultNext
    }

    const childStack = new Set(parentWorkflowIds)
    childStack.add(childId)
    await runCore(child, {
      variables,
      signal: signalToUse,
      scope,
      executors,
      parentWorkflowIds: childStack,
      loopElementCounter,
      evaluateExpression,
      onSnapshot,
      onStep: onStep ? (kind, nodeId, text) => onStep(kind, nodeId, `[子] ${text}`) : undefined,
    })
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

  return { outcome, completedNodeIds, summary, ...(error ? { error } : {}) }
}