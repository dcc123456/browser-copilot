import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asPersistedDraft,
  deleteDraft,
  loadDraft,
  saveDraft,
} from '../src/lib/workflow/draft-storage'
import type { WorkflowDraft } from '../src/lib/workflow/draft-types'

/** In-memory `chrome.storage.local` double, resolved lazily by `fs-store`. */
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
      return Promise.resolve()
    }),
  }
  return { store, storage: { local: { get: local.get, set: local.set, remove: local.remove } } }
}

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    conversationId: 'conv-1',
    name: 'my flow',
    nodes: [
      {
        id: 't',
        label: 'trigger',
        position: { x: 0, y: 0 },
        data: { blockId: 'trigger', type: 'manual' },
      },
      {
        id: 'a',
        label: 'event-click',
        position: { x: 220, y: 0 },
        data: { blockId: 'event-click', selector: '#go' },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 't',
        target: 'a',
        sourceHandle: 'trigger-output-1',
        targetHandle: 'event-click-input-1',
      },
    ],
    tail: 'a',
    source: 'chat-generate',
    ...overrides,
  }
}

describe('asPersistedDraft', () => {
  it('rejects records without a conversation id or name', () => {
    expect(asPersistedDraft(null)).toBeNull()
    expect(asPersistedDraft('nope')).toBeNull()
    expect(asPersistedDraft([])).toBeNull()
    expect(asPersistedDraft({ name: 'x' })).toBeNull()
    expect(asPersistedDraft({ conversationId: '', name: 'x' })).toBeNull()
    expect(asPersistedDraft({ conversationId: 'c' })).toBeNull()
  })

  it('drops malformed nodes and edges instead of failing the whole draft', () => {
    const out = asPersistedDraft({
      conversationId: 'c',
      name: 'n',
      nodes: [
        { id: 'ok', label: 'trigger', position: { x: 0, y: 0 }, data: {} },
        { id: 'no-position', label: 'x', data: {} },
        { id: 'no-data', label: 'x', position: { x: 0, y: 0 } },
        'garbage',
      ],
      edges: [{ id: 'e', source: 'ok', target: 'ok' }, { id: 'broken' }, null],
    })
    expect(out).not.toBeNull()
    expect(out!.nodes.map((n) => n.id)).toEqual(['ok'])
    expect(out!.edges.map((e) => e.id)).toEqual(['e'])
  })

  it('defaults the source and drops an unusable pending branch', () => {
    const out = asPersistedDraft({
      conversationId: 'c',
      name: 'n',
      source: 'nonsense',
      pendingBranch: { source: 'a' },
    })
    expect(out!.source).toBe('chat-generate')
    expect(out!.pendingBranch).toBeUndefined()
  })

  it('keeps a well-formed pending branch', () => {
    const out = asPersistedDraft({
      conversationId: 'c',
      name: 'n',
      pendingBranch: { source: 'a', sourceBlockId: 'conditions', output: 'output-2' },
    })
    expect(out!.pendingBranch).toEqual({
      source: 'a',
      sourceBlockId: 'conditions',
      output: 'output-2',
    })
  })

  it('normalises a non-string tail to null', () => {
    expect(asPersistedDraft({ conversationId: 'c', name: 'n', tail: 7 })!.tail).toBeNull()
  })
})

