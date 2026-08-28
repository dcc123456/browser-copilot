/**
 * EditParameterPrompt — React port of Automa's EditParameterPrompt.vue.
 *
 * Prompts the user for parameters before the workflow runs. Holds a timeout
 * and a `parameters` list edited inline (Automa opens a modal; the React editor
 * uses a fold-out).
 *
 * @module workflow-editor/blocks/batchD/EditParameterPrompt
 */

import type { EditFormProps } from '../EditForms'
import { Expand, Field, TextArea, TextInput } from '../shared/Field'
import { num, str } from '../shared/InteractionBase'
import ParameterFields, { type WorkflowParameter } from './ParameterFields'

export default function EditParameterPrompt({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Timeout (millisecond) (0 to disable)">
        <TextInput
          type="number"
          value={num(data, 'timeout', 60000)}
          onChange={(v) => onChange({ timeout: Number(v) || 0 })}
        />
      </Field>

      <Expand title="Insert parameters" defaultOpen>
        <ParameterFields value={data.parameters} onChange={(parameters: WorkflowParameter[]) => onChange({ parameters })} />
      </Expand>
    </div>
  )
}
