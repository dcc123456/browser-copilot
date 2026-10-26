/**
 * Applying a bundle files it into a group named after the parent workflow.
 *
 * The group id rides on the records before they are saved, so a failed group
 * write must leave the library untouched, and an update must never re-file a
 * workflow the user moved somewhere else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowGroup } from '../src/lib/workflow/groups'
import type { Workflow } from '../src/lib/workflow/types'
import type {
  MarketplaceCard,
  MarketplaceDependency,
  MarketplaceSecret,
} from '../src/lib/marketplace/types'

const mock = vi.hoisted(() => {
  const calls: Array<{ type: string; [key: string]: unknown }> = []
  const state = {
    groups: [] as WorkflowGroup[],
    passwords: [] as unknown[],
    failGroupList: false,
  }
  async function sendCommand(command: { type: string; [key: string]: unknown }) {
    calls.push(command)
    if (command.type === 'workflowGroups.list') {
      if (state.failGroupList) throw new Error('group read failed')
      return { type: 'workflowGroups.list', groups: [...state.groups] }
    }
    if (command.type === 'workflowGroups.save') {
      const now = Date.now()
      const group: WorkflowGroup = {
        id: `g-${state.groups.length + 1}`,
        name: String(command.name),
        createdAt: now,
        updatedAt: now,
      }
      state.groups.push(group)
      return { type: 'workflowGroups.save', group }
    }
    if (command.type === 'passwords.list') {
      return { type: 'passwords.list', entries: [...state.passwords] }
    }
    if (command.type === 'passwords.save') {
      state.passwords.push(command.entry)
      return { type: 'passwords.save', entry: command.entry }
    }
    if (command.type === 'workflows.save') return { type: 'workflows.save' }
    return { type: command.type }
  }
  const published = {
    parent: null as unknown,
    dependency: null as unknown,
  }
  return { calls, state, sendCommand, published }
})

vi.mock('../src/lib/messages', () => ({ sendCommand: mock.sendCommand }))
vi.mock('../src/lib/marketplace/raw', () => ({
  fetchPublishedWorkflow: async () => mock.published.parent,
  fetchWorkflowAt: async () => mock.published.dependency,
}))

const { installFromCard } = await import('../src/sidepanel/marketplace-install')
const { buildMeta } = await import('../src/lib/marketplace/meta')

const SLUG = 'scrape-orders-abcdef'
const NOW = Date.parse('2026-10-26T09:00:00.000Z')

function dependency(id: string, name: string): MarketplaceDependency {
  return { id, name, path: `deps/${name.toLowerCase().replace(/\s+/g, '-')}.json` }
}

function graph(name: string, targets: string[]): unknown {
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

function secretGraph(name: string, credential: string): unknown {
  return {
    id: 'published-id',
    name,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: {
      nodes: [
        {
          id: 'secret-0',
          label: 'Get secret',
          position: { x: 0, y: 0 },
          data: { blockId: 'get-secret', values: { credential, variableName: 'token' } },
        },
      ],
      edges: [],
    },
  }
}

function card(
  dependencies: MarketplaceDependency[] = [],
  secrets: MarketplaceSecret[] = [],
): MarketplaceCard {
  return {
    meta: buildMeta({
      slug: SLUG,
      title: 'Scrape orders',
      description: 'Open the orders page.',
      category: 'ecommerce',
      dependencies,
      secrets,
      author: 'octocat',
      version: 2,
      hash: 'b'.repeat(64),
      now: new Date(NOW),
    }),
    prNumber: 10,
    likes: 0,
    comments: 0,
  }
}

function installed(folderId: string): Workflow {
  return {
    id: 'local-1',
    name: 'My edited copy',
    folderId,
    createdAt: 111,
    updatedAt: 222,
    revision: 2,
    revisionHistory: [{ revision: 2, updatedAt: 222, source: 'manual-edit' }],
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes: [], edges: [] },
    marketplace: {
      repo: 'dcc123456/BC-workflow',
      slug: SLUG,
      version: 1,
      hash: 'a'.repeat(64),
      author: 'octocat',
      appliedAt: 50,
    },
  }
}

function savedWorkflows(): Workflow[] {
  return mock.calls
    .filter((command) => command.type === 'workflows.save')
    .map((command) => command.workflow as Workflow)
}

function savedPasswords(): Array<{ id: string; fields: Array<{ key: string; value: string }> }> {
  return mock.calls
    .filter((command) => command.type === 'passwords.save')
    .map(
      (command) => command.entry as { id: string; fields: Array<{ key: string; value: string }> },
    )
}

beforeEach(() => {
  mock.calls.length = 0
  mock.state.groups = []
  mock.state.passwords = []
  mock.state.failGroupList = false
  mock.published.parent = graph('Scrape orders', ['child-1'])
  mock.published.dependency = graph('Collect numbers', [])
})

describe('installing a bundle', () => {
  it('files the parent and its dependencies into a group named after the parent', async () => {
    const plan = await installFromCard(
      card([dependency('child-1', 'Collect numbers')]),
      undefined,
      [],
    )

    expect(plan.status).toBe('new')
    expect(mock.calls.map((command) => command.type)).toEqual([
      'workflowGroups.list',
      'workflowGroups.save',
      'workflows.save',
      'workflows.save',
    ])
    expect(mock.calls[1]!.name).toBe('Scrape orders')
    const saves = savedWorkflows()
    expect(saves.map((workflow) => workflow.name)).toEqual(['Collect numbers', 'Scrape orders'])
    for (const workflow of saves) expect(workflow.folderId).toBe('g-1')
  })

  it('reuses a group that already carries the parent name', async () => {
    mock.state.groups = [{ id: 'g-9', name: 'Scrape orders', createdAt: 1, updatedAt: 1 }]

    await installFromCard(card([dependency('child-1', 'Collect numbers')]), undefined, [])

    expect(mock.calls.some((command) => command.type === 'workflowGroups.save')).toBe(false)
    for (const workflow of savedWorkflows()) expect(workflow.folderId).toBe('g-9')
  })

  it('leaves a single workflow ungrouped', async () => {
    mock.published.parent = graph('Scrape orders', [])

    await installFromCard(card(), undefined, [])

    expect(mock.calls.some((command) => command.type.startsWith('workflowGroups'))).toBe(false)
    expect(savedWorkflows()[0]!.folderId).toBeUndefined()
  })

  it('does not re-file an update out of the group the user chose', async () => {
    const local = installed('user-group')
    const localDependency: Workflow = {
      id: 'mkt-scrape-orders-abcdef-collect-numbers',
      name: 'Collect numbers',
      folderId: 'user-group',
      createdAt: 111,
      updatedAt: 222,
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      drawflow: { nodes: [], edges: [] },
    }

    const plan = await installFromCard(card([dependency('child-1', 'Collect numbers')]), local, [
      local,
      localDependency,
    ])

    expect(plan.status).toBe('update')
    expect(mock.calls.some((command) => command.type.startsWith('workflowGroups'))).toBe(false)
    for (const workflow of savedWorkflows()) expect(workflow.folderId).toBe('user-group')
  })

  it('writes nothing when the group cannot be created', async () => {
    mock.state.failGroupList = true

    await expect(
      installFromCard(card([dependency('child-1', 'Collect numbers')]), undefined, []),
    ).rejects.toThrow(/group read failed/)
    expect(savedWorkflows()).toEqual([])
    expect(mock.state.groups).toEqual([])
  })

  it('saves the imported credential before the workflow that uses it', async () => {
    mock.published.parent = secretGraph('Scrape orders', 'gh::token')

    await installFromCard(
      card(
        [],
        [
          {
            id: 'gh',
            label: 'GitHub',
            fields: [
              { key: 'token', value: 'ghp_live' },
              { key: 'password', value: '', secret: true },
            ],
          },
        ],
      ),
      undefined,
      [],
    )

    expect(mock.calls.map((command) => command.type)).toEqual([
      'passwords.list',
      'passwords.save',
      'workflows.save',
    ])
    expect(savedPasswords()).toEqual([
      {
        id: 'mkt-scrape-orders-abcdef-gh',
        label: 'GitHub',
        fields: [
          { key: 'token', value: 'ghp_live' },
          { key: 'password', value: '', secret: true },
        ],
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        useCount: 0,
      },
    ])
    expect(savedWorkflows()[0]!.drawflow.nodes[0]!.data).toMatchObject({
      credential: 'mkt-scrape-orders-abcdef-gh::token',
    })
  })
})
