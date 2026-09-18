/**
 * Folding a linearly recorded graph into loops.
 *
 * Workflow-generation mode records one node per real interaction, so a user who
 * clicks five "add to cart" buttons — or fills the five sibling inputs of a
 * form — produces five near-identical nodes. This module detects those runs and
 * rewrites them into a single loop block:
 *
 * - **identical run** → `repeat-task { repeatFor: N }`. The body repeats
 *   verbatim, so the rewrite cannot change what the run does.
 * - **varying run** → `loop-elements`, with the body's selector rewritten to
 *   `{{loopElementSelector}}` so each iteration acts on its own element. This
 *   depends on the engine publishing `loopElementSelector` AND on a single
 *   selector that really matches the recorded elements — hence
 *   {@link CollapseProbe}, and hence the fold is only ever applied after a
 *   successful page probe.
 *
 * Everything here is pure: the probe is injected, so the rules are unit-testable
 * without a browser.
 *
 * @module lib/workflow/loop-collapse
 */

import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

/** The block id of the loop block a fold introduces. */
const REPEAT_TASK = 'repeat-task'
const LOOP_ELEMENTS = 'loop-elements'

/** A loop block's body port (output-1) and after-loop port (output-2). */
const LOOP_PORT = 'output-1'
const END_PORT = 'output-2'

/** Minimum run length worth folding — two nodes are barely a loop. */
export const MIN_REPEAT_RUN = 2

/** One repeated run found in the recorded chain. */
export interface RepeatSuggestion {
  kind: 'identical' | 'varying'
  /** Node ids of the whole run, in chain order. */
  runIds: string[]
  /**
   * Node ids of ONE iteration — the part that survives as the loop body.
   * Always a prefix of {@link runIds}.
   */
  bodyIds: string[]
  /** How many back-to-back iterations the run contains. */
  repeat: number
  /** Block id shared by every node of the run. */
  blockId: string
  /**
   * `varying` only: the selector each iteration's first node targets, in order.
   * The container probe runs over exactly these.
   */
  selectors: string[]
  /** Why this run was reported, for the review card. */
  reason: string
}

/** The block id of a node, falling back to its label. */
function blockIdOf(node: WorkflowNode): string {
  const raw = node.data?.['blockId']
  return typeof raw === 'string' && raw ? raw : node.label
}

