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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type AiPrefillStep,
} from '../lib/storage'
import { isTriggerNode } from '../lib/workflow/migrate'
import {
  applyTriggerSelection,
  triggerSelectionOf,
  type TriggerSelection,
} from '../lib/workflow/trigger-patch'
import { OFFERED_TRIGGER_TYPES, type OfferedTriggerType } from '../lib/workflow/trigger-options'
import type { RepeatSuggestion } from '../lib/workflow/loop-collapse'
import { failingProbes, type SelectorProbeResult } from '../lib/workflow/selector-probe'
import { checkWorkflowIntegrity, type WorkflowIntegrity } from '../lib/workflow/integrity'
import { validateWorkflowForRun } from '../lib/workflow/validation'
import {
  applyNodeKeepSelection,
  reviewStepsOf,
  type ReviewStep,
  type WorkflowReview,
} from '../lib/workflow/review-patch'
import { WorkflowReviewDialog } from './WorkflowReviewList'
import SkillEditDialog from './SkillEditDialog'
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
import { isNearBottom } from '../lib/scroll'
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
import { useI18n, useT } from './i18n'
import type { Locale } from '../lib/i18n'
import Markdown from './Markdown'
import { downloadAnswer, hasTables, type AnswerFormat } from '../lib/export-answer'
import {
  ArrowDown,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Download,
  Gauge,
  Highlighter,
  History,
  Info,
  Loader2,
  Paperclip,
  Wrench,
} from 'lucide-react'
import { normalizeSkill, PLAN_SKILL_NAME } from '../lib/skills'
import { detectSkillCandidatesFromMarkdown, type DetectedSkill } from '../lib/skill-detect'
import { splitThinkSegments, stripThinkBlocks } from '../lib/model-output'

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
  /** Tool name for `tool` entries (the chip text stays as a fallback). */
  toolName?: string
  /**
   * Tool result summary for `tool` entries. Absent while the call is still
   * running; restored transcripts always carry it.
   */
  toolSummary?: string
}

/**
 * Render items: consecutive assistant/tool entries belong to ONE agent turn
 * and are painted as a single bubble, even when tool calls split the model's
 * answer into several streamed text segments. Everything else (user, status,
 * error) renders standalone and breaks the group.
 */
type RenderItem = { kind: 'single'; entry: Entry } | { kind: 'turn'; entries: Entry[] }

/**
 * Groups the flat transcript into standalone entries and agent turns
 * (assistant text + the tool calls interleaved between text segments).
 */
export function groupEntries(entries: readonly Entry[]): RenderItem[] {
  const items: RenderItem[] = []
  let run: Entry[] | null = null
  for (const entry of entries) {
    if (entry.role === 'assistant' || entry.role === 'tool') {
      if (!run) {
        run = []
        items.push({ kind: 'turn', entries: run })
      }
      run.push(entry)
    } else {
      run = null
      items.push({ kind: 'single', entry })
    }
  }
  return items
}

/**
 * Recovers the structured tool name/summary from a restored transcript line
 * (`← name: summary`, produced by `background/restore.ts`). Live turns carry
 * the fields directly.
 */
function parseRestoredTool(text: string): { name: string; summary: string } {
  const trimmed = text.trim()
  const match = /^←\s*([^:]+?):\s*([\s\S]*)$/.exec(trimmed)
  // Always report a summary (even if just the raw line): a replayed entry is
  // a completed call and must never render as a still-running spinner.
  if (!match) return { name: 'tool', summary: trimmed.replace(/^←\s*/, '') }
  return { name: match[1]!.trim(), summary: match[2]! }
}

/**
 * The copyable/exportable answer of one agent turn: every assistant segment
 * with reasoning blocks removed, joined across tool rounds.
 */
function turnAnswerText(entries: readonly Entry[]): string {
  return entries
    .filter((entry): entry is Entry & { role: 'assistant' } => entry.role === 'assistant')
    .map((entry) => stripThinkBlocks(entry.text).trim())
    .filter(Boolean)
    .join('\n\n')
}

/** A tool call awaiting the user's decision. */
interface PendingConfirm {
  requestId: string
  name: string
  argsPreview: string
}

/**
 * A clarifying question from the agent's `ask_user` tool. `options` are the
 * candidate approaches with pros/cons — index 0 is the agent's recommendation
 * and is pre-selected; the free-text input lets the user answer with something
 * else entirely.
 */
interface PendingAskUser {
  requestId: string
  question: string
  options: Array<{ label: string; pros: string; cons: string }>
}

/**
 * An execution plan submitted by the agent's `present_plan` tool (the plan
 * skill's hand-off). Rendered as an approval card: approve to unlock
 * execution, or reject with feedback so the agent revises the plan.
 */
