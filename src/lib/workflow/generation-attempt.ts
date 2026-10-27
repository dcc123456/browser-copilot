/**
 * One generation attempt, measured.
 *
 * The success rate this repository cares about is "did a real model produce a
 * workflow that runs and reaches its goal" — and until now no single record
 * said that. The compose stage knew the graph and the static verdict, the
 * replay knew the trial and the goal verdict, the repair loop knew its rounds,
 * and each of them wrote somewhere else.
 *
 * This module is the one record that spans those stages, plus the ordinal score
 * that lets two attempts be compared. The score is a RANKING signal for
 * regression and later Best-of-N work, **not** a success probability: it is a
 * weighted judgement over a small sample, and its weights are deliberately
 * visible in {@link ATTEMPT_SCORE_WEIGHTS}.
 *
 * Pure module (chrome-free): emission lives in the background handlers, the
 * capped store in `generation-attempt-store.ts`, the corpus in
 * `generation-corpus.ts`.
 *
 * @module lib/workflow/generation-attempt
 */

import { FAILURE_CODES, type FailureCode } from './failure-code'
import {
  isWorkflowFailureKind,
  kindFromFailureCode,
  type WorkflowFailureKind,
} from './failure-taxonomy'
import type { GoalVerificationLevel } from './goal-verification-record'

/** Weights of the five score components. They sum to 1. */
export const ATTEMPT_SCORE_WEIGHTS = {
  /** The graph was persisted at all. */
  saved: 0.1,
  /** The static validator had nothing to say (and no run-blocking issue). */
  staticChecks: 0.15,
  /** How much of the reachable graph a real trial proved. */
  trialProgress: 0.15,
  /** The replay was clean, complete and not stopped at a cutoff. */
  replayVerified: 0.2,
  /** The goal judge certified the goal — only granted on a verified replay. */
  goal: 0.4,
} as const

/** Credit per goal level, granted only when the replay verified. */
const GOAL_CREDIT: Record<GoalVerificationLevel, number> = {
  L3: 1,
  L2: 0.6,
  L1: 0.3,
  NONE: 0,
}

const GOAL_LEVELS: readonly GoalVerificationLevel[] = ['L1', 'L2', 'L3', 'NONE']

/** A goal verdict reduced to the facts an attempt keeps. */
export interface GoalFacts {
  level: GoalVerificationLevel
  certified: boolean
  /** How many goal rows did not hold. */
  unmetCount: number
}

/** The pre-save trial reduced to the facts an attempt keeps. */
export interface TrialFacts {
  outcome: string
  full: boolean
  coveredSteps: number
  totalSteps: number
  failureCode?: string
  draftSaved?: boolean
  degradedSteps?: number
}

/** What the compose stage produced, before any replay happened. */
export interface ComposeFacts {
  saved: boolean
  nodeCount: number
  staticOk: boolean
  staticCodes: string[]
  staticErrorCount: number
  staticWarningCount: number
  /** The goal asked for a draft save and the graph has no step that writes one. */
  terminalStepMissing?: boolean
  /** Operator steps that failed during generation and left no node. */
  coverageGap?: number
  blockCounts?: Record<string, number>
  trial?: TrialFacts
  goal?: GoalFacts
}

/** What one verify/replay pass (and the repair rounds after it) produced. */
export interface ReplayFacts {
  ran: boolean
  ok: boolean
  verified: boolean
  proven?: boolean
  outcome: string
  coveredSteps: number
  totalSteps: number
  failureCode?: string
  goal?: GoalFacts
  repair?: {
    attempted: boolean
    status: string
    attempts: number
    committed: boolean
  }
}

/** One generation attempt, merged across compose → verify → repair. */
export interface GenerationAttemptRecord {
  at: number
  attemptId: string
  /** Corpus round number; live attempts do not have one. */
  round?: number
  buildStampHash?: string
  model?: { name?: string; temperature?: number }
  origin?: string
  /** Furthest stage reached (`generate`, `verify`, `goal`, `harness`, …). */
  stage?: string
  compose?: ComposeFacts
  replay?: ReplayFacts
  failureKind?: WorkflowFailureKind
  pass: boolean
  score: number
}

/** The fields a later stage may add to an existing attempt. */
export interface GenerationAttemptPatch {
  attemptId: string
  at: number
  stage?: string
  round?: number
  buildStampHash?: string
  model?: { name?: string; temperature?: number }
  origin?: string
  compose?: ComposeFacts
  replay?: ReplayFacts
}

