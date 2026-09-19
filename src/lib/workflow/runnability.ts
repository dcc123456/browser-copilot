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
import type { Workflow } from './types'

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
