#!/usr/bin/env node
/**
 * Summarises the self-test corpus so a before/after comparison is reproducible.
 *
 * The corpus lives in `tmp/selftest-round*.json` — one file per real-browser
 * generation attempt, each holding the generated graph and its verdict. It is
 * gitignored, so the numbers that describe real generation quality exist
 * nowhere else; this script is the only way to recompute them.
 *
 * Usage: node scripts/selftest-corpus-stats.mjs [--dir tmp] [--top 10]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
const topArg = args.indexOf('--top')
const corpusDir = resolve(repoRoot, dirArg >= 0 ? args[dirArg + 1] : 'tmp')
const topN = topArg >= 0 ? Number(args[topArg + 1]) : 10

/**
 * Collapse a free-text verdict reason into a stable bucket.
 *
 * The raw reasons are long sentences that differ per round; counting them
 * verbatim would report a hundred singletons instead of the handful of
 * failure modes that actually recur.
 */
function normalizeReason(reason) {
  const text = String(reason ?? '')
    .split('\n')[0]
    .trim()
  if (!text) return '(no reason)'
  if (text.includes('READINESS_TIMEOUT')) {
    const code = text.match(/READINESS_TIMEOUT\([^)]*\)/)
    return code ? code[0] : 'READINESS_TIMEOUT'
  }
  if (text.includes('UNRESOLVED_INPUT')) return 'UNRESOLVED_INPUT'
  if (text.startsWith('L3 failed')) return 'L3 failed (goal conditions unmet)'
  if (text.startsWith('L2 failed')) return 'L2 failed (a node contract unmet)'
  if (text.startsWith('目标未达成')) return '目标未达成 (goal state not observed)'
  if (text.startsWith('the goal asks for a draft')) return 'missing terminal save action'
  if (text.startsWith('the replay stopped at step')) return 'replay stopped at cutoff'
  if (text.startsWith('the replay ran without failing a step')) return 'replay ran clean'
  if (text.includes('trial budget exhausted')) return 'trial budget exhausted'
  if (text.includes('network error')) return 'network error'
  if (text.includes('service worker is GONE')) return 'extension worker died'
  if (text.includes('reload_extension refused')) return 'reload refused by settings'
  if (text.includes('no reload within')) return 'no reload observed'
  if (text.includes('插件已断开连接')) return 'extension disconnected'
  if (text.includes('The agent produced no answer')) return 'agent produced no answer'
  if (text.includes('No draft to compose')) return 'no draft composed'
  if (text.includes('javascript-code')) return 'javascript-code error'
  if (text.includes('AI 智能体')) return 'ai-agent step failed'
  if (text.includes('save-local')) return 'save-local failed'
  return text.slice(0, 56)
}

/**
 * How many operator steps failed during generation and were never retried.
 *
 * The composed workflow reports it as a save warning ("Generation coverage gap:
 * N operator step(s) failed during generation and were not retried"), and it
 * is the only per-round trace of operator-level failures the corpus keeps.
 * It is the metric a failure-diagnosis change should move: a model that is
 * told what class of failure it hit has a chance to recover the step instead
 * of shipping the workflow with a hole in it.
 */
function unrecoveredOperatorFailures(parsed) {
  const workflows = [
    parsed?.phases?.generate?.result?.workflow,
    parsed?.phases?.verify?.result?.workflow,
  ]
  for (const workflow of workflows) {
    const warnings = workflow?.saveWarnings
    if (!Array.isArray(warnings)) continue
    for (const warning of warnings) {
      const matched = /Generation coverage gap: (\d+) operator step\(s\)/.exec(String(warning))
      if (matched) return Number(matched[1])
    }
  }
  return 0
}

let files
try {
  files = readdirSync(corpusDir)
    .filter((name) => /^selftest-round.*\.json$/.test(name))
    .sort()
} catch {
  console.log(`[selftest-corpus-stats] no corpus at ${corpusDir} — nothing to summarise.`)
  process.exit(0)
}

