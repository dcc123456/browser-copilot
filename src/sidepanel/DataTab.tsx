/**
 * Data tab: manage saved profiles and password/identity entries.
 * Action history has moved to the History tab.
 *
 * Create/edit happens in a dialog (ProfileEditDialog / PasswordEditDialog),
 * never inline on the page, so editing an entry never pushes the list around.
 *
 * @module sidepanel/DataTab
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { sendCommand } from '../lib/messages'
import { STORAGE_RECONNECTED_EVENT } from '../lib/fs-reconnect'
import { onStoreChanged } from '../lib/store-events'
import { newId } from '../lib/storage'
import { downloadJSONFile } from '../lib/download-json'
import {
  buildDataExport,
  coerceImportedProfile,
  coerceImportedSecret,
  isDataExport,
} from '../lib/data-export'
import type { PasswordEntry, UserProfile } from '../lib/types'
import { entryFields } from '../lib/types'
import { useT } from './i18n'
import Banner from './components/Banner'
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
  // Checked ids per section; the export buttons act on these sets.
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(new Set())
  const [selectedSecretIds, setSelectedSecretIds] = useState<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // A workflow applied from the marketplace imports its credentials in the
  // background, and this tab stays mounted (hidden) while the user is in 广场 —
  // without the notification the new entries only appeared after a reload.
  useEffect(
    () =>
      onStoreChanged('passwords', () => {
        void loadPasswords().catch((error) => flash('error', (error as Error).message))
      }),
    [loadPasswords],
  )

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

  const toggleProfile = (id: string): void => {
    setSelectedProfileIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleSecret = (id: string): void => {
    setSelectedSecretIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exportSelectedProfiles = (): void => {
    const selected = (profiles ?? []).filter((profile) => selectedProfileIds.has(profile.id))
    if (selected.length === 0) return
    void downloadJSONFile('profiles-selected.json', buildDataExport({ profiles: selected }))
    flash('ok', t.dataExportDone({ count: selected.length }))
  }
  const exportSelectedSecrets = (): void => {
    const selected = (passwords ?? []).filter((entry) => selectedSecretIds.has(entry.id))
    if (selected.length === 0) return
    void downloadJSONFile('secrets-selected.json', buildDataExport({ secrets: selected }))
    flash('ok', t.dataExportDone({ count: selected.length }))
  }

  /**
   * Imports every record the file carries. Imported records are always new
   * entries: an import never overwrites what this machine already holds.
   */
  const importFromFile = async (file: File | null): Promise<void> => {
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isDataExport(parsed)) throw new Error(t.dataImportInvalid)
      const now = Date.now()
      let importedProfiles = 0
      for (const raw of parsed.profiles) {
        const profile = coerceImportedProfile(raw, now)
        if (!profile) continue
        await sendCommand({ type: 'profiles.save', profile })
        importedProfiles += 1
      }
      let importedSecrets = 0
      for (const raw of parsed.secrets) {
        const entry = coerceImportedSecret(raw, now)
        if (!entry) continue
        await sendCommand({ type: 'passwords.save', entry })
        importedSecrets += 1
      }
      await loadProfiles()
      await loadPasswords()
      flash('ok', t.dataImportDone({ profiles: importedProfiles, secrets: importedSecrets }))
    } catch (error) {
      flash('error', t.dataImportFailed({ reason: (error as Error).message }))
    }
  }

  return (
    <div className="pane">
      {banner && (
        <Banner kind={banner.kind} onDismiss={() => setBanner(null)}>
          {banner.text}
        </Banner>
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
          selectedIds={selectedProfileIds}
          onToggleSelected={toggleProfile}
          onToggleAll={(checked) =>
            setSelectedProfileIds(
              checked ? new Set((profiles ?? []).map((profile) => profile.id)) : new Set(),
            )
          }
          onExportSelected={exportSelectedProfiles}
          onImport={() => fileInputRef.current?.click()}
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
          selectedIds={selectedSecretIds}
          onToggleSelected={toggleSecret}
          onToggleAll={(checked) =>
            setSelectedSecretIds(
              checked ? new Set((passwords ?? []).map((entry) => entry.id)) : new Set(),
            )
          }
          onExportSelected={exportSelectedSecrets}
          onImport={() => fileInputRef.current?.click()}
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

      {/* One hidden file input serves both sections: the file says what it
          carries, so the import button only has to open the picker. */}
      <input
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null
          // Reset so picking the same file again still fires a change.
          event.target.value = ''
          void importFromFile(file)
        }}
        ref={fileInputRef}
        type="file"
      />

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
  selectedIds: Set<string>
  onToggleSelected: (id: string) => void
  onToggleAll: (checked: boolean) => void
  onExportSelected: () => void
  onImport: () => void
  onStart: () => void
  onEdit: (profile: UserProfile) => void
  onDelete: (id: string) => void
}

