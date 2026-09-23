/**
 * Data-flow cache / incremental analysis tests (spec §15 Phase 8 · P3).
 */
import { describe, expect, it } from 'vitest'

import {
  DataFlowCache,
  incomingEdgeIndex,
  traceVariableChainFast,
} from '../../src/lib/workflow/repair/dataflow-cache'
import { buildFailureCorpus } from '../../src/lib/workflow/repair/failure-corpus'
import { traceVariableChain } from '../../src/lib/workflow/repair/dataflow-analyzer'

describe('DataFlowCache', () => {
  const corpus = buildFailureCorpus()
  const sample = corpus.find((entry) => entry.id === 'caseB-upstream-empty')!

  it('rebuilds on first call and reuses on repeated calls', () => {
    const cache = new DataFlowCache()
    const first = cache.get(sample.workflow, sample.trace)
    expect(first.rebuilt).toBe(true)
    const second = cache.get(sample.workflow, sample.trace)
    expect(second.rebuilt).toBe(false)
    // Same graph object reference — safe shared reuse.
    expect(second.graph).toBe(first.graph)
  })

  it('rebuilds after the workflow structurally changed', () => {
    const cache = new DataFlowCache()
    const first = cache.get(sample.workflow, sample.trace)
    // Mutate one node's data so the fingerprint changes.
    const changed = {
      ...sample.workflow,
      drawflow: {
        ...sample.workflow.drawflow,
        nodes: sample.workflow.drawflow.nodes.map((node) =>
          node.id === 'n3' ? { ...node, data: { ...node.data, selector: '.new' } } : node,
        ),
      },
    }
    const second = cache.get(changed, sample.trace)
    expect(second.rebuilt).toBe(true)
    expect(second.graph).not.toBe(first.graph)
  })

  it('invalidate forces a rebuild', () => {
    const cache = new DataFlowCache()
    expect(cache.get(sample.workflow, sample.trace).rebuilt).toBe(true)
    cache.invalidate()
    expect(cache.get(sample.workflow, sample.trace).rebuilt).toBe(true)
  })
})

describe('indexed chain walk', () => {
  it('matches the reference walk across the whole corpus', () => {
    const corpus = buildFailureCorpus()
    for (const sample of corpus) {
      const cache = new DataFlowCache()
      const { graph } = cache.get(sample.workflow, sample.trace)
      const reference = traceVariableChain(graph, sample.expected.failedNodeId)
      const fast = traceVariableChainFast(graph, sample.expected.failedNodeId)
      expect(fast.roots).toEqual(reference.roots)
      expect(fast.cycle).toBe(reference.cycle)
      expect(fast.chain).toEqual(reference.chain)
    }
  })

  it('builds a CONSUMES incoming adjacency index', () => {
    const corpus = buildFailureCorpus()
    const sample = corpus.find((entry) => entry.id === 'caseD-multiple-roots')!
    const cache = new DataFlowCache()
    const { graph } = cache.get(sample.workflow, sample.trace)
    const index = incomingEdgeIndex(graph)
    // n5 consumes both username and password.
    expect(index.get('n5')?.length).toBe(2)
  })
})
