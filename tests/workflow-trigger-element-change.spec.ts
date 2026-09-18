/**
 * The `element-change` trigger, end to end on both sides of the tab boundary:
 * the MutationObserver the extension injects into pages, and the service-worker
 * handler that turns its message into a run.
 *
 * The observer runs in the PAGE, so it is exercised against stubbed DOM globals
 * rather than a real document (the suite runs in the `node` environment). The
 * contract under test is which element it watches, with which options, and how
 * often it reports — not the DOM's own mutation delivery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
// `import type` is erased at compile time, so pulling the spec shape statically
// does not force `workflow-triggers` to evaluate before the storage mock below
// is wired up.
import type { ElementChangeSpec } from '../src/background/workflow-triggers'

const listWorkflowsMock = vi.fn<() => Promise<Workflow[]>>()

vi.mock('../src/lib/workflow/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/workflow/storage')>()
  return {
    ...actual,
    listWorkflows: () => listWorkflowsMock(),
    getWorkflow: async (id: string) =>
      (await listWorkflowsMock()).find((workflow) => workflow.id === id),
  }
})

const {
  elementChangeObserverInPage,
  elementChangeWorkflows,
  handleElementChange,
  refreshElementChangeObservers,
  setWorkflowRunner,
  releaseElementChangeRun,
} = await import('../src/background/workflow-triggers')

// --- DOM stand-ins ----------------------------------------------------------

/** A MutationObserver stand-in: records subscriptions, lets the test fire them. */
class FakeObserver {
  static instances: FakeObserver[] = []
  readonly subscriptions: Array<{ target: unknown; options: MutationObserverInit }> = []
  disconnected = false
  constructor(private readonly callback: () => void) {
    FakeObserver.instances.push(this)
  }
  observe(target: unknown, options: MutationObserverInit): void {
    this.subscriptions.push({ target, options })
  }
  disconnect(): void {
    this.disconnected = true
  }
  /** Simulate the browser delivering a mutation to this observer. */
  fire(): void {
    this.callback()
  }
  static reset(): void {
    FakeObserver.instances = []
  }
}

const documentElement = { tag: 'html' }
const querySelector = vi.fn<(selector: string) => unknown>()
const sendMessage = vi.fn<(message: unknown) => unknown>()
let windowStub: Record<string, unknown>

/** The observer registry the page holds; the injected function's only output. */
function liveRegistry(): { stop: () => void } | undefined {
  return windowStub['__bcElementWatch'] as { stop: () => void } | undefined
}

function spec(overrides: Partial<ElementChangeSpec> = {}): ElementChangeSpec {
  return {
    workflowId: 'wf-1',
    selector: '#feed',
    matchPattern: '',
    options: {
      subtree: false,
      childList: true,
      attributes: false,
      characterData: false,
      attributeFilter: [],
    },
    ...overrides,
  }
}

/** Advance past the observer's burst debounce so a pending report lands. */
function flushDebounce(): void {
  vi.advanceTimersByTime(500)
}

