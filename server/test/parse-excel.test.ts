import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { RunDriver } from '../src/driver'
import type { RunnerConfig } from '../src/config'
import { createExecutors } from '../src/executors'
import type { WorkflowExecCtx } from '../../src/background/workflow-engine/executors'
import type { WorkflowFileArtifact } from '../../src/lib/workflow/file-artifact'

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

function csvArtifact(text = 'name,amount\nA,1\nB,2'): WorkflowFileArtifact {
  return {
    type: 'file',
    name: 'report.csv',
    mimeType: 'text/csv',
    dataUrl: `data:text/csv;base64,${Buffer.from(text).toString('base64')}`,
    source: 'user',
  }
}

describe('runner parse-excel', () => {
  const driver = { execOp: vi.fn() } as unknown as RunDriver

  it('parses a variable file into both output rows', async () => {
    const registry = createExecutors(makeDeps(driver))
    const ctx = makeCtx({ lastFile: csvArtifact() })
    await registry['parse-excel']!(
      {
        sourceMode: 'workflow-file',
        fileVariable: 'lastFile',
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
    expect(ctx.variables['lastExcelRawRows']).toHaveLength(3)
  })

  it('fails user-select mode explicitly in the headless server', async () => {
    const registry = createExecutors(makeDeps(driver))
    await expect(
      registry['parse-excel']!({ sourceMode: 'user-select' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'UPLOAD_USER_SELECTION_CANCELLED' })
  })
})