export interface Interval {
  low: number
  high: number
}

export interface GenerationAttemptSummary {
  total: number
  pass: number
  passRate: number
  /** Goal certified at L3. */
  l3Certified: number
  /** The replay verified AND proved its step-by-step claims. */
  verifiedAndProven: number
  /** Rounds whose generation left operator steps with no node at all. */
  coverageGapRounds: number
  meanScore: number
  passInterval: Interval
  l3Interval: Interval
  meanScoreInterval: Interval
  /** Certified hits per goal level. */
  byGoalLevel: Record<GoalVerificationLevel, number>
  /** Failure counts over failed attempts, descending. */
  byFailureKind: { kind: WorkflowFailureKind | 'unclassified'; count: number }[]
}

// --- Reading persisted / exported values ---------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readCount(value: unknown): number | undefined {
  const parsed = readNumber(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeGoalFacts(raw: unknown): GoalFacts | undefined {
  if (!isRecord(raw)) return undefined
  const level = raw['level']
  if (!GOAL_LEVELS.includes(level as GoalVerificationLevel)) return undefined
  if (typeof raw['certified'] !== 'boolean') return undefined
  return {
    level: level as GoalVerificationLevel,
    certified: raw['certified'],
    unmetCount: readCount(raw['unmetCount']) ?? 0,
  }
}

function normalizeTrialFacts(raw: unknown): TrialFacts | undefined {
  if (!isRecord(raw)) return undefined
  const outcome = readString(raw['outcome'])
  const coveredSteps = readCount(raw['coveredSteps'])
  const totalSteps = readCount(raw['totalSteps'])
  if (outcome === undefined || coveredSteps === undefined || totalSteps === undefined)
    return undefined
  if (typeof raw['full'] !== 'boolean') return undefined
  return {
    outcome,
    full: raw['full'],
    coveredSteps,
    totalSteps,
    ...(readString(raw['failureCode']) ? { failureCode: raw['failureCode'] as string } : {}),
    ...(typeof raw['draftSaved'] === 'boolean' ? { draftSaved: raw['draftSaved'] } : {}),
    ...(readCount(raw['degradedSteps']) !== undefined
      ? { degradedSteps: raw['degradedSteps'] as number }
      : {}),
  }
}

function normalizeBlockCounts(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) return undefined
  const counts: Record<string, number> = {}
  for (const [blockId, count] of Object.entries(raw)) {
    const value = readCount(count)
    if (value !== undefined) counts[blockId] = value
  }
  return Object.keys(counts).length > 0 ? counts : undefined
}

function normalizeComposeFacts(raw: unknown): ComposeFacts | undefined {
  if (!isRecord(raw)) return undefined
  const nodeCount = readCount(raw['nodeCount'])
  if (nodeCount === undefined) return undefined
  if (typeof raw['saved'] !== 'boolean' || typeof raw['staticOk'] !== 'boolean') return undefined
  const staticCodes = Array.isArray(raw['staticCodes'])
    ? raw['staticCodes'].filter((code): code is string => typeof code === 'string')
    : []
  const trial = normalizeTrialFacts(raw['trial'])
  const goal = normalizeGoalFacts(raw['goal'])
  const blockCounts = normalizeBlockCounts(raw['blockCounts'])
  return {
    saved: raw['saved'],
    nodeCount,
    staticOk: raw['staticOk'],
    staticCodes,
    staticErrorCount: readCount(raw['staticErrorCount']) ?? 0,
    staticWarningCount: readCount(raw['staticWarningCount']) ?? 0,
    ...(raw['terminalStepMissing'] === true ? { terminalStepMissing: true } : {}),
    ...(readCount(raw['coverageGap']) !== undefined
      ? { coverageGap: raw['coverageGap'] as number }
      : {}),
    ...(blockCounts ? { blockCounts } : {}),
    ...(trial ? { trial } : {}),
    ...(goal ? { goal } : {}),
  }
}

function normalizeRepairFacts(raw: unknown): ReplayFacts['repair'] | undefined {
  if (!isRecord(raw)) return undefined
  const status = readString(raw['status'])
  const attempts = readCount(raw['attempts'])
  if (status === undefined || attempts === undefined) return undefined
  if (typeof raw['attempted'] !== 'boolean' || typeof raw['committed'] !== 'boolean')
    return undefined
  return {
    attempted: raw['attempted'],
    status,
    attempts,
    committed: raw['committed'],
  }
}

