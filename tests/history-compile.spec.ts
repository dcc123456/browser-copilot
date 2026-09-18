import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '../src/lib/types'

/**
 * `workflowFromHistory` is real here — only storage is mocked. The compiler is
 * the part that decides which actions become nodes, and asserting against a
 * stubbed compiler would only prove this module calls it.
 */
vi.mock('../src/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/storage')>()
  return { ...actual, listHistory: vi.fn(async () => [] as HistoryEntry[]) }
})

const { listHistory } = await import('../src/lib/storage')
const { compileConversationHistory } = await import('../src/background/history-compile')

const listHistoryMock = vi.mocked(listHistory)

let seq = 0
function entry(over: Partial<HistoryEntry> & { action: string }): HistoryEntry {
  seq += 1
  const { action, ...rest } = over
  return {
    id: `h${seq}`,
    at: seq,
    conversationId: 'conv-a',
    action,
    summary: action,
    approved: true,
    ok: true,
    ...rest,
  }
}

beforeEach(() => {
  seq = 0
  listHistoryMock.mockReset()
})

describe('compileConversationHistory', () => {
  it('compiles only this conversation’s actions', async () => {
    listHistoryMock.mockResolvedValue([
      entry({ action: 'open_url', args: { url: 'https://a.com' } }),
      entry({
        action: 'open_url',
        conversationId: 'conv-b',
        args: { url: 'https://other.com' },
      }),
      entry({ action: 'click', args: { target: '#go', ref: 'e1' } }),
    ])

    const out = await compileConversationHistory('conv-a', 'wf')

    expect(out.recorded).toBe(2)
    // `open_url` + the wait the compiler inserts after a navigation + `click`.
    expect(out.steps).toBe(3)
    const urls = out.workflow!.drawflow.nodes.map((n) => n.data?.['url'])
    expect(urls).not.toContain('https://other.com')
  })

  it('turns business literals into workflow inputs instead of freezing them', async () => {
    // The whole reason the history path was rejected as a workflow source in
    // 2026-09-17. A URL or a search keyword typed during generation must not
    // survive as a literal, or the saved workflow repeats that one run forever.
    listHistoryMock.mockResolvedValue([
      entry({ action: 'open_url', args: { url: 'https://a.com' } }),
      entry({ action: 'fill', args: { selector: '#q', value: 'iPhone' } }),
    ])

    const out = await compileConversationHistory('conv-a', 'wf')
    // Steps must hold references, not the values of the run that produced them.
    const steps = out.workflow!.drawflow.nodes.filter((n) => n.data?.['blockId'] !== 'trigger')
    const graph = JSON.stringify(steps)

    expect(graph).not.toContain('iPhone')
    expect(graph).not.toContain('https://a.com')
    expect(graph).toContain('{{newTabUrl}}')
    expect(graph).toContain('{{formsValue}}')
    expect(out.declaredInputs.sort()).toEqual(['formsValue', 'newTabUrl'])

    // The observed values survive as DEFAULTS on the trigger, so the workflow
    // runs as generated while staying editable — that is what makes the inputs
    // useful rather than empty placeholders.
    const trigger = out.workflow!.drawflow.nodes.find((n) => n.data?.['blockId'] === 'trigger')
    const parameters = trigger!.data!['parameters'] as { name: string; defaultValue: string }[]
    expect(parameters.find((p) => p.name === 'formsValue')?.defaultValue).toBe('iPhone')
    expect(parameters.find((p) => p.name === 'newTabUrl')?.defaultValue).toBe('https://a.com')
  })

  it('leaves structural parameters literal — a selector is not business data', async () => {
    listHistoryMock.mockResolvedValue([
      entry({ action: 'fill', args: { selector: '#search-box', value: 'iPhone' } }),
    ])

    const out = await compileConversationHistory('conv-a', 'wf')
    const graph = JSON.stringify(out.workflow!.drawflow.nodes)

    // Dynamicising a selector would make the node unreadable AND unreplayable.
    expect(graph).toContain('#search-box')
  })

  it('drops failed actions — replaying one would only fail again', async () => {
    listHistoryMock.mockResolvedValue([
      entry({ action: 'open_url', args: { url: 'https://a.com' } }),
      entry({ action: 'click', ok: false, args: { selector: '#missing' } }),
      entry({ action: 'click', args: { selector: '#go' } }),
    ])

    const out = await compileConversationHistory('conv-a', 'wf')

    expect(out.recorded).toBe(3)
    expect(out.failed).toBe(1)
    // The failed click is gone; the surviving two steps plus the navigation
    // wait remain.
    expect(out.steps).toBe(3)
    const selectors = out.workflow!.drawflow.nodes.map((n) => n.data?.['selector'])
    expect(selectors).toContain('#go')
    expect(selectors).not.toContain('#missing')
  })

  it('walks the actions in the order they happened', async () => {
    // `listHistory` returns newest-first, so a naive pass would build the
    // graph backwards.
    listHistoryMock.mockResolvedValue([
      entry({ at: 300, action: 'click', args: { target: '#c' } }),
      entry({ at: 200, action: 'fill', args: { target: '#b', value: 'x' } }),
      entry({ at: 100, action: 'open_url', args: { url: 'https://a.com' } }),
    ])

    const out = await compileConversationHistory('conv-a', 'wf')
    const blockIds = out.workflow!.drawflow.nodes.map((n) => n.data?.['blockId'])

    expect(blockIds).toEqual([
      'trigger',
      'new-tab',
      // The compiler paces the replay with a wait after every navigation.
      'wait-connections',
      'forms',
      'event-click',
    ])
  })

  it('returns no workflow when nothing compiles to a step', async () => {
    // `read_current_page` has no block mapping: it is not replayable.
    listHistoryMock.mockResolvedValue([entry({ action: 'read_current_page' })])

    const out = await compileConversationHistory('conv-a', 'wf')

    expect(out.workflow).toBeNull()
    expect(out.steps).toBe(0)
  })
})
