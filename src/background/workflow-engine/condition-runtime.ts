/**
 * The condition runtime — evaluating WorkflowConditions against the LIVE page
 * and the run's variables.
 *
 * The condition vocabulary is pure (`lib/workflow/conditions`); this module is
 * its runtime half on the browser side. All page access goes through the
 * injected {@link ConditionPageProbe}, so the evaluation logic is unit-testable
 * and the driver wiring lives in one factory. There is NO LLM here: a
 * condition is a deterministic observation, and goal judgement falls back to
 * the LLM only ABOVE this layer (see `goal-verifier`), never instead of it.
 *
 * @module background/workflow-engine/condition-runtime
 */
import type { SemanticLocator } from '../../lib/workflow/element-fingerprint'
import type { WorkflowCondition } from '../../lib/workflow/conditions'
import {
  conditionLocatorKey,
  describeCondition,
} from '../../lib/workflow/conditions'

/**
 * The page observations conditions may need. Implementations must observe
 * FRESH state per call (same rule as the readiness probe).
 */
export interface ConditionPageProbe {
  exists(target: SemanticLocator): Promise<boolean>
  visible(target: SemanticLocator): Promise<boolean>
  enabled(target: SemanticLocator): Promise<boolean>
  /** The element's text, or undefined when it does not exist. */
  text(target: SemanticLocator): Promise<string | undefined>
  /** One attribute value, or undefined when absent (element or attribute). */
  attribute(target: SemanticLocator, name: string): Promise<string | undefined>
  /** How many elements the locator matches. */
  count(target: SemanticLocator): Promise<number>
  /** The current page URL. */
  url(): Promise<string | undefined>
}

export interface ConditionEvalDeps {
  variables: Record<string, unknown>
  probe: ConditionPageProbe
  /**
   * What the page looked like BEFORE the step, when the condition asks what
   * CHANGED. Absent means nobody observed it, which is reported as
   * unsatisfied-with-detail rather than as a pass: "cannot tell" must never be
   * recorded as "the task worked".
   */
  baseline?: ConditionBaseline
}

/** A pre-step snapshot of the page, keyed by {@link conditionLocatorKey}. */
export interface ConditionBaseline {
  url?: string
  counts: Record<string, number>
  exists: Record<string, boolean>
}

/**
 * Observe the page once, before the step, for the conditions that describe a
 * CHANGE (the row vanished, the list grew, the dialog closed, the URL moved on).
 *
 * Returns undefined when nothing was observable — a page the probe cannot read
 * gives no honest baseline, and pretending otherwise would let a step claim it
 * changed something it never looked at.
 */
export async function captureConditionBaseline(
  conditions: readonly WorkflowCondition[],
  probe: ConditionPageProbe,
): Promise<ConditionBaseline | undefined> {
  const counts: Record<string, number> = {}
  const exists: Record<string, boolean> = {}
  let url: string | undefined
  let observed = false
  for (const condition of conditions) {
    if (condition.kind === 'urlChanged') {
      const before = await probe.url()
      if (before !== undefined) {
        url = before
        observed = true
      }
      continue
    }
    if (
      condition.kind !== 'elementGone' &&
      condition.kind !== 'elementAppeared' &&
      condition.kind !== 'countIncreased'
    ) {
      continue
    }
    const key = conditionLocatorKey(condition.target)
    if (condition.kind === 'countIncreased') {
      if (!(key in counts)) {
        counts[key] = await probe.count(condition.target)
        observed = true
      }
      continue
    }
    if (!(key in exists)) {
      exists[key] = await probe.exists(condition.target)
      observed = true
    }
  }
  if (!observed) return undefined
  return { ...(url !== undefined ? { url } : {}), counts, exists }
}

/** One evaluated condition. */
export interface ConditionOutcome {
  satisfied: boolean
  /** Human-readable condition text (for evidence and failure messages). */
  description: string
  detail?: string
}