function ProfilesSection({
  t,
  profiles,
  selectedIds,
  onToggleSelected,
  onToggleAll,
  onExportSelected,
  onImport,
  onStart,
  onEdit,
  onDelete,
}: ProfilesProps) {
  const allSelected = (profiles?.length ?? 0) > 0 && selectedIds.size === profiles?.length
  return (
    <>
      <div className="card">
        <div className="card-title">{t.dataProfiles}</div>
        <p className="hint">{t.dataProfilesIntro}</p>
        <div className="actions">
          <button className="primary" onClick={onStart} type="button">
            {t.dataAddProfile}
          </button>
          <button onClick={onImport} type="button">
            {t.dataImport}
          </button>
          <button disabled={selectedIds.size === 0} onClick={onExportSelected} type="button">
            {t.dataExportSelected}
          </button>
        </div>
      </div>

      {profiles && profiles.length === 0 && <div className="empty">{t.dataProfilesEmpty}</div>}
      {profiles && profiles.length > 0 && (
        <label className="wf-select-all">
          <input
            checked={allSelected}
            onChange={(event) => onToggleAll(event.target.checked)}
            type="checkbox"
          />
          {t.dataSelectAll}
        </label>
      )}
      {profiles?.map((profile) => (
        <div className="card" key={profile.id}>
          <div className="card-head">
            <span className="card-title">
              <label className="wf-item-check">
                <input
                  aria-label={t.dataSelectItem({ label: profile.label })}
                  checked={selectedIds.has(profile.id)}
                  onChange={() => onToggleSelected(profile.id)}
                  type="checkbox"
                />
              </label>{' '}
              {profile.label}
            </span>
          </div>
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
  selectedIds: Set<string>
  onToggleSelected: (id: string) => void
  onToggleAll: (checked: boolean) => void
  onExportSelected: () => void
  onImport: () => void
  onToggleReveal: (id: string) => void
  onStart: () => void
  onEdit: (entry: PasswordEntry) => void
  onDelete: (id: string) => void
}

function PasswordsSection({
  t,
  passwords,
  reveal,
  selectedIds,
  onToggleSelected,
  onToggleAll,
  onExportSelected,
  onImport,
  onToggleReveal,
  onStart,
  onEdit,
  onDelete,
}: PasswordsProps) {
  const allSelected = (passwords?.length ?? 0) > 0 && selectedIds.size === passwords?.length
  return (
    <>
      <div className="card">
        <div className="card-title">{t.dataSecrets}</div>
        <p className="hint">{t.dataSecretsIntro}</p>
        <div className="actions">
          <button className="primary" onClick={onStart} type="button">
            {t.dataAddSecret}
          </button>
          <button onClick={onImport} type="button">
            {t.dataImport}
          </button>
          <button disabled={selectedIds.size === 0} onClick={onExportSelected} type="button">
            {t.dataExportSelected}
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          {t.dataPasswordStorageNote}
        </p>
        <p className="hint" style={{ marginBottom: 0 }}>
          {t.dataExportPlaintext}
        </p>
      </div>

      {passwords && passwords.length === 0 && <div className="empty">{t.dataSecretsEmpty}</div>}
      {passwords && passwords.length > 0 && (
        <label className="wf-select-all">
          <input
            checked={allSelected}
            onChange={(event) => onToggleAll(event.target.checked)}
            type="checkbox"
          />
          {t.dataSelectAll}
        </label>
      )}
      {passwords?.map((entry) => (
        <div className="card" key={entry.id}>
          <div className="card-head">
            <span className="card-title">
              <label className="wf-item-check">
                <input
                  aria-label={t.dataSelectItem({ label: entry.label })}
                  checked={selectedIds.has(entry.id)}
                  onChange={() => onToggleSelected(entry.id)}
                  type="checkbox"
                />
              </label>{' '}
              {entry.label}
            </span>
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
