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

/** One target spec as it arrives from the model: unvalidated JSON. */
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
 */
export function richTargetFromAny(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const primary = (value as { primary?: unknown }).primary
  if (!primary || typeof primary !== 'object') return undefined
  const spec = primary as { how?: unknown; value?: unknown }
  if (typeof spec.how !== 'string' || !spec.how) return undefined
  if (typeof spec.value !== 'string') return undefined
  return value
}

/** {@link richTargetFromAny} applied to an action's args. */
export function richTargetFromArgs(args: Record<string, unknown> | undefined): unknown {
  return richTargetFromAny(args?.target)
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

  return {
    selector,
    ...(target ? { target } : {}),
    ...(label ? { label } : {}),
    ...(type ? { type } : {}),
  }
}
