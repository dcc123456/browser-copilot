/**
 * EditTriggerEvent — "Trigger event" block form.
 *
 * React port of Automa's EditTriggerEvent.vue and its sub-components under
 * edit/TriggerEvent/ (mouse / touch / keyboard / wheel / input). The event
 * picker selects an event from `eventList` (块目录定义); the
 * "Options" fold-out holds the shared Bubbles/Cancelable flags plus the
 * event-specific parameters (modifier keys, mouse button & coordinates,
 * wheel deltas, keyboard key details, input-event data, …).
 *
 * Selecting an event resets `eventParams` to `{ bubbles: true, cancelable:
 * true }` (Automa behavior). The info icon links to the MDN event reference.
 *
 * @module workflow-editor/blocks/batchA/EditTriggerEvent
 */
import { type ReactNode } from 'react'
import { Checkbox, Expand, Field, Select, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { str } from '../shared/InteractionBase'

interface EventDef {
  id: string
  name: string
  type: string
}

const EVENT_LIST: EventDef[] = [
  { id: 'click', name: 'Click', type: 'mouse-event' },
  { id: 'dblclick', name: 'Double Click', type: 'mouse-event' },
  { id: 'mouseup', name: 'Mouseup', type: 'mouse-event' },
  { id: 'mousedown', name: 'Mousedown', type: 'mouse-event' },
  { id: 'mouseenter', name: 'Mouseenter', type: 'mouse-event' },
  { id: 'mouseleave', name: 'Mouseleave', type: 'mouse-event' },
  { id: 'mouseover', name: 'Mouseover', type: 'mouse-event' },
  { id: 'mouseout', name: 'Mouseout', type: 'mouse-event' },
  { id: 'mousemove', name: 'Mousemove', type: 'mouse-event' },
  { id: 'focus', name: 'Focus', type: 'focus-event' },
  { id: 'blur', name: 'Blur', type: 'focus-event' },
  { id: 'input', name: 'Input', type: 'input-event' },
  { id: 'change', name: 'Change', type: 'event' },
  { id: 'touchstart', name: 'Touch start', type: 'touch-event' },
  { id: 'touchend', name: 'Touch end', type: 'touch-event' },
  { id: 'touchmove', name: 'Touch move', type: 'touch-event' },
  { id: 'touchcancel', name: 'Touch cancel', type: 'touch-event' },
  { id: 'keydown', name: 'Keydown', type: 'keyboard-event' },
  { id: 'keyup', name: 'Keyup', type: 'keyboard-event' },
  { id: 'submit', name: 'Submit', type: 'submit-event' },
  { id: 'wheel', name: 'Wheel', type: 'wheel-event' },
]

const MODIFIER_KEYS = ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const

/** Single-character key -> { code, keyCode } for the keyboard-event auto-fill
 *  (TriggerEventKeyboard.findKeyDefintion; subset of USKeyboardLayout). */
const KEY_DEFINITIONS: Record<string, { code: string; keyCode: number }> = {
  '0': { code: 'Digit0', keyCode: 48 }, '1': { code: 'Digit1', keyCode: 49 },
  '2': { code: 'Digit2', keyCode: 50 }, '3': { code: 'Digit3', keyCode: 51 },
  '4': { code: 'Digit4', keyCode: 52 }, '5': { code: 'Digit5', keyCode: 53 },
  '6': { code: 'Digit6', keyCode: 54 }, '7': { code: 'Digit7', keyCode: 55 },
  '8': { code: 'Digit8', keyCode: 56 }, '9': { code: 'Digit9', keyCode: 57 },
  ' ': { code: 'Space', keyCode: 32 },
  a: { code: 'KeyA', keyCode: 65 }, b: { code: 'KeyB', keyCode: 66 },
  c: { code: 'KeyC', keyCode: 67 }, d: { code: 'KeyD', keyCode: 68 },
  e: { code: 'KeyE', keyCode: 69 }, f: { code: 'KeyF', keyCode: 70 },
  g: { code: 'KeyG', keyCode: 71 }, h: { code: 'KeyH', keyCode: 72 },
  i: { code: 'KeyI', keyCode: 73 }, j: { code: 'KeyJ', keyCode: 74 },
  k: { code: 'KeyK', keyCode: 75 }, l: { code: 'KeyL', keyCode: 76 },
  m: { code: 'KeyM', keyCode: 77 }, n: { code: 'KeyN', keyCode: 78 },
  o: { code: 'KeyO', keyCode: 79 }, p: { code: 'KeyP', keyCode: 80 },
  q: { code: 'KeyQ', keyCode: 81 }, r: { code: 'KeyR', keyCode: 82 },
  s: { code: 'KeyS', keyCode: 83 }, t: { code: 'KeyT', keyCode: 84 },
  u: { code: 'KeyU', keyCode: 85 }, v: { code: 'KeyV', keyCode: 86 },
  w: { code: 'KeyW', keyCode: 87 }, x: { code: 'KeyX', keyCode: 88 },
  y: { code: 'KeyY', keyCode: 89 }, z: { code: 'KeyZ', keyCode: 90 },
  '*': { code: 'NumpadMultiply', keyCode: 106 }, '+': { code: 'NumpadAdd', keyCode: 107 },
  '-': { code: 'Minus', keyCode: 189 }, '/': { code: 'Slash', keyCode: 191 },
  ';': { code: 'Semicolon', keyCode: 186 }, '=': { code: 'NumpadEqual', keyCode: 187 },
  ',': { code: 'Comma', keyCode: 188 }, '.': { code: 'Period', keyCode: 190 },
  '`': { code: 'Backquote', keyCode: 192 }, '[': { code: 'BracketLeft', keyCode: 219 },
  '\\': { code: 'Backslash', keyCode: 220 }, ']': { code: 'BracketRight', keyCode: 221 },
  "'": { code: 'Quote', keyCode: 222 },
}

type Params = Record<string, unknown>

function getParams(data: Record<string, unknown>): Params {
  const p = data.eventParams
  return p && typeof p === 'object' ? (p as Params) : {}
}

function paramBool(params: Params, key: string): boolean {
  return params[key] === true
}
function paramNum(params: Params, key: string, fallback = 0): number {
  const v = params[key]
  return typeof v === 'number' ? v : fallback
}
function paramStr(params: Params, key: string, fallback = ''): string {
  const v = params[key]
  return typeof v === 'string' ? v : fallback
}

function ModifierCheckboxes({
  params,
  update,
}: {
  params: Params
  update: (patch: Params) => void
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {MODIFIER_KEYS.map((key) => (
        <Checkbox
          key={key}
          checked={paramBool(params, key)}
          onChange={(v) => update({ [key]: v })}
          label={key}
        />
      ))}
    </div>
  )
}

function MouseEventParams({ params, update }: { params: Params; update: (p: Params) => void }) {
  const button = paramNum(params, 'button', 0)
  const posGroups: [string, string][] = [
    ['clientX', 'clientY'],
    ['movementX', 'movementY'],
    ['offsetX', 'offsetY'],
    ['pageX', 'pageY'],
    ['screenX', 'screenY'],
  ]
  return (
    <>
      <ModifierCheckboxes params={params} update={update} />
      <div style={{ marginTop: 8 }}>
        <Field label="Button">
          <Select
            value={String(button)}
            onChange={(v) => update({ button: Number(v) })}
            options={[
              { value: '0', label: 'Left click' },
              { value: '1', label: 'Middle click' },
              { value: '2', label: 'Right click' },
            ]}
          />
        </Field>
      </div>
      {posGroups.map(([xKey, yKey]) => {
        const isClient = xKey.startsWith('client')
        return (
          <div key={xKey} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Field label={xKey}>
              {isClient ? (
                // clientX/clientY accept variable references (e.g. {{variables.x}})
                <TextInput
                  value={paramStr(params, xKey, String(paramNum(params, xKey)))}
                  onChange={(v) => update({ [xKey]: Number(v) || v })}
                />
              ) : (
                <TextInput
                  type="number"
                  value={paramNum(params, xKey)}
                  onChange={(v) => update({ [xKey]: Number(v) || 0 })}
                />
              )}
            </Field>
            <Field label={yKey}>
              {isClient ? (
                <TextInput
                  value={paramStr(params, yKey, String(paramNum(params, yKey)))}
                  onChange={(v) => update({ [yKey]: Number(v) || v })}
                />
              ) : (
                <TextInput
                  type="number"
                  value={paramNum(params, yKey)}
                  onChange={(v) => update({ [yKey]: Number(v) || 0 })}
                />
              )}
            </Field>
          </div>
        )
      })}
    </>
  )
}

function TouchEventParams({ params, update }: { params: Params; update: (p: Params) => void }) {
  return <ModifierCheckboxes params={params} update={update} />
}

function WheelEventParams({ params, update }: { params: Params; update: (p: Params) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <Field label="deltaX">
        <TextInput
          type="number"
          value={paramNum(params, 'deltaX')}
          onChange={(v) => update({ deltaX: Number(v) || 0 })}
        />
      </Field>
      <Field label="deltaY">
        <TextInput
          type="number"
          value={paramNum(params, 'deltaY')}
          onChange={(v) => update({ deltaY: Number(v) || 0 })}
        />
      </Field>
      <Field label="deltaZ">
        <TextInput
          type="number"
          value={paramNum(params, 'deltaZ')}
          onChange={(v) => update({ deltaZ: Number(v) || 0 })}
        />
      </Field>
    </div>
  )
}

function InputEventParams({ params, update }: { params: Params; update: (p: Params) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <Field label="Data">
        <TextInput value={paramStr(params, 'data')} onChange={(v) => update({ data: v })} />
      </Field>
      <Field label="Input type">
        <TextInput
          value={paramStr(params, 'inputType', 'insertText')}
          onChange={(v) => update({ inputType: v })}
        />
      </Field>
    </div>
  )
}

function KeyboardEventParams({ params, update }: { params: Params; update: (p: Params) => void }) {
  const key = paramStr(params, 'key')
  const findKeyDefinition = (value: string) => {
    const def = KEY_DEFINITIONS[value]
    if (!def) return
    update({ key: value, code: def.code, keyCode: def.keyCode })
  }
  return (
    <>
      <ModifierCheckboxes params={params} update={update} />
      <Field label="key">
        <TextInput
          value={key}
          placeholder="a"
          onChange={(v) => {
            if (KEY_DEFINITIONS[v]) findKeyDefinition(v)
            else update({ key: v })
          }}
        />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="code">
          <TextInput
            value={paramStr(params, 'code')}
            placeholder="KeyA"
            onChange={(v) => update({ code: v })}
          />
        </Field>
        <Field label="keyCode">
          <TextInput
            type="number"
            value={paramNum(params, 'keyCode')}
            onChange={(v) => update({ keyCode: Number(v) || 0 })}
          />
        </Field>
      </div>
      <Checkbox
        checked={paramBool(params, 'repeat')}
        onChange={(v) => update({ repeat: v })}
        label="Repeat"
      />
    </>
  )
}

function renderEventParams(eventType: string, params: Params, update: (p: Params) => void): ReactNode {
  switch (eventType) {
    case 'mouse-event':
      return <MouseEventParams params={params} update={update} />
    case 'touch-event':
      return <TouchEventParams params={params} update={update} />
    case 'keyboard-event':
      return <KeyboardEventParams params={params} update={update} />
    case 'wheel-event':
      return <WheelEventParams params={params} update={update} />
    case 'input-event':
      return <InputEventParams params={params} update={update} />
    default:
      return null // focus-event / event / submit-event have no extra params
  }
}

function toCamelCase(input: string): string {
  const result = input.replace(/(?:^\w|[A-Z]|\b\w)/g, (letter, index) =>
    index === 0 ? letter.toLowerCase() : letter.toUpperCase(),
  )
  return result.replace(/\s+|[-]/g, '')
}

export default function EditTriggerEvent({ data, onChange }: EditFormProps) {
  const eventName = str(data, 'eventName')
  const eventType = str(data, 'eventType')
  const params = getParams(data)
  const eventDef = EVENT_LIST.find((e) => e.id === eventName)

  const updateParams = (patch: Params) => {
    onChange({ eventParams: { ...params, ...patch } })
  }

  const handleEventChange = (value: string) => {
    const def = EVENT_LIST.find((e) => e.id === value)
    if (!def) return
    const payload: Params = { eventName: value, eventType: def.type }
    // Automa resets params when the event type changes (default flags true/true).
    const defaultParams = { bubbles: true, cancelable: true }
    payload.eventParams = defaultParams
    onChange(payload)
  }

  const detailsUrl = eventType
    ? `https://developer.mozilla.org/en-US/docs/Web/API/${toCamelCase(eventType)}/${toCamelCase(eventType)}`
    : ''

  return (
    <InteractionBase data={data} onChange={onChange}>
      <div style={{ marginTop: 16 }}>
        <Field label="Select event">
          <Select
            value={eventName}
            onChange={handleEventChange}
            options={EVENT_LIST.map((e) => ({ value: e.id, label: e.name }))}
          />
        </Field>
      </div>

      <Expand
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <span>Options</span>
            {eventName && (
              <a
                href={detailsUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="Event reference (MDN)"
                style={{ marginLeft: 'auto' }}
              >
                <i className="ri-information-line" />
              </a>
            )}
          </span>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <Checkbox
            checked={paramBool(params, 'bubbles')}
            onChange={(v) => updateParams({ bubbles: v })}
            label="Bubbles"
          />
          <Checkbox
            checked={paramBool(params, 'cancelable')}
            onChange={(v) => updateParams({ cancelable: v })}
            label="Cancelable"
          />
        </div>
        {eventDef && renderEventParams(eventDef.type, params, updateParams)}
      </Expand>
    </InteractionBase>
  )
}
