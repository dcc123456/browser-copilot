/**
 * Risk classification for the semi-auto approval card.
 *
 * Semi-auto is not "ask for everything": the user is present and only wants a
 * stop before consequences that are hard to take back — spending money, typing
 * credentials, destroying data, sending or publishing, running arbitrary code
 * or arming persistent side effects. Everything else (reads, scrolling,
 * navigation, tab bookkeeping) runs without interrupting.
 *
 * The classifier works from what the confirmation gate already has: the tool
 * name, its arguments, and the latest snapshot entry for the element (ref →
 * accessible name + input type). It is pure so the policy is testable without
 * a browser, and conservative in one direction only: an element action whose
 * target carries no usable signal is treated as risky (dcc, 2026-11-01).
 *
 * @module lib/action-risk
 */
import type { Target } from './ops'

export type ActionRiskReason =
  /** A side effect that outlives the page: saved skills, armed schedules. */
  | 'persistent'
  /** Arbitrary page script. */
  | 'script'
  | 'payment'
  | 'credentials'
  | 'destructive'
  | 'sending'
  /** An element action whose target cannot be identified. */
  | 'unknown-target'

export interface ActionRisk {
  risky: boolean
  reason?: ActionRiskReason
}

/** What the snapshot knows about the element an action targets. */
export interface RiskTargetInfo {
  /** Accessible name from the snapshot (`Pay now`, `Password`). */
  name?: string
  /** Input type for form controls (`password`, `email`, …). */
  type?: string
  /** Durable locator, which also carries a human-readable label. */
  target?: Target
}

export type RiskTargetResolver = (args: Record<string, unknown>) => RiskTargetInfo | undefined

/**
 * Element actions: the ones where what the element IS decides the risk. Other
 * actions are judged by name alone.
 */
const ELEMENT_ACTIONS = new Set(['click', 'fill', 'select_option', 'set_checkbox'])

/** Money leaving the user's hands, or a purchase being committed. */
const PAYMENT =
  /\b(pay|payment|checkout|purchase|buy now|place order|order now|subscribe|renew|donate|donation|transfer|withdraw|recharge|top[ -]?up|add funds|send money|confirm payment|finalize payment)\b|付款|支付|购买|下单|提交订单|确认订单|去结算|结算|转账|汇款|提现|充值|打赏|捐赠|订阅|续费|立即购买|立即支付/i

/** Irreversible removal of data or state. */
const DESTRUCTIVE =
  /\b(delete|remove|erase|clear all|reset|uninstall|deactivate|close account|cancel order|unsubscribe|discard)\b|删除|移除|清空|重置|注销|退订|取消订单|关闭账户|解除绑定|解绑|销毁/i

/** Publishing or messaging: the content is out of the user's hands. */
const SENDING = /\b(send|publish|post|share|comment|reply)\b|发送|发布|发表|分享|评论|回复|转发/i

/** Credential-shaped fields and secrets typed into the page. */
const CREDENTIALS =
  /\b(password|passwd|passcode|pin|cvv|cvc|card number|credit card|debit card|security code|verification code|one[- ]?time code|otp|2fa|authenticator|api key|secret key)\b|密码|口令|支付密码|验证码|校验码|动态码|安全码|银行卡|信用卡|卡号|身份证/i

/** Input types that hold a credential no matter what the label says. */
const CREDENTIAL_TYPES = new Set(['password'])

/** Persisted beyond the page, so a slip is not undone by closing a tab. */
const PERSISTENT_TOOLS = new Set(['create_skill', 'create_scheduled_task'])

/** Keys that submit whatever form has focus, i.e. can commit the action. */
const SUBMITTING_KEYS = new Set(['enter', 'numpadenter'])

/**
 * Target specs whose value is a human-readable label. A bare CSS class is not
 * proof of identity, so CSS values only ever contribute keyword evidence.
 */
const SEMANTIC_SPECS = new Set(['role', 'text', 'id', 'name', 'testid', 'cdp-shadow'])

