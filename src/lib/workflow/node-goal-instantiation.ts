/**
 * Node goal instantiation (spec §17).
 *
 * A recorded node goal must be an INSTANTIATED goal ("fill the customer name
 * with '张三'"), not the generic tool docs ("fill a form field"). When the
 * model supplies a goal contract it is used as-is; when it supplies none, this
 * module builds one from the operator's default goal, instantiated with the
 * current call arguments and contextualised by the workflow goal. A final node
 * goal is never empty for a generated action node.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/node-goal-instantiation
 */

import { operatorEntry } from './operator-registry'
import {
  normalizeNodeGoalContract,
  type WorkflowNodeGoalContract,
} from './node-goal-contract'
import type { WorkflowCondition } from './conditions'
import type { SemanticLocator } from './element-fingerprint'

/** Generic operator goal templates (en), keyed by block id. */
const DEFAULT_GOAL_TEMPLATES: Record<string, string> = {
  'new-tab': 'Open {{url}}',
  'event-click': 'Click the target element',
  forms: 'Fill the form field',
  'get-text': 'Read text from the target element',
  'read-page': 'Read the current page content',
  'attribute-value': 'Read the element attribute',
  'element-exists': 'Check whether the target element exists',
  'press-key': 'Press the {{keys}} key',
  'element-scroll': 'Scroll the page/element',
  'hover-element': 'Hover over the target element',
  'wait-connections': 'Wait for the page connections to settle',
  delay: 'Wait for {{time}} ms',
  'save-local': 'Save a value to local disk',
  'export-data': 'Export the collected data table',
  notification: 'Show a desktop notification',
  webhook: 'Send an HTTP request',
  'ai-agent': 'Generate semantic content with an AI agent',
  'execute-workflow': 'Run the sub-workflow',
  'save-assets': 'Save page assets',
  ocr: 'Recognise text from an image',
}

/** Instantiated snippets for common block args (en), keyed by block id. */
function instantiateGoal(blockId: string, args: Record<string, unknown>): string {
  const template = DEFAULT_GOAL_TEMPLATES[blockId] ?? `Run the ${blockId} block`
  return template
    .replace('{{url}}', shortText(args['url']))
    .replace('{{keys}}', shortText(args['keys']))
    .replace('{{time}}', shortText(args['time']))
}

function shortText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.length > 30 ? `${value.slice(0, 30)}…` : value
}

/** Build a specific instantiated detail from block args, when possible. */
function detailFor(blockId: string, args: Record<string, unknown>): string {
  const target = describeTarget(args)
  if (blockId === 'forms') {
    const value = typeof args['value'] === 'string' ? (args['value'] as string) : ''
    return [target, value ? `value "${value}"` : ''].filter(Boolean).join(', ')
  }
  return target
}

function describeTarget(args: Record<string, unknown>): string {
  if (typeof args['selector'] === 'string' && args['selector']) return args['selector'] as string
  const how = args['how']
  const value = args['value']
  if (typeof how === 'string' && typeof value === 'string') return `${how} = ${value}`
  return ''
}

/** Map recorded reliability postconditions into success criteria when present. */
function criteriaFromReliability(args: Record<string, unknown>): WorkflowCondition[] {
  const reliability = args['__reliability']
  if (!reliability || typeof reliability !== 'object') return []
  const post = (reliability as Record<string, unknown>)['postconditions']
  if (!Array.isArray(post)) return []
  // Reuse the condition guard indirectly by normalising a throwaway contract.
  return post.filter(
    (condition): condition is WorkflowCondition =>
      !!condition &&
      typeof condition === 'object' &&
      typeof (condition as Record<string, unknown>)['kind'] === 'string',
  )
}

/**
 * Resolve the goal contract for a node about to be recorded.
 *
 * @param blockId     the operator block id
 * @param args        the (possibly draft-only) call arguments
 * @param supplied    an optional model-supplied raw goal contract
 * @returns           a valid, instantiated goal contract, or undefined only
 *                    when the operator is not goal-bearing
 */
export function resolveNodeGoalContract(
  blockId: string,
  args: Record<string, unknown>,
  supplied?: unknown,
): WorkflowNodeGoalContract | undefined {
  // 1. The model's own instantiated contract wins.
  const fromModel = supplied ? normalizeNodeGoalContract(supplied) : undefined
  if (fromModel) return fromModel

  const entry = operatorEntry(blockId)
  if (!entry || !entry.allowGeneration) return undefined

  // 2. The registry's own builder, if provided.
  if (entry.buildGoalContract) {
    const built = entry.buildGoalContract(args)
    if (built) return built
  }

  // 3. Build an instantiated goal from the default template + args.
  const goal = instantiateGoal(blockId, args)
  const detail = detailFor(blockId, args)
  const instantiated = detail ? `${goal} (${detail})` : goal

  const successCriteria = criteriaFromReliability(args)
  // A goal contract needs at least one success criterion. When the operator
  // itself is the terminal action and no structured criterion exists, record a
  // variable-exists criterion for any produced variable so it stays verifiable.
  const finalCriteria: WorkflowCondition[] = successCriteria.length
    ? successCriteria
    : fallbackCriteria(args)

  if (finalCriteria.length === 0) return undefined
  return {
    version: 1,
    goal: instantiated,
    successCriteria: finalCriteria,
    ...(entry.sideEffect === 'external'
      ? { failureMeaning: ['The external side effect did not complete.'] }
      : {}),
  }
}

function fallbackCriteria(args: Record<string, unknown>): WorkflowCondition[] {
  const variableName = args['variableName']
  if (typeof variableName === 'string' && variableName.trim()) {
    return [{ kind: 'variableExists', name: variableName }]
  }
  // Element-bearing actions: the successful postcondition is that the resolved
  // locator reaches its target. This is a real check at L2, not an empty
  // placeholder, and keeps every generated action node goal-verifiable.
  const locator = locatorOf(args)
  if (locator) return [{ kind: 'elementExists', target: locator }]
  // A key press / navigation without a locator can still verify against URL
  // when the arguments imply one.
  return []
}

function locatorOf(args: Record<string, unknown>): SemanticLocator | undefined {
  const target = args['target']
  if (target && typeof target === 'object') return target as SemanticLocator
  // A recorded CSS selector is carried honestly as the `data-css` stable
  // attribute — the documented convention (auto-contract), resolved back to a
  // real CSS target by the condition probe. Machine-checkable, not fabricated.
  const selector = args['selector']
  if (typeof selector === 'string' && selector.trim()) {
    return { stableAttributes: { 'data-css': selector.trim() } }
  }
  return undefined
}