function normalizeReplayFacts(raw: unknown): ReplayFacts | undefined {
  if (!isRecord(raw)) return undefined
  const outcome = readString(raw['outcome'])
  const coveredSteps = readCount(raw['coveredSteps'])
  const totalSteps = readCount(raw['totalSteps'])
  if (outcome === undefined || coveredSteps === undefined || totalSteps === undefined)
    return undefined
  if (
    typeof raw['ran'] !== 'boolean' ||
    typeof raw['ok'] !== 'boolean' ||
    typeof raw['verified'] !== 'boolean'
  ) {
    return undefined
  }
  const goal = normalizeGoalFacts(raw['goal'])
  const repair = normalizeRepairFacts(raw['repair'])
  return {
    ran: raw['ran'],
    ok: raw['ok'],
    verified: raw['verified'],
    ...(typeof raw['proven'] === 'boolean' ? { proven: raw['proven'] } : {}),
    outcome,
    coveredSteps,
    totalSteps,
    ...(readString(raw['failureCode']) ? { failureCode: raw['failureCode'] as string } : {}),
    ...(goal ? { goal } : {}),
    ...(repair ? { repair } : {}),
  }
}

/**
 * Read a persisted attempt back, or nothing when the stored value is not one.
 *
 * A malformed record is dropped, not repaired — the same rule the goal verdict
 * follows. A repaired record would claim "this is what the attempt measured"
 * while measuring something else.
 */
export function normalizeGenerationAttempt(raw: unknown): GenerationAttemptRecord | undefined {
  if (!isRecord(raw)) return undefined
  const attemptId = readString(raw['attemptId'])
  const at = readNumber(raw['at'])
  const score = readNumber(raw['score'])
  if (!attemptId || at === undefined || score === undefined) return undefined
  if (typeof raw['pass'] !== 'boolean') return undefined
  const compose = normalizeComposeFacts(raw['compose'])
  const replay = normalizeReplayFacts(raw['replay'])
  const model =
    isRecord(raw['model']) &&
    (readString(raw['model']['name']) !== undefined ||
      readNumber(raw['model']['temperature']) !== undefined)
      ? {
          ...(readString(raw['model']['name']) !== undefined
            ? { name: raw['model']['name'] as string }
            : {}),
          ...(readNumber(raw['model']['temperature']) !== undefined
            ? { temperature: raw['model']['temperature'] as number }
            : {}),
        }
      : undefined
  const round = readCount(raw['round'])
  const stage = readString(raw['stage'])
  const failureKind = isWorkflowFailureKind(raw['failureKind']) ? raw['failureKind'] : undefined
  return {
    at,
    attemptId,
    pass: raw['pass'],
    score,
    ...(round !== undefined ? { round } : {}),
    ...(readString(raw['buildStampHash'])
      ? { buildStampHash: raw['buildStampHash'] as string }
      : {}),
    ...(model ? { model } : {}),
    ...(readString(raw['origin']) ? { origin: raw['origin'] as string } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(compose ? { compose } : {}),
    ...(replay ? { replay } : {}),
    ...(failureKind ? { failureKind } : {}),
  }
}

// --- Scoring -------------------------------------------------------------------

function ratio(covered: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, covered / total))
}

function goalFactsOf(
  record: Pick<GenerationAttemptRecord, 'compose' | 'replay'>,
): GoalFacts | undefined {
  return record.replay?.goal ?? record.compose?.goal
}

function goalCredit(goal: GoalFacts | undefined): number {
  return goal ? GOAL_CREDIT[goal.level] : 0
}

/**
 * Does the attempt count as a success?
 *
 * A goal verdict of `NONE` means "nothing was judged", so it neither passes nor
 * blocks anything; only an actual unmet goal does.
 */
export function attemptPasses(
  record: Pick<GenerationAttemptRecord, 'compose' | 'replay'>,
): boolean {
  const replay = record.replay
  if (!replay?.ran || !replay.ok || !replay.verified) return false
  const goal = goalFactsOf(record)
  return !goal || goal.level === 'NONE' || goal.certified
}

