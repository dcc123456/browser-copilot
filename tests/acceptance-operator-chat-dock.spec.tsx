// @vitest-environment jsdom
/**
 * Component test for the editor's floating AI operator assistant
 * (`workflow-editor/ai/OperatorChatDock`), driven with a mocked command channel.
 *
 * The dock owns only the conversation; the canvas mutation lives in the editor,
 * so what these rows pin is the boundary: what a send puts on the wire, that a
 * reply's action and the selection it was made against are handed to the editor
 * together, that the landed change offers exactly one undo, and that a failure
 * or a stop reports instead of silently doing nothing.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), requestElementPick: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

// The picker's browser round trip is its own subject (see the element-picker and
// condition-editor specs); here only what the dock DOES with the answer matters.
vi.mock('../src/workflow-editor/blocks/shared/element-pick', () => ({
  describePickFailure: (failure: string, error?: string) =>
    failure === 'cancelled' ? null : (error ?? 'The element picker did not respond.'),
  requestElementPick: mocks.requestElementPick,
}))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import OperatorChatDock, {
  type OperatorApplyRequest,
  type OperatorChatContext,
  type OperatorLanding,
} from '../src/workflow-editor/ai/OperatorChatDock'
import type { Command, CommandResult } from '../src/lib/messages'
import type {
  OperatorAction,
  OperatorProposal,
  OperatorScreenshotReport,
} from '../src/lib/workflow/operator-advise'

beforeAll(() => {
  // jsdom implements neither scrolling API; the transcript tail needs one.
  for (const method of ['scrollTo', 'scrollBy'] as const) {
    Object.defineProperty(Element.prototype, method, { value: () => {}, configurable: true })
  }
})

/** The editor translator mocked as key passthrough, so rows assert on key names. */
const t = (key: string) => key

type AdviseReply = Extract<CommandResult, { type: 'workflows.operatorAdvise' }>

const okReply = (
  proposals: OperatorProposal[],
  reply = '已添加两个算子',
  action?: OperatorAction,
  raw?: string,
): AdviseReply => ({
  type: 'workflows.operatorAdvise',
  data: {
    ok: true,
    reply,
    action: action ?? 'append',
    proposals,
    rejected: [],
    ...(raw ? { raw } : {}),
  },
})

/** An answer whose parameters came from a page the assistant actually read. */
const groundedReply = (
  proposals: OperatorProposal[],
  action: OperatorAction = 'append',
): AdviseReply => ({
  type: 'workflows.operatorAdvise',
  data: {
    ok: true,
    reply: '从城市下拉里选择杭州',
    action,
    proposals,
    rejected: [],
    page: { url: 'https://example.com/form', title: 'Sign up' },
  },
})

let reply: AdviseReply = okReply([
  { blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' },
])

type ObserveReply = Extract<CommandResult, { type: 'workflows.operatorObserve' }>

const seen: Command[] = []

let observe: ObserveReply = {
  type: 'workflows.operatorObserve',
  data: {
    ok: true,
    steps: [
      {
        blockId: 'event-click',
        name: 'Click element',
        ran: true,
        data: { selector: '#city', findBy: 'cssSelector', selectorVerified: true },
        report: ['点击 1 个元素'],
      },
    ],
    refused: [],
  },
}

const context: OperatorChatContext = {
  graphDigest: '1. trigger',
  selectedNodeId: 'n2',
  selectedSpec: 'new-tab — Open tab\n  url: https://b',
  windowId: 12,
  workflowGoal: 'scrape leads',
  workflowId: 'wf-1',
}

let requests: OperatorApplyRequest[] = []
let landing: OperatorLanding = {
  kind: 'chain',
  added: 1,
  applied: true,
  skipped: [],
  pruned: [],
  missing: [],
}
let undos = 0

let container: HTMLElement
const roots: Root[] = []

/** Broadcast listeners the dock registered — the stream arrives unsolicited. */
const broadcastListeners: ((message: unknown) => void)[] = []

beforeEach(() => {
  broadcastListeners.length = 0
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          broadcastListeners.push(listener)
        },
        removeListener: (listener: (message: unknown) => void) => {
          const index = broadcastListeners.indexOf(listener)
          if (index >= 0) broadcastListeners.splice(index, 1)
        },
      },
    },
  })
  reply = okReply([{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }])
  observe = {
    type: 'workflows.operatorObserve',
    data: {
      ok: true,
      steps: [
        {
          blockId: 'event-click',
          name: 'Click element',
          ran: true,
          data: { selector: '#city', findBy: 'cssSelector', selectorVerified: true },
          report: ['点击 1 个元素'],
        },
      ],
      refused: [],
    },
  }
  requests = []
  undos = 0
  landing = { kind: 'chain', added: 1, applied: true, skipped: [], pruned: [], missing: [] }
  seen.length = 0
  mocks.sendCommand.mockReset()
  mocks.requestElementPick.mockReset()
  mocks.requestElementPick.mockResolvedValue({ ok: false, failure: 'cancelled' })
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    if (command.type === 'workflows.operatorAdvise') return reply
    if (command.type === 'workflows.operatorObserve') return observe
    if (
      command.type === 'workflows.operatorAdviseCancel' ||
      command.type === 'workflows.operatorObserveCancel'
    )
      return { type: command.type }
    throw new Error(`unexpected command: ${command.type}`)
  })
})

