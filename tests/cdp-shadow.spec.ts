/**
 * Pure tree-parsing logic behind the CDP closed-shadow channel.
 *
 * `buildShadowCandidates` walks a `DOM.getDocument({ pierce: true })` tree
 * (which expands CLOSED shadow roots) and collects interactive elements inside
 * shadow roots; `matchCandidates` resolves a Target against them; `boxCenter`
 * and the live click sequence are verified with a fake CDP session.
 */
import { describe, it, expect } from 'vitest'
import {
  buildShadowCandidates,
  matchCandidates,
  candidateToSnapshot,
  boxCenter,
  clickClosedShadow,
  type CdpSession,
} from '../src/background/cdp-shadow'
import type { Target } from '../src/lib/ops'

// A pierced CDP node tree shaped like the <xhs-publish-btn> component:
// the host's shadowRoots[0] contains two buttons, one being 发布.
const piercedTree = {
  nodeId: 1,
  nodeType: 9, // document
  nodeName: '#document',
  children: [
    {
      nodeId: 2,
      nodeType: 1,
      nodeName: 'XHS-PUBLISH-BTN',
      attributes: ['id', 'publish-host'],
      shadowRoots: [
        {
          nodeId: 3,
          nodeType: 11, // shadow root (CDP marks these as fragments)
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
                  attributes: ['class', 'ce-btn bg-red', 'aria-disabled', 'false'],
                  children: [{ nodeType: 3, nodeName: '#text', nodeValue: '发布' }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      nodeId: 7,
      nodeType: 1,
      nodeName: 'BUTTON',
      attributes: ['id', 'light-btn'],
      children: [{ nodeType: 3, nodeName: '#text', nodeValue: 'Light' }],
    },
  ],
}

describe('buildShadowCandidates', () => {
  it('collects interactive elements inside shadow roots but not light DOM', () => {
    const cands = buildShadowCandidates(piercedTree)
    const names = cands.map((c) => c.name)
    expect(names).toContain('发布')
    expect(names).toContain('暂存离开')
    // The light-DOM button is not inside a shadow root.
    expect(names).not.toContain('Light')
  })

  it('marks buttons as role=button and records the host tag chain', () => {
    const cands = buildShadowCandidates(piercedTree)
    const publish = cands.find((c) => c.name === '发布')
    expect(publish).toBeTruthy()
    expect(publish!.role).toBe('button')
    expect(publish!.tag).toBe('button')
    expect(publish!.hostTags).toContain('xhs-publish-btn')
  })

  it('treats aria-disabled as disabled', () => {
    const cands = buildShadowCandidates(piercedTree)
    const publish = cands.find((c) => c.name === '发布')
    // aria-disabled="false" -> not disabled.
    expect(publish!.disabled).toBe(false)
  })
})

describe('matchCandidates', () => {
  const target: Target = {
    primary: { how: 'cdp-shadow', value: '发布', role: 'button', tag: 'button', closedShadow: true },
    fallbacks: [],
    label: '发布',
  }

  it('matches a role+name target to the right shadowed button', () => {
    const cands = buildShadowCandidates(piercedTree)
    const m = matchCandidates(cands, target)
    expect(m).toBeTruthy()
    expect(m!.name).toBe('发布')
    expect(m!.node.nodeId).toBe(6)
  })

  it('returns null when nothing matches', () => {
    const cands = buildShadowCandidates(piercedTree)
    const m = matchCandidates(cands, {
      primary: { how: 'cdp-shadow', value: '不存在的按钮', role: 'button', closedShadow: true },
      fallbacks: [],
    })
    expect(m).toBeNull()
  })
})

describe('candidateToSnapshot', () => {
  it('emits a closed-shadow target the driver routes through CDP', () => {
    const cands = buildShadowCandidates(piercedTree)
    const publish = cands.find((c) => c.name === '发布')!
    const entry = candidateToSnapshot(publish, 'e42')
    expect(entry.ref).toBe('e42')
    expect(entry.name).toBe('发布')
    expect(entry.target.primary.how).toBe('cdp-shadow')
    expect(entry.target.primary.closedShadow).toBe(true)
  })
})

describe('boxCenter', () => {
  it('parses the REAL CDP shape: a flat 8-number content quad', () => {
    // DOM.getBoxModel returns model.content as [x1,y1,x2,y2,x3,y3,x4,y4].
    // Regression: parsing this as point objects yielded NaN, which
    // JSON.stringify turned into null and CDP rejected with
    // "params.x mandatory field missing".
    const center = boxCenter({
      model: { content: [100, 200, 220, 200, 220, 240, 100, 240] },
    })
    expect(center).toEqual({ x: 160, y: 220 })
  })

  it('also tolerates an object-point quad', () => {
    const center = boxCenter({
      content: [
        { x: 100, y: 200 },
        { x: 220, y: 200 },
        { x: 220, y: 240 },
        { x: 100, y: 240 },
      ],
    })
    expect(center).toEqual({ x: 160, y: 220 })
  })

  it('rejects boxes that would produce non-finite coordinates', () => {
    expect(boxCenter({ model: { content: [] } })).toBeNull()
    expect(boxCenter({ model: { content: [1, 2] } })).toBeNull()
  })

  it('returns null for a missing box', () => {
    expect(boxCenter(undefined)).toBeNull()
  })
})

describe('clickClosedShadow', () => {
  it('dispatches trusted press/release at the matched button center', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const session: CdpSession = {
      send: (method, params = {}) => {
        calls.push({ method, params })
        if (method === 'DOM.getDocument') return Promise.resolve({ root: piercedTree })
        if (method === 'DOM.getBoxModel') {
          // REAL CDP shape: flat number quad, not point objects.
          return Promise.resolve({
            model: { content: [100, 200, 220, 200, 220, 240, 100, 240] },
          })
        }
        return Promise.resolve({})
      },
    }
    const target: Target = {
      primary: { how: 'cdp-shadow', value: '发布', role: 'button', closedShadow: true },
      fallbacks: [],
    }
    const out = await clickClosedShadow(session, target)
    expect(out.ok).toBe(true)

    const events = calls.filter((c) => c.method === 'Input.dispatchMouseEvent')
    expect(events.map((e) => e.params.type)).toEqual(['mousePressed', 'mouseReleased'])
    expect(events[0]!.params).toMatchObject({ x: 160, y: 220, button: 'left' })
  })

  it('falls back to a node click when the box model is unavailable', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const session: CdpSession = {
      send: (method, params = {}) => {
        calls.push({ method, params })
        if (method === 'DOM.getDocument') return Promise.resolve({ root: piercedTree })
        if (method === 'DOM.getBoxModel') return Promise.reject(new Error('no box'))
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'obj-1' } })
        }
        return Promise.resolve({})
      },
    }
    const out = await clickClosedShadow(session, {
      primary: { how: 'cdp-shadow', value: '发布', role: 'button', closedShadow: true },
      fallbacks: [],
    })
    expect(out.ok).toBe(true)
    const methods = calls.map((c) => c.method)
    expect(methods).toContain('DOM.resolveNode')
    expect(methods).toContain('Runtime.callFunctionOn')
    const fn = calls.find((c) => c.method === 'Runtime.callFunctionOn')
    expect(fn!.params.functionDeclaration).toContain('this.click()')
  })

  it('reports failure when the element is absent from the pierced tree', async () => {
    const session: CdpSession = {
      send: (method) => {
        if (method === 'DOM.getDocument') return Promise.resolve({ root: piercedTree })
        return Promise.resolve({})
      },
    }
    const out = await clickClosedShadow(session, {
      primary: { how: 'cdp-shadow', value: '不存在', role: 'button', closedShadow: true },
      fallbacks: [],
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('未找到')
  })
})
