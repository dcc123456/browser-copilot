/**
 * ExecutionTrace collector (spec §5.1, Phase 1).
 *
 * Aggregates engine callbacks (`onStep`, `onCheckpoint`, `onSnapshot`) into one
 * {@link ExecutionTrace} IN REAL TIME, so the evidence never depends on the
 * tail-capped `steps.slice(-40)` the engine returns. The collector is pure and
 * engine-agnostic: the integration layer (`run-workflow.ts`) feeds it, keeping
 * the existing run steps / checkpoints / running tasks unchanged.
 *
 * Per-node variable references are captured with `startNode`/`finishNode`,
 * which the integration layer calls around each node attempt. Retries append
 * a new {@link NodeExecutionTrace} instead of overwriting the old one.
 *
 * @module lib/workflow/execution-trace
 */

import { referencesIn } from './dynamic-data'
import { summarizeValue, summarizeVariables } from './repair/redaction'
import { contractOfNode } from './variable-contract'
import { evaluateContract } from './variable-contract'
import type {
  ExecutionTrace,
  NodeExecutionTrace,
  TraceEntry,
  TraceEvent,
  TraceFailure,
  VariableUseEvidence,
} from './repair/types'
import type { WorkflowNode } from './types'

let traceCounter = 0
function newTraceId(): string {
  traceCounter = (traceCounter + 1) % Number.MAX_SAFE_INTEGER
  return `trace-${Date.now().toString(36)}-${traceCounter.toString(36)}`
}

/** Convert a raw engine step kind into a trace-event kind. */
function asEventKind(kind: string): TraceEvent['kind'] {
  if (
    kind === 'tool' ||
    kind === 'status' ||
    kind === 'result' ||
    kind === 'error' ||
    kind === 'info'
  ) {
    return kind
  }
  return 'info'
}

/** Extract the variable references a node reads, with the param paths. */
export function inputRefsOf(
  node: WorkflowNode,
  variables: Readonly<Record<string, unknown>>,
): VariableUseEvidence[] {
  const out: VariableUseEvidence[] = []
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (!value.includes('{{')) return
      for (const reference of referencesIn(value)) {
        const root = reference.split('.')[0] ?? reference
        const resolved = Object.prototype.hasOwnProperty.call(variables, root)
        out.push({
          variable: root,
          consumerNodeId: node.id,
          paramPath: path,
          resolved,
          summary: summarizeValue(variables[root], root),
        })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path ? `${path}.${index}` : String(index)))
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        walk(item, path ? `${path}.${key}` : key)
      }
    }
  }
  walk(node.data ?? {}, '')
  // Stable order: by variable, then param path.
  return out.sort((a, b) =>
    a.variable === b.variable
      ? a.paramPath.localeCompare(b.paramPath)
      : a.variable.localeCompare(b.variable),
  )
}

export interface TraceCollectorOptions {
  workflowId: string
  runId: string
  entry: TraceEntry
  sessionId?: string
  startedAt?: number
}

/**
 * Mutable builder for one {@link ExecutionTrace}.
 *
 * Usage from the integration layer:
 *
 * ```ts
 * const collector = new TraceCollector({ workflowId, runId, entry: 'DEBUG' })
 * // feed engine onStep:
 * collector.recordStep(kind, nodeId, text)
 * // around each node attempt:
 * collector.startNode(node, variables)
 * collector.finishNode(node, 'ok' | 'failed', variables, failure?)
 * // checkpoints:
 * collector.recordCheckpoint(stepIndex, nodeId, status, variables)
 * const trace = collector.build(outcome, variables)
 * ```
 */
export class TraceCollector {
  private readonly trace: ExecutionTrace
  private sequence = 0
  /**
   * Workflow nesting stack (P3): root workflow id first; pushed when an
   * `execute-workflow` enters a child, popped when it returns.
   */
  private readonly workflowStack: string[]
  /** nodeId → attempt counter (0-based); each retry adds a new record. */
  private readonly attempts = new Map<string, number>()
  /** nodeId → current in-flight record. */
  private readonly active = new Map<string, NodeExecutionTrace>()

  constructor(options: TraceCollectorOptions) {
    this.workflowStack = [options.workflowId]
    this.trace = {
      traceId: newTraceId(),
      workflowId: options.workflowId,
      runId: options.runId,
      entry: options.entry,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      startedAt: options.startedAt ?? Date.now(),
      outcome: 'failed',
      events: [],
      nodeExecutions: [],
      checkpoints: [],
      finalVariables: {},
      workflowPath: [options.workflowId],
    }
  }

  /**
   * Enter a nested sub-workflow (P3). Idempotent for the same id so a nested
   * run of the SAME child still nests correctly.
   */
  enterSubWorkflow(workflowId: string): void {
    this.workflowStack.push(workflowId)
    this.trace.workflowPath = [...this.workflowStack]
  }

  /** Leave the current nested sub-workflow, returning to its parent. */
  exitSubWorkflow(): void {
    if (this.workflowStack.length > 1) this.workflowStack.pop()
    this.trace.workflowPath = [...this.workflowStack]
  }

  /** Index into the workflow path the collector is currently executing in. */
  currentWorkflowPathIndex(): number {
    return this.workflowStack.length - 1
  }

  /** Record one engine step line. */
  recordStep(kind: string, nodeId: string | undefined, text: string): void {
    const event: TraceEvent = {
      sequence: this.sequence++,
      at: Date.now(),
      kind: asEventKind(kind),
      ...(nodeId ? { nodeId } : {}),
      text,
    }
    // Stamp the workflow nesting for child steps (P3).
    const pathIndex = this.currentWorkflowPathIndex()
    if (pathIndex > 0) event['workflowPathIndex'] = pathIndex
    this.trace.events.push(event)
  }

