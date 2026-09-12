/**
 * Unit tests for the pure takeover helpers the server takeover hook reuses
 * (mirrors the extension's `tests/ai-takeover.spec.ts` but compiled against the
 * server's vitest config). Covers the closed-loop patch mechanic (M1-10b),
 * repeated-failure fast-fail breadth (M2-11) and the page-summary prompt slot
 * (M2-15).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTakeoverPrompt,
  failureSignature,
  isRepeatedHopelessFailure,
  takeoverMaxAttempts,
  takeoverToolRounds,
} from '../../src/lib/workflow/ai-takeover'
import { patchNodeParams } from '../../src/lib/workflow/auto-debug-patch'
import type { Workflow } from '../../src/lib/workflow/types'

function workflowWith(selector: string): Workflow {
  return {
    id: 'wf1',
    name: 'wf',
    drawflow: {
      nodes: [
        {
          id: 'click',
          label: 'click',
          data: { selector },
        } as never,
      ],
      edges: [],
    },
  } as unknown as Workflow
}

describe('patchNodeParams (M1-10b closed-loop mechanic)', () => {
  it('applies a corrected selector and reports the change', () => {
    const wf = workflowWith('#old')
    const r = patchNodeParams(wf, 'click', { selector: '#real' })
    expect(r.changed).toBe(true)
    expect((r.workflow.drawflow.nodes[0].data as { selector: string }).selector).toBe('#real')
    // never mutates the input graph
    expect((wf.drawflow.nodes[0].data as { selector: string }).selector).toBe('#old')
    expect(r.changes[0]).toContain('#real')
  })

  it('refuses to re-type or disable a node', () => {
    const wf = workflowWith('#old')
    const r = patchNodeParams(wf, 'click', { blockId: 'other', disableBlock: true })
    expect(r.changed).toBe(false)
  })

  it('no-ops on a missing node or empty patch', () => {
    const wf = workflowWith('#old')
    expect(patchNodeParams(wf, 'nope', { selector: '#x' }).changed).toBe(false)
    expect(patchNodeParams(wf, 'click', {}).changed).toBe(false)
  })
})

describe('repeated-failure fast-fail breadth (M2-11)', () => {
  it('produces a stable signature regardless of whitespace', () => {
    expect(failureSignature('n', '  Timeout   waiting  ')).toBe(
      failureSignature('n', 'timeout waiting'),
    )
  })
  it('declares hopeless only after three identical in a row', () => {
    expect(isRepeatedHopelessFailure(['n::x', 'n::x', 'n::x'])).toBe(true)
    expect(isRepeatedHopelessFailure(['n::x', 'n::x', 'n::y', 'n::x'])).toBe(false)
  })
})

describe('configurable budgets (M3-18) under server env', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })
  it('reads BC_TAKEOVER_MAX_ATTEMPTS / BC_TAKEOVER_TOOL_ROUNDS', () => {
    process.env.BC_TAKEOVER_MAX_ATTEMPTS = '4'
    process.env.BC_TAKEOVER_TOOL_ROUNDS = '9'
    expect(takeoverMaxAttempts()).toBe(4)
    expect(takeoverToolRounds()).toBe(9)
  })
})

describe('takeover prompt page-summary (M2-15)', () => {
  it('includes the live DOM/ARIA summary when present', () => {
    const prompt = buildTakeoverPrompt({
      steps: [],
      failing: { blockId: 'click', params: {} },
      error: 'e',
      attempt: 1,
      maxAttempts: 3,
      pageSummary: '按钮: [提交]',
    })
    expect(prompt).toContain('Current page DOM/ARIA summary')
    expect(prompt).toContain('按钮: [提交]')
  })
})
