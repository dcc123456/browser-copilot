/**
 * Rewrite risk classification tests (spec §8.4 · P2).
 */
import { describe, expect, it } from 'vitest'

import { classifyRewriteRisk, diffRewrites } from '../src/lib/workflow/rewrite-risk'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const node = (id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label: blockId,
  position: { x: 0, y: 0 },
  data: { blockId, ...data },
})

const workflow = (nodes: WorkflowNode[], edges: [string, string][] = []): Workflow => ({
  id: 'wf',
  name: 'wf',
  description: '',
  createdAt: 0,
  updatedAt: 0,
  drawflow: {
    nodes,
    edges: edges.map(([source, target], i) => ({
      id: `e${i}`,
      source,
      target,
    })),
  },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
})

describe('rewrite risk', () => {
  it('LOW when only params change on the same shape', () => {
    const original = workflow([node('t', 'trigger'), node('n5', 'click', { selector: '.a' })])
    const rewrite = workflow([node('t', 'trigger'), node('n5', 'click', { selector: '.b' })])
    const verdict = classifyRewriteRisk(original, rewrite)
    expect(verdict.level).toBe('LOW')
    expect(verdict.allowsAutoApply).toBe(true)
  })

  it('MEDIUM when a limited rewire/replace happens', () => {
    const original = workflow(
      [node('t', 'trigger'), node('n1', 'delay'), node('n2', 'delay'), node('n5', 'click')],
      [
        ['t', 'n1'],
        ['n1', 'n2'],
        ['n2', 'n5'],
      ],
    )
    const rewrite = workflow(
      [
        node('t', 'trigger'),
        node('n1', 'delay'),
        node('n2', 'delay'),
        node('n5', 'click'),
        node('n6', 'delay'),
      ],
      [
        ['t', 'n1'],
        ['n1', 'n2'],
        ['n2', 'n5'],
        ['n5', 'n6'],
      ],
    )
    const verdict = classifyRewriteRisk(original, rewrite)
    expect(verdict.level).toBe('MEDIUM')
  })

  it('HIGH when a side-effect block is added or many nodes change', () => {
    const original = workflow([node('t', 'trigger'), node('n5', 'delay')])
    const rewrite = workflow([
      node('t', 'trigger'),
      node('n5', 'delay'),
      node('n6', 'forms', { selector: '#pay' }),
    ])
    const verdict = classifyRewriteRisk(original, rewrite)
    expect(verdict.level).toBe('HIGH')
    expect(verdict.allowsAutoApply).toBe(false)
  })

  it('CRITICAL when the trigger node is removed/changed', () => {
    const original = workflow([node('t', 'trigger'), node('n5', 'delay')])
    // Rewrite keeps an id 't' but it is no longer a trigger.
    const rewrite = workflow([node('t', 'delay'), node('n5', 'delay')])
    const verdict = classifyRewriteRisk(original, rewrite)
    expect(verdict.level).toBe('CRITICAL')
    expect(verdict.allowsAutoApply).toBe(false)
  })

  it('computes a precise structural diff', () => {
    const original = workflow([node('t', 'trigger'), node('a', 'delay')])
    const rewrite = workflow([node('t', 'trigger'), node('b', 'delay')])
    const diff = diffRewrites(original, rewrite)
    expect(diff.added).toEqual(['b'])
    expect(diff.removed).toEqual(['a'])
  })
})
