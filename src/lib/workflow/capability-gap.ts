/**
 * Capability-gap gate — the ONLY sanctioned path to raw JavaScript.
 *
 * Native-first policy: when a native operator exists for an intent, a JS call
 * is rejected and the caller is pointed at the native capability. JS is
 * permitted solely for a documented capability gap — and even then the node
 * must carry a goal, success criteria and verification, so "JS ran OK" is
 * never treated as task success.
 *
 * Two intents are already documented by this module itself ({@link
 * SANCTIONED_JS_GAPS}): an intent whose point is an artifact no declarative
 * operator produces passes without an argument, because asking the model to
 * re-derive a standing policy each time only produced refused calls.
 *
 * This module owns the UNIFIED JS gate: a call carrying a valid documented
 * `gap` (or an equivalent `justification`) passes regardless of which of the
 * two argument shapes the model used, so the two cannot disagree. Earlier
 * builds applied the `justification` gate and this gate on different layers,
 * which is how a valid capability-gap call kept being refused.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/capability-gap
 */

import { generationOperators } from './operator-registry'
import { scriptJustification } from './operator-tools'

/**
 * Intents that always have a native operator, mapped to capability keywords.
 *
 * The English alternatives are word-bounded on purpose: these patterns run over
 * a free-text step description, and an unanchored `if` refused "verify the
 * generated image" as a *condition* intent.
 */
const NATIVE_INTENT_MAP: ReadonlyArray<{
  test: RegExp
  nativeBlockIds: string[]
  label: string
}> = [
  { test: /(点击|\bclick\b|\btap\b)/i, nativeBlockIds: ['event-click'], label: 'click' },
  { test: /(填写|输入|\btype\b|\bfill\b|\benter\b)/i, nativeBlockIds: ['forms'], label: 'fill' },
  { test: /(读取文本|\bread text\b|\bget text\b)/i, nativeBlockIds: ['get-text'], label: 'read text' },
  {
    test: /(读取属性|\battribute\b|\battributes\b)/i,
    nativeBlockIds: ['attribute-value'],
    label: 'read attribute',
  },
  {
    test: /(元素存在|判断.*存在|\belement exists\b|\bexists\b)/i,
    nativeBlockIds: ['element-exists'],
    label: 'element exists',
  },
  { test: /(等待|\bwait\b)/i, nativeBlockIds: ['wait-connections', 'delay'], label: 'wait' },
  { test: /(条件|\bcondition\b|\bif\b)/i, nativeBlockIds: ['conditions'], label: 'condition' },
  { test: /(循环|遍历|\bloop\b|\bfor each\b)/i, nativeBlockIds: ['loop-elements', 'loop-data'], label: 'loop' },
]

/** Decision returned by the gate. */
export type CapabilityGapDecision =
  | { allowed: false; reason: string; nativeBlockIds: string[]; intentLabel: string }
  | {
      allowed: true
      capabilityGap: CapabilityGapRecord
    }

/** The documented gap required to allow JS. */
export interface CapabilityGapRecord {
  missingCapability: string
  triedOperators: string[]
  whyInsufficient: string
  expectedResult: string
}

/**
 * Capability gaps the POLICY has already documented.
 *
 * A sanctioned gap is an intent the declarative ladder cannot express AT ALL —
 * there is no rung that draws or exports an image artifact. Making the model
 * re-argue that fact on every call does not keep scripts out of the graph; it
 * burns a round, and a refused call usually comes back as a worse operator
 * choice. The gate decides once, here, and still writes the reason onto the
 * node, so the user reads why the code node exists.
 *
 * Deliberately narrow: an intent qualifies only when it BOTH produces
 * something AND names an image artifact, and never when a native operator
 * already covers it (a page or canvas capture is `take-screenshot`'s job;
 * captcha solving stays a human gate).
 */
