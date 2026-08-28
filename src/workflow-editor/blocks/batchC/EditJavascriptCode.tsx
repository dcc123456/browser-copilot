/**
 * EditJavascriptCode — React port of Automa's EditJavascriptCode.vue.
 *
 * Automa shows the code in the sidebar form as a read-only dark <pre> preview;
 * clicking it opens a large modal hosting the CodeMirror editor (with automa
 * helper autocomplete) on a "Code" tab and the preload-script list on a
 * "Preload scripts" tab. Available helper functions are listed under the
 * editor as horizontally-scrolling <code> chips linking to the docs. Fields:
 * description, timeout, execution context, everyNewTab, runBeforeLoad.
 *
 * @module workflow-editor/blocks/batchC/EditJavascriptCode
 */

import { useState } from 'react'
import { Checkbox, Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import { bool, num, str } from '../shared/InteractionBase'
import type { EditFormProps } from '../EditForms'
import { arr, id } from './shared'
import { useEditorLocale } from '../../locale-context'
import Modal from '../../ui/Modal'
import CodeEditor from '../../ui/CodeEditor'

interface PreloadScript {
  src: string
  removeAfterExec?: boolean
}

const HELPER_FUNCS = [
  { name: 'automaNextBlock(data, insert?)', anchor: 'automanextblock-data' },
  { name: 'automaRefData(keyword, path?)', anchor: 'automarefdata-keyword-path' },
  { name: 'automaSetVariable(name, value)', anchor: 'automasetvariable-name-value' },
  { name: 'automaFetch(type, resource)', anchor: 'automasetvariable-type-resource' },
  { name: 'automaResetTimeout()', anchor: 'automaresettimeout' },
]

export default function EditJavascriptCode({ data, onChange }: EditFormProps) {
  const { bt, t } = useEditorLocale()
  const everyNewTab = bool(data, 'everyNewTab')
  const context = str(data, 'context') || 'website'
  const showContext = !everyNewTab
  const scripts = arr<PreloadScript>(data.preloadScripts)

  const [codeOpen, setCodeOpen] = useState(false)
  const [tab, setTab] = useState<'code' | 'preload'>('code')
  const [wrap, setWrap] = useState(false)

  const code = str(data, 'code')

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

      {/* Code preview (Automa: dark read-only <pre>, click to open editor) */}
      <Field label="JavaScript code">
        <pre
          className="wf-code-preview"
          onClick={() => {
            setTab('code')
            setCodeOpen(true)
          }}
          title={t('clickToEdit')}
        >
          {code ? code : <span className="wf-code-preview-empty">console.log("Hello world!");</span>}
        </pre>
      </Field>

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

      <Modal
        open={codeOpen}
        onClose={() => setCodeOpen(false)}
        icon="ri-code-s-slash-line"
        title={t('jsCode')}
        size="xl"
        actions={
          <div className="wf-modal-tabs">
            <button
              type="button"
              className={`wf-modal-tab${tab === 'code' ? ' wf-modal-tab-active' : ''}`}
              onClick={() => setTab('code')}
            >
              {t('codeTab')}
            </button>
            <button
              type="button"
              className={`wf-modal-tab${tab === 'preload' ? ' wf-modal-tab-active' : ''}`}
              onClick={() => setTab('preload')}
            >
              {bt('Preload scripts')}
            </button>
          </div>
        }
      >
        {tab === 'code' ? (
          <div className="wf-code-modal">
            <div className={`wf-code-host${wrap ? ' wf-code-wrap' : ''}`}>
              <CodeEditor value={code} onChange={(v) => onChange({ code: v })} lang="javascript" height="100%" />
            </div>
            <div className="wf-code-helpers">
              <p className="wf-code-helpers-title">
                <span>{t('availableFuncs')}</span>
                <button type="button" className="wf-code-wrap-toggle" onClick={() => setWrap((w) => !w)}>
                  {t('wrapLine')}
                </button>
              </p>
              <div className="wf-code-chips">
                {HELPER_FUNCS.map((f) => (
                  <a
                    key={f.anchor}
                    href={`https://docs.extension.automa.site/blocks/javascript-code.html#${f.anchor}`}
                    target="_blank"
                    rel="noreferrer"
                    className="wf-code-chip"
                  >
                    {f.name}
                  </a>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="wf-preload-tab">
            {scripts.length === 0 && <p className="wf-form-note">{t('noPreload')}</p>}
            {scripts.map((script, index) => (
              <div key={index} className="wf-preload-row">
                <IconButton icon="ri-delete-bin-line" title="Remove script" onClick={() => removeScript(index)} />
                <TextInput
                  value={script.src ?? ''}
                  placeholder="http://example.com/script.js"
                  onChange={(v) => setScript(index, { src: v })}
                />
                <Checkbox
                  checked={script.removeAfterExec !== false}
                  onChange={(v) => setScript(index, { removeAfterExec: v })}
                  label={bt('Remove after execution')}
                />
              </div>
            ))}
            <button type="button" className="wf-btn-accent" onClick={addScript}>
              <i className="ri-add-line" /> {bt('Add')}
            </button>
          </div>
        )}
      </Modal>
    </div>
  )
}