/** The CSS selector a node targets, whichever key its block uses. */
function selectorOf(node: WorkflowNode): string {
  const raw = node.data?.['selector'] ?? node.data?.['cssSelector']
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * A node's identity for repeat detection: two nodes with the same signature do
 * the same thing, so repeating them is a loop rather than a sequence.
 *
 * Deliberately coarse — it keys on the parts that change what the page sees
 * (block, target, value/type) and ignores presentation-only fields like
 * `description`, which the model writes differently for every call.
 */
export function nodeSignature(node: WorkflowNode): string {
  const data = node.data ?? {}
  const value = data['value'] ?? data['type'] ?? ''
  const checked = data['checked'] ?? ''
  return [blockIdOf(node), selectorOf(node), String(value), String(checked)].join('|')
}

/**
 * A node's shape: everything except the target and the value.
 *
 * Used to tell "the same action on different elements" (a foldable varying run)
 * from "genuinely different actions that happen to share a block" (not a run).
 * `type` belongs to the shape — a `forms` select and a `forms` text fill are
 * different actions even when they share every other field.
 */
function nodeShape(node: WorkflowNode): string {
  const data = node.data ?? {}
  const skip = new Set(['selector', 'cssSelector', 'value', 'description', 'blockId'])
  const keys = Object.keys(data)
    .filter((key) => !skip.has(key))
    .sort()
  return keys.map((key) => `${key}=${JSON.stringify(data[key])}`).join(',')
}

/**
 * The linear chain of action nodes, head first.
 *
 * The draft stores nodes in append order with the trigger as the head, so the
 * chain is simply that order with the trigger removed. Returns null when the
 * graph is not a simple chain (a branch means the run is not one straight
 * sequence and folding it would need real reachability analysis).
 */
function chainOf(graph: CollapsibleGraph): WorkflowNode[] | null {
  const nodes = graph.drawflow.nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, WorkflowEdge[]>()
  for (const edge of graph.drawflow.edges) {
    const list = outgoing.get(edge.source) ?? []
    list.push(edge)
    outgoing.set(edge.source, list)
  }

  const head = nodes.find((node) => blockIdOf(node) === 'trigger')
  const start = head
    ? (outgoing.get(head.id) ?? [])[0]?.target
    : nodes.find((node) => !graph.drawflow.edges.some((e) => e.target === node.id))?.id
  if (!start) return null

  const chain: WorkflowNode[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = start
  while (cursor) {
    if (seen.has(cursor)) return null
    seen.add(cursor)
    const node = byId.get(cursor)
    if (!node) return null
    chain.push(node)
    const next: WorkflowEdge[] = outgoing.get(cursor) ?? []
    // A fork (or a merge) is not a straight line: bail out rather than guess.
    if (next.length > 1) return null
    cursor = next[0]?.target
  }
  // Every node must be on the chain; an orphan means the graph is not linear.
  return chain.length === nodes.length - (head ? 1 : 0) ? chain : null
}

/**
 * Drop consecutive nodes that describe the SAME interaction.
 *
 * Event capture is chatty: one field fill arrives as a debounced input, an
 * Enter keydown and a blur flush, all describing the same selector + value.
 * `record-convert` already applies this rule when building a workflow from the
 * event log; the generation path appends nodes one call at a time and needs the
 * same guard, or the user gets three identical `forms` steps.
 *
 * Only same-selector-same-value `forms` nodes are collapsed (the rule
 * `record-convert` uses): two clicks on the same button are a real sequence,
 * not a capture artefact.
 */
export function collapseAdjacentDuplicates(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; removed: string[] } {
  const removed: string[] = []
  const keep: WorkflowNode[] = []
  let previous = ''
  for (const node of nodes) {
    const data = node.data ?? {}
    const type = data['type']
    const isFill = blockIdOf(node) === 'forms' && (type === 'text-field' || type === undefined)
    const signature = isFill ? `forms|${selectorOf(node)}|${String(data['value'] ?? '')}` : ''
    if (signature && signature === previous) {
      removed.push(node.id)
      continue
    }
    previous = signature
    keep.push(node)
  }
  if (removed.length === 0) return { nodes: [...nodes], edges: [...edges], removed }

  // Re-link around the dropped nodes: a dropped node's predecessor now points
  // at its successor, keeping the original handle on the incoming edge.
  const dropped = new Set(removed)
  const nextOf = new Map<string, string>()
  for (const edge of edges) nextOf.set(edge.source, edge.target)
  const successorOf = (id: string): string | undefined => {
    let cursor = nextOf.get(id)
    const guard = new Set<string>()
    while (cursor && dropped.has(cursor) && !guard.has(cursor)) {
      guard.add(cursor)
      cursor = nextOf.get(cursor)
    }
    return cursor
  }
  const nextEdges: WorkflowEdge[] = []
  for (const edge of edges) {
    if (dropped.has(edge.source)) continue
    if (!dropped.has(edge.target)) {
      nextEdges.push(edge)
      continue
    }
    const target = successorOf(edge.source)
    if (!target) continue
    nextEdges.push({
      ...edge,
      target,
      targetHandle: `${blockIdOf(nodeById(keep, target))}-input-1`,
    })
  }
  return { nodes: keep, edges: nextEdges, removed }
}

function nodeById(nodes: readonly WorkflowNode[], id: string): WorkflowNode {
  return (
    nodes.find((node) => node.id === id) ?? { id, label: '', position: { x: 0, y: 0 }, data: {} }
  )
}

/**
 * The part of a `Workflow` the detectors read. Narrowed so the review card can
 * ask about a draft, which is a graph without an id or settings yet.
 */
export interface CollapsibleGraph {
  drawflow: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
}

/**
 * Find the runs in a recorded chain that are worth folding into a loop.
 *
 * Reports at most one suggestion per maximal run. `identical` runs are always
 * reported (the rewrite cannot change behaviour); `varying` runs are reported
 * with the selectors the caller must probe before applying them — see
 * {@link applyLoopElementsFold}, which refuses to run without a verified
 * selector.
 */
export function detectRepeatRuns(graph: CollapsibleGraph): RepeatSuggestion[] {
  const chain = chainOf(graph)
  if (!chain) return []

  const suggestions: RepeatSuggestion[] = []
  let i = 0
  while (i < chain.length) {
    const node = chain[i]!
    const blockId = blockIdOf(node)
    // A run never starts on the trigger, and a run of loop blocks would nest
    // loops the engine would then re-enter for no reason.
    const foldable = blockId !== 'trigger' && blockId !== REPEAT_TASK && blockId !== LOOP_ELEMENTS
    if (!foldable) {
      i += 1
      continue
    }

    const signature = nodeSignature(node)
    let j = i + 1
    while (j < chain.length && nodeSignature(chain[j]!) === signature) j += 1
    const identical = j - i
    if (identical >= MIN_REPEAT_RUN) {
      suggestions.push({
        kind: 'identical',
        runIds: chain.slice(i, j).map((n) => n.id),
        bodyIds: [chain[i]!.id],
        repeat: identical,
        blockId,
        selectors: [selectorOf(chain[i]!)],
        reason: `${identical} 个完全相同的「${blockId}」步骤`,
      })
      i = j
      continue
    }

    // Not identical: a run of the same block with the same shape but different
    // targets is the "same action on each element" pattern a loop expresses.
    const shape = nodeShape(node)
    let k = i + 1
    while (
      k < chain.length &&
      blockIdOf(chain[k]!) === blockId &&
      nodeShape(chain[k]!) === shape &&
      selectorOf(chain[k]!) !== ''
    ) {
      k += 1
    }
    const varying = k - i
    const selectors = chain.slice(i, k).map((n) => selectorOf(n))
    // A fold is only offered when it can actually be applied: every iteration
    // must target a DIFFERENT element (otherwise the difference is the value,
    // which `loop-elements` cannot iterate). Whether one selector really
    // describes all of them is a question only the page can answer, so the
    // caller probes before applying.
    const distinct = new Set(selectors).size === selectors.length
    if (varying >= MIN_REPEAT_RUN && selectorOf(node) !== '' && distinct) {
      suggestions.push({
        kind: 'varying',
        runIds: chain.slice(i, k).map((n) => n.id),
        bodyIds: [chain[i]!.id],
        repeat: varying,
        blockId,
        selectors,
        reason: `${varying} 个「${blockId}」步骤作用于不同元素，可折叠为元素循环`,
      })
      i = k
      continue
    }
    i += 1
  }
  return suggestions
}

/**
 * The page-side question a `varying` fold depends on.
 *
 * `loop-elements`'s `selector` param is the selector whose MATCHES are iterated
 * (`countElements(selector)`, then `elementSelectorAt(selector, i)` per round) —
 * not a container. So the fold needs ONE selector that matches exactly the
 * elements the recorded run acted on, in the recorded order.
 *
 * Deriving that from the recorded per-element selectors is a guess (they are
 * often `#input-1` / `#input-2`, which no single selector describes), so the
 * answer must be VERIFIED against the live page: the candidate has to match
 * those elements and nothing else. Returns null when no such selector can be
 * confirmed — the fold is then refused, because a loop that iterates the wrong
 * set of elements is worse than an unfolded graph.
 */
export interface CollapseProbe {
  deriveLoopSelector(selectors: readonly string[], signal: AbortSignal): Promise<string | null>
}

/**
 * Rewrite one node's selector to target the current loop element.
 *
 * The recorded selector already points at the element the action was performed
 * on, and the loop iterates exactly those elements — so the body needs the loop
 * element and nothing else. No relative path is involved.
 */
function rewriteToLoopElement(node: WorkflowNode): WorkflowNode {
  const data: Record<string, unknown> = { ...node.data, selector: '{{loopElementSelector}}' }
  // The rich locator (if any) belongs to the ORIGINAL element; keeping it as a
  // fallback would silently re-target that element on every iteration.
  delete data['target']
  delete data['cssSelector']
  return { ...node, data }
}

/** A fresh loop node, positioned near the run it replaces. */
function loopNode(blockId: string, run: WorkflowNode, data: Record<string, unknown>): WorkflowNode {
  return {
    id: `${blockId}-${Math.random().toString(36).slice(2, 10)}`,
    label: blockId,
    position: { x: run.position.x, y: run.position.y },
    data: { blockId, description: '', ...data },
  }
}

/**
 * Rewrite a run into a loop: the loop node takes the run's place in the chain,
 * one iteration survives as its body, and the remaining iterations are removed.
 *
 * Handle wiring follows the engine's loop contract — `output-1` is the body
 * port and `output-2` the after-loop port, and the body's LAST node points back
 * at the loop node so one pass around the cycle is one iteration.
 */
function foldRun(workflow: Workflow, suggestion: RepeatSuggestion, loop: WorkflowNode): Workflow {
  const bodyIds = new Set(suggestion.bodyIds)
  const runIds = new Set(suggestion.runIds)
  const dropped = new Set(suggestion.runIds.filter((id) => !bodyIds.has(id)))

  const nodes = workflow.drawflow.nodes.filter((node) => !dropped.has(node.id))
  const bodyNodes = nodes.filter((node) => bodyIds.has(node.id))
  const bodyHead = bodyNodes[0]
  const bodyTail = bodyNodes[bodyNodes.length - 1]
  if (!bodyHead || !bodyTail) return workflow

  const predecessor = workflow.drawflow.edges.find(
    (edge) => !runIds.has(edge.source) && edge.target === suggestion.runIds[0],
  )
  const successor = workflow.drawflow.edges.find(
    (edge) => edge.source === suggestion.runIds[suggestion.runIds.length - 1],
  )

  const edges = workflow.drawflow.edges.filter((edge) => {
    // Internal body edges stay; everything touching a dropped node goes, and
    // so does the predecessor's edge into the run (the loop node replaces it).
    if (dropped.has(edge.source) || dropped.has(edge.target)) return false
    if (predecessor && edge.id === predecessor.id) return false
    return true
  })

  const blockOf = (id: string): string => {
    const node = workflow.drawflow.nodes.find((n) => n.id === id)
    return node ? blockIdOf(node) : ''
  }

  if (predecessor) {
    edges.push({ ...predecessor, target: loop.id, targetHandle: `${loop.label}-input-1` })
  }
  edges.push({
    id: `${loop.id}-body`,
    source: loop.id,
    target: bodyHead.id,
    sourceHandle: `${loop.label}-${LOOP_PORT}`,
    targetHandle: `${blockIdOf(bodyHead)}-input-1`,
  })
  edges.push({
    id: `${bodyTail.id}-loop`,
    source: bodyTail.id,
    target: loop.id,
    sourceHandle: `${blockIdOf(bodyTail)}-${LOOP_PORT}`,
    targetHandle: `${loop.label}-input-1`,
  })
  if (successor) {
    edges.push({
      id: `${loop.id}-end`,
      source: loop.id,
      target: successor.target,
      sourceHandle: `${loop.label}-${END_PORT}`,
      targetHandle: successor.targetHandle ?? `${blockOf(successor.target)}-input-1`,
    })
  }

  // Put the loop where the run started, so the node array stays in flow order
  // (the editor lays nodes out in array order).
  const at = nodes.findIndex((node) => node.id === suggestion.runIds[0])
  const ordered = at < 0 ? [...nodes, loop] : [...nodes.slice(0, at), loop, ...nodes.slice(at)]
  return { ...workflow, drawflow: { nodes: ordered, edges } }
}

/**
 * Fold an identical run into `repeat-task { repeatFor: N }`.
 *
 * The engine repeats the body verbatim, so the rewrite preserves behaviour
 * exactly — no page knowledge is needed and no probe applies.
 */
export function applyRepeatTaskFold(workflow: Workflow, suggestion: RepeatSuggestion): Workflow {
  if (suggestion.kind !== 'identical') return workflow
  const run = suggestion.runIds
    .map((id) => workflow.drawflow.nodes.find((node) => node.id === id))
    .filter((node): node is WorkflowNode => node !== undefined)
  if (run.length !== suggestion.runIds.length || run.length === 0) return workflow
  const loop = loopNode(REPEAT_TASK, run[0]!, {
    repeatFor: suggestion.repeat,
    // Say where the count came from: a bare "5" in the editor is unreadable.
    description: `重复 ${suggestion.repeat} 次（折叠自录制的连续步骤）`,
  })
  return foldRun(workflow, suggestion, loop)
}

/**
 * Fold a varying run into `loop-elements`.
 *
 * Refuses (returns the workflow unchanged) unless a loop selector is supplied:
 * it must come from a page-verified probe, because the whole fold rests on that
 * one selector matching the recorded elements and nothing else.
 */
export function applyLoopElementsFold(
  workflow: Workflow,
  suggestion: RepeatSuggestion,
  loopSelector: string | null,
): Workflow {
  if (suggestion.kind !== 'varying') return workflow
  const selector = (loopSelector ?? '').trim()
  if (!selector) return workflow

  const body = suggestion.bodyIds
    .map((id) => workflow.drawflow.nodes.find((node) => node.id === id))
    .filter((node): node is WorkflowNode => node !== undefined)
  if (body.length === 0) return workflow
  const head = rewriteToLoopElement(body[0]!)

  const loop = loopNode(LOOP_ELEMENTS, body[0]!, {
    selector,
    description: `遍历「${selector}」匹配的元素（折叠自 ${suggestion.repeat} 个录制步骤）`,
  })
  const folded = foldRun(workflow, suggestion, loop)
  return {
    ...folded,
    drawflow: {
      ...folded.drawflow,
      nodes: folded.drawflow.nodes.map((node) => (node.id === head.id ? head : node)),
    },
  }
}
