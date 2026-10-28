/**
 * `read_selected_element`: the bridge between the on-page picker and the agent.
 *
 * The tool is the only way the model learns what the user picked, so the rows
 * pin the three answers it can give: no target tab, nothing picked yet, and a
 * pick plus the ready-to-use `target` (with `stale` when the tab has moved on).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveAutomationTab = vi.fn()

vi.mock('../src/background/driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/driver')>()
  return { ...actual, resolveAutomationTab: (...args: unknown[]) => resolveAutomationTab(...args) }
})

import { advertiseTools, executeTool, modeAutoApproves } from '../src/background/agent'
import {
  _resetPickedElementWritesForTests,
  rememberPickedElement,
} from '../src/background/element-selection-store'

const baseCtx = {
  conversationId: 'test-conv',
  navigated: false,
  disabled: new Set<string>(),
}

function makeChrome() {
  const session = new Map<string, unknown>()
  return {
    session,
    chrome: {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) session.set(key, value)
          }),
        },
      },
    },
  }
}

const picked = {
  selector: '#buy',
  tag: 'button',
  id: 'buy',
  text: 'Buy',
  html: '<button id="buy">Buy</button>',
  url: 'https://shop.test/',
  title: 'Shop',
  pickedAt: 1_700_000_000_000,
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChrome().chrome)
  _resetPickedElementWritesForTests()
  resolveAutomationTab.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('read_selected_element', () => {
  it('is advertised in every mode that can act, and needs approval in semi-auto', () => {
    for (const mode of ['semi', 'full', 'readonly'] as const) {
      const names = advertiseTools({ mode }).map((tool) => tool.function.name)
      expect(names).toContain('read_selected_element')
    }
    expect(modeAutoApproves('semi', 'read_selected_element')).toBe(false)
    expect(modeAutoApproves('full', 'read_selected_element')).toBe(true)
  })

  it('fails honestly when no tab can be targeted', async () => {
    resolveAutomationTab.mockResolvedValue(undefined)

    const parsed = JSON.parse(await executeTool('read_selected_element', {}, baseCtx)) as {
      ok: boolean
      error: string
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('标签页')
  })

  it('points the model at the picker when this tab has no pick yet', async () => {
    resolveAutomationTab.mockResolvedValue({ id: 7, url: picked.url })

    const parsed = JSON.parse(await executeTool('read_selected_element', {}, baseCtx)) as {
      ok: boolean
      error: string
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('No element has been picked')
  })

  it('returns the pick with a ready target for click/fill', async () => {
    resolveAutomationTab.mockResolvedValue({ id: 7, url: picked.url })
    await rememberPickedElement(7, picked)

    const parsed = JSON.parse(await executeTool('read_selected_element', {}, baseCtx)) as {
      ok: boolean
      selector: string
      text: string
      stale: boolean
      target: { primary: { how: string; value: string }; fallbacks: unknown[] }
    }
    expect(parsed).toMatchObject({
      ok: true,
      selector: '#buy',
      text: 'Buy',
      stale: false,
      target: { primary: { how: 'css', value: '#buy' }, fallbacks: [] },
    })
  })

  it('flags a pick made on a different URL as stale but still returns it', async () => {
    resolveAutomationTab.mockResolvedValue({ id: 7, url: 'https://shop.test/next' })
    await rememberPickedElement(7, picked)

    const parsed = JSON.parse(await executeTool('read_selected_element', {}, baseCtx)) as {
      ok: boolean
      selector: string
      stale: boolean
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.selector).toBe('#buy')
    expect(parsed.stale).toBe(true)
  })

  it('reads only the tab it is pointed at', async () => {
    resolveAutomationTab.mockResolvedValue({ id: 8, url: picked.url })
    await rememberPickedElement(7, picked)

    const parsed = JSON.parse(await executeTool('read_selected_element', {}, baseCtx)) as {
      ok: boolean
      error: string
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('No element has been picked')
  })
})
