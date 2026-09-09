/**
 * Skills tab: create, edit, and delete reusable instruction packs.
 *
 * The list is owned by `App` because Chat needs it too; this tab only edits and
 * reports changes upward.
 *
 * @module sidepanel/SkillsTab
 */
import { useRef, useState } from 'react'
import { sendCommand } from '../lib/messages'
import type { Skill } from '../lib/types'
import {
  exportSkillsJson,
  importSkillsBatch,
  parseSkillsFiles,
  type ImportBatchProblem,
} from '../lib/skills-import'
import { downloadBlob } from '../lib/export-answer'
import { useT } from './i18n'
import SkillEditDialog, { type SkillFormValues } from './SkillEditDialog'

interface Props {
  skills: Skill[]
  activeSkillId: string | null
  onChanged: () => void
  /** `null` clears the selection; an id selects that skill and jumps to Chat. */
  onUseInChat: (id: string | null) => void
}

/** Editable form state; separate from `Skill` so a draft need not be valid yet. */
interface Draft {
  id: string
  name: string
  description: string
  instructions: string
  autoMatch: boolean
  createdAt: number
}

const newLocalId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

function toDraft(skill: Skill): Draft {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    autoMatch: skill.autoMatch,
    createdAt: skill.createdAt,
  }
}

function emptyDraft(): Draft {
  return {
    id: newLocalId(),
    name: '',
    description: '',
    instructions: '',
    autoMatch: true,
    createdAt: Date.now(),
  }
}

