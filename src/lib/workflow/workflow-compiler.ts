/**
 * Workflow compiler (spec §9, Commit 5).
 *
 * Compiles the successful execution trace of a generation session into a
 * reusable {@link Workflow}:
 *
 * ```text
 * successful action traces → nodes (trigger head + actions) + chained edges
 * ```
 *
 * The compiled workflow carries:
 *   - `settings.provenance = 'chat-generate'`;
 *   - `settings.generationOriginUrl` from the first observed page;
 *   - `settings.reliabilityMode = 'generated-strict'`;
 *   - `settings.goalSpec` when the session produced one;
 *   - per-node `data.__reliability.intent` (the recorded action intent);
 *
 * Failed actions are excluded entirely. A selector that was never verified
 * is not marked verified — the later save gate handles live hardening.
 *
 * Pure module: no `chrome`, no DOM.
 *
 * @module lib/workflow/workflow-compiler
 */
import type {
  GenerationActionTrace,
  WorkflowGenerationSession,
} from './generation-session'
import { successfulTraces } from './generation-session'
import { TRIGGER_BLOCK_ID } from './draft-types'
import type {
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from './types'

let compilerCounter = 0
function newId(prefix: string): string {
  compilerCounter = (compilerCounter + 1) % Number.MAX_SAFE_INTEGER
  return `${prefix}-${Date.now().toString(36)}-${compilerCounter.toString(36)}`
}

/** The canonical trigger head node every workflow starts with. */
function triggerHead(): WorkflowNode {
  return {
    id: 'trigger',
    label: TRIGGER_BLOCK_ID,
    position: { x: 0, y: 0 },
    data: { blockId: TRIGGER_BLOCK_ID, type: 'manual' },
  }
}

/** Build a workflow node from one successful action trace. */
function nodeFromTrace(trace: GenerationActionTrace, index: number): WorkflowNode {
  const nodeId = trace.nodeId || newId('node')
  return {
    id: nodeId,
    label: trace.blockId,
    position: { x: (index + 1) * 220, y: 0 },
    data: {
      ...trace.params,
      blockId: trace.blockId,
      __reliability: {
        intent: trace.intent,
      },
    },
  }
}

/** Chain edges from the trigger head through every action node in order. */
function chainEdges(nodes: WorkflowNode[]): WorkflowEdge[] {
  const edges: WorkflowEdge[] = []
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({
      id: newId('edge'),
      source: nodes[i]!.id,
      target: nodes[i + 1]!.id,
    })
  }
  return edges
}

export interface CompileTraceInput {
  /** The session to compile (its successful traces are used). */
  session: WorkflowGenerationSession
  /** Workflow name; defaults to the goal text. */
  name?: string
  /** Explicit workflow id; a new one is generated when absent. */
  workflowId?: string
  at?: number
}

export interface CompileTraceResult {
  workflow: Workflow
  /** Number of failed actions that were excluded from the compiled graph. */
  excludedFailures: number
}

/**
 * Compile a generation session into a Workflow. Requires at least one
 * successful action; throws otherwise (the orchestrator should fail the
 * generation rather than save an empty graph).
 */
export function compileWorkflowFromTrace(input: CompileTraceInput): CompileTraceResult {
  const { session } = input
  const traces = successfulTraces(session)
  if (traces.length === 0) {
    throw new Error('cannot compile a workflow without any successful action')
  }
  const at = input.at ?? Date.now()
  const nodes: WorkflowNode[] = [triggerHead(), ...traces.map(nodeFromTrace)]
  const edges = chainEdges(nodes)

  const originUrl =
    session.originUrl ?? traces[0]?.page.url ?? undefined

  const workflow: Workflow = {
    id: input.workflowId ?? newId('workflow'),
    name: (input.name ?? session.userGoal).slice(0, 120) || 'Workflow',
    createdAt: at,
    updatedAt: at,
    drawflow: {
      nodes,
      edges,
    },
    trigger: { type: 'manual' },
    settings: {
      saveLog: true,
      debugMode: false,
      notification: true,
      reuseLastState: false,
      provenance: 'chat-generate',
      ...(originUrl ? { generationOriginUrl: originUrl } : {}),
      reliabilityMode: 'generated-strict',
      ...(session.goalSpec ? { goalSpec: session.goalSpec } : {}),
    },
  }

  const excludedFailures = session.actionTrace.length - traces.length
  return { workflow, excludedFailures }
}
