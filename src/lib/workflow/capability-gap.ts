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
 * A native-first refusal is also lifted by evidence rather than prose: when the
 * caller reports ({@link NativeAttemptEvidence}) that the native operator
 * for that very intent ran in this generation session and the page refused it,
 * the rung has been proven insufficient by the browser itself, so the gate
 * synthesizes the gap record instead of refusing forever. The evidence comes
 * from `generation-coverage`, is in-memory, and is absent after a service
 * worker eviction — which simply restores the plain refusal.
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
  {
    test: /(读取文本|\bread text\b|\bget text\b)/i,
    nativeBlockIds: ['get-text'],
    label: 'read text',
  },
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
  {
    test: /(循环|遍历|\bloop\b|\bfor each\b)/i,
    nativeBlockIds: ['loop-elements', 'loop-data'],
    label: 'loop',
  },
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
 * What the caller knows about native attempts in this generation session.
 *
 * Optional by design: every call site that cannot see execution results simply
 * keeps today's behavior, so the evidence never becomes a required argument the
 * model has to fake.
 */
export interface NativeAttemptEvidence {
  /**
   * Block ids whose operator really ran and failed without a successful retry
   * — `failedBlockIdsOf(conversationId)` from `generation-coverage`. A native
   * intent is refused whatever the caller claims when this is absent or empty.
   */
  nativeAttemptFailedBlockIds?: readonly string[]
}

/** The native rung an intent maps to, with the operators that exist for it. */
interface NativeRung {
  label: string
  blockIds: string[]
}

/**
 * The one scan over {@link NATIVE_INTENT_MAP}. Both gates used to run their own
 * copy, which is how the two could disagree; an intent keeps its native label
 * even when the generation registry currently hides the operator, so the
 * refusal still names what the caller should look for.
 */
function nativeRungFor(stepIntent: string): NativeRung | undefined {
  const entry = NATIVE_INTENT_MAP.find((native) => native.test.test(stepIntent))
  if (!entry) return undefined
  const available = entry.nativeBlockIds.filter((blockId) =>
    generationOperators().some((op) => op.id === blockId),
  )
  return { label: entry.label, blockIds: available.length ? available : entry.nativeBlockIds }
}

/**
 * The native block ids this session really ran and lost, for one intent. Non-empty
 * means the browser, not the model, proved that rung insufficient.
 *
 * Approximate on purpose: the coverage set is keyed by block id and not by
 * element, so any unrecovered failure of this intent's operator counts. The cost
 * is visible rather than hidden — a failed step records no node and shows up as a
 * coverage warning on the save card.
 */
function nativeAttemptsProvenInsufficient(
  rung: NativeRung,
  failedBlockIds: readonly string[] | undefined,
): string[] {
  if (!failedBlockIds || failedBlockIds.length === 0) return []
  return rung.blockIds.filter((blockId) => failedBlockIds.includes(blockId))
}

/**
 * The gap record the evidence writes onto the node. `triedOperators` names the
 * operators the session actually ran and lost, so the canvas card stays auditable
 * instead of repeating the model's claim.
 */
function gapFromFailedNativeAttempt(
  rung: NativeRung,
  triedOperators: readonly string[],
): CapabilityGapRecord {
  return {
    missingCapability: `reach the element the native "${rung.label}" operator could not (${triedOperators.join(
      ', ',
    )} failed in this session)`,
    triedOperators: [...triedOperators],
    whyInsufficient:
      'sanctioned capability gap: the native operator ran on this page and the page refused it (generation coverage record)',
    expectedResult:
      'the same effect as the native step, produced by a script because no declarative rung reaches it',
  }
}

/**
 * The native-first refusal, which has to name the way out. An earlier build said
 * only "use the native operator", and a model that had already tried it and lost
 * had no move left but to give up or pick a worse operator.
 */
