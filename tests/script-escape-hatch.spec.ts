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

import {
  actionNodesOf,
  getDraftSnapshot,
  runOperatorTool,
} from '../src/background/operator-tool-handler'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'
import {
  MIN_SCRIPT_JUSTIFICATION_CHARS,
  OPERATOR_BLOCK_IDS,
  WORKFLOW_ACTION_OPERATOR_IDS,
  WORKFLOW_AUTHOR_OPERATOR_IDS,
  scriptJustification,
} from '../src/lib/workflow/operator-tools'

/**
 * `javascript-code` is the one escape hatch, and the rule that governs it is
 * the whole point of the feature: a generated workflow has to stay editable by
 * someone who does not read code, so a script may only be recorded when the
 * model can say why no declarative operator could do the step.
 *
 * These tests pin BOTH halves of that: the gate refuses an unjustified call
 * (recording nothing at all), and an accepted call keeps its reason attached
 * to the node so the user can still judge it later.
 */
const signal = new AbortController().signal

function okExecutors(overrides: Record<string, BlockExecutor> = {}) {
  const calls: { blockId: string; data: Record<string, unknown> }[] = []
  const record =
    (blockId: string): BlockExecutor =>
    async (data) => {
      calls.push({ blockId, data })
      return null
    }
  return {
    calls,
    executors: {
      'event-click': record('event-click'),
      'javascript-code': record('javascript-code'),
      ...overrides,
    },
  }
}

function run(conversationId: string, name: string, args: Record<string, unknown>) {
  const { calls, executors } = okExecutors()
  return runOperatorToolWithExecution({ name, args, conversationId, signal, executors }).then(
    (out) => ({ out, calls }),
  )
}

const JUSTIFICATION =
  'Tried get-text and attribute-value, but the value only exists in the page\u2019s own state object (window.__APP__.token), which no operator can read.'

describe('scriptJustification', () => {
  it('rejects a missing, empty or one-word answer', () => {
    expect(scriptJustification({})).toBeNull()
    expect(scriptJustification({ justification: '' })).toBeNull()
    expect(scriptJustification({ justification: '   ' })).toBeNull()
    expect(scriptJustification({ justification: 'needed' })).toBeNull()
    expect(scriptJustification({ justification: 42 })).toBeNull()
  })

  it('accepts and trims a real reason', () => {
    expect(scriptJustification({ justification: `  ${JUSTIFICATION}  ` })).toBe(JUSTIFICATION)
    expect(scriptJustification({ justification: 'x'.repeat(MIN_SCRIPT_JUSTIFICATION_CHARS) })).toBe(
      'x'.repeat(MIN_SCRIPT_JUSTIFICATION_CHARS),
    )
  })
})

describe('the escape hatch is gated at the call site', () => {
  it('refuses a script with no justification and records nothing', async () => {
    const { out, calls } = await run('esc1', 'wf_op_javascript-code', {
      code: 'window.__APP__.token',
    })

    expect(out.ok).toBe(false)
    if (out.ok) return
    // The refusal has to name the ladder, otherwise the model just retries.
    expect(out.error).toContain('justification')
    expect(out.error).toContain('get-text')
    // Nothing ran, and no node exists — a refused call must not leave a trace
    // in the draft, not even an empty one.
    expect(calls).toEqual([])
    expect(getDraftSnapshot('esc1')).toBeUndefined()
  })

  it('refuses a justification that is too short to be a reason', async () => {
    const { out, calls } = await run('esc2', 'wf_op_javascript-code', {
      code: 'window.__APP__.token',
      justification: 'easier',
    })

    expect(out.ok).toBe(false)
    expect(calls).toEqual([])
    expect(getDraftSnapshot('esc2')).toBeUndefined()
  })

  it('accepts a justified script, runs it, and keeps the reason on the node', async () => {
    const { out, calls } = await run('esc3', 'wf_op_javascript-code', {
      code: 'return window.__APP__.token',
      justification: JUSTIFICATION,
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.executed).toBe(true)
    expect(out.scriptJustification).toBe(JUSTIFICATION)
    // The block really ran with the model's parameters.
    expect(calls.map((c) => c.blockId)).toEqual(['javascript-code'])

    const node = actionNodesOf(getDraftSnapshot('esc3')!).at(-1)!
    expect(node.data.blockId).toBe('javascript-code')
    // The reason is what the user reads on the canvas card, so it has to
    // survive into the recorded node...
    expect(node.data.description).toBe(JUSTIFICATION)
    // ...and must not be stored as a block parameter of its own.
    expect(node.data).not.toHaveProperty('justification')
  })

  it('accepts a documented capabilityGap in place of a justification', async () => {
    const { out, calls } = await run('esc5', 'wf_op_javascript-code', {
      code: 'automaSetVariable("generatedImage", canvas.toDataURL())',
      capabilityGap: {
        missingCapability: 'generate a canvas PNG via toDataURL',
        triedOperators: ['get-text', 'forms', 'event-click'],
        whyInsufficient:
          'No declarative operator can draw on a canvas or produce a binary image.',
        expectedResult: 'A data URL string is stored as the generatedImage variable.',
      },
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.executed).toBe(true)
    expect(calls.map((c) => c.blockId)).toEqual(['javascript-code'])
    const node = actionNodesOf(getDraftSnapshot('esc5')!).at(-1)!
    // The gap becomes the node description so the reason survives the save.
    expect(node.data.description).toContain('canvas PNG')
    expect(node.data).not.toHaveProperty('capabilityGap')
  })

  it('keeps the model’s own description when it wrote one', async () => {
    const { out } = await run('esc4', 'wf_op_javascript-code', {
      code: 'return window.__APP__.token',
      justification: JUSTIFICATION,
      description: '读取页面内部 token',
    })

    expect(out.ok).toBe(true)
    const node = actionNodesOf(getDraftSnapshot('esc4')!).at(-1)!
    expect(node.data.description).toBe('读取页面内部 token')
  })

  it('does not gate the declarative operators', async () => {
    const { out, calls } = await run('esc5', 'wf_op_event-click', { selector: '#go' })

    expect(out.ok).toBe(true)
    expect(calls.map((c) => c.blockId)).toEqual(['event-click'])
  })

  it('applies the same rule on the non-executing recording path', async () => {
    const refused = await runOperatorTool({
      name: 'wf_op_javascript-code',
      args: { code: 'x' },
      conversationId: 'esc6',
    })
    expect(refused.ok).toBe(false)

    const accepted = await runOperatorTool({
      name: 'wf_op_javascript-code',
      args: { code: 'x', justification: JUSTIFICATION },
      conversationId: 'esc6',
    })
    expect(accepted.ok).toBe(true)
  })
})

/**
 * The availability half. The gate above only matters because the model has to
 * ask for the block at all; if it were advertised next to `event-click`, the
 * refusal would just teach it to always attach a boilerplate justification.
 */
describe('the escape hatch is not part of the declarative surface', () => {
  it('is absent from both advertised tiers and present in the catalog', () => {
    expect(OPERATOR_BLOCK_IDS).toContain('javascript-code')
    expect(WORKFLOW_ACTION_OPERATOR_IDS).not.toContain('javascript-code')
    expect(WORKFLOW_AUTHOR_OPERATOR_IDS).not.toContain('javascript-code')
  })
})
