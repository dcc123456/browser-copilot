import { describe, expect, it } from 'vitest'
import { resolveWorkflowTarget } from '../src/lib/workflow/locator-resolver'
import type { LocatorProbe } from '../src/lib/workflow/locator-resolver'
import type { WorkflowNode } from '../src/lib/workflow/types'

function elementNode(data: Record<string, unknown>): WorkflowNode {
  return {
    id: 'n1',
    label: 'event-click',
    position: { x: 0, y: 0 },
    data: { blockId: 'event-click', ...data },
  }
}

describe('semantic locator and target resolver', () => {
  it('resolves a unique primary selector', async () => {
    const probe: LocatorProbe = (selector) => (selector === '.buy' ? 1 : 0)
    const result = await resolveWorkflowTarget(elementNode({ selector: '.buy' }), probe)
    expect(result.status).toBe('RESOLVED_PRIMARY')
    expect(result.selector).toBe('.buy')
    expect(result.usedFallback).toBe(false)
    expect(result.matchCount).toBe(1)
  })

  it('falls back to a target-derived selector when the primary misses', async () => {
    // Primary css selector is stale (0 matches); the rich target carries a
    // testid that resolves uniquely.
    const probe: LocatorProbe = (selector) => {
      if (selector === '.stale') return 0
      if (selector.includes('data-testid')) return 1
      return 0
    }
    const result = await resolveWorkflowTarget(
      elementNode({
        selector: '.stale',
        target: { primary: { how: 'testid', value: 'buy-button' } },
      }),
      probe,
    )
    expect(result.status).toBe('RESOLVED_FALLBACK')
    expect(result.usedFallback).toBe(true)
    expect(result.selector).toContain('data-testid')
    expect(result.notes.some((n) => n.includes('fallback'))).toBe(true)
  })

  it('records the fallback in trace notes explicitly', async () => {
    const probe: LocatorProbe = (selector) => (selector === '.stale' ? 0 : 1)
    const result = await resolveWorkflowTarget(
      elementNode({
        selector: '.stale',
        target: { primary: { how: 'css', value: '[data-qa="buy"]' } },
      }),
      probe,
    )
    expect(result.notes.join('\n')).toContain('→')
  })

  it('is unresolved when every candidate matches zero elements', async () => {
    const probe: LocatorProbe = () => 0
    const result = await resolveWorkflowTarget(elementNode({ selector: '.gone' }), probe)
    expect(result.status).toBe('UNRESOLVED')
  })

  it('is unresolved when the selector matches multiple elements', async () => {
    const probe: LocatorProbe = () => 3
    const result = await resolveWorkflowTarget(elementNode({ selector: '.many' }), probe)
    expect(result.status).toBe('UNRESOLVED')
    expect(result.matchCount).toBe(3)
  })

  it('rejects a positional-only locator without semantic identity', async () => {
    const probe: LocatorProbe = () => 1
    const result = await resolveWorkflowTarget(
      elementNode({ selector: 'div:nth-child(3) > span:nth-child(1)' }),
      probe,
    )
    expect(result.status).toBe('REJECTED_POSITIONAL')
    expect(result.selector).toBe('')
  })

  it('accepts a positional path when a stable semantic identity exists', async () => {
    const probe: LocatorProbe = (selector) =>
      selector === 'div:nth-child(3) > span:nth-child(1)' ? 1 : 0
    const result = await resolveWorkflowTarget(
      elementNode({
        selector: 'div:nth-child(3) > span:nth-child(1)',
        target: { primary: { how: 'testid', value: 'x' } },
      }),
      probe,
    )
    expect(result.status).not.toBe('REJECTED_POSITIONAL')
  })

  it('emits a reliability locator patch on resolution', async () => {
    const probe: LocatorProbe = (selector) => (selector === '.buy' ? 1 : 0)
    const result = await resolveWorkflowTarget(elementNode({ selector: '.buy' }), probe)
    // No semantic + verified selector is enough to yield a patch.
    expect(result.reliabilityLocator).toBeDefined()
  })

  it('tolerates a throwing probe as an unresolved count', async () => {
    const probe: LocatorProbe = () => {
      throw new Error('no page')
    }
    const result = await resolveWorkflowTarget(elementNode({ selector: '.buy' }), probe)
    expect(result.status).toBe('UNRESOLVED')
  })
})
