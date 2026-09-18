/**
 * Guard: every parameter the operator tool schema advertises is one the block's
 * executor actually reads.
 *
 * This is the failure mode that produced four separate bugs in one sitting —
 * `get-text`'s collect trio, `export-data`'s whole field set, `switch-tab`'s
 * `tabIndex`, and the guide's category column. A parameter name has to agree
 * across FOUR places: `blocks/catalog.ts` defaults, the `EditForms` key, the
 * operator guide / tool schema the model is taught, and the key `EXECUTORS`
 * actually reads. Three agreeing while the fourth differs leaves the whole
 * panel silently inert, and nothing catches it: the catalog is data, the guide
 * is a template string, and `tsc` sees neither.
 *
 * The model-facing half of that is what this test pins. If the schema teaches a
 * parameter nothing reads, the model will send it, the node will record it, and
 * the saved workflow will quietly not do what it says.
 *
 * WHY IT PARSES SOURCE: an executor's reads are not declared anywhere — they are
 * just property accesses inside the function body — so there is nothing to
 * import. The alternative is a hand-maintained table, which would drift in
 * exactly the way this test exists to prevent. Reads are resolved transitively
 * through the file's own top-level helpers (`withWait`, `publishRead`,
 * `collectIntoDataTable`, `targetFrom`, …), because most executors do their
 * reading through one of those.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { BLOCK_CATALOG } from '../src/lib/workflow/blocks/catalog'
import {
  UI_ONLY_KEYS,
  dataSchemaFromEntry,
  isOperatorTool,
  operatorToolName,
} from '../src/lib/workflow/operator-tools'

const SOURCE = readFileSync('src/background/workflow-engine/executors.ts', 'utf8')

/**
 * Executor bodies that belong to the ENGINE rather than to a block: triggers
 * are consumed by the trigger subsystem, loops by the loop driver, and
 * `execute-workflow` by the run scheduler. Their parameters are real, they are
 * just not read by an executor — so they are not mismatches.
 */
const ENGINE_SERVED_EXECUTORS = new Set(['noop', 'placeholder'])

/**
 * Advertised parameters no executor reads yet. Every entry is a block whose
 * edit form offers a control that does nothing — the same defect as the four
 * fixed above, just not fixed yet. Kept explicit so the drift is visible and
 * reviewable instead of silent; the staleness check below fails once a key
 * starts being honoured, so entries cannot rot here.
 *
 * Grouped by why they are still inert:
 *
 * - `port-not-implemented`: the block is an Automa import whose executor was
 *   never ported (it reads one or two keys and ignores the rest).
 * - `catalog-only`: declared for Automa graph compatibility, with no edit-form
 *   field and no executor read — dead data rather than a broken control.
 * - `engine-or-kernel`: read by the in-page kernel or the trigger subsystem
 *   rather than by the background executor.
 */
