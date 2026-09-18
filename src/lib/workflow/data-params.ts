/**
 * Which block parameters carry BUSINESS DATA, and which are structural.
 *
 * The distinction is the whole point of this module, because the two must be
 * recorded in opposite ways:
 *
 *   - A **structural** parameter is part of the step's identity — a CSS
 *     selector, a `findBy` strategy, the name of the variable to write into,
 *     an HTTP method, a weekday. A literal is the CORRECT form; making one
 *     dynamic would be nonsense (a workflow that clicks `{{selector}}` cannot
 *     be read, let alone replayed).
 *   - A **data** parameter carries a value from the outside world — what to
 *     type into a field, which URL to open, what to POST, what to compare
 *     against. A literal here is *dead data*: it freezes whatever happened to
 *     be true during generation, so the replayed workflow only ever repeats
 *     that one run. These must be recorded as a `{{reference}}`.
 *
 * There is deliberately no third "maybe" bucket. `javascript-code`'s `code` is
 * classified structural because it is program text, not data — but data
 * belongs inside it as `vars.xxx` / `refData`, never as an inline literal, and
 * the operator guide says so.
 *
 * Unknown blocks default to structural: rewriting a parameter this table has
 * never heard of risks corrupting a selector or an imported workflow, and a
 * wrong rewrite is worse than a missed one. New blocks must be added here.
 *
 * Pure data + pure functions (no `chrome`, no storage) so the operator bridge,
 * the run-time validator and the tests all read the SAME table — a second,
 * hand-maintained copy of this knowledge is how the UI and the engine drift
 * apart.
 *
 * @module lib/workflow/data-params
 */

/** One data-bearing parameter of a block. */
export interface DataParamSpec {
  /** Top-level key in the node's `data`. */
  key: string
  /**
   * True when every string leaf anywhere inside this parameter is data
   * (an object or array subtree, e.g. `webhook.body`). False when only the
   * top-level string value itself is data.
   */
  deep?: boolean
  /**
   * For a parameter that is an ARRAY OF OBJECTS: the property of each item
   * that holds the data (e.g. `conditions` rows compare on `right`).
   */
  itemKey?: string
  /**
   * Skip this parameter for a node whose OTHER fields put it in a mode that
   * does not use it. `forms` in "get form value" mode reads a control instead
   * of writing one, so its `value` is not business data there — rewriting a
   * literal into `{{reference}}` would invent a workflow input nobody uses.
   */
  skipWhen?: (data: Record<string, unknown>) => boolean
  /**
   * Exempt from the bulk-content gate (`unproducedBulkData`).
   *
   * The gate exists because a LONG literal is almost always content the model
   * read off the page itself instead of recording a step that reads it — a
   * frozen snapshot masquerading as a workflow. An INSTRUCTION is the one
   * legitimate long literal: it is the user's own words about what to do, not
   * something the page produced, so declaring it as a workflow input is exactly
   * right. Only set this where the value is addressed TO the workflow rather
   * than obtained BY it.
   */
  allowBulk?: boolean
}

/**
 * blockId → its data-bearing parameters.
 *
 * Only blocks reachable from the workflow generator need an entry; every other
 * block is structural by default.
 */
const DATA_PARAMS: Readonly<Record<string, readonly DataParamSpec[]>> = {
  // --- navigation: where to go, and what to send there ---------------------
  'new-tab': [{ key: 'url' }, { key: 'userAgent' }, { key: 'customUserAgent' }],
  'new-window': [{ key: 'url' }],
  'switch-tab': [{ key: 'url' }, { key: 'tabTitle' }, { key: 'matchPattern' }],
  'close-tab': [{ key: 'url' }],
  'tab-url': [{ key: 'qTitle' }, { key: 'qMatchPatterns' }],
  'save-assets': [{ key: 'url' }, { key: 'filename' }],
  'handle-download': [{ key: 'filename' }],
  'take-screenshot': [{ key: 'fileName' }],
  // `read-page` only PRODUCES data — every parameter is structural (which
  // source to read, which element to scope to, how much to keep, where to put
  // it). Listed explicitly rather than left to the unknown-block default so the
  // "no data params" reading is a decision on record, not an omission.
  'read-page': [],
  proxy: [{ key: 'host' }, { key: 'bypassList' }],

  // --- interaction: the values written INTO the page -----------------------
  // `value` is skipped in "get form value" mode: that mode reads the control,
  // so a value there is left over from an earlier edit and freezing it would
  // declare a workflow input nothing consumes.
  forms: [{ key: 'value', skipWhen: (data) => data['getValue'] === true }],
  'get-text': [
    { key: 'prefixText' },
    { key: 'suffixText' },
    { key: 'regexExp' },
    { key: 'extraRowValue' },
  ],
  'attribute-value': [{ key: 'attributeValue' }, { key: 'extraRowValue' }],
  'press-key': [],
  'upload-file': [{ key: 'filePaths', deep: true }],
  'handle-dialog': [{ key: 'promptText' }],
  'create-element': [],

  // --- data plumbing: values the workflow carries --------------------------
  'set-variable': [{ key: 'value' }],
  'insert-data': [{ key: 'dataList', deep: true }],
  'delete-data': [],
  'data-mapping': [{ key: 'sources', deep: true }],
  'sort-data': [],
  'export-data': [{ key: 'name' }],
  'save-local': [{ key: 'value' }, { key: 'filename' }],
  clipboard: [{ key: 'dataToCopy' }],
  'regex-variable': [{ key: 'replaceVal' }],
  'increase-variable': [],
  'slice-variable': [],
  cookie: [
    { key: 'value' },
    { key: 'url' },
    { key: 'domain' },
    { key: 'name' },
    { key: 'path' },
    { key: 'jsonCode' },
  ],

  // --- control flow: the values compared / iterated ------------------------
  conditions: [{ key: 'conditions', itemKey: 'right' }],
  'while-loop': [{ key: 'conditions', itemKey: 'right' }],
  'loop-data': [{ key: 'loopData', deep: true }, { key: 'fromNumber' }, { key: 'toNumber' }],
  'repeat-task': [],

  // --- side effects: what leaves the browser ---------------------------------
  webhook: [{ key: 'url' }, { key: 'body', deep: true }, { key: 'headers', deep: true }],
  notification: [{ key: 'message' }, { key: 'title' }],
  'workflow-state': [{ key: 'errorMessage' }],
  'trigger-event': [{ key: 'eventParams', deep: true }],
  'execute-workflow': [{ key: 'globalData', deep: true }],

  // --- AI ------------------------------------------------------------------
  // The prompt is business data: a frozen instruction is as dead as a frozen
  // search keyword. It is also the one param exempt from the bulk gate — see
  // `allowBulk` — because a long prompt is the user's instruction, not page
  // content the model failed to record a reader for.
  'ai-agent': [{ key: 'prompt', allowBulk: true }],

  // --- trigger -------------------------------------------------------------
  // Nothing is data here. `url` is a MATCH PATTERN (structure), and
  // `parameters` is not data at all — it is where this workflow's inputs are
  // DECLARED, so its `defaultValue` is the declaration's own default and must
  // stay a literal.
  trigger: [],
}

