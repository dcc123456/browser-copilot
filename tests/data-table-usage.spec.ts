/**
 * The data-table scan behind the editor's Data table panel: which blocks write
 * into the run-scoped table, which read from it, and which columns the workflow
 * names. These rules mirror the executor/form defaults, so a block that only
 * looks like it touches the table (data mapping pointed at a variable) stays out.
 */
import { describe, expect, it } from 'vitest'
import { dataTableUsage } from '../src/workflow-editor/data-table-usage'
import type { WorkflowNode } from '../src/lib/workflow/types'

const node = (id: string, data: Record<string, unknown>): WorkflowNode => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  data,
})

describe('dataTableUsage', () => {
  it('lists writers, readers and deduped columns', () => {
    const usage = dataTableUsage([
      node('trigger', { blockId: 'trigger' }),
      node('grab', {
        blockId: 'get-text',
        description: 'Grab price',
        saveData: true,
        dataColumn: 'price',
      }),
      node('hook', { blockId: 'webhook', saveData: true, dataColumn: 'reply' }),
      node('grab2', { blockId: 'get-text', saveData: true, dataColumn: 'price' }),
      node('insert', {
        blockId: 'insert-data',
        dataList: [
          { type: 'text', name: 'note' },
          { type: 'variable', name: 'ignored' },
        ],
      }),
      node('export', { blockId: 'export-data' }),
      node('loop', { blockId: 'loop-data' }),
      node('sort', { blockId: 'sort-data', dataSource: 'variable' }),
      node('del', {
        blockId: 'delete-data',
        deleteList: [{ type: 'table', columnId: 'price' }],
      }),
    ])

    expect(usage.writers.map((row) => row.nodeId)).toEqual(['grab', 'hook', 'grab2', 'insert'])
    expect(usage.writers[0]?.description).toBe('Grab price')
    expect(usage.columns).toEqual(['price', 'reply', 'note'])
    expect(usage.readers.map((row) => row.nodeId)).toEqual(['export', 'loop', 'del'])
  })

  it('treats the catalog default as "table" for export, loop, sort and mapping', () => {
    const usage = dataTableUsage([
      node('export', { blockId: 'export-data', dataToExport: 'data-columns' }),
      node('loop', { blockId: 'loop-data', loopThrough: 'data-columns' }),
      node('sort', { blockId: 'sort-data' }),
      node('map', { blockId: 'data-mapping' }),
    ])
    expect(usage.readers.map((row) => row.nodeId)).toEqual(['export', 'loop', 'sort', 'map'])
  })

  it('skips blocks that point at a variable instead of the table', () => {
    const usage = dataTableUsage([
      node('export', { blockId: 'export-data', dataToExport: 'variable' }),
      node('loop', { blockId: 'loop-data', loopThrough: 'variable' }),
      node('map', { blockId: 'data-mapping', dataSource: 'variable' }),
      node('del', { blockId: 'delete-data', deleteList: [{ type: 'variable' }] }),
    ])
    expect(usage.readers).toEqual([])
  })
})
