/**
 * Data tab: manage saved profiles and password/identity entries.
 * Action history has moved to the History tab.
 *
 * @module sidepanel/DataTab
 */
import { useCallback, useEffect, useState } from 'react'
import { sendCommand } from '../lib/messages'
import { newId } from '../lib/storage'
import type { PasswordEntry, UserProfile } from '../lib/types'
import { entryFields } from '../lib/types'
import { useT } from './i18n'

type Section = 'profiles' | 'passwords'

function emptyProfile(): UserProfile {
  return {
    id: newId(),
    label: '',
    custom: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function emptyPassword(): PasswordEntry {
  return {
    id: newId(),
    label: '',
    url: '',
    fields: [
      { key: 'username', value: '' },
      { key: 'password', value: '', secret: true },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    useCount: 0,
  }
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


export default function DataTab() {
  const t = useT()
  const [section, setSection] = useState<Section>('profiles')
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [profiles, setProfiles] = useState<UserProfile[] | null>(null)
  const [passwords, setPasswords] = useState<PasswordEntry[] | null>(null)

  const [profileDraft, setProfileDraft] = useState<UserProfile | null>(null)
  const [customText, setCustomText] = useState('')
  const [passwordDraft, setPasswordDraft] = useState<PasswordEntry | null>(null)
  const [reveal, setReveal] = useState<Record<string, boolean>>({})

  const flash = (kind: 'ok' | 'error', text: string): void => {
    setBanner({ kind, text })
    window.setTimeout(() => setBanner(null), 3000)
  }

  const loadProfiles = useCallback(async () => {
    const result = await sendCommand({ type: 'profiles.list' })
    if (result.type === 'profiles.list') setProfiles(result.profiles)
  }, [])
  const loadPasswords = useCallback(async () => {
    const result = await sendCommand({ type: 'passwords.list' })
    if (result.type === 'passwords.list') setPasswords(result.entries)
  }, [])

  useEffect(() => {
    void loadProfiles().catch((error) => flash('error', (error as Error).message))
    void loadPasswords().catch((error) => flash('error', (error as Error).message))
  }, [loadProfiles, loadPasswords])

  const startProfile = (profile?: UserProfile): void => {
    // Coerce every known field to a string defensively. A panel/worker version
    // skew or hand-edited storage can otherwise leave a field `undefined`,
    // which later crashes on `.trim()` in render.
    const base: UserProfile = profile
      ? {
          id: profile.id ?? newId(),
          label: profile.label ?? '',
          fullName: profile.fullName ?? '',
          firstName: profile.firstName ?? '',
          lastName: profile.lastName ?? '',
          email: profile.email ?? '',
          phone: profile.phone ?? '',
          address: profile.address ?? '',
          city: profile.city ?? '',
          state: profile.state ?? '',
          postalCode: profile.postalCode ?? '',
          country: profile.country ?? '',
          company: profile.company ?? '',
          jobTitle: profile.jobTitle ?? '',
          custom: { ...(profile.custom ?? {}) },
          createdAt: profile.createdAt ?? Date.now(),
          updatedAt: profile.updatedAt ?? Date.now(),
        }
      : emptyProfile()
    setProfileDraft(base)
    setCustomText(serializeCustom(base.custom))
  }
  const saveProfile = async (): Promise<void> => {
    if (!profileDraft) return
    if (!(profileDraft.label ?? '').trim()) {
      flash('error', t.dataProfileLabel)
      return
    }
    try {
      await sendCommand({
        type: 'profiles.save',
        profile: { ...profileDraft, custom: parseCustom(customText) },
      })
      setProfileDraft(null)
      await loadProfiles()
      flash('ok', t.save)
    } catch (error) {
      flash('error', (error as Error).message)
    }
  }
  const removeProfile = async (id: string): Promise<void> => {
    await sendCommand({ type: 'profiles.delete', id })
    await loadProfiles()
  }

  const savePassword = async (): Promise<void> => {
    if (!passwordDraft) return
    if (!(passwordDraft.label ?? '').trim()) {
      flash('error', t.dataSecretLabel)
      return
    }
    const hasValue = passwordDraft.fields.some((f) => f.key.trim() && f.value)
    if (!hasValue) {
      flash('error', t.dataSecretFieldValue)
      return
    }
    try {
      await sendCommand({ type: 'passwords.save', entry: passwordDraft })
      setPasswordDraft(null)
      await loadPasswords()
      flash('ok', t.save)
    } catch (error) {
      flash('error', (error as Error).message)
    }
  }
  const removePassword = async (id: string): Promise<void> => {
    await sendCommand({ type: 'passwords.delete', id })
    await loadPasswords()
  }

  return (
    <div className="pane">
      {banner && (
        <div className="banner" data-kind={banner.kind} onClick={() => setBanner(null)}>
          {banner.text}
        </div>
      )}

      <div className="card">
        <div className="card-title">{t.dataTitle}</div>
        <p className="hint">{t.dataIntro}</p>
        <div className="tabs" style={{ margin: '4px 0 0' }}>
          {(['profiles', 'passwords'] as Section[]).map((id) => (
            <button
              key={id}
              className="tab"
              data-active={section === id}
              onClick={() => setSection(id)}
              type="button"
            >
              {id === 'profiles' ? t.dataProfiles : t.dataSecrets}
            </button>
          ))}
        </div>
      </div>

      {section === 'profiles' && (
        <ProfilesSection
          t={t}
          profiles={profiles}
          draft={profileDraft}
          customText={customText}
          onStart={startProfile}
          onEdit={startProfile}
          onDelete={removeProfile}
          onDraftChange={setProfileDraft}
          onCustomChange={setCustomText}
          onSave={saveProfile}
          onCancel={() => setProfileDraft(null)}
        />
      )}

      {section === 'passwords' && (
        <PasswordsSection
          t={t}
          passwords={passwords}
          draft={passwordDraft}
          reveal={reveal}
          onToggleReveal={(id) => setReveal((prev) => ({ ...prev, [id]: !prev[id] }))}
          onStart={() => setPasswordDraft(emptyPassword())}
          onEdit={(entry) => setPasswordDraft({ ...entry })}
          onDelete={removePassword}
          onDraftChange={setPasswordDraft}
          onSave={savePassword}
          onCancel={() => setPasswordDraft(null)}
        />
      )}
    </div>
  )
}

// --- Profiles ---------------------------------------------------------------

interface ProfilesProps {
  t: ReturnType<typeof useT>
  profiles: UserProfile[] | null
  draft: UserProfile | null
  customText: string
  onStart: () => void
  onEdit: (profile: UserProfile) => void
  onDelete: (id: string) => void
  onDraftChange: (draft: UserProfile) => void
  onCustomChange: (text: string) => void
  onSave: () => void
  onCancel: () => void
}

function ProfilesSection({
  t,
  profiles,
  draft,
  customText,
  onStart,
  onEdit,
  onDelete,
  onDraftChange,
  onCustomChange,
  onSave,
  onCancel,
}: ProfilesProps) {
  const field = (key: keyof UserProfile, label: string, placeholder?: string) => (
    <label className="field" key={String(key)}>
      <span>{label}</span>
      <input
        onChange={(event) => {
          if (!draft) return
          onDraftChange({ ...draft, [key]: event.target.value } as UserProfile)
        }}
        placeholder={placeholder}
        value={String((draft?.[key] as string | undefined) ?? '')}
      />
    </label>
  )

  return (
    <>
      <div className="card">
        <div className="card-title">{t.dataProfiles}</div>
        <p className="hint">{t.dataProfilesIntro}</p>
        {!draft && (
          <div className="actions">
            <button className="primary" onClick={onStart} type="button">
              {t.dataAddProfile}
            </button>
          </div>
        )}
      </div>

      {draft && (
        <div className="card">
          <div className="card-title">{(draft.label ?? '').trim() || t.dataAddProfile}</div>
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
              onChange={(event) => onCustomChange(event.target.value)}
              placeholder="birthday = 1990-01-01"
              rows={3}
              value={customText}
            />
          </label>
          <p className="hint">{t.dataCustomFieldsHint}</p>
          <div className="actions">
            <button className="primary" onClick={() => void onSave()} type="button">
              {t.save}
            </button>
            <button onClick={onCancel} type="button">
              {t.cancel}
            </button>
          </div>
        </div>
      )}

      {profiles && profiles.length === 0 && !draft && <div className="empty">{t.dataProfilesEmpty}</div>}
      {profiles?.map((profile) => (
        <div className="card" key={profile.id}>
          <div className="card-title">{profile.label}</div>
          <div className="meta">
            {[profile.fullName, profile.email, profile.phone, profile.company]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <div className="actions">
            <button onClick={() => onEdit(profile)} type="button">
              {t.edit}
            </button>
            <button className="danger" onClick={() => void onDelete(profile.id)} type="button">
              {t.delete}
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

// --- Passwords --------------------------------------------------------------

interface PasswordsProps {
  t: ReturnType<typeof useT>
  passwords: PasswordEntry[] | null
  draft: PasswordEntry | null
  reveal: Record<string, boolean>
  onToggleReveal: (id: string) => void
  onStart: () => void
  onEdit: (entry: PasswordEntry) => void
  onDelete: (id: string) => void
  onDraftChange: (draft: PasswordEntry) => void
  onSave: () => void
  onCancel: () => void
}

function PasswordsSection({
  t,
  passwords,
  draft,
  reveal,
  onToggleReveal,
  onStart,
  onEdit,
  onDelete,
  onDraftChange,
  onSave,
  onCancel,
}: PasswordsProps) {
  const updateField = (index: number, patch: Partial<{ key: string; value: string; secret: boolean }>): void => {
    if (!draft) return
    const fields = draft.fields.map((f, i) => (i === index ? { ...f, ...patch } : f))
    onDraftChange({ ...draft, fields })
  }
  const addField = (): void => {
    if (!draft) return
    onDraftChange({ ...draft, fields: [...draft.fields, { key: '', value: '' }] })
  }
  const removeField = (index: number): void => {
    if (!draft) return
    onDraftChange({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })
  }

  return (
    <>
      <div className="card">
        <div className="card-title">{t.dataSecrets}</div>
        <p className="hint">{t.dataSecretsIntro}</p>
        {!draft && (
          <div className="actions">
            <button className="primary" onClick={onStart} type="button">
              {t.dataAddSecret}
            </button>
          </div>
        )}
        <p className="hint" style={{ marginBottom: 0 }}>
          {t.dataPasswordStorageNote}
        </p>
      </div>

      {draft && (
        <div className="card">
          <div className="card-title">{draft.label.trim() || t.dataAddSecret}</div>
          <label className="field">
            <span>{t.dataSecretLabel}</span>
            <input
              onChange={(event) => onDraftChange({ ...draft, label: event.target.value })}
              value={draft.label}
            />
          </label>
          <label className="field">
            <span>{t.dataSecretUrl}</span>
            <input
              onChange={(event) => onDraftChange({ ...draft, url: event.target.value })}
              placeholder="https://example.com"
              value={draft.url ?? ''}
            />
          </label>

          <div className="kv-fields">
            <div className="kv-head">
              <span>{t.dataSecretFields}</span>
              <button className="link" onClick={addField} type="button">
                + {t.dataSecretAddField}
              </button>
            </div>
            {draft.fields.map((field, index) => (
              <div className="kv-row" key={index}>
                <input
                  aria-label={t.dataSecretFieldKey}
                  className="kv-key"
                  onChange={(event) => updateField(index, { key: event.target.value })}
                  placeholder={t.dataSecretFieldKey}
                  value={field.key}
                />
                <input
                  aria-label={t.dataSecretFieldValue}
                  autoComplete="new-password"
                  className="kv-value"
                  onChange={(event) => updateField(index, { value: event.target.value })}
                  type={field.secret && !reveal[draft.id] ? 'password' : 'text'}
                  value={field.value}
                />
                <label className="kv-secret" title={t.dataSecretMaskValue}>
                  <input
                    checked={!!field.secret}
                    onChange={(event) => updateField(index, { secret: event.target.checked })}
                    type="checkbox"
                  />
                </label>
                <button
                  aria-label={t.delete}
                  className="danger kv-remove"
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
              checked={!!reveal[draft.id]}
              onChange={() => onToggleReveal(draft.id)}
              type="checkbox"
            />
            <span>{t.dataShowPassword}</span>
          </label>
          <div className="actions">
            <button className="primary" onClick={() => void onSave()} type="button">
              {t.save}
            </button>
            <button onClick={onCancel} type="button">
              {t.cancel}
            </button>
          </div>
        </div>
      )}

      {passwords && passwords.length === 0 && !draft && (
        <div className="empty">{t.dataSecretsEmpty}</div>
      )}
      {passwords?.map((entry) => (
        <div className="card" key={entry.id}>
          <div className="card-head">
            <span className="card-title">{entry.label}</span>
            {entry.useCount > 0 && (
              <span className="meta">{t.dataUsed({ count: entry.useCount })}</span>
            )}
          </div>
          {entry.url && <div className="meta">{entry.url}</div>}
          <ul className="secret-fields">
            {entryFields(entry).map((field) => (
              <li className="secret-field" key={field.key}>
                <span className="secret-field-key">{field.key}</span>
                <code>{field.secret && !reveal[entry.id] ? '••••••••' : field.value || '—'}</code>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button onClick={() => onToggleReveal(entry.id)} type="button">
              {t.dataShowPassword}
            </button>
            <button onClick={() => onEdit(entry)} type="button">
              {t.edit}
            </button>
            <button className="danger" onClick={() => void onDelete(entry.id)} type="button">
              {t.delete}
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

