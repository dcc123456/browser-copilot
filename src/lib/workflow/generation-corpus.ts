/**
 * Legacy selftest rounds → sanitized generation attempts.
 *
 * The only real-model corpus this repository has sits in gitignored
 * `tmp/selftest-round*.json` files written by `pnpm selftest`. They are useful
 * to keep as fixtures, but they are not safe or stable as-is: they carry wall
 * clocks, workflow / conversation / run ids, workflow names, goal summaries and
 * save-warning prose that names real selectors and page copy.
 *
 * This module is the mapping in one place — the exporter writes the fixtures,
 * and the regression spec reads them back. It is pure and synchronous: the
 * caller supplies the round number (the filename carries it) and the build
 * stamp hash (hashing is language-level crypto, which does not belong in
 * `src/lib/**`).
 *
 * Cross-era scores are NOT comparable: the rounds span validator generations,
 * so "static errors" below means "the warnings that were recorded at the time",
 * not a re-run of today's validator.
 *
 * @module lib/workflow/generation-corpus
 */

import {
  failureKindOfAttempt,
  normalizeGenerationAttempt,
  scoreGenerationAttempt,
  type ComposeFacts,
  type GenerationAttemptRecord,
  type GoalFacts,
  type ReplayFacts,
  type TrialFacts,
} from './generation-attempt'

/** Rounds that ship as fixtures. Round 1 was never written; 84+ are excluded. */
export const CORPUS_FIRST_ROUND = 2
export const CORPUS_LAST_ROUND = 83

/** Why the corpus stops at 83: see the design spec. */
export const CORPUS_EXCLUDED = {
  from: 84,
  to: 112,
  reason: '429 quota + concurrent src edits',
} as const

