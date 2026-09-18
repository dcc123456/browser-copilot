/**
 * `take-screenshot`'s "save to computer" controls actually write a file.
 *
 * The form offers save-to-computer with a file name, a PNG/JPEG choice and a
 * JPEG quality slider; the executor ignored all of them and only ever stored a
 * data URL in a variable, so checking the box wrote nothing to disk. That
 * breaks the project rule that anything saved locally lands in the configured
 * download directory and reports success or failure either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDownloadDir: vi.fn(),
  writeFileToDownloadDir: vi.fn(),
  askSaveViaSidePanel: vi.fn(),
  captureVisiblePage: vi.fn(),
}))

vi.mock('../src/lib/download-dir', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/download-dir')>()
  return {
    ...actual,
    getDownloadDir: mocks.getDownloadDir,
    writeFileToDownloadDir: mocks.writeFileToDownloadDir,
    askSaveViaSidePanel: mocks.askSaveViaSidePanel,
  }
})

vi.mock('../src/background/capture', () => ({
  captureVisiblePage: mocks.captureVisiblePage,
}))

import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

const PNG_URL = 'data:image/png;base64,QUJD'

function makeCtx(vars: Record<string, unknown> = {}) {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: vars,
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

beforeEach(() => {
  mocks.getDownloadDir.mockResolvedValue({ name: 'Downloads' })
  mocks.writeFileToDownloadDir.mockResolvedValue(true)
  mocks.askSaveViaSidePanel.mockResolvedValue({ ok: false, canceled: false })
  mocks.captureVisiblePage.mockResolvedValue({ ok: true, dataUrl: PNG_URL })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('take-screenshot save-to-computer', () => {
  it('writes the decoded bytes to the configured download directory', async () => {
    const { ctx, emit } = makeCtx()
    await EXECUTORS['take-screenshot']!(
      { type: 'page', saveToComputer: true, fileName: 'home', ext: 'png' },
      ctx,
    )
    expect(mocks.writeFileToDownloadDir).toHaveBeenCalledTimes(1)
    const [, filename, data] = mocks.writeFileToDownloadDir.mock.calls[0] as [
      unknown,
      string,
      Uint8Array,
    ]
    expect(filename).toBe('home.png')
    // "ABC" in base64, decoded back to bytes — not the base64 text itself.
    expect(Array.from(data)).toEqual([65, 66, 67])
    expect(emit).toHaveBeenCalledWith('result', expect.stringContaining('已自动保存'))
    expect(ctx.variables['lastScreenshotPath']).toBe('home.png')
  })

  it('falls back to screenshot.png when no name is given', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['take-screenshot']!({ type: 'page', saveToComputer: true }, ctx)
    expect((mocks.writeFileToDownloadDir.mock.calls[0] as unknown[])[1]).toBe('screenshot.png')
  })

  it('keeps an extension the user already typed', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['take-screenshot']!(
      { type: 'page', saveToComputer: true, fileName: 'shot.png' },
      ctx,
    )
    expect((mocks.writeFileToDownloadDir.mock.calls[0] as unknown[])[1]).toBe('shot.png')
  })

  it('interpolates the file name from a variable', async () => {
    const { ctx } = makeCtx({ pageName: 'products' })
    await EXECUTORS['take-screenshot']!(
      { type: 'page', saveToComputer: true, fileName: '{{pageName}}' },
      ctx,
    )
    expect((mocks.writeFileToDownloadDir.mock.calls[0] as unknown[])[1]).toBe('products.png')
  })

  it('asks for JPEG and forwards the quality slider when ext is jpeg', async () => {
    mocks.captureVisiblePage.mockResolvedValue({ ok: true, dataUrl: 'data:image/jpeg;base64,QUJD' })
    const { ctx } = makeCtx()
    await EXECUTORS['take-screenshot']!(
      { type: 'page', saveToComputer: true, ext: 'jpeg', quality: 42 },
      ctx,
    )
    expect(mocks.captureVisiblePage).toHaveBeenCalledWith(undefined, {
      format: 'jpeg',
      quality: 42,
    })
    expect((mocks.writeFileToDownloadDir.mock.calls[0] as unknown[])[1]).toBe('screenshot.jpeg')
  })

  it('does not write anything when saveToComputer is off', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['take-screenshot']!({ type: 'page' }, ctx)
    expect(mocks.writeFileToDownloadDir).not.toHaveBeenCalled()
    expect(ctx.variables['lastScreenshot']).toBe(PNG_URL)
  })

  it('fails the step and does not claim a path when the write fails', async () => {
    mocks.getDownloadDir.mockResolvedValue(null)
    mocks.askSaveViaSidePanel.mockResolvedValue({ ok: false, canceled: false })
    const { ctx } = makeCtx()

    // Thrown: a failed write used to be ignored, so a step whose whole purpose
    // is the file reported success with nothing on disk.
    await expect(
      EXECUTORS['take-screenshot']!({ type: 'page', saveToComputer: true }, ctx),
    ).rejects.toThrow(/保存对话框/)

    expect(ctx.variables['lastScreenshotPath']).toBeUndefined()
  })

  it('reports a user cancel without claiming a path', async () => {
    mocks.getDownloadDir.mockResolvedValue(null)
    mocks.askSaveViaSidePanel.mockResolvedValue({ ok: false, canceled: true })
    const { ctx, emit } = makeCtx()
    await EXECUTORS['take-screenshot']!({ type: 'page', saveToComputer: true }, ctx)
    expect(emit).toHaveBeenCalledWith('result', '用户取消了保存')
    expect(ctx.variables['lastScreenshotPath']).toBeUndefined()
  })

  it('collects the capture into the named table column', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['take-screenshot']!(
      { type: 'page', saveToColumn: true, dataColumn: '截图' },
      ctx,
    )
    expect(ctx.variables['dataTable']).toEqual([{ 截图: PNG_URL }])
  })

  it('leaves the table alone when no column is named', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['take-screenshot']!({ type: 'page', saveToColumn: true }, ctx)
    expect(ctx.variables['dataTable']).toBeUndefined()
  })
})
