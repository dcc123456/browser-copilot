/**
 * EditTrigger — React port of Automa's EditTrigger + Trigger/* sub-forms.
 *
 * The "Trigger" block decides how a workflow starts. A workflow has exactly ONE
 * trigger, edited through the type dropdown; the main form shows that kind's
 * options:
 *
 *   manual             — no options
 *   interval           — interval + delay (minutes)
 *   date               — date + time
 *   specific-day       — weekdays + time
 *   visit-web          — URL match pattern + regex/SPA flags
 *   keyboard-shortcut  — shortcut (+ active-in-input)
 *   context-menu       — menu name + context types
 *   on-startup         — no options
 *   element-change     — observe a target element (SelectorField pick/verify +
 *                        MutationObserver options) and an optional base element
 *
 * Graphs imported from Automa can carry several trigger specs. Only the primary
 * (index 0) is editable here; the first edit collapses the list to that one, and
 * the form says so while the extra specs still exist. The "Parameters" fold-out
 * edits `data.parameters`, which is workflow-level, not per trigger.
 *
 * @module workflow-editor/blocks/batchD/EditTrigger
 */

import { CircleDot, Square, SquareTerminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EditFormProps } from '../EditForms'
import {
  Checkbox,
  Expand,
  Field,
  NumberInput,
  Select,
  TextArea,
  TextInput,
  type Patch,
} from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import SelectorField from '../shared/SelectorField'
import Modal from '../../ui/Modal'
import { useEditorLocale } from '../../locale-context'
import {
  newTriggerSpec,
  normalizeTriggers,
  writeTriggers,
  type WorkflowTriggerSpec,
} from '../../../lib/workflow/triggers'
import ParameterFields, { type WorkflowParameter } from './ParameterFields'
import WorkflowInfoFields from './WorkflowInfoFields'

/** Sub-forms receive the same data/patch channel without needing blockId. */
interface SubFormProps {
  data: Record<string, unknown>
  onChange: Patch
}

