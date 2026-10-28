/**
 * EditAiAgent — Browser-Copilot's own "AI agent" block form.
 *
 * Unlike the Automa-ported forms, this block does not exist upstream: at
 * runtime it reads a target element's text, hands it plus the user's prompt to
 * the tool-calling agent loop, and stores the agent's final answer in a
 * variable. The form therefore collects:
 *   - a description (shown on the node)
 *   - an optional target element (CSS/XPath selector with pick/verify)
 *   - the user's prompt (supports {{variable}} interpolation)
 *   - an "act on page" switch (off = read-only analysis, on = full-auto)
 *   - advanced: tool-round budget, output variable name, auto-snapshot
 *
 * @module workflow-editor/blocks/batchD/EditAiAgent
 */

import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { messagesFor } from '../../../lib/i18n'
import { sendCommand } from '../../../lib/messages'
import { PLAN_SKILL_NAME } from '../../../lib/skills'
import { BRIDGE_ONLY_TOOLS, TOOL_META } from '../../../lib/tool-catalog'
import type { Skill } from '../../../lib/types'
import type { EditFormProps } from '../EditForms'
import { useEditorLocale } from '../../locale-context'
import {
  Checkbox,
  Expand,
  Field,
  IconButton,
  NumberInput,
  TextArea,
  TextInput,
} from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import SelectorField from '../shared/SelectorField'

/**
 * Tools with no meaning inside a workflow block: bridge-only tools never reach
 * an unattended turn, `ask_user` is withheld without a panel to answer it, and
 * `compose_workflow` exists only in workflow-generation mode. Listing them
 * would offer switches that can never change anything.
 */
const BLOCK_UNAVAILABLE_TOOLS: ReadonlySet<string> = new Set([
  ...BRIDGE_ONLY_TOOLS,
  'ask_user',
  'compose_workflow',
])

/** Read a stored deny list; absent reads as "nothing disabled". */
function nameList(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Add (disabled) or remove (enabled) one name, keeping the list order stable. */
function toggledName(names: string[], name: string, enabled: boolean): string[] {
  if (enabled) return names.filter((entry) => entry !== name)
  return names.includes(name) ? names : [...names, name]
}

export default function EditAiAgent({ data, onChange }: EditFormProps) {
  const { bt, locale } = useEditorLocale()
  const findBy = str(data, 'findBy') || 'cssSelector'
  const selector = str(data, 'selector')
  const actOnPage = bool(data, 'actOnPage')
  const disabledTools = nameList(data, 'disabledTools')
  const disabledSkills = nameList(data, 'disabledSkills')

  // The block's capability list needs the saved skills, which live in the
  // worker's store. A failure only hides the skill toggles — the rest of the
  // form (and the already-stored switches) keeps working, so the author can
  // still save; the retry button reloads the list.
  const [skills, setSkills] = useState<Skill[]>([])
  const [skillsFailed, setSkillsFailed] = useState(false)
  const reloadSkills = useCallback(() => {
    setSkillsFailed(false)
    void sendCommand({ type: 'skills.list' })
      .then((result) => {
        if (result.type === 'skills.list') setSkills(result.skills)
      })
      .catch(() => setSkillsFailed(true))
  }, [])
  useEffect(() => {
    reloadSkills()
  }, [reloadSkills])

  const t = messagesFor(locale === 'zh' ? 'zh-CN' : 'en')
  const selectableSkills = skills.filter((skill) => skill.name !== PLAN_SKILL_NAME)
  const selectableTools = TOOL_META.filter((meta) => !BLOCK_UNAVAILABLE_TOOLS.has(meta.name))

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      <SelectorField
        label="Target element (optional)"
        data={data}
        selector={selector}
        onSelector={(sel) => onChange({ selector: sel })}
        findBy={findBy}
        onFindBy={(v) => onChange({ findBy: v })}
      />
      <p className="wf-form-note">
        {bt(
          "The matched element's text is read at runtime and given to the agent. Leave it empty and the agent reads the page itself via its tools.",
        )}
      </p>

      <Field label="Prompt *">
        <TextArea
          rows={5}
          value={str(data, 'prompt')}
          placeholder={
            'e.g. Summarize the price in this element and fill the coupon code box.\nUse {{variableName}} to insert a workflow variable.'
          }
          onChange={(v) => onChange({ prompt: v })}
        />
      </Field>

      <Checkbox
        checked={actOnPage}
        onChange={(v) => onChange({ actOnPage: v })}
        label={bt('Allow the agent to act on the page (click, fill, navigate)')}
        title={bt(
          'Off: the agent only reads and analyzes (read-only). On: it performs actions autonomously without per-step confirmation.',
        )}
      />
      <p className="wf-form-note">
        {actOnPage
          ? bt(
              'Full auto: the agent may click, type, and navigate to finish the task. Every action is written to the run log.',
            )
          : bt(
              'Read-only: the agent can read/snapshot the page and answer, but cannot click, type, or navigate.',
            )}
      </p>

      <Expand title="Skills & tools">
        <p className="wf-form-note">
          {bt(
            'Everything is enabled by default. Turning a skill or tool off removes it from the model request, which lowers token cost.',
          )}
        </p>

        <Field label="Skills">
          {skillsFailed && (
            <div className="flex items-center gap-2">
              <p className="wf-form-note">{bt('Could not load saved skills.')}</p>
              <IconButton icon={RefreshCw} title="Reload skills" onClick={reloadSkills} />
            </div>
          )}
          {selectableSkills.length > 0 && (
            <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto pr-1">
              {selectableSkills.map((skill) => (
                <Checkbox
                  key={skill.id}
                  checked={!disabledSkills.includes(skill.name)}
                  label={<span className="text-xs">{skill.name}</span>}
                  title={skill.description || skill.name}
                  onChange={(enabled) =>
                    onChange({
                      disabledSkills: toggledName(disabledSkills, skill.name, enabled),
                    })
                  }
                />
              ))}
            </div>
          )}
          {selectableSkills.length === 0 && !skillsFailed && (
            <p className="wf-form-note">{bt('No saved skills.')}</p>
          )}
        </Field>

        <Field label="Tools">
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto pr-1">
            {selectableTools.map((meta) => (
              <Checkbox
                key={meta.name}
                checked={!disabledTools.includes(meta.name)}
                label={
                  <span className="flex items-baseline gap-2 text-xs">
                    <span>{t[meta.labelKey]}</span>
                    <span className="font-mono text-[11px] text-muted">{meta.name}</span>
                  </span>
                }
                title={t[meta.warningKey]}
                onChange={(enabled) =>
                  onChange({ disabledTools: toggledName(disabledTools, meta.name, enabled) })
                }
              />
            ))}
          </div>
        </Field>
      </Expand>

      <Expand title="Advanced">
        <Field label="Max tool rounds">
          <NumberInput
            value={num(data, 'maxToolRounds', 20)}
            min={1}
            max={50}
            fallback={20}
            onChange={(n) => onChange({ maxToolRounds: n })}
          />
        </Field>
        <Field label="Output variable name">
          <TextInput
            value={str(data, 'variableName')}
            placeholder="lastAIAgent"
            fallback="lastAIAgent"
            onChange={(v) => onChange({ variableName: v })}
            noSlash
          />
        </Field>
        <Checkbox
          checked={bool(data, 'useSnapshot')}
          onChange={(v) => onChange({ useSnapshot: v })}
          label="Take a page snapshot before acting"
          title="Lets the agent list buttons/links/fields so it can locate elements itself."
        />
      </Expand>
    </div>
  )
}
