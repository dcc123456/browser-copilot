import { beforeAll, describe, expect, it, vi } from 'vitest'

// The review call goes through the shared LLM client; the unit spec replaces it
// so failures/successes are simulated without a network.
vi.mock('../src/lib/llm', () => ({ streamCompletion: vi.fn() }))

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({ settings: storedSettings }),
        set: async () => {},
        remove: async () => {},
      },
    },
  })
})

import { streamCompletion } from '../src/lib/llm'
import {
  buildReviewPrompt,
  parseReview,
  reviewWorkflow,
  stripThinkBlocks,
} from '../src/background/workflow-engine/workflow-review'
import { reviewStepsOf } from '../src/lib/workflow/review-patch'
import { workflowFromHistory } from '../src/lib/storage'
import type { HistoryEntry } from '../src/lib/types'

/** Settings payload the chrome.storage stub serves; mutated per test. */
let storedSettings: Record<string, unknown> = {}

/** One configured provider, so reviewWorkflow gets past the provider check. */
const providerSettings = {
  providers: [
    {
      id: 'p1',
      label: 'Test',
      baseUrl: 'https://llm.test/v1',
      model: 'test-model',
      apiKey: 'sk-test',
    },
  ],
  activeProviderId: 'p1',
}

const streamMock = vi.mocked(streamCompletion)

type Args = Record<string, unknown>

let seq = 0
function entry(action: string, args?: Args): HistoryEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    at: seq,
    conversationId: 'conv-1',
    action,
    summary: action,
    approved: true,
    ok: true,
    ...(args ? { args } : {}),
  }
}

const fixture = () =>
  workflowFromHistory(
    [
      entry('open_url', { url: 'https://a.com' }),
      entry('click', { target: { primary: { how: 'css', value: '.go' } } }),
    ],
    'wf',
  )!

describe('buildReviewPrompt', () => {
  it('lists every primary step id, the guide and the JSON contract', () => {
    const wf = fixture()
    const prompt = buildReviewPrompt(wf)
    for (const step of reviewStepsOf(wf)) {
      expect(prompt).toContain(`id=${step.id}`)
    }
    expect(prompt).toContain('节点取舍')
    expect(prompt).toContain('"summary"')
    expect(prompt).toContain('keep')
  })

  it('truncates oversized param values', () => {
    const wf = workflowFromHistory(
      [entry('run_javascript', { code: `console.log("${'x'.repeat(500)}")`, timeout: 20000 })],
      'wf',
    )!
    const prompt = buildReviewPrompt(wf)
    // The long code ships capped (ellipsis) instead of verbatim.
    expect(prompt).toMatch(/x{100,}…/)
    expect(prompt).not.toContain('x'.repeat(500))
  })
})

describe('stripThinkBlocks', () => {
  it('removes paired <think> blocks (braces inside must not confuse the parser)', () => {
    expect(stripThinkBlocks('a<think>weigh {"id":"x"} options</think>b')).toBe('ab')
  })

  it('drops everything before a lone closing tag (thinking cut off mid-stream)', () => {
    expect(stripThinkBlocks('partial reasoning with {"keep":false}…</think>{"ok":1}')).toBe(
      '{"ok":1}',
    )
  })

  it('leaves plain content untouched', () => {
    expect(stripThinkBlocks('{"summary":"s"}')).toBe('{"summary":"s"}')
  })
})

describe('parseReview', () => {
  const ids = new Set(['step-a', 'step-b'])

  it('parses an explicit drop with its reason', () => {
    const review = parseReview(
      '{"summary":"打开了页面并点击。","steps":[{"id":"step-a","keep":false,"reason":"探索性点击"},{"id":"step-b","keep":true}]}',
      ids,
    )
    expect(review?.summary).toBe('打开了页面并点击。')
    expect(review?.steps).toEqual([
      { id: 'step-a', keep: false, reason: '探索性点击' },
      { id: 'step-b', keep: true },
    ])
  })

  it('treats a missing keep flag as keep (never drops by omission)', () => {
    const review = parseReview(
      '{"summary":"s","steps":[{"id":"step-a"},{"id":"step-b","keep":true}]}',
      ids,
    )
    expect(review?.steps[0]).toEqual({ id: 'step-a', keep: true })
  })

  it('ignores unknown step ids and returns null when nothing usable remains', () => {
    expect(parseReview('{"summary":"s","steps":[{"id":"nope","keep":false}]}', ids)).toBeNull()
    expect(
      parseReview(
        '{"summary":"s","steps":[{"id":"nope","keep":true},{"id":"step-a","keep":true}]}',
        ids,
      ),
    ).toEqual({
      summary: 's',
      steps: [{ id: 'step-a', keep: true }],
    })
  })

  it('accepts a markdown-fenced JSON body', () => {
    const review = parseReview(
      '```json\n{"summary":"s","steps":[{"id":"step-a","keep":false,"reason":"r"}]}\n```',
      ids,
    )
    expect(review?.steps[0]?.keep).toBe(false)
  })

  it('finds the verdict JSON after a reasoning-model <think> block', () => {
    const review = parseReview(
      '<think>第一步像是探索性点击…输出 {"id":"step-a"} keep=false?</think>\n{"summary":"s","steps":[{"id":"step-a","keep":false,"reason":"r"}]}',
      ids,
    )
    expect(review?.steps[0]).toEqual({ id: 'step-a', keep: false, reason: 'r' })
  })

  it('returns null for noise, empty verdicts or unparseable text', () => {
    expect(parseReview('模型走神了，没有 JSON', ids)).toBeNull()
    expect(parseReview('{"summary":"s","steps":[]}', ids)).toBeNull()
    expect(parseReview('{"summary":"s","steps":"not-an-array"}', ids)).toBeNull()
  })
})

