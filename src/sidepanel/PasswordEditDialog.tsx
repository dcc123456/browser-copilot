/**
 * Password/identity entry create/edit dialog — replaces the inline editor card
 * that used to expand inside the data tab, so editing an entry never pushes
 * the list around. Same split as `sidepanel/SkillEditDialog`: the dialog owns
 * the draft and its reveal toggle, the caller validates, persists through the
 * worker and closes — or reports the failure back through `error`.
 *
 * @module sidepanel/PasswordEditDialog
 */
import { useState } from 'react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import type { PasswordEntry } from '../lib/types'
import { useT } from './i18n'

interface Props {
  /** Starting values; the dialog remounts per open so no sync effect is needed. */
  initial: PasswordEntry
  /** Heading: the entry label (edit) or "New secret" (create). */
  title: string
  /** True while the caller persists — disables the buttons, prevents double submits. */
  saving?: boolean
  /** Save failure from the last attempt, shown inside the dialog. */
  error?: string | null
  onSave: (entry: PasswordEntry) => void
  onCancel: () => void
}

export default function PasswordEditDialog({
  initial,
  title,
  saving = false,
  error = null,
  onSave,
  onCancel,
}: Props): React.ReactElement {
  const t = useT()
  const [draft, setDraft] = useState<PasswordEntry>(initial)
  // Local to the editing session: revealing here never unmasks the list behind.
  const [showSecrets, setShowSecrets] = useState(false)

  const updateField = (
    index: number,
    patch: Partial<{ key: string; value: string; secret: boolean }>,
  ): void => {
    setDraft((prev) => ({
      ...prev,
      fields: prev.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }))
  }
  const addField = (): void => {
    setDraft((prev) => ({ ...prev, fields: [...prev.fields, { key: '', value: '' }] }))
  }
  const removeField = (index: number): void => {
    setDraft((prev) => ({ ...prev, fields: prev.fields.filter((_, i) => i !== index) }))
  }

  const canSave = draft.label.trim().length > 0 && draft.fields.some((f) => f.key.trim() && f.value)

  return (
    <FormDialog
      footer={
        <>
          <FormDialogCancelButton disabled={saving} label={t.cancel} onClick={onCancel} />
          <FormDialogPrimaryButton
            disabled={saving || !canSave}
            label={t.save}
            onClick={() => onSave(draft)}
          />
        </>
      }
      onClose={onCancel}
      title={title}
      width="lg"
    >
      {error && (
        <div
          className="mb-3 rounded-lg border border-err bg-err-surface px-3 py-2 text-[12.5px] leading-relaxed break-words text-err"
          role="alert"
        >
          {error}
        </div>
      )}
      <label className="field">
        <span>{t.dataSecretLabel}</span>
        <input
          disabled={saving}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          value={draft.label}
        />
      </label>
      <label className="field">
        <span>{t.dataSecretUrl}</span>
        <input
          disabled={saving}
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          placeholder="https://example.com"
          value={draft.url ?? ''}
        />
      </label>

      <div className="kv-fields">
        <div className="kv-head">
          <span>{t.dataSecretFields}</span>
          <button className="link" disabled={saving} onClick={addField} type="button">
            + {t.dataSecretAddField}
          </button>
        </div>
        {draft.fields.map((field, index) => (
          <div className="kv-row" key={index}>
            <input
              aria-label={t.dataSecretFieldKey}
              className="kv-key"
              disabled={saving}
              onChange={(event) => updateField(index, { key: event.target.value })}
              placeholder={t.dataSecretFieldKey}
              value={field.key}
            />
            <input
              aria-label={t.dataSecretFieldValue}
              autoComplete="new-password"
              className="kv-value"
              disabled={saving}
              onChange={(event) => updateField(index, { value: event.target.value })}
              type={field.secret && !showSecrets ? 'password' : 'text'}
              value={field.value}
            />
            <label className="kv-secret" title={t.dataSecretMaskValue}>
              <input
                checked={!!field.secret}
                disabled={saving}
                onChange={(event) => updateField(index, { secret: event.target.checked })}
                type="checkbox"
              />
            </label>
            <button
              aria-label={t.delete}
              className="danger kv-remove"
              disabled={saving}
              onClick={() => removeField(index)}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <label className="checkbox">
        <input
          checked={showSecrets}
          disabled={saving}
          onChange={() => setShowSecrets((prev) => !prev)}
          type="checkbox"
        />
        <span>{t.dataShowPassword}</span>
      </label>
    </FormDialog>
  )
}
