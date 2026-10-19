import { describe, expect, it, vi } from 'vitest'
import { finalizeGeneratedWorkflow } from '../../src/background/workflow-engine/repair/generation-repair'
import { buildRepairContext } from '../../src/background/workflow-engine/repair/repair-agent'
import { createMemoryCheckpointStore } from '../../src/lib/workflow/checkpoints'
import { TraceCollector } from '../../src/lib/workflow/execution-trace'
import type { WorkflowRunner } from '../../src/background/workflow-engine/repair/verification-runner'
import type { RepairContext, WorkflowPatchSet } from '../../src/lib/workflow/repair/types'
import type { RepairReflection } from '../../src/lib/workflow/repair-reflection'
import { edge, makeWorkflow, node } from './helpers'

/**
 * Reflection in the patch-and-retry loop.
 *
 * The field this loop shipped as a permanent `[]` is `repairHistory` — the
 * proposer had nothing to learn from the round that just failed. These tests
 * pin the loop's behaviour both with reflection available and without it.
 */

const wf = makeWorkflow(
  [
    node('t', 'trigger'),
    node('n3', 'get-text', { variableName: 'captcha', selector: '.code' }),
    node('n5', 'event-click', { selector: '{{captcha}}' }),
  ],
  [edge('t', 'n3'), edge('n3', 'n5')],
)

function failedTrace(runId: string, variables: Record<string, unknown>) {
  const collector = new TraceCollector({ workflowId: wf.id, runId, entry: 'GENERATION' })
  let incoming: Record<string, unknown> = {}
  for (const [id, failed] of [
    ['t', false],
    ['n3', false],
    ['n5', true],
  ] as [string, boolean][]) {
    const wfNode = wf.drawflow.nodes.find((item) => item.id === id)!
    collector.startNode(wfNode, incoming)
    if (failed) {
      collector.finishNode(wfNode, 'failed', incoming, variables, {
        code: 'ACTION_ERROR',
        message: 'ACTION_ERROR',
        nodeId: id,
        retryable: false,
        source: 'EXECUTOR',
      })
    } else {
      collector.finishNode(wfNode, 'ok', incoming, variables)
    }
    incoming = variables
  }
  return collector.build('failed', variables, {
    code: 'ACTION_ERROR',
    message: 'ACTION_ERROR',
    nodeId: 'n5',
    retryable: false,
    source: 'EXECUTOR',
  })
}

/** Always fails, so every round keeps failing and keeps reflecting. */
function alwaysFailingRunner(): WorkflowRunner {
  return {
    run: async () => ({
      outcome: 'failed' as const,
      error: 'ACTION_ERROR',
      trace: failedTrace('r', {}),
    }),
  }
}

const patch: WorkflowPatchSet = {
  patchSetId: 'ps-1',
  analysisId: '',
  operations: [
    {
      operationId: 'op',
      nodeId: 'n3',
      kind: 'SET_PARAM',
      path: 'selector',
      before: '.code',
      after: 'input.code',
      reason: 'read the value',
      evidenceIds: ['ev-1'],
    },
  ],
  reason: 'captcha producer reads the wrong property',
  confidence: 0.9,
  expectedEffect: 'captcha becomes non-empty',
}

const reflection: RepairReflection = {
  rootCause: 'the producer reads text, the consumer needs a value',
  evidence: '.code is a span; input.code is the field',
  nextApproach: 'read the input value, not the span text',
  confidence: 0.9,
}

