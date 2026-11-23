#!/usr/bin/env node
/**
 * Rebuilds `memory/` from git history (AGENTS.md §9).
 *
 * The rule is "one file per commit day", so this walks `git log --reverse`,
 * groups by the commit's own date, and appends one entry per CODE commit plus a
 * single merged `docs:` entry per day. Everything it writes is marked `（回填）`
 * and its 验证 / 遗留 lines say 未记录: a commit message cannot prove which gates
 * ran back then, and inventing "green" would be the most damaging thing this
 * script could do.
 *
 * Idempotent: an entry whose subject is already in the day's file is skipped, so
 * re-running it adds nothing. Existing entries are never edited or removed.
 *
 * Run: node scripts/memory-backfill.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const MEMORY = join(ROOT, 'memory')
const dryRun = process.argv.includes('--dry-run')

const FIELD = '\u001f'
const raw = execFileSync(
  'git',
  ['log', '--reverse', '--date=short', `--pretty=format:@@%H${FIELD}%ad${FIELD}%s`, '--name-only'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)

/** @type {{ hash: string, date: string, subject: string, files: string[] }[]} */
const commits = []
for (const line of raw.split('\n')) {
  if (line.startsWith('@@')) {
    const [hash, date, subject] = line.slice(2).split(FIELD)
    commits.push({ hash, date, subject, files: [] })
    continue
  }
  if (line.trim() === '') continue
  commits[commits.length - 1]?.files.push(line.trim())
}

