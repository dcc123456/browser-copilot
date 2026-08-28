/**
 * EditTrigger — React port of Automa's EditTrigger + Trigger/* sub-forms.
 *
 * The "Trigger" block decides how a workflow starts. The catalog stores a flat
 * trigger payload (`type` plus the shared fields used by every trigger type),
 * so this form renders one field set per `type`:
 *
 *   manual             — no options
 *   interval           — interval + delay (minutes)
 *   date               — date + time
 *   specific-day       — weekdays + time
 *   visit-web          — URL match pattern + regex/SPA flags
 *   keyboard-shortcut  — shortcut (+ active-in-input)
 *   context-menu       — menu name + context types
 *   on-startup         — no options
 *   element-change     — observe a target element (InteractionBase selector +
 *                        MutationObserver options) and an optional base element
 *
 * Automa's newer build wraps these in a multi-trigger modal, but the flat
 * catalog shape (src/lib/workflow/blocks/catalog.ts) maps 1:1 to this form.
 * The "Parameters" fold-out edits `data.parameters`.
 *
 * @module workflow-editor/blocks/batchD/EditTrigger
 */

import { useEffect, useRef, useState } from 'react'
import type { EditFormProps } from '../EditForms'
import { Checkbox, Expand, Field, Select, TextArea, TextInput, type Patch } from '../shared/Field'
import InteractionBase, { bool, num, str } from '../shared/InteractionBase'
import Modal from '../../ui/Modal'
import { useEditorLocale } from '../../locale-context'
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

const CONTEXT_TYPES = ['audio', 'editable', 'image', 'link', 'page', 'password', 'selection', 'video']

const OBSERVER_OPTIONS: { key: 'subtree' | 'childList' | 'attributes' | 'characterData'; label: string }[] = [
  { key: 'subtree', label: 'Include subtree' },
  { key: 'childList', label: 'Child list' },
  { key: 'attributes', label: 'Attributes' },
  { key: 'characterData', label: 'Character data' },
]

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min
  return Math.min(max, Math.max(min, v))
}

