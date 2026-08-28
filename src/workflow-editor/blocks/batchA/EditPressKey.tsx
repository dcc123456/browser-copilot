/**
 * EditPressKey — "Press key" block form.
 *
 * React port of Automa's EditPressKey.vue. The block optionally targets an
 * element; the remaining fields are:
 *   - Action: "Press a key" (single key/combo with autocomplete + live key
 *     detection) or "Press multiple keys" (free textarea)
 *   - Press time (milliseconds)
 *
 * The key-autocomplete list is embedded as a constant derived from Automa's
 * `utils/USKeyboardLayout.js` (single-char / arrow keys plus the special keys
 * Enter/Control/Meta/Shift/Alt/Space). The "Detect key" button captures the
 * next key combination pressed anywhere in the window (recordPressedKey
 * behavior).
 *
 * @module workflow-editor/blocks/batchA/EditPressKey
 */
import { useEffect, useState } from 'react'
import { Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { str } from '../shared/InteractionBase'
import ElSelectorActions from '../shared/ElSelectorActions'

/** Keys suggested in the single-key autocomplete (EditPressKey `keysList`). */
const KEYS_LIST = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '*', '+', '-', '/', ';', '=', ',', '.', '`', '[', '\\', ']', "'", ')',
  '!', '@', '#', '$', '%', '^', '&', '(',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  ':', '<', '_', '>', '?', '~', '{', '|', '}', '"',
  'Enter', 'Control', 'Meta', 'Shift', 'Alt', 'Space',
]

const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta']

function toCamelCase(input: string, capitalize = false): string {
  const result = input.replace(/(?:^\w|[A-Z]|\b\w)/g, (letter, index) =>
    index === 0 && !capitalize ? letter.toLowerCase() : letter.toUpperCase(),
  )
  return result.replace(/\s+|[-]/g, '')
}

/** Port of Automa's recordPressedKey: turns a keydown event into a key combo. */
function recordPressedKey(
  event: { repeat: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean; ctrlKey: boolean; key: string },
): string | null {
  if (event.repeat || MODIFIER_KEYS.includes(event.key)) return null

  let pressedKey: string =
    event.key.length > 1 || event.shiftKey ? toCamelCase(event.key, true) : event.key

  if (pressedKey === ' ') pressedKey = 'Space'
  else if (pressedKey === '+') pressedKey = 'NumpadAdd'

  const keys = [pressedKey]
  if (event.shiftKey) keys.unshift('Shift')
  if (event.metaKey) keys.unshift('Meta')
  if (event.altKey) keys.unshift('Alt')
  if (event.ctrlKey) keys.unshift('Control')

  return keys.join('+')
}

export default function EditPressKey({ data, onChange }: EditFormProps) {
  const action = str(data, 'action') || 'press-key'
  const selector = str(data, 'selector')
  const [isRecording, setIsRecording] = useState(false)

  useEffect(() => {
    if (!isRecording) return
    const onKeydown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const combo = recordPressedKey(event)
      if (combo) onChange({ keys: combo })
    }
    const onKeyup = () => setIsRecording(false)
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('keyup', onKeyup)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('keyup', onKeyup)
    }
    // onChange is stable enough; the listeners are (re)bound per recording state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording])

  return (
    <InteractionBase
      data={data}
      onChange={onChange}
      hideSelector
      header={
        <Field label="Target element (Optional)">
          <div className="wf-selector-row">
            <TextInput
              value={selector}
              placeholder="CSS Selector or XPath"
              onChange={(v) => onChange({ selector: v })}
            />
            <ElSelectorActions selector={selector} onSelector={(sel) => onChange({ selector: sel })} />
          </div>
        </Field>
      }
    >
      <Field label="Action">
        <Select
          value={action}
          onChange={(v) => onChange({ action: v })}
          options={[
            { value: 'press-key', label: 'Press a key' },
            { value: 'multiple-keys', label: 'Press multiple keys' },
          ]}
        />
      </Field>

      {action === 'press-key' ? (
        <Field label="Key">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <input
                type="text"
                value={str(data, 'keys')}
                placeholder="(Enter, Esc, a, b, ...)"
                list="press-key-keys"
                onChange={(e) => onChange({ keys: e.target.value })}
              />
              <datalist id="press-key-keys">
                {KEYS_LIST.map((key) => (
                  <option key={key} value={key} />
                ))}
              </datalist>
            </div>
            <IconButton
              icon={isRecording ? 'ri-close-line' : 'ri-focus-3-line'}
              title={isRecording ? 'Cancel' : 'Detect key'}
              onClick={() => setIsRecording((v) => !v)}
            />
          </div>
        </Field>
      ) : (
        <Field label="Keys">
          <TextArea
            value={str(data, 'keysToPress')}
            placeholder="keys"
            onChange={(v) => onChange({ keysToPress: v })}
          />
        </Field>
      )}

      <Field label="Press time (milliseconds)">
        <TextInput
          type="number"
          value={str(data, 'pressTime') || '0'}
          placeholder="millisecond"
          onChange={(v) => onChange({ pressTime: v })}
        />
      </Field>
    </InteractionBase>
  )
}
