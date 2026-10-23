/**
 * Producer-completeness check for generated workflows.
 *
 * A generated workflow is a dead shell when its consuming nodes reference
 * values nobody produces: the model "explored" with read-only tools
 * (`snapshot_page` / `read_current_page`, which record no nodes) and then
 * placed `save-local` / `webhook` / `notification` / `forms` nodes that
 * reference `{{variables}}` (or `export-data` consuming a table) with no read
 * step upstream. The operator guide forbids this, but nothing enforced it at
 * generation time — the broken workflow was offered and failed on first run.
 *
 * This pure module closes the gap. Given a workflow it reports:
 *
 *   - `MISSING_PRODUCER`       — a `{{reference}}` with no producer node and
 *                                no declaration on the trigger;
 *   - `MISSING_TABLE_PRODUCER` — an `export-data` node with no upstream
 *                                `saveData` read feeding the data table.
 *
 * Producer knowledge is the static block semantics (which blocks write a
 * session variable / the table); no execution and no `chrome` access.
 *
 * @module lib/workflow/producer-completeness
 */

import type { Workflow, WorkflowNode } from './types'
import { variableAssignmentsOf } from './block-output'
import { referenceRoot } from './dynamic-data'
import { SECRET_PRODUCER_BLOCK, secretVariableNamesOf } from './secret-params'

export type ProducerCompletenessCode = 'MISSING_PRODUCER' | 'MISSING_TABLE_PRODUCER'

export interface ProducerCompletenessIssue {
  code: ProducerCompletenessCode
  /** The consuming node id. */
  nodeId: string
  /** The consuming node's block id. */
  blockId: string
  /** The variable name (MISSING_PRODUCER) or empty string (table). */
  reference: string
  /** One-line human-readable detail. */
  message: string
}

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Read a string field from a node's data. */
function stringField(node: WorkflowNode, key: string): string {
  const value = node.data?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Block id of a node: `data.blockId`, falling back to the label. */
export function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  return typeof fromData === 'string' && fromData ? fromData : node.label
}

/**
 * Blocks that write a named session variable, and the data field carrying that
 * variable's name. Every one of these blocks is a valid "producer" for a
 * `{{reference}}` consumed downstream.
 *
 * This is the ONE definition of "which field of which block holds the variable
 * it writes" — `generated-validation`'s data-flow analysis reads it instead of
 * keeping its own list, which had already drifted (it omitted `ai-agent`, so a
 * graph whose title came from an ai-agent node was reported as reading a
 * variable nothing writes, and it read `variableName` for `webhook`, which
 * publishes through `responseVariable`).
 */
export const VARIABLE_PRODUCER_FIELD: Readonly<Record<string, string>> = {
  'get-text': 'variableName',
  'attribute-value': 'variableName',
  'read-page': 'variableName',
  'ai-agent': 'variableName',
  ocr: 'imageVariable',
  'set-variable': 'variableName',
  'data-mapping': 'variableName',
  'slice-variable': 'variableName',
  'regex-variable': 'variableName',
  'increase-variable': 'variableName',
  webhook: 'responseVariable',
  // Its `variableName` is only the FIRST credential row; {@link
  // producedVariableNames} adds the rest through `secret-params`.
  'get-secret': 'variableName',
  // The object rows go to `variableName`; the raw 2-D array is a second,
  // independently nameable output added in `producedVariableNames`.
  'parse-excel': 'variableName',
}

/** Additional, independently named outputs a block writes besides its main one. */
const EXTRA_OUTPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'parse-excel': ['rawVariableName'],
}

/**
 * Every variable name one node publishes, in the order a reader should offer
 * them. This is the single definition of "what does this node write":
 * `integrity`'s save-time reference check, the provenance index, the generator's
 * data-flow analysis and the `/` menu all consult it instead of reading
 * `data.variableName` themselves, because a `get-secret` node writes one name
 * PER CREDENTIAL ROW while `variableName` only ever mirrors the first.
 *
 * The generic `variableName` read is kept for blocks the map above does not
 * cover — it is what `integrity` has always treated as produced, and dropping it
 * would turn live references into dangling ones.
 */
export function producedVariableNames(node: WorkflowNode): string[] {
  const blockId = blockIdOf(node)
  const names = new Set<string>()
  const field = VARIABLE_PRODUCER_FIELD[blockId]
  const declared = field ? stringField(node, field) : ''
  if (declared) names.add(declared)
  for (const extraField of EXTRA_OUTPUT_FIELDS[blockId] ?? []) {
    const extra = stringField(node, extraField)
    if (extra) names.add(extra)
  }
  if (blockId === SECRET_PRODUCER_BLOCK) {
    for (const name of secretVariableNamesOf(node.data)) names.add(name)
  }
  // `set-variable` writes one variable per row; the flat `variableName` field
  // only mirrors the single-variable shape saved before rows existed.
  for (const assignment of variableAssignmentsOf((node.data ?? {}) as Record<string, unknown>)) {
    names.add(assignment.name)
  }
  const written = stringField(node, 'variableName')
  if (written) names.add(written)
  return [...names]
}

/**
 * Whether a node publishes the named variable. Reader blocks always publish
 * under BOTH the explicit `variableName` and their block fallback
 * (`lastText` / …); for the completeness check the explicit name is enough —
 * a model referencing the fallback has a producer node regardless.
 */
