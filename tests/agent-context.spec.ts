import { describe, expect, it } from 'vitest'
import type { WireMessage } from '../src/lib/llm'
import { retireOldPageReads } from '../src/background/agent'

function readTool(id: string, text: string): WireMessage {
  return {
    role: 'tool',
    tool_call_id: id,
    name: 'read_current_page',
    content: JSON.stringify({ url: 'https://example.com', title: 'Example', text }),
  }
}

function clickTool(id: string): WireMessage {
  return {
    role: 'tool',
    tool_call_id: id,
    name: 'click',
    content: JSON.stringify({ ok: true }),
  }
}

describe('retireOldPageReads', () => {
  it('replaces older page reads with a retired stub, keeping the most recent one', () => {
    const history: WireMessage[] = [
      readTool('a', 'FIRST PAGE '.repeat(500)),
      clickTool('c1'),
      readTool('b', 'SECOND PAGE '.repeat(500)),
    ]
    retireOldPageReads(history, false)

    const first = history[0]!
    const click = history[1]!
    const last = history[2]!
    // Old read is stubbed and much smaller.
    expect(first.content!.length).toBeLessThan(300)
    expect(first.content).toContain('retired')
    // Non-page tool results are untouched.
    expect(click.content).toBe(JSON.stringify({ ok: true }))
    // Most recent read is left intact so the model can act on it.
    expect(last.content).toContain('SECOND PAGE')
  })

  it('drops every page read when retireAll is set (after navigation)', () => {
    const history: WireMessage[] = [
      readTool('a', 'OLD PAGE '.repeat(500)),
      clickTool('c1'),
      readTool('b', 'STALE PAGE '.repeat(500)),
    ]
    retireOldPageReads(history, true)
    for (const msg of history) {
      if (msg.role === 'tool' && (msg as { name?: string }).name === 'read_current_page') {
        expect(msg.content).toContain('retired')
      }
    }
  })

  it('is idempotent and never grows the transcript', () => {
    const history: WireMessage[] = [readTool('a', 'X'.repeat(10_000))]
    retireOldPageReads(history, true)
    const entry = history[0]!
    const once = entry.content!.length
    retireOldPageReads(history, true)
    retireOldPageReads(history, false)
    expect(entry.content!.length).toBe(once)
  })
})