interface PendingPlan {
  requestId: string
  goal: string
  steps: { title: string; detail?: string }[]
  risks?: string
  split?: string
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
  /**
   * Trigger the saved workflow will launch from. A generated workflow is
   * useless without one, so the card always carries a selection (defaulting to
   * the draft's trigger, i.e. `manual`) and {@link applyTriggerSelection} folds
   * it into the preview — see `lib/workflow/trigger-patch` for why the graph
   * node and the top-level mirror must both be patched.
   */
  trigger: TriggerSelection
  workflow: Workflow
  steps: number
  /**
   * Which mode produced this card. The history-derive path uses
   * `chatSaveWorkflowPrompt` ("This session performed N steps…"); the
   * workflow-draft path uses `chatSaveWorkflowDraftPrompt` ("Generated a
   * workflow draft with N steps…"). Tracked separately because both reuse
   * the same review/save machinery.
   */
  source: 'history' | 'draft'
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
  /**
   * Repeat runs the draft contains, offered as folds. A generated workflow
   * records one node per real interaction, so five identical clicks become five
   * nodes; folding them into a loop is what makes the replay maintainable.
   */
  suggestions: RepeatSuggestion[]
  /**
   * Every selector in the graph checked against the live page. `null` means the
   * page could not be probed at all — shown as "unverified" rather than as a
   * pass, because a graph whose selectors were never checked is exactly the
   * case that used to fail on first run.
   */
  probes: SelectorProbeResult[] | null
  /**
   * True while the probe request is in flight.
   *
   * The probe runs as its own command AFTER the card is on screen, so a page
   * that is slow to answer — or refuses injection outright — cannot delay or
   * swallow the card. Without this flag the panel would show "unverified"
   * during the wait, which reads as a failure.
   */
  probesChecking: boolean
  /**
   * Internal consistency of the graph: references nothing can resolve, and
   * nodes the trigger head cannot reach.
   *
   * The complement of {@link probes}: probing asks the page whether the steps
   * still find their elements, this asks the graph whether the steps still hang
   * together. A step that lost its edge, or a `{{variable}}` no block produces,
   * replays as a silent no-op and looks like a page problem.
   */
  integrity: WorkflowIntegrity
  /** Index of the suggestion currently being folded, for the busy state. */
  folding: number | null
  /**
   * Outcome of the last fold. A refused fold (no page-verified selector) is a
   * normal result, so it is reported here rather than thrown.
   */
  foldNote: string | null
  /**
   * Whether saving should be followed by a verify run (the AI-debug loop).
   * Opt-in (default false, per the 2026-09-19 first-run plan): the verify run
   * executes the workflow for real — real side effects and one model call —
   * so it must be the user's explicit choice, not the default.
   */
  verifyRun: boolean
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

/** Localized-text bundle type, reused by the small render components below. */
type ChatT = ReturnType<typeof useT>

/**
 * One agent `ask_user` question card: the question, the candidate approaches
 * as a radio-style list (index 0 = the recommendation, pre-selected, each with
 * its pros/cons), a free-text answer that overrides the selection, and a
 * dismiss action. Lives above the composer in the chat log, in the same slot
 * as the confirmation cards.
 */
function AskUserCard({
  request,
  onAnswer,
  t,
}: {
  request: PendingAskUser
  onAnswer: (requestId: string, answer: string, cancelled: boolean) => void
  t: ChatT
}) {
  /** Index 0 is the agent's recommendation — pre-selected by default. */
  const [selected, setSelected] = useState(0)
  const [draft, setDraft] = useState('')
  /** True during an IME composition, so Enter confirms the candidate, not the card. */
  const composingRef = useRef(false)
  const submit = (): void => {
    // A typed answer always wins over the pre-selected suggestion.
    const custom = draft.trim()
    if (custom) {
      onAnswer(request.requestId, custom, false)
      return
    }
    const option = request.options[selected]
    if (option) onAnswer(request.requestId, option.label, false)
  }
  return (
    <div className="confirm-card" data-kind="ask">
      <strong>{t.chatAskTitle}</strong>
      <div className="confirm-action">{request.question}</div>
      <div className="mt-2 flex flex-col gap-1.5">
        {request.options.map((option, index) => {
          const active = index === selected
          return (
            <button
              className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                active ? 'border-accent bg-accent-soft' : 'border-border bg-panel hover:bg-hover'
              }`}
              key={`${option.label}-${index}`}
              onClick={() => setSelected(index)}
              type="button"
            >
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <span aria-hidden="true">{active ? '◉' : '○'}</span>
                <span>{option.label}</span>
                {index === 0 && (
                  <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-on-accent">
                    {t.chatAskRecommended}
                  </span>
                )}
              </span>
              <span className="mt-1 block pl-5 text-[11.5px] leading-snug text-ok">
                ✓ {option.pros}
              </span>
              <span className="block pl-5 text-[11.5px] leading-snug text-warn">
                ✗ {option.cons}
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          className="w-full rounded border border-border bg-sunken px-2 py-1.5 text-[13px] text-ink placeholder:text-faint"
          onChange={(event) => setDraft(event.target.value)}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !composingRef.current && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={t.chatAskPlaceholder}
          value={draft}
        />
        <button
          className="primary shrink-0"
          disabled={request.options.length === 0 && !draft.trim()}
          onClick={submit}
          type="button"
        >
          {t.dialogConfirm}
        </button>
      </div>
      <div className="actions mt-2">
        <button onClick={() => onAnswer(request.requestId, '', true)} type="button">
          {t.cancel}
        </button>
      </div>
    </div>
  )
}

/**
 * One agent `present_plan` approval card: the goal, the numbered steps and the
 * optional risk/split notes. Approve lets the agent execute the plan; "revise"
 * opens a feedback input so the agent re-plans. While the plan is pending the
 * plan gate refuses every page action, so the decision is the only way
 * forward — deliberately the same slot as the confirmation cards.
 */
function PlanCard({
  request,
  onDecide,
  t,
}: {
  request: PendingPlan
  onDecide: (requestId: string, approved: boolean, feedback?: string) => void
  t: ChatT
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /** True during an IME composition, so Enter confirms the candidate, not the card. */
  const composingRef = useRef(false)
  const reject = (): void => {
    const feedback = draft.trim()
    if (!feedback) return
    onDecide(request.requestId, false, feedback)
  }
  return (
    <div className="confirm-card" data-kind="plan" role="region" aria-label={t.planCardAria}>
      <strong>{t.planCardTitle}</strong>
      <div className="mt-2">
        <span className="text-xs font-medium text-muted">{t.planCardGoal}</span>
        <div className="confirm-action">{request.goal}</div>
      </div>
      <div className="mt-2">
        <span className="text-xs font-medium text-muted">{t.planCardSteps}</span>
        <ol className="ml-4 list-decimal space-y-1 text-[13px] text-ink">
          {request.steps.map((step, index) => (
            <li key={index}>
              <span>{step.title}</span>
              {step.detail && <span className="text-xs text-muted"> — {step.detail}</span>}
            </li>
          ))}
        </ol>
      </div>
      {request.risks && (
        <div className="mt-2">
          <span className="text-xs font-medium text-muted">{t.planCardRisks}</span>
          <div className="text-[13px] text-err">{request.risks}</div>
        </div>
      )}
      {request.split && (
        <div className="mt-2">
          <span className="text-xs font-medium text-muted">{t.planCardSplit}</span>
          <div className="text-[13px] text-ink">{request.split}</div>
        </div>
      )}
      <div className="actions mt-2">
        <button className="primary" onClick={() => onDecide(request.requestId, true)} type="button">
          {t.planApprove}
        </button>
        <button
          onClick={() => {
            setDraft('')
            setEditing(true)
          }}
          type="button"
        >
          {t.planRevise}
        </button>
      </div>
      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <textarea
            className="w-full rounded border border-border bg-sunken px-2 py-1.5 text-[13px] text-ink placeholder:text-faint"
            onChange={(event) => setDraft(event.target.value)}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !composingRef.current &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                reject()
              }
            }}
            placeholder={t.planFeedbackPlaceholder}
            rows={2}
            value={draft}
          />
          <button
            className="primary shrink-0"
            disabled={!draft.trim()}
            onClick={reject}
            type="button"
          >
            {t.planFeedbackSend}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * One reasoning block (`<think>…</think>`) rendered apart from the answer:
 * a collapsible, muted panel instead of literal tags mixed into the reply.
 *
 * Pinned open while the turn is streaming so the model's progress stays
 * visible; auto-collapses when the turn completes, after which the user can
 * freely toggle it.
 */
function ThinkBlock({
  text,
  closed,
  live,
}: {
  text: string
  /** False while the closing tag (and the rest of the thought) is pending. */
  closed: boolean
  /** True for the turn currently streaming. */
  live: boolean
}) {
  const t = useT()
  // A thought whose closing tag has not arrived is still streaming: default
  // open even when the panel did not track the turn as busy (e.g. a run it
  // reattached to mid-flight).
  const [open, setOpen] = useState(live || !closed)
  useEffect(() => {
    // A completed turn collapses its finished reasoning blocks.
    if (!live && closed) setOpen(false)
  }, [live, closed])
  const expanded = live || open || !closed

  return (
    <details
      className="rounded-lg border border-border bg-sunken px-2.5 py-1.5"
      data-kind="think"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={expanded}
    >
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 text-muted [&::-webkit-details-marker]:hidden">
        <Brain aria-hidden="true" className="h-3.5 w-3.5 shrink-0" size={14} />
        <span className="text-xs font-medium">{t.chatThinking}</span>
        {!closed && <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin" />}
        <ChevronRight
          aria-hidden="true"
          className={`ml-auto h-3 w-3 shrink-0 transition-transform duration-150 ${
            expanded ? 'rotate-90' : ''
          }`}
          size={12}
        />
      </summary>
      <div className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere] text-xs leading-relaxed text-muted">
        {text}
      </div>
    </details>
  )
}

/**
 * One assistant text segment. Splits reasoning blocks out of the raw model
 * text and renders them in stream order, each as its own {@link ThinkBlock},
 * with only the actual answer going through Markdown.
 */
function AssistantContent({ text, live }: { text: string; live: boolean }) {
  const segments = splitThinkSegments(text)
  if (segments.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {segments.map((segment, index) => {
        if (segment.kind === 'think') {
          return (
            <ThinkBlock
              closed={segment.closed}
              key={`think-${index}`}
              live={live}
              text={segment.text}
            />
          )
        }
        // Whitespace-only answer runs (e.g. the newline after a think tag)
        // would render as an empty paragraph with extra margins.
        if (!segment.text.trim()) return null
        return <Markdown key={`answer-${index}`} text={segment.text} />
      })}
    </div>
  )
}

/**
 * One tool call embedded inside an agent turn: a compact card instead of a
 * loose chip floating between reply bubbles. Shows a spinner until the result
 * summary arrives; the completed card expands to reveal the full summary.
 */
function ToolCallCard({ entry, t }: { entry: Entry; t: ChatT }) {
  const name = entry.toolName ?? 'tool'
  const summary = entry.toolSummary
  const running = summary === undefined
  const baseClass = 'rounded-lg border border-border bg-sunken px-2.5 py-1.5'

  const icon = running ? (
    <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin text-accent" />
  ) : (
    <Wrench aria-hidden="true" className="h-3 w-3 shrink-0 text-muted" />
  )

  const inner = (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {icon}
      <span className="shrink-0 font-mono text-xs text-ink">{name}</span>
      {running ? (
        <span className="text-xs text-muted">{t.chatToolRunning}</span>
      ) : (
        summary && <span className="min-w-0 truncate text-xs text-muted">· {summary}</span>
      )}
    </div>
  )

  if (running || !summary?.trim()) {
    return (
      <div className={`${baseClass} flex items-center`} data-kind="tool" data-state="running">
        {inner}
      </div>
    )
  }

  return (
    <details className={`${baseClass} group/tool`} data-kind="tool" data-state="done">
      <summary
        className="flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden"
        title={summary}
      >
        {inner}
        <ChevronRight
          aria-hidden="true"
          className="ml-1 h-3 w-3 shrink-0 text-muted transition-transform duration-150 group-open/tool:rotate-90"
          size={12}
        />
      </summary>
      <div className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-muted">
        {summary}
      </div>
    </details>
  )
}

/**
 * One complete agent turn painted as a SINGLE bubble: all assistant text
 * segments and the tool calls interleaved between them share one container,
 * so a turn whose answer brackets tool calls no longer splits into several
 * disconnected bubbles.
 */
function AssistantTurn({
  entries,
  live,
  isLast,
  busy,
  t,
  title,
  onSkillSaved,
}: {
  entries: Entry[]
  live: boolean
  isLast: boolean
  busy: boolean
  t: ChatT
  title: string
  onSkillSaved: (statusText: string) => void
}) {
  const answer = turnAnswerText(entries)
  const usage = [...entries]
    .reverse()
    .find((entry) => entry.role === 'assistant' && entry.usage)?.usage
  const actionsEntry: Entry = {
    id: `turn-actions-${entries[0]!.id}`,
    role: 'assistant',
    text: answer,
    ...(usage ? { usage } : {}),
  }

  return (
    <div
      className="flex flex-col gap-2.5 rounded-xl border border-border bg-panel-2 px-3 py-2.5"
      data-role="assistant-turn"
    >
      {entries.map((entry) =>
        entry.role === 'tool' ? (
          <ToolCallCard entry={entry} key={entry.id} t={t} />
        ) : (
          <AssistantContent key={entry.id} live={live} text={entry.text} />
        ),
      )}
      <GeneratedSkillCards assistantText={answer} onSaved={onSkillSaved} t={t} />
      <MsgActions busy={busy} entry={actionsEntry} isLastAssistant={isLast} t={t} title={title} />
    </div>
  )
}

/**
 * Icon-only toolbar button used by the chat toolbar, where three text labels
 * would not fit. The explanation lives in the hover tooltip (`title`) instead
 * of a visible label; toggles additionally show their ON state as an accent
 * tint (`aria-pressed`) so the icon alone still reads unambiguously.
 *
 * `!` modifiers are REQUIRED on the colour/border/padding utilities here:
 * sidepanel/styles.css styles bare `button` elements with UNLAYERED rules
 * (`button { … }`, `button:hover:not(:disabled) { … }`), and unlayered CSS
 * always beats Tailwind's `@layer utilities` declarations in the cascade —
 * without `!` the active/inactive tints are silently overridden and the
 * toggles never show their selected state.
 *
 * `inline-flex`, NOT `flex`: Chrome shrinks the inline <svg> child of a
 * flex-display <button> to zero width (the icon then paints nothing — see the
 * `.msg-action svg` note in styles.css). Every icon button in this panel uses
 * inline-flex for exactly that reason.
 *
 * For plain actions (no `active`) the attribute is omitted, keeping the
 * semantics of a normal button.
 */
function ToolbarIconButton({
  icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  /** Hover explanation; defaults to the label. */
  hint?: string
  /** Toggle state; omit for plain (non-toggle) action buttons. */
  active?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={[
        'inline-flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-lg border p-0! transition-colors duration-150',
        active
          ? 'border-accent! bg-accent-soft! text-accent!'
          : 'border-transparent! bg-transparent! text-muted! hover:border-border! hover:bg-hover! hover:text-ink!',
      ].join(' ')}
      onClick={onClick}
      title={hint ?? label}
      type="button"
    >
      {icon}
    </button>
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
 */ function MsgActions({
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
  // While a turn is still streaming, NO assistant bubble (the live one
  // included) shows actions — the answer is still evolving, not a finished
  // text worth copying or exporting. Buttons appear once the chat completes.
  if (busy && isAssistant) return null
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

  const download = async (format: AnswerFormat): Promise<void> => {
    setMenuOpen(false)
    await downloadAnswer({ text: entry.text, format, title })
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

/**
 * Renders the generated-skill cards found in an assistant reply (see
 * `msg-actions` UI, below). Each assistant message is scanned once and every
 * recognised skill block becomes a card where the user can save it straight
 * into the project's skill store, open the edit dialog to tweak it first, or
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
  // True while the edit DIALOG is open; the dialog owns the field state, so
  // this component only tracks the saving/error outcome of the last save.
  const [editing, setEditing] = useState(false)
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

  return (
    <div className="card generated-skill-card">
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
        <button
          disabled={saving}
          onClick={() => {
            setErrorText(null)
            setEditing(true)
          }}
          type="button"
        >
          {t.skillSaveEdit}
        </button>
        <button disabled={saving} onClick={() => setDismissed(true)} type="button">
          {t.skillDiscard}
        </button>
      </div>

      {editing && (
        <SkillEditDialog
          error={errorText}
          initial={{
            name: detected.draft.name,
            description: detected.draft.description,
            instructions: detected.draft.instructions,
            autoMatch: detected.draft.autoMatch,
          }}
          saving={saving}
          title={t.skillSaveEdit}
          onCancel={() => {
            setEditing(false)
            setErrorText(null)
          }}
          onSave={(values) => {
            void persist(values.name, values.description, values.instructions, values.autoMatch)
          }}
        />
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

/**
 * Sensible starting parameters per trigger kind, applied when the user picks a
 * kind. Without them, choosing `interval` would leave the required field blank
 * and the card could save a workflow that never fires — or that the run gate
 * rejects.
 */
const TRIGGER_KIND_DEFAULTS: Readonly<
  Partial<Record<OfferedTriggerType, Record<string, unknown>>>
> = {
  'keyboard-shortcut': { shortcut: '' },
  'context-menu': { contextMenuName: '' },
  'visit-web': { url: '' },
  interval: { interval: 30 },
  'specific-day': { days: [1, 2, 3, 4, 5], time: '09:00' },
  date: { date: '', time: '09:00' },
  'element-change': {
    observeElement: {
      selector: '',
      matchPattern: '',
      // `childList` on by default, matching the observer's own default: a
      // watched element whose children change is the common case, and a
      // picker that watched nothing at all would look broken.
      targetOptions: { subtree: false, childList: true, attributes: false, characterData: false },
    },
  },
}

/**
 * Trigger picker for the save-as-workflow card.
 *
 * A generated workflow is useless without a trigger, and a trigger this build
 * does not arm is worse than none — it looks configured but never fires. So the
 * picker offers only {@link OFFERED_TRIGGER_TYPES} and collects the fields each
 * kind's scheduler actually reads (see `workflowAutoTrigger`).
 */
/**
 * The inputs a generated workflow needs, read from the denormalized trigger
 * mirror and falling back to the trigger node's `data.parameters`.
 *
 * Generation declares these (see `lib/workflow/dynamic-data`) whenever a
 * business value has no upstream producer; the save card lists them so the
 * user can see what will be re-prompted / overridable on each run.
 *
 * @returns `name`/`defaultValue` pairs with no empty names.
 */
function declaredInputsOf(workflow: Workflow): { name: string; defaultValue: string }[] {
  const fromMirror = workflow.trigger?.parameters
  const triggerNode = workflow.drawflow.nodes.find(
    (n) => (n.data?.['blockId'] as string) === 'trigger' || n.label === 'trigger',
  )
  const fromNode = triggerNode?.data?.['parameters']
  const raw: unknown = Array.isArray(fromMirror) ? fromMirror : fromNode
  if (!Array.isArray(raw)) return []
  const out: { name: string; defaultValue: string }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = record['name']
    if (typeof name !== 'string' || name.trim() === '') continue
    out.push({
      name,
      defaultValue:
        typeof record['defaultValue'] === 'string' ? (record['defaultValue'] as string) : '',
    })
  }
  return out
}

/**
 * The steps of a generated workflow that run raw JavaScript.
 *
 * A script step is only allowed when no declarative operator could do the job
 * (see `lib/workflow/operator-tools`), and the reason travels on the node's
 * `description`. Surfacing both here — before the user saves — is the point:
 * the person who maintains this workflow later is the one who has to know
 * which steps need code, and they can still ask for a rewrite now.
 *
 * @returns `label`/`reason` pairs, one per script node, in graph order.
 */
function codeNodesOf(workflow: Workflow): { id: string; reason: string }[] {
  return workflow.drawflow.nodes
    .filter((node) => {
      const raw = node.data?.['blockId']
      const blockId = typeof raw === 'string' && raw ? raw : node.label
      return blockId === 'javascript-code'
    })
    .map((node) => {
      const description = node.data?.['description']
      return {
        id: node.id,
        reason: typeof description === 'string' ? description.trim() : '',
      }
    })
}

function WorkflowTriggerPicker({
  locale,
  selection,
  onChange,
}: {
  locale: Locale
  selection: TriggerSelection
  onChange: (next: TriggerSelection) => void
}) {
  const t = useT()

  const kindLabel: Record<OfferedTriggerType, string> = {
    manual: t.triggerKindManual,
    'on-startup': t.triggerKindOnStartup,
    'keyboard-shortcut': t.triggerKindKeyboardShortcut,
    'context-menu': t.triggerKindContextMenu,
    'visit-web': t.triggerKindVisitWeb,
    interval: t.triggerKindInterval,
    'specific-day': t.triggerKindSpecificDay,
    date: t.triggerKindDate,
    'element-change': t.triggerKindElementChange,
  }

  const text = (field: string): string => {
    const value = selection.params[field]
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    return ''
  }

  const setParam = (field: string, value: unknown): void => {
    onChange({ ...selection, params: { ...selection.params, [field]: value } })
  }

  // `element-change` is the one kind whose parameters are nested rather than
  // flat: the observer reads `data.observeElement.{selector,matchPattern,
  // targetOptions}`. These three helpers keep the nested writes readable.
  const observe = (): Record<string, unknown> => {
    const value = selection.params['observeElement']
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  }
  const setObserve = (patch: Record<string, unknown>): void => {
    setParam('observeElement', { ...observe(), ...patch })
  }
  const targetOptions = (): Record<string, unknown> => {
    const value = observe()['targetOptions']
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  }
  const setTargetOption = (field: string, value: boolean): void => {
    setObserve({ targetOptions: { ...targetOptions(), [field]: value } })
  }
  const observeText = (field: string): string => {
    const value = observe()[field]
    return typeof value === 'string' ? value : ''
  }

  const changeKind = (type: OfferedTriggerType): void => {
    // Keep whatever the user already entered for this kind, seed the rest.
    // `applyTriggerSelection` clears the OTHER kinds' fields, so switching
    // away and back is safe.
    onChange({
      type,
      params: { ...(TRIGGER_KIND_DEFAULTS[type] ?? {}), ...selection.params },
    })
  }

  const days: number[] = Array.isArray(selection.params['days'])
    ? (selection.params['days'] as unknown[]).map(Number).filter((d) => Number.isInteger(d))
    : []
  const toggleDay = (day: number): void => {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort()
    setParam('days', next)
  }
  // Weekday names via Intl, so they follow the panel's locale for free.
  const weekdayName = (day: number): string =>
    new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(2024, 0, 7 + day))

  const autoFires = selection.type !== 'manual'

  return (
    <div className="trigger-picker" role="group" aria-label={t.chatSaveWorkflowTriggerTitle}>
      <p className="hint" style={{ margin: '6px 0 4px' }}>
        {t.chatSaveWorkflowTriggerTitle}
      </p>
      <select
        aria-label={t.chatSaveWorkflowTriggerTitle}
        className="w-full"
        disabled={false}
        onChange={(event) => changeKind(event.target.value as OfferedTriggerType)}
        value={selection.type}
      >
        {OFFERED_TRIGGER_TYPES.map((type) => (
          <option key={type} value={type}>
            {kindLabel[type]}
          </option>
        ))}
      </select>

      {selection.type === 'keyboard-shortcut' && (
        <input
          className="w-full"
          onChange={(event) => setParam('shortcut', event.target.value)}
          placeholder={t.chatSaveWorkflowTriggerShortcut}
          value={text('shortcut')}
        />
      )}

      {selection.type === 'context-menu' && (
        <input
          className="w-full"
          onChange={(event) => setParam('contextMenuName', event.target.value)}
          placeholder={t.chatSaveWorkflowTriggerMenuName}
          value={text('contextMenuName')}
        />
      )}

      {selection.type === 'visit-web' && (
        <input
          className="w-full"
          onChange={(event) => setParam('url', event.target.value)}
          placeholder={t.chatSaveWorkflowTriggerUrl}
          value={text('url')}
        />
      )}

      {selection.type === 'interval' && (
        <input
          className="w-full"
          min={1}
          onChange={(event) => setParam('interval', Number(event.target.value))}
          placeholder={t.chatSaveWorkflowTriggerInterval}
          type="number"
          value={text('interval')}
        />
      )}

      {selection.type === 'specific-day' && (
        <div className="flex flex-wrap items-center gap-1">
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <label className="ai-prefill-item" key={day}>
              <input checked={days.includes(day)} onChange={() => toggleDay(day)} type="checkbox" />
              <span>{weekdayName(day)}</span>
            </label>
          ))}
          <input
            onChange={(event) => setParam('time', event.target.value)}
            placeholder={t.chatSaveWorkflowTriggerTime}
            value={text('time')}
          />
        </div>
      )}

      {selection.type === 'date' && (
        <div className="flex flex-wrap items-center gap-1">
          <input
            onChange={(event) => setParam('date', event.target.value)}
            placeholder={t.chatSaveWorkflowTriggerDate}
            value={text('date')}
          />
          <input
            onChange={(event) => setParam('time', event.target.value)}
            placeholder={t.chatSaveWorkflowTriggerTime}
            value={text('time')}
          />
        </div>
      )}

      {selection.type === 'element-change' && (
        <div className="flex flex-col gap-1">
          <input
            className="w-full"
            onChange={(event) => setObserve({ selector: event.target.value })}
            placeholder={t.chatSaveWorkflowTriggerElementSelector}
            value={observeText('selector')}
          />
          <input
            className="w-full"
            onChange={(event) => setObserve({ matchPattern: event.target.value })}
            placeholder={t.chatSaveWorkflowTriggerElementPattern}
            value={observeText('matchPattern')}
          />
          {(
            [
              ['subtree', t.chatSaveWorkflowTriggerElementSubtree],
              ['childList', t.chatSaveWorkflowTriggerElementChildList],
              ['attributes', t.chatSaveWorkflowTriggerElementAttributes],
              ['characterData', t.chatSaveWorkflowTriggerElementCharacterData],
            ] as const
          ).map(([field, label]) => (
            <label className="ai-prefill-item" key={field}>
              <input
                checked={targetOptions()[field] === true}
                onChange={(event) => setTargetOption(field, event.target.checked)}
                type="checkbox"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )}

      <p className="hint" style={{ margin: '4px 0 0' }}>
        {autoFires ? t.chatSaveWorkflowTriggerHintAuto : t.chatSaveWorkflowTriggerHintManual}
      </p>
    </div>
  )
}

export default function ChatTab({ skills, activeSkillId, onSelectSkill }: Props) {
  const t = useT()
  // Only the trigger picker needs the locale itself: weekday names come from
  // `Intl.DateTimeFormat`, which localizes them correctly for free.
  const { locale } = useI18n()
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
  /** Clarifying questions from the agent's `ask_user` tool, awaiting an answer. */
  const [askUsers, setAskUsers] = useState<PendingAskUser[]>([])
  /** Execution plans from the agent's `present_plan` tool, awaiting a decision. */
  const [plans, setPlans] = useState<PendingPlan[]>([])
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
   * Mirrors `mode` for the `done` handler — same trick as `tRef`. Without it the
   * port's closure would capture the initial mode and a mode change would not
   * gate the workflow-generation prompt until the panel reconnected.
   */
  const modeRef = useRef<AgentMode>(mode)
  modeRef.current = mode
  /**
   * "Save this session as a workflow?" call-to-action, shown right after a turn
   * that actually performed page operations in workflow mode. `conversationId`
   * guards against saving another conversation's flow by mistake.
   *
   * The AI node review does NOT run while the card is open — it starts only
   * when the user clicks "Save as workflow", which opens the review dialog
   * (`reviewOpen`). A failed attempt (`reviewError`) can be retried by
   * clicking save again; a landed verdict is reused.
   */
  const [workflowPrompt, setWorkflowPrompt] = useState<WorkflowPromptState | null>(null)
  /**
   * Runnability of the graph on the open save card, recomputed whenever the
   * card's workflow changes (trigger selection, review edits, folding). The
   * same checks the run gate applies (`validateWorkflowForRun`) — shown BEFORE
   * saving so "must fix" problems block the save button instead of the run.
   */
  const runIssues = useMemo(
    () => (workflowPrompt ? validateWorkflowForRun(workflowPrompt.workflow) : null),
    [workflowPrompt],
  )
  /** Last reuseable-step count we already asked about per conversation. */
  const promptedRef = useRef<Record<string, number>>({})
  /**
   * One-line explanation shown when a workflow-generation turn produced nothing
   * worth saving.
   *
   * Silence used to be the behaviour here, and silence is indistinguishable
   * from a broken feature — which is exactly how the missing save card went
   * unnoticed. `null` means "no notice to show".
   */
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

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
   * After a turn, offer to persist the result as a reusable workflow.
   *
   * The end-of-turn card is GATED to workflow-generation mode — the user
   * explicitly opted into a drafting session and the draft
   * (`workflows.draft.get`) is the only artifact worth saving. In other modes
   * (semi / full / read-only / chat) the model just answered a question, so
   * we skip the card and the history query entirely.
   *
   * Three outcomes, and all three are VISIBLE: a card to review, or a one-line
   * explanation of why there is nothing to save. Never silence — a silent turn
   * cannot be told apart from a broken feature.
   */
  const maybePromptSaveWorkflow = useCallback(async (convId: string) => {
    if (modeRef.current !== 'workflow') return
    let workflow: Workflow | null = null
    let source: 'history' | 'draft' = 'draft'
    let result: Awaited<ReturnType<typeof sendCommand>>
    try {
      result = await sendCommand({ type: 'workflows.draft.get', conversationId: convId })
    } catch {
      return
    }
    if (result.type !== 'workflows.draft') return
    if (!result.workflow) {
      // The background says WHY: it never touched the page, or it tried and
      // everything failed. Only the second is worth retrying.
      setSaveNotice(
        result.empty === 'all-failed'
          ? tRef.current.chatWorkflowNothingSavedFailed
          : tRef.current.chatWorkflowNothingSaved,
      )
      return
    }
    setSaveNotice(null)
    workflow = result.workflow
    // `history` means the panel compiled the actions the model actually
    // performed; `draft` means the model placed operator blocks itself.
    source = result.source ?? 'draft'
    const aiSteps = aiPrefillSteps(workflow)
    const aiSelections = Object.fromEntries(aiSteps.map((s) => [s.nodeId, true]))
    // Count only real action nodes: every draft carries a trigger head, so the
    // raw node count is never 0 and would defeat the "nothing to save" guard.
    const steps = workflow.drawflow.nodes.filter((n) => !isTriggerNode(n)).length
    if (steps === 0) {
      setSaveNotice(tRef.current.chatWorkflowNothingSaved)
      return
    }
    if ((promptedRef.current[convId] ?? 0) >= steps) return
    promptedRef.current[convId] = steps
    const trigger = triggerSelectionOf(workflow)
    setWorkflowPrompt({
      conversationId: convId,
      base: workflow,
      // Seed the preview with the trigger folded in, so what the card shows and
      // what gets saved are the same object from the first render on.
      workflow: applyTriggerSelection(workflow, trigger),
      aiSteps,
      aiSelections,
      trigger,
      steps,
      source,
      reviewing: false,
      review: null,
      reviewError: null,
      reviewOpen: false,
      reviewLog: [],
      saving: false,
      saveError: null,
      keep: null,
      stepList: reviewStepsOf(workflow),
      suggestions: result.suggestions ?? [],
      probes: null,
      probesChecking: true,
      integrity: checkWorkflowIntegrity(workflow),
      folding: null,
      foldNote: null,
      verifyRun: false,
    })
    // Probe AFTER the card is up, on its own command: injecting into the page
    // can be slow or refused outright, and neither may keep the card away.
    void sendCommand({ type: 'workflows.probe', conversationId: convId })
      .then((probed) => {
        if (probed.type !== 'workflows.probe') return
        setWorkflowPrompt((prev) =>
          // Guard against a card that was saved, discarded or replaced while
          // the probe was in flight.
          prev && prev.conversationId === convId && prev.base === workflow
            ? { ...prev, probes: probed.probes, probesChecking: false }
            : prev,
        )
      })
      .catch(() => {
        setWorkflowPrompt((prev) =>
          prev && prev.conversationId === convId && prev.base === workflow
            ? { ...prev, probes: null, probesChecking: false }
            : prev,
        )
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
                // Replay lines are preformatted `← name: summary`; recover the
                // structured fields so historical turns render the same card
                // UI as live tool calls.
                const { name, summary } = parseRestoredTool(entry.text)
                return {
                  id: nextId(),
                  role: 'tool' as const,
                  text: entry.text,
                  toolName: name,
                  toolSummary: summary,
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
            // A fresh conversation view always opens pinned to the bottom.
            setAtBottom(true)
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
            append({ role: 'tool', text: '', toolName: message.name })
            break
          case 'tool.result':
            setEntries((prev) => {
              // Attach to the first still-running call of this tool: the
              // calls of one round execute and report in order (FIFO). A
              // result without a live start (reconnected mid-turn) appends
              // its own completed card instead.
              const pending = prev.findIndex(
                (entry) =>
                  entry.role === 'tool' &&
                  entry.toolName === message.name &&
                  entry.toolSummary === undefined,
              )
              if (pending === -1) {
                return [
                  ...prev,
                  {
                    id: nextId(),
                    role: 'tool' as const,
                    text: '',
                    toolName: message.name,
                    toolSummary: message.summary,
                  },
                ]
              }
              return prev.map((entry, index) =>
                index === pending ? { ...entry, toolSummary: message.summary } : entry,
              )
            })
            break
          case 'confirm.request':
            setConfirms((prev) => [...prev, message])
            break
          case 'ask_user.request':
            setAskUsers((prev) => [...prev, message])
            break
          case 'plan.request':
            setPlans((prev) => [...prev, message])
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

  // Load local settings once on mount: the autonomy mode rides along with each
  // chat message (the worker reads settings itself).
  useEffect(() => {
    void (async () => {
      try {
        const result = await sendCommand({ type: 'settings.get' })
        if (result.type === 'settings') {
          setMode(result.settings.mode)
        }
      } catch {
        /* keep defaults */
      }
    })()
  }, [])

  const changeMode = async (next: AgentMode): Promise<void> => {
    // Both "no per-step approval" modes get an explicit warning. Workflow
    // generate is NOT a dry run: every operator really clicks, types and
    // navigates, and `javascript-code` runs arbitrary JS in the page's MAIN
    // world — so switching into it deserves the same gate as full auto.
    const warning =
      next === 'full' ? t.modeFullWarning : next === 'workflow' ? t.modeWorkflowWarning : ''
    if (
      warning &&
      !(await confirmDialog({
        title: t.dialogWarningTitle,
        message: warning,
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
  }, [panelWindowId])

  const openConversation = (id: string): void => {
    if (busy) return
    setShowHistory(false)
    setPreviewConv(null)
    if (id === conversationId) return
    setConversationId(id)
    setEntries([])
    setConfirms([])
    setAskUsers([])
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
  })

  const startNewConversation = (): void => {
    if (busy) return
    setShowHistory(false)
    const id = newId()
    setConversationId(id)
    setEntries([])
    setConfirms([])
    setAskUsers([])
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
      setAskUsers([])
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

  // Stick-to-bottom: follow the newest output ONLY while the user is already
  // at the bottom. Streaming deltas append constantly, and an unconditional
  // scroll-to-bottom on every render yanked the view back down the moment the
  // user tried to scroll up to reread something. When they scroll away, a
  // "jump to latest" pill lets them return (and re-enable following).
  const [atBottom, setAtBottom] = useState(true)
  useEffect(() => {
    if (atBottom) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [entries, confirms, askUsers, plans, atBottom])

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

  /** Replies to the agent's `ask_user` question: an answer, or a dismissal. */
  const answerAskUser = (requestId: string, answer: string, cancelled: boolean): void => {
    post({ type: 'ask_user.answer', requestId, answer, cancelled })
    setAskUsers((prev) => prev.filter((item) => item.requestId !== requestId))
  }

  /**
   * Decides the agent's submitted plan: approve, or reject with feedback.
   *
   * Approval ENDS plan mode: the plan skill was a manual selection, so once
   * its plan is approved the pin is cleared — the composer's plan chip
   * disappears, the next message goes out unpinned, and the agent keeps
   * executing the approved plan (other skills load normally mid-execution).
   */
  const answerPlan = (requestId: string, approved: boolean, feedback?: string): void => {
    post({ type: 'plan.decision', requestId, approved, ...(feedback ? { feedback } : {}) })
    setPlans((prev) => prev.filter((item) => item.requestId !== requestId))
    if (approved && activeSkillId !== null) {
      const active = skills.find((entry) => entry.id === activeSkillId)
      if (active?.name === PLAN_SKILL_NAME) onSelectSkill(null)
    }
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
   * Primary "保存为工作流" click: persists DIRECTLY with the captured steps —
   * no model call, zero tokens. The AI node review is opt-in via the separate
   * "AI refine" button, so the default path never spends tokens.
   */
  const savePromptWorkflowDirect = (): void => {
    const prompt = workflowPrompt
    if (!prompt || prompt.saving) return
    void persistPromptWorkflow(prompt)
  }

  /**
   * "AI refine" click: opens the AI review dialog and runs the node review
   * (one model call, only when the user asks for it). With nothing to review
   * it saves straight away instead — a review of zero steps is pointless.
   */
  const refinePromptWorkflow = (): void => {
    const prompt = workflowPrompt
    if (!prompt || prompt.saving || prompt.reviewing) return
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
      const workflow = derivePreview(prompt.base, prompt.keep, prompt.aiSelections, prompt.trigger)
      // `fromGeneration` lets the background harden the graph against the live
      // page (verified selectors + persisted element waits) before persisting.
      // Editor/import saves must NOT get this — hand-tuned selectors are
      // never rewritten behind the user's back.
      await sendCommand({ type: 'workflows.save', workflow, fromGeneration: true })
      // In draft mode the background still holds the operator-tool draft; drop
      // it so a later turn in the same conversation starts with a clean slate
      // rather than appending to the just-saved workflow. Fire-and-forget:
      // a clear failure does not block the saved-status announcement below.
      if (prompt.source === 'draft') {
        sendCommand({ type: 'workflows.draft.clear', conversationId: prompt.conversationId }).catch(
          () => undefined,
        )
      }
      setWorkflowPrompt(null)
      append({
        role: 'status',
        text: tRef.current.chatSaveWorkflowSaved({ name: workflow.name }),
      })
      if (prompt.verifyRun) {
        // Opt-in verify run: the AI-debug loop re-executes the workflow for
        // real, hands failed nodes to the AI (one repair round), and verifies
        // the fixes takeover-free. Progress streams on the running board; the
        // verdict lands here as chat entries.
        append({ role: 'status', text: tRef.current.chatWorkflowVerifyStarted })
        try {
          const debug = await sendCommand({ type: 'workflows.debug', id: workflow.id })
          if (debug.type === 'workflows.debug') {
            const r = debug.result
            if (r.ok && r.pendingChanges.length > 0) {
              append({
                role: 'status',
                text: tRef.current.chatWorkflowVerifyPending({ count: r.pendingChanges.length }),
              })
            } else if (r.ok) {
              append({
                role: 'status',
                text: tRef.current.chatWorkflowVerifyPassed({
                  summary: (r.summary || '').slice(0, 200),
                }),
              })
            } else if (r.cancelled) {
              append({ role: 'status', text: tRef.current.taskOutcomeCancelled })
            } else {
              append({
                role: 'error',
                text: tRef.current.chatWorkflowVerifyFailed({
                  reason: (r.error || r.summary || '').slice(0, 300),
                }),
              })
            }
          }
        } catch (error) {
          append({
            role: 'error',
            text: tRef.current.chatWorkflowVerifyFailed({ reason: (error as Error).message }),
          })
        }
      }
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
    const prompt = workflowPrompt
    setWorkflowPrompt(null)
    // A "Skip" on a draft-sourced card means the user explicitly rejected the
    // current draft — clear it so the next workflow-mode turn starts fresh
    // instead of re-prompting with the same nodes.
    if (prompt?.source === 'draft') {
      sendCommand({ type: 'workflows.draft.clear', conversationId: prompt.conversationId }).catch(
        () => undefined,
      )
    }
  }

  /**
   * Re-derives the preview workflow from the untouched base: first the AI
   * node-review keep set (dropping whole steps), then the AI-prefill toggles,
   * then the trigger selection.
   * Layering all three from the base keeps every toggle idempotent.
   */
  const derivePreview = (
    base: Workflow,
    keep: Record<string, boolean> | null,
    aiSelections: Record<string, boolean>,
    trigger: TriggerSelection,
  ): Workflow =>
    applyTriggerSelection(
      applyAiPrefillOptions(applyNodeKeepSelection(base, keep ?? {}), aiSelections),
      trigger,
    )

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
        workflow: derivePreview(prev.base, prev.keep, aiSelections, prev.trigger),
      }
    })
  }

  /** Keep/drop one reviewed step (primary + its satellites) on the card. */
  const toggleStepKeep = (stepId: string, kept: boolean): void => {
    setWorkflowPrompt((prev) => {
      if (!prev) return prev
      const keep = { ...prev.keep, [stepId]: kept }
      return {
        ...prev,
        keep,
        workflow: derivePreview(prev.base, keep, prev.aiSelections, prev.trigger),
      }
    })
  }

  /**
   * Change the trigger the saved workflow will launch from. Patched into the
   * preview immediately so the card can show the resulting consequence (a
   * time-based trigger starts firing as soon as the workflow is saved).
   */
  const changeTrigger = (trigger: TriggerSelection): void => {
    setWorkflowPrompt((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        trigger,
        workflow: derivePreview(prev.base, prev.keep, prev.aiSelections, trigger),
      }
    })
  }

  /** Toggle the opt-in verify run on the save card. */
  const toggleVerifyRun = (enabled: boolean): void => {
    setWorkflowPrompt((prev) => (prev ? { ...prev, verifyRun: enabled } : prev))
  }

  /**
   * Fold one detected repeat run into a loop.
   *
   * The background rewrites the DRAFT and re-materialises the workflow, so the
   * whole card is replaced from the response rather than patched locally —
   * folding changes the node ids the review and AI-prefill state point at, and
   * merging that by hand would be the easiest way to show a stale step list.
   */
  const foldRun = async (index: number): Promise<void> => {
    const prompt = workflowPrompt
    if (!prompt || prompt.folding !== null) return
    setWorkflowPrompt({ ...prompt, folding: index, foldNote: null })
    let result: Awaited<ReturnType<typeof sendCommand>>
    try {
      result = await sendCommand({
        type: 'workflows.draft.fold',
        conversationId: prompt.conversationId,
        index,
        // The exact ids the card rendered: the background re-detects runs on
        // the current draft, so the ids — not the list position — pick the run
        // the user actually clicked.
        runIds: prompt.suggestions[index]?.runIds,
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setWorkflowPrompt((prev) => (prev ? { ...prev, folding: null, foldNote: text } : prev))
      return
    }
    if (result.type !== 'workflows.draft.fold' || !result.workflow) {
      setWorkflowPrompt((prev) => prev && { ...prev, folding: null })
      return
    }
    const workflow = result.workflow
    const trigger = triggerSelectionOf(workflow)
    setWorkflowPrompt({
      ...prompt,
      base: workflow,
      workflow: applyTriggerSelection(workflow, trigger),
      trigger,
      steps: workflow.drawflow.nodes.filter((n) => !isTriggerNode(n)).length,
      stepList: reviewStepsOf(workflow),
      suggestions: result.suggestions ?? [],
      folding: null,
      foldNote: result.folded ? t.chatFoldApplied : (result.reason ?? t.chatFoldRefused),
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
        {/*
          Icon-only toggles: three text labels squeezed the toolbar, so the
          explanations moved into the hover tooltips. The workflow-save card is
          capped to workflow-generation mode (driven by `modeRef`).
        */}
        <div className="flex items-center gap-1">
          <ToolbarIconButton
            active={includeSelection}
            icon={<Highlighter size={15} className="shrink-0" aria-hidden="true" />}
            label={t.chatAttachSelection}
            onClick={() => setIncludeSelection((current) => !current)}
          />
        </div>
        <ToolbarIconButton
          icon={<History size={16} className="shrink-0" aria-hidden="true" />}
          label={t.convHistory}
          onClick={() => {
            void refreshConversations()
            setShowHistory(true)
          }}
        />
      </div>

      <div
        className="pane chat-log"
        ref={logRef}
        onScroll={(event) => {
          const el = event.currentTarget
          setAtBottom(isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight))
        }}
      >
        {!atBottom && (
          // A zero-height sticky wrapper keeps the pill pinned to the top edge
          // of the scrollport without taking layout space (no content jump).
          <div className="sticky top-0 z-10 h-0">
            <button
              className="absolute right-4 top-2 flex items-center gap-1 rounded-full border border-border bg-accent px-3 py-1 text-xs font-medium text-on-accent shadow-md hover:opacity-90"
              onClick={() => {
                setAtBottom(true)
                logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
              }}
              title={t.chatJumpToLatest}
              type="button"
            >
              <ArrowDown size={12} aria-hidden="true" />
              {t.chatJumpToLatest}
            </button>
          </div>
        )}
        {entries.length === 0 &&
          confirms.length === 0 &&
          askUsers.length === 0 &&
          plans.length === 0 && <div className="empty">{t.chatEmpty}</div>}

        {groupEntries(entries).map((item) => {
          if (item.kind === 'single') {
            const entry = item.entry
            return (
              <div className="msg" data-role={entry.role} key={entry.id}>
                {/*
                  User text is shown exactly as typed; status and error lines
                  are plain text generated by this extension. Only assistant
                  replies are parsed as Markdown, and those render as turns
                  below.
                */}
                {entry.text}
                <MessageAttachments attachments={entry.attachments} />
                <MsgActions
                  busy={busy}
                  entry={entry}
                  isLastAssistant={false}
                  t={t}
                  title={convTitle}
                />
              </div>
            )
          }
          // Consecutive assistant/tool entries are one agent turn: the model
          // often thinks, answers, calls a tool, then continues — keeping
          // those segments in one bubble prevents the reply from visually
          // breaking into disconnected blocks.
          const containsLastAssistant = item.entries.some((entry) => entry.id === lastAssistantId)
          return (
            <AssistantTurn
              busy={busy}
              entries={item.entries}
              isLast={containsLastAssistant}
              key={item.entries[0]!.id}
              live={busy && containsLastAssistant}
              onSkillSaved={(text) => append({ role: 'status', text })}
              t={t}
              title={convTitle}
            />
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

        {askUsers.map((request) => (
          <AskUserCard key={request.requestId} onAnswer={answerAskUser} request={request} t={t} />
        ))}

        {plans.map((request) => (
          <PlanCard key={request.requestId} onDecide={answerPlan} request={request} t={t} />
        ))}

        {saveNotice && !workflowPrompt && (
          <div className="confirm-card" data-kind="workflow">
            <p className="hint" style={{ margin: 0 }} role="status">
              {saveNotice}
            </p>
            <div className="actions">
              <button onClick={() => setSaveNotice(null)} type="button">
                {t.chatSaveWorkflowSkip}
              </button>
            </div>
          </div>
        )}

        {workflowPrompt && (
          <div className="confirm-card" data-kind="workflow">
            <strong>
              {workflowPrompt.source === 'draft'
                ? t.chatSaveWorkflowDraftPrompt({ steps: workflowPrompt.steps })
                : t.chatSaveWorkflowPrompt({ steps: workflowPrompt.steps })}
            </strong>
            <p className="hint" style={{ margin: '6px 0' }}>
              {workflowPrompt.workflow.name}
            </p>
            {workflowPrompt.saveError && (
              <p className="hint text-err" style={{ margin: '6px 0' }} role="alert">
                {workflowPrompt.saveError}
              </p>
            )}
            <WorkflowTriggerPicker
              locale={locale}
              onChange={changeTrigger}
              selection={workflowPrompt.trigger}
            />
            {workflowPrompt.probesChecking && (
              <p className="hint" style={{ margin: '4px 0' }} role="status">
                {t.chatWorkflowProbeChecking}
              </p>
            )}
            {!workflowPrompt.probesChecking &&
              workflowPrompt.probes !== null &&
              workflowPrompt.probes.length > 0 && (
                <div className="ai-prefill-list" role="group" aria-label={t.chatWorkflowProbeTitle}>
                  <p className="hint">{t.chatWorkflowProbeTitle}</p>
                  {failingProbes(workflowPrompt.probes).length === 0 ? (
                    <p className="hint" style={{ margin: '4px 0' }}>
                      {t.chatWorkflowProbeAllOk({ count: workflowPrompt.probes.length })}
                    </p>
                  ) : (
                    failingProbes(workflowPrompt.probes).map((probe) => (
                      <div className="ai-prefill-item" key={probe.nodeId}>
                        <span className="wf-input-name">{probe.blockId}</span>
                        <span className="wf-input-default">
                          {probe.status === 'ambiguous'
                            ? t.chatWorkflowProbeAmbiguous({ count: probe.matches })
                            : t.chatWorkflowProbeMissing}
                          {` · ${probe.selector}`}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            {!workflowPrompt.probesChecking && workflowPrompt.probes === null && (
              <p className="hint" style={{ margin: '4px 0' }}>
                {t.chatWorkflowProbeUnverified}
              </p>
            )}
            {(workflowPrompt.integrity.danglingVars.length > 0 ||
              workflowPrompt.integrity.unreachable.length > 0) && (
              <div
                className="ai-prefill-list"
                role="group"
                aria-label={t.chatWorkflowIntegrityTitle}
              >
                <p className="hint text-err">{t.chatWorkflowIntegrityTitle}</p>
                {workflowPrompt.integrity.danglingVars.map((dangling) => (
                  <div
                    className="ai-prefill-item"
                    key={`${dangling.nodeId}:${dangling.param}:${dangling.reference}`}
                  >
                    <span className="wf-input-name">{`{{${dangling.reference}}}`}</span>
                    <span className="wf-input-default">
                      {t.chatWorkflowIntegrityDangling({ blockId: dangling.blockId })}
                    </span>
                  </div>
                ))}
                {workflowPrompt.integrity.unreachable.length > 0 && (
                  <div className="ai-prefill-item">
                    <span className="wf-input-name">
                      {t.chatWorkflowIntegrityUnreachable({
                        count: workflowPrompt.integrity.unreachable.length,
                      })}
                    </span>
                    <span className="wf-input-default">
                      {workflowPrompt.integrity.unreachable.join(', ')}
                    </span>
                  </div>
                )}
              </div>
            )}
            {runIssues && (runIssues.errors.length > 0 || runIssues.warnings.length > 0) && (
              <div
                className="ai-prefill-list"
                role="group"
                aria-label={t.chatWorkflowRunIssuesTitle}
              >
                <p className={`hint ${runIssues.errors.length > 0 ? 'text-err' : ''}`}>
                  {t.chatWorkflowRunIssuesTitle}
                </p>
                {runIssues.errors.map((error, index) => (
                  <div className="ai-prefill-item" key={`run-error-${index}`}>
                    <span className="wf-input-name text-err">
                      {t.chatWorkflowRunIssuesError}
                    </span>
                    <span className="wf-input-default">{error}</span>
                  </div>
                ))}
                {runIssues.warnings.map((warning, index) => (
                  <div className="ai-prefill-item" key={`run-warning-${index}`}>
                    <span className="wf-input-name">{t.chatWorkflowRunIssuesWarning}</span>
                    <span className="wf-input-default">{warning}</span>
                  </div>
                ))}
                {runIssues.errors.length > 0 && (
                  <p className="hint text-err mt-1">
                    {t.chatWorkflowRunIssuesBlocked}
                  </p>
                )}
              </div>
            )}
            {declaredInputsOf(workflowPrompt.workflow).length > 0 && (
              <div className="ai-prefill-list" role="group" aria-label={t.chatWorkflowInputsTitle}>
                <p className="hint">{t.chatWorkflowInputsTitle}</p>
                {declaredInputsOf(workflowPrompt.workflow).map((input) => (
                  <label className="ai-prefill-item" key={input.name}>
                    <span className="wf-input-name">{`{{${input.name}}}`}</span>
                    <span className="wf-input-default">{input.defaultValue || '—'}</span>
                  </label>
                ))}
                <p className="hint" style={{ margin: '4px 0 0' }}>
                  {t.chatWorkflowInputsHint}
                </p>
              </div>
            )}
            {codeNodesOf(workflowPrompt.workflow).length > 0 && (
              <div
                className="ai-prefill-list"
                role="group"
                aria-label={t.chatWorkflowCodeNodesTitle}
              >
                <p className="hint">{t.chatWorkflowCodeNodesTitle}</p>
                {codeNodesOf(workflowPrompt.workflow).map((node) => (
                  <div className="ai-prefill-item" key={node.id}>
                    <span>{node.reason || t.chatWorkflowCodeNodesNoReason}</span>
                  </div>
                ))}
                <p className="hint" style={{ margin: '4px 0 0' }}>
                  {t.chatWorkflowCodeNodesHint}
                </p>
              </div>
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
            {workflowPrompt.suggestions.length > 0 && (
              <div className="ai-prefill-list" role="group" aria-label={t.chatFoldTitle}>
                <p className="hint">{t.chatFoldTitle}</p>
                {workflowPrompt.suggestions.map((suggestion, index) => (
                  <div
                    className="ai-prefill-item"
                    key={`${suggestion.kind}-${suggestion.runIds[0]}`}
                  >
                    <button
                      disabled={workflowPrompt.folding !== null || workflowPrompt.saving}
                      onClick={() => void foldRun(index)}
                      type="button"
                    >
                      {workflowPrompt.folding === index ? t.chatFoldBusy : t.chatFoldApply}
                    </button>
                    <span>{suggestion.reason}</span>
                  </div>
                ))}
                <p className="hint" style={{ margin: '4px 0 0' }}>
                  {workflowPrompt.foldNote ?? t.chatFoldHint}
                </p>
              </div>
            )}
            <label className="ai-prefill-item" style={{ marginTop: '4px' }}>
              <input
                checked={workflowPrompt.verifyRun}
                disabled={workflowPrompt.saving}
                onChange={(event) => toggleVerifyRun(event.target.checked)}
                type="checkbox"
              />
              <span>{t.chatWorkflowVerifyRun}</span>
            </label>
            {workflowPrompt.verifyRun && (
              <p className="hint" style={{ margin: '4px 0' }}>
                {t.chatWorkflowVerifyRunHint}
              </p>
            )}
            <div className="actions">
              <button
                className="primary"
                disabled={workflowPrompt.saving || (runIssues !== null && runIssues.errors.length > 0)}
                onClick={savePromptWorkflowDirect}
                title={
                  runIssues !== null && runIssues.errors.length > 0
                    ? t.chatWorkflowRunIssuesBlocked
                    : undefined
                }
                type="button"
              >
                {t.chatSaveWorkflowSave}
              </button>
              {workflowPrompt.stepList.length > 0 && (
                <button
                  disabled={workflowPrompt.saving || workflowPrompt.reviewing}
                  onClick={refinePromptWorkflow}
                  title={t.chatWorkflowReviewing}
                  type="button"
                >
                  {t.chatSaveWorkflowAiReview}
                </button>
              )}
              <button
                disabled={workflowPrompt.saving}
                onClick={dismissPromptWorkflow}
                type="button"
              >
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
        {/*
          The active-skill chip lives INSIDE the input box: the wrapper is the
          positioning context, the chip floats over the textarea's top edge,
          and the textarea gains matching top padding while it is shown.
        */}
        <div className="relative min-h-0 flex-1">
          {activeSkill && (
            <div className="skill-chip absolute left-2 top-1.5 z-10 mr-2">
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
          <textarea
            className={`h-full w-full${activeSkill ? ' pt-8!' : ''}`}
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
        </div>
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
              <option value="workflow">🧩 {t.modeWorkflow}</option>
            </select>
            <button
              aria-label="mode info"
              className="icon-btn mode-info-btn"
              onClick={() => setModeInfoOpen((open) => !open)}
              type="button"
            >
              <Info size={14} aria-hidden="true" />
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
                <p>
                  <b>🧩 {t.modeWorkflow}</b>
                  <br />
                  {t.modeWorkflowHint}
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
