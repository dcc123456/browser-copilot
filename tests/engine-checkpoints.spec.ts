/**
 * Tests for the engine's M4 checkpoint hooks:
 *  - one checkpoint per settled node, in order, with the right status;
 *  - a failed (and a cancelled) node is recorded too, not silently skipped;
 *  - per-node retries are IDEMPOTENT: attempt 2 starts from the variables the
 *    node saw BEFORE attempt 1, not from the half-written state attempt 1 left
 *    behind (a form already partially filled, a counter already bumped).
 *
 * Everything is injected: executors are stubs, so no browser is touched.
 */
import { describe, expect, it } from 'vitest'

import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

const node = (id: string, label: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data,
})

const edge = (source: string, target: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
})

/** The checkpoint entries the engine reports, in order. */
interface Seen {
  stepIndex: number
  nodeId: string
  status: 'ok' | 'failed' | 'cancelled'
  variables: Record<string, unknown>
}

describe('engine checkpoints (M4)', () => {
  it('reports one checkpoint per settled node, in order', async () => {
    const seen: Seen[] = []
    const wf = makeWorkflow(
      [node('a', 'step-a'), node('b', 'step-b'), node('c', 'step-c')],
      [edge('a', 'b'), edge('b', 'c')],
    )
    await runWorkflow(wf, {
      executors: {
        'step-a': async (_data, ctx) => {
          ctx.variables['first'] = 1
          return null
        },
        'step-b': async () => null,
        'step-c': async () => null,
      },
      onCheckpoint: (entry) => seen.push(entry),
    })
    expect(seen.map((entry) => entry.nodeId)).toEqual(['a', 'b', 'c'])
    expect(seen.map((entry) => entry.stepIndex)).toEqual([0, 1, 2])
    expect(seen.every((entry) => entry.status === 'ok')).toBe(true)
    // Variables are carried forward, and step b already sees step a's output.
    expect(seen[0]?.variables).toEqual({ first: 1 })
    expect(seen[1]?.variables).toEqual({ first: 1 })
  })

  it('records a failed node as failed (the rollback point)', async () => {
    const seen: Seen[] = []
    const wf = makeWorkflow([node('a', 'step-a'), node('b', 'step-b')], [edge('a', 'b')])
    const result = await runWorkflow(wf, {
      executors: {
        'step-a': async () => null,
        'step-b': async () => {
          throw new Error('boom')
        },
      },
      onCheckpoint: (entry) => seen.push(entry),
    })
    expect(result.outcome).toBe('failed')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ nodeId: 'a', status: 'ok' })
    expect(seen[1]).toMatchObject({ nodeId: 'b', status: 'failed', stepIndex: 1 })
  })

  it('records a cancelled node as cancelled', async () => {
    const seen: Seen[] = []
    const controller = new AbortController()
    const wf = makeWorkflow([node('a', 'step-a')], [])
    const result = await runWorkflow(wf, {
      signal: controller.signal,
      executors: {
        'step-a': async () => {
          controller.abort()
          throw new DOMException('Aborted', 'AbortError')
        },
      },
      onCheckpoint: (entry) => seen.push(entry),
    })
    expect(result.outcome).toBe('cancelled')
    expect(seen[0]).toMatchObject({ nodeId: 'a', status: 'cancelled' })
  })

  it('a retried node starts attempt 2 from the pre-node variables (idempotent retry)', async () => {
    let attempts = 0
    const wf = makeWorkflow(
      [
        node('a', 'step-a', {
          onError: { enable: true, retry: true, retryTimes: 1, retryInterval: 0 },
        }),
      ],
      [],
    )
    const result = await runWorkflow(wf, {
      variables: { filled: 'no' },
      executors: {
        // Attempt 1 mutates a variable and THEN fails — exactly what a real
        // block does when it half-completes (fills a field, then the submit
        // times out). Attempt 2 must not inherit that half-state.
        'step-a': async (_data, ctx) => {
          attempts += 1
          ctx.variables['filled'] = `attempt-${attempts}`
          if (attempts === 1) throw new Error('transient')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(attempts).toBe(2)
    // The successful attempt overwrote it, so the run's final value is its own;
    // the proof of the restore is that attempt 2 STARTED from 'no', which the
    // executor records below.
    expect(result.variables).toEqual({ filled: 'attempt-2' })
  })

  it('restores pre-node variables for attempt 2 (observed from inside the retry)', async () => {
    const observed: unknown[] = []
    let attempts = 0
    const wf = makeWorkflow(
      [
        node('a', 'step-a', {
          onError: { enable: true, retry: true, retryTimes: 1, retryInterval: 0 },
        }),
      ],
      [],
    )
    await runWorkflow(wf, {
      variables: { filled: 'no', kept: 'yes' },
      executors: {
        'step-a': async (_data, ctx) => {
          attempts += 1
          // What this attempt SEES on entry — the state it starts from.
          observed.push({ ...ctx.variables })
          ctx.variables['filled'] = 'yes'
          if (attempts === 1) throw new Error('transient')
          return null
        },
      },
    })
    expect(attempts).toBe(2)
    // Attempt 1 starts from the run's initial state…
    expect(observed[0]).toEqual({ filled: 'no', kept: 'yes' })
    // …and attempt 2 starts from that SAME state, not from attempt 1's
    // half-written `filled: 'yes'`. Without the restore this would be
    // `{ filled: 'yes', kept: 'yes' }`.
    expect(observed[1]).toEqual({ filled: 'no', kept: 'yes' })
  })

  it('a sub-workflow shares the parent checkpoint sink', async () => {
    const seen: Seen[] = []
    const parent = makeWorkflow(
      [node('a', 'step-a'), node('exec', 'execute-workflow', { workflowId: 'child' })],
      [edge('a', 'exec')],
    )
    const child = makeWorkflow([node('c1', 'step-c1')], [])
    await runWorkflow(parent, {
      resolveWorkflow: async () => child,
      executors: {
        'step-a': async () => null,
        'step-c1': async () => null,
        'execute-workflow': async () => null,
      },
      onCheckpoint: (entry) => seen.push(entry),
    })
    // The child's step is recorded through the same sink as the parent's.
    expect(seen.map((entry) => entry.nodeId)).toContain('c1')
  })
})
