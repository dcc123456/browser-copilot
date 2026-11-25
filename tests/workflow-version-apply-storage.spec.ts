/**
 * "Apply" switches the workflow to an old version instead of appending a
 * "rollback" line, and the next save must not re-add that content as a new
 * version either. These tests drive the real storage layer over an in-memory
 * chrome.storage double, because the dedupe baseline is what decides whether a
 * save creates a version — a pure fingerprint test cannot see that wiring.
 *
 * See specs/2026-11-25-version-apply-switch-design.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkflow,
  loadWorkflowVersionIndex,
  readWorkflowVersionSnapshot,
  saveWorkflow,
  saveWorkflowVersionSnapshot,
} from '../src/lib/workflow/storage'
import { currentVersionOf, workflowFingerprint } from '../src/lib/workflow/workflow-versions'
import type { Workflow } from '../src/lib/workflow/types'

function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    get: vi.fn(async (keys: string | string[]) => {
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
  return { store, storage: { local: { get: local.get, set: local.set, remove: local.remove } } }
}

/** A workflow whose only content difference between versions is one node param. */
function makeWorkflow(name: string, code: string): Workflow {
  const now = Date.now()
  return {
    id: 'wf-1',
    name,
    createdAt: now,
    updatedAt: now,
    drawflow: {
      nodes: [
        {
          id: 'n1',
          label: 'JavaScript code',
          position: { x: 0, y: 0 },
          data: { blockId: 'javascript-code', code },
        },
      ],
      edges: [],
    },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

describe('saving after applying a version', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('adds no version when the stored content is written back after an apply', async () => {
    // The background save handler passes the fingerprint of what was on disk
    // BEFORE the save; capture it the same way here.
    const savedWithBaseline = async (next: Workflow): Promise<void> => {
      const before = await getWorkflow('wf-1')
      await saveWorkflow(next)
      const after = (await getWorkflow('wf-1'))!
      await saveWorkflowVersionSnapshot(after, {
        ...(before ? { baselineFingerprint: workflowFingerprint(before) } : {}),
      })
    }

    // Two saves with a real change between them → v1, v2.
    await savedWithBaseline(makeWorkflow('v1', 'return 1'))
    await savedWithBaseline(makeWorkflow('v2', 'return 2'))
    expect((await loadWorkflowVersionIndex('wf-1')).entries).toHaveLength(2)

    // A save with no edit after v2: identical to the stored content → no line.
    await savedWithBaseline(makeWorkflow('v2', 'return 2'))
    let index = await loadWorkflowVersionIndex('wf-1')
    expect(index.entries).toHaveLength(2)

    // "Apply v1": the background switches the stored content, no snapshot.
    const v1 = (await readWorkflowVersionSnapshot('wf-1', 1))!
    await saveWorkflow(v1)
    index = await loadWorkflowVersionIndex('wf-1')
    expect(index.entries).toHaveLength(2)

    // The user now presses Save without editing: same content, no new version.
    const storedV1 = (await getWorkflow('wf-1'))!
    await saveWorkflowVersionSnapshot(storedV1, {
      baselineFingerprint: workflowFingerprint(storedV1),
    })
    index = await loadWorkflowVersionIndex('wf-1')
    expect(index.entries).toHaveLength(2)
    // The applied version is "where we are" — the panel marks it current.
    expect(currentVersionOf(index, workflowFingerprint(storedV1))?.version).toBe(1)

    // Now the user edits the node and saves: that IS a new version.
    await saveWorkflow(makeWorkflow('v1', 'return 3'))
    const storedEdited = (await getWorkflow('wf-1'))!
    await saveWorkflowVersionSnapshot(storedEdited, {
      baselineFingerprint: workflowFingerprint(storedV1),
    })
    index = await loadWorkflowVersionIndex('wf-1')
    expect(index.entries).toHaveLength(3)
    expect(currentVersionOf(index, workflowFingerprint(storedEdited))?.version).toBe(3)
  })

  it('never surfaces legacy rollback trace rows again', async () => {
    mocks.store.set('workflow-versions:wf-1', {
      workflowId: 'wf-1',
      updatedAt: 1,
      entries: [
        {
          version: 1,
          at: 1,
          fingerprint: 'a',
          revision: 1,
          nodes: 1,
          edges: 0,
          bytes: 10,
        },
        {
          version: 2,
          at: 2,
          source: 'rollback',
          fromVersion: 1,
          fingerprint: 'a',
          revision: 2,
          nodes: 1,
          edges: 0,
          bytes: 10,
          note: '回滚自 v1',
        },
      ],
    })
    const index = await loadWorkflowVersionIndex('wf-1')
    expect(index.entries.map((entry) => entry.version)).toEqual([1])
  })
})
