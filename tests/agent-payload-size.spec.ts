import { describe, expect, it } from 'vitest'
import { advertiseTools, TOOLS } from '../src/background/agent'
import { buildSystemPrompt } from '../src/background/agent'

/**
 * Pins the size of the FIRST-round agent payload. Every turn re-sends the
 * system prompt + advertised tool schemas, so bloated descriptions are paid on
 * every single round of every conversation. The advertised set is what a fresh
 * full-auto conversation sends (core tools + the load_tools loader, before any
 * on-demand group is loaded). When you add a tool or expand descriptions,
 * raise the budget deliberately — and prefer deleting duplicated prose over
 * growing it (see the slimming notes on each schema).
 */
const MAX_ADVERTISED_PAYLOAD_CHARS = 17_500
/** The full catalog (core + every on-demand group) must also stay bounded. */
const MAX_CATALOG_CHARS = 19_500

describe('first-turn agent payload size (full auto)', () => {
  it('stays under the advertised-payload budget', () => {
    const system = buildSystemPrompt({ mode: 'full' })
    const tools = JSON.stringify(advertiseTools({ mode: 'full' }))
    // eslint-disable-next-line no-console
    console.log(
      `[payload-size] advertised: system=${system.length} tools=${tools.length} ` +
        `total=${system.length + tools.length} chars (~${Math.round((system.length + tools.length) / 3.3)} tokens @ ~3.3 chars/token)`,
    )
    expect(system.length + tools.length).toBeLessThanOrEqual(MAX_ADVERTISED_PAYLOAD_CHARS)
  })

  it('keeps the full tool catalog bounded', () => {
    const catalog = JSON.stringify(TOOLS).length
    // eslint-disable-next-line no-console
    console.log(`[payload-size] full catalog (all groups): ${catalog} chars`)
    expect(catalog).toBeLessThanOrEqual(MAX_CATALOG_CHARS)
  })
})
