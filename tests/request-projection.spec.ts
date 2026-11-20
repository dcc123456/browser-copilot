/**
 * AC-15 gate: what a request sends is a PROJECTION, and projecting is stable.
 *
 * The composition (compaction → page-read retirement → emergency hard cap) must
 * be reproducible byte for byte and must never write back into the transcript
 * that storage persists. A projection that drifts between two identical runs,
 * or that mutates `history`, is a bug the cache metrics would silently absorb.
 */
import { describe, expect, it } from 'vitest'
import type { WireMessage } from '../src/lib/llm'
import { projectCompaction, projectHardCap } from '../src/lib/context-compact'
import { retireOldPageReads } from '../src/background/agent'

const MARKER = '[context compacted]'

function history(): WireMessage[] {
  return [
    { role: 'user', content: 'turn 1: read the pricing page' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'read_current_page', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'c1',
      name: 'read_current_page',
      content: JSON.stringify({
        url: 'https://shop.test/pricing',
        title: 'Pricing',
        text: 'PRICE PAGE '.repeat(400),
      }),
    },
    { role: 'assistant', content: 'The plan costs 10 yuan.' },
    { role: 'user', content: 'turn 2: add it to the cart' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c2', type: 'function', function: { name: 'click', arguments: '{"ref":"e1"}' } },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'c2',
      name: 'click',
      content: JSON.stringify({
        ok: true,
        pageUnchanged: true,
        observation: {
          snapshot: { url: 'https://shop.test/cart', elements: [{ ref: 'e1' }] },
          screenshot: `data:image/png;base64,${'A'.repeat(2_000)}`,
        },
      }),
    },
    { role: 'assistant', content: 'Added to the cart.' },
    { role: 'user', content: 'turn 3: re-read the cart' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c3',
          type: 'function',
          function: { name: 'read_current_page', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'c3',
      name: 'read_current_page',
      content: JSON.stringify({
        url: 'https://shop.test/cart',
        title: 'Cart',
        text: 'CART PAGE '.repeat(200),
      }),
    },
    { role: 'assistant', content: 'The cart has one item.' },
    { role: 'user', content: 'turn 4: continue' },
    { role: 'assistant', content: 'Continuing.' },
  ]
}

/** The exact composition the loop uses for one outgoing request. */
async function project(source: readonly WireMessage[]): Promise<WireMessage[]> {
  const compacted = await projectCompaction(source, {
    marker: MARKER,
    keepRecentTurns: 1,
    summarize: async () => 'earlier turns summary',
  })
  const base = compacted?.messages ?? source
  const retired = retireOldPageReads(base, false)
  return projectHardCap(retired, 8_000).messages
}

describe('request projection stability (AC-15)', () => {
  it('projects the same bytes twice and never rewrites the stored transcript', async () => {
    const source = history()
    const snapshot = JSON.parse(JSON.stringify(source)) as WireMessage[]

    const first = await project(source)
    const second = await project(source)

    // 1. Deterministic: two identical runs send identical bytes.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    // 2. The projection carries the compaction summary and retired reads...
    expect(first.some((message) => String(message.content).includes('earlier turns summary'))).toBe(
      true,
    )
    // The projection is not the stored transcript: it differs wherever a turn
    // was summarized or a read retired.
    expect(first).not.toEqual(source)
    // 3. ...while the stored transcript keeps the raw page text and the
    //    original observation (no stub, no truncation marker).
    expect(source).toEqual(snapshot)
    expect(JSON.stringify(source)).not.toContain('"retired":true')
    expect(JSON.stringify(source)).not.toContain('[truncated]')
  })

  it('leaves source messages byte-identical after a hard cap', () => {
    const source: WireMessage[] = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'x'.repeat(30_000) },
    ]
    const capped = projectHardCap(source, 2_000)
    expect(capped.removed).toBeGreaterThan(0)
    expect(String(capped.messages[1]?.content).endsWith('[truncated]')).toBe(true)
    expect(String(source[1]?.content)).not.toContain('[truncated]')
  })
})
