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
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  AGENT_PORT,
  type AgentClientMessage,
  type AgentServerMessage,
  type TurnTokenUsage,
  emitReviewLog,
  onReviewLog,
  sendCommand,
} from '../lib/messages'
import {
  applyAiPrefillOptions,
  aiPrefillSteps,
  DEFAULT_CONVERSATION_ID,
  newId,
  workflowFromHistory,
  type AiPrefillStep,
} from '../lib/storage'
import {
  applyNodeKeepSelection,
  reviewStepsOf,
  type ReviewStep,
  type WorkflowReview,
} from '../lib/workflow/review-patch'
import { WorkflowReviewDialog } from './WorkflowReviewList'
import type { Workflow } from '../lib/workflow/types'
import type { AgentMode, ConversationMeta } from '../lib/types'
import { confirmDialog } from '../ui/confirm'
import {
  applySlashPick,
  filterSkills,
  findSlashQuery,
  moveSelection,
  type SlashQuery,
} from '../lib/slash'
import type { Skill } from '../lib/types'
import {
  FILE_INPUT_ACCEPT,
  fileToDraft,
  isImageAttachment,
  toAttachmentSummaries,
  validateAttachmentMeta,
  type AttachmentDescriptor,
  type AttachmentErrorCode,
  type AttachmentSummary,
} from '../lib/attachments'
import { useT } from './i18n'
import Markdown from './Markdown'
import { downloadAnswer, hasTables, type AnswerFormat } from '../lib/export-answer'
import { Check, Copy, Download, Gauge, Paperclip } from 'lucide-react'
import { normalizeSkill } from '../lib/skills'
import { detectSkillCandidatesFromMarkdown, type DetectedSkill } from '../lib/skill-detect'

/**
 * Fixed default conversation id; other conversations are generated ids.
 *
 * The currently-selected id is kept in `localStorage` so collapse-and-return
 * resumes the same thread. Unlike `chrome.storage`, `localStorage` is
 * synchronously available on first paint, which avoids a flash of the wrong
 * conversation.
 */
const STORED_CONV_KEY = 'browser-copilot:active-conversation'

/**
 * The "current conversation" pointer is PER WINDOW.
 *
 * `localStorage` is shared by every panel instance (one extension origin), so
 * a single key made two windows' panels open onto the same thread — and the
 * worker serializes turns within a conversation (`activeTurns`), so two
 * windows could not work in parallel by default. Keying by windowId gives
 * each window its own pointer; before the window id resolves (and in tests)
 * the legacy global key applies.
 */
export function storedConvKey(windowId?: number): string {
  return typeof windowId === 'number' ? `${STORED_CONV_KEY}:${windowId}` : STORED_CONV_KEY
}

/** Empty token tally, used when (re)starting a conversation's counters. */
const ZERO_USAGE: TurnTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
}

function loadStoredConversationId(windowId?: number): string {
  try {
    return localStorage.getItem(storedConvKey(windowId)) || DEFAULT_CONVERSATION_ID
  } catch {
    return DEFAULT_CONVERSATION_ID
  }
}

/** One rendered transcript entry. */
interface Entry {
  id: string
  role: 'user' | 'assistant' | 'status' | 'error' | 'tool'
  text: string
  /** Files carried by a user turn, as slimmed summaries (no inline text). */
  attachments?: AttachmentSummary[]
  /** Token usage of the completed turn this assistant reply belongs to (hover). */
  usage?: TurnTokenUsage
}

/** A tool call awaiting the user's decision. */
interface PendingConfirm {
  requestId: string
  name: string
  argsPreview: string
}

/**
 * State of the "save this session as a workflow?" card plus its save-time AI
 * node review. `reviewing` while the background verdict is in flight;
 * `review: null` after it settled means unavailable — every step stays.
 * `keep` (stepId → keep) is `null` until the review lands; the absent case
 * keeps everything. `reviewOpen` is true only while the review dialog the
 * "Save as workflow" click opened is showing. `reviewLog` accumulates the
 * dialog's progress lines (sent → verdict / failure) across retries.
 */
interface WorkflowPromptState {
  conversationId: string
  /** Unmodified workflow the prompt was built from, for re-deriving on toggle. */
  base: Workflow
  /** Form fields the generator flagged as AI-composable, with their capture text. */
  aiSteps: AiPrefillStep[]
  /** Per-node checkbox state; absent = enabled (the default). */
  aiSelections: Record<string, boolean>
  workflow: Workflow
  steps: number
  reviewing: boolean
  review: WorkflowReview | null
  /** Failure reason of the last review attempt (timeout / endpoint / parse). */
  reviewError: string | null
  /** True while the save-time review dialog is open. */
  reviewOpen: boolean
  /** Ordered review progress lines shown in the dialog. */
  reviewLog: string[]
  /** True while the persist command is in flight (blocks double clicks). */
  saving: boolean
  /** Failure reason of the last save attempt; the dialog stays open for a retry. */
  saveError: string | null
  keep: Record<string, boolean> | null
  /** Reviewable steps of the base workflow, in chain order (stable). */
  stepList: ReviewStep[]
}

let counter = 0
const nextId = (): string => `e${(counter += 1)}`

/** Attachment thumbnails/chips rendered under a message bubble. */
function MessageAttachments({ attachments }: { attachments?: AttachmentSummary[] }) {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="msg-attachments">
      {attachments.map((attachment) =>
        isImageAttachment(attachment) && attachment.dataUrl ? (
          <img
            alt={attachment.name}
            className="attach-thumb"
            key={attachment.id}
            src={attachment.dataUrl}
            title={attachment.name}
          />
        ) : (
          <span className="attach-chip" key={attachment.id} title={attachment.name}>
            <Paperclip size={13} aria-hidden="true" /> {attachment.name}
          </span>
        ),
      )}
    </div>
  )
}

/**
 * Copy / download actions rendered on user and assistant bubbles.
 *
 * Copying writes the raw `entry.text` (plain text for the user's own words,
 * raw Markdown for an assistant reply — the form most useful to paste back
 * into another tool). Assistant bubbles additionally offer a download menu
 * (Markdown / plain text / printable HTML) driven by `lib/export-answer`.
 *
 * The buttons sit in the top-right corner and only show on hover / keyboard
 * focus, so they never block the transcript on a touch-less desktop.
 */
