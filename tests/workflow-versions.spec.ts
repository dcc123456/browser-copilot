import { describe, expect, it } from 'vitest'
import type { Workflow } from '../src/lib/workflow/types'
import {
  appendVersion,
  canDeleteVersion,
  currentVersionOf,
  nextVersionNumber,
  oversizedNodeOf,
  prepareSnapshot,
  rollbackEntryOf,
  rollbackSourceDeleted,
  WORKFLOW_VERSION_LIMIT,
  workflowFingerprint,
  type WorkflowVersionEntry,
  type WorkflowVersionIndex,
} from '../src/lib/workflow/workflow-versions'

/**
 * The version list is defined by what it REFUSES to treat as a change: the
 * revision counter, the save timestamp, the viewport. Those move on every save,
 * so a fingerprint that included them would make every save a "version" — the
 * exact failure this layer exists to prevent.
 */

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'Watch price',
    description: 'watch',
    createdAt: 1,
    updatedAt: 1,
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    } as Workflow['settings'],
    drawflow: {
      nodes: [
        { id: 'a', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
        { id: 'b', label: 'open-url', position: { x: 0, y: 80 }, data: { blockId: 'open-url' } },
      ],
      edges: [{ id: 'e', source: 'a', target: 'b' }],
    },
    ...overrides,
  } as Workflow
}

function entry(version: number, fingerprint: string, bytes = 100): WorkflowVersionEntry {
  return {
    version,
    at: version * 1000,
    source: 'save',
    fingerprint,
    revision: version,
    nodes: 2,
    edges: 1,
    bytes,
  }
}

const emptyIndex = (): WorkflowVersionIndex => ({ workflowId: 'wf-1', entries: [], updatedAt: 0 })

describe('content fingerprint', () => {
  it('ignores the fields that move on every save', () => {
    const first = workflow()
    const second = workflow({
      updatedAt: 999,
      revision: 7,
      revisionHistory: [{ revision: 7, updatedAt: 999, source: 'manual-edit' }],
    } as Partial<Workflow>)
    expect(workflowFingerprint(second)).toBe(workflowFingerprint(first))
  })

  it('ignores panning and zooming the canvas', () => {
    const first = workflow()
    const panned = workflow()
    panned.drawflow.position = { x: 400, y: -120 }
    panned.drawflow.zoom = 1.7
    expect(workflowFingerprint(panned)).toBe(workflowFingerprint(first))
  })

  it('changes when a node or an edge really changes', () => {
    const first = workflow()
    const edited = workflow()
    edited.drawflow.nodes[1]!.data = { blockId: 'open-url', url: 'https://shop.test/2' }
    expect(workflowFingerprint(edited)).not.toBe(workflowFingerprint(first))
    const rewired = workflow()
    rewired.drawflow.edges = []
    expect(workflowFingerprint(rewired)).not.toBe(workflowFingerprint(first))
  })
})

describe('append and evict', () => {
  it('keeps at most the limit, dropping the oldest', () => {
    let index = emptyIndex()
    for (let version = 1; version <= 4; version += 1) {
      index = appendVersion(index, entry(version, `fp-${version}`), { limit: 3 }).index
    }
    expect(index.entries.map((item) => item.version)).toEqual([2, 3, 4])
  })

  it('evicts for the byte budget too, and keeps the newest entry', () => {
    const plan = appendVersion(
      { ...emptyIndex(), entries: [entry(1, 'a', 900), entry(2, 'b', 900)] },
      entry(3, 'c', 900),
      { budgetBytes: 2000 },
    )
    expect(plan.index.entries.map((item) => item.version)).toEqual([2, 3])
    expect(plan.evicted).toEqual([1])
  })

  it('refuses a single snapshot that cannot fit the budget', () => {
    const plan = appendVersion(emptyIndex(), entry(1, 'a', 5000), { budgetBytes: 4000 })
    expect(plan.refused).toBe('too-large')
    expect(plan.index.entries).toEqual([])
  })

  it('keeps version numbers monotonic after eviction', () => {
    let index = emptyIndex()
    for (let version = 1; version <= 4; version += 1) {
      index = appendVersion(index, entry(version, `fp-${version}`), { limit: 2 }).index
    }
    expect(nextVersionNumber(index)).toBe(5)
  })
})

