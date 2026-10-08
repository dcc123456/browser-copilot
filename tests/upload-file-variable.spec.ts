/**
 * upload-file workflow-file mode: what a `fileVariable` may hold.
 *
 * Round 71 spent 21 operator calls and its entire 100-round generation budget
 * on the same refusal: the parameter was described as an "Artifact/data-URL
 * variable", the model passed the generated image's base64 as the value, and
 * the executor answered only «variable … is not set» — a message with no
 * remedy, so the retry was the obvious next move. These tests pin the two
 * things that let such a turn converge: a refusal that names the fix, and a
 * `{{reference}}` read as the variable it points at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Op, OpResult } from '../src/lib/ops'
import type { WorkflowExecCtx } from '../src/background/workflow-engine/executors'

const PNG_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const execMock = vi.fn<(op: Op) => Promise<OpResult>>()
vi.mock('../src/background/driver', () => ({
  execOnActiveTab: (op: Op) => execMock(op),
}))
vi.mock('../src/lib/workflow/user-file-picker', () => ({
  requestUserFiles: vi.fn(async () => []),
}))

import { EXECUTORS } from '../src/background/workflow-engine/executors'

function ctx(variables: Record<string, unknown> = {}): WorkflowExecCtx {
  return { variables, refData: {}, signal: new AbortController().signal, emit: () => undefined }
}

function nodeData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'node-1', sourceMode: 'workflow-file', selector: '#upload', ...extra }
}

const injection: OpResult = {
  ok: true,
  found: true,
  frameUrl: 'https://example.com/',
  isTopFrame: true,
  data: { count: 1, files: [{ name: 'image.png', type: 'image/png', size: 68 }] },
}

// The kernel reports what actually landed; echo the request so the node's own
// verification step compares like with like.
beforeEach(() => {
  execMock.mockReset()
  execMock.mockImplementation(async (op: Op): Promise<OpResult> => ({
    ...injection,
    data: {
      count: op.files?.length ?? 0,
      files: (op.files ?? []).map((f) => ({ name: f.name, type: f.mimeType, size: 68 })),
    },
  }))
})

describe('upload-file fileVariable resolution', () => {
  it('refuses inline file content with a message that names the fix', async () => {
    await expect(
      EXECUTORS['upload-file']!(nodeData({ fileVariable: PNG_URL }), ctx()),
    ).rejects.toMatchObject({
      code: 'UPLOAD_FILE_VARIABLE_NOT_FOUND',
      message: expect.stringMatching(/variable NAME/i),
    })
    expect(execMock).not.toHaveBeenCalled()
  })

  it('reads a {{reference}} written in place of the name as that variable', async () => {
    await EXECUTORS['upload-file']!(
      nodeData({ fileVariable: '{{generatedImage}}' }),
      ctx({ generatedImage: PNG_URL }),
    )
    const op = execMock.mock.calls[0]?.[0] as Op
    expect(op.action).toBe('upload_files')
    expect(op.files?.[0]?.dataUrl).toBe(PNG_URL)
  })

  it('says which node has to produce a genuinely unset variable', async () => {
    await expect(
      EXECUTORS['upload-file']!(nodeData({ fileVariable: 'generatedImage' }), ctx()),
    ).rejects.toMatchObject({
      code: 'UPLOAD_FILE_VARIABLE_NOT_FOUND',
      message: expect.stringMatching(/earlier node/i),
    })
  })
})
