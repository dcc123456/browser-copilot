/**
 * The `/` menu that inserts dynamic variables into a block parameter field.
 *
 * Every string field in every block form is rendered by `TextInput` / `TextArea`
 * (`shared/Field.tsx`), so the menu lives here and the ~180 call sites stay
 * untouched: the primitives ask this hook for a menu and render what it returns.
 * Which names exist is answered by `lib/workflow/var-suggestions` (graph reach,
 * trigger inputs, loop context, credentials); this file only decides when the
 * menu opens, where it sits and what a pick writes back.
 *
 * A credential row carries its label and field key ONLY. Picking one secures a
 * `get-secret` producer through the host and inserts that producer's variable
 * name, so the secret value never enters the field, the workflow, or this DOM.
 *
 * @module workflow-editor/blocks/shared/SlashVariableMenu
 */

import { KeyRound } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import {
  applySlashInsert,
  findSlashQuery,
  moveSelection,
  type SlashQuery,
} from '../../../lib/slash'
import { listPasswords } from '../../../lib/storage'
import {
  collectSuggestions,
  filterSuggestions,
  type SecretFieldRef,
  type SecretOption,
  type SuggestionGraph,
  type SuggestionOrigin,
  type VariableSuggestion,
} from '../../../lib/workflow/var-suggestions'
import { useEditorLocale } from '../../locale-context'
import type { EditorStringKey } from '../../i18n'

/** What the editor host supplies: the live graph and the secret producer path. */
export interface SlashMenuContextValue {
  nodeId: string
  /** A thunk, so the list reflects edges/names added since the field mounted. */
  graph: () => SuggestionGraph
  secrets: SecretOption[]
  /**
   * Secure the producer for a picked credential; resolves to its variable name.
   * The host is shared by every field, so the node being edited is passed back
   * to it rather than baked into the callback.
   */
  insertSecret: (nodeId: string, ref: SecretFieldRef) => Promise<string>
}

const SlashMenuContext = createContext<SlashMenuContextValue | null>(null)

/** Menu groups, in the order they are listed. */
const GROUPS: { origin: SuggestionOrigin; key: EditorStringKey }[] = [
  { origin: 'input', key: 'varMenuInputs' },
  { origin: 'variable', key: 'varMenuVariables' },
  { origin: 'alias', key: 'varMenuAliases' },
  { origin: 'loop', key: 'varMenuLoop' },
  { origin: 'secret', key: 'varMenuSecrets' },
]

/** Roughly ten rows; the rest scrolls. */
const MENU_MAX_HEIGHT = 260

/**
 * Loads the user's credentials once per edited node and provides them, together
 * with the host's graph access, to every field primitive below it.
 *
 * Without this provider the menu simply stays closed — a block form rendered
 * outside the editor (a test, a future host) keeps working unchanged.
 */
export function SlashMenuProvider({
  nodeId,
  graph,
  insertSecret,
  children,
}: {
  nodeId: string
  graph: () => SuggestionGraph
  insertSecret: (nodeId: string, ref: SecretFieldRef) => Promise<string>
  children: ReactNode
}) {
  const [secrets, setSecrets] = useState<SecretOption[]>([])

  useEffect(() => {
    let cancelled = false
    void listPasswords()
      .then((entries) => {
        if (cancelled) return
        // Project to metadata immediately: keeping a PasswordEntry around means
        // keeping its values around, and they must never reach the menu.
        setSecrets(
          entries.flatMap((entry) =>
            (Array.isArray(entry.fields) ? entry.fields : [])
              .filter((field) => field && typeof field.key === 'string' && field.key.length > 0)
              .map((field) => ({
                credentialId: entry.id,
                fieldKey: field.key,
                label: entry.label,
              })),
          ),
        )
      })
      .catch(() => {
        // A non-extension host has no storage: the group is empty, not an error.
        if (!cancelled) setSecrets([])
      })
    return () => {
      cancelled = true
    }
  }, [nodeId])

  const value = useMemo(
    () => ({ nodeId, graph, secrets, insertSecret }),
    [nodeId, graph, secrets, insertSecret],
  )
  return <SlashMenuContext.Provider value={value}>{children}</SlashMenuContext.Provider>
}

interface FieldMenuOptions {
  /** The input the menu is anchored to. */
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  onChange: (next: string) => void
  /** Name-defining fields (variableName, column names) reference nothing. */
  disabled?: boolean
}

interface FieldMenu {
  /** Re-read the caret after a change or a caret move. */
  sync: () => void
  /** Menu keys own Enter/arrows only while open. */
  onKeyDown: (event: React.KeyboardEvent) => void
  close: () => void
  /** The portal-rendered dropdown, or null. */
  node: ReactNode
}

