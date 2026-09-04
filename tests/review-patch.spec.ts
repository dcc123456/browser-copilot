import { describe, expect, it } from 'vitest'

import { applyNodeKeepSelection, reviewStepsOf } from '../src/lib/workflow/review-patch'
import { workflowFromHistory } from '../src/lib/storage'
import type { HistoryEntry } from '../src/lib/types'
import type { Workflow } from '../src/lib/workflow/types'

type Args = Record<string, unknown>

let seq = 0
function entry(action: string, args?: Args, host?: string): HistoryEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    at: seq,
    conversationId: 'conv-1',
    action,
    summary: action,
    approved: true,
    ok: true,
    ...(args ? { args } : {}),
    ...(host ? { host } : {}),
  }
}

/** A representative generated flow: nav → wait, click, AI-prefilled fill. */
function fixture(): Workflow {
  return workflowFromHistory(
    [
      entry('open_url', { url: 'https://a.com' }),
      entry('click', { target: { primary: { how: 'css', value: '.open-form' } } }),
      entry('fill', {
        target: { primary: { how: 'css', value: '#bio' } },
        value: '一段超过二十四个字符的自我介绍文本内容',
        generated: true,
      }),
      entry('fill', { target: { primary: { how: 'css', value: '#name' } }, value: '张三' }),
    ],
    'wf',
  )!
}

describe('applyNodeKeepSelection', () => {
  it('returns the identical workflow for an empty / all-keep selection', () => {
    const wf = fixture()
    expect(applyNodeKeepSelection(wf, {})).toBe(wf)
    const allKeep = Object.fromEntries(reviewStepsOf(wf).map((s) => [s.id, true]))
    expect(applyNodeKeepSelection(wf, allKeep)).toBe(wf)
  })

  it('drops a middle step and re-links the spine with the canonical handles', () => {
    const wf = fixture()
    const steps = reviewStepsOf(wf)
    const click = steps.find((s) => s.blockId === 'event-click')!
    const result = applyNodeKeepSelection(wf, { [click.id]: false })

    expect(result.drawflow.nodes.some((n) => n.id === click.id)).toBe(false)
    // The trigger survives even though it was never part of any step.
    expect(result.drawflow.nodes.some((n) => n.data.blockId === 'trigger')).toBe(true)
    // The remaining chain is fully connected: every node but the first has one
    // incoming edge, and no node is left dangling.
    const ids = new Set(result.drawflow.nodes.map((n) => n.id))
    for (const edge of result.drawflow.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
    }
    const incoming = new Map<string, number>()
    for (const edge of result.drawflow.edges) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    }
    const chain = result.drawflow.nodes.filter((n) => n.data.blockId !== 'trigger')
    for (const node of chain) expect(incoming.get(node.id)).toBe(1)

    // Canonical block-keyed handles, same convention as the generator: with
    // the click gone, the nav node re-links straight to its own wait
    // satellite, which re-links onward — the spine stays one chain.
    const nav = result.drawflow.nodes.find((n) => n.data.blockId === 'new-tab')!
    const nextEdge = result.drawflow.edges.find(
      (e) => e.source === nav.id && e.sourceHandle === 'new-tab-output-1',
    )
    expect(nextEdge).toBeDefined()
    const target = result.drawflow.nodes.find((n) => n.id === nextEdge!.target)!
    expect(target.data.blockId).toBe('wait-connections')
    expect(nextEdge!.targetHandle).toBe('wait-connections-input-1')
  })

  it('drops the paired AI agent together with its forms step', () => {
    const wf = fixture()
    const steps = reviewStepsOf(wf)
    const bio = steps.find((s) =>
      s.satelliteSummary.some((sum) => sum.includes('AI 生成表单内容')),
    )!
    const agentId = bio.satelliteIds[0]!
    const result = applyNodeKeepSelection(wf, { [bio.id]: false })
    expect(result.drawflow.nodes.some((n) => n.id === bio.id)).toBe(false)
    expect(result.drawflow.nodes.some((n) => n.id === agentId)).toBe(false)
  })

  it('is idempotent and keeps the trigger under aggressive drops', () => {
    const wf = fixture()
    const dropAll = Object.fromEntries(reviewStepsOf(wf).map((s) => [s.id, false]))
    const once = applyNodeKeepSelection(wf, dropAll)
    const twice = applyNodeKeepSelection(once, dropAll)
    expect(twice.drawflow.nodes).toEqual(once.drawflow.nodes)
    expect(twice.drawflow.edges).toEqual(once.drawflow.edges)
    // Only the trigger remains, and it survives.
    expect(once.drawflow.nodes.map((n) => n.data.blockId)).toEqual(['trigger'])
  })

  it('re-packs canvas positions without gaps after removals', () => {
    const wf = fixture()
    const steps = reviewStepsOf(wf)
    const click = steps.find((s) => s.blockId === 'event-click')!
    const result = applyNodeKeepSelection(wf, { [click.id]: false })
    const ys = result.drawflow.nodes.map((n) => n.position.y)
    expect(ys[0]).toBe(0)
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBe(80 + (i - 1) * 140)
    }
  })
})
