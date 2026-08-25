/**
 * The agent: tool schemas, the tool-call loop, and confirmation gating.
 *
 * Provider-agnostic — it talks to whichever OpenAI-compatible endpoint is
 * active because tool calling is part of the shared wire format.
 *
 * ## Acting on the page, safely
 *
 * Every action — clicking, typing, scrolling, switching tabs — changes a
 * page the user may be logged into. Therefore **all action tools require
 * explicit user approval** before they run, with a human-readable summary
 * naming the target and value. The confirmation card is rendered by the
 * side panel.
 *
 * Reading the page is also gated: page text may contain email, dashboards,
 * or bank statements, and reading it ships that text to the model endpoint.
 * Attaching the page in the composer waives that gate for the attached URL
 * only.
 *
 * Secrets (passwords, the user's API keys) are never handed back to the
 * model as values. The agent asks for a credential by label via
 * `get_secret`, the user approves, and the *action* tool receives the
 * resolved value directly — the model only ever sees `{"filled": true}`.
 *
 * @module background/agent
 */

import {
  LlmError,
  streamCompletion,
  type WireMessage,
  type WireTool,
  type WireToolCall,
} from '../lib/llm'
import type { AgentServerMessage, TurnTokenUsage } from '../lib/messages'
import { renderSkillCatalogue, renderSkillPrompt } from '../lib/skills'
import {
  addHistory,
  findSkillByName,
  getActiveProvider,
  listPasswords,
  listProfiles,
  listSkills,
  newId,
  recordPasswordUse,
  getSkill,
} from '../lib/storage'
import { isSamePage } from '../lib/pages'
import { DEFAULT_SYSTEM_PROMPT } from '../lib/system-prompt'
import { entryFields, findField, type AgentMode, type PasswordEntry, type Skill, type UserProfile } from '../lib/types'
import type { Op, OpResult, Target } from '../lib/ops'
import {
  DriverError,
  closeActiveTab,
  execOnActiveTab,
  listTabs,
  newTab,
  settleAfterNavigation,
  snapshotActiveTab,
  switchTab,
} from './driver'
import { activeTab, readActivePage } from './page'

/** Tools that change something and therefore always need approval. */
const ACTION_TOOLS = new Set([
  'click',
  'fill',
  'select_option',
  'set_checkbox',
  'press_key',
  'scroll',
  'wait_for',
  'open_url',
  'tab_new',
  'tab_switch',
  'tab_close',
])

const READ_TOOLS = new Set(['read_current_page', 'snapshot_page', 'list_tabs'])

/** Fallback cap used when settings cannot supply one. */
const DEFAULT_MAX_TOOL_ROUNDS = 20

/** Re-exported for tests/consumers; the canonical text lives in lib/system-prompt. */
export { DEFAULT_SYSTEM_PROMPT }

// Internal alias used by buildSystemPrompt.
const SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT

export function buildSystemPrompt(options: {
  activeSkill?: Skill | undefined
  catalogue?: readonly Skill[] | undefined
  mode?: AgentMode
  /**
   * User-edited base prompt. When a non-empty string it replaces the default
   * operating rules; an empty/undefined value means use the default.
   */
  basePrompt?: string | undefined
}): string {
  // Chat mode is pure conversation: no operating rules, no skill catalogue, no
  // mode instructions. Just a short identity line so the model stays in role.
  if (options.mode === 'chat') {
    return 'You are Browser Copilot, a browser-extension assistant in the side panel. Answer the user conversationally in their language. You cannot read or act on the page in this mode; keep it concise.'
  }

  const override = options.basePrompt?.trim()
  const base = override ? override : SYSTEM_PROMPT
  const parts = [base]
  // The skill catalogue only matters when no skill is pinned: an active skill's
  // full instructions are injected below instead.
  if (!options.activeSkill && options.catalogue && options.catalogue.length > 0) {
    const catalogue = renderSkillCatalogue(options.catalogue)
    if (catalogue) parts.push(catalogue)
  }

  // State the operating mode so the model does not promise (or attempt) an
  // action the gate will refuse.
  if (options.mode === 'readonly') {
    parts.push(
      'OPERATING MODE: READ-ONLY. You may read the page and list tabs, but you MUST NOT click, type, scroll-to-act, navigate, switch tabs, fill forms, or use secrets. If the user asks you to do something, explain that read-only mode is on and tell them how to switch to Semi or Full auto in the panel.',
    )
  } else if (options.mode === 'full') {
    parts.push(
      'OPERATING MODE: FULL AUTO. The user has pre-approved actions, so do not ask them to confirm — just perform them step by step, taking a fresh snapshot after each navigation or important change. Still read errors back and stop if something looks dangerous.',
    )
  } else {
    parts.push(
      'OPERATING MODE: SEMI-AUTO (default). Every action that changes the page is shown to the user for one-shot approval before it runs. Be precise so the approval summary is clear.',
    )
  }

  // The active (pinned) skill goes LAST — closest to the user's message — so the
  // model treats it as the immediate, overriding instruction rather than a
  // distant block it may ignore. State explicitly that it is already active and
  // must be applied now; otherwise a bare "use the active skill" turn can make
  // the model claim it has no such ability.
  if (options.activeSkill) parts.push(renderSkillPrompt(options.activeSkill))

  return parts.join('\n\n')
}

