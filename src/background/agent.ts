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
import { renderSkillCatalogue, renderSkillPrompt, validateSkill } from '../lib/skills'
import {
  addHistory,
  findSkillByName,
  getActiveProvider,
  listPasswords,
  listProfiles,
  listSkills,
  newId,
  recordPasswordUse,
  saveSkill,
  getSettings,
  getSkill,
} from '../lib/storage'
import {
  askSaveViaSidePanel,
  getDownloadDir,
  resolveTransferMode,
  writeFileToDownloadDir,
} from '../lib/download-dir'
import { inspectImage, preprocessImage, recognizeImage, resolveVisionTarget } from '../lib/vision'
import { evaluateArithmetic } from '../lib/ocr-candidates'
import { isSamePage } from '../lib/pages'
import { DEFAULT_SYSTEM_PROMPT } from '../lib/system-prompt'
import {
  entryFields,
  findField,
  type AgentMode,
  type PasswordEntry,
  type Skill,
  type UserProfile,
} from '../lib/types'
import type { Op, OpResult, Target } from '../lib/ops'
import {
  DriverError,
  closeActiveTab,
  execOnActiveTab,
  listTabs,
  newTab,
  ocrImage,
  pinActiveTab,
  resolveAutomationTab,
  settleAfterNavigation,
  snapshotActiveTab,
  switchTab,
  unpinTab,
  updateActiveTabUrl,
} from './driver'
import { normalScopeFromWindowId, currentPanelScope, type ScopeWindow } from './automation-scope'
import {
  drainConsoleEntries,
  ensureTabMonitor,
  getRecentRequests,
  waitForNetworkIdle,
} from './cdp-monitor'
import { activeTab, readActivePage } from './page'
import { captureVisiblePage } from './capture'
import { captureElementRobust } from './element-capture'
import { listTasks } from '../lib/task-store'
import { describeSchedule } from '../lib/schedule'

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
  'pin_tab',
  'unpin_tab',
  'run_javascript',
  'save_local',
  'recognize_image',
  'screenshot',
  'create_skill',
  'run_plan',
])

const READ_TOOLS = new Set([
  'read_current_page',
  'snapshot_page',
  'list_tabs',
  'list_network_requests',
])

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
      'OPERATING MODE: FULL AUTO. The user has pre-approved actions, so do not ask them to confirm — just perform them, issuing multiple tool calls in one response whenever the next steps are unambiguous. Take a fresh snapshot after each navigation or important change. Still read errors back and stop if something looks dangerous.',
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
    'A durable element locator. Prefer passing `ref` — only pass a full target copied VERBATIM from a snapshot element\'s "target" field; do not assemble one yourself.',
  properties: {
    primary: { $ref: '#/$defs/spec' },
    fallbacks: { type: 'array', items: { $ref: '#/$defs/spec' } },
    frameHint: { type: 'string' },
    label: { type: 'string' },
  },
  required: ['primary', 'fallbacks'],
  additionalProperties: true,
} as const

/**
 * Optional per-call screenshot flag shared by the action tools. The result's
 * `observation` then embeds a base64 PNG for multimodal remote clients; the
 * side-panel agent loop strips the flag (text-only transcript).
 */
const SCREENSHOT_ARG = {
  type: 'boolean',
  description:
    "Also attach a base64 screenshot of the page to the result's observation, for multimodal remote clients. Ignored by the side-panel agent (its transcript is text-only).",
} as const

/** Preferred element handle: a short ref from the latest snapshot/observation. */
const REF_ARG = {
  type: 'string',
  description:
    'Element ref (e.g. "e12") from the latest snapshot_page or an action\'s observation. Preferred over passing a full target object.',
} as const