afterEach(() => {
  // jsdom leaks the timers of a mounted root otherwise.
  while (roots.length > 0) {
    const mounted = roots.pop()!
    act(() => mounted.unmount())
  }
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const render = async (): Promise<void> => {
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(OperatorChatDock, {
        t,
        getContext: () => context,
        onApply: (request) => {
          requests.push(request)
          return landing
        },
        onUndo: () => {
          undos += 1
        },
      }),
    )
  })
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined

const typeInto = async (value: string): Promise<void> => {
  const field = container.querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const send = async (): Promise<void> => {
  await act(async () => {
    buttonByText('operatorAiSend')?.click()
  })
  await flush()
}

/** Open the chat, say one thing, and let the mocked answer come back. */
const ask = async (text: string): Promise<void> => {
  await act(async () => {
    buttonByText('operatorAiFabLabel')?.click()
  })
  await typeInto(text)
  await send()
}

const click = async (label: string): Promise<void> => {
  await act(async () => {
    buttonByText(label)?.click()
  })
  await flush()
}

/** Deliver one unsolicited broadcast to the dock, as the background would. */
const broadcast = async (message: unknown): Promise<void> => {
  await act(async () => {
    for (const listener of [...broadcastListeners]) listener(message)
  })
}

/** The pick button is looked up by title: its text carries the pending-count
 *  badge, which grows with every pick. */
const pickElement = async (): Promise<void> => {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[title="operatorAiPick"]')?.click()
  })
  await flush()
}

const adviseCommands = () =>
  seen.filter(
    (command): command is Extract<Command, { type: 'workflows.operatorAdvise' }> =>
      command.type === 'workflows.operatorAdvise',
  )

const observeCommands = () =>
  seen.filter(
    (command): command is Extract<Command, { type: 'workflows.operatorObserve' }> =>
      command.type === 'workflows.operatorObserve',
  )

