// @vitest-environment jsdom
/**
 * Component tests for the tokens dashboard (`sidepanel/TokensTab`), driving the
 * real component with a mocked command channel and a dashboard built by the real
 * ledger. Pins what the tab owes the user:
 *
 * 1. the four statistical windows switch by re-asking the worker for that range
 *    (AC-2) — the panel never re-adds numbers itself.
 * 2. chart vs. table are two views of one payload (AC-3): the chart is a smooth
 *    path, the tables list every consumer and every conversation / task (AC-4,
 *    AC-5).
 * 3. a ledger write from anywhere refreshes the view without reopening the tab.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import { messagesFor } from '../src/lib/i18n'
import {
  applyRecordToDaily,
  buildTokenDashboard,
  startOfDay,
  type TokenDashboard,
  type TokenDailyStore,
  type TokenRange,
  type TokenUsageRecord,
} from '../src/lib/token-ledger'
import { I18nProvider } from '../src/sidepanel/i18n'
import TokensTab from '../src/sidepanel/TokensTab'
import { notifyStoreChanged } from '../src/lib/store-events'

const t = messagesFor('en')
const HOUR_MS = 3_600_000

function record(
  id: string,
  hoursAgo: number,
  consumer: TokenUsageRecord['consumer'],
  entityKey: string,
  entityLabel: string,
  inputTokens: number,
  outputTokens: number,
): TokenUsageRecord {
  const at = startOfDay(Date.now()) + 12 * HOUR_MS - hoursAgo * HOUR_MS
  return {
    id,
    at,
    consumer,
    entityKey,
    entityLabel,
    model: 'deepseek-chat',
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  }
}

/** Two rounds of one chat turn plus a scheduled task run, the shape a real
 *  week of use leaves in the ledger. */
const RECORDS: TokenUsageRecord[] = [
  record('r1', 3, 'chat', 'chat:c1', 'Debug the login form', 1000, 200),
  record('r2', 2, 'chat', 'chat:c1', 'Debug the login form', 1500, 300),
  record('r3', 2, 'scheduled-task', 'task:t1', 'Morning digest', 500, 100),
]

const DAILY: TokenDailyStore = {}
for (const entry of RECORDS) applyRecordToDaily(DAILY, entry)

const TOTAL_TOKENS = RECORDS.reduce((sum, entry) => sum + entry.totalTokens, 0)

const seen: Command[] = []
const roots: Root[] = []

function dashboardFor(range: TokenRange): TokenDashboard {
  return buildTokenDashboard(RECORDS, DAILY, range)
}

beforeEach(() => {
  seen.length = 0
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    switch (command.type) {
      case 'tokens.stats':
        return { type: 'tokens.stats', stats: dashboardFor(command.range) }
      case 'tokens.clear':
        return { type: 'tokens.clear' }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
  })
})

afterEach(async () => {
  // Every mounted tab keeps a store-bus subscription, so leaving one mounted
  // after its test would push commands into the next test's transcript.
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const render = async (): Promise<{ container: HTMLElement; root: Root }> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        { value: { locale: 'en' as const, t } },
        createElement(TokensTab),
      ),
    )
  })
  await flush()
  return { container, root }
}

