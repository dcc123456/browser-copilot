/**
 * Tests for the `ai-prompt` block executor: the raw completion it receives is
 * normalized before being stored in `lastAIResponse` (reasoning-model
 * `<think>` blocks and a wrapping code fence stripped), so downstream
 * `{{lastAIResponse}}` consumers never see wrapper junk. `streamCompletion`
 * and settings are mocked; no network.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const streamMock = vi.fn()
vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: (...args: unknown[]) => streamMock(...args) }
})

const getSettingsMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getSettings: (...args: unknown[]) => getSettingsMock(...args) }
})

import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

function makeCtx() {
  const emit = vi.fn((_kind: string, _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

describe('ai-prompt executor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSettingsMock.mockResolvedValue({
      providers: [{ id: 'p1', apiKey: 'k', baseUrl: 'https://x', model: 'm' }],
      activeProviderId: 'p1',
    })
  })

  it('stores a sanitized lastAIResponse: think blocks and the fence stripped', async () => {
    streamMock.mockResolvedValue({
      content: '<think>reasoning here</think>\n```json\n{"a": 1}\n```',
    })
    const { ctx, emit } = makeCtx()
    await EXECUTORS['ai-prompt']!({ prompt: 'give me json' }, ctx)
    expect(ctx.variables['lastAIResponse']).toBe('{"a": 1}')
    expect(emit).toHaveBeenCalledWith('result', '{"a": 1}')
  })

  it('passes plain-text replies through unchanged', async () => {
    streamMock.mockResolvedValue({ content: '  plain answer  ' })
    const { ctx } = makeCtx()
    await EXECUTORS['ai-prompt']!({ prompt: 'hi' }, ctx)
    expect(ctx.variables['lastAIResponse']).toBe('plain answer')
  })

  it('still fails the block (and empties the variable) when the call throws', async () => {
    streamMock.mockRejectedValue(new Error('boom'))
    const { ctx } = makeCtx()
    await expect(EXECUTORS['ai-prompt']!({ prompt: 'hi' }, ctx)).rejects.toThrow(/boom/)
    expect(ctx.variables['lastAIResponse']).toBe('')
  })
})
