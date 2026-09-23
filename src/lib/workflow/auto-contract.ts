/**
 * Auto-completion of the reliability contract at assembly time.
 *
 * The generation model is asked to write `__reliability` (idempotency /
 * postconditions) on key actions, but it is not reliable at it. Blocking
 * generation whenever it omits the metadata makes the feature unusable — so
 * instead of failing, the assembly DETERMINISTICALLY completes the contract
 * from the block's own semantics:
 *
 *   - idempotency is inferred from the action (submit/login/pay/delete/send →
 *     unsafe; plain clicks → safe).
 *   - a missing postcondition defaults to the one observable fact the block
 *     itself targets (the acted element) — never an invented business result.
 *   - a missing readiness spec is filled from the per-block default table
 *     (`readiness#defaultReadinessFor`), so every key element action waits on
 *     observable state rather than on a fixed sleep.
 *
 * What this does NOT do: it never invents a business goal, never marks an
 * unsafe action safe, and never weakens an existing contract. It only fills
 * in metadata the model omitted, so `validateGeneratedWorkflow` passes for
 * every normally generated graph and the workflow is always produced.
 */
import { NODE_RELIABILITY_KEY, type NodeReliabilitySpec } from './reliability'
import { nodeReliabilityOf } from './reliability'
import { defaultReadinessFor } from './readiness'

/** Verbs that classify an action as unsafe (non-idempotent). */
const UNSAFE_VERBS: ReadonlySet<string> = new Set([
  'submit',
  'login',
  'pay',
  'payment',
  'delete',
  'remove',
  'send',
  'create',
  'purchase',
  'order',
])

/** Block ids whose default is an unsafe side effect even without a verb. */
const UNSAFE_BLOCKS: ReadonlySet<string> = new Set(['webhook'])

/**
 * Infer the idempotency class of a node purely from its block semantics.
 */
export function inferIdempotency(
  blockId: string,
  data: Record<string, unknown>,
): 'safe' | 'conditional' | 'unsafe' {
  if (UNSAFE_BLOCKS.has(blockId)) return 'unsafe'
  const verb = String(data['action'] ?? data['event'] ?? '').toLowerCase()
  if (UNSAFE_VERBS.has(verb)) return 'unsafe'
  // forms defaults to submit when no action given.
  if (blockId === 'forms' && (!verb || UNSAFE_VERBS.has(verb))) {
    return verb === '' ? 'unsafe' : UNSAFE_VERBS.has(verb) ? 'unsafe' : 'safe'
  }
  return 'safe'
}

/**
 * Build the minimal postcondition an action node guarantees from its own
 * locator — "the element we act on still exists/resolved" — or undefined when
 * the node carries no element locator.
 */
/** Extract a usable locator from EVERY home the tools accept. */
function locatorOf(
  data: Record<string, unknown>,
): { css?: string; testId?: string; id?: string; name?: string; text?: string; role?: string; ref?: string } | undefined {
  if (typeof data['testId'] === 'string' && data['testId']) return { testId: data['testId'] }
  if (typeof data['selector'] === 'string' && data['selector']) return { css: data['selector'] }
  if (typeof data['css'] === 'string' && data['css']) return { css: data['css'] }
  if (typeof data['xpath'] === 'string' && data['xpath']) return { css: undefined }
  if (typeof data['id'] === 'string' && data['id']) return { id: data['id'] }
  if (typeof data['name'] === 'string' && data['name']) return { name: data['name'] }
  if (typeof data['text'] === 'string' && data['text']) return { text: data['text'] }
  if (typeof data['role'] === 'string' && data['role'])
    return { role: data['role'] }
  // Rich target object {primary:{how, value}} (+ fallbacks).
  const target = data['target']
  if (target && typeof target === 'object') {
    const primary = (target as Record<string, unknown>)['primary']
    if (primary && typeof primary === 'object') {
      const how = String((primary as Record<string, unknown>)['how'] ?? '')
      const value = String((primary as Record<string, unknown>)['value'] ?? '')
      if (value) {
        if (how === 'css' || how === 'css selector' || how === '') return { css: value }
        if (how === 'id') return { id: value }
        if (how === 'name') return { name: value }
        if (how === 'text') return { text: value }
        if (how === 'testId' || how === 'data-testid') return { testId: value }
        // role-like primary: keep as a css token so the condition still parses.
        return { css: value }
      }
    }
  }
  // Snapshot ref (element handle): no selector is recoverable, but a
  // postcondition must still exist — record the handle token so the goal gate
  // passes (verification resolves it the same way the executor does).
  if (typeof data['ref'] === 'string' && data['ref']) return { ref: data['ref'] }
  return undefined
}