describe('reviewWorkflow', () => {
  it('returns null (keep-everything) when no provider is configured', async () => {
    storedSettings = {}
    const result = await reviewWorkflow(fixture())
    expect(result).toBeNull()
  })

  it('returns the parsed verdict on a usable reply', async () => {
    storedSettings = providerSettings
    const wf = fixture()
    const firstStep = reviewStepsOf(wf)[0]!
    streamMock.mockResolvedValueOnce({
      content: `{"summary":"打开了页面并点击。","steps":[{"id":"${firstStep.id}","keep":false,"reason":"探索性点击"}]}`,
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    })
    const review = await reviewWorkflow(wf)
    expect(review?.summary).toBe('打开了页面并点击。')
    expect(review?.steps[0]).toEqual({ id: firstStep.id, keep: false, reason: '探索性点击' })
  })

  it('propagates an endpoint failure with its message (panel shows the reason)', async () => {
    storedSettings = providerSettings
    streamMock.mockRejectedValueOnce(new Error('endpoint exploded'))
    await expect(reviewWorkflow(fixture())).rejects.toThrow('endpoint exploded')
  })

  it('maps a timeout abort to a timed-out message', async () => {
    storedSettings = providerSettings
    const timeout = new Error('signal timed out')
    timeout.name = 'TimeoutError'
    streamMock.mockRejectedValueOnce(timeout)
    await expect(reviewWorkflow(fixture())).rejects.toThrow(/超时或被中断/)
  })

  it('maps a mid-stream abort ("BodyStreamBuffer was aborted") to the same retryable failure', async () => {
    storedSettings = providerSettings
    // MV3 service workers surface an aborted response stream with this text
    // instead of the abort reason; it must read as a retryable timeout.
    streamMock.mockRejectedValueOnce(new Error('BodyStreamBuffer was aborted'))
    await expect(reviewWorkflow(fixture())).rejects.toThrow(/超时或被中断.*重试审查/s)
  })

  it('streams live progress lines through onLog while the verdict arrives', async () => {
    storedSettings = providerSettings
    const wf = fixture()
    const stepIds = reviewStepsOf(wf).map((step) => step.id)
    const logs: string[] = []
    const verdictJson = `{"steps":[${stepIds
      .map((id, index) => `{"id":"${id}","keep":${index === 0}}`)
      .join(',')}]}`
    streamMock.mockImplementationOnce(async (_request, handlers) => {
      // Emit the verdict JSON in three deltas, like a real SSE stream would.
      for (const chunk of [
        verdictJson.slice(0, 30),
        verdictJson.slice(30, 60),
        verdictJson.slice(60),
      ]) {
        handlers?.onText?.(chunk)
      }
      return { content: verdictJson, toolCalls: [], finishReason: 'stop', usage: null }
    })
    const review = await reviewWorkflow(wf, (text) => logs.push(text))
    expect(review?.steps).toHaveLength(2)
    expect(logs[0]).toMatch(/模型：test-model/)
    expect(logs).toContain('模型开始返回判决…')
    expect(logs.some((line) => /已收到 1\/2 个步骤的判决/.test(line))).toBe(true)
    expect(logs.some((line) => /已收到 2\/2 个步骤的判决/.test(line))).toBe(true)
  })

  it('throws when the reply carries no usable verdict', async () => {
    storedSettings = providerSettings
    streamMock.mockResolvedValueOnce({
      content: '模型走神了，没有 JSON',
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    })
    await expect(reviewWorkflow(fixture())).rejects.toThrow(/no usable review verdict/i)
  })
})
