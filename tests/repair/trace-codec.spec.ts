/**
 * Server-side trace alignment codec tests (spec §15 Phase 8 · P3).
 */
import { describe, expect, it } from 'vitest'

import {
  canonicalTraceJson,
  decodeTrace,
  encodeTrace,
  TRACE_CODEC_VERSION,
} from '../../src/lib/workflow/repair/trace-codec'
import type { ExecutionTrace } from '../../src/lib/workflow/repair/types'

const baseTrace: ExecutionTrace = {
  traceId: 't1',
  workflowId: 'wf1',
  runId: 'r1',
  entry: 'DEBUG',
  startedAt: 1,
  outcome: 'failed',
  events: [{ sequence: 0, at: 1, kind: 'error', text: 'boom' }],
  nodeExecutions: [
    {
      nodeId: 'n1',
      blockId: 'click',
      attempt: 0,
      status: 'failed',
      inputVariables: [],
      outputVariables: [],
    },
  ],
  checkpoints: [],
  finalVariables: {
    captcha: { exists: false, redacted: false },
  },
  failedNodeId: 'n1',
}

describe('trace codec', () => {
  it('round-trips a trace through the versioned envelope', () => {
    const envelope = encodeTrace(baseTrace)
    expect(envelope.kind).toBe('bc.executionTrace')
    expect(envelope.v).toBe(TRACE_CODEC_VERSION)
    const decoded = decodeTrace(envelope)
    expect(decoded.ok).toBe(true)
    expect(decoded.trace).toEqual(baseTrace)
  })

  it('produces byte-identical canonical JSON regardless of key order', () => {
    const a = canonicalTraceJson(baseTrace)
    // Re-parse and rebuild the envelope inserting keys in REVERSE order.
    const parsed = JSON.parse(a) as Record<string, unknown>
    const reversed: Record<string, unknown> = {}
    for (const key of Object.keys(parsed).sort().reverse()) {
      reversed[key] = parsed[key]
    }
    // Same content → same canonical text even though source key order differs.
    expect(canonicalTraceJson(decodeTrace(reversed).trace!)).toBe(a)
  })

  it('rejects malformed envelopes with a diagnostic (never throws)', () => {
    expect(decodeTrace(null).ok).toBe(false)
    expect(decodeTrace({ kind: 'other' }).reason).toMatch(/kind/)
    expect(decodeTrace({ kind: 'bc.executionTrace', v: 1, trace: {} }).reason).toMatch(/traceId/)
    const badOutcome = {
      kind: 'bc.executionTrace',
      v: 1,
      trace: { ...baseTrace, outcome: 'weird' },
    }
    expect(decodeTrace(badOutcome).reason).toMatch(/outcome/)
  })

  it('strips non-serializable runtime data on encode', () => {
    const trace: ExecutionTrace & { runtime?: unknown } = {
      ...baseTrace,
      runtime: () => undefined,
    }
    const decoded = decodeTrace(encodeTrace(trace))
    expect(decoded.ok).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(decoded.trace!, 'runtime')).toBe(false)
  })
})
