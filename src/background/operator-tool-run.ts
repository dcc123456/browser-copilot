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

import { reliabilityLocatorOf, resolveRecordedLocator } from '../lib/workflow/target-to-selector'
import { selectorAfterExecution, selectorCandidatesOf } from '../lib/workflow/target-to-selector'
import type { RecordedLocator, SnapshotTargetEntry } from '../lib/workflow/target-to-selector'
import { countSelectorMatches } from './selector-probe'
import {
  beginSelectorTrace,
  commitSelectorTrace,
  markChosen,
  markExecuted,
  markProbed,
  markResolved,
} from './selector-trace'
import { BLOCK_BY_ID } from '../lib/workflow/blocks/palette'
import {
  formatRequirementRefusal,
  missingRequirements,
} from '../lib/workflow/block-requirements'
import {
  isOperatorTool,
  blockIdFromOperatorName,
  JAVASCRIPT_BLOCK_ID,
} from '../lib/workflow/operator-tools'
import { evaluateJsPermission } from '../lib/workflow/capability-gap'
import { operatorAuditCall } from '../lib/workflow/operator-history'
import { resolveNodeGoalContract } from '../lib/workflow/node-goal-instantiation'
import { withNodeGoalContract } from '../lib/workflow/node-goal-contract'

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
  aiPrefillPlanOf,
  appendOperatorNode,
  declareWorkflowInputs,
  declaredInputs,
  generatedFlagOf,
  hydrateDraft,
  insertAiPrefillNode,
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
 *
 * The reliability layer additionally saves the element's SEMANTIC identity
 * under `__reliability.locator` (spec §5.5): role/accessible name/test id —
 * meaning that survives DOM drift, not a positional path. The flat fields
 * stay untouched; the metadata is additive.
 */
