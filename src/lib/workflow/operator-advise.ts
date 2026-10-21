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
import { BLOCK_BY_ID } from './blocks/palette'
import type { BlockCatalogEntry } from './blocks/types'
import {
  errorFallbackDrawn,
  fallbackHandleOf,
  inputHandleOf,
  normalOutputHandleOf,
  outputPortLabelsOf,
  outputPortsOf,
  type BlockPortSource,
} from './block-ports'
import { blockTakesElement, schemaRequiredArgs, missingRequirements } from './block-requirements'
import { isSecretKey, MASK, redactText } from './execution-evidence'
import { isFallbackHandle, loopBackEdgeIds } from './graph-edges'
import { NODE_INSERT_GAP, placeClearOfNodes, type SuggestionGraph } from './var-suggestions'
import { blockIdOf, producedVariableNames } from './producer-completeness'
import { TRIGGER_BLOCK_ID } from './draft-types'
import { sanitizeNodeData } from './node-fix'
import {
  nodeGoalContractOf,
  withNodeAddedByAi,
  withNodeGoalContract,
  WORKFLOW_AI_NAMESPACE,
} from './node-goal-contract'
import { findWorkflowOperators } from './operator-discovery'
import { JAVASCRIPT_BLOCK_ID, operatorExecClass } from './operator-class'
import { aiLandingAllowed, generationOperators } from './operator-registry'
import { dataSchemaFromEntry } from './operator-tools'
import { PROTECTED_PARAMS } from './repair/patch-policy'
import type { WorkflowEdge, WorkflowNode } from './types'

/** How many operators one answer may hand back. */
export const OPERATOR_ADVISE_MAX_OPERATORS = 6

/** How many discovery hits ride along with the core operators. */
const DISCOVERY_LIMIT = 12

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

/**
 * What the assistant wants done with its proposals: added to the flow after the
 * selected step (or the end of it), wired in FRONT of the selected step, or
 * applied to that step in place. The target of `prepend`/`edit`/`replace` is
 * always the editor's own selection — the model never names a node.
 */
export type OperatorAction = 'append' | 'prepend' | 'edit' | 'replace'

/** The half of {@link OperatorAction} that changes one node in place. */
export type OperatorNodeAction = Extract<OperatorAction, 'edit' | 'replace'>

/** The half that splices a new chain into the flow. */
export type OperatorChainAction = Extract<OperatorAction, 'append' | 'prepend'>

/** Whether an answer wants a chain placed (and the target is an ANCHOR to splice
 *  next to) or a node changed in place (and the target is the step itself). */
export function isOperatorChainAction(action: OperatorAction): action is OperatorChainAction {
  return action === 'append' || action === 'prepend'
}

/** A read-back answer: what to tell the user, and what may land on the canvas. */
export interface OperatorAdviseReply {
  reply: string
  /** `append` when the model did not say otherwise. */
  action: OperatorAction
  proposals: OperatorProposal[]
  /** Ids the model asked for that it was never offered, or that exceeded the cap. */
  rejected: string[]
}

/**
 * The page the assistant was allowed to look at. Read-only grounding: knowing
 * which page the parameters came from is what makes a filled-in selector
 * checkable by the user.
 */
export interface OperatorPageRef {
  url: string
  title: string
}

/** A read-only page snapshot reduced to what the assistant may use: the
 *  interactive elements (each with its stable `loc` hint) and the forms with
 *  their field labels and option lists. Body prose is never sent. */
export interface OperatorPageRead extends OperatorPageRef {
  elements: readonly unknown[]
  forms: readonly unknown[]
}

/**
 * An element the user pointed at by hand with the page picker, plus the locator
 * the picker built for it. The strongest grounding the assistant can get: a
 * machine read only guesses which element the user meant, this is the user
 * answering that question. `findBy` rides along because the picker may have been
 * switched to XPath.
 */
export interface PickedElement {
  selector: string
  findBy: 'cssSelector' | 'xpath'
}

/**
 * One of the two model references the screenshot route is decided from. Only the
 * user knows whether a model reads images, so the judgement is made from what
 * they configured, never from a capability probe.
 */
export interface OperatorModelRef {
  providerId: string
  model: string
}

/**
 * Where an automatic screenshot goes: into the assistant's own call as an image
 * (`inline`), or through the configured image model, whose read of it becomes
 * text in the assistant's prompt (`described`).
 */
export type OperatorScreenshotRoute = 'inline' | 'described'

/**
 * `inline` costs one call and needs the chat model to see images; `described`
 * costs two and works with any image model the user picked. A screenshot may
 * only ride the chat call when the image target resolves to that very call's
 * provider and model — which, since `resolveVisionTarget` falls back to the
 * active provider whenever no image provider is picked, is also the case when
 * the user has configured nothing.
 */
export function operatorScreenshotRoute(
  active: OperatorModelRef | undefined,
  imageModel: OperatorModelRef | undefined,
): OperatorScreenshotRoute {
  const providerId = imageModel?.providerId.trim() ?? ''
  if (!providerId) return 'inline'
  const model = imageModel?.model.trim() ?? ''
  if (!active || providerId !== active.providerId.trim()) return 'described'
  return model === '' || model === active.model.trim() ? 'inline' : 'described'
}