const isDocs = (subject) => /^docs(\(|:)/.test(subject)
const timeOf = (hash) =>
  execFileSync('git', ['log', '-1', '--date=format:%H:%M', '--pretty=%ad', hash], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
/** Module names, capped: a first commit touching thirty root files is a list, not a summary. */
function modulesOf(files) {
  const modules = [...new Set(files.map((file) => file.split('/').slice(0, 2).join('/')))]
  const shown = modules.slice(0, 8)
  return shown.length < modules.length ? [...shown, `等 ${modules.length} 项`] : shown
}

/** Subjects already logged in a day file, so a second run adds nothing.
 *  The `（回填）` marker is stripped BEFORE comparing: leaving it in the key made
 *  every backfilled entry look new on the next run (the marker is not part of the
 *  commit subject), which is exactly the duplicate this check exists to prevent. */
/** Comparison key: BOM stripped and edges trimmed. A file entry and the git
 *  subject must agree on this, or every run re-adds the same commits (that is how
 *  the BOM and the padded subject were caught).
 *
 *  What is WRITTEN is `subject.trim()`: prettier collapses leading/trailing run
 *  whitespace in Markdown and `format:check` must pass, so one historical subject
 *  with leading spaces is stored without them. */
const normalizeSubject = (subject) => subject.replace(/^\uFEFF/, '').trim()

function loggedSubjects(text) {
  const subjects = new Set()
  for (const line of text.split('\n')) {
    const match = /^## \d{2}:\d{2} · (.+)$/.exec(line)
    if (match) subjects.add(normalizeSubject(match[1].replace(/（回填）$/, '')))
  }
  return subjects
}

function entryBlock({ time, title, change, modules }) {
  return [
    `## ${time} · ${title}（回填）`,
    '',
    `- 变更：${change}`,
    `- 模块：${modules.join('、') || '（无文件变化）'}`,
    '- 验证：未记录',
    '- 遗留：未记录',
    '',
  ].join('\n')
}

mkdirSync(MEMORY, { recursive: true })
const byDate = new Map()
for (const commit of commits) {
  const day = byDate.get(commit.date) ?? []
  day.push(commit)
  byDate.set(commit.date, day)
}

const added = []
for (const [date, dayCommits] of [...byDate.entries()].sort()) {
  const file = join(MEMORY, `${date}.md`)
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : `# ${date} 修改记录\n\n`
  const logged = loggedSubjects(existing)
  const blocks = []

  for (const commit of dayCommits.filter((entry) => !isDocs(entry.subject))) {
    if (logged.has(normalizeSubject(commit.subject))) continue
    logged.add(normalizeSubject(commit.subject))
    blocks.push(
      entryBlock({
        time: timeOf(commit.hash),
        title: commit.subject.trim(),
        change: commit.subject.trim(),
        modules: modulesOf(commit.files),
      }),
    )
  }

  // One merged entry for the day's docs commits — unless the day already has a
  // `docs:` entry (a hand-written one covers them).
  const docsCommits = dayCommits.filter((entry) => isDocs(entry.subject))
  const hasDocsEntry = [...logged].some((subject) => /^docs:/.test(subject))
  if (docsCommits.length > 0 && !hasDocsEntry) {
    const missing = docsCommits.filter((commit) => !logged.has(normalizeSubject(commit.subject)))
    if (missing.length > 0) {
      // Every subject, verbatim: a mechanical check greps the commit subject, so
      // an abridged list ("等 N 条") would look like a missing record.
      blocks.push(
        entryBlock({
          time: timeOf(missing[0].hash),
          title: `docs: 文档与规范变更（${missing.length} 条）`,
          change: missing.map((commit) => commit.subject.trim()).join('；'),
          modules: modulesOf(missing.flatMap((commit) => commit.files)),
        }),
      )
    }
  }

  if (blocks.length === 0) continue
  const next = `${existing.replace(/\s*$/, '')}\n\n${blocks.join('\n')}`
  if (!dryRun) writeFileSync(file, next)
  added.push({ date, entries: blocks.length })
}

// index.md: ONE row per day file, and every existing row is kept byte-identical.
// A day file without its row is an incomplete log — that is exactly how the first
// backfill shipped 76 files with 2 index rows.
const indexPath = join(MEMORY, 'index.md')
const indexText = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# 修改记忆索引\n'
const knownDates = new Set([...indexText.matchAll(/^\| (\d{4}-\d{2}-\d{2}) \|/gm)].map((m) => m[1]))

/** A short, factual summary: how many commits and what they were about. */
function summaryOf(dayCommits) {
  // Keep the conventional prefix: `chore(release): 0.6.1` and `0.6.10` differ only
  // by it, and a summary that drops it reads as the wrong release.
  const topics = dayCommits
    .map((commit) => {
      const subject = normalizeSubject(commit.subject)
      return subject.length > 46 ? `${subject.slice(0, 45)}…` : subject
    })
    .slice(0, 3)
  const more = dayCommits.length > topics.length ? ` 等 ${dayCommits.length} 项` : ''
  return `${dayCommits.length} 次提交：${topics.join('；')}${more}（回填）`
}

const rows = [...byDate.entries()]
  .filter(([date]) => !knownDates.has(date))
  .map(([date, dayCommits]) => `| ${date} | ${summaryOf(dayCommits)} | [详情](${date}.md) |`)

// Newest first, inserted after the last existing row so the frozen rows stay on top.
rows.sort((a, b) => (a < b ? 1 : -1))
if (rows.length > 0 && !dryRun) {
  const lines = indexText.replace(/\s*$/, '').split('\n')
  const lastRow = lines.findLastIndex((line) => line.startsWith('| 20'))
  lines.splice(lastRow + 1, 0, ...rows)
  writeFileSync(indexPath, `${lines.join('\n')}\n`)
}

// Both directions must hold: every day file has a row, every row has a file.
const dayFiles = [...byDate.keys()]
const missingRows = dayFiles.filter(
  (date) => !knownDates.has(date) && !rows.some((row) => row.includes(`| ${date} |`)),
)
const indexDates = [
  ...knownDates,
  ...rows.map((row) => row.match(/^\| (\d{4}-\d{2}-\d{2}) \|/)?.[1]),
]
const missingFiles = indexDates.filter((date) => date && !existsSync(join(MEMORY, `${date}.md`)))
if (missingRows.length > 0) console.log(`WARN rows missing after write: ${missingRows.join(', ')}`)
if (missingFiles.length > 0)
  console.log(`WARN index rows without a file: ${missingFiles.join(', ')}`)

console.log(
  `${dryRun ? '[dry-run] ' : ''}commits=${commits.length} days=${added.length} indexRows=${rows.length} indexTotal=${knownDates.size + rows.length}`,
)
for (const day of added) console.log(`  ${day.date}: +${day.entries}`)
