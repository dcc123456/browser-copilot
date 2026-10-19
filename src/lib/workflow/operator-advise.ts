/**
 * Editor AI operator assistant — pure vocabulary, prompt builder, reply reader
 * and the graph patch that lands the chosen operators on the canvas.
 *
 * The editor's floating `AI` chat lets the user say what the workflow should do
 * next ("我需要打开 https://www.baidu.com") and gets operators back. Following
 * the selection spec's Principle A (the model decides WHAT, the system decides
 * which implementation), the model never faces the whole catalog: it is offered
 * the deterministic discovery shortlist plus the core operators as a floor
 * ({@link adviseCandidates}), and only ids from that offer can land.
 *
 * Nothing here executes a node, reads a page or calls a model. The canvas stays
 * the single source of truth — the patch is pure and the editor owns it — which
 * is why this does not reuse the background agent loop and its session draft
 * (specs/2026-10-19-editor-operator-ai-chat-design.md §2). The side-effectful
 * request lives in `background/operator-advise-engine`.
 *
 * Everything in this module is pure (no `chrome`, no DOM, no network) so the
 * prompt/parser/patcher are unit-testable.
 *
 * @module lib/workflow/operator-advise
 */

import { capModelPayload } from '../extract'
import { stripThinkBlocks, unwrapFencedAnswer } from '../model-output'
import { OCR_SUPPORTED } from '../ocr-support'
import { isCloudBlock } from './blocks/cloud-blocks'
import { BLOCK_BY_ID } from './blocks/palette'
import type { BlockCatalogEntry } from './blocks/types'
import { schemaRequiredArgs, missingRequirements } from './block-requirements'
import { conditionPathsOf } from './condition-tree'
import { isFallbackHandle, loopBackEdgeIds } from './graph-edges'
import { NODE_INSERT_GAP, placeClearOfNodes, type SuggestionGraph } from './var-suggestions'
import { blockIdOf, producedVariableNames } from './producer-completeness'
import { sanitizeNodeData } from './node-fix'
import { withNodeAddedByAi } from './node-goal-contract'
import { findWorkflowOperators } from './operator-discovery'
import { generationOperators, operatorEntry } from './operator-registry'
import { dataSchemaFromEntry } from './operator-tools'
import type { WorkflowEdge, WorkflowNode } from './types'

/** How many operators one answer may hand back. */
export const OPERATOR_ADVISE_MAX_OPERATORS = 6

/** How many discovery hits ride along with the core operators. */
const DISCOVERY_LIMIT = 12

/** The one trigger a workflow may have is never an append target. */
const TRIGGER_BLOCK_ID = 'trigger'

/** One turn of the assistant's conversation. */
export interface OperatorAdviseMessage {
  role: 'user' | 'assistant'
  content: string
}

/** One operator the model is allowed to pick, with its parameter schema. */
export interface OperatorCandidate {
  blockId: string
  /** English catalog name (model-facing text, like the operator guide). */
  name: string
  description: string
  /** OpenAI-shaped parameter schema — the model's only view of the params. */
  schema: Record<string, unknown>
  /** Params the block cannot run without. */
  required: string[]
}

/** One operator the model asked for, with the parameters it filled in. */
export interface OperatorProposal {
  blockId: string
  data: Record<string, unknown>
  rationale: string
}

/** A read-back answer: what to tell the user, and what may land on the canvas. */
export interface OperatorAdviseReply {
  reply: string
  proposals: OperatorProposal[]
  /** Ids the model asked for that it was never offered, or that exceeded the cap. */
  rejected: string[]
}

/**
 * The assistant's answer as it travels back over the command channel. Declared
 * with the vocabulary it carries so `src/lib` stays free of `src/background`
 * (the engine returns this shape, the editor reads it).
 */
export interface OperatorAdviseResult {
  ok: boolean
  /** Why nothing came back, when it failed. */
  reason?: string
  /** What to show the user, in their language. */
  reply: string
  /** Operators the model asked for that this build can actually land. */
  proposals: OperatorProposal[]
  /** Ids it asked for that it was never offered, or that exceeded the cap. */
  rejected: string[]
}

/** Node ids exist before the patch runs, so the graph patch mints them. */
export interface OperatorChainOptions {
  /** Node to place the chain after — a canvas selection, or the end of the flow. */
  anchorNodeId?: string
  newId: () => string
}

