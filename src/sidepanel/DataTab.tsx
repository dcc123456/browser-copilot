/**
 * Data tab: manage saved profiles and password/identity entries.
 * Action history has moved to the History tab.
 *
 * Create/edit happens in a dialog (ProfileEditDialog / PasswordEditDialog),
 * never inline on the page, so editing an entry never pushes the list around.
 *
 * @module sidepanel/DataTab
 */
import { useCallback, useEffect, useState } from 'react'
import { sendCommand } from '../lib/messages'
import { STORAGE_RECONNECTED_EVENT } from '../lib/fs-reconnect'
import { newId } from '../lib/storage'
import type { PasswordEntry, UserProfile } from '../lib/types'
import { entryFields } from '../lib/types'
import { useT } from './i18n'
import ProfileEditDialog from './ProfileEditDialog'
import PasswordEditDialog from './PasswordEditDialog'

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

export default function DataTab() {
  const t = useT()
  const [section, setSection] = useState<Section>('profiles')
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [profiles, setProfiles] = useState<UserProfile[] | null>(null)
  const [passwords, setPasswords] = useState<PasswordEntry[] | null>(null)

  // Non-null while the matching edit dialog is open; holds the dialog's
  // starting values, not the live draft (the dialog owns that).
  const [profileDraft, setProfileDraft] = useState<UserProfile | null>(null)
  const [passwordDraft, setPasswordDraft] = useState<PasswordEntry | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
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

  // Same contract as the other tabs: the storage folder can reconnect itself
  // mid-session (lib/fs-reconnect) after an extension update, and these lists
  // were read before the handle was available — reload on the event.
  useEffect(() => {
    const handler = (): void => {
      void loadProfiles().catch((error) => flash('error', (error as Error).message))
      void loadPasswords().catch((error) => flash('error', (error as Error).message))
    }
    window.addEventListener(STORAGE_RECONNECTED_EVENT, handler)
    return () => window.removeEventListener(STORAGE_RECONNECTED_EVENT, handler)
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
    setDialogError(null)
    setProfileDraft(base)
  }
  const saveProfile = async (profile: UserProfile): Promise<void> => {
    if (!(profile.label ?? '').trim()) {
      setDialogError(t.dataProfileLabel)
      return
    }
    setSaving(true)
    setDialogError(null)
    try {
      await sendCommand({ type: 'profiles.save', profile })
      setProfileDraft(null)
      await loadProfiles()
      flash('ok', t.save)
    } catch (error) {
      setDialogError((error as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const removeProfile = async (id: string): Promise<void> => {
    await sendCommand({ type: 'profiles.delete', id })
    await loadProfiles()
  }

  const savePassword = async (entry: PasswordEntry): Promise<void> => {
    if (!(entry.label ?? '').trim()) {
      setDialogError(t.dataSecretLabel)
      return
    }
    const hasValue = entry.fields.some((f) => f.key.trim() && f.value)
    if (!hasValue) {
      setDialogError(t.dataSecretFieldValue)
      return
    }
    setSaving(true)
    setDialogError(null)
    try {
      await sendCommand({ type: 'passwords.save', entry })
      setPasswordDraft(null)
      await loadPasswords()
      flash('ok', t.save)
    } catch (error) {
      setDialogError((error as Error).message)
    } finally {
      setSaving(false)
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
          onStart={() => startProfile()}
          onEdit={startProfile}
          onDelete={removeProfile}
        />
      )}

      {section === 'passwords' && (
        <PasswordsSection
          t={t}
          passwords={passwords}
          reveal={reveal}
          onToggleReveal={(id) => setReveal((prev) => ({ ...prev, [id]: !prev[id] }))}
          onStart={() => {
            setDialogError(null)
            setPasswordDraft(emptyPassword())
          }}
          onEdit={(entry) => {
            setDialogError(null)
            setPasswordDraft({ ...entry })
          }}
          onDelete={removePassword}
        />
      )}

      {/* Create/edit happens in a dialog, never inline on the page. */}
      {profileDraft && (
        <ProfileEditDialog
          error={dialogError}
          initial={profileDraft}
          saving={saving}
          title={(profileDraft.label ?? '').trim() || t.dataAddProfile}
          onCancel={() => setProfileDraft(null)}
          onSave={(profile) => void saveProfile(profile)}
        />
      )}
      {passwordDraft && (
        <PasswordEditDialog
          error={dialogError}
          initial={passwordDraft}
          saving={saving}
          title={passwordDraft.label.trim() || t.dataAddSecret}
          onCancel={() => setPasswordDraft(null)}
          onSave={(entry) => void savePassword(entry)}
        />
      )}
    </div>
  )
}

// --- Profiles ---------------------------------------------------------------

interface ProfilesProps {
  t: ReturnType<typeof useT>
  profiles: UserProfile[] | null
  onStart: () => void
  onEdit: (profile: UserProfile) => void
  onDelete: (id: string) => void
}

function ProfilesSection({ t, profiles, onStart, onEdit, onDelete }: ProfilesProps) {
  return (
    <>
      <div className="card">
        <div className="card-title">{t.dataProfiles}</div>
        <p className="hint">{t.dataProfilesIntro}</p>
        <div className="actions">
          <button className="primary" onClick={onStart} type="button">
            {t.dataAddProfile}
          </button>
        </div>
      </div>

      {profiles && profiles.length === 0 && <div className="empty">{t.dataProfilesEmpty}</div>}
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
  reveal: Record<string, boolean>
  onToggleReveal: (id: string) => void
  onStart: () => void
  onEdit: (entry: PasswordEntry) => void
  onDelete: (id: string) => void
}

function PasswordsSection({
  t,
  passwords,
  reveal,
  onToggleReveal,
  onStart,
  onEdit,
  onDelete,
}: PasswordsProps) {
  return (
    <>
      <div className="card">
        <div className="card-title">{t.dataSecrets}</div>
        <p className="hint">{t.dataSecretsIntro}</p>
        <div className="actions">
          <button className="primary" onClick={onStart} type="button">
            {t.dataAddSecret}
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          {t.dataPasswordStorageNote}
        </p>
      </div>

      {passwords && passwords.length === 0 && <div className="empty">{t.dataSecretsEmpty}</div>}
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
