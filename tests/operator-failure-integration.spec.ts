import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) {
            if (store.has(key)) out[key] = store.get(key)
          }
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
        remove: async () => {},
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
})

import { actionNodesOf, getDraftSnapshot } from '../src/background/operator-tool-handler'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'

const signal = new AbortController().signal

function run(
  conversationId: string,
  name: string,
  args: Record<string, unknown>,
  executors: Record<string, BlockExecutor> = {},
) {
  return runOperatorToolWithExecution({
    name,
    args,
    conversationId,
    signal,
    executors: {
      'event-click': async () => null,
      forms: async () => null,
      'press-key': async () => null,
      'javascript-code': async () => null,
      ...executors,
    },
  })
}

/**
 * A failed operator call used to hand the model nothing but an error string,
 * and the three ways a step can fail — the target was never there, an earlier
 * step left the page wrong, the target was there but unclickable — collapsed
 * into the same text. The evidence bundle gives each failure its own name, so
 * the model can act on the diagnosis instead of guessing.
 */
describe('a failed operator call reports evidence, not just text', () => {
  it('names the failure class when the action itself failed', async () => {
    const out = await run(
      'f1',
      'wf_op_event-click',
      { selector: '#gone' },
      {
        'event-click': async () => {
          throw new Error('LOCATOR_NOT_FOUND: no element matched "#gone"')
        },
      },
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('LOCATOR_NOT_FOUND')
    expect(out.evidence?.failureCode).toBe('LOCATOR_NOT_FOUND')
    expect(out.evidence?.category).toBe('locator')
    expect(out.evidence?.failureHint).toBeTruthy()
    expect(out.evidence?.errorMessage).toContain('LOCATOR_NOT_FOUND')
  })

  it('names the failure class when a required parameter is missing', async () => {
    const out = await run('f2', 'wf_op_press-key', {})

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.evidence?.failureCode).toBe('VALIDATION_FAILED')
    expect(out.evidence?.category).toBe('workflow')
  })

  it('names the permission refusal when the script gate rejects the call', async () => {
    const out = await run('f3', 'wf_op_javascript-code', { code: 'window.__APP__.token' })

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.evidence?.failureCode).toBe('PERMISSION_DENIED')
    // A refused call leaves no trace in the draft — not even a created one.
    expect(getDraftSnapshot('f3')).toBeUndefined()
  })

  it('names the locator failure when the ref no longer resolves', async () => {
    const out = await run('f4', 'wf_op_event-click', { ref: 'gone-from-the-snapshot' })

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.evidence?.failureCode).toBe('LOCATOR_NOT_FOUND')
  })

  it('carries no evidence on a success', async () => {
    const out = await run('f5', 'wf_op_event-click', { selector: '#go' })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect('evidence' in out).toBe(false)
  })
})

/**
 * The re-run boundary is the other half of the bundle: it tells the model
 * which step it may repeat. A step that only filled a field committed nothing,
 * so it can be replayed; the step after it may not.
 */
describe('the failure evidence names the safe re-run boundary', () => {
  it('points at the last step that committed nothing', async () => {
    const filled = await run('f6', 'wf_op_forms', {
      selector: '#title',
      value: '标题',
      description: '填写标题',
    })
    expect(filled.ok).toBe(true)
    const recorded = actionNodesOf(getDraftSnapshot('f6')!).at(-1)!

    const out = await run(
      'f6',
      'wf_op_event-click',
      { selector: '#publish' },
      {
        'event-click': async () => {
          throw new Error('READINESS_TIMEOUT(visible): 元素尚未可见')
        },
      },
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.evidence?.safeRerunBoundary?.nodeId).toBe(recorded.id)
    expect(out.evidence?.safeRerunBoundary?.label).toBe('forms')
  })

  it('has no boundary when the chain holds nothing that may be replayed', async () => {
    const out = await run(
      'f7',
      'wf_op_event-click',
      { selector: '#gone' },
      {
        'event-click': async () => {
          throw new Error('LOCATOR_NOT_FOUND: nothing matched')
        },
      },
    )

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.evidence?.safeRerunBoundary).toBeUndefined()
  })
})