export default function EditTrigger({ data, onChange }: EditFormProps) {
  const { bt } = useEditorLocale()
  const [paramsOpen, setParamsOpen] = useState(false)
  const type = str(data, 'type') || 'manual'

  const days = asStringList(data.days).map((d) => String(d))
  const contextTypes = asStringList(data.contextTypes)

  const toggleListValue = (key: 'days' | 'contextTypes', value: string, checked: boolean) => {
    const current = key === 'days' ? days : contextTypes
    const next = checked ? [...current, value] : current.filter((v) => v !== value)
    onChange({ [key]: next })
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

      <Field label="Trigger workflow">
        <Select value={type} onChange={(v) => onChange({ type: v })} options={TRIGGER_TYPES} />
      </Field>

      {type === 'interval' && (
        <>
          <Field label="Interval (minutes)">
            <TextInput
              type="number"
              value={num(data, 'interval', 60)}
              onChange={(v) => onChange({ interval: clamp(Number(v), 1, 360) })}
            />
          </Field>
          <Field label="Delay (minutes)">
            <TextInput
              type="number"
              value={num(data, 'delay', 5)}
              onChange={(v) => onChange({ delay: clamp(Number(v), 0, 20) })}
            />
          </Field>
        </>
      )}

      {type === 'date' && (
        <>
          <Field label="Date">
            <TextInput type="date" value={str(data, 'date')} onChange={(v) => onChange({ date: v })} />
          </Field>
          <Field label="Time">
            <TextInput type="time" value={str(data, 'time') || '00:00'} onChange={(v) => onChange({ time: v || '00:00' })} />
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
            <TextInput type="time" value={str(data, 'time') || '00:00'} onChange={(v) => onChange({ time: v || '00:00' })} />
          </Field>
        </>
      )}

      {type === 'visit-web' && (
        <>
          <Field label="URL or Regex">
            <TextInput value={str(data, 'url')} placeholder="https://example.com/*" onChange={(v) => onChange({ url: v })} />
          </Field>
          <Checkbox checked={bool(data, 'isUrlRegex')} onChange={(v) => onChange({ isUrlRegex: v })} label="Use regex" />
        </>
      )}

      {type === 'keyboard-shortcut' && <ShortcutFields data={data} onChange={onChange} />}

      {type === 'context-menu' && (
        <>
          <Field label="Workflow name in the context menu">
            <TextInput
              value={str(data, 'contextMenuName')}
              placeholder="Context menu item name"
              onChange={(v) => onChange({ contextMenuName: v })}
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

      {type === 'element-change' && <ElementChangeFields data={data} onChange={onChange} />}

      {type === 'on-startup' && <p className="wf-hint">The workflow runs when the browser starts.</p>}
      {type === 'manual' && <p className="wf-hint">The workflow runs only when started manually.</p>}

      {/* Automa EditTrigger: a "Parameters" button opens the parameters modal
          (EditWorkflowParameters) instead of an inline fold-out. */}
      <button type="button" className="wf-params-btn" onClick={() => setParamsOpen(true)}>
        <i className="ri-command-line" />
        <span>{bt('Parameters')}</span>
      </button>

      <Modal open={paramsOpen} onClose={() => setParamsOpen(false)} title={bt('Parameters')} size="lg">
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
          <input value={shortcut} readOnly placeholder="Record a shortcut" />
          <button
            type="button"
            className="wf-icon-btn"
            title={recording ? 'Stop recording' : 'Record shortcut'}
            onClick={() => setRecording((r) => !r)}
          >
            <i className={recording ? 'ri-stop-line' : 'ri-record-circle-line'} />
          </button>
        </div>
      </Field>
      <Checkbox
        checked={bool(data, 'activeInInput')}
        onChange={(v) => onChange({ activeInInput: v })}
        label="Active while in input"
        title="Execute shortcut even when you're in an input element"
      />
      <p className="wf-hint">Note: keyboard shortcut only works when you're on a webpage.</p>
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
    attributeFilter: Array.isArray(o.attributeFilter) ? o.attributeFilter.filter((x): x is string => typeof x === 'string') : [],
    characterData: o.characterData === true,
  }
}

/** Element-change trigger — observe a target element (ports TriggerElementChange). */
function ElementChangeFields({ data, onChange }: SubFormProps) {
  const observe =
    typeof data.observeElement === 'object' && data.observeElement !== null
      ? (data.observeElement as Record<string, unknown>)
      : {}
  const targetOptions = asObserveOptions(observe.targetOptions)
  const baseOptions = asObserveOptions(observe.baseElOptions)
  const baseSelector = str(observe, 'baseSelector')
  const matchPattern = str(observe, 'matchPattern')

  // InteractionBase drives selector pick/verify on a shimmed record.
  const shim = useRef<Record<string, unknown>>({})
  shim.current = {
    selector: str(observe, 'selector'),
    findBy: 'cssSelector',
    multiple: true, // hide the "multiple elements" checkbox (irrelevant here)
    markEl: false,
    waitForSelector: false,
    waitSelectorTimeout: 5000,
  }
  const patchShim = (patch: Record<string, unknown>) => {
    if ('selector' in patch) onChange({ observeElement: { ...observe, selector: String(patch.selector ?? '') } })
  }

  const patchTarget = (patch: Partial<ObserveOptions>) =>
    onChange({ observeElement: { ...observe, targetOptions: { ...targetOptions, ...patch } } })
  const patchBase = (patch: Partial<ObserveOptions>) =>
    onChange({ observeElement: { ...observe, baseElOptions: { ...baseOptions, ...patch } } })

  const renderOptions = (
    options: ObserveOptions,
    patch: (p: Partial<ObserveOptions>) => void,
  ) => (
    <div className="wf-observer-options">
      {OBSERVER_OPTIONS.map(({ key, label }) => (
        <Checkbox key={key} checked={options[key]} onChange={(v) => patch({ [key]: v })} label={label} />
      ))}
      {options.attributes && (
        <Field label="Attribute filter">
          <TextInput
            value={options.attributeFilter.join(',')}
            placeholder="id,label,class"
            onChange={(v) => patch({ attributeFilter: v.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
          <span className="wf-hint">Use commas (,) to separate attribute names</span>
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

      {/* Target element selector with pick/verify (InteractionBase). */}
      <InteractionBase
        data={shim.current}
        onChange={patchShim}
        hideDescription
        hideMultiple
        hideMarkEl
      >
        <Expand title="Target element options">
          {renderOptions(targetOptions, patchTarget)}
        </Expand>
      </InteractionBase>

      <Field label="Base element (optional)">
        <TextArea
          mono
          value={baseSelector}
          placeholder="CSS selector or XPath"
          onChange={(v) => onChange({ observeElement: { ...observe, baseSelector: v } })}
        />
        <span className="wf-hint">Automa restarts observing the target element when this element changes.</span>
      </Field>
      <Expand title="Base element options">{renderOptions(baseOptions, patchBase)}</Expand>
    </div>
  )
}
