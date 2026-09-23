/**
 * Server-side trace alignment codec (spec §15 Phase 8 · P3).
 *
 * The browser MV3 engine and any server / Node-side runner must exchange an
 * ExecutionTrace that means exactly the same thing on both sides. This module
 * is the single canonical wire adapter:
 *
 *   - {@link TRACE_CODEC_VERSION} versions the envelope;
 *   - {@link encodeTrace} normalizes an in-memory trace (Maps are already
 *     absent; this guarantees field presence/absence and strips any accidental
 *     non-serializable runtime data) into a stable JSON envelope;
 *   - {@link decodeTrace} validates the envelope and reconstructs the trace,
 *     accepting older versions through {@link migrateTraceEnvelope};
 *   - {@link canonicalTraceJson} is the deterministic serialization used so a
 *     trace hashes identically on the browser and the server.
 *
 * The decoder is defensive: an envelope it cannot understand returns a
 * diagnostic rather than throwing, and unknown future fields are preserved
 * (forward compatibility). Pure — no browser / provider / fs.
 *
 * @module lib/workflow/repair/trace-codec
 */

import type { ExecutionTrace, TraceEntry } from './types'

/** Current wire-envelope version. */
export const TRACE_CODEC_VERSION = 1

/** Versioned JSON envelope exchanged between browser and server. */
export interface TraceEnvelope {
  kind: 'bc.executionTrace'
  v: number
  trace: ExecutionTrace
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ENTRIES: readonly TraceEntry[] = ['GENERATION', 'DEBUG', 'VERIFY', 'REPLAY']
const OUTCOMES = ['ok', 'failed', 'cancelled'] as const

/**
 * Bring an older envelope up to the current version. Only `v: 1` exists today;
 * the switch is where future migrations are added deterministically.
 */
export function migrateTraceEnvelope(envelope: TraceEnvelope): TraceEnvelope {
  switch (envelope.v) {
    case TRACE_CODEC_VERSION:
      return envelope
    default:
      return envelope
  }
}

/** Encode a trace into the canonical, versioned wire envelope. */
export function encodeTrace(trace: ExecutionTrace): TraceEnvelope {
  // JSON round-trip guarantees a plain, serializable payload and drops any
  // runtime-only fields that cannot cross the browser/server boundary.
  const serialized = JSON.parse(JSON.stringify(trace)) as ExecutionTrace
  return {
    kind: 'bc.executionTrace',
    v: TRACE_CODEC_VERSION,
    trace: serialized,
  }
}

export interface DecodeResult {
  ok: boolean
  trace?: ExecutionTrace
  reason?: string
}

/** Decode + validate a wire envelope back into an ExecutionTrace. */
export function decodeTrace(input: unknown): DecodeResult {
  if (!isRecord(input)) {
    return { ok: false, reason: 'trace envelope is not an object' }
  }
  if (input['kind'] !== 'bc.executionTrace') {
    return { ok: false, reason: 'envelope kind mismatch' }
  }
  if (typeof input['v'] !== 'number') {
    return { ok: false, reason: 'envelope version missing' }
  }
  const traceRaw = input['trace']
  if (!isRecord(traceRaw)) {
    return { ok: false, reason: 'envelope trace missing' }
  }

  // Structural validation of the required identity fields.
  if (typeof traceRaw['traceId'] !== 'string') {
    return { ok: false, reason: 'trace.traceId missing' }
  }
  if (typeof traceRaw['workflowId'] !== 'string') {
    return { ok: false, reason: 'trace.workflowId missing' }
  }
  if (typeof traceRaw['runId'] !== 'string') {
    return { ok: false, reason: 'trace.runId missing' }
  }
  if (!ENTRIES.includes(traceRaw['entry'] as TraceEntry)) {
    return { ok: false, reason: 'trace.entry invalid' }
  }
  if (!OUTCOMES.includes(traceRaw['outcome'] as (typeof OUTCOMES)[number])) {
    return { ok: false, reason: 'trace.outcome invalid' }
  }
  for (const key of ['events', 'nodeExecutions', 'checkpoints'] as const) {
    if (!Array.isArray(traceRaw[key])) {
      return { ok: false, reason: `trace.${key} must be an array` }
    }
  }
  if (!isRecord(traceRaw['finalVariables'])) {
    return { ok: false, reason: 'trace.finalVariables must be an object' }
  }

  const migrated = migrateTraceEnvelope(input as unknown as TraceEnvelope)
  return { ok: true, trace: migrated.trace }
}

/**
 * Deterministic JSON text for an envelope: sorted object keys, so the same
 * trace serializes byte-for-byte identically in the browser and on the server
 * (used for cross-environment signatures / hashing).
 */
export function canonicalTraceJson(trace: ExecutionTrace): string {
  const envelope = encodeTrace(trace)
  return stableStringify(envelope)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}