function producesVariable(node: WorkflowNode, name: string): boolean {
  const blockId = blockIdOf(node)
  const field = VARIABLE_PRODUCER_FIELD[blockId]
  if (!field) return false
  if (producedVariableNames(node).includes(name)) return true
  // Blocks with an empty variable name still publish their fallback; treat a
  // same-block reader as a producer for its own fallback name only.
  if (!stringField(node, field) && name === fallbackVariableOf(blockId)) return true
  return false
}

/** Canonical fallback variable name for reader blocks with empty variableName. */
export function fallbackVariableOf(blockId: string): string {
  switch (blockId) {
    case 'get-text':
      return 'lastText'
    case 'attribute-value':
      return 'lastAttribute'
    case 'read-page':
      return 'lastReadPage'
    case 'ai-agent':
      return 'lastAiResult'
    default:
      return ''
  }
}

/**
 * Blocks feeding the data table: `get-text` / `read-page` with `saveData:true`
 * (and a non-empty `dataColumn`). `export-data` only writes what these nodes
 * collected.
 */
export function feedsTable(node: WorkflowNode): boolean {
  const blockId = blockIdOf(node)
  if (blockId !== 'get-text' && blockId !== 'read-page') return false
  if (node.data?.['saveData'] !== true) return false
  return stringField(node, 'dataColumn') !== ''
}

/** Names declared as run inputs on the trigger (the other valid reference source). */
function triggerInputs(nodes: readonly WorkflowNode[]): Set<string> {
  const head = nodes.find((node) => blockIdOf(node) === 'trigger')
  const raw = head?.data?.['parameters']
  const out = new Set<string>()
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const name = (item as Record<string, unknown>)['name']
    if (typeof name === 'string' && name) out.add(name)
  }
  return out
}

/** Collect every `{{reference}}` token in one value (recursing into containers). */
function referencesInValue(value: unknown): string[] {
  const out = new Set<string>()
  const walk = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(TOKEN)) {
        const expression = (match[1] ?? '').trim()
        if (!expression) continue
        // Only the root is a session variable; `x.y` and `x[0]` both key on x.
        out.add(referenceRoot(expression))
      }
    } else if (Array.isArray(item)) {
      for (const child of item) walk(child)
    } else if (item && typeof item === 'object') {
      for (const child of Object.values(item as Record<string, unknown>)) walk(child)
    }
  }
  walk(value)
  return [...out]
}

/** Collect every `{{reference}}` token anywhere in a node's data. */
function referencesIn(node: WorkflowNode): string[] {
  return referencesInValue(node.data ?? {})
}

/**
 * Check producer completeness of one workflow. Returns one issue per missing
 * producer (deduplicated by node + reference); an empty array means the graph
 * carries producers for everything it consumes.
 */
export function checkProducerCompleteness(workflow: Workflow): ProducerCompletenessIssue[] {
  const nodes = workflow.drawflow?.nodes ?? []
  const declared = triggerInputs(nodes)
  const issues: ProducerCompletenessIssue[] = []
  const seen = new Set<string>()

  const add = (issue: ProducerCompletenessIssue): void => {
    const key = `${issue.code}:${issue.nodeId}:${issue.reference}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push(issue)
  }

  for (const node of nodes) {
    const blockId = blockIdOf(node)
    if (blockId === 'trigger') continue

    const hasProducer = (reference: string): boolean =>
      declared.has(reference) ||
      nodes.some((candidate) => candidate.id !== node.id && producesVariable(candidate, reference))
    const reportMissing = (reference: string): void =>
      add({
        code: 'MISSING_PRODUCER',
        nodeId: node.id,
        blockId,
        reference,
        message: `Node "${blockId}" references "{{${reference}}}", but no upstream node produces it and it is not declared on the trigger.`,
      })

    // 1. Every {{reference}} this node consumes must be declared or produced.
    if (blockId === 'set-variable') {
      // Rows run top to bottom, so a later row may consume a variable an
      // earlier row just wrote — that is not a missing producer.
      const writtenEarlier = new Set<string>()
      for (const assignment of variableAssignmentsOf(node.data ?? {})) {
        for (const reference of referencesInValue(assignment.value)) {
          if (!writtenEarlier.has(reference) && !hasProducer(reference)) reportMissing(reference)
        }
        writtenEarlier.add(assignment.name)
      }
    } else {
      for (const reference of referencesIn(node)) {
        if (!hasProducer(reference)) reportMissing(reference)
      }
    }

    // 2. export-data needs a saveData read feeding the table.
    if (blockId === 'export-data') {
      const hasTableProducer = nodes.some(
        (candidate) => candidate.id !== node.id && feedsTable(candidate),
      )
      if (!hasTableProducer) {
        add({
          code: 'MISSING_TABLE_PRODUCER',
          nodeId: node.id,
          blockId,
          reference: '',
          message:
            'Node "export-data" writes the data table, but no upstream get-text/read-page node has saveData:true with a dataColumn.',
        })
      }
    }
  }

  return issues
}

/** Flatten issues into a one-per-line detail string for the save resolution. */
export function describeProducerIssues(issues: readonly ProducerCompletenessIssue[]): string {
  return issues.map((issue) => issue.message).join('; ')
}
