/**
 * Agents tab: create, edit, duplicate and delete supervisor/specialist
 * agents. Structure mirrors SkillsTab (top action card, dialog-based editing,
 * drag-and-drop import, per-entity cards); the list itself is owned by `App`
 * so future chat-side pickers can share it.
 *
 * Built-in agents are read-only: their only action is "duplicate as mine",
 * which saves a brand-new user-owned copy under a fresh id — the same policy
 * the skills tab uses for built-in skills.
 *
 * @module sidepanel/AgentsTab
 */
import { useRef, useState } from 'react'
import { sendCommand } from '../lib/messages'
import type { Agent, AgentDomain, Skill } from '../lib/types'
import {
  exportAgentsJson,
  importAgentsBatch,
  parseAgentFiles,
  type AgentImportProblem,
} from '../lib/agents-import'
import { downloadBlob } from '../lib/export-answer'
import { getBuiltinI18nKeys } from '../lib/builtin-agents'
import { useT } from './i18n'
import AgentEditDialog, { type AgentFormValues } from './AgentEditDialog'

interface Props {
  agents: Agent[]
  skills: Skill[]
  onChanged: () => void
}

interface Draft {
  id: string
  name: string
  delegationHint: string
  role: Agent['role']
  domain: AgentDomain
  tools: string[]
  skillNames: string[]
  delegatable: boolean
  maxRounds: number
  instructions: string
  createdAt: number
  /** Kept while editing a built-in so the save preserves its identity. */
  builtIn?: boolean
}

const newLocalId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

function toDraft(agent: Agent): Draft {
  return {
    id: agent.id,
    name: agent.name,
    delegationHint: agent.delegationHint,
    role: agent.role,
    domain: agent.domain,
    tools: [...agent.tools],
    skillNames: [...agent.skillNames],
    delegatable: agent.delegatable,
    maxRounds: agent.maxRounds,
    instructions: agent.instructions,
    createdAt: agent.createdAt,
    ...(agent.builtIn ? { builtIn: true as const } : {}),
  }
}

function emptyDraft(): Draft {
  return {
    id: newLocalId(),
    name: '',
    delegationHint: '',
    role: 'specialist',
    domain: 'custom',
    tools: [],
    skillNames: [],
    delegatable: false,
    maxRounds: 8,
    instructions: '',
    createdAt: Date.now(),
  }
}

