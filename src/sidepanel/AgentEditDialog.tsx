/**
 * Agent create/edit dialog — the agent counterpart of SkillEditDialog.
 *
 * Mirrors that dialog's contract: the form owns the (possibly invalid) field
 * state; the caller validates, persists, and reports failures through `error`.
 * Remounts per open, so initial values need no sync effect.
 *
 * @module sidepanel/AgentEditDialog
 */
import { useState } from 'react'
import FormDialog, { FormDialogCancelButton, FormDialogPrimaryButton } from '../ui/FormDialog'
import { OPERATOR_META, TOOL_META, type ToolCategory } from '../lib/tool-catalog'
import type { AgentDomain, AgentRole, Skill } from '../lib/types'
import { useT } from './i18n'

/** Editable agent fields, shared by the Agents tab. */
export interface AgentFormValues {
  name: string
  delegationHint: string
  role: AgentRole
  domain: AgentDomain
  tools: string[]
  skillNames: string[]
  delegatable: boolean
  maxRounds: number
  instructions: string
}

interface Props {
  initial: AgentFormValues
  title: string
  saving?: boolean
  error?: string | null
  /** Saved skills, offered as injectable instructions for this agent. */
  skills: readonly Skill[]
  onSave: (values: AgentFormValues) => void
  onCancel: () => void
}

/**
 * load_tools is always available implicitly, delegate_to_agent is a
 * supervisor-only power, and compose_workflow is the supervisor's own
 * draft-management tool — none belong on a specialist whitelist. Workflow
 * operator tools (`wf_op_*`) ARE pickable so sub-agents can append to a
 * draft just like the supervisor can.
 */
const PICKABLE_TOOLS = [...TOOL_META, ...OPERATOR_META].filter(
  (meta) =>
    meta.name !== 'load_tools' &&
    meta.name !== 'delegate_to_agent' &&
    meta.name !== 'compose_workflow',
)

const CATEGORY_ORDER: ToolCategory[] = ['read', 'nav', 'act', 'data']

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

export default function AgentEditDialog({
  initial,
  title,
  saving = false,
  error = null,
  skills,
  onSave,
  onCancel,
}: Props): React.ReactElement {
  const t = useT()
  const [values, setValues] = useState<AgentFormValues>(initial)

  const domains: AgentDomain[] = [
    'search',
    'writing',
    'operations',
    'workflow',
    'analysis',
    'custom',
  ]
  const domainLabel: Record<AgentDomain, string> = {
    search: t.agentDomainSearch,
    writing: t.agentDomainWriting,
    operations: t.agentDomainOperations,
    workflow: t.agentDomainWorkflow,
    analysis: t.agentDomainAnalysis,
    custom: t.agentDomainCustom,
  }

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
        <div
          className="mb-3 rounded-lg border border-err bg-err-surface px-3 py-2 text-[12.5px] leading-relaxed break-words text-err"
          role="alert"
        >
          {error}
        </div>
      )}

      <label className="field">
        <span>{t.skillsName}</span>
        <input
          maxLength={60}
          onChange={(event) => setValues({ ...values, name: event.target.value })}
          placeholder="e.g. search-expert"
          value={values.name}
        />
      </label>

      <label className="field">
        <span>{t.agentRole}</span>
        <select
          onChange={(event) => setValues({ ...values, role: event.target.value as AgentRole })}
          value={values.role}
        >
          <option value="specialist">{t.agentRoleSpecialist}</option>
          <option value="supervisor">{t.agentRoleSupervisor}</option>
        </select>
      </label>

      {values.role === 'specialist' && (
        <label className="field">
          <span>{t.agentDomain}</span>
          <select
            onChange={(event) =>
              setValues({ ...values, domain: event.target.value as AgentDomain })
            }
            value={values.domain}
          >
            {domains.map((domain) => (
              <option key={domain} value={domain}>
                {domainLabel[domain]}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>{t.agentHint}</span>
        <input
          maxLength={300}
          onChange={(event) => setValues({ ...values, delegationHint: event.target.value })}
          value={values.delegationHint}
        />
      </label>
      <p className="hint">{t.agentHintHint}</p>

      <fieldset className="border-border">
        <legend className="text-[12.5px] font-medium text-muted">{t.agentTools}</legend>
        <div className="grid grid-cols-2 gap-x-3">
          {CATEGORY_ORDER.map((category) =>
            PICKABLE_TOOLS.filter((meta) => meta.category === category).map((meta) => (
              <label className="checkbox" key={meta.name}>
                <input
                  checked={values.tools.includes(meta.name)}
                  onChange={() => setValues({ ...values, tools: toggle(values.tools, meta.name) })}
                  type="checkbox"
                />
                <span>{t[meta.labelKey] as string}</span>
              </label>
            )),
          )}
        </div>
      </fieldset>
      <p className="hint">
        {t.agentToolsHint}
        {values.tools.length === 0 ? ` ${t.agentToolsInherit}` : ''}
      </p>

      {skills.length > 0 && (
        <>
          <fieldset className="border-border">
            <legend className="text-[12.5px] font-medium text-muted">{t.agentSkills}</legend>
            <div className="grid grid-cols-2 gap-x-3">
              {skills.map((skill) => (
                <label className="checkbox" key={skill.id}>
                  <input
                    checked={values.skillNames.includes(skill.name)}
                    onChange={() =>
                      setValues({ ...values, skillNames: toggle(values.skillNames, skill.name) })
                    }
                    type="checkbox"
                  />
                  <span>{skill.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="hint">{t.agentSkillsHint}</p>
        </>
      )}

      {values.role === 'supervisor' && (
        <>
          <label className="checkbox">
            <input
              checked={values.delegatable}
              onChange={(event) => setValues({ ...values, delegatable: event.target.checked })}
              type="checkbox"
            />
            <span>{t.agentDelegatable}</span>
          </label>
          <p className="hint">{t.agentDelegatableHint}</p>
        </>
      )}

      <label className="field">
        <span>{t.agentMaxRounds}</span>
        <input
          min={1}
          max={20}
          onChange={(event) => setValues({ ...values, maxRounds: Number(event.target.value) || 8 })}
          type="number"
          value={values.maxRounds}
        />
      </label>

      <label className="field">
        <span>{t.skillsInstructions}</span>
        <textarea
          maxLength={8000}
          onChange={(event) => setValues({ ...values, instructions: event.target.value })}
          rows={10}
          value={values.instructions}
        />
      </label>
    </FormDialog>
  )
}