/** Loose equality for `variableEquals` (JSON-level, not reference equality). */
function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** Evaluate one condition. Never throws — probe failures read as unsatisfied. */
export async function evaluateCondition(
  condition: WorkflowCondition,
  deps: ConditionEvalDeps,
): Promise<ConditionOutcome> {
  const description = describeCondition(condition)
  const unsatisfied = (detail?: string): ConditionOutcome => ({
    satisfied: false,
    description,
    ...(detail ? { detail } : {}),
  })
  try {
    switch (condition.kind) {
      case 'urlContains': {
        const url = (await deps.probe.url()) ?? ''
        return url.includes(condition.value)
          ? { satisfied: true, description }
          : unsatisfied(`URL "${url}" 不包含 "${condition.value}"`)
      }
      case 'urlMatches': {
        const url = (await deps.probe.url()) ?? ''
        let matched = false
        try {
          matched = new RegExp(condition.value).test(url)
        } catch {
          matched = url.includes(condition.value)
        }
        return matched
          ? { satisfied: true, description }
          : unsatisfied(`URL "${url}" 不匹配 "${condition.value}"`)
      }
      case 'elementExists': {
        const ok = await deps.probe.exists(condition.target)
        return ok ? { satisfied: true, description } : unsatisfied('元素不存在')
      }
      case 'elementVisible': {
        const ok = await deps.probe.visible(condition.target)
        return ok ? { satisfied: true, description } : unsatisfied('元素不可见')
      }
      case 'elementEnabled': {
        const ok = await deps.probe.enabled(condition.target)
        return ok ? { satisfied: true, description } : unsatisfied('元素不可用')
      }
      case 'elementText': {
        const text = await deps.probe.text(condition.target)
        if (text === undefined) return unsatisfied('元素不存在')
        const ok =
          (condition.match ?? 'exact') === 'exact'
            ? text.trim() === condition.expected
            : text.includes(condition.expected)
        return ok
          ? { satisfied: true, description }
          : unsatisfied(`文本为 "${text.trim().slice(0, 80)}"`)
      }
      case 'attributeEquals': {
        const value = await deps.probe.attribute(condition.target, condition.name)
        if (value === undefined) return unsatisfied(`属性 ${condition.name} 不存在`)
        return value === condition.expected
          ? { satisfied: true, description }
          : unsatisfied(`属性 ${condition.name} 为 "${value}"`)
      }
      case 'variableEquals': {
        const value = deps.variables[condition.name]
        return looseEqual(value, condition.expected)
          ? { satisfied: true, description }
          : unsatisfied(`变量 ${condition.name} = ${JSON.stringify(value) ?? 'undefined'}`)
      }
      case 'variableExists': {
        const present = condition.name in deps.variables && deps.variables[condition.name] !== undefined
        return present
          ? { satisfied: true, description }
          : unsatisfied(`变量 ${condition.name} 不存在`)
      }
      case 'count': {
        const n = await deps.probe.count(condition.target)
        const ok =
          condition.op === 'eq'
            ? n === condition.value
            : condition.op === 'gte'
              ? n >= condition.value
              : n <= condition.value
        return ok
          ? { satisfied: true, description }
          : unsatisfied(`实际数量 ${n}`)
      }
      case 'urlChanged': {
        const before = deps.baseline?.url
        if (before === undefined) return unsatisfied('缺少步骤前的 URL 观测')
        const after = await deps.probe.url()
        if (after === undefined) return unsatisfied('步骤后的 URL 不可观测')
        return after !== before
          ? { satisfied: true, description }
          : unsatisfied(`URL 仍为 "${after}"`)
      }
      case 'elementGone': {
        const key = conditionLocatorKey(condition.target)
        if (!(key in (deps.baseline?.exists ?? {}))) return unsatisfied('缺少步骤前的元素观测')
        const still = await deps.probe.exists(condition.target)
        return still ? unsatisfied('元素仍然存在') : { satisfied: true, description }
      }
      case 'elementAppeared': {
        const key = conditionLocatorKey(condition.target)
        if (!(key in (deps.baseline?.exists ?? {}))) return unsatisfied('缺少步骤前的元素观测')
        if (deps.baseline?.exists?.[key]) return unsatisfied('步骤前就已存在')
        const now = await deps.probe.exists(condition.target)
        return now ? { satisfied: true, description } : unsatisfied('元素没有出现')
      }
      case 'countIncreased': {
        const key = conditionLocatorKey(condition.target)
        const before = deps.baseline?.counts?.[key]
        if (before === undefined) return unsatisfied('缺少步骤前的数量观测')
        const after = await deps.probe.count(condition.target)
        return after > before
          ? { satisfied: true, description }
          : unsatisfied(`数量 ${before} → ${after}`)
      }
    }
  } catch (e) {
    return unsatisfied(e instanceof Error ? e.message : String(e))
  }
}

