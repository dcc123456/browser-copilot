import { describe, expect, it } from 'vitest'
import {
  buildRepairProposal,
  evidenceOfProposal,
} from '../src/lib/workflow/repair/repair-proposal'
import type {
  WorkflowPatchOperation,
  WorkflowPatchSet,
} from '../src/lib/workflow/repair/types'

function op(
  partial: Partial<WorkflowPatchOperation> & Pick<WorkflowPatchOperation, 'kind' | 'nodeId'>,
): WorkflowPatchOperation {
  return {
    operationId: `op-${partial.nodeId}-${partial.kind}`,
    reason: partial.reason ?? 'because',
    evidenceIds: partial.evidenceIds ?? [],
    ...partial,
  }
}

function patch(operations: WorkflowPatchOperation[]): WorkflowPatchSet {
  return {
    patchSetId: 'ps1',
    analysisId: 'a1',
    operations,
    reason: 'repair reason',
    confidence: 0.8,
    expectedEffect: 'goal achieved',
  }
}

describe('repair proposal model', () => {
  it('rates a set-param change LOW', () => {
    const proposal = buildRepairProposal(
      patch([op({ kind: 'SET_PARAM', nodeId: 'n3', path: 'value', before: 'a', after: 'b' })]),
    )
    expect(proposal.changes[0]!.risk).toBe('LOW')
    expect(proposal.risk).toBe('LOW')
  })

  it('rates a target replacement MEDIUM', () => {
    const proposal = buildRepairProposal(
      patch([op({ kind: 'REPLACE_TARGET', nodeId: 'n5', before: '.x', after: '.y' })]),
    )
    expect(proposal.changes[0]!.risk).toBe('MEDIUM')
  })

  it('rates node removal, insertion and edge rewire HIGH', () => {
    for (const kind of ['REMOVE_NODE', 'INSERT_NODE', 'REWIRE_EDGE'] as const) {
      const proposal = buildRepairProposal(patch([op({ kind, nodeId: 'n5' })]))
      expect(proposal.risk).toBe('HIGH')
    }
  })

  it('takes the highest risk across operations for the proposal', () => {
    const proposal = buildRepairProposal(
      patch([
        op({ kind: 'SET_PARAM', nodeId: 'n3' }),
        op({ kind: 'REPLACE_TARGET', nodeId: 'n5' }),
        op({ kind: 'REMOVE_NODE', nodeId: 'n7' }),
      ]),
    )
    expect(proposal.risk).toBe('HIGH')
  })

  it('lists affected nodes de-duplicated', () => {
    const proposal = buildRepairProposal(
      patch([
        op({ kind: 'SET_PARAM', nodeId: 'n5' }),
        op({ kind: 'SET_PARAM', nodeId: 'n5' }),
        op({ kind: 'SET_PARAM', nodeId: 'n7' }),
      ]),
    )
    expect(proposal.affectedNodeIds).toEqual(['n5', 'n7'])
  })

  it('collects evidence ids de-duplicated', () => {
    const proposal = buildRepairProposal(
      patch([
        op({ kind: 'SET_PARAM', nodeId: 'n5', evidenceIds: ['ev1'] }),
        op({ kind: 'SET_PARAM', nodeId: 'n7', evidenceIds: ['ev1', 'ev2'] }),
      ]),
    )
    expect(evidenceOfProposal(proposal).sort()).toEqual(['ev1', 'ev2'])
  })

  it('derives a verification plan including the expected effect', () => {
    const proposal = buildRepairProposal(
      patch([op({ kind: 'REPLACE_TARGET', nodeId: 'n5' })]),
    )
    expect(proposal.verificationPlan.length).toBeGreaterThan(0)
    expect(proposal.verificationPlan.at(-1)).toContain('goal achieved')
    expect(proposal.verificationPlan.some((s) => s.includes('n5'))).toBe(true)
  })

  it('preserves before/after for display', () => {
    const proposal = buildRepairProposal(
      patch([op({ kind: 'SET_PARAM', nodeId: 'n5', path: 'selector', before: 'x', after: 'y' })]),
    )
    expect(proposal.changes[0]!.before).toBe('x')
    expect(proposal.changes[0]!.after).toBe('y')
    expect(proposal.changes[0]!.path).toBe('selector')
  })
})
