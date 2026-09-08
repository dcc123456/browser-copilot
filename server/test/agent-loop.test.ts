import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDriver } from '../src/driver'
import type { OpResult } from '../../src/lib/ops'

const streamCompletion = vi.fn()
vi.mock('../../src/lib/llm', () => ({
  streamCompletion: (...args: unknown[]) => streamCompletion(...(args as [])),
}))

import { runAgentLoop, runAgentTurnForBlock, buildBlockPrompt } from '../src/agent/agent-loop'
import type { WireToolCall } from '../../src/lib/llm'

function toolCall(name: string, args: Record<string, unknown> = {}): WireToolCall {
  return { id: `call-${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** A driver stub whose execOp serves snapshots; execJs evaluates real JS. */
function makeDriver(): RunDriver {
  const OP_BASE = { found: false, frameUrl: '', isTopFrame: true }
  return {
    async execOp(): Promise<OpResult> {
      return {
        ...OP_BASE,
        ok: true,
        page: { url: 'https://example.com/list', title: 'List', text: 'hello page', elements: [], forms: [] },
      } as unknown as OpResult
    },
    async execJs(code: string, args: Record<string, unknown> = {}): Promise<OpResult> {
      try {
        const keys = Object.keys(args)
        const fn = new Function(...keys, `"use strict";\n${code}`)
        return { ...OP_BASE, ok: true, data: fn(...keys.map((k) => args[k])) }
      } catch (error) {
        return { ...OP_BASE, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async execWorkflowJs(): Promise<never> {
      throw new Error('no page in unit test')
    },
  } as unknown as RunDriver
}

const provider = { apiKey: 'k', baseUrl: 'https://llm.test/v1', model: 'test-model' }

beforeEach(() => {
  streamCompletion.mockReset()
})

describe('runAgentLoop', () => {
  it('executes tool calls then returns the sanitized final answer', async () => {
    streamCompletion
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: '',
          toolCalls: [toolCall('snapshot_page', {})],
          finishReason: 'tool_calls',
          usage: null,
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          content: '最终<think>hidden</think>答案',
          toolCalls: [],
          finishReason: 'stop',
          usage: null,
        }),
      )

    const steps: string[] = []
    const result = await runAgentLoop({
      provider,
      prompt: 'Read the page title',
      mode: 'full',
      maxRounds: 5,
      signal: new AbortController().signal,
      driver: makeDriver(),
      artifactsDir: '/tmp/x',
      onStep: (kind, text) => steps.push(`${kind}:${text}`),
    })

    expect(result.ok).toBe(true)
    expect(result.answer).toBe('最终答案') // <think> stripped
    // A tool round happened and its output was appended as a tool message.
    const secondCallMessages = streamCompletion.mock.calls[1]?.[0].messages as { role: string; name?: string }[]
    expect(secondCallMessages.some((m) => m.role === 'tool' && m.name === 'snapshot_page')).toBe(true)
    expect(steps.some((s) => s.startsWith('tool:snapshot_page'))).toBe(true)
  })

  it('exposes only read tools in readonly mode', async () => {
    let tools: { function: { name: string } }[] = []
    streamCompletion.mockImplementationOnce(() =>
      Promise.resolve({ content: 'done', toolCalls: [], finishReason: 'stop', usage: null }),
    )
    await runAgentLoop({
      provider,
      prompt: 'p',
      mode: 'readonly',
      maxRounds: 3,
      signal: new AbortController().signal,
      driver: makeDriver(),
      artifactsDir: '/tmp/x',
    })
    tools = streamCompletion.mock.calls[0]?.[0].tools ?? []
    const names = tools.map((t) => t.function.name)
    expect(names).toContain('snapshot_page')
    expect(names).not.toContain('click')
    expect(names).not.toContain('fill')
    expect(names).not.toContain('navigate')
  })

  it('errors after exhausting the tool-round budget', async () => {
    streamCompletion.mockImplementation(() =>
      Promise.resolve({ content: '', toolCalls: [toolCall('snapshot_page')], finishReason: 'tool_calls', usage: null }),
    )
    const result = await runAgentLoop({
      provider,
      prompt: 'p',
      mode: 'readonly',
      maxRounds: 2,
      signal: new AbortController().signal,
      driver: makeDriver(),
      artifactsDir: '/tmp/x',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('最大工具轮次')
  })
})

describe('runAgentTurnForBlock', () => {
  function makeCtx() {
    const events: { kind: string; text: string }[] = []
    return {
      variables: {} as Record<string, unknown>,
      refData: null,
      signal: new AbortController().signal,
      events,
      emit(kind: 'status' | 'result' | 'error' | 'info', text: string) {
        events.push({ kind, text })
      },
    }
  }

  it('writes the sanitized answer into the configured variable', async () => {
    streamCompletion.mockImplementation(() =>
      Promise.resolve({ content: '页面标题是 List', toolCalls: [], finishReason: 'stop', usage: null }),
    )
    const ctx = makeCtx()
    const deps = {
      driver: makeDriver(),
      config: {} as never,
      artifactsDir: '/tmp/x',
      signal: ctx.signal,
      provider,
    }
    await runAgentTurnForBlock({ prompt: '标题是什么', variableName: 'out', useSnapshot: false }, ctx as never, deps as never)
    expect(ctx.variables['out']).toBe('页面标题是 List')
    expect(ctx.variables['lastAIAgent']).toBe('页面标题是 List')
  })

  it('fails like the extension when no provider is configured', async () => {
    const ctx = makeCtx()
    const deps = {
      driver: makeDriver(),
      config: {} as never,
      artifactsDir: '/tmp/x',
      signal: ctx.signal,
      provider: null,
    }
    await expect(
      runAgentTurnForBlock({ prompt: 'p' }, ctx as never, deps as never),
    ).rejects.toThrow(/未配置模型/)
    expect(ctx.variables['lastAIAgent']).toBe('')
  })
})

describe('buildBlockPrompt', () => {
  it('includes the element text block and output requirements', () => {
    const prompt = buildBlockPrompt({
      userPrompt: '总结内容',
      selector: '#main',
      elementText: '一些正文',
      elementFound: true,
      useSnapshot: false,
      actOnPage: false,
    })
    expect(prompt).toContain('#main')
    expect(prompt).toContain('一些正文')
    expect(prompt).toContain('总结内容')
    expect(prompt).toContain('READ-ONLY')
    expect(prompt).toContain('<think>')
  })

  it('announces full mode when acting is allowed', () => {
    const prompt = buildBlockPrompt({
      userPrompt: 'p',
      selector: '',
      elementText: '',
      elementFound: false,
      useSnapshot: true,
      actOnPage: true,
    })
    expect(prompt).toContain('MAY act on the current page')
    expect(prompt).toContain('snapshot_page')
  })
})
