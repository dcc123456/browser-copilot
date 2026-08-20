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
} from '../lib/messages'
import { DEFAULT_CONVERSATION_ID } from '../lib/storage'
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
 * Fixed conversation id.
 *
 * Closing the panel destroys this JavaScript context, so a per-instance random id
 * would silently start a new conversation on every reopen — defeating the whole
 * point of running in the background. A constant id makes collapse-and-return
 * resume the same thread.
 */
const CONVERSATION_ID = DEFAULT_CONVERSATION_ID

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
  const [includePage, setIncludePage] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirms, setConfirms] = useState<PendingConfirm[]>([])

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
            const restored = (message.messages ?? []).map((entry) => ({
              id: nextId(),
              role: entry.role,
              text: entry.text,
            }))
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
          conversationId: CONVERSATION_ID,
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
  }, [append, appendDelta])

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
    const text = draft.trim()
    if (!text || busy) return

    const delivered = post({
      type: 'chat',
      conversationId: CONVERSATION_ID,
      text,
      includePage,
      ...(activeSkillId ? { skillId: activeSkillId } : {}),
    })
    if (!delivered) {
      append({
        role: 'error',
        text: t.chatExtensionReloaded,
      })
      return
    }

    append({ role: 'user', text })
    streamingRef.current = null
    setBusy(true)
    setDraft('')
  }

  const answerConfirm = (requestId: string, approved: boolean): void => {
    post({ type: 'confirm', requestId, approved })
    setConfirms((prev) => prev.filter((item) => item.requestId !== requestId))
  }

  const resetChat = (): void => {
    post({ type: 'reset', conversationId: CONVERSATION_ID })
    setEntries([])
    setConfirms([])
    streamingRef.current = null
    setBusy(false)
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

    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
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
            <pre>{confirm.argsPreview}</pre>
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

      <div className="composer">
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
                  // Mouse down, not click: click fires after blur, which would
                  // close the menu before the pick was registered.
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
          onBlur={closeMenu}
          onClick={(event) => syncMenu(draft, event.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          placeholder={skills.length > 0 ? t.chatPlaceholderWithSkills : t.chatPlaceholder}
          ref={textareaRef}
          value={draft}
        />
        <div className="composer-row">
          <label className="inline-check">
            <input
              checked={includePage}
              onChange={(event) => setIncludePage(event.target.checked)}
              type="checkbox"
            />
            {t.chatAttachPage}
          </label>
          <div className="actions" style={{ margin: 0 }}>
            {entries.length > 0 && !busy && (
              <button onClick={resetChat} type="button">
                {t.chatNewChat}
              </button>
            )}
            {busy && (
              <button onClick={() => post({ type: 'cancel' })} type="button">
                {t.chatStop}
              </button>
            )}
            <button className="primary" disabled={busy || !draft.trim()} onClick={send} type="button">
              {busy ? t.loading : t.chatSend}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
