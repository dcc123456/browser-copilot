/**
 * Batched form ops in the injection kernel (`form_fields`, `fill_form`,
 * `verify_fields`).
 *
 * The whole point of the batch is that one injection covers every field, so
 * these tests assert what ONE `runOp` call reports — including the per-field
 * verdicts, because a batch that fails three fields must name exactly those
 * three instead of failing the call.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type {
  FieldCheck,
  FormFieldEntry,
  FormFillField,
  FormFillOutcome,
  FieldVerdict,
  Op,
  OpResult,
  Target,
} from '../src/lib/ops'

let dom: JSDOM

function cssTarget(selector: string): Target {
  return { primary: { how: 'css', value: selector }, fallbacks: [] }
}

function makePage(html: string): void {
  dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, {
    url: 'https://forms.test/signup',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLInputElement = dom.window.HTMLInputElement
  g.HTMLButtonElement = dom.window.HTMLButtonElement
  g.HTMLAnchorElement = dom.window.HTMLAnchorElement
  g.HTMLSelectElement = dom.window.HTMLSelectElement
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  g.HTMLFormElement = dom.window.HTMLElement
  g.ShadowRoot = dom.window.ShadowRoot
  g.DocumentFragment = dom.window.DocumentFragment
  g.MouseEvent = dom.window.MouseEvent
  g.PointerEvent = dom.window.PointerEvent
  g.Event = dom.window.Event
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.InputEvent = dom.window.InputEvent
  g.CustomEvent = dom.window.CustomEvent
  g.Node = dom.window.Node
  g.Element = dom.window.Element
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
}

const FORM = `
  <label for="name">Name</label><input id="name" type="text" value="Ada">
  <label for="bio">Bio</label><textarea id="bio"></textarea>
  <label for="plan">Plan</label>
  <select id="plan"><option value="">Choose</option><option value="pro">Pro</option></select>
  <label for="agree">Agree</label><input id="agree" type="checkbox">
  <label for="pw">Password</label><input id="pw" type="password" value="hunter2">
  <input id="token" type="hidden" value="abc">
  <input id="send" type="submit" value="Submit">
  <input id="gone" type="text" style="display:none">
`

function fieldsOf(result: OpResult): FormFieldEntry[] {
  return (result.data as { fields: FormFieldEntry[] }).fields
}

function resultsOf<T>(result: OpResult): T[] {
  return (result.data as { results: T[] }).results
}

beforeEach(() => {
  makePage(FORM)
})

describe('kernel form_fields', () => {
  it('lists every fillable control with its ref, label and current value', async () => {
    const result = (await runOp({ action: 'form_fields' } as Op)) as unknown as OpResult
    expect(result.ok).toBe(true)
    const fields = fieldsOf(result)
    const byLabel = new Map(fields.map((field) => [field.label, field]))
    expect(byLabel.get('Name')?.value).toBe('Ada')
    expect(byLabel.get('Name')?.type).toBe('text')
    expect(byLabel.get('Plan')?.options).toEqual(['Choose', 'Pro'])
    expect(byLabel.get('Agree')?.value).toBe(false)
    expect(byLabel.get('Bio')?.tag).toBe('textarea')
    // Every entry is addressable: the ref is what the model passes back, the
    // target is what the kernel resolves it to.
    expect(fields.map((field) => field.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
    expect(fields.every((field) => field.target.primary.value.length > 0)).toBe(true)
  })

  it('never returns a password value, a hidden input, a submit button or an invisible control', async () => {
    const listed = (await runOp({ action: 'form_fields' } as Op)) as unknown as OpResult
    const fields = fieldsOf(listed)
    const password = fields.find((field) => field.type === 'password')
    expect(password?.value).toBeUndefined()
    const labels = fields.map((field) => field.label)
    expect(fields.length).toBe(5)
    expect(labels).toEqual(['Name', 'Bio', 'Plan', 'Agree', 'Password'])
    expect(JSON.stringify(fields)).not.toMatch(/token|send|gone/)
    expect(fields.every((field) => field.type !== 'submit' && field.type !== 'hidden')).toBe(true)

    // The password is still verifiable — the comparison happens in the page.
    const verified = (await runOp({
      action: 'verify_fields',
      checks: [{ target: cssTarget('#pw'), value: 'hunter2' }] as FieldCheck[],
    } as Op)) as unknown as OpResult
    expect(resultsOf<FieldVerdict>(verified)[0]?.ok).toBe(true)
    expect(JSON.stringify(verified.data)).not.toContain('hunter2')
  })

  it('finds controls in a div-based form, where snapshot forms[] would see none', async () => {
    makePage(`<div class="form"><input id="q" aria-label="Query"></div>`)
    const result = (await runOp({ action: 'form_fields' } as Op)) as unknown as OpResult
    expect(fieldsOf(result)[0]?.label).toBe('Query')
  })

  it('says so when the frame holds nothing fillable', async () => {
    makePage(`<p>No controls here.</p>`)
    const result = (await runOp({ action: 'form_fields' } as Op)) as unknown as OpResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No visible form controls')
  })
})

describe('kernel fill_form', () => {
  function fillOp(fields: FormFillField[]): Op {
    return { action: 'fill_form', fields } as Op
  }

  it('writes text, a select by visible label and a checkbox in one injection', async () => {
    const result = (await runOp(
      fillOp([
        { target: cssTarget('#name'), value: 'Grace Hopper' },
        { target: cssTarget('#bio'), value: 'navy  coder' },
        { target: cssTarget('#plan'), value: 'Pro' },
        { target: cssTarget('#agree'), value: true },
      ]),
    )) as unknown as OpResult
    const outcomes = resultsOf<FormFillOutcome>(result)
    expect(result.ok).toBe(true)
    expect(result.note).toBe('4/4 fields written')
    expect(outcomes.map((entry) => entry.kind)).toEqual(['text', 'text', 'select', 'checkbox'])
    const doc = dom.window.document
    expect((doc.getElementById('name') as HTMLInputElement).value).toBe('Grace Hopper')
    expect((doc.getElementById('plan') as HTMLSelectElement).value).toBe('pro')
    expect((doc.getElementById('agree') as HTMLInputElement).checked).toBe(true)
    // Whitespace in a textarea round-trips through the page's own normalization.
    expect((doc.getElementById('bio') as HTMLTextAreaElement).value).toBe('navy  coder')
  })

  it('reports a failed field without failing the fields around it', async () => {
    const result = (await runOp(
      fillOp([
        { target: cssTarget('#name'), value: 'first' },
        { target: cssTarget('#missing'), value: 'second' },
        { target: cssTarget('#plan'), value: 'Enterprise' },
      ]),
    )) as unknown as OpResult
    const outcomes = resultsOf<FormFillOutcome>(result)
    expect(result.ok).toBe(false)
    expect(result.note).toBe('1/3 fields written')
    expect(outcomes[0]?.ok).toBe(true)
    expect(outcomes[1]?.ok).toBe(false)
    expect(outcomes[1]?.found).toBe(false)
    expect(outcomes[2]?.ok).toBe(false)
    expect(outcomes[2]?.error).toContain('No option matched')
  })

  it('refuses a rich-text editor and names the single-field tool', async () => {
    makePage(`<div id="editor" contenteditable="true"></div><input id="name">`)
    const result = (await runOp(
      fillOp([{ target: cssTarget('#editor'), value: 'prose' }]),
    )) as unknown as OpResult
    const outcome = resultsOf<FormFillOutcome>(result)[0]
    expect(outcome?.ok).toBe(false)
    expect(outcome?.error).toContain('rich-text editor')
    expect(outcome?.error).toContain('fill')
  })

  it('writes a password field but reports it as a text field', async () => {
    const result = (await runOp(
      fillOp([{ target: cssTarget('#pw'), value: 'new secret' }]),
    )) as unknown as OpResult
    expect(resultsOf<FormFillOutcome>(result)[0]?.kind).toBe('text')
    expect((dom.window.document.getElementById('pw') as HTMLInputElement).value).toBe('new secret')
  })
})

describe('kernel verify_fields', () => {
  function checkOp(checks: FieldCheck[]): Op {
    return { action: 'verify_fields', checks } as Op
  }

  it('compares text after whitespace collapsing', async () => {
    ;(dom.window.document.getElementById('name') as HTMLInputElement).value = '  Ada   Lovelace '
    const result = (await runOp(
      checkOp([{ target: cssTarget('#name'), value: 'Ada Lovelace' }]),
    )) as unknown as OpResult
    expect(resultsOf<FieldVerdict>(result)[0]?.ok).toBe(true)
  })

  it('accepts a select by stored value or by visible label', async () => {
    const select = dom.window.document.getElementById('plan') as HTMLSelectElement
    select.value = 'pro'
    const byValue = (await runOp(
      checkOp([{ target: cssTarget('#plan'), value: 'pro' }]),
    )) as unknown as OpResult
    const byLabel = (await runOp(
      checkOp([{ target: cssTarget('#plan'), value: 'Pro' }]),
    )) as unknown as OpResult
    expect(resultsOf<FieldVerdict>(byValue)[0]?.ok).toBe(true)
    expect(resultsOf<FieldVerdict>(byLabel)[0]?.ok).toBe(true)
  })

  it('names expected and actual for a field the page did not keep', async () => {
    const result = (await runOp(
      checkOp([{ target: cssTarget('#name'), value: 'Grace' }]),
    )) as unknown as OpResult
    const verdict = resultsOf<FieldVerdict>(result)[0]
    expect(result.ok).toBe(false)
    expect(result.note).toBe('0/1 fields verified')
    expect(verdict?.ok).toBe(false)
    expect(verdict?.expected).toBe('Grace')
    expect(verdict?.actual).toBe('Ada')
  })

  it('keeps a password inside the page: verdict only, never the value', async () => {
    const result = (await runOp(
      checkOp([
        { target: cssTarget('#pw'), value: 'hunter2' },
        { target: cssTarget('#pw'), value: 'wrong' },
      ]),
    )) as unknown as OpResult
    const verdicts = resultsOf<FieldVerdict>(result)
    expect(verdicts[0]?.ok).toBe(true)
    expect(verdicts[1]?.ok).toBe(false)
    expect(verdicts[1]?.secret).toBe(true)
    expect(verdicts[1]?.expected).toBe('5 chars (hidden)')
    expect(verdicts[1]?.actual).toBe('7 chars (hidden)')
    expect(JSON.stringify(result.data)).not.toContain('wrong')
  })

  it('compares a checkbox by its checked state', async () => {
    const result = (await runOp(
      checkOp([{ target: cssTarget('#agree'), value: true }]),
    )) as unknown as OpResult
    expect(resultsOf<FieldVerdict>(result)[0]?.ok).toBe(false)
    ;(dom.window.document.getElementById('agree') as HTMLInputElement).click()
    const after = (await runOp(
      checkOp([{ target: cssTarget('#agree'), value: true }]),
    )) as unknown as OpResult
    expect(resultsOf<FieldVerdict>(after)[0]?.ok).toBe(true)
  })
})
