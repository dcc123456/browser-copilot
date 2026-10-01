/**
 * Workflow conditions — the declarative vocabulary of verifiable facts.
 *
 * "I clicked the button" and "the task is done" are different claims. The
 * reliability contract expresses the second kind as CONDITIONS: small,
 * machine-checkable statements about the page, the URL or the run's variables.
 * The same type serves three consumers:
 *
 *   - node preconditions / postconditions (`node.data.__reliability`),
 *   - the workflow-level goal spec (`workflow.settings.goalSpec`),
 *   - the terminal-state checks that guard non-idempotent actions.
 *
 * Page/element conditions reference targets as {@link SemanticLocator} —
 * meaning, not CSS. Pure module: evaluation lives in the runtime layer
 * (`background/workflow-engine/condition-runtime`); everything here is data,
 * guards and description.
 *
 * @module lib/workflow/conditions
 */
import type { ConditionTarget } from './element-fingerprint'
import { describeConditionTarget } from './element-fingerprint'

/** One checkable fact. All kinds are deterministic except none — the LLM is not a condition. */
export type WorkflowCondition =
  | { kind: 'urlContains'; value: string }
  | { kind: 'urlMatches'; value: string }
  | { kind: 'elementExists'; target: ConditionTarget }
  | { kind: 'elementVisible'; target: ConditionTarget }
  | { kind: 'elementEnabled'; target: ConditionTarget }
  | {
      kind: 'elementText'
      target: ConditionTarget
      expected: string
      /** Default `exact`: a goal condition must not pass on a substring. */
      match?: 'exact' | 'contains'
    }
  | { kind: 'attributeEquals'; target: ConditionTarget; name: string; expected: string }
  | { kind: 'variableEquals'; name: string; expected: unknown }
  | { kind: 'variableExists'; name: string }
  | { kind: 'count'; target: ConditionTarget; op: 'eq' | 'gte' | 'lte'; value: number }
  /**
   * The four CHANGING conditions: what the step did to the page, rather than
   * what is on it. Each needs an observation from BEFORE the step (see
   * `conditionRequiresBaseline`), which is why they are their own group — a
   * replay that collected no baseline cannot claim them either way.
   *
   * They are also the business-outcome signals: "the URL moved on", "the row
   * disappeared", "the list grew by one", "the dialog closed".
   */
  | { kind: 'urlChanged' }
  | { kind: 'elementGone'; target: ConditionTarget }
  | { kind: 'elementAppeared'; target: ConditionTarget }
  | { kind: 'countIncreased'; target: ConditionTarget }

/** The `kind` whitelist — the guard used on every untrusted condition. */
const CONDITION_KINDS: readonly string[] = [
  'urlContains',
  'urlMatches',
  'elementExists',
  'elementVisible',
  'elementEnabled',
  'elementText',
  'attributeEquals',
  'variableEquals',
  'variableExists',
  'count',
  'urlChanged',
  'elementGone',
  'elementAppeared',
  'countIncreased',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A recorded `TargetSpec`: something the observation layer can search for. */
function hasResolvableSpec(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value['how'] !== 'string' || !value['how'].trim()) return false
  return typeof value['value'] === 'string' && !!value['value'].trim()
}

/** Structural check of a raw (untrusted) condition object. */
export function isWorkflowCondition(value: unknown): value is WorkflowCondition {
  if (!isRecord(value)) return false
  if (typeof value['kind'] !== 'string') return false
  if (!(CONDITION_KINDS as readonly string[]).includes(value['kind'])) return false
  const kind = value['kind']
  // Element-bearing kinds need a semantic target object.
  if (
    kind === 'elementExists' ||
    kind === 'elementVisible' ||
    kind === 'elementEnabled' ||
    kind === 'elementText' ||
    kind === 'attributeEquals' ||
    kind === 'elementGone' ||
    kind === 'elementAppeared' ||
    kind === 'countIncreased' ||
    kind === 'count'
  ) {
    const target = value['target']
    if (!isRecord(target)) return false
    // At least one identity field must be present — an empty locator matches
    // everything, which is exactly the bug class the contract prevents.
    // A recorded rich `Target` (`{ primary, fallbacks }`, the shape generation
    // actually emits) counts too: its specs are resolvable by the observer even
    // though they carry no locator fields, and refusing them silently deleted
    // whole success criteria — an unverified step reported as a passed one.
    const hasIdentity =
      typeof target['role'] === 'string' ||
      typeof target['accessibleName'] === 'string' ||
      typeof target['text'] === 'string' ||
      typeof target['label'] === 'string' ||
      typeof target['placeholder'] === 'string' ||
      typeof target['testId'] === 'string' ||
      isRecord(target['stableAttributes']) ||
      hasResolvableSpec(target['primary']) ||
      (Array.isArray(target['fallbacks']) && target['fallbacks'].some(hasResolvableSpec))
    if (!hasIdentity) return false
  }
  if (kind === 'elementText') {
    if (typeof value['expected'] !== 'string') return false
    if (value['match'] !== undefined && value['match'] !== 'exact' && value['match'] !== 'contains') {
      return false
    }
  }
  if (kind === 'attributeEquals') {
    if (typeof value['name'] !== 'string' || typeof value['expected'] !== 'string') return false
  }
  if (kind === 'urlContains' || kind === 'urlMatches') {
    if (typeof value['value'] !== 'string' || !value['value'].trim()) return false
  }
  if (kind === 'variableExists') {
    if (typeof value['name'] !== 'string' || !value['name'].trim()) return false
  }
  if (kind === 'variableEquals') {
    if (typeof value['name'] !== 'string' || !value['name'].trim()) return false
  }
  if (kind === 'count') {
    if (typeof value['value'] !== 'number') return false
    if (value['op'] !== 'eq' && value['op'] !== 'gte' && value['op'] !== 'lte') return false
  }
  return true
}

