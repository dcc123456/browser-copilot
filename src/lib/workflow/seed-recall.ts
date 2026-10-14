/**
 * Seed recall — hand the model proven step evidence from a workflow that has
 * ALREADY verified against its own goal, so a fresh generation stops re-guessing
 * locators, waits and node goals it (or a previous session) already proved.
 *
 * The invariant this module is built around: a seed is an OFFER, never a draft.
 * Nothing here appends a node. The model must still call `wf_op_<blockId>` with
 * the seeded arguments and the live page must accept it — which is why only
 * `selector` / `target` are offered and a snapshot `ref` never is (a ref dies
 * with its session, while an inline selector executes without a snapshot —
 * see `background/operator-tool-run` `resolveOperatorLocator`).
 *
 * Eligibility is deliberately narrow: `certificationStatus === 'certified'` is
 * the only persisted proof of a takeover-free run that achieved its goal
 * (`docs/ai-debug-success-rate-v3.md` §4.1). A badge is not enough on its own —
 * the newest counted run must not have failed, because "certified months ago,
 * broken yesterday" is exactly how a stale seed poisons a good generation.
 *
 * Pure module: no `chrome`, no storage, no I/O — callers pass workflows and run
 * logs in as plain arrays.
 *
 * @module lib/workflow/seed-recall
 */

import type { TaskRunLog } from '../scheduler-types'
import { semanticActionsOfBlock } from './block-capabilities'
import type { SemanticLocator } from './element-fingerprint'
import { nodeGoalContractOf } from './node-goal-contract'
import { originOfUrl, pageContextOf } from './page-context'
import { goalSpecOf, nodeReliabilityOf } from './reliability'
import {
  isCredentialFieldType,
  isInterpolationReference,
  VALUE_FILL_BLOCK_IDS,
} from './secret-guard'
import { detectSemanticIntents } from './semantic-intent'
import { richTargetFromArgs, selectorFromArgs } from './target-to-selector'
import { newestCountedRunOf, summarizeWorkflowHealth } from './workflow-health'
import type { Workflow, WorkflowNode } from './types'

/** Hard cap on the rendered offer: it rides a tool result and is re-sent every
 * round of a turn that can run to 40 rounds, so this is a real cost, not a
 * courtesy limit. */
export const SEED_OFFER_MAX_CHARS = 3072
/** Steps offered per candidate workflow. */
export const SEED_MAX_STEPS = 8
/** Candidates offered at all — two is enough to choose from and keeps the
 * model from treating the offer as a menu to explore. */
export const SEED_MAX_CANDIDATES = 2
/** A certified workflow nobody has re-exercised for this long is a guess. */
export const SEED_MAX_AGE_DAYS = 90

/** Offered only when a site signal fired. */
export const SEED_FLOOR_WITH_SITE = 0.45
/** Offered on text alone only when the match is overwhelming — reached by a goal
 * that re-states the saved workflow's own words (near-verbatim lexical coverage
 * plus intent agreement), not by a topic that merely rhymes. This is what keeps
 * a Xiaohongshu seed out of a GitHub task when no site hint is available. */
export const SEED_FLOOR_TEXT_ONLY = 0.6

const WEIGHTS = {
  primaryOrigin: 0.4,
  secondarySite: 0.25,
  intentMax: 0.25,
  /** The goal-side lexical overlap carries the text-only path on its own, so it
   * gets the authority the vocabulary deserves; the floor below is what keeps it
   * from carrying a coincidence. */
  lexiconMax: 0.35,
  capabilityMax: 0.1,
  recencyMax: 0.05,
} as const

/** Node `data` keys that are generation bookkeeping, not `wf_op_*` arguments. */
const NON_ARG_DATA_KEYS: ReadonlySet<string> = new Set<string>([
  'blockId',
  'description',
  'notes',
  'comment',
  'selectorVerified',
  '__reliability',
  '__workflowAi',
  'next',
  'workflowName',
  'inputName',
  'generated',
  'justification',
  'capabilityGap',
  'goalContract',
])

const MAX_SELECTOR_CHARS = 200
const MAX_GOAL_CHARS = 160
const MAX_LITERAL_CHARS = 120
const MAX_CRITERIA_PER_STEP = 2
/** Intents count only when they fire strongly enough to mean something, the
 * same floor `operator-discovery` uses. */
const INTENT_MIN_SCORE = 0.4
/** Below this many shared tokens the overlap is a coincidence: two-word Chinese
 * goals share a bigram with almost anything. */