describe('V-operator-dock: the floating assistant', () => {
  it('opens from the AI button and starts from guidance, not an empty box', async () => {
    await render()
    expect(container.querySelector('textarea')).toBeNull()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    expect(container.querySelector('textarea')).toBeDefined()
    expect(container.textContent).toContain('operatorAiEmptyState')
  })

  it('sends the canvas digest, the goal and the conversation it holds', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('打开 https://www.baidu.com')
    await send()

    expect(adviseCommands()).toHaveLength(1)
    const command = adviseCommands()[0]!
    expect(command.graphDigest).toBe('1. trigger')
    expect(command.workflowGoal).toBe('scrape leads')
    expect(command.workflowId).toBe('wf-1')
    expect(command.messages).toEqual([{ role: 'user', content: '打开 https://www.baidu.com' }])
    expect(command.sessionId).toBeTruthy()
  })

  it('sends the selected step alongside the digest', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('打开 https://www.baidu.com')
    await send()

    expect(adviseCommands()[0]!.selectedSpec).toBe(context.selectedSpec)
  })

  it('reads the page by default, in the window hosting the editor', async () => {
    reply = {
      type: 'workflows.operatorAdvise',
      data: {
        ok: true,
        reply: '已添加',
        action: 'append',
        proposals: [{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }],
        rejected: [],
        page: { url: 'https://example.com/form', title: 'Sign up' },
      },
    }
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('从城市下拉里选择杭州')
    await send()

    const command = adviseCommands()[0]!
    expect(command.windowId).toBe(12)
    expect(command.skipPageRead).toBeUndefined()
    // The row says where the parameters came from, so a guess is not mistaken for a read.
    expect(container.textContent).toContain('operatorAiPageUsed')
  })

  it('stops reading the page when the user turns the override on', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await act(async () => {
      buttonByText('operatorAiPageToggleOn')?.click()
    })
    expect(buttonByText('operatorAiPageToggleOff')).toBeDefined()
    await typeInto('打开 https://www.baidu.com')
    await send()

    expect(adviseCommands()[0]!.skipPageRead).toBe(true)
    expect(container.textContent).toContain('operatorAiPageNone')
  })

  describe('a batch whose locator only the page can supply', () => {
    it('holds it instead of landing a guessed locator', async () => {
      reply = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }])
      await render()
      await ask('从城市下拉里选择杭州')

      expect(requests).toEqual([])
      expect(container.textContent).toContain('operatorAiOfferQuestion')
      expect(buttonByText('operatorAiOfferAct')).toBeDefined()
      expect(buttonByText('operatorAiOfferLand')).toBeDefined()
      // Acting is a side effect on the user's own page, so the row says what
      // undo will not take back, and the next message waits for this answer.
      expect(container.textContent).toContain('operatorAiOfferNoUndo')
      const sendButton = buttonByText('operatorAiSend')
      expect(sendButton?.title).toBe('operatorAiOfferWaiting')
      expect(sendButton?.disabled).toBe(true)
    })

    it('names the steps a page run would not touch', async () => {
      reply = groundedReply([
        { blockId: 'event-click', data: {}, rationale: '' },
        { blockId: 'upload-file', data: {}, rationale: '' },
      ])
      await render()
      await ask('选完城市再上传文件')

      expect(container.textContent).toContain('operatorAiOfferRefused')
    })

    it('lands it as the model wrote it when the user skips the page', async () => {
      reply = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }])
      await render()
      await ask('从城市下拉里选择杭州')
      await click('operatorAiOfferLand')

      expect(observeCommands()).toEqual([])
      expect(requests).toEqual([
        {
          action: 'append',
          proposals: [{ blockId: 'event-click', data: {}, rationale: '' }],
          targetNodeId: 'n2',
        },
      ])
      expect(container.textContent).toContain('operatorAiAdded')
      expect(buttonByText('operatorAiOfferLand')).toBeUndefined()
    })

    it('keeps the chosen placement while the batch is held', async () => {
      // The offer is consumed later than the answer was written: landing must use
      // the placement the assistant asked for, not the one the dock assumed.
      reply = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }], 'prepend')
      await render()
      await ask('在点击之前先等下拉框出现')
      await click('operatorAiOfferLand')

      expect(requests).toEqual([
        {
          action: 'prepend',
          proposals: [{ blockId: 'event-click', data: {}, rationale: '' }],
          targetNodeId: 'n2',
        },
      ])
    })

    it('acts once and lands the locator the page really used', async () => {
      reply = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }])
      await render()
      await ask('从城市下拉里选择杭州')
      await click('operatorAiOfferAct')

      const command = observeCommands()[0]!
      expect(command.steps).toEqual([{ blockId: 'event-click', data: {} }])
      expect(command.windowId).toBe(12)
      // One model call: the refined parameters come from the page, not a rewrite.
      expect(adviseCommands()).toHaveLength(1)
      expect(requests).toEqual([
        {
          action: 'append',
          proposals: [
            {
              blockId: 'event-click',
              data: { selector: '#city', findBy: 'cssSelector', selectorVerified: true },
              rationale: '',
            },
          ],
          targetNodeId: 'n2',
        },
      ])
      expect(container.textContent).toContain('点击 1 个元素')
    })

    it('leaves the choice open when the page run is stopped', async () => {
      observe = {
        type: 'workflows.operatorObserve',
        data: {
          ok: false,
          reason: 'The assistant stopped before the page was acted on.',
          steps: [],
          refused: [],
        },
      }
      reply = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }])
      await render()
      await ask('从城市下拉里选择杭州')
      await click('operatorAiOfferAct')

      expect(requests).toEqual([])
      expect(container.textContent).toContain('The assistant stopped before the page was acted on.')
      expect(buttonByText('operatorAiOfferAct')).toBeDefined()
      expect(buttonByText('operatorAiOfferLand')).toBeDefined()
    })
  })

  it('hands the proposals and the selection to the editor as one request', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('打开百度并点击第一个结果')
    await send()

    expect(requests).toEqual([
      {
        action: 'append',
        proposals: [{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }],
        targetNodeId: 'n2',
      },
    ])
    expect(container.textContent).toContain('已添加两个算子')
    expect(container.textContent).toContain('operatorAiAdded')
  })

  it('lands a prepend answer in front of the step the user selected', async () => {
    // The assistant chose where the steps belong; the dock only relays it, so the
    // request the canvas acts on has to carry the action it was given.
    reply = okReply([{ blockId: 'delay', data: {}, rationale: '' }], '先等待页面加载', 'prepend')
    await render()
    await ask('在打开标签页之前先等两秒')

    expect(requests).toEqual([
      {
        action: 'prepend',
        proposals: [{ blockId: 'delay', data: {}, rationale: '' }],
        targetNodeId: 'n2',
      },
    ])
  })

  it('lands an in-place answer as a change to the selected step', async () => {
    reply = okReply(
      [{ blockId: 'new-tab', data: { url: 'https://a' }, rationale: '' }],
      '已把链接改成 a',
      'edit',
    )
    landing = {
      kind: 'node',
      added: 0,
      applied: true,
      skipped: [],
      pruned: [{ handle: 'conditions-output-p2', label: 'Second' }],
      missing: [],
    }
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('把链接改成 https://a')
    await send()

    expect(requests[0]).toMatchObject({ action: 'edit', targetNodeId: 'n2' })
    expect(container.textContent).toContain('operatorAiChangedInPlace')
    // The cut port is reported: React Flow would otherwise just hide the line.
    expect(container.textContent).toContain('operatorAiPrunedPorts')
    expect(buttonByText('operatorAiUndo')).toBeDefined()
  })

  it('reports an in-place answer the canvas refused, with nothing undoable', async () => {
    reply = okReply([{ blockId: 'event-click', data: {}, rationale: '' }], '换个算子', 'edit')
    landing = {
      kind: 'node',
      added: 0,
      applied: false,
      skipped: [],
      pruned: [],
      missing: [],
      problem: 'edit-other-block',
    }
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('改下参数')
    await send()

    expect(container.textContent).toContain('operatorAiEditOtherBlock')
    expect(buttonByText('operatorAiUndo')).toBeUndefined()
  })

  it('reports an in-place answer that changed nothing as not applied', async () => {
    reply = okReply([], '已修改', 'edit')
    landing = {
      kind: 'node',
      added: 0,
      applied: false,
      skipped: [],
      pruned: [],
      missing: [],
      problem: 'no-change',
    }
    await render()
    await ask('把链接改成 https://a')

    expect(container.textContent).toContain('operatorAiNotApplied')
    expect(container.textContent).toContain('operatorAiNoChange')
    expect(container.textContent).not.toContain('operatorAiChangedInPlace')
    expect(buttonByText('operatorAiUndo')).toBeUndefined()
  })

  it('says which parameters an in-place answer really changed', async () => {
    reply = okReply(
      [{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }],
      '已把链接改成 b',
      'edit',
    )
    landing = {
      kind: 'node',
      added: 0,
      applied: true,
      skipped: [],
      pruned: [],
      missing: [],
      changed: [{ key: 'url', before: 'https://a', after: 'https://b' }],
    }
    await render()
    await ask('把链接改成 https://b')

    expect(container.textContent).toContain('operatorAiChangedParams')
    expect(container.textContent).toContain('url: "https://a" → "https://b"')
  })

  it('names both operators when the answer swaps the selected step', async () => {
    reply = okReply([{ blockId: 'event-click', data: {}, rationale: '' }], '换个算子', 'replace')
    landing = {
      kind: 'node',
      added: 0,
      applied: true,
      skipped: [],
      pruned: [],
      missing: [],
      swapped: { from: 'New tab', to: 'Event click' },
    }
    await render()
    await ask('换成点击元素')

    expect(container.textContent).toContain('operatorAiSwappedStep')
    expect(container.textContent).toContain('New tab → Event click')
  })

  it('says so when an append answer carries no steps at all', async () => {
    reply = okReply([], '已添加')
    await render()
    await ask('修改第二步')

    expect(requests).toEqual([])
    expect(container.textContent).toContain('operatorAiNoSteps')
  })

  it('offers undo for the batch it just landed, and only for that batch', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('打开百度')
    await send()

    const undo = buttonByText('operatorAiUndo')
    expect(undo).toBeDefined()
    await act(async () => {
      undo?.click()
    })
    expect(undos).toBe(1)
    expect(buttonByText('operatorAiUndo')).toBeUndefined()

    // A second reply lands a new batch, which is the only one undoable now.
    await typeInto('再等一下')
    await send()
    expect(buttonByText('operatorAiUndo')).toBeDefined()
  })

  it('reports a refusal instead of pretending a step was added', async () => {
    reply = {
      type: 'workflows.operatorAdvise',
      data: {
        ok: false,
        reason: 'No AI provider is configured with an API key.',
        reply: '',
        proposals: [],
        rejected: [],
      },
    }
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('打开百度')
    await send()

    expect(requests).toEqual([])
    expect(container.textContent).toContain('No AI provider is configured with an API key.')
    expect(container.textContent).toContain('operatorAiFailed')
    expect(container.textContent).not.toContain('operatorAiAdded')
  })

  it('says what the canvas refused to place', async () => {
    landing = {
      kind: 'chain',
      added: 0,
      applied: false,
      skipped: [],
      pruned: [],
      missing: [],
      problem: 'branch-anchor',
    }
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('打开百度')
    await send()

    expect(container.textContent).toContain('operatorAiBranchAnchor')
    expect(buttonByText('operatorAiUndo')).toBeUndefined()
  })

  it('stops the in-flight request rather than dropping the button', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    // Park the command: the dock must show a stop control while it hangs.
    let resolveCommand: ((value: AdviseReply) => void) | null = null
    mocks.sendCommand.mockImplementation(
      (command: Command) =>
        new Promise((resolve) => {
          seen.push(command)
          if (command.type === 'workflows.operatorAdviseCancel') resolve({ type: command.type })
          else resolveCommand = resolve
        }),
    )
    await typeInto('打开百度')
    await act(async () => {
      buttonByText('operatorAiSend')?.click()
    })

    const stop = buttonByText('operatorAiStop')
    expect(stop).toBeDefined()
    await act(async () => {
      stop?.click()
    })
    expect(seen.map((command) => command.type)).toContain('workflows.operatorAdviseCancel')
    await act(async () => {
      resolveCommand?.(okReply([]))
    })
    await flush()
  })

  it('shows the model writing as it happens, then keeps it behind a disclosure', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    let resolveCommand: ((value: AdviseReply) => void) | null = null
    mocks.sendCommand.mockImplementation(
      (command: Command) =>
        new Promise((resolve) => {
          seen.push(command)
          if (command.type === 'workflows.operatorAdviseCancel') resolve({ type: command.type })
          else resolveCommand = resolve
        }),
    )
    await typeInto('打开百度')
    await act(async () => {
      buttonByText('operatorAiSend')?.click()
    })

    const sessionId = adviseCommands()[0]!.sessionId
    // Another editor page's deltas are not this answer.
    await broadcast({
      type: 'workflows.operatorAdviseEvent',
      sessionId: 'not-my-turn',
      channel: 'text',
      delta: 'wrong turn',
    })
    await broadcast({
      type: 'workflows.operatorAdviseEvent',
      sessionId,
      channel: 'reasoning',
      delta: '先看画布',
    })
    await broadcast({
      type: 'workflows.operatorAdviseEvent',
      sessionId,
      channel: 'text',
      delta: '正在打开百度',
    })

    // The waiting row says it is thinking, and the model's own words are on it.
    expect(container.textContent).toContain('operatorAiThinking')
    expect(container.textContent).toContain('先看画布')
    expect(container.textContent).toContain('正在打开百度')
    expect(container.textContent).not.toContain('wrong turn')

    const raw = '{"reply":"已添加","proposals":[]}'
    await act(async () => {
      resolveCommand?.(okReply([], '已添加', undefined, raw))
    })
    await flush()

    // Settled: the live row is gone, the answer and its raw text stay readable.
    expect(container.textContent).not.toContain('operatorAiThinking')
    expect(container.textContent).toContain('已添加')
    expect(container.querySelectorAll('details')).toHaveLength(1)
    expect(container.querySelector('details summary')?.textContent).toBe('operatorAiRaw')
    expect(container.querySelector('details pre')?.textContent).toBe(raw)
  })

  it('keeps the thinking after the answer lands, and reports a level that was not sent', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    let resolveCommand: ((value: AdviseReply) => void) | null = null
    mocks.sendCommand.mockImplementation(
      (command: Command) =>
        new Promise((resolve) => {
          seen.push(command)
          if (command.type === 'workflows.operatorAdviseCancel') resolve({ type: command.type })
          else resolveCommand = resolve
        }),
    )
    await typeInto('打开百度')
    await act(async () => {
      buttonByText('operatorAiSend')?.click()
    })
    await act(async () => {
      resolveCommand?.({
        type: 'workflows.operatorAdvise',
        data: {
          ok: true,
          reply: '已添加',
          proposals: [],
          rejected: [],
          reasoning: '先看画布再挑算子',
          thinkingSkippedModel: 'gpt-4o-mini',
        },
      })
    })
    await flush()

    const summaries = [...container.querySelectorAll('details summary')].map(
      (element) => element.textContent,
    )
    expect(summaries).toContain('operatorAiReasoning')
    expect(container.textContent).toContain('先看画布再挑算子')
    expect(container.textContent).toContain('operatorAiThinkingSkipped')
  })

  it('renders the reply and the reason for each proposed step', async () => {
    reply = okReply(
      [{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '用户要打开百度' }],
      '先打开目标页面',
    )
    await render()
    await ask('打开百度')

    expect(container.textContent).toContain('先打开目标页面')
    expect(container.textContent).toContain('用户要打开百度')
  })
})

