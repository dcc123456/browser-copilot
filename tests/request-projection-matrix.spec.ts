/**
 * Combination matrix for the request pipeline (retire × compaction × hard cap).
 *
 * Three regressions came from pairs of individually-correct projections:
 * retirement × compaction, hard cap × persisted transcript, hard cap ×
 * retirement. Each unit test stayed green. This matrix asserts the properties
 * that only appear when the switches are combined:
 *   - the stored transcript is never modified, whatever the switches;
 *   - a hard-capped page read is still retired (never re-grows the request);
 *   - with retirement on, the request keeps at most one raw page read;
 *   - the request grows roughly linearly round over round.
 */
import { describe, expect, it } from 'vitest'
import type { WireMessage } from '../src/lib/llm'
import { projectCompaction, projectHardCap } from '../src/lib/context-compact'
import { retireOldPageReads } from '../src/background/agent'

const MARKER = '[context compacted]'
const TOOLS = ['snapshot_page', 'read_current_page', 'form_fields']

interface Switches {
  compaction: boolean
  retire: boolean
  cap: boolean
}

function seeded(): WireMessage[] {
  const history: WireMessage[] = []
  for (let turn = 0; turn < 5; turn += 1) {
    history.push({ role: 'user', content: `turn ${turn + 1}: read the page` })
    history.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `seed-${turn}`,
          type: 'function',
          function: { name: 'snapshot_page', arguments: '{}' },
        },
      ],
    })
    history.push({
      role: 'tool',
      tool_call_id: `seed-${turn}`,
      name: 'snapshot_page',
      content: JSON.stringify({
        url: 'https://shop.test/p',
        title: 'P',
        text: `TURN ${turn + 1} PRICE `.repeat(30),
      }),
    })
  }
  history.push({ role: 'user', content: 'keep watching' })
  return history
}

/** One more tool round of a long page read, as the loop appends it. */
function appendRound(history: WireMessage[], round: number): WireMessage[] {
  history.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: `r${round}`, type: 'function', function: { name: 'snapshot_page', arguments: '{}' } },
    ],
  })
  history.push({
    role: 'tool',
    tool_call_id: `r${round}`,
    name: 'snapshot_page',
    content: JSON.stringify({
      url: 'https://shop.test/p',
      title: 'P',
      text: `ROUND ${round} PRICE `.repeat(30),
    }),
  })
  return history
}

/** The composition the loop performs for one outgoing request. */
async function project(
  history: readonly WireMessage[],
  switches: Switches,
): Promise<WireMessage[]> {
  let messages: WireMessage[] = [...history]
  if (switches.compaction) {
    const compacted = await projectCompaction(history, {
      marker: MARKER,
      keepRecentTurns: 2,
      summarize: async () => 'earlier turns summary',
    })
    if (compacted) messages = compacted.messages
  }
  if (switches.cap) messages = projectHardCap(messages, 4_000).messages
  if (switches.retire) messages = retireOldPageReads(messages, false)
  return messages
}

function rawPageReads(messages: readonly WireMessage[]): number {
  return messages.filter(
    (message) =>
      message.role === 'tool' &&
      TOOLS.includes(String((message as { name?: string }).name)) &&
      !String(message.content).includes('"retired":true'),
  ).length
}

const COMBOS: Switches[] = [false, true].flatMap((compaction) =>
  [false, true].flatMap((retire) => [false, true].map((cap) => ({ compaction, retire, cap }))),
)

describe('request projection combination matrix', () => {
  for (const switches of COMBOS) {
    const label = `compaction=${switches.compaction} retire=${switches.retire} cap=${switches.cap}`

    it(`keeps the transcript immutable and retirement effective (${label})`, async () => {
      const history = seeded()
      // Cheap digest instead of a deep equal against a growing array each round.
      const seededCount = history.length
      const snapshot = JSON.stringify(history)
      const sizes: number[] = []
      // Structural switches only: few rounds keep the matrix fast. Growth over
      // 100 rounds is asserted in `agent-request-pipeline.spec.ts`, which runs
      // the real loop (this helper re-summarizes every round, unlike the loop).
      const rounds = 2

      for (let round = 0; round < rounds; round += 1) {
        appendRound(history, round)
        const messages = await project(history, switches)
        sizes.push(JSON.stringify(messages).length)

        // The transcript (what storage persists) is never rewritten. Only the
        // seeded prefix exists at this point; later rounds append after it.
        expect(JSON.stringify(history.slice(0, seededCount))).toBe(snapshot)
        // Retirement always leaves at most one raw page read in the request.
        if (switches.retire) expect(rawPageReads(messages)).toBeLessThanOrEqual(1)
        // A hard cap on a page read cannot make it un-retirable. The single
        // read kept raw may itself be the capped one, so at most ONE truncated
        // read may survive — never the accumulating backlog that regressed.
        if (switches.retire && switches.cap) {
          const truncatedReads = messages.filter(
            (message) =>
              message.role === 'tool' &&
              TOOLS.includes(String((message as { name?: string }).name)) &&
              String(message.content).includes('\u2026[context-truncated]'),
          )
          expect(truncatedReads.length).toBeLessThanOrEqual(1)
        }
      }

      // Retirement must keep the projection from compounding (the 100-round
      // increment bound lives in the real-loop test).
      if (switches.retire) {
        expect(sizes.at(-1)!).toBeLessThan(sizes[0]! * 3)
      }
    })
  }
})