describe('current version and deletion', () => {
  const index = { ...emptyIndex(), entries: [entry(1, 'a'), entry(2, 'b')] }

  it('finds the newest entry that matches the canvas', () => {
    expect(currentVersionOf(index, 'a')?.version).toBe(1)
    expect(currentVersionOf(index, 'nope')).toBeUndefined()
  })

  it('refuses to delete the version the canvas is on', () => {
    expect(canDeleteVersion(index, 2, 'b')).toEqual({ ok: false, reason: 'current' })
    expect(canDeleteVersion(index, 1, 'b')).toEqual({ ok: true })
  })

  it('marks nothing current when the canvas matches no version, and allows deleting any', () => {
    // The canvas was edited after the last save, or an old version was applied:
    // "current" is undefined, so no row is pinned and every row may go.
    expect(currentVersionOf(index, 'edited-but-unsaved')).toBeUndefined()
    expect(canDeleteVersion(index, 2, 'edited-but-unsaved')).toEqual({ ok: true })
  })

  it('reports a missing version instead of pretending it deleted', () => {
    expect(canDeleteVersion(index, 9, 'b')).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('rollback entries', () => {
  const index = { ...emptyIndex(), entries: [entry(1, 'a'), entry(2, 'b')] }

  it('records which version was re-applied, without a snapshot of its own', () => {
    const rollback = rollbackEntryOf(index, 1, {
      at: 5000,
      revision: 9,
      fingerprint: 'a',
      nodes: 2,
      edges: 1,
      bytes: 120,
    })
    expect(rollback).toMatchObject({ version: 3, source: 'rollback', fromVersion: 1 })
    expect(rollback.note).toContain('v1')
  })

  it('marks the trace when the source version has been deleted', () => {
    const rollback = rollbackEntryOf(index, 1, {
      at: 5000,
      revision: 9,
      fingerprint: 'a',
      nodes: 2,
      edges: 1,
      bytes: 120,
    })
    const withRollback = { ...index, entries: [...index.entries, rollback] }
    expect(rollbackSourceDeleted(withRollback, rollback)).toBe(false)
    const sourceGone = {
      ...withRollback,
      entries: withRollback.entries.filter((e) => e.version !== 1),
    }
    expect(rollbackSourceDeleted(sourceGone, rollback)).toBe(true)
  })
})

describe('preparing a snapshot', () => {
  it('sheds a bulk data URL BEFORE fingerprinting, so the stored copy and the snapshot agree', () => {
    const raw = workflow()
    const payload = `data:image/png;base64,${'A'.repeat(400 * 1024)}`
    raw.drawflow.nodes[1]!.data = { blockId: 'open-url', screenshot: payload }
    const prepared = prepareSnapshot(raw)
    expect('refused' in prepared).toBe(false)
    if ('refused' in prepared) return
    // The data URL is gone; the placeholder is what gets hashed and written.
    expect(JSON.stringify(prepared.workflow)).not.toContain('base64')
    expect(JSON.stringify(prepared.workflow)).toContain('[data URL dropped:')
    expect(prepared.bytes).toBeLessThan(8 * 1024)

    // Same graph, same fingerprint as one that already carries the placeholder:
    // one content, one hash — otherwise de-duplication silently stops working.
    const withMarker = workflow()
    withMarker.drawflow.nodes[1]!.data = {
      blockId: 'open-url',
      screenshot: `[data URL dropped: ${payload.length} chars]`,
    }
    const markerPrepared = prepareSnapshot(withMarker)
    if ('refused' in markerPrepared) throw new Error('unexpected refusal')
    expect(markerPrepared.fingerprint).toBe(prepared.fingerprint)
  })

  it('still refuses a large NON-data string: shedding only knows data URLs', () => {
    const heavy = workflow()
    heavy.drawflow.nodes[1]!.data = { blockId: 'javascript-code', code: 'x'.repeat(300 * 1024) }
    expect(prepareSnapshot(heavy)).toEqual({ refused: 'node-payload' })
  })

  it('leaves a small data URL alone — shedding has its own threshold', () => {
    const small = workflow()
    const tiny = 'data:image/png;base64,AAAA'
    small.drawflow.nodes[1]!.data = { blockId: 'open-url', screenshot: tiny }
    const prepared = prepareSnapshot(small)
    if ('refused' in prepared) throw new Error('unexpected refusal')
    expect(JSON.stringify(prepared.workflow)).toContain(tiny)
  })
})

describe('the canvas ↔ snapshot fingerprint contract', () => {
  /**
   * "Current version" is ONE equality: the fingerprint the panel computes from
   * the canvas must equal the fingerprint stored with the last snapshot. It
   * silently breaks the day `toWorkflowNode` or the save path changes a field,
   * and QA already mis-reported it twice as a product bug — so it gets its own
   * assertion, in both directions.
   */
  const editorShaped = () => {
    // What the editor actually builds: display labels, positions, settings,
    // createdAt — not a hand-made fixture with blockId labels.
    const wf = workflow()
    wf.settings = { ...wf.settings, saveLog: true }
    wf.drawflow.nodes = [
      {
        id: 'a',
        label: 'Trigger',
        position: { x: 120, y: 160 },
        data: { blockId: 'trigger', type: 'manual' },
      },
      {
        id: 'b',
        label: 'JavaScript code',
        position: { x: 120, y: 260 },
        data: { blockId: 'javascript-code', code: 'return 1', outputVariables: ['x'] },
      },
    ] as Workflow['drawflow']['nodes']
    return wf
  }

  it('saving does not change the fingerprint the canvas reports', () => {
    const canvas = editorShaped()
    const stored = prepareSnapshot(canvas)
    if ('refused' in stored) throw new Error('unexpected refusal')
    // The panel hashes the canvas workflow; the entry carries the stored form's
    // hash. They MUST be the same value for "current" to ever light up.
    expect(workflowFingerprint(canvas)).toBe(stored.fingerprint)
  })

  it('ignores filing, the goal text and the data-store reference', () => {
    // The editor's canvas record never carries these; the stored one can. They
    // must not make the canvas look "not current" after every save.
    const canvas = editorShaped()
    const stored = workflow({
      folderId: 'folder-1',
      plan: 'watch the price, then report',
      table: { id: 'sheet-1' },
    } as Partial<Workflow>)
    stored.drawflow = canvas.drawflow
    stored.settings = canvas.settings
    expect(workflowFingerprint(stored)).toBe(workflowFingerprint(canvas))
  })

  it('editing a node without saving makes the two disagree', () => {
    const saved = prepareSnapshot(editorShaped())
    if ('refused' in saved) throw new Error('unexpected refusal')
    const edited = editorShaped()
    edited.drawflow.nodes[1]!.data = { blockId: 'javascript-code', code: 'return 2' }
    expect(workflowFingerprint(edited)).not.toBe(saved.fingerprint)
  })
})

describe('payload guard', () => {
  it('refuses a node whose data is bigger than the per-node limit', () => {
    const heavy = workflow()
    heavy.drawflow.nodes[1]!.data = { blockId: 'open-url', screenshot: 'x'.repeat(300 * 1024) }
    expect(oversizedNodeOf(heavy)).toMatchObject({ nodeId: 'b' })
    expect(oversizedNodeOf(workflow())).toBeNull()
  })

  it('keeps the published limit at 20 versions', () => {
    expect(WORKFLOW_VERSION_LIMIT).toBe(20)
  })
})