/**
 * Unwrap a model-authored condition value into a LIST, judging only its shape.
 *
 * The list is JSON from a generation model, and three shapes arrive in practice:
 * a proper array, a single bare condition, and a one-element array serialized
 * as an object (`{item: {…}}`, `{"0": {…}}`). The last two would otherwise be
 * dropped without a trace, taking a step's whole claim about what it achieved
 * with them. Members are returned unvalidated — pair with
 * {@link isWorkflowCondition} or a looser check, per consumer.
 */
export function conditionListValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  if (typeof value['kind'] === 'string') return [value]
  const entries = Object.values(value)
  if (
    entries.length > 0 &&
    entries.every((entry) => isRecord(entry) && typeof entry['kind'] === 'string')
  ) {
    return entries
  }
  return []
}

/** Narrow an untrusted list to valid conditions, dropping the rest. */
export function workflowConditionsOf(value: unknown): WorkflowCondition[] {
  return conditionListValue(value).filter(isWorkflowCondition)
}

/** One-line human-readable form, for validator messages and run logs. */
export function describeCondition(condition: WorkflowCondition): string {
  switch (condition.kind) {
    case 'urlContains':
      return `URL 包含 "${condition.value}"`
    case 'urlMatches':
      return `URL 匹配 "${condition.value}"`
    case 'elementExists':
      return `元素存在 ${describeConditionTarget(condition.target)}`
    case 'elementVisible':
      return `元素可见 ${describeConditionTarget(condition.target)}`
    case 'elementEnabled':
      return `元素可点 ${describeConditionTarget(condition.target)}`
    case 'elementText':
      return `文本${
        condition.match === 'exact' ? '等于' : '包含'
      } "${condition.expected}"（${describeConditionTarget(condition.target)}）`
    case 'attributeEquals':
      return `属性 ${condition.name}="${condition.expected}"（${describeConditionTarget(
        condition.target,
      )}）`
    case 'variableEquals':
      return `变量 ${condition.name} = ${JSON.stringify(condition.expected) ?? '?'}`
    case 'variableExists':
      return `变量 ${condition.name} 存在`
    case 'count':
      return `元素数量 ${condition.op} ${condition.value}（${describeConditionTarget(
        condition.target,
      )}）`
    case 'urlChanged':
      return 'URL 已离开原页面'
    case 'elementGone':
      return `元素已消失 ${describeConditionTarget(condition.target)}`
    case 'elementAppeared':
      return `元素新出现 ${describeConditionTarget(condition.target)}`
    case 'countIncreased':
      return `元素数量增加（${describeConditionTarget(condition.target)}）`
  }
}

/**
 * Does a condition reference ONLY variable conditions? A pure-variable
 * condition is checkable without a page — useful when a workflow is verified
 * offline (import validation, resume guards).
 */
export function isVariableOnlyCondition(condition: WorkflowCondition): boolean {
  return condition.kind === 'variableEquals' || condition.kind === 'variableExists'
}

/**
 * Hard conditions: facts the run can be held to without any interpretation.
 *
 * Everything else is SOFT, and a soft condition that does not hold must never
 * fail a step. The reason is the whole point of the reliability contract being
 * introduced to a replay: a step the agent demonstrably performed, that the
 * executor reports as done, and whose only sin is that a page phrase the
 * generator guessed is worded differently on a later day, is a step that WORKS.
 * Failing it turns a passing workflow into a failing one — the exact trade the
 * project must not make. A soft miss is recorded as evidence that this run is
 * UNVERIFIED and as the trigger for a wider retry; it is not an error.
 *
 * `attributeEquals` is hard because it is a fact about a control the step just
 * touched (a checkbox that did not check, an option that did not select) — the
 * executor's own success claim, not a guess about business outcomes.
 */
export function isHardCondition(condition: WorkflowCondition): boolean {
  return (
    condition.kind === 'variableExists' ||
    condition.kind === 'variableEquals' ||
    condition.kind === 'attributeEquals'
  )
}

/** The conditions whose verdict needs an observation from before the step. */
export function conditionRequiresBaseline(condition: WorkflowCondition): boolean {
  return (
    condition.kind === 'urlChanged' ||
    condition.kind === 'elementGone' ||
    condition.kind === 'elementAppeared' ||
    condition.kind === 'countIncreased'
  )
}

/**
 * A stable key for a semantic locator, so a baseline captured before the step
 * can be found again after it. Key order is sorted: two writes of the same
 * locator (one from the model, one from a rehydration) must collide.
 */
export function conditionLocatorKey(target: ConditionTarget): string {
  const entries = Object.keys(target)
    .sort()
    .map((key) => `${key}=${JSON.stringify((target as Record<string, unknown>)[key]) ?? ''}`)
  return entries.join(',')
}
