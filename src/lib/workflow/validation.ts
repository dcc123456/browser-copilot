/**
 * Import-time structural validation for workflows.
 *
 * {@link validateWorkflow} is intentionally separate from persistence: it
 * returns a list of human-readable problems (rather than throwing) so a UI can
 * present every defect in a pasted/imported payload at once, and so storage can
 * reject corrupt payloads before writing them.
 *
 * @module lib/workflow/validation
 */

import type { Workflow } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Returns a list of validation error messages for `value`, or `[]` when the
 * value is a well-formed workflow.
 *
 * Only structural invariants are checked here (shape, required fields, types);
 * semantic checks such as "edge targets a node that exists" are left to callers
 * that have the full graph.
 */
export function validateWorkflow(value: unknown): string[] {
  const errors: string[] = []

  if (!isRecord(value)) {
    return ['workflow must be an object']
  }

  const id = value.id
  if (typeof id !== 'string' || id.trim() === '') {
    errors.push('workflow requires a non-empty id')
  }
  const name = value.name
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push('workflow requires a non-empty name')
  }

  const drawflow = value.drawflow
  if (!isRecord(drawflow)) {
    errors.push('workflow requires a drawflow object')
    return errors
  }

  const nodes = drawflow.nodes
  if (!Array.isArray(nodes)) {
    errors.push('drawflow.nodes must be an array')
  } else {
    nodes.forEach((node, i) => {
      if (!isRecord(node)) {
        errors.push(`nodes[${i}] must be an object`)
        return
      }
      if (typeof node.id !== 'string' || String(node.id).trim() === '') {
        errors.push(`nodes[${i}] requires a non-empty id`)
      }
      if (typeof node.label !== 'string') {
        errors.push(`nodes[${i}] requires a string label`)
      }
      const pos = node.position
      if (!isRecord(pos)) {
        errors.push(`nodes[${i}] requires a position`)
      } else if (typeof pos.x !== 'number' || typeof pos.y !== 'number') {
        errors.push(`nodes[${i}].position requires numeric x and y`)
      }
    })
  }

  const edges = drawflow.edges
  if (!Array.isArray(edges)) {
    errors.push('drawflow.edges must be an array')
  } else {
    edges.forEach((edge, i) => {
      if (!isRecord(edge)) {
        errors.push(`edges[${i}] must be an object`)
        return
      }
      if (typeof edge.id !== 'string' || String(edge.id).trim() === '') {
        errors.push(`edges[${i}] requires a non-empty id`)
      }
      if (typeof edge.source !== 'string') {
        errors.push(`edges[${i}] requires a string source`)
      }
      if (typeof edge.target !== 'string') {
        errors.push(`edges[${i}] requires a string target`)
      }
    })
  }

  if (!isRecord(value.settings)) {
    errors.push('workflow requires a settings object')
  }
  if (typeof value.createdAt !== 'number') {
    errors.push('workflow requires a numeric createdAt')
  }
  if (typeof value.updatedAt !== 'number') {
    errors.push('workflow requires a numeric updatedAt')
  }

  return errors
}

/** Convenience: does {@link validateWorkflow} report no problems? */
export function isWorkflowValid(value: unknown): value is Workflow {
  return validateWorkflow(value).length === 0
}