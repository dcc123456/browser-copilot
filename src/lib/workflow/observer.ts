/**
 * Observer — read-only preflight before an AI takeover (M3-17 / proposal 7).
 *
 * A takeover ("AI 接管") is an expensive multi-round agent run. Before spending
 * that, a cheap read-only check can recognise a captcha / login wall / popup
 * from the failing context (the node error, and any live page summary the
 * caller passes). On a captcha/login wall — which the agent can NEVER solve —
 * we skip the run entirely and fail fast with a clear reason, exactly like the
 * hopeless-reason fast-fail but one agent episode earlier.
 *
 * Everything here is PURE and OPT-IN (gated by `BC_OBSERVER_PREFLIGHT`, default
 * OFF) so existing behaviour is unchanged unless an operator turns it on. The
 * extension and the server both call into this shared module.
 *
 * @module lib/workflow/observer
 */
import { classifyReason, type TakeoverReasonKind } from './ai-takeover'

/** Structured finding of the read-only preflight. */
export interface ObserverHints {
  /** Detected reason kind when one is recognisable (usually hopeless). */
  kind?: TakeoverReasonKind
  /** A captcha/login wall the agent can never solve — skip the takeover. */
  hopeless: boolean
  /** Human-readable Chinese finding. */
  message: string
  /** Suggested next action for the user / agent. */
  suggestedAction?: string
}

const SUGGESTED: Record<TakeoverReasonKind, string> = {
  auth: '请先人工登录后再运行，AI 接管无法越过登录墙',
  captcha: '请先人工通过验证码，AI 接管无法自动完成验证码',
  notfound: '检查定位选择器是否已变化',
  timeout: '检查页面是否加载过慢或网络是否稳定',
  network: '检查网络连接后重试',
  other: '查看上方页面状态后再决定',
}

/** Popups / overlays the agent should dismiss before retrying. */
const POPUP_NEEDLES =
  /(弹窗|对话框|modal|dialog|overlay|遮罩|广告弹窗|cookie 提示|订阅弹窗|登录弹窗)/i

/** Whether the read-only Observer preflight is enabled. Default OFF. */
export function observerPreflightEnabled(): boolean {
  return typeof process !== 'undefined' && !!process.env?.BC_OBSERVER_PREFLIGHT
}

/**
 * Inspect the failing context and report any captcha / login wall / popup the
 * agent should not waste a run on. Pure: callers only invoke it when
 * {@link observerPreflightEnabled}.
 *
 * @param input.pageSummary live DOM/ARIA summary when available (else undefined)
 * @param input.error the failing node's error text
 */
export function detectPreflightHints(input: {
  pageSummary?: string
  error?: string
}): ObserverHints {
  const text = `${input.pageSummary ?? ''}\n${input.error ?? ''}`.toLowerCase()
  const kind = classifyReason(text)
  if (kind === 'auth' || kind === 'captcha') {
    return {
      kind,
      hopeless: true,
      message: `预检发现${kind === 'captcha' ? '验证码' : '登录墙'}，AI 接管无法自动越过`,
      suggestedAction: SUGGESTED[kind],
    }
  }
  if (POPUP_NEEDLES.test(text)) {
    return {
      kind: 'other',
      hopeless: false,
      message: '预检发现弹窗/遮罩，建议先关闭再接管',
      suggestedAction: SUGGESTED.other,
    }
  }
  if (kind === 'timeout' || kind === 'network' || kind === 'notfound') {
    return { kind, hopeless: false, message: `预检线索：${kind}`, suggestedAction: SUGGESTED[kind] }
  }
  return { hopeless: false, message: '预检未发现明显阻断（验证码/登录墙/弹窗）' }
}
