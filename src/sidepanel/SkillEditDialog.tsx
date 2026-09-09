/**
 * Skill create/edit dialog — replaces the old inline editor cards so skill
 * forms never expand inside the page flow.
 *
 * The dialog owns the FIELD state only (it must be free to hold an invalid
 * draft while the user types); persistence stays with the caller: `onSave`
 * receives the trimmed-ish values, the caller validates, persists, and either
 * closes the dialog or reports the failure back through `error`.
 *
 * Used by both the Skills tab (new / edit) and the chat's generated-skill card
 * ("save and edit"), which is why labels come from `useT()` here.
 *
 * @module sidepanel/SkillEditDialog
 */
import { useState } from 'react'
import FormDialog, {
  FormDialogCancelButton,
  FormDialogPrimaryButton,
} from '../ui/FormDialog'
import { useT } from './i18n'

/** Editable skill fields, shared shape for both call sites. */
export interface SkillFormValues {
  name: string
  description: string
  instructions: string
  autoMatch: boolean
}

interface Props {
  /** Starting values; the dialog remounts per open so no sync effect is needed. */
  initial: SkillFormValues
  /** Heading, e.g. the skill name (edit) or "New skill" (create). */
  title: string
  /** True while the caller persists — disables the buttons, prevents double submits. */
  saving?: boolean
  /** Validation / persistence failure from the last save attempt; null hides it. */
  error?: string | null
  onSave: (values: SkillFormValues) => void
  onCancel: () => void
}

export default function SkillEditDialog({
  initial,
  title,
  saving = false,
  error = null,
  onSave,
  onCancel,
}: Props): React.ReactElement {
  const t = useT()
  const [values, setValues] = useState<SkillFormValues>(initial)

  return (
    <FormDialog
      footer={
        <>
          <FormDialogCancelButton disabled={saving} label={t.cancel} onClick={onCancel} />
          <FormDialogPrimaryButton
            disabled={saving}
            label={t.save}
            onClick={() => onSave(values)}
          />
        </>
      }
      onClose={onCancel}
      title={title}
    >
      {error && (
        <div className="mb-3 rounded-lg border border-err bg-err-surface px-3 py-2 text-[12.5px] leading-relaxed break-words text-err" role="alert">
          {error}
        </div>
      )}

      <label className="field">
        <span>{t.skillsName}</span>
        <input
          maxLength={60}
          onChange={(event) => setValues({ ...values, name: event.target.value })}
          placeholder={t.skillsNamePlaceholder}
          value={values.name}
        />
      </label>

      <label className="field">
        <span>{t.skillsDescription}</span>
        <input
          maxLength={300}
          onChange={(event) => setValues({ ...values, description: event.target.value })}
          value={values.description}
        />
      </label>
      <p className="hint">{t.skillsDescriptionHint}</p>

      <label className="field">
        <span>{t.skillsInstructions}</span>
        <textarea
          maxLength={8000}
          onChange={(event) => setValues({ ...values, instructions: event.target.value })}
          rows={10}
          value={values.instructions}
        />
      </label>
      <p className="hint">{t.skillsInstructionsHint}</p>

      <label className="checkbox">
        <input
          checked={values.autoMatch}
          onChange={(event) => setValues({ ...values, autoMatch: event.target.checked })}
          type="checkbox"
        />
        <span>{t.skillsAutoMatch}</span>
      </label>
      <p className="hint">{t.skillsAutoMatchHint}</p>
    </FormDialog>
  )
}
