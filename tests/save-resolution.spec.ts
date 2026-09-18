import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '../src/lib/types'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

/**
 * The save card's decision function.
 *
 * This exists because of a specific, shipped regression: the command behind the
 * card short-circuited on `composeWorkflowFromDraft`'s error result, so once the
 * mode stopped producing an operator draft the history fallback below it became
 * unreachable — the card silently stopped appearing and the feature looked
 * deleted. The tests below pin the ordering and, above all, that "no draft" is
 * not an early return.
 */

const { composeMock, listHistoryMock, fromHistoryMock } = vi.hoisted(() => ({
  composeMock: vi.fn(),
  listHistoryMock: vi.fn(),
  fromHistoryMock: vi.fn(),
}))

vi.mock('../src/background/operator-tool-handler', () => ({
  composeWorkflowFromDraft: (...args: unknown[]) => composeMock(...args),
}))

vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    listHistory: (...args: unknown[]) => listHistoryMock(...args),
    workflowFromHistory: (...args: unknown[]) => fromHistoryMock(...args),
  }
})

const { compileConversationHistory, resolveWorkflowForSave } =
  await import('../src/background/history-compile')

function makeWorkflow(nodes: WorkflowNode[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

const triggerNode: WorkflowNode = {
  id: 't',
  label: 'trigger',
  position: { x: 0, y: 0 },
  data: { blockId: 'trigger', type: 'manual' },
}

const actionNode = (id: string): WorkflowNode => ({
  id,
  label: 'forms',
  position: { x: 0, y: 0 },
  data: { blockId: 'forms', selector: '#q', value: '{{keyword}}' },
})

/** A draft carrying one real step. */
const draftWithStep = () => makeWorkflow([triggerNode, actionNode('a')])
/** What `composeWorkflowFromDraft` returns for a conversation with no draft. */
const NO_DRAFT = { error: 'No draft to compose' }

function historyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    conversationId: 'c1',
    at: 1,
    action: 'click',
    ok: true,
    ...overrides,
  } as HistoryEntry
}

beforeEach(() => {
  composeMock.mockReset()
  listHistoryMock.mockReset()
  fromHistoryMock.mockReset()
})

describe('resolveWorkflowForSave — source order', () => {
  it('prefers a non-empty operator draft and does not consult history', async () => {
    composeMock.mockResolvedValue({ workflow: draftWithStep() })

    const out = await resolveWorkflowForSave('c1', 'My flow')

    expect(out).toEqual({ workflow: expect.anything(), source: 'draft' })
    expect(listHistoryMock).not.toHaveBeenCalled()
    // `save: false`: the card is a preview, and the user commits by clicking.
    expect(composeMock).toHaveBeenCalledWith('c1', { save: false })
  })

  it('falls back to history when the draft is empty', async () => {
    // THE regression. Before this, an error result returned early and the card
    // never appeared.
    composeMock.mockResolvedValue(NO_DRAFT)
    listHistoryMock.mockResolvedValue([historyEntry()])
    fromHistoryMock.mockReturnValue(makeWorkflow([triggerNode, actionNode('h')]))

    const out = await resolveWorkflowForSave('c1', 'My flow')

    expect(out).toEqual({ workflow: expect.anything(), source: 'history' })
    expect(fromHistoryMock).toHaveBeenCalled()
  })

  it('falls back to history when the draft holds only its trigger head', async () => {
    // A trigger alone is not a workflow: `actionNodeCount` is what decides, not
    // "did compose return something".
    composeMock.mockResolvedValue({ workflow: makeWorkflow([triggerNode]) })
    listHistoryMock.mockResolvedValue([historyEntry()])
    fromHistoryMock.mockReturnValue(makeWorkflow([triggerNode, actionNode('h')]))

    const out = await resolveWorkflowForSave('c1', 'My flow')
    expect(out).toMatchObject({ source: 'history' })
  })

  it('passes the conversation title through as the workflow name', async () => {
    composeMock.mockResolvedValue(NO_DRAFT)
    listHistoryMock.mockResolvedValue([])
    fromHistoryMock.mockReturnValue(null)

    await resolveWorkflowForSave('c1', 'Book a table')
    expect(fromHistoryMock).toHaveBeenCalledWith([], 'Book a table')
  })
})

