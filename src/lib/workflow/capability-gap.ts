/**
 * Capability-gap gate — the ONLY sanctioned path to raw JavaScript.
 *
 * Native-first policy: when a native operator exists for an intent, a JS call
 * is rejected and the caller is pointed at the native capability. JS is
 * permitted solely for a documented capability gap — and even then the node
 * must carry a goal, success criteria and verification, so "JS ran OK" is
 * never treated as task success.
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

/** Intents that always have a native operator, mapped to capability keywords. */
const NATIVE_INTENT_MAP: ReadonlyArray<{
  test: RegExp
  nativeBlockIds: string[]
  label: string
}> = [
  { test: /(点击|click|tap)/i, nativeBlockIds: ['event-click'], label: 'click' },
  { test: /(填写|输入|type|fill|enter)/i, nativeBlockIds: ['forms'], label: 'fill' },
  { test: /(读取文本|read text|get text)/i, nativeBlockIds: ['get-text'], label: 'read text' },
  {
    test: /(读取属性|read attribute|attribute)/i,
    nativeBlockIds: ['attribute-value'],
    label: 'read attribute',
  },
  {
    test: /(元素存在|判断.*存在|element exists|exists)/i,
    nativeBlockIds: ['element-exists'],
    label: 'element exists',
  },
  { test: /(等待|wait)/i, nativeBlockIds: ['wait-connections', 'delay'], label: 'wait' },
  { test: /(条件|condition|if)/i, nativeBlockIds: ['conditions'], label: 'condition' },
  { test: /(循环|loop|for each|遍历)/i, nativeBlockIds: ['loop-elements', 'loop-data'], label: 'loop' },
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
 * Evaluate a JS request.
 *
 * `gap` must be supplied for any non-native intent; it is validated for
 * completeness. When the request matches an intent that has a native operator,
 * the call is rejected regardless of the supplied gap.
 */
export function evaluateCapabilityGap(input: {
  /** The natural-language intent of the step. */
  stepIntent: string
  /** Optional documented gap. */
  gap?: Partial<CapabilityGapRecord>
}): CapabilityGapDecision {
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
        'JavaScript is a LAST RESORT. Provide EITHER a capabilityGap object (missingCapability, triedOperators, whyInsufficient, expectedResult) OR a justification naming the declarative operators you tried and why each fails; a call with neither is refused. Work the ladder first: get-text / attribute-value (read) · forms (fill / select / check) · event-click / hover-element / press-key (interact) · element-exists / conditions (branch) · set-variable / data-mapping / slice-variable / regex-variable (transform). / 代码节点是最后手段：必须提供 capabilityGap（四个字段）或 justification（说明试过的算子与原因），否则拒绝。',
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
 * refused regardless of the supplied gap.
 */
export function evaluateJsPermission(input: {
  /** Natural-language intent of the step. */
  stepIntent: string
  /** Full tool-call arguments (carries capabilityGap and/or justification). */
  args: Record<string, unknown>
}): JsPermission {
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
