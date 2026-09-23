/**
 * Repair candidate contract (spec §17, §18, Commit 8).
 *
 * The structured change a repair strategy produces — node patches, edge
 * patches, optional section replacement and the expected postconditions.
 * This supersedes the legacy flat `paramsPatch` for graph repair while the
 * legacy shape stays accepted via {@link normalizeLegacyParamsPatch}.
 *
 * Candidates are PARSED ({@link parseRepairCandidate}) and applied to a CLONE
 * ({@link applyRepairCandidate}) — never straight onto the saved workflow:
 *
 * ```text
 * original → candidate (clone) → static validate → execute → verify
 *          → commit only on pass, else rollback
 * ```
 *
 * Pure module: no `chrome`, no DOM.
 *
 * @module lib/workflow/repair-candidate
 */
import { checkWorkflowIntegrity, integrityIsClean } from './integrity'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'
import type { WorkflowCondition } from './conditions'
import type { RepairStrategy } from './repair-session'
import { isWorkflowFailureType } from './failure-classification'

// --- Patch operations --------------------------------------------------------

export type NodePatch =
  | { op: 'update-node'; nodeId: string; changes: Record<string, unknown> }
  | { op: 'insert-node'; node: WorkflowNode }
  | { op: 'delete-node'; nodeId: string }

export type EdgePatch =
  | {
      op: 'connect'
      source: string
      target: string
      sourceHandle?: string
      targetHandle?: string
    }
  | {
      op: 'disconnect'
      source: string
      target: string
      sourceHandle?: string
    }

// --- Candidate ---------------------------------------------------------------

export interface RepairCandidate {
  strategy: RepairStrategy
  reason: string

  nodePatches: NodePatch[]
  edgePatches: EdgePatch[]

  replacementSection?: {
    nodeIds: string[]
    workflow: Partial<Workflow>
  }

  expectedPostconditions: WorkflowCondition[]

  confidence?: number
}

// --- Parsing ------------------------------------------------------------------

export type ParsedRepairResponse =
  | { kind: 'candidate'; candidate: RepairCandidate }
  | { kind: 'empty' }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'refusal'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const STRATEGY_SET: ReadonlySet<RepairStrategy> = new Set<RepairStrategy>([
  'terminal-state-check',
  'readiness-recovery',
  'locator-repair',
  'parameter-repair',
  'local-graph-repair',
  'section-replan',
  'full-workflow-replan',
  'agent-rescue',
])

function isRepairStrategy(value: unknown): value is RepairStrategy {
  return typeof value === 'string' && (STRATEGY_SET as ReadonlySet<string>).has(value)
}

function parseNodePatch(value: unknown, issues: string[]): NodePatch | undefined {
  if (!isRecord(value) || typeof value['op'] !== 'string') {
    issues.push('node patch missing op')
    return undefined
  }
  const op = value['op']
  if (op === 'update-node') {
    const nodeId = value['nodeId']
    const changes = value['changes']
    if (typeof nodeId !== 'string') {
      issues.push('update-node missing nodeId')
      return undefined
    }
    if (!isRecord(changes)) {
      issues.push('update-node missing changes object')
      return undefined
    }
    return { op, nodeId, changes }
  }
  if (op === 'insert-node') {
    const node = value['node']
    if (!isRecord(node) || typeof node['id'] !== 'string') {
      issues.push('insert-node missing node.id')
      return undefined
    }
    return { op, node: node as unknown as WorkflowNode }
  }
  if (op === 'delete-node') {
    if (typeof value['nodeId'] !== 'string') {
      issues.push('delete-node missing nodeId')
      return undefined
    }
    return { op, nodeId: String(value['nodeId']) }
  }
  issues.push(`unknown node patch op: ${op}`)
  return undefined
}

function parseEdgePatch(value: unknown, issues: string[]): EdgePatch | undefined {
  if (!isRecord(value) || typeof value['op'] !== 'string') {
    issues.push('edge patch missing op')
    return undefined
  }
  const op = value['op']
  if (op === 'connect' || op === 'disconnect') {
    if (typeof value['source'] !== 'string' || typeof value['target'] !== 'string') {
      issues.push(`${op} edge missing source/target`)
      return undefined
    }
    const out: EdgePatch =
      op === 'connect'
        ? {
            op,
            source: value['source'],
            target: value['target'],
            ...(typeof value['sourceHandle'] === 'string' ? { sourceHandle: value['sourceHandle'] } : {}),
            ...(typeof value['targetHandle'] === 'string' ? { targetHandle: value['targetHandle'] } : {}),
          }
        : {
            op,
            source: value['source'],
            target: value['target'],
            ...(typeof value['sourceHandle'] === 'string' ? { sourceHandle: value['sourceHandle'] } : {}),
          }
    return out
  }
  issues.push(`unknown edge patch op: ${op}`)
  return undefined
}

