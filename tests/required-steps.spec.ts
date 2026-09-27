// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { requiredStepIdsOf } from '../src/lib/workflow/required-steps'
import type { Workflow } from '../src/lib/workflow/types'

/**
 * Minimal linear workflow: trigger → get-text → get-text.
 * The second get-text's selector references the first step's output variable
 * (`{{first}}`), so dropping the producer strands the consumer.
 */
function workflowWithVarDependency(): Workflow {
  return {
    id: 'wf-req',
    name: 'req-workflow',
    description: '',
    trigger: { type: 'manual' },
    createdAt: 1, updatedAt: 1,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    table: [],
    drawflow: {
      nodes: [
        { id: 'n0', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
        {
          id: 'n1',
          label: 'get-text',
          position: { x: 160, y: 80 },
          data: { blockId: 'get-text', selector: '#token', variableName: 'first' },
        },
        {
          id: 'n2',
          label: 'get-text',
          position: { x: 160, y: 220 },
          data: { blockId: 'get-text', selector: '{{first}}', variableName: 'out' },
        },
      ],
      edges: [
        { id: 'e0', source: 'n0', target: 'n1' },
        { id: 'e1', source: 'n1', target: 'n2' },
      ],
    },
  }
}

describe('requiredStepIdsOf', () => {
  it('marks the last action node required: dropping it leaves nothing to run', () => {
    const wf: Workflow = {
      ...workflowWithVarDependency(),
      drawflow: {
        nodes: [
          { id: 'n0', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
          {
            id: 'n2',
            label: 'get-text',
            position: { x: 160, y: 80 },
            data: { blockId: 'get-text', selector: '#x', variableName: 'out' },
          },
        ],
        edges: [{ id: 'e0', source: 'n0', target: 'n2' }],
      },
    }
    expect(requiredStepIdsOf(wf)).toEqual(['n2'])
  })

  it('marks the producer step required when a later step reads its variable', () => {
    const required = requiredStepIdsOf(workflowWithVarDependency())
    expect(required).toContain('n1')
  })

  it('does not flag the consumer step as required merely for consuming', () => {
    const required = requiredStepIdsOf(workflowWithVarDependency())
    expect(required).not.toContain('n2')
  })
})