const KNOWN_INERT: Readonly<Record<string, readonly string[]>> = {
  'new-tab': ['userAgent', 'active', 'tabZoom', 'inGroup', 'updatePrevTab', 'customUserAgent'],
  'new-window': ['top', 'left', 'width', 'height', 'type', 'incognito', 'windowState'],
  proxy: ['scheme', 'host', 'port', 'bypassList', 'clearProxy'],
  'close-tab': ['url', 'activeTab', 'closeType', 'allWindows'],
  'take-screenshot': ['fullPage', 'captureActiveTab'],
  'browser-event': [
    'timeout',
    'eventName',
    'setAsActiveTab',
    'activeTabLoaded',
    'tabLoadedUrl',
    'tabUrl',
    'fileQuery',
  ],
  'get-text': [
    'findBy',
    'waitForSelector',
    'waitSelectorTimeout',
    'regex',
    'prefixText',
    'suffixText',
    'regexExp',
    'addExtraRow',
    'extraRowValue',
    'extraRowDataColumn',
  ],
  'element-scroll': ['incX', 'incY'],
  link: ['findBy', 'disableMultiple', 'openInNewTab'],
  'attribute-value': [
    'waitForSelector',
    'waitSelectorTimeout',
    'attributeValue',
    'attributeName',
    'action',
    'addExtraRow',
    'extraRowValue',
    'extraRowDataColumn',
  ],
  forms: ['selected', 'selectOptionBy', 'optionPosition', 'delay'],
  'javascript-code': ['context', 'preloadScripts', 'everyNewTab', 'runBeforeLoad'],
  'trigger-event': [
    'waitForSelector',
    'waitSelectorTimeout',
    'eventName',
    'eventType',
    'eventParams',
  ],
  conditions: ['retryConditions', 'retryCount', 'retryTimeout'],
  'element-exists': ['findBy', 'tryCount', 'timeout', 'throwError'],
  clipboard: ['type', 'dataToCopy', 'copySelectedText'],
  'insert-data': ['dataList'],
  'switch-to': ['findBy', 'selector', 'windowType'],
  'upload-file': ['findBy', 'waitForSelector', 'waitSelectorTimeout', 'filePaths'],
  'save-assets': [
    'findBy',
    'waitForSelector',
    'waitSelectorTimeout',
    'selector',
    'type',
    'url',
    'filename',
    'saveDownloadIds',
    'variableName',
    'saveToGDrive',
  ],
  'press-key': ['selector', 'pressTime', 'action'],
  'handle-dialog': ['accept', 'promptText'],
  'handle-download': ['timeout', 'waitForDownload', 'downloadId'],
  'delete-data': ['deleteList'],
  'wait-connections': ['specificFlow', 'flowBlockId'],
  notification: ['iconUrl', 'imageUrl'],
  'log-data': ['workflowId', 'variableName'],
  'tab-url': ['type', 'qTitle', 'qMatchPatterns'],
  'data-mapping': ['dataSource', 'sources', 'varSourceName', 'variableName'],
  'sort-data': ['sortByProperty', 'itemProperties', 'dataSource', 'varSourceName', 'variableName'],
  'create-element': [
    'javascript',
    'css',
    'preloadScripts',
    'findBy',
    'insertAt',
    'runBeforeLoad',
    'waitForSelector',
    'waitSelectorTimeout',
    'selector',
  ],
  cookie: [
    'type',
    'jsonCode',
    'useJson',
    'getAll',
    'domain',
    'path',
    'sameSite',
    'httpOnly',
    'secure',
    'session',
  ],
  'workflow-state': ['type', 'exceptCurrent', 'workflowsToStop', 'throwError', 'errorMessage'],
  'parameter-prompt': ['timeout'],
}

/** name -> body, for every top-level declaration in the executors module. */
function topLevelBodies(): Map<string, string> {
  const re = /^(?:export )?(?:const|function|type|interface) (\w+)/gm
  const marks: { name: string; start: number }[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(SOURCE)) !== null) marks.push({ name: match[1]!, start: match.index })
  const bodies = new Map<string, string>()
  marks.forEach((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1]!.start : SOURCE.length
    bodies.set(mark.name, SOURCE.slice(mark.start, end))
  })
  return bodies
}

const BODIES = topLevelBodies()

