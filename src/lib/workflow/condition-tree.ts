/**
 * Shared condition-tree evaluation.
 *
 * The workflow editor stores `conditions` (the branch block) and `while-loop`
 * conditions as an OR-group tree of builder items:
 *
 *   Group   = { id, conditions: AndRow[] }             // groups are OR-ed
 *   AndRow  = { id, items: BuilderItem[] }             // items are AND-ed
 *   Item    = { category: 'compare', type } | { category: 'value', type, data }
 *
 * The engine and both executor layers used to read a *flat* `{ name, compare,
 * value }` row instead, which the editor never writes — so any condition built
 * in the editor matched every row by accident (`'' === ''`) and the branch
 * block always took its true output, while a while-loop built in the editor
 * never iterated at all. This module evaluates the shape the editor actually
 * produces, and keeps the flat row working for generated graphs.
 *
 * Chrome-free by design (`[纪律]` AGENTS.md §5.7): page lookups go through the
 * injected `runCode`, which each runtime wires to its own in-page evaluator.
 *
 * @module lib/workflow/condition-tree
 */

import { getByPath, interpolate } from './interpolate'

/** One builder item: either a comparison operator or a value/lookup. */
export interface ConditionItem {
  id?: string
  category?: string
  type?: string
  data?: Record<string, unknown>
}

/** One AND row — either the editor's item list or the legacy flat row. */
export interface ConditionAndRow {
  id?: string
  items?: ConditionItem[]
  name?: string
  compare?: string
  value?: unknown
  type?: string
}

export interface ConditionGroup {
  id?: string
  name?: string
  conditions?: ConditionAndRow[]
}

export interface ConditionEnv {
  /** Runtime variables — the lookup target for `{{token}}`-free data paths. */
  vars: Record<string, unknown>
  /** The run's last collected reference data, for `{{…}}` tokens in rows. */
  refData?: unknown
  /**
   * Evaluate a single JS *expression* in the page and return its value.
   * Element lookups and `Code` rows go through this; runtimes that have no page
   * (pure-engine tests) may pass a `new Function` shim.
   */
  runCode?: (code: string) => unknown | Promise<unknown>
}

/**
 * Substitute `{{token}}` against the CURRENT variables. A while-loop re-runs
 * this tree every iteration, so the substitution belongs here rather than in
 * the one-shot param interpolation the node entry applies.
 */
function resolveTokens(value: unknown, env: ConditionEnv): unknown {
  if (typeof value !== 'string' || !value.includes('{{')) return value
  return interpolate(value, env.vars, env.refData)
}

/** Value types that decide on their own, without a comparison. */
const STANDALONE_VALUE_TYPES = new Set([
  'code',
  'data#exists',
  'element#exists',
  'element#notExists',
  'element#visible',
  'element#invisible',
  'element#visibleScreen',
])

/** Whether `groups` is a non-empty condition tree. */
export function hasConditionGroups(groups: unknown): boolean {
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        !!group &&
        typeof group === 'object' &&
        Array.isArray((group as ConditionGroup).conditions) &&
        ((group as ConditionGroup).conditions?.length ?? 0) > 0,
    )
  )
}

/** OR over the groups; a group holds when all of its rows hold. */
export async function conditionGroupsMatch(
  groups: unknown,
  env: ConditionEnv,
): Promise<boolean> {
  if (!Array.isArray(groups)) return false
  for (const group of groups) {
    const rows = (group as ConditionGroup | null)?.conditions
    if (!Array.isArray(rows) || rows.length === 0) continue
    let all = true
    for (const row of rows) {
      if (!(await conditionRowMatches(row as ConditionAndRow, env))) {
        all = false
        break
      }
    }
    if (all) return true
  }
  return false
}

/** Evaluate one row: the editor's item list, or the legacy flat `{name,compare,value}`. */
async function conditionRowMatches(
  row: ConditionAndRow,
  env: ConditionEnv,
): Promise<boolean> {
  if (!row || typeof row !== 'object') return false
  if (Array.isArray(row.items)) return evaluateBuilderRow(row.items, env)
  return evaluateFlatRow(row, env)
}

async function evaluateBuilderRow(items: ConditionItem[], env: ConditionEnv): Promise<boolean> {
  const valueItems = items.filter((item) => item?.category !== 'compare')
  const compareItem = items.find((item) => item?.category === 'compare')

  // A standalone value (code / exists / visibility …) answers for the whole row.
  const only = valueItems[0]
  if (valueItems.length === 1 && only && STANDALONE_VALUE_TYPES.has(only.type ?? '')) {
    return truthy(await resolveValueItem(only, env))
  }

  const left = valueItems[0]
  const right = valueItems[valueItems.length - 1]
  if (!left || !compareItem) return false
  const leftValue = await resolveValueItem(left, env)
  if (right === left && STANDALONE_VALUE_TYPES.has(left.type ?? '')) return truthy(leftValue)
  const rightValue = right ? await resolveLiteral(right, env) : undefined
  return applyCompare(String(compareItem.type ?? ''), leftValue, rightValue)
}