function withLocator(
  args: Record<string, unknown>,
  locator: RecordedLocator | undefined,
  recorded?: { selector: string; verified: boolean },
): Record<string, unknown> {
  if (!locator) return args
  const { target, label } = locator
  // When post-execution evidence exists it decides the flat selector;
  // otherwise keep the resolved locator's selector (it still plays, even
  // unverified — the kernel's rich target is the fallback).
  const selector = recorded ? recorded.selector : locator.selector
  const verified = recorded ? recorded.verified : locator.verified
  const out: Record<string, unknown> = { ...args }
  delete out.ref
  if (selector) {
    out.selector = selector
    out.findBy = 'cssSelector'
  } else if (recorded) {
    // Post-execution explicitly chose the rich target: make sure a stale
    // selector from the raw args cannot linger ahead of it.
    delete out.selector
    delete out.findBy
  }
  if (target) out.target = target
  if (label && typeof out.label !== 'string') out.label = label
  if (typeof verified === 'boolean') out.selectorVerified = verified
  // Stamp the verified state onto the locator so the reliability metadata
  // reflects what really happened, not the pre-execution guess.
  const effectiveLocator: RecordedLocator = {
    ...locator,
    ...(selector ? { selector } : {}),
    ...(typeof verified === 'boolean' ? { verified } : {}),
  }
  const reliabilityLocator = reliabilityLocatorOf(effectiveLocator)
  if (reliabilityLocator) {
    const existing = out['__reliability']
    out['__reliability'] = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      locator: reliabilityLocator,
    }
  }
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
  // draft write, no partial node. The UNIFIED gate accepts either a documented
  // capabilityGap or a justification, so a valid gap can no longer be refused
  // by the stricter single-argument check.
  let justification: string | null = null
  if (blockId === JAVASCRIPT_BLOCK_ID) {
    const stepIntent =
      typeof args['description'] === 'string' ? (args['description'] as string) : ''
    const permission = evaluateJsPermission({ stepIntent, args })
    if (!permission.allowed) return { ok: false, error: permission.error }
    justification = permission.justification
  }

  const draft = await hydrateDraft(conversationId)
  draft.variables = draft.variables ?? {}

  const suppliedGoalContract = args['goalContract']
  const raw = stripDraftOnlyKeys(args)
  const resolved = resolveOperatorLocator(blockId, raw, snapshotTargets)

  // Begin the fine-grained selector trace immediately: even a refusal below
  // must leave evidence of the exact locator arguments the model sent.
  const trace = beginSelectorTrace({ conversationId, toolName: name, blockId, rawArgs: raw })
  if (resolved) {
    markResolved(trace, {
      selector: resolved.selector,
      hasTarget: resolved.target !== undefined,
      ...(resolved.label ? { label: resolved.label } : {}),
    })
  }

  // Probe the locator's CSS candidates against the live page BEFORE acting.
  // The probe is EVIDENCE now, not the decision: counts are carried into the
  // post-execution pick (see `selectorAfterExecution`), so the node records
  // what the kernel really clicked with rather than a pre-execution guess.
  // A locator with no CSS candidates (role/text only) is left untouched.
  const probeCandidates = resolved
    ? selectorCandidatesOf(resolved)
    : []
  const probeCounts = probeCandidates.length > 0
    ? await countSelectorMatches(probeCandidates, {
        ...(pinnedTab.has(conversationId) ? { tabId: pinnedTab.get(conversationId) } : {}),
        ...(scope ? { scope } : {}),
      })
    : null
  const locator: RecordedLocator | undefined =
    resolved && probeCounts
      ? { ...resolved, verified: undefined }
      : resolved
  if (probeCounts && locator) {
    markProbed(trace, probeCandidates, probeCounts)
  }

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
  // Read BEFORE the strip, same as `inputName`: the model's self-report on
  // whether it composed this fill's text itself. Drives the AI-prefill
  // insertion below (see `lib/workflow/ai-prefill`).
  const generated = generatedFlagOf(args)

  // Credentials resolved earlier in this session are merged in for execution
  // only — see `secretBags`.
  const bag = secretBagOf(conversationId)
  const variables: Record<string, unknown> = { ...draft.variables, ...bag.values }

  // A fill whose text the model COMPOSED itself must be produced by an
  // ai-agent node at replay, not frozen as a literal or an input default —
  // the same rule the history compiler applies to `fill` steps. The decision
  // runs before the bulk gate so a decided prefill skips it: the bulk gate
  // exists to stop page-read content, and `generated:true` is the model
  // asserting the opposite provenance for the one param (`forms.value`) this
  // decision covers.
  const plan = aiPrefillPlanOf(draft, blockId, data, generated, buildVariableIndex(draft.variables ?? {}, bag.keys))

  // A data literal this big, with nothing in the graph producing it, is content
  // the model read with its own tools and pasted in. Refused BEFORE the page is
  // touched: recording it would declare a workflow input whose default is the
  // generation-time snapshot, so the saved workflow would never fetch anything.
  // See `unproducedBulkData`. This runs BEFORE the required-parameter gate so a
  // pasted scrape in `save-local.value` gets the richer "record a producer"
  // refusal instead of the blunter "value must be a reference" one — both are
  // correct, the first is actionable.
  const unproduced =
    plan.kind === 'none'
      ? unproducedBulkData(blockId, data, buildVariableIndex(draft.variables ?? {}, bag.keys))
      : null
  if (unproduced) {
    const error = unproducedDataRefusal(blockId, unproduced)
    commitSelectorTrace(trace, { ok: false, error })
    return { ok: false, error }
  }

  // Required-parameter gate (see `lib/workflow/block-requirements`): a call a
  // block cannot work with is refused BEFORE anything runs — the empty-locator
  // `element-exists` that reported "元素不存在" and got recorded, the key-less
  // `press-key`, the url-less `webhook` all die here now. Runs on the
  // locator-merged `data` so a resolved `ref` counts as a locator.
  // `mustReference` params (save-local.value) are skipped: the literal may yet
  // be rewritten into a `{{reference}}`; the final gate below re-checks.
  const requirementProblems = missingRequirements(blockId, data, { skipMustReference: true })
  if (requirementProblems.length > 0) {
    const error = formatRequirementRefusal(blockName(blockId), requirementProblems)
    commitSelectorTrace(trace, { ok: false, error })
    return { ok: false, error }
  }

  const outcome = await executeOperatorNode(blockId, data, {
    signal,
    ...(scope ? { scope } : {}),
    ...(pinnedTab.has(conversationId) ? { tabId: pinnedTab.get(conversationId) } : {}),
    variables,
    setTab: (tabId) => pinnedTab.set(conversationId, tabId),
    ...(input.executors ? { executors: input.executors } : {}),
  })

  if (outcome.status === 'failed') {
    if (outcome.resolution) {
      markExecuted(trace, outcome.resolution)
    }
    const error = outcome.error ?? `${blockId} failed`
    commitSelectorTrace(trace, { ok: false, error })
    return { ok: false, error }
  }
  // Record-only (side-effect blocks during drafting): no live resolution.
  if (outcome.resolution) {
    markExecuted(trace, outcome.resolution)
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

  // Reconstruct the locator from what the kernel REALLY executed. The flat
  // selector on the recorded node must be the exact locator that worked —
  // when the executed spec had a CSS form it is recorded verbatim (never a
  // generic stand-in); role/text executions keep the rich target primary and
  // only adopt a proven-unique CSS candidate. Pre-execution probe counts
  // supply the evidence. When no probe ran (or no resolution was reported),
  // the locator stays as resolved.
  let recordedSelector: { selector: string; verified: boolean } | undefined
  if (locator && outcome.resolution) {
    const countOf = (selector: string): number => {
      const idx = probeCandidates.indexOf(selector)
      return idx >= 0 ? (probeCounts?.[idx] ?? 0) : 0
    }
    recordedSelector = selectorAfterExecution({
      usedSpec: outcome.resolution.usedSpec,
      locator,
      countOf,
    })
    markChosen(trace, recordedSelector)
  }

  // Rebuild the recorded data with the post-execution locator. `withLocator`
  // also strips a stale pre-execution selector when the node must rely on
  // the rich target.
  const locatedRedactedData = recordedSelector
    ? withLocator(redactedData, locator, recordedSelector)
    : redactedData

  // AI prefill: swap the composed literal for the producer's variable BEFORE
  // the rewrite, so the rewriter sees a reference (nothing to declare) instead
  // of declaring an input whose default freezes this conversation's copy. The
  // producer node itself is appended only after the final gate passes — a
  // refused call must not strand an orphaned ai-agent node in the draft. The
  // page was really filled with the composed text above; the draft records the
  // REPLAY plan, which regenerates the copy per run (the same semantics the
  // history compiler applies).
  const recordingData =
    plan.kind === 'none' ? locatedRedactedData : { ...locatedRedactedData, value: `{{${plan.variableName}}}` }

  // Business data must not be frozen at record time. Redaction runs FIRST so a
  // credential literal is already a `{{secret}}` reference by now and the
  // general rewriter cannot claim it (which would record a plain variable
  // reference where a credential reference belongs).
  const dynamic = rewriteForRecording(
    draft,
    blockId,
    recordingData,
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

  // Final required-parameter gate, on the POST-REWRITE data: a `mustReference`
  // literal the rewriter turned into a `{{reference}}` now passes, while one
  // the rewriter could not satisfy (nothing produces it) is refused here —
  // still before the node joins the graph. The pre-execution pass above
  // already refused everything rewrite-independent.
  const finalProblems = missingRequirements(blockId, recorded)
  if (finalProblems.length > 0) {
    const error = formatRequirementRefusal(blockName(blockId), finalProblems)
    commitSelectorTrace(trace, { ok: false, error })
    return { ok: false, error }
  }

  // The producer joins the chain first, so the forms node below wires from it.
  insertAiPrefillNode(draft, plan)

  // Attach the Node Goal Contract to the recorded data so every recorded node
  // carries a structured goal. A model-supplied contract wins; otherwise it is
  // instantiated from the operator default and the call arguments. Engine-
  // interpreted nodes keep their own shape.
  const goalContract = resolveNodeGoalContract(blockId, data, suppliedGoalContract)
  const dataWithGoal = goalContract ? withNodeGoalContract(recorded, goalContract) : recorded

  // The node joins the chain through whatever port the PREVIOUS block left
  // pending (or the tail's first output). `appendOperatorNode` consumes that.
  const appended = appendOperatorNode(draft, blockId, dataWithGoal)

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
  // Ensure the trace carries the locator the node actually recorded, even
  // when the executor reported no live resolution (record-only / mock):
  // read it back off the final recorded data.
  if (!trace.chosen && typeof recorded['selector'] === 'string' && recorded['selector']) {
    markChosen(trace, {
      selector: recorded['selector'] as string,
      verified: recorded['selectorVerified'] === true,
    })
  }
  commitSelectorTrace(trace, { ok: true })
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
    // History records what the page actually received: for a prefill fill that
    // is the composed literal, not the `{{aiFillN}}` the recorded node carries
    // — so a later history compile still recognizes the step as composed copy
    // and inserts its own prefill producer.
    audit: operatorAuditCall(
      blockId,
      plan.kind === 'none' ? recorded : { ...recorded, value: plan.fillValue },
    ),
  }
}

/** Display name of a block, for gate refusals. */
function blockName(blockId: string): string {
  return BLOCK_BY_ID.get(blockId)?.name ?? blockId
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
