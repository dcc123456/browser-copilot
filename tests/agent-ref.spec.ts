import { describe, expect, it } from 'vitest'
import { executeTool, hydrateRecordArgs } from '../src/background/agent'

/**
 * The devtools-mcp uid pattern: act tools accept a short `ref` from the latest
 * snapshot and the agent resolves it against the ref→target cache held in the
 * ToolContext. These tests cover the validation paths that must fail BEFORE
 * the browser is touched.
 */
describe('ref-based element resolution', () => {
  const baseCtx = {
    conversationId: 'test',
    navigated: false,
    disabled: new Set<string>(),
  }

  it('rejects an unknown ref without touching the browser', async () => {
    const output = await executeTool('click', { ref: 'e99' }, baseCtx)
    const parsed = JSON.parse(output) as { error?: string }
    expect(parsed.error).toContain('Unknown ref "e99"')
    expect(parsed.error).toContain('fresh snapshot')
  })

  it('rejects a call with neither ref nor target', async () => {
    const output = await executeTool('click', {}, baseCtx)
    const parsed = JSON.parse(output) as { error?: string }
    expect(parsed.error).toContain('`ref`')
  })

  it('error names the tool-agnostic fix (snapshot first)', async () => {
    const output = await executeTool('fill', { ref: 'e1', value: 'x' }, baseCtx)
    const parsed = JSON.parse(output) as { error?: string }
    expect(parsed.error).toContain('Unknown ref')
  })
})

describe('recorded args hydration', () => {
  const snapshotTarget = {
    primary: { how: 'id' as const, value: 'vCode-new' },
    fallbacks: [],
  }
  const ctx = {
    snapshotTargets: new Map([['e12', { target: snapshotTarget, name: '验证码' }]]),
  } as unknown as Parameters<typeof hydrateRecordArgs>[0]

  it('records the snapshot target even when the model inlined its own', () => {
    const recorded = hydrateRecordArgs(ctx, {
      ref: 'e12',
      // Model guess: ARIA role name stuffed into `value` — never executed
      // (resolveTargetFrom prefers the ref). It must not reach the history.
      target: { primary: { how: 'role', value: 'textbox' }, fallbacks: [] },
      value: 'AB12',
    })
    expect(recorded.target).toBe(snapshotTarget)
  })

  it('hydrates a ref-only call with the resolved target', () => {
    const recorded = hydrateRecordArgs(ctx, { ref: 'e12', value: 'AB12' })
    expect(recorded.target).toBe(snapshotTarget)
  })

  it('leaves a target-only call (remote clients, no snapshot) untouched', () => {
    const inline = { primary: { how: 'css', value: '#x' }, fallbacks: [] }
    const recorded = hydrateRecordArgs(ctx, { target: inline, value: 'AB12' })
    expect(recorded.target).toBe(inline)
  })
})
