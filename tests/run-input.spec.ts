/** The chrome-free contract of the runtime parameter dialog. */
import { describe, expect, it } from 'vitest'
import {
  RUN_INPUT_DEFAULT_TIMEOUT_MS,
  RUN_INPUT_MAX_WAIT_MS,
  applyRunInputValues,
  runInputFieldsOf,
  runInputTimeoutOf,
} from '../src/lib/workflow/run-input'
import type { WorkflowParameter } from '../src/lib/workflow/types'

function param(overrides: Partial<WorkflowParameter> & { name: string }): WorkflowParameter {
  return { type: 'string', ...overrides }
}

describe('runInputTimeoutOf', () => {
  it('uses the block default when the field is absent or unusable', () => {
    expect(runInputTimeoutOf(undefined)).toBe(RUN_INPUT_DEFAULT_TIMEOUT_MS)
    expect(runInputTimeoutOf('')).toBe(RUN_INPUT_DEFAULT_TIMEOUT_MS)
    expect(runInputTimeoutOf('abc')).toBe(RUN_INPUT_DEFAULT_TIMEOUT_MS)
    expect(runInputTimeoutOf(-1)).toBe(RUN_INPUT_DEFAULT_TIMEOUT_MS)
  })

  it('keeps a positive value and reads a numeric string', () => {
    expect(runInputTimeoutOf(1500)).toBe(1500)
    expect(runInputTimeoutOf('1500')).toBe(1500)
  })

  it('treats zero as "as long as the worker can stay alive", not infinity', () => {
    expect(runInputTimeoutOf(0)).toBe(RUN_INPUT_MAX_WAIT_MS)
  })

  it('caps longer waits at the worker-lifetime bound', () => {
    expect(runInputTimeoutOf(RUN_INPUT_MAX_WAIT_MS * 4)).toBe(RUN_INPUT_MAX_WAIT_MS)
  })
})

describe('runInputFieldsOf', () => {
  const resolveDefault = (value: string): string => value.replace('{{suffix}}', 'X')

  it('prefills from the scope, then from the interpolated default', () => {
    const fields = runInputFieldsOf(
      [param({ name: 'city' }), param({ name: 'tag', defaultValue: 'v-{{suffix}}' })],
      { city: '上海' },
      resolveDefault,
    )
    expect(fields.map((field) => field.value)).toEqual(['上海', 'v-X'])
  })

  it('renders an object value as JSON text, not [object Object]', () => {
    const [field] = runInputFieldsOf(
      [param({ name: 'config', type: 'json' })],
      { config: { retries: 2 } },
      resolveDefault,
    )
    expect(field!.value).toBe('{\n  "retries": 2\n}')
  })

  it('never sends a secret back but reports whether one is stored', () => {
    const [stored, empty] = runInputFieldsOf(
      [
        param({ name: 'apiKey', secret: true, defaultValue: 'd' }),
        param({ name: 'token', secret: true }),
      ],
      { apiKey: 'real-secret' },
      resolveDefault,
    )
    expect(stored).toMatchObject({ value: '', secret: true, secretStored: true })
    expect(empty).toMatchObject({ value: '', secret: true })
    expect(empty!.secretStored).toBeUndefined()
  })

  it('carries the required flag and the supported field type', () => {
    const [field] = runInputFieldsOf(
      [param({ name: 'limit', type: 'number', data: { required: true } })],
      {},
      resolveDefault,
    )
    expect(field).toMatchObject({ type: 'number', required: true })
  })
})

describe('applyRunInputValues', () => {
  it('coerces each answer by its declared type', () => {
    const variables: Record<string, unknown> = {}
    applyRunInputValues(
      [
        param({ name: 'count', type: 'number' }),
        param({ name: 'config', type: 'json' }),
        param({ name: 'flag', type: 'checkbox' }),
        param({ name: 'label' }),
      ],
      { count: '3', config: '{"a":1}', flag: 'false', label: 'x' },
      variables,
    )
    expect(variables).toEqual({ count: 3, config: { a: 1 }, flag: false, label: 'x' })
  })

  it('treats a blank secret as "keep the stored value"', () => {
    const variables: Record<string, unknown> = { apiKey: 'stored' }
    applyRunInputValues([param({ name: 'apiKey', secret: true })], { apiKey: '' }, variables)
    expect(variables['apiKey']).toBe('stored')
  })

  it('lets a blank non-secret clear the value so the required check catches it', () => {
    const variables: Record<string, unknown> = { keyword: 'old' }
    applyRunInputValues([param({ name: 'keyword' })], { keyword: '' }, variables)
    expect(variables['keyword']).toBe('')
  })

  it('ignores fields the answer did not include', () => {
    const variables: Record<string, unknown> = { kept: 'yes' }
    applyRunInputValues([param({ name: 'kept' })], {}, variables)
    expect(variables['kept']).toBe('yes')
  })
})