describe('generation repair: reflection between rounds', () => {
  it('reflects after a failed replay and hands the conclusion to the next proposal', async () => {
    const seen: RepairContext[] = []
    const result = await finalizeGeneratedWorkflow(wf, {
      runner: alwaysFailingRunner(),
      store: createMemoryCheckpointStore(),
      propose: async (context) => {
        seen.push(context)
        return patch
      },
      reflect: vi.fn(async () => reflection),
      policy: { maxRepairRounds: 2, maxTotalDurationMs: 60_000 },
    })

    expect(result.status).toBe('DRAFT')
    expect(seen).toHaveLength(2)
    // Round 1 has nothing to learn from; round 2 must.
    expect(seen[0]!.repairHistory).toHaveLength(0)
    expect(seen[0]!.reflection).toBeUndefined()
    expect(seen[1]!.repairHistory).toHaveLength(1)
    expect(seen[1]!.reflection?.nextApproach).toBe('read the input value, not the span text')
  })

  it('behaves exactly as before when no reflection runner is supplied', async () => {
    const seen: RepairContext[] = []
    const result = await finalizeGeneratedWorkflow(wf, {
      runner: alwaysFailingRunner(),
      store: createMemoryCheckpointStore(),
      propose: async (context) => {
        seen.push(context)
        return patch
      },
      policy: { maxRepairRounds: 2, maxTotalDurationMs: 60_000 },
    })

    expect(result.status).toBe('DRAFT')
    expect(seen[1]!.repairHistory).toHaveLength(1)
    expect(seen[1]!.reflection).toBeUndefined()
  })

  it('does not spend a reflection on the last round', async () => {
    const reflect = vi.fn(async () => reflection)
    await finalizeGeneratedWorkflow(wf, {
      runner: alwaysFailingRunner(),
      store: createMemoryCheckpointStore(),
      propose: async () => patch,
      reflect,
      policy: { maxRepairRounds: 2, maxTotalDurationMs: 60_000 },
    })
    // Two rounds: the first failed and had a successor, the second had none.
    expect(reflect).toHaveBeenCalledTimes(1)
  })

  it('survives a reflection that throws', async () => {
    const steps: string[] = []
    const result = await finalizeGeneratedWorkflow(wf, {
      runner: alwaysFailingRunner(),
      store: createMemoryCheckpointStore(),
      propose: async () => patch,
      reflect: vi.fn(async () => {
        throw new Error('provider down')
      }),
      onStep: (kind, text) => steps.push(`${kind}: ${text}`),
      policy: { maxRepairRounds: 2, maxTotalDurationMs: 60_000 },
    })
    // The thrown reflection is swallowed and the loop carries on: round 2 still
    // runs and is rejected by the ordinary stale-patch guard, not by anything
    // reflection did.
    expect(steps.join('\n')).toMatchInlineSnapshot(`
      "error: Patch rejected: stale patch: current value of selector no longer matches "before"; re-diagnosis required
      error: Repair budget exhausted; preserving the workflow as a draft."
    `)
    expect(result.status).toBe('DRAFT')
    expect(result.patches).toHaveLength(1)
  })
})

describe('buildRepairContext', () => {
  const analysis = {
    analysisVersion: 1 as const,
    analysisId: 'a1',
    failedNodeId: 'n5',
    rootCauseNodeIds: ['n3'],
    failureType: 'VARIABLE_EMPTY' as const,
    repairTarget: 'UPSTREAM_NODE' as const,
    dependencyChain: [],
    variableEvidence: [],
    pageEvidence: [],
    alternatives: [],
    explanation: 'producer is root',
    confidence: 0.85,
    retryRecommended: false,
  }

  it('surfaces the newest reflection a past round recorded', () => {
    const context = buildRepairContext(wf, failedTrace('r1', {}), analysis, [
      { round: 1, rootCauseNodeIds: ['n3'], result: 'FAILED' },
      {
        round: 2,
        rootCauseNodeIds: ['n3'],
        result: 'FAILED',
        reflection: { ...reflection, rootCause: 'the newer one' },
      },
    ])
    expect(context.reflection?.rootCause).toBe('the newer one')
  })

  it('skips rounds that recorded no reflection', () => {
    const context = buildRepairContext(wf, failedTrace('r1', {}), analysis, [
      { round: 1, rootCauseNodeIds: ['n3'], result: 'FAILED', reflection },
      { round: 2, rootCauseNodeIds: ['n3'], result: 'FAILED' },
    ])
    expect(context.reflection?.rootCause).toBe(reflection.rootCause)
  })

  it('leaves the field absent when nothing has failed yet', () => {
    const context = buildRepairContext(wf, failedTrace('r1', {}), analysis)
    expect(context.repairHistory).toEqual([])
    expect(context.reflection).toBeUndefined()
  })
})
