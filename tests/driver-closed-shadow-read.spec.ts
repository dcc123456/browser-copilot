/**
 * Where a closed-shadow READ is answered.
 *
 * A target marked `cdp-shadow` lives inside a CLOSED shadow root, which in-page
 * JS cannot query at all (see tests/kernel-shadow.spec.ts). Before this path
 * existed the driver sent `element_exists` / `actionability` to the kernel
 * anyway, so a generated graph whose last step clicks such a button could never
 * satisfy its own `visible` readiness gate — `READINESS_TIMEOUT(visible)` on an
 * element the very next call clicks successfully.
 *
 * The invariant: a read of a closed-shadow target is answered over
 * `chrome.debugger`, and the kernel is never injected for it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Target } from '../src/lib/ops'

const TAB = { id: 11, windowId: 1, url: 'https://creator.xiaohongshu.test/publish/publish' }

const shadowTarget: Target = {
  primary: {
    how: 'cdp-shadow',
    value: '暂存离开',
    role: 'button',
    tag: 'button',
    closedShadow: true,
    shadowHosts: ['xhs-publish-btn'],
  },
  fallbacks: [],
}

/** The pierced tree the debugger hands back: one shadowed button, by name. */
const piercedTree = {
  nodeId: 1,
  nodeType: 9,
  nodeName: '#document',
  children: [
    {
      nodeId: 2,
      nodeType: 1,
      nodeName: 'XHS-PUBLISH-BTN',
      shadowRoots: [
        {
          nodeId: 3,
          nodeType: 11,
          nodeName: '#shadow-root',
          children: [
            {
              nodeId: 5,
              nodeType: 1,
              nodeName: 'BUTTON',
              attributes: ['class', 'ce-btn white'],
              children: [{ nodeType: 3, nodeName: '#text', nodeValue: '暂存离开' }],
            },
          ],
        },
      ],
    },
  ],
}

const rendered = {
  visible: true,
  enabled: true,
  occluded: false,
  rect: { x: 100, y: 200, w: 120, h: 40 },
}

let sendCommand: ReturnType<typeof vi.fn>
let executeScript: ReturnType<typeof vi.fn>

function installChrome(opts: { debuggerAvailable?: boolean; sendFails?: boolean } = {}): void {
  sendCommand = vi.fn(async (_target: unknown, method: string) => {
    if (opts.sendFails) throw new Error('Cannot access a chrome:// URL')
    if (method === 'DOM.getDocument') return { root: piercedTree }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-5' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: rendered } }
    if (method === 'DOM.getBoxModel') {
      return { model: { content: [100, 200, 220, 200, 220, 240, 100, 240] } }
    }
    return {}
  })
  executeScript = vi.fn(async () => [{ result: { ok: true, found: false, data: 0 } }])
  const on = () => ({ addListener: vi.fn(), removeListener: vi.fn() })
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
    tabs: {
      get: vi.fn(async (id: number) => (id === TAB.id ? TAB : undefined)),
      query: vi.fn(async () => [TAB]),
      onActivated: on(),
      onUpdated: on(),
      onRemoved: on(),
    },
    windows: {
      get: vi.fn(async (id: number) => ({ id, type: 'normal', focused: true })),
      onRemoved: on(),
      onFocusChanged: on(),
    },
    scripting: { executeScript, insertCSS: vi.fn(), removeCSS: vi.fn() },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    debugger:
      opts.debuggerAvailable === false
        ? undefined
        : {
            attach: vi.fn(async () => {}),
            detach: vi.fn(async () => {}),
            sendCommand,
            onDetach: on(),
            onEvent: on(),
          },
  }
}

beforeEach(() => {
  installChrome()
})

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
  vi.resetModules()
})

/** Fresh module graph so the driver reads the stubbed `chrome`. */
async function driver(): Promise<typeof import('../src/background/driver')> {
  return import('../src/background/driver')
}

describe('execOnActiveTab reads closed-shadow targets over CDP', () => {
  it('answers element_exists from the debugger, without injecting the kernel', async () => {
    const { execOnActiveTab } = await driver()

    const out = await execOnActiveTab(
      { action: 'element_exists', target: shadowTarget },
      undefined,
      TAB.id,
    )

    expect(out.ok).toBe(true)
    expect(out.found).toBe(true)
    expect(out.data).toBe(1)
    expect(sendCommand).toHaveBeenCalled()
    expect(executeScript).not.toHaveBeenCalled()
  })

  it('answers actionability with the three facts a readiness wait asks for', async () => {
    const { execOnActiveTab } = await driver()

    const out = await execOnActiveTab(
      { action: 'actionability', target: shadowTarget },
      undefined,
      TAB.id,
    )

    expect(out.data).toMatchObject({
      state: 'ready',
      visible: true,
      enabled: true,
      occluded: false,
      rect: { x: 100, y: 200, w: 120, h: 40 },
    })
  })

  it('reports an absent shadow element as missing rather than refusing', async () => {
    sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root: piercedTree }
      throw new Error('unreachable')
    })
    const { execOnActiveTab } = await driver()

    const out = await execOnActiveTab(
      {
        action: 'actionability',
        target: { ...shadowTarget, primary: { ...shadowTarget.primary, value: '不存在' } },
      },
      undefined,
      TAB.id,
    )

    expect(out.data).toMatchObject({ state: 'missing', visible: false })
    expect(executeScript).not.toHaveBeenCalled()
  })

  it('says so when the debugger channel is unavailable', async () => {
    installChrome({ debuggerAvailable: false })
    const { execOnActiveTab } = await driver()

    const out = await execOnActiveTab(
      { action: 'element_exists', target: shadowTarget },
      undefined,
      TAB.id,
    )

    expect(out.ok).toBe(false)
    expect(out.error).toContain('封闭 Shadow DOM')
  })

  it('turns a failed CDP read into an op failure instead of a throw', async () => {
    installChrome({ sendFails: true })
    const { execOnActiveTab } = await driver()

    const out = await execOnActiveTab(
      { action: 'element_exists', target: shadowTarget },
      undefined,
      TAB.id,
    )

    expect(out.ok).toBe(false)
    expect(out.error).toContain('封闭 Shadow DOM 状态读取失败')
  })

  it('leaves an ordinary target on the in-page channel', async () => {
    const { execOnActiveTab } = await driver()

    await execOnActiveTab(
      { action: 'element_exists', target: { primary: { how: 'css', value: '#x' }, fallbacks: [] } },
      undefined,
      TAB.id,
    )

    expect(executeScript).toHaveBeenCalled()
    expect(sendCommand).not.toHaveBeenCalled()
  })
})
