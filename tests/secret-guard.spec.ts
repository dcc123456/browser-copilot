import { describe, expect, it } from 'vitest'
import {
  EMPTY_SECRET_INDEX,
  buildSecretIndex,
  credentialFillPath,
  isCredentialFieldType,
  isInterpolationReference,
  redactRecordedParams,
} from '../src/lib/workflow/secret-guard'

const CREDENTIAL = 'correct-horse-battery'

/**
 * The rule: the model may learn a credential's NAME, never its value. These
 * tests pin the three ways a value could escape — into the recorded graph,
 * into a password field as a literal, or into a string that merely contains it.
 */
describe('secret index', () => {
  it('maps a secret literal to its reference', () => {
    const index = buildSecretIndex({ password: CREDENTIAL }, new Set(['password']))
    expect(index.byValue.get(CREDENTIAL)).toBe('{{password}}')
  })

  it('ignores variables that are not marked as credentials', () => {
    const index = buildSecretIndex({ city: 'Berlin' }, new Set())
    expect(index.byValue.size).toBe(0)
  })

  it('ignores a marked key that holds nothing', () => {
    const index = buildSecretIndex({ password: '' }, new Set(['password']))
    expect(index.byValue.size).toBe(0)
  })

  it('indexes nested shapes, not just plain strings', () => {
    const index = buildSecretIndex({ password: { value: CREDENTIAL } }, new Set(['password']))
    expect(index.byValue.get(CREDENTIAL)).toBe('{{password}}')
  })

  it('keeps the first variable when two hold the same secret', () => {
    const index = buildSecretIndex(
      { first: CREDENTIAL, second: CREDENTIAL },
      new Set(['first', 'second']),
    )
    expect(index.byValue.get(CREDENTIAL)).toBe('{{first}}')
  })
})

describe('redactRecordedParams', () => {
  const index = buildSecretIndex({ password: CREDENTIAL }, new Set(['password']))

  it('replaces an exact literal with the reference', () => {
    const out = redactRecordedParams({ selector: '#pw', value: CREDENTIAL }, index)
    expect(out.redacted).toBe(true)
    expect(out.data.value).toBe('{{password}}')
    expect(out.data.selector).toBe('#pw')
  })

  it('replaces a secret embedded in a longer string', () => {
    const out = redactRecordedParams({ header: `Bearer ${CREDENTIAL}` }, index)
    expect(out.redacted).toBe(true)
    expect(out.data.header).toBe('Bearer {{password}}')
  })

  it('replaces a secret nested inside an object or array', () => {
    const out = redactRecordedParams(
      { rows: [{ value: CREDENTIAL }], note: ['x', CREDENTIAL] },
      index,
    )
    expect(out.redacted).toBe(true)
    expect(out.data.rows).toEqual([{ value: '{{password}}' }])
    expect(out.data.note).toEqual(['x', '{{password}}'])
  })

  it('leaves a reference untouched and reports nothing redacted', () => {
    const data = { value: '{{password}}' }
    const out = redactRecordedParams(data, index)
    expect(out.redacted).toBe(false)
    // Same object: the common path must not allocate.
    expect(out.data).toBe(data)
  })

  it('is a no-op with an empty index', () => {
    const data = { value: CREDENTIAL }
    const out = redactRecordedParams(data, EMPTY_SECRET_INDEX)
    expect(out.redacted).toBe(false)
    expect(out.data).toBe(data)
  })

  it('does not touch a short secret as a substring', () => {
    // Substring replacement has a length floor so a 3-char password cannot
    // shred unrelated parameters; the exact match still fires.
    const short = buildSecretIndex({ pin: 'abc' }, new Set(['pin']))
    const out = redactRecordedParams({ label: 'abcdef' }, short)
    expect(out.redacted).toBe(false)
    expect(out.data.label).toBe('abcdef')

    const exact = redactRecordedParams({ label: 'abc' }, short)
    expect(exact.redacted).toBe(true)
    expect(exact.data.label).toBe('{{pin}}')
  })
})

describe('credentialFillPath', () => {
  it('captures a literal aimed at a password field', () => {
    expect(
      credentialFillPath({
        blockId: 'forms',
        data: { value: CREDENTIAL },
        targetType: 'password',
      }),
    ).toEqual(['value'])
  })

  it('ignores a reference aimed at a password field', () => {
    // A `{{reference}}` is already safe to record — nothing to capture.
    expect(
      credentialFillPath({
        blockId: 'forms',
        data: { value: '{{password}}' },
        targetType: 'password',
      }),
    ).toBeNull()
  })

  it('ignores a literal aimed at an ordinary field', () => {
    expect(
      credentialFillPath({
        blockId: 'forms',
        data: { value: 'Ada Lovelace' },
        targetType: 'text',
      }),
    ).toBeNull()
  })

  it('ignores a literal when the target type is unknown', () => {
    // A hand-written `selector` carries no snapshot metadata, and guessing
    // here would wrongly freeze ordinary form data.
    expect(
      credentialFillPath({ blockId: 'forms', data: { value: 'Ada' }, targetType: undefined }),
    ).toBeNull()
  })

  it('ignores an empty value', () => {
    expect(
      credentialFillPath({ blockId: 'forms', data: { value: '' }, targetType: 'password' }),
    ).toBeNull()
  })

  it('only polices blocks that write a value into the page', () => {
    expect(
      credentialFillPath({
        blockId: 'get-text',
        data: { value: CREDENTIAL },
        targetType: 'password',
      }),
    ).toBeNull()
  })
})

describe('helpers', () => {
  it('recognises interpolation references', () => {
    expect(isInterpolationReference('{{password}}')).toBe(true)
    expect(isInterpolationReference('Bearer {{token}}')).toBe(true)
    expect(isInterpolationReference('literal')).toBe(false)
    expect(isInterpolationReference('{not-a-ref}')).toBe(false)
  })

  it('recognises credential field types', () => {
    expect(isCredentialFieldType('password')).toBe(true)
    expect(isCredentialFieldType('PASSWORD')).toBe(true)
    expect(isCredentialFieldType(' password ')).toBe(true)
    expect(isCredentialFieldType('text')).toBe(false)
    expect(isCredentialFieldType(undefined)).toBe(false)
  })
})
