// @vitest-environment jsdom
/**
 * The publish dialog's gating contract: without a GitHub connection it stops
 * at the connection panel, and the form only exists once a token is stored.
 * Re-editing a published workflow starts from the listing on GitHub.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/sidepanel/i18n'
import PublishWorkflowDialog from '../src/sidepanel/PublishWorkflowDialog'
import { messagesFor, type Locale } from '../src/lib/i18n'
import type { TeamConnection, TeamRepoConfig } from '../src/lib/marketplace/team'
import type { Workflow } from '../src/lib/workflow/types'

function makeWorkflow(): Workflow {
  return {
    id: 'local-1',
    name: 'Scrape orders',
    description: 'Open the orders page and copy every row.',
    createdAt: 1,
    updatedAt: 2,
    trigger: { type: 'manual' },
    settings: { saveLog: true, debugMode: true, notification: true, reuseLastState: true },
    drawflow: { nodes: [], edges: [] },
  }
}

function callNode(id: string, workflowId: string): Workflow['drawflow']['nodes'][number] {
  return {
    id,
    label: 'Execute workflow',
    position: { x: 0, y: 0 },
    data: { blockId: 'execute-workflow', values: { workflowId } },
  }
}

function render(
  initialAuth: { token: string; login: string } | null,
  locale: Locale = 'en',
  options: {
    workflow?: Workflow
    library?: Workflow[]
    teams?: TeamConnection[] | null
  } = {},
): string {
  const workflow = options.workflow ?? makeWorkflow()
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { value: { locale, t: messagesFor(locale) } },
      createElement(PublishWorkflowDialog, {
        workflow,
        library: options.library ?? [workflow],
        onClose: () => {},
        initialAuth,
        initialTeams: options.teams ?? null,
      }),
    ),
  )
}

describe('publish dialog', () => {
  it('stops at the connection panel without a token', () => {
    const markup = render(null)
    expect(markup).toContain('GitHub connection')
    expect(markup).toContain('Create a token on GitHub')
    expect(markup).not.toContain('shop, orders, export')
    expect(markup).toContain('disabled')
  })

  it('shows the form once connected, prefilled from the workflow', () => {
    const markup = render({ token: `ghp_${'a'.repeat(30)}`, login: 'octocat' })
    expect(markup).toContain('Connected as @octocat')
    expect(markup).not.toContain('Create a token on GitHub')
    expect(markup).toContain('value="Scrape orders"')
    expect(markup).toContain('Open the orders page and copy every row.')
    expect(markup).toContain('E-commerce')
  })

  it('offers finer categories plus a custom one', () => {
    const markup = render({ token: `ghp_${'a'.repeat(30)}`, login: 'octocat' })
    expect(markup).toContain('Orders &amp; fulfillment')
    expect(markup).toContain('Reports &amp; dashboards')
    expect(markup).toContain('Custom…')
  })

  it('is translated on the Chinese panel', () => {
    const markup = render(null, 'zh-CN')
    expect(markup).toContain('GitHub 连接')
    expect(markup).toContain('去 GitHub 创建令牌')
  })

  it('translates the attachment field on the Chinese panel', () => {
    const markup = render({ token: `ghp_${'a'.repeat(30)}`, login: 'octocat' }, 'zh-CN')
    expect(markup).toContain('附件')
    expect(markup).toContain('添加文件')
  })

  it('offers an attachment field with its limits', () => {
    const markup = render({ token: `ghp_${'a'.repeat(30)}`, login: 'octocat' })
    expect(markup).toContain('Attachments')
    expect(markup).toContain('Up to 3 files, 200 KB each')
    expect(markup).toContain('Add files')
  })

  it('names the workflows that will be published alongside this one', () => {
    const workflow = makeWorkflow()
    workflow.drawflow.nodes = [callNode('n1', 'local-2')]
    const dependency = { ...makeWorkflow(), id: 'local-2', name: 'Export orders' }

    const markup = render({ token: `ghp_${'a'.repeat(30)}`, login: 'octocat' }, 'en', {
      workflow,
      library: [workflow, dependency],
    })

    expect(markup).toContain('Called workflows')
    expect(markup).toContain('Export orders')
    expect(markup).toContain('This workflow calls 1 other workflow')
  })

  it('blocks publishing when a called workflow no longer exists locally', () => {
    const workflow = makeWorkflow()
    workflow.drawflow.nodes = [callNode('n1', 'deleted-1')]

    const markup = render({ token: `ghp_${'a'.repeat(30)}`, login: 'octocat' }, 'en', {
      workflow,
      library: [workflow],
    })

    expect(markup).toContain('cannot be bundled')
    expect(markup).toContain('deleted-1')
  })
})

describe('prefilling a published workflow', () => {
  let container: HTMLElement
  let root: Root
  const originalFetch = globalThis.fetch
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeAll(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  it('loads the listing copy and its screenshots for a re-publish', async () => {
    const workflow = makeWorkflow()
    workflow.marketplace = {
      repo: 'dcc123456/BC-workflow',
      slug: 'scrape-orders-abcdef',
      version: 2,
      hash: 'a'.repeat(64),
      author: 'octocat',
      appliedAt: 1,
    }
    const meta = {
      schema: 1,
      slug: 'scrape-orders-abcdef',
      title: 'Orders, archived',
      description: 'Previous copy',
      category: 'data',
      tags: ['shop', 'export'],
      author: 'octocat',
      version: 2,
      hash: 'a'.repeat(64),
      images: ['assets/1.webp'],
      attachments: [{ name: 'orders.csv', path: 'attachments/orders.csv', size: 2048 }],
      videoUrl: 'https://example.com/v',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/meta.json')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(meta) }
      }
      if (url.endsWith('/assets/1.webp')) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }),
        }
      }
      if (url.endsWith('/attachments/orders.csv')) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([new Uint8Array(2048)], { type: 'text/csv' }),
        }
      }
      return { ok: false, status: 404, text: async () => '' }
    }) as unknown as typeof fetch
    URL.createObjectURL = () => 'blob:restored'
    URL.revokeObjectURL = () => {}

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'en', t: messagesFor('en') } },
          createElement(PublishWorkflowDialog, {
            workflow,
            library: [workflow],
            onClose: () => {},
            initialAuth: { token: `ghp_${'a'.repeat(30)}`, login: 'octocat' },
            initialTeams: null,
          }),
        ),
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[]
    expect(inputs.find((input) => input.value === 'Orders, archived')).toBeDefined()
    expect(inputs.find((input) => input.value === 'shop, export')).toBeDefined()
    expect(inputs.find((input) => input.value === 'https://example.com/v')).toBeDefined()
    expect(container.querySelector('textarea')?.value).toBe('Previous copy')
    expect(
      (container.querySelector('select[aria-label="Category"]') as HTMLSelectElement | null)?.value,
    ).toBe('data')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:restored')
    expect(container.textContent).toContain('orders.csv')
    expect(container.textContent).toContain('2 KB')
  })

  it('keeps a keystroke that lands before the published listing arrives', async () => {
    const workflow = makeWorkflow()
    workflow.marketplace = {
      repo: 'dcc123456/BC-workflow',
      slug: 'scrape-orders-abcdef',
      version: 2,
      hash: 'a'.repeat(64),
      author: 'octocat',
      appliedAt: 1,
    }
    const gateControl: { release?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      gateControl.release = resolve
    })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/meta.json')) {
        await gate
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              schema: 1,
              slug: 'scrape-orders-abcdef',
              title: 'Orders, archived',
              description: 'Previous copy',
              category: 'data',
              tags: [],
              author: 'octocat',
              version: 2,
              hash: 'a'.repeat(64),
              images: [],
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-02T00:00:00.000Z',
            }),
        }
      }
      return { ok: false, status: 404, text: async () => '' }
    }) as unknown as typeof fetch

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'en', t: messagesFor('en') } },
          createElement(PublishWorkflowDialog, {
            workflow,
            library: [workflow],
            onClose: () => {},
            initialAuth: { token: `ghp_${'a'.repeat(30)}`, login: 'octocat' },
            initialTeams: null,
          }),
        ),
      )
    })

    const titleInput = [...container.querySelectorAll('input')].find(
      (input) => (input as HTMLInputElement).value === 'Scrape orders',
    ) as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(titleInput, 'My own title')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    gateControl.release?.()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect((titleInput as HTMLInputElement).value).toBe('My own title')
  })

  it('restores a custom published category into the free-form input', async () => {
    const workflow = makeWorkflow()
    workflow.marketplace = {
      repo: 'dcc123456/BC-workflow',
      slug: 'scrape-orders-abcdef',
      version: 1,
      hash: 'a'.repeat(64),
      author: 'octocat',
      appliedAt: 1,
    }
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            schema: 1,
            slug: 'scrape-orders-abcdef',
            title: 'Scrape orders',
            description: 'Previous copy',
            category: '行业调研',
            tags: [],
            author: 'octocat',
            version: 1,
            hash: 'a'.repeat(64),
            images: [],
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
          }),
      }) as unknown as Response) as unknown as typeof fetch

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'en', t: messagesFor('en') } },
          createElement(PublishWorkflowDialog, {
            workflow,
            library: [workflow],
            onClose: () => {},
            initialAuth: { token: `ghp_${'a'.repeat(30)}`, login: 'octocat' },
            initialTeams: null,
          }),
        ),
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(
      (container.querySelector('select[aria-label="Category"]') as HTMLSelectElement | null)?.value,
    ).toBe('__custom__')
    const custom = [...container.querySelectorAll('input')].find(
      (input) => (input as HTMLInputElement).value === '行业调研',
    ) as HTMLInputElement
    expect(custom).toBeDefined()
  })

  it('accepts a small attachment and rejects an oversized one without any request', async () => {
    const fetchCalls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input))
      return { ok: false, status: 404, text: async () => '' }
    }) as unknown as typeof fetch
    URL.createObjectURL = () => 'blob:attachment'
    URL.revokeObjectURL = () => {}

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'en', t: messagesFor('en') } },
          createElement(PublishWorkflowDialog, {
            workflow: makeWorkflow(),
            library: [makeWorkflow()],
            onClose: () => {},
            initialAuth: { token: `ghp_${'a'.repeat(30)}`, login: 'octocat' },
            initialTeams: null,
          }),
        ),
      )
    })

    const fileInput = [...container.querySelectorAll('input[type="file"]')].at(
      -1,
    ) as HTMLInputElement
    const big = new File([new Uint8Array(200 * 1024 + 1)], 'big.csv', { type: 'text/csv' })
    Object.defineProperty(fileInput, 'files', { value: [big], configurable: true })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('Each attachment must be 200 KB or smaller.')
    expect(container.textContent).not.toContain('big.csv')

    const small = new File([new Uint8Array(2048)], 'orders.csv', { type: 'text/csv' })
    Object.defineProperty(fileInput, 'files', { value: [small], configurable: true })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('orders.csv')
    expect(container.textContent).toContain('2 KB')
    expect(fetchCalls).toEqual([])
  })

  it('refuses to publish a custom category with no name', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'en', t: messagesFor('en') } },
          createElement(PublishWorkflowDialog, {
            workflow: makeWorkflow(),
            library: [makeWorkflow()],
            onClose: () => {},
            initialAuth: { token: `ghp_${'a'.repeat(30)}`, login: 'octocat' },
            initialTeams: null,
          }),
        ),
      )
    })

    const select = container.querySelector('select[aria-label="Category"]') as HTMLSelectElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, '__custom__')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(
      [...container.querySelectorAll('input')].some(
        (input) => (input as HTMLInputElement).placeholder === 'Name it, e.g. Industry research',
      ),
    ).toBe(true)

    const publish = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Publish',
    ) as HTMLButtonElement
    await act(async () => publish.click())
    expect(container.textContent).toContain('Choose a category, or name your own.')
  })
})

describe('publish target', () => {
  function teamWorkflow(): Workflow {
    const workflow = makeWorkflow()
    workflow.marketplace = {
      repo: 'acme/workflows',
      slug: 'scrape-orders-abcdef',
      version: 1,
      hash: 'a'.repeat(64),
      author: 'writer',
      appliedAt: 1,
    }
    return workflow
  }

  const CONFIG: TeamRepoConfig = {
    owner: 'acme',
    repo: 'workflows',
    branch: 'main',
    canPush: true,
    isPublic: false,
  }
  const TEAM_AUTH = { token: `ghp_${'a'.repeat(30)}`, login: 'writer' }

  it('opens on the team target for a workflow last published there', () => {
    const markup = render(null, 'en', {
      workflow: teamWorkflow(),
      teams: [{ config: CONFIG, auth: TEAM_AUTH }],
    })

    expect(markup).toContain('Publishing to acme/workflows as @writer.')
    expect(markup).toContain('Public marketplace')
    expect(markup).toContain('Team repository')
    // The team token lives in Settings, so no token field is offered here.
    expect(markup).not.toContain('Create a token on GitHub')
    expect(markup).toContain('>Publish</button>')
  })

  it('offers every connected team as a target, opening on the last one used', () => {
    const markup = render(null, 'en', {
      workflow: teamWorkflow(),
      teams: [
        { config: CONFIG, auth: TEAM_AUTH },
        {
          config: { ...CONFIG, owner: 'beta', repo: 'automations', branch: 'trunk' },
          auth: { token: `ghp_${'c'.repeat(30)}`, login: 'writer' },
        },
      ],
    })

    expect(markup).toContain('<option value="public">Public marketplace</option>')
    expect(markup).toContain(
      '<option value="acme/workflows" selected="">Team repository · acme/workflows</option>',
    )
    expect(markup).toContain(
      '<option value="beta/automations">Team repository · beta/automations</option>',
    )
  })

  it('stops when no team repository is connected', () => {
    const markup = render(null, 'en', { workflow: teamWorkflow(), teams: null })

    expect(markup).toContain('No team repository is connected.')
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Publish<\/button>/)
  })

  it('blocks a read-only team member from publishing', () => {
    const markup = render(null, 'en', {
      workflow: teamWorkflow(),
      teams: [{ config: { ...CONFIG, canPush: false }, auth: TEAM_AUTH }],
    })

    expect(markup).toContain('publishing needs write access')
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Publish<\/button>/)
  })
})

describe('publish drafts', () => {
  let container: HTMLElement
  let root: Root
  let store: Map<string, unknown>
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) store.set(key, value)
          }),
          remove: vi.fn(async (key: string | string[]) => {
            for (const entry of Array.isArray(key) ? key : [key]) store.delete(entry)
          }),
        },
      },
    })
    // The published-listing prefill must not reach the network in these tests.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    URL.createObjectURL = () => 'blob:draft'
    URL.revokeObjectURL = () => {}
  })

  afterEach(() => {
    act(() => root?.unmount())
    vi.unstubAllGlobals()
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  function seedDraft(): void {
    store.set('marketplaceDrafts', {
      'local-1': {
        schema: 1,
        workflowId: 'local-1',
        title: 'Draft title',
        description: 'Draft body',
        category: 'data',
        customCategory: '',
        tags: 'shop, export',
        videoUrl: '',
        images: [],
        attachments: [],
        savedAt: Date.now(),
      },
    })
  }

  const TEAM_CONFIG: TeamRepoConfig = {
    owner: 'acme',
    repo: 'workflows',
    branch: 'main',
    canPush: true,
    isPublic: false,
  }
  const TEAM_AUTH = { token: `ghp_${'b'.repeat(30)}`, login: 'writer' }

  function teamWorkflow(): Workflow {
    const workflow = makeWorkflow()
    workflow.marketplace = {
      repo: 'acme/workflows',
      slug: 'scrape-orders-abcdef',
      version: 1,
      hash: 'a'.repeat(64),
      author: 'writer',
      appliedAt: 1,
    }
    return workflow
  }

  function seedTwoTargets(): void {
    const savedAt = Date.now()
    store.set('marketplaceDrafts', {
      'local-1': {
        schema: 1,
        workflowId: 'local-1',
        title: 'Public draft',
        description: '',
        category: 'other',
        customCategory: '',
        tags: '',
        videoUrl: '',
        images: [],
        attachments: [],
        savedAt,
      },
      'local-1@acme/workflows': {
        schema: 1,
        workflowId: 'local-1@acme/workflows',
        title: 'Team draft',
        description: '',
        category: 'other',
        customCategory: '',
        tags: '',
        videoUrl: '',
        images: [],
        attachments: [],
        savedAt,
      },
    })
  }

  function mount(
    options: {
      workflow?: Workflow
      teams?: TeamConnection[] | null
    } = {},
  ): void {
    const workflow = options.workflow ?? makeWorkflow()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { value: { locale: 'en', t: messagesFor('en') } },
          createElement(PublishWorkflowDialog, {
            workflow,
            library: [workflow],
            onClose: () => {},
            initialAuth: { token: `ghp_${'a'.repeat(30)}`, login: 'octocat' },
            initialTeams: options.teams === undefined ? null : options.teams,
          }),
        ),
      )
    })
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }

  async function chooseTarget(value: 'public' | `${string}/${string}`): Promise<void> {
    const select = container.querySelector(
      'select[aria-label="Publish to"]',
    ) as HTMLSelectElement | null
    if (!select) throw new Error('publish target select missing')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
  }

  function titleInput(): HTMLInputElement {
    return [...container.querySelectorAll('input')].find(
      (input) => (input as HTMLInputElement).value === 'Scrape orders',
    ) as HTMLInputElement
  }

  function anyTitleInput(): HTMLInputElement | undefined {
    return [...container.querySelectorAll('input')].find((input) =>
      [
        'Scrape orders',
        'Public draft',
        'Team draft',
        'Half-written title',
        'Public half-written',
      ].includes(input.value),
    ) as HTMLInputElement | undefined
  }

  async function typeTitle(value: string): Promise<void> {
    const input = anyTitleInput()
    if (!input) throw new Error('title input missing')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('restores the saved draft when the same workflow reopens', async () => {
    seedDraft()
    mount()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(
      [...container.querySelectorAll('input')].some((input) => input.value === 'Draft title'),
    ).toBe(true)
    expect(container.querySelector('textarea')?.value).toBe('Draft body')
    expect(
      (container.querySelector('select[aria-label="Category"]') as HTMLSelectElement | null)?.value,
    ).toBe('data')
    expect(container.textContent).toContain('Draft restored from your last edit.')
  })

  it('saves an edited form when the dialog closes', async () => {
    mount()
    const title = titleInput()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(title, 'Half-written title')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      root.unmount()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    const drafts = store.get('marketplaceDrafts') as Record<string, { title: string }>
    expect(drafts['local-1']?.title).toBe('Half-written title')
  })

  it('writes nothing when the form was never touched', async () => {
    mount()
    await act(async () => {
      root.unmount()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(store.has('marketplaceDrafts')).toBe(false)
  })

  it('discards the draft and restores the workflow copy', async () => {
    seedDraft()
    mount()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    const discard = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Discard draft',
    ) as HTMLButtonElement
    await act(async () => discard.click())

    expect(store.has('marketplaceDrafts')).toBe(false)
    expect(titleInput()?.value).toBe('Scrape orders')
    expect(container.textContent).not.toContain('Draft restored from your last edit.')
  })

  it('restores each target from its own draft', async () => {
    seedTwoTargets()
    mount({
      workflow: teamWorkflow(),
      teams: [{ config: TEAM_CONFIG, auth: TEAM_AUTH }],
    })
    await settle()

    // Published to the team repo, so the dialog opens on the team target.
    expect(anyTitleInput()?.value).toBe('Team draft')

    await chooseTarget('public')

    // The public draft is a different form; the team one is not reused.
    expect(anyTitleInput()?.value).toBe('Public draft')
  })

  it('saves a team-target draft under its own key', async () => {
    mount({ workflow: teamWorkflow(), teams: [{ config: TEAM_CONFIG, auth: TEAM_AUTH }] })
    await settle()
    await typeTitle('Half-written title')

    await act(async () => {
      root.unmount()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    const drafts = store.get('marketplaceDrafts') as Record<string, { title: string }>
    expect(drafts['local-1@acme/workflows']?.title).toBe('Half-written title')
    expect(drafts['local-1']).toBeUndefined()
  })

  it('keeps the outgoing target’s draft when switching', async () => {
    mount({ teams: [{ config: TEAM_CONFIG, auth: TEAM_AUTH }] })
    await typeTitle('Half-written title')

    await chooseTarget('acme/workflows')

    const drafts = store.get('marketplaceDrafts') as Record<string, { title: string }>
    expect(drafts['local-1']?.title).toBe('Half-written title')
    // Nothing was typed on the team form, so it stores nothing.
    expect(drafts['local-1@acme/workflows']).toBeUndefined()
  })
})
