/**
 * Patch engine (spec §5.6, §8 · Phase 4).
 *
 * The single write entry for AI-proposed changes. The AI only PROPOSES a
 * {@link WorkflowPatchSet}; this engine decides whether it may land:
 *
 * Validation order (§8.3):
 *
 *   1. shape / JSON-schema sanity
 *   2. unique patchSetId / operationId
 *   3. target node exists
 *   4. target node ∈ allowedNodeIds
 *   5. path ∈ allowedParamPaths
 *   6. `before` equals the working-copy value (optimistic lock)
 *   7. operation legal for the block id
 *   8. data/structural param semantics
 *   9. apply to a clone
 *  10. checkWorkflowIntegrity
 *  11. validateWorkflowForRun (no new hard errors)
 *  12. dynamic-data gate (no frozen business value introduced)
 *  13. selector / locator static rules
 *  14. diff: only the declared nodes changed
 *  15. PatchValidationResult
 *
 * All validation happens on a CLONE; nothing mutates until {@link applyPatch},
 * which re-runs validation so a stale patch can never be applied directly.
 *
 * Pure (imports only lib validation) — no browser/provider.
 *
 * @module lib/workflow/repair/patch-engine
 */

import { checkWorkflowIntegrity, integrityIsClean } from '../integrity'
import { validateWorkflowForRun } from '../validation'
import { referencesIn } from '../dynamic-data'
import { looksLikeBulkContent } from '../dynamic-data'
import { allowedNodeIdsOf, allowedParamPathsOf, isDataPath, PROTECTED_PARAMS } from './patch-policy'
import type {
  FailureAnalysis,
  PatchApplyResult,
  PatchIssue,
  PatchValidationResult,
  WorkflowPatchOperation,
  WorkflowPatchSet,
} from './types'
import type { Workflow, WorkflowNode } from '../types'

/** Operations currently supported on a node's param bag. */
const NODE_PARAM_OPERATIONS: ReadonlySet<WorkflowPatchOperation['kind']> = new Set([
  'SET_PARAM',
  'REMOVE_PARAM',
  'REPLACE_TARGET',
  'REPLACE_INPUT_REF',
  'REPLACE_OUTPUT',
])

/** Operations that change graph structure (Phase 1: guarded but limited). */
const STRUCTURAL_OPERATIONS: ReadonlySet<WorkflowPatchOperation['kind']> = new Set([
  'INSERT_NODE',
  'REMOVE_NODE',
  'REWIRE_EDGE',
])

function blockIdOf(node: WorkflowNode): string {
  const raw = node.data?.['blockId']
  return typeof raw === 'string' && raw ? raw : node.label
}

/** Read a value at a dot path inside a param bag. */
function getPath(root: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = root
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/** Write a value at a dot path inside a cloned param bag. */
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let cursor: Record<string, unknown> = root
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!
    const next = cursor[segment]
    if (!next || typeof next !== 'object') {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]!] = value
}

export class PatchEngine {
  /** Compute the allowed nodes for an analysis (exposed for repair context). */
  allowedNodeIds(analysis: FailureAnalysis): string[] {
    return allowedNodeIdsOf(analysis)
  }

