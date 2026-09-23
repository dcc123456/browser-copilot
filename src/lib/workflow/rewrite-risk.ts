/**
 * Rewrite risk classification (spec §8.4, §17.6 · P2).
 *
 * A whole-graph rewrite is kept only as a constrained fallback, but not every
 * rewrite is equally dangerous. This module produces a deterministic risk
 * level by comparing the ORIGINAL workflow against the proposed rewrite:
 *
 *   LOW      — same node set, only params/selectors changed, trigger + goal
 *              preserved;
 *   MEDIUM   — a small share of nodes rewired / replaced, but no deletions of
 *              goal/trigger and graph stays connected;
 *   HIGH     — many nodes replaced/removed, the trigger/goal changed, unsafe
 *              side-effect blocks added, or the graph shape changed a lot;
 *   CRITICAL — trigger/goal removed, blockId whitelist violated, or an unsafe
 *              side effect introduced — never auto-applied, human only.
 *
 * The verdict also returns the contributing signals so the UI can explain the
 * difference between an atomic patch and a rewrite and so an automatic policy
 * can bound what it applies. Pure — no browser / provider.
 *
 * @module lib/workflow/rewrite-risk
 */

import { isGeneratedStrict } from './reliability'
import type { Workflow, WorkflowNode } from './types'

/** Risk levels ordered least → most severe. */
export type RewriteRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

/**
 * Blocks with irreversible business effects (mirror patch-policy intent).
 * Adding one of these in a rewrite raises the risk.
 */
const SIDE_EFFECT_BLOCKS: ReadonlySet<string> = new Set([
  'forms',
  'event-click',
  'click',
  'webhook',
  'upload-file',
  'cookie',
  'notification',
])

const RISK_ORDER: readonly RewriteRiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

function blockIdOf(node: WorkflowNode): string {
  const raw = node.data?.['blockId']
  return typeof raw === 'string' && raw ? raw : node.label
}

/** Index nodes by id. */
function indexNodes(workflow: Workflow): Map<string, WorkflowNode> {
  return new Map(workflow.drawflow.nodes.map((node) => [node.id, node]))
}

/** Structural diff signals between two graphs. */
export interface RewriteDiff {
  nodeCountBefore: number
  nodeCountAfter: number
  added: string[]
  removed: string[]
  replaced: string[] // blockId changed on a retained node id
  paramsChanged: string[]
  edgesBefore: number
  edgesAfter: number
  triggerChanged: boolean
  goalChanged: boolean
  addedSideEffectBlocks: string[]
}

/** Compute the structural diff between the original and a rewrite. */
export function diffRewrites(original: Workflow, rewrite: Workflow): RewriteDiff {
  const before = indexNodes(original)
  const after = indexNodes(rewrite)

  const added: string[] = []
  const removed: string[] = []
  const replaced: string[] = []
  const paramsChanged: string[] = []
  const addedSideEffectBlocks: string[] = []

  for (const [id, node] of after) {
    if (!before.has(id)) {
      added.push(id)
      if (SIDE_EFFECT_BLOCKS.has(blockIdOf(node))) addedSideEffectBlocks.push(id)
      continue
    }
    const oldNode = before.get(id)!
    if (blockIdOf(oldNode) !== blockIdOf(node)) replaced.push(id)
    else if (JSON.stringify(oldNode.data) !== JSON.stringify(node.data)) {
      paramsChanged.push(id)
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id)
  }

  const triggerOf = (workflow: Workflow): WorkflowNode | undefined =>
    workflow.drawflow.nodes.find((node) => blockIdOf(node) === 'trigger')
  const triggerChanged =
    blockIdOf(triggerOf(original) ?? ({ id: '∅' } as WorkflowNode)) !==
    blockIdOf(triggerOf(rewrite) ?? ({ id: '∅' } as WorkflowNode))

  return {
    nodeCountBefore: before.size,
    nodeCountAfter: after.size,
    added: added.sort(),
    removed: removed.sort(),
    replaced: replaced.sort(),
    paramsChanged: paramsChanged.sort(),
    edgesBefore: original.drawflow.edges.length,
    edgesAfter: rewrite.drawflow.edges.length,
    triggerChanged,
    goalChanged:
      JSON.stringify(original.settings?.goalSpec ?? null) !==
      JSON.stringify(rewrite.settings?.goalSpec ?? null),
    addedSideEffectBlocks: addedSideEffectBlocks.sort(),
  }
}

/** A classified rewrite risk with the signals that produced it. */
export interface RewriteRiskVerdict {
  level: RewriteRiskLevel
  diff: RewriteDiff
  /** Human-readable contributing reasons (for the UI / log). */
  reasons: string[]
  /** CRITICAL/HIGH rewrites must never be auto-applied. */
  allowsAutoApply: boolean
}

function maxLevel(a: RewriteRiskLevel, b: RewriteRiskLevel): RewriteRiskLevel {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))] ?? 'HIGH'
}

/**
 * Classify the risk of applying `rewrite` over `original` (spec §8.4).
 */
export function classifyRewriteRisk(original: Workflow, rewrite: Workflow): RewriteRiskVerdict {
  const diff = diffRewrites(original, rewrite)
  const reasons: string[] = []
  let level: RewriteRiskLevel = 'LOW'

  const structuralChanges = diff.added.length + diff.removed.length + diff.replaced.length
  const base = Math.max(1, diff.nodeCountBefore)
  const ratio = structuralChanges / base

  // CRITICAL: trigger / goal removed or a side-effect block introduced.
  if (diff.triggerChanged) {
    level = maxLevel(level, 'CRITICAL')
    reasons.push('the trigger node changed')
  }
  if (diff.goalChanged) {
    level = maxLevel(level, 'HIGH')
    reasons.push('the goal specification changed')
  }
  if (diff.addedSideEffectBlocks.length > 0) {
    level = maxLevel(level, 'HIGH')
    reasons.push(`side-effect block(s) added: ${diff.addedSideEffectBlocks.join(', ')}`)
  }
  const removedTrigger = diff.removed.some(
    (id) => blockIdOf(indexNodes(original).get(id)!) === 'trigger',
  )
  if (removedTrigger) {
    level = 'CRITICAL'
    reasons.push('the trigger node was removed')
  }

  // HIGH: a large share of the graph was structurally altered.
  if (ratio >= 0.5) {
    level = maxLevel(level, 'HIGH')
    reasons.push(`${Math.round(ratio * 100)}% of nodes structurally changed`)
  } else if (structuralChanges > 0 || diff.edgesAfter !== diff.edgesBefore) {
    // MEDIUM: some rewire/replace but limited scope.
    level = maxLevel(level, 'MEDIUM')
    reasons.push(`${structuralChanges} node(s) structurally changed or rewired`)
  } else if (diff.paramsChanged.length > 0) {
    // LOW: same shape, params/selectors only.
    reasons.push(`${diff.paramsChanged.length} node(s) params changed; shape preserved`)
  }

  // In generated-strict mode, hold HIGH to a stricter line.
  if (isGeneratedStrict(rewrite) && level === 'MEDIUM' && diff.replaced.length > 1) {
    level = 'HIGH'
    reasons.push('generated-strict mode elevates multi-node replacement')
  }

  return {
    level,
    diff,
    reasons,
    allowsAutoApply: level === 'LOW' || level === 'MEDIUM',
  }
}