export default function AgentsTab({ agents, skills, onChanged }: Props) {
  const t = useT()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const domainLabel: Record<AgentDomain, string> = {
    search: t.agentDomainSearch,
    writing: t.agentDomainWriting,
    operations: t.agentDomainOperations,
    workflow: t.agentDomainWorkflow,
    analysis: t.agentDomainAnalysis,
    custom: t.agentDomainCustom,
  }

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

  const importProblemTexts = (problem: AgentImportProblem): string[] =>
    problem.problems.map((item) => {
      const code = item.code
      if (code === 'nameRequired') return t.agentNameRequired
      if (code === 'instructionsRequired') return t.agentInstructionsRequired
      if (code === 'nameTaken') {
        const name = rawDisplayName(problem.raw)
        return t.agentsImportNameTaken({ name: name || t.agentsAdd })
      }
      return String(code)
    })

  /** Translates the worker's `agent:code,code` errors into localized text. */
  const describeError = (error: Error): string => {
    const message = error.message
    if (!message.startsWith('agent:')) return message
    const codes = message.slice('agent:'.length).split(',')
    const lookup: Record<string, string> = {
      nameRequired: t.agentNameRequired,
      instructionsRequired: t.agentInstructionsRequired,
      nameTaken: t.agentNameTaken,
    }
    return codes
      .map((code) => lookup[code] ?? code)
      .filter((text, index, all) => all.indexOf(text) === index)
      .join(' ')
  }

  const save = async (values: AgentFormValues): Promise<void> => {
    if (!draft) return
    const agent: Agent = {
      id: draft.id,
      name: values.name,
      role: values.role,
      domain: values.role === 'supervisor' ? 'custom' : values.domain,
      delegationHint: values.delegationHint,
      instructions: values.instructions,
      tools: values.tools,
      skillNames: values.skillNames,
      delegatable: values.role === 'supervisor' ? values.delegatable : false,
      maxRounds: values.maxRounds,
      createdAt: draft.createdAt,
      updatedAt: Date.now(),
      // A built-in keeps its marker through edits; reset restores shipped
      // content under the same id.
      ...(draft.builtIn ? { builtIn: true as const } : {}),
    }
    setSaving(true)
    setDraftError(null)
    try {
      const result = await sendCommand({ type: 'agents.save', agent })
      const saved = result.type === 'agents.save' ? result.agent : agent
      setBanner({ kind: 'ok', text: t.agentSaved({ name: saved.name }) })
      setDraft(null)
      onChanged()
    } catch (error) {
      setDraftError(describeError(error as Error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (agent: Agent): Promise<void> => {
    try {
      await sendCommand({ type: 'agents.delete', id: agent.id })
      setBanner({ kind: 'ok', text: t.agentDeleted({ name: agent.name }) })
      if (draft?.id === agent.id) {
        setDraft(null)
        setDraftError(null)
      }
      onChanged()
    } catch (error) {
      setBanner({ kind: 'error', text: describeError(error as Error) })
    }
  }

  /**
   * Restores an edited built-in to the shipped version under the same id
   * (the worker stamps updatedAt: 0 again, so future seed refreshes apply).
   */
  const resetBuiltIn = async (agent: Agent): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'agents.reset', id: agent.id })
      const restored = result.type === 'agents.reset' ? result.agent : agent
      if (draft?.id === agent.id) {
        setDraft(null)
        setDraftError(null)
      }
      setBanner({ kind: 'ok', text: t.agentResetDone({ name: restored.name }) })
      onChanged()
    } catch (error) {
      setBanner({ kind: 'error', text: describeError(error as Error) })
    }
  }

  const importFromFiles = async (files: File | File[] | FileList | null): Promise<void> => {
    if (!files || (files as File[]).length === 0) return
    setImporting(true)
    try {
      const parsed = await parseAgentFiles(files)
      const raws: unknown[] = []
      let fileFailures = 0
      for (const item of parsed) {
        if (!item.ok) {
          fileFailures += 1
          continue
        }
        raws.push(...item.raws)
      }

      const batch = importAgentsBatch(raws, agents)
      const detail: string[] = batch.problems.flatMap((problem) => importProblemTexts(problem))

      let persisted = 0
      for (const agent of batch.saved) {
        try {
          await sendCommand({ type: 'agents.save', agent })
          persisted += 1
        } catch {
          /* counted as failure below */
        }
      }

      const failed = fileFailures + batch.problems.length + (batch.saved.length - persisted)
      if (failed === 0) {
        setBanner({ kind: 'ok', text: t.agentsImportResultOk({ count: persisted }) })
      } else {
        const summary = t.agentsImportResultFail({ ok: persisted, failed })
        setBanner({
          kind: 'error',
          text: detail.length ? `${summary} ${detail.join(' ')}` : summary,
        })
      }
      if (persisted > 0) onChanged()
    } catch (error) {
      setBanner({ kind: 'error', text: (error as Error).message })
    } finally {
      setImporting(false)
    }
  }

  const exportAll = async (): Promise<void> => {
    // Built-ins re-seed on every install and re-import as user copies, so they
    // are excluded from the export.
    const mine = agents.filter((agent) => !agent.builtIn)
    if (mine.length === 0) {
      setBanner({ kind: 'error', text: t.agentsEmpty })
      return
    }
    const json = exportAgentsJson(mine)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await downloadBlob(json, 'application/json', `agents-${stamp}.json`)
  }

  return (
    <div
      className="pane"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        void importFromFiles(event.dataTransfer?.files ?? null)
      }}
    >
      {banner && (
        <div className="banner" data-kind={banner.kind}>
          {banner.text}
        </div>
      )}

      <div className="card">
        <div className="card-title">{t.agentsTitle}</div>
        <p className="hint">{t.agentsIntro}</p>
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              setDraftError(null)
              setDraft(emptyDraft())
            }}
            type="button"
          >
            {t.agentsAdd}
          </button>
          <button
            className="skills-import-btn"
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
            title={t.agentsImportHint}
            type="button"
          >
            {t.agentsImport}
          </button>
          <button
            className="skills-export-btn"
            disabled={agents.length === 0}
            onClick={exportAll}
            type="button"
          >
            {t.agentsExport}
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

      {draft && (
        <AgentEditDialog
          error={draftError}
          initial={{
            name: draft.name,
            delegationHint: draft.delegationHint,
            role: draft.role,
            domain: draft.domain,
            tools: draft.tools,
            skillNames: draft.skillNames,
            delegatable: draft.delegatable,
            maxRounds: draft.maxRounds,
            instructions: draft.instructions,
          }}
          saving={saving}
          skills={skills}
          title={draft.name.trim() || t.agentsAdd}
          onCancel={() => {
            setDraft(null)
            setDraftError(null)
          }}
          onSave={(values) => void save(values)}
        />
      )}

      {agents.length === 0 && <div className="empty">{t.agentsEmpty}</div>}

      {agents.map((agent) => {
        // Untouched built-in agents (updatedAt === 0) show i18n translations;
        // user-edited built-ins show their edited content.
        const builtinKeys = getBuiltinI18nKeys(agent.id)
        const isUntouchedBuiltin = agent.builtIn && agent.updatedAt === 0
        const displayName =
          isUntouchedBuiltin && builtinKeys.displayName
            ? (t[builtinKeys.displayName] as string)
            : agent.name
        const displayHint =
          isUntouchedBuiltin && builtinKeys.hint
            ? (t[builtinKeys.hint] as string)
            : agent.delegationHint
        return (
          <div className="card" key={agent.id}>
            <div className="card-title">
              {displayName}
              {isUntouchedBuiltin && displayName !== agent.name && (
                <span className="ml-1 text-[11px] text-muted">({agent.name})</span>
              )}
              {agent.builtIn && <span className="pill">{t.agentsBuiltinBadge}</span>}
              <span className="ml-1 rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
                {agent.role === 'supervisor' ? t.agentsDelegatablePill : domainLabel[agent.domain]}
              </span>
              <span className="pill">{t.agentsToolsCount({ count: agent.tools.length })}</span>
              {agent.role === 'specialist' && (
                <span className="pill">{t.agentsSpecialistPill}</span>
              )}
            </div>
            {displayHint && <p className="hint">{displayHint}</p>}
            <div className="actions">
              <button onClick={() => setDraft(toDraft(agent))} type="button">
                {t.edit}
              </button>
              {agent.builtIn ? (
                <button onClick={() => void resetBuiltIn(agent)} type="button">
                  {t.agentsReset}
                </button>
              ) : (
                <button onClick={() => void remove(agent)} type="button">
                  {t.delete}
                </button>
              )}
            </div>
          </div>
        )
      })}

      <p className="hint">{t.agentsBuiltinNote}</p>
    </div>
  )
}
