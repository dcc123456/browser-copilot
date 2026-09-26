/**
 * Per-block REQUIRED parameters — the one table every gate reads.
 *
 * The workflow-generation contract was "record only what ran successfully",
 * but several executors succeed on empty parameters: `element-exists` with no
 * locator reports "元素不存在" and the empty node gets recorded, a rich target
 * whose specs are all empty matches every element, `press-key` with no key
 * presses nothing. This module is the fix at the CONTRACT level: for every
 * block, which parameters the step cannot work without — enforced by
 *
 *   1. the record gate (`background/operator-tool-run` and the non-executing
 *      `background/operator-tool-handler` path) — a call missing one is
 *      refused BEFORE the page is touched and nothing is recorded;
 *   2. the LLM tool schema (`lib/workflow/operator-tools`) — unconditional
 *      requirements become JSON-Schema `required`, so the model is told the
 *      contract in round one;
 *   3. the run gate (`lib/workflow/validation.validateWorkflowForRun`) — the
 *      same checks as ERRORS for every workflow, whatever path produced it.
 *
 * Modelled on `data-params.ts`: pure data + pure functions (no `chrome`), so
 * the background bridge, the tool catalogue and the tests all read the SAME
 * table. An unknown block has no requirements — a hand-built or imported block
 * this table has never heard of must not be blocked, only a known contract can
 * be enforced. New blocks must be added here.
 *
 * @module lib/workflow/block-requirements
 */

import { richTargetFromAny } from './target-to-selector'

/** One missing-parameter finding. `key` is the parameter to blame. */
export interface RequirementProblem {
  key: string
  /** What to do about it, phrased as a fix, not a complaint. */
  message: string
}

/** A parameter that must be filled (non-empty) for the step to work. */
interface RequiredParam {
  key: string
  message: string
  /** Only required when this predicate holds (e.g. `forms` write mode). */
  when?: (data: Record<string, unknown>) => boolean
  /**
   * The value must carry a `{{reference}}` — the parameter is a CONTENT sink
   * whose literal form would freeze generation-time data (`save-local.value`).
   */
  mustReference?: boolean
}

/** Everything a block demands, in one place. */
interface RequirementSet {
  params?: RequiredParam[]
  /** Groups where ANY one filled key satisfies the requirement. */
  anyOf?: { keys: string[]; message: string }[]
  /** The block acts on a page element: `selector` or a valid `target` is mandatory. */
  locator?: string
  /** Bespoke checks (enums, cross-parameter rules) — return a message when unmet. */
  check?: (data: Record<string, unknown>) => string | null
}

/** Is `value` something the step can work with? */
function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/** Does `data` carry a usable element locator (non-empty `selector` or rich `target`)? */
export function hasLocator(data: Record<string, unknown>): boolean {
  const selector = data['selector']
  if (typeof selector === 'string' && selector.trim() !== '') return true
  return richTargetFromAny(data['target']) !== undefined
}

const LOCATOR_MESSAGE =
  '缺少元素定位：请传 snapshot 的 ref，或非空 selector，或 target（primary 的 how 与 value 都必须非空）。' +
  '三者有其一，否则本节点不会记录。'

const REFERENCE_MESSAGE_SUFFIX = '（必须写成 {{引用}}，不能是字面量）'

/** First matching entry of `values`, else null. */
function oneOfEnum(data: Record<string, unknown>, key: string, values: readonly string[]): string | null {
  const raw = data[key]
  if (raw === undefined || raw === null || raw === '') return null
  return values.includes(String(raw)) ? null : `${key} 必须是 ${values.map((v) => `'${v}'`).join(' | ')} 之一`
}

/** Non-empty array (or a JSON string parsing to one) — used by data-list blocks. */
function filledList(data: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const raw = data[key]
    if (Array.isArray(raw) && raw.length > 0) return true
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0) return true
      } catch {
        /* a non-JSON string is not a list; keep looking */
      }
    }
  }
  return false
}

