/**
 * Semantic element identity — the vocabulary the whole reliability layer shares.
 *
 * A CSS selector is a very strong claim about a very unstable thing. When it
 * outlives the layout that produced it (`nth-child`, dynamic classes, random
 * ids, deep ancestor chains), it still MATCHES something — just the wrong
 * element, and the action lands in silence. The reliability work therefore
 * treats the selector as ONE hint among several and keeps a structured,
 * human-meaning identity alongside it:
 *
 * - {@link SemanticLocator} is the identity the AGENT reasons about ("the
 *   发货 button inside the 订单 10001 row") and what a recorded workflow saves.
 * - {@link ElementFingerprint} is the identity OBSERVED from a live element —
 *   the same fields plus stable attributes and nearby context. Light and
 *   structured on purpose: no HTML dumps, no long text (privacy + payload).
 *
 * Pure module: no `chrome`, no DOM — the in-page kernel carries its own nested
 * extractor (it is serialized without closures), and the background/lib side
 * uses the pure helpers here.
 *
 * @module lib/workflow/element-fingerprint
 */

/** The structured, meaningful identity of a target element. */
export interface SemanticLocator {
  /** Implicit or explicit ARIA role (`button`, `textbox`, `link`, …). */
  role?: string
  /** Accessible name (button label, input label, aria-label, …). */
  accessibleName?: string
  /** Exact visible text of the element (leaf elements mostly). */
  text?: string
  /** Associated `<label>` text (form controls). */
  label?: string
  /** `placeholder` attribute (inputs). */
  placeholder?: string
  /** `data-testid`-style attribute value (the `attr` is in stableAttributes). */
  testId?: string
  /** Stable, non-random attributes worth matching (`id`, `name`, `data-*`). */
  stableAttributes?: Record<string, string>
  /** Relation that narrows a ambiguous match to the RIGHT one. */
  relation?: {
    /** Nearby visible text that disambiguates (e.g. the row title). */
    nearText?: string
    /** Role of the (closest meaningful) parent. */
    parentRole?: string
    /** Text of the container block the element belongs to. */
    containerText?: string
  }
}

/** What a live element looks like when fingerprinted. */
export interface ElementFingerprint {
  tagName: string
  role?: string
  accessibleName?: string
  /** Whitespace-collapsed visible text, capped. */
  normalizedText?: string
  /** Stable attributes only — random ids/classes are dropped, not recorded. */
  stableAttributes: Record<string, string>
  /** Roles of the ancestor chain (outermost first), when meaningful. */
  ancestorRoles?: string[]
  /** Short visible texts near the element (siblings / container). */
  nearbyTexts?: string[]
}

/**
 * Attribute names that are SAFE to match on. `data-testid`-style test hooks,
 * `name`, and (verified) `id` identify; classes and generated paths do not.
 */
const STABLE_ATTRIBUTE_NAMES: readonly string[] = [
  'id',
  'name',
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'href',
  'type',
  'placeholder',
  'title',
  'aria-label',
]

/** Cap on stable-attribute VALUE length — identity, not content. */
const STABLE_VALUE_CAP = 80

/**
 * Does a value look UNSTABLE (generated at runtime)? Mirrors the kernel's
 * `looksUnstable` heuristics: leading digits, framework-generated prefixes,
 * UUIDs / long hex runs, long digit runs, hash-like suffixes. An unstable
 * value must never become a locator's identity — a re-render regenerates it.
 */
export function isUnstableValue(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 64) return true
  const patterns = [
    /^[0-9]/,
    /^(?:ember|react|vue|ng|mui|css|sc|jss|radix|headlessui)[-_]?[a-z]*[-_]?\d/i,
    /^:r[0-9a-z]+:$/i,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /^[0-9a-f]{16,}$/i,
    /\d{5,}/,
    /^[a-z0-9_-]*[a-f0-9]{6,}[a-z0-9_-]*$/i,
  ]
  return patterns.some((pattern) => pattern.test(trimmed))
}

/** True when `name` is an attribute worth keeping in a fingerprint/locator. */
export function isStableAttributeName(name: string): boolean {
  return (STABLE_ATTRIBUTE_NAMES as readonly string[]).includes(name.trim().toLowerCase())
}

/**
 * Filter a raw attribute bag down to the stable identity part. Unstable values
 * of otherwise-stable names (a random `id`) are DROPPED, not recorded — the
 * fingerprint must not lie about what will still match next visit.
 */
export function stableAttributesOf(
  attrs: Record<string, string | undefined | null>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(attrs)) {
    const name = rawName.trim().toLowerCase()
    const value = rawValue?.trim()
    if (!value) continue
    if (!isStableAttributeName(name)) continue
    if (name === 'class') continue // never identity, however stable it looks
    if (isUnstableValue(value)) continue
    out[name] = value.length > STABLE_VALUE_CAP ? value.slice(0, STABLE_VALUE_CAP) : value
  }
  return out
}

