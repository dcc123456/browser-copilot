/**
 * Save-time runnability normalization for generated workflows.
 *
 * The generation session proves each step works — every recorded operator call
 * executed against the live page. What it cannot prove is that the graph still
 * works when REPLAYED back-to-back instead of paced by a model: pages render
 * late, and a step that acted on a rendered element now races its own
 * predecessor's navigation.
 *
 * The run path already force-enables a short element wait on interaction
 * blocks (`applyDefaultWaits` in `background/workflow-engine/debug-session`).
 * Persisting the same flag on the graph at save time makes the saved workflow
 * self-describing: every consumer of the graph — server runner, scheduler,
 * future engine paths — sees the waits without re-deriving them, and a user
 * reading the graph in the editor sees why a step waits.
 *
 * Pure and idempotent: blocks that already set their own wait keep it, and a
 * graph passed through twice comes out identical.
 *
 * @module lib/workflow/runnability
 */

import { BLOCK_BY_ID } from './blocks/palette'
import { idempotencyOf, nodeReliabilityOf } from './reliability'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

/**
 * Interaction blocks whose executors honor `waitForSelector` polling, mirrored
 * from `WAIT_BLOCKS` in `background/workflow-engine/debug-session` (which adds
 * the legacy ids that only the editor/recorder emits). Read blocks poll by an
 * executor-level default and need no flag.
 */
const WAIT_BLOCK_IDS: readonly string[] = [
  'event-click',
  'hover-element',
  'forms',
  'element-scroll',
]

/** Blocks that establish WHICH page the graph works on by opening one. */
const NAVIGATION_BLOCK_IDS: readonly string[] = ['new-tab', 'new-window']

/** Window persisted on a block that had none — matches the run-time default. */
export const PERSISTED_WAIT_MS = 5000

/** Deterministic id: a graph that already has one is already anchored. */
const ANCHOR_NODE_ID = 'page-anchor'

/** Placed to the LEFT of the head, so the chain keeps reading top-to-bottom. */
const ANCHOR_OFFSET_X = 260

/** Extra attempts after the first one, on a step that failed to act on the page. */
export const DEFAULT_RETRY_TIMES = 2

/**
 * Pause between attempts. Short on purpose: it is meant to outlast a render
 * frame or an XHR, not a slow page — a slow page is what the readiness probe
 * and `wait-for` are for, and a long interval here would just make every run
 * that genuinely cannot work take three times as long.
 */
export const DEFAULT_RETRY_INTERVAL_MS = 800

/**
 * Page-acting blocks a retry can repair. Reads are included (the element may
 * not be mounted yet); control flow, variables and navigation are not — a
 * retried loop re-runs its body, and a retried `new-tab` opens a second tab.
 */
const RETRY_BLOCK_IDS: readonly string[] = [
  'event-click',
  'click',
  'forms',
  'hover-element',
  'element-scroll',
  'select-option',
  'set-checkbox',
  'set-radio',
  'press-key',
  'upload-file',
  'get-text',
  'attribute-value',
  'read-page',
  'element-exists',
  'wait-for',
]

/**
 * A copy of the workflow with a leading `new-tab` node that opens `url`, when
 * its first element action would otherwise run on whatever tab is active.
 *
 * This is the single biggest replay failure that generation could not see: the
 * agent acted on a page the user already had open, so the graph records
 * interactions and no navigation, and replaying it tomorrow — on a blank tab,
 * on a different origin, after the browser restarted — types into the wrong
 * document or finds nothing. The warning in `validateWorkflowForRun` tells the
 * user to open the page first; this just opens it for them.
 *
 * Deliberately additive: it never removes, reorders or rewrites an existing
 * node, and it declines (returning the SAME object) when the graph already
 * navigates, when it has no element action to anchor, or when there is no URL
 * to point at. A graph that comes out of here different came out of here with
 * exactly one node and the edges to reroute it — everything else is untouched.
 */
