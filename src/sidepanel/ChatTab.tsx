/**
 * Chat UI.
 *
 * ## Surviving service-worker eviction
 *
 * Chrome evicts an idle MV3 service worker after roughly 30 seconds, which tears
 * down the message port with it. Two mechanisms keep that invisible:
 *
 * 1. **Heartbeat** — a periodic `ping` while the panel is open. Port traffic
 *    resets the worker's idle timer, so it stays alive rather than dropping a
 *    stream mid-turn.
 * 2. **Reconnect** — if the port drops anyway (eviction, an extension reload, a
 *    crash), a fresh one is opened automatically. The transcript lives in the
 *    worker's session storage keyed by `conversationId`, so the conversation
 *    continues instead of silently restarting.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AGENT_PORT,
  type AgentClientMessage,
  type AgentServerMessage,
  type TurnTokenUsage,
  sendCommand,
} from '../lib/messages'
import { DEFAULT_CONVERSATION_ID, newId } from '../lib/storage'
import type { AgentMode, ConversationMeta } from '../lib/types'
import {
  applySlashPick,
  filterSkills,
  findSlashQuery,
  moveSelection,
  type SlashQuery,
} from '../lib/slash'
import type { Skill } from '../lib/types'
import { useT } from './i18n'
import Markdown from './Markdown'

/**
 * Fixed default conversation id; other conversations are generated ids.
 *
 * The currently-selected id is kept in `localStorage` so collapse-and-return
 * resumes the same thread. Unlike `chrome.storage`, `localStorage` is
 * synchronously available on first paint, which avoids a flash of the wrong
 * conversation.
 */
const STORED_CONV_KEY = 'browser-copilot:active-conversation'

/** Empty token tally, used when (re)starting a conversation's counters. */
const ZERO_USAGE: TurnTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
}

function loadStoredConversationId(): string {
  try {
    return localStorage.getItem(STORED_CONV_KEY) || DEFAULT_CONVERSATION_ID
  } catch {
    return DEFAULT_CONVERSATION_ID
  }
}

/** One rendered transcript entry. */
interface Entry {
  id: string
  role: 'user' | 'assistant' | 'status' | 'error' | 'tool'
  text: string
}

/** A tool call awaiting the user's decision. */
interface PendingConfirm {
  requestId: string
  name: string
  argsPreview: string
}

let counter = 0
const nextId = (): string => `e${(counter += 1)}`

/** Comfortably inside Chrome's ~30s idle eviction window. */
const HEARTBEAT_MS = 20_000

interface Props {
  skills: Skill[]
  activeSkillId: string | null
  onSelectSkill: (id: string | null) => void
}