// A corpus that grows over time mixes the rounds of every era, and a before /
// after comparison needs the two halves apart. The round number in the file
// name is the only thing that orders them, so it is also the filter.
const roundNumberOf = (name) => {
  const matched = /^selftest-round(\d+)\.json$/.exec(name)
  return matched ? Number(matched[1]) : undefined
}
const fromArg = args.indexOf('--from')
const toArg = args.indexOf('--to')
const fromRound = fromArg >= 0 ? Number(args[fromArg + 1]) : undefined
const toRound = toArg >= 0 ? Number(args[toArg + 1]) : undefined
if (fromRound !== undefined || toRound !== undefined) {
  files = files.filter((name) => {
    const number = roundNumberOf(name)
    if (number === undefined) return false
    if (fromRound !== undefined && number < fromRound) return false
    if (toRound !== undefined && number > toRound) return false
    return true
  })
}

// A round that never reached the product — the provider's quota was spent, the
// browser was gone — measures the environment, not the pipeline. Counting it
// would make a product comparison meaningless, so it can be dropped by reason.
const excludeArg = args.indexOf('--exclude')
const excludeText = excludeArg >= 0 ? String(args[excludeArg + 1] ?? '') : ''

const rounds = []
for (const name of files) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(resolve(corpusDir, name), 'utf8'))
  } catch {
    continue
  }
  const verdict = parsed?.verdict ?? {}
  const reason = normalizeReason(verdict.reason)
  if (excludeText && reason.includes(excludeText)) continue
  rounds.push({
    name,
    pass: verdict.pass === true,
    stage: verdict.stage ?? '(none)',
    goalCertified: verdict.goalCertified === true,
    verified: verdict.verified === true,
    proven: verdict.proven === true,
    repairStatus: verdict.repairStatus ?? '(none)',
    reason,
    unrecoveredFailures: unrecoveredOperatorFailures(parsed),
  })
}

if (rounds.length === 0) {
  console.log(
    `[selftest-corpus-stats] ${files.length} file(s) found but none held a readable verdict.`,
  )
  process.exit(0)
}

const tally = (key) => {
  const counts = new Map()
  for (const round of rounds) counts.set(round[key], (counts.get(round[key]) ?? 0) + 1)
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])),
  )
}

const total = rounds.length
const passed = rounds.filter((r) => r.pass).length
const certified = rounds.filter((r) => r.goalCertified).length
const verifiedProven = rounds.filter((r) => r.verified && r.proven).length
const withGap = rounds.filter((r) => r.unrecoveredFailures > 0).length
const unrecoveredTotal = rounds.reduce((sum, r) => sum + r.unrecoveredFailures, 0)
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`

console.log(`[selftest-corpus-stats] ${total} round(s) from ${corpusDir}`)
console.log(`  verdict.pass        ${passed}/${total}  (${pct(passed)})`)
console.log(`  goalCertified (L3)  ${certified}/${total}  (${pct(certified)})`)
console.log(`  verified && proven  ${verifiedProven}/${total}  (${pct(verifiedProven)})`)
console.log(
  `  generation gaps      ${withGap}/${total} rounds (${pct(withGap)})  ` +
    `${unrecoveredTotal} unrecovered operator step(s) total`,
)

console.log('\n  failure stage:')
for (const [stage, count] of tally('stage')) {
  console.log(`    ${String(count).padStart(3)}  ${pct(count).padStart(6)}  ${stage}`)
}

console.log('\n  repair status:')
for (const [status, count] of tally('repairStatus')) {
  console.log(`    ${String(count).padStart(3)}  ${status}`)
}

console.log(`\n  top ${topN} failure reasons:`)
for (const [reason, count] of tally('reason').slice(0, topN)) {
  console.log(`    ${String(count).padStart(3)}  ${reason}`)
}
