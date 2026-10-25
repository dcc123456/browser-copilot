/**
 * Update detection is version-based: a locally edited workflow is not stale,
 * it is what an update overwrites, and an unpublished slug has nothing to
 * compare against.
 */
import { describe, expect, it } from 'vitest'
import { pendingUpdates } from '../src/lib/marketplace/apply'
import type { MarketplaceCard, MarketplaceMeta } from '../src/lib/marketplace/types'
import type { Workflow } from '../src/lib/workflow/types'

function meta(slug: string, version: number, hash = 'a'.repeat(64)): MarketplaceMeta {
  return {
    schema: 1,
    slug,
    title: `Workflow ${slug}`,
    description: '',
    category: 'other',
    tags: [],
    author: 'octocat',
    version,
    hash,
    images: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  }
}

function card(slug: string, version: number, hash = 'a'.repeat(64)): MarketplaceCard {
  return { meta: meta(slug, version, hash), prNumber: 7, likes: 0, comments: 0 }
}

function installed(id: string, slug: string, version: number, hash = 'a'.repeat(64)): Workflow {
  return {
    id,
    name: `Local ${id}`,
    createdAt: 1,
    updatedAt: 2,
    drawflow: { nodes: [], edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    marketplace: {
      repo: 'dcc123456/BC-workflow',
      slug,
      version,
      hash,
      author: 'octocat',
      appliedAt: 3,
    },
  }
}

describe('pendingUpdates', () => {
  it('flags a workflow whose published version moved ahead', () => {
    const updates = pendingUpdates(
      [installed('wf-1', 'scrape-orders-111', 1), installed('wf-2', 'other-222', 3)],
      [card('scrape-orders-111', 2), card('other-222', 3)],
    )

    expect(Object.keys(updates)).toEqual(['wf-1'])
    expect(updates['wf-1']?.meta.version).toBe(2)
  })

  it('does not flag a local edit at the same published version', () => {
    // The local hash differs (the user edited the graph) but the publisher has
    // not released anything new — an update here would silently discard work.
    const updates = pendingUpdates(
      [installed('wf-1', 'scrape-orders-111', 2, 'f'.repeat(64))],
      [card('scrape-orders-111', 2)],
    )

    expect(updates).toEqual({})
  })

  it('ignores workflows that were never installed', () => {
    const local: Workflow = {
      id: 'wf-1',
      name: 'Hand made',
      createdAt: 1,
      updatedAt: 2,
      drawflow: { nodes: [], edges: [] },
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    }
    expect(pendingUpdates([local], [card('scrape-orders-111', 2)])).toEqual({})
  })

  it('ignores a card that is gone from the catalog', () => {
    expect(pendingUpdates([installed('wf-1', 'deleted-111', 1)], [])).toEqual({})
  })

  it('ignores an older published version', () => {
    expect(
      pendingUpdates([installed('wf-1', 'scrape-orders-111', 3)], [card('scrape-orders-111', 2)]),
    ).toEqual({})
  })
})