beforeEach(() => {
  FakeObserver.reset()
  querySelector.mockReset()
  sendMessage.mockReset()
  sendMessage.mockReturnValue(undefined)
  vi.useFakeTimers()
  windowStub = {
    // Delegating rather than capturing: fake timers replace the globals after
    // this object is built, and the observer must schedule on the faked clock.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  }
  vi.stubGlobal('window', windowStub)
  vi.stubGlobal('MutationObserver', FakeObserver)
  vi.stubGlobal('document', { documentElement, querySelector })
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setWorkflowRunner(() => {})
})

describe('elementChangeObserverInPage', () => {
  it('watches the matched element with the spec\u2019s mutation options', () => {
    const element = { id: 'feed' }
    querySelector.mockReturnValue(element)

    elementChangeObserverInPage([spec()])

    expect(FakeObserver.instances).toHaveLength(1)
    expect(FakeObserver.instances[0]!.subscriptions).toEqual([
      {
        target: element,
        options: { subtree: false, childList: true, attributes: false, characterData: false },
      },
    ])
  })

  it('omits attributeFilter when attributes are not watched', () => {
    // A MutationObserver THROWS if `attributeFilter` is passed without
    // `attributes: true`, which would abort the whole registration — so a
    // leftover filter on an attribute-less spec must be dropped.
    querySelector.mockReturnValue({ id: 'feed' })

    elementChangeObserverInPage([
      spec({
        options: {
          subtree: false,
          childList: true,
          attributes: false,
          characterData: false,
          attributeFilter: ['class'],
        },
      }),
    ])

    expect(FakeObserver.instances[0]!.subscriptions[0]!.options).not.toHaveProperty(
      'attributeFilter',
    )
  })

  it('forwards attributeFilter when attributes are watched', () => {
    querySelector.mockReturnValue({ id: 'feed' })

    elementChangeObserverInPage([
      spec({
        options: {
          subtree: true,
          childList: false,
          attributes: true,
          characterData: false,
          attributeFilter: ['class', 'data-state'],
        },
      }),
    ])

    expect(FakeObserver.instances[0]!.subscriptions[0]!.options).toEqual({
      subtree: true,
      childList: false,
      attributes: true,
      characterData: false,
      attributeFilter: ['class', 'data-state'],
    })
  })

  it('collapses a burst of mutations into one message', () => {
    querySelector.mockReturnValue({ id: 'feed' })
    elementChangeObserverInPage([spec()])
    const observer = FakeObserver.instances[0]!

    observer.fire()
    observer.fire()
    observer.fire()
    expect(sendMessage).not.toHaveBeenCalled()

    flushDebounce()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith({ type: 'trigger:element-change', workflowId: 'wf-1' })
  })

  it('reports again for a later, separate burst', () => {
    querySelector.mockReturnValue({ id: 'feed' })
    elementChangeObserverInPage([spec()])
    const observer = FakeObserver.instances[0]!

    observer.fire()
    flushDebounce()
    observer.fire()
    flushDebounce()

    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('survives a sendMessage that rejects (invalidated extension context)', () => {
    // In MV3 an invalidated context REJECTS the returned promise; without an
    // attached handler that becomes an unhandled rejection in the page.
    sendMessage.mockReturnValue(Promise.reject(new Error('Extension context invalidated')))
    querySelector.mockReturnValue({ id: 'feed' })
    elementChangeObserverInPage([spec()])
    const observer = FakeObserver.instances[0]!

    observer.fire()
    expect(() => flushDebounce()).not.toThrow()
  })

  it('waits for a late-rendered element instead of giving up', () => {
    const element = { id: 'feed' }
    querySelector.mockReturnValueOnce(null)
    elementChangeObserverInPage([spec()])
    const placeholder = FakeObserver.instances[0]!

    // No match yet: watch the document for it, and report nothing.
    expect(placeholder.subscriptions).toEqual([
      { target: documentElement, options: { childList: true, subtree: true } },
    ])
    placeholder.fire()
    flushDebounce()
    expect(sendMessage).not.toHaveBeenCalled()

    // It appears: the real observer attaches and the placeholder retires.
    querySelector.mockReturnValue(element)
    placeholder.fire()
    expect(placeholder.disconnected).toBe(true)
    const real = FakeObserver.instances[1]!
    expect(real.subscriptions[0]!.target).toBe(element)

    real.fire()
    flushDebounce()
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('installs one observer per spec', () => {
    querySelector.mockReturnValue({ id: 'feed' })
    elementChangeObserverInPage([spec(), spec({ workflowId: 'wf-2', selector: '#inbox' })])

    expect(FakeObserver.instances).toHaveLength(2)
  })

  it('replaces the previous registry on re-injection', () => {
    // Re-injection is the ONLY way a removed / re-pointed trigger gets
    // unregistered, so the old observers must be disconnected.
    querySelector.mockReturnValue({ id: 'feed' })
    elementChangeObserverInPage([spec()])
    const first = FakeObserver.instances[0]!

    elementChangeObserverInPage([spec({ selector: '#other' })])

    expect(first.disconnected).toBe(true)
    expect(liveRegistry()).toBeDefined()
  })

  it('drops every observer when re-injected with no specs', () => {
    querySelector.mockReturnValue({ id: 'feed' })
    elementChangeObserverInPage([spec()])
    const first = FakeObserver.instances[0]!

    elementChangeObserverInPage([])

    expect(first.disconnected).toBe(true)
    expect(FakeObserver.instances).toHaveLength(1)
  })

  it('stop() disconnects observers and cancels a pending report', () => {
    querySelector.mockReturnValue({ id: 'feed' })
    elementChangeObserverInPage([spec()])
    const observer = FakeObserver.instances[0]!

    observer.fire()
    liveRegistry()!.stop()

    expect(observer.disconnected).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

// --- service-worker side ----------------------------------------------------

function triggerNode(data: Record<string, unknown>): WorkflowNode {
  return {
    id: 't',
    label: 'trigger',
    position: { x: 0, y: 0 },
    data: { blockId: 'trigger', ...data },
  }
}

function actionNode(id = 'a'): WorkflowNode {
  return { id, label: 'event-click', position: { x: 0, y: 0 }, data: { blockId: 'event-click' } }
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'test',
    createdAt: 0,
    updatedAt: 0,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: {
      nodes: [
        triggerNode({ type: 'element-change', observeElement: { selector: '#feed' } }),
        actionNode(),
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    },
    trigger: { type: 'element-change', enabled: true },
    ...overrides,
  }
}

describe('elementChangeWorkflows', () => {
  it('maps a configured workflow to an observer spec', async () => {
    listWorkflowsMock.mockResolvedValue([
      workflow({
        drawflow: {
          nodes: [
            triggerNode({
              type: 'element-change',
              observeElement: {
                selector: '  #feed  ',
                matchPattern: 'https://x.test/*',
                targetOptions: {
                  subtree: true,
                  childList: false,
                  attributes: true,
                  characterData: true,
                  attributeFilter: ['class', ''],
                },
              },
            }),
            actionNode(),
          ],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    ])

    expect(await elementChangeWorkflows()).toEqual([
      {
        workflowId: 'wf-1',
        selector: '#feed',
        matchPattern: 'https://x.test/*',
        options: {
          subtree: true,
          childList: false,
          attributes: true,
          characterData: true,
          attributeFilter: ['class'],
        },
      },
    ])
  })

  it('defaults childList on and everything else off', async () => {
    // Watching an element for "it changed" without noticing its children change
    // is almost never what the user meant.
    listWorkflowsMock.mockResolvedValue([workflow()])

    const [only] = await elementChangeWorkflows()
    expect(only!.options).toEqual({
      subtree: false,
      childList: true,
      attributes: false,
      characterData: false,
      attributeFilter: [],
    })
  })

  it('skips a workflow with no selector, a disabled trigger, or another kind', async () => {
    listWorkflowsMock.mockResolvedValue([
      workflow({
        id: 'no-selector',
        drawflow: { nodes: [triggerNode({ type: 'element-change' }), actionNode()], edges: [] },
      }),
      workflow({ id: 'disabled', trigger: { type: 'element-change', enabled: false } }),
      workflow({
        id: 'other-kind',
        drawflow: { nodes: [triggerNode({ type: 'manual' }), actionNode()], edges: [] },
        trigger: { type: 'manual', enabled: true },
      }),
      workflow({ id: 'ok' }),
    ])

    expect((await elementChangeWorkflows()).map((s) => s.workflowId)).toEqual(['ok'])
  })
})

describe('refreshElementChangeObservers', () => {
  const executeScript = vi.fn<(arg: unknown) => Promise<unknown>>()

  beforeEach(() => {
    executeScript.mockReset()
    executeScript.mockResolvedValue([])
    vi.stubGlobal('chrome', {
      runtime: { sendMessage },
      tabs: { query: vi.fn(async () => []) },
      scripting: { executeScript },
    })
  })

  function tabsOf(list: Array<{ id?: number; url?: string }>): void {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage },
      tabs: { query: vi.fn(async () => list) },
      scripting: { executeScript },
    })
  }

  it('injects into http(s) tabs only', async () => {
    listWorkflowsMock.mockResolvedValue([workflow()])
    tabsOf([
      { id: 1, url: 'https://x.test/a' },
      { id: 2, url: 'chrome://extensions' },
      { id: 3, url: 'about:blank' },
      { id: 4 },
    ])

    await refreshElementChangeObservers()

    expect(executeScript).toHaveBeenCalledTimes(1)
    expect(executeScript.mock.calls[0]![0]).toMatchObject({ target: { tabId: 1 } })
  })

  it('honours the spec\u2019s match pattern', async () => {
    listWorkflowsMock.mockResolvedValue([
      workflow({
        drawflow: {
          nodes: [
            triggerNode({
              type: 'element-change',
              observeElement: { selector: '#feed', matchPattern: 'https://x.test/*' },
            }),
            actionNode(),
          ],
          edges: [{ id: 'e1', source: 't', target: 'a' }],
        },
      }),
    ])
    tabsOf([
      { id: 1, url: 'https://x.test/a' },
      { id: 2, url: 'https://other.test/a' },
    ])

    await refreshElementChangeObservers()

    // Every http(s) tab is injected — including non-matching ones, with an
    // EMPTY spec list. That is how a tab that stopped matching gets its old
    // observer unregistered; skipping the injection would leave it running.
    const byTab = new Map(
      executeScript.mock.calls.map((call) => {
        const arg = call[0] as { target: { tabId: number }; args: unknown[] }
        return [arg.target.tabId, arg.args[0]]
      }),
    )
    expect(byTab.get(1)).toEqual([expect.objectContaining({ workflowId: 'wf-1' })])
    expect(byTab.get(2)).toEqual([])
  })

  it('injects an empty registry so a removed trigger is unregistered', async () => {
    // Otherwise the previously injected observer keeps running in every tab.
    listWorkflowsMock.mockResolvedValue([])
    tabsOf([{ id: 1, url: 'https://x.test/a' }])

    await refreshElementChangeObservers()

    const call = executeScript.mock.calls[0]![0] as { args: unknown[] }
    expect(call.args[0]).toEqual([])
  })

  it('does nothing when the workflow list cannot be read', async () => {
    listWorkflowsMock.mockRejectedValue(new Error('storage unavailable'))
    tabsOf([{ id: 1, url: 'https://x.test/a' }])

    await expect(refreshElementChangeObservers()).resolves.toBeUndefined()
    expect(executeScript).not.toHaveBeenCalled()
  })

  it('keeps going when a tab refuses injection', async () => {
    listWorkflowsMock.mockResolvedValue([workflow()])
    executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'))
    tabsOf([
      { id: 1, url: 'https://x.test/a' },
      { id: 2, url: 'https://x.test/b' },
    ])

    await expect(refreshElementChangeObservers()).resolves.toBeUndefined()
    expect(executeScript).toHaveBeenCalledTimes(2)
  })
})

describe('handleElementChange', () => {
  const runner = vi.fn()

  beforeEach(() => {
    runner.mockReset()
    setWorkflowRunner(runner)
    listWorkflowsMock.mockResolvedValue([workflow()])
    // The re-entrancy guard is module state whose release is scheduled on a
    // timer; `useRealTimers()` in afterEach discards that timer, so without
    // this reset the first test would leave 'wf-1' guarded for the whole file.
    releaseElementChangeRun('wf-1')
  })

  it('ignores unrelated messages', async () => {
    expect(await handleElementChange({ type: 'something-else', workflowId: 'wf-1' })).toBe(false)
    expect(await handleElementChange({ type: 'trigger:element-change' })).toBe(false)
    expect(await handleElementChange(null)).toBe(false)
    expect(runner).not.toHaveBeenCalled()
  })

  it('runs the workflow in the window the mutation happened in', async () => {
    const handled = await handleElementChange(
      { type: 'trigger:element-change', workflowId: 'wf-1' },
      { tab: { windowId: 7 } } as chrome.runtime.MessageSender,
    )

    expect(handled).toBe(true)
    expect(runner).toHaveBeenCalledWith('wf-1', 7)
  })

  it('skips a workflow that was disabled after the observer was injected', async () => {
    // The observer can outlive the edit; re-reading storage is what keeps a
    // switched-off trigger from firing.
    listWorkflowsMock.mockResolvedValue([
      workflow({ trigger: { type: 'element-change', enabled: false } }),
    ])

    expect(await handleElementChange({ type: 'trigger:element-change', workflowId: 'wf-1' })).toBe(
      true,
    )
    expect(runner).not.toHaveBeenCalled()
  })

  it('skips a workflow whose trigger kind changed since injection', async () => {
    listWorkflowsMock.mockResolvedValue([
      workflow({
        drawflow: { nodes: [triggerNode({ type: 'manual' }), actionNode()], edges: [] },
        trigger: { type: 'manual', enabled: true },
      }),
    ])

    await handleElementChange({ type: 'trigger:element-change', workflowId: 'wf-1' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('skips a workflow that no longer exists', async () => {
    listWorkflowsMock.mockResolvedValue([])

    await handleElementChange({ type: 'trigger:element-change', workflowId: 'gone' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not let a workflow re-trigger itself while it is running', async () => {
    // A workflow that mutates the element it watches would otherwise feed
    // itself forever.
    const message = { type: 'trigger:element-change', workflowId: 'wf-1' }
    await handleElementChange(message)
    await handleElementChange(message)

    expect(runner).toHaveBeenCalledTimes(1)

    // The guard is released after the run settles, so the next burst runs again.
    vi.advanceTimersByTime(1000)
    await handleElementChange(message)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('releases the guard explicitly', async () => {
    const message = { type: 'trigger:element-change', workflowId: 'wf-1' }
    await handleElementChange(message)
    releaseElementChangeRun('wf-1')
    await handleElementChange(message)

    expect(runner).toHaveBeenCalledTimes(2)
  })
})
