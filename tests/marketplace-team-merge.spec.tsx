// @vitest-environment jsdom
/**
 * The team view with several repositories connected: every team's catalog is
 * merged into one list, each card remembers where it came from, the filter
 * narrows the list to one repository, and one unreadable repository degrades
 * to a banner instead of emptying the view.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MarketplaceCard } from '../src/lib/marketplace/types'
import type { TeamConnection } from '../src/lib/marketplace/team'

const state = vi.hoisted(() => ({
  teamConnections: [] as TeamConnection[],
  /** Owner whose catalog read throws, to exercise the partial-failure path. */
  failOwner: null as string | null,
}))

vi.mock('../src/lib/marketplace/catalog', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/marketplace/catalog')>()
  const { buildMeta } = await import('../src/lib/marketplace/meta')
  const card = (owner: string, slug: string, title: string): MarketplaceCard => ({
    meta: buildMeta({
      slug,
      title,
      description: '',
      category: 'ecommerce',
      tags: [],
      author: owner,
      version: 1,
      hash: 'a'.repeat(64),
      now: new Date('2026-10-20T00:00:00.000Z'),
    }),
    prNumber: null,
    likes: 0,
    comments: 0,
  })
  return {
    ...original,
    chromeCatalogCache: () => ({}),
    loadCatalog: async ({ repo }: { repo?: { owner: string } }) => {
      const owner = repo?.owner ?? 'public'
      if (owner === state.failOwner) throw new Error('offline')
      return {
        fetchedAt: Date.now(),
        cards:
          owner === 'acme'
            ? [card('acme', 'acme-orders-111', 'Acme orders')]
            : [card('beta', 'beta-report-222', 'Beta report')],
        truncated: false,
        fromCache: false,
        stale: false,
      }
    },
  }
})
vi.mock('../src/lib/messages', () => ({
  sendCommand: async () => ({ type: 'workflows.list', workflows: [] }),
}))
vi.mock('../src/lib/store-events', () => ({ onStoreChanged: () => () => {} }))
vi.mock('../src/lib/marketplace/token', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/marketplace/token')>()
  return { ...original, getAuth: async () => null, clearAuth: async () => {} }
})
vi.mock('../src/lib/marketplace/team', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/marketplace/team')>()
  return { ...original, getTeamConnections: async () => state.teamConnections }
})

const { default: MarketplaceTab } = await import('../src/sidepanel/MarketplaceTab')
const { I18nProvider } = await import('../src/sidepanel/i18n')
const { messagesFor } = await import('../src/lib/i18n')

const TOKEN = `ghp_${'a'.repeat(36)}`

function connection(owner: string, repo: string): TeamConnection {
  return {
    config: { owner, repo, branch: 'main', canPush: true, isPublic: false },
    auth: { token: TOKEN, login: owner },
  }
}

describe('marketplace team merge', () => {
  let container: HTMLElement
  let root: Root

  beforeAll(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    state.failOwner = null
  })

  async function mount(): Promise<void> {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'en', t: messagesFor('en') } },
          createElement(MarketplaceTab, {
            active: true,
            initial: { source: 'team', teamConnections: state.teamConnections },
          }),
        ),
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  it('lists the workflows of every connected team', async () => {
    state.teamConnections = [connection('acme', 'workflows'), connection('beta', 'automations')]
    await mount()

    expect(container.textContent).toContain('Acme orders')
    expect(container.textContent).toContain('Beta report')
  })

  it('narrows the merged list to one repository', async () => {
    state.teamConnections = [connection('acme', 'workflows'), connection('beta', 'automations')]
    await mount()

    const filter = container.querySelector(
      'select[aria-label="Team repository"]',
    ) as HTMLSelectElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(filter, 'beta/automations')
      filter.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.textContent).toContain('Beta report')
    expect(container.textContent).not.toContain('Acme orders')
  })

  it('keeps the readable teams and names the one that failed', async () => {
    state.teamConnections = [connection('acme', 'workflows'), connection('beta', 'automations')]
    state.failOwner = 'acme'
    await mount()

    expect(container.textContent).toContain('Beta report')
    expect(container.textContent).toContain('acme/workflows')
  })
})
