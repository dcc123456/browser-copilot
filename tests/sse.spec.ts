import { describe, expect, it, vi } from 'vitest'
import { SseAccumulator } from '../src/lib/llm'

/** Wraps a JSON payload as one SSE frame. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function textChunk(content: string): string {
  return frame({ choices: [{ delta: { content } }] })
}

describe('SseAccumulator · text', () => {
  it('concatenates content deltas and reports them incrementally', () => {
    const onText = vi.fn()
    const accumulator = new SseAccumulator({ onText })
    accumulator.push(textChunk('Hello'))
    accumulator.push(textChunk(' world'))
    accumulator.push('data: [DONE]\n\n')

    expect(accumulator.isDone).toBe(true)
    expect(accumulator.finish().content).toBe('Hello world')
    expect(onText.mock.calls.map(([delta]) => delta)).toEqual(['Hello', ' world'])
  })

  it('reassembles frames split arbitrarily across network reads', () => {
    const accumulator = new SseAccumulator()
    const whole = textChunk('streamed')
    // Split mid-JSON, the worst realistic case.
    const cut = Math.floor(whole.length / 2)
    accumulator.push(whole.slice(0, cut))
    expect(accumulator.result().content).toBe('')
    accumulator.push(whole.slice(cut))
    expect(accumulator.result().content).toBe('streamed')
  })

  it('handles several frames arriving in one chunk', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(textChunk('a') + textChunk('b') + textChunk('c'))
    expect(accumulator.finish().content).toBe('abc')
  })

  it('tolerates CRLF line endings from proxies', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\r\n\r\n`)
    expect(accumulator.finish().content).toBe('x')
  })

  it('flushes a final frame that lacks a trailing blank line', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`)
    expect(accumulator.finish().content).toBe('tail')
  })

  it('ignores comments, blank lines, and usage-only chunks', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(': keep-alive\n\n')
    accumulator.push(frame({ usage: { prompt_tokens: 10, completion_tokens: 2 } }))
    accumulator.push(textChunk('ok'))
    expect(accumulator.finish().content).toBe('ok')
  })

  it('survives a malformed frame without losing the stream', () => {
    const accumulator = new SseAccumulator()
    accumulator.push('data: {not json}\n\n')
    accumulator.push(textChunk('after'))
    expect(accumulator.finish().content).toBe('after')
  })

  it('records the finish reason', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    expect(accumulator.finish().finishReason).toBe('stop')
  })
})

describe('SseAccumulator · tool calls', () => {
  it('merges argument fragments into one call and announces it once', () => {
    const onToolCallStart = vi.fn()
    const accumulator = new SseAccumulator({ onToolCallStart })

    accumulator.push(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'read_current_page', arguments: '' } },
              ],
            },
          },
        ],
      }),
    )
    accumulator.push(
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"max' } }] } }] }),
    )
    accumulator.push(
      frame({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'Chars":50}' } }] }, finish_reason: 'tool_calls' },
        ],
      }),
    )

    const result = accumulator.finish()
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_current_page', arguments: '{"maxChars":50}' },
      },
    ])
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ maxChars: 50 })
    expect(onToolCallStart).toHaveBeenCalledExactlyOnceWith('read_current_page')
  })

  it('keeps parallel calls separate and ordered by index', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'b', function: { name: 'second', arguments: '{}' } },
                { index: 0, id: 'a', function: { name: 'first', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    )
    const calls = accumulator.finish().toolCalls
    expect(calls.map((call) => call.function.name)).toEqual(['first', 'second'])
  })

  it('defaults a missing index to 0 rather than dropping the call', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(
      frame({ choices: [{ delta: { tool_calls: [{ id: 'x', function: { name: 'only', arguments: '{}' } }] } }] }),
    )
    expect(accumulator.finish().toolCalls).toHaveLength(1)
  })
})

describe('SseAccumulator · usage', () => {
  it('captures a trailing usage-only chunk and fires onUsage', () => {
    let received: import('../src/lib/llm').TokenUsage | undefined
    const accumulator = new SseAccumulator({
      onUsage: (u) => {
        received = u
      },
    })
    accumulator.push(
      frame({
        choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40, reasoning_tokens: 5 },
        },
      }),
    )
    const result = accumulator.finish()
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningTokens: 5,
      totalTokens: 120,
    })
    expect(received).toEqual(result.usage)
  })

  it('accepts gateway aliases for token fields', () => {
    const accumulator = new SseAccumulator()
    accumulator.push(
      frame({
        usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 12 },
      }),
    )
    expect(accumulator.finish().usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 10,
      cachedInputTokens: 12,
      totalTokens: 40,
    })
  })
})
