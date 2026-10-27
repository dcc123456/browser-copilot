// @vitest-environment jsdom
/**
 * On a marketplace card the category is a filled accent pill and each tag is a
 * bordered `#` pill, so the two never read as the same kind of label.
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

describe('marketplace card chips', () => {
  let container: HTMLElement
  let root: Root

  beforeAll(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    cards.length = 0
  })

  it('renders the category as a filled accent pill and tags as bordered pills', async () => {
    cards.push({
      meta: buildMeta({
        slug: 'scrape-orders-abcdef',
        title: 'Scrape orders',
        description: '',
        category: 'ecommerce',
        tags: ['orders', 'stock'],
        author: 'octocat',
        version: 1,
        hash: 'a'.repeat(64),
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

    const card = container.querySelector('li.task-item')
    const category = card?.querySelector('[data-chip="category"]')
    expect(category?.textContent).toBe('E-commerce')
    expect(category?.className).toContain('bg-accent-soft!')
    expect(category?.className).toContain('text-accent!')

    const tags = [...(card?.querySelectorAll('[data-chip="tag"]') ?? [])]
    expect(tags.map((tag) => tag.textContent)).toEqual(['#orders', '#stock'])
    for (const tag of tags) {
      expect(tag.className).toContain('border-border')
      expect(tag.className).toContain('bg-transparent!')
      expect(tag.className).not.toContain('bg-accent-soft!')
    }
  })
})
