/**
 * Skills tab: create, edit, and delete reusable instruction packs.
 *
 * The list is owned by `App` because Chat needs it too; this tab only edits and
 * reports changes upward.
 *
 * @module sidepanel/SkillsTab
 */
import { useState } from 'react'
import { sendCommand } from '../lib/messages'
import type { Skill } from '../lib/types'
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

  return (
    <div className="pane">
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