/** The `conditions` block's evaluatable content: a `code` expression or rows. */
function hasConditionsContent(data: Record<string, unknown>): boolean {
  const code = data['code']
  if (typeof code === 'string' && code.trim() !== '') return true
  const groups = data['conditions']
  if (!Array.isArray(groups)) return false
  return groups.some(
    (group) =>
      !!group &&
      typeof group === 'object' &&
      Array.isArray((group as { conditions?: unknown }).conditions) &&
      (group as { conditions: unknown[] }).conditions.length > 0,
  )
}

/**
 * `javascript-code`'s escape-hatch gate (`justification`) stays in the operator
 * bridge, so only `code` is listed here. Declared before the table because the
 * table uses it as a computed key.
 */
const JAVASCRIPT_CODE_BLOCK_ID = 'javascript-code'

/**
 * blockId → its requirements. Only blocks reachable from the workflow
 * generator need an entry; every other block is unconstrained.
 */
const REQUIREMENTS: Readonly<Record<string, RequirementSet>> = {
  // --- interaction ---------------------------------------------------------
  'event-click': { locator: LOCATOR_MESSAGE },
  'hover-element': { locator: LOCATOR_MESSAGE },
  link: { locator: LOCATOR_MESSAGE },
  'element-exists': { locator: LOCATOR_MESSAGE },
  'element-scroll': {
    check: (data) =>
      hasLocator(data) ||
      Number(data['scrollX'] ?? 0) !== 0 ||
      Number(data['scrollY'] ?? 0) !== 0
        ? null
        : '缺少滚动目标：请传元素定位（ref / selector / target），或给出非零的 scrollX / scrollY',
  },
  'get-text': {
    locator: LOCATOR_MESSAGE,
    params: [
      {
        key: 'dataColumn',
        when: (data) => data['saveData'] === true,
        message:
          'saveData:true 时必须填 dataColumn（列名），否则读取不会写入数据表，export-data 将导出空文件',
      },
    ],
  },
  'attribute-value': {
    locator: LOCATOR_MESSAGE,
    params: [{ key: 'attribute', message: '必须填写 attribute（要读取/设置的属性名，如 href、value）' }],
  },
  forms: {
    locator: LOCATOR_MESSAGE,
    params: [
      {
        key: 'value',
        when: (data) => data['getValue'] !== true && !['checkbox', 'radio'].includes(String(data['type'] ?? 'text-field')),
        message: '填写表单必须给 value（要输入/选择的内容；复选框模式除外）',
      },
      {
        key: 'variableName',
        when: (data) => data['getValue'] === true,
        message: '读取表单值（getValue:true）必须给 variableName，读取结果才有地方放',
      },
    ],
    check: (data) => oneOfEnum(data, 'type', ['text-field', 'select', 'checkbox', 'radio']),
  },
  'press-key': {
    anyOf: [
      {
        keys: ['keys', 'keysToPress', 'key'],
        message: '必须给出要按的键（keys，如 Enter / Control+a）',
      },
    ],
  },
  'trigger-event': {
    locator: LOCATOR_MESSAGE,
    params: [{ key: 'event', message: '必须填写 event（要派发的事件名，如 click / input / submit）' }],
  },
  'upload-file': {
    locator: LOCATOR_MESSAGE,
    check: (data) => {
      const mode = data['sourceMode']
      if (mode !== 'user-select' && mode !== 'workflow-file') {
        return "必须给出 sourceMode：'user-select' 或 'workflow-file'"
      }
      if (
        mode === 'workflow-file' &&
        !String(data['fileVariable'] ?? '').trim() &&
        data['fileData'] === undefined
      ) {
        return "workflow-file 模式必须给出 fileVariable（存放文件的变量名）"
      }
      return null
    },
  },
  'create-element': {
    params: [{ key: 'html', message: '必须给 html（要注入页面的元素标记）' }],
  },
  [JAVASCRIPT_CODE_BLOCK_ID]: {
    params: [{ key: 'code', message: '必须给 code（要执行的 JavaScript）' }],
  },

  // --- browser -------------------------------------------------------------
  'new-tab': { params: [{ key: 'url', message: '必须给 url（要打开的网址）' }] },
  'new-window': { params: [{ key: 'url', message: '必须给 url（要打开的网址）' }] },
  'switch-tab': {
    check: (data) => {
      const pattern = data['matchPattern']
      const title = data['tabTitle']
      const index = Number(data['tabIndex'])
      if (typeof pattern === 'string' && pattern.trim() !== '') {
        return data['findTabBy'] === 'match-patterns'
          ? null
          : "matchPattern 需要搭配 findTabBy:'match-patterns' 才会生效"
      }
      if (typeof title === 'string' && title.trim() !== '') {
        return data['findTabBy'] === 'tab-title'
          ? null
          : "tabTitle 需要搭配 findTabBy:'tab-title' 才会生效"
      }
      if (Number.isFinite(index)) return null
      return '必须给出切换目标：matchPattern（+findTabBy）、tabTitle（+findTabBy）或 tabIndex 之一'
    },
  },
  'take-screenshot': {
    check: (data) =>
      String(data['type'] ?? 'page') !== 'element' || hasLocator(data)
        ? null
        : '元素截图（type:"element"）必须给元素定位（ref / selector / target）',
  },
  ocr: {
    check: (data) => {
      const source = String(data['source'] ?? 'page')
      const enumProblem = oneOfEnum(data, 'source', ['variable', 'element', 'page'])
      if (enumProblem) return enumProblem
      if (source === 'element' && !hasLocator(data)) {
        return "source:'element' 必须给元素定位（ref / selector / target）"
      }
      if (source === 'variable' && !isFilled(data['imageVariable'])) {
        return "source:'variable' 必须给 imageVariable（存放图片的变量名）"
      }
      return null
    },
  },
  'save-local': {
    params: [
      { key: 'value', mustReference: true, message: '必须给 value（要写进文件的内容）' },
      { key: 'filename', message: '必须给 filename（带扩展名的文件名，如 report.md）' },
    ],
  },
  cookie: {
    check: (data) => {
      const op = String(data['op'] ?? 'get')
      const enumProblem = oneOfEnum(data, 'op', ['get', 'getAll', 'set', 'remove'])
      if (enumProblem) return enumProblem
      if ((op === 'set' || op === 'remove') && !isFilled(data['url'])) {
        return `cookie op:'${op}' 必须给 url`
      }
      if ((op === 'set' || op === 'remove' || op === 'get') && !isFilled(data['name'])) {
        return `cookie op:'${op}' 必须给 name（Cookie 名）`
      }
      return null
    },
  },

  // --- general -------------------------------------------------------------
  webhook: {
    params: [{ key: 'url', message: '必须给 url（请求地址，http(s) 或 {{引用}}）' }],
    check: (data) => {
      const headers = data['headers']
      if (headers === undefined || headers === null || headers === '') return null
      if (typeof headers !== 'string') return null
      try {
        const parsed: unknown = JSON.parse(headers)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? null
          : 'headers 必须是 JSON 对象字符串，如 {"Authorization":"Bearer ..."}'
      } catch {
        return 'headers 必须是合法 JSON 对象字符串，如 {"Authorization":"Bearer ..."}'
      }
    },
  },
  notification: {
    params: [{ key: 'message', message: '必须给 message（通知正文）' }],
  },
  'export-data': {
    params: [
      { key: 'name', message: '必须给 name（带扩展名的文件名，如 热搜.csv）' },
      {
        key: 'variableName',
        when: (data) => data['dataToExport'] === 'variable',
        message: "dataToExport:'variable' 时必须给 variableName（要导出的变量名）",
      },
    ],
    check: (data) => oneOfEnum(data, 'type', ['csv', 'json', 'plain-text']),
  },
  'execute-workflow': {
    anyOf: [
      { keys: ['workflowId', 'executeId'], message: '必须给出要执行的子工作流（workflowId）' },
    ],
  },
  'parameter-prompt': {
    check: (data) =>
      Array.isArray(data['parameters']) && data['parameters'].length > 0
        ? null
        : '必须声明 parameters（工作流输入列表），否则这一步无事可做',
  },
  'ai-agent': {
    params: [
      { key: 'prompt', message: '必须给 prompt（告诉 AI 做什么）' },
      { key: 'variableName', message: '必须给 variableName（AI 的回答存入哪个变量）' },
    ],
  },

  // --- data ----------------------------------------------------------------
  'set-variable': {
    params: [
      { key: 'variableName', message: '必须给 variableName（存入哪个变量）' },
      { key: 'value', message: '必须给 value（要存的值）' },
    ],
  },
  'get-secret': {
    params: [
      { key: 'credential', message: '必须给 credential（"<凭证ID>::<字段>"，见设置里的凭证）' },
      { key: 'variableName', message: '必须给 variableName（凭证值存入哪个变量）' },
    ],
  },
  'increase-variable': {
    params: [{ key: 'variableName', message: '必须给 variableName（要增加的变量）' }],
  },
  'slice-variable': {
    params: [{ key: 'variableName', message: '必须给 variableName（要切片的变量）' }],
  },
  'regex-variable': {
    params: [
      { key: 'variableName', message: '必须给 variableName（要处理的变量）' },
      { key: 'expression', message: '必须给 expression（正则表达式）' },
    ],
  },
  'data-mapping': {
    params: [{ key: 'mapping', message: '必须给 mapping（映射表达式，用 item 引用每行）' }],
  },
  'sort-data': {
    params: [{ key: 'field', message: '必须给 field（按哪个列排序）' }],
    check: (data) => oneOfEnum(data, 'direction', ['asc', 'desc']),
  },
  'log-data': {
    params: [{ key: 'text', message: '必须给 text（要写入日志的内容）' }],
  },
  'insert-data': {
    check: (data) =>
      filledList(data, 'dataList', 'data')
        ? null
        : '必须给 dataList（要插入的行，非空数组）',
  },
  'delete-data': {
    check: (data) =>
      data['clearAll'] === true || (Number.isFinite(Number(data['key'])) && Number(data['key']) >= 0)
        ? null
        : '必须指明删除目标：clearAll:true 或要删除的行号 key',
  },

  // --- control flow --------------------------------------------------------
  'repeat-task': {
    params: [{ key: 'repeatFor', message: '必须给 repeatFor（重复次数）' }],
  },
  conditions: {
    check: (data) =>
      hasConditionsContent(data)
        ? null
        : 'conditions 没有可判断的内容：请给 code（页面内求值的 JS 表达式）或非空的 conditions 行',
  },
  'while-loop': {
    params: [{ key: 'code', message: '必须给 code（循环条件，页面内求值的 JS 表达式）' }],
  },
  'loop-data': {
    check: (data) =>
      filledList(data, 'data', 'loopData')
        ? null
        : '必须给 loopData（要遍历的数据，非空数组或 JSON 字符串）',
  },
  'loop-elements': { locator: LOCATOR_MESSAGE },
}

