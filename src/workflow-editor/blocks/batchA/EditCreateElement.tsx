/**
 * EditCreateElement — "Create element" block form.
 *
 * React port of Automa's EditCreateElement.vue. Beyond the interaction
 * skeleton (multiple/mark-element hidden):
 *   - "Insert element" position select (before / after / prev-sibling /
 *     next-sibling / replace)
 *   - "Run before page loaded" checkbox
 *   - "Edit element" button opening a modal with HTML / CSS / JavaScript tabs
 *     (plain textareas) plus a "Preload script" tab listing style/script URLs
 *     that can be added/removed.
 *
 * Automa uses a CodeMirror editor inside the modal; the port uses plain
 * monospace textareas (the React editor's CodeInput is JS-oriented and not
 * available in the sidebar bundle).
 *
 * @module workflow-editor/blocks/batchA/EditCreateElement
 */
import { useState } from 'react'
import { Checkbox, Field, IconButton, Select, TextArea, TextInput } from '../shared/Field'
import type { EditFormProps } from '../EditForms'
import InteractionBase, { bool, str } from '../shared/InteractionBase'

const INSERT_OPTIONS = [
  { value: 'before', label: 'As first child' },
  { value: 'after', label: 'As last child' },
  { value: 'prev-sibling', label: 'As previous sibling' },
  { value: 'next-sibling', label: 'As next sibling' },
  { value: 'replace', label: 'Replace target element' },
]

const TABS = [
  { id: 'html', name: 'HTML' },
  { id: 'css', name: 'CSS' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'preloadScript', name: 'Preload script' },
] as const

type TabId = (typeof TABS)[number]['id']

interface PreloadScript {
  type: string
  src: string
}

export default function EditCreateElement({ data, onChange }: EditFormProps) {
  const [showModal, setShowModal] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('html')

  const preloadScripts: PreloadScript[] = Array.isArray(data.preloadScripts)
    ? (data.preloadScripts as PreloadScript[])
    : []

  const setField = (key: string, value: unknown) => onChange({ [key]: value })

  const updateScript = (index: number, patch: Partial<PreloadScript>) => {
    const next = preloadScripts.map((item, i) => (i === index ? { ...item, ...patch } : item))
    onChange({ preloadScripts: next })
  }
  const addScript = () =>
    onChange({ preloadScripts: [...preloadScripts, { src: '', type: 'script' }] })
  const removeScript = (index: number) =>
    onChange({ preloadScripts: preloadScripts.filter((_, i) => i !== index) })

  return (
    <InteractionBase data={data} onChange={onChange} hideMultiple hideMarkEl>
      <Field label="Insert element">
        <Select
          value={str(data, 'insertAt') || 'after'}
          onChange={(v) => setField('insertAt', v)}
          options={INSERT_OPTIONS}
        />
      </Field>

      <Checkbox
        checked={bool(data, 'runBeforeLoad')}
        onChange={(v) => setField('runBeforeLoad', v)}
        label="Run before page loaded"
      />

      <button
        type="button"
        className="wf-btn-accent"
        style={{ width: '100%', marginTop: 16, padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer' }}
        onClick={() => setShowModal(true)}
      >
        Edit element
      </button>

      {showModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(760px, 90vw)',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bc-bg, #fff)',
              color: 'var(--bc-text, #111)',
              borderRadius: 12,
              overflow: 'hidden',
              border: '1px solid var(--bc-border, rgba(128,128,128,0.3))',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: 8, gap: 4 }}>
              <div style={{ flex: 1, display: 'flex', gap: 4 }}>
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={activeTab === tab.id ? 'wf-tab wf-tab-active' : 'wf-tab'}
                    style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}
                  >
                    {tab.name}
                  </button>
                ))}
              </div>
              <IconButton icon="ri-close-line" title="Close" onClick={() => setShowModal(false)} />
            </div>

            <div style={{ padding: '0 16px 16px', overflow: 'auto', flex: 1 }}>
              {activeTab === 'html' && (
                <TextArea
                  mono
                  rows={18}
                  className="wf-mono"
                  value={str(data, 'html')}
                  onChange={(v) => setField('html', v)}
                />
              )}
              {activeTab === 'css' && (
                <TextArea
                  mono
                  rows={18}
                  className="wf-mono"
                  value={str(data, 'css')}
                  onChange={(v) => setField('css', v)}
                />
              )}
              {activeTab === 'javascript' && (
                <>
                  <div style={{ margin: '8px 0' }}>
                    <span style={{ fontSize: 13, opacity: 0.75 }}>Available functions</span>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                      {['automaRefData(keyword, path?)', 'automaExecWorkflow(options)'].map((name) => (
                        <code
                          key={name}
                          style={{
                            background: 'var(--bc-box-transparent, rgba(128,128,128,0.12))',
                            padding: '2px 6px',
                            borderRadius: 6,
                            fontSize: 12,
                          }}
                        >
                          {name}
                        </code>
                      ))}
                    </div>
                  </div>
                  <TextArea
                    mono
                    rows={16}
                    className="wf-mono"
                    value={str(data, 'javascript')}
                    onChange={(v) => setField('javascript', v)}
                  />
                </>
              )}
              {activeTab === 'preloadScript' && (
                <div>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {preloadScripts.map((item, index) => (
                      <li key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <Select
                          value={item.type || 'script'}
                          onChange={(v) => updateScript(index, { type: v })}
                          options={[
                            { value: 'style', label: 'Style' },
                            { value: 'script', label: 'Script' },
                          ]}
                        />
                        <div style={{ flex: 1 }}>
                          <TextInput
                            value={item.src}
                            type="url"
                            placeholder={`https://example.com/${item.type === 'style' ? 'style.css' : 'script.js'}`}
                            onChange={(v) => updateScript(index, { src: v })}
                          />
                        </div>
                        <IconButton
                          icon="ri-delete-bin-7-line"
                          title="Remove"
                          onClick={() => removeScript(index)}
                        />
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="wf-btn-accent"
                    style={{ marginTop: 8, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer' }}
                    onClick={addScript}
                  >
                    Add script
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </InteractionBase>
  )
}
