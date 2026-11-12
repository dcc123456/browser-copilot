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

/** The two bulk writes, so a case reads as its field list rather than as glue. */
function fillOp(fields: FormFillField[]): Op {
  return { action: 'fill_form', fields } as unknown as Op
}

function checkOp(checks: FieldCheck[]): Op {
  return { action: 'verify_fields', checks } as unknown as Op
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

/**
 * The checkable half of a mixed form. A checkbox or radio has no text to write,
 * so the only question is what a value MEANS — and a silent `false` is the
 * dangerous answer: it unchecks a field the read-back then agrees with.
 */
const CHECKABLES = `
  <label for="nick">Nickname</label><input id="nick" type="text">
  <label for="tastes">Tastes</label>
  <select id="tastes" multiple><option value="tea">Tea</option><option value="sake">Sake</option></select>
  <label for="agree">Agree</label><input id="agree" type="checkbox">
  <label for="g_m">Male</label><input id="g_m" name="gender" type="radio" value="male">
  <label for="g_f">Female</label><input id="g_f" name="gender" type="radio" value="female">
  <label for="locked">VIP</label><input id="locked" type="text" value="readonly" disabled>
`

describe('kernel batch writes on checkboxes and radios', () => {
  beforeEach(() => {
    makePage(CHECKABLES)
  })

  const isChecked = (id: string) =>
    (dom.window.document.getElementById(id) as HTMLInputElement).checked

  it('lists each radio of a group and marks the multi-select', async () => {
    const result = (await runOp({ action: 'form_fields' } as Op)) as unknown as OpResult
    const byLabel = new Map(fieldsOf(result).map((field) => [field.label, field]))
    expect(byLabel.get('Male')?.type).toBe('radio')
    expect(byLabel.get('Female')?.type).toBe('radio')
    // Without the flag a multi-select is indistinguishable from a single one.
    expect(byLabel.get('Tastes')?.multiple).toBe(true)
    expect(byLabel.get('Tastes')?.options).toEqual(['Tea', 'Sake'])
  })

  it('selects one radio of a group and keeps the group exclusive', async () => {
    const written = (await runOp(
      fillOp([{ target: cssTarget('#g_m'), value: true }]),
    )) as unknown as OpResult
    expect(resultsOf<FormFillOutcome>(written)[0]?.kind).toBe('radio')
    expect(isChecked('g_m')).toBe(true)

    const flipped = (await runOp(
      fillOp([{ target: cssTarget('#g_f'), value: true }]),
    )) as unknown as OpResult
    expect(resultsOf<FormFillOutcome>(flipped)[0]?.ok).toBe(true)
    expect(isChecked('g_f')).toBe(true)
    expect(isChecked('g_m')).toBe(false)

    const verified = (await runOp(
      checkOp([
        { target: cssTarget('#g_f'), value: true },
        { target: cssTarget('#g_m'), value: false },
      ]),
    )) as unknown as OpResult
    expect(verified.note).toBe('2/2 fields verified')
  })

  it('takes the option text a caller mirrored from the field list', async () => {
    // `form_fields` shows a radio's own value/label, so a model repeating it is
    // naming THIS control — the ref already says which option.
    const written = (await runOp(
      fillOp([
        { target: cssTarget('#g_m'), value: 'male' },
        { target: cssTarget('#agree'), value: true },
      ]),
    )) as unknown as OpResult
    expect(written.note).toBe('2/2 fields written')
    expect(isChecked('g_m')).toBe(true)
    const byLabel = (await runOp(
      checkOp([{ target: cssTarget('#g_f'), value: 'Female' }]),
    )) as unknown as OpResult
    expect(resultsOf<FieldVerdict>(byLabel)[0]?.ok).toBe(false)
  })

  it('refuses a value that names neither true nor this control', async () => {
    const written = (await runOp(
      fillOp([
        { target: cssTarget('#nick'), value: 'Ada' },
        // the OTHER radio's value: a guess about which option the caller wanted
        { target: cssTarget('#g_f'), value: 'male' },
        // "yes" is not a checked state
        { target: cssTarget('#agree'), value: 'yes' },
      ]),
    )) as unknown as OpResult
    const outcomes = resultsOf<FormFillOutcome>(written)
    expect(written.note).toBe('1/3 fields written')
    expect(outcomes[0]?.ok).toBe(true)
    expect(outcomes[1]?.ok).toBe(false)
    expect(outcomes[1]?.error).toContain('chosen by its ref')
    expect(outcomes[2]?.ok).toBe(false)
    expect(outcomes[2]?.error).toContain('true or false')
    // Nothing was touched behind the refusal.
    expect(isChecked('g_f')).toBe(false)
    expect(isChecked('agree')).toBe(false)
  })

  it('never verifies a value the writer would refuse', async () => {
    const verified = (await runOp(
      checkOp([{ target: cssTarget('#agree'), value: 'yes' }]),
    )) as unknown as OpResult
    expect(resultsOf<FieldVerdict>(verified)[0]?.ok).toBe(false)
  })

  it('refuses a disabled control instead of reporting it filled', async () => {
    // A disabled field is never submitted, so writing it would be a field the
    // model believes is done and the server never receives.
    const written = (await runOp(
      fillOp([
        { target: cssTarget('#locked'), value: 'hacked' },
        { target: cssTarget('#nick'), value: 'Ada' },
      ]),
    )) as unknown as OpResult
    const outcomes = resultsOf<FormFillOutcome>(written)
    expect(outcomes[0]?.ok).toBe(false)
    expect(outcomes[0]?.error).toContain('disabled')
    expect(outcomes[1]?.ok).toBe(true)
    expect((dom.window.document.getElementById('locked') as HTMLInputElement).value).toBe(
      'readonly',
    )
  })

  it('means the same thing as a single-field set_checkbox', async () => {
    const lone = (await runOp({
      action: 'set_checkbox',
      target: cssTarget('#g_m'),
      value: 'male',
    } as unknown as Op)) as unknown as OpResult
    expect(lone.ok).toBe(true)
    expect(isChecked('g_m')).toBe(true)

    const guessed = (await runOp({
      action: 'set_checkbox',
      target: cssTarget('#agree'),
      value: 'yes',
    } as unknown as Op)) as unknown as OpResult
    expect(guessed.ok).toBe(false)
    expect(guessed.error).toContain('true or false')
    expect(isChecked('agree')).toBe(false)
  })
})
