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
    scripting: {
      executeScript: vi.fn(),
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
})

import {
  parseSerializedSpec,
  selectorAfterExecution,
} from '../src/lib/workflow/target-to-selector'
import type { RecordedLocator } from '../src/lib/workflow/target-to-selector'
import {
  resetSelectorTraces,
  selectorTraces,
  selectorTracesOf,
  SELECTOR_TRACE_PREFIX,
} from '../src/background/selector-trace'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import { getDraftSnapshot } from '../src/background/operator-tool-handler'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'

const signal = new AbortController().signal

beforeEach(() => {
  resetSelectorTraces()
})

describe('parseSerializedSpec — kernel spec inverse bridge', () => {
  it('parses a plain how|value spec', () => {
    expect(parseSerializedSpec('css|div > button')).toEqual({
      how: 'css',
      value: 'div > button',
    })
  })

  it('parses role/tag/nth suffixes', () => {
    expect(parseSerializedSpec('role|上传图文|role=button|tag=div|nth=2')).toEqual({
      how: 'role',
      value: '上传图文',
      role: 'button',
      tag: 'div',
      nth: 2,
    })
  })

  it('keeps a pipe-free value containing selector characters intact', () => {
    const out = parseSerializedSpec('id|a.b:c')
    expect(out?.value).toBe('a.b:c')
  })

  it('rejects malformed text', () => {
    expect(parseSerializedSpec('nope')).toBeNull()
    expect(parseSerializedSpec('|value')).toBeNull()
  })
})

describe('selectorAfterExecution — record what really worked', () => {
  const locator: RecordedLocator = {
    selector: 'div.generic > span.path',
    target: {
      primary: { how: 'css' as const, value: '.precise' },
      fallbacks: [
        { how: 'id' as const, value: 'uploadBtn' },
        { how: 'role' as const, value: '上传图文', role: 'button' },
      ],
    },
  }

  it('records the exact executed CSS selector verbatim, never a generic candidate', () => {
    const out = selectorAfterExecution({
      usedSpec: 'css|.precise',
      locator,
      countOf: (s) => (s === '.precise' ? 1 : 3),
    })
    expect(out).toEqual({ selector: '.precise', verified: true })
  })

  it('records an executed id spec as its #id CSS form', () => {
    const out = selectorAfterExecution({
      usedSpec: 'id|uploadBtn',
      locator,
      countOf: (s) => (s === '#uploadBtn' ? 1 : 0),
    })
    expect(out.selector).toBe('#uploadBtn')
    expect(out.verified).toBe(true)
  })

  it('marks an executed selector unverified when it matches several', () => {
    const out = selectorAfterExecution({
      usedSpec: 'css|.precise',
      locator,
      countOf: () => 4,
    })
    expect(out).toEqual({ selector: '.precise', verified: false })
  })

  it('falls back to a proven-unique CSS candidate when the executed spec was role/text', () => {
    const out = selectorAfterExecution({
      usedSpec: 'role|上传图文|role=button',
      locator,
      countOf: (s) => (s === '#uploadBtn' ? 1 : s === 'div.generic > span.path' ? 2 : 0),
    })
    // The id candidate is the highest-scored exact-one — not the positional path.
    expect(out).toEqual({ selector: '#uploadBtn', verified: true })
  })

  it('records NO flat selector when only role/text worked and nothing CSS is unique', () => {
    const roleOnlyLocator: RecordedLocator = {
      selector: '',
      target: {
        primary: { how: 'role' as const, value: '上传图文', role: 'button' },
        fallbacks: [],
      },
    }
    const out = selectorAfterExecution({
      usedSpec: 'role|上传图文|role=button',
      locator: roleOnlyLocator,
      countOf: () => 0,
    })
    expect(out).toEqual({ selector: '', verified: false })
  })
})

