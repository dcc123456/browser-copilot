// @vitest-environment jsdom
/**
 * Page-harness contract for the helpers advertised in the javascript-code
 * block: every catalogue entry must have a probe, and the probe must run
 * through the real injected kernel (`runWorkflowJs`). The reset probe proves
 * the timer is actually re-armed, not just that the name exists.
 */
import { describe, expect, it } from 'vitest'
import { CODE_NODE_HELPERS } from '../src/lib/workflow/code-node-helpers'
import { runWorkflowJs } from '../src/inpage/kernel'
import { CODE_NODE_HELPER_PROBES } from './code-node-helper-probes'

describe('javascript-code helper contract — page harness', () => {
  it('has a probe for every advertised helper', () => {
    expect(Object.keys(CODE_NODE_HELPER_PROBES).sort()).toEqual(
      CODE_NODE_HELPERS.map((helper) => helper.name).sort(),
    )
  })

  for (const [name, probe] of Object.entries(CODE_NODE_HELPER_PROBES)) {
    it(`defines and runs ${name}`, async () => {
      const result = await runWorkflowJs({
        code: probe.code,
        variables: probe.variables ?? {},
        timeout: 5000,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data).toEqual(probe.expectedResult)
      if (probe.expectedVariables) {
        expect(result.variables).toMatchObject(probe.expectedVariables)
      }
    })
  }

  it('automaResetTimeout re-arms the execution timer', async () => {
    // Total run time (1300ms) exceeds the timeout (1000ms); the reset at
    // ~650ms re-arms it to ~1650ms. Without a working reset the block would
    // be killed at 1000ms.
    const result = await runWorkflowJs({
      code: [
        'const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
        'await wait(650)',
        'automaResetTimeout()',
        'await wait(650)',
        "automaNextBlock('finished')",
      ].join('\n'),
      timeout: 1000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBe('finished')
  })
})
