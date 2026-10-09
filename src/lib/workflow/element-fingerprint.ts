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
  /**
   * A recorded CSS selector. Positional, not identity — but OBSERVABLE, and a
   * generation model writes goal conditions as `target: {selector: "…"`, so an
   * observer that skips this field reads a present element as permanently
   * absent and the goal can never certify.
   */
  selector?: string
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

/**
 * What a condition or probe may be pointed at: the structured identity a
 * workflow records, OR the node's own rich `Target` — which is what a generation
 * model actually writes into `condition.target`. Observers accept both (see
 * {@link conditionTargetSpecs}); identity-only matching would read a clickable
 * element as permanently absent.
 */
export type ConditionTarget = SemanticLocator | import('../ops').Target

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
 * The element NAME a condition target expresses, for editors and logs. A
 * `role`/`text`/`cdp-shadow` spec's value IS the accessible name; a positional
 * chain has none, so it reports the label it was recorded under.
 */
export function conditionTargetName(target: unknown): string {
  if (!target || typeof target !== 'object') return ''
  const raw = target as {
    label?: unknown
    primary?: import('../ops').TargetSpec
  } & SemanticLocator
  const specs = [raw.primary]
  for (const spec of specs) {
    if (
      spec &&
      typeof spec === 'object' &&
      (spec.how === 'role' || spec.how === 'text' || spec.how === 'cdp-shadow')
    ) {
      if (typeof spec.value === 'string' && spec.value.trim()) return spec.value.trim()
    }
  }
  if (typeof raw.label === 'string' && raw.label.trim()) return raw.label.trim()
  return raw.accessibleName ?? raw.text ?? ''
}

/**
 * The same target shape with its element name replaced — what a "which element"
 * field writes. A rich chain keeps its other specs: an editor changes the name,
 * it does not re-derive the whole locator.
 */
export function withConditionTargetName(target: ConditionTarget, name: string): ConditionTarget {
  const primary = (target as { primary?: import('../ops').TargetSpec }).primary
  if (primary && typeof primary === 'object' && typeof primary.how === 'string') {
    const named = primary.how === 'role' || primary.how === 'text' || primary.how === 'cdp-shadow'
    if (named)
      return { ...(target as import('../ops').Target), primary: { ...primary, value: name } }
    return { ...(target as import('../ops').Target), label: name }
  }
  return { ...target, accessibleName: name }
}

/**
 * The spec chain an OBSERVER should use for a recorded condition target.
 *
 * `WorkflowCondition.target` is typed as a {@link SemanticLocator}, but the
 * graphs a generation model produces put the node's own rich `Target`
 * (`{ primary, fallbacks }`) there. Read as a locator that object carries no
 * identity fields at all, so {@link targetSpecsFromSemantic} returns nothing and
 * an `elementExists` criterion about an element the node can act on evaluates to
 * permanently false — which fails L2 verification and sinks every repair
 * candidate that depends on it. Positional and `cdp-shadow` specs are not
 * identity, but they ARE observable, and an observation must be able to find
 * exactly what the action can act on; that is the same rule the readiness probe
 * follows. So: the recorded chain first, in the order replay tries it, and the
 * locator vocabulary only as a fallback.
 */
export function conditionTargetSpecs(target: unknown): import('../ops').TargetSpec[] {
  if (!target || typeof target !== 'object') return []
  const raw = target as {
    primary?: import('../ops').TargetSpec
    fallbacks?: import('../ops').TargetSpec[]
  }
  const recorded = [raw.primary, ...(Array.isArray(raw.fallbacks) ? raw.fallbacks : [])]
  const out: import('../ops').TargetSpec[] = []
  for (const spec of recorded) {
    // An empty value is dropped, not kept: `{how:'role', value:''}` is the spec
    // the kernel resolves to every element on the page.
    if (!spec || typeof spec !== 'object') continue
    if (typeof spec.how !== 'string' || typeof spec.value !== 'string') continue
    const value = spec.value.trim()
    if (!value) continue
    if (out.some((s) => s.how === spec.how && s.value === value)) continue
    out.push({ ...spec, value })
  }
  if (out.length > 0) return out
  return targetSpecsFromSemantic(target as SemanticLocator)
}

/**
 * Human-readable identity of a condition target, in either shape. Falls back to
 * the spec vocabulary so a run log never renders `元素存在 ` with nothing in it.
 */
export function describeConditionTarget(target: unknown): string {
  const semantic = semanticLocatorFromTarget(target)
  const described = semantic ? describeSemanticLocator(semantic) : ''
  if (described) return described
  const [primary] = conditionTargetSpecs(target)
  const name = conditionTargetName(target)
  if (name) return `${primary?.role ? `${primary.role} ` : ''}"${name}"`
  // A positional chain with no name at all: say which vocabulary it speaks
  // rather than pretending it has an identity.
  if (primary) return `${primary.how} "${primary.value.slice(0, 60)}"`
  return describeSemanticLocator(target as SemanticLocator)
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

/**
 * EVERY kernel spec a semantic locator can honestly express, strongest first —
 * the identity {@link targetSpecFromSemantic} picks plus the recorded CSS
 * selector carried under the `data-css` stable attribute (see `auto-contract`).
 *
 * Probes observe through the full chain because an element the node can click
 * must never read as "absent" to a wait or a condition. A single-spec locator is
 * how an `elementExists` postcondition stayed permanently false after harmless
 * DOM drift. Specs with an empty value are dropped: `{how:'role', value:''}` is
 * the shape the kernel resolves to EVERY element on the page.
 */
export function targetSpecsFromSemantic(locator: SemanticLocator): import('../ops').TargetSpec[] {
  const out: import('../ops').TargetSpec[] = []
  const push = (spec: import('../ops').TargetSpec | undefined): void => {
    if (!spec || !spec.value.trim()) return
    if (out.some((s) => s.how === spec.how && s.value === spec.value)) return
    out.push(spec)
  }
  push(targetSpecFromSemantic(locator))
  // A recorded CSS selector is not identity, but it is the chain the node itself
  // acted on — dropping it would make its own postcondition unsatisfiable.
  if (typeof locator.selector === 'string') push({ how: 'css', value: locator.selector.trim() })
  const css = locator.stableAttributes?.['data-css']
  if (typeof css === 'string') push({ how: 'css', value: css.trim() })
  return out
}
