/**
 * Builders for repair tests: minimal workflows + trace fixtures.
 *
 * Mirrors the `makeWorkflow/node/edge` helpers used by the workflow test
 * suite, plus {@link buildTrace} which constructs a real ExecutionTrace via
 * the TraceCollector so the analyzer tests exercise the same aggregation as
 * the production run path.
 */

import { TraceCollector } from '../../src/lib/workflow/execution-trace'
import { classifyVerificationFailure } from '../../src/lib/workflow/repair/failure-classifier'
import type { ExecutionTrace, TraceEntry, TraceFailure } from '../../src/lib/workflow/repair/types'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../../src/lib/workflow/types'

export function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

export function node(
  id: string,
  blockId: string,
  data: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    label: blockId,
    position: { x: 0, y: 0 },
    data: { blockId, description: '', ...data },
  }
}

export function edge(source: string, target: string, handle?: string): WorkflowEdge {
  return {
    id: `${source}->${target}${handle ? `:${handle}` : ''}`,
    source,
    target,
    ...(handle ? { sourceHandle: handle } : {}),
  }
}

/** A linear chain trigger → ...ids. */
export function linearChain(
  ids: string[],
  blockFor: (id: string) => string,
  dataFor: (id: string) => Record<string, unknown> = () => ({}),
): {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
} {
  const nodes = ids.map((id) => node(id, blockFor(id), dataFor(id)))
  const edges = ids.slice(1).map((id, index) => edge(ids[index]!, id))
  return { nodes, edges }
}

export interface ExecutedNode {
  id: string
  status: 'ok' | 'failed' | 'cancelled' | 'skipped'
  /** Variable bag AFTER this node ran. */
  variables: Record<string, unknown>
  error?: string
}

/**
 * Build a real ExecutionTrace by feeding the collector the executed nodes in
 * order. The workflow nodes provide the static input references.
 */
export function buildTrace(
  workflow: Workflow,
  runId: string,
  executed: ExecutedNode[],
  options: { entry?: TraceEntry; failure?: TraceFailure; url?: string } = {},
): ExecutionTrace {
  const collector = new TraceCollector({
    workflowId: workflow.id,
    runId,
    entry: options.entry ?? 'DEBUG',
  })
  let incoming: Record<string, unknown> = {}
  for (const exec of executed) {
    const wfNode = workflow.drawflow.nodes.find((item) => item.id === exec.id)!
    if (exec.status === 'skipped') {
      collector.startNode(wfNode, incoming)
      collector.finishNode(wfNode, 'skipped', incoming, exec.variables)
      incoming = exec.variables
      continue
    }
    collector.startNode(wfNode, incoming)
    if (exec.status === 'failed') {
      const message = exec.error ?? 'failed'
      const classified = classifyVerificationFailure(message)
      const failure: TraceFailure =
        options.failure ??
        ({
          code: classified.type,
          message,
          nodeId: exec.id,
          retryable: classified.retryable,
          source: classified.source,
        } as TraceFailure)
      collector.finishNode(wfNode, 'failed', incoming, exec.variables, {
        ...failure,
        nodeId: exec.id,
      })
    } else {
      collector.finishNode(wfNode, exec.status, incoming, exec.variables)
    }
    incoming = exec.variables
  }
  if (options.url) collector.setCurrentPageState({ url: options.url })
  const last = executed[executed.length - 1]!
  const outcome: ExecutionTrace['outcome'] =
    last.status === 'ok' ? 'ok' : last.status === 'cancelled' ? 'cancelled' : 'failed'
  const failedExec = [...executed].reverse().find((item) => item.status === 'failed')
  return collector.build(
    outcome,
    last.variables,
    ...(outcome === 'failed'
      ? [
          options.failure ??
            (() => {
              const message = failedExec?.error ?? 'failed'
              const classified = classifyVerificationFailure(message)
              return {
                code: classified.type,
                message,
                nodeId: failedExec?.id,
                retryable: classified.retryable,
                source: classified.source,
              } as TraceFailure
            })(),
        ]
      : []),
  )
}
