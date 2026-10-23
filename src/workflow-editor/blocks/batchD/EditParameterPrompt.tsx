/**
 * EditParameterPrompt — React port of Automa's EditParameterPrompt.vue.
 *
 * Prompts the user for parameters before the workflow runs. Holds a timeout
 * and a `parameters` list edited in a modal (Automa's max-w-4xl dialog).
 *
 * @module workflow-editor/blocks/batchD/EditParameterPrompt
 */

import type { EditFormProps } from '../EditForms'
import { Field, NumberInput, TextArea } from '../shared/Field'
import PopupField from '../shared/PopupField'
import { num, str } from '../shared/InteractionBase'
import { useEditorLocale } from '../../locale-context'
import ParameterFields, { type WorkflowParameter } from './ParameterFields'

export default function EditParameterPrompt({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const parameterCount = Array.isArray(data.parameters) ? data.parameters.length : 0

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
        <NumberInput
          value={num(data, 'timeout', 60000)}
          fallback={0}
          onChange={(n) => onChange({ timeout: n })}
        />
      </Field>

      <PopupField
        title="Parameters"
        summary={`${parameterCount} ${bt('parameters')}`}
        editLabel="Insert parameters"
        icon="lucide:ListChecks"
        size="xl"
      >
        <ParameterFields
          value={data.parameters}
          onChange={(parameters: WorkflowParameter[]) => onChange({ parameters })}
        />
      </PopupField>
    </div>
  )
}