interface SanctionedJsGap {
  id: string
  /** Terms meaning "make an artifact", not "act on the page". */
  production: RegExp
  /** The artifact no operator can produce. */
  artifact: RegExp
  /** Intents that look like production but have a native operator. */
  excluded: RegExp
  missingCapability: string
  whyInsufficient: string
  expectedResult: string
}

const SANCTIONED_JS_GAPS: readonly SanctionedJsGap[] = [
  {
    id: 'image-artifact',
    production:
      /(生成|绘制|渲染|合成|制作|导出|转成|draw|render|\bgenerat\w*\b|\bcreat\w*\b|\bproduce\b|toDataURL)/i,
    artifact:
      /(图片|图像|海报|图表|二维码|canvas|png|jpe?g|webp|bmp|data\s?url|\bimage\b|\bchart\b|qr ?code)/i,
    excluded: /(截图|屏幕快照|screenshot|验证码|captcha|mfa|人机验证)/i,
    missingCapability: 'produce an image artifact (canvas drawing / data URL)',
    whyInsufficient:
      'sanctioned capability gap: no declarative operator draws or exports an image (声明式算子阶梯里没有“产出图片”这一级)',
    expectedResult:
      'a data-URL / binary image artifact a later step consumes (e.g. wf_op_upload-file)',
  },
]

/**
 * The documented gap for an intent the policy already knows no operator can
 * serve, or undefined when the caller must document it itself.
 */
export function sanctionedJsGap(stepIntent: string): CapabilityGapRecord | undefined {
  const intent = stepIntent.trim()
  if (!intent) return undefined
  for (const gap of SANCTIONED_JS_GAPS) {
    // No /g flag on purpose: RegExp.test on a global regex is stateful.
    if (gap.excluded.test(intent)) continue
    if (gap.production.test(intent) && gap.artifact.test(intent)) {
      return {
        missingCapability: `${gap.missingCapability} [${gap.id}]`,
        triedOperators: ['declarative ladder: none produces an image artifact'],
        whyInsufficient: gap.whyInsufficient,
        expectedResult: gap.expectedResult,
      }
    }
  }
  return undefined
}

/**
 * Evaluate a JS request.
 *
 * A sanctioned gap passes without an argument. Otherwise `gap` must be
 * supplied for any non-native intent, and is validated for completeness; when
 * the request matches an intent that has a native operator, the call is
 * rejected regardless of the supplied gap.
 */
export function evaluateCapabilityGap(input: {
  /** The natural-language intent of the step. */
  stepIntent: string
  /** Optional documented gap. */
  gap?: Partial<CapabilityGapRecord>
}): CapabilityGapDecision {
  const sanctioned = sanctionedJsGap(input.stepIntent)
  if (sanctioned) return { allowed: true, capabilityGap: sanctioned }

  const native = NATIVE_INTENT_MAP.find((entry) => entry.test.test(input.stepIntent))
  if (native) {
    // Only consider operators that actually exist in the generation registry.
    const available = native.nativeBlockIds.filter((id) =>
      generationOperators().some((op) => op.id === id),
    )
    return {
      allowed: false,
      reason: `A native operator exists for "${native.label}"; use it instead of JavaScript.`,
      nativeBlockIds: available.length ? available : native.nativeBlockIds,
      intentLabel: native.label,
    }
  }

  const record = validateGapRecord(input.gap)
  if (!record) {
    return {
      allowed: false,
      reason:
        'JavaScript is a LAST RESORT. Provide EITHER a capabilityGap object (missingCapability, triedOperators, whyInsufficient, expectedResult) OR a justification naming the declarative operators you tried and why each fails; a call with neither is refused. Work the ladder first: get-text / attribute-value (read) · forms (fill / select / check) · event-click / hover-element / press-key (interact) · element-exists / conditions (branch) · set-variable / data-mapping / slice-variable / regex-variable (transform). Intents with no rung at all are already sanctioned and need no argument — currently: producing an image / canvas artifact (data URL, chart, poster, QR). / 代码节点是最后手段：必须提供 capabilityGap（四个字段）或 justification（说明试过的算子与原因），否则拒绝；生成图片一类的产物属于已认定能力缺口，无需论证。',
      nativeBlockIds: [],
      intentLabel: input.stepIntent.slice(0, 40),
    }
  }
  return { allowed: true, capabilityGap: record }
}

