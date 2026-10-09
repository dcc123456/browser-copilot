/**
 * The closed-shadow READ channel: `probeClosedShadow`, the answer a
 * `present` / `visible` / `enabled` readiness wait gets for an element inside a
 * CLOSED shadow root.
 *
 * The premise (pinned in tests/kernel-shadow.spec.ts) is that page JS cannot see
 * such an element at all — so the kernel's `element_exists` / `actionability`
 * report nothing, and a wait built on them times out on a button the driver
 * clicks happily. This spec drives the probe over a real jsdom page with a real
 * closed root, and executes the function the probe serializes into the page
 * (`Runtime.callFunctionOn`) against the real element, so the composed-tree
 * walk — ancestor styles across the shadow boundary, the host-retargeted hit
 * test — is tested rather than assumed. Only what jsdom cannot provide is
 * stubbed: geometry (`getBoundingClientRect`, no layout engine) and
 * `document.elementFromPoint`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { probeClosedShadow, type CdpSession } from '../src/background/cdp-shadow'
import type { Target } from '../src/lib/ops'

/** The pierced tree CDP would return for the fixture below. */
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
              nodeId: 4,
              nodeType: 1,
              nodeName: 'DIV',
              children: [
                {
                  nodeId: 5,
                  nodeType: 1,
                  nodeName: 'BUTTON',
                  attributes: ['class', 'ce-btn white'],
                  children: [{ nodeType: 3, nodeName: '#text', nodeValue: '暂存离开' }],
                },
                {
                  nodeId: 6,
                  nodeType: 1,
                  nodeName: 'BUTTON',
                  attributes: ['class', 'ce-btn bg-red'],
                  children: [{ nodeType: 3, nodeName: '#text', nodeValue: '发布' }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}

const draftTarget: Target = {
  primary: {
    how: 'cdp-shadow',
    value: '暂存离开',
    role: 'button',
    tag: 'button',
    closedShadow: true,
  },
  fallbacks: [],
}

let dom: JSDOM
let host: HTMLElement
let draft: HTMLElement
let publish: HTMLElement
let lightButton: HTMLElement

/** Geometry jsdom cannot supply; the probe reads a rect and hit-tests its center. */
const box = { x: 100, y: 200, width: 120, height: 40, left: 100, top: 200, right: 220, bottom: 240 }

function giveGeometry(element: HTMLElement): void {
  element.getBoundingClientRect = () => box as DOMRect
}

/**
 * The CDP endpoint the probe speaks to. `DOM.getDocument` hands back the pierced
 * tree above; a resolved node becomes an id, and `Runtime.callFunctionOn` runs
 * the probe's own serialized function against the real jsdom element.
 */
function makeSession(opts: { hit?: (x: number, y: number) => unknown; callFails?: boolean } = {}): {
  session: CdpSession
  methods: string[]
} {
  const nodes = new Map<number, HTMLElement>([
    [5, draft],
    [6, publish],
  ])
  const methods: string[] = []
  const session: CdpSession = {
    async send(method, params = {}) {
      methods.push(method)
      if (method === 'DOM.getDocument') return { root: piercedTree }
      if (method === 'DOM.resolveNode') {
        const node = nodes.get(params['nodeId'] as number)
        if (!node) throw new Error('no such node')
        return { object: { objectId: `obj-${params['nodeId']}` } }
      }
      if (method === 'Runtime.callFunctionOn') {
        if (opts.callFails) throw new Error('debugger detached')
        const node = nodes.get(Number(String(params['objectId']).slice(4))) as HTMLElement
        const document = { elementFromPoint: (x: number, y: number) => opts.hit?.(x, y) ?? null }
        const invoke = new Function(
          'getComputedStyle',
          'document',
          'node',
          `return (${params['functionDeclaration']}).call(node)`,
        ) as (
          getComputedStyle: typeof globalThis.getComputedStyle,
          document: unknown,
          node: HTMLElement,
        ) => unknown
        return {
          result: {
            value: invoke(dom.window.getComputedStyle.bind(dom.window), document, node),
          },
        }
      }
      if (method === 'DOM.getBoxModel') {
        // The real shape: a flat content quad.
        return { model: { content: [100, 200, 220, 200, 220, 240, 100, 240] } }
      }
      return {}
    },
  }
  return { session, methods }
}

beforeEach(() => {
  dom = new JSDOM(
    `<!DOCTYPE html><body>
      <button id="light-btn">Light</button>
      <xhs-publish-btn id="publish-host"></xhs-publish-btn>
    </body>`,
    { url: 'https://creator.xiaohongshu.test/publish/publish', pretendToBeVisual: true },
  )
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document

  host = dom.window.document.getElementById('publish-host') as HTMLElement
  // CLOSED, like the real component: `host.shadowRoot` is null from here on.
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `
    <div class="publish-page-publish-btn">
      <button type="button" class="ce-btn white">暂存离开</button>
      <button type="button" class="ce-btn bg-red">发布</button>
    </div>`
  draft = root.querySelector('button.white') as HTMLElement
  publish = root.querySelector('button.bg-red') as HTMLElement
  lightButton = dom.window.document.getElementById('light-btn') as HTMLElement
  giveGeometry(draft)
  giveGeometry(publish)
})

describe('probeClosedShadow', () => {
  it('sees the element the page cannot: present, visible, enabled and ready', async () => {
    // The hit test reports the light-DOM host, because that is what a closed
    // root retargets to — the probe must read that as "the click lands on us".
    const { session, methods } = makeSession({ hit: () => host })

    const out = await probeClosedShadow(session, draftTarget)

    expect(out).toMatchObject({
      matchCount: 1,
      state: 'ready',
      visible: true,
      enabled: true,
      occluded: false,
      rect: { x: 100, y: 200, w: 120, h: 40 },
    })
    // Read through the debugger only: the in-page channel is never consulted.
    expect(methods).not.toContain('Runtime.evaluate')
    expect(host.shadowRoot).toBeNull()
  })

  it('follows the composed ancestor chain: a hidden host hides the button', async () => {
    host.style.display = 'none'
    const { session } = makeSession({ hit: () => host })

    const out = await probeClosedShadow(session, draftTarget)

    // Present (it is in the tree) but not drawable — `visible` is what the
    // wait asked for, so the step must not be let through.
    expect(out.matchCount).toBe(1)
    expect(out.state).toBe('blocked')
    expect(out.visible).toBe(false)
    expect(out.enabled).toBe(true)
  })

  it('reads aria-disabled on the shadowed button as not enabled', async () => {
    draft.setAttribute('aria-disabled', 'true')
    const { session } = makeSession({ hit: () => host })

    const out = await probeClosedShadow(session, draftTarget)

    expect(out.visible).toBe(true)
    expect(out.enabled).toBe(false)
    expect(out.state).toBe('blocked')
  })

  it('reports occlusion when the hit test lands on an unrelated element', async () => {
    const { session } = makeSession({ hit: () => lightButton })

    const out = await probeClosedShadow(session, draftTarget)

    // The button is drawn and usable — a `visible` wait still passes. Only the
    // combined `ready` verdict (the click pre-check) is withheld.
    expect(out.visible).toBe(true)
    expect(out.occluded).toBe(true)
    expect(out.state).toBe('blocked')
  })

  it('answers missing, without touching the node, when the root holds no match', async () => {
    const { session, methods } = makeSession()

    const out = await probeClosedShadow(session, {
      primary: {
        how: 'cdp-shadow',
        value: '不存在的按钮',
        role: 'button',
        closedShadow: true,
      },
      fallbacks: [],
    })

    expect(out).toMatchObject({ matchCount: 0, state: 'missing', visible: false })
    expect(methods).toEqual(['DOM.getDocument'])
  })

  it('falls back to the box model when the page-side read is unavailable', async () => {
    const { session, methods } = makeSession({ callFails: true })

    const out = await probeClosedShadow(session, draftTarget)

    // A box model exists only for a laid-out element, so it answers "drawn".
    expect(out.visible).toBe(true)
    expect(out.rect).toBeNull()
    expect(methods).toContain('DOM.getBoxModel')
  })

  it('counts every shadowed match of the whole target chain', async () => {
    const { session } = makeSession({ hit: () => host })

    const out = await probeClosedShadow(session, {
      primary: { how: 'cdp-shadow', value: '', role: 'button', closedShadow: true },
      fallbacks: [],
    })

    // Both buttons are role=button and the empty name matches any of them.
    expect(out.matchCount).toBe(2)
    // `matchCandidates` prefers the enabled one, and both are enabled here.
    expect(out.state).toBe('ready')
  })
})
