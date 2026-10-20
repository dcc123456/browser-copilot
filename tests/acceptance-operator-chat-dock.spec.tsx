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

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

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
import type { OperatorAction, OperatorProposal } from '../src/lib/workflow/operator-advise'

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
): AdviseReply => ({
  type: 'workflows.operatorAdvise',
  data: {
    ok: true,
    reply,
    action: action ?? 'append',
    proposals,
    rejected: [],
  },
})

/** An answer whose parameters came from a page the assistant actually read. */
const groundedReply = (proposals: OperatorProposal[]): AdviseReply => ({
  type: 'workflows.operatorAdvise',
  data: {
    ok: true,
    reply: '从城市下拉里选择杭州',
    action: 'append',
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
  kind: 'append',
  added: 1,
  applied: true,
  skipped: [],
  pruned: [],
  missing: [],
}
let undos = 0

let container: HTMLElement
const roots: Root[] = []

beforeEach(() => {
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
  landing = { kind: 'append', added: 1, applied: true, skipped: [], pruned: [], missing: [] }
  seen.length = 0
  mocks.sendCommand.mockReset()
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
      kind: 'append',
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
})
