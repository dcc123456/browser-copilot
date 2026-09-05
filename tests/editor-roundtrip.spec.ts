import { describe, it, expect } from 'vitest'
import { asWorkflow } from '../src/lib/workflow/storage'
import { migrateWorkflow } from '../src/lib/workflow/migrate'
import { BLOCK_BY_ID, CATALOG_BY_ID } from '../src/lib/workflow/blocks/palette'
import { BLOCK_CATALOG } from '../src/lib/workflow/blocks/catalog'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

/**
 * Reproduces the editor's save → reopen cycle without a browser:
 * 1. "save"  — buildWorkflow() output shape → storage.saveWorkflow's
 *              normalize (asWorkflow + migrateWorkflow).
 * 2. "reopen" — the editor load path: migrateWorkflow() again, then map nodes
 *              through toFlowNode's block lookup and check every edge handle
 *              against the handles BlockNode actually renders.
 *
 * BlockNode renders handles keyed by BLOCK id:
 *   input `<blockId>-input-1`, outputs `<blockId>-output-1` (+`-output-2` for
 *   branch blocks) and the fallback source `<blockId>-output-fallback`.
 */
function renderableHandles(blockId: string): { source: string[]; target: string[] } {
  const branch2 = ['conditions', 'element-exists', 'loop-data', 'loop-elements', 'while-loop', 'repeat-task']
  const source = [`${blockId}-output-1`]
  if (branch2.includes(blockId)) source.push(`${blockId}-output-2`)
  // The fallback handle renders when the block's onError settings enable it.
  source.push(`${blockId}-output-fallback`)
  return { source, target: blockId === 'trigger' ? [] : [`${blockId}-input-1`] }
}

function wf(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf1',
    name: 'roundtrip',
    createdAt: 1,
    updatedAt: 1,
    drawflow: { nodes, edges, position: { x: 0, y: 0 }, zoom: 1 },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

const BASE_NODES: WorkflowNode[] = [
  { id: 'n1', label: 'Trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger', type: 'manual' } },
  {
    id: 'n2',
    label: 'Click',
    position: { x: 1, y: 0 },
    data: { blockId: 'event-click', selector: 'a.buy', findBy: 'cssSelector', description: '', onError: { enable: true, toDo: 'fallback' } },
  },
  { id: 'n3', label: 'Forms', position: { x: 2, y: 0 }, data: { blockId: 'forms', selector: '#name', description: '' } },
  { id: 'n4', label: 'OCR', position: { x: 3, y: 0 }, data: { blockId: 'ocr', description: '', onError: { enable: true, toDo: 'fallback' } } },
]

const BASE_EDGES: WorkflowEdge[] = [
  { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'trigger-output-1', targetHandle: 'event-click-input-1' },
  { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'event-click-output-1', targetHandle: 'forms-input-1' },
  { id: 'e3', source: 'n3', target: 'n4', sourceHandle: 'forms-output-1', targetHandle: 'ocr-input-1' },
  // The fallback connection: drawn from ocr's fallback handle back to the
  // earlier event-click block — "fall back to any previous node". (The
  // trigger has no input handle, so it is not a drop target.)
  { id: 'e4', source: 'n4', target: 'n2', sourceHandle: 'ocr-output-fallback', targetHandle: 'event-click-input-1' },
]

function saveThenReopen(wf0: Workflow): Workflow {
  // storage.saveWorkflow(): validate + canonicalize before persisting…
  const stored = migrateWorkflow(asWorkflow(wf0)!)
  // …then the editor load path migrates the stored record again.
  return migrateWorkflow(asWorkflow(stored)!)
}

describe('editor save → reopen round trip', () => {
  it('keeps every node resolvable in the editor block catalog', () => {
    const reopened = saveThenReopen(wf(BASE_NODES, BASE_EDGES))
    for (const node of reopened.drawflow.nodes) {
      const blockId = node.data.blockId as string
      expect(BLOCK_BY_ID.has(blockId), `node ${node.id}: block "${blockId}" must resolve`).toBe(true)
    }
  })

  it('keeps fallback edge handles matching the rendered fallback handle', () => {
    const reopened = saveThenReopen(wf(BASE_NODES, BASE_EDGES))
    const fb = reopened.drawflow.edges.find((e) => e.id === 'e4')
    expect(fb).toBeDefined()
    // BlockNode renders id={`${block.id}-output-fallback`}.
    expect(fb!.sourceHandle).toBe('ocr-output-fallback')
  })

  it('keeps every edge attached to handles the reopened nodes actually render', () => {
    const reopened = saveThenReopen(wf(BASE_NODES, BASE_EDGES))
    const blocks = new Map(reopened.drawflow.nodes.map((n) => [n.id, n.data.blockId as string]))
    for (const e of reopened.drawflow.edges) {
      const src = blocks.get(e.source)!
      const tgt = blocks.get(e.target)!
      expect(renderableHandles(src).source, `edge ${e.id} sourceHandle`).toContain(e.sourceHandle)
      expect(renderableHandles(tgt).target, `edge ${e.id} targetHandle`).toContain(e.targetHandle)
    }
  })

  it('heals fallback handles mangled by earlier saves', () => {
    // Older builds rewrote `…-output-fallback` to `…-fallback` on save; the
    // next load must repair it against the rendered handle id.
    const mangled = wf(BASE_NODES, [
      ...BASE_EDGES.filter((e) => e.id !== 'e4'),
      { id: 'e4', source: 'n4', target: 'n2', sourceHandle: 'ocr-fallback', targetHandle: 'event-click-input-1' },
    ])
    const reopened = saveThenReopen(mangled)
    const fb = reopened.drawflow.edges.find((e) => e.id === 'e4')!
    expect(fb.sourceHandle).toBe('ocr-output-fallback')
  })

  it('is stable across a second save/reopen cycle', () => {
    const once = saveThenReopen(wf(BASE_NODES, BASE_EDGES))
    const twice = saveThenReopen(once)
    expect(twice).toEqual(once)
  })

  it('preserves cloud-block node ids instead of collapsing them to "unknown"', () => {
    const cloudId = BLOCK_CATALOG.find((b) => b.cloud)!.id
    expect(cloudId).toBeTruthy()
    expect(CATALOG_BY_ID.has(cloudId)).toBe(true)
    const nodes: WorkflowNode[] = [
      ...BASE_NODES,
      { id: 'n9', label: cloudId, position: { x: 3, y: 0 }, data: { blockId: cloudId } },
    ]
    const reopened = saveThenReopen(wf(nodes, BASE_EDGES))
    const n9 = reopened.drawflow.nodes.find((n) => n.id === 'n9')!
    // The editor (toFlowNode) must resolve cloud blocks via the full catalog —
    // a miss makes buildWorkflow persist blockId "unknown", which renders no
    // node and no handles, silently dropping every edge attached to it.
    expect(n9.data.blockId).toBe(cloudId)
    expect(CATALOG_BY_ID.get(cloudId)).toBeDefined()
  })
})
