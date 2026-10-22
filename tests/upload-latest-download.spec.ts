/**
 * upload-file executor tests for latest-download mode: the newest file in the
 * user's authorised download folders (matching accept / filePattern) is
 * injected without a picker. The scan and the tab driver are mocked — no real
 * directory or tab is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Op, OpResult } from '../src/lib/ops'
import type { WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import type { DownloadedFileCandidate, DownloadedFileScan } from '../src/lib/download-dir'
import type { WorkflowFileArtifact } from '../src/lib/workflow/file-artifact'

const execMock = vi.fn<(op: Op) => Promise<OpResult>>()
vi.mock('../src/background/driver', () => ({
  execOnActiveTab: (op: Op) => execMock(op),
}))

const scanMock = vi.fn<() => Promise<DownloadedFileScan>>()
vi.mock('../src/lib/download-dir', () => ({
  listDownloadedFileCandidates: () => scanMock(),
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

function candidate(
  name: string,
  lastModified: number,
  body = `content of ${name}`,
  mimeType = '',
): DownloadedFileCandidate {
  return {
    name,
    mimeType,
    size: body.length,
    lastModified,
    source: 'configured-download-dir',
    getFile: async () => new File([body], name),
  }
}

function scan(candidates: DownloadedFileCandidate[]): DownloadedFileScan {
  return { candidates, scanned: ['configured download folder'], skipped: [] }
}

function ctx(): WorkflowExecCtx {
  return {
    variables: {},
    refData: {},
    signal: new AbortController().signal,
    emit: () => undefined,
  }
}

function nodeData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'node-1',
    sourceMode: 'latest-download',
    selector: '#report',
    accept: '',
    filePattern: '',
    fallbackToPicker: false,
    verifyAfterUpload: false,
    ...extra,
  }
}

function injectionResult(files: Op['files']): OpResult {
  return {
    ok: true,
    found: true,
    frameUrl: 'https://example.com/',
    isTopFrame: true,
    data: {
      count: files?.length ?? 0,
      files: (files ?? []).map((f) => ({
        name: f.name,
        type: f.mimeType,
      })),
    },
  }
}

beforeEach(() => {
  execMock.mockReset()
  requestMock.mockClear()
  scanMock.mockReset()
  execMock.mockImplementation(async (op: Op) => injectionResult(op.files))
})

describe('upload-file latest-download mode', () => {
  it('uploads the newest matching download', async () => {
    scanMock.mockResolvedValue(scan([candidate('old.pdf', 1_000), candidate('new.pdf', 5_000)]))
    await expect(EXECUTORS['upload-file']!(nodeData(), ctx())).resolves.toBeNull()

    const op = execMock.mock.calls[0]?.[0] as Op
    const uploaded = op.files?.[0]
    expect(uploaded?.name).toBe('new.pdf')
    expect(Buffer.from(uploaded?.dataUrl.split(',')[1] ?? '', 'base64').toString()).toBe(
      'content of new.pdf',
    )
  })

  it('filters by accept and filePattern before choosing the newest', async () => {
    scanMock.mockResolvedValue(
      scan([
        candidate('report-2026-01.xlsx', 9_000, 'x', 'application/vnd.ms-excel'),
        candidate('report-2026-02.csv', 8_000, 'y'),
        candidate('photo.png', 10_000),
      ]),
    )
    await EXECUTORS['upload-file']!(nodeData({ accept: '.csv', filePattern: 'report-*' }), ctx())
    const op = execMock.mock.calls[0]?.[0] as Op
    expect(op.files?.[0]?.name).toBe('report-2026-02.csv')
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('fails with UPLOAD_NO_MATCHING_FILE when no download matches', async () => {
    scanMock.mockResolvedValue(scan([candidate('photo.png', 5_000)]))
    await expect(
      EXECUTORS['upload-file']!(nodeData({ accept: '.pdf' }), ctx()),
    ).rejects.toMatchObject({ code: 'UPLOAD_NO_MATCHING_FILE' })
    expect(execMock).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('falls back to the picker when fallbackToPicker is on', async () => {
    scanMock.mockResolvedValue(scan([]))
    const run = EXECUTORS['upload-file']!(nodeData({ fallbackToPicker: true }), ctx())
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1))
    pickerResolve([
      {
        type: 'file',
        name: 'picked.pdf',
        mimeType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,JVBERg==',
        size: 4,
        source: 'user',
      },
    ])
    await run
    const op = execMock.mock.calls[0]?.[0] as Op
    expect(op.files?.[0]?.name).toBe('picked.pdf')
  })

  it('reports an unreadable download as UPLOAD_FILE_DATA_INVALID', async () => {
    scanMock.mockResolvedValue(
      scan([
        {
          ...candidate('broken.pdf', 5_000),
          getFile: async () => {
            throw new Error('permission denied')
          },
        },
      ]),
    )
    await expect(EXECUTORS['upload-file']!(nodeData(), ctx())).rejects.toMatchObject({
      code: 'UPLOAD_FILE_DATA_INVALID',
    })
  })
})
