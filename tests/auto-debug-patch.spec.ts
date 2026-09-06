import { describe, expect, it } from 'vitest'
import { describeNodeParams, patchNodeParams } from '../src/lib/workflow/auto-debug-patch'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

/** Build a minimal Workflow from nodes + edges (mirrors workflow-engine.spec). */
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

const node = (id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label: blockId,
  position: { x: 0, y: 0 },
  data: { blockId, description: '', ...data },
})

const edge = (source: string, target: string, handle?: string): WorkflowEdge => ({
  id: `${source}->${target}${handle ? `:${handle}` : ''}`,
  source,
  target,
  ...(handle ? { sourceHandle: handle } : {}),
})

describe('patchNodeParams', () => {
  it('merges corrected params flat onto node data and reports old → new', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })],
      [edge('a', 'b')],
    )
    const applied = patchNodeParams(wf, 'b', { selector: '.fresh' })
    expect(applied.changed).toBe(true)
    expect(applied.workflow.drawflow.nodes[1]!.data['selector']).toBe('.fresh')
    expect(applied.changes[0]).toContain('.stale')
    expect(applied.changes[0]).toContain('.fresh')
  })

  it('protects blockId and disableBlock from being rewritten', () => {
    // Canonical nodes carry the catalog defaults (incl. disableBlock: false).
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('b', 'event-click', { disableBlock: false })],
      [edge('a', 'b')],
    )
    const applied = patchNodeParams(wf, 'b', { blockId: 'ai-agent', disableBlock: true, selector: 'x' })
    expect(applied.changed).toBe(true)
    const data = applied.workflow.drawflow.nodes[1]!.data
    expect(data['blockId']).toBe('event-click')
    expect(data['disableBlock']).toBe(false)
    expect(data['selector']).toBe('x')
  })

  it('is a no-op on an empty patch or an unknown node', () => {
    const wf = makeWorkflow([node('a', 'trigger')], [])
    expect(patchNodeParams(wf, 'a', {}).changed).toBe(false)
    expect(patchNodeParams(wf, 'ghost', { selector: '.x' }).changed).toBe(false)
  })

  it('is pure: the input workflow object is never mutated', () => {
    const wf = makeWorkflow(
      [node('a', 'trigger'), node('b', 'event-click', { selector: '.stale' })],
      [edge('a', 'b')],
    )
    const before = JSON.stringify(wf)
    patchNodeParams(wf, 'b', { selector: '.fresh' })
    expect(JSON.stringify(wf)).toBe(before)
  })
})

describe('describeNodeParams', () => {
  it('summarizes params as key=value pairs and skips noise keys', () => {
    const line = describeNodeParams(
      node('b', 'event-click', {
        blockId: 'event-click',
        description: '人类描述',
        disableBlock: false,
        selector: '.submit',
        findBy: 'cssSelector',
        markEl: true,
        empty: '',
        gone: undefined,
        off: false,
      }),
    )
    expect(line).toContain('selector=.submit')
    expect(line).toContain('findBy=cssSelector')
    expect(line).toContain('markEl=true')
    expect(line).not.toContain('blockId')
    expect(line).not.toContain('description')
    expect(line).not.toContain('disableBlock')
    expect(line).not.toContain('empty')
    expect(line).not.toContain('off')
  })

  it('collapses the retry policy and truncates long values', () => {
    const line = describeNodeParams(
      node('b', 'event-click', {
        onError: { enable: true, retry: true, toDo: 'retry', retryTimes: 3, retryInterval: 2000 },
        selector: 'x'.repeat(120),
      }),
    )
    expect(line).toContain('onError=重试×3')
    expect(line).toMatch(/selector=x{50}…/)
    expect(line).not.toContain('retryTimes=')
  })

  it('returns an empty string for a bare node', () => {
    expect(describeNodeParams(node('b', 'delay'))).toBe('')
  })
})