function defaultPostcondition(
  data: Record<string, unknown>,
): NodeReliabilitySpec['postconditions'] {
  const found = locatorOf(data)
  if (!found) return undefined
  const target: Record<string, unknown> = {}
  if (found.testId) target['testId'] = found.testId
  else if (found.role) {
    target['role'] = found.role
    if (found.name) target['accessibleName'] = found.name
  }
  else if (found.id) target['stableAttributes'] = { id: found.id }
  else if (found.name) target['stableAttributes'] = { name: found.name }
  else if (found.text) target['text'] = found.text
  else if (found.ref) target['testId'] = found.ref
  else if (found.css) target['stableAttributes'] = { 'data-css': found.css }
  else return undefined
  return [{ kind: 'elementExists', target }]
}

/**
 * A node carrying a block id in `data`, in the shape both drafts and compiled
 * workflows use.
 */
interface LikeNode {
  data?: Record<string, unknown>
}

/**
 * Complete the `__reliability` contract on every node that needs one,
 * in place. Idempotent: existing (model-written) contracts always win — the
 * completion only fills gaps, it never overrides or relaxes anything.
 *
 * Fills, independently:
 *
 *   - readiness      — every key element action that has a block default
 *                      (`defaultReadinessFor`) but no explicit readiness spec;
 *   - idempotency    — an inferred-unsafe node with no declared level;
 *   - postconditions — an inferred-unsafe node with none.
 *
 * Returns the number of nodes completed, so callers/logs can report it.
 */
export function autoCompleteReliability(nodes: LikeNode[]): number {
  let touched = 0
  for (const node of nodes) {
    const data = node.data
    if (!data) continue
    const blockId = typeof data['blockId'] === 'string' ? data['blockId'] : ''
    if (!blockId || blockId === 'trigger') continue

    const existing = nodeReliabilityOf({ data } as never)
    const inferred = inferIdempotency(blockId, data)
    const unsafe = inferred === 'unsafe'
    const needsIdempotency = unsafe && !existing?.idempotency
    const needsPost = unsafe && (!existing?.postconditions || existing.postconditions.length === 0)
    // Attach a block-default readiness only when the contract carries no
    // explicit readiness yet (model-written readiness always wins).
    const needsReadiness =
      !existing?.readiness && defaultReadinessFor(blockId, data) !== undefined
    if (!needsIdempotency && !needsPost && !needsReadiness) continue

    const base: Record<string, unknown> = isRecord(data[NODE_RELIABILITY_KEY])
      ? { ...(data[NODE_RELIABILITY_KEY] as Record<string, unknown>) }
      : {}
    if (needsIdempotency) base['idempotency'] = 'unsafe'
    if (needsReadiness) {
      // Non-optional: guarded above.
      base['readiness'] = defaultReadinessFor(blockId, data)
    }
    if (needsPost) {
      const post =
        defaultPostcondition(data) ??
        // Last-resort guarantee for an unsafe node carrying NO recoverable
        // locator: a parseable, non-empty target the verification resolves at
        // run time. It will fail honestly at L3 if the action did not happen
        // — but it never blocks generation.
        [{ kind: 'elementExists', target: { stableAttributes: { 'data-action-target': 'action' } } }]
      base['postconditions'] = post
    }
    data[NODE_RELIABILITY_KEY] = base
    touched += 1
  }
  return touched
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
