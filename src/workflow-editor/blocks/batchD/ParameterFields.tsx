/**
 * ParameterFields — React port of Automa's EditWorkflowParameters.vue.
 *
 * Table layout matching Automa: a Name / Type / Placeholder / Default Value
 * header over a grid row per parameter, an "Options" fold-out per row
 * (description + required flag) and a footer with an accent "Add parameter"
 * button plus the optional "prefer asking parameters in the active tab"
 * checkbox (rendered when `onPreferTab` is provided — the trigger block wires
 * it to `preferParamsInTab`).
 *
 * Used by the "Trigger" block (inside a modal, Automa-style) and the
 * "Parameter prompt" block (inline; the grid collapses to two columns there).
 *
 * @module workflow-editor/blocks/batchD/ParameterFields
 */

import { Checkbox, Expand, Select, TextArea, TextInput } from '../shared/Field'
import { useEditorLocale } from '../../locale-context'

export interface WorkflowParameter {
  id?: string
  name: string
  type: string
  description?: string
  defaultValue?: string
  placeholder?: string
  data?: { required?: boolean; [key: string]: unknown }
}

const PARAM_TYPES = [
  { value: 'string', label: 'Input (string)' },
  { value: 'number', label: 'Input (number)' },
  { value: 'json', label: 'Input (JSON)' },
  { value: 'checkbox', label: 'Checkbox' },
]

let counter = 0
function newId(): string {
  counter += 1
  return `param-${Date.now()}-${counter}`
}

function asParameters(value: unknown): WorkflowParameter[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({
      id: typeof p.id === 'string' ? p.id : newId(),
      name: typeof p.name === 'string' ? p.name : 'param',
      type: typeof p.type === 'string' ? p.type : 'string',
      description: typeof p.description === 'string' ? p.description : '',
      defaultValue: typeof p.defaultValue === 'string' ? p.defaultValue : '',
      placeholder: typeof p.placeholder === 'string' ? p.placeholder : 'Text',
      data:
        typeof p.data === 'object' && p.data !== null
          ? (p.data as WorkflowParameter['data'])
          : { required: false },
    }))
}

export default function ParameterFields({
  value,
  onChange,
  preferTab,
  onPreferTab,
}: {
  value: unknown
  onChange: (parameters: WorkflowParameter[]) => void
  /** Show the "prefer asking parameters in the active tab" checkbox (trigger). */
  preferTab?: boolean
  onPreferTab?: (v: boolean) => void
}) {
  const { bt } = useEditorLocale()
  const parameters = asParameters(value)

  const update = (index: number, patch: Partial<WorkflowParameter>) => {
    onChange(parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }
  const add = () =>
    onChange([
      ...parameters,
      {
        id: newId(),
        name: 'param',
        type: 'string',
        description: '',
        defaultValue: '',
        placeholder: 'Text',
        data: { required: false },
      },
    ])
  const remove = (index: number) => onChange(parameters.filter((_, i) => i !== index))

  return (
    <div className="wf-params">
      <div className="wf-params-scroll">
        {parameters.length === 0 ? (
          <p className="wf-params-empty">{bt('No parameters')}</p>
        ) : (
          <section>
            <div className="wf-params-head">
              <span>{bt('Name')}</span>
              <span>{bt('Type')}</span>
              <span>{bt('Placeholder')}</span>
              <span>{bt('Default Value')}</span>
              <span />
            </div>
            {parameters.map((param, index) => (
              <div className="wf-param" key={param.id ?? index}>
                <div className="wf-param-row">
                  <TextInput
                    value={param.name}
                    placeholder={bt('Parameter name')}
                    onChange={(v) => update(index, { name: v.replace(/\s/g, '_') })}
                  />
                  <Select
                    value={param.type}
                    onChange={(v) => update(index, { type: v })}
                    options={PARAM_TYPES}
                  />
                  <TextInput
                    value={param.placeholder ?? ''}
                    placeholder={bt('A parameter')}
                    onChange={(v) => update(index, { placeholder: v })}
                  />
                  <TextInput
                    type={param.type === 'number' ? 'number' : 'text'}
                    value={param.defaultValue ?? ''}
                    placeholder="NULL"
                    onChange={(v) => update(index, { defaultValue: v })}
                  />
                  <button
                    type="button"
                    className="wf-icon-btn wf-param-delete"
                    title={bt('Remove parameter')}
                    onClick={() => remove(index)}
                  >
                    <i className="ri-delete-bin-7-line" />
                  </button>
                </div>
                <Expand title="Options">
                  <div className="wf-param-options">
                    <TextArea
                      value={param.description ?? ''}
                      placeholder="Description"
                      onChange={(v) => update(index, { description: v })}
                    />
                    {(param.type === 'string' || param.type === 'number') && (
                      <Checkbox
                        checked={param.data?.required === true}
                        onChange={(v) => update(index, { data: { ...(param.data ?? {}), required: v } })}
                        label="Parameter required"
                      />
                    )}
                  </div>
                </Expand>
              </div>
            ))}
          </section>
        )}
      </div>
      <div className="wf-params-footer">
        <button type="button" className="wf-params-add" onClick={add}>
          <i className="ri-add-line" />
          <span>{bt('Add parameter')}</span>
        </button>
        <span className="wf-params-footer-grow" />
        {onPreferTab && (
          <Checkbox
            checked={preferTab === true}
            onChange={onPreferTab}
            label="Prefer asking parameters in the active tab"
          />
        )}
      </div>
    </div>
  )
}