/** Why a batch could not be placed at all. */
export type OperatorChainProblem = 'empty-graph' | 'unknown-anchor' | 'branch-anchor'

/** The accepted proposals, as the next canvas graph. */
export interface OperatorChainPatch {
  added: WorkflowNode[]
  /** The COMPLETE next edge list (splices included). */
  edges: WorkflowEdge[]
  /** Node the chain was placed after, when anything was placed. */
  anchorNodeId?: string
  problem?: OperatorChainProblem
  /** Catalog names of proposals that were not landed (unofferable id, cap, refusal). */
  skipped: string[]
  /** Nodes that landed but still lack required parameters. */
  missing: { blockId: string; name: string; keys: string[] }[]
  /** The anchor's continuation the chain borrowed, as it was before the splice. */
  splicedEdge?: OperatorSplicedEdge
}

/** One canvas edge, recorded at the moment a landed batch moved it. */
export interface OperatorSplicedEdge {
  id: string
  source: string
  sourceHandle?: string
}

/** Everything one landed batch owns, so undo can hand it all back. */
export interface OperatorBatch {
  nodeIds: string[]
  splicedEdge?: OperatorSplicedEdge
}

/**
 * Edges left after a batch is undone. The batch's own links go with its nodes —
 * and the continuation it borrowed has to go BACK to the anchor, or undoing an
 * inserted chain would silently cut the flow the user had already wired.
 */
export function edgesAfterBatchRemoved<
  E extends { id: string; source: string; target: string; sourceHandle?: string | null },
>(edges: readonly E[], batch: OperatorBatch): E[] {
  const owned = new Set(batch.nodeIds)
  const spliced = batch.splicedEdge
  const kept: E[] = []
  for (const edge of edges) {
    if (spliced && edge.id === spliced.id) {
      // The borrowed edge now starts on a batch node, but it is the user's own
      // wiring: hand it back to the anchor instead of dropping it with the rest.
      kept.push(
        Object.assign({}, edge, { source: spliced.source, sourceHandle: spliced.sourceHandle }),
      )
      continue
    }
    if (owned.has(edge.source) || owned.has(edge.target)) continue
    kept.push(edge)
  }
  return kept
}

/** The undo record for one landed batch: which nodes to drop, which edge to restore. */
export function operatorBatchOf(patch: OperatorChainPatch): OperatorBatch {
  return {
    nodeIds: patch.added.map((node) => node.id),
    ...(patch.splicedEdge ? { splicedEdge: patch.splicedEdge } : {}),
  }
}

/** Whether this block may be created by the assistant on the current build. */
function isAppendableBlock(id: string): boolean {
  if (id === TRIGGER_BLOCK_ID || isCloudBlock(id)) return false
  const entry = operatorEntry(id)
  if (!entry || !entry.allowGeneration || entry.aiExposure === 'hidden' || entry.cloud) return false
  const block = BLOCK_BY_ID.get(id)
  if (!block) return false
  return !(block.requiresOcr === true && !OCR_SUPPORTED)
}

function candidateOf(block: BlockCatalogEntry): OperatorCandidate {
  return {
    blockId: block.id,
    name: block.name,
    description: block.description,
    schema: dataSchemaFromEntry(block),
    required: schemaRequiredArgs(block.id),
  }
}

/**
 * The operator set offered to the model for this utterance: the deterministic
 * discovery shortlist, then every core operator as a floor, so a plain "打开某
 * 网站" never depends on the phrase tables alone. Ordered most-relevant first and
 * capped, because the whole offer is carried as JSON Schema in every request.
 */
export function adviseCandidates(stepIntent: string, workflowGoal?: string): OperatorCandidate[] {
  const { candidates } = findWorkflowOperators({
    stepIntent,
    ...(workflowGoal ? { workflowGoal } : {}),
    limit: DISCOVERY_LIMIT,
  })
  const offered: OperatorCandidate[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (seen.has(id) || !isAppendableBlock(id)) return
    const block = BLOCK_BY_ID.get(id)
    if (!block) return
    seen.add(id)
    offered.push(candidateOf(block))
  }
  for (const candidate of candidates) push(candidate.blockId)
  for (const entry of generationOperators('core')) push(entry.id)
  return offered
}

/** Inputs to the prompt builder. */
export interface OperatorAdvisePromptInput {
  /** The conversation so far, oldest first; the last row is what to answer. */
  history: OperatorAdviseMessage[]
  /** Text description of the current canvas, from {@link operatorDigestOf}. */
  graphDigest: string
  candidates: OperatorCandidate[]
  maxOperators?: number
}

