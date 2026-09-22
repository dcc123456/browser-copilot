/**
 * Element locator → replayable CSS selector.
 *
 * The agent targets elements with a rich `Target` (`{ primary, fallbacks }` of
 * `TargetSpec`s) because role/text matching survives page drift far better than
 * a hand-written CSS path. A recorded workflow node, however, needs a plain
 * `selector` string the block executors can resolve. These helpers bridge the
 * two: they re-express a `Target` as CSS where that is safe, and keep the rich
 * locator alongside it as a fallback so replay still hits the element when no
 * CSS selector can express it (see `targetFrom` in the workflow executors).
 *
 * Pure functions only — no `chrome` access — so both the history-derived
 * generator (`lib/storage`) and the live operator bridge can share one
 * implementation and one set of tests.
 *
 * @module lib/workflow/target-to-selector
 */

import { semanticLocatorFromTarget, type SemanticLocator } from './element-fingerprint'
import {
  candidateFromSelectorString,
  scoreCandidate,
  type LocatorCandidate,
} from './locator-score'
import type { NodeLocatorSpec } from './reliability'

/**
 * One target spec as it arrives from the model: unvalidated JSON. */
interface RawSpec {
  how?: unknown
  value?: unknown
  tag?: unknown
  nth?: unknown
}

/** A rich locator as it arrives from the model: unvalidated JSON. */
interface RawTarget {
  primary?: RawSpec
  fallbacks?: RawSpec[]
}

/** What the agent knows about a snapshot target: its locator and its label. */
export interface SnapshotTargetEntry {
  target: unknown
  name: string
  /**
   * The element's `type` attribute, when the snapshot carried one. This is how
   * a password field is recognised — it is the only signal that a value must
   * never be recorded as a literal (see `lib/workflow/secret-guard`).
   */
  type?: string
}

/** The replayable form of one operator/action call's element reference. */
export interface RecordedLocator {
  /** Best-effort CSS selector; `''` when the target is not CSS-expressible. */
  selector: string
  /** Rich locator kept verbatim so the kernel can fall back to role/text. */
  target?: unknown
  /** Human-readable element description, when the caller supplied one. */
  label?: string
  /** The target's `type` attribute, when the snapshot knew it. */
  type?: string
  /**
   * Whether the recorded `selector` was verified against the live page to
   * match EXACTLY ONE element at record time. Absent when the selector was
   * never probed (no page available). A `false` selector still plays — the
   * kernel resolves the rich target's semantic specs as fallbacks — but it is
   * the first suspect when a replay misses.
   */
  verified?: boolean
  /**
   * The element's semantic identity (role/accessible name/test id/stable
   * attributes), derived from the rich target. The selector is ONE hint; this
   * is the identity the strict runtime and the validators read.
   */
  semantic?: SemanticLocator
}

/**
 * Best-effort CSS selector from a single target spec ('' when not
 * expressible). Mappable specs:
 *   - `how: 'css'`    → the raw selector
 *   - `how: 'id'`     → `#<value>`
 *   - `how: 'name'`   → `[name="<value>"]`
 *   - `how: 'testid'` → `[data-testid="<value>"]`
 *   - `how: 'tag'`    → the tag name (optionally scoped by `nth`)
 * `role`/`text` targets can't be safely turned into a plain CSS selector
 * without knowing the page, so they yield `''` (the node keeps the rich
 * locator instead).
 */
export function selectorFromSpec(spec: RawSpec | undefined): string {
  if (!spec || typeof spec !== 'object') return ''
  const nth = typeof spec.nth === 'number' && spec.nth > 0 ? `:nth-of-type(${spec.nth + 1})` : ''
  const value = spec.value
  switch (spec.how) {
    case 'css':
      return typeof value === 'string' ? value.trim() : ''
    case 'id':
      return typeof value === 'string' && value.trim() ? `#${value.trim()}` : ''
    case 'name':
      return typeof value === 'string' && value.trim() ? `[name="${value.trim()}"]${nth}` : ''
    case 'testid':
      return typeof value === 'string' && value.trim()
        ? `[data-testid="${value.trim()}"]${nth}`
        : ''
    case 'tag':
      return typeof spec.tag === 'string' && spec.tag.trim() ? `${spec.tag.trim()}${nth}` : ''
    default:
      // role / text — cannot be expressed as a stable CSS selector.
      return ''
  }
}

/**
 * Best-effort CSS selector from a rich locator. The `primary` spec is
 * re-expressed into CSS, and when it does not map (the agent usually targets
 * elements by role/text) the `fallbacks` are tried in order — the replayable
 * workflow needs that fallback to carry a usable selector.
 */