/** Evaluate a list; stops at the first unsatisfied condition when `shortCircuit`. */
export async function evaluateAllConditions(
  conditions: readonly WorkflowCondition[],
  deps: ConditionEvalDeps,
  shortCircuit = true,
): Promise<{ allSatisfied: boolean; outcomes: ConditionOutcome[] }> {
  const outcomes: ConditionOutcome[] = []
  for (const condition of conditions) {
    const outcome = await evaluateCondition(condition, deps)
    outcomes.push(outcome)
    if (!outcome.satisfied && shortCircuit) break
  }
  return { allSatisfied: outcomes.every((o) => o.satisfied), outcomes }
}

// --- Driver-backed probe factory (browser integration) -------------------------------

import type { Target } from '../../lib/ops'
import { execOnActiveTab, resolveAutomationTab } from '../driver'
import { targetSpecsFromSemantic } from '../../lib/workflow/element-fingerprint'
import type { ScopeWindow } from '../automation-scope'

/**
 * The kernel Target a condition observes: every spec the semantic locator can
 * honestly express (see `targetSpecsFromSemantic`). An observation must be able
 * to find the element the node itself can click, so a condition walks the SAME
 * candidate chain replay does rather than betting on one spec. Nothing is
 * refused here: a locator with no expressible spec reads as "not observable".
 */
function targetFor(target: SemanticLocator): Target | undefined {
  const [primary, ...fallbacks] = targetSpecsFromSemantic(target)
  return primary ? { primary, fallbacks } : undefined
}

/**
 * The REAL condition probe over the driver. Every call is a fresh observation
 * through a kernel op on the automation tab; failures read as "no answer"
 * (undefined / false), never as throws — the evaluator turns them into
 * unsatisfied conditions with detail.
 */
export function createDriverConditionProbe(
  signal: AbortSignal,
  scope?: ScopeWindow,
): ConditionPageProbe {
  const op = async (o: TargetOp): Promise<import('../../lib/ops').OpResult | undefined> =>
    execOnActiveTab(o, signal, undefined, scope).catch(() => undefined)
  return {
    exists: async (target) => {
      const t = targetFor(target)
      if (!t) return false
      const result = await op({ action: 'element_exists', target: t })
      return (typeof result?.data === 'number' && result.data > 0) || result?.found === true
    },
    count: async (target) => {
      const t = targetFor(target)
      if (!t) return 0
      const result = await op({ action: 'element_exists', target: t })
      return typeof result?.data === 'number' ? result.data : result?.found ? 1 : 0
    },
    visible: async (target) => {
      const t = targetFor(target)
      if (!t) return false
      const result = await op({ action: 'actionability', target: t })
      return (result?.data as { visible?: boolean } | undefined)?.visible === true
    },
    enabled: async (target) => {
      const t = targetFor(target)
      if (!t) return false
      const result = await op({ action: 'actionability', target: t })
      return (result?.data as { enabled?: boolean } | undefined)?.enabled === true
    },
    text: async (target) => {
      const t = targetFor(target)
      if (!t) return undefined
      // The kernel reads the text of whatever its resolver picked, so role and
      // accessible-name locators are observable too. A CSS-only read (the old
      // path) reported "not observable" for exactly the locators a recorded run
      // produces, which made their success criteria unsatisfiable.
      const result = await op({ action: 'get_text', target: t })
      return typeof result?.data === 'string' ? result.data : undefined
    },
    attribute: async (target, name) => {
      const t = targetFor(target)
      if (!t) return undefined
      // `get_attribute` reads `op.attribute`, not `op.value` — sending the name
      // in `value` made every attribute condition fail with "needs an attribute
      // name", which reads as "condition not met".
      const result = await op({ action: 'get_attribute', target: t, attribute: name })
      return typeof result?.data === 'string' ? result.data : undefined
    },
    url: async () => {
      const tab = await resolveAutomationTab(undefined, scope).catch(() => undefined)
      return typeof tab?.url === 'string' ? tab.url : undefined
    },
  }
}

/** The op shape the probe issues (same union execOnActiveTab accepts). */
type TargetOp = Parameters<typeof execOnActiveTab>[0]

/**
 * Convenience bridge for callers that hold a variables bag: evaluate one
 * condition with a probe. Variable conditions read the bag directly.
 */
export async function evaluateConditionWithProbe(
  condition: WorkflowCondition,
  variables: Record<string, unknown>,
  probe: ConditionPageProbe,
  baseline?: ConditionBaseline,
): Promise<boolean> {
  const outcome = await evaluateCondition(condition, { variables, probe, baseline })
  return outcome.satisfied
}
