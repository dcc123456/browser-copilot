/**
 * Per-section history retention caps (`lib/types`, `lib/storage`, `lib/task-store`).
 *
 * Four records share the History tab and each one owns bytes on disk — a
 * conversation meta row comes with a `conv:<id>` transcript that can be
 * megabytes, a run record with a step bag. So the cap must be (a) per section,
 * (b) applied on write, and (c) re-applied when the user lowers a limit, since
 * the records already stored are the bulk of what the user wants shed.
 *
 * `chrome.storage.local` is stubbed with an in-process map: without a directory
 * handle `fileStorageArea()` falls back to exactly that mirror, so these tests
 * exercise the real write path without chrome or the filesystem.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addHistory,
  listConversations,
  listHistory,
  saveConversation,
  loadConversation,
  setSettings,
  touchConversation,
  trimActionHistoryToLimit,
  trimConversationsToLimit,
} from '../src/lib/storage'
import {
  addRun,
  isWorkflowRunSource,
  listRuns,
  recordFinishedRun,
  trimRunsToLimits,
} from '../src/lib/task-store'
import { HISTORY_LIMITS, normalizeHistoryLimit } from '../src/lib/types'
import type { HistoryEntry } from '../src/lib/types'
import type { TaskRunLog } from '../src/lib/scheduler-types'

const stored = new Map<string, unknown>()

beforeEach(() => {
  stored.clear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (!keys) return Object.fromEntries(stored)
          const list = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const key of list) if (stored.has(key)) out[key] = stored.get(key)
          return out
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) stored.set(key, value)
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) stored.delete(key)
        },
      },
    },
  })
})

function historyEntry(id: string, at: number): HistoryEntry {
  return { id, at, conversationId: 'c-1', action: 'click', summary: id, approved: true, ok: true }
}

/** Seed the conversation meta list directly: oldest first, all in the past. */
function seedConversations(ids: string[]): void {
  const now = Date.now()
  stored.set(
    'conversations',
    ids.map((id, index) => {
      // Increasing with the index, so the last entry is the newest, and every
      // timestamp stays in the past — a thread touched now must outrank them.
      const at = now - (ids.length - index) * 1000
      return {
        id,
        title: id,
        createdAt: at,
        updatedAt: at,
        preview: `first message of ${id}`,
      }
    }),
  )
}

function storedMetaIds(): string[] {
  const list = stored.get('conversations') as { id: string }[]
  return list.map((meta) => meta.id)
}

function run(source: TaskRunLog['source'], id: string): Omit<TaskRunLog, 'id' | 'at'> {
  return {
    trigger: source === 'manual' ? 'manual' : 'schedule',
    ok: true,
    skipped: false,
    summary: id,
    label: id,
    source,
  }
}

describe('normalizeHistoryLimit', () => {
  it('falls back to the default for anything that is not a finite number', () => {
    for (const raw of [undefined, null, '50', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeHistoryLimit(raw)).toBe(HISTORY_LIMITS.default)
    }
  })

  it('clamps into [min, max] and rounds', () => {
    expect(normalizeHistoryLimit(0)).toBe(HISTORY_LIMITS.min)
    expect(normalizeHistoryLimit(-10)).toBe(HISTORY_LIMITS.min)
    expect(normalizeHistoryLimit(HISTORY_LIMITS.max + 1)).toBe(HISTORY_LIMITS.max)
    expect(normalizeHistoryLimit(24.6)).toBe(25)
  })

  it('keeps a stored value inside the bounds as written', () => {
    expect(normalizeHistoryLimit(150)).toBe(150)
  })
})

describe('settings normalization', () => {
  it('defaults every section to the small retention cap', async () => {
    const settings = await setSettings({})
    expect(settings.historyLimitConversations).toBe(50)
    expect(settings.historyLimitWorkflowRuns).toBe(50)
    expect(settings.historyLimitTaskRuns).toBe(50)
    expect(settings.historyLimitOperations).toBe(50)
  })

  it('clamps an out-of-range written value on the next read', async () => {
    await setSettings({ historyLimitOperations: 9999 })
    stored.set('settings', {
      ...(stored.get('settings') as Record<string, unknown>),
      historyLimitOperations: 5000,
    })
    const settings = await setSettings({})
    expect(settings.historyLimitOperations).toBe(HISTORY_LIMITS.max)
  })
})

