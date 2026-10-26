import { describe, expect, it } from 'vitest'
import {
  applySecretOverrides,
  collectSecretRefs,
  filledPasswordFields,
  marketplaceSecretId,
  normalizePublishedSecrets,
  planPublishedSecrets,
  planSecretImport,
  rewriteWorkflowSecrets,
  secretValueKey,
} from '../src/lib/marketplace/secrets'
import {
  MAX_LISTING_SECRETS,
  MAX_SECRET_KEY_CHARS,
  MarketplaceError,
  type MarketplaceSecret,
} from '../src/lib/marketplace/types'
import type { PasswordEntry } from '../src/lib/types'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const NOW = Date.parse('2026-10-26T09:00:00.000Z')

function workflow(id: string, nodes: WorkflowNode[]): Workflow {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    trigger: { type: 'manual' },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes, edges: [] },
  }
}

function secretNode(id: string, values: Record<string, unknown>): WorkflowNode {
  return {
    id,
    label: 'Get secret',
    position: { x: 0, y: 0 },
    data: { blockId: 'get-secret', values },
  }
}

function entry(overrides: Partial<PasswordEntry> = {}): PasswordEntry {
  return {
    id: 'gh',
    label: 'GitHub',
    url: 'https://github.com',
    fields: [
      { key: 'username', value: 'octocat' },
      { key: 'password', value: 'hunter2', secret: true },
      { key: 'token', value: 'ghp_live' },
      { key: 'backup-code', value: '0000' },
    ],
    createdAt: 111,
    updatedAt: 222,
    useCount: 7,
    ...overrides,
  }
}

function publishedSecret(overrides: Partial<MarketplaceSecret> = {}): MarketplaceSecret {
  return {
    id: 'gh',
    label: 'GitHub',
    url: 'https://github.com',
    fields: [
      { key: 'username', value: 'octocat' },
      { key: 'password', value: '', secret: true },
      { key: 'token', value: 'ghp_live' },
    ],
    ...overrides,
  }
}

describe('collectSecretRefs', () => {
  it('gathers named fields across every graph and dedupes them', () => {
    const parent = workflow('parent', [
      secretNode('s1', { credential: 'gh::token' }),
      secretNode('s2', { credential: 'gh::username' }),
      secretNode('s3', { credential: 'mail::password' }),
    ])
    const child = workflow('child', [secretNode('s4', { credential: 'gh::token' })])

    expect(collectSecretRefs([parent, child])).toEqual([
      { credentialId: 'gh', fields: ['token', 'username'], anyField: false },
      { credentialId: 'mail', fields: ['password'], anyField: false },
    ])
  })

  it('marks a bare-id reference as needing every field', () => {
    const graph = workflow('one', [secretNode('s1', { credential: 'gh' })])

    expect(collectSecretRefs([graph])).toEqual([{ credentialId: 'gh', fields: [], anyField: true }])
  })

  it('reads the multi-row shape and ignores other blocks', () => {
    const graph = workflow('one', [
      secretNode('s1', { credential: 'gh::token', credentials: [{ credential: 'gh::token' }] }),
      { id: 'n2', label: 'Click', position: { x: 0, y: 0 }, data: { blockId: 'click' } },
    ])

    expect(collectSecretRefs([graph])).toEqual([
      { credentialId: 'gh', fields: ['token'], anyField: false },
    ])
  })
})

describe('planPublishedSecrets', () => {
  it('publishes referenced fields only, emptying password fields', () => {
    const graph = workflow('one', [
      secretNode('s1', { credential: 'gh::username' }),
      secretNode('s2', { credential: 'gh::password' }),
    ])

    const plan = planPublishedSecrets([graph], [entry()])

    expect(plan.missing).toEqual([])
    expect(plan.secrets).toEqual([
      {
        id: 'gh',
        label: 'GitHub',
        url: 'https://github.com',
        fields: [
          { key: 'username', value: 'octocat' },
          { key: 'password', value: '', secret: true },
        ],
      },
    ])
  })

  it('publishes every field when the node names the credential alone', () => {
    const plan = planPublishedSecrets(
      [workflow('one', [secretNode('s1', { credential: 'gh' })])],
      [entry()],
    )

    expect(plan.secrets[0]?.fields).toEqual([
      { key: 'username', value: 'octocat' },
      { key: 'password', value: '', secret: true },
      { key: 'token', value: 'ghp_live' },
      { key: 'backup-code', value: '0000' },
    ])
  })

  it('reports a credential the vault does not have and a field it lacks', () => {
    const graph = workflow('one', [
      secretNode('s1', { credential: 'gh::backup-pin' }),
      secretNode('s2', { credential: 'mail::password' }),
    ])

    const plan = planPublishedSecrets([graph], [entry()])

    expect(plan.missing).toEqual(['gh', 'mail'])
    expect(plan.secrets).toEqual([])
  })

  it('carries bundled credentials alongside the parent', () => {
    const parent = workflow('parent', [secretNode('s1', { credential: 'gh::token' })])
    const child = workflow('child', [secretNode('s2', { credential: 'mail::username' })])

    const plan = planPublishedSecrets(
      [parent, child],
      [entry(), entry({ id: 'mail', label: 'Mail', fields: [{ key: 'username', value: 'me@x' }] })],
    )

    expect(plan.secrets.map((secret) => secret.id)).toEqual(['gh', 'mail'])
    expect(plan.secrets[1]).toEqual({
      id: 'mail',
      label: 'Mail',
      url: 'https://github.com',
      fields: [{ key: 'username', value: 'me@x' }],
    })
  })
})

