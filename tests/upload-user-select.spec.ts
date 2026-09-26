/**
 * upload-file executor tests for user-select mode (U022-U026) and the
 * unified pipeline: the executor asks the side panel for files via
 * `requestUserFiles`, then injects through the shared kernel op path.
 *
 * `../src/background/driver` is mocked so no real tab is touched; the
 * file-picker transport is stubbed with a controllable promise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Op, OpResult } from '../src/lib/ops'
import type { WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import type { WorkflowFileArtifact } from '../src/lib/workflow/file-artifact'

const PNG_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const execMock = vi.fn<(op: Op) => Promise<OpResult>>()
vi.mock('../src/background/driver', () => ({
  execOnActiveTab: (op: Op) => execMock(op),
}))

let pickerResolve!: (files: WorkflowFileArtifact[]) => void
let pickerReject!: (error: unknown) => void
const requestMock = vi.fn<(opts?: unknown) => Promise<WorkflowFileArtifact[]>>(
  () =>
    new Promise<WorkflowFileArtifact[]>((resolve, reject) => {
      pickerResolve = resolve
      pickerReject = reject
    }),
)
vi.mock('../src/lib/workflow/user-file-picker', () => ({
  requestUserFiles: (opts: unknown) => requestMock(opts),
}))

import { EXECUTORS } from '../src/background/workflow-engine/executors'
import { UploadFileError } from '../src/lib/workflow/file-artifact'

function artifact(name: string, mimeType: string, dataUrl = PNG_URL): WorkflowFileArtifact {
  return { type: 'file', name, mimeType, dataUrl, size: 42, source: 'user' }
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
    sourceMode: 'user-select',
    selector: '#avatar',
    accept: 'image/png',
    multiple: false,
    verifyAfterUpload: true,
    ...extra,
  }
}

function injectionResult(files: WorkflowFileArtifact[]): OpResult {
  return {
    ok: true,
    found: true,
    frameUrl: 'https://example.com/',
    isTopFrame: true,
    data: {
      count: files.length,
      files: files.map((f) => ({ name: f.name, type: f.mimeType, size: f.size ?? 0 })),
    },
  }
}

beforeEach(() => {
  execMock.mockReset()
  requestMock.mockClear()
})

describe('upload-file user-select mode', () => {
  it('U022: one picked file is injected through the shared pipeline', async () => {
    const files = [artifact('avatar.png', 'image/png')]
    execMock.mockImplementation(async () => injectionResult(files))
    const run = EXECUTORS['upload-file']!(nodeData(), ctx())
    // Pending until the user picks.
    expect(requestMock).toHaveBeenCalledWith({ accept: 'image/png', multiple: false })
    pickerResolve(files)
    await run
    expect(execMock).toHaveBeenCalledTimes(1)
    const op = execMock.mock.calls[0]?.[0] as Op
    expect(op.action).toBe('upload_files')
    expect(op.files).toHaveLength(1)
  })

  it('U023: multiple picked files request multiple=true', async () => {
    const files = [artifact('a.png', 'image/png'), artifact('b.png', 'image/png')]
    execMock.mockImplementation(async () => injectionResult(files))
    const run = EXECUTORS['upload-file']!(nodeData({ multiple: true }), ctx())
    expect(requestMock.mock.calls[0]?.[0]).toMatchObject({ multiple: true })
    pickerResolve(files)
    await expect(run).resolves.toBeNull()
    expect((execMock.mock.calls[0]?.[0] as Op).files).toHaveLength(2)
  })

  it('U024: cancellation fails the node, never as success', async () => {
    const run = EXECUTORS['upload-file']!(nodeData(), ctx())
    pickerReject(new UploadFileError('UPLOAD_USER_SELECTION_CANCELLED', 'cancelled'))
    await expect(run).rejects.toMatchObject({ code: 'UPLOAD_USER_SELECTION_CANCELLED' })
    expect(execMock).not.toHaveBeenCalled()
  })

  it('U025: timeout fails with the timeout code', async () => {
    const run = EXECUTORS['upload-file']!(nodeData(), ctx())
    pickerReject(new UploadFileError('UPLOAD_USER_SELECTION_TIMEOUT', 'timeout'))
    await expect(run).rejects.toMatchObject({ code: 'UPLOAD_USER_SELECTION_TIMEOUT' })
  })

  it('U026: accept filter is forwarded to the picker request', async () => {
    const files = [artifact('doc.pdf', 'application/pdf', 'data:application/pdf;base64,JVBERg==')]
    execMock.mockImplementation(async () => injectionResult(files))
    const run = EXECUTORS['upload-file']!(
      nodeData({ accept: 'application/pdf' }),
      ctx(),
    )
    expect(requestMock.mock.calls[0]?.[0]).toMatchObject({ accept: 'application/pdf' })
    pickerResolve(files)
    await run
  })

  it('verification fails when fewer files reach the control', async () => {
    const files = [artifact('avatar.png', 'image/png')]
    execMock.mockImplementation(async () => ({
      ...injectionResult(files),
      data: { count: 0, files: [] },
    }))
    const run = EXECUTORS['upload-file']!(nodeData(), ctx())
    pickerResolve(files)
    await expect(run).rejects.toMatchObject({ code: 'UPLOAD_FILE_VERIFICATION_FAILED' })
  })
})

describe('upload-file workflow-file mode', () => {
  it('reads a data URL from a variable and injects it', async () => {
    execMock.mockImplementation(async (op: Op) => ({
      ok: true,
      found: true,
      frameUrl: '',
      isTopFrame: true,
      data: { count: 1, files: [{ name: (op.files?.[0]?.name as string), type: 'image/png', size: 1 }] },
    }))
    const c = ctx()
    c.variables['lastScreenshot'] = PNG_URL
    await expect(
      EXECUTORS['upload-file']!(
        nodeData({ sourceMode: 'workflow-file', fileVariable: 'lastScreenshot' }),
        c,
      ),
    ).resolves.toBeNull()
    const op = execMock.mock.calls[0]?.[0] as Op
    expect(op.files?.[0]?.dataUrl).toBe(PNG_URL)
  })

  it('UPLOAD_FILE_VARIABLE_NOT_FOUND for a missing variable', async () => {
    await expect(
      EXECUTORS['upload-file']!(
        nodeData({ sourceMode: 'workflow-file', fileVariable: 'nope' }),
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'UPLOAD_FILE_VARIABLE_NOT_FOUND' })
    expect(execMock).not.toHaveBeenCalled()
  })

  it('U004: legacy fileData still executes', async () => {
    execMock.mockImplementation(async () => ({
      ok: true,
      found: true,
      frameUrl: '',
      isTopFrame: true,
      data: { count: 1, files: [{ name: expect.any(String), type: 'image/png', size: 1 }] },
    }))
    await expect(
      EXECUTORS['upload-file']!(
        nodeData({ sourceMode: undefined, fileData: PNG_URL, verifyAfterUpload: false }),
        ctx(),
      ),
    ).resolves.toBeNull()
  })

  it('U005: legacy filePaths data URLs still execute', async () => {
    execMock.mockImplementation(async () => ({
      ok: true,
      found: true,
      frameUrl: '',
      isTopFrame: true,
      data: { count: 1, files: [{ name: expect.any(String), type: 'image/png', size: 1 }] },
    }))
    await expect(
      EXECUTORS['upload-file']!(
        nodeData({ sourceMode: undefined, filePaths: [PNG_URL], verifyAfterUpload: false }),
        ctx(),
      ),
    ).resolves.toBeNull()
  })

  it('missing selector fails before anything else', async () => {
    await expect(
      EXECUTORS['upload-file']!(nodeData({ selector: '' }), ctx()),
    ).rejects.toMatchObject({ code: 'UPLOAD_TARGET_NOT_FOUND' })
  })
})