function MsgActions({
  entry,
  title,
  t,
  isLastAssistant,
  busy,
}: {
  entry: Entry
  title: string
  t: ReturnType<typeof useT>
  isLastAssistant: boolean
  busy: boolean
}) {
  if (entry.role !== 'user' && entry.role !== 'assistant') return null
  const isAssistant = entry.role === 'assistant'
  // While a turn is still answering, intermediate replies (everything except
  // the newest assistant message) show no actions at all — their content is
  // still evolving context, not a finished answer worth copying or exporting.
  if (busy && isAssistant && !isLastAssistant) return null
  // Only the last assistant reply gets any buttons at all (copy + download +
  // token); earlier assistant messages show none so the transcript stays calm.
  if (isAssistant && !isLastAssistant) return null
  // Download and the token gauge only appear on that turn's closing answer.
  const isFinal = isAssistant && isLastAssistant
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [menuOpen, setMenuOpen] = useState(false)

  const copy = (): void => {
    void navigator.clipboard
      .writeText(entry.text)
      .then(() => setState('copied'))
      .catch(() => {
        // Clipboard writes can be refused (unfocused document, a browser
        // policy); say so rather than look like a no-op — the text stays
        // selectable, so the user can still copy it by hand.
        setState('failed')
      })
      .finally(() => {
        window.setTimeout(() => setState('idle'), 1400)
      })
  }

  const download = (format: AnswerFormat): void => {
    setMenuOpen(false)
    downloadAnswer({ text: entry.text, format, title })
  }

  // Clicking anywhere outside the open menu closes it (same deferred-listener
  // trick as the mode popover; see ChatTab above).
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenuOpen(false)
    const id = window.setTimeout(() => {
      document.addEventListener('click', close, { once: true })
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('click', close)
    }
  }, [menuOpen])

  const copyLabel =
    state === 'copied' ? t.msgCopied : state === 'failed' ? t.msgCopyFailed : t.msgCopy

  return (
    <div className="msg-actions">
      <button
        aria-label={copyLabel}
        className="msg-action msg-copy"
        data-state={state}
        onClick={copy}
        title={copyLabel}
        type="button"
      >
        {state === 'copied' ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
      </button>
      {isFinal && (
        <>
          <button
            aria-label={t.msgDownload}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="msg-action msg-download"
            onClick={() => setMenuOpen((open) => !open)}
            title={t.msgDownload}
            type="button"
          >
            <Download size={13} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="msg-download-menu" role="menu">
              <div className="msg-download-title">{t.msgDownloadAs}</div>
              <button onClick={() => download('md')} type="button">
                {t.msgDownloadMd}
              </button>
              <button onClick={() => download('txt')} type="button">
                {t.msgDownloadTxt}
              </button>
              <button onClick={() => download('html')} type="button">
                {t.msgDownloadHtmlPdf}
              </button>
              {hasTables(entry.text) && (
                <button onClick={() => download('csv')} type="button">
                  {t.msgDownloadCsv}
                </button>
              )}
            </div>
          )}
          {isFinal && !!entry.usage && (
            <div className="msg-token" tabIndex={0} role="button" aria-label={t.msgTokenUsage}>
              <Gauge size={13} aria-hidden="true" />
              <div className="msg-token-tip">
                <span className="msg-token-tip-title">{t.tokenBarLastTurn}</span>
                <span className="msg-token-tip-kv">
                  {t.tokenBarT}:{formatTokens(entry.usage!.totalTokens)}
                </span>
                <span className="msg-token-tip-kv">
                  {t.tokenBarI}:{formatTokens(entry.usage!.inputTokens)}
                </span>
                <span className="msg-token-tip-kv">
                  {t.tokenBarO}:{formatTokens(entry.usage!.outputTokens)}
                </span>
                <span className="msg-token-tip-kv">
                  {t.tokenBarR}:{formatTokens(entry.usage!.reasoningTokens ?? 0)}
                </span>
                <span className="msg-token-tip-kv">
                  {t.tokenBarC}:{formatTokens(entry.usage!.cachedInputTokens ?? 0)}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Editable fields of a generated-skill card; kept separate from `Skill` so the
 * form may hold an invalid (or empty) draft while the user is still typing. */
interface SkillForm {
  name: string
  description: string
  instructions: string
  autoMatch: boolean
}

function toSkillForm(skill: Skill): SkillForm {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    autoMatch: skill.autoMatch,
  }
}

/**
 * Renders the generated-skill cards found in an assistant reply (see
 * `msg-actions` UI, below). Each assistant message is scanned once and every
 * recognised skill block becomes a card where the user can save it straight
 * into the project's skill store, open an inline editor to tweak it first, or
 * dismiss it.
 */
function GeneratedSkillCards({
  assistantText,
  t,
  onSaved,
}: {
  assistantText: string
  t: ReturnType<typeof useT>
  onSaved: (statusText: string) => void
}) {
  const candidates = detectSkillCandidatesFromMarkdown(assistantText)
  if (candidates.length === 0) return null
  return (
    <div className="generated-skill-list">
      {candidates.map((item, index) => (
        <GeneratedSkillCard
          detected={item}
          key={`${item.draft.name}-${index}`}
          onSaved={onSaved}
          t={t}
        />
      ))}
    </div>
  )
}

/** One save-an-inline-edited / dismiss card for a detected skill. */
function GeneratedSkillCard({
  detected,
  onSaved,
  t,
}: {
  detected: DetectedSkill
  onSaved: (statusText: string) => void
  t: ReturnType<typeof useT>
}) {
  const [dismissed, setDismissed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<SkillForm>(() => toSkillForm(detected.draft))
  const [errorText, setErrorText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (dismissed) return null

  // Same validation-code mapping the Skills tab uses, so a name clash or a
  // missing field reads in the panel's language rather than the worker's.
  const describeError = (error: Error): string => {
    const message = error.message
    if (!message.startsWith('skill:')) return message
    const codes = message.slice('skill:'.length).split(',')
    const lookup: Record<string, string> = {
      nameRequired: t.skillsNameRequired,
      instructionsRequired: t.skillsInstructionsRequired,
      nameTaken: t.skillsNameTaken,
    }
    return codes
      .map((code) => lookup[code] ?? code)
      .filter((text, index, all) => all.indexOf(text) === index)
      .join(' ')
  }

  const persist = async (
    name: string,
    description: string,
    instructions: string,
    autoMatch: boolean,
  ): Promise<void> => {
    const skill: Skill = normalizeSkill({
      ...detected.draft,
      name,
      description,
      instructions,
      autoMatch,
      updatedAt: Date.now(),
    })
    setSaving(true)
    setErrorText(null)
    try {
      const result = await sendCommand({ type: 'skills.save', skill })
      const saved = result.type === 'skills.save' ? result.skill : skill
      onSaved(t.skillSavedBanner({ name: saved.name }))
      setDismissed(true)
    } catch (error) {
      setErrorText(describeError(error as Error))
    } finally {
      setSaving(false)
    }
  }

  const saveAsIs = (): void =>
    void persist(
      detected.draft.name,
      detected.draft.description,
      detected.draft.instructions,
      detected.draft.autoMatch,
    )

  const saveEdited = (): void =>
    void persist(form.name, form.description, form.instructions, form.autoMatch)

  const startEditing = (): void => {
    setForm(toSkillForm(detected.draft))
    setEditing(true)
    setErrorText(null)
  }

  return (
    <div className="card generated-skill-card">
      {editing ? (
        <>
          <div className="card-title">{t.skillSaveEdit}</div>
          <label className="field">
            <span>{t.skillName}</span>
            <input
              maxLength={60}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              value={form.name}
            />
          </label>
          <label className="field">
            <span>{t.skillDescription}</span>
            <input
              maxLength={300}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              value={form.description}
            />
          </label>
          <label className="field">
            <span>{t.skillInstructions}</span>
            <textarea
              maxLength={8000}
              onChange={(event) => setForm({ ...form, instructions: event.target.value })}
              rows={6}
              value={form.instructions}
            />
          </label>
          <label className="checkbox">
            <input
              checked={form.autoMatch}
              onChange={(event) => setForm({ ...form, autoMatch: event.target.checked })}
              type="checkbox"
            />
            <span>{t.skillAutoMatch}</span>
          </label>
          {errorText && (
            <div className="banner" data-kind="error">
              {errorText}
            </div>
          )}
          <div className="actions">
            <button className="primary" disabled={saving} onClick={saveEdited} type="button">
              {t.save}
            </button>
            <button
              disabled={saving}
              onClick={() => {
                setEditing(false)
                setErrorText(null)
              }}
              type="button"
            >
              {t.cancel}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="card-title">{t.skillGeneratedPreview}</div>
          <div className="generated-skill-name">{detected.draft.name}</div>
          {detected.draft.description && <p className="hint">{detected.draft.description}</p>}
          <details className="generated-skill-instructions">
            <summary>{t.skillInstructions}</summary>
            <pre>{detected.draft.instructions}</pre>
          </details>
          {errorText && (
            <div className="banner" data-kind="error">
              {errorText}
            </div>
          )}
          <div className="actions">
            <button className="primary" disabled={saving} onClick={saveAsIs} type="button">
              {t.skillSave}
            </button>
            <button disabled={saving} onClick={startEditing} type="button">
              {t.skillSaveEdit}
            </button>
            <button disabled={saving} onClick={() => setDismissed(true)} type="button">
              {t.skillDiscard}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Localized text for one rejected file, shown as a status line. */
function attachmentErrorText(
  t: ReturnType<typeof useT>,
  name: string,
  code: AttachmentErrorCode,
): string {
  switch (code) {
    case 'too-many':
      return t.chatAttachmentTooMany
    case 'unsupported':
      return t.chatAttachmentUnsupported({ name })
    case 'too-large-image':
    case 'too-large-text':
      return t.chatAttachmentTooLarge({ name })
    case 'total-too-large':
      return t.chatAttachmentTotalTooLarge
  }
}

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
  /** Files staged for the next message, mirrored in a ref for sequential validation. */
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentDescriptor[]>([])
  const pendingAttachmentsRef = useRef<AttachmentDescriptor[]>([])
  /** Hidden `<input type="file">` behind the 📎 composer button. */
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [includeSelection, setIncludeSelection] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirms, setConfirms] = useState<PendingConfirm[]>([])
  const [conversationId, setConversationId] = useState<string>(() => loadStoredConversationId())
  /**
   * This panel's browser window, resolved once after mount. Gates the
   * per-window "current conversation" pointer below (see storedConvKey).
   */
  const [panelWindowId, setPanelWindowId] = useState<number | undefined>(undefined)
  /**
   * Whether the per-window conversation pointer has been adopted.
   *
   * Mount-time `conversationId` comes from the legacy global key, which can
   * be arbitrarily stale after the per-window split. Until the window id
   * resolves and the pointer is adopted we must neither persist (writing the
   * stale legacy id into the per-window key would clobber the conversation
   * this window was last using) nor resume (it would briefly restore a
   * foreign transcript and race the adoption switch).
   */
  const [conversationAdopted, setConversationAdopted] = useState(false)
  const adoptedRef = useRef(false)
  /** Bumped when adoption completes so the port effect re-runs and resumes. */
  const [resumeTick, setResumeTick] = useState(0)
  /** Latest conversationId for listeners outside the React render cycle. */
  const conversationIdRef = useRef(conversationId)
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])
  /**
   * Adoption fallback for panels without a resolvable window id (or a failed
   * `windows.getCurrent`): unblock resume/persistence on the legacy global
   * pointer instead of waiting forever.
   */
  const adoptFallback = useCallback(() => {
    if (adoptedRef.current) return
    adoptedRef.current = true
    setConversationAdopted(true)
    setResumeTick((tick) => tick + 1)
  }, [])
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [showHistory, setShowHistory] = useState(false)
  /** Conversation whose messages are being previewed in the history drawer. */
  const [previewConv, setPreviewConv] = useState<{
    id: string
    title: string
    messages: {
      role: string
      text: string
      attachments?: AttachmentSummary[]
    }[]
  } | null>(null)
  const [mode, setMode] = useState<AgentMode>('semi')
  const [modeInfoOpen, setModeInfoOpen] = useState(false)
  /**
   * 「保存工作流」开关：开启后 agent 逐条执行（不用 run_plan 批量执行），
   * 每个动作单独入历史，「从历史生成工作流」的算子节点才完整。
   */
  const [saveWorkflow, setSaveWorkflow] = useState(false)
  /** Summed usage across turns in this conversation. */
  const [sessionUsage, setSessionUsage] = useState<TurnTokenUsage>(() => ({
    ...ZERO_USAGE,
  }))

  /**
   * Last cumulative turn usage this panel already folded into `sessionUsage`.
   * The worker pushes a fresh cumulative snapshot after every model request;
   * adding the delta against this keeps the live bar exact even if a snapshot
   * is missed, and the final `done` usage normally contributes zero.
   */
  const turnUsageRef = useRef<TurnTokenUsage | null>(null)
  const applyTurnUsage = useCallback((usage: TurnTokenUsage) => {
    const last = turnUsageRef.current ?? ZERO_USAGE
    turnUsageRef.current = { ...usage }
    // Math.max(0, …) keeps a regressive or out-of-order snapshot from making
    // the session tally go backwards.
    setSessionUsage((prev) => ({
      inputTokens: prev.inputTokens + Math.max(0, usage.inputTokens - last.inputTokens),
      outputTokens: prev.outputTokens + Math.max(0, usage.outputTokens - last.outputTokens),
      cachedInputTokens:
        prev.cachedInputTokens +
        Math.max(0, (usage.cachedInputTokens ?? 0) - (last.cachedInputTokens ?? 0)),
      reasoningTokens:
        prev.reasoningTokens +
        Math.max(0, (usage.reasoningTokens ?? 0) - (last.reasoningTokens ?? 0)),
      totalTokens: prev.totalTokens + Math.max(0, usage.totalTokens - last.totalTokens),
    }))
  }, [])

  // Each conversation gets its own token tally; reset when starting or opening
  // another conversation so the chip reflects only the current one.
  const resetUsage = useCallback(() => {
    turnUsageRef.current = null
    setSessionUsage({ ...ZERO_USAGE })
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

  // Drag-to-resize for the composer. Pointer events so it works with mouse and
  // touch; dragging up grows the composer (and shrinks the chat log).
  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    draggingRef.current = {
      startY: event.clientY,
      startHeight: composerHeight,
    }
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
  /**
   * Holds the live connect() routine so post() can trigger a full reconnect
   * (listener + heartbeat + resume) after the worker was evicted. A bare
   * `chrome.runtime.connect` in post() would open a port that receives
   * messages but never listens for them, silently dropping the reply.
   */
  const connectRef = useRef<(() => void) | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** Tracks an in-progress IME composition so Enter confirms it, not send. */
  const composingRef = useRef(false)
  /** Id of the assistant entry currently being streamed into. */
  const streamingRef = useRef<string | null>(null)
  /** Id of the transient "phase" status entry (preparing/sending/…). */
  const phaseRef = useRef<string | null>(null)
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

  /**
   * "Save this session as a workflow?" call-to-action, shown right after a turn
   * that actually performed page operations in semi/full-auto. `conversationId`
   * guards against saving another conversation's flow by mistake.
   *
   * The AI node review does NOT run while the card is open — it starts only
   * when the user clicks "Save as workflow", which opens the review dialog
   * (`reviewOpen`). A failed attempt (`reviewError`) can be retried by
   * clicking save again; a landed verdict is reused.
   */
  const [workflowPrompt, setWorkflowPrompt] = useState<WorkflowPromptState | null>(null)
  /** Last reuseable-step count we already asked about per conversation. */
  const promptedRef = useRef<Record<string, number>>({})
  const conversationsRef = useRef<ConversationMeta[]>(conversations)
  conversationsRef.current = conversations

  // Live AI review log: the port forwards pushed lines via emitReviewLog;
  // this subscription renders them in the open review dialog as they arrive.
  useEffect(() => {
    return onReviewLog((text) => {
      setWorkflowPrompt((prev) =>
        prev && prev.reviewOpen ? { ...prev, reviewLog: [...prev.reviewLog, text] } : prev,
      )
    })
  }, [])

  /**
   * After a turn that performed page operations, offer to persist them as a
   * reusable workflow. Only actions that actually ran (approved + ok) in this
   * conversation count; if none map to a block we stay quiet. A per-conversation
   * counter means we only ask again once new steps have accumulated.
   *
   * The card opens WITHOUT the AI node review — that starts only when the user
   * clicks "Save as workflow" (see {@link savePromptWorkflow}).
   */
  const maybePromptSaveWorkflow = useCallback(async (convId: string) => {
    let result: Awaited<ReturnType<typeof sendCommand>>
    try {
      result = await sendCommand({ type: 'history.list' })
    } catch {
      return
    }
    if (result.type !== 'history.list') return
    const session = result.entries
      .filter((e) => e.conversationId === convId && e.ok && e.approved)
      .sort((a, b) => a.at - b.at)
    const meta = conversationsRef.current.find((c) => c.id === convId)
    const name = (meta?.title ?? '').trim() || `session-${convId.slice(0, 6)}`
    const workflow = workflowFromHistory(session, name)
    if (!workflow) return
    const aiSteps = aiPrefillSteps(workflow)
    const aiSelections = Object.fromEntries(aiSteps.map((s) => [s.nodeId, true]))
    const steps = workflow.drawflow.nodes.length
    if (steps === 0) return
    if ((promptedRef.current[convId] ?? 0) >= steps) return
    promptedRef.current[convId] = steps
    setWorkflowPrompt({
      conversationId: convId,
      base: workflow,
      workflow,
      aiSteps,
      aiSelections,
      steps,
      reviewing: false,
      review: null,
      reviewError: null,
      reviewOpen: false,
      reviewLog: [],
      saving: false,
      saveError: null,
      keep: null,
      stepList: reviewStepsOf(workflow),
    })
  }, [])

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

  /**
   * Shows (or replaces) the one-line progress phase between pressing send and
   * the first token. Reusing a single entry — rather than appending a new line
   * per phase — keeps the turn from looking like a pile of statuses. The entry
   * is removed once real text or a tool call starts.
   */
  const showPhase = useCallback((label: string) => {
    setEntries((prev) => {
      const existing = phaseRef.current
      if (existing) {
        return prev.map((entry) => (entry.id === existing ? { ...entry, text: label } : entry))
      }
      const id = nextId()
      phaseRef.current = id
      return [...prev, { id, role: 'status' as const, text: label }]
    })
  }, [])

  const clearPhase = useCallback(() => {
    const id = phaseRef.current
    if (!id) return
    phaseRef.current = null
    setEntries((prev) => prev.filter((entry) => entry.id !== id))
  }, [])

  useEffect(() => {
    closedRef.current = false
    let heartbeat: number | undefined
    let retry: number | undefined

    const connect = (): void => {
      if (closedRef.current) return

      const port = chrome.runtime.connect({ name: AGENT_PORT })
      portRef.current = port
      // The panel is a window-level UI, not a tab, so the worker cannot rely
      // on port.sender.tab to know which window we belong to. State it
      // explicitly right after connecting (re-sent on every reconnect, so a
      // worker restart re-registers too).
      void chrome.windows.getCurrent().then((win) => {
        if (typeof win.id === 'number') {
          setPanelWindowId(win.id)
          try {
            port.postMessage({ type: 'panel.hello', windowId: win.id } satisfies AgentClientMessage)
          } catch {
            /* port closed between connect and hello — the next reconnect resends */
          }
        } else {
          // No usable window id: adopt immediately so the legacy global
          // pointer keeps working and the resume below is not blocked.
          adoptFallback()
        }
      }, adoptFallback)
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
                return {
                  id: nextId(),
                  role: 'tool' as const,
                  text: entry.text,
                }
              }
              return {
                id: nextId(),
                role: entry.role as 'user' | 'assistant',
                text: entry.text,
                ...(entry.role === 'user' && entry.attachments?.length
                  ? { attachments: entry.attachments }
                  : {}),
              }
            })
            setEntries(restored)
            // While a turn is still running, continue its stream into the last
            // restored assistant entry. Starting a fresh bubble here would
            // split the reply's tail (often its final line) into a second
            // paragraph after every reconnect.
            const lastAssistant = [...restored].reverse().find((e) => e.role === 'assistant')
            streamingRef.current = message.running && lastAssistant ? lastAssistant.id : null
            setBusy(message.running)
            if (message.running) {
              setEntries((prev) => [
                ...prev,
                {
                  id: nextId(),
                  role: 'status',
                  text: tRef.current.chatReattached,
                },
              ])
            }
            break
          }
          case 'delta':
            clearPhase()
            appendDelta(message.text)
            break
          case 'tool.start':
            clearPhase()
            streamingRef.current = null
            append({ role: 'tool', text: `→ ${message.name}` })
            break
          case 'tool.result':
            append({
              role: 'tool',
              text: `← ${message.name}: ${message.summary}`,
            })
            break
          case 'confirm.request':
            setConfirms((prev) => [...prev, message])
            break
          case 'status':
            // Free-form statuses (selection read results, etc.) replace the
            // transient phase line too, so they don't pile up.
            clearPhase()
            append({ role: 'status', text: message.text })
            break
          case 'workflows.reviewLog':
            // Live AI review progress: forward into the shared fan-out so the
            // open review dialog (here or in the history tab) renders it.
            emitReviewLog(message.text)
            break
          case 'phase': {
            const labels: Record<typeof message.phase, string> = {
              preparing: tRef.current.phasePreparing,
              'reading-page': tRef.current.phaseReadingPage,
              sending: tRef.current.phaseSending,
              thinking: tRef.current.phaseThinking,
              responding: tRef.current.phaseResponding,
            }
            showPhase(labels[message.phase])
            break
          }
          case 'usage': {
            // Live token bar: the worker pushes the turn's cumulative usage
            // after every model request completes. Tag the bubble currently
            // streaming so its hover breakdown keeps up too; `done` re-tags
            // the final one with the turn total.
            const liveId = streamingRef.current
            if (liveId) {
              setEntries((prev) =>
                prev.map((entry) =>
                  entry.id === liveId ? { ...entry, usage: message.usage } : entry,
                ),
              )
            }
            applyTurnUsage(message.usage)
            break
          }
          case 'done': {
            clearPhase()
            const finishingId = streamingRef.current
            streamingRef.current = null
            setBusy(false)
            void maybePromptSaveWorkflow(conversationId)
            if (message.usage) {
              // Tag the just-finished assistant bubble so hovering it shows the
              // turn's own token breakdown (the flat bar only sums the session).
              if (finishingId) {
                setEntries((prev) =>
                  prev.map((entry) =>
                    entry.id === finishingId ? { ...entry, usage: message.usage } : entry,
                  ),
                )
              }
              // Delta only: per-request `usage` messages already applied the
              // running total while the turn streamed, so this normally adds
              // zero — but it still covers a snapshot that never arrived.
              applyTurnUsage(message.usage)
            }
            break
          }
          case 'error':
            clearPhase()
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
      // Skipped until this window's conversation pointer is adopted: before
      // that the id is the possibly-stale legacy one, and resuming it would
      // flash a foreign transcript and race the adoption switch.
      if (adoptedRef.current) {
        try {
          port.postMessage({
            type: 'resume',
            conversationId,
          } satisfies AgentClientMessage)
        } catch {
          // The disconnect listener handles recovery.
        }
      }
    }

    connect()
    connectRef.current = connect

    return () => {
      closedRef.current = true
      connectRef.current = null
      window.clearInterval(heartbeat)
      window.clearTimeout(retry)
      portRef.current?.disconnect()
      portRef.current = null
    }
  }, [
    append,
    appendDelta,
    applyTurnUsage,
    clearPhase,
    conversationId,
    maybePromptSaveWorkflow,
    resumeTick,
    showPhase,
  ])

  // A turn that was still running when this panel (re)connected streams into
  // the port it was born with — which is gone. It broadcasts
  // `conversation.ended` when it finishes; re-pull the final transcript then,
  // otherwise the panel would keep showing the mid-turn snapshot with a busy
  // spinner until manual reload.
  useEffect(() => {
    // Guarded: some test stubs provide a partial `chrome.runtime` without
    // `onMessage`; the broadcast is an optimization, not a hard dependency.
    const onMessage = chrome.runtime?.onMessage
    if (!onMessage) return
    const listener: Parameters<typeof onMessage.addListener>[0] = (
      raw,
      _sender,
      sendResponse,
    ): void => {
      const message = raw as { type?: string; conversationId?: string }
      if (message?.type !== 'conversation.ended') return
      if (message.conversationId === conversationIdRef.current) {
        try {
          portRef.current?.postMessage({
            type: 'resume',
            conversationId: conversationIdRef.current,
          } satisfies AgentClientMessage)
        } catch {
          /* the reconnect loop resumes on its own */
        }
      }
      sendResponse({ ok: true })
    }
    onMessage.addListener(listener)
    return () => onMessage.removeListener(listener)
  }, [])

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
        if (result.type === 'settings') {
          setMode(result.settings.mode)
          setSaveWorkflow(result.settings.saveWorkflowFromChat === true)
        }
      } catch {
        /* keep default */
      }
    })()
  }, [])

  const toggleSaveWorkflow = async (): Promise<void> => {
    const next = !saveWorkflow
    setSaveWorkflow(next)
    try {
      await sendCommand({ type: 'settings.set', patch: { saveWorkflowFromChat: next } })
    } catch {
      /* non-fatal; worker will still use default on next turn */
    }
  }

  const changeMode = async (next: AgentMode): Promise<void> => {
    if (
      next === 'full' &&
      !(await confirmDialog({
        title: t.dialogWarningTitle,
        message: t.modeFullWarning,
        confirmText: t.dialogConfirm,
        cancelText: t.cancel,
        danger: true,
      }))
    ) {
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
    // Persist only the adopted pointer. Running this before adoption is the
    // bug: the mount render still holds the stale legacy id, and writing it
    // into the per-window key overwrote the conversation this window was
    // actually using — so a reopened panel landed on the wrong thread.
    if (!conversationAdopted) return
    try {
      localStorage.setItem(storedConvKey(panelWindowId), conversationId)
    } catch {
      /* ignore */
    }
  }, [conversationAdopted, conversationId, panelWindowId])

  // Adopt this window's own conversation pointer once the window id resolves.
  // First open after the split seeds the per-window key from the legacy global
  // pointer (pre-split behaviour), then the two windows diverge freely. The
  // port's resume effect fires on the resulting conversationId change and
  // restores the right transcript.
  useEffect(() => {
    if (panelWindowId === undefined) return
    const key = storedConvKey(panelWindowId)
    let stored: string | null = null
    try {
      stored = localStorage.getItem(key)
    } catch {
      /* ignore */
    }
    if (stored === null) {
      const legacy = loadStoredConversationId()
      try {
        localStorage.setItem(key, legacy)
      } catch {
        /* ignore */
      }
      setConversationId(legacy)
    } else if (stored !== conversationId) {
      setConversationId(stored)
    }
    // Unblock the port's transcript resume and per-window persistence even
    // when the id did not change (stored === conversationId): the resume was
    // skipped pre-adoption, so it must be requested now.
    adoptedRef.current = true
    setConversationAdopted(true)
    setResumeTick((tick) => tick + 1)
    // Owns the initial window-scoped selection; reruns on conversationId are
    // no-ops (the pointer is already in sync).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelWindowId])

  const openConversation = (id: string): void => {
    if (busy) return
    setShowHistory(false)
    setPreviewConv(null)
    if (id === conversationId) return
    setConversationId(id)
    setEntries([])
    setConfirms([])
    setWorkflowPrompt(null)
    streamingRef.current = null
    resetUsage()
    // The port's resume effect fires on conversationId change and restores.
  }

  // History tab's "continue chat" button dispatches this window event so it
  // can resume a conversation without importing ChatTab. The app shell flips
  // to the Chat tab in parallel; we just open the thread here.
  useEffect(() => {
    const handler = (event: Event): void => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id
      if (id) openConversation(id)
    }
    window.addEventListener('bc:open-conversation', handler)
    return () => window.removeEventListener('bc:open-conversation', handler)
    // openConversation references `busy` and several setters; re-binding on
    // every render is cheap and ensures we never hold a stale closure over
    // `busy`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  const startNewConversation = (): void => {
    if (busy) return
    setShowHistory(false)
    const id = newId()
    setConversationId(id)
    setEntries([])
    setConfirms([])
    setWorkflowPrompt(null)
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
    const ok = await confirmDialog({
      title: t.dialogDeleteTitle,
      message: t.convDeleteConfirm,
      confirmText: t.delete,
      cancelText: t.cancel,
      danger: true,
    })
    if (!ok) return
    try {
      await sendCommand({ type: 'conversations.delete', id })
    } catch {
      /* ignore */
    }
    if (id === conversationId) {
      setEntries([])
      setConfirms([])
      setWorkflowPrompt(null)
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
        setPreviewConv({
          id: result.id,
          title: result.title,
          messages: result.messages,
        })
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
      // The worker was likely evicted. Reconnect through the full path (which
      // re-attaches listeners and resumes), then send once the new port exists.
      try {
        connectRef.current?.()
        if (!portRef.current) return false
        portRef.current.postMessage(message)
        return true
      } catch {
        return false
      }
    }
  }

  /** Stages picked/pasted/dropped files, rejecting invalid ones with a status line. */
  const addFiles = async (files: FileList | File[] | null): Promise<void> => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      const code = validateAttachmentMeta(
        { mimeType: file.type, name: file.name, size: file.size },
        pendingAttachmentsRef.current,
      )
      if (code) {
        append({
          role: 'status',
          text: attachmentErrorText(t, file.name, code),
        })
        continue
      }
      try {
        const staged = await fileToDraft(file)
        const next = [...pendingAttachmentsRef.current, staged]
        pendingAttachmentsRef.current = next
        setPendingAttachments(next)
      } catch (error) {
        append({
          role: 'status',
          text: `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  const removeAttachment = (id: string): void => {
    const next = pendingAttachmentsRef.current.filter((attachment) => attachment.id !== id)
    pendingAttachmentsRef.current = next
    setPendingAttachments(next)
  }

  const send = (): void => {
    if (busy) return
    const text = draft.trim()
    // An active skill or a staged attachment may be sent with no additional
    // text — the skill's own instructions or the files themselves become the
    // task. Otherwise a message is required.
    if (!text && !activeSkillId && pendingAttachments.length === 0) return

    // When the user just selected a skill and hit send, name the skill explicitly
    // so the model ties the turn to the active-skill block in the system prompt
    // (rather than receiving a vague "use the skill" nudge it may refuse). When
    // "attach selection" is on, point the skill at the selected text.
    let outgoing = text
    if (!outgoing) {
      const skill = activeSkillId ? skills.find((entry) => entry.id === activeSkillId) : undefined
      const name = skill?.name ?? ''
      outgoing = includeSelection ? t.chatSkillGoSelection({ name }) : t.chatSkillGo({ name })
    }

    const delivered = post({
      type: 'chat',
      conversationId,
      text: outgoing,
      includeSelection,
      ...(activeSkillId ? { skillId: activeSkillId } : {}),
      ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
    })
    if (!delivered) {
      append({
        role: 'error',
        text: t.chatExtensionReloaded,
      })
      return
    }

    append({
      role: 'user',
      text: outgoing,
      // Summaries only: the full text content went to the worker with the
      // message, and the transcript rendering never needs it twice.
      ...(pendingAttachments.length
        ? { attachments: toAttachmentSummaries(pendingAttachments) }
        : {}),
    })
    streamingRef.current = null
    turnUsageRef.current = null
    setBusy(true)
    setDraft('')
    pendingAttachmentsRef.current = []
    setPendingAttachments([])
    setWorkflowPrompt(null)
  }

  const answerConfirm = (requestId: string, approved: boolean): void => {
    post({ type: 'confirm', requestId, approved })
    setConfirms((prev) => prev.filter((item) => item.requestId !== requestId))
  }

  /**
   * Fires the AI node review for the card's base workflow (once — an
   * in-flight or landed verdict is reused). Used by BOTH the save click and
   * the dialog's retry button: a failed attempt may be re-run arbitrarily.
   */
  const runSaveReview = (prompt: WorkflowPromptState): void => {
    if (prompt.reviewing || prompt.review) return
    setWorkflowPrompt((prev) =>
      prev
        ? {
            ...prev,
            reviewing: true,
            reviewError: null,
            reviewLog: [
              ...prev.reviewLog,
              tRef.current.workflowReviewLogStart({ steps: prev.stepList.length }),
            ],
          }
        : prev,
    )
    sendCommand({ type: 'workflows.review', workflow: prompt.base })
      .then((result) => {
        if (result.type !== 'workflows.review') return
        setWorkflowPrompt((prev) => {
          if (!prev || prev.conversationId !== prompt.conversationId) return prev
          // Materialize the verdicts into the keep set so the checkboxes AND
          // the saved result both reflect the AI judgment; steps the model
          // never mentioned stay keep=true.
          const keep: Record<string, boolean> = { ...prev.keep }
          if (result.review) {
            for (const verdict of result.review.steps) keep[verdict.id] = verdict.keep
          }
          const dropped = result.review?.steps.filter((verdict) => !verdict.keep).length ?? 0
          const logLine = result.review
            ? dropped > 0
              ? tRef.current.chatWorkflowReviewDropped({ count: dropped })
              : tRef.current.chatWorkflowReviewAllKept
            : tRef.current.workflowReviewLogFailed
          return {
            ...prev,
            reviewing: false,
            review: result.review,
            reviewError: result.error ?? null,
            reviewLog: [...prev.reviewLog, logLine],
            keep,
          }
        })
      })
      .catch((error) => {
        setWorkflowPrompt((prev) =>
          prev && prev.conversationId === prompt.conversationId
            ? {
                ...prev,
                reviewing: false,
                reviewError: (error as Error).message,
                reviewLog: [...prev.reviewLog, tRef.current.workflowReviewLogFailed],
              }
            : prev,
        )
      })
  }

  /**
   * "保存为工作流" click. With nothing to review, saves straight away;
   * otherwise OPENS the AI review dialog and runs the node review.
   */
  const savePromptWorkflow = (): void => {
    const prompt = workflowPrompt
    if (!prompt || prompt.saving) return
    if (prompt.stepList.length === 0) {
      void persistPromptWorkflow(prompt)
      return
    }
    setWorkflowPrompt((prev) => (prev ? { ...prev, reviewOpen: true } : prev))
    runSaveReview(prompt)
  }

  /** Review dialog retry: re-runs a failed/unavailable review on the spot. */
  const retrySaveReview = (): void => {
    const prompt = workflowPrompt
    if (!prompt || prompt.saving || prompt.reviewing) return
    runSaveReview(prompt)
  }

  /**
   * Applies the keep selection + AI prefill toggles and persists the workflow.
   * The card/dialog closes ONLY on success — a failed save keeps it open with
   * the reason shown, so "nothing seemed to happen" can never hide a failure.
   */
  const persistPromptWorkflow = async (prompt: WorkflowPromptState): Promise<void> => {
    setWorkflowPrompt((prev) =>
      prev && prev.conversationId === prompt.conversationId ? { ...prev, saving: true } : prev,
    )
    try {
      const workflow = derivePreview(prompt.base, prompt.keep, prompt.aiSelections)
      await sendCommand({ type: 'workflows.save', workflow })
      setWorkflowPrompt(null)
      append({
        role: 'status',
        text: tRef.current.chatSaveWorkflowSaved({ name: workflow.name }),
      })
    } catch (error) {
      const message = (error as Error).message
      setWorkflowPrompt((prev) =>
        prev && prev.conversationId === prompt.conversationId
          ? { ...prev, saving: false, saveError: message }
          : prev,
      )
      append({ role: 'error', text: message })
    }
  }

  /** Review dialog confirm: save with the (possibly AI-adjusted) keep set. */
  const confirmSaveReview = (): void => {
    const prompt = workflowPrompt
    if (!prompt) return
    void persistPromptWorkflow(prompt)
  }

  /** Review dialog cancel: back to the card, the verdict stays cached. */
  const cancelSaveReview = (): void => {
    setWorkflowPrompt((prev) => (prev ? { ...prev, reviewOpen: false } : prev))
  }

  const dismissPromptWorkflow = (): void => {
    setWorkflowPrompt(null)
  }

  /**
   * Re-derives the preview workflow from the untouched base: first the AI
   * node-review keep set (dropping whole steps), then the AI-prefill toggles.
   * Layering both from the base keeps every toggle idempotent.
   */
  const derivePreview = (
    base: Workflow,
    keep: Record<string, boolean> | null,
    aiSelections: Record<string, boolean>,
  ): Workflow => applyAiPrefillOptions(applyNodeKeepSelection(base, keep ?? {}), aiSelections)

  /**
   * Toggle one AI-prefill checkbox and rebuild the preview workflow from the
   * untouched base, so toggling is idempotent regardless of prior state.
   */
  const toggleAiPrefill = (nodeId: string, enabled: boolean): void => {
    setWorkflowPrompt((prev) => {
      if (!prev) return prev
      const aiSelections = { ...prev.aiSelections, [nodeId]: enabled }
      return {
        ...prev,
        aiSelections,
        workflow: derivePreview(prev.base, prev.keep, aiSelections),
      }
    })
  }

  /** Keep/drop one reviewed step (primary + its satellites) on the card. */
  const toggleStepKeep = (stepId: string, kept: boolean): void => {
    setWorkflowPrompt((prev) => {
      if (!prev) return prev
      const keep = { ...prev.keep, [stepId]: kept }
      return { ...prev, keep, workflow: derivePreview(prev.base, keep, prev.aiSelections) }
    })
  }

  // --- Slash menu ------------------------------------------------------------

  const activeSkill = skills.find((skill) => skill.id === activeSkillId) ?? null
  // Filename base for answer downloads: prefer the active conversation's title,
  // with a localized fallback for untitled conversations.
  const convTitle =
    conversations.find((entry) => entry.id === conversationId)?.title || t.msgDownloadUntitled
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

  // Only the final assistant reply (the closing "overall analysis" of the
  // turn) carries the download action; earlier replies keep copy alone.
  const lastAssistantId = [...entries].reverse().find((e) => e.role === 'assistant')?.id

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
                  <button className="link-btn" onClick={() => setPreviewConv(null)} type="button">
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
                        <MessageAttachments attachments={message.attachments} />
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
                  {conversations.length === 0 && <div className="empty">{t.convHistoryEmpty}</div>}
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
            <path d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7v3l4-4-4-4v3z" fill="currentColor" />
            <path d="M12 8v5l4 2-.7 1.2L11 13.5V8z" fill="currentColor" />
          </svg>
          <span className="icon-btn-label">{t.convHistory}</span>
        </button>
      </div>

      <div className="pane chat-log" ref={logRef}>
        {entries.length === 0 && confirms.length === 0 && (
          <div className="empty">{t.chatEmpty}</div>
        )}

        {entries.map((entry) => {
          if (entry.role === 'tool') {
            return (
              <div key={entry.id}>
                <span className="tool-chip">{entry.text}</span>
              </div>
            )
          }
          // A keyed fragment keeps `.msg` a direct flex child of `.chat-log`
          // (so its align-self keeps working) while letting the generated-skill
          // cards drop in as their own flex items right below the reply.
          return (
            <Fragment key={entry.id}>
              <div className="msg" data-role={entry.role}>
                {/*
                  Only assistant replies are parsed as Markdown. What the user typed
                  is shown exactly as typed: reformatting their own words would be
                  surprising, and asking about `**` or a code fence must not make
                  the question itself change shape. Status and error lines are
                  plain text generated by this extension.
                */}
                {entry.role === 'assistant' ? <Markdown text={entry.text} /> : entry.text}
                <MessageAttachments attachments={entry.attachments} />
                <MsgActions
                  entry={entry}
                  t={t}
                  title={convTitle}
                  isLastAssistant={entry.id === lastAssistantId}
                  busy={busy}
                />
              </div>
              {entry.role === 'assistant' && (
                <GeneratedSkillCards
                  assistantText={entry.text}
                  onSaved={(text) => append({ role: 'status', text })}
                  t={t}
                />
              )}
            </Fragment>
          )
        })}

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

        {workflowPrompt && (
          <div className="confirm-card" data-kind="workflow">
            <strong>
              {t.chatSaveWorkflowPrompt({
                steps: workflowPrompt.workflow.drawflow.nodes.length,
              })}
            </strong>
            <p className="hint" style={{ margin: '6px 0' }}>
              {workflowPrompt.workflow.name}
            </p>
            {workflowPrompt.saveError && (
              <p className="hint text-err" style={{ margin: '6px 0' }} role="alert">
                {workflowPrompt.saveError}
              </p>
            )}
            {workflowPrompt.aiSteps.filter((step) =>
              workflowPrompt.workflow.drawflow.nodes.some((node) => node.id === step.nodeId),
            ).length > 0 && (
              <div className="ai-prefill-list" role="group" aria-label={t.chatSaveWorkflowAiTitle}>
                <p className="hint">{t.chatSaveWorkflowAiTitle}</p>
                {workflowPrompt.aiSteps
                  .filter((step) =>
                    workflowPrompt.workflow.drawflow.nodes.some((node) => node.id === step.nodeId),
                  )
                  .map((step) => (
                    <label key={step.nodeId} className="ai-prefill-item">
                      <input
                        checked={workflowPrompt.aiSelections[step.nodeId] !== false}
                        onChange={(event) => toggleAiPrefill(step.nodeId, event.target.checked)}
                        type="checkbox"
                      />
                      <span>{step.label}</span>
                    </label>
                  ))}
              </div>
            )}
            <div className="actions">
              <button
                className="primary"
                disabled={workflowPrompt.saving}
                onClick={savePromptWorkflow}
                type="button"
              >
                {t.chatSaveWorkflowSave}
              </button>
              <button disabled={workflowPrompt.saving} onClick={dismissPromptWorkflow} type="button">
                {t.chatSaveWorkflowSkip}
              </button>
            </div>
          </div>
        )}

        {workflowPrompt?.reviewOpen && (
          <WorkflowReviewDialog
            keep={workflowPrompt.keep}
            log={workflowPrompt.reviewLog}
            review={workflowPrompt.review}
            reviewing={workflowPrompt.reviewing}
            saveError={workflowPrompt.saveError ?? undefined}
            steps={workflowPrompt.stepList}
            subtitle={workflowPrompt.workflow.name}
            title={t.workflowReviewDialogTitle}
            unavailableReason={workflowPrompt.reviewError ?? undefined}
            onCancel={cancelSaveReview}
            onConfirm={confirmSaveReview}
            onRetry={retrySaveReview}
            onToggle={toggleStepKeep}
          />
        )}
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

        {pendingAttachments.length > 0 && (
          <div className="composer-attachments">
            {pendingAttachments.map((attachment) => (
              <span className="attach-chip" key={attachment.id} title={attachment.name}>
                {isImageAttachment(attachment) && attachment.dataUrl ? (
                  <img alt={attachment.name} className="attach-thumb" src={attachment.dataUrl} />
                ) : (
                  <span aria-hidden="true">📎</span>
                )}
                <span className="attach-name">{attachment.name}</span>
                <button
                  aria-label={t.chatAttachmentRemove}
                  className="attach-remove"
                  onClick={() => removeAttachment(attachment.id)}
                  title={t.chatAttachmentRemove}
                  type="button"
                >
                  ×
                </button>
              </span>
            ))}
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
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            void addFiles(event.dataTransfer?.files ?? null)
          }}
          onPaste={(event) => {
            const files = event.clipboardData?.files
            if (files && files.length > 0) {
              event.preventDefault()
              void addFiles(files)
            }
          }}
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
            <button
              aria-label={t.saveWorkflowLabel}
              aria-pressed={saveWorkflow}
              className="icon-btn mode-info-btn save-workflow-btn"
              onClick={() => void toggleSaveWorkflow()}
              title={t.saveWorkflowHint}
              type="button"
            >
              <svg height="14" viewBox="0 0 24 24" width="14" aria-hidden="true">
                <path
                  d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"
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
          </div>
          <div className="actions" style={{ margin: 0 }}>
            <button
              aria-label={t.chatAttach}
              className="icon-btn"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              title={t.chatAttach}
              type="button"
            >
              <Paperclip size={16} aria-hidden="true" />
            </button>
            <input
              accept={FILE_INPUT_ACCEPT}
              multiple
              onChange={(event) => {
                void addFiles(event.target.files)
                event.target.value = ''
              }}
              ref={fileInputRef}
              style={{ display: 'none' }}
              type="file"
            />
            {!busy && entries.length > 0 && (
              <button onClick={startNewConversation} title={t.convNew} type="button">
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
              disabled={
                busy || (!draft.trim() && !activeSkillId && pendingAttachments.length === 0)
              }
              onClick={send}
              type="button"
            >
              {busy ? t.loading : t.chatSend}
            </button>
          </div>
        </div>
        <div className="token-bar">
          <TokenBarGroup label={t.tokenBarSession} t={t} usage={sessionUsage} />
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

/**
 * One flat token block on the token bar, summing the current conversation's
 * usage. Numbers use the compact `formatTokens` form so the whole bar stays
 * on one or two short lines. Per-turn breakdowns live in the message-bubble
 * hover tooltip instead (see `.msg-token-tip`).
 */
function TokenBarGroup({
  label,
  usage,
  t,
}: {
  label: string
  usage: TurnTokenUsage | null
  t: ReturnType<typeof useT>
}) {
  const v = (n: number): string => (usage ? formatTokens(n) : t.tokenBarDash)
  return (
    <span className="token-bar-group">
      <span className="token-bar-label">{label}</span>
      <span className="token-bar-kv">
        {t.tokenBarT}:{v(usage?.totalTokens ?? 0)}
      </span>
      <span className="token-bar-kv">
        {t.tokenBarI}:{v(usage?.inputTokens ?? 0)}
      </span>
      <span className="token-bar-kv">
        {t.tokenBarO}:{v(usage?.outputTokens ?? 0)}
      </span>
      <span className="token-bar-kv">
        {t.tokenBarR}:{v(usage?.reasoningTokens ?? 0)}
      </span>
      <span className="token-bar-kv">
        {t.tokenBarC}:{v(usage?.cachedInputTokens ?? 0)}
      </span>
    </span>
  )
}