describe('applySecretOverrides', () => {
  it('replaces only the fields the publisher edited', () => {
    const secrets = [publishedSecret()]

    const edited = applySecretOverrides(secrets, {
      [secretValueKey('gh', 'password')]: 'typed-password',
    })

    expect(edited[0]?.fields).toEqual([
      { key: 'username', value: 'octocat' },
      { key: 'password', value: 'typed-password', secret: true },
      { key: 'token', value: 'ghp_live' },
    ])
    // The plan is not mutated by an edit.
    expect(secrets[0]?.fields[1]?.value).toBe('')
  })

  it('applies an override that clears a plain field', () => {
    const edited = applySecretOverrides([publishedSecret()], {
      [secretValueKey('gh', 'token')]: '',
    })

    expect(edited[0]?.fields[2]?.value).toBe('')
  })
})

describe('normalizePublishedSecrets', () => {
  const graph = workflow('one', [secretNode('s1', { credential: 'gh::token' })])
  const refs = collectSecretRefs([graph])

  it('drops credentials and fields no step references, and trims the rest', () => {
    const secrets = normalizePublishedSecrets(refs, [
      entry({ id: 'gh', label: '  GitHub  ' }),
      publishedSecret({ id: 'other', label: 'Unused' }),
    ])

    expect(secrets).toEqual([
      {
        id: 'gh',
        label: 'GitHub',
        url: 'https://github.com',
        fields: [{ key: 'token', value: 'ghp_live' }],
      },
    ])
  })

  it('keeps everything when the step names the credential alone', () => {
    const anyFieldRefs = collectSecretRefs([
      workflow('two', [secretNode('s', { credential: 'gh' })]),
    ])

    const secrets = normalizePublishedSecrets(anyFieldRefs, [publishedSecret()])

    expect(secrets[0]?.fields).toHaveLength(3)
  })

  it('refuses to publish a referenced credential that has no record', () => {
    let caught: unknown
    try {
      normalizePublishedSecrets(refs, [])
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(MarketplaceError)
    expect((caught as MarketplaceError).code).toBe('invalid')
    expect((caught as MarketplaceError).message).toContain('gh')
  })

  it('refuses a record that lost the referenced field', () => {
    expect(() =>
      normalizePublishedSecrets(refs, [
        { id: 'gh', label: 'GitHub', fields: [{ key: 'username', value: 'octocat' }] },
      ]),
    ).toThrow(/missing/i)
  })

  it('caps how many credentials one listing carries', () => {
    const many = Array.from({ length: MAX_LISTING_SECRETS + 1 }, (_, index) =>
      secretNode(`s${index}`, { credential: `credential-${index}::token` }),
    )
    const manyRefs = collectSecretRefs([workflow('many', many)])

    expect(() => normalizePublishedSecrets(manyRefs, [])).toThrow(/at most/i)
  })

  it('trims an over-long field key instead of rejecting the publish', () => {
    const longRefs = collectSecretRefs([
      workflow('one', [secretNode('s1', { credential: `gh::${'k'.repeat(300)}` })]),
    ])

    const secrets = normalizePublishedSecrets(longRefs, [
      { id: 'gh', label: 'GitHub', fields: [{ key: 'k'.repeat(300), value: 'v' }] },
    ])

    expect(secrets[0]?.fields[0]?.key).toHaveLength(MAX_SECRET_KEY_CHARS)
  })

  it('returns nothing for a graph with no credential steps', () => {
    expect(normalizePublishedSecrets([], [publishedSecret()])).toEqual([])
  })
})

describe('filledPasswordFields', () => {
  it('lists only password fields the publisher filled in', () => {
    expect(filledPasswordFields([publishedSecret()])).toEqual([])
    expect(
      filledPasswordFields([
        publishedSecret({
          fields: [
            { key: 'username', value: 'octocat' },
            { key: 'password', value: 'typed', secret: true },
          ],
        }),
      ]),
    ).toEqual([{ key: 'password', value: 'typed', secret: true }])
  })
})

describe('planSecretImport', () => {
  it('creates a deterministic local record for a new credential', () => {
    const plan = planSecretImport('scrape-orders-abcdef', [publishedSecret()], [], NOW)

    const expectedId = marketplaceSecretId('scrape-orders-abcdef', 'gh')
    expect(plan.idMap.get('gh')).toBe(expectedId)
    expect(plan.entries).toEqual([
      {
        id: expectedId,
        label: 'GitHub',
        url: 'https://github.com',
        fields: [
          { key: 'username', value: 'octocat' },
          { key: 'password', value: '', secret: true },
          { key: 'token', value: 'ghp_live' },
        ],
        createdAt: NOW,
        updatedAt: NOW,
        useCount: 0,
      },
    ])
  })

  it('keeps values the user already typed and adds only missing fields', () => {
    const existingEntry = entry({
      id: 'mkt-scrape-orders-abcdef-gh',
      useCount: 12,
      lastUsedAt: 999,
      fields: [
        { key: 'UserName', value: 'me' },
        { key: 'password', value: 'my-real-password', secret: true },
        { key: 'extra', value: 'local-only' },
      ],
    })

    const plan = planSecretImport('scrape-orders-abcdef', [publishedSecret()], [existingEntry], NOW)

    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]?.fields).toEqual([
      { key: 'UserName', value: 'me' },
      { key: 'password', value: 'my-real-password', secret: true },
      { key: 'extra', value: 'local-only' },
      { key: 'token', value: 'ghp_live' },
    ])
    expect(plan.entries[0]?.createdAt).toBe(111)
    expect(plan.entries[0]?.useCount).toBe(12)
    expect(plan.entries[0]?.lastUsedAt).toBe(999)
    expect(plan.entries[0]?.updatedAt).toBe(NOW)
  })

  it('falls back to a generic label and tolerates an empty listing', () => {
    const plan = planSecretImport(
      'slug',
      [{ id: 'mail', label: '  ', fields: [{ key: 'password', value: 'p', secret: true }] }],
      [],
      NOW,
    )

    expect(plan.entries[0]?.label).toBe('Credential')
    expect(plan.entries[0]?.url).toBeUndefined()
    expect(planSecretImport('slug', undefined, [], NOW)).toEqual({ entries: [], idMap: new Map() })
  })

  it('skips records without an id or fields', () => {
    const plan = planSecretImport(
      'slug',
      [
        { id: '', label: 'Broken', fields: [{ key: 'token', value: 'x' }] },
        { id: 'empty', label: 'Empty', fields: [] },
      ],
      [],
      NOW,
    )

    expect(plan.entries).toEqual([])
    expect(plan.idMap.size).toBe(0)
  })
})

