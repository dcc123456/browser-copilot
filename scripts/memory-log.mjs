#!/usr/bin/env node
/**
 * Prints the skeleton of one `memory/YYYY-MM-DD.md` entry for a commit, so the
 * five-field format never has to be retyped by hand (AGENTS.md §9).
 *
 * It only PRINTS: appending the entry and updating `index.md` stay deliberate
 * steps, because the file to touch depends on the commit's local date and on
 * whether today's line already exists.
 *
 * Run: pnpm memory:log            (HEAD)
 *      node scripts/memory-log.mjs <rev>
 */
import { execFileSync } from 'node:child_process'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const rev = process.argv[2] ?? 'HEAD'
const at = (format) => git(['log', '-1', `--date=format:${format}`, '--pretty=%ad', rev])
const time = at('%H:%M')
const date = at('%Y-%m-%d')
const subject = git(['log', '-1', '--pretty=%s', rev])
const files = git(['show', '--name-only', '--pretty=format:', rev]).split('\n').filter(Boolean)

// Group by the two leading path segments so a list of twenty files stays readable.
const modules = [...new Set(files.map((file) => file.split('/').slice(0, 2).join('/')))]

console.log(`## ${time} · ${subject}`)
console.log('')
console.log('- 变更：<用户可见的行为变化，一句话；不是文件清单>')
console.log(`- 模块：${modules.join('、') || '<无文件变化>'}`)
console.log('- 验证：typecheck / test / build；真机 <哪条判据>')
console.log('- 遗留：无')
console.log('')
console.log(`追加到 memory/${date}.md，并更新 memory/index.md 的今日行（历史行不动）。`)
