import { describe, expect, it, vi } from 'vitest'
import {
  proposeWithSelectorVerification,
  type SelectorProbe,
} from '../src/background/workflow-engine/repair/proposal-verification'
import type {
  PageEvidence,
  RepairContext,
  WorkflowPatchOperation,
  WorkflowPatchSet,
} from '../src/lib/workflow/repair/types'

function op(operationId: string, nodeId: string, selector: string): WorkflowPatchOperation {
  return {
    operationId,
    nodeId,
    kind: 'SET_PARAM',
    path: 'selector',
    after: selector,
    reason: 'test',
    evidenceIds: [],
  }
}

function patch(selectors: string[]): WorkflowPatchSet {
  return {
    patchSetId: 'p1',
    analysisId: 'a1',
    operations: selectors.map((sel, i) => op(`o${i}`, 'n1', sel)),
    reason: 'test',
    confidence: 0.9,
    expectedEffect: 'fix selector',
  }
}

function makeContext(): RepairContext {
  return {
    failedNodeId: 'n1',
    rootCauseNodeIds: ['n1'],
    failureType: 'TARGET_NOT_FOUND',
    dependencyChain: [],
    variableEvidence: [],
    pageEvidence: [],
    allowedNodeIds: ['n1'],
    allowedParamPaths: { n1: ['selector'] },
    recentTrace: [],
    repairHistory: [],
  }
}

function probe(over: Partial<SelectorProbe> = {}): SelectorProbe {
  return {
    count: async () => 1,
    candidates: async () => [],
    ...over,
  }
}

describe('proposeWithSelectorVerification', () => {
  it('returns a unique proposal immediately without re-proposing', async () => {
    const propose = vi.fn(async () => patch(['#only']))
    const result = await proposeWithSelectorVerification(
      propose,
      probe({ count: async () => 1 }),
      makeContext(),
      3,
    )

    expect(result.patch?.operations).toHaveLength(1)
    expect(result.rounds).toBe(1)
    expect(result.rejected).toEqual([])
    expect(propose).toHaveBeenCalledTimes(1)
  })

  it('rejects an ambiguous selector and feeds candidate evidence back into the context', async () => {
    const evidence: PageEvidence = {
      evidenceId: 'page-cand-0',
      kind: 'DOM',
      detail: '#submit <button> "Save"',
    }
    const propose = vi.fn(async (context: RepairContext) => {
      // First round proposes the ambiguous selector; subsequent rounds give up.
      if (context.pageEvidence.length === 0) return patch(['.many'])
      return null
    })
    const candidates = vi.fn(async () => [evidence])
    const context = makeContext()
    const result = await proposeWithSelectorVerification(
      propose,
      probe({ count: async () => 4, candidates }),
      context,
      3,
    )

    expect(result.patch).toBeNull()
    expect(result.rejected).toEqual([
      { operationId: 'o0', nodeId: 'n1', selector: '.many', matches: 4 },
    ])
    // The live candidate was pushed in place so the next propose sees it.
    expect(context.pageEvidence).toContainEqual(evidence)
    expect(candidates).toHaveBeenCalledWith('.many')
  })

  it('keeps an unverifiable selector instead of regressing an offline repair', async () => {
    const propose = vi.fn(async () => patch(['#maybe']))
    const result = await proposeWithSelectorVerification(
      propose,
      probe({ count: async () => null }),
      makeContext(),
      3,
    )

    expect(result.patch?.operations).toHaveLength(1)
    expect(result.rejected).toEqual([])
    expect(propose).toHaveBeenCalledTimes(1)
  })

  it('caps the loop at maxRounds and truthfully reports every rejection', async () => {
    const propose = vi.fn(async () => patch(['.row']))
    const result = await proposeWithSelectorVerification(
      propose,
      probe({ count: async () => 2, candidates: async () => [] }),
      makeContext(),
      2,
    )

    expect(result.patch).toBeNull()
    expect(result.rounds).toBe(2)
    expect(result.rejected).toHaveLength(2)
    expect(propose).toHaveBeenCalledTimes(2)
  })

  it('returns null when there is no proposal at all', async () => {
    const propose = vi.fn(async () => null)
    const result = await proposeWithSelectorVerification(propose, probe(), makeContext(), 3)

    expect(result.patch).toBeNull()
    expect(result.rounds).toBe(0)
    expect(result.rejected).toEqual([])
  })
})
