// @vitest-environment jsdom
/**
 * A marketplace card names its actions with icons: like and comments sit side
 * by side in the action row (the like control is NOT part of the discussion
 * panel), and the GitHub link is an icon beside the title.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MarketplaceCard } from '../src/lib/marketplace/types'
import type { Workflow } from '../src/lib/workflow/types'

const cards: MarketplaceCard[] = []
/** Local library the panel reads; empty unless a test installs something. */
const installed: Workflow[] = []
const mocked = vi.hoisted(() => ({
  auth: null as { token: string; login: string } | null,
  /** Issue numbers this device already reacted to. */
  likedIssues: new Set<number>(),
}))

vi.mock('../src/lib/marketplace/catalog', () => ({
  loadCatalog: async () => ({ cards, stale: false, truncated: false }),
  chromeCatalogCache: () => ({}),
}))
vi.mock('../src/lib/messages', () => ({
  sendCommand: async () => ({ type: 'workflows.list', workflows: installed }),
}))
vi.mock('../src/lib/store-events', () => ({ onStoreChanged: () => () => {} }))
vi.mock('../src/lib/marketplace/token', () => ({
  getAuth: async () => mocked.auth,
  clearAuth: async () => {},
  readAuth: async () => null,
}))
vi.mock('../src/lib/marketplace/team', () => ({
  getTeamRepo: async () => null,
  getTeamAuth: async () => null,
  teamRepoRef: () => null,
}))
vi.mock('../src/lib/marketplace/engagement', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/marketplace/engagement')>()
  return {
    ...original,
    chromeReactionCache: () => ({
      get: async (issueNumber: number) => (mocked.likedIssues.has(issueNumber) ? 900 : null),
      set: async () => {},
      clear: async () => {},
    }),
    listAllComments: async () => [],
  }
})

const { default: MarketplaceTab } = await import('../src/sidepanel/MarketplaceTab')
const { I18nProvider } = await import('../src/sidepanel/i18n')
const { messagesFor } = await import('../src/lib/i18n')
const { buildMeta } = await import('../src/lib/marketplace/meta')

const zh = messagesFor('zh-CN')

/**
 * Two cards built milliseconds apart could sort either way, so the timestamp
 * is explicit: the list is newest-first and the first test asserts on order.
 */
function card(
  slug: string,
  title: string,
  prNumber: number,
  likes: number,
  comments: number,
  updatedAt = Date.now(),
) {
  return {
    meta: buildMeta({
      slug,
      title,
      description: '',
      category: 'ecommerce',
      tags: [],
      author: 'octocat',
      version: 1,
      hash: 'a'.repeat(64),
      now: new Date(updatedAt),
    }),
    prNumber,
    likes,
    comments,
  } satisfies MarketplaceCard
}

