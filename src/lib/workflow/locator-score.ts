/**
 * Locator candidate scoring — the shared judgement of "how much can this
 * locator be trusted to point at the RIGHT element next time".
 *
 * The weights encode one principle: identity beats position. A verified
 * testid, a role+accessible-name pair, a stable id or a stable `data-*`
 * attribute say WHO the element is; a positional CSS path says where it
 * HAPPENED to sit when recorded. The module exists because the old
 * record-time picker took the FIRST CSS candidate that matched exactly one
 * element — which let a lucky positional path beat a verified role target.
 *
 * The numbers are engineering defaults, not a product API: every scorer takes
 * an optional weights override, and all values live in this one table
 * (spec §5.4). Consumers:
 *
 *   - record time: `chooseRecordedSelector` picks the highest-scored
 *     candidate that matches exactly one element (see `target-to-selector`);
 *   - run time (generated-strict): the kernel's resolver mirrors this table
 *     in-page and refuses ambiguous matches (see Phase 3);
 *   - validators: `semanticLocatorScore` judges whether a node carries ANY
 *     usable identity.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/locator-score
 */
import { isUnstableValue } from './element-fingerprint'

/** Default weights (spec §5.4). Override via the `weights` parameters. */
export const LOCATOR_WEIGHTS = {
  /** Verified (live-probed, exactly-one) testid. */
  verifiedTestid: 100,
  /** Role + accessible name — what the element IS on the page. */
  roleAccessibleName: 95,
  /** Verified stable id. */
  verifiedStableId: 90,
  /** Associated `<label>` text. */
  label: 88,
  /** `name` attribute (form controls). */
  name: 85,
  /** Role plus a nearby-text/parent relation that narrows the match. */
  roleNearbyRelation: 82,
  /** Stable `data-*` attribute. */
  stableDataAttribute: 75,
  /** Exact visible text. */
  exactVisibleText: 70,
  /** CSS selector (positional paths score lower via depth demotion). */
  css: 35,
  /** XPath. */
  xpath: 25,
  /** Positional locators (`nth`, `nth-child`, `nth-of-type`) — near-zero trust. */
  positional: 10,
} as const

export type LocatorWeights = {
  [K in keyof typeof LOCATOR_WEIGHTS]: number
}

/** One locator candidate as the scorers accept it. */
export interface LocatorCandidate {
  /**
   * Strategy: `testid | id | name | role | text | label | data-attr | css |
   * xpath | positional`. The fine-grained kinds exist so the weights stay
   * readable; `css` candidates get demoted to `positional` trust when they
   * carry unstable class tokens or an explicit `nth`.
   */
  kind: LocatorCandidateKind
  /** The strategy's value (selector text, accessible name, attribute value…). */
  value: string
  /** ARIA role, when the strategy is role-based. */
  role?: string
  /** Live-probed to match exactly one element at record time. */
  verified?: boolean
  /** Whether the id/attribute value looks runtime-generated. */
  unstable?: boolean
}

export type LocatorCandidateKind =
  | 'testid'
  | 'id'
  | 'name'
  | 'role'
  | 'text'
  | 'label'
  | 'data-attr'
  | 'css'
  | 'xpath'
  | 'positional'

/** One scored candidate. */
export interface ScoredCandidate {
  candidate: LocatorCandidate
  score: number
}

/**
 * Score one candidate. Demotions applied on top of the base weight:
 *
 *   - an explicit `nth` caps the score at `positional` (never identity);
 *   - an unstable (generated) id/attribute value caps at `positional`;
 *   - a CSS selector containing an unstable class token caps at `positional`
 *     (a random hash class must not read as a trustworthy locator);
 *   - CSS depth (each `>` or descendant step) shaves a point, floor 1.
 */
export function scoreCandidate(
  candidate: LocatorCandidate,
  weights: LocatorWeights = LOCATOR_WEIGHTS,
): number {
  // An id/testid/name whose VALUE looks runtime-generated is unstable even
  // when the caller forgot to say so — the cap must not depend on flag
  // discipline at the call site.
  const unstable =
    candidate.unstable ??
    ((candidate.kind === 'id' || candidate.kind === 'name' || candidate.kind === 'data-attr') &&
      isUnstableValue(candidate.value))
  let base: number
  switch (candidate.kind) {
    case 'testid':
      base = candidate.verified ? weights.verifiedTestid : weights.verifiedTestid - 8
      break
    case 'role':
      base = weights.roleAccessibleName
      break
    case 'id':
      base = candidate.verified ? weights.verifiedStableId : weights.verifiedStableId - 12
      break
    case 'label':
      base = weights.label
      break
    case 'name':
      base = weights.name
      break
    case 'data-attr':
      base = weights.stableDataAttribute
      break
    case 'text':
      base = weights.exactVisibleText
      break
    case 'css':
      base = weights.css
      break
    case 'xpath':
      base = weights.xpath
      break
    case 'positional':
      return weights.positional
  }
  // Positional / generated-value demotions cap the whole score, they do not
  // subtract — "unstable" must land BELOW every semantic strategy.
  if (unstable) return weights.positional
  if (candidate.kind === 'css') {
    const steps = (candidate.value.match(/[>\s]+/) ?? []).length
    base = Math.max(1, base - Math.min(15, steps))
    if (cssHasUnstableClassToken(candidate.value)) return weights.positional
  }
  return base
}