function conditionsOf(value: unknown): WorkflowCondition[] {
  return Array.isArray(value) ? (value as WorkflowCondition[]) : []
}

/**
 * Parse an untrusted model response into one of: a valid candidate, empty
 * output (no patch proposed), invalid output, or a strategy refusal
 * (spec §27.1).
 */
export function parseRepairResponse(raw: unknown): ParsedRepairResponse {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return { kind: 'empty' }
    // The legacy refusal phrase: parsed as EMPTY, which the orchestrator
    // converts to "next strategy" — never to human takeover (spec §27.2).
    if (/no patch proposed|no candidate|cannot repair/i.test(trimmed)) return { kind: 'empty' }
    // Try embedded JSON.
    const embedded = extractJson(trimmed)
    if (embedded !== undefined) return parseRepairResponse(embedded)
    return { kind: 'invalid', issues: ['model returned prose instead of a candidate'] }
  }
  if (!isRecord(raw)) return { kind: 'invalid', issues: ['response is not an object'] }

  // Explicit refusal shape.
  if (typeof raw['refusal'] === 'string') {
    return { kind: 'refusal', reason: raw['refusal'] }
  }

  const issues: string[] = []
  if (!isRepairStrategy(raw['strategy'])) issues.push('missing valid strategy')
  if (typeof raw['reason'] !== 'string') issues.push('missing reason')

  const nodePatches: NodePatch[] = []
  if (raw['nodePatches'] !== undefined) {
    if (!Array.isArray(raw['nodePatches'])) {
      issues.push('nodePatches must be an array')
    } else {
      for (const value of raw['nodePatches']) {
        const before = issues.length
        const patch = parseNodePatch(value, issues)
        if (patch && issues.length === before) nodePatches.push(patch)
      }
    }
  }

  const edgePatches: EdgePatch[] = []
  if (raw['edgePatches'] !== undefined) {
    if (!Array.isArray(raw['edgePatches'])) {
      issues.push('edgePatches must be an array')
    } else {
      for (const value of raw['edgePatches']) {
        const before = issues.length
        const patch = parseEdgePatch(value, issues)
        if (patch && issues.length === before) edgePatches.push(patch)
      }
    }
  }

  if (nodePatches.length === 0 && edgePatches.length === 0 && !raw['replacementSection']) {
    // A structured object with no changes == the current strategy produced
    // no candidate.
    return { kind: 'empty' }
  }

  if (issues.length) return { kind: 'invalid', issues }

  const candidate: RepairCandidate = {
    strategy: raw['strategy'] as RepairStrategy,
    reason: String(raw['reason']),
    nodePatches,
    edgePatches,
    expectedPostconditions: conditionsOf(raw['expectedPostconditions']),
    ...(isRecord(raw['replacementSection'])
      ? {
          replacementSection: {
            nodeIds: Array.isArray(raw['replacementSection']['nodeIds'])
              ? (raw['replacementSection']['nodeIds'] as string[])
              : [],
            workflow: isRecord(raw['replacementSection']['workflow'])
              ? (raw['replacementSection']['workflow'] as Partial<Workflow>)
              : {},
          },
        }
      : {}),
    ...(typeof raw['confidence'] === 'number' ? { confidence: raw['confidence'] } : {}),
  }
  return { kind: 'candidate', candidate }
}

