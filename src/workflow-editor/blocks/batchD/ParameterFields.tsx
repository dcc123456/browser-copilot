/**
 * ParameterFields — React port of the shared parts of Automa's
 * EditWorkflowParameters.vue used by the "Parameter prompt" and "Trigger"
 * blocks. Both blocks store a `parameters` array; each entry has a name,
 * type, placeholder, default value, description and a required flag. The Vue
 * editor offers many parameter types (with custom value components); this
 * port keeps the core types the block runtime understands.
 *
 * @module workflow-editor/blocks/batchD/ParameterFields
 */

import { Checkbox, Select, TextArea, TextInput } from '../shared/Field'

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
}: {
  value: unknown
  onChange: (parameters: WorkflowParameter[]) => void
}) {
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
      {parameters.length === 0 && <p className="wf-empty">No parameters</p>}
      {parameters.map((param, index) => (
        <div className="wf-param" key={param.id ?? index}>
          <div className="wf-param-row">
            <TextInput
              value={param.name}
              placeholder="Parameter name"
              onChange={(v) => update(index, { name: v.replace(/\s/g, '_') })}
            />
            <Select
              value={param.type}
              onChange={(v) => update(index, { type: v })}
              options={PARAM_TYPES}
            />
            <TextInput
              value={param.placeholder ?? ''}
              placeholder="A parameter"
              onChange={(v) => update(index, { placeholder: v })}
            />
            <TextInput
              type={param.type === 'number' ? 'number' : 'text'}
              value={param.defaultValue ?? ''}
              placeholder="NULL"
              onChange={(v) => update(index, { defaultValue: v })}
            />
            <button type="button" className="wf-icon-btn" title="Remove parameter" onClick={() => remove(index)}>
              <i className="ri-delete-bin-7-line" />
            </button>
          </div>
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
        </div>
      ))}
      <button type="button" className="wf-btn" onClick={add}>
        Add parameter
      </button>
    </div>
  )
}