/**
 * Wire one input to the `/` menu.
 *
 * The query is read from the DOM node rather than from React state: the caret
 * and the pending value only exist there between keystrokes, and a menu driven
 * by props lags one render behind (the same reason the composer reads
 * `textareaRef` directly).
 */
export function useFieldSlashMenu({ inputRef, onChange, disabled }: FieldMenuOptions): FieldMenu {
  const host = useContext(SlashMenuContext)
  const { t } = useEditorLocale()
  const [query, setQuery] = useState<SlashQuery | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [pending, setPending] = useState(false)
  const [anchor, setAnchor] = useState<{
    left: number
    width: number
    top?: number
    bottom?: number
  } | null>(null)

  const reposition = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const roomBelow = window.innerHeight - rect.bottom
    const flip = roomBelow < MENU_MAX_HEIGHT + 16 && rect.top > roomBelow
    setAnchor(
      flip
        ? { left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4 }
        : { left: rect.left, width: rect.width, top: rect.bottom + 4 },
    )
  }, [inputRef])

  const close = useCallback(() => {
    setQuery(null)
    setAnchor(null)
  }, [])

  const sync = useCallback(() => {
    const el = inputRef.current
    if (!el || disabled) {
      close()
      return
    }
    const found = findSlashQuery(el.value, el.selectionStart ?? el.value.length)
    if (!found) {
      close()
      return
    }
    setQuery(found)
    setHighlight(0)
    reposition()
  }, [disabled, inputRef, reposition, close])

  // Follow the field while the menu is open: the sidebar scrolls, the canvas
  // pans, and an auto-growing textarea moves the caret's box under the menu.
  useEffect(() => {
    if (!query) return
    const follow = () => reposition()
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [query, reposition])

  const items = useMemo(() => {
    if (!host || !query) return []
    return filterSuggestions(
      collectSuggestions(host.graph(), host.nodeId, { secrets: host.secrets }),
      query.term,
    )
  }, [host, query])

  const pick = useCallback(
    async (item: VariableSuggestion) => {
      const el = inputRef.current
      if (!el || !query || !host) return
      let insert = item.insert
      if (item.secret && item.needsProducer) {
        if (pending) return
        setPending(true)
        try {
          insert = `{{${await host.insertSecret(host.nodeId, item.secret)}}}`
        } finally {
          setPending(false)
        }
      }
      const next = applySlashInsert(el.value, query, insert)
      onChange(next.text)
      close()
      // Restore the caret after React has committed the new value.
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
      })
    },
    [close, host, inputRef, onChange, pending, query],
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // An IME candidate list owns these keys; a menu that opened or picked
      // mid-composition would eat the user's keystroke.
      if (event.nativeEvent.isComposing) return
      if (!query || items.length === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((current) => moveSelection(current, 1, items.length))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) => moveSelection(current, -1, items.length))
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const item = items[highlight]
        if (item) void pick(item)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    },
    [close, highlight, items, pick, query],
  )

  const node =
    host && query && anchor
      ? createPortal(
          <div
            className="fixed z-[9000] overflow-y-auto rounded-lg border border-border bg-panel py-1 text-xs shadow-lg"
            role="listbox"
            aria-label={t('varMenuVariables')}
            style={{
              left: anchor.left,
              width: anchor.width,
              top: anchor.top,
              bottom: anchor.bottom,
              maxHeight: MENU_MAX_HEIGHT,
            }}
          >
            {pending ? (
              <div className="px-3 py-2 text-muted">{t('varMenuInserting')}</div>
            ) : items.length === 0 ? (
              <div className="px-3 py-2 text-muted">{t('varMenuEmpty')}</div>
            ) : (
              GROUPS.flatMap((group) => {
                const rows = items
                  .map((item, index) => ({ item, index }))
                  .filter(({ item }) => item.origin === group.origin)
                if (rows.length === 0) return []
                return [
                  <div
                    key={`group-${group.origin}`}
                    className="px-3 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted"
                  >
                    {t(group.key)}
                  </div>,
                  ...rows.map(({ item, index }) => (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={index === highlight}
                      data-active={index === highlight || undefined}
                      // preventDefault keeps the field focused, so the pending
                      // blur-validation cannot write a fallback over the pick.
                      onMouseDown={(event) => {
                        event.preventDefault()
                        void pick(item)
                      }}
                      onMouseEnter={() => setHighlight(index)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                        index === highlight ? 'bg-accent-soft text-ink' : 'text-muted'
                      }`}
                    >
                      {item.origin === 'secret' ? (
                        <KeyRound size={12} className="shrink-0" />
                      ) : null}
                      <span className="truncate font-mono">{item.name}</span>
                      {item.hint ? (
                        <span className="ml-auto shrink-0 truncate text-muted">{item.hint}</span>
                      ) : null}
                    </button>
                  )),
                ]
              })
            )}
          </div>,
          document.body,
        )
      : null

  return { sync, onKeyDown, close, node }
}
