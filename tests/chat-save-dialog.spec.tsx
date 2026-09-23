// @vitest-environment jsdom
/**
 * Component test for the ChatTab save-as-workflow flow ("保存为工作流"),
 * driving the REAL ChatTab component with a mocked command channel. Pins the
 * zero-token interaction contract:
 *
 * 1. clicking "Save as workflow" on the card saves DIRECTLY — exactly one
 *    `workflows.save` and ZERO `workflows.review` commands (no model tokens);
 * 2. the AI node review is opt-in via "AI refine…": it opens the review
 *    dialog, starts immediately, shows no confirm while in flight, and the
 *    landed verdict prunes the saved workflow;
 * 3. a failed review still ends with a confirm button (keep everything);
 * 4. cancel closes the dialog and keeps the card.
 */
import { beforeAll, afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
}))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom implements neither scrolling API; the transcript log auto-scrolls.
  for (const method of ['scrollTo', 'scrollBy'] as const) {
    Object.defineProperty(Element.prototype, method, { value: () => {}, configurable: true })
  }
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => {},
    configurable: true,
  })
})

import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AGENT_PORT, type Command } from '../src/lib/messages'
import type { HistoryEntry } from '../src/lib/types'
import type { Workflow } from '../src/lib/workflow/types'
import { reviewStepsOf } from '../src/lib/workflow/review-patch'
import ChatTab from '../src/sidepanel/ChatTab'

type Args = Record<string, unknown>

let seq = 0
function entry(action: string, args?: Args): HistoryEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    at: seq,
    conversationId: 'default',
    action,
    summary: action,
    approved: true,
    ok: true,
    ...(args ? { args } : {}),
  }
}

const historyEntries = (): HistoryEntry[] => [
  entry('open_url', { url: 'https://a.com' }),
  entry('click', { target: { primary: { how: 'css', value: '.go' } } }),
]

/**
 * The draft the operator-tool flow hands to the card in workflow mode: a
 * trigger + open-url + page-load wait + click. `reviewStepsOf` groups the
 * wait onto the open-url so the AI review sees exactly 2 steps
 * (open-url, click) — clicking `click` in a verdict drops only that node,
 * leaving the trigger + open-url + wait behind (3 nodes).
 */