/** The data-bearing parameters of `blockId`, or `[]` for an unknown block. */
export function dataParamSpecs(blockId: string): readonly DataParamSpec[] {
  return DATA_PARAMS[blockId] ?? []
}

/** Does `blockId` treat the top-level `key` as business data? */
export function isDataParam(blockId: string, key: string): boolean {
  return dataParamSpecs(blockId).some((spec) => spec.key === key)
}

/** Does this block have ANY data-bearing parameter? */
export function hasDataParams(blockId: string): boolean {
  return dataParamSpecs(blockId).length > 0
}

/**
 * One place in a node's `data` where a literal would be dead data.
 *
 * `path` is the walk from the top-level key down to the string, so a caller
 * can report or rewrite it precisely (`['conditions', 0, 'right']`).
 */
export interface DataValueSite {
  path: readonly (string | number)[]
  value: string
  /**
   * Copied from the spec that produced this site — see
   * {@link DataParamSpec.allowBulk}. Callers that gate on the SIZE of a
   * literal must honour it, or a long `ai-agent` prompt gets mistaken for
   * un-recorded page content.
   */
  allowBulk?: boolean
}

/** Walk every string leaf under `value`, prefixing each with `path`. */
function collectLeaves(
  value: unknown,
  path: (string | number)[],
  out: DataValueSite[],
  allowBulk: boolean,
): void {
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push({ path, value, ...(allowBulk ? { allowBulk } : {}) })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectLeaves(item, [...path, i], out, allowBulk))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectLeaves(item, [...path, key], out, allowBulk)
    }
  }
}

/**
 * Every string in `data` that this block treats as business data, with the
 * path needed to rewrite it. This is the single source of truth shared by the
 * record-time rewriter and the run-time validator.
 *
 * Empty / whitespace-only values are skipped: there is nothing to freeze, and
 * a blank is more likely a placeholder the user will fill in than data.
 */
export function dataValueSites(blockId: string, data: Record<string, unknown>): DataValueSite[] {
  const out: DataValueSite[] = []
  for (const spec of dataParamSpecs(blockId)) {
    if (spec.skipWhen?.(data)) continue
    const value = data[spec.key]
    if (value === undefined) continue

    if (spec.itemKey !== undefined) {
      // An array of records: only the named property of each item is data.
      if (!Array.isArray(value)) continue
      value.forEach((item, i) => {
        if (item === null || typeof item !== 'object') return
        const leaf = (item as Record<string, unknown>)[spec.itemKey as string]
        if (typeof leaf === 'string' && leaf.trim() !== '') {
          out.push({
            path: [spec.key, i, spec.itemKey as string],
            value: leaf,
            ...(spec.allowBulk ? { allowBulk: true } : {}),
          })
        }
      })
      continue
    }

    if (spec.deep) {
      // A subtree: every string leaf inside it is data.
      collectLeaves(value, [spec.key], out, spec.allowBulk === true)
      continue
    }

    // A plain scalar param: only its own top-level string is data. Deliberately
    // NOT recursing here — an unexpected object in a scalar slot should not
    // silently turn its inner strings into rewritable data.
    if (typeof value === 'string' && value.trim() !== '') {
      out.push({ path: [spec.key], value, ...(spec.allowBulk ? { allowBulk: true } : {}) })
    }
  }
  return out
}