/**
 * The trigger block's per-kind required field — MOVED here from
 * `lib/workflow/validation` so both the record gate and the run gate read one
 * implementation. Returns the missing field name, or null when configured.
 */
export function missingTriggerParam(
  type: string,
  data: Record<string, unknown> | undefined,
): string | null {
  const isNonEmptyString = (value: unknown): boolean =>
    typeof value === 'string' && value.trim() !== ''
  switch (type) {
    case 'visit-web':
      return isNonEmptyString(data?.['url']) ? null : 'url'
    case 'keyboard-shortcut':
      return isNonEmptyString(data?.['shortcut']) ? null : 'shortcut'
    case 'context-menu':
      return isNonEmptyString(data?.['contextMenuName']) ? null : 'contextMenuName'
    case 'interval': {
      const raw = data?.['interval']
      const minutes = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(minutes) && minutes > 0 ? null : 'interval'
    }
    case 'specific-day':
      return Array.isArray(data?.['days']) && data['days'].length > 0 ? null : 'days'
    case 'date':
      return isNonEmptyString(data?.['date']) ? null : 'date'
    case 'element-change': {
      const observe = data?.['observeElement']
      const selector =
        observe && typeof observe === 'object'
          ? (observe as Record<string, unknown>)['selector']
          : undefined
      return isNonEmptyString(selector) ? null : 'observeElement.selector'
    }
    default:
      return null
  }
}

