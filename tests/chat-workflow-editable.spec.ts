import { beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
  })
})

import { workflowFromHistory } from '../src/lib/storage'
import { migrateWorkflow } from '../src/lib/workflow/migrate'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'
import type { HistoryEntry } from '../src/lib/types'

type Args = Record<string, unknown>

let seq = 0
function entry(action: string, args?: Args): HistoryEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    at: seq,
    conversationId: 'conv-1',
    action,
    summary: action,
    approved: true,
    ok: true,
    ...(args ? { args } : {}),
  }
}

/**
 * Editor rendering contract: App.tsx `toFlowNode` resolves a node only through
 * `BLOCK_BY_ID.get(blockId)` — a node whose blockId misses the catalog renders
 * as nothing on the canvas. Chat-generated workflows ("save as workflow") must
 * satisfy this after `migrateWorkflow` (the exact path the editor load runs).
 */
describe('chat-generated workflows are editor-renderable', () => {
  it('resolves every node blockId (fresh generation) through the block catalog', () => {
    const wf = workflowFromHistory(
      [
        entry('open_url', { url: 'https://example.com' }),
        entry('click', { target: { primary: { how: 'css', value: '.btn' } } }),
        entry('fill', { target: { primary: { how: 'id', value: 'q' } }, value: 'hi' }),
        entry('run_javascript', { code: 'document.title' }),
        entry('wait_for', { target: { primary: { how: 'css', value: '.r' } }, timeout: 2000 }),
        entry('press_key', { key: 'Enter' }),
        entry('tab_switch', { index: 1 }),
        entry('scroll', { mode: 'into_view', target: { primary: { how: 'css', value: '.x' } } }),
      ],
      'chat wf',
    )
    expect(wf).not.toBeNull()
    const migrated = migrateWorkflow(wf!)
    const unknown = migrated.drawflow.nodes
      .map((n) => String((n.data as { blockId?: string }).blockId))
      .filter((id) => !BLOCK_BY_ID.has(id))
    expect(unknown).toEqual([])
  })

  it('resolves saved (already-broken) chat workflows through migration', () => {
    // Shape saved by the current generator: legacy ids the catalog does not know.
    const wf = workflowFromHistory(
      [entry('open_url', { url: 'https://example.com' }), entry('wait_for', { timeout: 1500 })],
      'saved wf',
    )
    expect(wf).not.toBeNull()
    // Simulate the pre-fix stored payload: rewrite the generated ids back to
    // the legacy ones that used to be emitted.
    const legacy: typeof wf = {
      ...(wf as NonNullable<typeof wf>),
      drawflow: {
        ...(wf as NonNullable<typeof wf>).drawflow,
        nodes: (wf as NonNullable<typeof wf>).drawflow.nodes.map((n, i) =>
          i === 0
            ? { ...n, data: { blockId: 'manual', values: {} } }
            : String((n.data as { blockId?: string }).blockId) === 'new-tab'
              ? { ...n, data: { blockId: 'open-url', values: n.data.values } }
              : String((n.data as { blockId?: string }).blockId) === 'delay'
                ? { ...n, data: { blockId: 'wait-for', values: n.data.values } }
                : n,
        ),
      },
    }
    const migrated = migrateWorkflow(legacy)
    const unknown = migrated.drawflow.nodes
      .map((n) => String((n.data as { blockId?: string }).blockId))
      .filter((id) => !BLOCK_BY_ID.has(id))
    expect(unknown).toEqual([])
  })
})

/**
 * Edit-panel contract: toFlowNode derives `blockData` from the migrated node
 * data (everything except `blockId`). Catalog defaults contain EMPTY-string
 * placeholders (url: '', selector: '', ...) — stored values must never be
 * clobbered by them, or the edit panel opens with all fields blank.
 */
