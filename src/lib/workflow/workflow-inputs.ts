/**
 * Workflow inputs: reading the declarations, and turning them into the variable
 * scope a run starts with.
 *
 * A generated workflow records `{{keyword}}` instead of the keyword it observed
 * (see `dynamic-data`). Something has to make that reference resolve, and this
 * module is that something: it reads the `parameters` a workflow declares — on
 * its trigger, or on a `parameter-prompt` block — and seeds the run's variable
 * scope from their defaults.
 *
 * Why the defaults matter: no caller passes `variables` into `executeWorkflow`,
 * so without this the scope starts empty and every recorded reference would
 * resolve to an empty string. Seeding from `defaultValue` is what keeps a
 * generated workflow runnable exactly as generated while the value stays
 * visible and editable on the trigger.
 *
 * Declared values are only DEFAULTS. Anything already in the scope wins, so a
 * trigger payload (a `visit-web` query, a Feishu command argument) or an
 * earlier step's output overrides them without a special case.
 *
 * Pure functions — no `chrome` — so the engine, the operator bridge and the
 * tests share one reading of the declaration shape.
 *
 * @module lib/workflow/workflow-inputs
 */

import type { WorkflowParameter, WorkflowTrigger } from './types'

/** The parameter types the editor offers; anything else is treated as a string. */
const PARAM_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'json', 'checkbox'])

/**
 * Read a `parameters` value into a usable list.
 *
 * Tolerant on purpose: this reads data an older import or a hand-edited graph
 * may have written, so an entry missing a `type` is repaired rather than
 * dropped — losing a declared input would silently break the references that
 * depend on it.
 */
export function workflowParametersOf(value: unknown): WorkflowParameter[] {
  if (!Array.isArray(value)) return []
  const out: WorkflowParameter[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = record['name']
    if (typeof name !== 'string' || name.trim() === '') continue
    const rawType = record['type']
    const type = typeof rawType === 'string' && PARAM_TYPES.has(rawType) ? rawType : 'string'
    const param: WorkflowParameter = { name: name.trim(), type }
    if (typeof record['id'] === 'string') param.id = record['id']
    if (typeof record['description'] === 'string') param.description = record['description']
    if (typeof record['defaultValue'] === 'string') param.defaultValue = record['defaultValue']
    if (typeof record['placeholder'] === 'string') param.placeholder = record['placeholder']
    if (record['secret'] === true) param.secret = true
    if (record['data'] !== null && typeof record['data'] === 'object') {
      param.data = record['data'] as WorkflowParameter['data']
    }
    out.push(param)
  }
  return out
}

/** Is this declaration marked required? Absent metadata means "not required". */
export function isRequiredInput(param: WorkflowParameter): boolean {
  return param.data?.['required'] === true
}

/**
 * Coerce a declared default into the value the scope should hold.
 *
 * `defaultValue` is stored as text (it is what the editor's input shows), so a
 * `number` param would otherwise put the STRING `'10'` in the scope and any
 * executor doing `+` would concatenate. `checkbox` maps `'true'` / `'false'` to
 * a real boolean for the same reason. A value that cannot be coerced falls back
 * to the raw text rather than becoming `NaN`.
 */
export function coerceInputValue(param: WorkflowParameter, raw: string): unknown {
  switch (param.type) {
    case 'number': {
      const n = Number(raw)
      return Number.isFinite(n) ? n : raw
    }
    case 'checkbox':
      return raw === 'true' || raw === '1'
    case 'json': {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }
    default:
      return raw
  }
}

/**
 * The variable scope a run should START with, built from a workflow's declared
 * inputs.
 *
 * Only declarations that actually carry a default are seeded: an input with no
 * default has nothing to contribute, and inventing an empty string for it would
 * hide the "this workflow needs a value nobody supplied" problem behind a
 * silently blank field — exactly the failure mode this whole mechanism exists
 * to remove.
 */
export function seedInputs(parameters: readonly WorkflowParameter[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const param of parameters) {
    const raw = param.defaultValue
    if (typeof raw !== 'string' || raw === '') continue
    out[param.name] = coerceInputValue(param, raw)
  }
  return out
}

/** The declared inputs of a workflow, read from its trigger mirror. */
export function triggerInputs(trigger: WorkflowTrigger | undefined): WorkflowParameter[] {
  return workflowParametersOf(trigger?.parameters)
}

/**
 * Merge the trigger's declared defaults UNDER an existing scope, so anything
 * the caller or an earlier step already produced wins.
 */
export function seedFromTrigger(
  trigger: WorkflowTrigger | undefined,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const seeded = seedInputs(triggerInputs(trigger))
  if (Object.keys(seeded).length === 0) return existing ?? {}
  return { ...seeded, ...(existing ?? {}) }
}

/**
 * Declared inputs that are required but still have no value.
 *
 * Returned rather than thrown so the caller can decide: the `parameter-prompt`
 * executor fails the step on these, because continuing would drive the page
 * with a blank value the user never intended.
 */
export function missingRequiredInputs(
  parameters: readonly WorkflowParameter[],
  variables: Readonly<Record<string, unknown>>,
): string[] {
  return parameters
    .filter((param) => isRequiredInput(param))
    .filter((param) => {
      const value = variables[param.name]
      return value === undefined || value === null || value === ''
    })
    .map((param) => param.name)
}
