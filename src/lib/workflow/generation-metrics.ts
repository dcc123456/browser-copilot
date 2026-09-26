/**
 * Workflow generation metrics (spec §30).
 *
 * Lightweight, in-memory counters for one generation session: discovery calls,
 * candidates returned, operator attempts and failures, recovery transitions,
 * JS usage (and whether it followed a capability gap), repair rounds, and
 * token/tool totals. A {@link recordGenerationMetrics} snapshot is what the
 * acceptance targets (§31) are measured against.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/generation-metrics
 */

/** Mutable metrics accumulator for one generation session. */
export interface GenerationMetrics {
  discoveryCalls: number
  candidatesReturned: number
  operatorAttempts: number
  operatorFailures: number
  recoveryTransitions: number
  jsCalls: number
  /** JS calls that were rejected because a native operator exists. */
  jsRejectedNative: number
  /** JS calls allowed only after a documented capability gap. */
  jsAllowedCapabilityGap: number
  repairRounds: number
  nodesRecorded: number
  toolCalls: number
  promptTokens: number
  completionTokens: number
  startedAt: number
  finishedAt?: number
}

/** Create an empty metrics accumulator. */
export function newGenerationMetrics(now = Date.now()): GenerationMetrics {
  return {
    discoveryCalls: 0,
    candidatesReturned: 0,
    operatorAttempts: 0,
    operatorFailures: 0,
    recoveryTransitions: 0,
    jsCalls: 0,
    jsRejectedNative: 0,
    jsAllowedCapabilityGap: 0,
    repairRounds: 0,
    nodesRecorded: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    startedAt: now,
  }
}

/** Apply one metrics event. */
export function recordMetric(
  metrics: GenerationMetrics,
  event:
    | { type: 'discovery'; candidates: number }
    | { type: 'operator-attempt' }
    | { type: 'operator-failure' }
    | { type: 'recovery' }
    | { type: 'js-request' }
    | { type: 'js-rejected-native' }
    | { type: 'js-allowed-gap' }
    | { type: 'repair-round' }
    | { type: 'node-recorded' }
    | { type: 'tool-call' }
    | { type: 'tokens'; prompt?: number; completion?: number }
    | { type: 'finish' },
): void {
  switch (event.type) {
    case 'discovery':
      metrics.discoveryCalls += 1
      metrics.candidatesReturned += event.candidates
      return
    case 'operator-attempt':
      metrics.operatorAttempts += 1
      return
    case 'operator-failure':
      metrics.operatorFailures += 1
      return
    case 'recovery':
      metrics.recoveryTransitions += 1
      return
    case 'js-request':
      metrics.jsCalls += 1
      return
    case 'js-rejected-native':
      metrics.jsRejectedNative += 1
      return
    case 'js-allowed-gap':
      metrics.jsAllowedCapabilityGap += 1
      return
    case 'repair-round':
      metrics.repairRounds += 1
      return
    case 'node-recorded':
      metrics.nodesRecorded += 1
      return
    case 'tool-call':
      metrics.toolCalls += 1
      return
    case 'tokens':
      metrics.promptTokens += event.prompt ?? 0
      metrics.completionTokens += event.completion ?? 0
      return
    case 'finish':
      metrics.finishedAt = Date.now()
      return
  }
}

/** Derived acceptance measurements (§31). */
export interface MetricsSummary {
  /** Operator attempts per recorded node (lower is better). */
  attemptsPerNode: number
  /** Share of operator attempts that failed. */
  failureRate: number
  /** Whether every allowed JS call followed a capability gap. */
  jsOnlyViaGap: boolean
  totalTokens: number
  durationMs: number
}

/** Summarise raw metrics into acceptance measurements. */
export function summarizeMetrics(metrics: GenerationMetrics): MetricsSummary {
  const durationMs = (metrics.finishedAt ?? Date.now()) - metrics.startedAt
  return {
    attemptsPerNode: metrics.nodesRecorded
      ? Number((metrics.operatorAttempts / metrics.nodesRecorded).toFixed(2))
      : 0,
    failureRate: metrics.operatorAttempts
      ? Number((metrics.operatorFailures / metrics.operatorAttempts).toFixed(3))
      : 0,
    jsOnlyViaGap:
      metrics.jsAllowedCapabilityGap + metrics.jsRejectedNative >= metrics.jsCalls,
    totalTokens: metrics.promptTokens + metrics.completionTokens,
    durationMs,
  }
}
