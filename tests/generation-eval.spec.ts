/**
 * The committed generation eval corpus is the baseline the rest of this work
 * is measured against, so it is pinned here rather than trusted: every fixture
 * must read back as an attempt, re-score to exactly the number stored in it,
 * stay free of personal data, and aggregate to the manifest's golden numbers.
 *
 * The corpus is rounds 2–83 of the real-model `pnpm selftest` history. Round 1
 * was never written; 84+ are excluded (see `manifest.json`).
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  normalizeGenerationAttempt,
  scoreGenerationAttempt,
  summarizeGenerationAttempts,
  type GenerationAttemptRecord,
} from '../src/lib/workflow/generation-attempt'
import { assertFixtureSafe, sanitizeAttempt } from '../src/lib/workflow/generation-corpus'

const CORPUS_DIR = path.join(process.cwd(), 'tests/fixtures/generation-eval')

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(CORPUS_DIR, name), 'utf8')) as T
}

interface Manifest {
  rounds: { from: number; to: number }
  count: number
  missing: number[]
  excluded: { from: number; to: number; reason: string }
  golden: ReturnType<typeof summarizeGenerationAttempts>
}

const manifest = readJson<Manifest>('manifest.json')
const fixtureFiles = readdirSync(CORPUS_DIR)
  .filter((name) => /^round-\d{3}\.json$/.test(name))
  .sort()
const records = fixtureFiles.map((name) => readJson<GenerationAttemptRecord>(name))

function round(number: number): GenerationAttemptRecord {
  const found = records.find((record) => record.round === number)
  if (!found) throw new Error(`round ${number} is not in the corpus`)
  return found
}

describe('generation eval corpus', () => {
  it('ships exactly the rounds 2–83 fixtures, with round 1 recorded as missing', () => {
    expect(manifest.count).toBe(82)
    expect(manifest.rounds).toEqual({ from: 2, to: 83 })
    expect(manifest.missing).toEqual([1])
    expect(manifest.excluded).toEqual({
      from: 84,
      to: 112,
      reason: '429 quota + concurrent src edits',
    })
    expect(fixtureFiles).toHaveLength(82)
    expect(records.map((record) => record.round)).toEqual(
      Array.from({ length: 82 }, (_, index) => index + 2),
    )
  })

  it('reads every fixture back as an attempt and re-scores to the stored value', () => {
    for (const record of records) {
      expect(normalizeGenerationAttempt(record)).toEqual(record)
      expect(scoreGenerationAttempt(record)).toBe(record.score)
    }
  })

  it('keeps nothing personal or live in any fixture', () => {
    for (const record of records) assertFixtureSafe(record)
  })

  it('aggregates to the frozen baseline in the manifest', () => {
    expect(summarizeGenerationAttempts(records)).toEqual(manifest.golden)
  })

  it('keeps the baseline this repository measured before the corpus existed', () => {
    // These four numbers are the reason the corpus exists; a change to them is
    // a change to the baseline, not a refactor.
    expect(manifest.golden).toMatchObject({
      total: 82,
      pass: 9,
      l3Certified: 3,
      verifiedAndProven: 19,
      coverageGapRounds: 40,
    })
    expect(manifest.golden.passInterval).toEqual({ low: 0.0588, high: 0.1956 })
    expect(manifest.golden.l3Interval).toEqual({ low: 0.0125, high: 0.1021 })
    // The mean itself is frozen here too; regenerating the corpus after a
    // scoring change must update the manifest explicitly.
    expect(manifest.golden.meanScore).toBe(0.331)
  })

  it('maps each known failure family onto the shared taxonomy', () => {
    // Round 5 is a failed replay whose recorded code carries a visibility
    // suffix; round 8 is the dataflow guard's own code, which is not in the
    // runtime table; round 25 is a generation-stage graph with no terminal save.
    expect(round(5).failureKind).toBe('readiness')
    expect(round(8).failureKind).toBe('dataflow')
    expect(round(25).failureKind).toBe('intent')
    // Round 78 stopped at the unsafe cutoff without any static finding; round 2
    // never got past the harness.
    expect(round(78).failureKind).toBe('side-effect')
    expect(round(2).failureKind).toBe('environment')
    // And a certified replay has no failure at all.
    expect(round(74).pass).toBe(true)
    expect(round(74).failureKind).toBeUndefined()
    expect(round(74).replay).toMatchObject({
      verified: true,
      goal: { level: 'L3', certified: true },
    })
  })
})

describe('corpus redaction', () => {
  it('drops the wall clock and any live identifier a caller brought', () => {
    const sanitized = sanitizeAttempt({
      ...records[0],
      at: 1_790_000_000_000,
      attemptId: 'muo9kqeo-4cua4p73',
    })
    expect(sanitized).toMatchObject({ at: 0, attemptId: 'redacted' })
    expect(sanitized?.score).toBe(records[0]?.score)
  })

  it('refuses records that carry personal data or live ids', () => {
    const leaks = [
      { id: 'wf-1' },
      { runId: 'run-77' },
      { note: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
      { note: 'someone@example.com' },
      { note: '13800138000' },
      { origin: 'https://creator.xiaohongshu.com/publish?target=image' },
      { note: '小红书创作服务平台生成图文' },
    ]
    for (const leak of leaks) {
      expect(() => assertFixtureSafe({ ...records[0], ...leak })).toThrow(/fixture leak/)
    }
  })
})