/** Extract the first balanced JSON object/array from a text blob. */
function extractJson(text: string): unknown {
  const start = text.search(/[[{]/)
  if (start < 0) return undefined
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Strictly validate an already-parsed candidate (spec §17 parsing rules). */
export function validateRepairCandidate(
  candidate: RepairCandidate,
  workflow: Workflow,
): string[] {
  const issues: string[] = []
  const nodeIds = new Set(workflow.drawflow.nodes.map((node) => node.id))
  for (const patch of candidate.nodePatches) {
    if (patch.op === 'update-node') {
      if (!nodeIds.has(patch.nodeId)) issues.push(`update-node target missing: ${patch.nodeId}`)
    } else if (patch.op === 'delete-node') {
      if (!nodeIds.has(patch.nodeId)) issues.push(`delete-node target missing: ${patch.nodeId}`)
    } else if (!patch.node.id) {
      issues.push('insert-node missing id')
    }
  }
  for (const patch of candidate.edgePatches) {
    const endpointsExist = nodeIds.has(patch.source) && nodeIds.has(patch.target)
    // A connect may reference a node inserted by the same candidate.
    const inserted = candidate.nodePatches.some(
      (nodePatch) => nodePatch.op === 'insert-node' && (nodePatch.node.id === patch.source || nodePatch.node.id === patch.target),
    )
    if (!endpointsExist && !inserted) {
      issues.push(`edge endpoint missing: ${patch.source} → ${patch.target}`)
    }
  }
  return issues
}

// --- Apply (to a clone) -------------------------------------------------------

let edgeCounter = 0
function newEdgeId(): string {
  edgeCounter = (edgeCounter + 1) % Number.MAX_SAFE_INTEGER
  return `repair-edge-${Date.now().toString(36)}-${edgeCounter.toString(36)}`
}

export interface ApplyResult {
  workflow: Workflow
  changedNodeIds: string[]
  issues: string[]
}

/**
 * Apply a candidate to a CLONE of the workflow, then run integrity
 * validation. Nothing here mutates the input; when integrity fails the
 * caller discards the clone (rollback).
 */
export function applyRepairCandidate(workflow: Workflow, candidate: RepairCandidate): ApplyResult {
  const clone: Workflow = structuredClone(workflow)
  const changed = new Set<string>()

  // Node patches.
  for (const patch of candidate.nodePatches) {
    if (patch.op === 'update-node') {
      const node = clone.drawflow.nodes.find((entry) => entry.id === patch.nodeId)
      if (!node) continue
      node.data = { ...node.data, ...patch.changes }
      changed.add(patch.nodeId)
    } else if (patch.op === 'insert-node') {
      if (!clone.drawflow.nodes.some((entry) => entry.id === patch.node.id)) {
        clone.drawflow.nodes.push(structuredClone(patch.node))
      }
      changed.add(patch.node.id)
    } else if (patch.op === 'delete-node') {
      clone.drawflow.nodes = clone.drawflow.nodes.filter((entry) => entry.id !== patch.nodeId)
      clone.drawflow.edges = clone.drawflow.edges.filter(
        (edge) => edge.source !== patch.nodeId && edge.target !== patch.nodeId,
      )
      changed.add(patch.nodeId)
    }
  }

  // Edge patches.
  for (const patch of candidate.edgePatches) {
    if (patch.op === 'connect') {
      const exists = clone.drawflow.edges.some(
        (edge) =>
          edge.source === patch.source &&
          edge.target === patch.target &&
          (edge.sourceHandle ?? '') === (patch.sourceHandle ?? ''),
      )
      if (!exists) {
        const edge: WorkflowEdge = {
          id: newEdgeId(),
          source: patch.source,
          target: patch.target,
          ...(patch.sourceHandle ? { sourceHandle: patch.sourceHandle } : {}),
          ...(patch.targetHandle ? { targetHandle: patch.targetHandle } : {}),
        }
        clone.drawflow.edges.push(edge)
      }
      changed.add(patch.source)
      changed.add(patch.target)
    } else {
      clone.drawflow.edges = clone.drawflow.edges.filter(
        (edge) =>
          !(
            edge.source === patch.source &&
            edge.target === patch.target &&
            (edge.sourceHandle ?? '') === (patch.sourceHandle ?? '')
          ),
      )
      changed.add(patch.source)
      changed.add(patch.target)
    }
  }

  // Static integrity gate on the patched clone.
  const integrity = checkWorkflowIntegrity(clone)
  const issues: string[] = integrityIsClean(integrity)
    ? []
    : [
        ...integrity.danglingVars.map((entry) => `dangling variable: ${entry.reference}`),
        ...integrity.orphanNodes.map((id) => `orphan node: ${id}`),
        ...integrity.unreachable.map((id) => `unreachable node: ${id}`),
      ]
  return { workflow: clone, changedNodeIds: [...changed], issues }
}

// --- Legacy compatibility -----------------------------------------------------

/**
 * Normalize the legacy flat `paramsPatch` shape ({nodeId, params}) into a
 * candidate, so old call sites keep working.
 */
export function normalizeLegacyParamsPatch(input: {
  nodeId: string
  params: Record<string, unknown>
  reason?: string
  strategy?: RepairStrategy
}): RepairCandidate {
  return {
    strategy: input.strategy ?? 'parameter-repair',
    reason: input.reason ?? 'legacy params patch',
    nodePatches: [{ op: 'update-node', nodeId: input.nodeId, changes: input.params }],
    edgePatches: [],
    expectedPostconditions: [],
  }
}

/** Whether a value looks like a failure type code (used by parser adapters). */
export function looksLikeFailureType(value: unknown): boolean {
  return isWorkflowFailureType(value)
}