function baseWorkflow(): Workflow {
  return {
    id: 'wf-base',
    name: 'demo-workflow',
    description: '',
    trigger: { type: 'manual' },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    table: [],
    drawflow: {
      nodes: [
        { id: 'n0', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
        {
          id: 'n1',
          label: 'open-url',
          position: { x: 160, y: 80 },
          data: { blockId: 'event-open-url', url: 'https://a.com', description: '打开页面' },
        },
        {
          id: 'n2',
          label: 'wait-connections',
          position: { x: 160, y: 220 },
          data: { blockId: 'wait-connections', description: '等待页面加载' },
        },
        {
          id: 'n3',
          label: 'click',
          position: { x: 160, y: 360 },
          data: { blockId: 'event-click', selector: '.go', description: '点击元素' },
        },
      ],
      edges: [
        { id: 'e0', source: 'n0', target: 'n1' },
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

/** The command channel: a verdict drop of the second step, like a real review. */
let reviewBehavior: 'ok' | 'fail' = 'ok'
/** When true the review reply parks until the test releases it. */
let holdReview = false
let releaseReview: (() => void) | null = null
const saveCommands: Extract<Command, { type: 'workflows.save' }>[] = []
const debugCommands: Extract<Command, { type: 'workflows.debug' }>[] = []
/** Settings payload served by the `settings.get` mock; tests may override. */
let settingsPayload: Record<string, unknown> = { mode: 'workflow' }
/**
 * What `workflows.draft.get` answers. Defaults to the compiled draft; the
 * empty-result tests swap in the two "nothing to save" shapes.
 */
let draftReply: unknown = { type: 'workflows.draft', workflow: baseWorkflow() }
/** What `workflows.probe` answers — `null` means "could not probe". */
let probeReply: unknown = null

const portMessageListeners: ((message: unknown) => void)[] = []
const fakePort = {
  postMessage: vi.fn(),
  disconnect: vi.fn(),
  onMessage: {
    addListener: (fn: (message: unknown) => void) => portMessageListeners.push(fn),
    removeListener: (fn: (message: unknown) => void) => {
      const index = portMessageListeners.indexOf(fn)
      if (index >= 0) portMessageListeners.splice(index, 1)
    },
  },
  onDisconnect: { addListener: () => {}, removeListener: () => {} },
}

beforeEach(() => {
  reviewBehavior = 'ok'
  holdReview = false
  releaseReview = null
  saveCommands.length = 0
  debugCommands.length = 0
  settingsPayload = { mode: 'workflow' }
  draftReply = { type: 'workflows.draft', workflow: baseWorkflow() }
  probeReply = null
  portMessageListeners.length = 0
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command) => {
    switch (command.type) {
      case 'history.list':
        return { type: 'history.list', entries: historyEntries() }
      case 'conversations.list':
        return { type: 'conversations.list', conversations: [] }
      case 'settings.get':
        return { type: 'settings', settings: settingsPayload }
      case 'settings.set':
        settingsPayload = { ...settingsPayload, ...command.patch }
        return { type: 'settings', settings: settingsPayload }
      case 'workflows.draft.get':
        return draftReply
      case 'workflows.probe':
        return { type: 'workflows.probe', probes: probeReply }
      case 'workflows.draft.clear':
        return { type: 'workflows.draft.clear' }
      case 'workflows.review': {
        if (reviewBehavior === 'fail') throw new Error('AI review timed out after 60s.')
        const workflow = (command as { workflow: Workflow }).workflow
        const steps = reviewStepsOf(workflow)
        const reply = {
          type: 'workflows.review',
          review: {
            summary: '打开了页面并点击。',
            steps: steps.map((step, index) => ({
              id: step.id,
              keep: index !== 1,
              ...(index === 1 ? { reason: '探索性点击' } : {}),
            })),
          },
        }
        if (holdReview) {
          return new Promise((resolve) => {
            releaseReview = () => resolve(reply)
          })
        }
        return reply
      }
      case 'workflows.save':
        saveCommands.push(command)
        return { type: 'workflows.save' }
      case 'workflows.debug':
        debugCommands.push(command)
        return {
          type: 'workflows.debug',
          result: {
            ok: true,
            attempts: 1,
            summary: 'All steps completed without help.',
            takeovers: [],
            pendingChanges: [],
          },
        }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn(() => fakePort),
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chat save-as-workflow flow', () => {
  const flush = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  const openCard = async (container: HTMLElement, root: Root): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
      )
    })
    await flush()
    // The worker's end-of-turn `done` triggers the save-as-workflow card.
    await act(async () => {
      for (const listener of portMessageListeners) listener({ type: 'done' })
    })
    await flush()
    expect(container.textContent).toContain('Save as workflow')
  }

  const buttonTexts = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '')

  const clickButton = async (container: HTMLElement, label: string): Promise<void> => {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )
    expect(button).toBeDefined()
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
  }

  /** Click a button by a UNIQUE SUBSTRING (composite labels like the log toggle). */
  const clickButtonContaining = async (container: HTMLElement, label: string): Promise<void> => {
    const matches = [...container.querySelectorAll('button')].filter((candidate) =>
      candidate.textContent?.includes(label),
    )
    expect(matches).toHaveLength(1)
    await act(async () => {
      matches[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
  }

  const reviewCommandCount = (): number =>
    mocks.sendCommand.mock.calls.filter(
      ([command]) => (command as Command).type === 'workflows.review',
    ).length

  it('saves directly from the card with ZERO review calls (no model tokens)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await openCard(container, root)

      // Click "Save as workflow": the save goes out at once.
      await clickButton(container, 'Save as workflow')
      expect(saveCommands).toHaveLength(1)
      expect(reviewCommandCount()).toBe(0)
      // The card closed and a status line confirmed the save.
      expect(container.textContent).toContain('Saved workflow:')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('saves with hardened graph and does NOT verify-run unless the user opts in', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await openCard(container, root)
      await clickButton(container, 'Save as workflow')

      // Generation saves mark themselves so the background hardens the graph
      // (verified selectors + persisted waits); no verify run without the box.
      expect(saveCommands).toHaveLength(1)
      expect(saveCommands[0]!.fromGeneration).toBe(true)
      expect(debugCommands).toHaveLength(0)
      expect(container.textContent).not.toContain('Verify run started')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('verify run is opt-in: checking the box debug-runs the saved workflow once', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await openCard(container, root)

      // The verify-run checkbox sits next to the save actions.
      const verifyLabel = [...container.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('Verify run after save'),
      )
      expect(verifyLabel).toBeDefined()
      const checkbox = verifyLabel!.querySelector('input[type="checkbox"]')
      expect(checkbox).not.toBeNull()
      await act(async () => {
        checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      // The hint only shows while the box is checked.
      expect(container.textContent).toContain('costs one model call')
      await clickButton(container, 'Save as workflow')

      expect(saveCommands).toHaveLength(1)
      expect(debugCommands).toHaveLength(1)
      expect(debugCommands[0]!.id).toBe(saveCommands[0]!.workflow.id)
      // The verdict lands in the chat as status entries.
      expect(container.textContent).toContain('Verify run started')
      expect(container.textContent).toContain('Verify run passed')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('runs the opt-in AI review from "AI refine…" and saves the pruned workflow', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      holdReview = true
      await openCard(container, root)

      // "AI refine…" opens the review dialog and the review STARTS at once.
      await clickButton(container, 'AI refine…')
      expect(container.textContent).toContain('Sent 2 steps to the AI reviewer…')
      expect(container.textContent).toContain('AI is reviewing which nodes are worth keeping…')
      // No confirm button while the review is in flight.
      expect(buttonTexts(container)).not.toContain('Save workflow')
      // Exactly one review command, for the base workflow.
      expect(reviewCommandCount()).toBe(1)

      // The verdict lands: the save button appears; clicking saves once.
      await act(async () => {
        releaseReview?.()
      })
      await flush()
      expect(container.textContent).toContain('AI dropped 1 ineffective step')
      expect(buttonTexts(container)).toContain('Save workflow')
      await clickButton(container, 'Save workflow')
      expect(saveCommands).toHaveLength(1)
      const saved = saveCommands[0]!.workflow
      // Trigger + new-tab + its page-load wait; the AI-dropped click is gone.
      expect(saved.drawflow.nodes).toHaveLength(3)
      const blockIds = saved.drawflow.nodes.map((node) => node.data?.blockId)
      expect(blockIds).not.toContain('event-click')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('keeps every step and still offers the save after a failed review', async () => {
    reviewBehavior = 'fail'
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await openCard(container, root)
      await clickButton(container, 'AI refine…')
      await flush()
      expect(container.textContent).toContain('Review failed')
      // A settled (failed) review still ends with a confirm button.
      expect(buttonTexts(container)).toContain('Save workflow')
      await clickButton(container, 'Save workflow')
      expect(saveCommands).toHaveLength(1)
      // Unavailable review keeps EVERYTHING (4 nodes incl. the click + wait).
      expect(saveCommands[0]!.workflow.drawflow.nodes).toHaveLength(4)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('cancel closes the review dialog and keeps the save card', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await openCard(container, root)
      await clickButton(container, 'AI refine…')
      expect(container.textContent).toContain('Review steps before saving')
      await clickButton(container, 'Cancel')
      expect(container.textContent).not.toContain('Review steps before saving')
      expect(container.textContent).toContain('Save as workflow')
      expect(saveCommands).toHaveLength(0)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('connects the agent port under the AGENT_PORT name', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await openCard(container, root)
      expect(vi.mocked(chrome.runtime.connect)).toHaveBeenCalledWith({ name: AGENT_PORT })
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('shows live pushed review-log lines and can collapse the log', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      // Hold the review so the dialog stays in-flight while lines are pushed.
      holdReview = true
      await openCard(container, root)
      await clickButton(container, 'AI refine…')
      // The collapsible log section is visible with the local start line.
      expect(container.textContent).toContain('Review log')
      expect(container.textContent).toContain('Sent 2 steps to the AI reviewer…')

      // The worker pushes live lines over the agent port mid-review.
      await act(async () => {
        for (const listener of [...portMessageListeners]) {
          listener({ type: 'workflows.reviewLog', text: 'Model: test-model · reviewing 2 steps…' })
        }
      })
      await flush()
      expect(container.textContent).toContain('Model: test-model · reviewing 2 steps…')

      // Collapse hides the lines but keeps the header; expand restores them.
      await clickButtonContaining(container, 'Collapse')
      expect(container.textContent).not.toContain('Model: test-model · reviewing 2 steps…')
      expect(container.textContent).toContain('Review log')
      expect(container.textContent).toContain('Expand')
      await clickButtonContaining(container, 'Expand')
      expect(container.textContent).toContain('Model: test-model · reviewing 2 steps…')

      // The verdict lands and its outcome line joins the log.
      await act(async () => {
        releaseReview?.()
      })
      await flush()
      expect(container.textContent).toContain('AI dropped 1 ineffective step')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('retries a failed review from the dialog and saves the new verdict', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      // First attempt fails (e.g. the MV3 mid-stream abort the user reported).
      reviewBehavior = 'fail'
      await openCard(container, root)
      await clickButton(container, 'AI refine…')
      await flush()
      expect(container.textContent).toContain('Retry review')

      // Retry: hold the second attempt, assert the in-flight state again.
      reviewBehavior = 'ok'
      holdReview = true
      await clickButton(container, 'Retry review')
      // The retry button is gone while the second attempt is in flight (the
      // failed log LINE still mentions retrying, so assert on the button).
      expect(buttonTexts(container)).not.toContain('Retry review')
      expect(container.textContent).toContain('AI is reviewing which nodes are worth keeping…')
      expect(buttonTexts(container)).not.toContain('Save workflow')
      // Two review commands now, and a second "sent" log line.
      expect(reviewCommandCount()).toBe(2)
      expect(container.textContent.match(/Sent 2 steps to the AI reviewer…/g)).toHaveLength(2)

      // The retried verdict lands and saves with its keep set.
      await act(async () => {
        releaseReview?.()
      })
      await flush()
      expect(buttonTexts(container)).toContain('Save workflow')
      await clickButton(container, 'Save workflow')
      expect(saveCommands).toHaveLength(1)
      expect(saveCommands[0]!.workflow.drawflow.nodes).toHaveLength(3)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('pops the save card from the operator-tool draft in workflow-generation mode', async () => {
    settingsPayload = { mode: 'workflow' }
    // The panel pulls the draft via workflows.draft.get on `done` and renders
    // the same review/save card. Stub the command to return a small draft so
    // we can assert the card appears and uses the draft text.
    const draftWorkflow: Workflow = {
      id: 'wf-draft',
      name: 'demo-draft',
      description: '',
      trigger: { type: 'manual' },
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      table: [],
      drawflow: {
        nodes: [
          {
            id: 'n1',
            label: 'open-url',
            position: { x: 0, y: 0 },
            data: { url: 'https://example.com' },
          },
          {
            id: 'n2',
            label: 'click-element',
            position: { x: 220, y: 0 },
            data: { selector: 'button.submit' },
          },
        ],
        edges: [],
      },
      createdAt: 1,
      updatedAt: 1,
    }
    mocks.sendCommand.mockImplementation(async (cmd: Command) => {
      if (cmd.type === 'workflows.draft.get')
        return { type: 'workflows.draft', workflow: draftWorkflow }
      if (cmd.type === 'workflows.draft.clear') return { type: 'workflows.draft.clear' }
      if (cmd.type === 'workflows.save') {
        saveCommands.push(cmd)
        return { type: 'workflows.save' }
      }
      if (cmd.type === 'settings.get') return { type: 'settings', settings: settingsPayload }
      if (cmd.type === 'settings.set') {
        settingsPayload = { ...settingsPayload, ...cmd.patch }
        return { type: 'settings', settings: settingsPayload }
      }
      if (cmd.type === 'conversations.list')
        return { type: 'conversations.list', conversations: [] }
      return { type: 'noop' } as never
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
        )
      })
      await flush()
      await act(async () => {
        for (const listener of portMessageListeners) listener({ type: 'done' })
      })
      await flush()

      // The panel must NOT fall through to the history path in workflow mode.
      const historyCalls = mocks.sendCommand.mock.calls.filter(
        ([command]) => (command as Command).type === 'history.list',
      )
      expect(historyCalls).toHaveLength(0)
      const draftCalls = mocks.sendCommand.mock.calls.filter(
        ([command]) => (command as Command).type === 'workflows.draft.get',
      )
      expect(draftCalls.length).toBeGreaterThan(0)

      // The card appears with the draft-source text and the workflow name.
      expect(container.textContent).toContain('demo-draft')
      expect(container.textContent).toMatch(/draft/i)
      expect(buttonTexts(container)).toContain('Save as workflow')

      // Saving clears the draft so a later turn starts fresh.
      await clickButton(container, 'Save as workflow')
      const clearCalls = mocks.sendCommand.mock.calls.filter(
        ([command]) => (command as Command).type === 'workflows.draft.clear',
      )
      expect(clearCalls).toHaveLength(1)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  /**
   * The regression that made this whole flow look deleted: the card stopped
   * appearing and the user had no way to tell "the feature is broken" from "the
   * model recorded nothing". Every turn must END WITH SOMETHING VISIBLE.
   */
  describe('empty results are explained, never silent', () => {
    const renderAndFinishTurn = async (): Promise<{
      container: HTMLElement
      root: Root
    }> => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
        )
      })
      await flush()
      await act(async () => {
        for (const listener of portMessageListeners) listener({ type: 'done' })
      })
      await flush()
      return { container, root }
    }

    const cleanup = async (container: HTMLElement, root: Root): Promise<void> => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }

    it('explains that no page operations were recorded', async () => {
      draftReply = { type: 'workflows.draft', empty: 'no-actions' }
      const { container, root } = await renderAndFinishTurn()
      try {
        expect(container.textContent).toContain('no page operations were recorded')
        expect(container.textContent).not.toContain('demo-workflow')
        // The notice is the only feedback now: the manual "Save as workflow"
        // button that used to sit next to the composer was removed on request.
        expect(buttonTexts(container)).not.toContain('Save as workflow')
      } finally {
        await cleanup(container, root)
      }
    })

    it('distinguishes "every action failed" from "nothing happened"', async () => {
      // Only one of the two is worth telling the user to retry.
      draftReply = { type: 'workflows.draft', empty: 'all-failed' }
      const { container, root } = await renderAndFinishTurn()
      try {
        expect(container.textContent).toContain('every recorded action failed')
        expect(container.textContent).not.toContain('no page operations were recorded')
      } finally {
        await cleanup(container, root)
      }
    })

    it('clears the notice once a later turn does have something to save', async () => {
      draftReply = { type: 'workflows.draft', empty: 'no-actions' }
      const { container, root } = await renderAndFinishTurn()
      try {
        expect(container.textContent).toContain('no page operations were recorded')
        draftReply = { type: 'workflows.draft', workflow: baseWorkflow() }
        await act(async () => {
          for (const listener of portMessageListeners) listener({ type: 'done' })
        })
        await flush()
        expect(container.textContent).not.toContain('no page operations were recorded')
        expect(container.textContent).toContain('demo-workflow')
      } finally {
        await cleanup(container, root)
      }
    })
  })

  /**
   * The manual "Save as workflow" button was removed on request: the save card
   * is meant to arrive on its own at the end of a workflow-mode turn, and a
   * second, manual way in only invited saving a draft that was never exercised.
   * These two cases pin the removal — the entry point must not come back
   * without the behaviour behind it.
   */
  describe('manual entry point is gone', () => {
    const draftRequests = (): unknown[] =>
      mocks.sendCommand.mock.calls.filter(
        ([command]) => (command as Command).type === 'workflows.draft.get',
      )

    const renderChat = async (): Promise<{ container: HTMLElement; root: Root }> => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
        )
      })
      await flush()
      return { container, root }
    }

    it('offers no manual button in workflow mode', async () => {
      const { container, root } = await renderChat()
      try {
        // Workflow mode is the default payload; the button used to live here.
        expect(buttonTexts(container)).not.toContain('Save as workflow')
        // The behaviour, not just the label: the manual button asked the worker
        // for the draft on click, so with no turn ended there must be no ask.
        expect(draftRequests()).toHaveLength(0)
        expect(container.textContent).not.toContain('demo-workflow')
      } finally {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      }
    })

    it('offers no manual button outside workflow mode', async () => {
      settingsPayload = { mode: 'full' }
      const { container, root } = await renderChat()
      try {
        expect(buttonTexts(container)).not.toContain('Save as workflow')
        expect(draftRequests()).toHaveLength(0)
      } finally {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      }
    })
  })
})
