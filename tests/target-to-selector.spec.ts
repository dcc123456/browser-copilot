import { describe, expect, it } from 'vitest'
import {
  resolveRecordedLocator,
  richTargetFromAny,
  richTargetFromArgs,
  selectorFromArgs,
  selectorFromSpec,
  selectorFromTarget,
  withRichTarget,
} from '../src/lib/workflow/target-to-selector'
import type { SnapshotTargetEntry } from '../src/lib/workflow/target-to-selector'

describe('selectorFromSpec', () => {
  it('keeps a css selector trimmed', () => {
    expect(selectorFromSpec({ how: 'css', value: '  .btn  ' })).toBe('.btn')
  })

  it('renders id, name and testid specs', () => {
    expect(selectorFromSpec({ how: 'id', value: 'submit' })).toBe('#submit')
    expect(selectorFromSpec({ how: 'name', value: 'q' })).toBe('[name="q"]')
    expect(selectorFromSpec({ how: 'testid', value: 'row' })).toBe('[data-testid="row"]')
  })

  it('appends an nth-of-type qualifier for repeated matches', () => {
    expect(selectorFromSpec({ how: 'name', value: 'q', nth: 2 })).toBe('[name="q"]:nth-of-type(3)')
    expect(selectorFromSpec({ how: 'tag', value: '', tag: 'li', nth: 0 })).toBe('li')
    // nth 0 is the first match, so no qualifier is emitted.
    expect(selectorFromSpec({ how: 'tag', tag: 'li', nth: 0 })).toBe('li')
    expect(selectorFromSpec({ how: 'tag', tag: 'li', nth: 4 })).toBe('li:nth-of-type(5)')
  })

  it('returns empty for specs CSS cannot express', () => {
    expect(selectorFromSpec({ how: 'role', value: 'button' })).toBe('')
    expect(selectorFromSpec({ how: 'text', value: 'Submit' })).toBe('')
    expect(selectorFromSpec({ how: 'cdp-shadow', value: 'x' })).toBe('')
    expect(selectorFromSpec(undefined)).toBe('')
    expect(selectorFromSpec({ how: 'id', value: '   ' })).toBe('')
  })
})

describe('selectorFromTarget', () => {
  it('prefers the primary spec', () => {
    expect(
      selectorFromTarget({
        primary: { how: 'css', value: '#a' },
        fallbacks: [{ how: 'css', value: '#b' }],
      }),
    ).toBe('#a')
  })

  it('falls back when the primary is not CSS-expressible', () => {
    expect(
      selectorFromTarget({
        primary: { how: 'role', value: 'button' },
        fallbacks: [{ how: 'testid', value: 'save' }],
      }),
    ).toBe('[data-testid="save"]')
  })

  it('returns empty when nothing maps', () => {
    expect(selectorFromTarget({ primary: { how: 'text', value: 'Go' }, fallbacks: [] })).toBe('')
    expect(selectorFromTarget(null)).toBe('')
    expect(selectorFromTarget('nope')).toBe('')
  })
})

describe('selectorFromArgs', () => {
  it('lets an explicit selector win over the rich target', () => {
    expect(
      selectorFromArgs({
        selector: ' .explicit ',
        target: { primary: { how: 'css', value: '#t' } },
      }),
    ).toBe('.explicit')
  })

  it('derives from the target when no explicit selector is present', () => {
    expect(selectorFromArgs({ target: { primary: { how: 'id', value: 'go' } } })).toBe('#go')
  })

  it('tolerates a missing or malformed args bag', () => {
    expect(selectorFromArgs(undefined)).toBe('')
    expect(selectorFromArgs({})).toBe('')
    expect(selectorFromArgs({ selector: '   ' })).toBe('')
  })
})

describe('richTargetFromAny', () => {
  it('passes through a usable locator verbatim', () => {
    const target = { primary: { how: 'role', value: 'button' }, fallbacks: [] }
    expect(richTargetFromAny(target)).toBe(target)
  })

  it('rejects locators the kernel cannot resolve', () => {
    expect(richTargetFromAny(null)).toBeUndefined()
    expect(richTargetFromAny({})).toBeUndefined()
    expect(richTargetFromAny({ primary: {} })).toBeUndefined()
    expect(richTargetFromAny({ primary: { how: 'role' } })).toBeUndefined()
    expect(richTargetFromArgs({ target: 'x' })).toBeUndefined()
  })
})

describe('withRichTarget', () => {
  it('attaches the locator only when there is one', () => {
    expect(withRichTarget({ a: 1 }, undefined)).toEqual({ a: 1 })
    expect(withRichTarget({ a: 1 }, { primary: {} })).toEqual({ a: 1, target: { primary: {} } })
  })
})

describe('resolveRecordedLocator', () => {
  const targets = new Map<string, SnapshotTargetEntry>([
    [
      'e3',
      {
        name: 'Save button',
        target: {
          primary: { how: 'role', value: 'button', role: 'button' },
          fallbacks: [{ how: 'testid', value: 'save' }],
        },
      },
    ],
    [
      'e4',
      {
        name: 'Row 1',
        target: { primary: { how: 'css', value: '#row-1' }, fallbacks: [] },
      },
    ],
  ])

  it('resolves a ref through the snapshot cache, label and all', () => {
    const out = resolveRecordedLocator({ ref: 'e4' }, targets)
    expect(out.selector).toBe('#row-1')
    expect(out.label).toBe('Row 1')
    expect(out.target).toEqual({ primary: { how: 'css', value: '#row-1' }, fallbacks: [] })
  })

  it('derives a replayable selector from a role-based snapshot target', () => {
    const out = resolveRecordedLocator({ ref: 'e3' }, targets)
    // The role spec itself is not CSS-expressible, so the fallback carries it.
    expect(out.selector).toBe('[data-testid="save"]')
    expect(out.label).toBe('Save button')
  })

  it('falls back to the inline target when the ref is unknown', () => {
    const out = resolveRecordedLocator(
      { ref: 'e99', target: { primary: { how: 'id', value: 'fallback' } } },
      targets,
    )
    expect(out.selector).toBe('#fallback')
    expect(out.label).toBeUndefined()
  })

  it('honours an explicit selector over everything else', () => {
    const out = resolveRecordedLocator({ ref: 'e4', selector: '.manual' }, targets)
    expect(out.selector).toBe('.manual')
    // The rich target is still kept for the kernel's fallback chain.
    expect(out.target).toBeDefined()
  })

  it('keeps an inline label when no snapshot entry supplies one', () => {
    const out = resolveRecordedLocator({ selector: '#x', label: 'Submit' })
    expect(out).toEqual({ selector: '#x', label: 'Submit' })
  })

  it('degrades to an empty selector rather than throwing', () => {
    expect(resolveRecordedLocator(undefined)).toEqual({ selector: '' })
    expect(resolveRecordedLocator({ ref: 42 })).toEqual({ selector: '' })
    expect(resolveRecordedLocator({ ref: 'e1' })).toEqual({ selector: '' })
  })
})
