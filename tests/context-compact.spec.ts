import { describe, expect, it } from 'vitest'
import {
  COMPACT_KEEP_RECENT_TURNS,
  COMPACT_THRESHOLD_TOKENS,
  compactHistory,
  shouldCompact,
  type CompactOptions,
} from '../src/lib/context-compact'
import type { WireMessage, WireToolCall } from '../src/lib/llm'

/**
 * Compaction replaces older turns (assistant answers + tool exchanges) with a
 * single summary message once the context crosses 80% of the 256K window.
 * User messages and the most recent turns must always survive verbatim.
 */

const MARKER = '[上下文已压缩]'

function opts(overrides: Partial<CompactOptions> = {}): CompactOptions {
  return { marker: MARKER, ...overrides }
}

function user(text: string): WireMessage {
  return { role: 'user', content: text }
}

function assistant(text: string, toolCalls?: WireToolCall[]): WireMessage {
  return toolCalls
    ? { role: 'assistant', content: null, tool_calls: toolCalls }
    : { role: 'assistant', content: text }
}

function toolCall(id: string): WireToolCall {
  return { id, type: 'function', function: { name: 'click', arguments: '{}' } }
}

function toolResult(id: string, content: string): WireMessage {
  return { role: 'tool', tool_call_id: id, content }
}

function seeded(): WireMessage[] {
  // Three complete turns; the last two must survive any compaction untouched.
  return [
    user('T1: buy something'),
    assistant('T1 answer'),
    toolResult('t1', '{"result":"page read"}'),
    user('T2: refine'),
    assistant('T2 answer'),
    user('T3: final request'),
    assistant('T3 answer'),
  ]
}

describe('shouldCompact', () => {
  it('triggers at 80% of the 256K window and never below', () => {
    expect(COMPACT_THRESHOLD_TOKENS).toBe(204_800)
    expect(shouldCompact(COMPACT_THRESHOLD_TOKENS - 1)).toBe(false)
    expect(shouldCompact(COMPACT_THRESHOLD_TOKENS)).toBe(true)
    expect(shouldCompact(0)).toBe(false)
  })
})

describe('compactHistory', () => {
  it('keeps the last two turns verbatim and compacts only older ones', async () => {
    const history = seeded()
    const outcome = await compactHistory(history, opts({ summarize: async () => 'S' }))
    expect(outcome?.removed).toBe(2) // T1 answer + T1 tool result
    // The summary lands where T1's answer used to be — after T1's user
    // message, before the next turn.
    expect(history).toEqual([
      user('T1: buy something'),
      { role: 'user', content: `${MARKER}\nS` },
      user('T2: refine'),
      assistant('T2 answer'),
      user('T3: final request'),
      assistant('T3 answer'),
    ])
  })

  it('keeps user messages even inside compacted turns', async () => {
    const history: WireMessage[] = [
      user('old question'),
      assistant('old answer'),
      user('kept question'),
      assistant('kept answer'),
      user('current'),
    ]
    await compactHistory(history, opts({ keepRecentTurns: 1, summarize: async () => 'S' }))
    expect(history.some((m) => m.role === 'user' && m.content === 'old question')).toBe(true)
    expect(history.some((m) => m.role === 'user' && m.content === 'kept question')).toBe(true)
    expect(history.some((m) => m.role === 'assistant' && m.content === 'old answer')).toBe(false)
  })

  it('falls back to a mechanical digest when the summarizer fails', async () => {
    const history = seeded()
    const outcome = await compactHistory(
      history,
      opts({ summarize: async () => Promise.reject(new Error('boom')) }),
    )
    expect(outcome).not.toBeNull()
    const markerMessage = history.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(MARKER),
    )
    const summary = typeof markerMessage?.content === 'string' ? markerMessage.content : ''
    expect(summary.startsWith(`${MARKER}\n`)).toBe(true)
    // Only REMOVED messages are digested — user messages never enter it.
    expect(summary).toContain('assistant: T1 answer')
    expect(summary).toContain('tool: {"result":"page read"}')
    expect(summary).not.toContain('T1: buy something')
  })

  it('falls back when the summarizer returns whitespace', async () => {
    const history = seeded()
    const outcome = await compactHistory(history, opts({ summarize: async () => '   ' }))
    expect(outcome?.summary.length).toBeGreaterThan(0)
  })

  it('returns null when there are too few turns to compact', async () => {
    const history: WireMessage[] = [user('a'), assistant('b'), user('current')]
    const outcome = await compactHistory(history, opts({ summarize: async () => 'S' }))
    expect(outcome).toBeNull()
    expect(history.some((m) => m.role === 'user' && m.content === `${MARKER}\nS`)).toBe(false)
  })

  it('returns null when the compactable span holds only user messages', async () => {
    const history: WireMessage[] = [
      user('lone old turn'),
      user('kept 1'),
      user('kept 2'),
      user('current'),
    ]
    const outcome = await compactHistory(history, opts({ summarize: async () => 'S' }))
    expect(outcome).toBeNull()
    expect(history).toHaveLength(4)
  })

  it('does not mutate the history when nothing is compacted', async () => {
    const history = seeded()
    const snapshot = JSON.parse(JSON.stringify(history)) as WireMessage[]
    await compactHistory(history, opts({ keepRecentTurns: 99, summarize: async () => 'S' }))
    expect(history).toEqual(snapshot)
  })

  it('caps each removed message in the summarizer transcript', async () => {
    const history: WireMessage[] = [
      user('old'),
      assistant('x'.repeat(10_000)),
      user('kept 1'),
      assistant('k1'),
      user('kept 2'),
      assistant('k2'),
      user('current'),
    ]
    let seen = ''
    await compactHistory(
      history,
      opts({
        keepRecentTurns: COMPACT_KEEP_RECENT_TURNS,
        summarize: async (transcript) => {
          seen = transcript
          return 'S'
        },
      }),
    )
    expect(seen.length).toBeLessThan(10_000)
    expect(seen).toContain('…')
  })

  it('tool exchanges in KEPT turns survive intact with their assistant call', async () => {
    const history: WireMessage[] = [
      user('old'),
      assistant('old answer'),
      user('mid'),
      assistant('', [toolCall('t2')]),
      toolResult('t2', '{"ok":true}'),
      user('current'),
    ]
    await compactHistory(history, opts({ keepRecentTurns: 2, summarize: async () => 'S' }))
    const survivingCalls = new Set(
      history.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []) : [])).map((c) => c.id),
    )
    for (const message of history) {
      if (message.role === 'tool') {
        expect(survivingCalls.has(message.tool_call_id)).toBe(true)
      }
    }
    // And the kept exchange is really there.
    expect(history.some((m) => m.role === 'tool' && m.tool_call_id === 't2')).toBe(true)
  })
})