/** How much of the image model's read reaches the assistant prompt. */
export const OPERATOR_SCREENSHOT_NOTE_CAP = 1200

/**
 * What to ask the image model for. It is asked for the screen, not for text:
 * the transcription ban is on the record because a screenshot cannot be scrubbed
 * before it leaves the machine, and whatever it shows goes to the provider.
 */
export const OPERATOR_SCREENSHOT_QUESTION =
  'Describe this screenshot of the page the user is working on: the layout, every visible ' +
  'control (buttons, fields, dropdowns, menus) with its label, the option text of any open ' +
  'list, and the current state — what is open, selected, disabled, loading or showing an ' +
  'error. Do NOT transcribe anything that looks like a password, security token, cookie, ' +
  'phone number, ID number or card number; describe such a field instead of copying its ' +
  'contents.'

/** What the assistant did with a screenshot, so the user can see that screen
 *  pixels left the machine — or that it tried and could not. */
export interface OperatorScreenshotReport {
  route: OperatorScreenshotRoute
  /** False when nothing was captured; the answer is then the one from the page read. */
  taken: boolean
  /** Why the screenshot was not used, when it was not. */
  error?: string
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
  /** Where the proposals belong; absent (or `append`) means add them to the flow. */
  action?: OperatorAction
  /** Operators the model asked for that this build can actually land. */
  proposals: OperatorProposal[]
  /** Ids it asked for that it was never offered, or that exceeded the cap. */
  rejected: string[]
  /** The page the parameters were grounded in; `null` when none could be read. */
  page?: OperatorPageRef | null
  /** Set only when a step still lacked a page parameter and a screenshot was
   *  tried for it — the user must be told the screen went out. */
  screenshot?: OperatorScreenshotReport
}

/** One landed node that still lacks parameters its operator cannot run without. */
export interface OperatorMissingParams {
  blockId: string
  name: string
  keys: string[]
}

/** One step to perform on the page: the operator and the parameters to try.
 *  Declared here because the command channel carries it, and `src/lib` must not
 *  reach into `src/background` (§5.7). */
export interface OperatorObserveStep {
  blockId: string
  data: Record<string, unknown>
}

/**
 * One step the assistant performed on the page to learn its real parameters, as
 * it travels back to the editor. `data` is what to LAND: the observed parameters
 * when the step ran, the model's guess untouched when it did not — so a partially
 * failed observation degrades to the ungrounded batch rather than to nothing.
 */
export interface OperatorObservedStep {
  blockId: string
  name: string
  /** The page really ran this step. */
  ran: boolean
  data: Record<string, unknown>
  /** What the page reported: how many elements matched, the locator that resolved,
   *  the option it chose (including the site's own "Available: …" list). */
  report: string[]
  /** Why it did not run — refused, or the action failed. */
  error?: string
}

/** The observation's answer: one row per step, plus what was refused outright. */
export interface OperatorObserveResult {
  ok: boolean
  /** Why the whole observation did not happen, when it failed. */
  reason?: string
  steps: OperatorObservedStep[]
  /** Operators the assistant will not act with, named for the confirm row. */
  refused: string[]
}

/** Why an in-place answer could not be applied to the step the user selected. */
export type OperatorTargetProblem =
  | 'unknown-target'
  | 'no-proposal'
  | 'many-proposals'
  | 'edit-other-block'
  | 'replace-same-block'
  | 'replace-unofferable'
  | 'replace-entry-point'

/** One node and every edge that touched it — the undo record for an in-place
 *  change, so undoing it hands back exactly what was there. */
export interface OperatorNodeSnapshot {
  node: WorkflowNode
  edges: WorkflowEdge[]
}

/** An output port the new block does not draw, whose edge therefore had to go. */
export interface OperatorPrunedPort {
  handle: string
  /** The label the port carried on the canvas (`exists`, a path name, …). */
  label: string
}

/** The result of applying an `edit`/`replace` answer to the selected node. */
export interface OperatorNodePatch {
  /** The COMPLETE next node list. */
  nodes: WorkflowNode[]
  /** The COMPLETE next edge list (re-anchored, pruned). */
  edges: WorkflowEdge[]
  problem?: OperatorTargetProblem
  /** Ports the change dropped, named — React Flow would only have hidden them. */
  pruned: OperatorPrunedPort[]
  missing: OperatorMissingParams[]
  /** The target as it was, for undo. */
  before?: OperatorNodeSnapshot
}

/** Which required parameters this node data still lacks, in the shape both the
 *  append chain and the in-place patch report. */
function missingParameterProblems(
  blockId: string,
  data: Record<string, unknown>,
): OperatorMissingParams[] {
  const problems = missingRequirements(blockId, data)
  if (problems.length === 0) return []
  return [{ blockId, name: operatorBlockName(blockId), keys: problems.map((p) => p.key) }]
}

/** A refused in-place answer: the canvas exactly as it was. */
function unchangedNodePatch(
  graph: SuggestionGraph,
  problem: OperatorTargetProblem,
): OperatorNodePatch {
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    problem,
    pruned: [],
    missing: [],
  }
}

/** Every edge that touches `nodeId`, deep-copied for the undo snapshot. Shared
 *  with the editor's own pre-fix capture so both record a step the same way. */
export function incidentEdgeSnapshot(
  edges: readonly WorkflowEdge[],
  nodeId: string,
): WorkflowEdge[] {
  return structuredClone(edges.filter((edge) => edge.source === nodeId || edge.target === nodeId))
}

