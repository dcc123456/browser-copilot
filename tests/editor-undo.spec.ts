// @vitest-environment jsdom
/**
 * The two rules behind the editor's Ctrl+Z, kept out of the React wiring: what
 * counts as ONE undoable step, and which keypresses the canvas may take at all.
 *
 * The stack holds whole-canvas snapshots, so the interesting bugs are all in
 * when a snapshot is recorded: a drag that fires a frame per animation frame must
 * not bury the structural steps under sixty no-ops, the Delete key must still
 * record (it never reaches the editor's own delete handlers), and Ctrl+Z typed
 * into a parameter field has to stay that field's undo.
 */
import { describe, expect, it } from 'vitest'
import type { EdgeChange, NodeChange } from '@xyflow/react'
import {
  EDITOR_UNDO_LIMIT,
  nodeDragStep,
  pushCanvasSnapshot,
  removesAnything,
  type CanvasSnapshot,
} from '../src/workflow-editor/graph-history'
import { isEditableTarget } from '../src/workflow-editor/use-space-select'

const snapshot = (name: string): CanvasSnapshot => ({
  nodes: [{ id: name, label: name, position: { x: 0, y: 0 }, data: { blockId: 'click' } }],
  edges: [],
  selectedIds: [],
})

describe('pushCanvasSnapshot', () => {
  it('stacks newest last, so the pop order is the undo order', () => {
    const history: CanvasSnapshot[] = []
    pushCanvasSnapshot(history, snapshot('a'))
    pushCanvasSnapshot(history, snapshot('b'))
    expect(history).toHaveLength(2)
    expect(history.pop()?.nodes[0]?.id).toBe('b')
  })

  it('drops the oldest steps past the limit', () => {
    const history: CanvasSnapshot[] = []
    for (let index = 0; index < EDITOR_UNDO_LIMIT + 10; index += 1) {
      pushCanvasSnapshot(history, snapshot(`step-${index}`))
    }
    expect(history).toHaveLength(EDITOR_UNDO_LIMIT)
    expect(history[0]?.nodes[0]?.id).toBe('step-10')
    expect(history[history.length - 1]?.nodes[0]?.id).toBe(`step-${EDITOR_UNDO_LIMIT + 9}`)
  })
})

describe('removesAnything', () => {
  it('is the Delete-key path', () => {
    const nodeRemoved: NodeChange = { type: 'remove', id: 'n1' }
    const edgeRemoved: EdgeChange = { type: 'remove', id: 'e1' }
    expect(removesAnything([nodeRemoved])).toBe(true)
    expect(removesAnything([edgeRemoved])).toBe(true)
  })

  it('stays quiet for picking and for a drawn connection', () => {
    const picked: NodeChange = { type: 'select', id: 'n1', selected: true }
    const added: EdgeChange = { type: 'add', item: { id: 'e1', source: 'n1', target: 'n2' } }
    expect(removesAnything([picked])).toBe(false)
    expect(removesAnything([added])).toBe(false)
  })
})

describe('nodeDragStep', () => {
  const frame = (ids: string[], dragging: boolean): NodeChange[] =>
    ids.map((id) => ({
      type: 'position',
      id,
      position: { x: 1, y: 1 },
      ...(dragging ? { dragging: true } : {}),
    }))

  it('opens one step for the whole drag', () => {
    let open = false
    const pushes: boolean[] = []
    for (const batch of [frame(['n1'], true), frame(['n1'], true), frame(['n1'], false)]) {
      const step = nodeDragStep(batch, open)
      open = step.dragStepOpen
      pushes.push(step.push)
    }
    expect(pushes).toEqual([true, false, false])
    expect(open).toBe(false)
  })

  it('counts a box-drag of several nodes as one step', () => {
    expect(nodeDragStep(frame(['n1', 'n2', 'n3'], true), false)).toEqual({
      push: true,
      dragStepOpen: true,
    })
  })

  it('does not mistake a programmatic move for a drag', () => {
    // An auto-layout or a snap writes the position without dragging: the caller
    // records that change itself, so the drag rule must stay out of the way.
    expect(nodeDragStep(frame(['n1'], false), false)).toEqual({
      push: false,
      dragStepOpen: false,
    })
  })

  it('ignores selection changes', () => {
    expect(nodeDragStep([{ type: 'select', id: 'n1', selected: true }], false)).toEqual({
      push: false,
      dragStepOpen: false,
    })
  })
})

describe('isEditableTarget', () => {
  it('leaves the key to whatever the user is typing into', () => {
    for (const tag of ['input', 'textarea'] as const) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true)
    }
    const editable = document.createElement('div')
    // jsdom has no contenteditable engine; the flag the DOM would set is the input.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isEditableTarget(editable)).toBe(true)
  })

  it('is the canvas, not a field, for everything else', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(document.createElement('span'))).toBe(false)
    expect(isEditableTarget(document.body)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
