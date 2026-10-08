/**
 * Self-heal write-back: what the replay learned goes back into the graph.
 *
 * A degraded step (see the kernel's `rank` policy in
 * `background/workflow-engine/executors`) means the locator the node was
 * AUTHORED with no longer identifies the element on its own, and a weaker
 * candidate had to take over. Without a write-back the next replay pays for
 * that again — the same ladder, the same lost margin, forever. This module
 * rotates the winning candidate into the node so the NEXT run starts from what
 * the page actually agrees with, and appends an audit record so the substitution
 * is never silent.
 *
 * Two rules keep it honest:
 *
 * - **It never removes a locator.** The displaced spec becomes the first
 *   fallback, so a page that drifts back (or a replay on a different page state)
 *   still has the original candidate to try. Improving a node cannot make it
 *   able to find fewer elements than before.
 * - **A node that keeps landing on the bottom rung is not "fixed".** Repeated
 *   rung-4 wins mean the graph is guessing; the workflow is reported
 *   un-verified instead of accumulating confidence it never earned.
 *
 * Pure: the input workflow is never mutated (the op clones), so a caller that
 * dislikes the result simply discards it.
 *
 * @module lib/workflow/self-heal
 */

import type { Target, TargetSpec } from '../ops'
import type { Workflow, WorkflowNode } from './types'
import { sameSpec, specFromSerialized } from './target-to-selector'

/**
 * One node's degradation report from a finished run: the `DegradeEvidence` the
 * kernel attached to its resolution, tagged with the node it happened on.
 */
export interface NodeDegradation {
  nodeId: string
  /** Ladder rung: 2 margin waived, 3 score floor waived, 4 first-visible guess. */
  rung: 2 | 3 | 4
  /** Serialized spec the node was authored with. */
  from: string
  /** Serialized spec that actually got acted on. */
  to: string
  /** Distinct elements the whole target matched. */
  matchCount: number
}

/** The audit record written to `node.data.__resolution` (latest wins). */
export interface NodeResolutionRecord {
  rung: 2 | 3 | 4
  from: string
  to: string
  matchCount: number
  at: number
  runId: string
}

export interface SelfHealResult {
  workflow: Workflow
  /** One human-readable line per node the write-back changed. */
  changes: string[]
  /**
   * True when some node has now landed on the bottom rung too many times — the
   * graph is guessing, so the caller must not report it as verified.
   */
  uncertify: boolean
}

/** Older audit records kept per node, newest first. */
const HISTORY_LIMIT = 5

/**
 * Bottom-rung (first-visible) wins after which the node stops counting as
 * self-healed. Three is a judgment call, not a measurement: two consecutive
 * guesses is drift, four is a broken graph, and three is where a workflow gets
 * to say "I'm not sure" out loud.
 */
const RUNG4_GIVEUP = 3

/** The flat-selector fields a node may use (see `sel()` in the executors). */
function flatSelector(data: Record<string, unknown>): string {
  return (
    (typeof data['selector'] === 'string' && data['selector']) ||
    (typeof data['cssSelector'] === 'string' && data['cssSelector']) ||
    ''
  )
}

/** Read the node's existing rich target, tolerant of anything stored there. */
function richTargetOf(data: Record<string, unknown>): Target | undefined {
  const raw = data['target']
  if (!raw || typeof raw !== 'object') return undefined
  const target = raw as Partial<Target>
  const primary = target.primary
  if (!primary || typeof primary !== 'object' || typeof primary.value !== 'string') {
    return undefined
  }
  return {
    primary,
    fallbacks: Array.isArray(target.fallbacks) ? target.fallbacks : [],
    ...(typeof target.frameHint === 'string' && target.frameHint
      ? { frameHint: target.frameHint }
      : {}),
    ...(typeof target.label === 'string' && target.label ? { label: target.label } : {}),
  }
}

/** The CSS a `css` spec can be promoted to in the flat `selector` field. */
function flatFormOf(spec: TargetSpec): string | undefined {
  if (spec.how !== 'css') return undefined
  // nth / tag qualifiers have no flat field to live in; an `xpath:` value
  // belongs to the xpath form of the selector field (`findBy: 'xpath'`).
  if (typeof spec.nth === 'number' || (spec.tag && spec.tag !== '')) return undefined
  return spec.value
}

function isXpathForm(value: string): boolean {
  return value.startsWith('xpath:')
}

/**
 * Reorder one node's locator so the candidate that won is the one tried first,
 * and record the substitution. Mutates the CLONED node only.
 */
