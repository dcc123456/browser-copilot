/**
 * Tests for the node-fix engine loop, driven entirely with injected deps (no
 * real page or network): first-pass success, model-driven recovery, round
 * exhaustion, missing contract and cancellation.
 */
import { describe, expect, it } from 'vitest'
import { runNodeFix } from '../src/background/workflow-engine/node-fix-engine'
import {
  NODE_FIX_MAX_ROUNDS,
  type NodeFixEvent,
} from '../src/lib/workflow/node-fix'
import { WORKFLOW_AI_NAMESPACE } from '../src/lib/workflow/node-goal-contract'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'

const criteria: WorkflowCondition[] = [{ kind: 'urlContains', value: '/home' }]

function blockData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selector: '#old',
    ...extra,
    [WORKFLOW_AI_NAMESPACE]: {
      goalContract: {
        version: 1,
        goal: 'land on the home page',
        successCriteria: criteria,
      },
    },
  }
}

function eventCollector(): {
  events: NodeFixEvent[]
  emit: (e: NodeFixEvent) => void
} {
  const events: NodeFixEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

describe('runNodeFix', () => {
  it('succeeds on the first round when execution is clean and criteria hold', async () => {
    const collector = eventCollector()
    const result = await runNodeFix(
      { sessionId: 's1', blockId: 'event-click', blockData: blockData() },
      {
        signal: new AbortController().signal,
        emit: collector.emit,
        executeNode: async () => ({ ok: true }),
        evaluateCriteria: async () =>
          criteria.map((condition) => ({ condition, satisfied: true })),
      },
    )
    expect(result.success).toBe(true)
    expect(result.rounds).toBe(1)
    expect(result.proposedData!['selector']).toBe('#old')
  })

  it('asks the model and succeeds once criteria hold', async () => {
    let calls = 0
    const result = await runNodeFix(
      {
        sessionId: 's2',
        blockId: 'event-click',
        blockData: blockData(),
        userSuggestion: 'use the test id',
      },
      {
        signal: new AbortController().signal,
        emit: eventCollector().emit,
        executeNode: async () => ({ ok: true }),
        evaluateCriteria: async (cs) =>
          cs.map((condition) => ({ condition, satisfied: calls > 0 })),
        callModel: async (prompt) => {
          calls += 1
          expect(prompt).toContain('use the test id')
          return { rationale: 'new selector', data: { selector: '#new' } }
        },
      },
    )
    expect(result.success).toBe(true)
    expect(result.rounds).toBe(2)
    expect(result.proposedData!['selector']).toBe('#new')
  })

  it('fails after the maximum rounds when criteria never hold', async () => {
    const result = await runNodeFix(
      { sessionId: 's3', blockId: 'event-click', blockData: blockData() },
      {
        signal: new AbortController().signal,
        emit: eventCollector().emit,
        executeNode: async () => ({ ok: true }),
        evaluateCriteria: async (cs) =>
          cs.map((condition) => ({ condition, satisfied: false })),
        callModel: async () => ({
          rationale: 'try again',
          data: { selector: '#candidate' },
        }),
      },
    )
    expect(result.success).toBe(false)
    expect(result.rounds).toBe(NODE_FIX_MAX_ROUNDS)
    expect(result.reason).toContain(String(NODE_FIX_MAX_ROUNDS))
  })

  it('fails without a goal contract before doing any work', async () => {
    const result = await runNodeFix(
      { sessionId: 's4', blockId: 'event-click', blockData: { selector: '#x' } },
      {
        signal: new AbortController().signal,
        emit: eventCollector().emit,
      },
    )
    expect(result.success).toBe(false)
    expect(result.rounds).toBe(0)
    expect(result.reason).toContain('goal contract')
  })

  it('reports a missing provider when callModel returns null', async () => {
    const result = await runNodeFix(
      { sessionId: 's5', blockId: 'event-click', blockData: blockData() },
      {
        signal: new AbortController().signal,
        emit: eventCollector().emit,
        executeNode: async () => ({ ok: true }),
        evaluateCriteria: async (cs) =>
          cs.map((condition) => ({ condition, satisfied: false })),
        callModel: async () => null,
      },
    )
    expect(result.success).toBe(false)
    expect(result.reason).toContain('provider')
  })

  it('throws AbortError when cancelled mid-loop', async () => {
    const controller = new AbortController()
    const promise = runNodeFix(
      { sessionId: 's6', blockId: 'event-click', blockData: blockData() },
      {
        signal: controller.signal,
        emit: eventCollector().emit,
        executeNode: async () => {
          controller.abort()
          return { ok: true }
        },
        evaluateCriteria: async (cs) =>
          cs.map((condition) => ({ condition, satisfied: true })),
      },
    )
    await expect(promise).rejects.toThrow('Aborted')
  })
})
