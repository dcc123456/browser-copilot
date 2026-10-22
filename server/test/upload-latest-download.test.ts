import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RunDriver, RecordedDownloadInfo } from '../src/driver'
import type { RunnerConfig } from '../src/config'
import { createExecutors } from '../src/executors'
import type { WorkflowExecCtx } from '../../src/background/workflow-engine/executors'

function makeCtx(): WorkflowExecCtx {
  return {
    variables: {},
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

function makeDriver(downloads: RecordedDownloadInfo[], captured: CapturedFile[][]): RunDriver {
  const stub = {
    listDownloads: () => downloads.map((entry) => ({ ...entry })),
    pageForUpload: () => ({
      locator: () => ({
        first: () => ({
          setInputFiles: async (payloads: CapturedFile[]) => {
            captured.push(payloads)
          },
        }),
      }),
    }),
    execOp: vi.fn(),
  }
  return stub as unknown as RunDriver
}

describe('runner upload-file latest-download', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-latest-download-'))
  const older = join(dir, 'report-2026-01.xlsx')
  const newest = join(dir, 'report-2026-02.xlsx')
  writeFileSync(older, 'january')
  writeFileSync(newest, 'february')

  const downloads: RecordedDownloadInfo[] = [
    { filename: 'report-2026-01.xlsx', path: older, url: '', lastModified: 1_000 },
    { filename: 'report-2026-02.xlsx', path: newest, url: '', lastModified: 5_000 },
    { filename: 'photo.png', path: null, url: 'https://x/photo.png', lastModified: 9_000 },
  ]

  it('uploads the newest saved download matching the filters', async () => {
    const captured: CapturedFile[][] = []
    const registry = createExecutors(makeDeps(makeDriver(downloads, captured)))
    await registry['upload-file']!(
      {
        sourceMode: 'latest-download',
        selector: '#report',
        accept: '.xlsx',
        filePattern: 'report-*',
      },
      makeCtx(),
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]?.[0]?.name).toBe('report-2026-02.xlsx')
    expect(captured[0]?.[0]?.buffer.toString()).toBe('february')
  })

  it('fails with UPLOAD_NO_MATCHING_FILE when no saved download matches', async () => {
    const captured: CapturedFile[][] = []
    const registry = createExecutors(makeDeps(makeDriver(downloads, captured)))
    await expect(
      registry['upload-file']!(
        { sourceMode: 'latest-download', selector: '#report', accept: '.pdf' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'UPLOAD_NO_MATCHING_FILE' })
    expect(captured).toHaveLength(0)
  })
})
