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
import { describeCondition } from '../../lib/workflow/conditions'

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

import type { Target, TargetSpec } from '../../lib/ops'
import { execOnActiveTab, execJsOnActiveTab, resolveAutomationTab } from '../driver'
import { targetSpecFromSemantic } from '../../lib/workflow/element-fingerprint'
import type { ScopeWindow } from '../automation-scope'

/**
 * A CSS selector that uniquely expresses a kernel-expressible locator, or
 * undefined for role/text locators (no honest CSS exists — the caller gets
 * "not observable" instead of a guess).
 */
function cssFromSemantic(target: SemanticLocator): string | undefined {
  const spec: TargetSpec | undefined = targetSpecFromSemantic(target)
  if (!spec) return undefined
  if (spec.how === 'testid') return `[data-testid=${JSON.stringify(spec.value)}]`
  if (spec.how === 'id') return `#${CSS.escape(spec.value)}`
  if (spec.how === 'name') return `[name=${JSON.stringify(spec.value)}]`
  return undefined
}

/** Resolve a semantic locator to a kernel Target, or fall back to a CSS spec. */
function targetFor(target: SemanticLocator, nodeSelector?: string): Target | undefined {
  const spec = targetSpecFromSemantic(target)
  if (spec) return { primary: spec, fallbacks: [] }
  if (nodeSelector?.trim()) {
    return { primary: { how: 'css', value: nodeSelector.trim() }, fallbacks: [] }
  }
  return undefined
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
      return (result?.data as { state?: string } | undefined)?.state !== 'missing'
    },
    enabled: async (target) => {
      const t = targetFor(target)
      if (!t) return false
      const result = await op({ action: 'actionability', target: t })
      return (result?.data as { state?: string } | undefined)?.state === 'ready'
    },
    text: async (target) => {
      const css = cssFromSemantic(target)
      if (!css) return undefined // role/text locators are not CSS-observable
      const result = await execJsOnActiveTab(
        `return (document.querySelector(${JSON.stringify(css)})?.innerText ?? null);`,
        {},
        signal,
        undefined,
        scope,
      ).catch(() => undefined)
      return result && result.ok ? ((result.data as string | null) ?? '') : undefined
    },
    attribute: async (target, name) => {
      const t = targetFor(target)
      if (!t) return undefined
      const result = await op({ action: 'get_attribute', target: t, value: name })
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
): Promise<boolean> {
  const outcome = await evaluateCondition(condition, { variables, probe })
  return outcome.satisfied
}
