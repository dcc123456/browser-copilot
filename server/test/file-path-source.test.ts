import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RecordedDownloadInfo, RunDriver } from '../src/driver'
import type { RunnerConfig } from '../src/config'
import { createExecutors } from '../src/executors'
import type { WorkflowExecCtx } from '../../src/background/workflow-engine/executors'

function makeCtx(variables: Record<string, unknown> = {}): WorkflowExecCtx {
  return {
    variables,
    refData: null,
    signal: new AbortController().signal,
    outputs: {},
    emit: () => undefined,
  }
}

function makeDeps(driver: RunDriver) {
  return {
    driver,
    config: {
      dataDir: join(tmpdir(), 'bc-exec-test'),
      browser: { mode: 'local', headless: true, maxConcurrent: 1, cdpEndpoint: '' },
      feishu: { webhookUrl: '', webhookSecret: '' },
    } as unknown as RunnerConfig,
    artifactsDir: join(tmpdir(), 'bc-exec-artifacts'),
    signal: new AbortController().signal,
    provider: null,
  }
}

interface CapturedFile {
  name: string
  mimeType: string
  buffer: Buffer
}

function makeDriver(downloads: RecordedDownloadInfo[], captured?: CapturedFile[][]): RunDriver {
  const stub = {
    listDownloads: () => downloads.map((entry) => ({ ...entry })),
    pageForUpload: () =>
      captured
        ? {
            locator: () => ({
              first: () => ({
                setInputFiles: async (payloads: CapturedFile[]) => {
                  captured.push(payloads)
                },
              }),
            }),
          }
        : {},
    execOp: vi.fn(),
  }
  return stub as unknown as RunDriver
}

describe('runner file-path source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-file-path-'))
  const csvPath = join(dir, 'orders.csv')
  writeFileSync(csvPath, 'name,amount\nA,1\nB,2')
  const downloads: RecordedDownloadInfo[] = [
    { filename: 'orders.csv', path: csvPath, url: '', lastModified: 2_000 },
    { filename: 'broken.csv', path: null, url: 'https://x/broken.csv', lastModified: 1_000 },
  ]

  it('uploads the recorded download a nested path names (flat fallback)', async () => {
    const captured: CapturedFile[][] = []
    const registry = createExecutors(makeDeps(makeDriver(downloads, captured)))
    await registry['upload-file']!(
      { sourceMode: 'file-path', filePath: 'reports/orders.csv', selector: '#report' },
      makeCtx(),
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]?.[0]?.name).toBe('orders.csv')
    expect(captured[0]?.[0]?.buffer.toString()).toContain('name,amount')
  })

  it('parses the recorded spreadsheet a flat path names', async () => {
    const registry = createExecutors(makeDeps(makeDriver(downloads)))
    const ctx = makeCtx()
    await registry['parse-excel']!(
      {
        sourceMode: 'file-path',
        filePath: 'orders.csv',
        hasHeader: true,
        variableName: 'lastExcelRows',
        rawVariableName: 'lastExcelRawRows',
      },
      ctx,
    )
    expect(ctx.variables['lastExcelRows']).toEqual([
      { name: 'A', amount: '1' },
      { name: 'B', amount: '2' },
    ])
  })

  it('fails with UPLOAD_NO_MATCHING_FILE when this run did not download it', async () => {
    const captured: CapturedFile[][] = []
    const registry = createExecutors(makeDeps(makeDriver(downloads, captured)))
    await expect(
      registry['upload-file']!(
        { sourceMode: 'file-path', filePath: 'reports/missing.csv', selector: '#report' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'UPLOAD_NO_MATCHING_FILE' })
    expect(captured).toHaveLength(0)
  })

  it('rejects an absolute path before reading any download', async () => {
    const registry = createExecutors(makeDeps(makeDriver(downloads)))
    await expect(
      registry['upload-file']!(
        { sourceMode: 'file-path', filePath: '/tmp/orders.csv', selector: '#report' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'UPLOAD_FILE_DATA_INVALID' })
  })
})
