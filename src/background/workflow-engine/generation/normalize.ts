/**
 * Workflow generation normalization pipeline (spec §7 · Commit 03).
 *
 * Turns the captured action list into a tighter, deterministic PROGRAM
 * without an LLM. Every rule is conservative: a node is removed or merged
 * ONLY when it is provably redundant, and branch / multi-parent nodes are
 * never touched (removing them can change control flow).
 *
 * Rules:
 *
 *   1. duplicate click cleanup     — a repeated click on the SAME selector
 *      immediately after the first, when the first click has no other
 *      purpose (single in/out) — collapse to one;
 *   2. duplicate navigation        — consecutive identical new-tab / link /
 *      active-tab actions to the same URL — keep the first;
 *   3. redundant delay cleanup     — a small fixed delay immediately followed
 *      by a readiness-protected action — the readiness contract already
 *      covers the wait, drop the delay;
 *   4. exploratory action removal  — a hover/scroll whose result no later
 *      node reads and which sits in a simple linear segment — remove;
 *   5. input candidate extraction  — mark repeated / clearly-business literal
 *      values as candidates (Commit 04 promotes them to trigger inputs);
 *      nothing is rewritten here.
 *
 * Hard guarantees:
 *
 *   - the trigger head and every verified business node are preserved;
 *   - the goal (goalSpec / goalText) is never altered;
 *   - edges are rewired only around removed single-in/single-out nodes;
 *   - anything uncertain is kept with an explanatory note.
 *
 * Pure module: no `chrome`, no DOM, no I/O.
 *
 * @module background/workflow-engine/generation/normalize
 */

import type { WorkflowDraft } from '../../../lib/workflow/draft-types'
import type { WorkflowEdge, WorkflowNode } from '../../../lib/workflow/types'

export type NormalizationNoteCode =
  | 'DUPLICATE_CLICK'
  | 'DUPLICATE_NAVIGATION'
  | 'REDUNDANT_DELAY'
  | 'EXPLORATORY_ACTION'
  | 'INPUT_CANDIDATE'
  | 'PRESERVED'

export interface NormalizationNote {
  code: NormalizationNoteCode
  nodeId?: string
  message: string
}

/** A literal value worth promoting to a runtime input (Commit 04). */
export interface InputCandidate {
  nodeId: string
  path: string
  value: string
  reason: string
}

export interface NormalizationResult {
  draft: WorkflowDraft
  /** Ids of nodes removed outright. */
  removedNodeIds: string[]
  /** Ids of nodes merged into a kept neighbor (pair: removed → kept). */
  mergedNodeIds: string[]
  inputCandidates: InputCandidate[]
  notes: NormalizationNote[]
}

// --- block vocabulary -------------------------------------------------------

const CLICK_BLOCKS = new Set(['event-click', 'click'])
const NAV_BLOCKS = new Set(['new-tab', 'link', 'active-tab', 'go-back', 'new-window'])
const DELAY_BLOCKS = new Set(['delay'])
const EXPLORATORY_BLOCKS = new Set(['hover-element', 'element-scroll'])

/** Blocks whose own contract already waits for an observable state. */
const READINESS_PROTECTED_BLOCKS = new Set([
  'event-click',
  'click',
  'forms',
  'get-text',
  'element-exists',
  'wait-for',
  'set-checkbox',
  'select-option',
  'hover-element',
])

function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  return typeof fromData === 'string' && fromData ? fromData : node.label
}

function selectorOf(node: WorkflowNode): string {
  const data = node.data ?? {}
  return (
    (typeof data['selector'] === 'string' && data['selector']) ||
    (typeof data['cssSelector'] === 'string' && data['cssSelector']) ||
    ''
  )
}

function navTargetOf(node: WorkflowNode): string {
  const data = node.data ?? {}
  return (
    (typeof data['url'] === 'string' && data['url']) ||
    (typeof data['tabUrl'] === 'string' && data['tabUrl']) ||
    selectorOf(node)
  )
}

function delayMsOf(node: WorkflowNode): number {
  const time = node.data?.['time']
  const n = typeof time === 'number' ? time : Number(time)
  return Number.isFinite(n) ? n : 0
}

/** A short fixed delay a readiness contract can replace (≤ 1000 ms). */
const REDUNDANT_DELAY_MAX_MS = 1000