const TRIGGER_TYPES = [
  { value: 'manual', label: 'Manually' },
  { value: 'interval', label: 'Interval' },
  { value: 'date', label: 'On a specific date' },
  { value: 'specific-day', label: 'On a specific day' },
  { value: 'visit-web', label: 'When visiting a website' },
  { value: 'keyboard-shortcut', label: 'Keyboard shortcut' },
  { value: 'context-menu', label: 'Context menu' },
  { value: 'on-startup', label: 'On browser startup' },
  { value: 'element-change', label: 'On element change' },
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const CONTEXT_TYPES = [
  'audio',
  'editable',
  'image',
  'link',
  'page',
  'password',
  'selection',
  'video',
]

const OBSERVER_OPTIONS: {
  key: 'subtree' | 'childList' | 'attributes' | 'characterData'
  label: string
}[] = [
  { key: 'subtree', label: 'Include subtree' },
  { key: 'childList', label: 'Child list' },
  { key: 'attributes', label: 'Attributes' },
  { key: 'characterData', label: 'Character data' },
]

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

function stringFieldOf(spec: WorkflowTriggerSpec, key: string): string {
  const value = spec.data[key]
  return typeof value === 'string' ? value : ''
}

export default function EditTrigger({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const [paramsOpen, setParamsOpen] = useState(false)

  const specs = normalizeTriggers(data)
  // Only the primary trigger is editable; an imported multi-trigger graph keeps
  // the others until the first edit, which writes a one-entry list.
  const selected = specs[0]!
  const type = TRIGGER_TYPES.some((entry) => entry.value === selected.type)
    ? selected.type
    : 'manual'

  const days = asStringList(selected.data['days']).map((d) => String(d))
  const contextTypes = asStringList(selected.data['contextTypes'])

  const writeSelected = (spec: WorkflowTriggerSpec) => onChange(writeTriggers(data, [spec]))

  const patchSelected = (patch: Record<string, unknown>) =>
    writeSelected({ ...selected, data: { ...selected.data, ...patch } })

  const changeType = (nextType: string) => {
    // Switching kinds starts from that kind's defaults: keeping the previous
    // kind's fields would leave the trigger describing two things at once.
    writeSelected({ ...selected, type: nextType, data: newTriggerSpec(nextType).data })
  }

  const toggleListValue = (key: 'days' | 'contextTypes', value: string, checked: boolean) => {
    const current = key === 'days' ? days : contextTypes
    const next = checked ? [...current, value] : current.filter((v) => v !== value)
    patchSelected({ [key]: next })
  }

  return (
    <div className="wf-form">
      {/* Workflow name / description / run settings live on the trigger block
          (Automa keeps workflow config with the trigger, not a separate tab). */}
      <WorkflowInfoFields />

      {/* Automa EditTrigger: bare description textarea, no label. */}
      <Field>
        <TextArea
          value={str(data, 'description')}
          placeholder="Description"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      {specs.length > 1 && (
        <p className="wf-hint">
          {bt('This workflow has extra triggers. Editing keeps only the first one.')}
        </p>
      )}

      <Field label="Trigger workflow">
        <Select value={type} onChange={changeType} options={TRIGGER_TYPES} />
      </Field>

      {type === 'interval' && (
        <>
          <Field label="Interval (minutes)">
            <NumberInput
              value={num(selected.data, 'interval', 60)}
              min={1}
              max={360}
              fallback={60}
              onChange={(n) => patchSelected({ interval: n })}
            />
          </Field>
          <Field label="Delay (minutes)">
            <NumberInput
              value={num(selected.data, 'delay', 5)}
              min={0}
              max={20}
              fallback={5}
              onChange={(n) => patchSelected({ delay: n })}
            />
          </Field>
        </>
      )}

      {type === 'date' && (
        <>
          <Field label="Date">
            <TextInput
              type="date"
              value={stringFieldOf(selected, 'date')}
              onChange={(v) => patchSelected({ date: v })}
            />
          </Field>
          <Field label="Time">
            <TextInput
              type="time"
              value={stringFieldOf(selected, 'time')}
              fallback="00:00"
              onChange={(v) => patchSelected({ time: v })}
            />
          </Field>
        </>
      )}

      {type === 'specific-day' && (
        <>
          <Field label="Select day">
            <div className="wf-checkbox-grid">
              {WEEKDAYS.map((label, id) => (
                <Checkbox
                  key={id}
                  checked={days.includes(String(id))}
                  onChange={(c) => toggleListValue('days', String(id), c)}
                  label={label}
                />
              ))}
            </div>
          </Field>
          <Field label="Time">
            <TextInput
              type="time"
              value={stringFieldOf(selected, 'time')}
              fallback="00:00"
              onChange={(v) => patchSelected({ time: v })}
            />
          </Field>
        </>
      )}

      {type === 'visit-web' && (
        <>
          <Field label="URL or Regex">
            <TextInput
              value={stringFieldOf(selected, 'url')}
              placeholder="https://example.com/*"
              onChange={(v) => patchSelected({ url: v })}
            />
          </Field>
          <Checkbox
            checked={bool(selected.data, 'isUrlRegex')}
            onChange={(v) => patchSelected({ isUrlRegex: v })}
            label="Use regex"
          />
        </>
      )}

      {type === 'keyboard-shortcut' && (
        <ShortcutFields data={selected.data} onChange={patchSelected} />
      )}

      {type === 'context-menu' && (
        <>
          <Field label="Workflow name in the context menu">
            <TextInput
              value={stringFieldOf(selected, 'contextMenuName')}
              placeholder="Context menu item name"
              onChange={(v) => patchSelected({ contextMenuName: v })}
            />
          </Field>
          <Field label="Will appear in">
            <div className="wf-checkbox-grid">
              {CONTEXT_TYPES.map((ct) => (
                <Checkbox
                  key={ct}
                  checked={contextTypes.includes(ct)}
                  onChange={(c) => toggleListValue('contextTypes', ct, c)}
                  label={ct.charAt(0).toUpperCase() + ct.slice(1)}
                />
              ))}
            </div>
          </Field>
        </>
      )}

      {type === 'element-change' && (
        <ElementChangeFields data={selected.data} onChange={patchSelected} />
      )}

      {type === 'on-startup' && (
        <p className="wf-hint">{bt('The workflow runs when the browser starts.')}</p>
      )}
      {type === 'manual' && (
        <p className="wf-hint">{bt('The workflow runs only when started manually.')}</p>
      )}

      {/* Automa EditTrigger: a "Parameters" button opens the parameters modal
          (EditWorkflowParameters) instead of an inline fold-out. */}
      <button type="button" className="wf-params-btn" onClick={() => setParamsOpen(true)}>
        <SquareTerminal size={14} />
        <span>{bt('Parameters')}</span>
      </button>

      <Modal
        open={paramsOpen}
        onClose={() => setParamsOpen(false)}
        title={bt('Parameters')}
        size="lg"
      >
        <ParameterFields
          value={data.parameters}
          onChange={(parameters: WorkflowParameter[]) => onChange({ parameters })}
          preferTab={bool(data, 'preferParamsInTab')}
          onPreferTab={(v) => onChange({ preferParamsInTab: v })}
        />
      </Modal>
    </div>
  )
}

/** Record-a-keyboard-shortcut field (ports TriggerKeyboardShortcut). */
function ShortcutFields({ data, onChange }: SubFormProps) {
  const { bt } = useEditorLocale()
  const [recording, setRecording] = useState(false)
  const shortcut = str(data, 'shortcut')

  useEffect(() => {
    if (!recording) return
    const onKeydown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const parts: string[] = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.metaKey) parts.push('Meta')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      const key = event.key
      if (key && !['Control', 'Meta', 'Alt', 'Shift'].includes(key)) {
        parts.push(key.length === 1 ? key.toUpperCase() : key)
      }
      if (parts.length) onChange({ shortcut: parts.join('+') })
    }
    const onKeyup = () => setRecording(false)
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('keyup', onKeyup, true)
    return () => {
      window.removeEventListener('keydown', onKeydown, true)
      window.removeEventListener('keyup', onKeyup, true)
    }
  }, [recording, onChange])

  return (
    <>
      <Field label="Shortcut">
        <div className="wf-selector-row">
          <input value={shortcut} readOnly placeholder={bt('Record a shortcut')} />
          <button
            type="button"
            className="wf-icon-btn"
            title={recording ? bt('Stop recording') : bt('Record shortcut')}
            onClick={() => setRecording((r) => !r)}
          >
            {recording ? <Square size={14} /> : <CircleDot size={14} />}
          </button>
        </div>
      </Field>
      <Checkbox
        checked={bool(data, 'activeInInput')}
        onChange={(v) => onChange({ activeInInput: v })}
        label="Active while in input"
        title="Execute shortcut even when you're in an input element"
      />
      <p className="wf-hint">
        {bt("Note: keyboard shortcut only works when you're on a webpage.")}
      </p>
    </>
  )
}

