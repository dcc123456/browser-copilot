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
  const [draft, setDraft] = useState<Draft | null>(null)
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

  const save = async (): Promise<void> => {
    if (!draft) return
    const skill: Skill = {
      id: draft.id,
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      autoMatch: draft.autoMatch,
      createdAt: draft.createdAt,
      updatedAt: Date.now(),
    }
    try {
      const result = await sendCommand({ type: 'skills.save', skill })
      const saved = result.type === 'skills.save' ? result.skill : skill
      setBanner({ kind: 'ok', text: t.skillsSaved({ name: saved.name }) })
      setDraft(null)
      onChanged()
    } catch (error) {
      setBanner({ kind: 'error', text: describeError(error as Error) })
    }
  }

  const remove = async (skill: Skill): Promise<void> => {
    try {
      await sendCommand({ type: 'skills.delete', id: skill.id })
      setBanner({ kind: 'ok', text: t.skillsDeleted({ name: skill.name }) })
      if (draft?.id === skill.id) setDraft(null)
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
        {!draft && (
          <div className="actions">
            <button className="primary" onClick={() => setDraft(emptyDraft())} type="button">
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
        )}
      </div>

      {draft && (
        <div className="card">
          <div className="card-title">{draft.name.trim() || t.skillsAdd}</div>

          <label className="field">
            <span>{t.skillsName}</span>
            <input
              maxLength={60}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder={t.skillsNamePlaceholder}
              value={draft.name}
            />
          </label>

          <label className="field">
            <span>{t.skillsDescription}</span>
            <input
              maxLength={300}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              value={draft.description}
            />
          </label>
          <p className="hint">{t.skillsDescriptionHint}</p>

          <label className="field">
            <span>{t.skillsInstructions}</span>
            <textarea
              maxLength={8000}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              rows={10}
              value={draft.instructions}
            />
          </label>
          <p className="hint">{t.skillsInstructionsHint}</p>

          <label className="checkbox">
            <input
              checked={draft.autoMatch}
              onChange={(event) => setDraft({ ...draft, autoMatch: event.target.checked })}
              type="checkbox"
            />
            <span>{t.skillsAutoMatch}</span>
          </label>
          <p className="hint">{t.skillsAutoMatchHint}</p>

          <div className="actions">
            <button className="primary" onClick={() => void save()} type="button">
              {t.save}
            </button>
            <button onClick={() => setDraft(null)} type="button">
              {t.cancel}
            </button>
          </div>
        </div>
      )}

      {skills.length === 0 && !draft && <div className="empty">{t.skillsEmpty}</div>}

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
