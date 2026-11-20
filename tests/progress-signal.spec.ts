/**
 * No-progress judgement (spec R1): thresholds, the wait-class whitelist, the
 * unreadable-signature escalation, and the rule that a different action is
 * never blocked because an earlier one was repeating.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROGRESS_THRESHOLDS,
  emptyProgressState,
  evaluateProgress,
  progressReminderText,
  type ProgressState,
} from '../src/lib/progress-signal'

function run(
  signatures: (string | null)[],
  tools: string[] = [],
): { state: ProgressState; actions: string[]; verdicts: string[] } {
  let state = emptyProgressState()
  const actions: string[] = []
  const verdicts: string[] = []
  signatures.forEach((signature, index) => {
    const result = evaluateProgress(state, {
      tool: tools[index] ?? 'click',
      callKey: 'click:e1',
      ok: true,
      signature,
    })
    state = result.state
    actions.push(result.action)
    verdicts.push(result.verdict)
  })
  return { state, actions, verdicts }
}

describe('evaluateProgress', () => {
  it('treats a changed signature as progress and resets the streak', () => {
    const { actions, verdicts } = run(['A', 'A', 'B'])
    expect(verdicts).toEqual(['progress', 'no-progress', 'progress'])
    expect(actions).toEqual(['none', 'none', 'none'])
  })

  it('reminds at the threshold and blocks only after twice the threshold', () => {
    const { actions } = run(['A', 'A', 'A', 'A', 'A', 'A', 'A'])
    // index 0 has no prior signature → progress; unchanged=3 reminds,
    // unchanged=6 blocks: the same call may keep being retried once more after
    // the warning, never a different action.
    expect(actions).toEqual(['none', 'none', 'none', 'remind', 'none', 'none', 'block'])
  })

  it('never counts wait-class tools as no-progress, but reminds when they repeat', () => {
    const { verdicts, actions } = run(
      ['A', 'A', 'A', 'A', 'A', 'A', 'A'],
      ['wait_for', 'wait_for', 'wait_for', 'wait_for', 'wait_for', 'wait_for', 'wait_for'],
    )
    expect(verdicts.every((verdict) => verdict === 'exempt')).toBe(true)
    expect(actions.at(-1)).toBe('remind')
  })

  it('escalates consecutive unreadable signatures to an explicit blocker', () => {
    const { actions, verdicts } = run([null, null, null])
    expect(verdicts).toEqual(['unreadable', 'unreadable', 'unreadable'])
    expect(actions).toEqual(['none', 'none', 'blocker'])
  })

  it('resets the unreadable streak once a signature is readable again', () => {
    const { state } = run([null, null, 'A'])
    expect(state.unreadable).toBe(0)
    expect(state.signature).toBe('A')
  })

  it('does not count failed calls (they have their own guard)', () => {
    let state = emptyProgressState()
    const failed = evaluateProgress(state, {
      tool: 'click',
      callKey: 'click:e1',
      ok: false,
      signature: 'A',
    })
    expect(failed.verdict).toBe('exempt')
    expect(failed.state.unchanged).toBe(0)
    state = failed.state
    expect(state.unreadable).toBe(0)
  })

  it('respects custom thresholds', () => {
    const { actions } = run(['A', 'A', 'A'])
    expect(actions).toEqual(['none', 'none', 'none'])
    let state = emptyProgressState()
    const custom = { ...DEFAULT_PROGRESS_THRESHOLDS, stagnation: 1 }
    const result = evaluateProgress(
      { ...state, signature: 'A', unchanged: 0 },
      { tool: 'click', callKey: 'click:e1', ok: true, signature: 'A' },
      custom,
    )
    expect(result.action).toBe('remind')
  })

  it('names the stuck state in the reminder', () => {
    expect(progressReminderText(3)).toContain('3 successful actions')
    expect(progressReminderText(3)).toContain('tell the user')
  })
})
