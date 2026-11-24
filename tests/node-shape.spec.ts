import { describe, expect, it } from 'vitest'
import type { WorkflowNode } from '../src/lib/workflow/types'
import { canvasFieldsOf, storedNodeOf } from '../src/lib/workflow/node-shape'

/**
 * A block the running build does not know must survive the canvas round trip.
 * The old path stripped `blockId` into the resolved catalog entry and wrote
 * `unknown` back whenever that entry was missing — a silent, permanent rewrite
 * of the user's graph on the next save.
 */

const stored = (
  blockId: string,
  label: string,
  data: Record<string, unknown> = {},
): WorkflowNode => ({
  id: 'u1',
  label,
  position: { x: 1, y: 2 },
  data: { ...data, blockId },
})

describe('canvas ↔ stored round trip', () => {
  it('keeps an unknown block id and label instead of writing `unknown`', () => {
    const original = stored('some-removed-block', 'Old operator', { code: 'return 1' })
    const fields = canvasFieldsOf(original)
    expect(fields).toMatchObject({ blockId: 'some-removed-block', label: 'Old operator' })
    const back = storedNodeOf(original.id, original.position, fields)
    expect(back.data['blockId']).toBe('some-removed-block')
    expect(back.label).toBe('Old operator')
  })

  it('uses the catalog name for a known block, so labels stay canonical', () => {
    const original = stored('javascript-code', 'whatever', { code: 'x' })
    const back = storedNodeOf(original.id, original.position, canvasFieldsOf(original))
    expect(back.data['blockId']).toBe('javascript-code')
    expect(back.label).not.toBe('')
    expect(back.label).not.toBe('unknown')
  })

  it('never emits `unknown` for a node that had an id', () => {
    for (const id of ['some-removed-block', 'javascript-code', 'wf_op_event-click']) {
      const fields = canvasFieldsOf(stored(id, id))
      expect(storedNodeOf('n', { x: 0, y: 0 }, fields).data['blockId']).toBe(id)
    }
  })
})