export default function SkillsTab({ skills, activeSkillId, onChanged, onUseInChat }: Props) {
  const t = useT()
  // Non-null while the create/edit DIALOG is open; the dialog owns the fields,
  // this only carries identity (id/createdAt) and the open/closed switch.
  const [draft, setDraft] = useState<Draft | null>(null)
  /** Failure of the last save attempt, rendered inside the dialog. */
  const [draftError, setDraftError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** Best-effort human-readable name of a raw import entry, for clash banners. */
  const rawDisplayName = (raw: unknown): string => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>
      for (const key of ['name', 'title']) {
        if (typeof obj[key] === 'string' && (obj[key] as string).trim()) {
          return (obj[key] as string).trim()
        }
      }
    }
    return ''
  }

  /** Translates one rejected import item into localised text lines. */
  const importProblemTexts = (problem: ImportBatchProblem): string[] =>
    problem.problems.map((item) => {
      const code = item.code
      if (code === 'nameRequired') return t.skillsNameRequired
      if (code === 'instructionsRequired') return t.skillsInstructionsRequired
      if (code === 'nameTaken') {
        const name = rawDisplayName(problem.raw)
        return t.skillsImportNameTaken({ name: name || t.skillName })
      }
      return String(code)
    })

  /**
   * Translates the worker's validation codes into localized text.
   *
   * The worker sends `skill:nameRequired,nameTaken` rather than sentences, so the
   * wording follows the panel's language rather than the worker's.
   */
  const describeError = (error: Error): string => {
    const message = error.message
    if (!message.startsWith('skill:')) return message
    const codes = message.slice('skill:'.length).split(',')
    const lookup: Record<string, string> = {
      nameRequired: t.skillsNameRequired,
      instructionsRequired: t.skillsInstructionsRequired,
      nameTaken: t.skillsNameTaken,
    }
    return codes
      .map((code) => lookup[code] ?? code)
      .filter((text, index, all) => all.indexOf(text) === index)
      .join(' ')
  }

  const save = async (values: SkillFormValues): Promise<void> => {
    if (!draft) return
    const skill: Skill = {
      id: draft.id,
      name: values.name,
      description: values.description,
      instructions: values.instructions,
      autoMatch: values.autoMatch,
      createdAt: draft.createdAt,
      updatedAt: Date.now(),
    }
    setSaving(true)
    setDraftError(null)
    try {
      const result = await sendCommand({ type: 'skills.save', skill })
      const saved = result.type === 'skills.save' ? result.skill : skill
      setBanner({ kind: 'ok', text: t.skillsSaved({ name: saved.name }) })
      setDraft(null)
      onChanged()
    } catch (error) {
      // Rendered INSIDE the dialog so the failure is visible next to the form.
      setDraftError(describeError(error as Error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (skill: Skill): Promise<void> => {
    try {
      await sendCommand({ type: 'skills.delete', id: skill.id })
      setBanner({ kind: 'ok', text: t.skillsDeleted({ name: skill.name }) })
      if (draft?.id === skill.id) {
        setDraft(null)
        setDraftError(null)
      }
      onChanged()
    } catch (error) {
      setBanner({ kind: 'error', text: (error as Error).message })
    }
  }

  /**
   * Parses dropped/picked skill files, validates the batch against the current
   * list, persists the valid entries one-by-one, and reports a summary banner.
   */
  const importFromFiles = async (files: File | File[] | FileList | null): Promise<void> => {
    if (!files || (files as File[]).length === 0) return
    setImporting(true)
    try {
      const parsed = await parseSkillsFiles(files)
      const raws: unknown[] = []
      let fileFailures = 0
      for (const item of parsed) {
        if (!item.ok) {
          fileFailures += 1
          continue
        }
        raws.push(...item.raws)
      }

      const batch = importSkillsBatch(raws, skills)
      const detail: string[] = batch.problems.flatMap((problem) => importProblemTexts(problem))

      // Persist each valid skill individually (the existing skills.save protocol
      // is the single write path; a name clash with another client's storage is
      // still reported here rather than guessed from the local snapshot).
      let persisted = 0
      for (const skill of batch.saved) {
        try {
          await sendCommand({ type: 'skills.save', skill })
          persisted += 1
        } catch {
          /* count as a failure below */
        }
      }

      const failed = fileFailures + batch.problems.length + (batch.saved.length - persisted)
      if (failed === 0) {
        setBanner({ kind: 'ok', text: t.skillsImportResultOk({ count: persisted }) })
      } else {
        const summary = t.skillsImportResultFail({ ok: persisted, failed })
        setBanner({ kind: 'error', text: detail.length ? `${summary} ${detail.join(' ')}` : summary })
      }
      if (persisted > 0) onChanged()
    } catch (error) {
      setBanner({ kind: 'error', text: (error as Error).message })
    } finally {
      setImporting(false)
    }
  }

  /** Exports the whole local list as an indented JSON file for later re-import. */
  const exportAll = (): void => {
    if (skills.length === 0) {
      setBanner({ kind: 'error', text: t.skillsEmpty })
      return
    }
    const json = exportSkillsJson(skills)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    downloadBlob(json, 'application/json', `skills-${stamp}.json`)
  }

  return (
    <div className="pane" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault()
      void importFromFiles(event.dataTransfer?.files ?? null)
    }}>
      {banner && (
        <div className="banner" data-kind={banner.kind}>
          {banner.text}
        </div>
      )}

      <div className="card">
        <div className="card-title">{t.skillsTitle}</div>
        <p className="hint">{t.skillsIntro}</p>
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              setDraftError(null)
              setDraft(emptyDraft())
            }}
            type="button"
          >
            {t.skillsAdd}
          </button>
          <button
            className="skills-import-btn"
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
            title={t.skillsImportHint}
            type="button"
          >
            {t.skillsImport}
          </button>
          <button
            className="skills-export-btn"
            disabled={skills.length === 0}
            onClick={exportAll}
            type="button"
          >
            {t.skillsExportAll}
          </button>
          <input
            accept=".json,.yaml,.yml,.md,.markdown"
            multiple
            onChange={(event) => {
              void importFromFiles(event.target.files)
              event.target.value = ''
            }}
            ref={fileInputRef}
            style={{ display: 'none' }}
            type="file"
          />
        </div>
      </div>

      {/* Create/edit happens in a dialog, never inline on the page. */}
      {draft && (
        <SkillEditDialog
          error={draftError}
          initial={{
            name: draft.name,
            description: draft.description,
            instructions: draft.instructions,
            autoMatch: draft.autoMatch,
          }}
          saving={saving}
          title={draft.name.trim() || t.skillsAdd}
          onCancel={() => {
            setDraft(null)
            setDraftError(null)
          }}
          onSave={(values) => void save(values)}
        />
      )}

      {skills.length === 0 && <div className="empty">{t.skillsEmpty}</div>}

      {skills.map((skill) => (
        <div className="card" key={skill.id}>
          <div className="card-title">
            {skill.name}
            {skill.id === activeSkillId && <span className="pill">{t.skillsInUse}</span>}
          </div>
          {skill.description && <p className="hint">{skill.description}</p>}
          <div className="actions">
            {skill.id === activeSkillId ? (
              <button onClick={() => onUseInChat(null)} type="button">
                {t.skillsStopUsing}
              </button>
            ) : (
              <button className="primary" onClick={() => onUseInChat(skill.id)} type="button">
                {t.skillsUse}
              </button>
            )}
            <button onClick={() => setDraft(toDraft(skill))} type="button">
              {t.edit}
            </button>
            <button onClick={() => void remove(skill)} type="button">
              {t.delete}
            </button>
          </div>
        </div>
      ))}

      <p className="hint">{t.skillsBuiltinNote}</p>
    </div>
  )
}
