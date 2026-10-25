/**
 * The workflows a graph calls, resolved against the publisher's local library.
 *
 * A published `execute-workflow` step stores the publisher's local workflow id,
 * which means nothing on anyone else's machine. Publishing therefore carries a
 * copy of every called workflow inside the same directory and records the ids
 * in `meta.json`; applying uses that record to point the calls at the copies it
 * just installed.
 *
 * The publisher must see what travels with their listing, so the plan exposes
 * both the resolved dependencies and every call that cannot be satisfied.
 *
 * @module lib/marketplace/dependencies
 */

import { nodeBlockId, nodeParams } from '../workflow/node-params'
import type { Workflow, WorkflowNode } from '../workflow/types'
import { dependencyPath } from './meta'
import { slugify } from './slug'

const EXECUTE_WORKFLOW_BLOCK = 'execute-workflow'
/** A value the engine only resolves at run time cannot be bundled. */
const INTERPOLATED_RE = /\{\{/

export interface WorkflowCall {
  nodeId: string
  nodeLabel: string
  /** Raw `workflowId` parameter; empty when the step has no target. */
  workflowId: string
}

export interface ResolvedDependency {
  workflow: Workflow
  /** Workflow-relative file, e.g. `deps/export-orders.json`. */
  path: string
}

export interface DependencyPlan {
  /** Every called workflow, each listed after the workflows it calls. */
  dependencies: ResolvedDependency[]
  /** Calls a bundle cannot satisfy: missing, empty or dynamically built ids. */
  missing: WorkflowCall[]
}

/** Every `execute-workflow` step in one graph, in node order. */
export function workflowCalls(workflow: Workflow): WorkflowCall[] {
  const calls: WorkflowCall[] = []
  for (const node of workflow.drawflow.nodes) {
    if (nodeBlockId(node) !== EXECUTE_WORKFLOW_BLOCK) continue
    const raw = nodeParams(node)['workflowId']
    calls.push({
      nodeId: node.id,
      nodeLabel: node.label || node.id,
      workflowId: typeof raw === 'string' ? raw.trim() : '',
    })
  }
  return calls
}

/** File names must be unique inside one directory, so repeats get a suffix. */
function uniqueFile(name: string, taken: Set<string>): string {
  const base = slugify(name).slice(0, 40) || 'workflow'
  let file = base
  for (let suffix = 2; taken.has(file); suffix += 1) file = `${base}-${suffix}`
  taken.add(file)
  return file
}

/**
 * Walks the call graph from `root` through the local `library`.
 *
 * Cycles are cut by the visited set — the run engine refuses them anyway — and
 * a workflow calling itself is not a dependency. Anything else that cannot be
 * resolved is reported instead of silently published as a dangling reference.
 */
export function collectDependencies(root: Workflow, library: readonly Workflow[]): DependencyPlan {
  const byId = new Map(library.map((workflow) => [workflow.id, workflow]))
  const dependencies: ResolvedDependency[] = []
  const missing: WorkflowCall[] = []
  const missingIds = new Set<string>()
  const takenFiles = new Set<string>()
  const visited = new Set<string>([root.id])

  const miss = (call: WorkflowCall): void => {
    if (missingIds.has(call.workflowId)) return
    missingIds.add(call.workflowId)
    missing.push(call)
  }

  const visit = (parent: Workflow): void => {
    for (const call of workflowCalls(parent)) {
      if (call.workflowId === parent.id || visited.has(call.workflowId)) continue
      if (!call.workflowId || INTERPOLATED_RE.test(call.workflowId)) {
        miss(call)
        continue
      }
      const dependency = byId.get(call.workflowId)
      if (!dependency) {
        miss(call)
        continue
      }
      visited.add(call.workflowId)
      visit(dependency)
      dependencies.push({
        workflow: dependency,
        path: dependencyPath(uniqueFile(dependency.name, takenFiles)),
      })
    }
  }

  visit(root)
  return { dependencies, missing }
}

/** Writes one rewritten call back into the container the engine will read. */
function withCallId(node: WorkflowNode, workflowId: string): WorkflowNode {
  const data = node.data ?? {}
  const values = data['values']
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    return {
      ...node,
      data: { ...data, values: { ...(values as Record<string, unknown>), workflowId } },
    }
  }
  return { ...node, data: { ...data, workflowId } }
}

/**
 * Returns a copy of `workflow` whose calls point at `ids` (published id → local
 * id). Unknown ids are left alone: only this bundle's dependencies are known,
 * and rewriting a call the publisher aimed elsewhere would be a guess.
 */
export function rewriteWorkflowCalls(
  workflow: Workflow,
  ids: ReadonlyMap<string, string>,
): Workflow {
  const nodes = workflow.drawflow.nodes.map((node) => {
    if (nodeBlockId(node) !== EXECUTE_WORKFLOW_BLOCK) return node
    const current = nodeParams(node)['workflowId']
    if (typeof current !== 'string') return node
    const target = ids.get(current.trim())
    return target ? withCallId(node, target) : node
  })
  return { ...workflow, drawflow: { ...workflow.drawflow, nodes } }
}
