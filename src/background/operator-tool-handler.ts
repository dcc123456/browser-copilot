/**
 * Background-side state and dispatch for workflow-operator tools.
 *
 * Workflow generation mode turns every workflow block into an LLM tool. Each
 * `wf_op_<id>` call does two things: it EXECUTES the corresponding block
 * against the live page (see `operator-tool-run`), and — only when that
 * succeeds — appends one node to a per-conversation draft (`WorkflowDraft`).
 * "What got recorded is what actually happened" holds by construction, because
 * execution goes through the very same block executors the workflow engine
 * replays.
 *
 * This module owns the draft graph itself: the append primitive, the trigger
 * head node, and the edge/handle bookkeeping. The draft is mirrored to durable
 * storage on every write (`lib/workflow/draft-storage`), because the MV3
 * service worker can be evicted between any two tool calls of a long run — an
 * in-memory-only draft would silently lose the session's work.
 *
 * The history-derived "save as workflow" UI flow goes through the same shape
 * via {@link loadDraftFromWorkflow}, so the two paths share one serialisation
 * and one save call.
 *
 * @module background/operator-tool-handler
 */

import { newId } from '../lib/storage'
import { isTriggerNode, triggerFromNodes } from '../lib/workflow/migrate'
import { deleteDraft, loadDraft, saveDraft } from '../lib/workflow/draft-storage'
import { TRIGGER_BLOCK_ID } from '../lib/workflow/draft-types'
import { saveWorkflow } from '../lib/workflow/storage'
import { BLOCK_BY_ID } from '../lib/workflow/blocks/palette'
import { aiPrefillNodeData } from '../lib/workflow/ai-prefill'
import {
  formatRequirementRefusal,
  missingRequirements,
} from '../lib/workflow/block-requirements'
import {
  isOperatorTool,
  blockIdFromOperatorName,
  JAVASCRIPT_BLOCK_ID,
  SCRIPT_REFUSAL,
  scriptJustification,
} from '../lib/workflow/operator-tools'
import {
  applyLoopElementsFold,
  applyRepeatTaskFold,
  detectRepeatRuns,
  type CollapseProbe,
  type RepeatSuggestion,
} from '../lib/workflow/loop-collapse'
import type { DraftSource, PendingBranch, WorkflowDraft } from '../lib/workflow/draft-types'
import type { DeclaredInput } from '../lib/workflow/dynamic-data'
import {
  buildVariableIndex,
  mergeTriggerInputs,
  rewriteDataParams,
  unproducedBulkData,
  unproducedDataRefusal,
} from '../lib/workflow/dynamic-data'
import { isAiComposedFill } from '../lib/workflow/ai-prefill'
import type { Workflow, WorkflowNode } from '../lib/workflow/types'

export { TRIGGER_BLOCK_ID }
export type { DraftSource, PendingBranch, WorkflowDraft }

/** Per-conversation in-memory cache. Write-through; storage is the source of truth. */
const draftStore = new Map<string, WorkflowDraft>()

/** Optional cap so abandoned conversations cannot grow the cache without bound. */
const DRAFT_STORE_CAP = 128

/** In-flight rehydrations, so concurrent tool calls load a draft only once. */
const hydrating = new Map<string, Promise<WorkflowDraft>>()

/** Canonical block id of a draft node: `data.blockId`, falling back to `label`. */
export function blockIdOfNode(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  if (typeof fromData === 'string' && fromData) return fromData
  return node.label
}

/** Nodes that actually do something — everything but the trigger head. */
export function actionNodesOf(draft: WorkflowDraft): WorkflowNode[] {
  return draft.nodes.filter((n) => !isTriggerNode(n))
}

/**
 * Make sure the graph starts at a trigger node and return its id. Generated
 * workflows must carry a trigger or they cannot be launched, so this runs both
 * when a draft is created and right before composing. When a draft somehow
 * lacks one (older shape, hand-built graph) the node is prepended and wired to
 * whichever node currently has no incoming edge.
 */