export function selectorFromTarget(target: unknown): string {
  if (!target || typeof target !== 'object') return ''
  const raw = target as RawTarget
  const primary = selectorFromSpec(raw.primary)
  if (primary) return primary
  const fallbacks = Array.isArray(raw.fallbacks) ? raw.fallbacks : []
  for (const spec of fallbacks) {
    const selector = selectorFromSpec(spec)
    if (selector) return selector
  }
  return ''
}

/**
 * Best-effort CSS selector from an action's args. An explicit `selector` wins
 * when present; otherwise the rich `target` is re-expressed (see
 * {@link selectorFromTarget}).
 */
export function selectorFromArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== 'object') return ''
  if (typeof args.selector === 'string' && args.selector.trim()) return args.selector.trim()
  return selectorFromTarget(args.target)
}

/**
 * Validate a rich locator (`args.target`, the `TARGET_SCHEMA` in agent.ts),
 * passed through verbatim when it is a usable object. The kernel resolves every
 * spec strategy — role/text included — so replay hits the same element even
 * when no CSS selector can express it, and the edit panel has something
 * concrete to show.
 *
 * The spec's `value` must be NON-EMPTY. This is the gate that keeps a
 * `{primary: {how: 'role', value: ''}}` out of the graph: the kernel's role
 * matcher treats an empty role AND empty value as "any element", so such a
 * spec matched EVERYTHING on the page, the action "succeeded" against the
 * first match, and the recorded node replayed against an arbitrary element.
 */
export function richTargetFromAny(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const primary = (value as { primary?: unknown }).primary
  if (!primary || typeof primary !== 'object') return undefined
  const spec = primary as { how?: unknown; value?: unknown }
  if (typeof spec.how !== 'string' || !spec.how.trim()) return undefined
  if (typeof spec.value !== 'string' || !spec.value.trim()) return undefined
  return value
}

/** {@link richTargetFromAny} applied to an action's args. */
export function richTargetFromArgs(args: Record<string, unknown> | undefined): unknown {
  return richTargetFromAny(args?.target)
}

/** Cap on probed candidates — a locator with more specs than this is noise. */
const MAX_CANDIDATES = 8

/**
 * Every CSS selector worth probing for a locator, in preference order: the
 * explicit/derived selector first, then the rich target's primary spec and its
 * fallbacks (only the CSS-mappable ones). Deduplicated, non-empty.
 */
export function selectorCandidatesOf(locator: RecordedLocator): string[] {
  const out: string[] = []
  const push = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  push(locator.selector ?? '')
  const raw = locator.target as RawTarget | undefined
  if (raw && typeof raw === 'object') {
    push(selectorFromSpec(raw.primary))
    const fallbacks = Array.isArray(raw.fallbacks) ? raw.fallbacks : []
    for (const spec of fallbacks) push(selectorFromSpec(spec))
  }
  return out.slice(0, MAX_CANDIDATES)
}

/**
 * Pick the selector a node should record, given live match counts.
 *
 * A selector that matches EXACTLY ONE element on the page at record time is
 * the only provably replayable one: the element the user actually picked.
 * Among the exact-one candidates the highest-SCORED one wins (see
 * `locator-score`) — an identity-bearing locator (#id, [data-testid],
 * [name]) beats a positional CSS path that merely got lucky, which is the
 * spec's "不要因为 CSS 是第一候选就胜出". Preference order breaks ties.
 * When nothing matches exactly, the best fallback is a candidate that at
 * least matches something — the recorded behavior stays what it was, minus
 * the pretense of being verified. When not even that exists, record NO
 * selector: the rich target (role/text specs) becomes the replay's primary,
 * which is exactly the case where a positional CSS path would only ever
 * mislead.
 */
export function chooseRecordedSelector(
  locator: RecordedLocator,
  countOf: (selector: string) => number,
): { selector: string; verified: boolean } {
  const scored = scoredSelectorCandidatesOf(locator, countOf)
  const exact = scored.filter((entry) => entry.count === 1)
  if (exact.length > 0) {
    // scoreCandidates sorts by score; rebuild here so the ORIGINAL preference
    // order breaks ties (stable: equal scores keep their relative order).
    let best = exact[0]!
    for (const entry of exact) {
      if (entry.score > best.score) best = entry
    }
    return { selector: best.selector, verified: true }
  }
  const alive = scored.find((entry) => entry.count > 0)
  return { selector: alive?.selector ?? '', verified: false }
}

/** One candidate selector with its origin spec, live count and score. */
interface ScoredSelectorCandidate {
  selector: string
  candidate: LocatorCandidate
  count: number
  score: number
}

/**
 * Every CSS selector worth probing for a locator, paired with the candidate
 * metadata the scorer needs: the explicit/derived selector first, then the
 * rich target's primary spec and its fallbacks (only the CSS-mappable ones).
 * Deduplicated, non-empty, each scored with `verified = (count === 1)`.
 */
