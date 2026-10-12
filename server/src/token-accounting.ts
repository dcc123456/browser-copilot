/**
 * Token accounting for the Runner host.
 *
 * The mirror of `src/background/token-accounting.ts`: the same observer hook in
 * `lib/llm` turns every attributed completion into one ledger record, and the
 * same pure functions in `lib/token-ledger` do the rollup and the aggregation,
 * so a token counted here and a token counted in the extension are counted
 * identically (design §4.7 — one accounting rule, two hosts).
 *
 * Storage differs only in the medium: the Runner owns `<dataDir>/token-usage.json`
 * and must not write extension storage. Writes are serialized in-process because
 * the ledger is a read-modify-write file; a lost record is lost spend.
 *
 * @module server/token-accounting
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setUsageObserver, type UsageEvent } from '../../src/lib/llm'
import {
  applyRecordToDaily,
  buildTokenDashboard,
  coerceDailyStore,
  coerceTokenRecord,
  MAX_TOKEN_RECORDS,
  recordOf,
  type TokenDailyStore,
  type TokenDashboard,
  type TokenLedger,
  type TokenRange,
  type TokenUsageRecord,
} from '../../src/lib/token-ledger'
import { logger } from './observability'

/** File name the ledger lives under inside the Runner's data directory. */
const LEDGER_FILE = 'token-usage.json'

/** Absolute path of the Runner's ledger, for the boot wiring and the API route. */
export function tokenLedgerFile(dataDir: string): string {
  return join(dataDir, LEDGER_FILE)
}

/** One observed completion → one ledger record. */
export function recordFromEvent(event: UsageEvent, id: string, at = Date.now()): TokenUsageRecord {
  const { attribution } = event
  return recordOf(event.usage, {
    id,
    at,
    consumer: attribution.consumer,
    entityKey: attribution.entityKey,
    // The Runner always knows the entity's own name (a workflow, a takeover
    // target); without it the key still yields a readable row.
    entityLabel: attribution.entityLabel?.trim() || attribution.entityKey,
    model: event.model,
  })
}

/** Reads and coerces the ledger; a missing or corrupt file reads as empty. */
export async function readTokenLedger(file: string): Promise<TokenLedger> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { records: [], daily: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn('[token-accounting] ledger file is not valid JSON, starting empty')
    return { records: [], daily: {} }
  }
  const entry = (parsed ?? {}) as Partial<TokenLedger>
  const records = Array.isArray(entry.records)
    ? entry.records
        .map(coerceTokenRecord)
        .filter((record): record is TokenUsageRecord => record !== null)
    : []
  return { records, daily: coerceDailyStore(entry.daily) }
}

/**
 * Appends records: newest detail first, capped detail, uncapped day rollup.
 *
 * Same rules as `lib/storage.ts` `recordTokenUsage`, because the two halves must
 * stay consistent — the detail bounds the hourly chart, the rollup bounds
 * history, and truncating the rollup would silently shrink "since first use".
 */
export async function appendTokenRecords(
  file: string,
  incoming: readonly TokenUsageRecord[],
): Promise<void> {
  if (incoming.length === 0) return
  const ledger = await readTokenLedger(file)
  const records = [...incoming, ...ledger.records]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_TOKEN_RECORDS)
  const daily: TokenDailyStore = ledger.daily
  for (const record of incoming) applyRecordToDaily(daily, record)
  const payload = `${JSON.stringify({ records, daily })}\n`
  const temporary = `${file}.${process.pid}.tmp`
  await mkdir(dirname(file), { recursive: true })
  // Write-then-rename: a crash mid-write leaves the previous ledger intact
  // rather than a truncated file that parses as nothing.
  await writeFile(temporary, payload, 'utf8')
  await rename(temporary, file)
}

/** One dashboard over the Runner's own ledger, for the read-only API route. */
export async function readTokenDashboard(file: string, range: TokenRange): Promise<TokenDashboard> {
  const { records, daily } = await readTokenLedger(file)
  return buildTokenDashboard(records, daily, range)
}

/**
 * Starts recording every attributed completion into `file`.
 *
 * Flush per request, chained on the previous write: the Runner is long-lived,
 * so an unchained append would let two turns read the same file and the later
 * write would drop the earlier one.
 */
export function installTokenAccounting(file: string): void {
  let pending: Promise<void> = Promise.resolve()
  setUsageObserver((event) => {
    const record = recordFromEvent(event, randomUUID())
    pending = pending
      .then(() => appendTokenRecords(file, [record]))
      .catch((error: unknown) => {
        logger.warn(`[token-accounting] could not persist usage: ${String(error)}`)
      })
  })
}