export function ensureTriggerHead(draft: WorkflowDraft): string {
  const existing = draft.nodes.find(isTriggerNode)
  if (existing) return existing.id

  const triggerId = newId()
  draft.nodes.unshift({
    id: triggerId,
    label: TRIGGER_BLOCK_ID,
    position: { x: 0, y: 0 },
    data: { blockId: TRIGGER_BLOCK_ID, type: 'manual', enabled: true, description: '' },
  })
  const targets = new Set(draft.edges.map((e) => e.target))
  const head = draft.nodes.find((n) => n.id !== triggerId && !targets.has(n.id))
  if (head) {
    draft.edges.unshift({
      id: newId(),
      source: triggerId,
      target: head.id,
      sourceHandle: `${TRIGGER_BLOCK_ID}-output-1`,
      targetHandle: `${blockIdOfNode(head)}-input-1`,
    })
  }
  if (!draft.tail) draft.tail = draft.nodes.at(-1)?.id ?? triggerId
  return triggerId
}

/** Fresh draft for a conversation, already carrying its trigger head node. */
function emptyDraft(conversationId: string): WorkflowDraft {
  const draft: WorkflowDraft = {
    conversationId,
    name: `workflow-${conversationId.slice(0, 6)}`,
    nodes: [],
    edges: [],
    tail: null,
    source: 'chat-generate',
  }
  draft.tail = ensureTriggerHead(draft)
  return draft
}

/** Cache a draft, evicting the least recently touched conversation. */
function remember(draft: WorkflowDraft): void {
  draftStore.delete(draft.conversationId)
  draftStore.set(draft.conversationId, draft)
  while (draftStore.size > DRAFT_STORE_CAP) {
    const oldest = draftStore.keys().next().value
    if (oldest === undefined) break
    draftStore.delete(oldest)
  }
}

/**
 * Load the conversation's draft, rehydrating it from durable storage when the
 * service worker has been recycled since the last tool call. Concurrent callers
 * share one load. Always returns a draft with a trigger head.
 */
export async function hydrateDraft(conversationId: string): Promise<WorkflowDraft> {
  const cached = draftStore.get(conversationId)
  if (cached) return cached
  const inFlight = hydrating.get(conversationId)
  if (inFlight) return inFlight

  const task = (async (): Promise<WorkflowDraft> => {
    const persisted = await loadDraft(conversationId)
    const draft = persisted ?? emptyDraft(conversationId)
    ensureTriggerHead(draft)
    remember(draft)
    return draft
  })()
  hydrating.set(
    conversationId,
    task.finally(() => hydrating.delete(conversationId)),
  )
  return task
}

/** Mirror a draft to durable storage. Called after every mutation. */
export async function persistDraft(draft: WorkflowDraft): Promise<void> {
  try {
    await saveDraft(draft)
  } catch {
    // A failed mirror must not abort the run: the in-memory draft is still
    // correct, and the user can still review and save it.
  }
}

/** Exposed for the side panel's review card to render the draft. */
export function getDraftSnapshot(conversationId: string): WorkflowDraft | undefined {
  return draftStore.get(conversationId)
}

/** Drop a draft everywhere — cache and storage. */
export async function clearDraft(conversationId: string): Promise<void> {
  draftStore.delete(conversationId)
  try {
    await deleteDraft(conversationId)
  } catch {
    /* the cache drop is what matters for correctness of the next turn */
  }
}

/** Where the edge from the draft's current tail should start. */
function tailBranch(draft: WorkflowDraft): PendingBranch | undefined {
  if (!draft.tail) return undefined
  const tailNode = draft.nodes.find((n) => n.id === draft.tail)
  if (!tailNode) return undefined
  return { source: tailNode.id, sourceBlockId: blockIdOfNode(tailNode), output: 'output-1' }
}

/**
 * Append one operator node to the draft and wire it into the chain.
 *
 * The edge handle is the canonical `<blockId>-output-N` → `<blockId>-input-1`
 * form the engine and the canvas both expect (never a bare `next`, which the
 * engine's branch resolution cannot map). The source port is, in order of
 * preference: an explicit `branch` from the caller, the branch recorded by the
 * previous append, or the tail's first output.
 */
