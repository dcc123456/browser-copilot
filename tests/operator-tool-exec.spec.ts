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

import { getDraftSnapshot } from '../src/background/operator-tool-handler'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import { actionNodesOf } from '../src/background/operator-tool-handler'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'
import type { SnapshotTargetEntry } from '../src/lib/workflow/target-to-selector'

const signal = new AbortController().signal

/** A registry where every page action succeeds and records what it received. */
function okExecutors(overrides: Record<string, BlockExecutor> = {}) {
  const calls: { blockId: string; data: Record<string, unknown> }[] = []
  const executors: Record<string, BlockExecutor> = {}
  const record =
    (blockId: string): BlockExecutor =>
    async (data) => {
      calls.push({ blockId, data })
      return null
    }
  for (const id of [
    'event-click',
    'forms',
    'press-key',
    'new-tab',
    'switch-tab',
    'javascript-code',
    'get-secret',
    'set-variable',
    'element-scroll',
  ]) {
    executors[id] = record(id)
  }
  return { calls, executors: { ...executors, ...overrides } }
}

function run(
  conversationId: string,
  name: string,
  args: Record<string, unknown>,
  extra: {
    executors?: Record<string, BlockExecutor>
    snapshotTargets?: ReadonlyMap<string, SnapshotTargetEntry>
  } = {},
) {
  return runOperatorToolWithExecution({
    name,
    args,
    conversationId,
    signal,
    ...(extra.executors ? { executors: extra.executors } : {}),
    ...(extra.snapshotTargets ? { snapshotTargets: extra.snapshotTargets } : {}),
  })
}

describe('operator calls really operate the page', () => {
  it('runs the block and records exactly one node on success', async () => {
    const { calls, executors } = okExecutors()
    const out = await run('c1', 'wf_op_event-click', { selector: '#go' }, { executors })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.executed).toBe(true)
    expect(out.workflowSize).toBe(1)
    // The executor receives the canonical flat shape the replay would use
    // (`selector` + `findBy`); `blockId` is added when the node is recorded.
    expect(calls).toEqual([
      { blockId: 'event-click', data: { selector: '#go', findBy: 'cssSelector' } },
    ])

    const draft = getDraftSnapshot('c1')!
    expect(actionNodesOf(draft).map((n) => n.data.blockId)).toEqual(['event-click'])
  })

  it('records nothing when the action fails, and says why', async () => {
    const executors: Record<string, BlockExecutor> = {
      'event-click': async () => {
        throw new Error('no element matched "#gone"')
      },
    }
    const out = await run('c2', 'wf_op_event-click', { selector: '#gone' }, { executors })

    expect(out).toEqual({ ok: false, error: 'no element matched "#gone"' })
    // The draft keeps only its trigger head — a failed step leaves no trace.
    const draft = getDraftSnapshot('c2')!
    expect(actionNodesOf(draft)).toHaveLength(0)
    expect(draft.edges).toHaveLength(0)
  })

  it('rejects an unknown operator tool', async () => {
    const out = await run('c3', 'click', { selector: '#x' })
    expect(out.ok).toBe(false)
  })

  it('refuses a call with no locator and records nothing', async () => {
    // The empty-selector defect: element-exists with no locator used to report
    // 元素不存在, read as success, and record an empty node. The gate refuses
    // before the executor can succeed at nothing.
    const { calls, executors } = okExecutors({
      'element-exists': async () => null,
    })
    const out = await run('c-refuse-locator', 'wf_op_element-exists', {}, { executors })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('selector')
    expect(calls).toEqual([])
    expect(actionNodesOf(getDraftSnapshot('c-refuse-locator')!)).toHaveLength(0)
  })

  it('refuses a key-less press-key and a url-less new-tab', async () => {
    const { calls, executors } = okExecutors()

    const noKey = await run('c-refuse-key', 'wf_op_press-key', { selector: '#x' }, { executors })
    expect(noKey.ok).toBe(false)

    const noUrl = await run('c-refuse-url', 'wf_op_new-tab', {}, { executors })
    expect(noUrl.ok).toBe(false)

    // Neither touched its executor, so neither could "succeed" at nothing.
    expect(calls).toEqual([])
  })

  it('refuses a url-less webhook even though webhook never executes', async () => {
    const { executors } = okExecutors()
    const out = await run('c-refuse-webhook', 'wf_op_webhook', {}, { executors })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('url')
    expect(actionNodesOf(getDraftSnapshot('c-refuse-webhook')!)).toHaveLength(0)
  })

  it('accepts the same calls once the required parameters are present', async () => {
    const { executors } = okExecutors({
      'element-exists': async () => null,
    })
    const exists = await run(
      'c-ok-locator',
      'wf_op_element-exists',
      { selector: '#maybe' },
      { executors },
    )
    expect(exists.ok).toBe(true)

    const press = await run('c-ok-key', 'wf_op_press-key', { keys: 'Enter' }, { executors })
    expect(press.ok).toBe(true)
  })
})