const GOAL_LEVELS = ['L1', 'L2', 'L3', 'NONE'] as const

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringAt(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberAt(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function booleanAt(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function trialFactsOf(raw: unknown): TrialFacts | undefined {
  const trial = recordOf(raw)
  const outcome = stringAt(trial, 'outcome')
  const full = booleanAt(trial, 'full')
  const coveredSteps = numberAt(trial, 'coveredSteps')
  const totalSteps = numberAt(trial, 'totalSteps')
  if (outcome === undefined || full === undefined || coveredSteps === undefined) return undefined
  if (totalSteps === undefined) return undefined
  return {
    outcome,
    full,
    coveredSteps,
    totalSteps,
    ...(stringAt(trial, 'failureCode') ? { failureCode: stringAt(trial, 'failureCode') } : {}),
    ...(booleanAt(trial, 'draftSaved') !== undefined
      ? { draftSaved: booleanAt(trial, 'draftSaved') as boolean }
      : {}),
    ...(numberAt(trial, 'degradedSteps') !== undefined
      ? { degradedSteps: numberAt(trial, 'degradedSteps') as number }
      : {}),
  }
}

function goalFactsOf(raw: unknown): GoalFacts | undefined {
  const goal = recordOf(raw)
  const level = stringAt(goal, 'level')
  const certified = booleanAt(goal, 'certified')
  if (level === undefined || certified === undefined) return undefined
  if (!(GOAL_LEVELS as readonly string[]).includes(level)) return undefined
  const unmet = Array.isArray(goal?.['unmet']) ? goal['unmet'].length : 0
  return { level: level as GoalFacts['level'], certified, unmetCount: unmet }
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

const STATIC_CODE = /^\[([A-Z0-9_]+)\]/
const COVERAGE_GAP = /Generation coverage gap: (\d+) operator step/

/** Static findings a round recorded, as codes rather than prose. */
function staticFactsOf(saveWarnings: readonly string[]): {
  codes: string[]
  errorCount: number
  coverageGap: number
} {
  const codes: string[] = []
  let coverageGap = 0
  for (const warning of saveWarnings) {
    const code = STATIC_CODE.exec(warning)?.[1]
    if (code) codes.push(code)
    const gap = COVERAGE_GAP.exec(warning)
    if (gap) coverageGap = Math.max(coverageGap, Number(gap[1]))
  }
  return { codes: [...new Set(codes)].sort(), errorCount: codes.length, coverageGap }
}

function blockCountsOf(nodes: unknown): Record<string, number> | undefined {
  if (!Array.isArray(nodes)) return undefined
  const counts: Record<string, number> = {}
  for (const node of nodes) {
    const blockId = stringAt(recordOf(node), 'blockId')
    if (blockId) counts[blockId] = (counts[blockId] ?? 0) + 1
  }
  return Object.keys(counts).length > 0 ? counts : undefined
}

function composeFactsOf(
  workflow: Record<string, unknown>,
  trial: TrialFacts | undefined,
  goal: GoalFacts | undefined,
): ComposeFacts {
  const warnings = stringsOf(workflow['saveWarnings'])
  const staticFacts = staticFactsOf(warnings)
  const blockCounts = blockCountsOf(workflow['nodes'])
  const terminalStepMissing = booleanAt(workflow, 'terminalStepMissing') === true
  return {
    saved: booleanAt(workflow, 'saved') === true,
    nodeCount: numberAt(workflow, 'nodeCount') ?? 0,
    // A cross-era reading: only what the round recorded, not a re-validation.
    staticOk: staticFacts.errorCount === 0,
    staticCodes: staticFacts.codes,
    staticErrorCount: staticFacts.errorCount,
    staticWarningCount: 0,
    ...(terminalStepMissing ? { terminalStepMissing: true } : {}),
    ...(staticFacts.coverageGap > 0 ? { coverageGap: staticFacts.coverageGap } : {}),
    ...(blockCounts ? { blockCounts } : {}),
    ...(trial ? { trial } : {}),
    ...(goal ? { goal } : {}),
  }
}

function repairFactsOf(verdict: Record<string, unknown>): ReplayFacts['repair'] | undefined {
  const status = stringAt(verdict, 'repairStatus')
  if (status === undefined) return undefined
  return {
    attempted: status !== 'not-needed',
    status,
    attempts: numberAt(verdict, 'repairAttempts') ?? 0,
    committed: booleanAt(verdict, 'repairCommitted') === true,
  }
}

function replayFactsOf(
  verdict: Record<string, unknown>,
  trial: TrialFacts | undefined,
  goal: GoalFacts | undefined,
): ReplayFacts | undefined {
  const outcome = stringAt(verdict, 'outcome')
  if (outcome === undefined) return undefined
  const repair = repairFactsOf(verdict)
  return {
    ran: true,
    // Same rule the bridge uses: a failed trial is not ok, a timeout or a
    // cutoff stopped safely and still produced a measurement.
    ok: outcome !== 'failed',
    verified: booleanAt(verdict, 'verified') === true,
    ...(booleanAt(verdict, 'proven') !== undefined
      ? { proven: booleanAt(verdict, 'proven') as boolean }
      : {}),
    outcome,
    coveredSteps: numberAt(verdict, 'coveredSteps') ?? trial?.coveredSteps ?? 0,
    totalSteps: numberAt(verdict, 'totalSteps') ?? trial?.totalSteps ?? 0,
    ...((stringAt(verdict, 'failureCode') ?? trial?.failureCode)
      ? { failureCode: (stringAt(verdict, 'failureCode') ?? trial?.failureCode) as string }
      : {}),
    ...(goal ? { goal } : {}),
    ...(repair ? { repair } : {}),
  }
}

export interface LegacyRoundOptions {
  /** Round number, taken from the file name (`selftest-round17.json` → 17). */
  round: number
  /** `sha256(buildStamp)` first 12 hex chars, computed by the caller. */
  buildStampHash?: string
}

/**
 * Map one raw selftest round onto an attempt record.
 *
 * `pass` is the round's own verdict, deliberately: the old harness counted a
 * partial replay as a pass, and re-deriving it would quietly rewrite the
 * baseline this corpus exists to freeze. Everything structural (graph, trial,
 * replay, goal, repair) is carried as facts so the score has something to say.
 */
export function legacyAttemptFromRound(
  raw: unknown,
  options: LegacyRoundOptions,
): GenerationAttemptRecord | undefined {
  const round = recordOf(raw)
  if (!round) return undefined
  const verdict = recordOf(round['verdict']) ?? {}
  const phases = recordOf(round['phases'])
  const verifyResult = recordOf(recordOf(phases?.['verify'])?.['result'])
  const generateResult = recordOf(recordOf(phases?.['generate'])?.['result'])
  const workflow = recordOf(verifyResult?.['workflow']) ?? recordOf(generateResult?.['workflow'])

  const trial = workflow ? trialFactsOf(workflow['trialRun']) : undefined
  const goal = workflow ? goalFactsOf(workflow['goal']) : undefined
  const compose = workflow ? composeFactsOf(workflow, trial, goal) : undefined
  const replay = replayFactsOf(verdict, trial, goal)
  const pass = booleanAt(verdict, 'pass') === true
  const stage = stringAt(verdict, 'stage')

  const base = {
    at: 0,
    attemptId: `round-${String(options.round).padStart(3, '0')}`,
    round: options.round,
    ...(options.buildStampHash ? { buildStampHash: options.buildStampHash } : {}),
    ...(workflow && stringAt(workflow, 'provenance')
      ? { origin: stringAt(workflow, 'provenance') as string }
      : {}),
    ...(stage ? { stage } : {}),
    ...(compose ? { compose } : {}),
    ...(replay ? { replay } : {}),
    pass,
    score: scoreGenerationAttempt({ compose, replay }),
  }
  const failureKind = pass ? undefined : failureKindOfAttempt(base)
  return failureKind ? { ...base, failureKind } : base
}

/**
 * Rebuild an attempt from nothing but the fields a fixture may keep.
 *
 * Runs through the same reader the store uses, so a live-shaped record and an
 * exported one are held to one definition. Wall clocks and live identifiers are
 * replaced rather than dropped — the record shape keeps both.
 */
export function sanitizeAttempt(attempt: unknown): GenerationAttemptRecord | undefined {
  const record = normalizeGenerationAttempt({ ...(recordOf(attempt) ?? {}), at: 0 })
  if (!record) return undefined
  return {
    ...record,
    at: 0,
    attemptId: /^round-\d{3}$/.test(record.attemptId) ? record.attemptId : 'redacted',
  }
}

const FORBIDDEN_KEYS = new Set([
  'id',
  'conversationid',
  'runid',
  'workflowid',
  'nodeid',
  'failednodeid',
  'cutoffnodeid',
])
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/
const URL = /^https?:\/\//
const BARE_ORIGIN = /^https?:\/\/[^/?#\s]+$/
const LONG_CJK = /[\u4e00-\u9fff]{8,}/

function assertSafeValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeValue(entry, `${path}[${index}]`))
    return
  }
  const record = recordOf(value)
  if (record) {
    for (const [key, entry] of Object.entries(record)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new Error(`fixture leak: ${path}.${key} is a live identifier`)
      }
      assertSafeValue(entry, `${path}.${key}`)
    }
    return
  }
  if (typeof value !== 'string') return
  if (UUID.test(value)) throw new Error(`fixture leak: ${path} contains a UUID`)
  if (EMAIL.test(value)) throw new Error(`fixture leak: ${path} contains an email address`)
  if (PHONE.test(value)) throw new Error(`fixture leak: ${path} contains a phone number`)
  if (URL.test(value) && !BARE_ORIGIN.test(value)) {
    throw new Error(`fixture leak: ${path} contains a URL with a path or query`)
  }
  if (LONG_CJK.test(value)) throw new Error(`fixture leak: ${path} contains page text`)
}

/**
 * Throw when a fixture would carry anything personal or live.
 *
 * The corpus keeps structure only; this is the guard that says so, run on every
 * fixture by the exporter and by the regression spec.
 */
export function assertFixtureSafe(record: unknown): void {
  assertSafeValue(record, 'attempt')
}
