import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ReactFlowProvider, type Edge } from '@xyflow/react'
import { UnknownBlockNode } from '../src/workflow-editor/flow/BlockNode'
import { healEdgeHandles } from '../src/workflow-editor/flow/connections'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { canvasFieldsOf, storedNodeOf } from '../src/lib/workflow/node-shape'
import type { WorkflowNode } from '../src/lib/workflow/types'

/**
 * A block id this build does not resolve used to render `null`: the node was a
 * 0×0 shell with no handles, React Flow silently dropped its edges, and the
 * canvas looked like the workflow had been mangled while the data was intact.
 * The card must be visible and must keep its wiring; the stored id/label must
 * survive a save.
 */

const UNKNOWN_ID = 'some-removed-block'

function render(data: Record<string, unknown>): string {
  const value = makeEditorLocale(
    'en',
    (key) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key,
  )
  return renderToStaticMarkup(
    createElement(
      EditorLocaleContext.Provider,
      { value },
      createElement(ReactFlowProvider, {
        children: createElement(UnknownBlockNode, { id: 'u1', data, selected: false } as never),
      }),
    ),
  )
}

const UNKNOWN_NODE_DATA = {
  blockId: UNKNOWN_ID,
  label: 'Old operator',
  blockData: { code: 'return 1' },
}

describe('unknown block placeholder card', () => {
  it('renders a visible card that names the block instead of nothing', () => {
    const html = render(UNKNOWN_NODE_DATA)
    expect(html).toContain(`Unknown operator: ${UNKNOWN_ID}`)
    expect(html).toContain('Original name: Old operator')
    // The card body exists — the old renderer produced an empty string.
    expect(html).toContain('wf-node-body')
  })

  it('draws both handles under the stored block id, so edges have somewhere to land', () => {
    const html = render(UNKNOWN_NODE_DATA)
    expect(html).toContain(`data-handleid="${UNKNOWN_ID}-input-1"`)
    expect(html).toContain(`data-handleid="${UNKNOWN_ID}-output-1"`)
  })

  it('keeps only the actions that can work, so no button opens an empty panel', () => {
    const calls: string[] = []
    const html = render({
      ...UNKNOWN_NODE_DATA,
      actions: {
        onDelete: () => calls.push('delete'),
        onDuplicate: () => calls.push('duplicate'),
        onSettings: () => calls.push('settings'),
        onEdit: () => calls.push('edit'),
        onToggleDisable: () => calls.push('disable'),
        onToggleBreakpoint: () => calls.push('breakpoint'),
        onRunFromHere: () => calls.push('run'),
      },
    })
    expect(html).toContain('Delete block')
    expect(html).toContain('Duplicate block')
    expect(html).not.toContain('Block settings')
    expect(html).not.toContain('Edit block')
    expect(html).not.toContain('Run workflow from here')
  })
})

describe('edges of an unknown block survive the load', () => {
  const nodes = [
    { id: 'k1', data: { block: { id: 'javascript-code', inputs: 1, outputs: 1 }, blockData: {} } },
    { id: 'u1', data: { blockId: UNKNOWN_ID } },
    { id: 'k2', data: { block: { id: 'javascript-code', inputs: 1, outputs: 1 }, blockData: {} } },
  ]
  const edges: Edge[] = [
    {
      id: 'e1',
      source: 'k1',
      target: 'u1',
      sourceHandle: 'k1-output-1',
      targetHandle: 'k1-input-1',
    },
    {
      id: 'e2',
      source: 'u1',
      target: 'k2',
      sourceHandle: `${UNKNOWN_ID}-output-2`,
      targetHandle: `${UNKNOWN_ID}-input-1`,
    },
  ]

  it('re-anchors both ends onto the placeholder handles instead of dropping the edge', () => {
    const healed = healEdgeHandles(nodes as never, edges)
    expect(healed.map((e) => e.id)).toEqual(['e1', 'e2'])
    const into = healed.find((e) => e.id === 'e1')!
    expect(into.targetHandle).toBe(`${UNKNOWN_ID}-input-1`)
    const out = healed.find((e) => e.id === 'e2')!
    expect(out.sourceHandle).toBe(`${UNKNOWN_ID}-output-1`)
    expect(out.targetHandle).toBe('javascript-code-input-1')
  })
})

describe('saving a placeholder node', () => {
  it('writes the stored id and label back unchanged', () => {
    const original: WorkflowNode = {
      id: 'u1',
      label: 'Old operator',
      position: { x: 10, y: 20 },
      data: { blockId: UNKNOWN_ID, code: 'return 1' },
    }
    const fields = canvasFieldsOf(original)
    // What the placeholder carries on its node data.
    const back = storedNodeOf(
      'u1',
      { x: 30, y: 40 },
      {
        blockId: fields.blockId,
        label: fields.label,
        blockData: fields.blockData,
      },
    )
    expect(back.data['blockId']).toBe(UNKNOWN_ID)
    expect(back.label).toBe('Old operator')
    expect(back.data['code']).toBe('return 1')
  })
})
