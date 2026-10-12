import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { observeUsage, setUsageObserver } from '../../src/lib/llm'
import {
  dayKeyOf,
  entityKeyFor,
  MAX_TOKEN_RECORDS,
  recordOf,
  type TokenAttribution,
  type TokenUsageRecord,
} from '../../src/lib/token-ledger'
import { buildHttpApi } from '../src/http-api'
import { loadConfig } from '../src/config'
import { WorkflowLibrary } from '../src/workflow-library'
import { RunService } from '../src/run-service'
import { BrowserPool } from '../src/browser-pool'
import {
  appendTokenRecords,
  installTokenAccounting,
  readTokenDashboard,
  readTokenLedger,
  tokenLedgerFile,
} from '../src/token-accounting'

let dir: string
const attribution: TokenAttribution = {
  consumer: 'workflow-run',
  entityKey: entityKeyFor('workflow', 'wf-1'),
  entityLabel: 'Nightly crawl',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-tokens-'))
})

afterEach(() => {
  setUsageObserver(null)
  rmSync(dir, { recursive: true, force: true })
})

function sendUsage(inputTokens: number, outputTokens: number): void {
  observeUsage(
    { attribution, model: 'gpt-test' },
    { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  )
}

describe('runner token ledger', () => {
  it('records one entry per attributed completion, and none for unattributed ones', async () => {
    const file = tokenLedgerFile(dir)
    installTokenAccounting(file)

    sendUsage(100, 20)
    sendUsage(50, 10)
    observeUsage({ model: 'gpt-test' }, { inputTokens: 999, outputTokens: 9, totalTokens: 1008 })
    await vi.waitFor(async () => {
      const { records } = await readTokenLedger(file)
      expect(records).toHaveLength(2)
    })

    const { records, daily } = await readTokenLedger(file)
    // Newest first, and the rollup derived from the same records.
    expect(records.map((record) => record.inputTokens)).toEqual([50, 100])
    expect(records[0]?.entityLabel).toBe('Nightly crawl')
    expect(daily[dayKeyOf(records[0]?.at as number)]?.totals.totalTokens).toBe(180)
  })

  it('reads a missing or corrupt ledger as empty instead of throwing', async () => {
    const missing = await readTokenLedger(join(dir, 'absent.json'))
    expect(missing).toEqual({ records: [], daily: {} })

    const corrupt = join(dir, 'corrupt.json')
    writeFileSync(corrupt, '{not json', 'utf8')
    expect(await readTokenLedger(corrupt)).toEqual({ records: [], daily: {} })

    const dashboard = await readTokenDashboard(corrupt, 'today')
    expect(dashboard.totals.requests).toBe(0)
    expect(dashboard.byConsumer).toEqual([])
  })

  it('caps the detail and keeps the day rollup whole', async () => {
    const file = join(dir, 'ledger.json')
    const day = 24 * 60 * 60 * 1000
    const oldest = Date.now() - MAX_TOKEN_RECORDS * day
    const seed = (id: string, at: number): TokenUsageRecord =>
      recordOf(
        { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        {
          id,
          at,
          consumer: 'workflow-run',
          entityKey: attribution.entityKey,
          entityLabel: 'Nightly crawl',
          model: 'gpt-test',
        },
      )
    // One record per day: the rollup then has one day key per record, which is
    // what makes "the detail was capped but the history was not" observable.
    const records = Array.from({ length: MAX_TOKEN_RECORDS }, (_, index) =>
      seed(`r-${index}`, oldest + index * day),
    )
    await appendTokenRecords(file, records)
    await appendTokenRecords(file, [seed('new', Date.now())])

    const { records: stored, daily } = await readTokenLedger(file)
    expect(stored).toHaveLength(MAX_TOKEN_RECORDS)
    expect(stored[0]?.id).toBe('new')
    // History is reported from the rollup, so truncating the detail cannot
    // shrink "since first use".
    expect(Object.keys(daily)).toHaveLength(MAX_TOKEN_RECORDS + 1)
    const dashboard = await readTokenDashboard(file, 'all')
    expect(dashboard.totals.requests).toBe(MAX_TOKEN_RECORDS + 1)
  })

  it('serves the dashboard over the API and defaults to the whole history', async () => {
    const config = {
      ...loadConfig(),
      dataDir: dir,
      workflowsFile: join(dir, 'workflows.json'),
      workflowsExtraDir: '',
      token: '',
    }
    const library = new WorkflowLibrary(config.workflowsFile)
    library.load()
    const runs = new RunService(config, new BrowserPool(config), library)
    const app: FastifyInstance = buildHttpApi({ config, library, runs, onLibraryChanged: () => {} })
    try {
      installTokenAccounting(tokenLedgerFile(dir))
      sendUsage(120, 30)
      await vi.waitFor(async () => {
        const { records } = await readTokenLedger(tokenLedgerFile(dir))
        expect(records).toHaveLength(1)
      })

      const res = await app.inject({ method: 'GET', url: '/api/tokens/stats' })
      expect(res.statusCode).toBe(200)
      expect(res.json().stats.range).toBe('all')
      expect(res.json().stats.totals.totalTokens).toBe(150)

      // A bogus range is not an error: it falls back rather than emptying the
      // dashboard for a mistyped link.
      const bogus = await app.inject({ method: 'GET', url: '/api/tokens/stats?range=nope' })
      expect(bogus.json().stats.range).toBe('all')
      const today = await app.inject({ method: 'GET', url: '/api/tokens/stats?range=today' })
      expect(today.json().stats.range).toBe('today')
    } finally {
      await app.close()
    }
  })
})
