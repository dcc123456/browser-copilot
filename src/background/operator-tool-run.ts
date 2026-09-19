/**
 * Run one workflow-operator tool call: resolve → execute → record.
 *
 * The ordering is the point. A node is appended ONLY after the block ran
 * successfully against the live page, so the recorded graph cannot contain a
 * step that never worked — a failed click leaves the draft untouched and
 * returns the error to the model to fix.
 *
 * Kept separate from `operator-tool-handler` (which owns the graph) and from
 * `agent.ts` (which owns the tool loop) so neither has to import the other:
 * this module takes primitives, not a `ToolContext`.
 *
 * @module background/operator-tool-run
 */

import { resolveRecordedLocator } from '../lib/workflow/target-to-selector'
import type { RecordedLocator, SnapshotTargetEntry } from '../lib/workflow/target-to-selector'
import { verifyRecordedSelector } from './selector-probe'
import { BLOCK_BY_ID } from '../lib/workflow/blocks/palette'
import {
  isOperatorTool,
  blockIdFromOperatorName,
  JAVASCRIPT_BLOCK_ID,
  SCRIPT_REFUSAL,
  scriptJustification,
} from '../lib/workflow/operator-tools'
import { operatorAuditCall } from '../lib/workflow/operator-history'
import {
  buildSecretIndex,
  redactRecordedParams,
  credentialFillPath,
} from '../lib/workflow/secret-guard'
import {
  buildVariableIndex,
  rewriteDataParams,
  unproducedBulkData,
  unproducedDataRefusal,
  type DataRewrite,
} from '../lib/workflow/dynamic-data'
import type { WorkflowDraft } from '../lib/workflow/draft-types'
import type { ScopeWindow } from './automation-scope'
import {
  appendOperatorNode,
  declareWorkflowInputs,
  declaredInputs,
  hydrateDraft,
  outputSuffixOf,
  persistDraft,
  stripDraftOnlyKeys,
  TRIGGER_BLOCK_ID,
} from './operator-tool-handler'
import { executeOperatorNode } from './workflow-engine/operator-exec'
import type { BlockExecutor } from './workflow-engine/executors'
import { resolveAutomationTab } from './driver'

/**
 * Pinned tab per conversation. Navigation blocks report the tab they opened so
 * later steps follow the right page instead of whatever is active. In-memory on
 * purpose: after a worker restart the driver re-resolves the active tab, which
 * is the correct fallback.
 */
const pinnedTab = new Map<string, number>()

/**
 * Credentials resolved during this generation session, per conversation.
 *
 * Deliberately NOT part of the draft. The draft is mirrored to extension
 * storage and rendered in the review card, and a credential value has no
 * business in either. Keeping it here also means the value can never be
 * serialised into a tool result by accident — nothing reads this map except
 * the executor call below.
 *
 * Losing it on a worker restart is correct, not a bug: the model re-resolves
 * the credential BY NAME, and the `{{variable}}` references already recorded
 * in the graph still resolve at replay time.
 */
interface SecretBag {
  values: Record<string, unknown>
  keys: Set<string>
}

const secretBags = new Map<string, SecretBag>()
const SECRET_BAG_CAP = 64

function secretBagOf(conversationId: string): SecretBag {
  const existing = secretBags.get(conversationId)
  if (existing) return existing
  const bag: SecretBag = { values: {}, keys: new Set() }
  secretBags.set(conversationId, bag)
  while (secretBags.size > SECRET_BAG_CAP) {
    const oldest = secretBags.keys().next().value
    if (oldest === undefined || oldest === conversationId) break
    secretBags.delete(oldest)
  }
  return bag
}

/**
 * Drop a conversation's resolved credentials. Called when its draft is cleared
 * (the workflow was saved or discarded), so a value does not outlive the
 * generation that resolved it.
 */
export function forgetGenerationSecrets(conversationId: string): void {
  secretBags.delete(conversationId)
}

/** Does this block read an element from the page? */
export function blockTakesElement(blockId: string): boolean {
  const entry = BLOCK_BY_ID.get(blockId)
  if (!entry) return false
  return (entry.refDataKeys ?? []).includes('selector')
}

/** Did the caller give us anything we could turn into a locator? */
function hasLocatorInput(args: Record<string, unknown>): boolean {
  return (
    typeof args.ref === 'string' ||
    typeof args.target === 'object' ||
    typeof args.selector === 'string'
  )
}