export default function ChatTab({ skills, activeSkillId, onSelectSkill }: Props) {
  const t = useT()
  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [includeSelection, setIncludeSelection] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirms, setConfirms] = useState<PendingConfirm[]>([])
  const [conversationId, setConversationId] = useState<string>(() =>
    loadStoredConversationId(),
  )
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [showHistory, setShowHistory] = useState(false)
  /** Conversation whose messages are being previewed in the history drawer. */
  const [previewConv, setPreviewConv] = useState<{ id: string; title: string; messages: { role: string; text: string }[] } | null>(null)
  const [mode, setMode] = useState<AgentMode>('semi')
  const [modeInfoOpen, setModeInfoOpen] = useState(false)
  /** Token usage of the most recent turn, for the popover breakdown. */
  const [lastUsage, setLastUsage] = useState<TurnTokenUsage | null>(null)
  /** Summed usage across turns in this conversation. */
  const [sessionUsage, setSessionUsage] = useState<TurnTokenUsage>(() => ({ ...ZERO_USAGE }))
  const [usageOpen, setUsageOpen] = useState(false)

  // Each conversation gets its own token tally; reset when starting or opening
  // another conversation so the chip reflects only the current one.
  const resetUsage = useCallback(() => {
    setSessionUsage({ ...ZERO_USAGE })
    setLastUsage(null)
  }, [])
  /**
   * Composer height in px, persisted to localStorage. A drag handle on the
   * top edge of the composer adjusts it; the chat log takes the remaining
   * space.
   */
  const COMPOSER_HEIGHT_KEY = 'browser-copilot:composer-height'
  const [composerHeight, setComposerHeight] = useState<number>(() => {
    const stored = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY))
    return Number.isFinite(stored) && stored >= 72 && stored <= 520 ? stored : 140
  })
  const draggingRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const closeModeInfo = useCallback(() => setModeInfoOpen(false), [])
  const closeUsage = useCallback(() => setUsageOpen(false), [])

  useEffect(() => {
    if (!modeInfoOpen) return
    const id = window.setTimeout(() => {
      document.addEventListener('click', closeModeInfo, { once: true })
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('click', closeModeInfo)
    }
  }, [modeInfoOpen, closeModeInfo])

  useEffect(() => {
    if (!usageOpen) return
    const id = window.setTimeout(() => {
      document.addEventListener('click', closeUsage, { once: true })
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('click', closeUsage)
    }
  }, [usageOpen, closeUsage])

  // Drag-to-resize for the composer. Pointer events so it works with mouse and
  // touch; dragging up grows the composer (and shrinks the chat log).
  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    draggingRef.current = { startY: event.clientY, startHeight: composerHeight }
    const onMove = (move: PointerEvent): void => {
      const start = draggingRef.current
      if (!start) return
      // Moving the pointer up (negative delta) grows the composer.
      const next = Math.min(520, Math.max(72, start.startHeight - (move.clientY - start.startY)))
      setComposerHeight(next)
    }
    const onUp = (): void => {
      draggingRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
      try {
        localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight))
      } catch {
        /* ignore */
      }
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  useEffect(() => {
    // Persist height after dragging settles; a separate effect avoids writing
    // on every pointermove.
    if (draggingRef.current) return
    try {
      localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight))
    } catch {
      /* ignore */
    }
  }, [composerHeight, COMPOSER_HEIGHT_KEY])

  /**
   * Slash-menu state.
   *
   * `query` is null whenever the menu is closed, so it doubles as the open flag
   * and there is no way for the two to disagree.
   */
  const [query, setQuery] = useState<SlashQuery | null>(null)
  const [highlight, setHighlight] = useState(0)

  const portRef = useRef<chrome.runtime.Port | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** Tracks an in-progress IME composition so Enter confirms it, not send. */
  const composingRef = useRef(false)
  /** Id of the assistant entry currently being streamed into. */
  const streamingRef = useRef<string | null>(null)
  /** Set once the component unmounts, to stop reconnect attempts. */
  const closedRef = useRef(false)
  /**
   * Mirrors `busy` for the port listeners.
   *
   * The connect effect runs once, so its closure would otherwise capture the
   * initial `busy` value forever and misjudge whether a turn was interrupted.
   */
  const busyRef = useRef(false)
  busyRef.current = busy
  /**
   * Mirrors the dictionary for the port listeners.
   *
   * The connect effect deliberately does not depend on `t`: adding it would tear
   * down and rebuild the port — losing an in-flight turn — every time the user
   * changed language. Reading the current messages through a ref keeps status text
   * localized without coupling the connection lifetime to the locale.
   */
  const tRef = useRef(t)
  tRef.current = t

  const append = useCallback((entry: Omit<Entry, 'id'>) => {
    setEntries((prev) => [...prev, { id: nextId(), ...entry }])
  }, [])

  /**
   * Appends streamed text to the open assistant entry, opening one on the first
   * delta so an empty bubble never appears while tools run.
   */
  const appendDelta = useCallback((text: string) => {
    setEntries((prev) => {
      const streamingId = streamingRef.current
      if (streamingId) {
        return prev.map((entry) =>
          entry.id === streamingId ? { ...entry, text: entry.text + text } : entry,
        )
      }
      const id = nextId()
      streamingRef.current = id
      return [...prev, { id, role: 'assistant', text }]
    })
  }, [])

  useEffect(() => {
    closedRef.current = false
    let heartbeat: number | undefined
    let retry: number | undefined

    const connect = (): void => {
      if (closedRef.current) return

      const port = chrome.runtime.connect({ name: AGENT_PORT })
      portRef.current = port
      port.onMessage.addListener((raw) => {
        const message = raw as AgentServerMessage
        switch (message.type) {
          case 'pong':
            break
          case 'restore': {
            // Replace rather than append: this is the authoritative transcript,
            // and a reconnect must not duplicate what is already shown.
            // `messages` is defensively defaulted because a stale worker from a
            // previous version may not send it, and mapping undefined would
            // crash the whole panel.
            const restored = (message.messages ?? []).map((entry) => {
              if (entry.role === 'tool') {
                return { id: nextId(), role: 'tool' as const, text: entry.text }
              }
              return {
                id: nextId(),
                role: entry.role as 'user' | 'assistant',
                text: entry.text,
              }
            })
            setEntries(restored)
            streamingRef.current = null
            setBusy(message.running)
            if (message.running) {
              setEntries((prev) => [
                ...prev,
                { id: nextId(), role: 'status', text: tRef.current.chatReattached },
              ])
            }
            break
          }
          case 'delta':
            appendDelta(message.text)
            break
          case 'tool.start':
            streamingRef.current = null
            append({ role: 'tool', text: `→ ${message.name}` })
            break
          case 'tool.result':
            append({ role: 'tool', text: `← ${message.name}: ${message.summary}` })
            break
          case 'confirm.request':
            setConfirms((prev) => [...prev, message])
            break
          case 'status':
            append({ role: 'status', text: message.text })
            break
          case 'done':
            streamingRef.current = null
            setBusy(false)
            if (message.usage) {
              setLastUsage(message.usage)
              setSessionUsage((prev) => ({
                inputTokens: prev.inputTokens + message.usage!.inputTokens,
                outputTokens: prev.outputTokens + message.usage!.outputTokens,
                cachedInputTokens:
                  prev.cachedInputTokens + (message.usage!.cachedInputTokens ?? 0),
                reasoningTokens: prev.reasoningTokens + (message.usage!.reasoningTokens ?? 0),
                totalTokens: prev.totalTokens + message.usage!.totalTokens,
              }))
            }
            break
          case 'error':
            streamingRef.current = null
            append({ role: 'error', text: message.message })
            setBusy(false)
            break
        }
      })

      port.onDisconnect.addListener(() => {
        portRef.current = null
        window.clearInterval(heartbeat)
        if (closedRef.current) return

        // A turn's `done`/`error` can never arrive on a port that is already
        // gone, so release the composer rather than leaving it locked forever.
        // The worker persists the transcript, so the reply is not lost — it
        // reappears in context on the next message.
        if (busyRef.current) {
          streamingRef.current = null
          setBusy(false)
          append({
            role: 'status',
            text: tRef.current.chatConnectionDropped,
          })
        }

        // Reconnect promptly and silently; the worker keeps the transcript.
        retry = window.setTimeout(connect, 250)
      })

      heartbeat = window.setInterval(() => {
        try {
          port.postMessage({ type: 'ping' } satisfies AgentClientMessage)
        } catch {
          // The disconnect listener handles recovery.
        }
      }, HEARTBEAT_MS)

      // Ask for the stored transcript. On a first open this is empty; after a
      // collapse it restores the conversation and any run still in progress.
      try {
        port.postMessage({
          type: 'resume',
          conversationId,
        } satisfies AgentClientMessage)
      } catch {
        // The disconnect listener handles recovery.
      }
    }

    connect()

    return () => {
      closedRef.current = true
      window.clearInterval(heartbeat)
      window.clearTimeout(retry)
      portRef.current?.disconnect()
      portRef.current = null
    }
  }, [append, appendDelta, conversationId])

  // Refresh the conversation list when it changes and on mount.
  const refreshConversations = useCallback(async () => {
    try {
      const result = await sendCommand({ type: 'conversations.list' })
      if (result.type === 'conversations.list') setConversations(result.conversations)
    } catch {
      /* non-fatal */
    }
  }, [])

  // Load the autonomy mode once on mount. It is sent with each chat message
  // indirectly via the worker reading settings, so the switch below only has
  // to persist it before the next send.
  useEffect(() => {
    void (async () => {
      try {
        const result = await sendCommand({ type: 'settings.get' })
        if (result.type === 'settings') setMode(result.settings.mode)
      } catch {
        /* keep default */
      }
    })()
  }, [])

  const changeMode = async (next: AgentMode): Promise<void> => {
    if (next === 'full' && !window.confirm(t.modeFullWarning)) {
      return
    }
    setMode(next)
    try {
      await sendCommand({ type: 'settings.set', patch: { mode: next } })
    } catch {
      /* non-fatal; worker will still use default on next turn */
    }
  }

  useEffect(() => {
    void refreshConversations()
  }, [refreshConversations, entries.length])

  useEffect(() => {
    try {
      localStorage.setItem(STORED_CONV_KEY, conversationId)
    } catch {
      /* ignore */
    }
  }, [conversationId])

  const openConversation = (id: string): void => {
    if (busy) return
    setShowHistory(false)
    setPreviewConv(null)
    if (id === conversationId) return
    setConversationId(id)
    setEntries([])
    setConfirms([])
    streamingRef.current = null
    resetUsage()
    // The port's resume effect fires on conversationId change and restores.
  }

  const startNewConversation = (): void => {
    if (busy) return
    setShowHistory(false)
    const id = newId()
    setConversationId(id)
    setEntries([])
    setConfirms([])
    streamingRef.current = null
    resetUsage()
    void refreshConversations()
  }

  const renameConversation = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      await sendCommand({ type: 'conversations.rename', id, title: trimmed })
      await refreshConversations()
    } catch {
      /* ignore */
    }
  }

  const deleteConversationById = async (id: string): Promise<void> => {
    if (busy) return
    if (!window.confirm(t.convDeleteConfirm)) return
    try {
      await sendCommand({ type: 'conversations.delete', id })
    } catch {
      /* ignore */
    }
    if (id === conversationId) {
      setEntries([])
      setConfirms([])
      streamingRef.current = null
      setConversationId(DEFAULT_CONVERSATION_ID)
    }
    if (previewConv?.id === id) setPreviewConv(null)
    await refreshConversations()
  }

  const previewConversation = async (id: string): Promise<void> => {
    try {
      const result = await sendCommand({ type: 'conversations.get', id })
      if (result.type === 'conversations.get') {
        setPreviewConv({ id: result.id, title: result.title, messages: result.messages })
      }
    } catch {
      /* ignore */
    }
  }

  // Keep the newest message in view.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [entries, confirms])

  /**
   * Sends over the live port, reconnecting once if it was just evicted.
   *
   * Returns false only when even a fresh connection fails, which means the
   * extension itself is gone (reloaded or updated).
   */
  const post = (message: AgentClientMessage): boolean => {
    try {
      if (!portRef.current) throw new Error('no port')
      portRef.current.postMessage(message)
      return true
    } catch {
      try {
        const port = chrome.runtime.connect({ name: AGENT_PORT })
        portRef.current = port
        port.postMessage(message)
        return true
      } catch {
        return false
      }
    }
  }

  const send = (): void => {
    if (busy) return
    const text = draft.trim()
    // An active skill may be invoked with no additional text — the skill's own
    // instructions become the task. Otherwise a message is required.
    if (!text && !activeSkillId) return

    // When the user just selected a skill and hit send, give the model an
    // explicit nudge to follow it, rather than sending an empty user turn.
    const outgoing = text || t.chatSkillGo

    const delivered = post({
      type: 'chat',
      conversationId,
      text: outgoing,
      includeSelection,
      ...(activeSkillId ? { skillId: activeSkillId } : {}),
    })
    if (!delivered) {
      append({
        role: 'error',
        text: t.chatExtensionReloaded,
      })
      return
    }

    append({ role: 'user', text: outgoing })
    streamingRef.current = null
    setBusy(true)
    setDraft('')
  }

  const answerConfirm = (requestId: string, approved: boolean): void => {
    post({ type: 'confirm', requestId, approved })
    setConfirms((prev) => prev.filter((item) => item.requestId !== requestId))
  }

  // --- Slash menu ------------------------------------------------------------

  const activeSkill = skills.find((skill) => skill.id === activeSkillId) ?? null
  const matches = query ? filterSkills(skills, query.term) : []
  // Only open once there is something to pick, so a stray '/' is not disruptive.
  const menuOpen = query !== null && skills.length > 0

  const closeMenu = (): void => {
    setQuery(null)
    setHighlight(0)
  }

  /**
   * Recomputes the menu from the draft and caret.
   *
   * Driven by the textarea's own value/caret rather than component state, because
   * `onChange` fires before a `setDraft` render lands — reading state here would
   * lag one keystroke behind.
   */
  const syncMenu = (text: string, caret: number | null): void => {
    if (caret === null || skills.length === 0) {
      closeMenu()
      return
    }
    const next = findSlashQuery(text, caret)
    setQuery(next)
    // Reset the highlight whenever the term changes, so it never points past the
    // end of a newly-filtered list.
    setHighlight(0)
  }

  const pickSkill = (skill: Skill): void => {
    if (!query) return
    const { text, caret } = applySlashPick(draft, query)
    setDraft(text)
    onSelectSkill(skill.id)
    closeMenu()

    // Restore focus and caret after React commits the new value; without this the
    // caret jumps to the end and focus can land on the clicked button.
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(caret, caret)
    })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen && matches.length > 0) {
      // While the menu is open it owns these keys; the textarea must not also act
      // on them, or Enter would both pick a skill and send the message.
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) =>
          moveSelection(current, event.key === 'ArrowDown' ? 1 : -1, matches.length),
        )
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const chosen = matches[highlight]
        if (chosen) {
          event.preventDefault()
          pickSkill(chosen)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        return
      }
    }

    // Enter sends; Shift+Enter inserts a newline. When an IME is composing
    // (Chinese/Japanese/Korean), Enter confirms the in-place candidate instead
    // of sending — a second Enter after composition ends sends the message.
    if (event.key === 'Enter' && !event.shiftKey) {
      if (composingRef.current || event.nativeEvent.isComposing) {
        return
      }
      event.preventDefault()
      send()
      return
    }

    // Arrow keys move the caret, which can leave or enter a command token, so the
    // menu is re-evaluated after the browser has applied the movement.
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (node) syncMenu(node.value, node.selectionStart)
      })
    }
  }

  return (
    <>
      {/* History drawer (left side) */}
      {showHistory && (
        <div className="drawer-backdrop" onClick={() => setShowHistory(false)}>
          <aside className="drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <strong>{t.convHistory}</strong>
              <button
                aria-label={t.cancel}
                className="drawer-close"
                onClick={() => {
                  setShowHistory(false)
                  setPreviewConv(null)
                }}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="drawer-body">
              {previewConv ? (
                <div className="conv-preview">
                  <button
                    className="link-btn"
                    onClick={() => setPreviewConv(null)}
                    type="button"
                  >
                    ← {t.convHistory}
                  </button>
                  <h4>{previewConv.title}</h4>
                  <div className="conv-preview-log">
                    {previewConv.messages.length === 0 && (
                      <div className="empty">{t.convHistoryEmpty}</div>
                    )}
                    {previewConv.messages.map((message, index) => (
                      <div className="msg" data-role={message.role} key={index}>
                        {message.text}
                      </div>
                    ))}
                  </div>
                  <div className="actions">
                    <button
                      className="primary"
                      onClick={() => openConversation(previewConv.id)}
                      type="button"
                    >
                      {t.convContinue}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="actions" style={{ marginBottom: 8 }}>
                    <button className="primary" onClick={startNewConversation} type="button">
                      ＋ {t.convNew}
                    </button>
                  </div>
                  {conversations.length === 0 && (
                    <div className="empty">{t.convHistoryEmpty}</div>
                  )}
                  {conversations.map((conv) => (
                    <ConversationRow
                      conversation={conv}
                      isActive={conv.id === conversationId}
                      key={conv.id}
                      onContinue={() => openConversation(conv.id)}
                      onDelete={() => void deleteConversationById(conv.id)}
                      onPreview={() => void previewConversation(conv.id)}
                      onRename={(title) => void renameConversation(conv.id, title)}
                      t={t}
                    />
                  ))}
                </>
              )}
            </div>
          </aside>
        </div>
      )}

      <div className="chat-toolbar">
        <label className="inline-check" title={t.chatAttachSelection}>
          <input
            checked={includeSelection}
            onChange={(event) => setIncludeSelection(event.target.checked)}
            type="checkbox"
          />
          {t.chatAttachSelection}
        </label>
        <button
          aria-label={t.convHistory}
          className="icon-btn"
          onClick={() => {
            void refreshConversations()
            setShowHistory(true)
          }}
          title={t.convHistory}
          type="button"
        >
          <svg height="16" viewBox="0 0 24 24" width="16" aria-hidden="true">
            <path
              d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7v3l4-4-4-4v3z"
              fill="currentColor"
            />
            <path d="M12 8v5l4 2-.7 1.2L11 13.5V8z" fill="currentColor" />
          </svg>
          <span className="icon-btn-label">{t.convHistory}</span>
        </button>
      </div>

      <div className="pane chat-log" ref={logRef}>
        {entries.length === 0 && confirms.length === 0 && (
          <div className="empty">{t.chatEmpty}</div>
        )}

        {entries.map((entry) =>
          entry.role === 'tool' ? (
            <div key={entry.id}>
              <span className="tool-chip">{entry.text}</span>
            </div>
          ) : (
            <div key={entry.id} className="msg" data-role={entry.role}>
              {/*
                Only assistant replies are parsed as Markdown. What the user typed
                is shown exactly as typed: reformatting their own words would be
                surprising, and asking about `**` or a code fence must not make
                the question itself change shape. Status and error lines are
                plain text generated by this extension.
              */}
              {entry.role === 'assistant' ? <Markdown text={entry.text} /> : entry.text}
            </div>
          ),
        )}

        {confirms.map((confirm) => (
          <div key={confirm.requestId} className="confirm-card">
            <strong>{t.chatConfirmTitle({ name: confirm.name })}</strong>
            <div className="confirm-action">{confirm.argsPreview}</div>
            <p className="hint" style={{ margin: '6px 0' }}>
              {t.confirmActionHint}
            </p>
            <div className="actions">
              <button
                className="primary"
                onClick={() => answerConfirm(confirm.requestId, true)}
                type="button"
              >
                {t.chatApprove}
              </button>
              <button onClick={() => answerConfirm(confirm.requestId, false)} type="button">
                {t.chatDecline}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div
        className="composer-resize-handle"
        onPointerDown={beginResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
      >
        <span className="composer-resize-grip" />
      </div>

      <div className="composer" style={{ height: composerHeight }}>
        {activeSkill && (
          <div className="skill-chip">
            <span className="skill-chip-name">{t.chatSkillActive({ name: activeSkill.name })}</span>
            <button
              aria-label={t.skillsStopUsing}
              className="skill-chip-clear"
              onClick={() => onSelectSkill(null)}
              title={t.skillsStopUsing}
              type="button"
            >
              ×
            </button>
          </div>
        )}

        {/*
          The menu sits above the textarea and is positioned by CSS rather than
          measured caret coordinates: the composer is only a few lines tall, so
          anchoring to it is both simpler and steadier than tracking the caret.
        */}
        {menuOpen && (
          <div className="slash-menu" role="listbox">
            {matches.length === 0 ? (
              <div className="slash-empty">{t.chatSlashNoMatch}</div>
            ) : (
              matches.map((skill, index) => (
                <button
                  aria-selected={index === highlight}
                  className="slash-item"
                  data-active={index === highlight}
                  key={skill.id}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    pickSkill(skill)
                  }}
                  onMouseEnter={() => setHighlight(index)}
                  role="option"
                  type="button"
                >
                  <span className="slash-item-name">{skill.name}</span>
                  {skill.description && (
                    <span className="slash-item-desc">{skill.description}</span>
                  )}
                </button>
              ))
            )}
          </div>
        )}

        <textarea
          onChange={(event) => {
            setDraft(event.target.value)
            syncMenu(event.target.value, event.target.selectionStart)
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onBlur={closeMenu}
          onClick={(event) => syncMenu(draft, event.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          placeholder={skills.length > 0 ? t.chatPlaceholderWithSkills : t.chatPlaceholder}
          ref={textareaRef}
          value={draft}
        />
        <div className="composer-row">
          <div className="mode-select">
            <select
              aria-label={t.modeLabel}
              onChange={(event) => void changeMode(event.target.value as AgentMode)}
              value={mode}
            >
              <option value="chat">💬 {t.modeChat}</option>
              <option value="readonly">🔒 {t.modeReadonly}</option>
              <option value="semi">🛡 {t.modeSemi}</option>
              <option value="full">⚡ {t.modeFull}</option>
            </select>
            <button
              aria-label="mode info"
              className="icon-btn mode-info-btn"
              onClick={() => setModeInfoOpen((open) => !open)}
              type="button"
            >
              <svg height="14" viewBox="0 0 24 24" width="14" aria-hidden="true">
                <path
                  d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"
                  fill="currentColor"
                />
              </svg>
            </button>
            {modeInfoOpen && (
              <div className="popover" role="tooltip">
                <strong>{t.modeLabel}</strong>
                <p>
                  <b>💬 {t.modeChat}</b>
                  <br />
                  {t.modeChatHint}
                </p>
                <p>
                  <b>🔒 {t.modeReadonly}</b>
                  <br />
                  {t.modeReadonlyHint}
                </p>
                <p>
                  <b>🛡 {t.modeSemi}</b>
                  <br />
                  {t.modeSemiHint}
                </p>
                <p>
                  <b>⚡ {t.modeFull}</b>
                  <br />
                  {t.modeFullHint}
                </p>
              </div>
            )}
            <button
              aria-label={t.tokenUsage}
              className={`token-btn${usageOpen ? ' token-btn-active' : ''}`}
              onClick={() => setUsageOpen((open) => !open)}
              title={t.tokenUsage}
              type="button"
            >
              {formatTokens(sessionUsage.totalTokens)}
            </button>
            {usageOpen && (
              <div className="popover token-popover" role="tooltip">
                <TokenBreakdown
                  label={t.tokenSession}
                  t={t}
                  usage={sessionUsage}
                />
                {lastUsage && (
                  <TokenBreakdown
                    label={t.tokenLastTurn}
                    t={t}
                    usage={lastUsage}
                  />
                )}
                {!lastUsage && sessionUsage.totalTokens === 0 && (
                  <p className="token-none">{t.tokenNone}</p>
                )}
              </div>
            )}
          </div>
          <div className="actions" style={{ margin: 0 }}>
            {!busy && entries.length > 0 && (
              <button
                onClick={startNewConversation}
                title={t.convNew}
                type="button"
              >
                ＋ {t.chatNewChat}
              </button>
            )}
            {busy && (
              <button onClick={() => post({ type: 'cancel' })} type="button">
                {t.chatStop}
              </button>
            )}
            <button
              className="primary"
              disabled={busy || (!draft.trim() && !activeSkillId)}
              onClick={send}
              type="button"
            >
              {busy ? t.loading : t.chatSend}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

interface RowProps {
  conversation: ConversationMeta
  isActive: boolean
  onContinue: () => void
  onPreview: () => void
  onRename: (title: string) => void
  onDelete: () => void
  t: ReturnType<typeof useT>
}

function ConversationRow({
  conversation,
  isActive,
  onContinue,
  onPreview,
  onRename,
  onDelete,
  t,
}: RowProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(conversation.title)

  const commit = (): void => {
    setEditing(false)
    if (value.trim() && value !== conversation.title) onRename(value)
  }

  const when = new Date(conversation.updatedAt).toLocaleString()

  return (
    <div className="conv-row" data-active={isActive}>
      {editing ? (
        <input
          autoFocus
          className="conv-rename"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') {
              setValue(conversation.title)
              setEditing(false)
            }
          }}
          value={value}
        />
      ) : (
        <button className="conv-row-main" onClick={onContinue} type="button">
          <span className="conv-row-title">{conversation.title || t.convUntitled}</span>
          <span className="conv-row-meta">
            {t.convUpdated} {when}
          </span>
        </button>
      )}
      <div className="conv-row-actions">
        <button onClick={onPreview} title={t.convPreview} type="button">
          👁
        </button>
        <button
          onClick={() => {
            setValue(conversation.title)
            setEditing(true)
          }}
          title={t.convRename}
          type="button"
        >
          ✎
        </button>
        <button className="danger" onClick={onDelete} title={t.convDelete} type="button">
          🗑
        </button>
      </div>
    </div>
  )
}

/** Compact token count for the chip: 1.2k / 3.4m style. */
function formatTokens(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function TokenBreakdown({
  label,
  usage,
  t,
}: {
  label: string
  usage: TurnTokenUsage
  t: ReturnType<typeof useT>
}) {
  const rows: Array<[string, number]> = [
    [t.tokenTotal, usage.totalTokens],
    [t.tokenInput, usage.inputTokens],
    [t.tokenOutput, usage.outputTokens],
  ]
  if (usage.reasoningTokens > 0) rows.push([t.tokenReasoning, usage.reasoningTokens])
  if (usage.cachedInputTokens > 0) rows.push([t.tokenCached, usage.cachedInputTokens])

  // Cache hit rate = cached input tokens as a share of all input tokens. Only
  // meaningful (and shown) once the provider has actually reported input tokens.
  const cacheRate =
    usage.inputTokens > 0
      ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)
      : null

  return (
    <div className="token-group">
      <div className="token-group-title">{label}</div>
      <dl>
        {rows.map(([k, v]) => (
          <div className="token-row" key={k}>
            <dt>{k}</dt>
            <dd>{v.toLocaleString()}</dd>
          </div>
        ))}
        {cacheRate !== null && (
          <div className="token-row token-rate">
            <dt>{t.tokenCacheRate}</dt>
            <dd>{cacheRate}%</dd>
          </div>
        )}
      </dl>
    </div>
  )
}
