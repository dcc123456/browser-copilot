/**
 * EditGetSecret — edit form for the local `get-secret` block.
 *
 * The block fetches a stored credential field at RUNTIME and stores its value
 * in a workflow variable. Unlike embedding the literal value, this approach:
 *   - Never stores the secret in the workflow definition
 *   - Picks up credential updates automatically on each run
 *   - Follows the same pattern as `ai-agent` and `ocr` blocks that produce
 *     variables for downstream blocks to consume
 *
 * The form collects:
 *   - a description (shown on the node)
 *   - the credential bundle id (from list_secrets)
 *   - the field key within the credential (e.g. 'password', 'username')
 *   - the output variable name
 *
 * @module workflow-editor/blocks/batchC/EditGetSecret
 */

import { Field, TextArea, TextInput } from '../shared/Field'
import { str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'

export default function EditGetSecret({ data, onChange }: EditFormProps) {
  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <Field label="Credential ID">
        <TextInput
          value={str(data, 'secretId')}
          placeholder="ID of the credential bundle (from list_secrets)"
          onChange={(v) => onChange({ secretId: v })}
        />
      </Field>

      <Field label="Field name">
        <TextInput
          value={str(data, 'fieldName')}
          placeholder="Field key within the credential (e.g. password, username)"
          onChange={(v) => onChange({ fieldName: v })}
        />
      </Field>

      <Field label="Output variable">
        <TextInput
          value={str(data, 'variableName')}
          placeholder="Variable the secret value is stored under"
          onChange={(v) => onChange({ variableName: v })}
        />
      </Field>

      <div className="mt-2 text-xs text-muted">
        The secret value is fetched at runtime and never stored in the workflow.
        Downstream blocks can reference it via {'{{'}variable name{'}'}
      </div>
    </div>
  )
}