/**
 * Resolve the element this call targets, or undefined when the block does not
 * read one. Exported so the credential gate can inspect the target's `type`
 * BEFORE anything runs.
 */
export function resolveOperatorLocator(
  blockId: string,
  args: Record<string, unknown>,
  snapshotTargets?: ReadonlyMap<string, SnapshotTargetEntry>,
): RecordedLocator | undefined {
  if (!blockTakesElement(blockId) || !hasLocatorInput(args)) return undefined
  return resolveRecordedLocator(args, snapshotTargets)
}

export interface OperatorRunInput {
  name: string
  args: Record<string, unknown>
  conversationId: string
  /** The run's `ref` → target cache, from the agent's tool context. */
  snapshotTargets?: ReadonlyMap<string, SnapshotTargetEntry>
  scope?: ScopeWindow
  signal: AbortSignal
  /** Executor registry override, for tests. */
  executors?: Record<string, BlockExecutor>
}

export type OperatorRunResult =
  | {
      ok: true
      nodeId: string
      workflowSize: number
      /** False when the block was recorded without running (see `note`). */
      executed: boolean
      /** Why the block was not run, or which branch it took. */
      note?: string
      branch?: string
      /**
       * True when a credential literal in the parameters was replaced by its
       * `{{variable}}` reference before the node was recorded. The call still
       * succeeded; the model is told so it knows the node holds a reference.
       */
      secretRedacted?: true
      /**
       * Names of `secret` trigger inputs created this call from a chat-typed
       * credential literal (e.g. a password field). The credential now lives in
       * the trigger variable set and is referenceable via `{{name}}` at replay.
       */
      secretInputs?: string[]
      /**
       * What the "no dead data" rewrite did to this node's parameters: which
       * literals became `{{reference}}`s, and which workflow inputs had to be
       * declared on the trigger. Surfaced to the model so it can reference the
       * inputs it now owns instead of re-typing the literal next time.
       */
      dynamicData?: { rewrites: DataRewrite[]; declared: string[] }
      /**
       * The reason the model gave for using the escape hatch. Present only for
       * `javascript-code`, which is refused outright without one.
       */
      scriptJustification?: string
      /**
       * What the action history should record. The action name is the raw
       * browser action the operator performed (so the History tab reads
       * naturally and the history→workflow path still compiles), and the args
       * are the RESOLVED, redacted parameters — a history step carrying the
       * model's stale `ref` instead of a selector would be useless.
       */
      audit: { action: string; args: Record<string, unknown> }
    }
  | { ok: false; error: string }

/**
 * Merge the resolved element locator into the node's parameters. The canonical
 * shape is a flat `selector` plus `findBy`, with the rich `target` kept
 * alongside so the kernel can still fall back to role/text specs when no CSS
 * selector can express the element. A verified locator also stamps
 * `selectorVerified`, and an unverified one that lost its CSS candidate
 * records NO selector at all — the rich target becomes the replay's primary.
 */
function withLocator(
  args: Record<string, unknown>,
  locator: RecordedLocator | undefined,
): Record<string, unknown> {
  if (!locator) return args
  const { selector, target, label, verified } = locator
  const out: Record<string, unknown> = { ...args }
  delete out.ref
  if (selector) {
    out.selector = selector
    out.findBy = 'cssSelector'
  }
  if (target) out.target = target
  if (label && typeof out.label !== 'string') out.label = label
  if (typeof verified === 'boolean') out.selectorVerified = verified
  return out
}

/**
 * Replace every business literal with a `{{reference}}` and declare whatever
 * input the graph cannot produce on its own.
 *
 * Two sources, in order: a value an upstream step already wrote into the
 * session's variables becomes `{{thatVariable}}` (so the replay re-reads the
 * page); anything else becomes a declared workflow input on the trigger, with
 * the observed literal as its `defaultValue`.
 *
 * Credential variables are excluded from the index: `secret-guard` owns those
 * and has already rewritten them by the time this runs.
 */
function rewriteForRecording(
  draft: WorkflowDraft,
  blockId: string,
  data: Record<string, unknown>,
  secretKeys: ReadonlySet<string>,
  nameHint: string,
  secretPaths?: ReadonlySet<string>,
): {
  data: Record<string, unknown>
  declared: string[]
  rewrites: DataRewrite[]
  secretCaptured: string[]
} {
  const result = rewriteDataParams({
    blockId,
    data,
    variableIndex: buildVariableIndex(draft.variables ?? {}, secretKeys),
    declared: declaredInputs(draft),
    ...(nameHint ? { nameHint } : {}),
    ...(secretPaths ? { secretPaths } : {}),
  })
  const declared = declareWorkflowInputs(draft, result.newInputs)
  const secretCaptured = secretPaths
    ? declared.filter((name) => result.newInputs.some((i) => i.secret && i.name === name))
    : []
  return { data: result.data, declared, rewrites: result.rewrites, secretCaptured }
}

