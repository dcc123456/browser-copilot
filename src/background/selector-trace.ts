/**
 * Fine-grained selector tracing for workflow generation.
 *
 * When a model completes a task with a PRECISE locator but the generated
 * workflow records a GENERIC one, the replay fails and nobody can tell where
 * the two diverged. This module collects one trace per `wf_op_*` element call
 * describing every stage of the locator pipeline:
 *
 *   1. the raw locator arguments the model actually sent (ref / target /
 *      selector, verbatim);
 *   2. the locator resolved from those (ref cache → inline target → raw
 *      selector);
 *   3. every CSS candidate probed against the live page and its match count;
 *   4. the selector chosen for the node and its verification state;
 *   5. the spec the executor REALLY clicked with (returned by the page), so
 *      "executed selector" and "recorded selector" can be compared directly.
 *
 * Traces are emitted with `console.info` (prefixed so they survive the
 * service-worker log filter) AND collected in an in-memory ring readable from
 * tests and from the debug surfaces. They carry no credential values: the
 * secret guard's redaction is applied by the caller before fields land here.
 *
 * @module background/selector-trace
 */

/** One probed CSS candidate with its live match count. */
export interface SelectorProbeEntry {
  /** The candidate CSS selector, verbatim. */
  selector: string
  /** Live `querySelectorAll` count; `-1` = invalid selector. */
  count: number
}

/** One stage of the locator pipeline, in execution order. */
export type SelectorTraceStage =
  | 'raw'
  | 'resolved'
  | 'probed'
  | 'chosen'
  | 'executed'

/** The trace recorded for one element-taking operator call. */
export interface SelectorTrace {
  /** Conversation the call belongs to. */
  conversationId: string
  /** Operator tool name, e.g. `wf_op_event-click`. */
  toolName: string
  /** Block id, e.g. `event-click`. */
  blockId: string
  /** Epoch ms. */
  at: number
  /**
   * The locator inputs as the model sent them. A `ref` is recorded as its
   * handle; `target` / `selector` are truncated descriptors, never secrets.
   */
  raw: {
    ref?: string
    selector?: string
    targetPrimary?: string
    fallbackCount?: number
  }
  /** The locator resolved from the raw inputs (see `resolveRecordedLocator`). */
  resolved?: {
    selector: string
    hasTarget: boolean
    label?: string
  }
  /** Every CSS candidate probed against the page and its live count. */
  probes?: SelectorProbeEntry[]
  /** The selector picked for the node and whether it was verified. */
  chosen?: {
    selector: string
    verified: boolean
  }
  /**
   * The serialized spec the page-side kernel REALLY resolved the element
   * with (`how|value`), and whether a fallback spec won. This is the truth
   * about what got executed — the field to compare against `chosen`.
   */
  executed?: {
    usedSpec: string
    usedFallback: boolean
    matched: number
  }
  /** Whether the call ultimately succeeded. */
  ok: boolean
  /** Error text on failure (already developer-facing, may be bilingual). */
  error?: string
}

/** Cap on retained traces — a generation session is never longer than this. */
const TRACE_RING_CAP = 200

/** In-memory ring of the most recent traces, newest last. */
const ring: SelectorTrace[] = []

/** Log prefix used for every console emission. */
export const SELECTOR_TRACE_PREFIX = '[wf-selector]'

/**
 * Open one trace for a call. The raw stage is recorded immediately so a
 * refusal or throw before resolution still leaves evidence of what the model
 * sent.
 */
export function beginSelectorTrace(input: {
  conversationId: string
  toolName: string
  blockId: string
  rawArgs: Record<string, unknown>
}): SelectorTrace {
  const raw = input.rawArgs
  const target = raw['target']
  const primary =
    target && typeof target === 'object'
      ? (target as { primary?: unknown }).primary
      : undefined
  const primaryText = primary && typeof primary === 'object'
    ? String(
        (primary as { how?: unknown }).how ?? '',
      ) +
      '|' +
      String((primary as { value?: unknown }).value ?? '')
    : undefined
  const trace: SelectorTrace = {
    conversationId: input.conversationId,
    toolName: input.toolName,
    blockId: input.blockId,
    at: Date.now(),
    raw: {
      ...(typeof raw['ref'] === 'string' && raw['ref'].trim()
        ? { ref: raw['ref'].trim() }
        : {}),
      ...(typeof raw['selector'] === 'string' && raw['selector'].trim()
        ? { selector: raw['selector'].trim() }
        : {}),
      ...(primaryText
        ? { targetPrimary: primaryText.slice(0, 200) }
        : {}),
      ...(target &&
      typeof target === 'object' &&
      Array.isArray((target as { fallbacks?: unknown }).fallbacks)
        ? {
            fallbackCount: (
              (target as { fallbacks: unknown[] }).fallbacks
            ).length,
          }
        : {}),
    },
    ok: false,
  }
  return trace
}