export function ensureNavigationAnchor(workflow: Workflow, url?: string): Workflow {
  if (!unanchoredElementStart(workflow)) return workflow
  const target = url?.trim() || String(workflow.settings?.['generationOriginUrl'] ?? '').trim()
  if (!/^https?:\/\//i.test(target)) return workflow

  const nodes = [...workflow.drawflow.nodes]
  const edges = [...workflow.drawflow.edges]
  if (nodes.some((node) => node.id === ANCHOR_NODE_ID)) return workflow
  // The graph's first action, trigger aside. Anchoring there — rather than at
  // the element block that forced the anchor — means the page is open before
  // ANY step runs, so a leading read or delay cannot act on the stale tab.
  const headIndex = nodes.findIndex(
    (node) => blockIdOf(node) !== '' && blockIdOf(node) !== 'trigger',
  )
  if (headIndex === -1) return workflow
  const head = nodes[headIndex]!

  const incomingIndex = edges.findIndex((edge) => edge.target === head.id)
  const triggerIndex = nodes.findIndex((node) => blockIdOf(node) === 'trigger')
  const anchor: WorkflowNode = {
    id: ANCHOR_NODE_ID,
    label: 'new-tab',
    position: { x: head.position.x - ANCHOR_OFFSET_X, y: head.position.y },
    data: {
      blockId: 'new-tab',
      url: target,
      description: '',
      waitTabLoaded: true,
    },
  }
  const outEdge: WorkflowEdge = {
    id: `${ANCHOR_NODE_ID}-to-${head.id}`,
    source: anchor.id,
    target: head.id,
    sourceHandle: 'new-tab-output-1',
    targetHandle: `${blockIdOf(head)}-input-1`,
  }

  if (incomingIndex >= 0) {
    // Splice into the chain the generator already built.
    const incoming = edges[incomingIndex]!
    edges[incomingIndex] = { ...incoming, target: anchor.id, targetHandle: 'new-tab-input-1' }
  } else if (triggerIndex >= 0 && !edges.some((edge) => edge.source === nodes[triggerIndex]!.id)) {
    edges.push({
      id: `${nodes[triggerIndex]!.id}-to-${ANCHOR_NODE_ID}`,
      source: nodes[triggerIndex]!.id,
      target: anchor.id,
      sourceHandle: 'trigger-output-1',
      targetHandle: 'new-tab-input-1',
    })
  }
  edges.push(outEdge)
  nodes.splice(headIndex, 0, anchor)

  return { ...workflow, drawflow: { ...workflow.drawflow, nodes, edges } }
}

/**
 * A copy of the workflow with a short retry armed on every repeat-safe page
 * step that has no error policy of its own.
 *
 * During generation each step was paced by a model: it looked at the page,
 * waited for the render, acted. A replay runs the steps back to back, so the
 * dominant first-run failure is not a wrong locator but a locator that will be
 * right in 300 ms. A retry is the cheapest possible remedy — it adds no gate,
 * refuses nothing, and turns a transient miss into the success the generation
 * session already proved is reachable.
 *
 * The scope is deliberately narrow, and every part of it protects the success
 * rate rather than the strictness:
 *   - only blocks that ACT on the page (a retry of a loop node would re-run its
 *     whole body, and a retry of a variable step fixes nothing);
 *   - never a step `idempotencyOf` calls unsafe — a submit does not get
 *     re-fired just because it looked like it failed;
 *   - never a node the user or the AI already configured, so an existing
 *     `fallback` / `continue` / custom retry policy is respected as-is.
 */
export function persistDefaultRetries(workflow: Workflow): Workflow {
  let changed = false
  const nodes = workflow.drawflow.nodes.map((node) => {
    const blockId = blockIdOf(node)
    if (!RETRY_BLOCK_IDS.includes(blockId)) return node
    if (node.data?.['onError']) return node
    if (idempotencyOf(blockId, node.data ?? {}, nodeReliabilityOf(node)) === 'unsafe') return node
    changed = true
    return {
      ...node,
      data: {
        ...node.data,
        onError: {
          enable: true,
          toDo: 'retry',
          retryTimes: DEFAULT_RETRY_TIMES,
          retryInterval: DEFAULT_RETRY_INTERVAL_MS,
        },
      },
    }
  })
  return changed ? { ...workflow, drawflow: { ...workflow.drawflow, nodes } } : workflow
}

/** The block id of a node: `data.blockId`, falling back to the label. */
function blockIdOf(node: { label: string; data?: Record<string, unknown> }): string {
  const fromData = node.data?.['blockId']
  return typeof fromData === 'string' && fromData ? fromData : node.label
}

/** Does this block act on a page element (its catalog carries `selector`)? */
function takesElement(blockId: string): boolean {
  const entry = BLOCK_BY_ID.get(blockId)
  return !!entry && (entry.refDataKeys ?? []).includes('selector')
}

/**
 * Does the graph's first element action run on WHATEVER page is active?
 *
 * True when the path from the trigger reaches an element-acting block before
 * any block that OPENS a page (`new-tab` / `new-window`). Such a graph was
 * almost certainly generated against a page the user already had open, so a
 * replay only works on that same page — the run gate warns, and the run-start
 * hint fires when the active tab is a different origin. Reading the graph in
 * trigger→node order (not a full reachability walk) is deliberate: generated
 * graphs are single chains, and a hand-edited branch that opens a page after
 * the first element action is still unanchored at that first action.
 */
export function unanchoredElementStart(workflow: Workflow): boolean {
  for (const node of workflow.drawflow.nodes) {
    const blockId = blockIdOf(node)
    if (!blockId || blockId === 'trigger') continue
    if ((NAVIGATION_BLOCK_IDS as readonly string[]).includes(blockId)) return false
    if (takesElement(blockId)) return true
  }
  return false
}

/**
 * A copy of the workflow with element waits persisted on interaction blocks.
 * Never adds or removes nodes/edges — the graph's structure is exactly what
 * the user reviewed. `ms <= 0` disables the rewrite entirely.
 */
export function persistDefaultWaits(workflow: Workflow, ms = PERSISTED_WAIT_MS): Workflow {
  if (!(ms > 0)) return workflow
  const clone = structuredClone(workflow)
  for (const node of clone.drawflow.nodes) {
    const blockId = blockIdOf(node)
    if (!blockId || !(WAIT_BLOCK_IDS as readonly string[]).includes(blockId)) continue
    if (!node.data) continue
    if (node.data['waitForSelector'] === true) continue
    node.data['waitForSelector'] = true
    const existing = node.data['waitSelectorTimeout']
    if (!(typeof existing === 'number' && existing > 0)) {
      node.data['waitSelectorTimeout'] = ms
    }
  }
  return clone
}
