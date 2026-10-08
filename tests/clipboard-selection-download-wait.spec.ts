/**
 * Two clipboard/download options, pinned in the EXTENSION host.
 *
 * The real-browser matrix found both advertised but inert, and it proves the
 * shared half (the kernel script, the poll shape) — not the extension's own
 * executor, which is the copy that actually runs inside the loaded extension:
 *
 *  - `clipboard.copySelectedText` still read the SYSTEM clipboard, so the
 *    variable received whatever an earlier block had copied. It now runs a page
 *    read (`window.getSelection()`) through the workflow-JS channel.
 *  - `handle-download` searched `chrome.downloads` exactly once, so a file that
 *    landed a moment later was reported as 未找到匹配下载. It now honours the
 *    block's own `timeout`, and `waitForDownload: false` opts back out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    clipboardGet: vi.fn(async () => 'system-clipboard-content'),
    clipboardInsert: vi.fn(async () => {}),
    execWorkflowJsOnActiveTab: vi.fn(async () => ({
      ok: true,
      data: { result: 'text selected on the page' },
    })),
  }
})

import { clipboardGet, execWorkflowJsOnActiveTab } from '../src/background/driver'

function makeCtx(): WorkflowExecCtx {
  return {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    emit: vi.fn() as unknown as WorkflowExecCtx['emit'],
  }
}

/** Install a `chrome.downloads.search` double returning these pages of items. */
function installDownloads(pages: Array<Array<{ id: number; filename: string; url: string }>>) {
  const search = vi.fn(async () => {
    const next = pages.shift() ?? []
    return next
  })
  vi.stubGlobal('chrome', { downloads: { search } })
  return search
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('clipboard.copySelectedText', () => {
  it('reads the page selection instead of the system clipboard', async () => {
    const ctx = makeCtx()
    await EXECUTORS['clipboard']!(
      { op: 'get', copySelectedText: true, variableName: 'sel' },
      ctx,
    )

    expect(ctx.variables['sel']).toBe('text selected on the page')
    expect(clipboardGet).not.toHaveBeenCalled()
    const script = vi.mocked(execWorkflowJsOnActiveTab).mock.calls[0]![0]
    expect(script).toContain('window.getSelection()')
  })

  it('still uses the system clipboard when the option is off', async () => {
    const ctx = makeCtx()
    await EXECUTORS['clipboard']!({ op: 'get', variableName: 'clip' }, ctx)

    expect(ctx.variables['clip']).toBe('system-clipboard-content')
    expect(execWorkflowJsOnActiveTab).not.toHaveBeenCalled()
  })

  it('fails the node when the page read fails', async () => {
    vi.mocked(execWorkflowJsOnActiveTab).mockResolvedValueOnce({
      ok: false,
      error: '页面不可脚本化',
    } as never)
    const ctx = makeCtx()
    await expect(
      EXECUTORS['clipboard']!({ op: 'get', copySelectedText: true }, ctx),
    ).rejects.toThrow(/剪贴板 get 失败/)
  })
})

describe('handle-download wait', () => {
  it('keeps polling until the download appears', async () => {
    const search = installDownloads([
      [],
      [{ id: 7, filename: '/d/report.csv', url: 'https://example.com/report.csv' }],
    ])
    const ctx = makeCtx()
    const started = Date.now()

    await EXECUTORS['handle-download']!(
      { filename: 'report.csv', variableName: 'dl', timeout: 5000 },
      ctx,
    )

    expect(search.mock.calls.length).toBeGreaterThan(1)
    expect(ctx.variables['dl']).toMatchObject({ id: 7, filename: '/d/report.csv' })
    // The wait must be shorter than the budget it was given — it returns the
    // moment the file shows up rather than burning the whole timeout.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('searches exactly once when the wait is switched off', async () => {
    const search = installDownloads([[]])
    const ctx = makeCtx()

    await EXECUTORS['handle-download']!(
      { filename: 'report.csv', waitForDownload: false, timeout: 5000 },
      ctx,
    )

    expect(search.mock.calls.length).toBe(1)
    expect(ctx.variables['lastDownload']).toBeNull()
  })

  it('gives up when the timeout expires and records null', async () => {
    const search = installDownloads([[], [], [], []])
    const ctx = makeCtx()

    await EXECUTORS['handle-download']!({ filename: 'gone.csv', timeout: 300 }, ctx)

    expect(ctx.variables['lastDownload']).toBeNull()
    expect(search.mock.calls.length).toBeLessThan(5)
  })
})
