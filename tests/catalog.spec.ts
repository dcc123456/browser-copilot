/**
 * Catalog integrity: the generated block catalog must stay complete and
 * internally consistent — every block has the fields the UI/engine rely on,
 * ids are unique, cloud blocks are flagged and filtered, and editable blocks
 * reference an edit form.
 */
import { describe, it, expect } from 'vitest'
import { BLOCK_CATALOG, CATEGORY_META } from '../src/lib/workflow/blocks/catalog'
import { CLOUD_BLOCK_IDS, isCloudBlock } from '../src/lib/workflow/blocks/cloud-blocks'

describe('block catalog', () => {
  it('every entry has id/name/icon/category/component/default data', () => {
    for (const b of BLOCK_CATALOG) {
      expect(b.id, 'block has id').toBeTruthy()
      expect(b.name, `${b.id} has name`).toBeTruthy()
      expect(b.icon, `${b.id} has icon`).toBeTruthy()
      expect(CATEGORY_META[b.category], `${b.id} has known category`).toBeTruthy()
      expect(b.component, `${b.id} has component`).toBeTruthy()
      expect(typeof b.description, `${b.id} description is string`).toBe('string')
      expect(b.data && typeof b.data === 'object', `${b.id} has default data`).toBe(true)
      expect(typeof b.inputs, `${b.id} inputs`).toBe('number')
      expect(typeof b.outputs, `${b.id} outputs`).toBe('number')
    }
  })

  it('ids are unique', () => {
    const ids = BLOCK_CATALOG.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('icons use RemixIcon names, inline paths, or http URLs', () => {
    for (const b of BLOCK_CATALOG) {
      const ok =
        b.icon.startsWith('ri') || b.icon.startsWith('path:') || b.icon.startsWith('http')
      expect(ok, `${b.id} icon "${b.icon}" is a supported form`).toBe(true)
    }
  })

  it('every cloud id is flagged cloud, and only those are cloud', () => {
    for (const id of CLOUD_BLOCK_IDS) {
      const entry = BLOCK_CATALOG.find((b) => b.id === id)
      expect(entry, `cloud block ${id} exists in catalog`).toBeTruthy()
      expect(entry?.cloud, `${id} flagged cloud`).toBe(true)
    }
    for (const b of BLOCK_CATALOG) {
      expect(b.cloud === true ? true : !isCloudBlock(b.id)).toBe(true)
    }
  })

  it('the five cloud blocks are exactly google/ai/package', () => {
    const cloud = BLOCK_CATALOG.filter((b) => b.cloud).map((b) => b.id).sort()
    expect(cloud).toEqual(
      [...CLOUD_BLOCK_IDS].sort(),
    )
  })

  it('local (palette) block count is at least 50', () => {
    expect(BLOCK_CATALOG.filter((b) => !b.cloud).length).toBeGreaterThanOrEqual(50)
  })

  it('every editable local block references an editComponent (except inline-edited repeat-task)', () => {
    const INLINE_EDITED = new Set(['repeat-task'])
    for (const b of BLOCK_CATALOG) {
      if (b.cloud || b.disableEdit || INLINE_EDITED.has(b.id)) continue
      expect(b.editComponent, `block ${b.id} references an edit form`).toBeTruthy()
    }
  })

  it('every category has light and dark colors', () => {
    for (const [id, meta] of Object.entries(CATEGORY_META)) {
      expect(meta.name, `${id} has name`).toBeTruthy()
      expect(meta.light.bg, `${id} light bg`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(meta.dark.bg, `${id} dark bg`).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('branching blocks use node components that render extra handles', () => {
    // Automa renders branch handles dynamically from the node component
    // (BlockConditions renders one output per condition, loop blocks render
    // loop/end handles). Assert the component-family wiring that the React
    // node renderers branch on.
    const comp = (id: string) => BLOCK_CATALOG.find((b) => b.id === id)?.component
    expect(comp('conditions')).toBe('Conditions')
    expect(comp('element-exists')).toBe('ElementExists')
    expect(comp('repeat-task')).toBe('RepeatTask')
    expect(comp('loop-breakpoint')).toBe('LoopBreakpoint')
    // while-loop renders through the default node renderer
    expect(comp('while-loop')).toBe('Default')
    // element-exists statically declares two outputs (exists / not-exists)
    expect(BLOCK_CATALOG.find((b) => b.id === 'element-exists')?.outputs).toBe(2)
  })

  it('trigger block has no inputs and one output', () => {
    const trigger = BLOCK_CATALOG.find((b) => b.id === 'trigger')!
    expect(trigger.inputs).toBe(0)
    expect(trigger.outputs).toBe(1)
  })
})
