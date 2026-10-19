/**
 * The editor assistant's one model call, driven with an injected model: what it
 * puts in front of the model, and how every failure mode settles — as a readable
 * result, except a cancellation, which must reach the command handler as an
 * abort rather than a chat message.
 */
import { describe, expect, it } from 'vitest'
import { runOperatorAdvise } from '../src/background/operator-advise-engine'

const messages = [{ role: 'user', content: '打开 https://www.baidu.com' }] as const

function input(extra: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    messages: [...messages],
    graphDigest: '1. trigger',
    ...extra,
  } as Parameters<typeof runOperatorAdvise>[0]
}

describe('runOperatorAdvise', () => {
  it('hands the model the canvas, the offer and the conversation', async () => {
    const prompts: string[] = []
    const result = await runOperatorAdvise(input({ graphDigest: '1. trigger 2. new-tab' }), {
      signal: new AbortController().signal,
      callModel: async (prompt) => {
        prompts.push(prompt)
        return '{"reply":"已添加","proposals":[{"blockId":"new-tab","data":{"url":"https://www.baidu.com"}}]}'
      },
    })
    expect(prompts[0]).toContain('1. trigger 2. new-tab')
    expect(prompts[0]).toContain('user: 打开 https://www.baidu.com')
    expect(prompts[0]).toContain('- new-tab — New tab')
    expect(result.ok).toBe(true)
    expect(result.reply).toBe('已添加')
    expect(result.proposals).toEqual([
      { blockId: 'new-tab', data: { url: 'https://www.baidu.com' }, rationale: '' },
    ])
  })

  it('refuses to call the model when there is no utterance to answer', async () => {
    let called = 0
    const result = await runOperatorAdvise(
      input({ messages: [{ role: 'user', content: '   ' }] }),
      {
        signal: new AbortController().signal,
        callModel: async () => {
          called += 1
          return '{}'
        },
      },
    )
    expect(called).toBe(0)
    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(result.proposals).toEqual([])
  })

  it('settles a model failure as a readable reason instead of rejecting', async () => {
    const result = await runOperatorAdvise(input(), {
      signal: new AbortController().signal,
      callModel: async () => {
        throw new Error('No AI provider is configured with an API key.')
      },
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'No AI provider is configured with an API key.',
      reply: '',
      proposals: [],
      rejected: [],
    })
  })

  it('settles an unreadable answer as a failure, so nothing lands', async () => {
    const result = await runOperatorAdvise(input(), {
      signal: new AbortController().signal,
      callModel: async () => 'Sure! I would add a New tab block.',
    })
    expect(result.ok).toBe(false)
    expect(result.proposals).toEqual([])
  })

  it('keeps only ids it actually offered and reports the rest', async () => {
    const result = await runOperatorAdvise(input(), {
      signal: new AbortController().signal,
      callModel: async () =>
        '{"reply":"ok","proposals":[{"blockId":"new-tab","data":{}},{"blockId":"sheet-tools","data":{}}]}',
    })
    expect(result.ok).toBe(true)
    expect(result.proposals.map((proposal) => proposal.blockId)).toEqual(['new-tab'])
    expect(result.rejected).toEqual(['sheet-tools'])
  })

  it('propagates a cancellation as an abort, not as a chat line', async () => {
    const controller = new AbortController()
    await expect(
      runOperatorAdvise(input(), {
        signal: controller.signal,
        callModel: async () => {
          controller.abort()
          throw new DOMException('Aborted', 'AbortError')
        },
      }),
    ).rejects.toThrow(/Aborted/)
  })

  it('aborts a reply that arrived after the user pressed stop', async () => {
    const controller = new AbortController()
    await expect(
      runOperatorAdvise(input(), {
        signal: controller.signal,
        callModel: async () => {
          controller.abort()
          return '{"reply":"too late","proposals":[]}'
        },
      }),
    ).rejects.toThrow(/Aborted/)
  })
})
