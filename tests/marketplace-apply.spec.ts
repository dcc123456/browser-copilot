import { describe, expect, it } from 'vitest'
import { findInstalled, planApply } from '../src/lib/marketplace/apply'
import { buildMeta } from '../src/lib/marketplace/meta'
import type { MarketplaceCard } from '../src/lib/marketplace/types'
import type { Workflow } from '../src/lib/workflow/types'

const NOW = Date.parse('2026-10-25T09:00:00.000Z')

function card(version = 2): MarketplaceCard {
  return {
    meta: buildMeta({
      slug: 'scrape-orders-abcdef',
      title: 'Scrape orders',
      description: 'Open the orders page.',
      category: 'ecommerce',
      tags: ['orders'],
      author: 'octocat',
      version,
      hash: 'b'.repeat(64),
      now: new Date(NOW),
    }),
    prNumber: 10,
    likes: 3,
    comments: 2,
  }
}

function published(): unknown {
  return {
    id: 'remote-id',
    name: 'Scrape orders',
    description: 'Open the orders page.',
    trigger: { type: 'scheduled', schedule: '0 9 * * *', enabled: true },
    settings: { saveLog: true, debugMode: true, notification: true, reuseLastState: true },
    drawflow: {
      nodes: [
        {
          id: 'n1',
          label: 'Open page',
          position: { x: 1, y: 2 },
          data: { blockId: 'forms', selector: '#orders' },
        },
      ],
      edges: [],
    },
  }
}

function existing(version = 1): Workflow {
  return {
    id: 'local-1',
    name: 'My edited copy',
    description: 'local description',
    plan: 'local plan',
    folderId: 'folder-a',
    createdAt: 111,
    updatedAt: 222,
    revision: 4,
    revisionHistory: [{ revision: 4, updatedAt: 222, source: 'manual-edit' }],
    trigger: { type: 'interval', schedule: '15', enabled: true },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes: [], edges: [] },
    table: { id: 'table-1' },
    marketplace: {
      repo: 'dcc123456/BC-workflow',
      slug: 'scrape-orders-abcdef',
      version,
      hash: 'a'.repeat(64),
      author: 'octocat',
      appliedAt: 50,
    },
  }
}

describe('planApply', () => {
  it('creates a fresh local record for a new workflow', () => {
    const plan = planApply(card(), published(), undefined, NOW)

    expect(plan.status).toBe('new')
    expect(plan.workflow.id).not.toBe('remote-id')
    expect(plan.workflow.createdAt).toBe(NOW)
    expect(plan.workflow.updatedAt).toBe(NOW)
    expect(plan.workflow.folderId).toBeUndefined()
    expect(plan.workflow.revision).toBe(1)
    expect(plan.workflow.revisionHistory).toEqual([
      { revision: 1, updatedAt: NOW, source: 'marketplace' },
    ])
    expect(plan.workflow.marketplace).toEqual({
      repo: 'dcc123456/BC-workflow',
      slug: 'scrape-orders-abcdef',
      version: 2,
      hash: 'b'.repeat(64),
      author: 'octocat',
      appliedAt: NOW,
    })
    // A published trigger is display metadata only; it must not arm itself.
    expect(plan.workflow.trigger).toMatchObject({ enabled: false })
  })

  it('reports up-to-date without rewriting the local copy', () => {
    const local = existing(2)
    const plan = planApply(card(2), published(), local, NOW)
    expect(plan.status).toBe('up-to-date')
    expect(plan.workflow).toBe(local)
  })

  it('updates in place, keeping identity and bumping the revision', () => {
    const local = existing(1)
    const plan = planApply(card(2), published(), local, NOW)

    expect(plan.status).toBe('update')
    expect(plan.workflow.id).toBe('local-1')
    expect(plan.workflow.folderId).toBe('folder-a')
    expect(plan.workflow.createdAt).toBe(111)
    expect(plan.workflow.name).toBe('Scrape orders')
    expect(plan.workflow.drawflow.nodes).toHaveLength(1)
    expect(plan.workflow.table).toEqual({ id: 'table-1' })
    expect(plan.workflow.revision).toBe(5)
    expect(plan.workflow.revisionHistory?.at(-1)).toEqual({
      revision: 5,
      updatedAt: NOW,
      source: 'marketplace-update',
      parentRevision: 4,
    })
    expect(plan.workflow.marketplace?.version).toBe(2)
    expect(plan.workflow.trigger).toMatchObject({ type: 'scheduled', enabled: false })
  })

  it('rejects a published body that storage would not accept', () => {
    expect(() => planApply(card(), null, undefined, NOW)).toThrow(/not readable/)
    expect(() => planApply(card(), { id: 'no-name' }, undefined, NOW)).toThrow(/not readable/)
  })

  it('finds an installed workflow by its marketplace slug', () => {
    const local = existing(1)
    expect(findInstalled([local], 'scrape-orders-abcdef')).toBe(local)
    expect(findInstalled([local], 'other')).toBeUndefined()
  })
})
