// @vitest-environment jsdom
/**
 * A published listing shows its attachments as links straight to the raw file,
 * so browsing the marketplace never needs a GitHub connection.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MarketplaceCard } from '../src/lib/marketplace/types'

const cards: MarketplaceCard[] = []

vi.mock('../src/lib/marketplace/catalog', () => ({
  loadCatalog: async () => ({ cards, stale: false, truncated: false }),
  chromeCatalogCache: () => ({}),
}))
vi.mock('../src/lib/messages', () => ({
  sendCommand: async () => ({ type: 'workflows.list', workflows: [] }),
}))
vi.mock('../src/lib/store-events', () => ({ onStoreChanged: () => () => {} }))
vi.mock('../src/lib/marketplace/token', () => ({
  getAuth: async () => null,
  clearAuth: async () => {},
  readAuth: async () => null,
}))
vi.mock('../src/lib/marketplace/team', () => ({
  getTeamRepo: async () => null,
  getTeamAuth: async () => null,
  teamRepoRef: () => null,
}))

const { default: MarketplaceTab } = await import('../src/sidepanel/MarketplaceTab')
const { I18nProvider } = await import('../src/sidepanel/i18n')
const { messagesFor } = await import('../src/lib/i18n')
const { buildMeta } = await import('../src/lib/marketplace/meta')

describe('marketplace card attachments', () => {
  let container: HTMLElement
  let root: Root

  beforeAll(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    cards.length = 0
  })

  it('links each attachment to its raw file with its size', async () => {
    cards.push({
      meta: buildMeta({
        slug: 'scrape-orders-abcdef',
        title: 'Scrape orders',
        description: '',
        category: 'ecommerce',
        author: 'octocat',
        version: 1,
        hash: 'a'.repeat(64),
        attachments: [{ name: '订单模板.csv', path: 'attachments/file.csv', size: 2048 }],
      }),
      prNumber: null,
      likes: 0,
      comments: 0,
    })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'en', t: messagesFor('en') } },
          createElement(MarketplaceTab, { active: true }),
        ),
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(container.textContent).toContain('Attachments')
    expect(container.textContent).toContain('订单模板.csv (2 KB)')
    const link = [...container.querySelectorAll('a')].find((anchor) =>
      anchor.textContent?.includes('订单模板.csv'),
    )
    expect(link?.getAttribute('href')).toBe(
      'https://raw.githubusercontent.com/dcc123456/BC-workflow/main/workflows/scrape-orders-abcdef/attachments/file.csv',
    )
    expect(link?.getAttribute('target')).toBe('_blank')
  })
})
