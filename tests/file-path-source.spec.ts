/**
 * Both operators' `file-path` source: the exact file named by a
 * download-relative path is read, interpolated first, and never a host path.
 * The folder reader and the tab driver are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Op, OpResult } from '../src/lib/ops'
import type { WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import type { DownloadedPathFile } from '../src/lib/download-dir'

const execMock = vi.fn<(op: Op) => Promise<OpResult>>()
vi.mock('../src/background/driver', () => ({
  execOnActiveTab: (op: Op) => execMock(op),
}))

const readMock = vi.fn<(path: string) => Promise<DownloadedPathFile | null>>()
vi.mock('../src/lib/download-dir', () => ({
  listDownloadedFileCandidates: vi.fn(async () => ({ candidates: [], scanned: [], skipped: [] })),
  readDownloadedFileAtPath: (path: string) => readMock(path),
}))

vi.mock('../src/lib/workflow/user-file-picker', () => ({
  requestUserFiles: vi.fn(async () => []),
}))

import { EXECUTORS } from '../src/background/workflow-engine/executors'

function ctx(variables: Record<string, unknown> = {}): WorkflowExecCtx {
  return {
    variables,
    refData: {},
    signal: new AbortController().signal,
    emit: () => undefined,
  }
}

function found(relativePath: string, text: string, mimeType = 'text/csv'): DownloadedPathFile {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  return {
    file: new File([text], name, { type: mimeType }),
    source: 'configured-download-dir',
    relativePath,
  }
}

function injection(files: Op['files']): OpResult {
  return {
    ok: true,
    found: true,
    frameUrl: 'https://example.com/',
    isTopFrame: true,
    data: {
      count: files?.length ?? 0,
      files: (files ?? []).map((file) => ({ name: file.name, type: file.mimeType })),
    },
  }
}

beforeEach(() => {
  execMock.mockReset()
  execMock.mockImplementation(async (op: Op) => injection(op.files))
  readMock.mockReset()
})

describe('upload-file file-path mode', () => {
  function nodeData(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'upload-1',
      sourceMode: 'file-path',
      selector: '#report',
      filePath: 'reports/2026-10/sales.csv',
      verifyAfterUpload: false,
      ...extra,
    }
  }

  it('uploads exactly the file at the relative path', async () => {
    readMock.mockResolvedValue(found('reports/2026-10/sales.csv', 'exact bytes'))
    await expect(EXECUTORS['upload-file']!(nodeData(), ctx())).resolves.toBeNull()

    expect(readMock).toHaveBeenCalledWith('reports/2026-10/sales.csv')
    const op = execMock.mock.calls[0]?.[0] as Op
    expect(op.files?.[0]?.name).toBe('sales.csv')
    expect(Buffer.from(op.files?.[0]?.dataUrl.split(',')[1] ?? '', 'base64').toString()).toBe(
      'exact bytes',
    )
  })

  it('interpolates the path before resolving it', async () => {
    readMock.mockResolvedValue(found('reports/2026-10/sales.csv', 'x'))
    await EXECUTORS['upload-file']!(
      nodeData({ filePath: 'reports/{{year}}-{{month}}/sales.csv' }),
      ctx({ year: '2026', month: '10' }),
    )
    expect(readMock).toHaveBeenCalledWith('reports/2026-10/sales.csv')
  })

  it('fails with UPLOAD_NO_MATCHING_FILE when the file is absent', async () => {
    readMock.mockResolvedValue(null)
    await expect(EXECUTORS['upload-file']!(nodeData(), ctx())).rejects.toMatchObject({
      code: 'UPLOAD_NO_MATCHING_FILE',
    })
    expect(execMock).not.toHaveBeenCalled()
  })

  it('rejects an absolute path before touching the folders', async () => {
    await expect(
      EXECUTORS['upload-file']!(nodeData({ filePath: '/Users/me/sales.csv' }), ctx()),
    ).rejects.toMatchObject({ code: 'UPLOAD_FILE_DATA_INVALID' })
    expect(readMock).not.toHaveBeenCalled()
  })
})

describe('parse-excel file-path mode', () => {
  function nodeData(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'excel-1',
      sourceMode: 'file-path',
      filePath: 'downloads/orders.csv',
      hasHeader: true,
      variableName: 'lastExcelRows',
      rawVariableName: 'lastExcelRawRows',
      ...extra,
    }
  }

  it('parses the spreadsheet at the relative path', async () => {
    readMock.mockResolvedValue(found('downloads/orders.csv', 'name,amount\nA,1\nB,2'))
    const c = ctx()
    await expect(EXECUTORS['parse-excel']!(nodeData(), c)).resolves.toBeNull()

    expect(c.variables['lastExcelRows']).toEqual([
      { name: 'A', amount: '1' },
      { name: 'B', amount: '2' },
    ])
  })

  it('fails with UPLOAD_NO_MATCHING_FILE when the file is absent', async () => {
    readMock.mockResolvedValue(null)
    await expect(EXECUTORS['parse-excel']!(nodeData(), ctx())).rejects.toMatchObject({
      code: 'UPLOAD_NO_MATCHING_FILE',
    })
  })
})
