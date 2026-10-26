import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blobToDraftFile,
  clearDraft,
  DRAFT_SCHEMA_VERSION,
  DRAFT_TTL_MS,
  draftFileToBlob,
  loadDraft,
  MARKETPLACE_DRAFT_KEY,
  MAX_DRAFTS,
  parseDraft,
  saveDraft,
  type PublishDraft,
} from '../src/lib/marketplace/draft'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    store,
    storage: {
      local: {
        get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        }),
        remove: vi.fn(async (key: string | string[]) => {
          for (const entry of Array.isArray(key) ? key : [key]) store.delete(entry)
        }),
      },
    },
  }
}

function makeDraft(overrides: Partial<PublishDraft> = {}): PublishDraft {
  return {
    schema: DRAFT_SCHEMA_VERSION,
    workflowId: 'local-1',
    title: 'Scrape orders',
    description: 'Draft copy',
    category: 'data',
    customCategory: '',
    tags: 'shop, orders',
    videoUrl: '',
    images: [{ type: 'image/png', dataUrl: PNG }],
    attachments: [{ name: 'orders.csv', type: 'text/csv', dataUrl: 'data:text/csv;base64,YSxi' }],
    savedAt: Date.now(),
    ...overrides,
  }
}

function draftsInStore(mocks: ReturnType<typeof makeChromeMock>): Record<string, PublishDraft> {
  return (mocks.store.get(MARKETPLACE_DRAFT_KEY) ?? {}) as Record<string, PublishDraft>
}

describe('marketplace publish draft', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('round-trips the form, screenshots and attachments', async () => {
    await saveDraft(makeDraft())

    const loaded = await loadDraft('local-1')
    expect(loaded).toMatchObject({
      title: 'Scrape orders',
      description: 'Draft copy',
      category: 'data',
      tags: 'shop, orders',
    })
    expect(loaded?.images).toHaveLength(1)
    expect(loaded?.attachments[0]?.name).toBe('orders.csv')
  })

  it('keeps each workflow on its own entry', async () => {
    await saveDraft(makeDraft())
    await saveDraft(makeDraft({ workflowId: 'local-2', title: 'Other' }))

    expect((await loadDraft('local-1'))?.title).toBe('Scrape orders')
    expect((await loadDraft('local-2'))?.title).toBe('Other')
    expect(Object.keys(draftsInStore(mocks))).toHaveLength(2)
  })

  it('forgets a draft past its lifetime', async () => {
    const savedAt = Date.now()
    await saveDraft(makeDraft({ savedAt }))

    expect(await loadDraft('local-1', savedAt + DRAFT_TTL_MS + 1)).toBeNull()
    expect(draftsInStore(mocks)['local-1']).toBeUndefined()
  })

  it('drops expired entries and keeps the newest MAX_DRAFTS', async () => {
    const now = Date.now()
    for (let index = 0; index < MAX_DRAFTS + 2; index += 1) {
      await saveDraft(
        makeDraft({ workflowId: `wf-${index}`, title: `Draft ${index}`, savedAt: now + index }),
        now + MAX_DRAFTS + 2,
      )
    }
    await saveDraft(makeDraft({ workflowId: 'stale', savedAt: now - DRAFT_TTL_MS - 1 }), now)

    const kept = draftsInStore(mocks)
    expect(Object.keys(kept)).toHaveLength(MAX_DRAFTS)
    expect(kept['wf-0']).toBeUndefined()
    expect(kept[`wf-${MAX_DRAFTS + 1}`]).toBeDefined()
    expect(kept.stale).toBeUndefined()
  })

  it('clears one entry and removes the key with the last one', async () => {
    await saveDraft(makeDraft())
    await saveDraft(makeDraft({ workflowId: 'local-2' }))

    await clearDraft('local-1')
    expect(await loadDraft('local-1')).toBeNull()
    expect(await loadDraft('local-2')).not.toBeNull()

    await clearDraft('local-2')
    expect(mocks.store.has(MARKETPLACE_DRAFT_KEY)).toBe(false)
  })

  it('ignores data that does not belong to the workflow', () => {
    expect(parseDraft({ ...makeDraft(), schema: 99 }, 'local-1')).toBeNull()
    expect(parseDraft(makeDraft(), 'local-2')).toBeNull()
    expect(parseDraft('nope', 'local-1')).toBeNull()
  })

  it('drops unreadable files instead of failing the whole draft', () => {
    const parsed = parseDraft(
      {
        ...makeDraft(),
        title: 42,
        images: [{ type: 'image/png', dataUrl: 'https://example.com/a.png' }, { dataUrl: PNG }],
        attachments: [{ dataUrl: 'data:text/csv;base64,YSxi' }],
      },
      'local-1',
    )

    expect(parsed?.title).toBe('')
    expect(parsed?.images).toEqual([{ type: 'image/png', dataUrl: PNG }])
    expect(parsed?.attachments).toEqual([])
  })

  it('encodes and decodes a file without changing its bytes', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'image/webp' })
    const stored = await blobToDraftFile(blob)
    const restored = draftFileToBlob(stored)

    expect(stored.dataUrl.startsWith('data:image/webp;base64,')).toBe(true)
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 250]))
  })
})