/** Record one stage onto an open trace and return the same object. */
export function markResolved(
  trace: SelectorTrace,
  resolved: { selector: string; hasTarget: boolean; label?: string },
): SelectorTrace {
  trace.resolved = {
    selector: resolved.selector,
    hasTarget: resolved.hasTarget,
    ...(resolved.label ? { label: resolved.label.slice(0, 120) } : {}),
  }
  return trace
}

/** Record the candidate probes and their live match counts. */
export function markProbed(
  trace: SelectorTrace,
  candidates: readonly string[],
  counts: readonly number[],
): SelectorTrace {
  trace.probes = candidates.map((selector, index) => ({
    selector,
    count: counts[index] ?? -1,
  }))
  return trace
}

/** Record the selector chosen for the node. */
export function markChosen(
  trace: SelectorTrace,
  chosen: { selector: string; verified: boolean },
): SelectorTrace {
  trace.chosen = { selector: chosen.selector, verified: chosen.verified }
  return trace
}

/**
 * Record what the page-side executor really clicked with.
 *
 * `usedSpec` is the kernel's `how|value` serialized spec; surfacing it is the
 * whole point of the trace — when it differs from `chosen.selector`, the
 * recorded node does not replay what actually worked.
 */
export function markExecuted(
  trace: SelectorTrace,
  executed: { usedSpec?: string; usedFallback?: boolean; matched?: number },
): SelectorTrace {
  if (typeof executed.usedSpec === 'string') {
    trace.executed = {
      usedSpec: executed.usedSpec,
      usedFallback: executed.usedFallback === true,
      matched: typeof executed.matched === 'number' ? executed.matched : 0,
    }
  }
  return trace
}

/**
 * Finish and retain a trace. Emits a single compact console line with the
 * raw input, the recorded selector and the executed spec, followed by probe
 * detail when the recorded and executed locators diverged.
 */
export function commitSelectorTrace(
  trace: SelectorTrace,
  outcome: { ok: boolean; error?: string },
): SelectorTrace {
  trace.ok = outcome.ok
  if (outcome.error) trace.error = outcome.error.slice(0, 300)

  const chosen = trace.chosen?.selector
    ? `"${trace.chosen.selector}"${trace.chosen.verified ? ' verified' : ''}`
    : '(none)'
  const executed = trace.executed?.usedSpec
    ? `${trace.executed.usedSpec}${trace.executed.usedFallback ? ' [fallback]' : ''}`
    : '(not reported)'
  const raw = trace.raw.ref
    ? `ref=${trace.raw.ref}`
    : trace.raw.selector
      ? `selector="${trace.raw.selector}"`
      : trace.raw.targetPrimary
        ? `target=${trace.raw.targetPrimary}`
        : '(no locator)'
  console.info(
    `${SELECTOR_TRACE_PREFIX} ${trace.toolName} ${outcome.ok ? 'OK' : 'FAIL'} raw ${raw} → recorded ${chosen} → executed ${executed}`,
  )
  if (trace.probes && trace.probes.length > 0) {
    const detail = trace.probes
      .map((probe) => `${probe.count}× ${probe.selector}`)
      .join(' · ')
    console.info(`${SELECTOR_TRACE_PREFIX}   probes: ${detail}`)
  }
  if (trace.error) {
    console.info(`${SELECTOR_TRACE_PREFIX}   error: ${trace.error}`)
  }

  ring.push(trace)
  while (ring.length > TRACE_RING_CAP) ring.shift()
  return trace
}

/** All retained traces, oldest first. */
export function selectorTraces(): readonly SelectorTrace[] {
  return ring
}

/** Traces for one conversation, oldest first. */
export function selectorTracesOf(
  conversationId: string,
): readonly SelectorTrace[] {
  return ring.filter((trace) => trace.conversationId === conversationId)
}

/** Drop every retained trace (test hook). */
export function resetSelectorTraces(): void {
  ring.length = 0
}
