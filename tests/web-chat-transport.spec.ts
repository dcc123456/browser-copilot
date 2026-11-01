import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/background/driver', () => ({ execOnActiveTab: vi.fn() }))
vi.mock('../src/background/worker-messages', () => ({ workerMessages: vi.fn() }))
vi.mock('../src/background/web-chat/window', () => ({
  ensureWebChatWindow: vi.fn(),
  openWebChatWindow: vi.fn(),
  withWebChatLock: (_site: string, task: () => Promise<unknown>) => task(),
}))

import { messagesFor } from '../src/lib/i18n'
import type { Op, OpResult } from '../src/lib/ops'
import type { ProviderProfile } from '../src/lib/providers'
import { WebChatError, streamWebChat, type WebChatDeps } from '../src/background/web-chat/transport'

const profile: ProviderProfile = {
  id: 'w1',
  label: 'DeepSeek Web',
  presetId: 'deepseek-web',
  transport: 'web',
  baseUrl: 'https://chat.deepseek.com/',
  apiKey: '',
  model: 'deepseek-web',
}

const ok = (data?: string): OpResult => ({
  ok: true,
  found: true,
  frameUrl: 'https://chat.deepseek.com/',
  isTopFrame: true,
  ...(data === undefined ? {} : { data }),
})

const miss = (): OpResult => ({
  ok: false,
  found: false,
  frameUrl: 'https://chat.deepseek.com/',
  isTopFrame: true,
})

function baseDeps(exec: WebChatDeps['exec'], sleep: WebChatDeps['sleep']): WebChatDeps {
  return {
    ensureWindow: vi.fn(async () => ({ windowId: 1, tabId: 2 })),
    openWindow: vi.fn(async () => ({ windowId: 1, tabId: 2 })),
    exec,
    reload: vi.fn(async () => undefined),
    messages: async () => messagesFor('en'),
    sleep,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('streamWebChat', () => {
  it('types the flattened prompt and streams the growing reply', async () => {
    let filled = false
    let sendRequested = false
    let stopChecks = 0
    const onText = vi.fn()

    const exec = vi.fn(async (op: Op): Promise<OpResult> => {
      const selector = op.target?.primary.value ?? ''
      if (op.action === 'element_exists') {
        if (selector.includes('textarea')) return ok()
        if (selector.includes('新对话') || selector.includes('a[href="/"]')) return ok()
        if (selector.includes('发送')) return ok()
        if (selector.includes('stop')) return stopChecks++ === 0 ? ok() : miss()
        return miss()
      }
      if (op.action === 'click') {
        if (selector.includes('发送')) sendRequested = true
        return ok()
      }
      if (op.action === 'press_key') {
        sendRequested = true
        return ok()
      }
      if (op.action === 'fill') {
        filled = true
        return ok()
      }
      if (op.action === 'get_text') return ok(filled && sendRequested ? 'Hello' : '')
      return ok()
    })
    const sleep: WebChatDeps['sleep'] = async (ms) => {
      vi.setSystemTime(Date.now() + ms)
    }

    const result = await streamWebChat(
      profile,
      { messages: [{ role: 'user', content: 'hi' }] },
      { onText },
      baseDeps(exec, sleep),
    )

    expect(result).toMatchObject({
      content: 'Hello',
      reasoning: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    })
    expect(onText).toHaveBeenCalledWith('Hello')
    const fillCall = exec.mock.calls.find(([op]) => (op as Op).action === 'fill')
    expect(fillCall?.[0]).toMatchObject({ value: expect.stringContaining('hi') })
  })

  it('asks the user to log in when only the login form is present', async () => {
    const exec = vi.fn(async (op: Op): Promise<OpResult> => {
      const selector = op.target?.primary.value ?? ''
      if (op.action !== 'element_exists') return ok()
      if (selector.includes('textarea')) return miss()
      if (selector.includes('password')) return ok()
      return miss()
    })
    const deps = baseDeps(exec, async () => undefined)

    const failure = streamWebChat(
      profile,
      { messages: [{ role: 'user', content: 'hi' }] },
      {},
      deps,
    )
    await expect(failure).rejects.toMatchObject({ code: 'login-required' })
    expect(deps.openWindow).toHaveBeenCalledWith('deepseek')
  })

  it('times out when the site never starts replying', async () => {
    const exec = vi.fn(async (op: Op): Promise<OpResult> => {
      const selector = op.target?.primary.value ?? ''
      if (op.action === 'element_exists') {
        if (selector.includes('textarea')) return ok()
        if (selector.includes('新对话') || selector.includes('a[href="/"]')) return ok()
        if (selector.includes('发送')) return ok()
        return miss()
      }
      if (op.action === 'get_text') return ok('')
      return ok()
    })
    const sleep: WebChatDeps['sleep'] = async (ms) => {
      vi.setSystemTime(Date.now() + ms)
    }

    const failure = streamWebChat(
      profile,
      { messages: [{ role: 'user', content: 'hi' }] },
      {},
      baseDeps(exec, sleep),
    )
    await expect(failure).rejects.toBeInstanceOf(WebChatError)
    await expect(failure).rejects.toMatchObject({ code: 'timeout' })
  })

  it('honours an already-aborted signal', async () => {
    const exec = vi.fn(async (): Promise<OpResult> => ok())
    const failure = streamWebChat(
      profile,
      { messages: [{ role: 'user', content: 'hi' }], signal: AbortSignal.abort() },
      {},
      baseDeps(exec, async () => undefined),
    )
    await expect(failure).rejects.toMatchObject({ name: 'AbortError' })
  })
})
