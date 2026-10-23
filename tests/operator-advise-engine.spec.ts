/**
 * The editor assistant's one model call, driven with an injected model: what it
 * puts in front of the model, and how every failure mode settles — as a readable
 * result, except a cancellation, which must reach the command handler as an
 * abort rather than a chat message.
 */
import { describe, expect, it } from 'vitest'
import { runOperatorAdvise, runOperatorObserve } from '../src/background/operator-advise-engine'

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

  it('shows the model the selected step only when the editor sent one', async () => {
    const prompts: string[] = []
    const deps = {
      signal: new AbortController().signal,
      callModel: async (prompt: string) => {
        prompts.push(prompt)
        return '{"reply":"已改好","action":"edit","proposals":[{"blockId":"new-tab","data":{"url":"https://a"}}]}'
      },
    }

    const withSelection = await runOperatorAdvise(
      input({ selectedSpec: 'new-tab — Open tab\n  url: https://b' }),
      deps,
    )
    expect(prompts[0]).toContain('## The step the user selected')
    expect(prompts[0]).toContain('url: https://b')
    expect(prompts[0]).toContain('- "edit": change the selected step in place')
    // The action is relayed, not decided here — the canvas is what applies it.
    expect(withSelection.action).toBe('edit')

    prompts.length = 0
    await runOperatorAdvise(input(), deps)
    expect(prompts[0]).not.toContain('## The step the user selected')
    expect(prompts[0]).not.toContain('"edit": change the selected step')
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

  it('grounds the answer in the page it just read', async () => {
    const prompts: string[] = []
    const windows: (number | undefined)[] = []
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async (windowId) => {
        windows.push(windowId)
        return {
          url: 'https://example.com/form',
          title: 'Sign up',
          elements: [{ ref: 'e12', role: 'combobox', name: 'City', loc: '#city' }],
          forms: [],
        }
      },
      callModel: async (prompt) => {
        prompts.push(prompt)
        return '{"reply":"已添加","proposals":[{"blockId":"select","data":{"selector":"#city"}}]}'
      },
    })
    // Read in the editor's own window, and nothing else.
    expect(windows).toEqual([7])
    expect(prompts[0]).toContain('## The page the user is looking at — Sign up')
    expect(prompts[0]).toContain('#city')
    // The transcript row says which page the parameters came from.
    expect(result.page).toEqual({ url: 'https://example.com/form', title: 'Sign up' })
  })

  it('relays the elements the user picked by hand into the prompt', async () => {
    const prompts: string[] = []
    const deps = {
      signal: new AbortController().signal,
      callModel: async (prompt: string) => {
        prompts.push(prompt)
        return '{"reply":"已添加","proposals":[{"blockId":"event-click","data":{}}]}'
      },
    }

    await runOperatorAdvise(
      input({ pickedElements: [{ selector: '#city', findBy: 'cssSelector' }] }),
      deps,
    )
    expect(prompts[0]).toContain('## Elements the user picked by hand')
    expect(prompts[0]).toContain('CSS: #city')

    prompts.length = 0
    await runOperatorAdvise(input({ pickedElements: [] }), deps)
    expect(prompts[0]).not.toContain('## Elements the user picked by hand')
  })

  it('still answers when there is no page to read', async () => {
    const prompts: string[] = []
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async () => null,
      callModel: async (prompt) => {
        prompts.push(prompt)
        return '{"reply":"已添加","proposals":[]}'
      },
    })
    expect(prompts[0]).not.toContain('## The page the user is looking at')
    expect(result.ok).toBe(true)
    expect(result.page).toBeNull()
  })

  it('leaves the page alone when the user turned reading off', async () => {
    const prompts: string[] = []
    let reads = 0
    const deps = {
      signal: new AbortController().signal,
      readPage: async () => {
        reads += 1
        return { url: 'https://example.com', title: 'Form', elements: [], forms: [] }
      },
      callModel: async (prompt: string) => {
        prompts.push(prompt)
        return '{"reply":"已添加","proposals":[]}'
      },
    }

    const skipped = await runOperatorAdvise(input({ windowId: 7, skipPageRead: true }), deps)
    expect(reads).toBe(0)
    expect(prompts[0]).not.toContain('## The page the user is looking at')
    expect(skipped.page).toBeNull()

    reads = 0
    prompts.length = 0
    await runOperatorAdvise(input({ windowId: 7 }), deps)
    expect(reads).toBe(1)
    expect(prompts[0]).toContain('## The page the user is looking at')
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

  /**
   * The screenshot round. Its gate is the same predicate the dock asks its
   * act-once question with: a step that reads an element and still has none. A
   * vision call costs and the screen leaves the machine, so the round runs at most
   * once per turn, and every way it can fail keeps the answer the page read gave.
   */
  const pageRead = {
    url: 'https://example.com/form',
    title: 'Sign up',
    elements: [{ ref: 'e12', role: 'combobox', name: 'City', loc: '#city' }],
    forms: [],
  }
  const noElement = '{"reply":"已添加","proposals":[{"blockId":"event-click","data":{}}]}'
  const withElement =
    '{"reply":"已添加","proposals":[{"blockId":"event-click","data":{"selector":"#city"}}]}'
  const shot = {
    ok: true as const,
    dataUrl: 'data:image/jpeg;base64,AAAB',
    mimeType: 'image/jpeg',
  }

  it('takes no screenshot when the answer needs nothing from the page', async () => {
    let captures = 0
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async () => pageRead,
      captureScreenshot: async () => {
        captures += 1
        return shot
      },
      callModel: async () => withElement,
    })
    expect(captures).toBe(0)
    expect(result.screenshot).toBeUndefined()
    expect(result.proposals[0]?.data).toEqual({ selector: '#city' })
  })

  it('attaches the screen to a second call when a step is still without its element', async () => {
    const prompts: string[] = []
    const images: ({ dataUrl: string; mimeType: string } | undefined)[] = []
    const windows: (number | undefined)[] = []
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async () => pageRead,
      screenshotRoute: async () => 'inline' as const,
      captureScreenshot: async (windowId) => {
        windows.push(windowId)
        return shot
      },
      callModel: async (prompt, image) => {
        prompts.push(prompt)
        images.push(image)
        return prompts.length === 1 ? noElement : withElement
      },
    })
    // The editor's own window, and one capture only.
    expect(windows).toEqual([7])
    expect(images[0]).toBeUndefined()
    expect(images[1]).toEqual({ dataUrl: shot.dataUrl, mimeType: shot.mimeType })
    // The plain vocabulary mentions the screenshot operator; the section header
    // is what says the image itself rode this call.
    expect(prompts[0]).not.toContain('## A screenshot of the page')
    expect(prompts[1]).toContain('## A screenshot of the page is attached to this request')
    // The offer the user sees is the refined answer, not the guess.
    expect(result.proposals[0]?.data).toEqual({ selector: '#city' })
    expect(result.screenshot).toEqual({ route: 'inline', taken: true })
  })

  it('sends the screen to the image model when that model is not the chat model', async () => {
    const prompts: string[] = []
    const asked: string[] = []
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async () => pageRead,
      screenshotRoute: async () => 'described' as const,
      captureScreenshot: async () => shot,
      describeScreenshot: async (dataUrl) => {
        asked.push(dataUrl)
        return { ok: true as const, note: 'An open dropdown lists 杭州 and 苏州.' }
      },
      callModel: async (prompt, image) => {
        prompts.push(prompt)
        expect(image).toBeUndefined()
        return prompts.length === 1 ? noElement : withElement
      },
    })
    expect(asked).toEqual([shot.dataUrl])
    expect(prompts[1]).toContain('## What a screenshot of the page shows')
    expect(prompts[1]).toContain('杭州 and 苏州')
    // The DOM read is still in there — the image adds to it, it does not replace it.
    expect(prompts[1]).toContain('#city')
    expect(result.screenshot).toEqual({ route: 'described', taken: true })
  })

  it('asks with the screen once, and hands back the offer when it still misses', async () => {
    const prompts: string[] = []
    let captures = 0
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async () => pageRead,
      screenshotRoute: async () => 'inline' as const,
      captureScreenshot: async () => {
        captures += 1
        return shot
      },
      callModel: async (prompt) => {
        prompts.push(prompt)
        return noElement
      },
    })
    // No third round: a screen that did not settle the step settles nothing.
    expect(prompts).toHaveLength(2)
    expect(captures).toBe(1)
    expect(result.proposals[0]?.data).toEqual({})
    expect(result.screenshot).toEqual({ route: 'inline', taken: true })
  })

  it('leaves the whole path closed when the user turned page reading off', async () => {
    let captures = 0
    const result = await runOperatorAdvise(input({ windowId: 7, skipPageRead: true }), {
      signal: new AbortController().signal,
      screenshotRoute: async () => {
        throw new Error('the route is not consulted without a page read')
      },
      captureScreenshot: async () => {
        captures += 1
        return shot
      },
      callModel: async () => noElement,
    })
    expect(captures).toBe(0)
    expect(result.screenshot).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  it('reports a capture that failed, and keeps the answer the page read gave', async () => {
    let calls = 0
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async () => pageRead,
      screenshotRoute: async () => 'inline' as const,
      captureScreenshot: async () => ({ ok: false, error: 'This page type is not capturable.' }),
      callModel: async () => {
        calls += 1
        return noElement
      },
    })
    expect(calls).toBe(1)
    expect(result.screenshot).toEqual({
      route: 'inline',
      taken: false,
      error: 'This page type is not capturable.',
    })
    expect(result.ok).toBe(true)
    expect(result.proposals).toHaveLength(1)
  })

  it('keeps the first answer when the screenshot round does not answer', async () => {
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async () => pageRead,
      screenshotRoute: async () => 'inline' as const,
      captureScreenshot: async () => shot,
      callModel: async (prompt) => {
        if (prompt.includes('## A screenshot of the page'))
          throw new Error('The provider timed out.')
        return noElement
      },
    })
    expect(result.ok).toBe(true)
    expect(result.proposals).toHaveLength(1)
    expect(result.screenshot).toEqual({
      route: 'inline',
      taken: true,
      error: 'The provider timed out.',
    })
  })

  it('reports an image model that could not read the screen, without a second chat call', async () => {
    let calls = 0
    const result = await runOperatorAdvise(input({ windowId: 7 }), {
      signal: new AbortController().signal,
      readPage: async () => pageRead,
      screenshotRoute: async () => 'described' as const,
      captureScreenshot: async () => shot,
      describeScreenshot: async () => ({
        ok: false,
        error: 'The image model rejected the API key.',
      }),
      callModel: async () => {
        calls += 1
        return noElement
      },
    })
    expect(calls).toBe(1)
    expect(result.screenshot).toEqual({
      route: 'described',
      taken: true,
      error: 'The image model rejected the API key.',
    })
  })
})

