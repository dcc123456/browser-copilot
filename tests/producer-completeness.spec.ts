/**
 * Unit tests for the producer-completeness check.
 *
 * Covers the two failure shapes behind "the generated workflow has most
 * nodes missing and cannot run":
 *
 *   - a `{{reference}}` with no producer node / trigger declaration;
 *   - `export-data` with no upstream saveData read feeding the table;
 *
 * and the legitimate cases (producer upstream, declared trigger input).
 */
import { describe, expect, it } from 'vitest'
import type { Workflow } from '../src/lib/workflow/types'
import {
  checkProducerCompleteness,
  describeProducerIssues,
} from '../src/lib/workflow/producer-completeness'

type NodeData = Record<string, unknown>

function workflow(nodes: Workflow['drawflow']['nodes']): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    trigger: { type: 'manual' },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes, edges: [] },
  }
}

function node(id: string, blockId: string, data: NodeData = {}): Workflow['drawflow']['nodes'][number] {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

describe('checkProducerCompleteness', () => {
  it('reports nothing when a producer node sits upstream', () => {
    const wf = workflow([
      node('t', 'trigger'),
      node('read', 'get-text', { variableName: 'title' }),
      node('save', 'save-local', { value: '{{title}}', filename: 'a.txt' }),
    ])
    expect(checkProducerCompleteness(wf)).toEqual([])
  })

  it('flags a referenced variable with no producer node', () => {
    const wf = workflow([
      node('t', 'trigger'),
      node('save', 'save-local', { value: '{{title}}', filename: 'a.txt' }),
    ])
    const issues = checkProducerCompleteness(wf)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.code).toBe('MISSING_PRODUCER')
    expect(issues[0]!.reference).toBe('title')
    expect(issues[0]!.nodeId).toBe('save')
  })

  it('accepts a reference declared as a trigger input', () => {
    const wf = workflow([
      node('t', 'trigger', {
        parameters: [{ name: 'title', defaultValue: 'x' }],
      }),
      node('save', 'save-local', { value: '{{title}}', filename: 'a.txt' }),
    ])
    expect(checkProducerCompleteness(wf)).toEqual([])
  })

  it('flags export-data without a saveData table producer', () => {
    const wf = workflow([
      node('t', 'trigger'),
      node('exp', 'export-data', { name: 'out.csv' }),
    ])
    const issues = checkProducerCompleteness(wf)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.code).toBe('MISSING_TABLE_PRODUCER')
  })

  it('accepts export-data fed by a saveData get-text node', () => {
    const wf = workflow([
      node('t', 'trigger'),
      node('read', 'get-text', {
        saveData: true,
        dataColumn: 'content',
        variableName: 'rows',
      }),
      node('exp', 'export-data', { name: 'out.csv' }),
    ])
    expect(checkProducerCompleteness(wf)).toEqual([])
  })

  it('deduplicates repeated references in one node', () => {
    const wf = workflow([
      node('t', 'trigger'),
      node('note', 'notification', { title: '{{x}}', body: 'val {{x}}' }),
    ])
    const issues = checkProducerCompleteness(wf)
    expect(issues.filter((i) => i.reference === 'x')).toHaveLength(1)
  })

  it('describes issues as a joined detail string', () => {
    const wf = workflow([
      node('t', 'trigger'),
      node('save', 'save-local', { value: '{{title}}', filename: 'a.txt' }),
    ])
    const detail = describeProducerIssues(checkProducerCompleteness(wf))
    expect(detail).toContain('{{title}}')
  })
})