/** Turn one value item into the thing to compare (or its own boolean answer). */
async function resolveValueItem(item: ConditionItem, env: ConditionEnv): Promise<unknown> {
  const type = String(item?.type ?? '')
  const data = item?.data ?? {}
  const selector = String(resolveTokens(data['selector'], env) ?? '')

  switch (type) {
    case 'value':
      return resolveTokens(data['value'], env)
    case 'code':
      return runInPage(env, functionBody(data['code']))
    case 'data#exists': {
      const path = String(resolveTokens(data['dataPath'], env) ?? '')
      return path !== '' && getByPath(env.vars, path) !== undefined
    }
    case 'element#exists':
      return runInPage(env, `document.querySelectorAll(${jsStr(selector)}).length > 0`)
    case 'element#notExists':
      return runInPage(env, `document.querySelectorAll(${jsStr(selector)}).length === 0`)
    case 'element#visible':
      return runInPage(env, visibleCheck(selector, false, false))
    case 'element#invisible':
      return runInPage(env, visibleCheck(selector, false, true))
    case 'element#visibleScreen':
      return runInPage(env, visibleCheck(selector, true, false))
    case 'element#text':
      return runInPage(
        env,
        `(() => { const el = document.querySelector(${jsStr(selector)});` +
          ` return el ? (el.textContent ?? '') : '' })()`,
      )
    case 'element#attribute':
      return runInPage(
        env,
        `(() => { const el = document.querySelector(${jsStr(selector)});` +
          ` const v = el ? el.getAttribute(${jsStr(String(data['attrName'] ?? ''))}) : null;` +
          ` return v === null ? '' : v })()`,
      )
    default:
      throw new Error(`conditions: 不支持的条件类型「${type || '(空)'}」`)
  }
}

/** The right-hand side of a comparison: a literal value, or a page lookup. */
async function resolveLiteral(item: ConditionItem, env: ConditionEnv): Promise<unknown> {
  const type = String(item?.type ?? '')
  if (type === 'value' || type === '') return item?.data?.['value']
  return resolveValueItem(item, env)
}

function evaluateFlatRow(row: ConditionAndRow, env: ConditionEnv): boolean {
  const name = typeof row.name === 'string' ? row.name : ''
  const right = resolveTokens(row.value, env)
  const left = name !== '' ? env.vars[name] : right
  const present = left !== undefined && left !== null && left !== ''
  switch (row.compare ?? '') {
    case 'nq':
    case 'not-exists':
    case 'not-visible':
      return !present
    case 'exists':
    case 'visible':
    case 'visible-screen':
      return present
    case 'itr':
      return Boolean(left)
    case 'ifl':
      return !left
    default:
      // The comparison ids are shared with the builder rows; reuse that logic
      // so a generated graph and a canvas graph answer the same way.
      return applyCompare(row.compare ?? 'eq', left, right)
  }
}

/** The Automa comparison set, over values already resolved to literals. */
export function applyCompare(compare: string, left: unknown, right: unknown): boolean {
  const leftText = String(left ?? '')
  const rightText = String(right ?? '')
  switch (compare) {
    case 'eq':
    case 'eql':
      if (typeof left === 'number' || typeof right === 'number') {
        return Number(left) === Number(right)
      }
      if (typeof left === 'boolean' || typeof right === 'boolean') {
        return Boolean(left) === Boolean(right) || leftText === rightText
      }
      return leftText === rightText
    case 'eqi':
      return leftText.toLowerCase() === rightText.toLowerCase()
    case 'nq':
      return !applyCompare('eq', left, right)
    case 'gt':
      return Number(left) > Number(right)
    case 'gte':
      return Number(left) >= Number(right)
    case 'lt':
      return Number(left) < Number(right)
    case 'lte':
      return Number(left) <= Number(right)
    case 'cnt':
    case 'contains':
      return leftText.includes(rightText)
    case 'cni':
      return leftText.toLowerCase().includes(rightText.toLowerCase())
    case 'nct':
      return !leftText.includes(rightText)
    case 'nci':
      return !leftText.toLowerCase().includes(rightText.toLowerCase())
    case 'stw':
      return leftText.startsWith(rightText)
    case 'enw':
      return leftText.endsWith(rightText)
    case 'rgx': {
      try {
        return new RegExp(rightText).test(leftText)
      } catch {
        return false
      }
    }
    case 'itr':
      return Boolean(left)
    case 'ifl':
      return !left
    default:
      return applyCompare('eq', left, right)
  }
}

function truthy(value: unknown): boolean {
  if (typeof value === 'string') return value !== '' && value !== 'false'
  return Boolean(value)
}

/** The editor's `Code` rows are function bodies; the page hook takes one expression. */
function functionBody(code: unknown): string {
  return `(() => { ${String(code ?? '')} })()`
}

function visibleCheck(selector: string, inViewport: boolean, negate: boolean): string {
  const sel = jsStr(selector)
  const test = inViewport
    ? 'r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth'
    : 'el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0'
  return (
    `(() => { const el = document.querySelector(${sel});` +
    ` if (!el) return ${negate ? 'true' : 'false'};` +
    ` const r = el.getBoundingClientRect();` +
    ` return ${negate ? '!' : ''}(${test}) })()`
  )
}

async function runInPage(env: ConditionEnv, source: string): Promise<unknown> {
  if (!env.runCode) {
    throw new Error('conditions: 当前运行环境无法在页面中求值，条件项无法判断')
  }
  return env.runCode(source)
}

/** A JS string literal for a page-supplied selector — no injection. */
function jsStr(value: string): string {
  return JSON.stringify(value)
}
