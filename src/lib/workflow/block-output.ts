/**
 * Shared handling for the parameter shapes the block editor forms actually
 * write, but the executors used to invent their own names for.
 *
 * These contracts are read by several blocks in both hosts (extension + Runner
 * port), and each host previously kept its own guess at them: the output strip
 * every `Edit*` form renders through `AssignVariable`, the `dataList` bag that
 * arrives either as a real array (editor, tool schema) or as a JSON string
 * (legacy chat-authored nodes), the `switch-tab` tab lookup the port
 * reimplemented around a key nothing writes, the "Scroll element" block's
 * increment checkboxes, and the webhook block's content type / response decoding.
 *
 * @module lib/workflow/block-output
 */
import type { ScrollSpec } from '../ops'
import { getByPath } from './interpolate'

/**
 * Match a tab URL against an Automa-style match pattern (`https://*.example.com/*`).
 * Only `*` is special — everything else is escaped, so a pattern containing
 * regex metacharacters matches them literally.
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(`^${escaped.split('*').join('.*')}$`).test(value)
  } catch {
    return false
  }
}

/** The tab list entry both hosts can build (`switch-tab` needs id, url, title). */
export interface TabCandidate {
  id: number
  url: string
  title: string
}

/**
 * Which tab the editor's `switch-tab` node means, out of the tabs that are open.
 *
 * `EditSwitchTab` writes `findTabBy` ∈ {match-patterns, tab-title, next-tab,
 * prev-tab, tab-index} plus the matching field. Both hosts used to implement
 * this lookup independently, and the port read only `index` — a key nothing
 * writes — so every authored node jumped to tab 0 there. `resolved` carries the
 * host's interpolated field values (interpolation needs the run's variable bag,
 * which this module must not know about).
 */
export function pickTabIndex(
  data: Record<string, unknown>,
  tabs: readonly TabCandidate[],
  currentId: number | undefined,
  resolved: { matchPattern?: string; tabTitle?: string } = {},
): { index: number; byIndex: boolean } {
  const findBy = String(data['findTabBy'] ?? 'match-patterns')
  if (findBy === 'match-patterns') {
    const pattern = resolved.matchPattern ?? ''
    return {
      index: pattern ? tabs.findIndex((tab) => globMatch(pattern, tab.url)) : -1,
      byIndex: false,
    }
  }
  if (findBy === 'tab-title') {
    const title = resolved.tabTitle ?? ''
    return {
      index: title ? tabs.findIndex((tab) => tab.title.includes(title)) : -1,
      byIndex: false,
    }
  }
  if (findBy === 'next-tab' || findBy === 'prev-tab') {
    const at = tabs.findIndex((tab) => tab.id === currentId)
    const step = findBy === 'next-tab' ? 1 : -1
    // Relative to the tab the run is driving; wrap around when it is unknown.
    return { index: at < 0 ? 0 : (at + step + tabs.length) % tabs.length, byIndex: false }
  }
  const wanted = Number(data['tabIndex'] ?? data['index'] ?? 0)
  return { index: Number.isFinite(wanted) ? Math.trunc(wanted) : 0, byIndex: true }
}

/** Write a block result where the editor's "Assign to a variable" strip says. */
export function applyAssignVariable(
  data: Record<string, unknown>,
  variables: Record<string, unknown>,
  value: unknown,
): boolean {
  if (data['assignVariable'] !== true) return false
  const name = String(data['variableName'] ?? '').trim()
  if (name === '') return false
  variables[name] = value
  return true
}

/**
 * Normalize a list parameter into rows.
 *
 * `String()` on an array yields `[object Object]`, which silently parses to
 * nothing — so the array case must be checked before any string handling.
 */
export function readRecordList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch {
      /* malformed json → nothing to insert */
    }
  }
  return []
}

/**
 * Translate the editor's "Select an option by" choice into `select_option` op
 * fields.
 *
 * The positional modes carry no value at all, so an executor that only sends
 * `value` cannot select them; `value`/label matching is the kernel's default and
 * needs no fields back. Lives here because both hosts run the same four options.
 */
export function selectOptionFields(data: Record<string, unknown>): {
  selectBy?: 'first' | 'last' | 'index'
  index?: number
} {
  const by = String(data['selectOptionBy'] ?? 'value')
  if (by === 'first-option') return { selectBy: 'first' }
  if (by === 'last-option') return { selectBy: 'last' }
  if (by === 'custom-position') {
    // The form's "Option position" input is 1-based.
    const position = Number(data['optionPosition'])
    return {
      selectBy: 'index',
      index: Math.max(0, (Number.isFinite(position) ? Math.trunc(position) : 1) - 1),
    }
  }
  return {}
}