export function appendOperatorNode(
  draft: WorkflowDraft,
  blockId: string,
  data: Record<string, unknown>,
  opts: { branch?: PendingBranch } = {},
): { nodeId: string; workflowSize: number } {
  // The trigger is the one block that must NOT be appended: every draft
  // already carries a trigger head (see `ensureTriggerHead`), and a second
  // trigger node would make `triggerFromNodes` pick an arbitrary one. The
  // `wf_op_trigger` tool therefore *edits* the head in place — it is the
  // model's way to set the trigger type/params, alongside the save card's
  // picker.
  if (blockId === TRIGGER_BLOCK_ID) {
    const head = draft.nodes.find(isTriggerNode)
    if (head) {
      head.data = { ...head.data, ...data, blockId }
      return { nodeId: head.id, workflowSize: actionNodesOf(draft).length }
    }
  }

  const nodeId = newId()
  const node: WorkflowNode = {
    id: nodeId,
    label: blockId,
    position: { x: draft.nodes.length * 220, y: 0 },
    data: { ...data, blockId },
  }
  const from = opts.branch ?? draft.pendingBranch ?? tailBranch(draft)
  if (from) {
    draft.edges.push({
      id: newId(),
      source: from.source,
      target: nodeId,
      sourceHandle: `${from.sourceBlockId}-${from.output}`,
      targetHandle: `${blockId}-input-1`,
    })
  }
  draft.pendingBranch = undefined
  draft.nodes.push(node)
  draft.tail = nodeId
  return { nodeId, workflowSize: actionNodesOf(draft).length }
}

/**
 * Normalise a model-supplied `next` hint into a port suffix. Accepts both the
 * semantic branch keys the operators use in the editor and raw `output-N`
 * handles. Returns null when the value is not a usable port.
 */
export function outputSuffixOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (!value) return null
  if (/^output-\d+$/.test(value)) return value
  switch (value) {
    case 'next':
    case 'true':
    case 'exists':
    case 'loop':
      return 'output-1'
    case 'false':
    case 'notexists':
    case 'not-exists':
    case 'end':
      return 'output-2'
    case 'fallback':
      return 'output-fallback'
    default:
      return null
  }
}

/**
 * Append a node for one operator tool call without executing anything.
 *
 * The TEST / non-executing helper. The live path is `runOperatorToolWithExecution`
 * in `operator-tool-run`, which resolves the element locator, runs the block
 * against the real page, and only then calls {@link appendOperatorNode}.
 *
 * The dead-data rewrite is applied here too, deliberately: an append path that
 * silently recorded business literals would be a trap for the next caller, and
 * "no path records dead data" is easier to hold than "one path does not".
 * Credential redaction is NOT applied — that needs the session's resolved
 * secret bag, which only the executing path has; do not use this to record a
 * call that touched a credential.
 */
