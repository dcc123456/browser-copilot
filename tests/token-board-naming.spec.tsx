/**
 * Token board naming and deep links.
 *
 * The board's credibility rests on one promise (plan
 * `specs/2026-10-12-token-board-entity-naming-plan.md`): a row tells you *which*
 * task, workflow or conversation the spend was on, and clicking it lands there.
 * Two guarantees are tested here:
 *  - name precedence: live store name → ledger snapshot → localized kind + short
 *    id, so a renamed task, a deleted one and an unnameable one all read well;
 *  - only a row whose id still addresses a live object is a link.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  GroupTable,
  entityRowView,
  type EntityRowTexts,
  type EntityTarget,
} from '../src/sidepanel/TokensTab'
import {
  emptyTally,
  OTHER_ENTITY_KEY,
  type TokenEntityKind,
  type TokenGroupRow,
} from '../src/lib/token-ledger'

/** English-ish stand-ins; the real strings come from the dictionary. */
const KIND_NAMES: Partial<Record<TokenEntityKind, string>> = {
  chat: 'chat',
  task: 'task',
  workflow: 'workflow',
}

const TEXTS: EntityRowTexts = {
  kindName: (kind) => KIND_NAMES[kind] ?? kind,
  unnamed: (kind, id) => `${kind} ${id}`,
  jumpHint: (kind) => `Jump to this ${kind}`,
  otherLabel: 'Other',
  truncatedHint: 'Only the 25 busiest entries are listed',
}

const row = (key: string, label = key): TokenGroupRow => ({
  key,
  label,
  totals: { ...emptyTally(), totalTokens: 100 },
  lastUsedAt: 1,
})

const LIVE: Record<string, EntityTarget> = {
  'task:t-1': { kind: 'task', id: 't-1', name: 'Nightly PR digest' },
  'workflow:wf-1': { kind: 'workflow', id: 'wf-1', name: 'Crawl the shop' },
  'chat:c-1': { kind: 'chat', id: 'c-1', name: 'Debug the login form' },
}

describe('entityRowView — what a spend row is called', () => {
  it('shows the current store name, not the write-time snapshot', () => {
    expect(entityRowView(row('task:t-1', 'Old name'), LIVE, TEXTS).name).toBe('Nightly PR digest')
  })

  it('falls back to the snapshot when the entity is gone', () => {
    const view = entityRowView(row('task:gone', 'Deleted digest'), {}, TEXTS)
    expect(view.name).toBe('Deleted digest')
    expect(view.target).toBeUndefined()
  })

  it('names a row with no label at all by kind plus a short id', () => {
    const view = entityRowView(row('task:9f3c1a2b'), {}, TEXTS)
    expect(view.name).toBe('task …3c1a2b')
    expect(view.target).toBeUndefined()
  })

  it('borrows the consumer caption for a kind the panel cannot open', () => {
    expect(
      entityRowView(
        row('external:k-1'),
        {},
        {
          ...TEXTS,
          kindName: (kind) => (kind === 'external' ? 'External API' : String(kind)),
        },
      ).name,
    ).toBe('External API k-1')
  })

  it('links only a row whose id still resolves, and hints the jump', () => {
    const linked = entityRowView(row('workflow:wf-1', 'Crawl the shop'), LIVE, TEXTS)
    expect(linked.target).toEqual({ kind: 'workflow', id: 'wf-1', name: 'Crawl the shop' })
    expect(linked.hint).toBe('Jump to this workflow')
    expect(entityRowView(row('workflow:deleted'), {}, TEXTS).hint).toBe('workflow:deleted')
  })

  it('keeps the folded tail row a plain caption', () => {
    const other = entityRowView(row(OTHER_ENTITY_KEY, OTHER_ENTITY_KEY), LIVE, TEXTS)
    expect(other).toEqual({ name: 'Other', hint: 'Only the 25 busiest entries are listed' })
  })
})

describe('GroupTable entity rows', () => {
  const headers = { name: 'Name', input: 'In', output: 'Out', requests: 'Req', total: 'Total' }
  const table = (rows: TokenGroupRow[]): string =>
    renderToStaticMarkup(
      createElement(GroupTable, {
        title: 'By chat, task and workflow',
        rows,
        locale: 'en',
        headers,
        emptyLabel: 'None',
        entityView: (entry) => entityRowView(entry, LIVE, TEXTS),
        windowTotal: 200,
      }),
    )

  it('renders a live entity as a button whose tooltip carries the full name', () => {
    const html = table([row('task:t-1', 'Old name')])
    expect(html).toContain('<button')
    expect(html).toContain('Nightly PR digest')
    expect(html).toContain('title="Nightly PR digest"')
  })

  it('renders an unresolvable entity as plain text with its display name as tooltip', () => {
    const html = table([row('session:s-1')])
    expect(html).not.toContain('<button')
    expect(html).toContain('title="session s-1"')
  })
})
