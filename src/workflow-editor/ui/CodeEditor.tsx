/**
 * CodeEditor — React wrapper around CodeMirror 6, ported from Automa's
 * SharedCodemirror.vue.
 *
 * Fixed one-dark theme, line numbers, bracket matching, auto-indent, 2-space
 * tabs (Tab indents instead of leaving the field), and — for JavaScript —
 * autocomplete for the automa* helper functions available inside the
 * javascript-code block (`automaNextBlock`, `automaSetVariable`, …). The same
 * component is used read-only for JSON viewers (logs / variables).
 *
 * @module workflow-editor/ui/CodeEditor
 */

import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { CODE_NODE_HELPERS } from '../../lib/workflow/code-node-helpers'
import { useEditorLocale } from '../locale-context'

function automaAutocomplete(translate: (english: string) => string) {
  return autocompletion({
    override: [
      (context) => {
        const word = context.matchBefore(/[\w$]*$/)
        if (!word || (word.from === word.to && !context.explicit)) return null
        return {
          from: word.from,
          options: CODE_NODE_HELPERS.map((helper) => ({
            label: helper.name,
            detail: translate(helper.hint),
            type: helper.kind === 'object' ? 'variable' : 'function',
          })),
          validFor: /^[\w$]*$/,
        }
      },
    ],
  })
}

export default function CodeEditor({
  value,
  onChange,
  lang = 'javascript',
  readOnly = false,
  height,
  className,
}: {
  value: string
  onChange?: (value: string) => void
  lang?: 'javascript' | 'json'
  readOnly?: boolean
  /** CSS height for the editor (e.g. '100%' or '320px'). */
  height?: string
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const { bt } = useEditorLocale()
  // Keep the latest onChange without recreating the editor on every render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const btRef = useRef(bt)
  btRef.current = bt

  useEffect(() => {
    if (!hostRef.current) return
    const langExt: Extension = lang === 'json' ? json() : javascript()
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
    })
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        autocompletion(),
        ...(readOnly
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [
              keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                ...foldKeymap,
                ...completionKeymap,
                indentWithTab,
              ]),
            ]),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        highlightActiveLine(),
        langExt,
        ...(lang === 'javascript' && !readOnly
          ? [automaAutocomplete((text) => btRef.current(text))]
          : []),
        updateListener,
        oneDark,
        EditorState.tabSize.of(2),
        EditorView.theme({
          '&': { height: height ?? '100%', fontSize: '14px', borderRadius: '8px' },
          '.cm-scroller': {
            fontFamily: "'Source Code Pro', ui-monospace, Menlo, Consolas, monospace",
          },
          '.cm-content': { padding: '10px 0' },
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Editor is created once; external value changes are synced below.
  }, [lang, readOnly])

  // Sync external value (e.g. modal open) into the doc without resetting caret
  // when the change originated in the editor.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className={`wf-code-editor ${className ?? ''}`} />
}
