/**
 * CodeEditor — React wrapper around CodeMirror 6, ported from Automa's
 * SharedCodemirror.vue.
 *
 * Fixed one-dark theme, line numbers, bracket matching, auto-indent, 2-space
 * tabs (Tab indents instead of leaving the field), and — for JavaScript —
 * autocomplete for the automa* helper functions available inside the
 * javascript-code block (`automaNextBlock`, `automaSetVariable`, …) plus a `/`
 * menu that inserts an available workflow variable as `variables.name`. The
 * same component is used read-only for JSON viewers (logs / variables).
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
import {
  autocompletion,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import {
  CODE_NODE_HELPERS,
  scriptVariableCompletions,
  type ScriptVariable,
} from '../../lib/workflow/code-node-helpers'
import { useEditorLocale } from '../locale-context'

/** Automa helper names, offered while typing an ordinary word. */
function helperCompletionSource(
  translate: (english: string) => string,
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const word = context.matchBefore(/[\w$]*$/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    // A word right after a word-start slash belongs to the variable query; the
    // slash source owns it, and offering helper names there would mix the two.
    if (word.from > 0 && context.state.sliceDoc(word.from - 1, word.from) === '/') return null
    return {
      from: word.from,
      options: CODE_NODE_HELPERS.map((helper) => ({
        label: helper.name,
        detail: translate(helper.hint),
        type: helper.kind === 'object' ? 'variable' : 'function',
      })),
      validFor: /^[\w$]*$/,
    }
  }
}

/** `/` inserts a variable available at this node; see `scriptVariableCompletions`. */
function scriptVariableSource(
  variables: () => readonly ScriptVariable[],
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos)
    const completion = scriptVariableCompletions(line.text, context.pos - line.from, variables())
    if (!completion) return null
    return {
      from: line.from + completion.from,
      options: completion.options,
      // Ranked already, and the term after `/` is not a CodeMirror word.
      filter: false,
      // Reject `//`, `/*` and a second slash in the term: the word-start rule
      // opens the menu on the first slash, and prose must close it again.
      validFor: /^\/(?![/\s*])[^\s/]*$/,
    }
  }
}

export default function CodeEditor({
  value,
  onChange,
  variables,
  lang = 'javascript',
  readOnly = false,
  height,
  className,
}: {
  value: string
  onChange?: (value: string) => void
  /** Workflow variables the `/` menu may insert (names only, no values). */
  variables?: readonly ScriptVariable[]
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
  // The editor is created once; completion reads the live list through this ref.
  const variablesRef = useRef<readonly ScriptVariable[]>(variables ?? [])
  variablesRef.current = variables ?? []

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
          ? [
              autocompletion({
                override: [
                  helperCompletionSource((text) => btRef.current(text)),
                  scriptVariableSource(() => variablesRef.current),
                ],
              }),
            ]
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