function allSpecValues(target: Target | undefined): { semantic: string[]; css: string[] } {
  const semantic: string[] = []
  const css: string[] = []
  if (!target) return { semantic, css }
  if (target.label) semantic.push(target.label)
  for (const spec of [target.primary, ...(target.fallbacks ?? [])]) {
    if (!spec) continue
    if (spec.how === 'css') css.push(spec.value)
    else if (SEMANTIC_SPECS.has(spec.how)) semantic.push(spec.value)
  }
  return { semantic, css }
}

/**
 * Everything we know about the target, split into strong signals (an
 * accessible name, a role/text/id/name/testid locator, an input type) and weak
 * ones (a CSS selector). Weak text can still prove risk — `#pay-now` is a
 * payment button — but cannot prove safety.
 */
function readTarget(info: RiskTargetInfo | undefined): {
  text: string
  hasStrongSignal: boolean
} {
  if (!info) return { text: '', hasStrongSignal: false }
  const { semantic, css } = allSpecValues(info.target)
  if (info.name) semantic.push(info.name)
  const text = [...semantic, ...css].join(' ').toLowerCase()
  const hasStrongSignal =
    semantic.some((value) => value.trim().length > 0) || (info.type ?? '').trim().length > 0
  return { text, hasStrongSignal }
}

function keywordReason(text: string): ActionRiskReason | undefined {
  if (!text) return undefined
  if (PAYMENT.test(text)) return 'payment'
  if (DESTRUCTIVE.test(text)) return 'destructive'
  if (SENDING.test(text)) return 'sending'
  return undefined
}

function assessElementAction(
  args: Record<string, unknown>,
  resolve: RiskTargetResolver | undefined,
): ActionRisk {
  const info = resolve?.(args)
  // Filling a saved credential types it into the page; the tool is `get_secret`
  // but the effect is the password entry the user wants stopped.
  const targetText = readTarget(info)
  const credentialField =
    CREDENTIAL_TYPES.has((info?.type ?? '').toLowerCase()) || CREDENTIALS.test(targetText.text)
  if (credentialField) return { risky: true, reason: 'credentials' }
  const keyword = keywordReason(targetText.text)
  if (keyword) return { risky: true, reason: keyword }
  // A named element that matched no risk keyword is known-safe. An element with
  // no usable identity could be anything, so it asks (dcc's ruling).
  if (!targetText.hasStrongSignal) return { risky: true, reason: 'unknown-target' }
  return { risky: false }
}

/**
 * Decides whether a tool call needs the semi-auto confirmation card.
 *
 * @param name      Tool name, as dispatched.
 * @param args      Parsed arguments of the call.
 * @param resolve   Looks up the snapshot entry for a step's target. Required
 *                  for element actions to be judged as safe; without it every
 *                  element action is `unknown-target`.
 */
export function assessActionRisk(
  name: string,
  args: Record<string, unknown>,
  resolve?: RiskTargetResolver,
): ActionRisk {
  if (name === 'run_javascript') return { risky: true, reason: 'script' }
  if (PERSISTENT_TOOLS.has(name)) return { risky: true, reason: 'persistent' }
  if (name === 'get_secret') return { risky: true, reason: 'credentials' }
  if (name === 'press_key') {
    const key = typeof args['key'] === 'string' ? args['key'].toLowerCase() : ''
    return SUBMITTING_KEYS.has(key) ? { risky: true, reason: 'sending' } : { risky: false }
  }
  if (name === 'run_plan') {
    const steps = Array.isArray(args['steps']) ? args['steps'] : []
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue
      const record = step as { tool?: unknown; args?: unknown }
      const stepName = String(record.tool ?? '')
      const stepArgs =
        record.args && typeof record.args === 'object'
          ? (record.args as Record<string, unknown>)
          : {}
      const verdict = assessActionRisk(stepName, stepArgs, resolve)
      if (verdict.risky) return verdict
    }
    return { risky: false }
  }
  if (ELEMENT_ACTIONS.has(name)) return assessElementAction(args, resolve)
  // Reads, observations, scrolling, waits, navigation, tab bookkeeping,
  // local saves and delegation are either harmless or gated by their own
  // child calls.
  return { risky: false }
}