describe('V-operator-dock: a locator the user pointed at by hand', () => {
  const picked = (selector: string, findBy: 'cssSelector' | 'xpath' = 'cssSelector') =>
    mocks.requestElementPick.mockResolvedValue({ ok: true, selector, findBy })

  it('goes with the next message and is spent by it', async () => {
    picked('#city')
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await pickElement()
    expect(mocks.requestElementPick).toHaveBeenCalledTimes(1)
    // The transcript shows what the user handed over, in their own words.
    expect(container.textContent).toContain('operatorAiPicked')

    await typeInto('从城市下拉里选杭州')
    await send()
    expect(adviseCommands()[0]!.pickedElements).toEqual([
      { selector: '#city', findBy: 'cssSelector' },
    ])

    // Spent: the follow-up turn carries no hand facts of its own.
    await typeInto('再选杭州')
    await send()
    expect(adviseCommands()[1]!.pickedElements).toBeUndefined()
  })

  it('settles a held batch on send, never on the pick itself', async () => {
    reply = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }])
    picked('#city')
    await render()
    await ask('从城市下拉里选择杭州')
    expect(requests).toEqual([])
    expect(observeCommands()).toHaveLength(0)

    await pickElement()

    // The pick is only an attachment: the question is still the question, and
    // the send button now says what a click would do with it.
    expect(requests).toEqual([])
    expect(observeCommands()).toEqual([])
    expect(container.textContent).toContain('operatorAiPicksTitle')
    expect(buttonByText('operatorAiOfferAct')).toBeDefined()
    expect(buttonByText('operatorAiPickApply')).toBeDefined()

    await click('operatorAiPickApply')

    // The click was the consent: the batch lands filled — and nothing ran.
    expect(observeCommands()).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.proposals[0]!.data).toEqual({ selector: '#city', findBy: 'cssSelector' })
    expect(buttonByText('operatorAiOfferAct')).toBeUndefined()
  })

  it('fills one step per pick, in step order, and only lands on send', async () => {
    reply = groundedReply([
      { blockId: 'event-click', data: {}, rationale: '' },
      { blockId: 'event-click', data: {}, rationale: '' },
    ])
    mocks.requestElementPick
      .mockResolvedValueOnce({ ok: true, selector: '#city', findBy: 'cssSelector' })
      .mockResolvedValue({ ok: true, selector: '#ok', findBy: 'cssSelector' })
    await render()
    await ask('先点城市，再点确定')

    // Picks accumulate unanswered; nothing on the canvas moves yet.
    await pickElement()
    expect(requests).toEqual([])
    expect(buttonByText('operatorAiOfferAct')).toBeDefined()
    await pickElement()
    expect(requests).toEqual([])

    // The send click answers both gaps: each locator went into its own step.
    await click('operatorAiPickApply')
    expect(mocks.requestElementPick).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.proposals.map((proposal) => proposal.data.selector)).toEqual([
      '#city',
      '#ok',
    ])
  })

  it('lets the user correct or drop a pick before anything lands', async () => {
    reply = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }])
    picked('#city')
    await render()
    await ask('从城市下拉里选择杭州')
    await pickElement()

    const locator = container.querySelector<HTMLInputElement>(
      'footer input[aria-label="operatorAiPickShort"]',
    )!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(locator, '#city-select')
      locator.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const strategy = container.querySelector<HTMLSelectElement>('footer select')!
    await act(async () => {
      strategy.value = 'text'
      strategy.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(requests).toEqual([])

    await click('operatorAiPickApply')
    expect(requests[0]!.proposals[0]!.data).toEqual({
      selector: '#city-select',
      findBy: 'text',
    })

    // A removed pick is not sent at all: the next message carries no hand facts.
    await pickElement()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="operatorAiPickRemove"]')?.click()
    })
    expect(container.textContent).not.toContain('operatorAiPicksTitle')
    await typeInto('再试一次')
    await send()
    expect(adviseCommands()[1]!.pickedElements).toBeUndefined()
  })

  it('says nothing when the user cancelled the pick', async () => {
    reply = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }])
    await render()
    await ask('从城市下拉里选择杭州')

    await pickElement()

    expect(container.textContent).not.toContain('operatorAiPicked')
    expect(requests).toEqual([])
    // The choice the assistant asked is still the choice it is asking.
    expect(buttonByText('operatorAiOfferAct')).toBeDefined()
  })
})