/** The ordinal fitness of an attempt, 0..1, rounded to three decimals. */
export function scoreGenerationAttempt(
  record: Pick<GenerationAttemptRecord, 'compose' | 'replay'>,
): number {
  const progress = record.replay
    ? ratio(record.replay.coveredSteps, record.replay.totalSteps)
    : record.compose?.trial
      ? ratio(record.compose.trial.coveredSteps, record.compose.trial.totalSteps)
      : 0
  const value =
    (record.compose?.saved ? ATTEMPT_SCORE_WEIGHTS.saved : 0) +
    (record.compose?.staticOk ? ATTEMPT_SCORE_WEIGHTS.staticChecks : 0) +
    ATTEMPT_SCORE_WEIGHTS.trialProgress * progress +
    (record.replay?.verified
      ? ATTEMPT_SCORE_WEIGHTS.replayVerified +
        ATTEMPT_SCORE_WEIGHTS.goal * goalCredit(goalFactsOf(record))
      : 0)
  return Math.round(value * 1000) / 1000
}

/**
 * Map a structured failure code onto the shared taxonomy.
 *
 * Trial records append detail to the prefix (`READINESS_TIMEOUT(visible)`), and
 * `UNRESOLVED_INPUT` is raised by the dataflow guard rather than the runtime
 * code table, so neither goes through {@link kindFromFailureCode} untouched.
 */
export function failureKindOfCode(raw: string): WorkflowFailureKind | undefined {
  const bare = raw.trim().replace(/\(.*\)$/, '')
  if (bare === 'UNRESOLVED_INPUT') return 'dataflow'
  if (!(FAILURE_CODES as readonly string[]).includes(bare)) return undefined
  const kind = kindFromFailureCode(bare as FailureCode)
  return kind === 'unknown' ? undefined : kind
}

const ENVIRONMENT_OUTCOMES: readonly string[] = [
  'harness',
  'quota',
  'network',
  'provider',
  'environment',
]

/**
 * Which of the 16 shared failure kinds an attempt failed with, or nothing when
 * it passed. Priority follows the evidence's specificity: a structured code
 * beats a goal verdict, a goal verdict beats a static finding, and the stage
 * only speaks when nothing more specific did.
 */
export function failureKindOfAttempt(
  record: Pick<GenerationAttemptRecord, 'compose' | 'replay' | 'pass' | 'stage'>,
): WorkflowFailureKind | undefined {
  const codeKind = record.replay?.failureCode
    ? failureKindOfCode(record.replay.failureCode)
    : undefined
  if (codeKind) return codeKind
  const goal = goalFactsOf(record)
  if (goal && goal.level !== 'NONE' && !goal.certified) return 'goal-verification'
  if (record.stage === 'goal') return 'goal-verification'
  if (record.compose?.terminalStepMissing) return 'intent'
  if (record.compose && record.compose.staticErrorCount > 0) return 'graph'
  const outcomes = [record.replay?.outcome, record.compose?.trial?.outcome]
  if (outcomes.includes('partial')) return 'side-effect'
  if (outcomes.includes('timeout')) return 'readiness'
  if (
    record.stage === 'harness' ||
    outcomes.some((outcome) => outcome !== undefined && ENVIRONMENT_OUTCOMES.includes(outcome))
  ) {
    return 'environment'
  }
  if (record.stage === 'generate' || record.stage === 'intent') return 'intent'
  if (record.pass) return undefined
  return 'unknown'
}

// --- Merging -------------------------------------------------------------------

/**
 * Fold a later stage's facts into an existing attempt.
 *
 * `compose` and `replay` are replaced whole (each block is written by exactly
 * one stage, so a partial update would be a lost fact), while identity fields
 * survive unless the patch names them. The verdict is always recomputed from
 * the merged facts — a stored `pass`/`score` goes stale the moment replay lands.
 */
export function mergeGenerationAttempt(
  previous: GenerationAttemptRecord | undefined,
  patch: GenerationAttemptPatch,
): GenerationAttemptRecord {
  const compose = patch.compose ?? previous?.compose
  const replay = patch.replay ?? previous?.replay
  const base: GenerationAttemptRecord = {
    at: patch.at,
    attemptId: patch.attemptId,
    pass: false,
    score: 0,
    ...((patch.round ?? previous?.round) !== undefined
      ? { round: (patch.round ?? previous?.round) as number }
      : {}),
    ...((patch.buildStampHash ?? previous?.buildStampHash)
      ? { buildStampHash: (patch.buildStampHash ?? previous?.buildStampHash) as string }
      : {}),
    ...((patch.model ?? previous?.model)
      ? { model: (patch.model ?? previous?.model) as { name?: string; temperature?: number } }
      : {}),
    ...((patch.origin ?? previous?.origin)
      ? { origin: (patch.origin ?? previous?.origin) as string }
      : {}),
    ...((patch.stage ?? previous?.stage)
      ? { stage: (patch.stage ?? previous?.stage) as string }
      : {}),
    ...(compose ? { compose } : {}),
    ...(replay ? { replay } : {}),
  }
  const pass = attemptPasses(base)
  const score = scoreGenerationAttempt(base)
  const failureKind = pass ? undefined : failureKindOfAttempt({ ...base, pass })
  return {
    ...base,
    pass,
    score,
    ...(failureKind ? { failureKind } : {}),
  }
}

