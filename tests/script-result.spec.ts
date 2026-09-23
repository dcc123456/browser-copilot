import { describe, expect, it } from 'vitest'
import { interpretScriptResult } from '../src/lib/workflow/script-result'

describe('interpretScriptResult', () => {
  it('treats { success:false, message } as a failure with the message', () => {
    const verdict = interpretScriptResult({
      success: false,
      message: '未找到上传图文元素',
    })
    expect(verdict).toEqual({ ok: false, reason: '未找到上传图文元素' })
  })

  it('treats { ok:false } as a failure', () => {
    expect(interpretScriptResult({ ok: false })).toEqual({
      ok: false,
      reason: 'script reported failure',
    })
  })

  it('uses the error field when message is absent', () => {
    expect(interpretScriptResult({ success: false, error: 'boom' })).toEqual({
      ok: false,
      reason: 'boom',
    })
  })

  it('treats a non-empty error field without a positive marker as failure', () => {
    expect(interpretScriptResult({ error: 'something broke' })).toEqual({
      ok: false,
      reason: 'something broke',
    })
  })

  it('treats { success:true } as success', () => {
    expect(interpretScriptResult({ success: true })).toEqual({ ok: true })
  })

  it('does not treat the bare boolean false as failure', () => {
    expect(interpretScriptResult(false)).toEqual({ ok: true })
  })

  it('treats plain values as success', () => {
    expect(interpretScriptResult(undefined)).toEqual({ ok: true })
    expect(interpretScriptResult('done')).toEqual({ ok: true })
    expect(interpretScriptResult(0)).toEqual({ ok: true })
    expect(interpretScriptResult(null)).toEqual({ ok: true })
  })

  it('does not treat arrays as envelopes', () => {
    expect(interpretScriptResult([{ success: false }])).toEqual({ ok: true })
  })

  it('serializes an object error field', () => {
    const verdict = interpretScriptResult({ error: { code: 42 } })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('42')
  })
})