const TARGET_SCHEMA = {
  type: 'object',
  description:
    'A durable element locator taken verbatim from a snapshot element\'s "target" field.',
  properties: {
    primary: { $ref: '#/$defs/spec' },
    fallbacks: { type: 'array', items: { $ref: '#/$defs/spec' } },
    frameHint: { type: 'string' },
    label: { type: 'string' },
  },
  required: ['primary', 'fallbacks'],
  additionalProperties: true,
} as const

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    how: {
      type: 'string',
      enum: ['testid', 'id', 'name', 'role', 'text', 'css'],
    },
    value: { type: 'string' },
    role: { type: 'string' },
    tag: { type: 'string' },
    nth: { type: 'number' },
  },
  required: ['how', 'value'],
  additionalProperties: true,
} as const

export const TOOLS: WireTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_current_page',
      description:
        'Read the title, URL, selection, and visible text of the active tab. Use for questions about page content when you do not need to act on elements. Requires approval.',
      parameters: {
        type: 'object',
        properties: { maxChars: { type: 'number' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snapshot_page',
      description:
        'Read the active page AND list its interactive elements (buttons, links, inputs) and forms, each with a ref and a durable target. Call this before clicking or filling. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          maxChars: { type: 'number' },
          maxElements: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element (button, link, tab, etc.) by its target from a snapshot.',
      parameters: {
        type: 'object',
        properties: {
          target: TARGET_SCHEMA,
          label: { type: 'string', description: 'Human label for the confirmation prompt.' },
        },
        required: ['target'],
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description:
        'Type text into an input or textarea, replacing its value. Use for text/email/number/search/tel/url fields and contenteditable regions. For checkboxes use set_checkbox; for dropdowns use select_option.',
      parameters: {
        type: 'object',
        properties: {
          target: TARGET_SCHEMA,
          value: { type: 'string' },
          label: { type: 'string' },
          clear: {
            type: 'boolean',
            description: 'Clear the field first (default true).',
          },
        },
        required: ['target', 'value'],
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: 'Choose an option in a <select> dropdown by its visible label or value.',
      parameters: {
        type: 'object',
        properties: {
          target: TARGET_SCHEMA,
          value: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          label: { type: 'string' },
        },
        required: ['target', 'value'],
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_checkbox',
      description: 'Check or uncheck a checkbox, or select a radio button.',
      parameters: {
        type: 'object',
        properties: {
          target: TARGET_SCHEMA,
          value: { type: 'boolean', description: 'Desired checked state (default true).' },
          label: { type: 'string' },
        },
        required: ['target'],
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description:
        'Press a key on the focused element, e.g. "Enter", "Tab", "Escape", "ArrowDown". Use Enter to submit a single-field form.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          target: TARGET_SCHEMA,
          label: { type: 'string' },
        },
        required: ['key'],
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description:
        'Scroll the page or an element. Use {mode:"by", y: 600} to read more of a long page, {mode:"bottom"} to reach the end, {mode:"top"} for the top, or pass a target with {mode:"into_view"} to reveal an element.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['into_view', 'by', 'top', 'bottom'] },
          x: { type: 'number' },
          y: { type: 'number' },
          target: TARGET_SCHEMA,
        },
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for',
      description:
        'Wait briefly until an element becomes visible (e.g. after opening a menu). Returns immediately if it is already visible; otherwise the driver polls briefly.',
      parameters: {
        type: 'object',
        properties: { target: TARGET_SCHEMA, label: { type: 'string' } },
        required: ['target'],
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Navigate the active tab to a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab_new',
      description: 'Open a new tab, optionally navigating to a URL, and switch to it.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab_switch',
      description:
        'Switch to another tab in this window by its index (0-based, as returned by list_tabs).',
      parameters: {
        type: 'object',
        properties: { index: { type: 'number' } },
        required: ['index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab_close',
      description: 'Close the active tab.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tabs',
      description: 'List the tabs open in the current window with their index, title, and URL.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_profile',
      description:
        'Get the user\'s saved personal profile(s) (name, email, phone, address, company, etc.) for filling forms. Read-only and local; does not need approval. Returns labels and fields, not passwords.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_secrets',
      description:
        'List saved credential bundles by label and URL, with the names of their fields (e.g. username, password, cvv) — NOT the secret values. Use to find the right entry and field name before calling get_secret. Read-only.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_secret',
      description:
        "Fill a field using a saved credential bundle identified by its id. Pass 'field' to choose which value (e.g. 'username' or 'password'); it defaults to 'password'. The user must approve; the value is filled directly and never shown to you.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id from list_secrets.' },
          field: { type: 'string', description: "Field name to fill (defaults to 'password')." },
          target: TARGET_SCHEMA,
          label: { type: 'string' },
        },
        required: ['id', 'target'],
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        'Load a saved skill\'s full instructions by name and follow them. Read-only.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
]

export type ConfirmFn = (name: string, argsPreview: string) => Promise<boolean>

export interface AgentDeps {
  send: (message: AgentServerMessage) => void
  confirm: ConfirmFn
  signal?: AbortSignal
  skillId?: string | undefined
  grantedPageUrl?: string | undefined
  /** Bounding id for history records. */
  conversationId: string
  /**
   * Returns the current autonomy mode. The agent calls this before every
   * tool action, so switching from semi to full (or back) in the panel takes
   * effect on the next action within the same turn — without waiting for a
   * new message from the user.
   */
  getMode: () => Promise<AgentMode>
  /**
   * Returns the maximum number of model↔tool round trips allowed in one turn.
   * Read at turn start so a settings change applies to the next request.
   */
  getMaxToolRounds: () => Promise<number>
  /**
   * Returns the names of tools the user has disabled and their custom base
   * system prompt (empty string = use the default). Read at turn start so
   * toggles take effect on the next request without a worker restart.
   */
  getToolConfig: () => Promise<{ disabledTools: string[]; basePrompt: string }>
}

function parseArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    throw new Error(`Tool arguments were not valid JSON: ${trimmed.slice(0, 200)}`)
  }
}

function asTarget(value: unknown): Target | undefined {
  if (!value || typeof value !== 'object') return undefined
  const obj = value as Record<string, unknown>
  if (!obj.primary || typeof obj.primary !== 'object') return undefined
  return obj as unknown as Target
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/** Redacts a snapshot to a model-friendly size: targets + labels, no giant text. */
function summarizeSnapshot(snapshot: {
  url: string
  title: string
  elements: Array<{
    ref: string
    role: string
    name: string
    tag: string
    type?: string
    value?: string
    placeholder?: string
    disabled?: boolean
    checked?: boolean
    required?: boolean
    inViewport: boolean
  }>
  forms: unknown
  scrollY: number
  scrollHeight: number
  viewportHeight: number
  text: string
  truncated: boolean
  elementsTruncated: boolean
}): unknown {
  const ELEMENT_LIMIT = 80
  const elements = snapshot.elements.slice(0, ELEMENT_LIMIT).map((el) => ({
    ref: el.ref,
    role: el.role,
    name: el.name,
    tag: el.tag,
    ...(el.type ? { type: el.type } : {}),
    ...(el.value !== undefined ? { value: el.value } : {}),
    ...(el.placeholder ? { placeholder: el.placeholder } : {}),
    ...(el.disabled ? { disabled: true } : {}),
    ...(el.checked !== undefined ? { checked: el.checked } : {}),
    ...(el.required ? { required: true } : {}),
    inViewport: el.inViewport,
  }))
  // Keep the full text but cap so a long page doesn't blow the context.
  const text =
    snapshot.text.length > 6000 ? `${snapshot.text.slice(0, 6000)}…[truncated]` : snapshot.text
  return {
    url: snapshot.url,
    title: snapshot.title,
    text,
    truncated: snapshot.truncated,
    elementsTruncated:
      snapshot.elementsTruncated || snapshot.elements.length > ELEMENT_LIMIT,
    elements,
    forms: snapshot.forms,
    scroll: {
      y: snapshot.scrollY,
      total: snapshot.scrollHeight,
      viewport: snapshot.viewportHeight,
      remaining: Math.max(0, snapshot.scrollHeight - snapshot.scrollY - snapshot.viewportHeight),
    },
  }
}

/**
 * Cap on the page/snapshot text kept in a single tool result that lands in the
 * transcript. The raw read can be up to ~12k chars; once it is in history every
 * later round re-sends it, so we keep a tighter budget here. Element refs/labels
 * (what the model actually clicks/fills) are preserved; the prose body is
 * shortened. A page that truly needs more text can pass maxChars explicitly.
 */
const TRANSCRIPT_TEXT_CAP = 4000

function compactPageRead(page: {
  url: string
  title: string
  text: string
  truncated: boolean
  selection?: string
}): unknown {
  const text =
    page.text.length > TRANSCRIPT_TEXT_CAP
      ? `${page.text.slice(0, TRANSCRIPT_TEXT_CAP)}…[truncated]`
      : page.text
  return {
    url: page.url,
    title: page.title,
    ...(page.selection ? { selection: page.selection } : {}),
    text,
    truncated: page.truncated || page.text.length > TRANSCRIPT_TEXT_CAP,
  }
}

function compactSnapshot(snapshot: Parameters<typeof summarizeSnapshot>[0]): unknown {
  const summarized = summarizeSnapshot(snapshot) as {
    url: string
    title: string
    text: string
    truncated: boolean
    elementsTruncated: boolean
    elements: unknown[]
    forms: unknown
    scroll: unknown
  }
  const text =
    summarized.text.length > TRANSCRIPT_TEXT_CAP
      ? `${summarized.text.slice(0, TRANSCRIPT_TEXT_CAP)}…[truncated]`
      : summarized.text
  return { ...summarized, text, truncated: summarized.truncated || text.length < summarized.text.length }
}

async function recordAction(
  conversationId: string,
  action: string,
  summary: string,
  host: string | undefined,
  approved: boolean,
  ok: boolean,
  detail?: string[],
): Promise<void> {
  try {
    await addHistory({
      id: newId(),
      at: Date.now(),
      conversationId,
      action,
      summary,
      ...(host ? { host } : {}),
      approved,
      ok,
      ...(detail && detail.length > 0 ? { detail } : {}),
    })
  } catch {
    /* non-fatal */
  }
}

interface ToolContext {
  conversationId: string
  /** Set when a click/action likely navigated, so the caller can re-snapshot. */
  navigated: boolean
  /** The most recently read URL; used to attach history hosts. */
  lastUrl?: string
  /** Tools the user has disabled; the model should not call them. */
  disabled: Set<string>
}

/**
 * Tools whose large result is a full page/snapshot and is safe to retire once
 * the page navigates away. The model is told the snapshot was dropped; it can
 * re-read if it still needs it.
 */
const PAGE_READ_TOOLS = new Set(['read_current_page', 'snapshot_page'])

/**
 * Token-budget guard for long automated runs. Every prior tool result is
 * re-sent on each round, so old 4k–12k page reads/snapshots come to dominate
 * token cost. This compacts read/snapshot tool results IN PLACE in the
 * transcript, replacing their bulky JSON with a short retired stub the model
 * can act on (it re-reads if it needs the current page).
 *
 * By default the single most recent result is kept (the model is usually
 * acting on it); after a navigation even that is stale, so callers pass
 * `retireAll`. Only tool-message `content` (what goes to the model) is touched —
 * UI step summaries and action history come from separate paths. Exported for
 * testing.
 */
export function retireOldPageReads(history: WireMessage[], retireAll = false): void {
  let mostRecentReadIndex = -1
  if (!retireAll) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const msg = history[i]
      if (msg?.role === 'tool' && PAGE_READ_TOOLS.has((msg as { name?: string }).name ?? '')) {
        mostRecentReadIndex = i
        break
      }
    }
  }
  for (let i = 0; i < history.length; i += 1) {
    const msg = history[i]
    if (msg?.role !== 'tool') continue
    if (i === mostRecentReadIndex) continue
    const name = (msg as { name?: string }).name ?? ''
    if (!PAGE_READ_TOOLS.has(name)) continue
    const content = typeof msg.content === 'string' ? msg.content : ''
    // Already compacted.
    if (content.startsWith('{"ok":true,"retired"') || content.includes('"retired":true')) continue
    let url = ''
    try {
      const parsed = JSON.parse(content) as { url?: string; title?: string }
      url = parsed.url ?? ''
    } catch {
      /* not JSON — leave it */
      continue
    }
    msg.content = JSON.stringify({
      ok: true,
      retired: true,
      note:
        '[Page context retired] This older page read was dropped to save context. Call read_current_page or snapshot_page again if you need the current page.',
      ...(url ? { url } : {}),
    })
  }
}

/**
 * Builds detailed audit lines beyond the one-line summary: the element label
 * interacted with, what was typed/selected, and the URL opened, etc. Secret
 * values (get_secret / a field marked secret) are masked so the audit log never
 * stores a password in plain text.
 */
function describeDetail(name: string, args: Record<string, unknown>, output?: string): string[] {
  const lines: string[] = []
  const target = asTarget(args.target)
  const element =
    typeof args.label === 'string'
      ? args.label
      : target?.label ?? describeTarget(target)
  if (element && element !== 'element') lines.push(`Element: ${element}`)

  switch (name) {
    case 'click':
      // Nothing beyond the element label.
      break
    case 'fill': {
      const value = typeof args.value === 'string' ? args.value : ''
      const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value
      lines.push(`Typed: "${shown}"`)
      break
    }
    case 'select_option':
      lines.push(`Selected: ${JSON.stringify(args.value)}`)
      break
    case 'set_checkbox':
      lines.push(`Set to: ${args.value === false ? 'unchecked' : 'checked'}`)
      break
    case 'press_key':
      if (args.key) lines.push(`Key: ${String(args.key)}`)
      break
    case 'open_url':
    case 'tab_new':
      if (args.url) lines.push(`URL: ${String(args.url)}`)
      break
    case 'tab_switch':
      lines.push(`Tab index: ${Number(args.index ?? 0)}`)
      break
    case 'get_secret':
      lines.push(`Field: ${typeof args.field === 'string' ? args.field : 'password'}`)
      lines.push('Value: •••••••• (hidden)')
      break
  }

  if (output) {
    try {
      const parsed = JSON.parse(output) as { error?: string; url?: string }
      if (parsed.error) lines.push(`Result: ${parsed.error}`)
      else if (parsed.url) lines.push(`Now at: ${parsed.url}`)
    } catch {
      /* not JSON */
    }
  }
  return lines
}

/** Produces the human-readable summary shown on the confirmation card. */
function describeAction(name: string, args: Record<string, unknown>): string {
  const label = typeof args.label === 'string' ? args.label : undefined
  const targetLabel =
    label ??
    (() => {
      const target = asTarget(args.target)
      return target?.label ?? describeTarget(target)
    })()
  switch (name) {
    case 'read_current_page':
      return 'Read the text of the current page'
    case 'snapshot_page':
      return 'Read the current page and list its buttons, links, and fields'
    case 'click':
      return `Click ${targetLabel}`
    case 'fill':
      return `Type into ${targetLabel}${
        typeof args.value === 'string' && args.value.length > 0
          ? `: "${args.value.length > 40 ? `${args.value.slice(0, 40)}…` : args.value}"`
          : ''
      }`
    case 'select_option':
      return `Select ${JSON.stringify(args.value)} in ${targetLabel}`
    case 'set_checkbox':
      return `${args.value === false ? 'Uncheck' : 'Check'} ${targetLabel}`
    case 'press_key':
      return `Press ${String(args.key ?? '')}${targetLabel ? ` on ${targetLabel}` : ''}`
    case 'scroll': {
      const mode = String(args.mode ?? 'into_view')
      if (mode === 'by') return `Scroll by ${Number(args.y ?? 0)}px`
      if (mode === 'top') return 'Scroll to the top'
      if (mode === 'bottom') return 'Scroll to the bottom'
      return `Scroll ${targetLabel} into view`
    }
    case 'wait_for':
      return `Wait for ${targetLabel} to appear`
    case 'open_url':
      return `Open ${String(args.url ?? '')}`
    case 'tab_new':
      return args.url ? `Open a new tab at ${String(args.url)}` : 'Open a new tab'
    case 'tab_switch':
      return `Switch to tab #${Number(args.index ?? 0)}`
    case 'tab_close':
      return 'Close the active tab'
    case 'get_secret':
      return `Fill ${targetLabel} with saved credential${
        typeof args.field === 'string' && args.field ? ` (${args.field})` : ''
      }`
    default:
      return name
  }
}

function describeTarget(target: Target | undefined): string {
  if (!target) return 'element'
  const spec = target.primary
  return spec.how === 'role' || spec.how === 'text'
    ? `"${spec.value}"`
    : `<${spec.tag ?? 'element'} ${spec.how}=${spec.value}>`
}

/**
 * Runs the tool after approval. `approved` is false when the user declined.
 * Returns the JSON string handed back to the model.
 */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case 'read_current_page': {
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : undefined
      const page = await readActivePage(maxChars)
      ctx.lastUrl = page.url
      return JSON.stringify(compactPageRead(page))
    }

    case 'snapshot_page': {
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 8000
      const maxElements = typeof args.maxElements === 'number' ? args.maxElements : 120
      const snapshot = await snapshotActiveTab(maxChars, maxElements)
      ctx.lastUrl = snapshot.url
      return JSON.stringify(compactSnapshot(snapshot))
    }

    case 'list_tabs': {
      const tabs = await listTabs()
      return JSON.stringify(
        tabs.map((tab, index) => ({
          index,
          id: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
        })),
      )
    }

    case 'click': {
      const target = asTarget(args.target)
      if (!target) return JSON.stringify({ error: 'click requires a target.' })
      const result = await execOnActiveTab({ action: 'click', target })
      return afterAction(result, ctx)
    }

    case 'fill': {
      const target = asTarget(args.target)
      if (!target) return JSON.stringify({ error: 'fill requires a target.' })
      const value = String(args.value ?? '')
      const clear = args.clear === false ? false : true
      const result = await execOnActiveTab({ action: 'fill', target, value, clear })
      return afterAction(result, ctx, value.length > 0 ? { filled: true } : { cleared: true })
    }

    case 'select_option': {
      const target = asTarget(args.target)
      if (!target) return JSON.stringify({ error: 'select_option requires a target.' })
      const value = (Array.isArray(args.value)
        ? args.value.map(String)
        : String(args.value ?? '')) as string | string[]
      const result = await execOnActiveTab({ action: 'select_option', target, value })
      return afterAction(result, ctx)
    }

    case 'set_checkbox': {
      const target = asTarget(args.target)
      if (!target) return JSON.stringify({ error: 'set_checkbox requires a target.' })
      const value = args.value === undefined ? true : args.value === true
      const result = await execOnActiveTab({ action: 'set_checkbox', target, value })
      return afterAction(result, ctx)
    }

    case 'press_key': {
      const key = String(args.key ?? '')
      if (!key) return JSON.stringify({ error: 'press_key needs a key.' })
      const target = asTarget(args.target)
      const op: Op = target
        ? { action: 'press_key', target, value: key }
        : { action: 'press_key', value: key }
      const result = await execOnActiveTab(op)
      return afterAction(result, ctx)
    }

    case 'scroll': {
      const mode = String(args.mode ?? 'by')
      const target = asTarget(args.target)
      const op: Op =
        mode === 'into_view' && target
          ? { action: 'scroll', target, scroll: { mode: 'into_view' } }
          : mode === 'top'
            ? { action: 'scroll', scroll: { mode: 'top' } }
            : mode === 'bottom'
              ? { action: 'scroll', scroll: { mode: 'bottom' } }
              : {
                  action: 'scroll',
                  scroll: {
                    mode: 'by',
                    x: typeof args.x === 'number' ? args.x : 0,
                    y: typeof args.y === 'number' ? args.y : 600,
                  },
                }
      const result = await execOnActiveTab(op)
      return afterAction(result, ctx)
    }

    case 'wait_for': {
      const target = asTarget(args.target)
      if (!target) return JSON.stringify({ error: 'wait_for requires a target.' })
      // Poll a few times; the kernel itself is synchronous.
      const deadline = Date.now() + 4000
      let last: OpResult | undefined
      while (Date.now() < deadline) {
        last = await execOnActiveTab({ action: 'wait_for', target })
        if (last.ok) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return afterAction(last ?? { ok: false, found: false, frameUrl: '', isTopFrame: true }, ctx)
    }

    case 'open_url': {
      const url = String(args.url ?? '').trim()
      // The driver handles the isInjectablePage check with a clear error.
      await chrome.tabs.update({ url })
      ctx.navigated = true
      await settleAfterNavigation()
      return JSON.stringify({ ok: true, navigated: true, url })
    }

    case 'tab_new': {
      const url = typeof args.url === 'string' ? args.url.trim() : undefined
      const tab = await newTab(url || undefined)
      ctx.navigated = true
      ctx.lastUrl = tab.url
      await settleAfterNavigation()
      return JSON.stringify({ ok: true, tabId: tab.id, url: tab.url })
    }

    case 'tab_switch': {
      const index = Number(args.index ?? 0)
      const tab = await switchTab(index)
      ctx.navigated = true
      ctx.lastUrl = tab.url
      return JSON.stringify({ ok: true, index, tabId: tab.id, title: tab.title, url: tab.url })
    }

    case 'tab_close': {
      await closeActiveTab()
      return JSON.stringify({ ok: true })
    }

    case 'get_secret': {
      // Fills directly; the model never receives the secret value. Supports
      // both the legacy id-only form and an optional field name (e.g. fill
      // just the "username" or "password" field of a multi-field entry).
      const id = String(args.id ?? '')
      const fieldName = typeof args.field === 'string' ? args.field : undefined
      const target = asTarget(args.target)
      if (!target) return JSON.stringify({ error: 'get_secret requires a target.' })
      const secret = await resolveSecret(id)
      if (!secret) return JSON.stringify({ error: 'Saved credential not found.' })
      const field = fieldName
        ? findField(secret, fieldName)
        : findField(secret, 'password') ?? entryFields(secret)[0]
      if (!field) return JSON.stringify({ error: `No "${fieldName ?? 'password'}" field in this credential.` })
      const result = await execOnActiveTab({
        action: 'fill',
        target,
        value: field.value,
      })
      void recordPasswordUse(secret.id).catch(() => {})
      return afterAction(result, ctx, { filled: true, using: `${secret.label}:${field.key}` })
    }

    case 'get_my_profile': {
      const profiles = await listProfiles()
      return JSON.stringify(profiles.map(summarizeProfile))
    }

    case 'list_secrets': {
      const entries = await listPasswords()
      return JSON.stringify(
        entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          ...(entry.url ? { url: entry.url } : {}),
          fields: entryFields(entry).map((f) => ({ key: f.key, secret: !!f.secret })),
          useCount: entry.useCount,
        })),
      )
    }

    case 'use_skill': {
      const wanted = String(args.name ?? '').trim()
      if (!wanted) return JSON.stringify({ error: 'A skill name is required.' })
      const skill = await findSkillByName(wanted)
      if (!skill) {
        const available = (await listSkills()).map((entry) => entry.name)
        return JSON.stringify({ error: `No skill named "${wanted}".`, available })
      }
      return JSON.stringify({
        skill: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        note: 'Follow these instructions for the rest of this conversation unless the user says otherwise.',
      })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function resolveSecret(id: string): Promise<PasswordEntry | undefined> {
  const entries = await listPasswords()
  return entries.find((entry) => entry.id === id)
}

function summarizeProfile(profile: UserProfile): unknown {
  // Include all profile fields; these are personal (name/email/phone) but not
  // secrets, and the model needs them to fill forms. Omit empty values.
  const fields: Record<string, string> = {}
  const copy: Array<keyof UserProfile> = [
    'label',
    'fullName',
    'firstName',
    'lastName',
    'email',
    'phone',
    'address',
    'city',
    'state',
    'postalCode',
    'country',
    'company',
    'jobTitle',
  ]
  for (const key of copy) {
    const value = profile[key]
    if (typeof value === 'string' && value.trim()) fields[key] = value
  }
  for (const [key, value] of Object.entries(profile.custom)) {
    if (value && value.trim()) fields[`custom.${key}`] = value
  }
  return fields
}

async function afterAction(
  result: OpResult,
  ctx: ToolContext,
  extra: Record<string, unknown> = {},
): Promise<string> {
  if (result.mayNavigate) {
    ctx.navigated = true
    await settleAfterNavigation()
  }
  if (result.ok) {
    return JSON.stringify({
      ok: true,
      ...(result.note ? { note: result.note } : {}),
      ...(result.mayNavigate ? { navigated: true } : {}),
      ...extra,
    })
  }
  return JSON.stringify({
    ok: false,
    error: result.error ?? 'The action did not succeed.',
    ...(result.usedFallback ? { matchedViaFallback: true } : {}),
    ...extra,
  })
}

/**
 * Produces the short, human-readable chip text for a tool result.
 *
 * Exported so the resume path can render the same one-line summary for a
 * replayed tool call that the live turn showed. The stored `content` of a
 * tool message is the raw JSON result; showing it directly would dump raw
 * JSON into the transcript.
 */
export function summarizeToolResult(name: string, result: string): string {
  return shortSummary(name, result)
}

function shortSummary(name: string, result: string): string {
  try {
    const parsed = JSON.parse(result) as { error?: string; note?: string; navigated?: boolean }
    if (parsed.error) return `${name}: ${parsed.error}`.slice(0, 200)
    if (name === 'read_current_page') {
      const page = JSON.parse(result) as { title?: string; text?: string }
      return `Read "${page.title ?? 'page'}" (${page.text?.length ?? 0} chars)`
    }
    if (name === 'use_skill') {
      const loaded = JSON.parse(result) as { skill?: string; error?: string }
      return loaded.error ? loaded.error : `Using skill "${loaded.skill ?? 'unknown'}"`
    }
    if (parsed.navigated) return `${name} ✓ (page changed)`
    if (parsed.note) return `${name}: ${parsed.note}`
    return `${name} ✓`
  } catch {
    return result.length > 200 ? `${result.slice(0, 200)}…` : result
  }
}

export async function runAgentTurn(
  history: WireMessage[],
  deps: AgentDeps,
): Promise<TurnTokenUsage | null> {
  // These reads are independent and all hit local storage / the settings cache,
  // but running them in parallel shaves the serial round trips off the
  // time-to-first-token — most noticeable for short chat-mode turns.
  const [provider, skillList, initialMode, toolConfig, maxToolRounds] = await Promise.all([
    getActiveProvider(),
    listSkills(),
    deps.getMode(),
    deps.getToolConfig(),
    deps.getMaxToolRounds(),
  ])
  const activeSkill = deps.skillId ? await getSkill(deps.skillId) : undefined
  const catalogue = activeSkill ? [] : skillList
  const disabled = new Set(toolConfig.disabledTools)
  const systemPrompt = buildSystemPrompt({
    activeSkill,
    catalogue,
    mode: initialMode,
    basePrompt: toolConfig.basePrompt,
  })
  const roundsCap = maxToolRounds || DEFAULT_MAX_TOOL_ROUNDS

  // Filter the advertised tools:
  //  - chat mode sends no tools at all (pure conversation);
  //  - read-only mode hides every action that changes the page;
  //  - the user's disabled-tool list hides specific tools regardless of mode.
  // The execution switch below still rejects a tool that slips through, so a
  // stale model call cannot run a disabled tool.
  const tools =
    initialMode === 'chat'
      ? []
      : TOOLS.filter((tool) => {
          const name = tool.function.name
          if (disabled.has(name)) return false
          if (initialMode === 'readonly' && ACTION_TOOLS.has(name)) return false
          return true
        })

  const ctx: ToolContext = {
    conversationId: deps.conversationId,
    navigated: false,
    disabled,
  }

  // Sum usage across every LLM round in this turn (a turn may make several
  // tool-calling completions before it finally answers). Each round's usage is
  // reported in its own trailing SSE chunk.
  const totalUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }

  for (let round = 0; round < roundsCap; round += 1) {
    // Bail promptly when the run is cancelled, rather than waiting for the next
    // in-flight fetch to notice its signal. The streamCompletion catch below
    // also handles an abort mid-request.
    if (deps.signal?.aborted) {
      deps.send({ type: 'status', text: 'Cancelled.' })
      return null
    }

    // Bound page-context growth in long automated runs. Every prior tool result
    // is re-sent each round, so old reads/snapshots dominate token cost. If the
    // page navigated, drop ALL prior reads (they describe a page that no longer
    // exists); otherwise still retire older reads past a small keep window.
    if (ctx.navigated) {
      retireOldPageReads(history, true)
      ctx.navigated = false
    } else {
      retireOldPageReads(history, false)
    }

    const messages: WireMessage[] = [{ role: 'system', content: systemPrompt }, ...history]

    // "Thinking" covers the request in flight until either text starts streaming
    // or a tool call is announced. The first text delta flips it to "Responding";
    // the panel removes the line on the first delta regardless.
    deps.send({ type: 'phase', phase: 'thinking' })
    let announced = false

    let result
    try {
      result = await streamCompletion(
        {
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          model: provider.model,
          providerLabel: provider.label,
          messages,
          tools,
          ...(provider.headers ? { headers: provider.headers } : {}),
          ...(typeof provider.temperature === 'number'
            ? { temperature: provider.temperature }
            : {}),
          ...(typeof provider.maxTokens === 'number' ? { maxTokens: provider.maxTokens } : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        },
        {
          onText: (delta) => {
            if (!announced) {
              announced = true
              deps.send({ type: 'phase', phase: 'responding' })
            }
            deps.send({ type: 'delta', text: delta })
          },
          onToolCallStart: (name) => deps.send({ type: 'tool.start', name }),
          onUsage: (usage) => {
            totalUsage.inputTokens += usage.inputTokens
            totalUsage.outputTokens += usage.outputTokens
            totalUsage.cachedInputTokens += usage.cachedInputTokens ?? 0
            totalUsage.reasoningTokens += usage.reasoningTokens ?? 0
            totalUsage.totalTokens += usage.totalTokens
          },
        },
      )
    } catch (error) {
      if (error instanceof LlmError) throw error
      if ((error as Error)?.name === 'AbortError') return null
      throw error
    }

    if (result.toolCalls.length === 0) {
      history.push({ role: 'assistant', content: result.content })
      return totalUsage.totalTokens > 0 ? totalUsage : null
    }

    history.push({
      role: 'assistant',
      content: result.content.length > 0 ? result.content : '',
      tool_calls: result.toolCalls,
    })

    for (const call of result.toolCalls) {
      if (deps.signal?.aborted) {
        deps.send({ type: 'status', text: 'Cancelled.' })
        return totalUsage.totalTokens > 0 ? totalUsage : null
      }
      await runOneToolCall(call, history, deps, ctx)
    }
  }

  deps.send({
    type: 'status',
    text: `Stopped after ${roundsCap} tool rounds to avoid a loop.`,
  })
  return totalUsage.totalTokens > 0 ? totalUsage : null
}

export function needsConfirmation(
  name: string,
  grantedPageUrl: string | undefined,
  currentTabUrl: string | undefined,
): boolean {
  if (ACTION_TOOLS.has(name)) return true
  if (!READ_TOOLS.has(name)) return false
  // Read tools are gated by the attach grant, like before.
  if (name !== 'read_current_page' && name !== 'snapshot_page') return true
  if (!grantedPageUrl) return true
  return !isSamePage(grantedPageUrl, currentTabUrl)
}

async function runOneToolCall(
  call: WireToolCall,
  history: WireMessage[],
  deps: AgentDeps,
  ctx: ToolContext,
): Promise<void> {
  const name = call.function.name
  const pushResult = (content: string): void => {
    history.push({ role: 'tool', tool_call_id: call.id, content, name })
  }

  let args: Record<string, unknown>
  try {
    args = parseArgs(call.function.arguments)
  } catch (error) {
    pushResult(JSON.stringify({ error: (error as Error).message }))
    deps.send({
      type: 'tool.result',
      name,
      summary: `Invalid arguments: ${(error as Error).message}`,
    })
    return
  }

  // Defence in depth: a disabled tool's schema is withheld, but a model may
  // still hallucinate a call to it. Refuse rather than execute.
  if (ctx.disabled.has(name)) {
    const message = `The "${name}" tool is disabled in settings.`
    pushResult(JSON.stringify({ error: message }))
    deps.send({ type: 'tool.result', name, summary: `Blocked (${name} disabled)` })
    return
  }

  // Read the mode freshly for every action, so switching it in the panel
  // applies to the very next tool call, even within the same turn.
  const mode = await deps.getMode()

  // Read-only mode refuses any action that changes the page. Defensive: the
  // tool isn't even advertised in this mode (when the turn started there),
  // but a turn that began in another mode can be switched to read-only
  // mid-run; actions from that point must stop.
  if ((mode === 'readonly' || mode === 'chat') && ACTION_TOOLS.has(name)) {
    const inChat = mode === 'chat'
    const message = inChat
      ? 'Chat mode is on. No page actions or tools are available. Ask the user to switch to Semi or Full auto in the panel to operate the page.'
      : 'Read-only mode is now on. Clicking, typing, navigating, switching tabs, and filling forms are disabled. Ask the user to switch to Semi or Full auto in the panel.'
    pushResult(JSON.stringify({ error: message }))
    deps.send({
      type: 'tool.result',
      name,
      summary: inChat ? 'Blocked (chat mode)' : 'Blocked (read-only mode)',
    })
    void recordAction(
      deps.conversationId,
      name,
      describeAction(name, args),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      false,
      false,
      describeDetail(name, args),
    )
    return
  }

  const needsApproval = ACTION_TOOLS.has(name) || READ_TOOLS.has(name)
  let approved = true
  if (needsApproval) {
    let mustConfirm = true
    // Full auto means no confirmations — neither for actions that change the
    // page nor for reads. The user chose this mode deliberately (the panel
    // shows a warning before persisting it), so gating reads behind the attach
    // checkbox would still pop a dialog and contradict the "full auto" promise.
    if (mode === 'full') {
      mustConfirm = false
    } else if (READ_TOOLS.has(name) && deps.grantedPageUrl) {
      // Semi mode: a page attached by the user is already consented to, but a
      // read that drifted to another page still asks.
      try {
        const tab = await activeTab()
        mustConfirm = needsConfirmation(name, deps.grantedPageUrl, tab?.url)
      } catch {
        mustConfirm = true
      }
    }

    if (mustConfirm) {
      approved = await deps.confirm(name, describeAction(name, args))
      if (!approved) {
        pushResult(JSON.stringify({ error: 'The user declined this action. Do not retry it.' }))
        deps.send({ type: 'tool.result', name, summary: 'Declined by user' })
        void recordAction(
          deps.conversationId,
          name,
          describeAction(name, args),
          ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
          false,
          false,
          describeDetail(name, args),
        )
        return
      }
    }
  }

  try {
    const output = await executeTool(name, args, ctx)
    pushResult(output)
    const summary = shortSummary(name, output)
    deps.send({ type: 'tool.result', name, summary })
    let ok = true
    try {
      const parsed = JSON.parse(output) as { ok?: boolean; error?: string }
      ok = parsed.ok !== false
    } catch {
      /* keep ok */
    }
    void recordAction(
      deps.conversationId,
      name,
      describeAction(name, args),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      approved,
      ok,
      describeDetail(name, args, output),
    )
  } catch (error) {
    const message =
      error instanceof DriverError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
    pushResult(JSON.stringify({ error: message }))
    deps.send({ type: 'tool.result', name, summary: `Failed: ${message}` })
    void recordAction(
      deps.conversationId,
      name,
      describeAction(name, args),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      approved,
      false,
      [...describeDetail(name, args), `Error: ${message}`],
    )
  }
}