/** Keys read off a `data` parameter, via `data['x']` or `data.x`. */
function literalReads(body: string): Set<string> {
  const keys = new Set<string>()
  const re = /data(?:\[['"]([\w-]+)['"]\]|\.([\w-]+))/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) keys.add(match[1] ?? match[2]!)
  return keys
}

/** Top-level declarations a body calls. */
function callees(body: string): string[] {
  const found: string[] = []
  for (const name of BODIES.keys()) {
    if (name === 'data') continue
    if (new RegExp(`\\b${name}\\s*\\(`).test(body)) found.push(name)
  }
  return found
}

const readCache = new Map<string, Set<string>>()

/** A declaration's own reads plus every callee's, transitively. */
function readsOf(name: string, seen = new Set<string>()): Set<string> {
  const cached = readCache.get(name)
  if (cached) return cached
  if (seen.has(name)) return new Set()
  seen.add(name)
  const body = BODIES.get(name)
  if (body === undefined) return new Set()
  const keys = literalReads(body)
  for (const callee of callees(body)) for (const key of readsOf(callee, seen)) keys.add(key)
  readCache.set(name, keys)
  return keys
}

/** blockId -> executor variable name, out of the `EXECUTORS` map. */
function executorVarOf(): Map<string, string> {
  const tail = SOURCE.slice(SOURCE.indexOf('export const EXECUTORS'))
  const out = new Map<string, string>()
  // The value is either a bare identifier (`click: click,`) or a factory call
  // (`'loop-data': placeholder('loop-data'),`), so the separator after it can be
  // a comma OR an open paren — requiring a comma silently dropped every
  // factory-built entry, which would let the coverage guard skip those blocks.
  const re = /^\s{2}'?([\w-]+)'?:\s*(\w+)[,(]/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(tail)) !== null) out.set(match[1]!, match[2]!)
  return out
}

const EXECUTOR_VAR = executorVarOf()

/** Advertised schema keys of one block, in declaration order. */
function advertisedKeys(blockId: string): string[] {
  const entry = BLOCK_CATALOG.find((candidate) => candidate.id === blockId)
  if (!entry) return []
  const schema = dataSchemaFromEntry(entry)
  return Object.keys((schema['properties'] as Record<string, unknown>) ?? {})
}

describe('operator parameter coverage', () => {
  it('never advertises a parameter its executor does not read', () => {
    const offenders: string[] = []
    for (const entry of BLOCK_CATALOG) {
      if (!isOperatorTool(operatorToolName(entry.id))) continue
      const varName = EXECUTOR_VAR.get(entry.id)
      if (varName === undefined || ENGINE_SERVED_EXECUTORS.has(varName)) continue
      const read = readsOf(varName)
      const allowed = new Set([...read, ...(KNOWN_INERT[entry.id] ?? [])])
      const declared = new Set(Object.keys(entry.data ?? {}))
      const bad = advertisedKeys(entry.id).filter((key) => declared.has(key) && !allowed.has(key))
      if (bad.length) offenders.push(`${entry.id}: ${bad.join(', ')}`)
    }
    expect(
      offenders,
      'these parameters are advertised to the model but nothing reads them — either wire ' +
        'them up in the executor or add them to UI_ONLY_KEYS / KNOWN_INERT',
    ).toEqual([])
  })

  it('re-advertises a UI-only key only when the executor honours it', () => {
    // `dataSchemaFromEntry` filters UI_ONLY_KEYS out, but `SCHEMA_OVERRIDES` is
    // merged in AFTER that filter — so an override that lists a UI-only key
    // silently re-advertises it. `saveMode` shipped that way, described to the
    // model as "`manual` asks" while the executor ignored it entirely.
    //
    // The collect trio is the legitimate case: `get-text` / `read-page` do read
    // `multiple` / `saveData` / `dataColumn`, so re-exposing them is the point.
    const leaked: string[] = []
    for (const entry of BLOCK_CATALOG) {
      if (!isOperatorTool(operatorToolName(entry.id))) continue
      const varName = EXECUTOR_VAR.get(entry.id)
      const read = varName === undefined ? new Set<string>() : readsOf(varName)
      for (const key of advertisedKeys(entry.id)) {
        if (UI_ONLY_KEYS.has(key) && !read.has(key)) leaked.push(`${entry.id}.${key}`)
      }
    }
    expect(leaked, 'UI-only keys advertised without the executor reading them').toEqual([])
  })

  it('keeps no stale entries in the known-inert list', () => {
    const stale: string[] = []
    for (const [blockId, keys] of Object.entries(KNOWN_INERT)) {
      const varName = EXECUTOR_VAR.get(blockId)
      if (varName === undefined) {
        stale.push(`${blockId}: block is not wired to an executor at all`)
        continue
      }
      const read = readsOf(varName)
      const advertised = new Set(advertisedKeys(blockId))
      for (const key of keys) {
        if (read.has(key)) stale.push(`${blockId}.${key}: the executor reads it now — remove`)
        else if (!advertised.has(key)) {
          stale.push(`${blockId}.${key}: no longer advertised — remove`)
        }
      }
    }
    expect(stale, 'KNOWN_INERT entries that are no longer inert').toEqual([])
  })

  it('covers every block that is wired to an executor', () => {
    // A block with an executor but no operator tool is fine (a canvas-only
    // block); the reverse — an operator tool with no executor — is not.
    const orphaned = BLOCK_CATALOG.filter(
      (entry) => isOperatorTool(operatorToolName(entry.id)) && !EXECUTOR_VAR.has(entry.id),
    ).map((entry) => entry.id)
    expect(orphaned, 'operator tools with no registered executor').toEqual([])
  })
})