const MIN_SHARED_TOKENS = 3

/** One replayable step of a recalled workflow. */
export interface SeedStep {
  blockId: string
  /** The node's instantiated goal, when it carries a node goal contract. */
  goal?: string
  /** Machine-verifiable facts the recorded step declared, capped and compact. */
  successCriteria?: unknown[]
  /** Recorded CSS selector — replayable without a live snapshot. */
  selector?: string
  /** Recorded rich target (role/name/text identity), replayable as-is. */
  target?: unknown
  /** Semantic identity recorded with the element, when one was observed. */
  semantic?: SemanticLocator
  /** Remaining recorded arguments, after the credential and literal scrub. */
  params?: Record<string, unknown>
  /** Parameter names dropped because they are credential-bearing. */
  droppedCredentialFields?: string[]
}

/** One ranked candidate workflow. */
export interface SeedCandidate {
  workflowId: string
  workflowName: string
  score: number
  siteMatch: boolean
  /** Evidence behind the score, phrased as facts the model can check. */
  why: string[]
  steps: SeedStep[]
}

export interface SeedRecallInput {
  workflows: readonly Workflow[]
  runs: readonly TaskRunLog[]
  /** The new task's goal summary — the strongest intent signal available. */
  goalSummary: string
  requiredCapabilities?: readonly string[]
  /** Origins or urls the new task is about; may be EMPTY, because the origin is
   * genuinely unknown before the first page-touching operator runs. */
  siteHints?: readonly string[]
  /** Injectable for deterministic tests. */
  now?: number
}

/** The rendered offer, exactly as it goes into the tool result. */
export interface SeedOffer {
  workflowId: string
  workflowName: string
  siteMatch: boolean
  why: string[]
  steps: SeedStep[]
}

const DAY_MS = 86_400_000

// --- site identity ---------------------------------------------------------------

/**
 * Both comparable forms of a site reference: the parsed origin, and the bare
 * host. A `visit-web` trigger pattern (`*://creator.xiaohongshu.com/*`) is not a
 * URL, so `originOfUrl` alone would drop the one site signal the workflow states
 * explicitly; the host form is what lets that pattern meet a hint halfway.
 */
