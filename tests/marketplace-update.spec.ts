/**
 * Update detection follows the published listing, not the local copy: a newer
 * version or a changed content hash at the same version flags the installed
 * workflow. A local edit never touches `marketplace.hash`, so it is not stale —
 * it is what an update overwrites — and an unpublished slug has nothing to
 * compare against.
 */
import { describe, expect, it } from 'vitest'
import { pendingUpdates, removedSources } from '../src/lib/marketplace/apply'
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

  it('flags a listing re-published under the same version', () => {
    // A slug can be removed and added back under a number it already used, so
    // the version alone would hide the new content forever.
    const updates = pendingUpdates(
      [installed('wf-1', 'scrape-orders-111', 2, 'f'.repeat(64))],
      [card('scrape-orders-111', 2)],
    )

    expect(Object.keys(updates)).toEqual(['wf-1'])
  })

  it('leaves a copy that matches the published content alone', () => {
    const updates = pendingUpdates(
      [installed('wf-1', 'scrape-orders-111', 2)],
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

  it('never offers a downgrade from an older catalog snapshot', () => {
    expect(
      pendingUpdates(
        [installed('wf-1', 'scrape-orders-111', 3, 'f'.repeat(64))],
        [card('scrape-orders-111', 2)],
      ),
    ).toEqual({})
  })

  it('compares a copy only against cards from its own repository', () => {
    const team = installed('wf-1', 'shared-111', 1)
    team.marketplace = { ...team.marketplace!, repo: 'acme/team-workflows' }

    expect(pendingUpdates([team], [card('shared-111', 2)])).toEqual({})
    expect(
      Object.keys(pendingUpdates([team], [card('shared-111', 2)], 'acme/team-workflows')),
    ).toEqual(['wf-1'])
  })
})

describe('removedSources', () => {
  it('marks an installed workflow whose slug is gone from a complete catalog', () => {
    const removed = removedSources(
      [installed('wf-1', 'deleted-111', 1), installed('wf-2', 'live-222', 1)],
      [card('live-222', 1)],
      true,
    )

    expect([...removed]).toEqual(['wf-1'])
  })

  it('claims nothing from a truncated or stale catalog', () => {
    expect([...removedSources([installed('wf-1', 'deleted-111', 1)], [], false)]).toEqual([])
  })

  it('ignores local workflows that never came from the marketplace', () => {
    const local: Workflow = {
      id: 'wf-1',
      name: 'Hand made',
      createdAt: 1,
      updatedAt: 2,
      drawflow: { nodes: [], edges: [] },
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    }
    expect([...removedSources([local], [], true)]).toEqual([])
  })

  it('ignores references to a different repository', () => {
    const foreign = installed('wf-1', 'deleted-111', 1)
    foreign.marketplace = { ...foreign.marketplace!, repo: 'someone/other-workflows' }
    expect([...removedSources([foreign], [], true)]).toEqual([])
  })

  it('only judges copies from the repository the catalog came from', () => {
    const team = installed('wf-1', 'deleted-111', 1)
    team.marketplace = { ...team.marketplace!, repo: 'acme/team-workflows' }
    expect([...removedSources([team], [], true)]).toEqual([])
    expect([...removedSources([team], [], true, 'acme/team-workflows')]).toEqual(['wf-1'])
  })
})