describe('operator calls record the executed locator', () => {
  /**
   * An executor that goes through the real `runRaw` shape cannot be used
   * without a live page, so simulate what runRaw does: populate the ctx's
   * lastResolution while succeeding.
   */
  function resolutionExecutor(usedSpec: string): BlockExecutor {
    return async (_data, ctx) => {
      ctx.lastResolution = { usedSpec, usedFallback: false, matched: 1 }
      return null
    }
  }

  it('records the precise executed selector rather than a pre-execution generic one', async () => {
    const executors = {
      'event-click': resolutionExecutor('css|.precise-selector'),
    }
    const out = await runOperatorToolWithExecution({
      name: 'wf_op_event-click',
      // The model gives BOTH: a generic positional path is what the pre-
      // execution probe used to prefer; the executed spec is the truth.
      args: {
        target: {
          primary: { how: 'css', value: 'div.wrapper > span.generic' },
          fallbacks: [{ how: 'css', value: '.precise-selector' }],
        },
      },
      conversationId: 'c-precise',
      signal,
      executors,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const draft = getDraftSnapshot('c-precise')!
    const node = draft.nodes.find((n) => n.data['blockId'] === 'event-click')!
    expect(node.data['selector']).toBe('.precise-selector')
    expect(node.data['selectorVerified']).toBe(true)
  })

  it('records the executed id selector in #id form', async () => {
    const executors = {
      'event-click': (async (_data: unknown, ctx: { lastResolution?: unknown }) => {
        ctx.lastResolution = {
          usedSpec: 'id|uploadTrigger',
          usedFallback: false,
          matched: 1,
        }
        return null
      }) as BlockExecutor,
    }
    const out = await runOperatorToolWithExecution({
      name: 'wf_op_event-click',
      args: {
        target: {
          primary: { how: 'id', value: 'uploadTrigger' },
          fallbacks: [],
        },
      },
      conversationId: 'c-id',
      signal,
      executors,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const draft = getDraftSnapshot('c-id')!
    const node = draft.nodes.find((n) => n.data['blockId'] === 'event-click')!
    expect(node.data['selector']).toBe('#uploadTrigger')
  })
})

describe('selector trace ring', () => {
  it('keeps no traces until calls commit', () => {
    expect(selectorTraces()).toHaveLength(0)
  })

  it('retains one trace per committed call with raw and chosen stages', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const executors = {
      'event-click': (async (_data: unknown, ctx: { lastResolution?: unknown }) => {
        ctx.lastResolution = {
          usedSpec: 'css|.exact',
          usedFallback: false,
          matched: 1,
        }
        return null
      }) as BlockExecutor,
    }
    await runOperatorToolWithExecution({
      name: 'wf_op_event-click',
      args: {
        target: {
          primary: { how: 'css', value: '.exact' },
          fallbacks: [],
        },
      },
      conversationId: 'c-trace',
      signal,
      executors,
    })

    const traces = selectorTracesOf('c-trace')
    expect(traces).toHaveLength(1)
    const trace = traces[0]!
    expect(trace.toolName).toBe('wf_op_event-click')
    expect(trace.blockId).toBe('event-click')
    expect(trace.ok).toBe(true)
    expect(trace.raw.targetPrimary).toBe('css|.exact')
    expect(trace.resolved?.hasTarget).toBe(true)
    expect(trace.chosen).toEqual({ selector: '.exact', verified: true })
    expect(trace.executed).toEqual({
      usedSpec: 'css|.exact',
      usedFallback: false,
      matched: 1,
    })

    // The console line carries the prefix and the raw/recorded/executed chain.
    const lines = infoSpy.mock.calls.map((call) => String(call[0]))
    const main = lines.find((line) => line.includes(`${SELECTOR_TRACE_PREFIX} wf_op_event-click`))
    expect(main).toBeTruthy()
    expect(main).toContain('OK')
    expect(main).toContain('.exact')
    infoSpy.mockRestore()
  })

  it('commits a failure trace with the error when execution fails', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const executors = {
      'event-click': async () => {
        throw new Error('no element matched')
      },
    }
    const out = await runOperatorToolWithExecution({
      name: 'wf_op_event-click',
      args: { selector: '#gone' },
      conversationId: 'c-fail',
      signal,
      executors,
    })
    expect(out.ok).toBe(false)
    const traces = selectorTracesOf('c-fail')
    expect(traces).toHaveLength(1)
    expect(traces[0]!.ok).toBe(false)
    expect(traces[0]!.error).toBe('no element matched')
    expect(traces[0]!.raw.selector).toBe('#gone')
    infoSpy.mockRestore()
  })
})
