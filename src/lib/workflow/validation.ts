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

import { isOfferedTriggerType } from './trigger-options'
import { dataValueSites } from './data-params'
import { hasReference } from './dynamic-data'
import type { Workflow, WorkflowNode } from './types'

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

/** Result of {@link validateWorkflowForRun}: hard blockers vs. soft advice. */
export interface WorkflowRunValidation {
  /** The workflow cannot run until these are fixed. */
  errors: string[]
  /** The workflow will run, but probably not the way the user expects. */
  warnings: string[]
}

/** The trigger block's node, when the graph has one. */
function triggerNodeOf(workflow: Workflow): WorkflowNode | undefined {
  return workflow.drawflow.nodes.find(
    (n) => (n.data?.['blockId'] as string) === 'trigger' || n.label === 'trigger',
  )
}

/**
 * The trigger's parameters, read from the graph node and filled in from the
 * denormalized top-level mirror.
 *
 * The mirror is not a formality for the two kinds that carry a field there:
 * `visit-web` matches on `workflow.trigger.urlPattern` and the context menu
 * registers `workflow.trigger.menuItemId` — both are read from the MIRROR at
 * run time, not from the node. A workflow created by another path (an older
 * import, a `github` / `feishu` integration) may therefore carry only
 * `workflow.trigger`, and reading the node alone would report a missing
 * parameter and block a perfectly well-configured run.
 */
function triggerParamsOf(
  workflow: Workflow,
  triggerNode: WorkflowNode | undefined,
): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(triggerNode?.data ?? {}) }
  if (data['url'] === undefined && workflow.trigger?.urlPattern) {
    data['url'] = workflow.trigger.urlPattern
  }
  if (data['contextMenuName'] === undefined && workflow.trigger?.menuItemId) {
    data['contextMenuName'] = workflow.trigger.menuItemId
  }
  return data
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The trigger field this kind cannot work without but that is missing or
 * unusable, or null when the trigger is fully configured. Type-aware on
 * purpose: an `interval` of `"abc"` is as broken as an empty one, and the
 * engine's own coercion would silently fall back to a default.
 */
function missingTriggerParam(
  type: string,
  data: Record<string, unknown> | undefined,
): string | null {
  switch (type) {
    case 'visit-web':
      return isNonEmptyString(data?.['url']) ? null : 'url'
    case 'keyboard-shortcut':
      return isNonEmptyString(data?.['shortcut']) ? null : 'shortcut'
    case 'context-menu':
      return isNonEmptyString(data?.['contextMenuName']) ? null : 'contextMenuName'
    case 'interval': {
      const raw = data?.['interval']
      const minutes = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(minutes) && minutes > 0 ? null : 'interval'
    }
    case 'specific-day':
      return Array.isArray(data?.['days']) && data['days'].length > 0 ? null : 'days'
    case 'date':
      return isNonEmptyString(data?.['date']) ? null : 'date'
    case 'element-change': {
      // The selector is nested: `data.observeElement.selector`. Without it the
      // observer has nothing to watch, so the trigger would never fire.
      const observe = data?.['observeElement']
      const selector =
        observe && typeof observe === 'object'
          ? (observe as Record<string, unknown>)['selector']
          : undefined
      return isNonEmptyString(selector) ? null : 'observeElement.selector'
    }
    default:
      return null
  }
}

/**
 * Semantic pre-run checks: is this workflow actually launchable?
 *
 * Deliberately separate from {@link validateWorkflow} (which only checks the
 * payload's structure and is used by the importer). This one needs the full
 * graph and is called on the *run* path only — never from `saveWorkflow`, so
 * existing workflows with an odd shape stay editable.
 *
 * `errors` block the run; `warnings` do not. A trigger kind this build never
 * arms (`scheduled`, ...) is a warning rather than an error because the graph
 * is still runnable by hand.
 */
export function validateWorkflowForRun(workflow: Workflow): WorkflowRunValidation {
  const errors: string[] = []
  const warnings: string[] = []

  const triggerNode = triggerNodeOf(workflow)
  if (!triggerNode && !workflow.trigger) {
    errors.push('工作流缺少触发器：请添加一个 trigger 节点，否则无法运行')
  }

  const triggerType =
    (triggerNode?.data?.['type'] as string | undefined) ?? workflow.trigger?.type ?? 'manual'

  if (workflow.trigger?.enabled === false) {
    errors.push('触发器已被禁用：请先启用触发器再运行')
  }

  if (!isOfferedTriggerType(triggerType)) {
    warnings.push(
      `触发器类型 "${triggerType}" 在当前版本不会自动触发，只能手动运行；请在编辑器里改用其他类型`,
    )
  }

  // Only enforce the kind's own parameters when the kind is one we arm — for an
  // unarmed kind the field names may belong to another creation path.
  if (isOfferedTriggerType(triggerType)) {
    const missing = missingTriggerParam(triggerType, triggerParamsOf(workflow, triggerNode))
    if (missing) {
      errors.push(`触发器缺少必填参数 "${missing}"，无法运行`)
    }
  }

  const actionNodes = workflow.drawflow.nodes.filter((n) => n !== triggerNode)
  if (actionNodes.length === 0) {
    errors.push('工作流没有可执行的节点：请在触发器之后至少添加一个算子')
  }

  // Residual dead data. Generation rewrites business literals into references
  // (see `dynamic-data`), but a workflow can still arrive here holding one: it
  // was hand-edited, imported, or saved by a path that predates the rewrite.
  // A warning rather than an error — the step still runs, it just runs with a
  // frozen value, and only the user can say whether that is what they want.
  for (const node of actionNodes) {
    const data = node.data ?? {}
    const rawBlockId = data['blockId']
    const blockId = typeof rawBlockId === 'string' && rawBlockId ? rawBlockId : node.label
    for (const site of dataValueSites(blockId, data)) {
      if (hasReference(site.value)) continue
      warnings.push(
        `节点 "${node.id}" 的 ${site.path.join('.')} 是固定值 "${site.value}"：` +
          '重放时不会变化，如果它本该随数据改变，请改用 {{变量}} 引用或声明成工作流输入',
      )
    }
  }

  const nodeIds = new Set(workflow.drawflow.nodes.map((n) => n.id))
  for (const edge of workflow.drawflow.edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`存在无效连线：源节点 "${edge.source}" 不存在`)
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`存在无效连线：目标节点 "${edge.target}" 不存在`)
    }
  }

  return { errors, warnings }
}
