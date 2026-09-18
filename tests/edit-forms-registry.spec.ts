/**
 * The `editComponent` ↔ `EditForms` contract.
 *
 * A catalog entry names its form by string (`editComponent: 'EditReadPage'`);
 * the actual React component lives in one of the four batch maps that
 * `EditForms` merges. Nothing type-checks that pairing — the string and the
 * registry key are joined at runtime — so a block can ship with a form file
 * that nobody registered and still compile, lint, and pass every executor test.
 * The only visible symptom is the editor quietly falling back to the generic
 * key/value editor, which looks like "the form is missing" and is easy to
 * mistake for a rendering bug.
 *
 * This is a whole-registry invariant rather than a per-block assertion, so it
 * catches the next block too, not just `read-page`.
 *
 * `EditForms` is imported statically on purpose: it pulls in all ~55 React
 * forms, and a dynamic `await import()` inside a test body makes that transform
 * cost part of the test's own budget — which blew the 5 s default timeout under
 * full-suite load. At module scope the cost is paid during collection, where no
 * per-test timeout applies.
 */
import { describe, expect, it } from 'vitest'
import { EditForms } from '../src/workflow-editor/blocks/EditForms'
import { PALETTE_BLOCKS } from '../src/lib/workflow/blocks/palette'

/** Blocks the editor is expected to render a dedicated form for. */
const editable = PALETTE_BLOCKS.filter((b) => Boolean(b.editComponent) && !b.disableEdit)

describe('edit form registry', () => {
  it('has blocks to check', () => {
    // Guards the guard: a filter that silently matched nothing would make the
    // real assertion below vacuously true.
    expect(editable.length).toBeGreaterThan(30)
  })

  it('resolves every editable palette block to a registered form', () => {
    const missing = editable
      .filter((b) => typeof EditForms[b.editComponent!] !== 'function')
      .map((b) => `${b.id} → ${b.editComponent}`)

    expect(missing).toEqual([])
  })

  it('registers the read-page form', () => {
    expect(EditForms['EditReadPage']).toBeTypeOf('function')
  })
})