/**
 * Builds the assistant prompt. English scaffolding (models follow it reliably);
 * `reply` is asked for in the user's own language because it is shown to them.
 */
export function buildOperatorAdvisePrompt(input: OperatorAdvisePromptInput): string {
  const maxOperators = input.maxOperators ?? OPERATOR_ADVISE_MAX_OPERATORS
  const lines: string[] = []
  lines.push(
    "You are the operator assistant inside a browser-automation Chrome extension's workflow editor.",
    'The user describes what the workflow should do next. Choose the operator(s) that implement it',
    'and fill in their parameters. The editor appends what you return to the canvas — you never run it.',
    '',
    '## The workflow already on the canvas (in order)',
    input.graphDigest.trim() === '' ? '(empty)' : input.graphDigest.trim(),
    '',
    '## Operators you may use — ONLY these ids',
    'Each operator lists its id, what it does, and the JSON Schema of its parameters.',
  )
  for (const candidate of input.candidates) {
    lines.push(
      `- ${candidate.blockId} — ${candidate.name}${candidate.description ? `: ${candidate.description}` : ''}`,
      `  params: ${capModelPayload(candidate.schema)}`,
    )
    if (candidate.required.length > 0) lines.push(`  required: ${candidate.required.join(', ')}`)
  }
  lines.push(
    '',
    '## Conversation',
    ...input.history.map((message) => `${message.role}: ${message.content}`),
    '',
    '## Rules',
    '- Return the operators in execution order. They are appended as ONE chain right after the step the user selected, or after the last step when nothing is selected.',
    '- Use only ids from the list above. Never invent an id; never return an operator the canvas already has unless the user asks for another one.',
    '- Fill every value the user stated (URLs, text, selectors) and omit the rest — the catalog default is applied for you.',
    '- Where a value should come from an earlier step, reference it as {{variableName}} using a name the digest shows that step produces.',
    '- Prefer stable locators (#id, [data-testid], [name]) over generated classes or nth-child chains.',
    `- At most ${maxOperators} operators. Return an empty "proposals" array when nothing on the list fits or the user is only asking a question — then "reply" must say why.`,
    '- "reply" is shown to the user, in the language they wrote in, and must match what you actually did.',
    '',
    '## Response format',
    'Respond with ONLY a JSON object — no markdown fence, no commentary:',
    '{"reply":"<one sentence for the user>","proposals":[{"blockId":"<id>","data":{ …parameters… },"rationale":"<why this operator>"}]}',
  )
  return lines.join('\n')
}

/**
 * Read the model's answer back. Nothing is trusted: ids outside the offer (and
 * rows past the cap) are dropped and reported, and every parameter object is
 * sanitized by the same gate AI Fix uses, which also strips the `__workflowAi`
 * namespace so the model cannot forge the provenance marker.
 */
export function parseOperatorAdviseReply(
  text: string,
  offeredBlockIds: readonly string[],
  maxOperators: number = OPERATOR_ADVISE_MAX_OPERATORS,
): OperatorAdviseReply | null {
  const cleaned = unwrapFencedAnswer(stripThinkBlocks(text))
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const allowed = new Set(offeredBlockIds)
  const proposals: OperatorProposal[] = []
  const rejected: string[] = []
  const rows = Array.isArray(parsed['proposals']) ? parsed['proposals'] : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const blockId = (row as Record<string, unknown>)['blockId']
    const data = (row as Record<string, unknown>)['data']
    if (typeof blockId !== 'string' || !allowed.has(blockId)) {
      rejected.push(typeof blockId === 'string' ? blockId : '(malformed row)')
      continue
    }
    const sanitized = sanitizeNodeData(data)
    if (!sanitized) {
      rejected.push(blockId)
      continue
    }
    const rationale = (row as Record<string, unknown>)['rationale']
    proposals.push({
      blockId,
      data: sanitized,
      rationale: typeof rationale === 'string' ? rationale.trim() : '',
    })
  }
  const kept = proposals.slice(0, maxOperators)
  if (proposals.length > kept.length) {
    rejected.push(...proposals.slice(maxOperators).map((proposal) => proposal.blockId))
  }
  const reply = typeof parsed['reply'] === 'string' ? parsed['reply'].trim() : ''
  return { reply, proposals: kept, rejected }
}

