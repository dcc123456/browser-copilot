/**
 * Saves a workflow supplied as a literal graph through the MCP bridge. Unlike
 * compose_workflow (which closes a recorded conversation draft), this path
 * takes nodes + edges directly so data-only workflows can be authored exactly
 * instead of approximated by page-action recording.
 *
 * @module background/workflow-authoring
 */

import {
  assembleAuthoredWorkflow,
  validateAuthoredGraph,
  type AuthoredGraphInput,
} from '../lib/workflow/authored-graph'
import { validateWorkflowForRun } from '../lib/workflow/validation'
import { saveWorkflow } from '../lib/workflow/storage'
import { newId } from '../lib/storage'
import type { Workflow } from '../lib/workflow/types'

export interface SaveAuthoredWorkflowResult {
  ok: boolean
  error?: string
  errors?: string[]
  workflowId?: string
  name?: string
  nodeCount?: number
  warnings?: string[]
}

/**
 * Validate and persist an authored graph. Blocking findings (bad shape, broken
 * edges, unknown blocks) refuse the write; run-level findings are returned as
 * warnings and never block, matching compose_workflow's save policy.
 */
export async function saveAuthoredWorkflow(args: {
  workflow?: unknown
  save?: unknown
}): Promise<SaveAuthoredWorkflowResult> {
  const graph = args.workflow
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { ok: false, error: 'save_workflow needs a `workflow` object.' }
  }
  const input = graph as AuthoredGraphInput
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { ok: false, error: 'workflow.name must be a non-empty string.' }

  const shape = validateAuthoredGraph(input)
  if (shape.errors.length > 0) {
    return { ok: false, error: 'Invalid workflow graph.', errors: shape.errors }
  }

  const now = Date.now()
  const workflow = assembleAuthoredWorkflow(input, { id: newId(), createdAt: now, updatedAt: now })
  if (!workflow) {
    return { ok: false, error: 'Could not assemble a workflow from the supplied graph.' }
  }

  const warnings: string[] = [...shape.warnings]
  for (const issue of validateWorkflowForRun(workflow).errors) warnings.push(issue)

  const dryRun = args.save === false
  if (!dryRun) await saveWorkflow(workflow)

  return authoredResult(workflow, warnings, dryRun)
}

function authoredResult(
  workflow: Workflow,
  warnings: string[],
  dryRun: boolean,
): SaveAuthoredWorkflowResult {
  return {
    ok: true,
    ...(dryRun ? {} : { workflowId: workflow.id }),
    name: workflow.name,
    nodeCount: workflow.drawflow.nodes.length,
    warnings,
  }
}
