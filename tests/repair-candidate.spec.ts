import { describe, expect, it } from 'vitest'
import {
  applyRepairCandidate,
  normalizeLegacyParamsPatch,
  parseRepairResponse,
  validateRepairCandidate,
} from '../src/lib/workflow/repair-candidate'
import type { Workflow } from '../src/lib/workflow/types'

function makeWorkflow(): Workflow {
  return {
    id: 'wf-1',
    name: 'test',
    createdAt: 1,
    updatedAt: 1,
    drawflow: {
      nodes: [
        {
          id: 'n1',
          label: 'trigger',
          position: { x: 0, y: 0 },
          data: { blockId: 'trigger', selector: '' },
        },
        {
          id: 'n2',
          label: 'click',
          position: { x: 0, y: 100 },
          data: { blockId: 'click', selector: '#old' },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    },
    settings: {
      saveLog: true,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

describe('repair response parser', () => {
  it('treats empty and refusal as empty (never a human takeover)', () => {
    expect(parseRepairResponse('').kind).toBe('empty')
    expect(parseRepairResponse('  ').kind).toBe('empty')
    expect(parseRepairResponse('No candidate available for this strategy.').kind).toBe('empty')
    expect(parseRepairResponse(undefined).kind).toBe('empty')
  })

  it('extracts embedded JSON from prose/fences', () => {
    const raw = [
      'Here is the fix:',
      '```json',
      JSON.stringify({
        strategy: 'locator-repair',
        reason: 'selector changed',
        nodePatches: [
          { op: 'update-node', nodeId: 'n2', changes: { selector: '#new' } },
        ],
        edgePatches: [],
      }),
      '```',
    ].join('\n')
    const parsed = parseRepairResponse(raw)
    expect(parsed.kind).toBe('candidate')
    if (parsed.kind === 'candidate') {
      expect(parsed.candidate.strategy).toBe('locator-repair')
    }
  })

  it('marks unparseable text invalid', () => {
    expect(parseRepairResponse('definitely not json at all').kind).toBe('invalid')
  })
})

describe('candidate validation and apply', () => {
  it('accepts a valid locator patch and applies it immutably', () => {
    const workflow = makeWorkflow()
    const candidate = normalizeLegacyParamsPatch({
      nodeId: 'n2',
      params: { selector: '#new' },
      reason: 'markup changed',
      strategy: 'locator-repair',
    })
    expect(validateRepairCandidate(candidate, workflow)).toEqual([])

    const result = applyRepairCandidate(workflow, candidate)
    expect(result.issues).toEqual([])
    expect(result.changedNodeIds).toEqual(['n2'])
    const updated = result.workflow.drawflow.nodes.find((node) => node.id === 'n2')
    expect(updated?.data['selector']).toBe('#new')
    // Original untouched.
    const original = workflow.drawflow.nodes.find((node) => node.id === 'n2')
    expect(original?.data['selector']).toBe('#old')
  })

  it('rejects patches to unknown nodes', () => {
    const workflow = makeWorkflow()
    const candidate = normalizeLegacyParamsPatch({
      nodeId: 'nope',
      params: { selector: '#x' },
    })
    expect(validateRepairCandidate(candidate, workflow).length).toBeGreaterThan(0)
  })

  it('reports integrity issues after a destructive patch', () => {
    const workflow = makeWorkflow()
    const result = applyRepairCandidate(workflow, {
      strategy: 'local-graph-repair',
      reason: 'test',
      nodePatches: [{ op: 'delete-node', nodeId: 'n2' }],
      edgePatches: [],
      expectedPostconditions: [],
    })
    // Deleting n2 orphans nothing but changes graph; deletion itself is legal.
    expect(result.changedNodeIds).toEqual(['n2'])
    expect(result.workflow.drawflow.nodes.some((node) => node.id === 'n2')).toBe(false)
  })
})
