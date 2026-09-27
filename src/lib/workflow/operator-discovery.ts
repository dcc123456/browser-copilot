/**
 * Operator discovery — the `find_workflow_operators` engine.
 *
 * Given a step intent, the workflow goal and (optionally) page evidence, this
 * module deterministically ranks a SMALL set of candidate operators instead of
 * letting the model trial-and-error across every `wf_op_*`. Ranking combines
 * semantic-phrase matching, detected semantic intents, page evidence and goal
 * alignment; a single keyword can never force rank one. Previously failed
 * operators are reranked downward (failure-aware reranking).
 *
 * The discovery result also tells the caller which candidate tool schemas to
 * activate — activation itself happens in the agent loop (see
 * `candidateBlockIds`), not by another `use_operators` round.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/operator-discovery
 */

import {
  allOperators,
  type OperatorRegistryEntry,
} from './operator-registry'
import {
  detectSemanticIntents,
  type DetectedIntent,
  type PageStructureSignals,
} from './semantic-intent'

/** A ranked candidate. */
export interface RankedOperator {
  /** Block id. */
  blockId: string
  /** Tool name `wf_op_<id>`. */
  toolName: string
  /** English display name. */
  name: string
  /** Deterministic 0..1 ranking score. */
  score: number
  /** Human-readable reasons explaining the score (evidence). */
  reasons: string[]
}

/** Inputs to discovery. */
export interface DiscoveryInput {
  /** The natural-language intent for THIS step. */
  stepIntent: string
  /** The workflow goal summary, for goal alignment. */
  workflowGoal?: string
  /** Page-structure evidence. */
  pageSignals?: PageStructureSignals
  /** Operators that already failed for this step, keyed blockId ⇒ failure code. */
  failedOperators?: Record<string, string>
  /** Maximum candidates to return. */
  limit?: number
}

/** Discovery result. */
export interface DiscoveryResult {
  candidates: RankedOperator[]
  /** Detected step intents, for transparency. */
  detectedIntents: DetectedIntent[]
  /** Block ids the caller should activate as tools. */
  candidateBlockIds: string[]
}

export const WF_OP_PREFIX = 'wf_op_'

// Deterministic ranking weights — single source, not in a prompt.
const WEIGHTS = {
  semanticPhrase: 0.4,
  intent: 0.3,
  goalAlignment: 0.18,
  pageEvidence: 0.12,
  fallbackPenalty: 0.5,
  complexityPenalty: 0.05,
  failurePenalty: 0.35,
} as const

function phraseScore(entry: OperatorRegistryEntry, intent: string): { score: number; hits: string[] } {
  const text = ` ${intent.toLowerCase()} `
  const hits = entry.semanticPhrases.filter((phrase) => text.includes(` ${phrase}`))
  // Cap phrase contribution so a keyword alone cannot dominate.
  return { score: Math.min(WEIGHTS.semanticPhrase, hits.length * 0.2), hits }
}

function intentScore(entry: OperatorRegistryEntry, intents: DetectedIntent[]): number {
  // Map the operator's capabilities onto detected intents by shared action
  // semantics. Keep it simple: an operator scores when its capability action
  // is implied by a top detected intent.
  const top = intents.filter((i) => i.score >= 0.4)
  let matched = 0
  for (const intent of top) {
    if (capabilityMatchesIntent(entry, intent.intent)) matched += intent.score
  }
  return Math.min(WEIGHTS.intent, matched * 0.3)
}

function capabilityMatchesIntent(entry: OperatorRegistryEntry, intent: DetectedIntent['intent']): boolean {
  const caps = entry.capabilities
  switch (intent) {
    case 'interaction-click':
      return caps.includes('click') || caps.includes('submit')
    case 'interaction-fill':
      return caps.includes('fill') || caps.includes('select')
    case 'reading':
      return caps.some((c) => c.startsWith('read'))
    case 'verification':
      return caps.includes('element-exists')
    case 'semantic-generation':
      return entry.id === 'ai-agent'
    default:
      return false
  }
}

function goalAlignment(entry: OperatorRegistryEntry, goal: string): number {
  if (!goal) return 0
  const g = goal.toLowerCase()
  const hit = entry.semanticPhrases.some((phrase) => phrase.length > 2 && g.includes(phrase))
  return hit ? WEIGHTS.goalAlignment : 0
}

function pageEvidenceScore(entry: OperatorRegistryEntry, page: PageStructureSignals | undefined): number {
  if (!page) return 0
  let score = 0
  if (page.hasForm && (entry.capabilities.includes('fill') || entry.id === 'forms')) score += 0.06
  if (page.repeatedRows && entry.capabilities.some((c) => c.startsWith('read'))) score += 0.06
  return Math.min(WEIGHTS.pageEvidence, score)
}

/** Run discovery and return a deterministic ranked candidate list. */
export function findWorkflowOperators(input: DiscoveryInput): DiscoveryResult {
  const limit = input.limit ?? 5
  const detectedIntents = detectSemanticIntents(input.stepIntent, input.pageSignals)
  const failed = input.failedOperators ?? {}

  const ranked: RankedOperator[] = []
  for (const entry of allOperators()) {
    if (!entry.allowGeneration || entry.cloud) continue
    // Hidden operators are never discovered as normal candidates.
    if (entry.aiExposure === 'hidden') continue

    const reasons: string[] = []
    const phrase = phraseScore(entry, input.stepIntent)
    if (phrase.hits.length) reasons.push(`phrase: ${phrase.hits.join(', ')}`)

    const intent = intentScore(entry, detectedIntents)
    if (intent) reasons.push('intent match')

    const goal = goalAlignment(entry, input.workflowGoal ?? '')
    if (goal) reasons.push('goal alignment')

    const page = pageEvidenceScore(entry, input.pageSignals)
    if (page) reasons.push('page evidence')

    let score = phrase.score + intent + goal + page

    // Prefer direct native operators over fallback/complex ones.
    if (entry.aiExposure === 'fallback') {
      score -= WEIGHTS.fallbackPenalty
      reasons.push('fallback penalty')
    }
    if (entry.engineInterpreted) {
      score -= WEIGHTS.complexityPenalty
    }
    if (failed[entry.id]) {
      score -= WEIGHTS.failurePenalty
      reasons.push(`failed before (${failed[entry.id]})`)
    }
    if (score <= 0) continue

    ranked.push({
      blockId: entry.id,
      toolName: WF_OP_PREFIX + entry.id,
      name: entry.name,
      score: Number(score.toFixed(3)),
      reasons,
    })
  }

  ranked.sort((a, b) => b.score - a.score || a.blockId.localeCompare(b.blockId))
  const candidates = ranked.slice(0, limit)
  return {
    candidates,
    detectedIntents,
    candidateBlockIds: candidates.map((c) => c.blockId),
  }
}