describe('locator resolution', () => {
  it('records a canonical flat selector alongside the rich target', async () => {
    const { executors } = okExecutors()
    await run(
      'c4',
      'wf_op_event-click',
      {
        target: {
          primary: { how: 'role', value: 'button' },
          fallbacks: [{ how: 'testid', value: 'save' }],
        },
      },
      { executors },
    )
    const node = actionNodesOf(getDraftSnapshot('c4')!)[0]!
    // role/text cannot be CSS-expressible, so the fallback carries the selector
    // while the rich target stays for the kernel to fall back on.
    expect(node.data.selector).toBe('[data-testid="save"]')
    expect(node.data.findBy).toBe('cssSelector')
    expect(node.data.target).toEqual({
      primary: { how: 'role', value: 'button' },
      fallbacks: [{ how: 'testid', value: 'save' }],
    })
  })

  it('resolves a snapshot ref into the durable target and drops the ref', async () => {
    const { executors } = okExecutors()
    const snapshotTargets = new Map<string, SnapshotTargetEntry>([
      [
        'e7',
        {
          name: 'Submit',
          target: { primary: { how: 'css', value: '#submit' }, fallbacks: [] },
        },
      ],
    ])
    await run('c5', 'wf_op_event-click', { ref: 'e7' }, { executors, snapshotTargets })

    const node = actionNodesOf(getDraftSnapshot('c5')!)[0]!
    expect(node.data.selector).toBe('#submit')
    expect(node.data.target).toEqual({ primary: { how: 'css', value: '#submit' }, fallbacks: [] })
    expect(node.data.label).toBe('Submit')
    // The short-lived ref must not leak into the saved workflow.
    expect(node.data).not.toHaveProperty('ref')
  })

  it('does not inject a selector into a block that takes no element', async () => {
    const { executors } = okExecutors()
    await run('c6', 'wf_op_press-key', { key: 'Enter', ref: 'e1' }, { executors })
    const node = actionNodesOf(getDraftSnapshot('c6')!)[0]!
    expect(node.data).toEqual({ key: 'Enter', blockId: 'press-key' })
  })
})

describe('record-only operators', () => {
  it('records the node without running it and explains why', async () => {
    const { calls, executors } = okExecutors({ webhook: async () => null })
    const out = await run('c7', 'wf_op_webhook', { url: 'https://x.test' }, { executors })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.executed).toBe(false)
    expect(out.note).toContain('without sending the request')
    expect(calls).toEqual([])
    // Still recorded, so the user can review and edit it.
    expect(actionNodesOf(getDraftSnapshot('c7')!)).toHaveLength(1)
  })

  it('records a loop block without running it', async () => {
    const { executors } = okExecutors({ 'loop-elements': async () => null })
    const out = await run('c8', 'wf_op_loop-elements', { selector: '.row' }, { executors })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.executed).toBe(false)
    expect(out.note).toContain('engine')
  })
})

describe('branch recording', () => {
  it('hangs the next node off the port the branch block actually took', async () => {
    const executors: Record<string, BlockExecutor> = {
      'element-exists': async (_data, ctx) => ctx.outputs?.['notExists'] ?? null,
      'event-click': async () => null,
    }

    const first = await run('c9', 'wf_op_element-exists', { selector: '#maybe' }, { executors })
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.branch).toBe('output-2')

    await run('c9', 'wf_op_event-click', { selector: '#fallback' }, { executors })

    const draft = getDraftSnapshot('c9')!
    const click = actionNodesOf(draft)[1]!
    expect(draft.edges.find((e) => e.target === click.id)?.sourceHandle).toBe(
      'element-exists-output-2',
    )
  })

  it('honours an explicit next hint on a non-branch block', async () => {
    const { executors } = okExecutors()
    await run('c10', 'wf_op_event-click', { selector: '#a', next: 'false' }, { executors })
    await run('c10', 'wf_op_event-click', { selector: '#b' }, { executors })

    const draft = getDraftSnapshot('c10')!
    const second = actionNodesOf(draft)[1]!
    expect(draft.edges.find((e) => e.target === second.id)?.sourceHandle).toBe(
      'event-click-output-2',
    )
  })

  it('ignores a nonsense next hint instead of inventing a port', async () => {
    const { executors } = okExecutors()
    await run('c11', 'wf_op_event-click', { selector: '#a', next: 'sideways' }, { executors })
    await run('c11', 'wf_op_event-click', { selector: '#b' }, { executors })

    const draft = getDraftSnapshot('c11')!
    const second = actionNodesOf(draft)[1]!
    expect(draft.edges.find((e) => e.target === second.id)?.sourceHandle).toBe(
      'event-click-output-1',
    )
  })
})

describe('shared variable bag', () => {
  it('resolves an earlier block output into a later call without persisting it', async () => {
    const executors: Record<string, BlockExecutor> = {
      'get-secret': async (_data, ctx) => {
        ctx.variables['password'] = 's3cret'
        return null
      },
      forms: async (data) => {
        // The bridge interpolates before handing params to the executor.
        if (data.value !== 's3cret') throw new Error(`unresolved: ${String(data.value)}`)
        return null
      },
    }

    await run(
      'c12',
      'wf_op_get-secret',
      { credential: 'cred-1::password', variableName: 'password' },
      { executors },
    )
    const out = await run(
      'c12',
      'wf_op_forms',
      { selector: '#pw', value: '{{password}}' },
      { executors },
    )
    expect(out.ok).toBe(true)

    const draft = getDraftSnapshot('c12')!
    // The resolved credential stays in a SESSION bag, never in the draft: the
    // draft is mirrored to extension storage and rendered in the review card,
    // so a value there would outlive the generation that resolved it.
    expect(draft.variables).toEqual({})
    // The NODE keeps the token, so the replay resolves it at run time instead
    // of baking the secret into the saved workflow.
    const forms = actionNodesOf(draft)[1]!
    expect(forms.data.value).toBe('{{password}}')
  })
})