/**
 * Apply an `edit`/`replace` answer to the node the user has selected, as a pure
 * patch. The target is the editor's own selection — an id from the model could
 * only ever be `unknown-target` here, which is the point: the assistant cannot
 * reach a step the user did not point at.
 */
export function applyOperatorAction(
  graph: SuggestionGraph,
  nodeId: string,
  action: OperatorNodeAction,
  proposals: readonly OperatorProposal[],
): OperatorNodePatch {
  const target = graph.nodes.find((node) => node.id === nodeId)
  if (!target) return unchangedNodePatch(graph, 'unknown-target')
  const proposal = proposals[0]
  if (proposals.length === 0) return unchangedNodePatch(graph, 'no-proposal')
  if (proposals.length > 1) return unchangedNodePatch(graph, 'many-proposals')
  return action === 'edit'
    ? editNodeParams(graph, target, proposal!)
    : replaceNodeOperator(graph, target, proposal!)
}

/**
 * Change one node's parameters in place. Values are MERGED over what the node
 * holds, deliberately unlike AI Fix's complete re-authoring: a chat edit is one
 * thing ("把 url 改成 x"), and re-writing every key from that one line would drop
 * parameters the model was never asked about.
 */
function editNodeParams(
  graph: SuggestionGraph,
  target: WorkflowNode,
  proposal: OperatorProposal,
): OperatorNodePatch {
  const blockId = blockIdOf(target)
  if (proposal.blockId !== blockId) return unchangedNodePatch(graph, 'edit-other-block')
  const data = { ...target.data, ...proposal.data, blockId }
  const node: WorkflowNode = { ...structuredClone(target), data }
  return {
    nodes: graph.nodes.map((candidate) => (candidate.id === target.id ? node : { ...candidate })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    pruned: [],
    missing: missingParameterProblems(blockId, data),
    before: { node: structuredClone(target), edges: incidentEdgeSnapshot(graph.edges, target.id) },
  }
}

/**
 * Swap one node for a different operator, keeping its identity on the canvas:
 * same id, same place, same incoming and outgoing wiring where the new block has
 * a port for it.
 *
 * Handles are named after the block id, and React Flow DROPS an edge whose
 * `sourceHandle`/`targetHandle` matches no rendered `<Handle>` — silently. So a
 * swap must re-hang every incident edge on the new block's port naming, and the
 * branches the new block cannot host (a second conditions path, a fallback onto
 * a block that does not route errors, an input onto a block with no input port)
 * are cut and NAMED in the result, never left to disappear.
 */
function replaceNodeOperator(
  graph: SuggestionGraph,
  target: WorkflowNode,
  proposal: OperatorProposal,
): OperatorNodePatch {
  const oldBlockId = blockIdOf(target)
  const newBlock = BLOCK_BY_ID.get(proposal.blockId)
  if (proposal.blockId === oldBlockId) return unchangedNodePatch(graph, 'replace-same-block')
  if (!newBlock || !aiLandingAllowed(newBlock.id)) {
    return unchangedNodePatch(graph, 'replace-unofferable')
  }
  if (oldBlockId === TRIGGER_BLOCK_ID) return unchangedNodePatch(graph, 'replace-entry-point')

  // Catalog defaults, then the values this node already holds, then what the
  // model said. A parameter moves only under the same key — the alternative is
  // guessing which of the old node's fields mean something to the new operator.
  // The node's own policy (error routing, disabled) is not a parameter: it
  // follows the swap even though the new block's template never mentions it,
  // because it describes the NODE's place in the flow.
  const carried = structuredClone(newBlock.data) as Record<string, unknown>
  for (const [key, value] of Object.entries(target.data)) {
    if (key === 'blockId' || key === WORKFLOW_AI_NAMESPACE) continue
    if (key in carried || PROTECTED_PARAMS.has(key)) carried[key] = value
  }
  const data = { ...carried, ...proposal.data, blockId: newBlock.id }
  // The goal contract rides the swap for the same reason the policy does: the goal
  // and its success criteria describe what the STEP must achieve, and every one of
  // them is a check on the page or on a variable, not on this operator. Dropping it
  // would let a swap delete the user's own target — and quietly un-certify the run.
  // The namespace's `addedBy` provenance deliberately does NOT ride along.
  const goal = nodeGoalContractOf(target.data)
  const nextData = goal ? withNodeGoalContract(data, goal) : data

  const ports = outputPortsOf(newBlock, nextData)
  const inputHandle = inputHandleOf(newBlock)
  const oldPorts = portSourceOf(oldBlockId)
  const oldPrimary = normalOutputHandleOf(oldPorts, target.data)
  const labels = outputPortLabelsOf(oldPorts, target.data)
  const pruned: OperatorPrunedPort[] = []
  const edges: WorkflowEdge[] = []
  for (const edge of graph.edges) {
    if (edge.source === target.id) {
      const handle = edge.sourceHandle ?? oldPrimary
      if (isFallbackHandle(handle)) {
        if (!errorFallbackDrawn(nextData)) {
          pruned.push({ handle, label: labels.get(handle) ?? handle })
          continue
        }
        edges.push({ ...edge, sourceHandle: fallbackHandleOf(newBlock.id) })
        continue
      }
      // Only the block's own continuation carries over: a second branch of a
      // multi-port block has no equivalent on the new block to hang on.
      if (handle === oldPrimary) edges.push({ ...edge, sourceHandle: ports.primary })
      else pruned.push({ handle, label: labels.get(handle) ?? handle })
      continue
    }
    if (edge.target === target.id) {
      if (!inputHandle) {
        pruned.push({ handle: edge.targetHandle ?? `${oldBlockId}-input-1`, label: 'input' })
        continue
      }
      edges.push({ ...edge, targetHandle: inputHandle })
      continue
    }
    edges.push({ ...edge })
  }

  const node: WorkflowNode = { ...structuredClone(target), label: newBlock.name, data: nextData }
  return {
    nodes: graph.nodes.map((candidate) => (candidate.id === target.id ? node : { ...candidate })),
    edges,
    pruned,
    missing: missingParameterProblems(newBlock.id, nextData),
    before: { node: structuredClone(target), edges: incidentEdgeSnapshot(graph.edges, target.id) },
  }
}
export interface OperatorChainOptions {
  /** Node to place the chain after (or in front of) — a canvas selection, or the end of the flow. */
  anchorNodeId?: string
  newId: () => string
}

/** Why a batch could not be placed at all. */
export type OperatorChainProblem =
  | 'empty-graph'
  | 'unknown-anchor'
  | 'branch-anchor'
  /** The entry point: nothing runs before the trigger. */
  | 'prepend-entry-point'
  /** An unwired node has no step in front of it. */
  | 'prepend-no-incoming'
  /** Several paths arrive at the anchor: which one to cut into is the user's. */
  | 'join-anchor'

/** The accepted proposals, as the next canvas graph. */
export interface OperatorChainPatch {
  added: WorkflowNode[]
  /** The COMPLETE next edge list (splices included). */
  edges: WorkflowEdge[]
  /** Node the chain was spliced at (after, or in front of), when anything was placed. */
  anchorNodeId?: string
  problem?: OperatorChainProblem
  /** Catalog names of proposals that were not landed (unofferable id, cap, refusal). */
  skipped: string[]
  /** Nodes that landed but still lack required parameters. */
  missing: OperatorMissingParams[]
  /** The one flow edge the splice moved — the anchor's continuation when the chain
   *  went after it, the step that fed the anchor when it went in front — recorded as
   *  it was before, so undo can put it back. */
  splicedEdge?: OperatorSplicedEdge
}

/** One canvas edge, recorded at the moment a landed batch moved it. Both ends are
 *  held: inserting AFTER a step moves the edge's source, inserting BEFORE it
 *  moves its target, and undo has to put back whichever one was taken. */
export interface OperatorSplicedEdge {
  id: string
  source: string
  sourceHandle?: string
  target: string
  targetHandle?: string
}

/** Everything one landed batch owns, so undo can hand it all back. */
export interface OperatorBatch {
  nodeIds: string[]
  splicedEdge?: OperatorSplicedEdge
}

/**
 * Edges left after a batch is undone. The batch's own links go with its nodes —
 * and the edge it borrowed has to go BACK to the step it was taken from, or
 * undoing an inserted chain would silently cut the flow the user had already
 * wired. Both ends are restored, because inserting in front of a step moves the
 * target of the borrowed edge rather than its source.
 */
export function edgesAfterBatchRemoved<
  E extends {
    id: string
    source: string
    target: string
    sourceHandle?: string | null
    targetHandle?: string | null
  },
>(edges: readonly E[], batch: OperatorBatch): E[] {
  const owned = new Set(batch.nodeIds)
  const spliced = batch.splicedEdge
  const kept: E[] = []
  for (const edge of edges) {
    if (spliced && edge.id === spliced.id) {
      // The borrowed edge now touches a batch node, but it is the user's own
      // wiring: hand it back instead of dropping it with the rest.
      kept.push(
        Object.assign({}, edge, {
          source: spliced.source,
          sourceHandle: spliced.sourceHandle,
          target: spliced.target,
          targetHandle: spliced.targetHandle,
        }),
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

/** The name the canvas shows for an operator id. */
export function operatorBlockName(blockId: string): string {
  return BLOCK_BY_ID.get(blockId)?.name ?? blockId
}

/**
 * What one assistant turn must never do to the browser, even though the operator
 * can run: grant cookie or access permissions, open or destroy a window, take a
 * file handle, or claim a download. `javascript-code` is deliberately NOT listed —
 * it has its own gate, and an assistant that is picking operators has never
 * earned the escape hatch.
 */
const NEVER_OBSERVED_BLOCK_IDS: ReadonlySet<string> = new Set([
  'cookie',
  'new-window',
  'close-tab',
  'upload-file',
  'handle-download',
])

/**
 * Can the assistant perform this operator ONCE on the page to learn its real
 * parameters? Three filters, in order: the block must be one the canvas could land
 * anyway, it must actually run against the page (a record-only block has no page
 * behaviour to observe), and it must not be one of the browser-state operators
 * above. This is a confirmation-gated path: the user is asked before anything runs,
 * and the row says that acting on the page is not undone by undoing the step.
 */
export function isObservableBlock(blockId: string): boolean {
  if (!aiLandingAllowed(blockId)) return false
  if (blockId === JAVASCRIPT_BLOCK_ID) return false
  if (NEVER_OBSERVED_BLOCK_IDS.has(blockId)) return false
  return operatorExecClass(blockId) === 'execute'
}

/**
 * The node data one proposal lands with: the catalog entry's own defaults with
 * the model's parameters over them, plus the block id. Exported because the
 * pre-landing check has to judge the SAME object the patcher will write — asking
 * the user to act on the page over a parameter the catalog default already
 * supplies would be a lie.
 */
export function operatorDataOfProposal(
  blockId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const block = BLOCK_BY_ID.get(blockId)
  if (!block) return { ...data, blockId }
  return withNodeAddedByAi({
    ...structuredClone(block.data),
    description: '',
    ...data,
    blockId: block.id,
  })
}

/**
 * Which proposals cannot be trusted until the page has been touched: the operator
 * reads an element, and something its step cannot work without is still empty.
 * That is exactly the parameter a live action produces — a real locator, the
 * option label the site actually offers — and nothing else: a missing URL is not
 * worth acting for, so the block-taking-element filter is the gate.
 */
export function proposalsNeedingPage(
  proposals: readonly OperatorProposal[],
): OperatorMissingParams[] {
  return proposals.flatMap((proposal) => elementGapsOf(proposal))
}

/**
 * The same gate by position: a manual pick has to be written into the RIGHT step,
 * and two steps of one batch can share an operator id.
 */
export function proposalIndexesNeedingPage(proposals: readonly OperatorProposal[]): number[] {
  const needing: number[] = []
  proposals.forEach((proposal, index) => {
    if (elementGapsOf(proposal).length > 0) needing.push(index)
  })
  return needing
}

/** What one proposal still lacks that only the page can supply. */
function elementGapsOf(proposal: OperatorProposal): OperatorMissingParams[] {
  if (!blockTakesElement(proposal.blockId)) return []
  return missingParameterProblems(
    proposal.blockId,
    operatorDataOfProposal(proposal.blockId, proposal.data),
  )
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
    if (seen.has(id) || !aiLandingAllowed(id)) return
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
  /** The step the user selected, with every current parameter, from
   *  {@link selectedOperatorSpecOf}. Empty or absent when nothing is selected. */
  selectedSpec?: string
  /** What the page the user is looking at offers, from a read-only snapshot.
   *  Absent when there was no page to read or the user asked not to read it —
   *  then the model must guess, and the reply says so. */
  page?: OperatorPageRead
  /** Locators the user picked by hand for this turn, in the order they picked. */
  pickedElements?: readonly PickedElement[]
  /** The screenshot round: the image itself attached to this call (`inline`), or
   *  an image model's read of it (`described`). Only ever set on the second call
   *  of a turn, when a step still lacked a parameter only the page can give. */
  screenshot?: { route: 'inline' } | { route: 'described'; note: string }
  maxOperators?: number
}

/**
 * Builds the assistant prompt. English scaffolding (models follow it reliably);
 * `reply` is asked for in the user's own language because it is shown to them.
 */
export function buildOperatorAdvisePrompt(input: OperatorAdvisePromptInput): string {
  const maxOperators = input.maxOperators ?? OPERATOR_ADVISE_MAX_OPERATORS
  const selected = input.selectedSpec?.trim() ?? ''
  const page = input.page
  const picked = (input.pickedElements ?? []).filter((element) => element.selector.trim() !== '')
  const screenshot = input.screenshot
  const shot: string[] = []
  if (screenshot) {
    const head =
      screenshot.route === 'inline'
        ? ['## A screenshot of the page is attached to this request']
        : [
            '## What a screenshot of the page shows (read by the image model)',
            screenshot.note.trim().slice(0, OPERATOR_SCREENSHOT_NOTE_CAP),
          ]
    shot.push(
      '',
      ...head,
      'A step of the first answer was still missing a parameter only the page can give, so the',
      'screen was captured. Use it for what the page read above cannot show: what sits where, an',
      'open menu or dropdown and its option labels, a disabled, loading or error state. Fill the',
      'gap from what is actually on screen, and never invent a locator the sections above do not',
      'show. Do NOT copy out anything that looks like a password, token, cookie, phone number, ID',
      'or card number — describe such a field instead of transcribing it.',
    )
  }
  const lines: string[] = []
  lines.push(
    "You are the operator assistant inside a browser-automation Chrome extension's workflow editor.",
    'The user describes what the workflow should do next. Choose the operator(s) that implement it',
    'and fill in their parameters. The editor lands what you return on the canvas — you never run it.',
    '',
    '## The workflow already on the canvas (in order)',
    input.graphDigest.trim() === '' ? '(empty)' : input.graphDigest.trim(),
    ...(selected === ''
      ? []
      : ['', '## The step the user selected (with its current parameters)', selected]),
    ...(page === undefined
      ? []
      : [
          '',
          `## The page the user is looking at — ${page.title || page.url} (read just now, read-only)`,
          capModelPayload({ elements: page.elements, forms: page.forms }),
          'Fill parameters FROM THIS PAGE: take selectors from its "loc" hints, and option and label',
          'text from its forms. Never invent a selector that is not shown here; leave a parameter out',
          'rather than guessing it.',
        ]),
    ...(picked.length === 0
      ? []
      : [
          '',
          '## Elements the user picked by hand',
          ...picked.map(
            (element) => `${element.findBy === 'xpath' ? 'XPath' : 'CSS'}: ${element.selector}`,
          ),
          'The user pointed at these on the page themselves: use one VERBATIM as the element',
          'parameter of the step it belongs to, and never invent another selector for the same',
          'element. Where this disagrees with the page read above, this section wins.',
        ]),
    ...shot,
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
    '## What to do with your answer — the "action" field',
    ...(selected === ''
      ? [
          '- Only "append" is possible here (or omit it): nothing is selected, so the operators go after the last step.',
        ]
      : [
          '- "append" (default, also when omitted): your operators are added as a new chain right AFTER the selected step.',
          '- "prepend": your operators are inserted IN FRONT of the selected step: they run first, then the selected step runs unchanged. Choose by WHEN the new work happens — "prepend" for what must precede the selected step (wait for an element, close a popup, set a variable it reads), "append" for what follows it.',
          '- "edit": change the selected step in place. Return EXACTLY ONE proposal, with the SAME operator id as that step, and put in "data" only the parameters to change — every other parameter of the node stays untouched.',
          '- "replace": turn the selected step into a different operator. Return EXACTLY ONE proposal with the new operator id (it must differ from the selected step\'s) and the parameters it should carry.',
          '- Never name a node id: the editor only ever acts on the step the user selected.',
          '- "prepend" needs a single path arriving at the selected step; the editor refuses the batch when the step is the trigger, is not wired, or several paths join there.',
        ]),
    '',
    '## Rules',
    '- For "append" and "prepend", return the operators in execution order; they chain into one another automatically.',
    '- Use only ids from the list above. Never invent an id; never return an operator the canvas already has unless the user asks for another one.',
    '- Fill every value the user stated (URLs, text, selectors) and omit the rest — the catalog default is applied for you.',
    '- Where a value should come from an earlier step, reference it as {{variableName}} using a name the digest shows that step produces.',
    '- Prefer stable locators (#id, [data-testid], [name]) over generated classes or nth-child chains.',
    `- At most ${maxOperators} operators (one for "edit"/"replace"). Return an empty "proposals" array when nothing on the list fits or the user is only asking a question — then "reply" must say why.`,
    '- "reply" is shown to the user, in the language they wrote in, and must match what you actually did.',
    '',
    '## Response format',
    'Respond with ONLY a JSON object — no markdown fence, no commentary:',
    '{"reply":"<one sentence for the user>","action":"append|prepend|edit|replace","proposals":[{"blockId":"<id>","data":{ …parameters… },"rationale":"<why this operator>"}]}',
  )
  return lines.join('\n')
}

/**
 * Read the model's answer back. Nothing is trusted: ids outside the offer (and
 * rows past the cap) are dropped and reported, an `action` that names nothing
 * voids the whole answer instead of being guessed as `append`, and every
 * parameter object is sanitized by the same gate AI Fix uses, which also strips
 * the `__workflowAi` namespace so the model cannot forge the provenance marker.
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

  const rawAction = parsed['action']
  if (
    rawAction !== undefined &&
    rawAction !== null &&
    rawAction !== 'append' &&
    rawAction !== 'prepend' &&
    rawAction !== 'edit' &&
    rawAction !== 'replace'
  ) {
    // An action that names nothing is not a partial answer: the model broke the
    // contract, so the whole turn is refused instead of being guessed as append.
    return null
  }
  const action: OperatorAction =
    rawAction === 'prepend' || rawAction === 'edit' || rawAction === 'replace'
      ? rawAction
      : 'append'

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
  return { reply, action, proposals: kept, rejected }
}

/** Parameters worth showing the model: scalars the user can read off the node.
 *  Secret-named ones are masked — this text becomes part of a prompt, and a step
 *  that types a password must not hand it to the model provider. */
function scalarParamsOf(node: WorkflowNode): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.data)) {
    if (key === 'blockId' || key === 'description' || key.startsWith('__')) continue
    if (value === '' || value === null || value === undefined) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params[key] = isSecretKey(key) ? MASK : value
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
      if (node.id === selectedNodeId) parts.push('<< selected')
      return parts.join(' ')
    })
    .join('\n')
}

/** One node's parameters as an in-place edit sees them: every key, not only the
 *  scalars, because a `forms` step's settings are nested. Secret-named values
 *  are masked and long strings capped — this text goes to the model provider. */
function paramsForModel(node: WorkflowNode): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.data)) {
    if (key === 'blockId' || key.startsWith('__') || value === undefined) continue
    if (isSecretKey(key)) params[key] = MASK
    else if (typeof value === 'string') params[key] = redactText(value)
    else params[key] = value
  }
  return params
}

