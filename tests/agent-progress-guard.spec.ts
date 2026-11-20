/**
 * No-progress guard wiring (spec R1): the judge is fed the page's RESULT
 * signature, warns once at the threshold, refuses only the identical call at
 * twice the threshold, and turns consecutive unreadable signatures into an
 * explicit blocker that refuses further page actions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentTurn } from '../src/background/agent'
import { toHistoryMessages } from '../src/background/restore'
import type { AgentServerMessage } from '../src/lib/messages'
import { streamCompletion } from '../src/lib/llm'
import type { StreamResult } from '../src/lib/llm'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const PAGE = {
  url: 'https://shop.test/p',
  title: 'P',
  text: 'page',
  truncated: false,
  selection: '',
  elements: [
    {
      ref: 'e1',
      role: 'button',
      name: 'Next page',
      tag: 'button',
      inViewport: true,
      target: { primary: { how: 'css' as const, value: '#next' }, fallbacks: [] },
    },
    {
      ref: 'e2',
      role: 'button',
      name: 'Reload',
      tag: 'button',
      inViewport: true,
      target: { primary: { how: 'css' as const, value: '#reload' }, fallbacks: [] },
    },
  ],
  elementsTruncated: false,
  frameUrl: 'https://shop.test/p',
  isTopFrame: true,
  forms: [],
  scrollHeight: 1200,
  scrollY: 0,
  viewportHeight: 800,
}

let signature: string | null = 'SIG-1'
let clickCount = 0
const execMock = vi.fn(async (request: { action?: string }) => {
  if (request.action === 'progress_signature') {
    return signature === null ? { ok: false, error: 'unreadable' } : { ok: true, data: signature }
  }
  if (request.action === 'click') {
    clickCount += 1
    return { ok: true, data: {} }
  }
  return { ok: true, data: {} }
})
const snapshotMock = vi.fn(async () => PAGE)
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execOnActiveTab: (request: { action?: string }) => execMock(request),
    snapshotActiveTab: () => snapshotMock(),
  }
})
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: async () => ({ apiKey: 'k', baseUrl: 'https://x', model: 'm', label: 't' }),
    addHistory: async () => {},
  }
})

const streamMock = vi.mocked(streamCompletion)
const statuses: string[] = []

function script(toolNames: string[]) {
  let round = 0
  streamMock.mockImplementation((async () => {
    const name = toolNames[round]
    round += 1
    if (!name) {
      return {
        content: 'done',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      } as StreamResult
    }
    const args = name === 'click' ? { ref: round === 1 ? 'e1' : 'e1' } : {}
    return {
      content: '',
      reasoning: '',
      toolCalls: [
        { id: `c${round}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
      finishReason: 'tool_calls',
      usage: null,
    } as StreamResult
  }) as never)
}

function deps(conversationId: string) {
  return {
    send: (message: AgentServerMessage) => {
      if (message.type === 'status') statuses.push(message.text)
    },
    confirm: async () => true,
    conversationId,
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 20,
    getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
  }
}

beforeEach(() => {
  signature = 'SIG-1'
  clickCount = 0
  statuses.length = 0
  execMock.mockClear()
  snapshotMock.mockClear()
  streamMock.mockReset()
})

describe('no-progress guard in the loop', () => {
  it('warns, then refuses only the identical call; a different action still runs', async () => {
    script(['snapshot_page', ...Array(9).fill('click')])
    const history = [{ role: 'user', content: 'go to page 3' }]
    await runAgentTurn(history as never, deps('progress-1') as never)

    // Seven clicks executed (threshold 3 warns, 6 blocks the NEXT repeat).
    expect(clickCount).toBe(7)
    expect(statuses.some((text) => text.includes('No progress detected'))).toBe(true)
    // The reminder is identifiable in the stored transcript and never enters
    // the history panel as something the user said.
    expect(
      history.some(
        (message) =>
          message.role === 'user' && String(message.content).startsWith('[[agent-note]]'),
      ),
    ).toBe(true)
    expect(
      toHistoryMessages(history as never).some((message) =>
        message.text.startsWith('[[agent-note]]'),
      ),
    ).toBe(false)
    expect(
      history.some(
        (message) =>
          message.role === 'tool' && String(message.content).includes('no page/state change'),
      ),
    ).toBe(true)
  })

  it('escalates unreadable signatures to a blocker and refuses further page actions', async () => {
    signature = null
    script(['snapshot_page', ...Array(6).fill('click')])
    const history = [{ role: 'user', content: 'click through' }]
    await runAgentTurn(history as never, deps('progress-2') as never)

    expect(statuses.some((text) => text.includes('can no longer be read'))).toBe(true)
    // Three clicks executed; the rest are refused by the blocker.
    expect(clickCount).toBe(3)
    expect(
      history.some(
        (message) => message.role === 'tool' && String(message.content).includes('cannot be read'),
      ),
    ).toBe(true)
  })

  it('does not accuse a page that keeps changing', async () => {
    let n = 0
    execMock.mockImplementation(async (request: { action?: string }) => {
      if (request.action === 'progress_signature') {
        n += 1
        return { ok: true, data: `SIG-${n}` }
      }
      if (request.action === 'click') {
        clickCount += 1
        return { ok: true, data: {} }
      }
      return { ok: true, data: {} }
    })
    script(['snapshot_page', ...Array(6).fill('click')])
    const history = [{ role: 'user', content: 'go' }]
    await runAgentTurn(history as never, deps('progress-3') as never)
    expect(clickCount).toBe(6)
    expect(statuses.some((text) => text.includes('No progress detected'))).toBe(false)
  })
})