// --- graph adjacency --------------------------------------------------------

interface Adjacency {
  inEdges: WorkflowEdge[]
  outEdges: WorkflowEdge[]
}

function adjacencyOf(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, Adjacency> {
  const map = new Map<string, Adjacency>()
  for (const node of nodes) {
    map.set(node.id, { inEdges: [], outEdges: [] })
  }
  for (const edge of edges) {
    map.get(edge.source)?.outEdges.push(edge)
    map.get(edge.target)?.inEdges.push(edge)
  }
  return map
}

/**
 * A node is safe to remove only in a simple linear segment: exactly one plain
 * in-edge, no branch/merge, and either one plain out-edge (an interior node)
 * or none (a redundant tail). Removing it changes no routing.
 */
function isLinearRemovable(adj: Adjacency): boolean {
  return (
    adj.inEdges.length === 1 &&
    adj.outEdges.length <= 1 &&
    !adj.inEdges[0]!.sourceHandle &&
    !adj.outEdges.some((e) => e.sourceHandle)
  )
}

/** Direct linear predecessor/successor by the single plain edge. */
// --- input candidate extraction ---------------------------------------------

/** Forms fill literals that look like business values (non-empty, non-ref). */
const INTERPOLATION = /\{\{[^{}]*\}\}/

function collectInputCandidates(nodes: WorkflowNode[]): InputCandidate[] {
  const candidates: InputCandidate[] = []
  for (const node of nodes) {
    if (blockIdOf(node) !== 'forms') continue
    const value = node.data?.['value'] ?? node.data?.['formData']
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || INTERPOLATION.test(trimmed)) continue
    candidates.push({
      nodeId: node.id,
      path: 'value',
      value: trimmed,
      reason: 'forms literal',
    })
  }
  return candidates
}

// --- main pipeline ----------------------------------------------------------

/**
 * Normalize a draft. Returns a new draft (the input is not mutated) plus the
 * changes and notes.
 */