export async function runOperatorTool({
  name,
  args,
  conversationId,
}: {
  name: string
  args: Record<string, unknown>
  conversationId: string
}): Promise<{ ok: true; nodeId: string; workflowSize: number } | { ok: false; error: string }> {
  if (!isOperatorTool(name)) {
    return { ok: false, error: `Unknown operator tool: ${name}` }
  }
  const blockId = blockIdFromOperatorName(name)
  if (!blockId) return { ok: false, error: `Bad operator tool name: ${name}` }

  // The escape hatch's gate, applied here too: "no path records a script
  // nobody justified" is a cheaper invariant to hold than "one path does not".
  if (blockId === JAVASCRIPT_BLOCK_ID && !scriptJustification(args)) {
    return { ok: false, error: SCRIPT_REFUSAL }
  }

  const draft = await hydrateDraft(conversationId)
  const raw = stripDraftOnlyKeys(args)
  // The AI-prefill self-report rides on the RAW args (stripped above): a fill
  // whose text the model composed itself must be produced by an ai-agent node,
  // not frozen as a literal or an input default. Same rule as the executing
  // path — "no path records dead data" holds for composed copy too.
  const generated = generatedFlagOf(args)

  // Same gate as the executing path: "no path records unproduced content" is
  // cheaper to hold than "one path does not". See `unproducedBulkData`. Runs
  // BEFORE the required-parameter gate so a pasted scrape gets the richer
  // "record a producer" refusal first — same reasoning as the executing path.
  // Skipped when AI prefill has decided: the (existing or inserted) producer
  // replaces the literal, so the bulk judgment — aimed at page-read content —
  // does not apply.
  const variableIndex = buildVariableIndex(draft.variables ?? {})
  const plan = aiPrefillPlanOf(draft, blockId, raw, generated, variableIndex)
  const unproduced = plan.kind === 'none' ? unproducedBulkData(blockId, raw, variableIndex) : null
  if (unproduced) return { ok: false, error: unproducedDataRefusal(blockId, unproduced) }

  // Same required-parameter gate as the executing path (see
  // `lib/workflow/block-requirements`): "no path records a call a block cannot
  // run" is cheaper to hold than "one path does not". The locator check reads
  // the raw args here — an inline `target`/`selector` counts; a bare `ref`
  // without the run's snapshot cache does not (that path is the executing
  // bridge's to resolve). `mustReference` params (save-local.value) are
  // skipped: the literal may be rewritten into a `{{reference}}` below, and
  // the final gate re-checks after the rewrite.
  const problems = missingRequirements(blockId, raw, { skipMustReference: true })
  if (problems.length > 0) {
    return { ok: false, error: formatRequirementRefusal(BLOCK_BY_ID.get(blockId)?.name ?? blockId, problems) }
  }

  // Swap the composed literal for the producer's variable BEFORE the rewrite,
  // so the rewriter sees a reference (nothing to declare) rather than dead
  // data. The node itself is appended only after the final gate passes — a
  // refused call must not strand an orphaned producer in the draft.
  if (plan.kind !== 'none') {
    raw['value'] = `{{${plan.variableName}}}`
  }

  const rewrite = rewriteDataParams({
    blockId,
    data: raw,
    variableIndex,
    declared: declaredInputs(draft),
  })
  // Final required-parameter gate on the POST-REWRITE data — the literal that
  // became a `{{reference}}` now passes; an unsatisfiable one is refused.
  const finalProblems = missingRequirements(blockId, rewrite.data)
  if (finalProblems.length > 0) {
    return {
      ok: false,
      error: formatRequirementRefusal(BLOCK_BY_ID.get(blockId)?.name ?? blockId, finalProblems),
    }
  }
  insertAiPrefillNode(draft, plan)
  declareWorkflowInputs(draft, rewrite.newInputs)
  const appended = appendOperatorNode(draft, blockId, rewrite.data)
  const branch = outputSuffixOf(args['next'])
  if (branch) {
    draft.pendingBranch = {
      source: appended.nodeId,
      sourceBlockId: blockId,
      output: branch,
    }
  }
  // The model may pass a workflow name hint on any tool call; the first wins.
  const nameHint = typeof args['workflowName'] === 'string' ? args['workflowName'].trim() : ''
  if (nameHint && draft.name.startsWith('workflow-')) draft.name = nameHint

  await persistDraft(draft)
  return { ok: true, nodeId: appended.nodeId, workflowSize: appended.workflowSize }
}

/**
 * Drop the model-only affordances before persistence: `next` / `workflowName` /
 * `inputName` / `generated` steer the draft rather than the node, and
 * `justification` is the escape hatch's reasoning — it is folded into the
 * node's description by `operator-tool-run` instead of being stored as a block
 * parameter.
 */
export function stripDraftOnlyKeys(args: Record<string, unknown>): Record<string, unknown> {
  const {
    next: _next,
    workflowName: _wn,
    inputName: _in,
    generated: _gen,
    justification: _j,
    ...rest
  } = args as Record<string, unknown> & {
    next?: unknown
    workflowName?: unknown
    inputName?: unknown
    generated?: unknown
    justification?: unknown
  }
  return rest
}

/**
 * The model's `generated` self-report for a fill call, read before
 * {@link stripDraftOnlyKeys} removes it. `true` = the model composed the text
 * itself; `false` = user-dictated or page-read data; undefined = unmarked.
 */