describe('chat-generated workflows expose editable form data', () => {
  /** Migrated node data minus blockId — exactly what the edit form binds to. */
  const blockDataList = (entries: Parameters<typeof workflowFromHistory>[0]) => {
    const wf = workflowFromHistory(entries, 'wf')
    expect(wf).not.toBeNull()
    return migrateWorkflow(wf!).drawflow.nodes.map(
      (n) => {
        const { blockId, ...blockData } = n.data as Record<string, unknown>
        return { blockId: String(blockId), blockData }
      },
    )
  }

  it('carries stored values into the flat form fields (not catalog defaults)', () => {
    const nodes = blockDataList([
      entry('open_url', { url: 'https://example.com' }),
      entry('click', { target: { primary: { how: 'css', value: '.btn' } } }),
      entry('fill', { target: { primary: { how: 'id', value: 'q' } }, value: 'hi' }),
      entry('wait_for', { target: { primary: { how: 'css', value: '.r' } }, timeout: 2000 }),
      entry('press_key', { key: 'Enter' }),
      entry('tab_switch', { index: 1 }),
    ])
    expect(nodes).toEqual([
      { blockId: 'trigger', blockData: expect.objectContaining({ type: 'manual' }) },
      { blockId: 'new-tab', blockData: expect.objectContaining({ url: 'https://example.com' }) },
      // Navigation is always followed by a page-load wait (generator rule).
      {
        blockId: 'wait-connections',
        blockData: expect.objectContaining({ timeout: 10000 }),
      },
      {
        blockId: 'event-click',
        blockData: expect.objectContaining({ selector: '.btn', findBy: 'cssSelector' }),
      },
      {
        blockId: 'forms',
        blockData: expect.objectContaining({ selector: '#q', findBy: 'cssSelector', value: 'hi' }),
      },
      { blockId: 'delay', blockData: expect.objectContaining({ time: 2000 }) },
      { blockId: 'press-key', blockData: expect.objectContaining({ key: 'Enter' }) },
      { blockId: 'switch-tab', blockData: expect.objectContaining({ index: 1 }) },
    ])
  })

  it('carries values for the already-saved legacy ids through migration', () => {
    const wf = workflowFromHistory([entry('open_url', { url: 'https://a.com' })], 'wf')
    const legacy: NonNullable<typeof wf> = {
      ...wf!,
      drawflow: {
        ...wf!.drawflow,
        nodes: wf!.drawflow.nodes.map((n, i) =>
          i === 0
            ? { ...n, data: { blockId: 'manual', values: {} } }
            : { ...n, data: { blockId: 'open-url', values: { url: 'https://a.com' } } },
        ),
      },
    }
    const [actionNode] = migrateWorkflow(legacy).drawflow.nodes.slice(1)
    const { blockId, ...blockData } = actionNode!.data as Record<string, unknown>
    expect(blockId).toBe('new-tab')
    expect(blockData).toEqual(expect.objectContaining({ url: 'https://a.com' }))
  })

  it('lets flat Automa fields win over the legacy values object', () => {
    const wf = workflowFromHistory([entry('open_url', { url: 'https://a.com' })], 'wf')
    const mixed: NonNullable<typeof wf> = {
      ...wf!,
      drawflow: {
        ...wf!.drawflow,
        nodes: wf!.drawflow.nodes.map((n, i) =>
          i === 0
            ? n
            : { ...n, data: { blockId: 'new-tab', values: { url: 'https://a.com' }, url: 'https://flat.com' } },
        ),
      },
    }
    const [actionNode] = migrateWorkflow(mixed).drawflow.nodes.slice(1)
    const { blockId, ...blockData } = actionNode!.data as Record<string, unknown>
    expect(blockId).toBe('new-tab')
    expect(blockData).toEqual(expect.objectContaining({ url: 'https://flat.com' }))
  })

  it('carries run_javascript through as an editable javascript-code block', () => {
    const nodes = blockDataList([entry('run_javascript', { code: 'document.title' })])
    expect(nodes).toEqual([
      { blockId: 'trigger', blockData: expect.objectContaining({ type: 'manual' }) },
      {
        blockId: 'javascript-code',
        blockData: expect.objectContaining({ code: 'document.title', timeout: 20000 }),
      },
    ])
  })

  it('keeps the rich conversation locator on interaction blocks (edit panel can show it)', () => {
    const nodes = blockDataList([
      entry('click', {
        target: { primary: { how: 'role', value: '提交', role: 'button' }, fallbacks: [] },
      }),
    ])
    const click = nodes.find((n) => n.blockId === 'event-click')!
    expect(click.blockData).toEqual(
      expect.objectContaining({
        selector: '',
        target: { primary: { how: 'role', value: '提交', role: 'button' }, fallbacks: [] },
      }),
    )
  })
})
