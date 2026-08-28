/**
 * Kernel user-JS evaluator (`runExecJs`) — the MAIN-world entry used by the
 * workflow JS block and the agent's `run_javascript` tool.
 *
 * In the extension it is injected via `chrome.scripting.executeScript({ world:
 * 'MAIN' })`; here we call it directly against a JSDOM global and assert the
 * contract: function bodies and bare expressions, named args, DOM access,
 * clone-safe results, and error reporting.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { JSDOM } from 'jsdom'
import { runExecJs } from '../src/inpage/kernel'

const dom = new JSDOM(
  `<!DOCTYPE html><body><div id="price">$19.99</div><input name="email" value="a@b.c" /></body>`,
  { url: 'https://example.test/' },
)

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.CustomEvent = dom.window.CustomEvent
  g.Node = dom.window.Node
  g.Element = dom.window.Element
})

function execJs(code: string, args?: Record<string, unknown>) {
  return runExecJs({ code, args, argNames: args ? Object.keys(args) : undefined })
}

describe('kernel runExecJs', () => {
  it('evaluates a function body with return', () => {
    const r = execJs('return 6 * 7')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toBe(42)
  })

  it('evaluates a bare expression', () => {
    const r1 = execJs('1 + 2')
    expect(r1.ok && r1.data).toBe(3)
    const r2 = execJs('document.title || location.href')
    expect(r2.ok && r2.data).toBe('https://example.test/')
  })

  it('passes named args through', () => {
    const r = execJs('return vars.count + 1', { vars: { count: 10 } })
    expect(r.ok && r.data).toBe(11)
  })

  it('can read the DOM and map arrays via args', () => {
    const read = execJs('return document.querySelector("#price")?.textContent')
    expect(read.ok && read.data).toBe('$19.99')
    const mapped = execJs('return rows.map((item) => item * 2)', { rows: [1, 2, 3] })
    expect(mapped.ok && mapped.data).toEqual([2, 4, 6])
  })

  it('returns objects/arrays as clone-safe JSON', () => {
    const r = execJs('return { a: 1, b: [true, null, "x"] }')
    expect(r.ok && r.data).toEqual({ a: 1, b: [true, null, 'x'] })
  })

  it('returns a non-ok result with a message on syntax/runtime error', () => {
    const r = execJs('throw new Error("boom")')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('boom')
  })

  it('handles code with no return value', () => {
    const r = execJs('const x = 1; void x')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toBeUndefined()
  })
})