/** Parameters worth showing the model: scalars the user can read off the node. */
function scalarParamsOf(node: WorkflowNode): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.data)) {
    if (key === 'blockId' || key === 'description' || key.startsWith('__')) continue
    if (value === '' || value === null || value === undefined) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params[key] = value
    }
  }
  return params
}

/**
 * The canvas as text the model can reason about: step order, operator, filled
 * parameters, and the variable names each step publishes. This is what lets it
 * append in the right place and stop re-proposing an operator that is already there.
 * `selectedNodeId` is called out because the chain lands after that step.
 */
export function operatorDigestOf(graph: SuggestionGraph, selectedNodeId?: string): string {
  const ordered = chainOrderOf(graph)
  return ordered
    .map((node, index) => {
      const params = scalarParamsOf(node)
      const produced = producedVariableNames(node)
      const parts = [`${index + 1}. ${blockIdOf(node)}`]
      if (Object.keys(params).length > 0) parts.push(capModelPayload(params, 160))
      if (produced.length > 0) parts.push(`-> {{${produced.join(', ')}}}`)
      if (node.id === selectedNodeId)
        parts.push('<< selected: the new operators go after this step')
      return parts.join(' ')
    })
    .join('\n')
}

/** The output handle a node's normal continuation leaves from. */
function normalOutputHandleOf(node: WorkflowNode): string {
  const blockId = blockIdOf(node)
  // A conditions block's ports are named after its paths, so `output-1` may name
  // nothing — and React Flow drops an edge whose handle does not resolve,
  // silently (the connection just is not there).
  if (blockId === 'conditions') {
    const first = conditionPathsOf(node.data['paths'])[0]
    return `conditions-output-${first?.id ?? 1}`
  }
  return `${blockId}-output-1`
}

/** The handle a new node is fed through, or undefined when it draws no input port. */
function inputHandleOf(block: BlockCatalogEntry): string | undefined {
  return block.inputs > 0 ? `${block.id}-input-1` : undefined
}

/** The edges that carry the main line: neither an error fallback nor a loop-back. */
function normalOutgoing(graph: SuggestionGraph): Map<string, WorkflowEdge[]> {
  const loopBacks = loopBackEdgeIds(graph.edges)
  const outgoing = new Map<string, WorkflowEdge[]>()
  for (const edge of graph.edges) {
    if (isFallbackHandle(edge.sourceHandle) || loopBacks.has(edge.id)) continue
    const list = outgoing.get(edge.source)
    if (list) list.push(edge)
    else outgoing.set(edge.source, [edge])
  }
  return outgoing
}

/**
 * Steps grouped by how far they sit from the entry: breadth-first from every
 * node nothing feeds (the trigger, and any node the user dropped without wiring
 * it), following only the main-line edges.
 */
function levelsOf(graph: SuggestionGraph): WorkflowNode[][] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const outgoing = normalOutgoing(graph)
  const fed = new Set(graph.edges.map((edge) => edge.target))
  const levels: WorkflowNode[][] = []
  const seen = new Set<string>()
  let level = graph.nodes.filter((node) => !fed.has(node.id))
  if (level.length === 0 && graph.nodes.length > 0) level = [...graph.nodes]
  while (level.length > 0) {
    const current: WorkflowNode[] = []
    const next: WorkflowNode[] = []
    for (const node of level) {
      if (seen.has(node.id)) continue
      seen.add(node.id)
      current.push(node)
      for (const edge of outgoing.get(node.id) ?? []) {
        const child = byId.get(edge.target)
        if (child && !seen.has(child.id)) next.push(child)
      }
    }
    if (current.length === 0) break
    levels.push(current)
    level = next
  }
  return levels
}

/**
 * Nodes in control-flow order: the main line from the entry outwards, then
 * anything the walk could not reach, in the order the canvas holds it.
 */
export function chainOrderOf(graph: SuggestionGraph): WorkflowNode[] {
  const levels = levelsOf(graph)
  const ordered = levels.flat()
  const reached = new Set(ordered.map((node) => node.id))
  return [...ordered, ...graph.nodes.filter((node) => !reached.has(node.id))]
}

/**
 * The node new work should follow: a node of the deepest level, i.e. the end of
 * the main line. The deepest level is always a leaf with respect to the normal
 * edges — a continuation would sit one level further — so appending after it can
 * never cut in front of a step the user already wired. Ties keep the LAST node of
 * that level: the rightmost branch the flow reached most recently.
 */