/**
 * The selected step as a spec the model can edit against: operator id, display
 * name, every current parameter and the variables it publishes. Empty when
 * nothing is selected, and the prompt then offers no in-place action.
 */
export function selectedOperatorSpecOf(graph: SuggestionGraph, nodeId: string | undefined): string {
  const node = nodeId ? graph.nodes.find((candidate) => candidate.id === nodeId) : undefined
  if (!node) return ''
  const produced = producedVariableNames(node)
  const parts = [blockIdOf(node), node.label, capModelPayload(paramsForModel(node), 700)]
  if (produced.length > 0) parts.push(`-> {{${produced.join(', ')}}}`)
  return parts.filter(Boolean).join(' ')
}

/** The catalog shape the port authority reads for a graph node. */
function portSourceOf(blockId: string): BlockPortSource {
  const block = BLOCK_BY_ID.get(blockId)
  return block ? { id: block.id, inputs: block.inputs, outputs: block.outputs } : { id: blockId }
}

/** The output handle a node's normal continuation leaves from. */
function normalOutputHandleOfNode(node: WorkflowNode): string {
  return normalOutputHandleOf(portSourceOf(blockIdOf(node)), node.data)
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
 * The edges that feed the main line INTO a node — the mirror of
 * {@link normalOutgoing}. A loop-back is excluded for the same reason, and so is
 * an edge that leaves an error fallback: it is not the line that runs into the
 * step, it is what happens when the step before it failed.
 */
function normalIncoming(graph: SuggestionGraph): Map<string, WorkflowEdge[]> {
  const loopBacks = loopBackEdgeIds(graph.edges)
  const incoming = new Map<string, WorkflowEdge[]>()
  for (const edge of graph.edges) {
    if (isFallbackHandle(edge.sourceHandle) || loopBacks.has(edge.id)) continue
    const list = incoming.get(edge.target)
    if (list) list.push(edge)
    else incoming.set(edge.target, [edge])
  }
  return incoming
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

/** The handle a node's incoming main line hangs on. */
function inputHandleOfNode(node: WorkflowNode): string | undefined {
  return inputHandleOf(portSourceOf(blockIdOf(node)))
}

/** The canvas exactly as it was, for a batch that places nothing. */
function untouchedChainPatch(graph: SuggestionGraph): OperatorChainPatch {
  return {
    added: [],
    edges: graph.edges.map((edge) => ({ ...edge })),
    skipped: [],
    missing: [],
  }
}

/** A batch's own nodes and links, before any of them is wired into the flow. */
interface BuiltChain {
  added: WorkflowNode[]
  /** The links between the new nodes, in execution order. */
  inner: WorkflowEdge[]
  skipped: string[]
  missing: OperatorMissingParams[]
  /** Where the flow enters the chain. */
  headInput?: string
  /** Where the chain hands the flow back. */
  tailOutput?: string
}

/**
 * Turn the accepted proposals into nodes plus the links between them — the part
 * every placement shares, whether the chain goes after a step or in front of one.
 *
 * Each node steps away from the anchor by `stepX` (right for after, left for
 * before) and is pushed clear of what the canvas already holds, and the next step
 * is measured from where that one actually landed rather than from the ideal
 * spacing. An operator this build cannot run is skipped and NAMED, and the chain
 * closes over the gap so the rest still executes in order.
 *
 * Parameters are the model's, sanitized by AI Fix's gate; catalog defaults show
 * through whatever it did not author, exactly as a hand-dragged node would get
 * them.
 */
function buildChain(
  proposals: readonly OperatorProposal[],
  context: {
    newId: () => string
    occupied: WorkflowNode[]
    from: { x: number; y: number }
    stepX: number
  },
): BuiltChain {
  const added: WorkflowNode[] = []
  const inner: WorkflowEdge[] = []
  const skipped: string[] = []
  const missing: OperatorMissingParams[] = []
  let previous = context.from
  let previousId: string | undefined
  let previousHandle: string | undefined
  let headInput: string | undefined
  for (const proposal of proposals) {
    const block = BLOCK_BY_ID.get(proposal.blockId)
    if (!block || !aiLandingAllowed(block.id)) {
      skipped.push(block?.name ?? proposal.blockId)
      continue
    }
    const data = operatorDataOfProposal(block.id, proposal.data)
    const position = placeClearOfNodes(
      { x: previous.x + context.stepX, y: previous.y },
      context.occupied,
    )
    const node: WorkflowNode = { id: context.newId(), label: block.name, position, data }
    context.occupied.push(node)
    if (previousId !== undefined && previousHandle !== undefined) {
      inner.push({
        id: context.newId(),
        source: previousId,
        sourceHandle: previousHandle,
        target: node.id,
        targetHandle: inputHandleOf(block),
      })
    }
    if (headInput === undefined) headInput = inputHandleOf(block)
    added.push(node)
    previous = position
    previousId = node.id
    previousHandle = normalOutputHandleOfNode(node)
    missing.push(...missingParameterProblems(block.id, data))
  }
  return {
    added,
    inner,
    skipped,
    missing,
    ...(headInput !== undefined ? { headInput } : {}),
    ...(previousHandle !== undefined ? { tailOutput: previousHandle } : {}),
  }
}

/**
 * Point one existing edge at a different end, leaving every other edge untouched.
 * Both placements do this to the single flow edge they borrow: appending moves
 * its source onto the chain's tail, prepending moves its target onto the chain's
 * head.
 */
function rewireEdge(
  edges: WorkflowEdge[],
  edgeId: string,
  end: Partial<Pick<WorkflowEdge, 'source' | 'sourceHandle' | 'target' | 'targetHandle'>>,
): WorkflowEdge[] {
  return edges.map((edge) => (edge.id === edgeId ? { ...edge, ...end } : edge))
}

/** The undo record for the edge a splice moved: its id and both original ends. */
function splicedEdgeOf(edge: WorkflowEdge): OperatorSplicedEdge {
  return {
    id: edge.id,
    source: edge.source,
    ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
    target: edge.target,
    ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
  }
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
 * With no anchor named the chain goes to the end of the main line, which is the
 * one placement that can never cut in front of anything the user wired.
 */
export function appendOperatorChain(
  graph: SuggestionGraph,
  proposals: readonly OperatorProposal[],
  options: OperatorChainOptions,
): OperatorChainPatch {
  if (proposals.length === 0) return untouchedChainPatch(graph)

  const anchor = options.anchorNodeId
    ? graph.nodes.find((node) => node.id === options.anchorNodeId)
    : tailNodeOf(graph)
  if (!anchor) {
    return {
      ...untouchedChainPatch(graph),
      problem: options.anchorNodeId ? 'unknown-anchor' : 'empty-graph',
    }
  }

  const outgoing = normalOutgoing(graph).get(anchor.id) ?? []
  if (outgoing.length > 1) {
    return { ...untouchedChainPatch(graph), problem: 'branch-anchor', anchorNodeId: anchor.id }
  }
  const continuation = outgoing[0]

  const chain = buildChain(proposals, {
    newId: options.newId,
    occupied: [...graph.nodes],
    from: anchor.position,
    stepX: NODE_INSERT_GAP,
  })
  const placed = chain.added[0]
  const tail = chain.added[chain.added.length - 1]
  const edgeList = graph.edges.map((edge) => ({ ...edge }))
  if (placed && tail) {
    edgeList.push({
      id: options.newId(),
      source: anchor.id,
      sourceHandle: continuation?.sourceHandle ?? normalOutputHandleOfNode(anchor),
      target: placed.id,
      targetHandle: chain.headInput,
    })
    edgeList.push(...chain.inner)
  }

  // The step the anchor used to continue to now continues from the END of the new
  // chain. Re-hanging it on the first node would branch the flow the user wired.
  const borrowed = continuation && placed && tail ? continuation : undefined
  const edges =
    borrowed && tail
      ? rewireEdge(edgeList, borrowed.id, { source: tail.id, sourceHandle: chain.tailOutput })
      : edgeList

  return {
    added: chain.added,
    edges,
    anchorNodeId: anchor.id,
    skipped: chain.skipped,
    missing: chain.missing,
    ...(borrowed ? { splicedEdge: splicedEdgeOf(borrowed) } : {}),
  }
}

/**
 * Land the assistant's operators IN FRONT of the step the user selected.
 *
 * The same splice as {@link appendOperatorChain}, read from the other side: the
 * one path that arrives at the anchor is cut, the chain is wired into it, and the
 * anchor runs whatever the chain leaves. Placement never falls back to a guessed
 * anchor — "before" only has a meaning for the step that was picked — and the
 * refusals mirror the append's: nothing precedes the entry point, an unwired node
 * has no front, and a step several paths arrive at is a join, where choosing
 * which feed to rewrite is not ours to make.
 */
export function prependOperatorChain(
  graph: SuggestionGraph,
  proposals: readonly OperatorProposal[],
  options: OperatorChainOptions,
): OperatorChainPatch {
  if (proposals.length === 0) return untouchedChainPatch(graph)

  const anchor = options.anchorNodeId
    ? graph.nodes.find((node) => node.id === options.anchorNodeId)
    : undefined
  if (!anchor) return { ...untouchedChainPatch(graph), problem: 'unknown-anchor' }
  if (blockIdOf(anchor) === TRIGGER_BLOCK_ID) {
    return {
      ...untouchedChainPatch(graph),
      problem: 'prepend-entry-point',
      anchorNodeId: anchor.id,
    }
  }

  const incoming = normalIncoming(graph).get(anchor.id) ?? []
  if (incoming.length === 0) {
    return {
      ...untouchedChainPatch(graph),
      problem: 'prepend-no-incoming',
      anchorNodeId: anchor.id,
    }
  }
  if (incoming.length > 1) {
    return { ...untouchedChainPatch(graph), problem: 'join-anchor', anchorNodeId: anchor.id }
  }
  const feed = incoming[0] as WorkflowEdge

  const chain = buildChain(proposals, {
    newId: options.newId,
    occupied: [...graph.nodes],
    from: anchor.position,
    stepX: -NODE_INSERT_GAP,
  })
  const edgeList = graph.edges.map((edge) => ({ ...edge }))
  const placed = chain.added[0]
  const tail = chain.added[chain.added.length - 1]
  if (!placed || !tail) {
    return {
      added: [],
      edges: edgeList,
      anchorNodeId: anchor.id,
      skipped: chain.skipped,
      missing: chain.missing,
    }
  }

  edgeList.push(...chain.inner)
  edgeList.push({
    id: options.newId(),
    source: tail.id,
    sourceHandle: chain.tailOutput,
    target: anchor.id,
    targetHandle: inputHandleOfNode(anchor),
  })
  // The path that used to arrive at the anchor now feeds the head of the chain.
  const edges = rewireEdge(edgeList, feed.id, {
    target: placed.id,
    targetHandle: chain.headInput,
  })

  return {
    added: chain.added,
    edges,
    anchorNodeId: anchor.id,
    skipped: chain.skipped,
    missing: chain.missing,
    splicedEdge: splicedEdgeOf(feed),
  }
}
