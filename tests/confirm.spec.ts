/**
 * Confidence-boundary tests for the semi-auto approval card.
 *
 * Semi-auto used to ask before EVERY page action and every read, which made the
 * user click through harmless steps. dcc's ruling (2026-11-01): reading pages
 * and scrolling never ask; only consequences that are hard to take back do —
 * payments, credentials, deletions, sending/publishing, scripts, and persistent
 * side effects — plus any element action whose target cannot be identified.
 *
 * These tests pin both directions, because the failure modes are opposite: too
 * strict and the mode is noise, too loose and a one-click purchase goes out
 * without the user seeing it.
 */
import { describe, expect, it } from 'vitest'
import { modeAutoApproves } from '../src/background/agent'
import { assessActionRisk, type RiskTargetInfo } from '../src/lib/action-risk'

const NEXT_BUTTON: RiskTargetInfo = {
  name: 'Next',
  target: { primary: { how: 'role', value: 'button', role: 'button' }, fallbacks: [] },
}

const PAY_BUTTON: RiskTargetInfo = {
  name: 'Pay now',
  target: { primary: { how: 'text', value: 'Pay now' }, fallbacks: [] },
}

const EMAIL_FIELD: RiskTargetInfo = {
  name: 'Email',
  type: 'email',
  target: { primary: { how: 'id', value: 'email' }, fallbacks: [] },
}

const resolveTo = (info: RiskTargetInfo | undefined) => (_args: Record<string, unknown>) => info

describe('semi-auto never interrupts for reads or observations', () => {
  it.each([
    'read_current_page',
    'snapshot_page',
    'read_selected_element',
    'list_tabs',
    'screenshot',
    'recognize_image',
  ])('%s runs without a card', (name) => {
    expect(modeAutoApproves('semi', name)).toBe(true)
    expect(assessActionRisk(name, {}).risky).toBe(false)
  })

  it('harmless page actions are classified as low risk', () => {
    // Scroll/wait/navigation/tab bookkeeping have no argument-dependent risk.
    for (const name of ['scroll', 'wait_for', 'open_url', 'tab_switch', 'pin_tab']) {
      expect(assessActionRisk(name, {}).risky).toBe(false)
    }
  })
})

describe('risk classes that do ask', () => {
  it('a payment button is a payment risk', () => {
    expect(assessActionRisk('click', {}, resolveTo(PAY_BUTTON))).toEqual({
      risky: true,
      reason: 'payment',
    })
  })

  it('a Chinese payment button is a payment risk', () => {
    const info: RiskTargetInfo = { name: '立即支付' }
    expect(assessActionRisk('click', {}, resolveTo(info)).reason).toBe('payment')
  })

  it('a password field is a credentials risk, even without a password label', () => {
    const info: RiskTargetInfo = { name: 'Enter your secret', type: 'password' }
    expect(assessActionRisk('fill', {}, resolveTo(info))).toEqual({
      risky: true,
      reason: 'credentials',
    })
  })

  it('a verification-code field is a credentials risk', () => {
    const info: RiskTargetInfo = { name: 'Verification code' }
    expect(assessActionRisk('fill', {}, resolveTo(info)).reason).toBe('credentials')
  })

  it('filling a saved credential asks, because get_secret types it into the page', () => {
    expect(assessActionRisk('get_secret', { id: 'b1' })).toEqual({
      risky: true,
      reason: 'credentials',
    })
  })

  it('destructive and sending actions ask', () => {
    expect(assessActionRisk('click', {}, resolveTo({ name: 'Delete account' })).reason).toBe(
      'destructive',
    )
    expect(assessActionRisk('click', {}, resolveTo({ name: '发送' })).reason).toBe('sending')
    expect(assessActionRisk('click', {}, resolveTo({ name: 'Publish post' })).reason).toBe(
      'sending',
    )
  })

  it('scripts and persistent side effects always ask', () => {
    expect(assessActionRisk('run_javascript', { code: '1' }).reason).toBe('script')
    expect(assessActionRisk('create_skill', {}).reason).toBe('persistent')
    expect(assessActionRisk('create_scheduled_task', {}).reason).toBe('persistent')
  })

  it('Enter asks, because it submits whatever form has focus', () => {
    expect(assessActionRisk('press_key', { key: 'Enter' }).reason).toBe('sending')
    expect(assessActionRisk('press_key', { key: 'NumpadEnter' }).risky).toBe(true)
    expect(assessActionRisk('press_key', { key: 'Tab' }).risky).toBe(false)
  })
})

describe('safe element actions run through', () => {
  it('a named, harmless button does not ask', () => {
    expect(assessActionRisk('click', {}, resolveTo(NEXT_BUTTON))).toEqual({ risky: false })
  })

  it('a named email field does not ask', () => {
    expect(assessActionRisk('fill', {}, resolveTo(EMAIL_FIELD))).toEqual({ risky: false })
  })

  it('a CSS-only locator that names a risk still asks', () => {
    const info: RiskTargetInfo = {
      target: { primary: { how: 'css', value: '#pay-now' }, fallbacks: [] },
    }
    expect(assessActionRisk('click', {}, resolveTo(info)).reason).toBe('payment')
  })
})

describe('unknown targets ask (dcc, 2026-11-01)', () => {
  it('an icon button with no name or semantic locator asks', () => {
    expect(assessActionRisk('click', {}, resolveTo({ name: '' }))).toEqual({
      risky: true,
      reason: 'unknown-target',
    })
  })

  it('a bare CSS class is not proof of identity', () => {
    const info: RiskTargetInfo = {
      target: { primary: { how: 'css', value: '.icon-btn' }, fallbacks: [] },
    }
    expect(assessActionRisk('click', {}, resolveTo(info)).reason).toBe('unknown-target')
  })

  it('no resolver at all means every element action asks', () => {
    expect(assessActionRisk('click', {}).reason).toBe('unknown-target')
    expect(assessActionRisk('select_option', {}).reason).toBe('unknown-target')
  })
})

describe('run_plan inherits the risk of its steps', () => {
  const benignPlan = { steps: [{ tool: 'scroll', args: { mode: 'by', y: 300 } }] }
  const riskyPlan = {
    steps: [
      { tool: 'scroll', args: { mode: 'by', y: 300 } },
      { tool: 'click', args: {} },
    ],
  }

  it('a benign plan runs without a card', () => {
    expect(assessActionRisk('run_plan', benignPlan, resolveTo(NEXT_BUTTON)).risky).toBe(false)
  })

  it('one risky step makes the whole plan ask once', () => {
    expect(assessActionRisk('run_plan', riskyPlan, resolveTo(PAY_BUTTON))).toEqual({
      risky: true,
      reason: 'payment',
    })
  })
})