export function tailNodeOf(graph: SuggestionGraph): WorkflowNode | undefined {
  const levels = levelsOf(graph)
  const deepest = levels[levels.length - 1]
  return deepest?.[deepest.length - 1]
}

/**
 * Land the assistant's operators on the canvas graph, as a pure patch.
 *
 * The chain is spliced, not stapled: when the anchor already continues to a next
 * step, that one edge moves to the end of the new chain, so the inserted steps run
 * in the middle of the flow where the user meant them. An anchor with SEVERAL
 * normal continuations is a branch point, and picking one of its branches to
 * rewrite would silently reroute a path the user did not choose — so the whole
 * batch is refused and the UI says so. Fallback ports are never touched (they are
 * the error path), and only the anchor's FIRST normal edge is taken over.
 *
 * Parameters are the model's, sanitized by AI Fix's gate; catalog defaults show
 * through whatever it did not author, exactly as a hand-dragged node would get
 * them. Nodes the current build cannot run (cloud, OCR-only in the lite build,
 * hidden operators) are skipped and named.
 */
export function appendOperatorChain(
  graph: SuggestionGraph,
  proposals: readonly OperatorProposal[],
  options: OperatorChainOptions,
): OperatorChainPatch {
  const empty = {
    added: [],
    edges: graph.edges.map((edge) => ({ ...edge })),
    skipped: [],
    missing: [],
  }
  if (proposals.length === 0) return empty

  const anchor = options.anchorNodeId
    ? graph.nodes.find((node) => node.id === options.anchorNodeId)
    : tailNodeOf(graph)
  if (!anchor) return { ...empty, problem: options.anchorNodeId ? 'unknown-anchor' : 'empty-graph' }

  const outgoing = normalOutgoing(graph).get(anchor.id) ?? []
  if (outgoing.length > 1) {
    return { ...empty, problem: 'branch-anchor', anchorNodeId: anchor.id }
  }

  const edges: WorkflowEdge[] = graph.edges.map((edge) => ({ ...edge }))
  const added: WorkflowNode[] = []
  const skipped: string[] = []
  const missing: OperatorChainPatch['missing'] = []
  const occupied = [...graph.nodes]
  const continuation = outgoing[0]
  let previous = anchor
  let previousHandle = continuation?.sourceHandle ?? normalOutputHandleOf(anchor)
  let splicedEdge: OperatorSplicedEdge | undefined

  for (const proposal of proposals) {
    const block = BLOCK_BY_ID.get(proposal.blockId)
    if (!block || !isAppendableBlock(block.id)) {
      skipped.push(block?.name ?? proposal.blockId)
      continue
    }
    const data = withNodeAddedByAi({
      ...structuredClone(block.data),
      description: '',
      ...proposal.data,
      blockId: block.id,
    })
    const node: WorkflowNode = {
      id: options.newId(),
      label: block.name,
      position: placeClearOfNodes(
        { x: previous.position.x + NODE_INSERT_GAP, y: previous.position.y },
        occupied,
      ),
      data,
    }
    occupied.push(node)
    added.push(node)
    edges.push({
      id: options.newId(),
      source: previous.id,
      sourceHandle: previousHandle,
      target: node.id,
      targetHandle: inputHandleOf(block),
    })
    const problems = missingRequirements(block.id, data)
    if (problems.length > 0) {
      missing.push({ blockId: block.id, name: block.name, keys: problems.map((p) => p.key) })
    }
    previous = node
    previousHandle = normalOutputHandleOf(node)
  }

  if (continuation && added.length > 0) {
    // The step the anchor used to continue to now continues from the END of the new
    // chain. Re-hanging it on the first node would branch the flow the user wired.
    const spliced = edges.findIndex((edge) => edge.id === continuation.id)
    if (spliced >= 0) {
      edges[spliced] = {
        ...(edges[spliced] as WorkflowEdge),
        source: previous.id,
        sourceHandle: previousHandle,
      }
      splicedEdge = {
        id: continuation.id,
        source: anchor.id,
        ...(continuation.sourceHandle === undefined
          ? {}
          : { sourceHandle: continuation.sourceHandle }),
      }
    }
  }

  return {
    added,
    edges,
    anchorNodeId: anchor.id,
    skipped,
    missing,
    ...(splicedEdge ? { splicedEdge } : {}),
  }
}
