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
import { unanchoredElementStart } from './runnability'
import { missingRequirements, missingTriggerParam } from './block-requirements'
import { BLOCK_BY_ID } from './blocks/palette'
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

/** Canonical block id of a node: `data.blockId`, falling back to the label. */
function blockIdOfNode(node: WorkflowNode): string {
  const raw = node.data?.['blockId']
  return typeof raw === 'string' && raw ? raw : node.label
}

/** Display name of a block, for gate messages (falls back to the raw id). */
function blockDisplayName(blockId: string): string {
  return BLOCK_BY_ID.get(blockId)?.name ?? blockId
}

/** Branch blocks whose two output ports replay can take. */
const BRANCH_BLOCK_IDS: ReadonlySet<string> = new Set(['conditions', 'element-exists', 'webhook'])

/** Does this node write rows into the data table when it runs? */
function producesTableRows(blockId: string, data: Record<string, unknown>): boolean {
  if (blockId === 'get-text' || blockId === 'read-page') {
    return data['saveData'] === true && isNonEmptyString(data['dataColumn'])
  }
  if (blockId === 'take-screenshot') {
    return data['saveToColumn'] === true && isNonEmptyString(data['dataColumn'])
  }
  if (blockId === 'insert-data') {
    const list = data['dataList']
    return Array.isArray(list) ? list.length > 0 : isNonEmptyString(data['data'])
  }
  return false
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

  // Generated-workflow page anchor. A manual trigger drives whatever tab is
  // active, so a graph that starts acting on elements without ever opening a
  // page can only replay on the page it was generated on — recorded here as
  // `settings.generationOriginUrl` at generation time. A warning, not an
  // error: the user may genuinely be on that page right now.
  const generationOriginUrl = workflow.settings?.generationOriginUrl
  if (
    triggerType === 'manual' &&
    typeof generationOriginUrl === 'string' &&
    generationOriginUrl.trim() !== '' &&
    unanchoredElementStart(workflow)
  ) {
    warnings.push(
      `该工作流没有导航节点，直接操作生成时的页面（${generationOriginUrl}）。` +
        '手动运行时它操作的是当前活动标签页——请先打开该页面再运行，或在图前加一个 new-tab 节点',
    )
  }

  // Residual dead data. Generation rewrites business literals into references
  // (see `dynamic-data`), but a workflow can still arrive here holding one: it
  // was hand-edited, imported, or saved by a path that predates the rewrite.
  // A warning rather than an error — the step still runs, it just runs with a
  // frozen value, and only the user can say whether that is what they want.
  for (const node of actionNodes) {
    const data = node.data ?? {}
    for (const site of dataValueSites(blockIdOfNode(node), data)) {
      // Instruction text (the ai-agent prompt) is a legitimate literal: it is
      // addressed to the step, not data the replay must re-obtain.
      if (site.instruction) continue
      if (hasReference(site.value)) continue
      warnings.push(
        `节点 "${node.id}" 的 ${site.path.join('.')} 是固定值 "${site.value}"：` +
          '重放时不会变化，如果它本该随数据改变，请改用 {{变量}} 引用或声明成工作流输入',
      )
    }
  }

  // Required parameters per node — the same contract the generation-time
  // record gate enforces (see `block-requirements`), applied to EVERY workflow
  // no matter which path produced it. The empty-locator `element-exists`, the
  // key-less `press-key` and the url-less `webhook` all die HERE now instead
  // of failing (or silently doing nothing) mid-run. Errors, not warnings: the
  // step cannot work, so running it can only surprise.
  for (const node of actionNodes) {
    const blockId = blockIdOfNode(node)
    for (const problem of missingRequirements(blockId, node.data ?? {})) {
      errors.push(
        `节点 "${node.id}"（${blockDisplayName(blockId)}）缺少必填参数 ${problem.key}：${problem.message}`,
      )
    }
  }

  // A branch block whose OTHER port has no continuation: generation records
  // only the branch that was taken, so the untaken port often dangles. Replay
  // that takes it ends silently — say so before the run, not after.
  for (const node of actionNodes) {
    if (!BRANCH_BLOCK_IDS.has(blockIdOfNode(node))) continue
    const handles = workflow.drawflow.edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => edge.sourceHandle ?? '')
    if (handles.length === 0) continue
    const portConnected = (suffix: string): boolean =>
      handles.some((handle) => handle.endsWith(`-${suffix}`))
    if (!portConnected('output-1') || !portConnected('output-2')) {
      warnings.push(
        `节点 "${node.id}"（${blockDisplayName(blockIdOfNode(node))}）是分支节点，` +
          '但有一条分支没有连接后续节点：重放走到该分支时会直接结束',
      )
    }
  }

  // An export that reads the data table needs a producer BEFORE it: a read
  // with `saveData` + `dataColumn` (or an explicit insert). Without one the
  // replay fails with "数据表是空的" — say so at the gate.
  for (const node of actionNodes) {
    if (blockIdOfNode(node) !== 'export-data') continue
    const data = node.data ?? {}
    if ((data['dataToExport'] ?? 'data-columns') !== 'data-columns') continue
    const index = workflow.drawflow.nodes.indexOf(node)
    const produced = workflow.drawflow.nodes
      .slice(0, index === -1 ? undefined : index)
      .some((earlier) => producesTableRows(blockIdOfNode(earlier), earlier.data ?? {}))
    if (!produced) {
      warnings.push(
        `节点 "${node.id}"（${blockDisplayName('export-data')}）导出的是数据表，` +
          '但它之前没有任何采集节点（get-text / read-page 开 saveData 并填 dataColumn）——重放时会因数据表为空而报错',
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
