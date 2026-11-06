/**
 * The panel-side parameter editor: what reaches `Workflow.parameterValues`.
 *
 * The dialog itself is presentational, so the two rules that matter are pure:
 * which form field a declaration becomes, and which edits are persisted. A
 * secret must never be written, and a value left over from a removed parameter
 * must not stay in the (exported) workflow definition.
 */
import { describe, expect, it } from 'vitest'
import { declaredParameterValues, parameterFieldsOf } from '../src/ui/WorkflowParametersDialog'
import type { WorkflowParameter } from '../src/lib/workflow/types'

function param(overrides: Partial<WorkflowParameter> & { name: string }): WorkflowParameter {
  return { type: 'string', ...overrides }
}

describe('parameterFieldsOf', () => {
  it('builds one field per declaration with its saved value', () => {
    expect(
      parameterFieldsOf(
        [param({ name: 'city', placeholder: 'City' }), param({ name: 'limit', type: 'number' })],
        { city: '上海' },
      ),
    ).toEqual([
      { name: 'city', type: 'string', placeholder: 'City', value: '上海', required: false },
      { name: 'limit', type: 'number', value: '', required: false },
    ])
  })

  it('repairs an unknown type to string', () => {
    // The same repair `workflowParametersOf` makes, so an imported graph's odd
    // type still renders an editable text input.
    expect(parameterFieldsOf([param({ name: 'x', type: 'wat' })], {})[0]!.type).toBe('string')
  })

  it('is never required', () => {
    // A blank field in the panel means "ask me at run time", not an error.
    const required = param({ name: 'x', data: { required: true } })
    expect(parameterFieldsOf([required], {})[0]!.required).toBe(false)
  })
})

describe('declaredParameterValues', () => {
  it('keeps declared, non-empty, non-secret values', () => {
    expect(
      declaredParameterValues(
        [
          param({ name: 'city' }),
          param({ name: 'limit', type: 'number' }),
          param({ name: 'apiKey', secret: true }),
        ],
        { city: '上海', limit: '', apiKey: 'token' },
      ),
    ).toEqual({ city: '上海' })
  })

  it('drops a value whose declaration is gone', () => {
    // It would otherwise travel with every export of the workflow.
    expect(
      declaredParameterValues([param({ name: 'city' })], { city: '上海', removed: 'x' }),
    ).toEqual({ city: '上海' })
  })

  it('returns nothing for an empty draft', () => {
    expect(declaredParameterValues([param({ name: 'city' })], {})).toEqual({})
  })
})
