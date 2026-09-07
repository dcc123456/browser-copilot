import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, TOOLS } from '../src/background/agent'

/**
 * Pins the size of the FIRST-round agent payload (system prompt + advertised
 * tool schemas). Every turn re-sends this prefix, so bloated descriptions are
 * paid on every single round of every conversation mode. When you add a tool
 * or expand descriptions, raise the budget deliberately — and prefer deleting
 * duplicated prose over growing it (see the slimming notes on each schema).
 */
const MAX_PAYLOAD_CHARS = 22_000

function firstTurnFullPayloadChars(): { system: number; tools: number; total: number } {
  const system = buildSystemPrompt({ mode: 'full' })
  const tools = JSON.stringify(TOOLS)
  return { system: system.length, tools: tools.length, total: system.length + tools.length }
}

describe('first-turn agent payload size (full auto)', () => {
  it('stays under the payload budget', () => {
    const { system, tools, total } = firstTurnFullPayloadChars()
    // eslint-disable-next-line no-console
    console.log(
      `[payload-size] system=${system} tools=${tools} total=${total} chars ` +
        `(~${Math.round(total / 3.7)} tokens @ ~3.7 chars/token)`,
    )
    expect(total).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS)
  })
})