const click = async (root: ParentNode, label: string): Promise<void> => {
  const button = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${label}`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const text = (container: HTMLElement): string => container.textContent ?? ''

const statsRanges = (): TokenRange[] =>
  seen
    .filter(
      (entry): entry is { type: 'tokens.stats'; range: TokenRange } =>
        entry.type === 'tokens.stats',
    )
    .map((entry) => entry.range)

describe('TokensTab', () => {
  it('opens on the 7-day window and shows the ledger total', async () => {
    const { container } = await render()

    expect(statsRanges()).toEqual(['7d'])
    expect(text(container)).toContain(t.tokensRange7d)
    expect(text(container)).toContain(new Intl.NumberFormat('en').format(TOTAL_TOKENS))
  })

  it('re-reads the dashboard for every statistical window', async () => {
    const { container } = await render()

    await click(container, t.tokensRangeToday)
    await click(container, t.tokensRangeAll)
    await click(container, t.tokensRange30d)

    expect(statsRanges()).toEqual(['7d', 'today', 'all', '30d'])
  })

  it('draws a smooth curve in the chart view and tables in the table view', async () => {
    const { container } = await render()

    const paths = [...container.querySelectorAll('svg path')]
    expect(paths).toHaveLength(2)
    for (const path of paths) expect(path.getAttribute('d') ?? '').toContain('C')
    expect(text(container)).not.toContain(t.tokensByEntity)

    await click(container, t.tokensViewTable)
    expect(container.querySelector('svg')).toBeNull()
    expect(text(container)).toContain(t.tokensByConsumer)
    expect(text(container)).toContain(t.tokensByEntity)
  })

  it('names every consuming feature and drills down to one chat and one task', async () => {
    const { container } = await render()
    await click(container, t.tokensViewTable)

    expect(text(container)).toContain(t.tokensConsumerChat)
    expect(text(container)).toContain(t.tokensConsumerScheduledTask)
    // Per-entity rows carry the stored display name, which is how a user finds
    // "that chat" and "that task" in the list.
    expect(text(container)).toContain('Debug the login form')
    expect(text(container)).toContain('Morning digest')

    const chatRow = [...container.querySelectorAll('tr')].find((row) =>
      row.textContent?.includes('Debug the login form'),
    )
    expect(chatRow?.textContent).toContain(new Intl.NumberFormat('en').format(3000))
  })

  it('refreshes on a ledger write without reopening the tab', async () => {
    const { container } = await render()
    expect(statsRanges()).toEqual(['7d'])

    await act(async () => {
      notifyStoreChanged('tokenUsage')
      // The tab coalesces a burst of per-request writes into one re-read.
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    await flush()

    expect(statsRanges()).toEqual(['7d', '7d'])
    expect(container.querySelector('svg path')).not.toBeNull()
  })

  it('reads out the bucket under the cursor', async () => {
    const { container } = await render()
    const svg = container.querySelector('svg')
    if (!svg) throw new Error('the default view should be the chart')
    // The chart is 320 user units wide and the svg scales to its box; pin that
    // box so a cursor position maps to a bucket index the test can predict.
    const rect = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 320,
      left: 0,
      top: 0,
      height: 120,
      right: 320,
      bottom: 120,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    const number = (value: number): string => new Intl.NumberFormat('en').format(value)
    // Only the hover readout spells out "Total tokens" — the KPI uses a div.
    const readout = (): string | undefined =>
      [...container.querySelectorAll('span')].find((span) =>
        span.textContent?.includes(t.tokensTotal),
      )?.textContent

    const move = async (clientX: number): Promise<void> => {
      await act(async () => {
        svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX }))
      })
      await flush()
    }

    // Seven daily buckets; the window's first day is idle, today holds every
    // record. Hovering must report the bucket, not the window.
    await move(8)
    expect(readout()).toContain(`${t.tokensTotal} ${number(0)}`)

    await move(312)
    expect(readout()).toContain(`${t.tokensTotal} ${number(TOTAL_TOKENS)}`)
    expect(readout()).toContain(t.tokensInput)

    await act(async () => {
      // React synthesizes `onPointerLeave` from a `pointerout` whose target is
      // outside the element, so that is the pair to dispatch.
      svg.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
      )
    })
    await flush()
    expect(readout()).toBeUndefined()
    rect.mockRestore()
  })

  it('asks before deleting the ledger, then clears and re-reads', async () => {
    const confirmed = vi
      .fn()
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => true)
    vi.stubGlobal('confirm', confirmed)

    const { container } = await render()
    await click(container, t.tokensClear)
    expect(seen.some((entry) => entry.type === 'tokens.clear')).toBe(false)

    await click(container, t.tokensClear)
    await flush()

    expect(seen.filter((entry) => entry.type === 'tokens.clear')).toHaveLength(1)
    expect(statsRanges()).toEqual(['7d', '7d'])
  })
})