function nativeRefusalReason(rung: NativeRung): string {
  return (
    `A native operator exists for "${rung.label}" (${rung.blockIds.join(', ')}); use it instead of ` +
    'JavaScript. If it genuinely cannot reach this element (React synthetic events, a shadow root, a ' +
    'mousedown-only component), run it anyway: once it executes and fails, that recorded failure ' +
    'unlocks this call. / 声明式算子覆盖该意图时禁止改用 JS。若原生算子确实够不到该元素（合成事件、shadow DOM、' +
    '只监听 mousedown 的组件），先真实执行它一次，执行失败的覆盖记录会自动解锁本次 javascript-code 调用。'
  )
}

/** The narrative that rides onto the node's `justification`. */
function justificationOf(gap: CapabilityGapRecord): string {
  return `${gap.missingCapability}: ${gap.whyInsufficient} (tried: ${gap.triedOperators.join(', ')})`
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
 * captcha solving stays a human gate). A script body naming a pixel API is
 * accepted as the same fact ({@link SanctionedJsGap.codeEvidence}), because the
 * description is written while the model is still looking at the page and often
 * names the button it means to reach ("点击图片上传入口") rather than the
 * artifact the script produces.
 */
interface SanctionedJsGap {
  id: string
  /** Terms meaning "make an artifact", not "act on the page". */
  production: RegExp
  /** The artifact no operator can produce. */
  artifact: RegExp
  /** Script-body APIs whose only purpose is drawing or exporting pixels. */
  codeEvidence?: RegExp
  /** Intents that look like production but have a native operator. */
  excluded: RegExp
  missingCapability: string
  whyInsufficient: string
  expectedResult: string
}

