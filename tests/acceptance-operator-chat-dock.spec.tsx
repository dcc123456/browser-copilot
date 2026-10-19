// @vitest-environment jsdom
/**
 * Component test for the editor's floating AI operator assistant
 * (`workflow-editor/ai/OperatorChatDock`), driven with a mocked command channel.
 *
 * The dock owns only the conversation; the canvas mutation lives in the editor,
 * so what these rows pin is the boundary: what a send puts on the wire, that a
 * reply's proposals are handed to the editor with the anchor the request was
 * made from, that the landed batch offers exactly one undo, and that a failure
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
  type OperatorChatContext,
  type OperatorLanding,
} from '../src/workflow-editor/ai/OperatorChatDock'
import type { Command, CommandResult } from '../src/lib/messages'
import type { OperatorProposal } from '../src/lib/workflow/operator-advise'

beforeAll(() => {
  // jsdom implements neither scrolling API; the transcript tail needs one.
  for (const method of ['scrollTo', 'scrollBy'] as const) {
    Object.defineProperty(Element.prototype, method, { value: () => {}, configurable: true })
  }
})

/** The editor translator mocked as key passthrough, so rows assert on key names. */
const t = (key: string) => key

type AdviseReply = Extract<CommandResult, { type: 'workflows.operatorAdvise' }>

const okReply = (proposals: OperatorProposal[], reply = '已添加两个算子'): AdviseReply => ({
  type: 'workflows.operatorAdvise',
  data: { ok: true, reply, proposals, rejected: [] },
})

let reply: AdviseReply = okReply([
  { blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' },
])
const seen: Command[] = []

const context: OperatorChatContext = {
  graphDigest: '1. trigger',
  anchorNodeId: 'n2',
  workflowGoal: 'scrape leads',
  workflowId: 'wf-1',
}

let appended: { proposals: OperatorProposal[]; anchorNodeId?: string }[] = []
let landing: OperatorLanding = { added: 1, skipped: [], missing: [] }
let undos = 0

let container: HTMLElement
const roots: Root[] = []

beforeEach(() => {
  reply = okReply([{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }])
  appended = []
  undos = 0
  landing = { added: 1, skipped: [], missing: [] }
  seen.length = 0
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    if (command.type === 'workflows.operatorAdvise') return reply
    if (command.type === 'workflows.operatorAdviseCancel') return { type: command.type }
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
        onAppend: (proposals, anchorNodeId) => {
          appended.push({ proposals, anchorNodeId })
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

const adviseCommands = () =>
  seen.filter(
    (command): command is Extract<Command, { type: 'workflows.operatorAdvise' }> =>
      command.type === 'workflows.operatorAdvise',
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

  it('hands the proposals to the editor with the anchor the request used', async () => {
    await render()
    await act(async () => {
      buttonByText('operatorAiFabLabel')?.click()
    })
    await typeInto('打开百度并点击第一个结果')
    await send()

    expect(appended).toEqual([
      {
        proposals: [{ blockId: 'new-tab', data: { url: 'https://b' }, rationale: '' }],
        anchorNodeId: 'n2',
      },
    ])
    expect(container.textContent).toContain('已添加两个算子')
    expect(container.textContent).toContain('operatorAiAdded')
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

    expect(appended).toEqual([])
    expect(container.textContent).toContain('No AI provider is configured with an API key.')
    expect(container.textContent).toContain('operatorAiFailed')
    expect(container.textContent).not.toContain('operatorAiAdded')
  })

  it('says what the canvas refused to place', async () => {
    landing = { added: 0, skipped: [], missing: [], problem: 'branch-anchor' }
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
