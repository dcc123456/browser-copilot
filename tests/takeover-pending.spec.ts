import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPendingTakeover,
  getPendingTakeover,
  listPendingTakeovers,
  savePendingTakeover,
} from '../src/lib/workflow/takeover-pending'
import { saveWorkflow, deleteWorkflow } from '../src/lib/workflow/storage'
import type { TakeoverFix } from '../src/lib/workflow/ai-takeover'
import type { Workflow } from '../src/lib/workflow/types'

/**
 * In-memory `chrome.storage.local` double (same pattern as the old
 * debug-backup spec). With no picked directory the file-backed area falls
 * back to this mirror, which is all the pending store touches.
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
        if (store.has(key)) out[key] = store.get(key)
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

const fix = (nodeId: string, selector: string): TakeoverFix => ({
  nodeId,
  nodeLabel: `Click element: ${nodeId}`,
  paramsPatch: { selector },
  note: `AI 建议修正「${nodeId}」参数：selector → ${selector}`,
})

describe('AI takeover pending fixes', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('stores pending fixes until the user applies or discards them', async () => {
    await saveWorkflow(makeWorkflow({ id: 'wf-1', name: 'Scrape leads' }))
    await savePendingTakeover({
      workflowId: 'wf-1',
      runId: 'run-1',
      fixes: [fix('b', '.fresh')],
      createdAt: 123,
    })

    const pending = await getPendingTakeover('wf-1')
    expect(pending?.runId).toBe('run-1')
    expect(pending?.fixes[0]?.paramsPatch).toEqual({ selector: '.fresh' })
    const infos = await listPendingTakeovers()
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({ workflowId: 'wf-1', name: 'Scrape leads' })
  })

  it('a newer session replaces earlier unanswered fixes', async () => {
    await saveWorkflow(makeWorkflow({ id: 'wf-1' }))
    await savePendingTakeover({ workflowId: 'wf-1', fixes: [fix('b', '.old')], createdAt: 1 })
    await savePendingTakeover({ workflowId: 'wf-1', fixes: [fix('b', '.new'), fix('c', '.x')], createdAt: 2 })
    const pending = await getPendingTakeover('wf-1')
    expect(pending?.fixes).toHaveLength(2)
    expect(pending?.fixes[0]?.paramsPatch).toEqual({ selector: '.new' })
  })

  it('discard clears the pending record', async () => {
    await saveWorkflow(makeWorkflow({ id: 'wf-1' }))
    await savePendingTakeover({ workflowId: 'wf-1', fixes: [fix('b', '.fresh')], createdAt: 1 })
    await clearPendingTakeover('wf-1')
    expect(await getPendingTakeover('wf-1')).toBeUndefined()
    expect(await listPendingTakeovers()).toHaveLength(0)
    // Clearing again is a no-op.
    await clearPendingTakeover('wf-1')
  })

  it('prunes records whose workflow was deleted on the next save', async () => {
    await saveWorkflow(makeWorkflow({ id: 'kept' }))
    await saveWorkflow(makeWorkflow({ id: 'gone' }))
    await savePendingTakeover({ workflowId: 'kept', fixes: [fix('a', '.k')], createdAt: 1 })
    await savePendingTakeover({ workflowId: 'gone', fixes: [fix('a', '.g')], createdAt: 1 })

    await deleteWorkflow('gone')
    await savePendingTakeover({ workflowId: 'kept', fixes: [fix('a', '.k2')], createdAt: 2 })

    const infos = await listPendingTakeovers()
    expect(infos.map((info) => info.workflowId)).toEqual(['kept'])
  })

  it('never stores an empty fix set (nothing to confirm)', async () => {
    await saveWorkflow(makeWorkflow({ id: 'wf-1' }))
    await savePendingTakeover({ workflowId: 'wf-1', fixes: [], createdAt: 1 })
    expect(await getPendingTakeover('wf-1')).toBeUndefined()
  })

  it('is tolerant of corrupted stored payloads', async () => {
    mocks.store.set('aiTakeoverPending', { 'wf-1': { workflowId: 'wf-1', fixes: [{ bad: true }] } })
    expect(await getPendingTakeover('wf-1')).toBeUndefined()
    await expect(listPendingTakeovers()).resolves.toBeDefined()
  })
})