/** Text cap for fingerprint text fields — identity, not page content. */
const FINGERPRINT_TEXT_CAP = 80

/** Collapse whitespace and cap a text for identity use. */
export function normalizeIdentityText(text: string | undefined | null): string | undefined {
  const collapsed = (text ?? '').replace(/[\s\u00a0]+/g, ' ').trim()
  if (!collapsed) return undefined
  return collapsed.length > FINGERPRINT_TEXT_CAP
    ? collapsed.slice(0, FINGERPRINT_TEXT_CAP)
    : collapsed
}

/**
 * Derive a {@link SemanticLocator} from a rich `Target` (the
 * `{ primary, fallbacks }` of specs the agent's snapshot produces). The FIRST
 * spec that carries semantic identity wins; CSS-only targets yield `undefined`
 * — a positional path is not identity, and pretending otherwise is the bug
 * this module exists to prevent.
 */
export function semanticLocatorFromTarget(target: unknown): SemanticLocator | undefined {
  if (!target || typeof target !== 'object') return undefined
  const raw = target as {
    primary?: { how?: unknown; value?: unknown; role?: unknown; tag?: unknown }
    fallbacks?: { how?: unknown; value?: unknown; role?: unknown; tag?: unknown }[]
    label?: unknown
  }
  const specs = [raw.primary, ...(Array.isArray(raw.fallbacks) ? raw.fallbacks : [])]
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue
    const how = typeof spec.how === 'string' ? spec.how : ''
    const value = typeof spec.value === 'string' ? spec.value.trim() : ''
    if (!value) continue
    const role = typeof spec.role === 'string' && spec.role.trim() ? spec.role.trim() : undefined
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined
    switch (how) {
      case 'role': {
        const locator: SemanticLocator = {}
        if (role) locator.role = role
        locator.accessibleName = normalizeIdentityText(value)
        if (label && label !== locator.accessibleName) locator.label = label
        return locator
      }
      case 'text': {
        const locator: SemanticLocator = { text: normalizeIdentityText(value) }
        if (role) locator.role = role
        if (label && label !== locator.text) locator.label = label
        return locator
      }
      case 'testid': {
        const locator: SemanticLocator = { testId: value }
        if (role) locator.role = role
        if (label) locator.accessibleName = normalizeIdentityText(label)
        return locator
      }
      case 'name': {
        const locator: SemanticLocator = { stableAttributes: { name: value } }
        if (role) locator.role = role
        if (label) locator.accessibleName = normalizeIdentityText(label)
        return locator
      }
      case 'id': {
        // An id is identity ONLY when it does not look generated.
        if (isUnstableValue(value)) continue
        const locator: SemanticLocator = { stableAttributes: { id: value } }
        if (role) locator.role = role
        if (label) locator.accessibleName = normalizeIdentityText(label)
        return locator
      }
      default:
        // css / cdp-shadow: positional, not identity. Keep looking.
        continue
    }
  }
  return undefined
}

/**
 * One-line human-readable form of a semantic locator, for logs and validator
 * messages: `button "发货" near "订单 10001"`. Never includes selectors.
 */
export function describeSemanticLocator(locator: SemanticLocator): string {
  const parts: string[] = []
  if (locator.role) parts.push(locator.role)
  const name = locator.accessibleName ?? locator.label ?? locator.text
  if (name) parts.push(`"${name}"`)
  else if (locator.testId) parts.push(`testid=${locator.testId}`)
  else if (locator.stableAttributes) {
    for (const [key, value] of Object.entries(locator.stableAttributes)) {
      parts.push(`${key}=${value}`)
    }
  }
  if (locator.relation?.nearText) parts.push(`near "${locator.relation.nearText}"`)
  return parts.join(' ')
}

// --- Semantic locator → kernel target spec --------------------------------------

/**
 * The best `TargetSpec` a semantic locator can express, for probes and
 * condition runtimes that speak the kernel's vocabulary. Returns `undefined`
 * when the locator carries no kernel-expressible identity — the caller then
 * falls back to the node's own selector or reports "not observable".
 */
export function targetSpecFromSemantic(
  locator: SemanticLocator,
): import('../ops').TargetSpec | undefined {
  if (locator.testId) {
    return { how: 'testid', value: locator.testId }
  }
  const stable = locator.stableAttributes ?? {}
  if (stable['id'] && !isUnstableValue(stable['id'])) {
    return { how: 'id', value: stable['id'] }
  }
  if (stable['name']) {
    return { how: 'name', value: stable['name'] }
  }
  if (locator.role) {
    return { how: 'role', value: locator.accessibleName ?? locator.label ?? '', role: locator.role }
  }
  if (locator.text) {
    return { how: 'text', value: locator.text }
  }
  return undefined
}
