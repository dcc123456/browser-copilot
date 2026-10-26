// @vitest-environment jsdom
/**
 * The publish dialog's gating contract: without a GitHub connection it stops
 * at the connection panel, and the form only exists once a token is stored.
 * Re-editing a published workflow starts from the listing on GitHub.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/sidepanel/i18n'
import PublishWorkflowDialog, { connectFailureText } from '../src/sidepanel/PublishWorkflowDialog'
import { messagesFor, type Locale } from '../src/lib/i18n'
import { MarketplaceError } from '../src/lib/marketplace/types'
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
  options: { workflow?: Workflow; library?: Workflow[] } = {},
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

describe('connect failure text', () => {
  it('keeps the translated reason and appends the client detail', () => {
    const text = connectFailureText(
      messagesFor('en'),
      new MarketplaceError('network', 'GitHub request failed: Failed to fetch'),
    )
    expect(text).toContain('Could not reach GitHub')
    expect(text).toContain('Failed to fetch')
  })

  it('tells an invalid token apart from a network failure', () => {
    const text = connectFailureText(
      messagesFor('zh-CN'),
      new MarketplaceError('unauthorized', 'GitHub rejected the token: Bad credentials', 401),
    )
    expect(text).toContain('判定令牌无效')
    expect(text).toContain('Bad credentials')
  })

  it('falls back to a plain error message', () => {
    expect(connectFailureText(messagesFor('en'), new Error('boom'))).toBe('boom')
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
    expect(container.querySelector('select')?.value).toBe('data')
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
          }),
        ),
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(container.querySelector('select')?.value).toBe('__custom__')
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
          }),
        ),
      )
    })

    const select = container.querySelector('select') as HTMLSelectElement
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
