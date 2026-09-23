// @vitest-environment jsdom
/**
 * In-page workflow JS harness: a returned failure envelope must settle the
 * harness as a failure, mirroring the worker-side rule. Regression for a script
 * that walks the DOM, finds nothing, and returns
 * `{ success:false, message:'未找到上传图文元素' }` yet the block reported ok.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflowJs } from '../src/inpage/kernel'

describe('runWorkflowJs failure envelope', () => {
  it('reports ok:false when the code returns success:false', async () => {
    const result = await runWorkflowJs({
      code: "return { success: false, message: '未找到上传图文元素' }",
      timeout: 5000,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('未找到上传图文元素')
  })

  it('reports ok:false for ok:false', async () => {
    const result = await runWorkflowJs({ code: 'return { ok: false }', timeout: 5000 })
    expect(result.ok).toBe(false)
  })

  it('reports ok:true for success:true', async () => {
    const result = await runWorkflowJs({
      code: 'return { success: true }',
      timeout: 5000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ success: true })
  })

  it('still treats a thrown error as a failure', async () => {
    const result = await runWorkflowJs({
      code: "throw new Error('nope')",
      timeout: 5000,
    })
    expect(result.ok).toBe(false)
  })

  it('does not treat a bare false return as a failure', async () => {
    const result = await runWorkflowJs({ code: 'return false', timeout: 5000 })
    expect(result.ok).toBe(true)
  })

  it('honours an envelope passed through automaNextBlock', async () => {
    const result = await runWorkflowJs({
      code: "automaNextBlock({ success: false, message: 'x' })",
      timeout: 5000,
    })
    expect(result.ok).toBe(false)
  })
})
