// @vitest-environment jsdom
/**
 * The feedback dialog's contract: a GitHub token gates submission, the
 * diagnostics checkbox defaults on, and one click creates exactly one issue.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { messagesFor, type Locale } from '../src/lib/i18n'
import type { FeedbackDiagnostics } from '../src/lib/feedback/issue'
import type { MarketplaceAuth } from '../src/lib/marketplace/types'
import { I18nProvider } from '../src/sidepanel/i18n'
import FeedbackDialog from '../src/sidepanel/FeedbackDialog'

const AUTH: MarketplaceAuth = { token: `ghp_${'a'.repeat(30)}`, login: 'octocat' }
const DIAGNOSTICS: FeedbackDiagnostics = {
  version: '0.6.16',
  build: 'abc123',
  userAgent: 'TestAgent/1.0',
  locale: 'en',
}

interface Call {
  url: string
  init?: RequestInit
}

interface JsonResponseInit {
  status?: number
  headers?: Record<string, string>
}

function jsonResponse(body: unknown, init: JsonResponseInit = {}): Response {
  const status = init.status ?? 200
  const headers = init.headers ?? {}
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response
}

let container: HTMLElement
let root: Root | undefined
let calls: Call[]
let removedKeys: string[]

function setFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return handler(String(input), init)
  }) as unknown as typeof fetch
}

function render(auth: MarketplaceAuth | null, locale: Locale = 'en'): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      createElement(
        I18nProvider,
        { value: { locale, t: messagesFor(locale) } },
        createElement(FeedbackDialog, {
          onClose: () => {},
          initialAuth: auth,
          initialDiagnostics: { ...DIAGNOSTICS, locale },
        }),
      ),
    )
  })
}

function typeText(value: string): void {
  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('textarea missing')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonByText(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  )
  if (!button) throw new Error(`button "${label}" missing`)
  return button
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function submit(label = 'Create issue'): Promise<void> {
  act(() => buttonByText(label).click())
  await flush()
}

describe('feedback dialog', () => {
  beforeAll(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    calls = []
    removedKeys = []
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          remove: vi.fn(async (key: string) => {
            removedKeys.push(key)
          }),
        },
      },
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    container.remove()
    vi.unstubAllGlobals()
  })

  it('asks for a token before allowing a submit', () => {
    render(null)
    expect(container.textContent).toContain('GitHub connection')
    expect(container.textContent).toContain('Create a token on GitHub')
    expect(buttonByText('Create issue').disabled).toBe(true)
  })

  it('enables submit only once there is text, with diagnostics on by default', () => {
    render(AUTH)
    expect(container.textContent).toContain('Connected as @octocat')
    expect(buttonByText('Create issue').disabled).toBe(true)
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      true,
    )

    typeText('Settings crashes')
    expect(buttonByText('Create issue').disabled).toBe(false)
  })

  it('creates one issue with the first line as title and diagnostics in the body', async () => {
    setFetch(() =>
      jsonResponse(
        {
          number: 7,
          html_url: 'https://github.com/dcc123456/browser-copilot/issues/7',
        },
        { status: 201 },
      ),
    )
    render(AUTH)
    typeText('Settings crashes\n\nSteps: open Settings')

    await submit()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.github.com/repos/dcc123456/browser-copilot/issues')
    expect(calls[0]!.init!.method).toBe('POST')
    const payload = JSON.parse(String(calls[0]!.init!.body)) as { title: string; body: string }
    expect(payload.title).toBe('Settings crashes')
    expect(payload.body).toContain('Steps: open Settings')
    expect(payload.body).toContain('- Extension version: 0.6.16')
    expect(payload.body).toContain('- Build: abc123')
    expect(payload.body).toContain('- Browser: TestAgent/1.0')
    expect(payload.body).toContain('- UI language: en')

    expect(container.textContent).toContain('Issue #7 was created.')
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/dcc123456/browser-copilot/issues/7',
    )
  })

  it('sends only the report when diagnostics are unchecked', async () => {
    setFetch(() => jsonResponse({ number: 8, html_url: 'https://example.com/8' }, { status: 201 }))
    render(AUTH)
    typeText('  Just the text  ')
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click())

    await submit()

    const payload = JSON.parse(String(calls[0]!.init!.body)) as { body: string }
    expect(payload.body).toBe('Just the text')
  })

  it('posts once even when the button is clicked twice', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      await gate
      return jsonResponse({ number: 9, html_url: 'https://example.com/9' }, { status: 201 })
    }) as unknown as typeof fetch

    render(AUTH)
    typeText('One issue please')
    const button = buttonByText('Create issue')
    act(() => {
      button.click()
      button.click()
    })

    expect(calls).toHaveLength(1)
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain('Issue #9 was created.')
  })

  it('reports a rate limit and keeps the form editable', async () => {
    setFetch(() =>
      jsonResponse(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
        },
      ),
    )
    render(AUTH)
    typeText('Rate limited')

    await submit()

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('rate limit')
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false)
    expect(container.textContent).toContain('Connected as @octocat')
  })

  it('clears a rejected token and asks to connect again', async () => {
    setFetch(() => jsonResponse({ message: 'Bad credentials' }, { status: 401 }))
    render(AUTH)
    typeText('Token is dead')

    await submit()

    expect(removedKeys).toContain('marketplaceAuth')
    expect(container.textContent).toContain('Create a token on GitHub')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('rejected the token')
  })

  it('is translated on the Chinese panel', () => {
    render(null, 'zh-CN')
    expect(container.textContent).toContain('GitHub 连接')
    expect(container.textContent).toContain('去 GitHub 创建令牌')
    expect(container.textContent).toContain('创建 issue')
  })
})