  /** Begin one attempt of `node`, capturing its input variable references. */
  startNode(node: WorkflowNode, variables: Readonly<Record<string, unknown>>): void {
    const attempt = this.attempts.get(node.id) ?? 0
    this.attempts.set(node.id, attempt + 1)
    const blockId =
      typeof node.data?.['blockId'] === 'string' ? (node.data['blockId'] as string) : undefined
    const record: NodeExecutionTrace = {
      nodeId: node.id,
      ...(blockId ? { blockId } : {}),
      attempt,
      status: 'running',
      startedAt: Date.now(),
      inputVariables: inputRefsOf(node, variables),
      outputVariables: [],
    }
    // Stamp the workflow this node runs in (P3): omit for the root workflow.
    const pathIndex = this.currentWorkflowPathIndex()
    if (pathIndex > 0) record.workflowPathIndex = pathIndex
    this.active.set(node.id, record)
    this.trace.nodeExecutions.push(record)
  }

  /**
   * Finish the current attempt of `node`, recording produced variables as the
   * diff against the incoming variable bag.
   */
  finishNode(
    node: WorkflowNode,
    status: Exclude<NodeExecutionTrace['status'], 'running'>,
    before: Readonly<Record<string, unknown>>,
    after: Readonly<Record<string, unknown>>,
    failure?: TraceFailure,
  ): void {
    const record = this.active.get(node.id)
    if (!record) {
      // Defensive: an integration gap. Start a synthetic attempt so the
      // outcome is never silently lost.
      this.startNode(node, before)
      return this.finishNode(node, status, before, after, failure)
    }
    this.active.delete(node.id)
    record.status = status
    record.finishedAt = Date.now()

    const declared =
      typeof node.data?.['variableName'] === 'string' ? (node.data['variableName'] as string) : ''
    const producedNames = new Set<string>()
    if (declared.trim()) producedNames.add(declared.trim())
    // Any variable newly present after the node ran.
    for (const name of Object.keys(after)) {
      if (!Object.prototype.hasOwnProperty.call(before, name)) producedNames.add(name)
    }
    // Contract a producer node imposes on its own output (spec §5.3). Evaluated
    // right after production so an empty / wrong-typed output is an early,
    // deterministic repair signal the analyzer can cite.
    const contract = contractOfNode(node)
    record.outputVariables = [...producedNames].sort().map((variable) => {
      const produced = Object.prototype.hasOwnProperty.call(after, variable)
      const contractResult = contract
        ? evaluateContract(after[variable], contract, { produced })
        : undefined
      return {
        variable,
        producerNodeId: node.id,
        summary: summarizeValue(after[variable], variable),
        ...(contractResult && !contractResult.valid ? { contract: contractResult } : {}),
      }
    })
    if (failure) record.error = failure
  }

  /**
   * Record one durable checkpoint.
   *
   * @param snapshotAvailable whether the variable snapshot was captured. When
   * false (the bag could not be deep-copied) an explicit warning event is
   * recorded so the failure is never silent (spec §5.1) — such a point must
   * not be treated as "empty variables" or used for a checkpoint replay.
   */
  recordCheckpoint(
    stepIndex: number,
    nodeId: string | undefined,
    status: 'running' | 'ok' | 'failed' | 'cancelled',
    variables: Readonly<Record<string, unknown>>,
    snapshotAvailable = true,
    pageState?: unknown,
  ): void {
    this.trace.checkpoints.push({
      checkpointId: `${this.trace.runId}:${stepIndex}`,
      stepIndex,
      ...(nodeId ? { nodeId } : {}),
      status,
      variableSummaries: snapshotAvailable
        ? summarizeVariables(variables)
        : {},
      snapshotAvailable,
      ...(pageState !== undefined ? { pageState } : {}),
      at: Date.now(),
    })
    if (!snapshotAvailable) {
      const event: TraceEvent = {
        sequence: this.sequence++,
        at: Date.now(),
        kind: 'error',
        ...(nodeId ? { nodeId } : {}),
        text: 'checkpoint variable snapshot unavailable (deep copy failed); not resumable from this point',
      }
      this.trace.events.push(event)
    }
  }

  /** Record page/tab/frame state for the tail of the trace. */
  setCurrentPageState(input: { url?: string; tabId?: number; framePath?: string[] }): void {
    if (input.url !== undefined) this.trace.currentUrl = input.url
    if (input.tabId !== undefined) this.trace.currentTabId = input.tabId
    if (input.framePath !== undefined) this.trace.currentFramePath = input.framePath
  }

  /** Finalize and return the trace. */
  build(
    outcome: ExecutionTrace['outcome'],
    variables: Readonly<Record<string, unknown>>,
    failure?: TraceFailure,
  ): ExecutionTrace {
    this.trace.outcome = outcome
    this.trace.finishedAt = Date.now()
    this.trace.finalVariables = summarizeVariables(variables)
    if (failure) {
      this.trace.failure = failure
      if (failure.nodeId && !this.trace.failedNodeId) {
        this.trace.failedNodeId = failure.nodeId
      }
    }
    if (!this.trace.failedNodeId) {
      const lastFailed = [...this.trace.nodeExecutions]
        .reverse()
        .find((record) => record.status === 'failed')
      if (lastFailed) this.trace.failedNodeId = lastFailed.nodeId
    }
    return this.trace
  }
}
