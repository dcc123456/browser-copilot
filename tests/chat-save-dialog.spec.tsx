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
 * 4. cancel closes the dialog and keeps the card;
 * 5. the toolbar switch gates the whole flow: off → no card, no history query,
 *    and flipping it persists `chatWorkflowPromptEnabled` into settings.
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

/** The command channel: a verdict drop of the second step, like a real review. */
let reviewBehavior: 'ok' | 'fail' = 'ok'
/** When true the review reply parks until the test releases it. */
let holdReview = false
let releaseReview: (() => void) | null = null
const saveCommands: Extract<Command, { type: 'workflows.save' }>[] = []
/** Settings payload served by the `settings.get` mock; tests may override. */
let settingsPayload: Record<string, unknown> = { mode: 'semi' }

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
  settingsPayload = { mode: 'semi' }
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
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn(() => fakePort),
      sendMessage: vi.fn(async () => undefined),
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

  it('shows no card and sends no history query when the toolbar switch is off', async () => {
    settingsPayload = { mode: 'semi', chatWorkflowPromptEnabled: false }
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
      expect(container.textContent).not.toContain('Save as workflow')
      // Gated BEFORE any work: not even the history lookup happens.
      const historyCalls = mocks.sendCommand.mock.calls.filter(
        ([command]) => (command as Command).type === 'history.list',
      )
      expect(historyCalls).toHaveLength(0)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('persists the toolbar switch and stops offering after it is turned off', async () => {
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

      // The toolbar toggle is an icon button; it defaults to pressed
      // (historical behavior) and explains itself on hover via `title`.
      const toggle = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.getAttribute('aria-label') === 'Offer to save workflow',
      )
      expect(toggle).toBeDefined()
      expect(toggle!.getAttribute('aria-pressed')).toBe('true')
      expect(toggle!.getAttribute('title')).toContain('workflow')

      // All three toolbar controls are icon-only buttons that render their
      // lucide icon as an inline <svg>; if an icon import is ever dropped the
      // button still exists but paints nothing, so pin the svg presence.
      for (const label of ['Attach selection', 'Offer to save workflow', 'History']) {
        const button = [...container.querySelectorAll('button')].find(
          (candidate) => candidate.getAttribute('aria-label') === label,
        )
        expect(button, label).toBeDefined()
        expect(button!.querySelector('svg'), label).not.toBeNull()
      }

      // Clicking it off persists the setting and dismisses any open card.
      await act(async () => {
        toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
      expect(toggle!.getAttribute('aria-pressed')).toBe('false')
      expect(settingsPayload.chatWorkflowPromptEnabled).toBe(false)

      // A subsequent turn end stays quiet: no card, no history query.
      await act(async () => {
        for (const listener of portMessageListeners) listener({ type: 'done' })
      })
      await flush()
      expect(container.textContent).not.toContain('Save as workflow')
      expect(
        mocks.sendCommand.mock.calls.filter(
          ([command]) => (command as Command).type === 'history.list',
        ),
      ).toHaveLength(0)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
