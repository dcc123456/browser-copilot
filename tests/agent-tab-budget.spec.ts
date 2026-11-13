import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeTool, type ConversationTabLedger } from '../src/background/agent'

const newTabMock = vi.fn()
const reuseTabMock = vi.fn()

vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    newTab: (...args: unknown[]) => newTabMock(...args),
    reuseTab: (...args: unknown[]) => reuseTabMock(...args),
    settleAfterNavigation: async () => {},
    // The post-action observation is incidental here; make its best-effort
    // probes return immediately instead of reaching for a real Chrome.
    resolveAutomationTab: async () => {
      throw new Error('no browser in this test')
    },
    execOnActiveTab: async () => {
      throw new Error('no browser in this test')
    },
  }
})

const liveTabs = new Set<number>()
let nextTabId = 1

function context(
  tabLedger: ConversationTabLedger,
  windowId?: number,
): Parameters<typeof executeTool>[2] {
  return {
    conversationId: 'tab-budget-test',
    navigated: false,
    disabled: new Set<string>(),
    tabLedger,
    ...(windowId === undefined ? {} : { scope: { windowId } }),
  }
}

async function openTab(
  ledger: ConversationTabLedger,
  path: string,
  windowId?: number,
): Promise<{ ok: boolean; tabId: number; reused?: boolean }> {
  const output = await executeTool(
    'tab_new',
    { url: `https://search.test/${path}` },
    context(ledger, windowId),
  )
  return JSON.parse(output) as { ok: boolean; tabId: number; reused?: boolean }
}

beforeEach(() => {
  liveTabs.clear()
  nextTabId = 1
  newTabMock.mockReset()
  reuseTabMock.mockReset()
  newTabMock.mockImplementation(async (url?: string) => {
    const id = nextTabId++
    liveTabs.add(id)
    return { id, url: url ?? 'chrome://newtab/', title: '', active: true }
  })
  reuseTabMock.mockImplementation(async (id: number, url?: string) => {
    if (!liveTabs.has(id)) return null
    return { id, url: url ?? 'https://search.test/kept', title: '', active: true }
  })
})

describe('conversation tab budget', () => {
  it('creates five, then reuses the first one without rotating the others', async () => {
    const ledger: ConversationTabLedger = { tabs: [] }
    for (let index = 0; index < 5; index += 1) {
      const opened = await openTab(ledger, `q${index}`, 10)
      expect(opened.tabId).toBe(index + 1)
      expect(opened.reused).toBeUndefined()
    }
    // A fresh context on every call mirrors separate user turns sharing one
    // ledger; the allowance must not reset with ToolContext.
    const sixth = await openTab(ledger, 'q5', 10)
    const seventh = await openTab(ledger, 'q6', 10)
    expect(sixth).toMatchObject({ tabId: 1, reused: true })
    expect(seventh).toMatchObject({ tabId: 1, reused: true })
    expect(newTabMock).toHaveBeenCalledTimes(5)
    expect(reuseTabMock.mock.calls.map((call) => call[0])).toEqual([1, 1])
    expect(ledger.tabs.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('forgets a closed oldest tab and creates a replacement below the cap', async () => {
    const ledger: ConversationTabLedger = { tabs: [] }
    for (let index = 0; index < 5; index += 1) await openTab(ledger, `q${index}`, 10)
    liveTabs.delete(1)

    const replacement = await openTab(ledger, 'replacement', 10)
    expect(replacement.tabId).toBe(6)
    expect(replacement.reused).toBeUndefined()
    expect(ledger.tabs.map((entry) => entry.id)).toEqual([2, 3, 4, 5, 6])
    expect(newTabMock).toHaveBeenCalledTimes(6)
  })

  it('does not navigate a tab belonging to another panel window', async () => {
    const ledger: ConversationTabLedger = { tabs: [] }
    for (let index = 0; index < 5; index += 1) await openTab(ledger, `q${index}`, 10)

    const otherWindow = await openTab(ledger, 'other-window', 20)
    expect(otherWindow.tabId).toBe(6)
    expect(newTabMock).toHaveBeenCalledTimes(6)

    const backInFirstWindow = await openTab(ledger, 'first-window-again', 10)
    expect(backInFirstWindow).toMatchObject({ tabId: 1, reused: true })
    expect(reuseTabMock).toHaveBeenCalledWith(1, 'https://search.test/first-window-again')
  })

  it('does not register a tab whose creation failed', async () => {
    const ledger: ConversationTabLedger = { tabs: [] }
    newTabMock.mockRejectedValueOnce(new Error('browser refused'))
    await expect(openTab(ledger, 'failed', 10)).rejects.toThrow('browser refused')
    expect(ledger.tabs).toEqual([])
  })
})