/**
 * Keep what the editor's "Text prefix" / "Text suffix" fields wrap.
 *
 * Those two fields are markers, not decoration: the marker text itself is cut
 * off and whatever sits between them is the value (a `$10.50` read with prefix
 * `Price: ` yields the number, not the label). Both read blocks apply it the
 * same way, so the rule lives here.
 */
export function cutBetweenMarkers(text: string, prefix: string, suffix: string): string {
  let kept = text
  if (prefix !== '') {
    const at = kept.indexOf(prefix)
    if (at !== -1) kept = kept.slice(at + prefix.length)
  }
  if (suffix !== '') {
    const at = kept.indexOf(suffix)
    if (at !== -1) kept = kept.slice(0, at)
  }
  return kept
}

/**
 * Order two data items by the block's criteria.
 *
 * A variable source may hold plain strings or numbers, not only table rows, so
 * a named field is read off objects only; `field: ''` means "the item itself".
 */
export function compareDataItems(
  left: unknown,
  right: unknown,
  criteria: readonly { field: string; direction: number }[],
): number {
  for (const { field, direction } of criteria) {
    const va = field === '' ? left : readField(left, field)
    const vb = field === '' ? right : readField(right, field)
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va !== vb) return (va - vb) * direction
      continue
    }
    const order = String(va ?? '').localeCompare(String(vb ?? ''))
    if (order !== 0) return order * direction
  }
  return 0
}

function readField(value: unknown, field: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[field]
    : undefined
}

/**
 * The "Scroll element" block's offset box, shared by both hosts.
 *
 * `incX`/`incY` are the editor's "Increment horizontal/vertical scroll"
 * checkboxes (booleans) and, in chat-authored nodes, the amount to add (numbers);
 * either way that axis is relative, and a number also replaces
 * `scrollX`/`scrollY`. With neither flag the axis is an ABSOLUTE position — which
 * is why `mode: 'to'` exists: the block used to send `mode: 'by'`, so a node
 * saying "scroll to 1500" scrolled 1500 further on every replay.
 */
export function scrollSpecFrom(data: Record<string, unknown>): ScrollSpec {
  const axis = (inc: unknown, offset: number): { value: number; incremental: boolean } =>
    typeof inc === 'number'
      ? { value: inc, incremental: true }
      : { value: offset, incremental: inc === true }
  const x = axis(data['incX'], Number(data['scrollX'] ?? 0))
  const y = axis(data['incY'], Number(data['scrollY'] ?? 0))
  return {
    mode: 'to',
    x: x.value,
    y: y.value,
    smooth: data['smooth'] === true,
    xIncremental: x.incremental,
    yIncremental: y.incremental,
  }
}

/**
 * The webhook block's response contract, shared by both hosts.
 *
 * The form offers a "Content type" select, a "Response type" select
 * (json/text/base64) and a "Data path" field, and "Assign response to a variable"
 * stores the whole response record under the chosen name. The port implemented
 * none of this: it always sent JSON and stored `{status, ok, headers, body}`
 * without the decoded `data`, so `{{resp.data.total}}` resolved in the extension
 * and dangled on the server.
 */

/** Default request `content-type` per the form's "Content type" select. */
const WEBHOOK_CONTENT_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  text: 'text/plain',
  'form-data': 'multipart/form-data',
  form: 'application/x-www-form-urlencoded',
}

export function webhookContentTypeOf(data: Record<string, unknown>): string {
  return WEBHOOK_CONTENT_TYPES[String(data['contentType'] ?? 'json')] ?? 'application/json'
}

/** Parse a response body according to the block's `responseType`. */
function parseResponseBody(text: string, responseType: string): unknown {
  if (responseType !== 'json') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Narrow a parsed body to the block's `dataPath` (`data.items.0.id`). */
function pickDataPath(value: unknown, path: string): unknown {
  const segments = path.split('.').filter((segment) => segment.trim() !== '')
  if (segments.length === 0) return value
  return getByPath(value, segments.join('.'))
}

/** Base64 of a response body, for `responseType: 'base64'`. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** What "Assign response to a variable" stores: the record later `{{var.key}}` reads. */
export interface WebhookResponseRecord {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
  data: unknown
}

/**
 * Read a fetch response the way the webhook block documents it. `base64` consumes
 * the body as bytes, every other type as text; `data` is that text decoded per
 * `responseType` and narrowed by `dataPath`.
 */
export async function webhookRecord(
  response: Response,
  responseType: string,
  dataPath: string,
): Promise<WebhookResponseRecord> {
  const body =
    responseType === 'base64' ? toBase64(await response.arrayBuffer()) : await response.text()
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    body,
    // Additive on purpose: `{{var.body}}` keeps working exactly as before, and
    // `{{var}}` was already `[object Object]`, so nothing that worked stops working.
    data: pickDataPath(parseResponseBody(body, responseType), dataPath),
  }
}
