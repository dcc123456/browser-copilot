/**
 * Raw error text → {@link VerificationFailureType} (spec §6, Phase 3).
 *
 * Every failure raised by the executors is an English/Chinese string, often
 * prefixed with a structured code (`READINESS_TIMEOUT(present): …`). This
 * module is the ONE text → type mapping shared by the generation and debug
 * paths, so identical messages always classify identically regardless of the
 * entry point.
 *
 * It deliberately stays in `lib`: pure table matching, no browser/provider.
 *
 * @module lib/workflow/repair/failure-classifier
 */

import type { TraceFailure, VerificationFailureType } from './types'

/** Failure source hint for a matched type. */
type Source = TraceFailure['source']

interface ClassifierRow {
  /** Substrings / prefixes matched (case-insensitive) against the message. */
  match: readonly RegExp[]
  type: VerificationFailureType
  source: Source
  retryable: boolean
}

/** Ordered rows; first match wins. Keep specific rows before generic ones. */
const TABLE: readonly ClassifierRow[] = [
  {
    match: [/captcha/i],
    type: 'CAPTCHA_REQUIRED',
    source: 'EXECUTOR',
    retryable: false,
  },
  {
    match: [/2fa|two-factor|otp code/i, /\bauth(?:entication|orization)? required\b/i],
    type: 'AUTH_REQUIRED',
    source: 'EXECUTOR',
    retryable: false,
  },
  {
    match: [/FRAME_NOT_READY|frame .*not ready|frame .*not attached/i],
    type: 'FRAME_NOT_READY',
    source: 'EXECUTOR',
    retryable: true,
  },
  {
    match: [/PAGE_NOT_READY|page not ready|READINESS_TIMEOUT/i],
    type: 'PAGE_NOT_READY',
    source: 'EXECUTOR',
    retryable: true,
  },
  {
    match: [/LOCATOR_AMBIGUOUS|ambiguous|matches? \d+ elements|multiple elements/i],
    type: 'TARGET_AMBIGUOUS',
    source: 'EXECUTOR',
    retryable: true,
  },
  {
    match: [
      /LOCATOR_NOT_FOUND|ELEMENT_NOT_FOUND|element not found|元素未找到|元素不存在|没有读到任何内容/,
      /TARGET_NOT_FOUND|target not found|no node found/i,
    ],
    type: 'TARGET_NOT_FOUND',
    source: 'EXECUTOR',
    retryable: true,
  },
  {
    match: [/network error|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|fetch failed|网络/i],
    type: 'NETWORK_ERROR',
    source: 'EXECUTOR',
    retryable: true,
  },
  {
    match: [/WRONG_ORIGIN|wrong origin|不同源/i],
    type: 'WRONG_ORIGIN',
    source: 'EXECUTOR',
    retryable: false,
  },
  {
    match: [/WRONG_PAGE|wrong page/i],
    type: 'WRONG_PAGE',
    source: 'EXECUTOR',
    retryable: false,
  },
  {
    match: [/PRECONDITION_FAILED/i],
    type: 'PRECONDITION_FAILED',
    source: 'CONTRACT',
    retryable: true,
  },
  {
    match: [/POSTCONDITION_FAILED/i],
    type: 'POSTCONDITION_FAILED',
    source: 'POSTCONDITION',
    retryable: true,
  },
  {
    match: [/GOAL_NOT_ACHIEVED|goal not/i],
    type: 'GOAL_NOT_ACHIEVED',
    source: 'GOAL',
    retryable: false,
  },
  {
    match: [/SIDE_EFFECT_UNSAFE|SIDE_EFFECT_UNKNOWN|TERMINAL_STATE_UNCERTAIN|不可逆|副作用/i],
    type: 'SIDE_EFFECT_UNSAFE',
    source: 'EXECUTOR',
    retryable: false,
  },
  {
    match: [/wait.*condition|condition.*not.*met|WAIT_CONDITION/i],
    type: 'WAIT_CONDITION_UNMET',
    source: 'EXECUTOR',
    retryable: true,
  },
  {
    match: [/VARIABLE_MISSING|variable .*not defined|undefined variable|未定义变量/i],
    type: 'VARIABLE_MISSING',
    source: 'CONTRACT',
    retryable: true,
  },
  {
    match: [/VARIABLE_EMPTY|variable .*empty|值为空/i],
    type: 'VARIABLE_EMPTY',
    source: 'CONTRACT',
    retryable: true,
  },
  {
    match: [/VARIABLE_TYPE|type error|类型错误/i],
    type: 'VARIABLE_TYPE_ERROR',
    source: 'CONTRACT',
    retryable: true,
  },
  {
    match: [/STRUCTURAL_ERROR|STRUCTURE_|dangling|orphan|unreachable|cycle|circular/i],
    type: 'STRUCTURAL_ERROR',
    source: 'STRUCTURE',
    retryable: false,
  },
  {
    match: [/abortederror|\baborted\b|已取消|取消/i],
    type: 'CANCELLED',
    source: 'EXECUTOR',
    retryable: false,
  },
  {
    match: [/timeout|超时/i],
    type: 'TIMEOUT',
    source: 'EXECUTOR',
    retryable: true,
  },
]

export interface ClassifiedFailure {
  type: VerificationFailureType
  source: Source
  retryable: boolean
}

/** Classify a raw error message. Unmatched messages become `UNKNOWN`. */
export function classifyVerificationFailure(message: string): ClassifiedFailure {
  for (const row of TABLE) {
    if (row.match.some((pattern) => pattern.test(message))) {
      return { type: row.type, source: row.source, retryable: row.retryable }
    }
  }
  return { type: 'UNKNOWN', source: 'EXECUTOR', retryable: true }
}

/** Build a full {@link TraceFailure} from raw text, optionally with a node. */
export function traceFailureFrom(message: string, nodeId?: string): TraceFailure {
  const classified = classifyVerificationFailure(message)
  return {
    code: classified.type,
    message,
    ...(nodeId ? { nodeId } : {}),
    retryable: classified.retryable,
    source: classified.source,
  }
}