const SPEC_SCHEMA = {
  type: 'object',
  description:
    'One locator strategy, copied verbatim from a snapshot element — never invented. ' +
    '`testid`/`id`/`name`: the attribute value goes in `value`. ' +
    '`role`: the ARIA role goes in `role` (e.g. "textbox") and the accessible name in `value` — a spec with only the role name in `value` is a common mistake. ' +
    '`text`: the element\'s visible text in `value`. ' +
    '`css`: a CSS selector in `value`.',
  properties: {
    how: {
      type: 'string',
      enum: ['testid', 'id', 'name', 'role', 'text', 'css'],
      description: 'Locator strategy.',
    },
    value: {
      type: 'string',
      description:
        'Attribute value / accessible name / visible text / CSS selector — see the strategy descriptions.',
    },
    role: {
      type: 'string',
      description: 'ARIA role for `role` specs (e.g. "textbox", "button"); omit otherwise.',
    },
    tag: { type: 'string', description: 'Optional tag-name narrowing.' },
    nth: { type: 'number', description: 'Zero-based index among visible matches.' },
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
      description: 'Click an element (button, link, tab, etc.) by its ref from a snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: REF_ARG,
          target: TARGET_SCHEMA,
          label: { type: 'string', description: 'Human label for the confirmation prompt.' },
          withScreenshot: SCREENSHOT_ARG,
        },
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recognize_image',
      description:
        'Recognize the text/content of an image using an image model. The image can be supplied in two ways: pass an `image` value (a data URL or absolute http(s) URL) that is already available, OR pass a CSS selector to capture that page element; pass nothing to screenshot the visible page. Use when you need to read characters or text that live inside an image, most commonly a CAPTCHA code that you will then type into a field with fill. Check this conversation first: if the same unchanged image was already recognized earlier (or the user attached it and you can see it), reuse that result instead of calling this tool again — re-recognize only when the image changed (e.g. a refreshed CAPTCHA), the earlier call failed, or you cannot tell it is the same image. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          image: {
            type: 'string',
            description:
              'The image itself, given as a data URL (data:image/…) or an absolute http(s) URL. The image is recognized as-is — it is attached to the recognition request, so nothing needs to be fetched. Prefer this when an <img> src or a data URL is already in hand.',
          },
          selector: {
            type: 'string',
            description:
              'CSS selector of the <img> or element to capture from the active page. Prefer the img\'s own selector, e.g. "#captchaImg" or "img[src*=captcha]". Omit `image` to capture this region. If neither `image` nor `selector` is given, the visible page is used.',
          },
          prompt: {
            type: 'string',
            description:
              'Optional custom instruction for what to extract. Defaults to transcribing all visible text/characters (good for CAPTCHA). E.g. "Read the 4-digit code in the top-left corner".',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description:
        "Take a screenshot of a page element (or the whole visible page) and send it to the image model so it can LOOK at it — inspect an element's current state, layout, colors, or verify what is actually rendered. Unlike snapshot_page (which returns the DOM text) this shows the visual rendering. To READ TEXT that lives inside an image (a CAPTCHA, a label, digits), call recognize_image instead — this tool is for visual inspection, not text extraction. Optionally pass a `target` CSS selector to capture just that element; pass nothing to capture the whole page. Requires approval.",
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'CSS selector of the element to screenshot, e.g. "#captchaImg" or "img[src*=captcha]". Omit to capture the whole visible page.',
          },
          prompt: {
            type: 'string',
            description:
              'Optional instruction for what the model should look for. Defaults to reading any visible text/CAPTCHA and describing the element. E.g. "Is the submit button disabled?" or "What is displayed in the top-right toast?".',
          },
        },
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
          ref: REF_ARG,
          target: TARGET_SCHEMA,
          value: { type: 'string' },
          label: { type: 'string' },
          withScreenshot: SCREENSHOT_ARG,
          generated: {
            type: 'boolean',
            description:
              'Set true when you composed the text yourself (a message, summary, or any content not dictated by the user or read verbatim from the page); false when the text is literal user-dictated data (an email address, URL, name, number).',
          },
          clear: {
            type: 'boolean',
            description: 'Clear the field first (default true).',
          },
        },
        required: ['value'],
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
          ref: REF_ARG,
          target: TARGET_SCHEMA,
          value: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          label: { type: 'string' },
        },
        required: ['value'],
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
          ref: REF_ARG,
          target: TARGET_SCHEMA,
          value: { type: 'boolean', description: 'Desired checked state (default true).' },
          label: { type: 'string' },
        },
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
          ref: REF_ARG,
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
          ref: REF_ARG,
          target: TARGET_SCHEMA,
          withScreenshot: SCREENSHOT_ARG,
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
        properties: { ref: REF_ARG, target: TARGET_SCHEMA, label: { type: 'string' } },
        $defs: { spec: SPEC_SCHEMA },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description:
        "Navigate the active tab to a URL. The active tab is the one in the panel's window (side-panel runs never touch other browser windows).",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          withScreenshot: SCREENSHOT_ARG,
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab_new',
      description:
        "Open a new tab, optionally navigating to a URL, and switch to it. The tab is created in the panel's window; other browser windows are never touched.",
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
        'Switch to another tab in this window by its index (0-based, as returned by list_tabs). "This window" is the panel\'s window; tabs in other windows are out of scope.',
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
      name: 'pin_tab',
      description:
        'Pin a tab so every subsequent action targets it, avoiding tab_switch round trips. Pass a tabId from list_tabs, or nothing to pin the tab that would be acted on anyway. The pin expires after 5 minutes.',
      parameters: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Tab to pin. Omit to pin the current automation target.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unpin_tab',
      description: 'Remove the tab pin; subsequent actions target the active tab again.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_javascript',
      description:
        'Run custom JavaScript in the active web page and return its result. Use for data extraction or page manipulation the other tools cannot do. The code runs as a function body in the page; use `return` to send a JSON-serializable value back. This changes the page and requires approval.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'JavaScript statements to execute in the page. Use `return` to send a value back. Do NOT use this to fill form fields — use fill/select_option/set_checkbox; JS-assigned values are silently discarded by React/Vue controlled inputs.',
          },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tabs',
      description:
        "List the tabs open in the panel's window (not other windows) with their index, title, and URL. Indices are that window's.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_network_requests',
      description:
        'List recent network requests of the active tab (URL, method, HTTP status, failures), captured passively since the monitor attached. Use after an action to diagnose failed, slow, or error-status requests. Read-only; requires approval.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_profile',
      description:
        "Get the user's saved personal profile(s) (name, email, phone, address, company, etc.) for filling forms. Read-only and local; does not need approval. Returns labels and fields, not passwords.",
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
      description: "Load a saved skill's full instructions by name and follow them. Read-only.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_skill',
      description:
        'Create or update a saved skill, making it available in this project immediately (it is written to the skills store as a SKILL.md file). A skill is a reusable set of instructions the agent can auto-apply later. Use when the user asks to make, record, or remember a reusable procedure/skill, or when an active skill-authoring flow asks you to save the result. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Unique skill name (used to trigger it later). Keep it short, e.g. "captcha-helper".',
          },
          description: {
            type: 'string',
            description:
              'One concise sentence saying what the skill does AND when to use it — the auto-match trigger. E.g. "Recognizes CAPTCHA codes on login pages. Use when the user needs to read a verification code image."',
          },
          instructions: {
            type: 'string',
            description:
              "The skill body as Markdown: imperative steps in the user's language. This is the full instruction set applied when the skill runs.",
          },
          autoMatch: {
            type: 'boolean',
            description:
              'Allow the agent to auto-select this skill when it matches, without the user pinning it. Defaults to true.',
          },
          id: {
            type: 'string',
            description:
              'Optional existing skill id to update instead of create. You usually should not pass this; omit to create or update by name.',
          },
        },
        required: ['name', 'description', 'instructions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_scheduled_tasks',
      description:
        'List the currently enabled scheduled tasks (their name, schedule, kind, prompt, and latest status). Use when the user asks what scheduled/recurring/automated tasks exist, what is running on a timer, or "what are my tasks". Read-only and local; does not need approval.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_local',
      description:
        "Save a piece of text/content as a local file on the user's computer. Use this whenever the user asks to download, export, or save some content (a report, summary, transcript, table, or code) to a file. Do NOT build a Blob or <a download> script with run_javascript to download files — save_local uses the configured download folder or asks where to save. Requires approval.",
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The full text to save into the file.' },
          filename: {
            type: 'string',
            description:
              'Filename with extension, e.g. report.md. Optional; defaults to download.txt.',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_plan',
      description:
        'Execute a sequence of already-decided steps in ONE round, in order, stopping at the first failure. Use it when the next steps are unambiguous from the current snapshot (e.g. fill three fields, then click submit, then wait_for the confirmation element). Each step is { tool, args } using the other tool names; steps run exactly like individual tool calls, and an { optional: true } step that fails is skipped instead of stopping the plan. Do NOT use run_plan when a later step depends on what you would learn from an earlier one — do those one at a time. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered steps to execute. At most 16.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', description: 'A tool name other than run_plan.' },
                args: { type: 'object', description: "That tool's arguments, same schema." },
                optional: {
                  type: 'boolean',
                  description: 'Skip this step (continue the plan) if it fails. Default false.',
                },
              },
              required: ['tool'],
            },
          },
        },
        required: ['steps'],
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
  /**
   * Window id of the side panel that sent this turn's message. Resolved to a
   * validated {@link ScopeWindow} at turn start and threaded through every
   * tool call, so a panel-driven turn reads and acts ONLY inside its own
   * window — other windows belong to the user. Unattended entry points
   * (scheduled tasks, Feishu, the local-agent bridge) leave it undefined and
   * keep the legacy global resolution.
   */
  scopeWindowId?: number
}

function parseArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
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
    target?: unknown
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
    // NOTE: the element's durable `target` is deliberately NOT emitted — it
    // was the single largest token sink in every snapshot. The agent holds the
    // ref→target mapping in ToolContext.snapshotTargets; the model acts with
    // the short `ref` (devtools-mcp's uid pattern) and the full target —
    // including the closed-shadow marker that routes clicks through CDP —
    // never leaves the extension.
  }))
  // Keep the text but cap it hard: a snapshot is re-sent on every later round
  // and the model's locators come from the elements, not the prose.
  const text =
    snapshot.text.length > 3000 ? `${snapshot.text.slice(0, 3000)}…[truncated]` : snapshot.text
  return {
    url: snapshot.url,
    title: snapshot.title,
    text,
    truncated: snapshot.truncated,
    elementsTruncated: snapshot.elementsTruncated || snapshot.elements.length > ELEMENT_LIMIT,
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
  return {
    ...summarized,
    text,
    truncated: summarized.truncated || text.length < summarized.text.length,
  }
}

async function recordAction(
  conversationId: string,
  action: string,
  summary: string,
  host: string | undefined,
  approved: boolean,
  ok: boolean,
  detail?: string[],
  args?: Record<string, unknown>,
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
      ...(args && typeof args === 'object' ? { args } : {}),
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
  /**
   * Ref → element cache from the LATEST snapshot (the devtools-mcp uid
   * pattern): snapshots and observations carry only short refs like "e12",
   * and act tools resolve them here against the full durable target. The
   * snapshot's raw `target` objects never reach the model — that is where
   * most of the old snapshot's token weight lived. Cleared on navigation.
   */
  snapshotTargets?: Map<string, { target: Target; name: string }>
  /**
   * Panel-window scope for this turn: every tab resolution, tab op and page
   * read stays inside this window. Undefined for unattended runs (legacy
   * global behaviour). Validated once at turn start via
   * {@link normalScopeFromWindowId}.
   */
  scope?: ScopeWindow
}

/**
 * Resolves an element target from call args: a `ref` ("e12", preferred) or a
 * full `target` object (legacy/verbatim form, still accepted).
 */