  /** Compute the allowed param paths per node (exposed for repair context). */
  allowedParamPaths(workflow: Workflow, analysis: FailureAnalysis): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const nodeId of this.allowedNodeIds(analysis)) {
      out[nodeId] = allowedParamPathsOf(workflow, analysis, nodeId)
    }
    return out
  }

  /**
   * Validate a patch set against the working copy. Returns every issue found
   * (does not short-circuit) so the caller can report all violations.
   */
  validatePatch(
    workflow: Workflow,
    analysis: FailureAnalysis,
    patch: WorkflowPatchSet,
  ): PatchValidationResult {
    const issues: PatchIssue[] = []
    const problem = (message: string, operationId?: string): void => {
      issues.push({ code: 'PATCH_INVALID', message, ...(operationId ? { operationId } : {}) })
    }

    // 1. Shape sanity.
    if (!patch || typeof patch !== 'object') {
      return {
        ok: false,
        issues: [{ code: 'PATCH_INVALID', message: 'patch must be an object' }],
        changedNodeIds: [],
      }
    }
    if (!patch.patchSetId) problem('patchSetId is required')
    if (patch.analysisId && analysis.analysisId && patch.analysisId !== analysis.analysisId) {
      problem('patch is bound to a different analysis')
    }
    if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
      problem('patch must contain at least one operation')
      return { ok: false, issues, changedNodeIds: [] }
    }

    // 2. Unique ids.
    const operationIds = new Set<string>()
    for (const operation of patch.operations) {
      if (!operation.operationId) problem('operationId is required')
      else if (operationIds.has(operation.operationId)) {
        problem(`duplicate operationId ${operation.operationId}`, operation.operationId)
      }
      operationIds.add(operation.operationId)
    }

    const allowedNodeIds = new Set(this.allowedNodeIds(analysis))
    const allowedPaths = this.allowedParamPaths(workflow, analysis)

    // Per-operation checks 3–8.
    for (const operation of patch.operations) {
      // 3. target node exists (structural ops carry the node id as anchor).
      const node = workflow.drawflow.nodes.find((item) => item.id === operation.nodeId)
      if (!node && !STRUCTURAL_OPERATIONS.has(operation.kind)) {
        problem(`target node ${operation.nodeId} does not exist`, operation.operationId)
        continue
      }

      // 4. target node allowed.
      if (!allowedNodeIds.has(operation.nodeId)) {
        problem(
          `node ${operation.nodeId} is outside the root-cause / allowed scope`,
          operation.operationId,
        )
        continue
      }

      // Structural operations are not supported in Phase 1 beyond rejecting
      // them — atomic param patches are the default; whole-graph rewrite is
      // the separate, higher-risk path (§8.4).
      if (STRUCTURAL_OPERATIONS.has(operation.kind)) {
        problem(
          `operation ${operation.kind} is not permitted on the atomic patch path`,
          operation.operationId,
        )
        continue
      }

      if (!NODE_PARAM_OPERATIONS.has(operation.kind)) {
        problem(`unknown operation kind ${operation.kind}`, operation.operationId)
        continue
      }

      const path = operation.path
      if (!path) {
        problem('param path is required', operation.operationId)
        continue
      }

      // Identity fields are hard-protected regardless of allowed lists.
      if (PROTECTED_PARAMS.has(path.split('.')[0] ?? path)) {
        problem(`path ${path} is protected and cannot be changed`, operation.operationId)
        continue
      }

      // 5. path allowed for this node.
      const permitted = new Set(allowedPaths[operation.nodeId] ?? [])
      if (!permitted.has(path.split('.')[0] ?? path)) {
        problem(`path ${path} is not allowed for node ${operation.nodeId}`, operation.operationId)
        continue
      }

      if (!node) continue
      const blockId = blockIdOf(node)

      // 7/8. operation vs block semantics + data/structural legality.
      if (operation.kind === 'REMOVE_PARAM') {
        if (node.data?.[path] === undefined) {
          problem(`cannot remove missing path ${path}`, operation.operationId)
        }
      } else {
        if (operation.after === undefined) {
          problem('after value is required', operation.operationId)
          continue
        }
        // A business-data path must keep a dynamic reference; a static value
        // that looks like bulk content is rejected (dynamic-data gate, §12).
        if (isDataPath(blockId, path) && typeof operation.after === 'string') {
          const afterHasRef = referencesIn(operation.after).length > 0
          if (!afterHasRef && looksLikeBulkContent(operation.after)) {
            problem(
              `path ${path} would freeze bulk page content into a static value`,
              operation.operationId,
            )
          }
        }
        // Selector static rule: non-empty when set.
        if (
          (path === 'selector' || path === 'cssSelector') &&
          typeof operation.after === 'string' &&
          operation.after.trim() === ''
        ) {
          problem(`path ${path} must not be an empty selector`, operation.operationId)
        }
      }

      // 6. `before` optimistic lock: current working-copy value must match.
      if (!node) continue
      const currentValue = getPath(node.data ?? {}, path)
      if (operation.before !== undefined && !deepEqual(currentValue, operation.before)) {
        problem(
          `stale patch: current value of ${path} no longer matches "before"; re-diagnosis required`,
          operation.operationId,
        )
      }
    }

    // 9–14: apply the operations to a clone and re-validate.
    let changedNodeIds: string[] = []
    if (issues.length === 0) {
      let candidate: Workflow
      try {
        const applied = this.applyToClone(workflow, patch)
        candidate = applied.workflow
        changedNodeIds = applied.changedNodeIds
      } catch (e) {
        problem(e instanceof Error ? e.message : String(e))
        return { ok: false, issues, changedNodeIds: [] }
      }

      // 10. integrity.
      const integrity = checkWorkflowIntegrity(candidate)
      if (!integrityIsClean(integrity)) {
        problem(
          `patch breaks workflow integrity: ${integrity.danglingVars.length} dangling, ${integrity.orphanNodes.length} orphan, ${integrity.unreachable.length} unreachable`,
        )
      }

      // 11. run validation — no NEW hard errors vs the base workflow.
      const baseRun = validateWorkflowForRun(workflow)
      const nextRun = validateWorkflowForRun(candidate)
      const newErrors = nextRun.errors.filter((error) => !baseRun.errors.includes(error))
      for (const error of newErrors) problem(`patch introduces a run blocker: ${error}`)

      // 14. diff: only the declared nodes changed.
      const declaredNodes = new Set(patch.operations.map((operation) => operation.nodeId))
      for (const node of candidate.drawflow.nodes) {
        if (declaredNodes.has(node.id)) continue
        const baseNode = workflow.drawflow.nodes.find((item) => item.id === node.id)
        if (!baseNode || !deepEqual(baseNode, node)) {
          problem(`collateral change detected on node ${node.id}`)
        }
      }
      if (candidate.drawflow.nodes.length !== workflow.drawflow.nodes.length) {
        problem('patch changes the node count outside of declared operations')
      }
      if (!deepEdgeEqual(workflow, candidate)) {
        problem('patch changes edges outside of declared operations')
      }
    }

    return { ok: issues.length === 0, issues, changedNodeIds: [...changedNodeIds].sort() }
  }

  /**
   * Apply a validated patch set and return the new workflow. Validation is
   * re-run here so {@link applyPatch} can never be reached with a stale or
   * unauthorized patch.
   */
  applyPatch(
    workflow: Workflow,
    analysis: FailureAnalysis,
    patch: WorkflowPatchSet,
  ): PatchApplyResult {
    const validation = this.validatePatch(workflow, analysis, patch)
    if (!validation.ok) {
      throw new PatchRejectedError(validation.issues)
    }
    return this.applyToClone(workflow, patch)
  }

  /** Internal: apply every operation onto a structured clone. */
  private applyToClone(workflow: Workflow, patch: WorkflowPatchSet): PatchApplyResult {
    const clone = structuredClone(workflow)
    const changed = new Set<string>()
    for (const operation of patch.operations) {
      const node = clone.drawflow.nodes.find((item) => item.id === operation.nodeId)
      if (!node) throw new Error(`node ${operation.nodeId} vanished during apply`)
      changed.add(operation.nodeId)
      const path = operation.path ?? ''
      if (operation.kind === 'REMOVE_PARAM') {
        const [head, ...rest] = path.split('.')
        if (rest.length === 0) delete node.data[head!]
        else {
          let cursor: unknown = node.data[head!]
          for (let i = 0; i < rest.length - 1; i += 1) {
            if (cursor === null || typeof cursor !== 'object') {
              cursor = undefined
              break
            }
            cursor = (cursor as Record<string, unknown>)[rest[i]!]
          }
          if (cursor && typeof cursor === 'object') {
            delete (cursor as Record<string, unknown>)[rest[rest.length - 1]!]
          }
        }
      } else {
        setPath(node.data, path, operation.after)
      }
    }
    return { workflow: clone, changedNodeIds: [...changed].sort() }
  }
}

/** Raised when an apply is attempted on a rejected patch. */
export class PatchRejectedError extends Error {
  readonly issues: PatchIssue[]
  constructor(issues: PatchIssue[]) {
    super(issues.map((issue) => issue.message).join('; '))
    this.name = 'PatchRejectedError'
    this.issues = issues
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }
  return false
}

function deepEdgeEqual(a: Workflow, b: Workflow): boolean {
  if (a.drawflow.edges.length !== b.drawflow.edges.length) return false
  const normalize = (workflow: Workflow) =>
    workflow.drawflow.edges
      .map(
        (edge) =>
          `${edge.source}|${edge.sourceHandle ?? ''}→${edge.target}|${edge.targetHandle ?? ''}`,
      )
      .sort()
  const aEdges = normalize(a)
  const bEdges = normalize(b)
  return aEdges.every((edge, index) => edge === bEdges[index])
}
