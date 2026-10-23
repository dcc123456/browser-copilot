/**
 * EditWhileLoop — React port of Automa's EditWhileLoop.vue.
 *
 * While-loop stores its condition tree directly on `data.conditions`
 * (OrGroup[]); the catalog default is `null`, meaning "not configured yet".
 * Automa seeds it with one OR group of two AND rows on mount. The condition
 * tree is edited in a modal, as in Automa, while the form keeps a one-line
 * summary.
 *
 * @module workflow-editor/blocks/batchC/EditWhileLoop
 */

import type { EditFormProps } from '../EditForms'
import { useEditorLocale } from '../../locale-context'
import { Field, TextArea } from '../shared/Field'
import PopupField from '../shared/PopupField'
import { str } from '../shared/InteractionBase'
import ConditionBuilder, {
  defaultWhileConditions,
  readGroups,
  type OrGroup,
} from './ConditionBuilder'

export default function EditWhileLoop({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()

  // Catalog default is `null`; initialize with Automa's default tree.
  const groups: OrGroup[] =
    data.conditions === null || data.conditions === undefined
      ? defaultWhileConditions()
      : readGroups(data.conditions)
  const conditionCount = groups.reduce((total, group) => total + group.conditions.length, 0)

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <PopupField
        title="While loop condition"
        summary={`${groups.length} ${bt('OR groups')} · ${conditionCount} ${bt('conditions')}`}
        editLabel="Edit condition"
        icon="lucide:GitBranch"
        size="lg"
      >
        <ConditionBuilder value={groups} onChange={(g) => onChange({ conditions: g })} />
      </PopupField>

      <p className="wf-form-note" style={{ marginTop: 8 }}>
        {bt('Blocks connected to the fallback handle run when the condition is false.')}
      </p>
    </div>
  )
}