function siteKeys(values: readonly string[]): Set<string> {
  const keys = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    const origin = originOfUrl(trimmed)
    if (origin) keys.add(origin.toLowerCase())
    const host = trimmed.match(/\/\/([^/*?#:]+)|^([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i)
    const bare = host?.[1] ?? host?.[2]
    if (bare) keys.add(bare.toLowerCase())
  }
  return keys
}

/** The sites a saved workflow is known to belong to, from persisted facts only. */
function siteOf(workflow: Workflow): { primary: string[]; secondary: string[] } {
  const context = pageContextOf(workflow)
  const primary: string[] = []
  if (context?.origin) primary.push(context.origin)
  if (workflow.settings?.generationOriginUrl) primary.push(workflow.settings.generationOriginUrl)
  const secondary: string[] = [...(context?.additionalOrigins ?? [])]
  const pattern = workflow.trigger?.urlPattern
  if (typeof pattern === 'string') secondary.push(pattern)
  return { primary, secondary }
}

function siteSignal(
  workflow: Workflow,
  hintKeys: ReadonlySet<string>,
): { tier: 'primary' | 'secondary' } | undefined {
  if (hintKeys.size === 0) return undefined
  const { primary, secondary } = siteOf(workflow)
  if (siteKeys(primary).size && [...siteKeys(primary)].some((key) => hintKeys.has(key)))
    return { tier: 'primary' }
  if (siteKeys(secondary).size && [...siteKeys(secondary)].some((key) => hintKeys.has(key)))
    return { tier: 'secondary' }
  return undefined
}

/**
 * A workflow that records WHICH SITE it belongs to and records a site the task
 * is not about is evidence AGAINST, not merely evidence-less: its locators were
 * proven on another page, and a near-identical goal wording is exactly how a
 * Xiaohongshu seed walks into a GitHub task. A workflow with no recorded site at
 * all is unknown rather than contradicting, so it still competes on text.
 */
function siteConflicts(workflow: Workflow, hintKeys: ReadonlySet<string>): boolean {
  if (hintKeys.size === 0) return false
  const { primary, secondary } = siteOf(workflow)
  const recorded = new Set([...siteKeys(primary), ...siteKeys(secondary)])
  if (recorded.size === 0) return false
  for (const key of recorded) if (hintKeys.has(key)) return false
  return true
}

// --- text similarity -------------------------------------------------------------

/** Lowercase latin words plus CJK bigrams: enough overlap to tell 发布笔记 from
 * 导出表格 without a lexicon of its own (the intents vocabulary is control-flow,
 * so it carries no domain words). */
function lexiconOf(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]{2,}/g)) tokens.add(match[0])
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / new Set([...a, ...b]).size
}

/**
 * How much of the NEW goal the saved workflow already speaks for.
 *
 * Jaccard is the wrong measure here: the saved side carries its description and
 * plan on top of its goal, so a verbatim re-run of the same task scores low for
 * reasons that have nothing to do with similarity. Measuring from the goal side
 * gets both degenerate directions right on its own — a short goal covered by a
 * long saved text counts, a verbose goal only partly covered by a terse saved
 * summary does not — and the shared-token floor is what stops two-word goals
 * from claiming a hit on a coincidental bigram.
 */
function goalCoverage(goal: ReadonlySet<string>, saved: ReadonlySet<string>): number {
  if (goal.size === 0 || saved.size === 0) return 0
  let shared = 0
  for (const token of goal) if (saved.has(token)) shared += 1
  if (shared < MIN_SHARED_TOKENS) return 0
  return Math.min(1, shared / goal.size)
}

function strongIntents(text: string): Set<string> {
  return new Set(
    detectSemanticIntents(text)
      .filter((detected) => detected.score >= INTENT_MIN_SCORE)
      .map((detected) => detected.intent),
  )
}

// --- step extraction -------------------------------------------------------------

function isActionNode(node: WorkflowNode): boolean {
  const blockId = typeof node?.data?.blockId === 'string' ? node.data.blockId : ''
  return Boolean(blockId) && blockId !== 'trigger'
}

/** Recorded arguments minus bookkeeping, after the credential/literal scrub. */
function scrubbedParams(
  blockId: string,
  data: Record<string, unknown>,
): { params: Record<string, unknown>; droppedCredentialFields: string[] } {
  const params: Record<string, unknown> = {}
  const droppedCredentialFields: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (NON_ARG_DATA_KEYS.has(key)) continue
    if (key === 'selector' || key === 'cssSelector' || key === 'target') continue
    params[key] = scrubValue(value, key, droppedCredentialFields, blockId)
  }
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key]
  return { params, droppedCredentialFields }
}

function scrubValue(
  value: unknown,
  key: string,
  droppedCredentialFields: string[],
  blockId: string,
): unknown {
  if (typeof value === 'string') {
    // A `{{reference}}` is offered verbatim: it cannot freeze generation-time
    // data, and the model's own variable is what resolves it.
    if (isInterpolationReference(value)) return value
    if (value.length > MAX_LITERAL_CHARS) return undefined
    return value
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => scrubValue(item, key, droppedCredentialFields, blockId))
      .filter((item) => item !== undefined)
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // Form items carry their own field type; a credential-typed one is never
    // offered as a literal whatever the recording path redacted.
    if (VALUE_FILL_BLOCK_IDS.has(blockId) && isCredentialFieldType(stringOf(record['type']))) {
      const { value: _dropped, ...rest } = record
      droppedCredentialFields.push(stringOf(rest['name']) || key)
      return rest
    }
    const cleaned: Record<string, unknown> = {}
    for (const [nestedKey, nestedValue] of Object.entries(record)) {
      const scrubbed = scrubValue(nestedValue, nestedKey, droppedCredentialFields, blockId)
      if (scrubbed !== undefined) cleaned[nestedKey] = scrubbed
    }
    return cleaned
  }
  return value
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function seedStepsOf(workflow: Workflow): SeedStep[] {
  const steps: SeedStep[] = []
  for (const node of workflow.drawflow?.nodes ?? []) {
    if (!isActionNode(node)) continue
    const blockId = typeof node.data?.blockId === 'string' ? node.data.blockId : ''
    const data = (node.data ?? {}) as Record<string, unknown>
    const selector = selectorFromArgs(data)
    const target = richTargetFromArgs(data)
    const contract = nodeGoalContractOf(data)
    const reliability = nodeReliabilityOf(node)

    const step: SeedStep = { blockId }
    if (selector.trim()) step.selector = selector.slice(0, MAX_SELECTOR_CHARS)
    if (target !== undefined) step.target = target
    if (reliability?.locator?.semantic) step.semantic = reliability.locator.semantic
    if (contract?.goal?.trim()) step.goal = contract.goal.slice(0, MAX_GOAL_CHARS)
    if (contract?.successCriteria?.length)
      step.successCriteria = contract.successCriteria.slice(0, MAX_CRITERIA_PER_STEP)

    const { params, droppedCredentialFields } = scrubbedParams(blockId, data)
    if (Object.keys(params).length > 0) step.params = params
    if (droppedCredentialFields.length > 0) step.droppedCredentialFields = droppedCredentialFields

    // A step with neither a replayable locator nor any argument is a node id
    // and nothing else — offering it would tell the model nothing.
    if (step.selector === undefined && step.target === undefined && !step.params) continue
    steps.push(step)
  }
  return steps
}

