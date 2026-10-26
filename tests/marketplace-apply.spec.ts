import { describe, expect, it } from 'vitest'
import {
  bundleDependencyId,
  findInstalled,
  planApply,
  planApplyBundle,
} from '../src/lib/marketplace/apply'
import { buildMeta } from '../src/lib/marketplace/meta'
import type { MarketplaceCard, MarketplaceDependency } from '../src/lib/marketplace/types'
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

function existing(version = 1, hash = 'a'.repeat(64)): Workflow {
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
      hash,
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
    const local = existing(2, 'b'.repeat(64))
    const plan = planApply(card(2), published(), local, NOW)
    expect(plan.status).toBe('up-to-date')
    expect(plan.workflow).toBe(local)
  })

  it('updates a copy the publisher re-released under the same version', () => {
    const plan = planApply(card(2), published(), existing(2, 'a'.repeat(64)), NOW)

    expect(plan.status).toBe('update')
    expect(plan.workflow.marketplace?.hash).toBe('b'.repeat(64))
  })

  it('does not downgrade to an older published version', () => {
    const local = existing(3, 'a'.repeat(64))
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

function dependency(id: string, name: string): MarketplaceDependency {
  return { id, name, path: `deps/${name.toLowerCase().replace(/\s+/g, '-')}.json` }
}

function bundleCard(
  version = 2,
  dependencies: MarketplaceDependency[] = [dependency('child-1', 'Collect numbers')],
): MarketplaceCard {
  return {
    meta: buildMeta({
      slug: 'scrape-orders-abcdef',
      title: 'Scrape orders',
      description: 'Open the orders page.',
      category: 'ecommerce',
      tags: ['orders'],
      dependencies,
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

/** A published body whose only steps call other workflows by the given ids. */
function callGraph(name: string, targets: string[]): unknown {
  return {
    id: 'published-id',
    name,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: {
      nodes: targets.map((target, index) => ({
        id: `call-${index}`,
        label: 'Execute workflow',
        position: { x: 0, y: 0 },
        data: { blockId: 'execute-workflow', values: { workflowId: target } },
      })),
      edges: [],
    },
  }
}

describe('planApplyBundle', () => {
  it('installs dependencies under deterministic ids and rewrites the calls', () => {
    const plan = planApplyBundle(
      bundleCard(),
      callGraph('Scrape orders', ['child-1']),
      [
        {
          entry: dependency('child-1', 'Collect numbers'),
          published: callGraph('Collect numbers', []),
        },
      ],
      [],
      undefined,
      NOW,
    )

    expect(plan.status).toBe('new')
    expect(plan.dependencies).toHaveLength(1)
    const record = plan.dependencies[0]!
    expect(record.id).toBe('mkt-scrape-orders-abcdef-collect-numbers')
    expect(record.id).toBe(bundleDependencyId('scrape-orders-abcdef', 'deps/collect-numbers.json'))
    expect(record.name).toBe('Collect numbers')
    expect(record.createdAt).toBe(NOW)
    expect(record.marketplace).toBeUndefined()
    expect(plan.workflow.drawflow.nodes[0]!.data).toMatchObject({ workflowId: record.id })
  })

  it('rewrites calls inside a bundled workflow too', () => {
    const plan = planApplyBundle(
      bundleCard(2, [dependency('mid-1', 'Export orders'), dependency('leaf-1', 'Read rows')]),
      callGraph('Scrape orders', ['mid-1']),
      [
        {
          entry: dependency('mid-1', 'Export orders'),
          published: callGraph('Export orders', ['leaf-1']),
        },
        { entry: dependency('leaf-1', 'Read rows'), published: callGraph('Read rows', []) },
      ],
      [],
      undefined,
      NOW,
    )

    expect(plan.workflow.drawflow.nodes[0]!.data).toMatchObject({
      workflowId: 'mkt-scrape-orders-abcdef-export-orders',
    })
    expect(plan.dependencies[0]!.drawflow.nodes[0]!.data).toMatchObject({
      workflowId: 'mkt-scrape-orders-abcdef-read-rows',
    })
  })

  it('replaces a previously installed dependency in place', () => {
    const previous: Workflow = {
      id: 'mkt-scrape-orders-abcdef-collect-numbers',
      name: 'Old copy',
      createdAt: 111,
      updatedAt: 222,
      revision: 3,
      revisionHistory: [{ revision: 3, updatedAt: 222, source: 'marketplace' }],
      trigger: { type: 'interval', schedule: '15', enabled: true },
      settings: { saveLog: true, debugMode: true, notification: true, reuseLastState: true },
      drawflow: { nodes: [], edges: [] },
    }

    const plan = planApplyBundle(
      bundleCard(),
      callGraph('Scrape orders', ['child-1']),
      [
        {
          entry: dependency('child-1', 'Collect numbers'),
          published: callGraph('Collect numbers', []),
        },
      ],
      [previous],
      undefined,
      NOW,
    )

    const record = plan.dependencies[0]!
    expect(record.id).toBe(previous.id)
    expect(record.createdAt).toBe(111)
    expect(record.name).toBe('Collect numbers')
    expect(record.revision).toBe(4)
    expect(record.revisionHistory?.at(-1)).toMatchObject({
      revision: 4,
      source: 'marketplace-update',
    })
    // The local copy's schedule must not survive an update.
    expect(record.trigger).toBeUndefined()
  })

  it('installs nothing extra when the parent is already up to date', () => {
    const local = existing(2, 'b'.repeat(64))
    const plan = planApplyBundle(
      bundleCard(2),
      callGraph('Scrape orders', ['child-1']),
      [
        {
          entry: dependency('child-1', 'Collect numbers'),
          published: callGraph('Collect numbers', []),
        },
      ],
      [local],
      local,
      NOW,
    )

    expect(plan.status).toBe('up-to-date')
    expect(plan.dependencies).toEqual([])
    expect(plan.credentials).toEqual([])
  })

  it('imports the listing credentials and points the graph at the local ids', () => {
    const secret = {
      id: 'gh',
      label: 'GitHub',
      fields: [
        { key: 'token', value: 'ghp_live' },
        { key: 'password', value: '', secret: true },
      ],
    }
    const card: MarketplaceCard = {
      ...bundleCard(2),
      meta: { ...bundleCard(2).meta, secrets: [secret] },
    }
    const secretGraph = (name: string, credential: string): unknown => ({
      ...(callGraph(name, []) as Record<string, unknown>),
      drawflow: {
        nodes: [
          {
            id: 's1',
            label: 'Get secret',
            position: { x: 0, y: 0 },
            data: {
              blockId: 'get-secret',
              values: { credential, variableName: 'value' },
            },
          },
        ],
        edges: [],
      },
    })
    const localEntry = {
      id: 'mkt-scrape-orders-abcdef-gh',
      label: 'GitHub',
      fields: [{ key: 'password', value: 'typed-before', secret: true }],
      createdAt: 1,
      updatedAt: 1,
      useCount: 3,
    }

    const plan = planApplyBundle(
      card,
      secretGraph('Scrape orders', 'gh::token'),
      [
        {
          entry: dependency('child-1', 'Collect numbers'),
          published: secretGraph('Collect numbers', 'gh::password'),
        },
      ],
      [],
      undefined,
      NOW,
      [localEntry],
    )

    expect(plan.credentials).toEqual([
      {
        ...localEntry,
        fields: [
          { key: 'password', value: 'typed-before', secret: true },
          { key: 'token', value: 'ghp_live' },
        ],
        updatedAt: NOW,
      },
    ])
    expect(plan.workflow.drawflow.nodes[0]!.data).toMatchObject({
      credential: 'mkt-scrape-orders-abcdef-gh::token',
    })
    // The bundled sub-workflow resolves the same credential without asking.
    expect(plan.dependencies[0]!.drawflow.nodes[0]!.data).toMatchObject({
      credential: 'mkt-scrape-orders-abcdef-gh::password',
    })
  })

  it('rejects a bundle that does not match meta.json', () => {
    const parent = callGraph('Scrape orders', ['child-1'])
    expect(() => planApplyBundle(bundleCard(), parent, [], [], undefined, NOW)).toThrow(
      'The published bundle is incomplete',
    )
    expect(() =>
      planApplyBundle(
        bundleCard(),
        parent,
        [{ entry: dependency('other-1', 'Other'), published: callGraph('Other', []) }],
        [],
        undefined,
        NOW,
      ),
    ).toThrow('A bundled workflow is not listed in meta.json')
    expect(() =>
      planApplyBundle(
        bundleCard(),
        parent,
        [{ entry: dependency('child-1', 'Collect numbers'), published: { id: 'no-name' } }],
        [],
        undefined,
        NOW,
      ),
    ).toThrow(/Collect numbers" is not readable/)
  })
})
