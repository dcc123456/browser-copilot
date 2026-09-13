// @vitest-environment jsdom
/**
 * Component test for the M4 Resume action on a workflow card
 * (`sidepanel/WorkflowsTab`), driving the REAL component with a mocked command
 * channel. Pins the contract that makes the button trustworthy:
 *
 * 1. the button is offered ONLY where the worker reports a clean checkpoint — a
 *    workflow whose last run succeeded is never probed and never gets a button,
 *    so Resume can never silently re-run a whole workflow;
 * 2. clicking it resumes the run the probe named (the panel has no other source
 *    for that run id — `TaskRunLog` does not carry one), and the banner reports
 *    the step it picked up after, converting the 0-based `resumedFrom`;
 * 3. a failed resume keeps the clickable banner that deep-links into History;
 * 4. the tab's 5s refresh does not re-probe an unchanged workflow.
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
import type { Command, CommandResult } from '../src/lib/messages'
import type { TaskRunLog } from '../src/lib/scheduler-types'
import type { Workflow } from '../src/lib/workflow/types'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import WorkflowsTab from '../src/sidepanel/WorkflowsTab'

type ProbeCommand = Extract<Command, { type: 'workflows.resumePoint' }>
type ResumeCommand = Extract<Command, { type: 'workflows.resume' }>
type ResumeReply = Extract<CommandResult, { type: 'workflows.resume' }>
type ProbeReply = Extract<CommandResult, { type: 'workflows.resumePoint' }>

const RESUME = messagesFor('en').workflowsResume
const RESUMED_OK = messagesFor('en').workflowsResumedOk

function workflow(id: string, name: string): Workflow {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes: [], edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

/**
 * A persisted run. `workflowId` is the durable link to its workflow; `label` is
 * the user-editable name and only a fallback for records that predate the id.
 */
function run(label: string, ok: boolean, at: number, workflowId?: string): TaskRunLog {
  return {
    id: `run-${at}`,
    ...(workflowId ? { workflowId } : {}),
    label,
    trigger: 'manual',
    at,
    ok,
    skipped: false,
    summary: '',
  }
}

let workflows: Workflow[] = []
let runs: TaskRunLog[] = []
/** What `workflows.resumePoint` answers for a given workflow. */
let resumePointFor: (id: string) => ProbeReply = () => ({
  type: 'workflows.resumePoint',
  resumable: false,
})
let resumeReply: ResumeReply = {
  type: 'workflows.resume',
  outcome: { ok: true, summary: '', runId: 'run-9', resumedFrom: 2 },
}
const seen: Command[] = []

beforeEach(() => {
  workflows = []
  runs = []
  resumePointFor = () => ({ type: 'workflows.resumePoint', resumable: false })
  resumeReply = {
    type: 'workflows.resume',
    outcome: { ok: true, summary: '', runId: 'run-9', resumedFrom: 2 },
  }
  seen.length = 0
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    switch (command.type) {
      case 'workflows.list':
        return { type: 'workflows.list', workflows }
      case 'tasks.runs':
        return { type: 'tasks.runs', runs }
      case 'workflows.takeoverPending':
        return { type: 'workflows.takeoverPending', items: [] }
      case 'record.status':
        return { type: 'record.status', recording: false }
      case 'workflows.resumePoint':
        return resumePointFor(command.id)
      case 'workflows.resume':
        return resumeReply
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => path },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
    windows: { create: vi.fn(), getCurrent: vi.fn(async () => ({ id: 1 })) },
    tabs: { create: vi.fn() },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const render = async (): Promise<{ container: HTMLElement; root: Root }> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        { value: { locale: 'en' as const, t: messagesFor('en') } },
        createElement(WorkflowsTab),
      ),
    )
  })
  await flush()
  return { container, root }
}

