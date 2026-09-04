import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearDebugBackup,
  getDebugBackup,
  listDebugBackups,
  revertDebugBackup,
  saveDebugBackup,
} from '../src/lib/workflow/debug-backup'
import { saveWorkflow, deleteWorkflow } from '../src/lib/workflow/storage'
import type { Workflow } from '../src/lib/workflow/types'

/**
 * In-memory `chrome.storage.local` double (same pattern as
 * workflow-storage.spec.ts). With no picked directory the file-backed area
 * falls back to this mirror, which is all the backup store touches.
 */
function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    get: vi.fn(async (keys: string | string[] | null) => {
      if (keys === null) {
        const out: Record<string, unknown> = {}
        for (const [key, value] of store) out[key] = value
        return out
      }
      const wanted = typeof keys === 'string' ? [keys] : keys
      const out: Record<string, unknown> = {}
      for (const key of wanted) {
        if (store.has(key)) out[key] = valueOf(store, key)
      }
      return out
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value)
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const wanted = typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) store.delete(key)
    }),
  }
  return { store, storage: { local } }
}

function valueOf(store: Map<string, unknown>, key: string): unknown {
  return store.get(key)
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  const now = Date.now()
  return {
    id: 'wf-1',
    name: 'Scrape leads',
    description: '',
    createdAt: now,
    updatedAt: now,
    drawflow: { nodes: [], edges: [] },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: true,
      reuseLastState: false,
    },
    ...overrides,
  }
}

describe('AI debug backups', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('stores the pre-debug snapshot with change notes', async () => {
    await saveWorkflow(makeWorkflow({ id: 'wf-1', name: 'Scrape leads' }))
    await saveDebugBackup(makeWorkflow({ id: 'wf-1', name: 'Scrape leads' }), '修好了', [
      '增加重试',
      '修正参数',
    ])

    const backup = await getDebugBackup('wf-1')
    expect(backup?.workflow.name).toBe('Scrape leads')
    expect(backup?.changes).toEqual(['增加重试', '修正参数'])
    expect(backup?.summary).toBe('修好了')
    const infos = await listDebugBackups()
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({ workflowId: 'wf-1', name: 'Scrape leads', changes: ['增加重试', '修正参数'] })
  })

  it('keeps the EARLIEST snapshot when a later debug modifies again', async () => {
    await saveWorkflow(makeWorkflow({ id: 'wf-1', name: 'V2' }))
    await saveDebugBackup(makeWorkflow({ id: 'wf-1', name: 'ORIGINAL' }), 's1', ['a'])
    await saveDebugBackup(makeWorkflow({ id: 'wf-1', name: 'V2' }), 's2', ['b'])

    const backup = await getDebugBackup('wf-1')
    expect(backup?.workflow.name).toBe('ORIGINAL')
    expect(backup?.summary).toBe('s1')
  })

  it('revert restores the snapshot, clears the backup and returns the workflow', async () => {
    await saveWorkflow(makeWorkflow({ id: 'wf-1', name: 'ORIGINAL' }))
    await saveDebugBackup(makeWorkflow({ id: 'wf-1', name: 'ORIGINAL' }), 's', ['a'])

    const restored = await revertDebugBackup('wf-1')
    expect(restored?.name).toBe('ORIGINAL')
    expect(await getDebugBackup('wf-1')).toBeUndefined()
    // A second revert has nothing to restore.
    expect(await revertDebugBackup('wf-1')).toBeUndefined()
  })

  it('keep drops the snapshot (AI changes stay)', async () => {
    await saveWorkflow(makeWorkflow({ id: 'wf-1' }))
    await saveDebugBackup(makeWorkflow({ id: 'wf-1' }), 's', ['a'])
    await clearDebugBackup('wf-1')
    expect(await getDebugBackup('wf-1')).toBeUndefined()
    const infos = await listDebugBackups()
    expect(infos).toHaveLength(0)
  })

  it('prunes backups whose workflow was deleted on the next save', async () => {
    await saveWorkflow(makeWorkflow({ id: 'kept' }))
    await saveWorkflow(makeWorkflow({ id: 'gone' }))
    await saveDebugBackup(makeWorkflow({ id: 'kept' }), 's', ['a'])
    await saveDebugBackup(makeWorkflow({ id: 'gone' }), 's', ['a'])

    // The user deletes "gone" — the next debug save prunes its orphan backup.
    await deleteWorkflow('gone')
    await saveWorkflow(makeWorkflow({ id: 'fresh' }))
    await saveDebugBackup(makeWorkflow({ id: 'fresh' }), 's', ['a'])

    const infos = await listDebugBackups()
    expect(infos.map((info) => info.workflowId).sort()).toEqual(['fresh', 'kept'])
  })

  it('is tolerant of corrupted stored payloads', async () => {
    mocks.store.set('aiDebugBackups', { 'wf-1': { workflow: { id: 'wf-1' } } })
    expect(await getDebugBackup('wf-1')).toBeUndefined()
    // list must not throw either — the record's workflow lacks a name.
    await expect(listDebugBackups()).resolves.toBeDefined()
  })
})
