import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Content keys are written ONLY in the service worker.
 *
 * The persistence modules serialize their read-modify-write cycles with
 * per-key queues (`lib/key-lock.ts`), but those queues live in one JavaScript
 * context. A panel context that imported, say, `saveWorkflow` and called it
 * directly would mutate the `workflows` collection OUTSIDE the worker's queue
 * and outside the outbox/replay discipline — the exact lost-update race that
 * made workflows disappear. Panel UIs must go through `sendCommand` instead
 * (the worker applies the write through the locked persistence modules).
 *
 * This scan fails when a UI context imports a content-write function from the
 * persistence modules. Reading helpers (`newId`, `listSkills`, types, …) stay
 * allowed.
 */

const UI_DIRS = ['src/sidepanel', 'src/workflow-editor']

/** module specifier → function names that must never be imported by UI code. */
const FORBIDDEN_IMPORTS: Record<string, readonly string[]> = {
  '../lib/workflow/storage': ['saveWorkflow', 'deleteWorkflow', 'duplicateWorkflow'],
  '../lib/task-store': ['saveTask', 'deleteTask', 'recordTaskRun'],
  '../lib/storage': [
    'setSettings',
    'saveProvider',
    'deleteProvider',
    'saveConversation',
    'touchConversation',
    'renameConversation',
    'deleteConversation',
    'saveSkill',
    'deleteSkill',
    'saveAgent',
    'deleteAgent',
    'saveProfile',
    'deleteProfile',
    'savePassword',
    'deletePassword',
    'recordPasswordUse',
    'addHistory',
    'deleteHistory',
    'clearHistory',
  ],
}

function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSources(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('panel UI never writes content keys directly', () => {
  it('imports no content-write function from the persistence modules', () => {
    const violations: string[] = []
    for (const dir of UI_DIRS) {
      for (const file of collectSources(dir)) {
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(
          /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
        )) {
          const module = match[2] ?? ''
          const forbidden = FORBIDDEN_IMPORTS[module]
          if (!forbidden) continue
          const names = (match[1] ?? '')
            .split(',')
            .map((part) => part.trim().replace(/^type\s+/, ''))
            .filter((name) => forbidden.includes(name))
          for (const name of names) {
            violations.push(`${file}: imports ${name} from '${module}'`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })
})
