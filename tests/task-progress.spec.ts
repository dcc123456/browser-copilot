/**
 * Durable task progress (spec R4): the record a resumed long task reads.
 *
 * The point of these tests is the contract, not the storage: a fingerprint
 * must never leak the arguments it hashes, an irreversible action must stay
 * recorded across steps, and the model-facing note must be bounded and must
 * name what must not run again.
 */
import { describe, expect, it } from 'vitest'
import {
  appendProgressStep,
  beginTask,
  coerceTaskProgress,
  emptyTaskProgress,
  fingerprintOf,
  hasDestructiveOp,
  isIrreversibleReason,
  MAX_TASK_STEPS,
  noteDestructiveOp,
  renderResumeNote,
  taskTokenCost,
} from '../src/lib/task-progress'

describe('task progress record', () => {
  it('starts empty and adopts a goal without inventing steps', () => {
    const empty = emptyTaskProgress('conv-1', 1000)
    expect(empty.goal).toBeUndefined()
    expect(empty.steps).toEqual([])
    const started = beginTask(empty, '  Book the cheapest flight  ', 2000)
    expect(started.goal).toMatchObject({
      summary: 'Book the cheapest flight',
      startedAt: 2000,
      status: 'active',
    })
    expect(started.steps).toEqual([])
  })

  it('caps the step list so a runaway task cannot grow the record', () => {
    let progress = beginTask(emptyTaskProgress('conv-1', 1000), 'goal', 1000)
    for (let index = 0; index < MAX_TASK_STEPS + 12; index += 1) {
      progress = appendProgressStep(
        progress,
        { tool: 'click', summary: `step ${index}`, ok: true },
        2000 + index,
      )
    }
    expect(progress.steps).toHaveLength(MAX_TASK_STEPS)
    expect(progress.steps.at(-1)?.summary).toBe(`step ${MAX_TASK_STEPS + 11}`)
  })

  it('keeps an irreversible action once and reports it afterwards', () => {
    let progress = beginTask(emptyTaskProgress('conv-1', 1000), 'submit', 1000)
    const fingerprint = fingerprintOf('click', { ref: 'e1', value: 'pay' })
    progress = noteDestructiveOp(
      progress,
      { tool: 'click', summary: 'Click Pay', fingerprint },
      2000,
    )
    progress = noteDestructiveOp(
      progress,
      { tool: 'click', summary: 'Click Pay again', fingerprint },
      3000,
    )
    expect(progress.destructiveOps).toHaveLength(1)
    expect(hasDestructiveOp(progress, fingerprint)).toBe(true)
    expect(hasDestructiveOp(progress, fingerprintOf('click', { ref: 'e2' }))).toBe(false)
  })

  it('fingerprints arguments order-independently and never stores them', () => {
    expect(fingerprintOf('fill', { b: 2, a: { d: 4, c: 3 } })).toBe(
      fingerprintOf('fill', { a: { c: 3, d: 4 }, b: 2 }),
    )
    const progress = noteDestructiveOp(
      beginTask(emptyTaskProgress('conv-1', 1000), 'pay', 1000),
      {
        tool: 'fill',
        summary: 'Typed: "••••"',
        fingerprint: fingerprintOf('fill', { password: 'hunter2' }),
      },
      2000,
    )
    const stored = JSON.stringify(progress)
    expect(stored).not.toContain('hunter2')
  })

  it('treats only external-effect reasons as irreversible', () => {
    expect(isIrreversibleReason('sending')).toBe(true)
    expect(isIrreversibleReason('payment')).toBe(true)
    expect(isIrreversibleReason('destructive')).toBe(true)
    expect(isIrreversibleReason('unknown-target')).toBe(false)
    expect(isIrreversibleReason('persistent')).toBe(false)
    expect(isIrreversibleReason('credentials')).toBe(false)
  })
})

describe('stored value coercion', () => {
  it('rejects garbage instead of crashing a resumed turn', () => {
    expect(coerceTaskProgress(null)).toBeUndefined()
    expect(coerceTaskProgress({})).toBeUndefined()
    expect(coerceTaskProgress({ version: 3, conversationId: 'x' })).toBeUndefined()
    expect(coerceTaskProgress({ version: 1, conversationId: '' })).toBeUndefined()
  })

  it('drops malformed steps and ops but keeps the rest', () => {
    const coerced = coerceTaskProgress({
      version: 1,
      conversationId: 'conv-1',
      goal: { summary: 'goal', startedAt: 10 },
      steps: [{ tool: 'click', summary: 'a', ok: true, at: 1 }, null, { summary: 'no tool' }],
      destructiveOps: [{ tool: 'click', fingerprint: 'abc', summary: 's', at: 1 }, {}],
      updatedAt: 5,
    })
    expect(coerced?.goal?.summary).toBe('goal')
    expect(coerced?.steps).toHaveLength(1)
    expect(coerced?.destructiveOps).toHaveLength(1)
  })
})

describe('resume note', () => {
  it('names the goal, the finished steps and the actions that must not repeat', () => {
    let progress = beginTask(emptyTaskProgress('conv-1', 1000), 'File the report', 1000)
    progress = appendProgressStep(
      progress,
      { tool: 'click', summary: 'Click Submit', ok: true, url: 'https://x.test/form' },
      2000,
    )
    progress = noteDestructiveOp(
      progress,
      { tool: 'click', summary: 'Click Submit', fingerprint: 'f'.repeat(16) },
      2000,
    )
    const note = renderResumeNote(progress, {
      inputTokens: 1200,
      cachedInputTokens: 900,
      outputTokens: 40,
      requests: 2,
    })
    expect(note).toContain('RESUMED TASK')
    expect(note).toContain('File the report')
    expect(note).toContain('Click Submit')
    expect(note).toContain('NEVER repeat')
    expect(note).toContain('1200 input')
    expect(note.length).toBeLessThanOrEqual(1_600)
  })

  it('stays empty when there is nothing to resume', () => {
    expect(renderResumeNote(emptyTaskProgress('conv-1', 1000))).toBe('')
  })
})

describe('task cost from the request ledger', () => {
  const records = [
    { at: 100, entityKey: 'chat:c1', inputTokens: 1000, cachedInputTokens: 900, outputTokens: 10 },
    { at: 200, entityKey: 'chat:c1', inputTokens: 500, cachedInputTokens: 0, outputTokens: 5 },
    { at: 300, entityKey: 'chat:c2', inputTokens: 700, cachedInputTokens: 0, outputTokens: 7 },
    { at: 50, entityKey: 'chat:c1', inputTokens: 999, cachedInputTokens: 0, outputTokens: 9 },
  ]

  it('sums only this conversation and only since the task began', () => {
    expect(taskTokenCost(records, 'c1', 100)).toEqual({
      inputTokens: 1500,
      cachedInputTokens: 900,
      outputTokens: 15,
      requests: 2,
    })
  })

  it('returns a zero cost when nothing matched', () => {
    expect(taskTokenCost(records, 'c1', 5000).requests).toBe(0)
  })
})
