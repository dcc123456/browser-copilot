/**
 * Profile create/edit dialog — replaces the inline editor card that used to
 * expand inside the data tab, so editing a profile never pushes the list
 * around. Same split as `sidepanel/SkillEditDialog`: the dialog owns the draft
 * (including the custom-fields text), the caller validates, persists through
 * the worker and closes — or reports the failure back through `error`.
 *
 * @module sidepanel/ProfileEditDialog
 */
import { useState } from 'react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import type { UserProfile } from '../lib/types'
import { useT } from './i18n'

interface Props {
  /** Starting values; the dialog remounts per open so no sync effect is needed. */
  initial: UserProfile
  /** Heading: the profile label (edit) or "New profile" (create). */
  title: string
  /** True while the caller persists — disables the buttons, prevents double submits. */
  saving?: boolean
  /** Save failure from the last attempt, shown inside the dialog. */
  error?: string | null
  onSave: (profile: UserProfile) => void
  onCancel: () => void
}

function parseCustom(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function serializeCustom(custom: Record<string, string>): string {
  return Object.entries(custom)
    .map(([key, value]) => `${key} = ${value}`)
    .join('\n')
}

export default function ProfileEditDialog({
  initial,
  title,
  saving = false,
  error = null,
  onSave,
  onCancel,
}: Props): React.ReactElement {
  const t = useT()
  const [draft, setDraft] = useState<UserProfile>(initial)
  const [customText, setCustomText] = useState(() => serializeCustom(initial.custom ?? {}))

  const field = (key: keyof UserProfile, label: string, placeholder?: string) => (
    <label className="field" key={String(key)}>
      <span>{label}</span>
      <input
        disabled={saving}
        onChange={(event) =>
          setDraft((prev) => ({ ...prev, [key]: event.target.value }) as UserProfile)
        }
        placeholder={placeholder}
        value={String((draft[key] as string | undefined) ?? '')}
      />
    </label>
  )

  const canSave = (draft.label ?? '').trim().length > 0

  return (
    <FormDialog
      footer={
        <>
          <FormDialogCancelButton disabled={saving} label={t.cancel} onClick={onCancel} />
          <FormDialogPrimaryButton
            disabled={saving || !canSave}
            label={t.save}
            onClick={() => onSave({ ...draft, custom: parseCustom(customText) })}
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
      <div className="row">
        {field('label', t.dataProfileLabel)}
        {field('fullName', t.dataFullName)}
      </div>
      <div className="row">
        {field('firstName', t.dataFirstName)}
        {field('lastName', t.dataLastName)}
      </div>
      <div className="row">
        {field('email', t.dataEmail)}
        {field('phone', t.dataPhone)}
      </div>
      <div className="row">
        {field('company', t.dataCompany)}
        {field('jobTitle', t.dataJobTitle)}
      </div>
      {field('address', t.dataAddress)}
      <div className="row">
        {field('city', t.dataCity)}
        {field('state', t.dataState)}
      </div>
      <div className="row">
        {field('postalCode', t.dataPostalCode)}
        {field('country', t.dataCountry)}
      </div>
      <label className="field">
        <span>{t.dataCustomFields}</span>
        <textarea
          disabled={saving}
          onChange={(event) => setCustomText(event.target.value)}
          placeholder="birthday = 1990-01-01"
          rows={3}
          value={customText}
        />
      </label>
      <p className="hint">{t.dataCustomFieldsHint}</p>
    </FormDialog>
  )
}
