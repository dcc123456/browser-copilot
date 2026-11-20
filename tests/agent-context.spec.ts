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
    const projected = retireOldPageReads(history, false)

    const first = projected[0]!
    const click = projected[1]!
    const last = projected[2]!
    // The transcript keeps the original bytes: this is what gets persisted and
    // what a resumed task must be able to read (AC-5⑤).
    expect(history[0]!.content).toContain('FIRST PAGE')
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
    const projected = retireOldPageReads(history, true)
    for (const msg of projected) {
      if (msg.role === 'tool' && (msg as { name?: string }).name === 'read_current_page') {
        expect(msg.content).toContain('retired')
      }
    }
  })

  it('retires a page read whose body the emergency hard cap already shortened', () => {
    // After a hard cap the content ends with `…[truncated]` and no longer
    // parses as JSON. It is still a page read, and leaving it raw is what let
    // truncated reads accumulate after every cap.
    const history: WireMessage[] = [
      {
        role: 'tool',
        tool_call_id: 'a',
        name: 'read_current_page',
        content: `{"url":"https://example.com","text":"${'X'.repeat(2_000)}\u2026[truncated]`,
      },
      readTool('b', 'LATEST PAGE'),
    ]
    const projected = retireOldPageReads(history, false)
    expect(String(projected[0]!.content)).toContain('"retired":true')
    // The transcript keeps the truncated (never the original) text.
    expect(String(history[0]!.content)).toContain('\u2026[truncated]')
  })

  it('is idempotent and never grows the transcript', () => {
    const history: WireMessage[] = [readTool('a', 'X'.repeat(10_000))]
    const projected = retireOldPageReads(history, true)
    const entry = projected[0]!
    const once = entry.content!.length
    const again = retireOldPageReads(projected, true)
    const third = retireOldPageReads(again, false)
    expect(third[0]!.content!.length).toBe(once)
    // Projection never writes back into the source transcript.
    expect(history[0]!.content).toContain('X'.repeat(100))
  })
})
