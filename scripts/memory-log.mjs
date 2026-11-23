#!/usr/bin/env node
/**
 * Prints the skeleton of one `memory/YYYY-MM-DD.md` entry (AGENTS.md §9).
 *
 * It takes the subject of the commit you are ABOUT to make, not the last
 * commit's: an entry that is generated from HEAD can only ever be committed in
 * a LATER commit, and then "every commit has an entry" is false for the newest
 * one on any checkout. Generating from the intended subject lets the entry and
 * its commit land together.
 *
 * Run: pnpm memory:log "feat(agent): require an explicit completion declaration"
 */
import { execFileSync } from 'node:child_process'

const subject = (process.argv[2] ?? '').trim()
if (subject === '' || subject.startsWith('-')) {
  console.error(
    'usage: pnpm memory:log "<the commit subject you are about to use>"\n' +
      'The subject is required: reading HEAD would make every entry lag one commit.',
  )
  process.exit(1)
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const now = new Date()
const pad = (value) => String(value).padStart(2, '0')
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`

// Staged first (what is about to be committed), then the working tree.
const files =
  git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean).length > 0
    ? git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
    : git(['ls-files', '-m', '-o', '--exclude-standard']).split('\n').filter(Boolean)
// Local noise that would otherwise be copied into the 模块 line.
const NOISE = /^(pnpm-lock\.yaml|\.prettierignore\.local|dist|tmp)(\/|$)/
const modules = [
  ...new Set(
    files.filter((file) => !NOISE.test(file)).map((file) => file.split('/').slice(0, 2).join('/')),
  ),
]
const shown = modules.slice(0, 8)

console.log(`## ${time} · ${subject}`)
console.log('')
console.log('- 变更：<用户可见的行为变化，一句话；不是文件清单>')
console.log(
  `- 模块：${shown.join('、') || '<无文件变化>'}${modules.length > shown.length ? `、等 ${modules.length} 项` : ''}`,
)
console.log('- 验证：typecheck / test / build；真机 <哪条判据>')
console.log('- 遗留：无')
console.log('')
console.log(`追加到 memory/${date}.md，并更新 memory/index.md 的今日行（历史行不动）。`)
