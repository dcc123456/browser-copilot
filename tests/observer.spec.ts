import { describe, it, expect, afterEach } from 'vitest'
import { detectPreflightHints, observerPreflightEnabled } from '../src/lib/workflow/observer'

describe('detectPreflightHints (M3-17)', () => {
  it('flags a captcha as hopeless and names the suggested action', () => {
    const h = detectPreflightHints({ error: '点击提交后页面出现验证码 (captcha)，无法继续' })
    expect(h.hopeless).toBe(true)
    expect(h.kind).toBe('captcha')
    expect(h.suggestedAction).toContain('验证码')
  })

  it('flags a login wall as hopeless', () => {
    const h = detectPreflightHints({ error: '需要登录后才能访问该页面 (sign in required)' })
    expect(h.hopeless).toBe(true)
    expect(h.kind).toBe('auth')
  })

  it('surfaces a popup as a non-hopeless hint', () => {
    const h = detectPreflightHints({ pageSummary: '页面顶部有登录弹窗遮挡了按钮' })
    expect(h.hopeless).toBe(false)
    expect(h.kind).toBe('other')
    expect(h.message).toContain('弹窗')
  })

  it('reports no blockers for a neutral error', () => {
    const h = detectPreflightHints({ error: 'step returned an unexpected result' })
    expect(h.hopeless).toBe(false)
    expect(h.kind).toBeUndefined()
    expect(h.message).toContain('未发现明显阻断')
  })

  it('surfaces a notfound error as a non-hopeless locating hint', () => {
    const h = detectPreflightHints({ error: '元素未找到：#submit' })
    expect(h.hopeless).toBe(false)
    expect(h.kind).toBe('notfound')
    expect(h.suggestedAction).toContain('选择器')
  })

  it('reuses the same keyword engine as the takeover reason classifier', () => {
    const h = detectPreflightHints({ error: 'net::ERR_FAILED 网络请求失败' })
    expect(h.kind).toBe('network')
    expect(h.hopeless).toBe(false)
  })
})

describe('observerPreflightEnabled (M3-17)', () => {
  afterEach(() => {
    delete process.env.BC_OBSERVER_PREFLIGHT
  })

  it('is OFF by default', () => {
    expect(observerPreflightEnabled()).toBe(false)
  })

  it('turns ON with the env flag (opt-in enhancement)', () => {
    process.env.BC_OBSERVER_PREFLIGHT = '1'
    expect(observerPreflightEnabled()).toBe(true)
  })
})