/** The visible button carrying exactly this label, if any. */
const buttonByText = (container: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined

const probes = (): ProbeCommand[] =>
  seen.filter((command): command is ProbeCommand => command.type === 'workflows.resumePoint')
const resumes = (): ResumeCommand[] =>
  seen.filter((command): command is ResumeCommand => command.type === 'workflows.resume')

const bannerText = (container: HTMLElement): string =>
  container.querySelector('.banner-text')?.textContent ?? ''

describe('workflow card Resume action (M4)', () => {
  it('offers Resume only for the workflow the worker can resume', async () => {
    workflows = [workflow('wf-broken', 'Broken flow'), workflow('wf-fine', 'Fine flow')]
    // Both ran; only the broken one did not settle cleanly.
    runs = [run('Broken flow', false, 200), run('Fine flow', true, 100)]
    resumePointFor = (id) =>
      id === 'wf-broken'
        ? { type: 'workflows.resumePoint', resumable: true, runId: 'run-9', fromStepIndex: 2 }
        : { type: 'workflows.resumePoint', resumable: false }

    const { container, root } = await render()

    // The failed workflow is the only candidate, so it is the only one probed.
    expect(probes().map((command) => command.id)).toEqual(['wf-broken'])
    const cards = [...container.querySelectorAll('.task-item')] as HTMLElement[]
    expect(cards).toHaveLength(2)
    const [broken, fine] = cards as [HTMLElement, HTMLElement]
    expect(buttonByText(broken, RESUME)).toBeDefined()
    expect(buttonByText(fine, RESUME)).toBeUndefined()

    await act(async () => root.unmount())
  })

  it('probes nothing when every workflow settled cleanly', async () => {
    workflows = [workflow('wf-fine', 'Fine flow')]
    runs = [run('Fine flow', true, 100)]

    const { container, root } = await render()

    // A clean run has nothing after its last step, so asking would be pointless.
    expect(probes()).toEqual([])
    expect(buttonByText(container, RESUME)).toBeUndefined()

    await act(async () => root.unmount())
  })

  it('resumes the probed run and reports the step it continued after', async () => {
    workflows = [workflow('wf-broken', 'Broken flow')]
    runs = [run('Broken flow', false, 200)]
    resumePointFor = () => ({
      type: 'workflows.resumePoint',
      resumable: true,
      runId: 'run-9',
      fromStepIndex: 2,
    })

    const { container, root } = await render()
    const button = buttonByText(container, RESUME)
    expect(button).toBeDefined()

    await act(async () => {
      button!.click()
    })
    await flush()

    // The run id comes from the probe — the panel has no other source for it.
    expect(resumes()).toEqual([
      expect.objectContaining({ type: 'workflows.resume', id: 'wf-broken', runId: 'run-9' }),
    ])
    // `resumedFrom` is 0-based; the copy is 1-based.
    expect(bannerText(container)).toBe(RESUMED_OK({ step: 3 }))

    await act(async () => root.unmount())
  })

  it('keeps the clickable History deep link when a resume fails', async () => {
    workflows = [workflow('wf-broken', 'Broken flow')]
    runs = [run('Broken flow', false, 200)]
    resumePointFor = () => ({
      type: 'workflows.resumePoint',
      resumable: true,
      runId: 'run-9',
      fromStepIndex: 2,
    })
    resumeReply = {
      type: 'workflows.resume',
      outcome: { ok: false, summary: 'click failed', error: 'click failed', runId: 'run-9' },
    }

    const { container, root } = await render()
    const opened: unknown[] = []
    const onOpen = (event: Event): void => {
      opened.push((event as CustomEvent).detail)
    }
    window.addEventListener('bc:open-history', onOpen)

    await act(async () => {
      buttonByText(container, RESUME)!.click()
    })
    await flush()

    const banner = container.querySelector('.banner') as HTMLElement
    expect(banner.classList.contains('banner-link')).toBe(true)
    expect(bannerText(container)).toContain('click failed')

    await act(async () => {
      banner.click()
    })
    expect(opened).toEqual([{ section: 'workflowRuns', runId: 'run-9' }])
    window.removeEventListener('bc:open-history', onOpen)

    await act(async () => root.unmount())
  })

  it('does not re-probe an unchanged workflow on the periodic refresh', async () => {
    // Fake only the interval and the clock: `flush` still needs a real
    // setTimeout, and the refresh's own 4s guard reads `Date.now()`.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    workflows = [workflow('wf-broken', 'Broken flow')]
    runs = [run('Broken flow', false, 200)]
    resumePointFor = () => ({
      type: 'workflows.resumePoint',
      resumable: true,
      runId: 'run-9',
      fromStepIndex: 2,
    })

    const { root } = await render()
    expect(probes()).toHaveLength(1)

    // Two refresh ticks: the (workflow, last-run) signature is unchanged, so the
    // tab must not turn its 5s poll into a storage read per workflow.
    for (let tick = 0; tick < 2; tick += 1) {
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })
      await flush()
    }
    expect(probes()).toHaveLength(1)

    await act(async () => root.unmount())
  })

  it('attributes a run by workflow id, so a rename does not orphan it', async () => {
    // The workflow was renamed AFTER the run, so the run still carries the old
    // label. Only the id can tie the two together.
    workflows = [workflow('wf-a', 'Checkout flow')]
    runs = [run('Login flow', false, 200, 'wf-a')]
    resumePointFor = () => ({
      type: 'workflows.resumePoint',
      resumable: true,
      runId: 'run-200',
      fromStepIndex: 1,
    })

    const { container, root } = await render()

    expect(probes().map((command) => command.id)).toEqual(['wf-a'])
    expect(buttonByText(container, RESUME)).toBeDefined()

    await act(async () => root.unmount())
  })

  it("does not let a same-named workflow claim another one's run", async () => {
    // Two workflows share a name; only wf-a has a failed run. Matching on the
    // label would hand wf-b the run — and a Resume button — as well.
    workflows = [workflow('wf-a', 'Sync'), workflow('wf-b', 'Sync')]
    runs = [run('Sync', false, 200, 'wf-a')]
    resumePointFor = () => ({
      type: 'workflows.resumePoint',
      resumable: true,
      runId: 'run-200',
      fromStepIndex: 1,
    })

    const { container, root } = await render()

    expect(probes().map((command) => command.id)).toEqual(['wf-a'])
    const cards = [...container.querySelectorAll('.task-item')] as HTMLElement[]
    expect(cards).toHaveLength(2)
    expect(buttonByText(cards[0]!, RESUME)).toBeDefined()
    expect(buttonByText(cards[1]!, RESUME)).toBeUndefined()

    await act(async () => root.unmount())
  })

  it('still matches a legacy run that carries only its label', async () => {
    // Records persisted before the id existed must keep working, otherwise
    // upgrading would silently hide Resume for every pre-existing run.
    workflows = [workflow('wf-a', 'Login flow')]
    runs = [run('Login flow', false, 200)]
    resumePointFor = () => ({
      type: 'workflows.resumePoint',
      resumable: true,
      runId: 'run-200',
      fromStepIndex: 1,
    })

    const { container, root } = await render()

    expect(probes().map((command) => command.id)).toEqual(['wf-a'])
    expect(buttonByText(container, RESUME)).toBeDefined()

    await act(async () => root.unmount())
  })
})
