import { describe, expect, it } from 'vitest'
import {
  attachGoalSpec,
  generationIsActive,
  goalGatePassed,
  markFailureRecovered,
  recordActionFinished,
  recordActionStarted,
  startGenerationSession,
  successfulTraces,
  transitionGeneration,
} from '../src/lib/workflow/generation-session'

function executingSession() {
  const started = startGenerationSession({
    conversationId: 'c1',
    userGoal: 'buy milk',
    id: 'g1',
    startedAt: 100,
  })
  const understanding = transitionGeneration(started.session, 'understanding')
  return transitionGeneration(understanding.session, 'executing')
}

describe('generation session state machine', () => {
  it('starts in starting and moves forward only', () => {
    const started = startGenerationSession({
      conversationId: 'c1',
      userGoal: 'goal',
      startedAt: 1,
    })
    expect(started.session.phase).toBe('starting')
    expect(started.event.type).toBe('started')
    expect(generationIsActive(started.session)).toBe(true)

    const understanding = transitionGeneration(started.session, 'understanding')
    expect(understanding.session.phase).toBe('understanding')

    expect(() => transitionGeneration(understanding.session, 'starting')).toThrow()
  })

  it('records successful actions and exposes them to the compiler', () => {
    let { session } = executingSession()
    const actionStart = recordActionStarted(session, {
      blockId: 'click',
      intent: 'open the cart',
      at: 200,
    })
    session = actionStart.session
    const actionFinish = recordActionFinished(session, {
      passed: true,
      nodeId: 'n-gen-1',
      at: 250,
    })
    session = actionFinish.session

    expect(session.actionCount).toBe(1)
    expect(session.successfulActionCount).toBe(1)
    expect(successfulTraces(session)).toHaveLength(1)
  })

  it('records failures and marks them recovered without dropping the action', () => {
    let { session } = executingSession()
    session = recordActionStarted(session, {
      blockId: 'click',
      intent: 'submit',
      at: 300,
    }).session
    session = recordActionFinished(session, {
      passed: false,
      at: 320,
    }).session
    expect(session.failures).toHaveLength(1)
    expect(session.failures[0]?.recovered).toBe(false)

    const recovery = markFailureRecovered(session)
    session = recovery.session
    expect(recovery.events[0]).toMatchObject({ type: 'recovery' })
    expect(session.failures[0]?.recovered).toBe(true)
    // Failed action retained for trace/compiler exclusion.
    expect(session.actionTrace).toHaveLength(1)
  })

  it('gates saving on goal verification when a goal spec exists', () => {
    let { session } = executingSession()
    session = attachGoalSpec(session, {
      summary: 'checkout complete',
      successConditions: [],
    })
    expect(goalGatePassed(session)).toBe(false)

    session = recordActionStarted(session, {
      blockId: 'click',
      intent: 'final submit',
    }).session
    session = recordActionFinished(session, {
      passed: true,
      nodeId: 'n-gen-2',
      verification: { kind: 'goal', passed: true },
    }).session
    expect(goalGatePassed(session)).toBe(true)
  })

  it('can fail from an active phase and cannot leave a terminal phase', () => {
    let { session } = executingSession()
    const failed = transitionGeneration(session, 'failed', undefined, 'model error')
    session = failed.session
    expect(session.phase).toBe('failed')
    expect(session.failureReason).toBe('model error')
    expect(generationIsActive(session)).toBe(false)
    expect(() => transitionGeneration(session, 'compiling')).toThrow()
  })
})
