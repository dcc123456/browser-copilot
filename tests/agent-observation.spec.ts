import { describe, expect, it } from 'vitest'
import type { WireMessage } from '../src/lib/llm'
import { retireOldPageReads } from '../src/background/agent'

/**
 * Auto-observation retirement: every action result carries a fresh observation
 * (mini-snapshot, optionally a base64 screenshot). The transcript keeps only
 * the most recent one; older copies are replaced by a stub so history — and
 * per-round token cost — stays flat no matter how long the run.
 */
describe('retireOldPageReads: auto-observations', () => {
  function actionWithObservation(id: string, marker: string): WireMessage {
    return {
      role: 'tool',
      tool_call_id: id,
      name: 'click',
      content: JSON.stringify({
        ok: true,
        pageUnchanged: true,
        observation: {
          snapshot: { url: 'https://example.com', title: 'Example', elements: [{ ref: 'e1' }] },
          screenshot: `data:image/png;base64,${marker}`,
        },
      }),
    }
  }

  it('keeps only the most recent observation and stubs older ones', () => {
    const history: WireMessage[] = [
      actionWithObservation('a', 'OLD'.repeat(200)),
      actionWithObservation('b', 'NEW'),
    ]
    retireOldPageReads(history, false)

    const older = JSON.parse(history[0]!.content!) as { observation: string }
    const newest = JSON.parse(history[1]!.content!) as { observation: { snapshot: unknown } }
    expect(typeof older.observation).toBe('string')
    expect(older.observation).toContain('discarded')
    // The newest observation is intact so the model can act on its refs.
    expect(newest.observation.snapshot).toBeTruthy()
  })

  it('does not touch action results without an observation', () => {
    const history: WireMessage[] = [
      {
        role: 'tool',
        tool_call_id: 'a',
        name: 'click',
        content: JSON.stringify({ ok: true, pageUnchanged: true }),
      },
      actionWithObservation('b', 'ONLY'),
    ]
    retireOldPageReads(history, false)
    const plain = JSON.parse(history[0]!.content!) as { ok: boolean; observation?: unknown }
    expect(plain.ok).toBe(true)
    expect(plain.observation).toBeUndefined()
    expect(history[0]!.content).not.toContain('discarded')
  })

  it('keeps the latest observation even when retireAll drops page reads', () => {
    // After a navigation the action that caused it captured an observation of
    // the NEW page (post-settle) — retiring it would force an extra snapshot
    // round. Only page reads go fully stale on navigation.
    const history: WireMessage[] = [
      {
        role: 'tool',
        tool_call_id: 'page',
        name: 'read_current_page',
        content: JSON.stringify({ url: 'https://old.example', text: 'OLD PAGE '.repeat(500) }),
      },
      actionWithObservation('a', 'FRESH'),
    ]
    retireOldPageReads(history, true)

    const pageRead = JSON.parse(history[0]!.content!) as { retired?: boolean }
    const action = JSON.parse(history[1]!.content!) as { observation: { snapshot: unknown } }
    expect(pageRead.retired).toBe(true)
    expect(action.observation.snapshot).toBeTruthy()
  })
})
