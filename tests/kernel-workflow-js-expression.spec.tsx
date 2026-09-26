// @vitest-environment jsdom
/**
 * In-page workflow JS harness — parity with the agent's `run_javascript`.
 *
 * `wf_op_javascript-code` must accept a BARE EXPRESSION (`document.title`,
 * `1 + 2`, `await f()`) and auto-return its value without requiring `return`,
 * while still supporting a statement body that ends with `return` or
 * `automaNextBlock(...)`. This is the "supports run_javascript features"
 * contract once workflow generation routes every script through the operator.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflowJs } from '../src/inpage/kernel'

describe('runWorkflowJs bare-expression auto-return', () => {
  it('auto-returns a bare arithmetic expression', async () => {
    const result = await runWorkflowJs({ code: '6 * 7', timeout: 5000 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBe(42)
  })

  it('auto-returns a bare DOM expression', async () => {
    const result = await runWorkflowJs({
      code: 'document.title || location.href',
      timeout: 5000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(typeof result.data).toBe('string')
  })

  it('auto-returns an awaited promise expression', async () => {
    const result = await runWorkflowJs({
      code: 'await Promise.resolve(21).then((n) => n * 2)',
      timeout: 5000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBe(42)
  })

  it('still supports a statement body with an explicit return', async () => {
    const result = await runWorkflowJs({ code: 'const x = 40; return x + 2', timeout: 5000 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBe(42)
  })

  it('still supports a body ending in automaNextBlock', async () => {
    const result = await runWorkflowJs({
      code: "automaSetVariable('n', 42); automaNextBlock('done')",
      timeout: 5000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBe('done')
      expect(result.variables).toMatchObject({ n: 42 })
    }
  })

  it('falls back to a body for an expression wrap that does not compile', async () => {
    // An object literal `{...}` as the whole source is parsed as a block
    // (labelled statement), not an object expression. It must not throw at
    // compile time; the plain body runs and yields undefined.
    const result = await runWorkflowJs({ code: '{ a: 1 }', timeout: 5000 })
    expect(result.ok).toBe(true)
  })
})