export function generatedFlagOf(args: Record<string, unknown>): boolean | undefined {
  if (args['generated'] === true) return true
  if (args['generated'] === false) return false
  return undefined
}

/** Block id of the AI node a prefill insertion adds before a `forms` fill. */
export const AI_PREFILL_BLOCK_ID = 'ai-agent'

/**
 * An unused `aiFillN` for one prefill producer.
 *
 * Names are claimed against BOTH the draft's ai-agent nodes and its session
 * variables, so a name the model already used (its own `wf_op_ai-agent` call)
 * is never silently reused into a second producer.
 */
export function nextAiFillName(draft: WorkflowDraft): string {
  const used = new Set<string>(Object.keys(draft.variables ?? {}))
  for (const node of draft.nodes) {
    if (blockIdOfNode(node) !== AI_PREFILL_BLOCK_ID) continue
    const name = node.data?.['variableName']
    if (typeof name === 'string') used.add(name)
  }
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `aiFill${n}`
    if (!used.has(candidate)) return candidate
  }
  return `aiFill${Date.now()}`
}

/** Human name of the form field a fill targeted (the inserted AI prompt's subject). */
function formsFieldLabel(data: Record<string, unknown>): string {
  const label = data['label']
  if (typeof label === 'string' && label.trim()) return label.trim()
  const selector = data['selector']
  if (typeof selector === 'string' && selector.trim()) return selector.trim()
  return '表单字段'
}

/**
 * What the record paths should do about one composed `forms` fill.
 *
 * - `insert`: append an `ai-agent` producer before the fill and reference it.
 * - `reuse`: the model itself recorded an `ai-agent` as the draft's tail (the
 *   guide's recipe) but then passed the composed text as a literal — reference
 *   THAT producer instead of inserting a duplicate. `ai-agent` is record-only
 *   during generation, so its variable holds nothing yet and the value index
 *   cannot have made this match.
 * - `none`: nothing composed about this fill.
 */
export type AiPrefillPlan =
  | { kind: 'none' }
  | { kind: 'insert'; fillValue: string; fieldLabel: string; variableName: string }
  | { kind: 'reuse'; fillValue: string; variableName: string }

/** Decide the AI-prefill action for one `forms` write call. */
export function aiPrefillPlanOf(
  draft: WorkflowDraft,
  blockId: string,
  data: Record<string, unknown>,
  generated: boolean | undefined,
  variableIndex: ReadonlyMap<string, string>,
): AiPrefillPlan {
  const fillValue = isAiComposedFill({ blockId, data, generated, variableIndex })
  if (!fillValue) return { kind: 'none' }
  const tail = draft.tail ? draft.nodes.find((node) => node.id === draft.tail) : undefined
  if (tail && blockIdOfNode(tail) === AI_PREFILL_BLOCK_ID) {
    const variableName = tail.data?.['variableName']
    if (typeof variableName === 'string' && variableName) {
      return { kind: 'reuse', fillValue, variableName }
    }
  }
  return {
    kind: 'insert',
    fillValue,
    fieldLabel: formsFieldLabel(data),
    variableName: nextAiFillName(draft),
  }
}

/**
 * Insert the `ai-agent` node that regenerates one composed fill value at
 * replay, chained from the draft's current tail.
 *
 * Called by BOTH record paths after their gates have passed, immediately
 * before the `forms` node is appended — so the graph reads
 * ai-agent → forms, and the forms value the caller records is `{{variableName}}`.
 * The node itself did not run during generation (the model wrote the text in
 * conversation); that is the same accepted semantics as the history compiler's
 * prefill insertion, and `referenceValue` keeps the save-card toggle able to
 * fall back to the conversation's literal.
 */
export function insertAiPrefillNode(draft: WorkflowDraft, plan: AiPrefillPlan): void {
  if (plan.kind !== 'insert') return
  appendOperatorNode(
    draft,
    AI_PREFILL_BLOCK_ID,
    aiPrefillNodeData({
      fieldLabel: plan.fieldLabel,
      referenceValue: plan.fillValue,
      variableName: plan.variableName,
    }),
  )
}