function resolveTargetFrom(
  ctx: ToolContext,
  args: Record<string, unknown>,
): { target: Target } | { error: string } {
  const ref = typeof args.ref === 'string' ? args.ref.trim() : ''
  if (ref) {
    const hit = ctx.snapshotTargets?.get(ref)
    if (!hit) {
      return {
        error: `Unknown ref "${ref}". Refs come from the latest snapshot_page or an action's observation — take a fresh snapshot if the page has changed.`,
      }
    }
    return { target: hit.target }
  }
  const explicit = asTarget(args.target)
  if (explicit) return { target: explicit }
  return {
    error:
      'This tool needs an element: pass `ref` from the latest snapshot (preferred) or a full `target` object.',
  }
}

/** Stores the latest snapshot's ref→target mapping on the context. */
function rememberSnapshotTargets(
  ctx: ToolContext,
  snapshot: { elements: Array<{ ref?: unknown; name?: unknown; target?: unknown }> },
): void {
  const map = new Map<string, { target: Target; name: string }>()
  for (const el of snapshot.elements) {
    const target = asTarget(el.target)
    if (target && typeof el.ref === 'string') {
      map.set(el.ref, { target, name: typeof el.name === 'string' ? el.name : '' })
    }
  }
  ctx.snapshotTargets = map.size > 0 ? map : undefined
}

/**
 * Replaces a ref-only element handle with the resolved durable target for
 * DOWNSTREAM consumers of the recorded args (workflowFromHistory's
 * selectorFromArgs reads `args.target`). Model-facing transcripts stay lean —
 * this only shapes what lands in the action history.
 *
 * When the model passed BOTH a ref and its own inline `target`, the snapshot
 * target still wins — it is what {@link resolveTargetFrom} executed. Recording
 * the inlined guess instead persisted unvalidated locators ("role|textbox")
 * that later broke workflows built from the conversation's history.
 */
function hydrateRecordArgs(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args.ref === 'string') {
    const hit = ctx.snapshotTargets?.get(args.ref)
    if (hit) return { ...args, target: hit.target }
  }
  return args
}
export { hydrateRecordArgs }

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
      note: '[Page context retired] This older page read was dropped to save context. Call read_current_page or snapshot_page again if you need the current page.',
      ...(url ? { url } : {}),
    })
  }

  // Auto-observations attached to action results: keep only the most recent
  // one in the transcript. The observation served its purpose the round it
  // arrived — the model acted on it (or chose not to) — so every older copy
  // (including any base64 screenshot payload) is replaced by a stub.
  let lastObservationIndex = -1
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i]
    if (
      msg?.role === 'tool' &&
      typeof msg.content === 'string' &&
      msg.content.includes('"observation"')
    ) {
      lastObservationIndex = i
      break
    }
  }
  for (let i = 0; i < history.length; i += 1) {
    if (i === lastObservationIndex) continue
    const msg = history[i]
    if (msg?.role !== 'tool' || typeof msg.content !== 'string') continue
    if (!msg.content.includes('"observation"')) continue
    try {
      const parsed = JSON.parse(msg.content) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || !('observation' in parsed)) continue
      msg.content = JSON.stringify({
        ...parsed,
        observation:
          '[discarded] This observation from an older action was dropped to save context. Run snapshot_page if you need the current page.',
      })
    } catch {
      /* not JSON — leave it */
    }
  }
}

/**
 * Builds detailed audit lines beyond the one-line summary: the element label
 * interacted with, what was typed/selected, and the URL opened, etc. Secret
 * values (get_secret / a field marked secret) are masked so the audit log never
 * stores a password in plain text.
 */