/**
 * Execute one operator tool call and, on success, append its node.
 *
 * @returns the new node's id and the draft's action-node count, or the error
 *   the model should react to.
 */ export async function runOperatorToolWithExecution(
  input: OperatorRunInput,
): Promise<OperatorRunResult> {
  const { name, args, conversationId, snapshotTargets, scope, signal } = input
  if (!isOperatorTool(name)) return { ok: false, error: `Unknown operator tool: ${name}` }
  const blockId = blockIdFromOperatorName(name)
  if (!blockId) return { ok: false, error: `Bad operator tool name: ${name}` }

  // The escape hatch is gated before anything else happens — no page touch, no
  // draft write, no partial node. See `scriptJustification`.
  const justification = blockId === JAVASCRIPT_BLOCK_ID ? scriptJustification(args) : null
  if (blockId === JAVASCRIPT_BLOCK_ID && !justification) {
    return { ok: false, error: SCRIPT_REFUSAL }
  }

  const draft = await hydrateDraft(conversationId)
  draft.variables = draft.variables ?? {}

  const raw = stripDraftOnlyKeys(args)
  const resolved = resolveOperatorLocator(blockId, raw, snapshotTargets)
  // Verify the locator against the live page BEFORE acting: the candidate CSS
  // selectors are counted in one injection, and the one matching exactly one
  // element becomes the recorded `selector`. A locator nobody probed is kept
  // as-is, so a refusal to inject can never degrade a working call.
  const locator = await verifyRecordedSelector(resolved, {
    ...(pinnedTab.has(conversationId) ? { tabId: pinnedTab.get(conversationId) } : {}),
    ...(scope ? { scope } : {}),
  })

  // Credential capture: a literal aimed at a password field is a user-typed
  // account/password from chat. Instead of refusing it (the old policy), we
  // persist it as a `secret` trigger input and record `{{name}}` — so the
  // generated workflow can replay the login without re-entering the credential.
  // The live page is still driven with the real literal below.
  const credentialPath = credentialFillPath({ blockId, data: raw, targetType: locator?.type })
  const secretPaths = credentialPath ? new Set([JSON.stringify(credentialPath)]) : undefined

  const data = withLocator(raw, locator)
  const explicitBranch = outputSuffixOf(args['next'])
  // Read BEFORE `stripDraftOnlyKeys` removed it: the model's name for an input
  // it knows the purpose of ("keyword") beats a name derived from the block.
  const inputHint = typeof args['inputName'] === 'string' ? args['inputName'].trim() : ''

  // Credentials resolved earlier in this session are merged in for execution
  // only — see `secretBags`.
  const bag = secretBagOf(conversationId)
  const variables: Record<string, unknown> = { ...draft.variables, ...bag.values }

  // A data literal this big, with nothing in the graph producing it, is content
  // the model read with its own tools and pasted in. Refused BEFORE the page is
  // touched: recording it would declare a workflow input whose default is the
  // generation-time snapshot, so the saved workflow would never fetch anything.
  // See `unproducedBulkData`.
  const unproduced = unproducedBulkData(
    blockId,
    data,
    buildVariableIndex(draft.variables ?? {}, bag.keys),
  )
  if (unproduced) return { ok: false, error: unproducedDataRefusal(blockId, unproduced) }

  const outcome = await executeOperatorNode(blockId, data, {
    signal,
    ...(scope ? { scope } : {}),
    ...(pinnedTab.has(conversationId) ? { tabId: pinnedTab.get(conversationId) } : {}),
    variables,
    setTab: (tabId) => pinnedTab.set(conversationId, tabId),
    ...(input.executors ? { executors: input.executors } : {}),
  })

  if (outcome.status === 'failed') {
    return { ok: false, error: outcome.error ?? `${blockId} failed` }
  }

  // Remember the page this session first acted on (B2 of the first-run plan).
  // A graph with no navigation before its first element action can only replay
  // on THAT page, so the save card and the run gate need to know it. Only
  // http(s) pages are automatable — anything else would poison the warning.
  if (!draft.originUrl && blockTakesElement(blockId)) {
    const tab = await resolveAutomationTab(
      pinnedTab.has(conversationId) ? pinnedTab.get(conversationId) : undefined,
      scope,
    ).catch(() => undefined)
    const url = typeof tab?.url === 'string' ? tab.url : ''
    if (/^https?:/i.test(url)) draft.originUrl = url
  }

  // Harvest the executor's writes. `get-secret` is the only block that pulls a
  // credential in, so its output variable is the only key that must stay out
  // of the persisted draft.
  if (blockId === 'get-secret') {
    const variableName = typeof data['variableName'] === 'string' ? data['variableName'].trim() : ''
    if (variableName && variableName in variables) bag.keys.add(variableName)
  }
  for (const key of bag.keys) {
    if (key in variables) bag.values[key] = variables[key]
    else bag.keys.delete(key)
  }
  for (const [key, value] of Object.entries(variables)) {
    if (bag.keys.has(key)) delete draft.variables[key]
    else draft.variables[key] = value
  }

  // A node records a `{{variable}}` reference, never a credential literal —
  // even when the model passed one, and even for a field we cannot classify.
  const index = buildSecretIndex(bag.values, bag.keys)
  const { data: redactedData, redacted } = redactRecordedParams(data, index)

  // Business data must not be frozen at record time. Redaction runs FIRST so a
  // credential literal is already a `{{secret}}` reference by now and the
  // general rewriter cannot claim it (which would record a plain variable
  // reference where a credential reference belongs).
  const dynamic = rewriteForRecording(
    draft,
    blockId,
    redactedData,
    bag.keys,
    inputHint,
    secretPaths,
  )

  // Why this script exists is the one thing a maintainer needs, and the canvas
  // card renders `data.description`. When the model wrote its own description,
  // that wins; otherwise the justification becomes it, so the reason travels
  // with the saved workflow instead of dying with the conversation.
  const recorded =
    justification && !hasDescription(dynamic.data)
      ? { ...dynamic.data, description: justification }
      : dynamic.data

  // The node joins the chain through whatever port the PREVIOUS block left
  // pending (or the tail's first output). `appendOperatorNode` consumes that.
  const appended = appendOperatorNode(draft, blockId, recorded)

  // Which port THIS block routes the next node through. An executed branch
  // block reports the port it actually took — that is the truth, and it is
  // what makes "record only the path taken" work without the model having to
  // declare it. Otherwise the model's `next` hint is honoured.
  const output = outcome.branch ? suffixOfBranch(outcome.branch) : (explicitBranch ?? null)

  // `wf_op_trigger` is exempt from the chain cursor: it edits the head node in
  // place (see `appendOperatorNode`), so it must neither consume nor set it.
  // Honouring its `next` would wire the following node from the trigger and
  // orphan the real tail.
  if (blockId !== TRIGGER_BLOCK_ID) {
    draft.pendingBranch = output
      ? { source: appended.nodeId, sourceBlockId: blockId, output }
      : undefined
  }

  const nameHint = typeof args['workflowName'] === 'string' ? args['workflowName'].trim() : ''
  if (nameHint && draft.name.startsWith('workflow-')) draft.name = nameHint

  await persistDraft(draft)

  const executed = outcome.status === 'executed'
  const note = outcome.note ?? (output ? `next node attaches to ${output}` : undefined)
  return {
    ok: true,
    nodeId: appended.nodeId,
    workflowSize: appended.workflowSize,
    executed,
    ...(note ? { note } : {}),
    ...(output ? { branch: output } : {}),
    ...(redacted ? { secretRedacted: true as const } : {}),
    ...(dynamic.secretCaptured.length > 0 ? { secretInputs: dynamic.secretCaptured } : {}),
    ...(dynamic.rewrites.length > 0 || dynamic.declared.length > 0
      ? { dynamicData: { rewrites: dynamic.rewrites, declared: dynamic.declared } }
      : {}),
    ...(justification ? { scriptJustification: justification } : {}),
    audit: operatorAuditCall(blockId, recorded),
  }
}

/** Does this node already carry a human-written description? */
function hasDescription(data: Record<string, unknown>): boolean {
  const value = data['description']
  return typeof value === 'string' && value.trim() !== ''
}

/** Map a semantic branch name onto its port suffix. */
function suffixOfBranch(branch: string): string {
  switch (branch) {
    case 'true':
    case 'exists':
    case 'loop':
      return 'output-1'
    case 'false':
    case 'notExists':
    case 'end':
      return 'output-2'
    default:
      return 'output-1'
  }
}