describe('action history', () => {
  it('keeps only the newest entries within the configured cap', async () => {
    await setSettings({ historyLimitOperations: 3 })
    for (let index = 1; index <= 6; index++) {
      await addHistory(historyEntry(`h-${index}`, index * 1000))
    }
    const entries = await listHistory()
    expect(entries.map((entry) => entry.id)).toEqual(['h-6', 'h-5', 'h-4'])
  })

  it('trims already stored entries when the cap is lowered', async () => {
    await setSettings({ historyLimitOperations: 50 })
    for (let index = 1; index <= 8; index++) {
      await addHistory(historyEntry(`h-${index}`, index * 1000))
    }
    expect((await listHistory()).length).toBe(8)

    await setSettings({ historyLimitOperations: 2 })
    await trimActionHistoryToLimit()
    expect((await listHistory()).map((entry) => entry.id)).toEqual(['h-8', 'h-7'])
  })
})

describe('conversations', () => {
  it('keeps the newest threads and sheds their transcript files', async () => {
    await setSettings({ historyLimitConversations: 2 })
    // c-1 is the oldest, c-4 the newest (seedConversations sorts by index).
    seedConversations(['c-1', 'c-2', 'c-3', 'c-4'])
    await saveConversation('c-1', [{ role: 'user', content: 'oldest' }])
    await saveConversation('c-2', [{ role: 'user', content: 'second oldest' }])
    await saveConversation('c-3', [{ role: 'user', content: 'kept' }])

    await trimConversationsToLimit()

    expect(storedMetaIds()).toEqual(['c-4', 'c-3'])
    await expect(loadConversation('c-1')).resolves.toEqual([])
    await expect(loadConversation('c-2')).resolves.toEqual([])
    await expect(loadConversation('c-3')).resolves.toEqual([{ role: 'user', content: 'kept' }])
  })

  it('never evicts the thread it just created', async () => {
    // `touchConversation` appends the new thread to an otherwise newest-first
    // list, so a naive `slice(0, limit)` would drop the freshest record.
    await setSettings({ historyLimitConversations: 2 })
    seedConversations(['c-1', 'c-2', 'c-3'])

    await touchConversation('c-new', 'start a brand new thread')

    expect(storedMetaIds()[0]).toBe('c-new')
    expect((await listConversations()).map((meta) => meta.id)).toContain('c-new')
  })
})

describe('run logs', () => {
  it('classifies each source into exactly one history section', () => {
    expect(isWorkflowRunSource('manual')).toBe(true)
    expect(isWorkflowRunSource('chat')).toBe(true)
    expect(isWorkflowRunSource('schedule')).toBe(false)
    expect(isWorkflowRunSource('feishu')).toBe(false)
    expect(isWorkflowRunSource(undefined)).toBe(false)
  })

  it('caps workflow runs and task runs independently in the shared array', async () => {
    await setSettings({ historyLimitWorkflowRuns: 2, historyLimitTaskRuns: 3 })
    for (let index = 1; index <= 5; index++) {
      await addRun(run('manual', `w-${index}`))
      await addRun(run('schedule', `t-${index}`))
    }

    const runs = await listRuns()
    expect(runs.filter((r) => isWorkflowRunSource(r.source))).toHaveLength(2)
    expect(runs.filter((r) => !isWorkflowRunSource(r.source))).toHaveLength(3)
    expect(runs.map((r) => r.label).slice(0, 2)).toEqual(['t-5', 'w-5'])
  })

  it('trims stored runs of both kinds when a cap is lowered', async () => {
    await setSettings({ historyLimitWorkflowRuns: 50, historyLimitTaskRuns: 50 })
    for (let index = 1; index <= 4; index++) {
      await addRun(run('manual', `w-${index}`))
      await addRun(run('feishu', `t-${index}`))
    }
    expect((await listRuns()).length).toBe(8)

    await setSettings({ historyLimitWorkflowRuns: 1, historyLimitTaskRuns: 2 })
    await trimRunsToLimits()

    const runs = await listRuns()
    expect(runs.filter((r) => isWorkflowRunSource(r.source)).map((r) => r.label)).toEqual(['w-4'])
    expect(runs.filter((r) => !isWorkflowRunSource(r.source)).map((r) => r.label)).toEqual([
      't-4',
      't-3',
    ])
  })

  it('counts a finished manual run against the workflow cap', async () => {
    await setSettings({ historyLimitWorkflowRuns: 1 })
    await recordFinishedRun({ runId: 'r-1', source: 'manual', outcome: 'ok', finishedAt: 1000 })
    await recordFinishedRun({ runId: 'r-2', source: 'manual', outcome: 'ok', finishedAt: 2000 })

    const runs = await listRuns()
    expect(runs.map((r) => r.id)).toEqual(['r-2'])
  })
})