export function normalizeWorkflowDraft(input: WorkflowDraft): NormalizationResult {
  const notes: NormalizationNote[] = []
  const removedNodeIds: string[] = []
  const mergedNodeIds: string[] = []

  // Work on shallow copies; node.data is cloned only when a node is kept but
  // annotated (this pipeline never rewrites kept-node data).
  let nodes: WorkflowNode[] = input.nodes.map((n) => ({ ...n, data: { ...n.data } }))
  let edges: WorkflowEdge[] = input.edges.map((e) => ({ ...e }))

  // Input candidates are collected BEFORE removal (from the original set).
  const inputCandidates = collectInputCandidates(nodes)
  for (const candidate of inputCandidates) {
    notes.push({
      code: 'INPUT_CANDIDATE',
      nodeId: candidate.nodeId,
      message: `${candidate.path}=${candidate.value}`,
    })
  }

  const removal = new Set<string>()

  // Recompute adjacency, then mark nodes for removal in a single pass over
  // append order. Removal is decided against the ORIGINAL adjacency so two
  // adjacent duplicates are handled consistently with `prevKept` tracking.
  const adj = adjacencyOf(nodes, edges)

  const prevKept: Array<WorkflowNode | undefined> = []
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!
    const blockId = blockIdOf(node)
    const prev = prevKept[i]

    // Never remove the trigger head or anything branch/merge scoped.
    const nodeAdj = adj.get(node.id)!
    const linear = isLinearRemovable(nodeAdj)

    let marked: NormalizationNote | undefined

    if (prev && linear) {
      const prevBlock = blockIdOf(prev)

      // 1. duplicate click
      if (
        CLICK_BLOCKS.has(blockId) &&
        CLICK_BLOCKS.has(prevBlock) &&
        selectorOf(node) &&
        selectorOf(node) === selectorOf(prev)
      ) {
        marked = { code: 'DUPLICATE_CLICK', nodeId: node.id, message: selectorOf(node) }
      }

      // 2. duplicate navigation
      if (!marked && NAV_BLOCKS.has(blockId) && NAV_BLOCKS.has(prevBlock)) {
        const target = navTargetOf(node)
        if (target && target === navTargetOf(prev)) {
          marked = { code: 'DUPLICATE_NAVIGATION', nodeId: node.id, message: target }
        }
      }

      // 3. redundant delay before a readiness-protected action
      if (!marked && DELAY_BLOCKS.has(blockId) && delayMsOf(node) <= REDUNDANT_DELAY_MAX_MS) {
        const successorId = nodeAdj.outEdges[0]?.target
        const successor = nodes.find((n) => n.id === successorId)
        if (successor && READINESS_PROTECTED_BLOCKS.has(blockIdOf(successor))) {
          marked = {
            code: 'REDUNDANT_DELAY',
            nodeId: node.id,
            message: `${delayMsOf(node)}ms`,
          }
        }
      }

      // 4. exploratory action with no downstream reader.
      //    Hover: only when the successor targets a DIFFERENT element (a hover
      //    that is a precondition for the same-element action is meaningful).
      //    Scroll: a zero-delta scroll is exploratory; a real scroll that moves
      //    the page to reach content is preserved.
      if (!marked && EXPLORATORY_BLOCKS.has(blockId)) {
        if (blockId === 'element-scroll') {
          const dx = Number(node.data?.['scrollX'] ?? 0)
          const dy = Number(node.data?.['scrollY'] ?? 0)
          if (dx === 0 && dy === 0) {
            marked = { code: 'EXPLORATORY_ACTION', nodeId: node.id, message: blockId }
          }
        } else if (blockId === 'hover-element') {
          const successorId = nodeAdj.outEdges[0]?.target
          const successor = nodes.find((n) => n.id === successorId)
          if (successor && selectorOf(successor) !== selectorOf(node)) {
            marked = { code: 'EXPLORATORY_ACTION', nodeId: node.id, message: blockId }
          }
        }
      }
    }

    if (marked) {
      removal.add(node.id)
      notes.push(marked)
      removedNodeIds.push(node.id)
      prevKept[i + 1] = prev
    } else {
      if (!marked && !linear && blockId !== 'trigger') {
        notes.push({ code: 'PRESERVED', nodeId: node.id, message: blockId })
      }
      prevKept[i + 1] = node
    }
  }

  // Apply removal + rewire edges around removed linear nodes.
  if (removal.size > 0) {
    nodes = nodes.filter((n) => !removal.has(n.id))
    edges = rewireEdges(edges, removal)
  }

  // Track merges for the report (removed click/nav = merged into predecessor).
  for (const id of removedNodeIds) {
    if (!mergedNodeIds.includes(id)) mergedNodeIds.push(id)
  }

  const draft: WorkflowDraft = {
    ...input,
    nodes,
    edges,
    tail: nodes.at(-1)?.id ?? input.tail,
  }

  return { draft, removedNodeIds, mergedNodeIds, inputCandidates, notes }
}

/**
 * Rewire edges: for each removed node, connect its predecessor directly to
 * its successor. Only simple single-in/single-out nodes are removed, so the
 * predecessor/successor pair is unambiguous.
 */
function rewireEdges(edges: WorkflowEdge[], removal: Set<string>): WorkflowEdge[] {
  // Build predecessor/successor maps over the current edges.
  const predecessor = new Map<string, string>()
  const successor = new Map<string, string>()
  for (const edge of edges) {
    successor.set(edge.source, edge.target)
    predecessor.set(edge.target, edge.source)
  }

  const nextEdges: WorkflowEdge[] = []
  const added = new Set<string>()

  for (const edge of edges) {
    if (removal.has(edge.target) || removal.has(edge.source)) continue
    const key = `${edge.source}->${edge.target}`
    if (!added.has(key)) {
      added.add(key)
      nextEdges.push(edge)
    }
  }

  // For each removed node, bridge its nearest surviving neighbors.
  for (const removedId of removal) {
    let source = predecessor.get(removedId)
    while (source && removal.has(source)) source = predecessor.get(source)
    let target = successor.get(removedId)
    while (target && removal.has(target)) target = successor.get(target)
    if (source && target) {
      const key = `${source}->${target}`
      if (!added.has(key)) {
        added.add(key)
        nextEdges.push({
          id: `norm-${source}-${target}`,
          source,
          target,
        })
      }
    }
  }

  return nextEdges
}

/** Convenience guard used by tests: whether the goal text is unchanged. */
export function goalTextOf(draft: WorkflowDraft): string | undefined {
  return draft.goalText
}
