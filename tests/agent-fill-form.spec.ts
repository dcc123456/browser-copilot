/**
 * The batched form pair at the agent level: `form_fields` then `fill_form`
 * (see specs/2026-11-12-batch-form-fill-design.md).
 *
 * What is pinned here is the contract the model sees, because that contract is
 * the whole speed-up: one read that returns refs, ONE write injection for the
 * batch, one read-back that compares in the page, and a `failed` list carrying
 * only the fields to retry. The history side matters just as much — a batch
 * must still record one replayable step per field, or "save this conversation
 * as a workflow" loses the form.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runAgentTurn, TOOLS } from '../src/background/agent'
import type { AgentServerMessage } from '../src/lib/messages'
import { streamCompletion } from '../src/lib/llm'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const execMock = vi.fn()
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execOnActiveTab: (...args: unknown[]) => execMock(...args),
    // The auto-observation's snapshot: a page that did not navigate, so the
    // batch's one trailing observation is what the test asserts on.
    snapshotActiveTab: async () => ({
      url: 'https://forms.test/signup',
      title: 'Sign up',
      text: '',
      truncated: false,
      selection: '',
      elements: [],
      elementsTruncated: false,
      frameUrl: 'https://forms.test/signup',
      isTopFrame: true,
      forms: [],
      scrollHeight: 0,
      scrollY: 0,
      viewportHeight: 0,
    }),
  }
})

const addHistoryMock = vi.fn(async (_entry: unknown) => {})
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: async () => ({ apiKey: 'k', baseUrl: 'https://x', model: 'm', label: 't' }),
    addHistory: (entry: unknown) => addHistoryMock(entry),
  }
})

const streamMock = vi.mocked(streamCompletion)
const sent: AgentServerMessage[] = []

const FIELD_TARGETS = {
  name: { primary: { how: 'id', value: 'name' }, fallbacks: [] },
  city: { primary: { how: 'id', value: 'city' }, fallbacks: [] },
  plan: { primary: { how: 'id', value: 'plan' }, fallbacks: [] },
} as const

function fieldEntries() {
  return [
    { ref: 'e1', label: 'Name', tag: 'input', type: 'text', value: '', target: FIELD_TARGETS.name },
    { ref: 'e2', label: 'City', tag: 'input', type: 'text', target: FIELD_TARGETS.city },
    { ref: 'e3', label: 'Plan', tag: 'select', target: FIELD_TARGETS.plan },
  ]
}

function call(name: string, id: string, args: Record<string, unknown>) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }
}

function deps() {
  return {
    send: (message: AgentServerMessage): void => {
      sent.push(message)
    },
    confirm: vi.fn(async () => true),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 6,
    getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
  }
}

function toolContents(history: { role: string; content?: unknown }[]): string[] {
  return history
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
}

/** Driver stub keyed by op.action; every other op answers "page is stable". */
function stubKernel(
  write: { ok: boolean; note?: string; results?: unknown[] },
  verify: { ok: boolean; note?: string; results?: unknown[] },
) {
  execMock.mockImplementation(async (op: { action?: string }) => {
    if (op.action === 'form_fields') {
      return {
        ok: true,
        found: true,
        note: '3 fillable fields',
        data: { url: 'https://forms.test/signup', title: 'Sign up', fields: fieldEntries() },
      }
    }
    if (op.action === 'fill_form') {
      return {
        ok: write.ok,
        found: true,
        ...(write.note ? { note: write.note } : {}),
        data: { results: write.results },
      }
    }
    if (op.action === 'verify_fields') {
      return {
        ok: verify.ok,
        found: true,
        ...(verify.note ? { note: verify.note } : {}),
        data: { results: verify.results },
      }
    }
    if (op.action === 'page_signature') return { ok: true, found: true, data: 'sig' }
    return { ok: true, found: true, data: null }
  })
}

const WRITE_ALL = {
  ok: true,
  note: '3/3 fields written',
  results: [
    { i: 0, ok: true, found: true, kind: 'text' },
    { i: 1, ok: true, found: true, kind: 'text' },
    { i: 2, ok: true, found: true, kind: 'select' },
  ],
}

beforeEach(() => {
  sent.length = 0
  execMock.mockReset()
  addHistoryMock.mockClear()
})