describe('draft persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', makeChromeMock())
  })

  it('round-trips a draft through storage', async () => {
    const original = draft()
    await saveDraft(original)
    const loaded = await loadDraft('conv-1')
    expect(loaded).toEqual(original)
  })

  it('returns undefined for a conversation with no draft', async () => {
    expect(await loadDraft('missing')).toBeUndefined()
  })

  it('overwrites rather than duplicating on repeated saves', async () => {
    await saveDraft(draft())
    await saveDraft(draft({ name: 'renamed' }))
    expect((await loadDraft('conv-1'))!.name).toBe('renamed')
  })

  it('keeps conversations isolated', async () => {
    await saveDraft(draft({ conversationId: 'a', name: 'A' }))
    await saveDraft(draft({ conversationId: 'b', name: 'B' }))
    expect((await loadDraft('a'))!.name).toBe('A')
    expect((await loadDraft('b'))!.name).toBe('B')
  })

  it('deletes a draft and leaves the others alone', async () => {
    await saveDraft(draft({ conversationId: 'a' }))
    await saveDraft(draft({ conversationId: 'b' }))
    await deleteDraft('a')
    expect(await loadDraft('a')).toBeUndefined()
    expect(await loadDraft('b')).toBeDefined()
  })

  it('is a no-op when deleting a draft that was never stored', async () => {
    await expect(deleteDraft('never')).resolves.toBeUndefined()
  })

  it('drops the oldest conversations once the cap is reached', async () => {
    for (let i = 0; i < 40; i += 1) {
      await saveDraft(draft({ conversationId: `c-${i}`, name: `flow ${i}` }))
    }
    // The 32 most recent survive; the earliest are evicted.
    expect(await loadDraft('c-39')).toBeDefined()
    expect(await loadDraft('c-8')).toBeDefined()
    expect(await loadDraft('c-0')).toBeUndefined()
    expect(await loadDraft('c-7')).toBeUndefined()
  })

  it('re-saving an existing conversation refreshes its eviction position', async () => {
    for (let i = 0; i < 32; i += 1) {
      await saveDraft(draft({ conversationId: `c-${i}` }))
    }
    // Touch the oldest, then push one new draft in: the touched one survives.
    await saveDraft(draft({ conversationId: 'c-0' }))
    await saveDraft(draft({ conversationId: 'c-new' }))
    expect(await loadDraft('c-0')).toBeDefined()
    expect(await loadDraft('c-1')).toBeUndefined()
  })

  it('keeps a variable name without the megabyte payload behind it', async () => {
    // A trial run that screenshotted pages or drew images leaves data URLs in
    // the variable bag. Persisting them turned 32 drafts into one multi-megabyte
    // key rewritten on every tool call.
    const image = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`
    await saveDraft(
      draft({
        variables: {
          noteTitle: '推广文案',
          generatedImages: [image],
          capture: { screenshot: image, url: 'https://www.xiaohongshu.com' },
        },
      }),
    )

    const loaded = (await loadDraft('conv-1'))!
    expect(Object.keys(loaded.variables ?? {})).toEqual(['noteTitle', 'generatedImages', 'capture'])
    expect(loaded.variables?.noteTitle).toBe('推广文案')
    expect(loaded.variables?.capture).toMatchObject({ url: 'https://www.xiaohongshu.com' })
    const shrunk = (loaded.variables?.generatedImages as string[])[0]!
    expect(shrunk).toContain('data URL dropped')
    expect(shrunk.length).toBeLessThan(1024)
    expect((loaded.variables?.capture as { screenshot: string }).screenshot).toContain(
      'data URL dropped',
    )
  })

  it('bounds the whole draft key so the storage fallback can still carry it', async () => {
    // Every value is under the per-string limit and every draft under the count
    // cap, yet the record as a whole passes what the fallback parks per key —
    // and a key over that budget is REFUSED, losing the session's drafts whole.
    const wideBag = (tag: string): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: 10 }, (_, k) => [`v${k}`, `${tag}-${'x'.repeat(7000)}`]),
      )
    for (let i = 0; i < 32; i += 1) {
      await saveDraft(draft({ conversationId: `c-${i}`, variables: wideBag(`i${i}`) }))
    }

    const stored = (await chrome.storage.local.get('workflow-drafts'))[
      'workflow-drafts'
    ] as Record<string, unknown>
    expect(Object.keys(stored).length).toBeLessThan(32)
    expect(Object.keys(stored)).toContain('c-31')
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(1_500_000)
  })
})