function describeDetail(
  name: string,
  args: Record<string, unknown>,
  snapshotTargets?: ToolContext['snapshotTargets'],
  output?: string,
): string[] {
  const lines: string[] = []
  const target =
    asTarget(args.target) ??
    (typeof args.ref === 'string' ? snapshotTargets?.get(args.ref)?.target : undefined)
  const element =
    typeof args.label === 'string'
      ? args.label
      : ((typeof args.ref === 'string' ? snapshotTargets?.get(args.ref)?.name : undefined) ??
        target?.label ??
        describeTarget(target))
  if (element && element !== 'element') lines.push(`Element: ${element}`)

  switch (name) {
    case 'run_plan': {
      const steps = Array.isArray(args.steps) ? (args.steps as { tool?: unknown }[]) : []
      const tools = steps.map((step) => String(step?.tool ?? '?')).join(' → ')
      lines.push(`Plan (${steps.length} steps): ${tools}`)
      break
    }
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
    case 'save_local': {
      const name =
        typeof args.filename === 'string' && args.filename.trim()
          ? args.filename.trim()
          : 'download.txt'
      lines.push(`File: ${name}`)
      const body = typeof args.content === 'string' ? args.content : ''
      if (body) {
        lines.push(
          `Content (${body.length} chars): ${body.length > 80 ? `${body.slice(0, 80)}…` : body}`,
        )
      }
      break
    }
    case 'recognize_image':
      if (typeof args.selector === 'string' && args.selector.trim()) {
        lines.push(`Image: ${args.selector}`)
      } else {
        lines.push('Image: visible page')
      }
      break
    case 'create_skill':
      lines.push(`Skill: ${String(args.name ?? '')}`)
      if (typeof args.description === 'string' && args.description) {
        const d = args.description
        lines.push(`Description (${d.length} chars): ${d.length > 80 ? `${d.slice(0, 80)}…` : d}`)
      }
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
function describeAction(
  name: string,
  args: Record<string, unknown>,
  snapshotTargets?: ToolContext['snapshotTargets'],
): string {
  const label = typeof args.label === 'string' ? args.label : undefined
  const refTarget = typeof args.ref === 'string' ? snapshotTargets?.get(args.ref) : undefined
  const targetLabel =
    label ?? refTarget?.name ?? describeTarget(asTarget(args.target) ?? refTarget?.target)
  switch (name) {
    case 'run_plan': {
      // Approval card for a whole plan: name each step so the user can review
      // the sequence before it runs.
      const steps = Array.isArray(args.steps)
        ? (args.steps as { tool?: unknown; args?: Record<string, unknown> }[])
        : []
      const listed = steps
        .slice(0, 6)
        .map(
          (step, i) => `${i + 1}. ${describeAction(String(step?.tool ?? '?'), step?.args ?? {})}`,
        )
      const more = steps.length > 6 ? `… (+${steps.length - 6} more steps)` : ''
      return `Run a ${steps.length}-step plan:\n${listed.join('\n')}${more ? `\n${more}` : ''}`
    }
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
    case 'run_javascript':
      return 'Run JavaScript in the page'
    case 'get_secret':
      return `Fill ${targetLabel} with saved credential${
        typeof args.field === 'string' && args.field ? ` (${args.field})` : ''
      }`
    case 'save_local':
      return `Save content to ${typeof args.filename === 'string' && args.filename.trim() ? args.filename.trim() : 'a file'}`
    case 'recognize_image':
      return `Recognize text in the ${
        typeof args.selector === 'string' && args.selector.trim()
          ? `image "${args.selector}"`
          : 'visible page image'
      }`
    case 'screenshot':
      return `Screenshot ${
        typeof args.target === 'string' && args.target.trim()
          ? `the element "${args.target}" and inspect the image`
          : 'the visible page and inspect the image'
      }`
    case 'create_skill':
      return `Create skill "${String(args.name ?? '')}"`
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
 * Normalizes an `image` argument passed to `recognize_image` into something the
 * image model can consume: a data URL or an absolute http(s) URL is returned
 * as-is; a relative URL (e.g. an `<img>` src) is resolved against the active
 * tab's URL. Returns null when the reference is unusable.
 */
async function resolveImageRef(ref: string): Promise<string | null> {
  if (/^data:image\//i.test(ref)) return ref
  if (/^https?:\/\//i.test(ref)) return ref
  const tab = await activeTab()
  if (tab?.url) {
    try {
      return new URL(ref, tab.url).href
    } catch {
      return null
    }
  }
  return null
}

/**
 * Downloads an http(s) image and inlines it as a data URL, so both the local
 * OCR worker and the vision model receive self-contained bytes instead of a
 * URL they must each fetch themselves. The response must actually BE an image
 * (many sites serve JSON/API payloads at their captcha URLs — a fast, explicit
 * failure here beats slow cascading failures downstream). Cookies are sent:
 * captchas are commonly session-bound.
 */
async function fetchImageAsDataUrl(
  url: string,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} while downloading ${url}` }
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
    if (!type.startsWith('image/')) {
      return {
        ok: false,
        error:
          `${url} did not return an image (Content-Type: ${type || 'unknown'}). ` +
          'That URL likely serves an API/JSON response — capture the rendered element with a selector instead.',
      }
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return { ok: true, dataUrl: `data:${type};base64,${btoa(binary)}` }
  } catch (error) {
    return {
      ok: false,
      error: `Could not download ${url}: ${(error as Error)?.message ?? String(error)}`,
    }
  }
}

/**
 * Resolves what a vision/screenshot tool should analyze into a data URL, in
 * priority order:
 * 1. an `image` value (data URL or absolute http(s) URL) — used as-is;
 * 2. a captured page element when `selector` is given;
 * 3. otherwise the whole visible page.
 * Returns the reason when nothing usable could be produced, so the tool result
 * says why instead of the opaque "Could not capture the page."
 */
async function resolveToolImage(
  rawImage: string,
  selector: string,
  signal?: AbortSignal,
  opts?: { format?: 'png' | 'jpeg' },
  scope?: ScopeWindow,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  if (rawImage) {
    const ref = await resolveImageRef(rawImage)
    return ref
      ? { ok: true, dataUrl: ref }
      : { ok: false, error: `The image value is not usable: "${rawImage.slice(0, 80)}".` }
  }
  if (selector) {
    // Robust shared capture: scroll into view → in-page SVG capture with
    // waitFor polling → visible-page capture + crop fallback, retried. A
    // plain single capture op fails on pages whose CSP blocks the SVG data
    // URL ("SVG 加载失败") — the crop fallback cannot be blocked that way.
    const captured = await captureElementRobust(selector, { signal, scope })
    if (captured.ok) return { ok: true, dataUrl: captured.dataUrl }
    return {
      ok: false,
      error: `Could not capture the element "${selector}". (${captured.error})`,
    }
  }
  // Default PNG: lossless, for OCR/vision accuracy. The observation
  // screenshot path passes jpeg — a PNG of a full page costs the remote
  // client 5-10x the tokens for no benefit when just eyeballing state.
  const format = opts?.format ?? 'png'
  return captureVisiblePage(scope, {
    format,
    ...(format === 'jpeg' ? { quality: 60 } : {}),
  })
}

/**
 * Runs the tool after approval. `approved` is false when the user declined.
 * Returns the JSON string handed back to the model.
 */
/**
 * Executes a single browser tool directly (no approval, no audit — those live
 * in runOneToolCall). Exported for tests covering run_plan's validation paths;
 * not part of the public agent API.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<string> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }
  switch (name) {
    case 'read_current_page': {
      throwIfAborted()
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : undefined
      const page = await readActivePage(maxChars, ctx.scope)
      ctx.lastUrl = page.url
      return JSON.stringify(compactPageRead(page))
    }

    case 'snapshot_page': {
      throwIfAborted()
      // Default to a lean snapshot: it is re-sent on every later round, so the
      // interactive elements (what the model acts on) matter more than prose.
      // A page whose text is genuinely needed can ask for more via maxChars,
      // or use read_current_page.
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 3000
      const maxElements = typeof args.maxElements === 'number' ? args.maxElements : 120
      const snapshot = await snapshotActiveTab(maxChars, maxElements, ctx.scope)
      ctx.lastUrl = snapshot.url
      rememberSnapshotTargets(ctx, snapshot)
      return JSON.stringify(compactSnapshot(snapshot))
    }

    case 'recognize_image': {
      throwIfAborted()
      const totalStart = performance.now()
      const rawImage = typeof args.image === 'string' ? args.image.trim() : ''
      const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt : undefined

      const resolved = await resolveToolImage(rawImage, selector, signal, undefined, ctx.scope)
      const captureMs = Math.round(performance.now() - totalStart)
      if (!resolved.ok) {
        return JSON.stringify({ ok: false, error: resolved.error })
      }
      const dataUrl = resolved.dataUrl

      const settings = await getSettings()
      const provider = await getActiveProvider().catch(() => undefined)
      const target = resolveVisionTarget(settings.imageModel, settings.providers, provider)
      // Local OCR (Tesseract.js) runs first: it is fully offline, free and,
      // with the upscale+contrast preprocessing, accurate enough for clean
      // text. The vision model is the fallback for the noisy/distorted images
      // OCR comes up empty on.
      const lang = (settings.ocrLanguage || 'eng').trim() || 'eng'

      // An http(s) URL is downloaded here and inlined as a data URL: some
      // sites (e.g. dounai.pro's captcha endpoint) serve JSON rather than
      // image bytes at that URL — failing fast here beats letting Tesseract
      // and the vision provider each discover it after their own slow retries.
      // Captcha endpoints usually serve a fresh image on every request, so an
      // untrustworthy OCR read is retried against a RE-FETCHED image, not the
      // same pixels. Captures and data URLs cannot change → single attempt.
      const sourceUrl = /^https?:\/\//i.test(dataUrl) ? dataUrl : null
      const MAX_OCR_ATTEMPTS = 3
      let processed: string | null = null
      let preprocessMs = 0
      let ocrMs = 0
      let attempts = 0
      let lastOcrError: string | undefined
      let best: { text: string; confidence: number; agreed: boolean; alternatives: string[]; attempt: number; rank: number } | null = null
      const readings: string[] = []

      for (let attempt = 1; attempt <= (sourceUrl ? MAX_OCR_ATTEMPTS : 1); attempt++) {
        attempts = attempt
        let imageData = dataUrl
        if (sourceUrl) {
          const downloaded = await fetchImageAsDataUrl(sourceUrl)
          if (!downloaded.ok) {
            if (best) break // keep the earlier good attempt
            return JSON.stringify({
              ok: false,
              error: downloaded.error,
              timing: { captureMs, preprocessMs, ocrMs, visionMs: 0, attempts, totalMs: Math.round(performance.now() - totalStart) },
            })
          }
          imageData = downloaded.dataUrl
        }
        const tPre = performance.now()
        processed = await preprocessImage(imageData)
        preprocessMs += Math.round(performance.now() - tPre)
        const tOcr = performance.now()
        const ocr = await ocrImage(processed, lang)
        ocrMs += Math.round(performance.now() - tOcr)
        if (!ocr.ok) {
          // An offscreen/worker failure will not improve by refetching — stop.
          lastOcrError = ocr.error
          break
        }
        if (ocr.text.trim()) {
          const text = ocr.text.trim()
          const confidence = Math.round(ocr.confidence)
          const alternatives = (ocr.alternatives ?? []).filter((t) => t.trim() && t.trim() !== text)
          readings.push(text)
          const answerNow = evaluateArithmetic(text)
          const rank = (answerNow !== null ? 2000 : 0) + (ocr.agreed ? 200 : 0) + confidence
          if (!best || rank > best.rank) {
            best = { text, confidence, agreed: ocr.agreed, alternatives, attempt, rank }
          }
          // Trustworthy when the two segmentation passes agree or confidence
          // is high; otherwise refetch a fresh captcha and try again.
          if (ocr.agreed || confidence >= 75) break
        }
      }

      const timing = {
        captureMs,
        preprocessMs,
        ocrMs,
        visionMs: 0,
        attempts,
        totalMs: Math.round(performance.now() - totalStart),
      }

      if (best) {
        const { text, confidence, agreed, alternatives, attempt } = best
        // Hypothesis comparison: expose runner-up readings (and any arithmetic
        // answer) so the model can weigh which reading looks right.
        const answer =
          evaluateArithmetic(text) ??
          [...alternatives].map((t) => evaluateArithmetic(t)).find((v) => v !== null) ??
          undefined
        const parts: string[] = []
        if (attempts > 1) {
          parts.push(
            `Fetched and read ${attempts} fresh captcha images (the endpoint regenerates per request); ` +
              `this is the most plausible reading (attempt ${attempt}).`,
          )
        }
        if (readings.length > 1) {
          parts.push(`All readings: ${readings.join(' | ')} — compare and fill the most plausible one.`)
        }
        parts.push(`Local OCR (Tesseract.js · ${lang}) read ${text.length} chars; use this text to fill the CAPTCHA field.`)
        if (answer !== undefined) {
          parts.push(`The expression evaluates to ${answer} — fill that value.`)
        }
        if (!agreed) {
          parts.push(
            `This read is not fully reliable (confidence ${confidence}/100${alternatives.length > 0 ? ', segmentation passes disagree' : ''}). ` +
              'The CAPTCHA regenerates on every request: if the value is rejected after filling, refresh the page ' +
              'or click the captcha for a new image and call recognize_image again.',
          )
        } else {
          parts.push(
            'If the site rejects the value after filling, refresh the CAPTCHA (it regenerates per request) and recognize the fresh image.',
          )
        }
        return JSON.stringify({
          ok: true,
          text,
          // Tesseract self-assessed confidence (0-100). Low values flag reads
          // the agent may want to double-check with the vision model.
          confidence,
          agreed,
          attempts,
          ...(alternatives.length > 0 ? { alternatives } : {}),
          ...(answer !== undefined ? { answer } : {}),
          timing,
          note: parts.join(' '),
          model: 'tesseract(ocr)',
        })
      }

      if (target && processed) {
        const visionStart = performance.now()
        const result = await recognizeImage(target, processed, { prompt, signal })
        timing.ocrMs = ocrMs
        timing.visionMs = Math.round(performance.now() - visionStart)
        timing.totalMs = Math.round(performance.now() - totalStart)
        if (!result.ok) {
          return JSON.stringify({
            ok: false,
            error:
              result.error +
              ' The CAPTCHA usually regenerates on every request — refresh the page or click the captcha ' +
              'for a new image, then call recognize_image again.',
            timing,
          })
        }
        return JSON.stringify({
          ok: true,
          text: result.text,
          timing,
          note: `Recognized from the image (${result.text.length} chars). Use this text to fill the CAPTCHA field.`,
          model: target.model,
        })
      }

      return JSON.stringify({
        ok: false,
        error:
          'Local OCR could not read the image and no vision-capable image model is configured. ' +
          (lastOcrError ? `OCR error: ${lastOcrError}. ` : '') +
          'Open Settings → 图片识别模型 to set an image model (e.g. gpt-4o, qwen-vl, or glm-4v). ' +
          'The CAPTCHA usually regenerates on every request — refresh the page or click the captcha for ' +
          'a new image, then call recognize_image again.',
        timing,
      })
    }

    case 'screenshot': {
      throwIfAborted()
      const target = typeof args.target === 'string' ? args.target.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt : undefined

      // screenshot always sends the captured image to the image model for a
      // visual read; a `target` selector limits it to a single element.
      const resolved = await resolveToolImage('', target, signal, undefined, ctx.scope)
      if (!resolved.ok) {
        return JSON.stringify({ ok: false, error: resolved.error })
      }
      const dataUrl = resolved.dataUrl

      const processed = await preprocessImage(dataUrl)
      const settings = await getSettings()
      const provider = await getActiveProvider().catch(() => undefined)
      const vision = resolveVisionTarget(settings.imageModel, settings.providers, provider)
      if (!vision) {
        return JSON.stringify({
          ok: false,
          error:
            'The screenshot tool needs a vision-capable image model configured. Open Settings → 图片识别模型 and set a base URL, API key and model (e.g. gpt-4o, qwen-vl, or glm-4v).',
        })
      }

      const result = await inspectImage(vision, processed, { prompt, signal })
      if (!result.ok) return JSON.stringify({ ok: false, error: result.error })
      return JSON.stringify({ ok: true, text: result.text, model: vision.model })
    }

    case 'list_network_requests': {
      throwIfAborted()
      // Reads the passive CDP monitor's buffer; attaching here (best-effort)
      // makes the tool useful even when called before any action ran.
      const tab = await resolveAutomationTab(undefined, ctx.scope)
      if (!tab || typeof tab.id !== 'number') {
        return JSON.stringify({ ok: false, error: '没有可读取的标签页。' })
      }
      await ensureTabMonitor(tab.id)
      const requests = getRecentRequests(tab.id)
      return JSON.stringify({
        ok: true,
        requests,
        ...(requests.length === 0
          ? { note: 'No requests captured yet. Run an action first, then call again.' }
          : {}),
      })
    }

    case 'list_tabs': {
      throwIfAborted()
      const tabs = await listTabs(ctx.scope)
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

    case 'run_javascript': {
      throwIfAborted()
      const code = String(args.code ?? '')
      if (!code.trim()) return JSON.stringify({ error: 'run_javascript requires code.' })
      const result = await execOnActiveTab(
        { action: 'exec_js', value: code },
        signal,
        undefined,
        ctx.scope,
      )
      if (!result.ok)
        return JSON.stringify({ error: result.error ?? 'JavaScript execution failed' })
      return JSON.stringify({ ok: true, result: result.data ?? null })
    }

    case 'save_local': {
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')
      const filename =
        typeof args.filename === 'string' && args.filename.trim()
          ? args.filename.trim()
          : 'download.txt'
      const settings = await getSettings()
      const dir = await getDownloadDir()

      let hasDir = dir !== null
      if (hasDir && dir) {
        try {
          hasDir = (await dir.queryPermission({ mode: 'readwrite' })) === 'granted'
        } catch {
          hasDir = false
        }
      }

      const transfer = resolveTransferMode('auto', settings.downloadAutoSave, hasDir)
      if (transfer === 'auto' && dir) {
        const ok = await writeFileToDownloadDir(dir, filename, content)
        if (ok) return JSON.stringify({ ok: true, savedPath: filename, mode: 'auto' })
      }

      const res = await askSaveViaSidePanel(filename)
      if (res.canceled)
        return JSON.stringify({ ok: false, canceled: true, error: 'User cancelled.' })
      if (res.ok) return JSON.stringify({ ok: true, savedPath: filename, mode: 'save-as' })
      return JSON.stringify({
        ok: false,
        error: 'Could not open the save dialog. Ask the user to open the side panel and retry.',
      })
    }

    case 'click': {
      throwIfAborted()
      const resolved = resolveTargetFrom(ctx, args)
      if ('error' in resolved) return JSON.stringify({ error: resolved.error })
      const result = await execOnActiveTab(
        { action: 'click', target: resolved.target },
        signal,
        undefined,
        ctx.scope,
      )
      return afterAction(result, ctx, {}, { withScreenshot: args.withScreenshot === true, signal })
    }

    case 'fill': {
      throwIfAborted()
      const resolved = resolveTargetFrom(ctx, args)
      if ('error' in resolved) return JSON.stringify({ error: resolved.error })
      const target = resolved.target
      const value = String(args.value ?? '')
      const clear = args.clear === false ? false : true
      const result = await execOnActiveTab(
        { action: 'fill', target, value, clear },
        signal,
        undefined,
        ctx.scope,
      )
      return afterAction(result, ctx, value.length > 0 ? { filled: true } : { cleared: true }, {
        withScreenshot: args.withScreenshot === true,
        signal,
      })
    }

    case 'select_option': {
      throwIfAborted()
      const resolved = resolveTargetFrom(ctx, args)
      if ('error' in resolved) return JSON.stringify({ error: resolved.error })
      const target = resolved.target
      const value = (
        Array.isArray(args.value) ? args.value.map(String) : String(args.value ?? '')
      ) as string | string[]
      const result = await execOnActiveTab(
        { action: 'select_option', target, value },
        signal,
        undefined,
        ctx.scope,
      )
      return afterAction(result, ctx, {}, { withScreenshot: args.withScreenshot === true, signal })
    }

    case 'set_checkbox': {
      throwIfAborted()
      const resolved = resolveTargetFrom(ctx, args)
      if ('error' in resolved) return JSON.stringify({ error: resolved.error })
      const target = resolved.target
      const value = args.value === undefined ? true : args.value === true
      const result = await execOnActiveTab(
        { action: 'set_checkbox', target, value },
        signal,
        undefined,
        ctx.scope,
      )
      return afterAction(result, ctx, {}, { withScreenshot: args.withScreenshot === true, signal })
    }

    case 'press_key': {
      throwIfAborted()
      const key = String(args.key ?? '')
      if (!key) return JSON.stringify({ error: 'press_key needs a key.' })
      const resolved = args.target || args.ref ? resolveTargetFrom(ctx, args) : undefined
      if (resolved && 'error' in resolved) return JSON.stringify({ error: resolved.error })
      const op: Op = resolved
        ? { action: 'press_key', target: resolved.target, value: key }
        : { action: 'press_key', value: key }
      const result = await execOnActiveTab(op, signal, undefined, ctx.scope)
      return afterAction(result, ctx, {}, { withScreenshot: args.withScreenshot === true, signal })
    }

    case 'scroll': {
      throwIfAborted()
      const mode = String(args.mode ?? 'by')
      const resolved = args.target || args.ref ? resolveTargetFrom(ctx, args) : undefined
      if (resolved && 'error' in resolved) return JSON.stringify({ error: resolved.error })
      const target = resolved?.target
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
      const result = await execOnActiveTab(op, signal, undefined, ctx.scope)
      return afterAction(result, ctx, {}, { withScreenshot: args.withScreenshot === true, signal })
    }

    case 'wait_for': {
      throwIfAborted()
      const resolved = resolveTargetFrom(ctx, args)
      if ('error' in resolved) return JSON.stringify({ error: resolved.error })
      const target = resolved.target
      // Poll a few times; the kernel itself is synchronous.
      const deadline = Date.now() + 4000
      let last: OpResult | undefined
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        last = await execOnActiveTab({ action: 'wait_for', target }, signal, undefined, ctx.scope)
        if (last.ok) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return afterAction(
        last ?? { ok: false, found: false, frameUrl: '', isTopFrame: true },
        ctx,
        {},
        { signal },
      )
    }

    case 'run_plan': {
      throwIfAborted()
      // Plan-then-execute: the model planned the whole sequence from the last
      // snapshot; this runner performs it deterministically so the turn costs
      // one model round instead of one per step. Approval was granted once for
      // the whole plan (ACTION_TOOLS gating in runOneToolCall), so inner steps
      // skip the per-action confirm dialog — but they still respect disabled
      // tools, the 16-step cap and aborts, and the plan stops at the first
      // non-optional failure so the model can replan from real page state.
      const steps = Array.isArray(args.steps) ? args.steps : []
      if (steps.length === 0) {
        return JSON.stringify({ error: 'run_plan requires a non-empty steps array.' })
      }
      if (steps.length > 16) {
        return JSON.stringify({
          error: `run_plan accepts at most 16 steps (got ${steps.length}). Split the task.`,
        })
      }
      const outcomes: Record<string, unknown>[] = []
      for (let i = 0; i < steps.length; i += 1) {
        throwIfAborted()
        const step = (steps[i] ?? {}) as {
          tool?: unknown
          args?: Record<string, unknown>
          optional?: unknown
        }
        const toolName = String(step.tool ?? '')
        const stepArgs = (step.args && typeof step.args === 'object' ? step.args : {}) as Record<
          string,
          unknown
        >
        // Screenshots never belong in the text-only model transcript.
        delete stepArgs.withScreenshot
        const fail = (error: string): string => {
          outcomes.push({ step: i + 1, tool: toolName, ok: false, error })
          return JSON.stringify({
            ok: false,
            stoppedAt: i + 1,
            error: `run_plan stopped at step ${i + 1} (${toolName}): ${error}`,
            outcomes,
          })
        }
        if (toolName === 'run_plan' || !TOOLS.some((tool) => tool.function.name === toolName)) {
          return fail(`unknown tool "${toolName}"`)
        }
        if (ctx.disabled.has(toolName)) {
          return fail(`"${toolName}" is disabled in settings`)
        }
        const output = await executeTool(toolName, stepArgs, ctx, signal)
        let parsed: { ok?: boolean; error?: string }
        try {
          parsed = JSON.parse(output) as { ok?: boolean; error?: string }
        } catch {
          parsed = { ok: true }
        }
        const ok = parsed.ok !== false
        // Inner steps bypass runOneToolCall (and its audit), so record each
        // one here — action history is the source for "workflow from history",
        // and a plan that skips its recording loses operator nodes.
        await recordAction(
          ctx.conversationId,
          toolName,
          describeAction(toolName, stepArgs, ctx.snapshotTargets),
          ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
          true, // the whole plan was approved up front
          ok,
          describeDetail(toolName, stepArgs, ctx.snapshotTargets),
          hydrateRecordArgs(ctx, stepArgs),
        )
        outcomes.push({
          step: i + 1,
          tool: toolName,
          ok,
          ...(parsed.error ? { error: parsed.error } : {}),
        })
        if (!ok && step.optional !== true) {
          return JSON.stringify({
            ok: false,
            stoppedAt: i + 1,
            error: `run_plan stopped at step ${i + 1} (${toolName}): ${
              parsed.error ?? 'the step did not succeed'
            }`,
            outcomes,
          })
        }
      }
      return JSON.stringify({ ok: true, stepsRun: outcomes.length, outcomes })
    }

    case 'open_url': {
      throwIfAborted()
      const url = String(args.url ?? '').trim()
      // Navigates the active tab — inside the panel window for scoped turns —
      // and the isInjectablePage check does not apply here: any tab (even
      // chrome://newtab) can be navigated to an http(s) URL.
      await updateActiveTabUrl(url, ctx.scope)
      ctx.navigated = true
      ctx.snapshotTargets = undefined // old page's refs are gone
      await settleAfterNavigation(2000, signal, ctx.scope)
      const payload: Record<string, unknown> = { ok: true, navigated: true, url }
      // The fresh page's observation lets the very next step act on it (often
      // within the same run_plan), without a separate snapshot round.
      const observed = await captureObservation(ctx, args.withScreenshot === true, signal)
      if (observed) payload.observation = observed
      return JSON.stringify(payload)
    }

    case 'tab_new': {
      throwIfAborted()
      const url = typeof args.url === 'string' ? args.url.trim() : undefined
      const tab = await newTab(url || undefined, ctx.scope)
      ctx.navigated = true
      ctx.lastUrl = tab.url
      ctx.snapshotTargets = undefined // old page's refs are gone
      await settleAfterNavigation(undefined, signal, ctx.scope)
      const payload: Record<string, unknown> = { ok: true, tabId: tab.id, url: tab.url }
      const observed = await captureObservation(ctx, args.withScreenshot === true, signal)
      if (observed) payload.observation = observed
      return JSON.stringify(payload)
    }

    case 'tab_switch': {
      throwIfAborted()
      const index = Number(args.index ?? 0)
      const tab = await switchTab(index, ctx.scope)
      ctx.navigated = true
      ctx.lastUrl = tab.url
      ctx.snapshotTargets = undefined // different page entirely
      return JSON.stringify({ ok: true, index, tabId: tab.id, title: tab.title, url: tab.url })
    }

    case 'tab_close': {
      throwIfAborted()
      await closeActiveTab(ctx.scope)
      return JSON.stringify({ ok: true })
    }

    case 'pin_tab': {
      throwIfAborted()
      const tabId = typeof args.tabId === 'number' ? args.tabId : undefined
      const tab = await pinActiveTab(tabId, ctx.scope)
      return JSON.stringify({
        ok: true,
        pinnedTabId: tab.id,
        url: tab.url,
        title: tab.title,
        note: 'Subsequent actions target this tab until unpin_tab or a 5-minute expiry.',
      })
    }

    case 'unpin_tab': {
      throwIfAborted()
      unpinTab()
      return JSON.stringify({ ok: true, note: 'Pin removed; actions target the active tab again.' })
    }

    case 'get_secret': {
      throwIfAborted()
      // Fills directly; the model never receives the secret value. Supports
      // both the legacy id-only form and an optional field name (e.g. fill
      // just the "username" or "password" field of a multi-field entry).
      const id = String(args.id ?? '')
      const fieldName = typeof args.field === 'string' ? args.field : undefined
      const resolved = resolveTargetFrom(ctx, args)
      if ('error' in resolved) return JSON.stringify({ error: resolved.error })
      const target = resolved.target
      const secret = await resolveSecret(id)
      if (!secret) return JSON.stringify({ error: 'Saved credential not found.' })
      const field = fieldName
        ? findField(secret, fieldName)
        : (findField(secret, 'password') ?? entryFields(secret)[0])
      if (!field)
        return JSON.stringify({
          error: `No "${fieldName ?? 'password'}" field in this credential.`,
        })
      const result = await execOnActiveTab(
        {
          action: 'fill',
          target,
          value: field.value,
        },
        signal,
        undefined,
        ctx.scope,
      )
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

    case 'create_skill': {
      const name = String(args.name ?? '').trim()
      const description = String(args.description ?? '').trim()
      const instructions = String(args.instructions ?? '').trim()
      const autoMatch = args.autoMatch === undefined ? true : args.autoMatch !== false
      if (!name || !instructions) {
        return JSON.stringify({ ok: false, error: 'Both "name" and "instructions" are required.' })
      }

      // Updating an existing skill (by id or by a same-name match) keeps its
      // identity and creation time; otherwise this is a brand-new skill.
      const existing = await listSkills()
      const match =
        existing.find((entry) => entry.id === args.id) ??
        existing.find((entry) => entry.name.trim().toLowerCase() === name.toLowerCase())
      const base: Skill = {
        id: match?.id ?? newId(),
        name,
        description,
        instructions,
        autoMatch,
        createdAt: match?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }

      const problems = validateSkill(base, existing)
      if (problems.length > 0) {
        const reasons = problems
          .map((p) =>
            p.code === 'nameTaken'
              ? 'name is already in use by another skill'
              : `"${p.field}" is required`,
          )
          .join('; ')
        return JSON.stringify({ ok: false, error: `Skill not saved — ${reasons}.` })
      }

      await saveSkill(base)
      return JSON.stringify({
        ok: true,
        skill: base.name,
        id: base.id,
        updated: !!match,
        note: `Skill "${base.name}" is saved and available. It will be offered to the agent when ${base.description} matches.`,
      })
    }

    case 'list_scheduled_tasks': {
      const all = await listTasks()
      const tasks = all
        .filter((task) => task.enabled)
        .map((task) => ({
          name: task.name,
          kind: task.kind,
          schedule: describeSchedule(task.schedule, 'en'),
          ...(task.kind === 'agent-prompt' && task.prompt
            ? { prompt: task.prompt.slice(0, 500) }
            : {}),
          ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}),
          ...(task.lastStatus ? { lastStatus: task.lastStatus } : {}),
          ...(task.lastSummary ? { lastSummary: task.lastSummary } : {}),
          ...(task.notifyFeishu ? { notifyFeishu: true } : {}),
        }))
      return JSON.stringify({ count: tasks.length, tasks })
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

/**
 * Waits until the page's DOM stops changing before an auto-observation is
 * captured: polls a cheap `page_signature` kernel op and returns once two
 * consecutive probes (150ms apart) agree. Without this, a click whose handler
 * fetches/renders asynchronously (SPA updates — no tab navigation, so
 * settleAfterNavigation never runs) would be observed in its PRE-action state
 * and mislead the model. Budget-capped: continuously animating pages settle
 * at the timeout instead of looping forever.
 */
async function waitForPageStable(
  signal?: AbortSignal,
  timeout = 1500,
  scope?: ScopeWindow,
): Promise<void> {
  // Preferred verdict: the CDP monitor reports network idle (no in-flight
  // request for a while) — that sees "the fetch is still running" which a DOM
  // probe structurally cannot. Falls back to DOM-signature polling when the
  // monitor is not attached (no debugger access).
  const tab = await resolveAutomationTab(undefined, scope).catch(() => undefined)
  if (tab && typeof tab.id === 'number') {
    const idle = await waitForNetworkIdle(tab.id, 400, timeout).catch(() => undefined)
    if (idle === true) return
  }
  const deadline = Date.now() + timeout
  let prev: string | null = null
  while (Date.now() < deadline) {
    if (signal?.aborted) return
    const result = await execOnActiveTab(
      { action: 'page_signature' },
      signal,
      undefined,
      scope,
    ).catch(() => undefined)
    const sig = result && typeof result.data === 'string' ? result.data : null
    // Unscriptable or racing a navigation: stability will never come.
    if (sig === null) return
    if (sig === prev) return
    prev = sig
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * Auto-observation attached to a successful action result: a fresh lean
 * snapshot (and optionally a screenshot) taken after the page has settled.
 * The next round can act on the observation's refs directly instead of
 * spending a whole model round on snapshot_page; retireOldPageReads drops
 * older observations from the transcript, so history stays flat.
 *
 * `withScreenshot` embeds a base64 PNG of the visible page for multimodal
 * remote clients (the local-agent bridge / Claude Code). The side-panel agent
 * strips that flag — its transcript is text-only, so a base64 payload there
 * would be pure token waste.
 */
async function captureObservation(
  ctx: ToolContext,
  withScreenshot: boolean,
  signal?: AbortSignal,
): Promise<{ snapshot: unknown; screenshot?: string; consoleErrors?: string[] } | undefined> {
  try {
    // Let the action's async page updates (fetch → render) land first, or the
    // observation shows the pre-action page.
    await waitForPageStable(signal, undefined, ctx.scope)
    const snapshot = await snapshotActiveTab(1500, 40, ctx.scope)
    // The observation's refs become the model's next action handles.
    rememberSnapshotTargets(ctx, snapshot)
    const observed: { snapshot: unknown; screenshot?: string; consoleErrors?: string[] } = {
      snapshot: summarizeSnapshot(snapshot),
    }
    // Fresh console errors since the previous observation — the single most
    // useful signal when the model is debugging a page after an action.
    const tab = await resolveAutomationTab(undefined, ctx.scope).catch(() => undefined)
    const tabId = typeof tab?.id === 'number' ? tab.id : undefined
    if (tabId !== undefined) {
      const errors = drainConsoleEntries(tabId)
      if (errors.length > 0) {
        observed.consoleErrors = errors.map((entry) => `[${entry.level}] ${entry.text}`)
      }
    }
    if (withScreenshot) {
      if (signal?.aborted) return observed
      // Best-effort: the observation screenshot must never fail the action
      // that produced it, so the capture reason is deliberately dropped here.
      const shot = await captureVisiblePage(ctx.scope, { format: 'jpeg', quality: 60 }).catch(
        () => null,
      )
      if (shot?.ok) observed.screenshot = shot.dataUrl
    }
    return observed
  } catch {
    // Best-effort: a navigation racing the capture or an unscriptable page
    // must never turn a successful action into a failure.
    return undefined
  }
}

async function afterAction(
  result: OpResult,
  ctx: ToolContext,
  extra: Record<string, unknown> = {},
  opts?: { withScreenshot?: boolean; signal?: AbortSignal },
): Promise<string> {
  if (result.mayNavigate) {
    ctx.navigated = true
    await settleAfterNavigation(undefined, undefined, ctx.scope)
  }
  if (result.ok) {
    const payload: Record<string, unknown> = {
      ok: true,
      ...(result.note ? { note: result.note } : {}),
      ...(result.mayNavigate
        ? { navigated: true }
        : // Save a model round trip: with the page unchanged the refs the
          // model already holds stay valid, so it should act on them instead
          // of re-snapshotting before the next step.
          {
            pageUnchanged: true,
            note: "The page did not navigate; the previous snapshot's refs are still valid.",
          }),
      ...extra,
    }
    // After a navigation the fresh observation shows the new page; when the
    // page is unchanged it confirms the state. Either way the next round can
    // act on it without a separate snapshot call.
    const observed = await captureObservation(ctx, opts?.withScreenshot === true, opts?.signal)
    if (observed) payload.observation = observed
    return JSON.stringify(payload)
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
    if (parsed.error) {
      // Idempotent prefix: some error strings already carry the tool name
      // from an inner layer — never render "screenshot: screenshot: …".
      const prefix = `${name}: `
      let raw = parsed.error
      while (raw.startsWith(prefix)) raw = raw.slice(prefix.length)
      return `${prefix}${raw}`.slice(0, 200)
    }
    if (name === 'read_current_page') {
      const page = JSON.parse(result) as { title?: string; text?: string }
      return `Read "${page.title ?? 'page'}" (${page.text?.length ?? 0} chars)`
    }
    if (name === 'use_skill') {
      const loaded = JSON.parse(result) as { skill?: string; error?: string }
      return loaded.error ? loaded.error : `Using skill "${loaded.skill ?? 'unknown'}"`
    }
    if (name === 'list_scheduled_tasks') {
      const parsed = JSON.parse(result) as { count?: number }
      return `Listed scheduled tasks (${parsed.count ?? 0})`
    }
    if (name === 'save_local') {
      const parsed = JSON.parse(result) as { savedPath?: string; mode?: string; error?: string }
      if (parsed.error) return `save_local: ${parsed.error}`.slice(0, 200)
      return `Saved to ${parsed.savedPath ?? 'file'}${parsed.mode === 'auto' ? ' (auto)' : ''}`
    }
    if (name === 'recognize_image') {
      const parsed = JSON.parse(result) as { text?: string; error?: string }
      if (parsed.error) return `recognize_image: ${parsed.error}`.slice(0, 200)
      return `Recognized: "${parsed.text ?? ''}"`
    }
    if (name === 'screenshot') {
      const parsed = JSON.parse(result) as { text?: string; error?: string }
      if (parsed.error) return `screenshot: ${parsed.error}`.slice(0, 200)
      return `Inspected screenshot: "${(parsed.text ?? '').slice(0, 120)}"`
    }
    if (name === 'create_skill') {
      const parsed = JSON.parse(result) as { skill?: string; updated?: boolean; error?: string }
      if (parsed.error) return `create_skill: ${parsed.error}`.slice(0, 200)
      return `${parsed.updated ? 'Updated' : 'Created'} skill "${parsed.skill ?? 'unknown'}"`
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
  // 「保存工作流」模式：走逐条执行的老路径。run_plan 的内部步骤在
  // executeTool 里跑、不经过 runOneToolCall 的审计,撤掉它保证每个动作
  // 单独入历史,「从历史生成工作流」的算子节点才完整。
  if ((await getSettings()).saveWorkflowFromChat === true) {
    disabled.add('run_plan')
  }
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
    // Panel-scoped turns validate their window once here; a window that died
    // between the message and this point (or an editor-popup sender) degrades
    // to undefined = legacy global behaviour.
    ...(deps.scopeWindowId !== undefined
      ? { scope: await normalScopeFromWindowId(deps.scopeWindowId) }
      : {}),
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
            // Push the running turn total as soon as this request reports it,
            // so the panel's token bar updates per model request instead of
            // only when the whole turn finishes. Cumulative snapshot — the
            // panel adds the delta against the last value it applied.
            deps.send({ type: 'usage', usage: { ...totalUsage } })
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
      try {
        await runOneToolCall(call, history, deps, ctx)
      } catch (toolError) {
        // A termination mid-tool must unwind the turn cleanly rather than
        // surface as a generic failure in the transcript.
        if ((toolError as Error)?.name === 'AbortError') {
          deps.send({ type: 'status', text: 'Cancelled.' })
          return totalUsage.totalTokens > 0 ? totalUsage : null
        }
        throw toolError
      }
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

  // The side-panel transcript is text-only, so a base64 screenshot would be
  // pure token waste here. That flag exists for multimodal remote clients
  // (local-agent bridge); the panel loop always strips it.
  delete args.withScreenshot

  // The model acts with a short `ref`, but the audit history is downstream
  // source data: "workflow from history" (workflowFromHistory →
  // selectorFromArgs) builds replayable selectors from `args.target`. Persist
  // the resolved durable target so a ref-only call does not lose the locator.
  args = hydrateRecordArgs(ctx, args)

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
    await recordAction(
      deps.conversationId,
      name,
      describeAction(name, args, ctx.snapshotTargets),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      false,
      false,
      describeDetail(name, args, ctx.snapshotTargets),
      args,
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
        await recordAction(
          deps.conversationId,
          name,
          describeAction(name, args, ctx.snapshotTargets),
          ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
          false,
          false,
          describeDetail(name, args, ctx.snapshotTargets),
          args,
        )
        return
      }
    }
  }

  try {
    const output = await executeTool(name, args, ctx, deps.signal)
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
    await recordAction(
      deps.conversationId,
      name,
      describeAction(name, args, ctx.snapshotTargets),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      approved,
      ok,
      describeDetail(name, args, ctx.snapshotTargets, output),
      args,
    )
  } catch (error) {
    // A termination must unwind the whole turn, not be recorded as a failed
    // tool step — otherwise the loop keeps going after the user cancelled.
    if ((error as Error)?.name === 'AbortError') throw error
    const message =
      error instanceof DriverError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
    pushResult(JSON.stringify({ error: message }))
    deps.send({ type: 'tool.result', name, summary: `Failed: ${message}` })
    await recordAction(
      deps.conversationId,
      name,
      describeAction(name, args, ctx.snapshotTargets),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      approved,
      false,
      [...describeDetail(name, args, ctx.snapshotTargets), `Error: ${message}`],
      args,
    )
  }
}

/**
 * Executes a single browser tool directly, without the model loop or the
 * per-action approval card.
 *
 * Used by the local-agent bridge (agent-api.ts): the caller has already checked
 * that the sender is a trusted localhost page and that the user enabled the
 * bridge, so per-tool confirmation is intentionally skipped — an unattended
 * agent cannot click a side-panel button. Tools the user disabled in settings
 * are still refused as a second line of defense.
 */
export async function runToolStandalone(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!TOOLS.some((tool) => tool.function.name === name)) {
    return { ok: false, error: `Unknown tool: ${name}` }
  }
  const settings = await getSettings()
  const disabled = new Set(settings.disabledTools)
  if (disabled.has(name)) {
    return { ok: false, error: `The "${name}" tool is disabled in settings.` }
  }
  // The bridge has no sender window of its own: while a panel window exists it
  // is the monitored/controlled one, so scope to it; with no panel open the
  // legacy global resolution applies.
  const scope = await currentPanelScope()
  const ctx: ToolContext = {
    conversationId: `external:${newId()}`,
    navigated: false,
    disabled,
    ...(scope ? { scope } : {}),
  }
  const output = await executeTool(name, args, ctx)
  try {
    return JSON.parse(output)
  } catch {
    return { ok: true, output }
  }
}
