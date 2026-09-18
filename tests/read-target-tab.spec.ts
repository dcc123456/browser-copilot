/**
 * Page reads target the tab the RUN is driving, not whichever tab happens to be
 * active in the window.
 *
 * The engine keeps a per-run target tab (`WorkflowExecCtx.tabId`, updated by
 * `new-tab` / `switch-tab`) and hands it to every executor. Every action block
 * resolves through it, but the read blocks called `activeTab(scope)` directly.
 * A `new-tab → get-text` pair could therefore read a different tab than the very
 * next `click` acted on — and when the active tab is the extension's own editor
 * page (not injectable at all) the read failed outright. That is one of the ways
 * a generated scraper "gets no page data".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

const TARGET_TAB = 7
const ACTIVE_TAB = 99

function makeCtx(vars: Record<string, unknown> = {}) {
  const emit = vi.fn((_kind: 'string', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: vars,
    refData: undefined,
    signal: new AbortController().signal,
    tabId: TARGET_TAB,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

/** `executeScript` double that records the target it was given. */
function installChrome(result: unknown) {
  const targets: chrome.scripting.ScriptInjection<unknown[], unknown>['target'][] = []
  const tab = {
    id: TARGET_TAB,
    windowId: 1,
    url: 'https://s.weibo.com/top/summary',
    title: 'Weibo',
    active: false,
  } as unknown as chrome.tabs.Tab
  const executeScript = vi.fn(async (injection: { target: (typeof targets)[number] }) => {
    targets.push(injection.target)
    return [{ result }]
  })
  ;(globalThis as Record<string, unknown>).chrome = {
    tabs: {
      // The run's target tab is alive but NOT active; the active tab is the
      // extension's own page, which must never be the read target.
      get: vi.fn(async (id: number) =>
        id === TARGET_TAB
          ? tab
          : ({
              id,
              windowId: 1,
              url: 'chrome-extension://abc/editor.html',
              title: 'Editor',
            } as unknown as chrome.tabs.Tab),
      ),
      query: vi.fn(async () => [
        { id: ACTIVE_TAB, windowId: 1, url: 'chrome-extension://abc/editor.html', active: true },
      ]),
      update: vi.fn(async () => tab),
    },
    scripting: { executeScript },
    windows: {
      get: vi.fn(async () => ({ id: 1, state: 'normal' })),
      update: vi.fn(async () => {}),
    },
  }
  return { targets, executeScript }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome
})

describe('read blocks target the run tab', () => {
  it('get-text injects into ctx.tabId, not the window active tab', async () => {
    const { targets } = installChrome(['热搜一', '热搜二'])
    const { ctx } = makeCtx()
    await EXECUTORS['get-text']!({ selector: '#pl_toplist td.td-02 a', multiple: true }, ctx)
    expect(targets).toHaveLength(1)
    expect((targets[0] as { tabId: number }).tabId).toBe(TARGET_TAB)
    expect(ctx.variables['lastText']).toEqual(['热搜一', '热搜二'])
  })

  it('read-page (html) injects into ctx.tabId', async () => {
    const { targets } = installChrome('<html>hi</html>')
    const { ctx } = makeCtx()
    await EXECUTORS['read-page']!({ source: 'html', variableName: 'pageHtml' }, ctx)
    expect((targets[0] as { tabId: number }).tabId).toBe(TARGET_TAB)
    expect(ctx.variables['pageHtml']).toBe('<html>hi</html>')
  })

  it('read-page (text) injects into ctx.tabId', async () => {
    const { targets } = installChrome({
      url: 'https://s.weibo.com/top/summary',
      title: 'Weibo',
      selection: '',
      raw: '  正文   内容 ',
    })
    const { ctx } = makeCtx()
    await EXECUTORS['read-page']!({ source: 'text', variableName: 'pageText' }, ctx)
    expect((targets[0] as { tabId: number }).tabId).toBe(TARGET_TAB)
    expect(ctx.variables['pageText']).toBe('正文 内容')
  })

  it('read-page (element scope) injects into ctx.tabId', async () => {
    const { targets } = installChrome(['标题'])
    const { ctx } = makeCtx()
    await EXECUTORS['read-page']!({ source: 'text', selector: '.item' }, ctx)
    expect((targets[0] as { tabId: number }).tabId).toBe(TARGET_TAB)
  })

  it('falls back to the window active tab when the run has no target tab', async () => {
    const { targets } = installChrome(['x'])
    const { ctx } = makeCtx()
    ;(ctx as { tabId?: number }).tabId = undefined
    await EXECUTORS['get-text']!({ selector: '.a' }, ctx)
    expect((targets[0] as { tabId: number }).tabId).toBe(ACTIVE_TAB)
  })

  it('fails when the pinned tab is gone and no active tab can be resolved', async () => {
    installChrome(['x'])
    const chromeMock = (globalThis as { chrome: Record<string, unknown> }).chrome as {
      tabs: { get: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> }
    }
    chromeMock.tabs.get.mockResolvedValue(undefined)
    chromeMock.tabs.query.mockResolvedValue([])
    const { ctx } = makeCtx()
    await expect(EXECUTORS['get-text']!({ selector: '.a' }, ctx)).rejects.toThrow(/标签页/)
  })
})
