/**
 * EditJavascriptCode — React port of Automa's EditJavascriptCode.vue.
 *
 * The Vue form uses a CodeMirror modal with automa-function autocomplete.
 * Per porting scope that editor is replaced with a plain monospace textarea
 * bound to `data.code`. The preload-script list (script URL + remove-after
 * flag) is kept as an add/remove list. Fields: timeout, context,
 * everyNewTab, runBeforeLoad.
 *
 * @module workflow-editor/blocks/batchC/EditJavascriptCode
 */

import { Checkbox, Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'
import { arr, id } from './shared'

interface PreloadScript {
  src: string
  removeAfterExec?: boolean
}

export default function EditJavascriptCode({ data, onChange }: EditFormProps) {
  const everyNewTab = bool(data, 'everyNewTab')
  const context = str(data, 'context') || 'website'
  // Firefox/background restrictions don't apply in this build; both options shown.
  const showContext = !everyNewTab
  const scripts = arr<PreloadScript>(data.preloadScripts)

  const setScript = (index: number, patch: Partial<PreloadScript>) => {
    const next = scripts.slice()
    const current = next[index]
    if (!current) return
    next[index] = { ...current, ...patch }
    onChange({ preloadScripts: next })
  }
  const addScript = () => onChange({ preloadScripts: [...scripts, { src: '', removeAfterExec: true, id: id(6) }] })
  const removeScript = (index: number) => {
    const next = scripts.slice()
    next.splice(index, 1)
    onChange({ preloadScripts: next })
  }

  return (
    <div className="wf-form">
      <Field label="Description">
        <TextArea
          value={str(data, 'description')}
          placeholder="Description (shown on the node)"
          onChange={(v) => onChange({ description: v })}
        />
      </Field>

      {!everyNewTab && (
        <>
          <Field label="Timeout (milliseconds)" title="JavaScript code execution timeout">
            <TextInput
              type="number"
              value={num(data, 'timeout', 20000)}
              onChange={(v) => onChange({ timeout: Number(v) || 20000 })}
            />
          </Field>
          {showContext && (
            <Field label="Execution context">
              <Select
                value={context}
                onChange={(v) => onChange({ context: v })}
                options={[
                  { value: 'website', label: 'Active tab' },
                  { value: 'background', label: 'Background' },
                ]}
              />
            </Field>
          )}
        </>
      )}

      <Field label="JavaScript code">
        <TextArea
          mono
          rows={10}
          value={str(data, 'code')}
          placeholder={'console.log("Hello world!");\nautomaNextBlock()'}
          onChange={(v) => onChange({ code: v })}
        />
      </Field>
      <p className="wf-form-note">
        Available functions: <code>automaNextBlock(data, insert?)</code>, <code>automaRefData(keyword, path?)</code>,{' '}
        <code>automaSetVariable(name, value)</code>, <code>automaFetch(type, resource)</code>,{' '}
        <code>automaResetTimeout()</code>.
      </p>

      {context !== 'background' && (
        <>
          <Checkbox checked={everyNewTab} onChange={(v) => onChange({ everyNewTab: v })} label="Execute in every new tab" />
          <Checkbox
            checked={bool(data, 'runBeforeLoad')}
            onChange={(v) => onChange({ runBeforeLoad: v })}
            label="Run before page loaded"
          />
        </>
      )}

      <Field label="Preload scripts">
        {scripts.length === 0 && <p className="wf-form-note">No preload scripts.</p>}
        {scripts.map((script, index) => (
          <div
            key={index}
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}
          >
            <IconButton icon="ri-delete-bin-line" title="Remove script" onClick={() => removeScript(index)} />
            <TextInput
              value={script.src ?? ''}
              placeholder="http://example.com/script.js"
              onChange={(v) => setScript(index, { src: v })}
            />
            <Checkbox
              checked={script.removeAfterExec !== false}
              onChange={(v) => setScript(index, { removeAfterExec: v })}
              label="Remove after execution"
            />
          </div>
        ))}
        <button type="button" className="wf-btn-accent" onClick={addScript}>
          <i className="ri-add-line" /> Add
        </button>
      </Field>
    </div>
  )
}
