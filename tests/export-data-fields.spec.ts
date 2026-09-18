/**
 * `export-data` must honour the fields the catalog declares, the editor edits,
 * and the operator guide tells the model to send.
 *
 * The regression: the executor read `data['filename']` / `data['format']` while
 * everything else — `blocks/catalog.ts`, `batchC/EditExportData.tsx`, and the
 * `operator-guide` mapping table (`export-data(name:'x.csv', type:'csv')`) — used
 * `name` / `type`. Nothing read `name`, `type`, `dataToExport`, `addBOMHeader` or
 * `csvDelimiter` at all, so the file was always `export.csv` and "Export as JSON"
 * always wrote CSV: the block's entire editable surface was inert.
 *
 * `filename` / `format` stay supported as fallbacks (workflows saved before the
 * names agreed), which is why the first test pins both spellings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writtenFiles } = vi.hoisted(() => ({ writtenFiles: new Map<string, string>() }))

vi.mock('../src/lib/download-dir', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/download-dir')>()
  return {
    ...actual,
    getDownloadDir: vi.fn(async () => ({
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (text: string) => void writtenFiles.set(name, text),
          close: async () => {},
        }),
      }),
    })),
  }
})

import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import { dataSchemaFromEntry } from '../src/lib/workflow/operator-tools'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'

const exportData = EXECUTORS['export-data']!

const ROWS = [
  { 标题: 'a', 热度: '1' },
  { 标题: 'b,c', 热度: '2' },
]

function makeCtx(variables: Record<string, unknown> = {}): {
  ctx: WorkflowExecCtx
  emit: ReturnType<typeof vi.fn>
} {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: { dataTable: ROWS, ...variables },
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

const onlyFile = () => {
  expect(writtenFiles.size).toBe(1)
  return [...writtenFiles.entries()][0]!
}

beforeEach(() => {
  writtenFiles.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('export-data: the file name comes from `name`', () => {
  it('uses `name` — what the form edits and the guide tells the model to send', async () => {
    const { ctx } = makeCtx()
    await exportData({ name: '微博热搜TOP20.csv', type: 'csv' }, ctx)

    expect(onlyFile()[0]).toBe('微博热搜TOP20.csv')
  })

  it('still accepts the legacy `filename` spelling', async () => {
    const { ctx } = makeCtx()
    await exportData({ filename: 'legacy.csv', type: 'csv' }, ctx)

    expect(onlyFile()[0]).toBe('legacy.csv')
  })

  it('falls back to export.csv when no name is given', async () => {
    const { ctx } = makeCtx()
    await exportData({}, ctx)

    expect(onlyFile()[0]).toBe('export.csv')
  })

  it('interpolates a reference in the name', async () => {
    const { ctx } = makeCtx({ saveName: '每日热搜.csv' })
    await exportData({ name: '{{saveName}}', type: 'csv' }, ctx)

    expect(onlyFile()[0]).toBe('每日热搜.csv')
  })
})

describe('export-data: the format comes from `type`', () => {
  it('writes CSV with a header row and quotes only what needs it', async () => {
    const { ctx } = makeCtx()
    await exportData({ name: 'x.csv', type: 'csv' }, ctx)

    expect(onlyFile()[1]).toBe('标题,热度\na,1\n"b,c",2')
  })

  it('writes JSON when asked for JSON', async () => {
    const { ctx } = makeCtx()
    await exportData({ name: 'x.json', type: 'json' }, ctx)

    expect(JSON.parse(onlyFile()[1])).toEqual(ROWS)
  })

  it('writes headerless, unquoted rows for plain-text', async () => {
    const { ctx } = makeCtx()
    await exportData({ name: 'x.txt', type: 'plain-text' }, ctx)

    expect(onlyFile()[1]).toBe('a,1\nb,c,2')
  })

  it('honours csvDelimiter', async () => {
    const { ctx } = makeCtx()
    await exportData({ name: 'x.csv', type: 'csv', csvDelimiter: ';' }, ctx)

    expect(onlyFile()[1]).toBe('标题;热度\na;1\nb,c;2')
  })

  it('prepends a UTF-8 BOM only when asked — Excel needs it for Chinese', async () => {
    const { ctx } = makeCtx()
    await exportData({ name: 'x.csv', type: 'csv', addBOMHeader: true }, ctx)

    expect(onlyFile()[1]!.startsWith('\uFEFF')).toBe(true)
  })

  it('writes no BOM when the flag is absent, so existing exports are byte-identical', async () => {
    const { ctx } = makeCtx()
    await exportData({ name: 'x.csv', type: 'csv' }, ctx)

    expect(onlyFile()[1]!.startsWith('\uFEFF')).toBe(false)
  })
})

describe('export-data: dataToExport selects the source', () => {
  it('exports a single variable in variable mode', async () => {
    const { ctx } = makeCtx({ report: 'hello' })
    await exportData(
      { name: 'r.txt', type: 'plain-text', dataToExport: 'variable', variableName: 'report' },
      ctx,
    )

    expect(onlyFile()[1]).toBe('hello')
  })

  it('refuses variable mode without a variable name instead of exporting the table', async () => {
    const { ctx } = makeCtx()
    await expect(
      exportData({ name: 'r.txt', type: 'csv', dataToExport: 'variable' }, ctx),
    ).rejects.toThrow(/variableName/)

    expect(writtenFiles.size).toBe(0)
  })

  it('refuses a variable that was never produced, naming it', async () => {
    const { ctx } = makeCtx()
    await expect(
      exportData(
        { name: 'r.txt', type: 'csv', dataToExport: 'variable', variableName: 'missing' },
        ctx,
      ),
    ).rejects.toThrow(/missing/)

    expect(writtenFiles.size).toBe(0)
  })

  it('refuses an empty data table instead of writing a file that looks like a result', async () => {
    // The most common "工作流跑完了但文件是空的" report. Writing the empty file
    // silently is indistinguishable from a successful export, so the step now
    // fails and names every way the table ends up empty.
    const { ctx } = makeCtx()
    ctx.variables['dataTable'] = []

    await expect(exportData({ name: 'x.csv', type: 'csv' }, ctx)).rejects.toThrow(/saveData/)

    expect(writtenFiles.size).toBe(0)
  })

  it('reports the Google Sheets mode as unavailable rather than writing a local file', async () => {
    const { ctx } = makeCtx()
    await expect(
      exportData({ name: 'x.csv', type: 'csv', dataToExport: 'google-sheets' }, ctx),
    ).rejects.toThrow(/Google Sheets/)

    expect(writtenFiles.size).toBe(0)
  })
})

describe('export-data tool schema', () => {
  const schema = dataSchemaFromEntry(BLOCK_BY_ID.get('export-data')!) as {
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>
  }

  it('describes the implemented fields', () => {
    expect(schema.properties['name']!.description).toContain('File name')
    expect(schema.properties['type']!.enum).toEqual(['csv', 'json', 'plain-text'])
    expect(schema.properties['dataToExport']!.enum).toEqual(['data-columns', 'variable'])
  })

  it('does not advertise the knobs no executor reads', () => {
    // `onConflict` / `refKey` are declared by five blocks and read by none;
    // offering them would promise behaviour that does not exist.
    expect(schema.properties['onConflict']).toBeUndefined()
    expect(schema.properties['refKey']).toBeUndefined()
  })
})