/** Split a CSS selector into its `.class` tokens. */
function classTokensOf(selector: string): string[] {
  const tokens: string[] = []
  const pattern = /\.([A-Za-z0-9_-]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(selector)) !== null) {
    tokens.push(match[1] ?? '')
  }
  return tokens
}

/** Does any class token in the selector look runtime-generated? */
export function cssHasUnstableClassToken(selector: string): boolean {
  return classTokensOf(selector).some((token) => token && isUnstableValue(token))
}

/** Classify a raw selector string into the candidate kind it claims. */
export function candidateFromSelectorString(selector: string): LocatorCandidate {
  const value = selector.trim()
  if (value.startsWith('xpath:')) return { kind: 'xpath', value }
  if (/^\[[a-z-]*testid[a-z-]*=/.test(value)) return { kind: 'testid', value }
  if (/^\[name=/.test(value)) return { kind: 'name', value }
  if (/^\[data-[a-z0-9-]+=/.test(value)) return { kind: 'data-attr', value }
  if (value.startsWith('#')) {
    const id = value.slice(1)
    return { kind: 'id', value, unstable: isUnstableValue(id) }
  }
  return { kind: 'css', value }
}

/** Score (and sort) a list of candidates, highest first. */
export function scoreCandidates(
  candidates: readonly LocatorCandidate[],
  weights: LocatorWeights = LOCATOR_WEIGHTS,
): ScoredCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, weights) }))
    .sort((a, b) => b.score - a.score)
}

/** Options for {@link pickLocatorWinner} — the §6.3 decision core. */
export interface PickLocatorOptions {
  /** Minimum score a winner must reach (below → ambiguous). */
  minScore?: number
  /** Minimum gap between the top two scores (below → ambiguous). */
  minMargin?: number
  weights?: LocatorWeights
}

export interface PickLocatorOutcome {
  /** The winning candidate, when the decision was not ambiguous. */
  winner?: ScoredCandidate
  /** The runner-up, when there was one. */
  runnerUp?: ScoredCandidate
  /** Gap between winner and runner-up scores. */
  margin: number
  /** True when the candidate set cannot decide: fail closed. */
  ambiguous: boolean
  /** Machine-readable reason (`no-candidates` | `below-min-score` | `below-min-margin`). */
  reason?: 'no-candidates' | 'below-min-score' | 'below-min-margin'
  /** All candidates with scores, winner first (evidence for failures). */
  candidates: ScoredCandidate[]
}

/**
 * The ambiguity decision core (spec §6.3) over scored candidates: a winner
 * must reach `minScore` AND beat the runner-up by at least `minMargin`.
 * Everything else is ambiguous — fail closed, never guess.
 */
export function pickLocatorWinner(
  candidates: readonly LocatorCandidate[],
  options: PickLocatorOptions = {},
): PickLocatorOutcome {
  const minScore = options.minScore ?? 70
  const minMargin = options.minMargin ?? 12
  const scored = scoreCandidates(candidates, options.weights)
  if (scored.length === 0) {
    return { margin: 0, ambiguous: true, reason: 'no-candidates', candidates: [] }
  }
  const top = scored[0]!
  const runnerUp = scored[1]
  const margin = runnerUp ? top.score - runnerUp.score : top.score
  if (top.score < minScore) {
    return {
      runnerUp,
      margin,
      ambiguous: true,
      reason: 'below-min-score',
      candidates: scored,
    }
  }
  if (runnerUp && margin < minMargin) {
    return { runnerUp, margin, ambiguous: true, reason: 'below-min-margin', candidates: scored }
  }
  return { winner: top, runnerUp, margin, ambiguous: false, candidates: scored }
}

// --- Semantic locator scoring ---------------------------------------------------

/**
 * Score a {@link SemanticLocator} — how well it identifies the element on its
 * own. Used by validators ("does this node carry ANY usable identity?") and by
 * generated-workflow checks. Mirrors the candidate weights:
 *
 *   testid 100 · role+accessibleName 95 · stable id 90 · label 88 · name 85 ·
 *   stable data-* 75 · exact text 70 · role+near-relation 82
 *
 * The score is the BEST single identity the locator carries, with a bonus for
 * relations that narrow ambiguous matches.
 */
export function semanticLocatorScore(
  locator: import('./element-fingerprint').SemanticLocator,
  weights: LocatorWeights = LOCATOR_WEIGHTS,
): number {
  let best = 0
  if (locator.testId) best = Math.max(best, weights.verifiedTestid)
  if (locator.role && (locator.accessibleName || locator.label)) {
    best = Math.max(best, weights.roleAccessibleName)
  }
  const stable = locator.stableAttributes ?? {}
  if (stable['id'] && !isUnstableValue(stable['id'])) {
    best = Math.max(best, weights.verifiedStableId)
  }
  if (locator.label) best = Math.max(best, weights.label)
  if (stable['name']) best = Math.max(best, weights.name)
  for (const [key, value] of Object.entries(stable)) {
    if (key !== 'id' && key !== 'name' && key.startsWith('data-') && !isUnstableValue(value)) {
      best = Math.max(best, weights.stableDataAttribute)
    }
  }
  if (locator.text) best = Math.max(best, weights.exactVisibleText)
  if (locator.role && (locator.relation?.nearText || locator.relation?.containerText)) {
    best = Math.max(best, weights.roleNearbyRelation)
  }
  return best
}
