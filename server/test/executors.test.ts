import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RunDriver } from '../src/driver'
import type { RunnerConfig } from '../src/config'
import { createExecutors } from '../src/executors'
import type { WorkflowExecCtx } from '../../src/background/workflow-engine/executors'
import type { OpResult } from '../../src/lib/ops'
import { CODE_NODE_HELPERS } from '../../src/lib/workflow/code-node-helpers'

const OP_BASE = { found: false, frameUrl: '', isTopFrame: true }

/** A driver stub that ACTUALLY evaluates the JS the executors send to pages. */
function makeDriverStub(): RunDriver {
  const driver = {
    async execJs(code: string, args: Record<string, unknown> = {}): Promise<OpResult> {
      try {
        const keys = Object.keys(args)

        const fn = new Function(...keys, `"use strict";\n${code}`)
        return { ...OP_BASE, ok: true, data: fn(...keys.map((k) => args[k])) }
      } catch (error) {
        return {
          ...OP_BASE,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    async execWorkflowJs(): Promise<never> {
      // Force the local-fallback path for javascript-code blocks.
      throw new Error('no page in unit test')
    },
    async execOp(): Promise<OpResult> {
      return { ...OP_BASE, ok: true, note: 'stub' }
    },
    async countElements(): Promise<number> {
      return 0
    },
  }
  return driver as unknown as RunDriver
}

function makeCtx(variables: Record<string, unknown> = {}): WorkflowExecCtx & {
  outputs: Record<string, string>
  events: { kind: string; text: string }[]
} {
  const outputs: Record<string, string> = {}
  const events: { kind: string; text: string }[] = []
  return {
    variables,
    refData: null,
    signal: new AbortController().signal,
    outputs,
    events,
    emit(kind, text) {
      events.push({ kind, text })
    },
  }
}

function makeDeps(driver: RunDriver, feishu?: { webhookUrl: string; webhookSecret: string }) {
  return {
    driver,
    config: {
      dataDir: join(tmpdir(), 'bc-exec-test'),
      browser: { mode: 'local', headless: true, maxConcurrent: 1, cdpEndpoint: '' },
      feishu: feishu ?? { webhookUrl: '', webhookSecret: '' },
    } as unknown as RunnerConfig,
    artifactsDir: join(tmpdir(), 'bc-exec-artifacts'),
    signal: new AbortController().signal,
    provider: null,
  }
}

describe('server executors', () => {
  it('covers the extension registry keys', () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    for (const key of [
      'trigger',
      'click',
      'fill',
      'set-variable',
      'get-secret',
      'increase-variable',
      'slice-variable',
      'regex-variable',
      'conditions',
      'javascript-code',
      'webhook',
      'forms',
      'execute-workflow',
      'loop-breakpoint',
      'ai-agent',
    ]) {
      expect(registry[key], `missing executor: ${key}`).toBeTypeOf('function')
    }
  })

  it('set-variable interpolates into the variable store', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ name: '世界' })
    await registry['set-variable']!({ variableName: 'greeting', value: '你好 {{name}}' }, ctx)
    expect(ctx.variables['greeting']).toBe('你好 世界')
  })

  it('set-variable writes every row in order, later rows seeing earlier ones', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx()
    await registry['set-variable']!(
      {
        variables: [
          { name: 'token', value: 'abc' },
          { name: 'authHeader', value: 'Bearer {{token}}' },
        ],
      },
      ctx,
    )
    expect(ctx.variables['token']).toBe('abc')
    expect(ctx.variables['authHeader']).toBe('Bearer abc')
  })

  it('set-variable fails a node with no variable name', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx()
    await expect(
      registry['set-variable']!({ variables: [{ name: '', value: 'x' }] }, ctx),
    ).rejects.toThrow()
  })

  /**
   * `get-secret` on a headless host: no credential store, so each row reads the
   * environment. The values must land in the row's own variable, must never reach
   * the run log, and a missing one must fail the step rather than write `''` — a
   * blank password that fills a form and reports success is the failure mode here.
   */
  describe('get-secret reads credentials from the environment', () => {
    const ENV_NAMES = ['BC_SECRET_GITHUB_TOKEN', 'BC_SECRET_MAIL_PASSWORD']

    function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
      return async (): Promise<void> => {
        const saved = ENV_NAMES.map((name) => [name, process.env[name]] as const)
        for (const [name, value] of Object.entries(values)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
        try {
          await run()
        } finally {
          for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
          }
        }
      }
    }

    it('fills one variable per credential row, value out of the log', async () => {
      await withEnv(
        { BC_SECRET_GITHUB_TOKEN: 'ghp-SECRET', BC_SECRET_MAIL_PASSWORD: 'mail-SECRET' },
        async () => {
          const registry = createExecutors(makeDeps(makeDriverStub()))
          const ctx = makeCtx()
          await registry['get-secret']!(
            {
              credential: 'github::token',
              variableName: 'githubToken',
              credentials: [
                { credential: 'github::token', variableName: 'githubToken' },
                { credential: 'mail::password', variableName: 'mailPassword' },
              ],
            },
            ctx,
          )
          expect(ctx.variables).toEqual({
            githubToken: 'ghp-SECRET',
            mailPassword: 'mail-SECRET',
          })
          expect(JSON.stringify(ctx.events)).not.toContain('SECRET')
        },
      )
    })

    it('fails the step when the environment has no such credential', async () => {
      await withEnv({ BC_SECRET_GITHUB_TOKEN: undefined }, async () => {
        const registry = createExecutors(makeDeps(makeDriverStub()))
        const ctx = makeCtx()
        await expect(
          registry['get-secret']!(
            { credential: 'github::token', variableName: 'githubToken' },
            ctx,
          ),
        ).rejects.toThrow('BC_SECRET_GITHUB_TOKEN')
        // Not a green step that wrote an empty password.
        expect(ctx.variables).toEqual({})
      })
    })

    it('refuses a row with no output name', async () => {
      await withEnv({ BC_SECRET_GITHUB_TOKEN: 'ghp-SECRET' }, async () => {
        const registry = createExecutors(makeDeps(makeDriverStub()))
        await expect(
          registry['get-secret']!({ credential: 'github::token', variableName: '' }, makeCtx()),
        ).rejects.toThrow('未指定输出变量名')
      })
    })

    it('refuses a node with no credential at all', async () => {
      const registry = createExecutors(makeDeps(makeDriverStub()))
      await expect(registry['get-secret']!({}, makeCtx())).rejects.toThrow('未指定凭证')
    })
  })

  /**
   * Mirror of the extension's `new-window` test: headless has no windows, so
   * the contract "the steps after me run in the window I opened" is carried by
   * the page pin. A block that forgot it would leave later steps on the old
   * page while still reporting success.
   */
  it('new-window re-points the run at the page it opened', async () => {
    const driver = makeDriverStub() as unknown as Record<string, unknown>
    const newTab = vi.fn(async (url?: string) => ({ id: 12, url: url ?? '', title: 'New' }))
    const execOp = vi.fn(async (_op: unknown, _tabId?: number) => ({
      ...OP_BASE,
      ok: true,
      note: 'ok',
    }))
    driver['newTab'] = newTab
    driver['execOp'] = execOp
    const registry = createExecutors(makeDeps(driver as unknown as RunDriver))

    const ctx = makeCtx({ path: 'x' })
    const pinned: number[] = []
    ctx.setTab = (tabId) => pinned.push(tabId)
    await registry['new-window']!({ url: 'https://example.com/{{path}}' }, ctx)
    expect(newTab).toHaveBeenCalledWith('https://example.com/x')
    expect(pinned).toEqual([12])
    expect(ctx.tabId).toBe(12)

    // And the step that follows acts on that page, not the one before it.
    await registry['click']!({ cssSelector: '#btn' }, ctx)
    expect(execOp.mock.lastCall?.[1]).toBe(12)
  })

  /**
   * Mirror of the extension's `reload-tab` tests. Headless has no "set the
   * address bar" primitive, so a filled url is a single `goto` — mirroring the
   * extension's `tabs.update({url})`, which already loads the document. Calling
   * `reload` as well would fetch the page twice.
   */
  describe('reload-tab', () => {
    function makeReloadDriver() {
      const driver = makeDriverStub() as unknown as Record<string, unknown>
      const reloadTab = vi.fn(async (_url?: string): Promise<void> => {})
      driver['reloadTab'] = reloadTab
      return { reloadTab, registry: createExecutors(makeDeps(driver as unknown as RunDriver)) }
    }

    it('reloads the driven page when no url is set', async () => {
      const { reloadTab, registry } = makeReloadDriver()
      const ctx = makeCtx()
      await registry['reload-tab']!({}, ctx)
      expect(reloadTab).toHaveBeenCalledWith()
      expect(ctx.events).toContainEqual({ kind: 'result', text: '已刷新当前标签页' })
    })

    it('navigates to the url instead of reloading in place', async () => {
      const { reloadTab, registry } = makeReloadDriver()
      const ctx = makeCtx({ path: 'next' })
      await registry['reload-tab']!({ url: 'https://example.com/{{path}}' }, ctx)
      expect(reloadTab).toHaveBeenCalledWith('https://example.com/next')
      expect(ctx.events).toContainEqual({
        kind: 'result',
        text: '已刷新当前标签页 → https://example.com/next',
      })
    })

    it('treats a blank url as no url at all', async () => {
      const { reloadTab, registry } = makeReloadDriver()
      await registry['reload-tab']!({ url: '   ' }, makeCtx())
      expect(reloadTab).toHaveBeenCalledWith()
    })
  })

  /**
   * Mirror of the extension's `close-tab` tests: the page the RUN drives closes
   * (not whichever page a user might have focused), and the run follows the
   * surviving page instead of keeping the closed tab id.
   */
  describe('close-tab', () => {
    function makeCloseDriver(survivor: number | undefined) {
      const driver = makeDriverStub() as unknown as Record<string, unknown>
      const closeActiveTab = vi.fn(async (_tabId?: number) => survivor)
      driver['closeActiveTab'] = closeActiveTab
      return { closeActiveTab, registry: createExecutors(makeDeps(driver as unknown as RunDriver)) }
    }

    it('closes the driven page and re-points the run at the survivor', async () => {
      const { closeActiveTab, registry } = makeCloseDriver(9)
      const ctx = makeCtx()
      ctx.tabId = 7
      const pinned: number[] = []
      ctx.setTab = (tabId) => pinned.push(tabId)

      await registry['close-tab']!({ closeType: 'tab', activeTab: true }, ctx)

      expect(closeActiveTab).toHaveBeenCalledWith(7)
      expect(pinned).toEqual([9])
      expect(ctx.events).toContainEqual({ kind: 'result', text: '已关闭当前标签页' })
    })

    it('leaves the tab pointer alone when no page survives', async () => {
      const { registry } = makeCloseDriver(undefined)
      const ctx = makeCtx()
      const pinned: number[] = []
      ctx.setTab = (tabId) => pinned.push(tabId)

      await registry['close-tab']!({ closeType: 'tab', activeTab: true }, ctx)

      expect(pinned).toEqual([])
    })
  })

  /**
   * Mirror of the extension's `new-tab` reuse tests. Headless has no tab bar, so
   * "update previously opened tab" is a `goto` on the page the last new-tab block
   * made — and a page closed since then falls back to creating instead of
   * failing the run.
   */
  describe('new-tab reuses the page it opened before', () => {
    function makeNewTabDriver(closed = false) {
      const driver = makeDriverStub() as unknown as Record<string, unknown>
      const newTab = vi.fn(async (url?: string) => ({ id: 7, url: url ?? '', title: 'New' }))
      const reuseTab = vi.fn(async (tabId: number, url?: string) =>
        closed ? null : { id: tabId, url: url ?? '', title: 'Reused' },
      )
      const waitForLoaded = vi.fn(async (): Promise<void> => {})
      driver['newTab'] = newTab
      driver['reuseTab'] = reuseTab
      driver['waitForLoaded'] = waitForLoaded
      return {
        newTab,
        reuseTab,
        registry: createExecutors(makeDeps(driver as unknown as RunDriver)),
      }
    }

    it('records the page it created, for the next block to reuse', async () => {
      const { newTab, registry } = makeNewTabDriver()
      const ctx = makeCtx()
      const tabMemory: { prevNewTabId?: number } = {}
      ctx.tabMemory = tabMemory

      await registry['new-tab']!({ url: 'https://example.com/a' }, ctx)
      expect(newTab).toHaveBeenCalledTimes(1)
      expect(tabMemory.prevNewTabId).toBe(7)
    })

    it('reuses that page instead of opening another', async () => {
      const { newTab, reuseTab, registry } = makeNewTabDriver()
      const ctx = makeCtx()
      const tabMemory: { prevNewTabId?: number } = { prevNewTabId: 7 }
      ctx.tabMemory = tabMemory

      await registry['new-tab']!({ url: 'https://example.com/b', updatePrevTab: true }, ctx)
      expect(reuseTab).toHaveBeenCalledWith(7, 'https://example.com/b')
      expect(newTab).not.toHaveBeenCalled()
      expect(ctx.events).toContainEqual({
        kind: 'result',
        text: '已复用 https://example.com/b (tab #7)',
      })
    })

    it('falls back to creating when that page has been closed', async () => {
      const { newTab, reuseTab, registry } = makeNewTabDriver(true)
      const ctx = makeCtx()
      const tabMemory: { prevNewTabId?: number } = { prevNewTabId: 7 }
      ctx.tabMemory = tabMemory

      await registry['new-tab']!({ url: 'https://example.com/b', updatePrevTab: true }, ctx)
      expect(reuseTab).toHaveBeenCalledWith(7, 'https://example.com/b')
      expect(newTab).toHaveBeenCalledTimes(1)
      // And the fresh page becomes the one the next reuse follows.
      expect(tabMemory.prevNewTabId).toBe(7)
    })

    it('creates on the first block, since there is nothing to reuse yet', async () => {
      const { reuseTab, newTab, registry } = makeNewTabDriver()
      const ctx = makeCtx()
      ctx.tabMemory = {}

      await registry['new-tab']!({ url: 'https://example.com/a', updatePrevTab: true }, ctx)
      expect(reuseTab).not.toHaveBeenCalled()
      expect(newTab).toHaveBeenCalledTimes(1)
    })
  })

  it('javascript-code falls back to local evaluation with Automa helpers', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ seed: 2 })
    await registry['javascript-code']!(
      { code: "automaSetVariable('doubled', variables.seed * 2); automaNextBlock({ ok: true })" },
      ctx,
    )
    expect(ctx.variables['doubled']).toBe(4)
    expect(ctx.variables['lastResult']).toEqual({ ok: true })
  })

  it('javascript-code local evaluation defines every advertised helper', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ dataTable: [{ name: 'row-1' }] })
    const code = [
      "automaSetVariable('helped', 7)",
      "const fromRef = automaRefData('table', '0.name')",
      'automaResetTimeout()',
      'variables.answer = 42',
      'automaNextBlock({ helped: variables.helped, fromRef, answer: variables.answer })',
    ].join('\n')
    for (const helper of CODE_NODE_HELPERS) {
      expect(code, helper.name).toContain(helper.name)
    }
    await registry['javascript-code']!({ code }, ctx)
    expect(ctx.variables['lastResult']).toEqual({ helped: 7, fromRef: 'row-1', answer: 42 })
  })

  it('conditions route through outputs handles (row semantics)', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ a: 'yes' })
    ctx.outputs['true'] = 'node-yes'
    ctx.outputs['false'] = 'node-no'
    const next = await registry['conditions']!(
      { conditions: [{ conditions: [{ name: 'a', compare: 'eql', value: 'yes' }] }] },
      ctx,
    )
    expect(next).toBe('node-yes')

    const ctx2 = makeCtx({ a: 'no' })
    ctx2.outputs['true'] = 'node-yes'
    ctx2.outputs['false'] = 'node-no'
    const next2 = await registry['conditions']!(
      { conditions: [{ conditions: [{ name: 'a', compare: 'eql', value: 'yes' }] }] },
      ctx2,
    )
    expect(next2).toBe('node-no')
  })

  it('javascript-code expression conditions evaluate via driver JS', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ count: 5 })
    ctx.outputs['true'] = 'big'
    const next = await registry['conditions']!({ code: 'vars.count > 3' }, ctx)
    expect(next).toBe('big')
  })

  it('increase-variable mutates the stored number', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ n: 1 })
    await registry['increase-variable']!({ variableName: 'n', value: '4' }, ctx)
    expect(ctx.variables['n']).toBe(5)
    // The multiply mode starts from 1 when the variable is absent.
    const ctx2 = makeCtx({})
    await registry['increase-variable']!(
      { variableName: 'm', value: '3', incType: 'multiply' },
      ctx2,
    )
    expect(ctx2.variables['m']).toBe(3)
  })

  it('regex-variable extracts a match', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    const ctx = makeCtx({ text: 'order-42-shipped' })
    await registry['regex-variable']!(
      { variableName: 'text', pattern: 'order-(\\d+)', output: 'out' },
      ctx,
    )
    expect(String(ctx.variables['out'])).toContain('42')
  })

  it('loop-breakpoint throws the LoopBreakpointError the engine catches', async () => {
    const registry = createExecutors(makeDeps(makeDriverStub()))
    await expect(registry['loop-breakpoint']!({ loopId: 'l1' }, makeCtx())).rejects.toMatchObject({
      name: 'LoopBreakpointError',
    })
  })
})
