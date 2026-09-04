/**
 * AI node-review layer for conversation-generated workflows.
 *
 * Two pure halves:
 *
 * 1. {@link reviewStepsOf} cuts a generated linear graph into user-meaningful
 *    STEPS. A step is one primary node (the action the user understands) plus
 *    its satellite nodes — the mechanism blocks the generator inserts around
 *    an action (page-load waits, AI content prefill, OCR recognition). The AI
 *    reviewer and both save-entry UIs face steps, never bare nodes, so a
 *    verdict can never strand half a mechanism (an `ocr` without its fill, a
 *    forms left pointing at a deleted AI variable).
 *
 * 2. {@link applyNodeKeepSelection} rebuilds the workflow with the dropped
 *    steps removed, re-linking the surviving spine with the same handle
 *    convention `workflowFromHistory` uses.
 *
 * Both run on FRESHLY GENERATED workflows (the two save entries call them
 * between `workflowFromHistory` and `workflows.save`), which are linear
 * trigger-first chains — the rebuild relies on that shape.
 *
 * @module lib/workflow/review-patch
 */
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

/** The AI's overall verdict on one generated workflow. */
export interface WorkflowReview {
  /** One concise Chinese paragraph: what the session did, what was dropped. */
  summary: string
  /** Per-step verdicts, keyed by {@link ReviewStep.id}. */
  steps: WorkflowReviewVerdict[]
}

/** The AI's keep/drop judgment for one step. */
export interface WorkflowReviewVerdict {
  id: string
  keep: boolean
  /** Why the step is garbage (shown on the save card when dropped). */
  reason?: string
}

/** One user-meaningful step of a generated workflow. */
export interface ReviewStep {
  /** The primary node's id — also the verdict key the AI reports. */
  id: string
  blockId: string
  /** Human description carried by the node (generation writes Chinese). */
  description: string
  /** Primary node's block data (truncated by the prompt builder, not here). */
  params: Record<string, unknown>
  /** Satellite node ids dropped/kept together with the step. */
  satelliteIds: string[]
  /** Per-satellite human summary for the save-card inline grey text. */
  satelliteSummary: string[]
}

/** Block ids the generator inserts as step mechanics, never as user actions. */
const SATELLITE_BLOCKS: ReadonlySet<string> = new Set([
  'wait-connections',
  'ai-agent',
  'set-variable',
  'ocr',
])

/** `{{token}}` variable reference inside block data. */
const VAR_TOKEN = /\{\{\s*([^{}\s]+)\s*\}\}/g

function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  if (typeof fromData === 'string' && fromData) return fromData
  return node.label
}

function isTriggerNode(node: WorkflowNode): boolean {
  return blockIdOf(node) === 'trigger' || node.label === 'trigger'
}

/** Variable name a node writes (ai-agent / set-variable / ocr all use it). */
function writesOf(node: WorkflowNode): string | undefined {
  const name = node.data?.['variableName']
  return typeof name === 'string' && name ? name : undefined
}

/** Variable names a node reads: `{{token}}` references plus ocr's imageVariable. */
function readsOf(node: WorkflowNode): Set<string> {
  const reads = new Set<string>()
  const stack: unknown[] = [node.data]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === 'string') {
      for (const match of value.matchAll(VAR_TOKEN)) reads.add(match[1]!)
      continue
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) stack.push(nested)
    }
  }
  // The ocr block's variable source names its input image variable WITHOUT
  // braces (`imageVariable: 'lastOcrImage'`).
  const imageVariable = node.data?.['imageVariable']
  if (typeof imageVariable === 'string' && imageVariable) reads.add(imageVariable)
  return reads
}

/**
 * Walks the graph as a linear chain (trigger first, following outgoing
 * edges). Generated workflows are linear; nodes the walk cannot reach (a
 * broken or edited graph) are appended in array order so grouping still sees
 * them.
 */
function chainOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  if (nodes.length === 0) return []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, number>(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    const list = outgoing.get(edge.source) ?? []
    list.push(edge.target)
    outgoing.set(edge.source, list)
  }
  const start =
    nodes.find((node) => isTriggerNode(node)) ??
    nodes.find((node) => (incoming.get(node.id) ?? 0) === 0)
  if (!start) return [...nodes]
  const order: WorkflowNode[] = []
  const seen = new Set<string>()
  let cursor: WorkflowNode | undefined = start
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    order.push(cursor)
    const nextId: string | undefined = (outgoing.get(cursor.id) ?? []).find((id) => !seen.has(id))
    cursor = nextId ? byId.get(nextId) : undefined
  }
  for (const node of nodes) {
    if (!seen.has(node.id)) {
      seen.add(node.id)
      order.push(node)
    }
  }
  return order
}

/**
 * Groups the non-trigger chain into steps. Attachment rules (see the module
 * doc): `wait-connections` hangs on the nearest PREVIOUS primary; a variable
 * writer among the satellite blocks hangs on the first LATER node that reads
 * the variable — resolved transitively, so the OCR cluster
 * (set-variable → ocr → extract-agent) lands on the forms node that finally
 * consumes `{{ocrExtractN}}`. Satellites with no consumer stay primary steps
 * and are judged on their own.
 */
