#!/usr/bin/env node
/**
 * Export the real-model generation rounds as sanitized eval fixtures.
 *
 * Reads `selftest-round{2..83}.json` (written by `pnpm selftest`), maps each
 * through `legacyAttemptFromRound`, drops every personal or live field, and
 * writes one stable fixture per round plus `manifest.json` with the frozen
 * baseline. `--check` re-derives everything and compares bytes, so a change to
 * the mapping or the scorer fails the gate instead of silently rewriting the
 * baseline.
 *
 * Round numbers come from the file name; the corpus module stays synchronous.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'
import { loadTsModules } from './load-ts-module.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'tests/fixtures/generation-eval')
const FIXTURE_NAME = (round) => `round-${String(round).padStart(3, '0')}.json`

/** Same formatter the repository's `format:check` gate runs. */
const prettyJson = (value) => format(JSON.stringify(value), { parser: 'json' })

function parseArgs(argv) {
  const args = { check: false, source: undefined, out: OUT_DIR }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') args.check = true
    else if (arg === '--source') args.source = path.resolve(argv[++index])
    else if (arg === '--out') args.out = path.resolve(argv[++index])
    else throw new Error(`unknown argument ${arg}`)
  }
  return args
}

/**
 * Where the rounds live. The export can run from the worktree (whose parent is
 * the repository that holds `tmp/`), so the default probes both the plain
 * repository layout and the one-level-deeper worktree layout.
 */
function resolveSource(explicit) {
  const candidates = explicit ? [explicit] : [path.join(ROOT, 'tmp'), path.join(ROOT, '../../tmp')]
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'selftest-round2.json'))) return candidate
  }
  throw new Error(`no selftest rounds under ${candidates.join(' or ')}`)
}

function buildStampHashOf(raw) {
  const stamp = typeof raw?.buildStamp === 'string' ? raw.buildStamp : undefined
  return stamp ? createHash('sha256').update(stamp).digest('hex').slice(0, 12) : undefined
}

async function buildCorpus(source, corpusModule, attemptModule) {
  const fixtures = new Map()
  const records = []
  const missing = []
  for (let round = 1; round <= corpusModule.CORPUS_LAST_ROUND; round += 1) {
    const file = path.join(source, `selftest-round${round}.json`)
    if (!existsSync(file)) {
      missing.push(round)
      continue
    }
    const raw = JSON.parse(await readFile(file, 'utf8'))
    const buildStampHash = buildStampHashOf(raw)
    const attempt = corpusModule.legacyAttemptFromRound(raw, {
      round,
      ...(buildStampHash ? { buildStampHash } : {}),
    })
    if (!attempt) throw new Error(`round ${round} did not map to an attempt`)
    const sanitized = corpusModule.sanitizeAttempt(attempt)
    if (!sanitized) throw new Error(`round ${round} did not survive sanitizing`)
    corpusModule.assertFixtureSafe(sanitized)
    records.push(sanitized)
    fixtures.set(FIXTURE_NAME(round), await prettyJson(sanitized))
  }
  const manifest = {
    source: 'tmp/selftest-round{2..83}.json',
    rounds: { from: corpusModule.CORPUS_FIRST_ROUND, to: corpusModule.CORPUS_LAST_ROUND },
    count: records.length,
    missing,
    excluded: corpusModule.CORPUS_EXCLUDED,
    golden: attemptModule.summarizeGenerationAttempts(records),
  }
  fixtures.set('manifest.json', await prettyJson(manifest))
  return fixtures
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { corpus, attempt } = await loadTsModules({
    corpus: path.join(ROOT, 'src/lib/workflow/generation-corpus.ts'),
    attempt: path.join(ROOT, 'src/lib/workflow/generation-attempt.ts'),
  })
  const fixtures = await buildCorpus(resolveSource(args.source), corpus, attempt)

  if (!args.check) {
    await mkdir(args.out, { recursive: true })
    for (const [name, content] of fixtures) await writeFile(path.join(args.out, name), content)
    const golden = JSON.parse(fixtures.get('manifest.json')).golden
    console.log(
      `wrote ${fixtures.size - 1} fixtures to ${path.relative(ROOT, args.out)} ` +
        `(pass ${golden.pass}/${golden.total}, L3 ${golden.l3Certified}, mean ${golden.meanScore})`,
    )
    return
  }

  const written = new Set(await readdir(args.out))
  const problems = []
  for (const [name, content] of fixtures) {
    if (!written.has(name)) {
      problems.push(`missing ${name}`)
      continue
    }
    const onDisk = await readFile(path.join(args.out, name), 'utf8')
    if (onDisk !== content) problems.push(`out of date ${name}`)
    written.delete(name)
  }
  for (const extra of written) problems.push(`unexpected ${extra}`)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    throw new Error('generation eval corpus is stale; run without --check to regenerate')
  }
  console.log(`generation eval corpus is up to date (${fixtures.size - 1} fixtures)`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