describe('rewriteWorkflowSecrets', () => {
  const parent = workflow('parent', [
    secretNode('s1', { credential: 'gh::token', variableName: 'token' }),
    secretNode('s2', {
      credential: 'gh::token',
      variableName: 'token',
      credentials: [
        { credential: 'gh::token', variableName: 'token' },
        { credential: 'mail::password', variableName: 'password' },
      ],
    }),
    { id: 'n3', label: 'Click', position: { x: 0, y: 0 }, data: { blockId: 'click' } },
  ])
  const idMap = new Map([
    ['gh', 'mkt-slug-gh'],
    ['mail', 'mkt-slug-mail'],
  ])

  it('points every row at the imported credential', () => {
    const rewritten = rewriteWorkflowSecrets(parent, idMap)
    const [single, multi] = rewritten.drawflow.nodes

    expect(single?.data?.['values']).toMatchObject({
      credential: 'mkt-slug-gh::token',
      variableName: 'token',
    })
    expect(multi?.data?.['values']).toMatchObject({
      credential: 'mkt-slug-gh::token',
      variableName: 'token',
      credentials: [
        { credential: 'mkt-slug-gh::token', variableName: 'token' },
        { credential: 'mkt-slug-mail::password', variableName: 'password' },
      ],
    })
  })

  it('clears the legacy pair so one fact has one source', () => {
    const legacy = workflow('legacy', [
      {
        id: 's1',
        label: 'Get secret',
        position: { x: 0, y: 0 },
        data: {
          blockId: 'get-secret',
          credential: 'gh::token',
          secretId: 'gh',
          fieldName: 'token',
        },
      },
    ])

    const rewritten = rewriteWorkflowSecrets(legacy, idMap)

    expect(rewritten.drawflow.nodes[0]?.data?.['credential']).toBe('mkt-slug-gh::token')
    expect(rewritten.drawflow.nodes[0]?.data?.['secretId']).toBeUndefined()
    expect(rewritten.drawflow.nodes[0]?.data?.['fieldName']).toBeUndefined()
  })

  it('leaves unrelated nodes and unmapped credentials untouched', () => {
    const rewritten = rewriteWorkflowSecrets(parent, new Map([['gh', 'mkt-slug-gh']]))
    const [, multi, click] = rewritten.drawflow.nodes

    expect(rewritten.drawflow.nodes[2]).toBe(parent.drawflow.nodes[2])
    expect(click).toBe(parent.drawflow.nodes[2])
    expect(multi?.data?.['values']).toMatchObject({
      credentials: [{ credential: 'mkt-slug-gh::token' }, { credential: 'mail::password' }],
    })
  })

  it('returns the same workflow when nothing maps', () => {
    expect(rewriteWorkflowSecrets(parent, new Map())).toBe(parent)
  })
})
