#!/usr/bin/env node
/**
 * Report the committed generation eval baseline.
 *
 * Reads the sanitized fixtures and prints the numbers the repository is
 * measured against: pass rate, goal certification, verified-and-proven replays,
 * coverage gaps, the mean ordinal score, and — because n is small — a Wilson
 * interval for each proportion and a seeded bootstrap interval for the mean.
 *
 * The scoring lives in `src/lib/workflow/generation-attempt.ts` and is loaded
 * from there; this script formats, it does not calculate.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTsModules } from './load-ts-module.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  let fixtures = path.join(ROOT, 'tests/fixtures/generation-eval')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--fixtures') fixtures = path.resolve(argv[++index])
    else throw new Error(`unknown argument ${argv[index]}`)
  }
  return { fixtures }
}

const percent = (value) => `${(value * 100).toFixed(1)}%`
const interval = (range) => `[${percent(range.low)}, ${percent(range.high)}]`

async function main() {
  const { fixtures } = parseArgs(process.argv.slice(2))
  const { attempt } = await loadTsModules({
    attempt: path.join(ROOT, 'src/lib/workflow/generation-attempt.ts'),
  })

  const names = readdirSync(fixtures)
    .filter((name) => /^round-\d{3}\.json$/.test(name))
    .sort()
  const records = names.map((name) =>
    attempt.normalizeGenerationAttempt(JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'))),
  )
  const missing = records.flatMap((record, index) => (record ? [] : [names[index]]))
  if (missing.length > 0) throw new Error(`unreadable fixtures: ${missing.join(', ')}`)

  const summary = attempt.summarizeGenerationAttempts(records)
  const line = (label, value, extra = '') =>
    console.log(`${label.padEnd(20)}${String(value).padEnd(10)}${extra}`)

  console.log(`generation eval corpus — ${summary.total} attempts (rounds 2–83)`)
  console.log('')
  line(
    'pass',
    `${summary.pass}/${summary.total}`,
    `${percent(summary.passRate)}  Wilson 95% ${interval(summary.passInterval)}`,
  )
  line(
    'goal-certified L3',
    `${summary.l3Certified}/${summary.total}`,
    `${percent(summary.l3Certified / summary.total)}  Wilson 95% ${interval(summary.l3Interval)}`,
  )
  line(
    'verified && proven',
    `${summary.verifiedAndProven}/${summary.total}`,
    percent(summary.verifiedAndProven / summary.total),
  )
  line(
    'coverage gaps',
    `${summary.coverageGapRounds}/${summary.total}`,
    percent(summary.coverageGapRounds / summary.total),
  )
  line(
    'mean score',
    summary.meanScore.toFixed(3),
    `bootstrap 95% ${interval(summary.meanScoreInterval)}`,
  )
  console.log('')
  line(
    'certified tiers',
    '',
    Object.entries(summary.byGoalLevel)
      .map(([level, count]) => `${level} ${count}`)
      .join(' · '),
  )
  console.log('')
  console.log('failures by kind:')
  for (const { kind, count } of summary.byFailureKind) {
    console.log(`  ${kind.padEnd(20)}${count}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