function scoredSelectorCandidatesOf(
  locator: RecordedLocator,
  countOf: (selector: string) => number,
): ScoredSelectorCandidate[] {
  const out: ScoredSelectorCandidate[] = []
  const push = (selector: string, candidate: LocatorCandidate): void => {
    const trimmed = selector.trim()
    if (!trimmed) return
    if (out.some((entry) => entry.selector === trimmed)) return
    const verified = countOf(trimmed) === 1
    const withVerification: LocatorCandidate = { ...candidate, verified }
    out.push({
      selector: trimmed,
      candidate: withVerification,
      count: countOf(trimmed),
      score: scoreCandidate(withVerification),
    })
  }
  // The explicit selector's provenance is unknown — classify it by shape.
  const explicit = (locator.selector ?? '').trim()
  if (explicit) push(explicit, candidateFromSelectorString(explicit))
  const raw = locator.target as RawTarget | undefined
  if (raw && typeof raw === 'object') {
    const specs = [raw.primary, ...(Array.isArray(raw.fallbacks) ? raw.fallbacks : [])]
    for (const spec of specs) {
      const selector = selectorFromSpec(spec)
      if (!selector) continue
      const how = typeof spec?.how === 'string' ? spec.how : 'css'
      const value = typeof spec?.value === 'string' ? spec.value.trim() : ''
      const nth = typeof spec?.nth === 'number' && spec.nth > 0 ? spec.nth : undefined
      let candidate: LocatorCandidate
      switch (how) {
        case 'testid':
          candidate = { kind: 'testid', value }
          break
        case 'id':
          candidate = { kind: 'id', value }
          break
        case 'name':
          candidate = { kind: 'name', value }
          break
        default:
          candidate = candidateFromSelectorString(selector)
          break
      }
      if (nth) candidate = { ...candidate, kind: 'positional', value: selector }
      push(selector, candidate)
    }
  }
  return out.slice(0, MAX_CANDIDATES)
}

/** Attach the rich locator to flat block data when present. */
export function withRichTarget(
  data: Record<string, unknown>,
  target: unknown,
): Record<string, unknown> {
  return target ? { ...data, target } : data
}

/**
 * Resolve everything the model gave us about an element into one recordable
 * locator. Preference order:
 *
 *   1. `ref` — the short handle from `snapshot_page`, looked up in the run's
 *      `snapshotTargets` cache. This is the most reliable source: the snapshot
 *      already resolved the element and produced a scored `Target`.
 *   2. `target` — the rich locator the model passed inline.
 *   3. `selector` — a raw CSS selector (older callers / hand-written calls).
 *
 * The `selector` field is always filled when any source can be expressed as
 * CSS; `target` is kept so the kernel can still fall back to role/text.
 */
export function resolveRecordedLocator(
  args: Record<string, unknown> | undefined,
  snapshotTargets?: ReadonlyMap<string, SnapshotTargetEntry>,
): RecordedLocator {
  const ref = typeof args?.ref === 'string' ? args.ref.trim() : ''
  const hit = ref && snapshotTargets ? snapshotTargets.get(ref) : undefined
  const target = (hit ? richTargetFromAny(hit.target) : undefined) ?? richTargetFromArgs(args)

  const explicit =
    typeof args?.selector === 'string' && args.selector.trim() ? args.selector.trim() : ''
  const selector = explicit || selectorFromTarget(target)

  const inlineLabel = typeof args?.label === 'string' ? args.label.trim() : ''
  const label = inlineLabel || hit?.name || ''
  const type = typeof hit?.type === 'string' && hit.type.trim() ? hit.type.trim() : ''
  const semantic = semanticLocatorFromTarget(target)

  return {
    selector,
    ...(target ? { target } : {}),
    ...(label ? { label } : {}),
    ...(type ? { type } : {}),
    ...(semantic ? { semantic } : {}),
  }
}

/**
 * The `__reliability.locator` node-data patch a recorded locator implies
 * (spec §5.5): the semantic identity when one was observed, plus the live
 * probe result. `undefined` when the locator carries neither — there is
 * nothing reliability-relevant to say, and the node data stays untouched.
 */
export function reliabilityLocatorOf(locator: RecordedLocator): NodeLocatorSpec | undefined {
  const semantic = locator.semantic ?? semanticLocatorFromTarget(locator.target)
  const selectorVerified = typeof locator.verified === 'boolean' ? locator.verified : undefined
  if (!semantic && selectorVerified === undefined) return undefined
  return {
    ...(semantic ? { semantic } : {}),
    ...(selectorVerified !== undefined ? { selectorVerified } : {}),
  }
}
