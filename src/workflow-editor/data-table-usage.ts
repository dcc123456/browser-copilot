/**
 * Which blocks in a graph use the run-scoped data table, and which columns the
 * workflow writes into it.
 *
 * There is no table schema node: `variables.dataTable` is created by operators
 * that opt in (`saveData` / insert-data) and consumed by export/loop/sort/
 * delete/mapping. This scan is what the editor's Data table panel shows, so the
 * rules here mirror the forms and executors rather than inventing a schema.
 *
 * @module workflow-editor/data-table-usage
 */
import type { WorkflowNode } from '../lib/workflow/types'

export interface DataTableUsageRow {
  nodeId: string
  blockId: string
  /** The node's own description, used as a row subtitle. */
  description: string
  /** Columns this node writes (writers only). */
  columns: string[]
}

export interface DataTableUsage {
  writers: DataTableUsageRow[]
  readers: DataTableUsageRow[]
  /** Unique columns written anywhere in the workflow, in first-seen order. */
  columns: string[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Columns written by one node's configuration. */
function writtenColumns(data: Record<string, unknown>): string[] {
  const columns: string[] = []
  if (data.saveData === true) columns.push(text(data.dataColumn))
  columns.push(text(data.extraRowDataColumn))
  if (Array.isArray(data.dataList)) {
    for (const item of data.dataList) {
      const entry = record(item)
      if (entry?.type !== 'variable') columns.push(text(entry?.name))
    }
  }
  return [...new Set(columns.filter((column) => column !== ''))]
}

/** Whether the node's configuration reads from the table. */
function readsTable(blockId: string, data: Record<string, unknown>): boolean {
  switch (blockId) {
    case 'export-data':
      return (data.dataToExport ?? 'data-columns') === 'data-columns'
    case 'loop-data':
      // The catalog default is the table, so an unset value means table too.
      return (data.loopThrough ?? 'data-columns') === 'data-columns'
    case 'sort-data':
    case 'data-mapping':
      return (data.dataSource ?? 'table') === 'table'
    case 'delete-data':
      return (
        Array.isArray(data.deleteList) &&
        data.deleteList.some((item) => record(item)?.type !== 'variable')
      )
    default:
      return false
  }
}

function writesTable(blockId: string, data: Record<string, unknown>): boolean {
  if (data.saveData === true) return true
  if (blockId === 'insert-data') {
    return (
      Array.isArray(data.dataList) &&
      data.dataList.some((item) => {
        const entry = record(item)
        return entry !== undefined && entry.type !== 'variable'
      })
    )
  }
  return false
}

export function dataTableUsage(nodes: readonly WorkflowNode[]): DataTableUsage {
  const writers: DataTableUsageRow[] = []
  const readers: DataTableUsageRow[] = []
  const columns: string[] = []

  for (const node of nodes) {
    const blockId = text(node.data.blockId)
    if (!blockId || blockId === 'trigger') continue
    const description = text(node.data.description)
    if (writesTable(blockId, node.data)) {
      const written = writtenColumns(node.data)
      writers.push({ nodeId: node.id, blockId, description, columns: written })
      for (const column of written) {
        if (!columns.includes(column)) columns.push(column)
      }
    }
    if (readsTable(blockId, node.data)) {
      readers.push({ nodeId: node.id, blockId, description, columns: [] })
    }
  }

  return { writers, readers, columns }
}
