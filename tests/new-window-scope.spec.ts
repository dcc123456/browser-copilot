import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

/**
 * The `new-window` block's contract is "the steps after me run in the window I
 * opened". That only holds if the block hands the new window (and its active
 * tab) back to the engine, so these tests pin both halves: the block re-points
 * the ctx, and the chrome call it makes is scoped to the window it created.
 */
function makeChromeMock() {
  const create = vi.fn(async () => ({ id: 42 }))
  const query = vi.fn(async () => [{ id: 7 }])
  return {
    chrome: { windows: { create }, tabs: { query } },
    refs: { create, query },
  }
}

function makeCtx() {
  const setScope = vi.fn()
  const setTab = vi.fn()
  const ctx: WorkflowExecCtx = {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    scope: { windowId: 7 },
    tabId: 3,
    setScope,
    setTab,
    emit: () => {},
  }
  return { ctx, setScope, setTab }
}

describe('new-window block', () => {
  let chromeRefs: ReturnType<typeof makeChromeMock>['refs']

  beforeEach(() => {
    const mock = makeChromeMock()
    chromeRefs = mock.refs
    vi.stubGlobal('chrome', mock.chrome)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('re-points the run at the window it opened', async () => {
    const { ctx, setScope, setTab } = makeCtx()
    await EXECUTORS['new-window']!({ url: 'https://example.com' }, ctx)

    expect(chromeRefs.create).toHaveBeenCalledWith({ url: 'https://example.com', focused: true })
    expect(setScope).toHaveBeenCalledWith({ windowId: 42 })
    expect(ctx.scope).toEqual({ windowId: 42 })
    // The tab is looked up INSIDE the new window, never in the old one.
    expect(chromeRefs.query).toHaveBeenCalledWith({ active: true, windowId: 42 })
    expect(setTab).toHaveBeenCalledWith(7)
    expect(ctx.tabId).toBe(7)
  })

  it('still re-points when the block opens a blank window', async () => {
    const { ctx, setScope } = makeCtx()
    await EXECUTORS['new-window']!({}, ctx)
    expect(chromeRefs.create).toHaveBeenCalledWith({ url: undefined, focused: true })
    expect(setScope).toHaveBeenCalledWith({ windowId: 42 })
  })

  it('keeps working when the host does not wire the setters', async () => {
    const bare: WorkflowExecCtx = {
      variables: {},
      refData: undefined,
      signal: new AbortController().signal,
      emit: () => {},
    }
    await expect(EXECUTORS['new-window']!({}, bare)).resolves.toBeNull()
    expect(bare.scope).toEqual({ windowId: 42 })
  })
})
