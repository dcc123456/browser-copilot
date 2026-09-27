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

export type ProducerCompletenessCode =
  | 'MISSING_PRODUCER'
  | 'MISSING_TABLE_PRODUCER'

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
function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  return typeof fromData === 'string' && fromData ? fromData : node.label
}

/**
 * Blocks that write a named session variable, and the data field carrying that
 * variable's name. Every one of these blocks is a valid "producer" for a
 * `{{reference}}` consumed downstream.
 */
const VARIABLE_PRODUCER_FIELD: Readonly<Record<string, string>> = {
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
  const produced = stringField(node, field)
  if (produced === name) return true
  // Blocks with an empty variable name still publish their fallback; treat a
  // same-block reader as a producer for its own fallback name only.
  if (!produced && name === fallbackVariableOf(blockId)) return true
  return false
}

/** Canonical fallback variable name for reader blocks with empty variableName. */
function fallbackVariableOf(blockId: string): string {
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
function feedsTable(node: WorkflowNode): boolean {
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

/** Collect every `{{reference}}` token anywhere in a node's data. */
function referencesIn(node: WorkflowNode): string[] {
  const out = new Set<string>()
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(TOKEN)) {
        const expression = (match[1] ?? '').trim()
        if (!expression) continue
        // Only top-level names are session variables; `x.y` still keys on x.
        const dot = expression.indexOf('.')
        out.add(dot === -1 ? expression : expression.slice(0, dot))
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item)
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item)
    }
  }
  walk(node.data ?? {})
  return [...out]
}

/**
 * Check producer completeness of one workflow. Returns one issue per missing
 * producer (deduplicated by node + reference); an empty array means the graph
 * carries producers for everything it consumes.
 */
export function checkProducerCompleteness(
  workflow: Workflow,
): ProducerCompletenessIssue[] {
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

    // 1. Every {{reference}} this node consumes must be declared or produced.
    for (const reference of referencesIn(node)) {
      if (declared.has(reference)) continue
      const producer = nodes.some(
        (candidate) => candidate.id !== node.id && producesVariable(candidate, reference),
      )
      if (producer) continue
      add({
        code: 'MISSING_PRODUCER',
        nodeId: node.id,
        blockId,
        reference,
        message: `Node "${blockId}" references "{{${reference}}}", but no upstream node produces it and it is not declared on the trigger.`,
      })
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
export function describeProducerIssues(
  issues: readonly ProducerCompletenessIssue[],
): string {
  return issues.map((issue) => issue.message).join('; ')
}
