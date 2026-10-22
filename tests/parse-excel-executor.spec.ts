/**
 * parse-excel executor tests: file acquisition (runtime picker vs upstream
 * variable), the two output variables, and the structured failure codes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpResult } from '../src/lib/ops'
import type { WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import type { WorkflowFileArtifact } from '../src/lib/workflow/file-artifact'
import { buildXlsx, sheetXml } from './helpers/xlsx-fixture'

vi.mock('../src/background/driver', () => ({
  execOnActiveTab: vi.fn<() => Promise<OpResult>>(),
}))

let pickerResolve!: (files: WorkflowFileArtifact[]) => void
const requestMock = vi.fn<(opts?: unknown) => Promise<WorkflowFileArtifact[]>>(
  () =>
    new Promise<WorkflowFileArtifact[]>((resolve) => {
      pickerResolve = resolve
    }),
)
vi.mock('../src/lib/workflow/user-file-picker', () => ({
  requestUserFiles: (opts: unknown) => requestMock(opts),
}))

import { EXECUTORS } from '../src/background/workflow-engine/executors'

function ctx(): WorkflowExecCtx & { variables: Record<string, unknown> } {
  return {
    variables: {},
    refData: {},
    signal: new AbortController().signal,
    emit: () => undefined,
  }
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

function csvArtifact(name = 'report.csv', text = 'name,amount\nA,1\nB,2'): WorkflowFileArtifact {
  return {
    type: 'file',
    name,
    mimeType: 'text/csv',
    dataUrl: dataUrl('text/csv', new TextEncoder().encode(text)),
    source: 'user',
  }
}

function xlsxArtifact(): WorkflowFileArtifact {
  const bytes = buildXlsx({
    sheets: [
      {
        name: 'Sales',
        xml: sheetXml(
          '<row r="1">' +
            '<c r="A1" t="inlineStr"><is><t>item</t></is></c>' +
            '<c r="B1" t="inlineStr"><is><t>qty</t></is></c>' +
            '</row>' +
            '<row r="2">' +
            '<c r="A2" t="inlineStr"><is><t>apple</t></is></c>' +
            '<c r="B2"><v>3</v></c>' +
            '</row>',
        ),
      },
    ],
  })
  return {
    type: 'file',
    name: 'sales.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dataUrl: dataUrl('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes),
    source: 'user',
  }
}

function nodeData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'excel-1',
    blockId: 'parse-excel',
    sourceMode: 'workflow-file',
    fileVariable: 'lastFile',
    sheetName: '',
    hasHeader: true,
    variableName: 'lastExcelRows',
    rawVariableName: 'lastExcelRawRows',
    ...extra,
  }
}

beforeEach(() => {
  requestMock.mockClear()
})

describe('parse-excel executor', () => {
  it('parses a workflow-file CSV into object rows plus raw rows', async () => {
    const c = ctx()
    c.variables['lastFile'] = csvArtifact()
    await expect(EXECUTORS['parse-excel']!(nodeData(), c)).resolves.toBeNull()

    expect(c.variables['lastExcelRows']).toEqual([
      { name: 'A', amount: '1' },
      { name: 'B', amount: '2' },
    ])
    expect(c.variables['lastExcelRawRows']).toEqual([
      ['name', 'amount'],
      ['A', '1'],
      ['B', '2'],
    ])
    expect(c.variables['lastExcelSheet']).toBe('report')
  })

  it('parses an xlsx from a variable with typed cells and a named sheet', async () => {
    const c = ctx()
    c.variables['lastFile'] = xlsxArtifact()
    await EXECUTORS['parse-excel']!(nodeData({ sheetName: 'Sales' }), c)

    expect(c.variables['lastExcelRows']).toEqual([{ item: 'apple', qty: 3 }])
    expect(c.variables['lastExcelRawRows']).toEqual([
      ['item', 'qty'],
      ['apple', 3],
    ])
    expect(c.variables['lastExcelSheet']).toBe('Sales')
  })

  it('asks for a file in user-select mode', async () => {
    const c = ctx()
    const run = EXECUTORS['parse-excel']!(nodeData({ sourceMode: 'user-select' }), c)
    expect(requestMock).toHaveBeenCalledWith({
      accept:
        '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv',
      multiple: false,
    })
    pickerResolve([csvArtifact()])
    await run
    expect(c.variables['lastExcelRows']).toHaveLength(2)
  })

  it('honours custom output variable names', async () => {
    const c = ctx()
    c.variables['lastFile'] = csvArtifact()
    await EXECUTORS['parse-excel']!(
      nodeData({ variableName: 'orders', rawVariableName: 'ordersRaw' }),
      c,
    )
    expect(c.variables['orders']).toHaveLength(2)
    expect(c.variables['ordersRaw']).toHaveLength(3)
  })

  it('keeps every row when hasHeader is false', async () => {
    const c = ctx()
    c.variables['lastFile'] = csvArtifact()
    await EXECUTORS['parse-excel']!(nodeData({ hasHeader: false }), c)
    expect(c.variables['lastExcelRows']).toEqual([
      { column1: 'name', column2: 'amount' },
      { column1: 'A', column2: '1' },
      { column1: 'B', column2: '2' },
    ])
  })

  it('fails with EXCEL_SHEET_NOT_FOUND for an unknown worksheet', async () => {
    const c = ctx()
    c.variables['lastFile'] = xlsxArtifact()
    await expect(
      EXECUTORS['parse-excel']!(nodeData({ sheetName: 'Missing' }), c),
    ).rejects.toMatchObject({ code: 'EXCEL_SHEET_NOT_FOUND' })
  })

  it('rejects legacy .xls with the conversion hint code', async () => {
    const c = ctx()
    c.variables['lastFile'] = {
      ...csvArtifact('legacy.xls'),
      mimeType: 'application/vnd.ms-excel',
      dataUrl: dataUrl('application/vnd.ms-excel', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])),
    }
    await expect(EXECUTORS['parse-excel']!(nodeData(), c)).rejects.toMatchObject({
      code: 'EXCEL_LEGACY_FORMAT_UNSUPPORTED',
    })
  })

  it('requires exactly one file from the variable', async () => {
    const c = ctx()
    c.variables['lastFile'] = [csvArtifact('a.csv'), csvArtifact('b.csv')]
    await expect(EXECUTORS['parse-excel']!(nodeData(), c)).rejects.toMatchObject({
      code: 'EXCEL_PARSE_FAILED',
    })
  })

  it('reports a missing variable before parsing', async () => {
    await expect(EXECUTORS['parse-excel']!(nodeData(), ctx())).rejects.toMatchObject({
      code: 'UPLOAD_FILE_VARIABLE_NOT_FOUND',
    })
  })
})
