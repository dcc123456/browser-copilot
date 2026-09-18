/**
 * Declared inputs are what make a recorded `{{reference}}` resolve at replay
 * time. Two failures matter most here: seeding an input that has no default
 * (which would disguise "nobody supplied this" as an empty string) and letting
 * a coerced `number` reach an executor as text.
 */
import { describe, expect, it } from 'vitest'
import {
  coerceInputValue,
  isRequiredInput,
  missingRequiredInputs,
  seedFromTrigger,
  seedInputs,
  triggerInputs,
  workflowParametersOf,
} from '../src/lib/workflow/workflow-inputs'

describe('workflowParametersOf', () => {
  it('reads a well-formed declaration list', () => {
    const params = workflowParametersOf([
      { name: 'keyword', type: 'string', defaultValue: 'iPhone' },
      { name: 'limit', type: 'number', defaultValue: '10' },
    ])
    expect(params).toEqual([
      { name: 'keyword', type: 'string', defaultValue: 'iPhone' },
      { name: 'limit', type: 'number', defaultValue: '10' },
    ])
  })

  it('preserves a captured credential input as secret', () => {
    // A chat-typed account/password is persisted as a secret trigger input; the
    // flag must survive the round-trip so the editor can mask it and replay can
    // treat it as a credential.
    const params = workflowParametersOf([
      { name: 'password', type: 'string', defaultValue: 'hunter2', secret: true },
    ])
    expect(params).toEqual([
      { name: 'password', type: 'string', defaultValue: 'hunter2', secret: true },
    ])
  })

  it('does not flag an ordinary input as secret', () => {
    // Only the boolean `true` flags a credential; anything else is ignored.
    const params = workflowParametersOf([{ name: 'keyword', type: 'string', secret: 'yes' }])
    expect(params[0]?.secret).toBeUndefined()
  })

  it('drops entries with no usable name', () => {
    // An entry that cannot be referenced is not an input.
    expect(workflowParametersOf([{ type: 'string' }, { name: '   ' }, 'nope'])).toEqual([])
  })

  it('repairs a missing or unknown type instead of dropping the declaration', () => {
    // Losing the declaration would silently break the references depending on
    // it, which is worse than assuming a string.
    expect(workflowParametersOf([{ name: 'a' }])[0]!.type).toBe('string')
    expect(workflowParametersOf([{ name: 'b', type: 'wat' }])[0]!.type).toBe('string')
  })

  it('returns an empty list for a non-array', () => {
    expect(workflowParametersOf(undefined)).toEqual([])
    expect(workflowParametersOf({ name: 'x' })).toEqual([])
  })
})

describe('coerceInputValue', () => {
  it('turns a numeric default into a number', () => {
    // A string '10' would make any executor doing `+` concatenate.
    expect(coerceInputValue({ name: 'n', type: 'number' }, '10')).toBe(10)
    expect(coerceInputValue({ name: 'n', type: 'number' }, '2.5')).toBe(2.5)
  })

  it('keeps an unparseable number as text rather than NaN', () => {
    expect(coerceInputValue({ name: 'n', type: 'number' }, 'abc')).toBe('abc')
  })

  it('maps a checkbox default to a boolean', () => {
    expect(coerceInputValue({ name: 'c', type: 'checkbox' }, 'true')).toBe(true)
    expect(coerceInputValue({ name: 'c', type: 'checkbox' }, 'false')).toBe(false)
  })

  it('parses a json default, falling back to text', () => {
    expect(coerceInputValue({ name: 'j', type: 'json' }, '{"a":1}')).toEqual({ a: 1 })
    expect(coerceInputValue({ name: 'j', type: 'json' }, 'not json')).toBe('not json')
  })

  it('leaves a string default alone', () => {
    expect(coerceInputValue({ name: 's', type: 'string' }, 'iPhone')).toBe('iPhone')
  })
})

describe('seedInputs', () => {
  it('seeds each declaration from its default', () => {
    expect(
      seedInputs([
        { name: 'keyword', type: 'string', defaultValue: 'iPhone' },
        { name: 'limit', type: 'number', defaultValue: '10' },
      ]),
    ).toEqual({ keyword: 'iPhone', limit: 10 })
  })

  it('does NOT seed a declaration that has no default', () => {
    // Inventing '' here would hide "nobody supplied this value" behind a
    // silently blank field — the exact failure this mechanism exists to remove.
    expect(seedInputs([{ name: 'keyword', type: 'string' }])).toEqual({})
    expect(seedInputs([{ name: 'keyword', type: 'string', defaultValue: '' }])).toEqual({})
  })
})

describe('seedFromTrigger', () => {
  it('reads the declaration off the trigger mirror', () => {
    const trigger = {
      type: 'manual' as const,
      parameters: [{ name: 'city', type: 'string', defaultValue: '北京' }],
    }
    expect(triggerInputs(trigger)).toHaveLength(1)
    expect(seedFromTrigger(trigger, undefined)).toEqual({ city: '北京' })
  })

  it('lets a caller-supplied value win over the declared default', () => {
    // A trigger payload (visit-web query, Feishu argument) is more specific
    // than the default, so it must not be clobbered.
    const trigger = {
      type: 'manual' as const,
      parameters: [{ name: 'city', type: 'string', defaultValue: '北京' }],
    }
    expect(seedFromTrigger(trigger, { city: '上海' })).toEqual({ city: '上海' })
  })

  it('passes an existing scope through untouched when nothing is declared', () => {
    const existing = { loopIndex: 3 }
    expect(seedFromTrigger({ type: 'manual' }, existing)).toBe(existing)
    expect(seedFromTrigger(undefined, undefined)).toEqual({})
  })

  it('keeps a value the trigger does not declare', () => {
    const trigger = {
      type: 'manual' as const,
      parameters: [{ name: 'city', type: 'string', defaultValue: '北京' }],
    }
    expect(seedFromTrigger(trigger, { fromCaller: 'x' })).toEqual({
      city: '北京',
      fromCaller: 'x',
    })
  })
})

describe('missingRequiredInputs', () => {
  it('reports a required input with no value', () => {
    const params = [{ name: 'keyword', type: 'string', data: { required: true } }]
    expect(missingRequiredInputs(params, {})).toEqual(['keyword'])
    expect(missingRequiredInputs(params, { keyword: '' })).toEqual(['keyword'])
    expect(missingRequiredInputs(params, { keyword: 'iPhone' })).toEqual([])
  })

  it('treats an absent required flag as optional', () => {
    expect(missingRequiredInputs([{ name: 'x', type: 'string' }], {})).toEqual([])
    expect(isRequiredInput({ name: 'x', type: 'string' })).toBe(false)
  })

  it('accepts 0 and false as real values', () => {
    // Falsy is not missing: a limit of 0 and an unchecked box are answers.
    const params = [
      { name: 'limit', type: 'number', data: { required: true } },
      { name: 'flag', type: 'checkbox', data: { required: true } },
    ]
    expect(missingRequiredInputs(params, { limit: 0, flag: false })).toEqual([])
  })
})