/**
 * Every missing requirement of one block call. Unknown blocks and the trigger
 * kinds this build does not arm produce nothing — the run gate handles those
 * separately, and blocking an unknown shape would false-positive on imported
 * graphs.
 *
 * `skipMustReference` is for the record gate's PRE-execution pass: a
 * `mustReference` parameter (only `save-local.value`) may still be a raw
 * literal at that point that the dynamic-data rewriter turns into a
 * `{{reference}}` before the node is recorded, so refusing it there would
 * break the corrected "collector, then reference" pipeline. The gate re-runs
 * on the post-rewrite data before the node is appended.
 */
export function missingRequirements(
  blockId: string,
  data: Record<string, unknown>,
  opts: { skipMustReference?: boolean } = {},
): RequirementProblem[] {
  if (blockId === 'trigger') {
    const type = String(data['type'] ?? 'manual')
    const missing = missingTriggerParam(type, data)
    return missing ? [{ key: missing, message: `触发器类型 '${type}' 必须配置 ${missing}` }] : []
  }

  const requirements = REQUIREMENTS[blockId]
  if (!requirements) return []
  const problems: RequirementProblem[] = []

  for (const param of requirements.params ?? []) {
    if (param.when && !param.when(data)) continue
    const value = data[param.key]
    if (param.mustReference) {
      if (opts.skipMustReference) continue
      if (typeof value === 'string' && value.trim() !== '') {
        if (!value.includes('{{')) {
          problems.push({
            key: param.key,
            message: `${param.message}${REFERENCE_MESSAGE_SUFFIX}`,
          })
          continue
        }
      } else {
        problems.push({ key: param.key, message: param.message })
        continue
      }
      continue
    }
    if (!isFilled(value)) problems.push({ key: param.key, message: param.message })
  }

  for (const group of requirements.anyOf ?? []) {
    if (group.keys.some((key) => isFilled(data[key]))) continue
    problems.push({ key: group.keys.join('|'), message: group.message })
  }

  if (requirements.locator && !hasLocator(data)) {
    problems.push({ key: 'selector', message: requirements.locator })
  }

  if (requirements.check) {
    const message = requirements.check(data)
    if (message) problems.push({ key: 'parameters', message })
  }

  return problems
}

/**
 * Unconditional requirements of one block, for the LLM tool schema's JSON
 * `required` — conditional (`when`) and shape-based (`locator` / `anyOf` /
 * `check`) requirements cannot be expressed there and stay gate-enforced.
 * Unknown blocks (and blocks with only conditional requirements) yield `[]`.
 */
export function schemaRequiredArgs(blockId: string): string[] {
  if (blockId === 'trigger') return []
  const requirements = REQUIREMENTS[blockId]
  if (!requirements) return []
  return (requirements.params ?? [])
    .filter((param) => !param.when)
    .map((param) => param.key)
}

/**
 * Compose the refusal handed back to the model. Bilingual like
 * `SCRIPT_REFUSAL`: the English lead-in names the failure class, the Chinese
 * body carries the per-parameter fixes.
 */
export function formatRequirementRefusal(blockName: string, problems: readonly RequirementProblem[]): string {
  const body = problems.map((problem) => `· ${problem.key}: ${problem.message}`).join('\n')
  return (
    `Refused: ${blockName} is missing required parameters, so NOTHING was executed or recorded. ` +
    `已拒绝：${blockName} 缺少必填参数，本次调用未执行、未记录节点。请补齐后重试：\n${body}`
  )
}