export function reviewStepsOf(workflow: Workflow): ReviewStep[] {
  const order = chainOrder(workflow.drawflow.nodes, workflow.drawflow.edges).filter(
    (node) => !isTriggerNode(node),
  )
  /** satellite index → anchor index (anchor may itself be a satellite). */
  const anchorOf = new Map<number, number>()

  // Pass 1 — forward attachment by variable hand-off (indices strictly grow,
  // so the resolution below cannot cycle).
  for (let i = 0; i < order.length; i++) {
    const node = order[i]!
    if (!SATELLITE_BLOCKS.has(blockIdOf(node))) continue
    const writes = writesOf(node)
    if (!writes) continue
    for (let j = i + 1; j < order.length; j++) {
      if (readsOf(order[j]!).has(writes)) {
        anchorOf.set(i, j)
        break
      }
    }
  }

  // Pass 2 — backward attachment for page-load waits: nearest previous node
  // that is neither a wait nor a forward-anchored satellite (skipping over a
  // satellite cluster would mis-attach the wait to the LATER consumer row).
  for (let i = 0; i < order.length; i++) {
    if (blockIdOf(order[i]!) !== 'wait-connections' || anchorOf.has(i)) continue
    let j = i - 1
    while (j >= 0 && (blockIdOf(order[j]!) === 'wait-connections' || anchorOf.has(j))) j -= 1
    if (j >= 0) anchorOf.set(i, j)
  }

  /** Resolves through satellite anchors down to a primary index. */
  const resolve = (i: number): number | undefined => {
    let cursor = anchorOf.get(i)
    while (
      cursor !== undefined &&
      SATELLITE_BLOCKS.has(blockIdOf(order[cursor]!)) &&
      anchorOf.has(cursor)
    ) {
      cursor = anchorOf.get(cursor)
    }
    return cursor
  }

  /** satellite index → its row-anchor index (a primary). */
  const satelliteOwner = new Map<number, number>()
  for (let i = 0; i < order.length; i++) {
    if (!anchorOf.has(i)) continue
    const anchor = resolve(i)
    if (anchor !== undefined && anchor !== i) satelliteOwner.set(i, anchor)
  }
  /** anchor index → its satellite indices, in chain order. */
  const satellitesByAnchor = new Map<number, number[]>()
  for (const [satellite, anchor] of satelliteOwner) {
    const list = satellitesByAnchor.get(anchor) ?? []
    list.push(satellite)
    satellitesByAnchor.set(anchor, list)
  }

  const steps: ReviewStep[] = []
  for (let i = 0; i < order.length; i++) {
    // A satellite is rendered inside its anchor's row, never as its own.
    if (satelliteOwner.has(i)) continue
    const node = order[i]!
    const step: ReviewStep = {
      id: node.id,
      blockId: blockIdOf(node),
      description:
        typeof node.data?.['description'] === 'string' ? String(node.data['description']) : '',
      params: node.data ?? {},
      satelliteIds: [],
      satelliteSummary: [],
    }
    for (const satelliteIndex of satellitesByAnchor.get(i) ?? []) {
      const satellite = order[satelliteIndex]!
      step.satelliteIds.push(satellite.id)
      step.satelliteSummary.push(
        typeof satellite.data?.['description'] === 'string' && satellite.data['description']
          ? String(satellite.data['description'])
          : blockIdOf(satellite),
      )
    }
    steps.push(step)
  }
  return steps
}

/** Collision-resistant id (same shape as storage.newId, dependency-free). */
function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Rebuilds the workflow with every step whose `keep` is `false` removed —
 * primary plus satellites — and the surviving spine re-linked with the
 * handle convention of `workflowFromHistory`. Non-spine edges between
 * surviving nodes are preserved; the trigger is always kept. Idempotent: an
 * empty/all-true selection returns the workflow untouched.
 */
export function applyNodeKeepSelection(
  workflow: Workflow,
  keepStepIds: Record<string, boolean>,
): Workflow {
  const drop = new Set<string>()
  for (const step of reviewStepsOf(workflow)) {
    if (keepStepIds[step.id] === false) {
      drop.add(step.id)
      for (const satelliteId of step.satelliteIds) drop.add(satelliteId)
    }
  }
  if (drop.size === 0) return workflow

  const order = chainOrder(workflow.drawflow.nodes, workflow.drawflow.edges)
  const kept = order.filter((node) => !drop.has(node.id))
  const keptIds = new Set(kept.map((node) => node.id))

  // Re-link the spine: every consecutive kept pair gets one fresh edge with
  // the same block-keyed handles the generator (and the canvas) use.
  const spine = new Set<string>()
  const edges: WorkflowEdge[] = []
  for (let i = 0; i + 1 < kept.length; i++) {
    const source = kept[i]!
    const target = kept[i + 1]!
    const id = newId()
    spine.add(id)
    edges.push({
      id,
      source: source.id,
      target: target.id,
      sourceHandle: `${blockIdOf(source)}-output-1`,
      targetHandle: `${blockIdOf(target)}-input-1`,
    })
  }
  // Preserve any non-spine edge between two survivors (branch handles on an
  // edited graph); generated workflows simply have none.
  for (const edge of workflow.drawflow.edges) {
    if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue
    const duplicate = edges.some(
      (existing) => existing.source === edge.source && existing.target === edge.target,
    )
    if (duplicate) continue
    edges.push(edge)
  }

  // Re-pack the linear canvas so removals leave no gaps (the generator lays
  // the trigger at y=0 and every following node 140px apart).
  const packed = kept.map((node, index) =>
    isTriggerNode(node)
      ? node
      : { ...node, position: { x: 160, y: 80 + Math.max(0, index - 1) * 140 } },
  )

  return {
    ...workflow,
    drawflow: {
      ...workflow.drawflow,
      nodes: packed,
      edges,
    },
  }
}
