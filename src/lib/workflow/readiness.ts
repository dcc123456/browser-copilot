/**
 * Readiness — the declarative "the page is ready for this step" contract.
 *
 * A step that races its own predecessor's render fails or, worse, acts on a
 * half-built DOM. The old system encoded "wait" as either fixed sleeps (never
 * generated-strict) or per-executor polling flags; the reliability contract
 * replaces that with a per-node READINESS SPEC: which observable states must
 * hold BEFORE the action and which must hold AFTER it, polled with re-resolve
 * until satisfied or timed out (the runtime lives in
 * `background/workflow-engine/readiness-engine`).
 *
 * Pure module: state vocabulary, the per-block DEFAULT table (§7.3), and the
 * normalization used by validators and the runtime. No `chrome`, no DOM.
 *
 * @module lib/workflow/readiness
 */
import type { SemanticLocator } from './element-fingerprint'

/** An observable page/data state a step can wait for. */
export type ReadinessState =
  | 'present'
  | 'visible'
  | 'enabled'
  | 'stable'
  | 'navigation-settled'
  | 'value-committed'
  | 'data-ready'

/** One requirement inside a readiness spec. */
export interface ReadinessRequirement {
  state: ReadinessState
  /** Element the requirement is about (defaults to the step's own target). */
  target?: SemanticLocator
  /** Expected value for `value-committed`. */
  value?: string
  /** Per-requirement timeout override (ms). */
  timeoutMs?: number
}

/** The readiness contract of one node. */
export interface ReadinessSpec {
  /** States that must hold before the action runs. */
  before?: ReadinessRequirement[]
  /** States that must hold after the action ran (post-action verification). */
  after?: ReadinessRequirement[]
  /** Poll window for the whole spec (ms). */
  timeoutMs?: number
  /** Poll cadence (ms). */
  pollIntervalMs?: number
}

/** Default readiness window (ms) — generous enough for slow renders, capped. */
export const DEFAULT_READINESS_TIMEOUT_MS = 8000

/** Default poll cadence (ms) — every poll RE-RESOLVES, so keep this honest. */
export const DEFAULT_READINESS_POLL_MS = 150

/** Poll windows we refuse to exceed (a readiness wait is not a sleep). */
export const MAX_READINESS_TIMEOUT_MS = 60_000

function requirement(state: ReadinessRequirement): ReadinessRequirement {
  return state
}

/**
 * The default readiness table (§7.3). Keyed by canonical block id; the
 * generated-strict runtime applies it to every node whose `__reliability`
 * does not carry an explicit readiness spec. Blocks not listed have no
 * default (their executors keep their own waiting — downloads, tabs,
 * webhooks, loops — which §7.4 explicitly preserves).
 */
export function defaultReadinessFor(
  blockId: string,
  data: Record<string, unknown> = {},
): ReadinessSpec | undefined {
  switch (blockId) {
    case 'click':
    case 'event-click':
    case 'hover-element':
      return {
        before: [requirement({ state: 'present' }), requirement({ state: 'visible' }), requirement({ state: 'enabled' })],
      }
    case 'forms':
    case 'fill': {
      const action = String(data['action'] ?? 'fill')
      if (action === 'submit') {
        // A submit acts on its control; the VERIFIED outcome is page-level and
        // belongs to postconditions, not to a default here.
        return {
          before: [requirement({ state: 'present' }), requirement({ state: 'visible' }), requirement({ state: 'enabled' })],
        }
      }
      return {
        before: [requirement({ state: 'present' }), requirement({ state: 'visible' }), requirement({ state: 'enabled' })],
        after: [requirement({ state: 'value-committed', value: String(data['value'] ?? '') })],
      }
    }
    case 'select-option':
    case 'set-checkbox':
      return {
        before: [requirement({ state: 'present' }), requirement({ state: 'visible' }), requirement({ state: 'enabled' })],
        after: [requirement({ state: 'value-committed', value: String(data['value'] ?? '') })],
      }
    case 'get-text':
      return { before: [requirement({ state: 'present' }), requirement({ state: 'visible' })] }
    case 'attribute-value':
      return { before: [requirement({ state: 'present' })] }
    case 'read-page':
      return { before: [requirement({ state: 'navigation-settled' })] }
    case 'new-tab':
    case 'open-url':
    case 'go-back':
    case 'forward-page':
    case 'reload-tab':
    case 'visit-web':
      return { after: [requirement({ state: 'navigation-settled' })] }
    default:
      return undefined
  }
}

/** Is `state` one of the vocabulary values? (Guard for untrusted specs.) */
export function isReadinessState(value: unknown): value is ReadinessState {
  return (
    value === 'present' ||
    value === 'visible' ||
    value === 'enabled' ||
    value === 'stable' ||
    value === 'navigation-settled' ||
    value === 'value-committed' ||
    value === 'data-ready'
  )
}

function isRequirement(value: unknown): value is ReadinessRequirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!isReadinessState(raw['state'])) return false
  if (raw['target'] !== undefined && (typeof raw['target'] !== 'object' || raw['target'] === null)) {
    return false
  }
  if (raw['timeoutMs'] !== undefined && typeof raw['timeoutMs'] !== 'number') return false
  return true
}

/**
 * Normalize an untrusted readiness spec: keep only well-formed requirements,
 * clamp the timeout into [poll, MAX]. Returns `undefined` for garbage —
 * callers then fall back to the block default.
 */
export function normalizeReadinessSpec(value: unknown): ReadinessSpec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const before = Array.isArray(raw['before']) ? raw['before'].filter(isRequirement) : undefined
  const after = Array.isArray(raw['after']) ? raw['after'].filter(isRequirement) : undefined
  if (!before?.length && !after?.length) return undefined
  const timeoutRaw = Number(raw['timeoutMs'])
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(MAX_READINESS_TIMEOUT_MS, timeoutRaw)
      : DEFAULT_READINESS_TIMEOUT_MS
  const pollRaw = Number(raw['pollIntervalMs'])
  const pollIntervalMs =
    Number.isFinite(pollRaw) && pollRaw > 0 ? Math.min(2000, pollRaw) : DEFAULT_READINESS_POLL_MS
  return {
    ...(before?.length ? { before } : {}),
    ...(after?.length ? { after } : {}),
    timeoutMs,
    pollIntervalMs,
  }
}
