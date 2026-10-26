// @vitest-environment jsdom
/**
 * The self-updater's panel surface.
 *
 * Unit tests cover the check/apply logic; these render the two places a user
 * meets it — the panel-wide banner and the settings card — and pin the states
 * that decide whether an in-place update is even offered.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '../src/sidepanel/i18n'
import UpdateCenter from '../src/sidepanel/update/UpdateCenter'
import UpdateSettingsCard from '../src/sidepanel/update/UpdateSettingsCard'
import { messagesFor } from '../src/lib/i18n'
import type { UpdateState } from '../src/lib/update/types'

const noop = () => {}
const roots: Root[] = []
const containers: HTMLElement[] = []

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const ASSET_URL =
  'https://github.com/dcc123456/browser-copilot/releases/download/v0.6.8/browser-copilot-0.6.8-ocr.zip'

function availableState(): UpdateState {
  return {
    checkedAt: Date.UTC(2026, 9, 22, 10, 0),
    currentVersion: '0.6.7',
    latest: {
      version: '0.6.8',
      tag: 'v0.6.8',
      name: 'v0.6.8',
      htmlUrl: 'https://github.com/dcc123456/browser-copilot/releases/tag/v0.6.8',
      notes: 'Fixes and polish.',
      publishedAt: '2026-10-21T00:00:00Z',
    },
    asset: {
      name: 'browser-copilot-0.6.8-ocr.zip',
      url: ASSET_URL,
      size: 1024,
      digest: `sha256:${'a'.repeat(64)}`,
    },
    available: true,
    error: null,
  }
}

interface StubOptions {
  state?: UpdateState | null
  dismissed?: string | null
  pending?: string | null
  installType?: string
  manifestVersion?: string
}

interface StubHandles {
  setSpy: ReturnType<typeof vi.fn>
  reloadSpy: ReturnType<typeof vi.fn>
  createTabSpy: ReturnType<typeof vi.fn>
  sendMessageSpy: ReturnType<typeof vi.fn>
}

function installChrome(options: StubOptions = {}): StubHandles {
  let state = options.state ?? null
  let dismissed = options.dismissed ?? null
  let pending = options.pending ?? null
  const installType = options.installType ?? 'development'
  const manifestVersion = options.manifestVersion ?? '0.6.7'

  const setSpy = vi.fn(async (patch: Record<string, unknown>) => {
    if ('update.dismissedVersion' in patch) dismissed = patch['update.dismissedVersion'] as string
    if ('update.pendingReloadVersion' in patch)
      pending = patch['update.pendingReloadVersion'] as string
    if ('update.state' in patch) state = patch['update.state'] as UpdateState
  })
  const reloadSpy = vi.fn()
  const createTabSpy = vi.fn(async () => ({}))
  const sendMessageSpy = vi.fn(async (command: { type: string }) => {
    if (command.type === 'update.check') {
      return { ok: true, data: { type: 'update.state', state } }
    }
    return { ok: true, data: { type: 'noop' } }
  })

  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({
        manifest_version: 3,
        name: 'Browser Copilot',
        version: manifestVersion,
      }),
      sendMessage: sendMessageSpy,
      reload: reloadSpy,
      onMessage: { addListener: noop, removeListener: noop },
    },
    management: {
      getSelf: async () => ({ installType }),
    },
    storage: {
      local: {
        get: async (key: string) => {
          if (key === 'update.state') return state ? { 'update.state': state } : {}
          if (key === 'update.dismissedVersion') {
            return dismissed ? { 'update.dismissedVersion': dismissed } : {}
          }
          if (key === 'update.pendingReloadVersion') {
            return pending ? { 'update.pendingReloadVersion': pending } : {}
          }
          return {}
        },
        set: setSpy,
        remove: async (key: string) => {
          if (key === 'update.pendingReloadVersion') pending = null
        },
      },
      onChanged: { addListener: noop, removeListener: noop },
    },
    tabs: { create: createTabSpy },
  })
  return { setSpy, reloadSpy, createTabSpy, sendMessageSpy }
}

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(I18nProvider, { value: { locale: 'en', t: messagesFor('en') } }, element),
    )
  })
  // Settle the storage reads, install-type probe and IndexedDB miss.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  for (const container of containers) container.remove()
  roots.length = 0
  containers.length = 0
  vi.unstubAllGlobals()
})

describe('the update banner', () => {
  it('offers the release and opens the install dialog', async () => {
    installChrome({ state: availableState() })
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    const container = await render(createElement(UpdateCenter))

    expect(container.textContent).toContain('Version 0.6.8 is available.')
    const openButton = buttonByLabel(container, 'Update')
    expect(openButton?.textContent).toBe('')
    await click(openButton)

    expect(container.textContent).toContain('New version: 0.6.8')
    expect(container.textContent).toContain('Fixes and polish.')
    expect(container.textContent).toContain(
      'The first update asks for the folder you originally loaded; later updates reuse it automatically.',
    )
    // Every dialog action is icon-only; the label lives on aria-label/title.
    const startButton = buttonByLabel(container, 'Download and install')
    expect(startButton?.textContent).toBe('')
    expect(startButton?.title).toBe('Download and install')
    expect(buttonByLabel(container, 'Cancel')?.textContent).toBe('')
  })

  it('remembers a dismissed version', async () => {
    const { setSpy } = installChrome({ state: availableState() })
    const container = await render(createElement(UpdateCenter))

    await click(container.querySelector('button[aria-label="Dismiss"]'))

    expect(setSpy).toHaveBeenCalledWith({ 'update.dismissedVersion': '0.6.8' })
    expect(container.textContent).not.toContain('Version 0.6.8 is available.')
  })

  it('asks for the reload once the files are written', async () => {
    const { reloadSpy } = installChrome({
      state: availableState(),
      pending: '0.6.8',
    })
    const container = await render(createElement(UpdateCenter))

    expect(container.textContent).toContain('Version 0.6.8 is ready')
    await click(buttonByLabel(container, 'Reload'))
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('links to the release instead of writing an unpacked folder it cannot reach', async () => {
    const { createTabSpy } = installChrome({ state: availableState(), installType: 'normal' })
    const container = await render(createElement(UpdateCenter))

    await click(buttonByLabel(container, 'Update'))

    expect(container.textContent).toContain('cannot update itself in place')
    await click(buttonByLabel(container, 'Open release page'))
    expect(createTabSpy).toHaveBeenCalledWith({
      url: 'https://github.com/dcc123456/browser-copilot/releases/tag/v0.6.8',
    })
  })
})

describe('the settings card', () => {
  it('shows the available release and can re-check on demand', async () => {
    const { sendMessageSpy } = installChrome({ state: availableState() })
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    const container = await render(createElement(UpdateSettingsCard))

    expect(container.textContent).toContain('Installed version: 0.6.7')
    expect(container.textContent).toContain('Version 0.6.8 is ready to install.')
    expect(container.textContent).toContain('Last checked')
    await click(buttonByText(container, 'Check for updates'))
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'update.check', force: true })
  })

  it('offers the reload while an applied update waits', async () => {
    installChrome({ state: availableState(), pending: '0.6.8' })
    const container = await render(createElement(UpdateSettingsCard))

    expect(container.textContent).toContain('Version 0.6.8 is waiting for a reload.')
    expect(buttonByText(container, 'Reload extension')).toBeDefined()
  })

  it('says when the running version is current', async () => {
    const state = availableState()
    state.latest = { ...state.latest!, version: '0.6.7', tag: 'v0.6.7' }
    state.asset = { ...state.asset!, name: 'browser-copilot-0.6.7-ocr.zip' }
    state.available = false
    installChrome({ state })
    const container = await render(createElement(UpdateSettingsCard))

    expect(container.textContent).toContain('You are on the latest version.')
    expect(buttonByText(container, 'Update now')).toBeUndefined()
  })

  it('states the scheduled retry and leaves a pending one alone', async () => {
    const state: UpdateState = {
      ...availableState(),
      available: false,
      latest: null,
      asset: null,
      error: { code: 'rate-limited', message: 'limited' },
      failures: 1,
      retryAt: Date.now() + 60 * 60_000,
    }
    const { sendMessageSpy } = installChrome({ state })
    const container = await render(createElement(UpdateSettingsCard))

    expect(container.textContent).toContain('Automatic retry at')
    expect(sendMessageSpy).not.toHaveBeenCalled()
  })

  it('re-checks once the scheduled retry has come due', async () => {
    const state: UpdateState = {
      ...availableState(),
      available: false,
      latest: null,
      asset: null,
      error: { code: 'network', message: 'offline' },
      failures: 2,
      retryAt: Date.now() - 1_000,
    }
    const { sendMessageSpy } = installChrome({ state })
    await render(createElement(UpdateSettingsCard))

    expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'update.check', force: false })
  })
})