/**
 * The inputs the draft's trigger already declares, as a name → default map.
 *
 * The rewriter consults this so a literal that matches an existing declaration
 * is reused instead of being declared a second time under a suffixed name.
 */
export function declaredInputs(draft: WorkflowDraft): Map<string, string> {
  const node = draft.nodes.find(isTriggerNode)
  const raw = node?.data?.['parameters']
  const out = new Map<string, string>()
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = record['name']
    if (typeof name !== 'string' || name === '') continue
    const fallback = record['defaultValue']
    out.set(name, typeof fallback === 'string' ? fallback : '')
  }
  return out
}

/**
 * Add workflow inputs to the trigger node's `parameters`.
 *
 * The trigger is the right home: a declared input is needed before the first
 * step runs, and the trigger node is the only node guaranteed to exist in every
 * draft. `triggerFromNodes` mirrors the list onto the workflow's top-level
 * `trigger`, which is what the run path reads to seed the variable scope.
 *
 * Names already declared are skipped, so a second operator call that reuses an
 * input never duplicates it. Returns the names actually added.
 */
export function declareWorkflowInputs(
  draft: WorkflowDraft,
  inputs: readonly DeclaredInput[],
): string[] {
  if (inputs.length === 0) return []
  ensureTriggerHead(draft)
  const node = draft.nodes.find(isTriggerNode)
  if (!node) return []

  const { data, added } = mergeTriggerInputs(
    node.data,
    inputs,
    new Set(declaredInputs(draft).keys()),
  )
  node.data = data
  return added
}

/**
 * Close the draft into a Workflow, optionally persisting it. Returns the
 * final workflow so the UI can show the review card.
 *
 * The top-level `trigger` mirror is derived from the graph's trigger node via
 * `triggerFromNodes` — `saveWorkflow` does not do that sync itself, and a
 * stale mirror would mis-route the alarm / context-menu / visit-web
 * registrations.
 */
export async function composeWorkflowFromDraft(
  conversationId: string,
  opts: { name?: string; description?: string; save?: boolean } = {},
): Promise<{ workflow: Workflow; saved: boolean } | { error: string }> {
  const draft = draftStore.get(conversationId) ?? (await hydrateDraft(conversationId))
  if (actionNodesOf(draft).length === 0) {
    return { error: 'No draft to compose. Call wf_op_* tools first.' }
  }
  ensureTriggerHead(draft)
  const name = (opts.name ?? '').trim() || draft.name
  const now = Date.now()
  const workflow: Workflow = {
    id: newId(),
    name,
    description: opts.description ?? '',
    trigger: triggerFromNodes(draft.nodes) ?? { type: 'manual', enabled: true },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      provenance: draft.source === 'chat-generate' ? 'chat-generate' : 'chat-history',
      ...(draft.originUrl ? { generationOriginUrl: draft.originUrl } : {}),
    },
    table: [],
    drawflow: { nodes: draft.nodes, edges: draft.edges },
    createdAt: now,
    updatedAt: now,
  }
  let saved = false
  if (opts.save !== false) {
    try {
      await saveWorkflow(workflow)
      saved = true
      await clearDraft(conversationId)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { workflow, saved }
}

/**
 * Wrap an already-derived workflow (e.g. from `workflowFromHistory`) in the
 * same draft shape so {@link composeWorkflowFromDraft} can persist it. The
 * side panel calls this when the user clicks save in non-workflow mode.
 */
export async function loadDraftFromWorkflow(
  conversationId: string,
  workflow: Pick<Workflow, 'name' | 'drawflow'>,
  source: DraftSource = 'chat-history',
): Promise<WorkflowDraft | null> {
  if (workflow.drawflow.nodes.length === 0) return null
  const draft: WorkflowDraft = {
    conversationId,
    name: workflow.name,
    nodes: workflow.drawflow.nodes,
    edges: workflow.drawflow.edges,
    tail: workflow.drawflow.nodes.at(-1)?.id ?? null,
    source,
  }
  ensureTriggerHead(draft)
  remember(draft)
  await persistDraft(draft)
  return draft
}

/**
 * A `Workflow` wrapper around the draft's graph.
 *
 * The collapse functions return a whole `Workflow`, but the draft has no id,
 * settings or trigger mirror yet — this builds the minimum they read and lets
 * the caller take `drawflow` straight back out.
 */
function draftAsWorkflow(draft: WorkflowDraft): Workflow {
  return {
    id: `draft-${draft.conversationId}`,
    name: draft.name,
    createdAt: 0,
    updatedAt: 0,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes: draft.nodes, edges: draft.edges },
    trigger: triggerFromNodes(draft.nodes) ?? { type: 'manual', enabled: true },
  }
}