describe('form_fields read', () => {
  it('hands the model refs and values, never the locators', async () => {
    stubKernel(WRITE_ALL, { ok: true, note: '3/3 fields verified', results: [] })
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [call('form_fields', 'c1', {})] } as never)
      .mockResolvedValueOnce({ content: 'listed', toolCalls: [] } as never)

    const history: { role: string; content?: unknown }[] = [
      { role: 'user', content: 'what fields are here?' },
    ]
    await runAgentTurn(history as never, deps() as never)

    const listed = JSON.parse(toolContents(history)[0] ?? '{}') as Record<string, unknown>
    expect(listed.ok).toBe(true)
    expect(listed.count).toBe(3)
    expect(listed.url).toBe('https://forms.test/signup')
    const fields = listed.fields as Record<string, unknown>[]
    expect(fields.map((field) => field.ref)).toEqual(['e1', 'e2', 'e3'])
    expect(fields.every((field) => field.target === undefined)).toBe(true)
  })
})

describe('fill_form batch write', () => {
  async function runBatch(
    write: { ok: boolean; note?: string; results?: unknown[] },
    verify: { ok: boolean; note?: string; results?: unknown[] },
  ) {
    stubKernel(write, verify)
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [call('form_fields', 'c1', {})] } as never)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          call('fill_form', 'c2', {
            fields: [
              { ref: 'e1', value: 'Grace' },
              { ref: 'e2', value: 'Nanjing' },
              { ref: 'e3', value: 'Pro' },
            ],
            generated: false,
          }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'filled', toolCalls: [] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'fill it in' }]
    await runAgentTurn(history as never, deps() as never)
    return JSON.parse(toolContents(history)[1] ?? '{}') as Record<string, unknown>
  }

  it('writes the whole batch in one injection, then verifies once', async () => {
    const result = await runBatch(WRITE_ALL, {
      ok: true,
      note: '3/3 fields verified',
      results: [
        { i: 0, ok: true, found: true, kind: 'text' },
        { i: 1, ok: true, found: true, kind: 'text' },
        { i: 2, ok: true, found: true, kind: 'select' },
      ],
    })

    const writes = execMock.mock.calls.filter(
      (callArgs) => (callArgs[0] as { action?: string }).action === 'fill_form',
    )
    const reads = execMock.mock.calls.filter(
      (callArgs) => (callArgs[0] as { action?: string }).action === 'verify_fields',
    )
    expect(writes).toHaveLength(1)
    expect(reads).toHaveLength(1)
    const fields = (writes[0]?.[0] as { fields: { target: unknown }[] }).fields
    expect(fields).toHaveLength(3)
    expect(fields[0]?.target).toEqual(FIELD_TARGETS.name)
    expect((reads[0]?.[0] as { checks: unknown[] }).checks).toHaveLength(3)

    expect(result.ok).toBe(true)
    expect(result.filled).toBe(3)
    expect(result.attempted).toBe(3)
    expect(result.failed).toBeUndefined()
    // The observation the model needs to continue, taken once.
    expect(result.observation).toBeDefined()
  })

  it('reports only the fields that did not land, with the stage that lost them', async () => {
    const result = await runBatch(
      {
        ok: false,
        note: '2/3 fields written',
        results: [
          { i: 0, ok: true, found: true, kind: 'text' },
          { i: 1, ok: true, found: true, kind: 'text' },
          { i: 2, ok: false, found: true, kind: 'select', error: 'No option matched "Pro".' },
        ],
      },
      {
        ok: false,
        note: '1/2 fields verified',
        results: [
          { i: 0, ok: true, found: true, kind: 'text' },
          {
            i: 1,
            ok: false,
            found: true,
            kind: 'text',
            error: 'The page does not hold the requested value.',
            expected: 'Nanjing',
            actual: '',
          },
        ],
      },
    )

    const failed = result.failed as Record<string, unknown>[]
    expect(result.ok).toBe(false)
    expect(result.filled).toBe(1)
    expect(failed).toHaveLength(2)
    expect(failed[0]).toMatchObject({
      ref: 'e2',
      label: 'City',
      stage: 'verify',
      expected: 'Nanjing',
    })
    expect(failed[1]).toMatchObject({ ref: 'e3', label: 'Plan', stage: 'write' })
    expect(String(result.note)).toContain('e2')
    expect(String(result.note)).toContain('e3')

    // Only the two fields the injection wrote are read back.
    const reads = execMock.mock.calls.filter(
      (callArgs) => (callArgs[0] as { action?: string }).action === 'verify_fields',
    )
    expect((reads[0]?.[0] as { checks: unknown[] }).checks).toHaveLength(2)
  })

  it('records one replayable history step per field', async () => {
    await runBatch(WRITE_ALL, {
      ok: true,
      note: '3/3 fields verified',
      results: [
        { i: 0, ok: true, found: true, kind: 'text' },
        { i: 1, ok: true, found: true, kind: 'text' },
        { i: 2, ok: true, found: true, kind: 'select' },
      ],
    })

    const steps = addHistoryMock.mock.calls
      .map((args) => args[0] as { action: string; args?: Record<string, unknown>; ok?: boolean })
      .filter((entry) => entry.action !== 'form_fields' && entry.action !== 'fill_form')
    expect(steps.map((step) => step.action)).toEqual(['fill', 'fill', 'select_option'])
    expect(steps[0]?.args?.target).toEqual(FIELD_TARGETS.name)
    expect(steps[0]?.args?.value).toBe('Grace')
    expect(steps[0]?.args?.generated).toBe(false)
    expect(steps.every((step) => step.ok === true)).toBe(true)
  })

  it('files each field under the operator that actually replays it', async () => {
    // A mixed form is one batch call, but N history steps with DIFFERENT
    // actions: the kind comes back from the page, never from what the model
    // asked for, so a dropdown filled inside a text-shaped call still replays
    // as select_option when the conversation is saved as a workflow.
    await runBatch(
      {
        ok: true,
        note: '3/3 fields written',
        results: [
          { i: 0, ok: true, found: true, kind: 'select' },
          { i: 1, ok: true, found: true, kind: 'radio' },
          { i: 2, ok: true, found: true, kind: 'checkbox' },
        ],
      },
      {
        ok: true,
        note: '3/3 fields verified',
        results: [
          { i: 0, ok: true, found: true },
          { i: 1, ok: true, found: true },
          { i: 2, ok: true, found: true },
        ],
      },
    )

    const steps = addHistoryMock.mock.calls
      .map((args) => args[0] as { action: string; args?: Record<string, unknown> })
      .filter((entry) => entry.action !== 'form_fields' && entry.action !== 'fill_form')
    expect(steps.map((step) => step.action)).toEqual([
      'select_option',
      'set_checkbox',
      'set_checkbox',
    ])
  })

  it('refuses an unknown ref before touching the page', async () => {
    stubKernel(WRITE_ALL, { ok: true, results: [] })
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [call('fill_form', 'c1', { fields: [{ ref: 'e7', value: 'too soon' }] })],
      } as never)
      .mockResolvedValueOnce({ content: 'oops', toolCalls: [] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'fill it in' }]
    await runAgentTurn(history as never, deps() as never)

    const result = JSON.parse(toolContents(history)[0] ?? '{}') as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect((result.failed as Record<string, unknown>[])[0]?.stage).toBe('resolve')
    expect(
      execMock.mock.calls.filter(
        (callArgs) => (callArgs[0] as { action?: string }).action === 'fill_form',
      ),
    ).toHaveLength(0)
  })
})

/**
 * The ≥3-field threshold is only a behaviour because it is in the tool
 * descriptions — nothing in the code can tell "this task writes 3 values" from
 * "this page has 3 inputs". These assertions lock the steering text itself: an
 * edit that drops it silently sends the model back to one `fill` per field.
 */
describe('batch threshold in the advertised schemas', () => {
  function description(name: string): string {
    const tool = TOOLS.find((entry) => entry.function.name === name)
    return tool ? tool.function.description : ''
  }

  it('routes 3+ values to fill_form from both sides of the choice', () => {
    expect(description('fill_form')).toMatch(/3\+ field values/)
    expect(description('fill')).toMatch(/For 3\+ values use fill_form/)
    expect(description('form_fields')).toMatch(/3\+ values/)
    // A mixed form is the ≥3-field case too: two text fields, a dropdown and a
    // checkbox must not become four calls.
    expect(description('select_option')).toMatch(/For 3\+ values use fill_form/)
    expect(description('set_checkbox')).toMatch(/For 3\+ values use fill_form/)
  })

  it('no longer calls fill the preferred way to type', () => {
    expect(description('fill')).not.toMatch(/Preferred for ALL text entry/)
    expect(description('fill')).toMatch(/ONE/)
  })
})