describe('marketplace card actions', () => {
  let container: HTMLElement
  let root: Root

  beforeAll(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    cards.length = 0
    installed.length = 0
    mocked.auth = null
    mocked.likedIssues.clear()
  })

  async function render(): Promise<void> {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'zh-CN', t: zh } },
          createElement(MarketplaceTab, { active: true }),
        ),
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  it('puts the GitHub link beside the title and both icon actions in the row', async () => {
    mocked.likedIssues.add(6)
    cards.push(
      card('scrape-orders-abcdef', 'Scrape orders', 6, 2, 3, 2_000),
      card('sync-stock-fedcba', 'Sync stock', 7, 0, 0, 1_000),
    )
    await render()

    const list = [...container.querySelectorAll<HTMLElement>('li.task-item')]
    const first = list[0]!
    const second = list[1]!
    const githubLink = first.querySelector<HTMLAnchorElement>('.task-item-lead a')
    expect(githubLink?.getAttribute('aria-label')).toBe(zh.marketplaceViewOnGithub)
    expect(githubLink?.getAttribute('href')).toBe(
      'https://github.com/dcc123456/BC-workflow/tree/main/workflows/scrape-orders-abcdef',
    )
    expect(githubLink?.textContent).toBe('')
    expect(githubLink?.querySelector('svg')).not.toBeNull()

    const actions = first.querySelector<HTMLElement>('.task-actions')
    expect(actions?.textContent).not.toContain(zh.marketplaceViewOnGithub)

    const like = actions?.querySelector<HTMLButtonElement>('button[aria-pressed]')
    expect(like?.getAttribute('aria-label')).toBe(zh.marketplaceUnlikeAction)
    expect(like?.getAttribute('aria-pressed')).toBe('true')
    expect(like?.textContent).toBe('2')
    expect(like?.querySelector('svg')).not.toBeNull()
    expect(like?.className).toContain('bg-accent-soft!')

    const comments = first.querySelector<HTMLButtonElement>('.task-actions button[aria-expanded]')
    expect(comments?.getAttribute('aria-label')).toBe(zh.marketplaceCommentsTitle)
    expect(comments?.textContent).toBe('3')
    expect(comments?.querySelector('svg')).not.toBeNull()
    expect(comments?.previousElementSibling).toBe(like)

    const unlikedLike = second.querySelector<HTMLButtonElement>(
      '.task-actions button[aria-pressed]',
    )
    expect(unlikedLike?.getAttribute('aria-label')).toBe(zh.marketplaceLikeAction)
    expect(unlikedLike?.getAttribute('aria-pressed')).toBe('false')
    expect(unlikedLike?.textContent).toBe('0')
    expect(unlikedLike?.className).not.toContain('bg-accent-soft!')
  })

  it('keeps the like control out of the discussion panel', async () => {
    cards.push(card('scrape-orders-abcdef', 'Scrape orders', 6, 2, 3))
    await render()

    const first = container.querySelector<HTMLElement>('li.task-item')
    await act(async () => {
      first?.querySelector<HTMLButtonElement>('.task-actions button[aria-expanded]')?.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    const section = first?.querySelector<HTMLElement>('section')
    expect(section).not.toBeNull()
    expect(section?.querySelector('button[aria-pressed]')).toBeNull()
    expect(section?.textContent).not.toContain(zh.marketplaceLikeAction)
    // Without a credential the panel points at the PR page for commenting.
    const engage = section?.querySelector<HTMLAnchorElement>('a')
    expect(engage?.getAttribute('href')).toBe('https://github.com/dcc123456/BC-workflow/pull/6')
    // The like icon stays where it belongs.
    expect(first?.querySelector('.task-actions button[aria-pressed]')).not.toBeNull()
  })

  it('labels the owner action as unpublishing', async () => {
    mocked.auth = { token: `ghp_${'a'.repeat(36)}`, login: 'octocat' }
    cards.push(card('scrape-orders-abcdef', 'Scrape orders', 6, 2, 3))
    await render()

    const actions = container.querySelector<HTMLElement>('.task-actions')
    expect(actions?.textContent).toContain(zh.marketplaceUnpublish)
    expect(zh.marketplaceUnpublish).toBe('下架')
  })

  it('offers an installed-but-stale copy as an update, not an apply', async () => {
    cards.push({
      meta: buildMeta({
        slug: 'scrape-orders-abcdef',
        title: 'Scrape orders',
        description: '',
        category: 'ecommerce',
        tags: [],
        author: 'octocat',
        version: 2,
        hash: 'b'.repeat(64),
      }),
      prNumber: null,
      likes: 0,
      comments: 0,
    })
    installed.push({
      id: 'local-1',
      name: 'Scrape orders',
      createdAt: 1,
      updatedAt: 1,
      drawflow: { nodes: [], edges: [] },
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      marketplace: {
        repo: 'dcc123456/BC-workflow',
        slug: 'scrape-orders-abcdef',
        version: 1,
        hash: 'a'.repeat(64),
        author: 'octocat',
        appliedAt: 1,
      },
    })
    await render()

    // The chip names the state, the action names the click.
    expect(container.textContent).toContain(zh.marketplaceUpdate)
    expect(zh.marketplaceUpdate).toBe('可更新')
    const action = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === zh.marketplaceUpdateAction,
    )
    expect(action).toBeDefined()
    expect(action?.disabled).toBe(false)
    expect(zh.marketplaceUpdateAction).toBe('更新')
  })
})
