/**
 * The self-heal write-back: what a degraded replay learned must survive it.
 *
 * Without this the same node re-runs the same guess on every replay — the
 * ladder does its work each time and the graph never gets better. With it the
 * winning candidate is rotated into the node and the substitution is recorded.
 * The one rule that matters, and the reason these tests exist: the write-back
 * may only ever REORDER a node's locators. A healed workflow has to be able to
 * find everything it could find before, because a fix that lowers the chance of
 * the next replay working is worse than the degradation it was repairing.
 */
import { describe, expect, it } from 'vitest'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import {
  applySelfHeal,
  lastResolutionOf,
  type NodeDegradation,
} from '../src/lib/workflow/self-heal'
import type { Target, TargetSpec } from '../src/lib/ops'

function node(id: string, data: Record<string, unknown>, label = '点击按钮'): WorkflowNode {
  return { id, label, position: { x: 0, y: 0 }, data }
}

function workflow(nodes: WorkflowNode[]): Workflow {
  return {
    id: 'wf-1',
    name: 'Replay',
    createdAt: 1,
    updatedAt: 1,
    drawflow: { nodes, edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

const degradation = (
  nodeId: string,
  from: string,
  to: string,
  rung: 2 | 3 | 4,
): NodeDegradation => ({ nodeId, from, to, rung, matchCount: 2 })

describe('applySelfHeal', () => {
  it('rotates a CSS winner into the editable selector and keeps the old one', () => {
    const source = workflow([
      node('n1', {
        blockId: 'event-click',
        selector: '.old-list button',
        findBy: 'cssSelector',
        target: { primary: { how: 'css', value: '.old-list button' }, fallbacks: [] },
      }),
    ])

    const healed = applySelfHeal(
      source,
      [degradation('n1', 'css|.old-list button', 'css|#buy', 3)],
      {
        runId: 'run-1',
      },
    )

    expect(healed.changes).toHaveLength(1)
    const data = healed.workflow.drawflow.nodes[0]!.data as Record<string, unknown>
    expect(data['selector']).toBe('#buy')
    const target = data['target'] as Target
    expect(target.primary).toEqual({ how: 'css', value: '#buy' })
    // The displaced locator is still in the chain — healing reorders, never erases.
    expect(target.fallbacks).toContainEqual({ how: 'css', value: '.old-list button' })
    // The input was untouched.
    expect(source.drawflow.nodes[0]!.data['selector']).toBe('.old-list button')
  })

  it('a role winner has no flat form, so the dead selector steps aside', () => {
    const healed = applySelfHeal(
      workflow([node('n1', { blockId: 'event-click', selector: '.stale' })]),
      [degradation('n1', 'css|.stale', 'role|Buy|role=button', 2)],
      { runId: 'run-1' },
    )

    const data = healed.workflow.drawflow.nodes[0]!.data as Record<string, unknown>
    const target = data['target'] as Target
    expect(target.primary).toEqual({ how: 'role', value: 'Buy', role: 'button' })
    expect(target.fallbacks).toContainEqual({ how: 'css', value: '.stale' })
    // `targetFrom` puts a non-empty flat selector FIRST, so leaving `.stale`
    // there would re-ask the page the question it just failed.
    expect(data['selector']).toBe('')
  })

  it('records the substitution, and keeps a bounded history', () => {
    let current = workflow([node('n1', { blockId: 'event-click', selector: '.a' })])
    const chain = ['.b', '.c', '.d', '.e', '.f', '.g']
    for (const to of chain) {
      current = applySelfHeal(current, [degradation('n1', 'css|.a', `css|${to}`, 3)], {
        runId: `run-${to}`,
        at: 1000,
      }).workflow
    }

    const data = current.drawflow.nodes[0]!.data as Record<string, unknown>
    const record = lastResolutionOf(current.drawflow.nodes[0]!)
    expect(record?.to).toBe(`css|.g`)
    expect(record?.rung).toBe(3)
    expect(record?.runId).toBe('run-.g')
    const history = data['__resolutionHistory'] as unknown[]
    expect(history.length).toBeLessThan(5)
    // Only the specs the page actually produced land in the chain.
    const fallbacks = (data['target'] as Target).fallbacks as TargetSpec[]
    expect(fallbacks.length).toBeLessThanOrEqual(7)
  })

  it('a node that keeps landing on the bottom rung stops counting as healed', () => {
    // Rung 4 is the first-visible guess. Three of them on one node is not a
    // page that drifted — it is a graph that cannot find its element, and
    // reporting it as certified would be the false success this whole path
    // exists to prevent.
    let current = workflow([node('n1', { blockId: 'event-click', selector: '.a' })])
    let uncertify = false
    for (const to of ['.b', '.c', '.d']) {
      const result = applySelfHeal(current, [degradation('n1', 'css|.a', `css|${to}`, 4)], {
        runId: `run-${to}`,
      })
      current = result.workflow
      uncertify = result.uncertify
    }
    expect(uncertify).toBe(true)
  })

  it('a single bottom-rung win does not revoke certification', () => {
    const result = applySelfHeal(
      workflow([node('n1', { blockId: 'event-click', selector: '.a' })]),
      [degradation('n1', 'css|.a', 'css|.b', 4)],
      { runId: 'run-1' },
    )
    expect(result.uncertify).toBe(false)
    expect(result.changes).toHaveLength(1)
  })

  it('ignores reports for nodes the graph no longer has, and an unparseable winner', () => {
    const source = workflow([node('n1', { blockId: 'event-click', selector: '.a' })])

    const gone = applySelfHeal(source, [degradation('other', 'css|.a', 'css|.b', 2)], {
      runId: 'run-1',
    })
    expect(gone.workflow).toBe(source)
    expect(gone.changes).toEqual([])

    const bogus = applySelfHeal(source, [degradation('n1', 'css|.a', 'not-a-spec', 2)], {
      runId: 'run-1',
    })
    const data = bogus.workflow.drawflow.nodes[0]!.data as Record<string, unknown>
    // The audit record still lands (the ladder ran and lost); the locator does
    // not change, because there is nothing trustworthy to rotate in.
    expect(data['selector']).toBe('.a')
    expect(data['__resolution']).toMatchObject({ to: 'not-a-spec', rung: 2 })
  })

  it('preserves the rich target’s frame hint and label through the rotation', () => {
    const healed = applySelfHeal(
      workflow([
        node('n1', {
          blockId: 'event-click',
          target: {
            primary: { how: 'css', value: '.stale' },
            fallbacks: [{ how: 'text', value: 'Buy' }],
            frameHint: 'https://app.test/checkout',
            label: '结算按钮',
          },
        }),
      ]),
      [degradation('n1', 'css|.stale', 'text|Buy', 3)],
      { runId: 'run-1' },
    )
    const target = (healed.workflow.drawflow.nodes[0]!.data as Record<string, unknown>)[
      'target'
    ] as Target
    expect(target.frameHint).toBe('https://app.test/checkout')
    expect(target.label).toBe('结算按钮')
    expect(target.fallbacks).toContainEqual({ how: 'css', value: '.stale' })
  })
})