/** Repeated runs in the draft, for the review card to offer as folds. */
export async function draftRepeatRuns(conversationId: string): Promise<RepeatSuggestion[]> {
  const draft = draftStore.get(conversationId) ?? (await hydrateDraft(conversationId))
  return detectRepeatRuns(draftAsWorkflow(draft))
}

/** What a fold did, so the caller can report it honestly. */
export interface FoldOutcome {
  folded: boolean
  /** Why nothing happened, when `folded` is false. */
  reason?: string
  /** The suggestion that was folded, for the card's confirmation line. */
  suggestion?: RepeatSuggestion
}

/**
 * Fold one detected run of the draft into a loop.
 *
 * A `varying` run needs a page-verified selector and is refused without one;
 * the caller passes the probe so this module never touches `chrome` itself.
 * The run is matched by `runIds` (the exact node ids the card rendered) when
 * given, falling back to `index` into the freshly detected list — the ids are
 * authoritative, the index is a compatibility path for callers that predate
 * them.
 *
 * Returns `folded: false` with a reason rather than throwing, because "the page
 * would not confirm a selector" is a normal outcome the card has to explain.
 */
export async function foldDraftRun(
  conversationId: string,
  index: number,
  probe: CollapseProbe,
  signal: AbortSignal,
  runIds?: readonly string[],
): Promise<FoldOutcome> {
  const draft = draftStore.get(conversationId) ?? (await hydrateDraft(conversationId))
  ensureTriggerHead(draft)
  const before = draftAsWorkflow(draft)
  const suggestions = detectRepeatRuns(before)
  const key = runIds && runIds.length > 0 ? runIds.join('\n') : null
  const suggestion =
    (key !== null
      ? suggestions.find((entry) => entry.runIds.join('\n') === key)
      : undefined) ?? suggestions[index]
  if (!suggestion) return { folded: false, reason: '没有可折叠的重复段' }
  let after: Workflow
  if (suggestion.kind === 'identical') {
    after = applyRepeatTaskFold(before, suggestion)
  } else {
    const selector = await probe.deriveLoopSelector(suggestion.selectors, signal)
    if (!selector) {
      // Refusing is the point: a loop iterating the wrong elements would run
      // the body N times against the wrong target, silently.
      return {
        folded: false,
        reason: '当前页面无法确认一个能精确匹配这些元素的选择器，已取消折叠',
        suggestion,
      }
    }
    after = applyLoopElementsFold(before, suggestion, selector)
  }
  if (after === before) return { folded: false, reason: '折叠未产生变化', suggestion }

  draft.nodes = after.drawflow.nodes
  draft.edges = after.drawflow.edges
  // The tail anchors the next appended node. If it was one of the collapsed
  // iterations it no longer exists, so the loop that absorbed the run takes its
  // place; without this the next operator call would chain off a dead node.
  const ids = new Set(draft.nodes.map((node) => node.id))
  if (draft.tail && !ids.has(draft.tail)) {
    const loop = draft.nodes.find((node) => {
      const blockId = node.data?.['blockId']
      return blockId === 'loop-elements' || blockId === 'repeat-task'
    })
    draft.tail = loop?.id ?? draft.nodes.at(-1)?.id ?? null
  }
  if (draft.pendingBranch && !ids.has(draft.pendingBranch.source)) draft.pendingBranch = undefined
  remember(draft)
  await persistDraft(draft)
  return { folded: true, suggestion }
}