/** Offerable means there is a RECORDED LOCATION to reuse: a step that carries
 * neither a selector nor a rich target tells the model nothing it would not
 * re-derive from a snapshot, and a graph of pure bookkeeping nodes is not a seed. */
function hasOfferableContent(workflow: Workflow): boolean {
  return seedStepsOf(workflow).some(
    (step) => step.selector !== undefined || step.target !== undefined,
  )
}

// --- ranking ---------------------------------------------------------------------

interface ScoredCandidate {
  workflow: Workflow
  score: number
  siteMatch: boolean
  why: string[]
}

function scoreCandidate(
  workflow: Workflow,
  input: SeedRecallInput,
  hintKeys: ReadonlySet<string>,
  goalIntents: ReadonlySet<string>,
  goalLexicon: ReadonlySet<string>,
  now: number,
): ScoredCandidate {
  const reasons: string[] = []
  let score = 0

  const signal = siteSignal(workflow, hintKeys)
  if (signal) {
    const weight = signal.tier === 'primary' ? WEIGHTS.primaryOrigin : WEIGHTS.secondarySite
    score += weight
    const { primary, secondary } = siteOf(workflow)
    const matched = signal.tier === 'primary' ? primary : secondary
    reasons.push(`site:${siteKeys(matched).values().next().value ?? 'matched'}`)
  }

  const saved = [
    goalSpecOf(workflow)?.summary ?? '',
    workflow.description ?? '',
    workflow.plan ?? '',
  ].join(' ')

  const intentOverlap = jaccard(goalIntents, strongIntents(saved))
  if (intentOverlap > 0) {
    score += Math.min(WEIGHTS.intentMax, intentOverlap * 0.35)
    reasons.push(`intents:${Math.round(intentOverlap * 100)}%`)
  }

  const lexicalCoverage = goalCoverage(goalLexicon, lexiconOf(saved))
  if (lexicalCoverage > 0) {
    score += Math.min(WEIGHTS.lexiconMax, lexicalCoverage * 0.5)
    reasons.push(`goal-words:${Math.round(lexicalCoverage * 100)}%`)
  }

  const required = new Set(input.requiredCapabilities ?? [])
  if (required.size > 0) {
    const blockIds = new Set(
      (workflow.drawflow?.nodes ?? []).map((node) =>
        typeof node?.data?.blockId === 'string' ? node.data.blockId : '',
      ),
    )
    const actions = new Set<string>()
    for (const blockId of blockIds) actions.add(blockId)
    for (const blockId of blockIds)
      semanticActionsOfBlock(blockId).forEach((action) => actions.add(action))
    const matched = [...required].filter((capability) => actions.has(capability))
    if (matched.length > 0) {
      score += Math.min(WEIGHTS.capabilityMax, matched.length * 0.05)
      reasons.push(`capabilities:${matched.join(',')}`)
    }
  }

  const health = summarizeWorkflowHealth(input.runs, workflow.id)
  const ageDays = (now - workflow.updatedAt) / DAY_MS
  if (health.lastVerifiedAt) {
    const sinceDays = (now - health.lastVerifiedAt) / DAY_MS
    if (sinceDays <= 30) {
      score += WEIGHTS.recencyMax
      reasons.push('verified:<30d')
    }
  } else if (ageDays <= 30) {
    score += WEIGHTS.recencyMax
    reasons.push('saved:<30d')
  }

  return {
    workflow,
    score: Number(Math.min(1, score).toFixed(4)),
    siteMatch: Boolean(signal),
    why: reasons,
  }
}

