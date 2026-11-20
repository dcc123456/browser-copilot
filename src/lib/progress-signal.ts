/**
 * Result-based no-progress classification (spec R1 / AC-3).
 *
 * The judge is the RESULT signature, never the call signature: polling, waiting
 * and retrying the same action are legitimate and must not be counted. What is
 * counted is "the action succeeded and the page/task state did not change",
 * repeated far enough that the model is no longer exploring.
 *
 * Pure and chrome-free so the thresholds and whitelist can be unit-tested
 * without a browser; the loop owns the state and the dispatch decisions.
 *
 * @module lib/progress-signal
 */

/** Tools whose own effect is not a state change and never counts as progress. */
const WAIT_CLASS_TOOLS = new Set([
  'wait_for',
  'ask_user',
  'present_plan',
  'snapshot_page',
  'read_current_page',
  'screenshot',
  'list_tabs',
  'list_saved_tabs',
])

/** The same action repeated this many times while the signature is unchanged is stagnation. */
export const DEFAULT_STAGNATION_THRESHOLD = 3
/**
 * Consecutive `ok:true` calls whose signature is unreadable (chrome://, CSP,
 * cross-origin frame) become an explicit blocker after this many rounds.
 * Without it, `null` is the one way an unbounded loop can never converge.
 */
export const DEFAULT_UNREADABLE_THRESHOLD = 3
/** A wait-class result that repeats identically this many times escalates. */
export const WAIT_STAGNATION_MULTIPLIER = 2

export type ProgressVerdict = 'progress' | 'no-progress' | 'exempt' | 'unreadable'

/** What the loop should do with this verdict, if anything. */
export type ProgressAction = 'none' | 'remind' | 'block' | 'blocker'

export interface ProgressState {
  /** Last readable signature, or null when the page did not report one. */
  signature: string | null
  /** Consecutive executions that left the readable signature unchanged. */
  unchanged: number
  /** Consecutive ok-but-unreadable executions. */
  unreadable: number
  /** Consecutive wait-class executions (they do not reset the counters). */
  waiting: number
}

export function emptyProgressState(): ProgressState {
  return { signature: null, unchanged: 0, unreadable: 0, waiting: 0 }
}

export interface ProgressObservation {
  tool: string
  /** Canonical tool+args key, so a different action is never treated as a repeat. */
  callKey: string
  ok: boolean
  /** The page's result signature, or null when the page could not report one. */
  signature: string | null
}

export interface ProgressThresholds {
  stagnation: number
  unreadable: number
}

export const DEFAULT_PROGRESS_THRESHOLDS: ProgressThresholds = {
  stagnation: DEFAULT_STAGNATION_THRESHOLD,
  unreadable: DEFAULT_UNREADABLE_THRESHOLD,
}

export interface ProgressEvaluation {
  state: ProgressState
  verdict: ProgressVerdict
  action: ProgressAction
  /** Why this action fired, for the user-facing blocker/reminder text. */
  reason?: 'stagnant' | 'unreadable' | 'waiting'
}

/**
 * Folds one executed tool call into the progress state.
 *
 * A failed call is exempt: failures have their own streak guard, and counting
 * them here would double-penalise a page that is simply slow to appear.
 */
export function evaluateProgress(
  state: ProgressState,
  observation: ProgressObservation,
  thresholds: ProgressThresholds = DEFAULT_PROGRESS_THRESHOLDS,
): ProgressEvaluation {
  const sameSignature = observation.signature !== null && observation.signature === state.signature

  if (!observation.ok) {
    return {
      state: { ...state, unchanged: 0, unreadable: 0, waiting: 0 },
      verdict: 'exempt',
      action: 'none',
    }
  }

  if (WAIT_CLASS_TOOLS.has(observation.tool)) {
    const waiting = state.waiting + 1
    if (waiting >= thresholds.stagnation * WAIT_STAGNATION_MULTIPLIER) {
      return {
        state: { ...state, waiting },
        verdict: 'exempt',
        action: 'remind',
        reason: 'waiting',
      }
    }
    return { state: { ...state, waiting }, verdict: 'exempt', action: 'none' }
  }

  if (observation.signature === null) {
    const unreadable = state.unreadable + 1
    if (unreadable >= thresholds.unreadable) {
      return {
        state: { ...state, unreadable, waiting: 0 },
        verdict: 'unreadable',
        action: 'blocker',
        reason: 'unreadable',
      }
    }
    return { state: { ...state, unreadable, waiting: 0 }, verdict: 'unreadable', action: 'none' }
  }

  if (sameSignature) {
    const unchanged = state.unchanged + 1
    // First threshold warns (legitimate waits/polls may still succeed); the
    // second blocks ONLY the identical call, never a different action — trying
    // a different approach is the response the product wants.
    // Warn exactly once at the threshold; block at twice. Repeating the warning
    // every round would be noise the model already acted on.
    const action: ProgressAction =
      unchanged >= thresholds.stagnation * 2
        ? 'block'
        : unchanged === thresholds.stagnation
          ? 'remind'
          : 'none'
    return {
      state: { ...state, signature: observation.signature, unchanged, unreadable: 0, waiting: 0 },
      verdict: 'no-progress',
      action,
      reason: 'stagnant',
    }
  }

  return {
    state: { signature: observation.signature, unchanged: 0, unreadable: 0, waiting: 0 },
    verdict: 'progress',
    action: 'none',
  }
}

/** Whether a tool's own effect is exempt from the progress judge. */
export function isWaitClassTool(name: string): boolean {
  return WAIT_CLASS_TOOLS.has(name)
}

/** The model-facing reminder injected after a stagnation threshold. */
export function progressReminderText(rounds: number): string {
  return (
    `[No page/state change after ${rounds} successful actions in a row. ` +
    'Do not repeat the same call: inspect the latest result, try a different action or parameters, ' +
    'or stop and tell the user exactly where you are stuck and what they need to do.]'
  )
}