// --- Summary -------------------------------------------------------------------

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * The corpus is small, so the naive `successes / total` interval would claim a
 * precision the sample cannot support. With no observations the interval is the
 * full range, not a zero-width "certainty".
 */
export function wilsonInterval(successes: number, total: number, z = 1.959963984540054): Interval {
  if (total <= 0) return { low: 0, high: 1 }
  const count = Math.min(total, Math.max(0, successes))
  const proportion = count / total
  const squared = z * z
  const denominator = 1 + squared / total
  const center = (proportion + squared / (2 * total)) / denominator
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion)) / total + squared / (4 * total * total))) /
    denominator
  return {
    low: round(Math.max(0, center - margin), 4),
    high: round(Math.min(1, center + margin), 4),
  }
}

/** Fixed so a report number can be reproduced by anyone who runs it. */
const BOOTSTRAP_SEED = 20261027
const BOOTSTRAP_ITERATIONS = 2000

function quantileOfSorted(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? 0
}

/**
 * Percentile bootstrap for the mean, seeded.
 *
 * Nonparametric on purpose: scores are bounded, skewed and few, so a normal
 * approximation would be a story about the sample rather than about the
 * measurement.
 */
export function bootstrapMeanInterval(
  values: readonly number[],
  options: { iterations?: number; seed?: number } = {},
): Interval {
  if (values.length === 0) return { low: 0, high: 0 }
  const iterations = options.iterations ?? BOOTSTRAP_ITERATIONS
  let state = (options.seed ?? BOOTSTRAP_SEED) >>> 0
  // mulberry32 — deterministic, dependency-free, good enough for resampling.
  const nextRandom = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
  const means = new Array<number>(iterations)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0
    for (let draw = 0; draw < values.length; draw += 1) {
      const picked = values[Math.floor(nextRandom() * values.length)] ?? 0
      sum += picked
    }
    means[iteration] = sum / values.length
  }
  means.sort((left, right) => left - right)
  return {
    low: round(quantileOfSorted(means, 0.025), 4),
    high: round(quantileOfSorted(means, 0.975), 4),
  }
}

/** Aggregate an attempt list for the report and the regression fixtures. */
export function summarizeGenerationAttempts(
  records: readonly GenerationAttemptRecord[],
): GenerationAttemptSummary {
  const total = records.length
  const passed = records.filter((record) => record.pass).length
  const scores = records.map((record) => record.score)
  const meanScore = total > 0 ? round(scores.reduce((sum, value) => sum + value, 0) / total, 3) : 0

  const byGoalLevel: Record<GoalVerificationLevel, number> = { L1: 0, L2: 0, L3: 0, NONE: 0 }
  let verifiedAndProven = 0
  let coverageGapRounds = 0
  const failures = new Map<WorkflowFailureKind | 'unclassified', number>()
  for (const record of records) {
    const goal = goalFactsOf(record)
    if (goal?.certified) byGoalLevel[goal.level] += 1
    if (record.replay?.verified && record.replay.proven) verifiedAndProven += 1
    if ((record.compose?.coverageGap ?? 0) > 0) coverageGapRounds += 1
    if (record.pass) continue
    const kind = record.failureKind ?? 'unclassified'
    failures.set(kind, (failures.get(kind) ?? 0) + 1)
  }

  return {
    total,
    pass: passed,
    passRate: total > 0 ? round(passed / total, 4) : 0,
    l3Certified: byGoalLevel.L3,
    verifiedAndProven,
    coverageGapRounds,
    meanScore,
    passInterval: wilsonInterval(passed, total),
    l3Interval: wilsonInterval(byGoalLevel.L3, total),
    meanScoreInterval: bootstrapMeanInterval(scores),
    byGoalLevel,
    byFailureKind: [...failures.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
  }
}