/**
 * Rank saved workflows as seed candidates.
 *
 * Exclusion order matters: eligibility is checked before scoring so a
 * uncertified graph cannot earn its way in on a keyword match, and the poison
 * guard reads the run window rather than the badge.
 */
export function rankWorkflowSeeds(input: SeedRecallInput): SeedCandidate[] {
  const now = input.now ?? Date.now()
  const goalText = input.goalSummary.trim()
  if (!goalText) return []
  const hintKeys = siteKeys(input.siteHints ?? [])

  const eligible = (input.workflows ?? []).filter((workflow) => {
    if (workflow.settings?.certificationStatus !== 'certified') return false
    if (!goalSpecOf(workflow)) return false
    if (!hasOfferableContent(workflow)) return false
    if (siteConflicts(workflow, hintKeys)) return false
    // A badge never outranks what the page did last: the newest counted run
    // decides. `no-data` is NOT an exclusion — a workflow certified by the
    // verify path often has no run log yet at all, and excluding it would keep
    // the bootstrap round's own output from ever seeding the next round.
    const newest = newestCountedRunOf(input.runs ?? [], workflow.id)
    if (newest && !newest.ok) return false
    const health = summarizeWorkflowHealth(input.runs ?? [], workflow.id)
    const stale = (now - workflow.updatedAt) / DAY_MS > SEED_MAX_AGE_DAYS
    if (stale && health.passedRuns === 0) return false
    return true
  })
  if (eligible.length === 0) return []

  const goalIntents = strongIntents(goalText)
  const goalLexicon = lexiconOf(goalText)
  const scored = eligible
    .map((workflow) => scoreCandidate(workflow, input, hintKeys, goalIntents, goalLexicon, now))
    .filter((candidate) =>
      candidate.siteMatch
        ? candidate.score >= SEED_FLOOR_WITH_SITE
        : candidate.score >= SEED_FLOOR_TEXT_ONLY,
    )
    .sort((a, b) => b.score - a.score || a.workflow.updatedAt - b.workflow.updatedAt)
    .slice(0, SEED_MAX_CANDIDATES)

  return scored.map((candidate) => ({
    workflowId: candidate.workflow.id,
    workflowName: candidate.workflow.name,
    score: candidate.score,
    siteMatch: candidate.siteMatch,
    why: candidate.why,
    steps: seedStepsOf(candidate.workflow).slice(0, SEED_MAX_STEPS),
  }))
}

// --- offer rendering -------------------------------------------------------------

function renderSize(offer: readonly SeedOffer[]): number {
  return JSON.stringify(offer).length
}

function asOffer(candidate: SeedCandidate, stepLimit: number): SeedOffer {
  return {
    workflowId: candidate.workflowId,
    workflowName: candidate.workflowName,
    siteMatch: candidate.siteMatch,
    why: candidate.why,
    steps: candidate.steps.slice(0, stepLimit),
  }
}

/**
 * Trim the offer to its byte budget in a DETERMINISTIC order: drop steps first
 * (a partial scaffold still beats none), then the second candidate, then the
 * whole offer. `JSON.stringify` and hope is not a truncation strategy — the
 * offer rides a tool result that is re-sent on every round of the turn.
 */
export function buildSeedOffer(candidates: readonly SeedCandidate[]): SeedOffer[] | undefined {
  // A step larger than the whole budget cannot be trimmed by dropping its
  // siblings, so it is not offerable at all; dropping it here keeps one bloated
  // recorded argument (a bulk array) from voiding the entire offer.
  const offerable = (candidates ?? [])
    .map((candidate) => ({
      ...candidate,
      steps: candidate.steps.filter((step) => JSON.stringify(step).length <= SEED_OFFER_MAX_CHARS),
    }))
    .filter((candidate) => candidate.steps.length > 0)
    .slice(0, SEED_MAX_CANDIDATES)
  if (offerable.length === 0) return undefined

  for (let stepLimit = SEED_MAX_STEPS; stepLimit >= 1; stepLimit -= 1) {
    const offer = offerable.map((candidate) => asOffer(candidate, stepLimit))
    if (renderSize(offer) <= SEED_OFFER_MAX_CHARS) return offer
  }
  if (offerable.length < 2) return undefined
  for (let stepLimit = SEED_MAX_STEPS; stepLimit >= 1; stepLimit -= 1) {
    const offer = [asOffer(offerable[0]!, stepLimit)]
    if (renderSize(offer) <= SEED_OFFER_MAX_CHARS) return offer
  }
  return undefined
}