function healNode(
  node: WorkflowNode,
  degradation: NodeDegradation,
  runId: string,
  at: number,
): { change?: string; rung4Count: number } {
  const data = node.data as Record<string, unknown>
  const winner = specFromSerialized(degradation.to)

  const previous = data['__resolution']
  const history: NodeResolutionRecord[] = Array.isArray(data['__resolutionHistory'])
    ? (data['__resolutionHistory'] as NodeResolutionRecord[])
    : []
  if (previous && typeof previous === 'object') history.unshift(previous as NodeResolutionRecord)
  const record: NodeResolutionRecord = {
    rung: degradation.rung,
    from: degradation.from,
    to: degradation.to,
    matchCount: degradation.matchCount,
    at,
    runId,
  }
  data['__resolution'] = record
  data['__resolutionHistory'] = history.slice(0, HISTORY_LIMIT - 1)

  const rung4Count = [record, ...history].filter((entry) => entry.rung === 4).length

  // An unparseable winner still gets the audit record — the ladder ran and lost,
  // which the graph should show — but we have nothing to rotate in, so the
  // locator stays exactly as it was.
  if (!winner) return { rung4Count }

  const rich = richTargetOf(data)
  const displaced: TargetSpec[] = []
  if (rich) {
    if (!sameSpec(rich.primary, winner)) displaced.push(rich.primary)
    for (const spec of rich.fallbacks) {
      if (!sameSpec(spec, winner) && !displaced.some((entry) => sameSpec(entry, spec))) {
        displaced.push(spec)
      }
    }
  }
  // The stale flat selector is a candidate like any other: it keeps its place
  // at the head of the chain instead of vanishing.
  const flat = flatSelector(data)
  if (flat) {
    const asSpec: TargetSpec = { how: 'css', value: isXpathForm(flat) ? flat : flat }
    if (!sameSpec(asSpec, winner) && !displaced.some((entry) => sameSpec(entry, asSpec))) {
      displaced.unshift(asSpec)
    }
  }

  data['target'] = {
    primary: winner,
    fallbacks: displaced.slice(0, 7),
    ...(rich?.frameHint ? { frameHint: rich.frameHint } : {}),
    ...(rich?.label ? { label: rich.label } : {}),
  } satisfies Target

  const flatWinner = flatFormOf(winner)
  if (flatWinner !== undefined) {
    if (isXpathForm(flatWinner)) {
      data['selector'] = flatWinner.slice('xpath:'.length)
      data['findBy'] = 'xpath'
    } else {
      data['selector'] = flatWinner
      // A node that was matching by xpath is now a plain CSS locator.
      if (data['findBy'] === 'xpath') data['findBy'] = 'cssSelector'
    }
    if (typeof data['cssSelector'] === 'string') data['cssSelector'] = flatWinner
  } else {
    // The winner is role/text/testid/nth — nothing the flat field can express.
    // Clearing it is what makes `targetFrom` use the rich target as the primary
    // instead of putting the dead selector back in front; the displaced spec
    // survives as the chain's first fallback.
    if (flat) {
      data['selector'] = ''
      if (typeof data['cssSelector'] === 'string') data['cssSelector'] = ''
      data['findBy'] = 'cssSelector'
    }
  }

  return {
    change: `定位自愈：「${node.label}」改用 ${degradation.to}（原 ${degradation.from}，第 ${degradation.rung} 级降级）`,
    rung4Count,
  }
}

/**
 * Apply a run's degradation reports to the workflow, returning the healed copy.
 *
 * Nodes are matched by id; a report for an unknown node (a sub-workflow's graph,
 * or one deleted since the run) is ignored rather than guessed at.
 */
export function applySelfHeal(
  workflow: Workflow,
  degradations: NodeDegradation[],
  options: { runId: string; at?: number },
): SelfHealResult {
  if (degradations.length === 0) {
    return { workflow, changes: [], uncertify: false }
  }
  const at = options.at ?? Date.now()
  // Reports for nodes the graph no longer has are dropped BEFORE the clone: a
  // run whose nodes were all deleted must hand back the caller's own object, so
  // `healed !== workflow` keeps meaning "something actually changed".
  const known = new Set(workflow.drawflow.nodes.map((n) => n.id))
  const applicable = degradations.filter((d) => known.has(d.nodeId))
  if (applicable.length === 0) return { workflow, changes: [], uncertify: false }
  const clone = structuredClone(workflow)
  const changes: string[] = []
  let uncertify = false
  for (const degradation of applicable) {
    const node = clone.drawflow.nodes.find((n) => n.id === degradation.nodeId)
    if (!node) continue
    const result = healNode(node, degradation, options.runId, at)
    if (result.change) changes.push(result.change)
    if (degradation.rung === 4 && result.rung4Count >= RUNG4_GIVEUP) uncertify = true
  }
  return { workflow: clone, changes, uncertify }
}

/** Read back the last self-heal record of a node, when it has one. */
export function lastResolutionOf(node: WorkflowNode): NodeResolutionRecord | undefined {
  const raw = (node.data as Record<string, unknown> | undefined)?.['__resolution']
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Partial<NodeResolutionRecord>
  if (record.rung !== 2 && record.rung !== 3 && record.rung !== 4) return undefined
  if (typeof record.to !== 'string' || typeof record.from !== 'string') return undefined
  return {
    rung: record.rung,
    from: record.from,
    to: record.to,
    matchCount: typeof record.matchCount === 'number' ? record.matchCount : 0,
    at: typeof record.at === 'number' ? record.at : 0,
    runId: typeof record.runId === 'string' ? record.runId : '',
  }
}
