import { describe, expect, it } from 'vitest'
import { executeTool } from '../src/background/agent'

/**
 * run_plan validation paths that run without a chrome environment. The plan
 * runner validates the whole request (shape, step count, tool names, disabled
 * tools) BEFORE it touches the browser, so these tests exercise the guard
 * clauses that must never let a malformed plan reach a page.
 */
describe('run_plan', () => {
  const baseCtx = {
    conversationId: 'test',
    navigated: false,
    disabled: new Set<string>(),
  }

  it('rejects an empty steps array', async () => {
    const output = await executeTool('run_plan', { steps: [] }, baseCtx)
    const parsed = JSON.parse(output) as { error?: string }
    expect(parsed.error).toContain('non-empty')
  })

  it('rejects plans longer than 16 steps', async () => {
    const steps = Array.from({ length: 17 }, () => ({ tool: 'wait_for' }))
    const output = await executeTool('run_plan', { steps }, baseCtx)
    const parsed = JSON.parse(output) as { error?: string }
    expect(parsed.error).toContain('at most 16')
  })

  it('stops on an unknown tool before executing anything', async () => {
    const output = await executeTool(
      'run_plan',
      { steps: [{ tool: 'not_a_tool' }, { tool: 'click' }] },
      baseCtx,
    )
    const parsed = JSON.parse(output) as {
      ok: boolean
      stoppedAt: number
      outcomes: { ok: boolean; error?: string }[]
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.stoppedAt).toBe(1)
    expect(parsed.outcomes[0]?.error).toContain('unknown tool')
  })

  it('refuses steps calling run_plan itself (no nesting)', async () => {
    const output = await executeTool(
      'run_plan',
      { steps: [{ tool: 'run_plan', args: { steps: [] } }] },
      baseCtx,
    )
    const parsed = JSON.parse(output) as { ok: boolean; outcomes: { error?: string }[] }
    expect(parsed.ok).toBe(false)
    expect(parsed.outcomes[0]?.error).toContain('unknown tool')
  })

  it('refuses steps for tools the user disabled', async () => {
    const ctx = { ...baseCtx, disabled: new Set(['click']) }
    const output = await executeTool('run_plan', { steps: [{ tool: 'click' }] }, ctx)
    const parsed = JSON.parse(output) as { ok: boolean; outcomes: { error?: string }[] }
    expect(parsed.ok).toBe(false)
    expect(parsed.outcomes[0]?.error).toContain('disabled')
  })
})