interface ObserveOptions {
  subtree: boolean
  childList: boolean
  attributes: boolean
  attributeFilter: string[]
  characterData: boolean
}

const DEFAULT_OBSERVE_OPTIONS: ObserveOptions = {
  subtree: false,
  childList: true,
  attributes: false,
  attributeFilter: [],
  characterData: false,
}

function asObserveOptions(value: unknown): ObserveOptions {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_OBSERVE_OPTIONS }
  const o = value as Record<string, unknown>
  return {
    subtree: o.subtree === true,
    childList: o.childList !== false,
    attributes: o.attributes === true,
    attributeFilter: Array.isArray(o.attributeFilter)
      ? o.attributeFilter.filter((x): x is string => typeof x === 'string')
      : [],
    characterData: o.characterData === true,
  }
}

/** Element-change trigger — observe a target element (ports TriggerElementChange). */
function ElementChangeFields({ data, onChange }: SubFormProps) {
  const { bt } = useEditorLocale()
  const observe =
    typeof data.observeElement === 'object' && data.observeElement !== null
      ? (data.observeElement as Record<string, unknown>)
      : {}
  const targetOptions = asObserveOptions(observe.targetOptions)
  const baseOptions = asObserveOptions(observe.baseElOptions)
  const baseSelector = str(observe, 'baseSelector')
  const matchPattern = str(observe, 'matchPattern')

  const patchTarget = (patch: Partial<ObserveOptions>) =>
    onChange({ observeElement: { ...observe, targetOptions: { ...targetOptions, ...patch } } })
  const patchBase = (patch: Partial<ObserveOptions>) =>
    onChange({ observeElement: { ...observe, baseElOptions: { ...baseOptions, ...patch } } })

  const renderOptions = (options: ObserveOptions, patch: (p: Partial<ObserveOptions>) => void) => (
    <div className="wf-observer-options">
      {OBSERVER_OPTIONS.map(({ key, label }) => (
        <Checkbox
          key={key}
          checked={options[key]}
          onChange={(v) => patch({ [key]: v })}
          label={label}
        />
      ))}
      {options.attributes && (
        <Field label="Attribute filter">
          <TextInput
            value={options.attributeFilter.join(',')}
            placeholder="id,label,class"
            onChange={(v) =>
              patch({
                attributeFilter: v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <span className="wf-hint">{bt('Use commas (,) to separate attribute names')}</span>
        </Field>
      )}
    </div>
  )

  return (
    <div className="wf-element-change">
      <Field label="Match pattern">
        <TextInput
          value={matchPattern}
          placeholder="https://example.com/*"
          onChange={(v) => onChange({ observeElement: { ...observe, matchPattern: v } })}
        />
      </Field>

      {/* Target element selector with pick/verify (shared SelectorField — the
          record is nested under observeElement, so value-driven props). */}
      <SelectorField
        selector={str(observe, 'selector')}
        onSelector={(v) => onChange({ observeElement: { ...observe, selector: v } })}
      />
      <Expand title="Target element options">{renderOptions(targetOptions, patchTarget)}</Expand>

      <Field label="Base element (optional)">
        <TextArea
          mono
          value={baseSelector}
          placeholder="CSS selector or XPath"
          onChange={(v) => onChange({ observeElement: { ...observe, baseSelector: v } })}
        />
        <span className="wf-hint">
          {bt('Automa restarts observing the target element when this element changes.')}
        </span>
      </Field>
      <Expand title="Base element options">{renderOptions(baseOptions, patchBase)}</Expand>
    </div>
  )
}
