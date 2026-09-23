import { describe, expect, it, vi } from 'vitest'

/**
 * The javascript-code executor must fail when the script RETURNS a failure
 * envelope, not only when it throws. Regression test for:
 *
 *   return { success: false, message: '未找到上传图文元素' }
 *
 * which used to be treated as success, so later blocks ran even though the
 * click target was never reached and the workflow goal did not complete.
 *
 * No chrome.scripting bridge here, so the executor takes its local-evaluation
 * fallback — the same envelope rule applies on both paths.
 */
function chromeWithoutScripting() {
  return {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    // No `scripting`: forces the local-eval fallback.
  }
}

vi.stubGlobal('chrome', chromeWithoutScripting())

import { EXECUTORS } from '../src/background/workflow-engine/executors'

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  } as never
}

describe('javascript-code failure envelope', () => {
  const executor = EXECUTORS['javascript-code']!

  it('throws when the script returns { success:false, message }', async () => {
    await expect(
      executor(
        {
          code: "return { success: false, message: '未找到上传图文元素' }",
          timeout: 5000,
        },
        ctx(),
      ),
    ).rejects.toThrow('未找到上传图文元素')
  })

  it('throws when the script returns { ok:false }', async () => {
    await expect(
      executor({ code: 'return { ok: false }', timeout: 5000 }, ctx()),
    ).rejects.toThrow(/failure/)
  })

  it('still succeeds for { success:true }', async () => {
    await expect(
      executor({ code: 'return { success: true }', timeout: 5000 }, ctx()),
    ).resolves.toBeNull()
  })

  it('still succeeds for a plain return value', async () => {
    await expect(
      executor({ code: 'return 42', timeout: 5000 }, ctx()),
    ).resolves.toBeNull()
  })
})
