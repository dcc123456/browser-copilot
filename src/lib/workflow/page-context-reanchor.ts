/**
 * Page-context reanchoring — the deterministic repair for WRONG_ORIGIN.
 *
 * A strict run refuses to act when the page it stands on is not the page the
 * graph was grounded on (spec §11). Sometimes the contradiction is not the
 * user's fault: the recorded grounding (`generationOriginUrl` /
 * `settings.pageContext`) disagrees with where the graph's OWN first
 * navigation block deterministically drives. A graph that opens
 * `https://creator.example.com` as its first page-acting step acts on
 * creator.example.com — the honest fix is to move the anchor to that origin,
 * not to ask a human.
 *
 * The candidate this module produces touches NOTHING but
 * `settings.pageContext.origin`, and only when the new anchor is a fact
 * already recorded in the graph (a static, reference-free http(s) url). The
 * orchestrator must still re-run and verify; a wrong anchor cannot survive
 * the replay.
 *
 * Pure: no `chrome`, no DOM.
 *
 * @module lib/workflow/page-context-reanchor
 */

import { navigationDestinationOf, originOfUrl, pageContextOf } from './page-context'
import type { RepairCandidate } from './repair-candidate'
import type { WorkflowPatchSet } from './repair/types'
import type { Workflow, WorkflowNode } from './types'

/** Block ids that launch a workflow; the walk starts at one of these. */
const TRIGGER_BLOCK_IDS: ReadonlySet<string> = new Set([
  'trigger',
  'manual',
  'schedule',
  'scheduled',
  'visit-web',
  'context-menu',
  'on-startup',
])

function blockIdOf(node: WorkflowNode): string {
  const raw = node.data?.['blockId']
  return typeof raw === 'string' && raw ? raw : node.label
}

/** The destination the graph navigates to on its own, before any page act. */
export interface NavigationAnchor {
  nodeId: string
  url: string
  origin: string
}

/**
 * Walk the graph from its trigger along the default out-edges (first edge per
 * node, the engine's own fall-through order) and return the destination of
 * the FIRST navigation block reached — but only while no element-op node has
 * been passed: once the graph acts on a page, pages acted on before the nav
 * no longer describe "where this graph runs", and an anchor found past the
 * first action is not the guard's premise. Returns undefined when the graph
 * never self-navigates first.
 */
export function navigationAnchorOf(workflow: Workflow): NavigationAnchor | undefined {
  const nodes = workflow.drawflow.nodes
  if (nodes.length === 0) return undefined
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const firstOut = new Map<string, string>()
  for (const edge of workflow.drawflow.edges) {
    if (!firstOut.has(edge.source)) firstOut.set(edge.source, edge.target)
  }
  let current: WorkflowNode | undefined =
    nodes.find((node) => TRIGGER_BLOCK_IDS.has(blockIdOf(node))) ?? nodes[0]
  const visited = new Set<string>()
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    const blockId = blockIdOf(current)
    if (TRIGGER_BLOCK_IDS.has(blockId)) {
      // continue to the first step
    } else if (blockId === 'new-tab' || blockId === 'open-url') {
      const destination = navigationDestinationOf(
        blockId,
        (current.data ?? {}) as Record<string, unknown>,
      )
      if (destination) {
        const origin = originOfUrl(destination)
        if (origin) return { nodeId: current.id, url: destination, origin }
      }
      // A nav without a static destination cannot anchor anything.
      return undefined
    } else {
      // Some other page-acting node comes first — no self-navigation premise.
      return undefined
    }
    const nextId = firstOut.get(current.id)
    current = nextId ? nodeById.get(nextId) : undefined
  }
  return undefined
}

/**
 * The deterministic WRONG_ORIGIN candidate for a workflow, or undefined when
 * there is nothing safe to re-anchor (no recorded grounding, no static
 * self-navigation, or the two already agree — the last case is a user
 * standing on the wrong site, not a graph defect).
 */
export function pageContextReanchorCandidate(workflow: Workflow): RepairCandidate | undefined {
  const expected = pageContextOf(workflow)
  if (!expected) return undefined
  const anchor = navigationAnchorOf(workflow)
  if (!anchor || anchor.origin === expected.origin) return undefined
  return {
    strategy: 'page-context-reanchor',
    reason: `re-anchor the page context to the graph's own navigation target (${anchor.origin})`,
    nodePatches: [],
    edgePatches: [],
    settingsPatch: { pageContext: { origin: anchor.origin } },
    expectedPostconditions: [],
    confidence: 0.9,
  }
}

let patchSeq = 0

/**
 * The same deterministic reanchor expressed in the v1 patch vocabulary (the
 * shared repair engine), so the generation-finalize and debug loops can
 * validate/apply it through the PatchEngine instead of the auto-repair
 * candidate pipeline. Null when {@link pageContextReanchorCandidate} finds
 * nothing safe to move.
 */
export function pageContextReanchorPatchSet(
  workflow: Workflow,
  analysisId: string,
): WorkflowPatchSet | null {
  const candidate = pageContextReanchorCandidate(workflow)
  const origin = candidate?.settingsPatch?.pageContext?.origin
  if (!candidate || !origin) return null
  patchSeq = (patchSeq + 1) % Number.MAX_SAFE_INTEGER
  const id = `${Date.now().toString(36)}-${patchSeq.toString(36)}`
  return {
    patchSetId: `patch-reanchor-${id}`,
    analysisId,
    operations: [
      {
        operationId: `op-reanchor-${id}`,
        nodeId: '',
        kind: 'SET_PAGE_CONTEXT_ORIGIN',
        before: pageContextOf(workflow)?.origin,
        after: origin,
        reason: candidate.reason,
        evidenceIds: [],
      },
    ],
    reason: candidate.reason,
    confidence: candidate.confidence ?? 0.9,
    expectedEffect: 'the page-context guard accepts the site the graph navigates to itself',
  }
}