describe('runOperatorObserve', () => {
  const controller = () => new AbortController()

  it('lands the locator the page really used', async () => {
    const executed: Record<string, unknown>[] = []
    const result = await runOperatorObserve(
      { sessionId: 'o1', steps: [{ blockId: 'event-click', data: { selector: '#city' } }] },
      {
        signal: controller().signal,
        probe: async () => [1],
        execute: async (_blockId, data) => {
          executed.push(data)
          return {
            status: 'executed' as const,
            lines: ['点击成功'],
            resolution: { usedSpec: '#city', usedFallback: false, matched: 1 },
          }
        },
      },
    )
    // Probed before acting, so the recorded selector is the one that proved unique.
    expect(executed[0]?.['findBy']).toBe('cssSelector')
    expect(result.ok).toBe(true)
    expect(result.steps[0]).toMatchObject({
      blockId: 'event-click',
      name: 'Click element',
      ran: true,
      report: ['点击成功'],
    })
    expect(result.steps[0]!.data['selector']).toBe('#city')
    expect(result.steps[0]!.data['selectorVerified']).toBe(true)
  })

  it('refuses an operator it must not act with, and names it', async () => {
    let runs = 0
    const result = await runOperatorObserve(
      { sessionId: 'o1', steps: [{ blockId: 'upload-file', data: { selector: '#f' } }] },
      {
        signal: controller().signal,
        execute: async () => {
          runs += 1
          return { status: 'executed' as const, lines: [] }
        },
      },
    )
    expect(runs).toBe(0)
    expect(result.refused).toEqual([result.steps[0]!.name])
    expect(result.steps[0]!.ran).toBe(false)
    expect(result.steps[0]!.error).toBeTruthy()
  })

  it('keeps the proposal when the page refuses the step', async () => {
    const result = await runOperatorObserve(
      { sessionId: 'o1', steps: [{ blockId: 'event-click', data: { selector: '#gone' } }] },
      {
        signal: controller().signal,
        probe: async () => [0],
        execute: async () => ({
          status: 'failed' as const,
          lines: ['元素不存在'],
          error: 'no element matched #gone',
        }),
      },
    )
    expect(result.ok).toBe(true)
    expect(result.steps[0]).toMatchObject({
      ran: false,
      data: { selector: '#gone' },
      report: ['元素不存在'],
      error: 'no element matched #gone',
    })
  })

  it('follows the tab a navigation step opened', async () => {
    const tabs: (number | undefined)[] = []
    await runOperatorObserve(
      {
        sessionId: 'o1',
        steps: [
          { blockId: 'new-tab', data: { url: 'https://a' } },
          { blockId: 'event-click', data: { selector: '#x' } },
        ],
      },
      {
        signal: controller().signal,
        probe: async () => null,
        execute: async (blockId, _data, deps) => {
          tabs.push(deps.tabId)
          if (blockId === 'new-tab') deps.setTab?.(42)
          return { status: 'executed' as const, lines: [] }
        },
      },
    )
    expect(tabs).toEqual([undefined, 42])
  })

  it('carries back the locator only, never a value the page typed', async () => {
    const result = await runOperatorObserve(
      {
        sessionId: 'o1',
        steps: [{ blockId: 'forms', data: { selector: '#pw', value: 'hunter2' } }],
      },
      {
        signal: controller().signal,
        probe: async () => [1],
        execute: async (_blockId, data) => {
          // A leaky executor writes what it filled into the object it was given.
          ;(data as Record<string, unknown>).password = 'hunter2'
          return {
            status: 'executed' as const,
            lines: [],
            resolution: { usedSpec: '#pw', usedFallback: false, matched: 1 },
          }
        },
      },
    )
    const landed = result.steps[0]!.data
    expect(landed['value']).toBe('hunter2')
    expect(landed['selector']).toBe('#pw')
    expect(landed['password']).toBeUndefined()
  })

  it('aborts the loop when the user stops it, so nothing lands', async () => {
    const abort = new AbortController()
    await expect(
      runOperatorObserve(
        {
          sessionId: 'o1',
          steps: [
            { blockId: 'event-click', data: { selector: '#a' } },
            { blockId: 'event-click', data: { selector: '#b' } },
          ],
        },
        {
          signal: abort.signal,
          probe: async () => [1],
          execute: async () => {
            abort.abort()
            return { status: 'executed' as const, lines: [] }
          },
        },
      ),
    ).rejects.toThrow(/Aborted/)
  })
})