/**
 * The automatic screenshot is the one path where the user's screen leaves the
 * machine, so the dock reports it in all three states — sent, sent and then
 * failed, or could not be taken — and says nothing when it was not needed.
 */
describe('V-operator-dock: the screenshot the assistant took for itself', () => {
  const answeredWith = (screenshot: OperatorScreenshotReport): void => {
    const base = okReply([{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }])
    reply = { ...base, data: { ...base.data, screenshot } }
  }
  /** Which report line the transcript shows. The three keys share a prefix and
   *  jsdom concatenates neighbouring text nodes, so the longest key is tested
   *  first; the reason text cannot be matched at all, because this harness's
   *  translator passes the key through without interpolating. */
  const shotLine = (): string | undefined => {
    const text = container.textContent ?? ''
    for (const key of ['operatorAiShotSentFailed', 'operatorAiShotSkipped', 'operatorAiShotSent'])
      if (text.includes(key)) return key
    return undefined
  }

  it('says the screen went out, because it did', async () => {
    answeredWith({ route: 'inline', taken: true })
    await render()
    await ask('打开百度')
    expect(shotLine()).toBe('operatorAiShotSent')
  })

  it('says the round failed after the screen had already gone out', async () => {
    answeredWith({ route: 'described', taken: true, error: 'The provider timed out.' })
    await render()
    await ask('打开百度')
    expect(shotLine()).toBe('operatorAiShotSentFailed')
  })

  it('says nothing was captured, so the page read is all the answer has', async () => {
    answeredWith({ route: 'inline', taken: false, error: 'This page type is not capturable.' })
    await render()
    await ask('打开百度')
    expect(shotLine()).toBe('operatorAiShotSkipped')
  })

  it('stays silent when no screenshot was needed', async () => {
    await render()
    await ask('打开百度')
    expect(shotLine()).toBeUndefined()
  })

  it('reports it under a batch the assistant is still holding', async () => {
    reply = (() => {
      const base = groundedReply([{ blockId: 'event-click', data: {}, rationale: '' }])
      return { ...base, data: { ...base.data, screenshot: { route: 'inline', taken: true } } }
    })()
    await render()
    await ask('从城市下拉里选择杭州')
    // The offer and the disclosure are both on the row: the screen went out, and
    // the batch still has not landed.
    expect(shotLine()).toBe('operatorAiShotSent')
    expect(buttonByText('operatorAiOfferAct')).toBeDefined()
    expect(requests).toEqual([])
  })
})
