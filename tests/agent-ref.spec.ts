import { describe, expect, it } from 'vitest'
import { executeTool } from '../src/background/agent'

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