const SANCTIONED_JS_GAPS: readonly SanctionedJsGap[] = [
  {
    id: 'image-artifact',
    // No bare `画`: it is also inside 计划 / 规划, which would sanction any
    // plan-shaped step that happens to mention an image.
    production:
      /(生成|绘制|渲染|合成|制作|导出|转成|输出|拼接|画出|画到|画在|画一|draw|render|\bgenerat\w*\b|\bcreat\w*\b|\bproduce\b|toDataURL)/i,
    artifact:
      /(图片|图像|海报|图表|二维码|插画|插图|长图|头像|图标|缩略图|壁纸|配图|表情包|画布|封面图|canvas|png|jpe?g|webp|bmp|data\s?url|\bimage\b|\bchart\b|qr ?code|poster|thumbnail|artwork|illustration|avatar|\bicon\b)/i,
    // `new Image()` / `createObjectURL` / `DataTransfer` on their own only MOVE
    // bytes, so they are not evidence; every pattern here draws or encodes
    // pixels, which no declarative operator can do.
    codeEvidence:
      /(toDataURL|\.toBlob\(|convertToBlob|getContext\(\s*['"`]2d['"`]|new\s+OffscreenCanvas|\bdrawImage\b|createImageBitmap|\bImageBitmap\b|html2canvas|dom-to-image|image\/(?:png|jpe?g|webp|gif|bmp))/i,
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
 *
 * `scriptCode` is the node's own script, judged as a second source of the same
 * fact: a body that encodes pixels is producing an image artifact whatever the
 * description says. Exclusions still veto, so a captcha or screenshot step is
 * refused no matter what its script contains.
 */
export function sanctionedJsGap(
  stepIntent: string,
  scriptCode?: string,
): CapabilityGapRecord | undefined {
  const intent = stepIntent.trim()
  const code = typeof scriptCode === 'string' ? scriptCode : ''
  if (!intent && !code) return undefined
  for (const gap of SANCTIONED_JS_GAPS) {
    // No /g flag on purpose: RegExp.test on a global regex is stateful.
    if (gap.excluded.test(intent)) continue
    const described = gap.production.test(intent) && gap.artifact.test(intent)
    if (!described && !(code && gap.codeEvidence?.test(code))) continue
    return {
      missingCapability: `${gap.missingCapability} [${gap.id}]`,
      triedOperators: ['declarative ladder: none produces an image artifact'],
      whyInsufficient: gap.whyInsufficient,
      expectedResult: gap.expectedResult,
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
 * rejected regardless of the supplied gap — unless the caller's evidence shows
 * that operator really ran and failed in this session.
 */
export function evaluateCapabilityGap(
  input: {
    /** The natural-language intent of the step. */
    stepIntent: string
    /** The node's script body, when the caller has it. */
    scriptCode?: string
    /** Optional documented gap. */
    gap?: Partial<CapabilityGapRecord>
  } & NativeAttemptEvidence,
): CapabilityGapDecision {
  const sanctioned = sanctionedJsGap(input.stepIntent, input.scriptCode)
  if (sanctioned) return { allowed: true, capabilityGap: sanctioned }

  const rung = nativeRungFor(input.stepIntent)
  if (rung) {
    const tried = nativeAttemptsProvenInsufficient(rung, input.nativeAttemptFailedBlockIds)
    if (tried.length === 0) {
      return {
        allowed: false,
        reason: nativeRefusalReason(rung),
        nativeBlockIds: rung.blockIds,
        intentLabel: rung.label,
      }
    }
    return { allowed: true, capabilityGap: gapFromFailedNativeAttempt(rung, tried) }
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

function validateGapRecord(
  value: Partial<CapabilityGapRecord> | undefined,
): CapabilityGapRecord | null {
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
  return nativeRungFor(stepIntent) !== undefined
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
 * refused regardless of the supplied gap, and lifted only by a sanctioned gap
 * ({@link sanctionedJsGap}, judged FIRST so a description that merely also
 * mentions a form field cannot be refused as a "fill" intent) or by this
 * session's record that the native operator ran and the page refused it
 * ({@link NativeAttemptEvidence}).
 */
export function evaluateJsPermission(
  input: {
    /** Natural-language intent of the step. */
    stepIntent: string
    /** Full tool-call arguments (carries capabilityGap and/or justification). */
    args: Record<string, unknown>
  } & NativeAttemptEvidence,
): JsPermission {
  // The script body is the second half of the sanctioned-gap test: a node that
  // encodes pixels is producing an image artifact even when its description
  // reads like a click ("点击图片上传入口"), which is how image steps used to be
  // refused as native intents.
  const scriptCode = typeof input.args['code'] === 'string' ? (input.args['code'] as string) : ''
  const sanctioned = sanctionedJsGap(input.stepIntent, scriptCode)
  if (sanctioned) {
    // Permission is already settled by policy; a gap the caller documented
    // itself is still the better text — it names what THIS node produces, and
    // it is what lands on the canvas card.
    const gap =
      validateGapRecord(input.args['capabilityGap'] as Partial<CapabilityGapRecord>) ?? sanctioned
    return { allowed: true, justification: justificationOf(gap) }
  }

  // The native-rung decision lives in one place ({@link evaluateCapabilityGap}),
  // so this gate and the four-field contract can never disagree about whether a
  // click intent is refused — the disagreement that used to fail generations.
  const decision = evaluateCapabilityGap({
    stepIntent: input.stepIntent,
    ...(scriptCode ? { scriptCode } : {}),
    gap: input.args['capabilityGap'] as Parameters<typeof evaluateCapabilityGap>[0]['gap'],
    ...(input.nativeAttemptFailedBlockIds
      ? { nativeAttemptFailedBlockIds: input.nativeAttemptFailedBlockIds }
      : {}),
  })
  if (decision.allowed) {
    return { allowed: true, justification: justificationOf(decision.capabilityGap) }
  }
  // A native intent stays refused whatever the caller attaches: the ladder rung
  // has to be tried first, and only its recorded failure opens the escape hatch.
  if (decision.nativeBlockIds.length > 0) {
    return { allowed: false, error: decision.reason, nativeBlockIds: decision.nativeBlockIds }
  }

  // Fall back to the justification shape before refusing: the model may have
  // supplied the narrative without the four-field record.
  const justification = scriptJustification(input.args)
  if (justification) return { allowed: true, justification }

  return { allowed: false, error: decision.reason }
}