function validateGapRecord(value: Partial<CapabilityGapRecord> | undefined): CapabilityGapRecord | null {
  if (!value) return null
  if (typeof value.missingCapability !== 'string' || !value.missingCapability.trim()) return null
  if (!Array.isArray(value.triedOperators) || value.triedOperators.length === 0) return null
  if (typeof value.whyInsufficient !== 'string' || !value.whyInsufficient.trim()) return null
  if (typeof value.expectedResult !== 'string' || !value.expectedResult.trim()) return null
  return {
    missingCapability: value.missingCapability,
    triedOperators: value.triedOperators.filter((item): item is string => typeof item === 'string'),
    whyInsufficient: value.whyInsufficient,
    expectedResult: value.expectedResult,
  }
}

/** Whether a step intent has a native operator (no JS permitted). */
export function hasNativeOperator(stepIntent: string): boolean {
  return NATIVE_INTENT_MAP.some((entry) => entry.test.test(stepIntent))
}

/** Unified JS permission result for one wf_op_javascript-code call. */
export type JsPermission =
  | { allowed: true; justification: string }
  | { allowed: false; error: string; nativeBlockIds?: string[] }

/**
 * The UNIFIED javascript-code gate.
 *
 * Accepts either sanctioned argument shape:
 *
 *   - `capabilityGap`: the four-field documented record (missingCapability /
 *     triedOperators / whyInsufficient / expectedResult);
 *   - `justification`: the last-resort narrative naming the operators tried
 *     and why each fails.
 *
 * Both describe the same fact — "no declarative operator can do this step" —
 * and rejecting one while accepting the other is what trapped the model in a
 * retry loop. Native-first still holds: an intent with a native operator is
 * refused regardless of the supplied gap — except for a sanctioned gap
 * ({@link sanctionedJsGap}), which the policy has already documented and which
 * is judged FIRST, so a description that merely also mentions a form field
 * cannot be refused as a "fill" intent.
 */
export function evaluateJsPermission(input: {
  /** Natural-language intent of the step. */
  stepIntent: string
  /** Full tool-call arguments (carries capabilityGap and/or justification). */
  args: Record<string, unknown>
}): JsPermission {
  const sanctioned = sanctionedJsGap(input.stepIntent)
  if (sanctioned) {
    return {
      allowed: true,
      justification: `${sanctioned.missingCapability}: ${sanctioned.whyInsufficient} (tried: ${sanctioned.triedOperators.join(', ')})`,
    }
  }

  const native = NATIVE_INTENT_MAP.find((entry) => entry.test.test(input.stepIntent))
  if (native) {
    const available = native.nativeBlockIds.filter((id) =>
      generationOperators().some((op) => op.id === id),
    )
    return {
      allowed: false,
      error: `A native operator exists for "${native.label}"; use it instead of JavaScript.`,
      nativeBlockIds: available.length ? available : native.nativeBlockIds,
    }
  }

  const decision = evaluateCapabilityGap({
    stepIntent: input.stepIntent,
    gap: input.args['capabilityGap'] as Parameters<typeof evaluateCapabilityGap>[0]['gap'],
  })
  if (decision.allowed) {
    const gap = decision.capabilityGap
    return {
      allowed: true,
      justification: `${gap.missingCapability}: ${gap.whyInsufficient} (tried: ${gap.triedOperators.join(', ')})`,
    }
  }

  // Fall back to the justification shape before refusing: the model may have
  // supplied the narrative without the four-field record.
  const justification = scriptJustification(input.args)
  if (justification) return { allowed: true, justification }

  return { allowed: false, error: decision.reason }
}