describe('resolveWorkflowForSave — the empty cases', () => {
  it('reports "no-actions" when the model never touched the page', async () => {
    composeMock.mockResolvedValue(NO_DRAFT)
    listHistoryMock.mockResolvedValue([])
    fromHistoryMock.mockReturnValue(null)

    expect(await resolveWorkflowForSave('c1', 'x')).toEqual({ empty: 'no-actions' })
  })

  it('reports "all-failed" when actions were recorded but none survived', async () => {
    // The two cases are not interchangeable: only one of them is worth telling
    // the user to retry.
    composeMock.mockResolvedValue(NO_DRAFT)
    listHistoryMock.mockResolvedValue([
      historyEntry({ id: 'h1', ok: false }),
      historyEntry({ id: 'h2', ok: false }),
    ])
    fromHistoryMock.mockReturnValue(null)

    expect(await resolveWorkflowForSave('c1', 'x')).toEqual({ empty: 'all-failed' })
  })

  it('counts another conversation’s actions as nothing at all', async () => {
    composeMock.mockResolvedValue(NO_DRAFT)
    listHistoryMock.mockResolvedValue([historyEntry({ conversationId: 'other' })])
    fromHistoryMock.mockReturnValue(null)

    expect(await resolveWorkflowForSave('c1', 'x')).toEqual({ empty: 'no-actions' })
  })

  it('never reports an empty result as an error', async () => {
    // "Nothing to save" is a normal outcome; treating it as an error is what
    // made the panel render nothing at all.
    composeMock.mockResolvedValue(NO_DRAFT)
    listHistoryMock.mockResolvedValue([])
    fromHistoryMock.mockReturnValue(null)

    const out = await resolveWorkflowForSave('c1', 'x')
    expect(out).not.toHaveProperty('error')
  })
})

describe('compileConversationHistory', () => {
  it('only compiles this conversation’s successful actions, oldest first', async () => {
    listHistoryMock.mockResolvedValue([
      historyEntry({ id: 'newest', at: 3 }),
      historyEntry({ id: 'failed', at: 2, ok: false }),
      historyEntry({ id: 'other', at: 2, conversationId: 'other' }),
      historyEntry({ id: 'oldest', at: 1 }),
    ])
    fromHistoryMock.mockReturnValue(makeWorkflow([triggerNode, actionNode('h')]))

    const out = await compileConversationHistory('c1', 'My flow')

    const passed = fromHistoryMock.mock.calls[0]![0] as HistoryEntry[]
    expect(passed.map((entry) => entry.id)).toEqual(['oldest', 'newest'])
    // Counted, so the caller can tell "did nothing" from "everything failed".
    expect(out.recorded).toBe(3)
    expect(out.failed).toBe(1)
    expect(out.steps).toBe(1)
  })

  it('rewrites business literals into references so the result is not a recording', async () => {
    // The history path must run the same dynamic-data pass as the operator
    // path; without it the compiled workflow types the keyword from the day it
    // was generated, forever.
    listHistoryMock.mockResolvedValue([historyEntry()])
    fromHistoryMock.mockReturnValue(
      makeWorkflow([
        triggerNode,
        {
          id: 'fill',
          label: 'forms',
          position: { x: 0, y: 0 },
          data: { blockId: 'forms', selector: '#q', value: 'iPhone' },
        },
      ]),
    )

    const out = await compileConversationHistory('c1', 'My flow')

    const node = out.workflow!.drawflow.nodes.find((n) => n.id === 'fill')!
    // The name is derived from the block when the model supplied no
    // `inputName`; the point of the assertion is that the literal is GONE from
    // the node body.
    expect(node.data['value']).toBe('{{formsValue}}')
    // The observed literal survives as the input default, so the workflow runs
    // as generated and stays editable on the trigger.
    expect(out.declaredInputs).toEqual(['formsValue'])
    const head = out.workflow!.drawflow.nodes.find((n) => n.data?.['blockId'] === 'trigger')!
    expect(head.data['parameters']).toEqual([
      expect.objectContaining({ name: 'formsValue', defaultValue: 'iPhone' }),
    ])
  })

  it('leaves structural parameters literal', async () => {
    // `selector` is not business data; turning it into `{{x}}` would make the
    // node unreadable rather than dynamic.
    listHistoryMock.mockResolvedValue([historyEntry()])
    fromHistoryMock.mockReturnValue(
      makeWorkflow([
        triggerNode,
        {
          id: 'click',
          label: 'event-click',
          position: { x: 0, y: 0 },
          data: { blockId: 'event-click', selector: '#submit' },
        },
      ]),
    )

    const out = await compileConversationHistory('c1', 'My flow')
    const node = out.workflow!.drawflow.nodes.find((n) => n.id === 'click')!
    expect(node.data['selector']).toBe('#submit')
    expect(out.declaredInputs).toEqual([])
  })

  it('returns a null workflow and no declared inputs when nothing compiles', async () => {
    listHistoryMock.mockResolvedValue([])
    fromHistoryMock.mockReturnValue(null)

    const out = await compileConversationHistory('c1', 'My flow')
    expect(out).toMatchObject({ workflow: null, steps: 0, declaredInputs: [], recorded: 0 })
  })
})
