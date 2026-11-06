/** Dialog-side validation of a parameter-prompt answer. */
import { describe, expect, it } from 'vitest'
import { validateRunInput } from '../src/ui/RunInputDialog'
import type { RunInputField } from '../src/lib/workflow/run-input'

const labels = {
  requiredField: (name: string): string => `"${name}" is required.`,
  invalidJson: 'Enter valid JSON.',
}

function field(overrides: Partial<RunInputField> & { name: string }): RunInputField {
  return { type: 'string', value: '', required: false, ...overrides }
}

describe('validateRunInput', () => {
  it('accepts a filled form', () => {
    expect(
      validateRunInput([field({ name: 'city', required: true })], { city: '上海' }, labels),
    ).toEqual({})
  })

  it('reports a blank required field', () => {
    expect(
      validateRunInput([field({ name: 'city', required: true })], { city: '' }, labels),
    ).toEqual({ city: '"city" is required.' })
  })

  it('treats whitespace as blank', () => {
    expect(
      validateRunInput([field({ name: 'city', required: true })], { city: '   ' }, labels),
    ).toEqual({ city: '"city" is required.' })
  })

  it('accepts a blank required secret that already has a stored value', () => {
    expect(
      validateRunInput(
        [field({ name: 'apiKey', required: true, secret: true, secretStored: true })],
        { apiKey: '' },
        labels,
      ),
    ).toEqual({})
  })

  it('reports a blank required secret with nothing stored', () => {
    expect(
      validateRunInput(
        [field({ name: 'apiKey', required: true, secret: true })],
        { apiKey: '' },
        labels,
      ),
    ).toEqual({ apiKey: '"apiKey" is required.' })
  })

  it('rejects malformed JSON and accepts valid JSON', () => {
    const json = field({ name: 'config', type: 'json' })
    expect(validateRunInput([json], { config: '{oops' }, labels)).toEqual({
      config: 'Enter valid JSON.',
    })
    expect(validateRunInput([json], { config: '{"a":1}' }, labels)).toEqual({})
  })

  it('lets an optional JSON field stay blank', () => {
    expect(
      validateRunInput([field({ name: 'config', type: 'json' })], { config: '' }, labels),
    ).toEqual({})
  })
})
