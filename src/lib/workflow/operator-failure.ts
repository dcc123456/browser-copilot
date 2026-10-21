/**
 * Failure evidence for a generation-time operator call.
 *
 * A bare error string cannot tell a model whether the target was never on the
 * page, whether an earlier step left the page in the wrong state, or whether
 * the target was there but unclickable — three problems with three different
 * fixes. This module turns the failure into that evidence: a stable code, the
 * locator the kernel actually used, how many elements each CSS candidate
 * matched, and the page state at the time.
 *
 * The evidence is bounded on purpose. It travels inside the model's context,
 * so an unbounded page dump would cost more than it explains.
 *
 * The generic tool-layer fields (`errorType` / `suggestedRecovery`) are NOT
 * here: the tool-result envelope already adds them from `lib/tool-error.ts`,
 * and two copies of the same fact is one copy too many. What this bundle adds
 * is the DOMAIN classification — the failure code and what that class of
 * failure usually means.
 *
 * @module lib/workflow/operator-failure
 */

import {
  classifyFailureMessage,
  FAILURE_TABLE,
  type FailureCategory,
  type FailureCode,
} from './failure-code'
import type { RerunBoundary } from './rerun-policy'

/**
 * A failure code, plus the one refusal that has no runtime counterpart.
 *
 * `PERMISSION_DENIED` is a generation-time policy refusal (the JS escape
 * hatch was not justified) — it never reaches the runtime, so the runtime
 * vocabulary has no slot for it.
 */
export type OperatorFailureCode = FailureCode | 'PERMISSION_DENIED'

/**
 * The classification of the generation-time-only refusal.
 *
 * Retrying the same call changes nothing, and patching its parameters cannot
 * help either: the way out is a different approach, which is the model's job,
 * not the repair loop's.
 */
const PERMISSION_DENIED_CLASS = {
  category: 'workflow' as FailureCategory,
  recoverable: false,
  aiRepairable: false,
  hint: '脚本被原生算子门禁拒绝：先说明原生算子为何做不到（或改用原生算子）再重试，不要重复同一调用。',
}

/** What the kernel reported about the element it really hit. */
export interface OperatorLocatorResolution {
  /** Kernel's serialized spec (`how|value`) that matched the element. */
  usedSpec: string
  /** A fallback (not the primary spec) won. */
  usedFallback: boolean
  /** Elements the resolved target matched. */
  matched: number
}

/** The evidence handed back to the model when an operator call fails. */
export interface OperatorFailureEvidence {
  /** Stable code — the same vocabulary the runtime and the repair loop use. */
  failureCode: OperatorFailureCode
  /** Coarse class of the failure (locator / readiness / contract / …). */
  category: FailureCategory
  /** What this class of failure usually means. */
  failureHint: string
  /** Whether a bounded retry or re-observe can plausibly fix it. */
  recoverable: boolean
  /** Whether the AI-repair loop may patch parameters for it. */
  aiRepairable: boolean
  /** The failure text, truncated to {@link MAX_ERROR_MESSAGE} characters. */
  errorMessage: string
  /** The locator the kernel actually used, when it reported one. */
  locatorResolution?: OperatorLocatorResolution
  /** How many elements each probed CSS candidate matched. */
  candidateCounts?: { selector: string; count: number }[]
  /** The page the failure happened on. */
  pageState?: { url: string; title?: string }
  /** The last chain node a re-run may safely start from. */
  safeRerunBoundary?: RerunBoundary
}

const MAX_ERROR_MESSAGE = 200
const MAX_CANDIDATE_COUNTS = 8

/**
 * The classification of a code the caller named, looked up in the shared
 * failure table so the evidence never carries a second, divergent
 * classification of the same code.
 */
function classificationOf(code: OperatorFailureCode): {
  code: OperatorFailureCode
  category: FailureCategory
  recoverable: boolean
  aiRepairable: boolean
  hint: string
} {
  if (code === 'PERMISSION_DENIED') return { code, ...PERMISSION_DENIED_CLASS }
  const row = FAILURE_TABLE.find((entry) => entry.code === code)
  if (!row) {
    return {
      code,
      category: 'workflow',
      recoverable: true,
      aiRepairable: true,
      hint: '该失败码在分类表中没有对应说明，请结合 errorMessage 与页面状态判断。',
    }
  }
  return {
    code,
    category: row.category,
    recoverable: row.recoverable,
    aiRepairable: row.aiRepairable,
    hint: row.hint,
  }
}

/**
 * Build the evidence bundle for one failed operator call.
 *
 * `code` overrides the classifier: a pre-execution refusal has a message the
 * runtime vocabulary would read as `UNKNOWN`, but the caller knows exactly
 * which policy it hit.
 */
export function buildOperatorFailureEvidence(input: {
  errorMessage: string
  code?: OperatorFailureCode
  resolution?: OperatorLocatorResolution
  candidateSelectors?: readonly string[]
  candidateCounts?: readonly number[] | null
  pageState?: { url: string; title?: string }
  safeRerunBoundary?: RerunBoundary
}): OperatorFailureEvidence {
  const errorMessage = input.errorMessage.slice(0, MAX_ERROR_MESSAGE)
  const classification = input.code
    ? classificationOf(input.code)
    : classifyFailureMessage(input.errorMessage)
  const failureCode = classification.code

  const evidence: OperatorFailureEvidence = {
    failureCode,
    category: classification.category,
    failureHint: classification.hint,
    recoverable: classification.recoverable,
    aiRepairable: classification.aiRepairable,
    errorMessage,
  }
  if (input.resolution) {
    evidence.locatorResolution = {
      usedSpec: input.resolution.usedSpec,
      usedFallback: input.resolution.usedFallback,
      matched: input.resolution.matched,
    }
  }
  const selectors = input.candidateSelectors
  const counts = input.candidateCounts
  if (selectors && counts) {
    evidence.candidateCounts = selectors
      .slice(0, MAX_CANDIDATE_COUNTS)
      .map((selector, index) => ({ selector, count: counts[index] ?? 0 }))
  }
  if (input.pageState) evidence.pageState = input.pageState
  if (input.safeRerunBoundary) evidence.safeRerunBoundary = input.safeRerunBoundary
  return evidence
}
