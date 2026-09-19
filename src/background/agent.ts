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
import {
  isOperatorTool,
  buildWorkflowAuthorTools,
  buildWorkflowCategoryTools,
  buildWorkflowCoreTools,
  buildWorkflowEscapeTools,
  OPERATOR_NAMES,
  WORKFLOW_AUTHOR_OPERATOR_NAMES,
  WORKFLOW_CATEGORY_TOOL_GROUPS,
  WORKFLOW_ESCAPE_OPERATOR_NAMES,
} from '../lib/workflow/operator-tools'
import {
  ADVERTISABLE_OPERATOR_CATEGORIES,
  CORE_OPERATOR_TOOL_NAMES,
  OPERATOR_CATEGORY_HINTS,
  OPERATOR_CATEGORY_TOOL_NAMES,
  categoryOfOperatorGroup,
  isAdvertisableOperatorCategory,
} from '../lib/workflow/operator-categories'
import type { BlockCategory } from '../lib/workflow/blocks/types'
import { composeWorkflowFromDraft } from './operator-tool-handler'
import { runOperatorToolWithExecution } from './operator-tool-run'
import type { AgentServerMessage, TurnTokenUsage } from '../lib/messages'
import { notifySkillsChanged } from '../lib/messages'
import { renderAgentCatalogue, renderSubAgentSection, renderSupervisorGuide } from '../lib/agents'
import {
  renderModeSkillPrompt,
  renderSkillCatalogue,
  renderSkillPrompt,
  validateSkill,
} from '../lib/skills'
import { BUILT_IN_SUPERVISOR_ID, getBuiltinI18nKeys } from '../lib/builtin-agents'
import type { Messages } from '../lib/i18n'
import { effectiveLocale, messagesFor } from '../lib/i18n'
import { runDelegateTool, type DelegationRuntime } from './orchestrator'
import {
  addHistory,
  findSkillByName,
  getActiveProvider,
  listAgents,
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
import { fetchImageAsDataUrl } from '../lib/fetch-image'
import { isSamePage } from '../lib/pages'
import { DEFAULT_SYSTEM_PROMPT } from '../lib/system-prompt'
import { buildToolErrorContext, recentFailedAttempts } from '../lib/tool-error'
import {
  type Agent,
  type AgentMode,
  entryFields,
  findField,
  type PasswordEntry,
  type ProviderProfile,
  type Skill,
  type UserProfile,
} from '../lib/types'
import { locatorHintOf } from '../lib/ops'
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
import { normalScopeFromWindowId, type ScopeWindow } from './automation-scope'
import { resolveUnattendedScope } from './window-policy'
import {
  drainConsoleEntries,
  ensureTabMonitor,
  getConsoleEntries,
  getRecentRequests,
  summarizePerfNetwork,
  waitForNetworkIdle,
} from './cdp-monitor'
import { activeTab, readActivePage } from './page'
import { captureVisiblePage } from './capture'
import { captureElementRobust } from './element-capture'
import { listTasks, createDraft, getTask, saveTask, coerceMaxToolRounds } from '../lib/task-store'
import { describeSchedule, nextRunAt, normalizeSchedule } from '../lib/schedule'
import type { Schedule, ScheduledTask } from '../lib/scheduler-types'
import { getWorkflow, listWorkflows } from '../lib/workflow/storage'
import { scheduleTask } from './scheduler'
import { BUILT_IN_SKILLS } from '../lib/builtin-skills'

/**
 * Tools that change something and therefore always need approval.
 *
 * Mostly page actions, but the set is really "has a persistent side effect":
 * `create_skill` writes to the skill store and `create_scheduled_task` arms a
 * recurring unattended job, so both ask in semi mode like any click does. They
 * never touch the page, which is why neither appears in WORKFLOW_WITHHELD_TOOLS.
 *
 * `ask_user` is deliberately absent from both this set and `READ_TOOLS`: asking
 * IS the interaction, so it must never be held behind the approval card, and
 * `modeAutoApproves` / `needsConfirmation` then auto-approve it in every mode.
 * It is dispatched by a dedicated branch in `runOneToolCall`, never by
 * `executeTool`.
 */
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
  'create_scheduled_task',
  'run_plan',
])

const READ_TOOLS = new Set([
  'read_current_page',
  'snapshot_page',
  'list_tabs',
  'list_network_requests',
])

/**
 * Does this tool touch the page? Covers both the raw page tools and every
 * workflow operator, because an operator really clicks, types and navigates.
 *
 * Operators are only ADVERTISED in workflow mode, but that is not a gate: the
 * advertised set is recomputed from the mode the turn STARTED with, so a turn
 * that began in workflow generation and was switched to read-only mid-run
 * would otherwise keep driving the page. Every mode gate must therefore go
 * through this predicate rather than checking `ACTION_TOOLS` directly.
 */
export function isPageAction(name: string): boolean {
  return ACTION_TOOLS.has(name) || isOperatorTool(name)
}

/** The built-in plan skill (`lib/builtin-skills`) that arms the plan gate. */
export const PLAN_SKILL_NAME = 'plan'

/**
 * Tools blocked by the plan gate despite being in ACTION_TOOLS: they look like
 * actions only because they reach the image model, but they change nothing —
 * and visual inspection of the page IS part of the plan skill's research
 * phase ("查看页面，分析页面结构").
 */
const PLAN_PHASE_READS: ReadonlySet<string> = new Set(['screenshot', 'recognize_image'])

/** Mutable, per-turn state of the plan-first gate (see {@link planGateBlocks}). */
export interface PlanGate {
  /** True while the plan skill governs this turn (pinned or use_skill-loaded). */
  armed: boolean
  /** Flips true only by an approved `present_plan` call; reset each turn. */
  approved: boolean
  /** The approved plan declared a multi-workflow split (releases compose_workflow). */
  split: boolean
}

/**
 * PURE plan-gate predicate: does the gate currently refuse `name`?
 *
 * The gate exists because prompting cannot guarantee plan-first: in full-auto
 * (and workflow generation) every action tool is pre-approved, so a model that
 * skips the plan would just act. When the plan skill governs the turn and its
 * plan has not been approved yet, every page action — including every
 * `wf_op_*` operator, which would otherwise record research detours into the
 * draft — is refused with a pointer to `present_plan`. Reads (and the two
 * read-like image tools) stay available so the research phase can work.
 *
 * Exported and side-effect free so the contract can be unit-tested without a
 * browser driver. Callers pass `ctx.planGate`; absence means the gate is off.
 */
export function planGateBlocks(gate: PlanGate | undefined, name: string): boolean {
  if (!gate || !gate.armed || gate.approved) return false
  return isPageAction(name) && !PLAN_PHASE_READS.has(name)
}

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
   * A skill the MODE mounts for its duration, as opposed to one the user
   * pinned. Workflow generation auto-activates the built-in `workflow-generator`
   * skill so the full operator guide (action→operator mapping, data rules,
   * keep/drop criteria) is in context from the first round — the condensed
   * English paragraph below carries only the mode MECHANICS, not the domain
   * knowledge. Resolved from the skill store by the caller, so user edits to
   * the skill take effect on the next turn.
   */
  modeSkill?: Skill | undefined
  /**
   * User-edited base prompt. When a non-empty string it replaces the default
   * operating rules; an empty/undefined value means use the default.
   */
  basePrompt?: string | undefined
  /**
   * When set, turns this turn into a SUPERVISOR turn: the agent's own
   * instructions are appended after the base rules, followed by the terse
   * delegation guide and the specialist catalogue.
   */
  supervisor?: { agent: Agent; catalogue: string } | undefined
  /**
   * When set, this turn runs as a delegated specialist: the base operating
   * rules still hold (approvals, secrets), then the specialist's instructions
   * and linked skills replace the skill catalogue.
   */
  subAgent?: { agent: Agent; skills: readonly Skill[] } | undefined
  /**
   * Resolved i18n dictionary for the user's locale. When provided, built-in
   * agent instructions and specialist catalogue hints are rendered in the
   * user's language instead of the stored English defaults.
   */
  messages?: Messages | undefined
}): string {
  // Chat mode is pure conversation: no operating rules, no skill catalogue, no
  // mode instructions. Just a short identity line so the model stays in role.
  if (options.mode === 'chat') {
    return 'You are Browser Copilot, a browser-extension assistant in the side panel. Answer the user conversationally in their language. You cannot read or act on the page in this mode; keep it concise.'
  }

  // Delegated specialists always run on the project's base rules even when the
  // user replaced the interactive prompt: the approval/secret guarantees must
  // not silently disappear for a sub-agent.
  const override = options.subAgent ? undefined : options.basePrompt?.trim()
  const base = override ? override : SYSTEM_PROMPT
  const parts = [base]

  // A delegated specialist gets its identity block, then the mode rules; it
  // never sees the interactive skill catalogue or the supervisor section.
  if (options.subAgent) {
    parts.push(
      renderSubAgentSection(options.subAgent.agent, options.subAgent.skills, options.messages),
    )
  } else {
    // The skill catalogue only matters when no skill is pinned: an active
    // skill's full instructions are injected below instead.
    if (!options.activeSkill && options.catalogue && options.catalogue.length > 0) {
      const catalogue = renderSkillCatalogue(options.catalogue)
      if (catalogue) parts.push(catalogue)
    }

    // Supervisor identity + delegation rules + the specialist catalogue. The
    // guide is deliberately terse because this ships on every interactive
    // turn; it goes BEFORE the mode paragraph and the active skill.
    if (options.supervisor) {
      const { agent, catalogue } = options.supervisor
      const keys = getBuiltinI18nKeys(agent.id)
      const instructions =
        options.messages && keys.instructions
          ? (options.messages[keys.instructions] as string)
          : agent.instructions
      parts.push(`## ACTING AS SUPERVISOR AGENT — ${agent.name}\n\n${instructions}`)
      parts.push(renderSupervisorGuide())
      if (catalogue) parts.push(catalogue)
    }
  }

  // State the operating mode so the model does not promise (or attempt) an
  // action the gate will refuse.
  if (options.mode === 'readonly') {
    parts.push(
      'OPERATING MODE: READ-ONLY. You may read pages and list tabs but MUST NOT click, type, navigate, switch tabs, fill forms, or use secrets — if asked, explain that read-only mode is on and how to switch to Semi or Full auto.',
    )
  } else if (options.mode === 'full') {
    parts.push(
      'OPERATING MODE: FULL AUTO. Actions are pre-approved — do not ask for confirmation; batch multiple tool calls per response and take a fresh snapshot after navigations. Read errors back and stop if something looks dangerous. Use ask_user SPARINGLY: only when a decision is truly blocking and hard to reverse (spends money, deletes or sends data); otherwise pick the best option yourself and state the assumption.',
    )
  } else if (options.mode === 'workflow') {
    parts.push(
      [
        'OPERATING MODE: WORKFLOW GENERATE / 工作流生成.',
        'Every step is a WORKFLOW OPERATOR call (`wf_op_*`). Each successful call really operates the page AND records the node, so the draft you build IS the workflow — the native action tools (`click` / `fill` / `open_url` / …) are not offered here because they would record nothing.',
        `ALWAYS AVAILABLE / 常驻算子: ${CORE_OPERATOR_TOOL_NAMES.join(', ')} (navigate, click, fill-or-read a field, read text). Everything else needs its category: call \`use_operators\` with the categories this task needs — it REPLACES the current selection, so name everything you still need. Calling an undeclared operator also works: it activates that category and asks you to call it again, which costs a round.`,
        'Target elements with `ref` from `snapshot_page` — the recorded node stores a durable selector; do not hand-write CSS.',
        'EVERY STEP IS REPLAYED: no exploratory detours — going back, retrying a different element after a miss, or re-opening a view all become nodes.',
        'SCRIPTS ARE A LAST RESORT / 代码节点是最后手段: `run_javascript` is NOT advertised. Exhaust the operators first; only when none can express the step, call `load_tools({groups:["operators_escape"]})` — every call must carry a `justification` naming what you tried and why each operator fails, without it the call is refused.',
        'Operators are pre-approved: do not ask, and batch independent calls. Use `wf_op_wait-connections` when a step needs the page to settle — it really waits, never "just in case".',
        'When the task is done, END YOUR TURN. The panel shows a review card listing the recorded steps — do NOT call `compose_workflow` or any save tool.',
        // The mode paragraph carries the MECHANICS only. The domain knowledge —
        // which operator maps to which conversational action, the data rules,
        // the keep/drop criteria — lives in the mounted skill below, once, so
        // the two never drift apart (see `modeSkill` above).
        ...(options.modeSkill
          ? []
          : [
              'READS RECORD NOTHING BY THEMSELVES. `read_current_page` / `snapshot_page` are for YOUR understanding only; to make a read part of the workflow call `wf_op_read-page` (whole page) or `wf_op_get-text` (one element, or every match with `multiple`).',
              'Business data is never a literal: page content must be read by a step, never pasted in from what you saw; small user knobs become workflow inputs (`inputName`).',
              'COLLECTING A LIST / 采集列表: `wf_op_get-text` with `multiple:true` + `saveData:true` + `dataColumn:"<name>"` appends every match to the data table — the only thing `wf_op_export-data` writes.',
              'SAVING TO DISK / 保存到本地: use `wf_op_save-local` (or `wf_op_export-data`) — it writes to the configured download folder and reports success or failure.',
            ]),
      ].join(' '),
    )
    // The mode-mounted skill goes after the mode paragraph. When it is absent
    // (tests, or a skill store without the builtin) the domain rules ride in
    // the paragraph above instead, so the mode is never left mechanics-only.
    if (options.modeSkill) {
      parts.push(
        renderModeSkillPrompt(options.modeSkill, 'this turn runs in workflow-generation mode'),
      )
    }
  } else {
    parts.push(
      'OPERATING MODE: SEMI-AUTO (default). Every page-changing action is shown to the user for one-shot approval; be precise so the summary is clear.',
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
  description: 'Locator copied verbatim from a snapshot element. Prefer `ref`.',
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
  description: 'Attach a base64 page screenshot to the result (remote multimodal clients only).',
} as const

/** Preferred element handle: a short ref from the latest snapshot/observation. */
const REF_ARG = {
  type: 'string',
  description:
    'Element ref (e.g. "e12") from the latest snapshot/observation. Preferred over target.',
} as const

const SPEC_SCHEMA = {
  type: 'object',
  description:
    'One locator strategy copied verbatim from a snapshot element; a `role` spec needs the accessible name in `value`.',
  properties: {
    how: { type: 'string', enum: ['testid', 'id', 'name', 'role', 'text', 'css'] },
    value: { type: 'string' },
    role: { type: 'string' },
    tag: { type: 'string' },
    nth: { type: 'number' },
  },
  required: ['how', 'value'],
  additionalProperties: true,
} as const

/**
 * On-demand tool groups, loaded conversation-wide by the `load_tools` tool.
 * Group names appear in the load_tools schema and in system-prompt rule 14.
 * Every tool NOT listed here (plus `load_tools` itself) is core and always
 * advertised in non-chat modes.
 */
export const TOOL_GROUPS: Record<string, readonly string[]> = {
  tabs: ['list_tabs', 'tab_new', 'tab_switch', 'tab_close', 'pin_tab', 'unpin_tab'],
  data: ['save_local', 'get_my_profile', 'list_secrets', 'get_secret'],
  skills: ['use_skill', 'create_skill'],
  ops: [
    'list_network_requests',
    'list_console_messages',
    'list_scheduled_tasks',
    'create_scheduled_task',
  ],
  // Multi-agent delegation. On demand like the others so it stays out of the
  // first-round payload; never loaded for a sub-agent (recursion guard).
  delegate: ['delegate_to_agent'],
  // Workflow generation. Legacy "everything at once" group, kept so a
  // conversation that already loaded `operators` keeps working. It is a
  // superset of `operators_author` + `operators_escape`, so `advertiseTools`
  // treats it as "both on-demand tiers loaded".
  operators: ['compose_workflow', ...OPERATOR_NAMES],
  // The whole categorized operator set in one group: the "give me everything"
  // escape hatch. It is the union of the per-category groups below, so the two
  // tiers overlap on purpose and `TOOL_GROUP_BY_NAME` is built explicitly (see
  // there) rather than by walking this object.
  operators_author: [...WORKFLOW_AUTHOR_OPERATOR_NAMES],
  // The escape hatch, on its own group so it can never arrive as a side effect
  // of loading the authoring tail. `wf_op_javascript-code` lives here and
  // nowhere else: a generated workflow must stay maintainable by someone who
  // does not read code, so the block is reachable only after a deliberate load
  // and only with a justification (see `operator-tool-run`).
  operators_escape: [...WORKFLOW_ESCAPE_OPERATOR_NAMES],
  // One group per advertisable catalog category (`op_interaction`,
  // `op_browser`, …). This is the workflow-mode dispatch mechanism: the model
  // declares the categories it needs through `use_operators` and only those
  // schemas are advertised, which is what keeps the per-round payload from
  // carrying all 54 operator schemas.
  ...WORKFLOW_CATEGORY_TOOL_GROUPS,
}

/**
 * Tool → the on-demand group that owns it.
 *
 * Built explicitly instead of by walking `TOOL_GROUPS`, because several groups
 * legitimately overlap: `operators_author` is the union of every category, the
 * legacy `operators` group is a superset of both on-demand tiers, and the core
 * four operators are also members of `op_interaction`. Object iteration order
 * would then silently decide which group a stray `wf_op_*` call "belongs" to —
 * and activating the wrong one either dumps 53 schemas into the next round or
 * leaves the model unable to recover.
 *
 * Precedence, deliberately:
 *   1. the broad operator groups, as the fallback;
 *   2. the category groups — narrowest useful unit, so they win;
 *   3. the escape hatch, which wins outright (`wf_op_javascript-code` must
 *      never become reachable by activating a category);
 *   4. everything else.
 */
const TOOL_GROUP_BY_NAME: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  const broad = ['operators', 'operators_author']
  const categoryGroups = Object.keys(WORKFLOW_CATEGORY_TOOL_GROUPS)
  for (const group of broad) {
    for (const name of TOOL_GROUPS[group] ?? []) map.set(name, group)
  }
  for (const group of categoryGroups) {
    for (const name of TOOL_GROUPS[group] ?? []) map.set(name, group)
  }
  for (const name of TOOL_GROUPS['operators_escape'] ?? []) map.set(name, 'operators_escape')
  for (const [group, names] of Object.entries(TOOL_GROUPS)) {
    if (broad.includes(group) || categoryGroups.includes(group)) continue
    if (group === 'operators_escape') continue
    for (const name of names) map.set(name, group)
  }
  return map
})()

export const TOOLS: WireTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_current_page',
      description:
        'Read the active tab: title, URL, selection, visible text. For content questions that need no element action. Requires approval.',
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
        'Read the active page and list its interactive elements (buttons, links, inputs) with refs. Call before clicking/filling. Requires approval.',
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
        'Read TEXT inside an image (e.g. a CAPTCHA) with an image model. Pass `image` (data URL / http(s) URL), a CSS `selector`, or nothing for the visible page. Reuse an earlier result for the same unchanged image. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          image: {
            type: 'string',
            description: 'The image as a data URL or http(s) URL, attached as-is.',
          },
          selector: {
            type: 'string',
            description: 'CSS selector of the <img>/element to capture; omit `image` to use it.',
          },
          prompt: {
            type: 'string',
            description: 'Optional extraction instruction, e.g. "the 4-digit code top-left".',
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
        'Visually inspect an element or the page with an image model (layout, colors, rendered state). For text inside images use recognize_image. Pass `target` or nothing for the whole page. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'CSS selector; omit for the whole page.',
          },
          prompt: {
            type: 'string',
            description: 'Optional instruction for what to look for.',
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
        'Type text into an input/textarea/contenteditable. Preferred for ALL text entry (handles React inputs and shadow roots). Checkboxes: set_checkbox; dropdowns: select_option.',
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
              'True when you composed the text yourself; false for literal user data (email, URL, name, number).',
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
        'Scroll the page or an element: {mode:"by", y:600} to read on, "bottom"/"top" for the ends, {mode:"into_view"} with a ref/target to reveal an element.',
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
      description: 'Navigate the active tab to a URL.',
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
      description: 'Open a new tab (optionally navigating) and switch to it.',
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
      description: 'Switch to another tab in this window by index (0-based, from list_tabs).',
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
        'Pin a tab (tabId from list_tabs, or omit for the current target) so subsequent actions skip tab_switch. Expires after 5 minutes.',
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
        'Run JavaScript in the active page as a function body; `return` a JSON-serializable value. For computation/DOM work no other tool covers. NEVER fill form fields with it (use fill/select_option/set_checkbox; controlled inputs discard JS-set values) — script only after fill failed. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript statements; `return` a value. Do not fill fields with it.',
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
        'List recent network requests of the active tab (URL, method, status, failures). Use to diagnose failed/slow requests after an action. Read-only; requires approval.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_console_messages',
      description:
        'List recent console messages of the active tab (errors+warnings by default; level:"all" for everything). Only captures output after the monitor attached. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          level: {
            type: 'string',
            enum: ['errors', 'all'],
            description: "'errors' (default) = error+warning; 'all' = every captured entry.",
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_profile',
      description:
        'Get saved personal profile fields (name, email, phone, address, ...) for form filling. Read-only; no approval. Never includes passwords.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_secrets',
      description:
        'List saved credential bundles (label, URL, field NAMES like username/password — never values). Use to find the id and field before get_secret. Read-only.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_secret',
      description:
        "Fill a field from a saved credential bundle by id (`field` defaults to 'password'). The value is filled directly, never shown to you. Requires approval.",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'From list_secrets.' },
          field: { type: 'string', description: "Field to fill (defaults to 'password')." },
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
        'Create or update a saved reusable skill (written to the skills store, available immediately). Use when the user asks to make/record a reusable procedure or an authoring flow asks to save. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Unique short name used to trigger it later, e.g. "captcha-helper".',
          },
          description: {
            type: 'string',
            description:
              'Auto-match trigger: 1-2 sentences covering BOTH what it does and when to use it — the body loads only after this matches.',
          },
          instructions: {
            type: 'string',
            description:
              'Markdown body for an agent with no conversation memory: imperative tool-exact steps plus edge cases; one worked example over explanation.',
          },
          autoMatch: {
            type: 'boolean',
            description: 'Auto-select when it matches, without pinning (default true).',
          },
          id: {
            type: 'string',
            description: 'Existing skill id to update; usually omit.',
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
        'List enabled scheduled tasks (id, name, schedule, kind, prompt, latest status). Read-only.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_scheduled_task',
      description:
        'Create (or, with an existing id, update) a scheduled task that runs unattended on a clock. ' +
        'kind "agent-prompt" runs `prompt` through the agent in full auto; kind "workflow" runs a saved workflow by id. ' +
        'Use when the user asks to do something regularly / every day / on weekdays / on a schedule ("每天早上…", "每周一…", "每隔30分钟…"). ' +
        'Requires approval / 需要用户确认。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short display name shown in the Tasks tab, e.g. "Daily PR digest".',
          },
          schedule: {
            type: 'object',
            description:
              'When it runs (local time). One shape per kind; pick the kind that matches the request.',
            properties: {
              kind: {
                type: 'string',
                enum: ['daily', 'weekdays', 'weekly', 'interval', 'none'],
                description:
                  '"daily" = every day at hour:minute; "weekdays" = Mon-Fri at hour:minute; "weekly" = the listed days at hour:minute; "interval" = every N minutes; "none" = manual only (no alarm).',
              },
              hour: { type: 'number', description: '0-23, for daily/weekdays/weekly.' },
              minute: { type: 'number', description: '0-59, for daily/weekdays/weekly.' },
              days: {
                type: 'array',
                items: { type: 'number' },
                description: 'Weekdays for kind "weekly", 0=Sunday … 6=Saturday.',
              },
              minutes: { type: 'number', description: 'Interval length in minutes (1-1440).' },
            },
            required: ['kind'],
          },
          kind: {
            type: 'string',
            enum: ['agent-prompt', 'workflow'],
            description: 'What runs: default "agent-prompt" executes `prompt` via the agent.',
          },
          prompt: {
            type: 'string',
            description:
              'Required for kind "agent-prompt": the self-contained instruction for each unattended run (the agent runs full-auto, cannot ask questions).',
          },
          workflowId: {
            type: 'string',
            description: 'Required for kind "workflow": the saved workflow id to execute.',
          },
          id: {
            type: 'string',
            description:
              'Existing task id (from list_scheduled_tasks or a previous create) to update; omit to create a new task.',
          },
          enabled: { type: 'boolean', description: 'Arm the schedule (default true).' },
          notifyFeishu: {
            type: 'boolean',
            description: 'Also deliver each run result to Feishu (default false).',
          },
          maxToolRounds: {
            type: 'number',
            description: 'agent-prompt only: tool-round budget per run (default 50).',
          },
        },
        required: ['name', 'schedule'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_local',
      description:
        'Save text content as a local file (download folder / save dialog). Use for download/export/save requests; never script downloads with run_javascript. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The text to save.' },
          filename: {
            type: 'string',
            description: 'Filename with extension; defaults to download.txt.',
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
        'Execute up to 16 already-decided steps ({tool, args, optional?}) in order in ONE round; stops at the first failure unless the step is optional. Only when the steps are unambiguous from the current snapshot — one-at-a-time when a later step depends on an earlier result. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered steps, at most 16.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', description: 'A tool name other than run_plan.' },
                args: { type: 'object', description: "That tool's arguments, same schema." },
                optional: { type: 'boolean', description: 'Skip on failure (default false).' },
              },
              required: ['tool'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_tools',
      description:
        'Load a group of tools that are hidden by default to keep requests small. Groups: "tabs" (list/open/switch/close/pin tabs), "data" (save files, saved profile, saved passwords), "skills" (use/create saved skills), "ops" (network requests, console messages, scheduled tasks — list and create them), "delegate" (delegate a sub-task to a specialist agent). Call this before using any tool that is not advertised in the current request; loaded groups stay available for the rest of the conversation.',
      parameters: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            items: { type: 'string', enum: Object.keys(TOOL_GROUPS) },
            description: 'Tool groups to load.',
          },
        },
        required: ['groups'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate_to_agent',
      description:
        'Delegate ONE scoped sub-task to a specialist agent, which runs an isolated, approval-gated tool loop and returns a compact (≤1200 char) report plus artifact references. Use ONLY for a genuinely big task per the delegation rules; small tasks are refused. The specialist gets only what you put in "context", not this conversation. Independent calls can run in parallel in one response.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description:
              'Exact specialist name from the specialist catalogue (e.g. "search-expert").',
          },
          task: {
            type: 'string',
            description:
              'Self-contained instruction: the goal, constraints, and what "done" looks like. Required.',
          },
          context: {
            type: 'string',
            description:
              'Only the specific upstream outputs this sub-task needs. Never paste the whole transcript.',
          },
          expects: {
            type: 'string',
            description:
              'The expected deliverable shape (e.g. "a 10-row markdown table with URLs").',
          },
        },
        required: ['agent', 'task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user to decide when the request is ambiguous or a required choice is missing. "question" must first EXPLAIN the situation and what exactly needs deciding; then "options" carries 3-6 candidate approaches, each with one-line "pros" and "cons", the RECOMMENDED one FIRST (the UI pre-selects it and the user confirms or types their own). NEVER call without options.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: "Explain the situation and the decision needed, in the user's language.",
          },
          options: {
            type: 'array',
            minItems: 3,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'The suggestion, one line.' },
                pros: { type: 'string', description: 'Its main advantage.' },
                cons: { type: 'string', description: 'Its main drawback or risk.' },
              },
              required: ['label', 'pros', 'cons'],
            },
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_plan',
      description:
        'Submit the execution plan for user approval BEFORE acting (plan-first). Call it after researching the pages — reads stay allowed — and before any page action; while the plan is unapproved, page actions and workflow operators are refused. On rejection, revise per the feedback and resubmit.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'One-line task goal, in the user language.' },
          steps: {
            type: 'array',
            description: 'Ordered plan steps, 2-20, one user-visible line each.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Tool/operator + target + expected result.' },
                detail: { type: 'string', description: 'Optional note (input value, dependency).' },
              },
              required: ['title'],
            },
          },
          risks: {
            type: 'string',
            description:
              'Optional: login, CAPTCHA, irreversible steps, values the user must supply.',
          },
          split: {
            type: 'string',
            description:
              'Workflow mode: when the plan splits into several workflows — how many, their names/responsibilities, how the orchestrator chains them. Omit for one workflow.',
          },
        },
        required: ['goal', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compose_workflow',
      description:
        'Workflow-generation mode only. Close the conversation draft built from prior wf_op_* calls into a Workflow and (by default) save it to the workflow editor. Returns the saved workflow id. After this call the draft is cleared. / 工作流生成模式专用：把当前会话累积的 wf_op_* 节点收尾成一个工作流（默认保存），返回保存后的工作流 id，调用后草稿被清空。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional workflow display name.' },
          description: { type: 'string', description: 'Optional human description.' },
          save: {
            type: 'boolean',
            description:
              'Default true. When false, only return the composed JSON without persisting.',
          },
        },
      },
    },
  },
]

export type ConfirmFn = (name: string, argsPreview: string) => Promise<boolean>

/** One structured suggestion on an `ask_user` card. */
export interface AskUserOption {
  label: string
  pros: string
  cons: string
}

/** Payload of the `ask_user` tool: what the model wants to know. */
export interface AskUserRequest {
  question: string
  /** 3-6 candidate approaches with pros/cons; index 0 is the recommendation. */
  options: AskUserOption[]
}

/** What the user came back with: an answer, or a dismissal. */
export interface AskUserAnswer {
  answer: string
  cancelled: boolean
}

/**
 * Channel for the `ask_user` tool — the question/answer sibling of
 * {@link ConfirmFn}. Implemented by the panel port (background/index.ts) so
 * the request reaches the UI and the user's reply resolves the promise.
 * Unattended runs omit it; the tool then reports the absence instead of
 * stalling. Sub-agents inherit it via `...parent`, like `confirm`.
 */
export type AskUserFn = (request: AskUserRequest) => Promise<AskUserAnswer>

/** One user-visible line of a submitted plan. */
export interface PlanStep {
  title: string
  detail?: string
}

/** Payload of the `present_plan` tool: the plan awaiting approval. */
export interface PlanRequest {
  goal: string
  steps: PlanStep[]
  risks?: string
  split?: string
}

/** What the user decided: approval, or rejection with revision feedback. */
export interface PlanDecision {
  approved: boolean
  feedback?: string
}

/**
 * Channel for the `present_plan` tool — the plan-approval sibling of
 * {@link AskUserFn}. Implemented by the panel port (background/index.ts):
 * the request renders as a plan card and the user's decision resolves the
 * promise. Unattended runs omit it; the tool then auto-approves (the model
 * states its plan in the answer and proceeds) instead of stalling.
 * Sub-agents inherit it via `...parent`, like `confirm`.
 */
export type PlanDecisionFn = (request: PlanRequest) => Promise<PlanDecision>

/**
 * Conversation-scoped record of which on-demand tool groups the model has
 * loaded via `load_tools`. In-memory only: losing it after a worker restart
 * costs one extra load_tools round, never a wrong behaviour. LRU-capped so
 * abandoned conversations cannot grow it without bound.
 */
const loadedToolGroupStore = new Map<string, Set<string>>()
const LOADED_GROUP_STORE_CAP = 64

function storeLoadedGroups(conversationId: string, groups: readonly string[]): Set<string> {
  const existing = loadedToolGroupStore.get(conversationId) ?? new Set<string>()
  for (const group of groups) {
    if (TOOL_GROUPS[group]) existing.add(group)
  }
  // Re-insert so Map iteration order doubles as LRU order.
  loadedToolGroupStore.delete(conversationId)
  loadedToolGroupStore.set(conversationId, existing)
  while (loadedToolGroupStore.size > LOADED_GROUP_STORE_CAP) {
    const oldest = loadedToolGroupStore.keys().next().value
    if (oldest === undefined) break
    loadedToolGroupStore.delete(oldest)
  }
  return existing
}

/**
 * Conversation-scoped record of which operator CATEGORIES are active.
 *
 * Kept apart from {@link loadedToolGroupStore} because the two have opposite
 * semantics and mixing them would break the mode in a subtle way:
 *
 *   - `load_tools` ACCUMULATES — the model asks for a group once and keeps it.
 *   - `use_operators` REPLACES — the model names what the current step needs,
 *     and the previous step's categories stop costing tokens.
 *
 * A category activated by a stray operator call (see the auto-load path) is
 * merged into the current set rather than replacing it: the model is clearly
 * mid-task, and silently dropping the categories it was already using would be
 * worse than a slightly larger payload.
 */
const activeOperatorCategoryStore = new Map<string, Set<BlockCategory>>()

function storeActiveOperatorCategories(
  conversationId: string,
  categories: Iterable<BlockCategory>,
): Set<BlockCategory> {
  const next = new Set(categories)
  // Re-insert so Map iteration order doubles as LRU order.
  activeOperatorCategoryStore.delete(conversationId)
  activeOperatorCategoryStore.set(conversationId, next)
  while (activeOperatorCategoryStore.size > LOADED_GROUP_STORE_CAP) {
    const oldest = activeOperatorCategoryStore.keys().next().value
    if (oldest === undefined) break
    activeOperatorCategoryStore.delete(oldest)
  }
  return next
}

/** The categories currently active for a conversation (empty when none). */
export function getActiveOperatorCategories(conversationId: string): Set<BlockCategory> {
  return activeOperatorCategoryStore.get(conversationId) ?? new Set<BlockCategory>()
}

/**
 * Conversation-scoped record of conversations where the PLAN skill became
 * active through `use_skill` (a pinned plan skill is resolved per turn from
 * `deps.skillId` instead, so it needs no store). Once armed, every later turn
 * of the conversation starts with the plan gate on — the skill's own note says
 * "follow for the rest of this conversation", so the gate must span turns too.
 * In-memory only, LRU-capped like the group store.
 */
const planGateArmedStore = new Map<string, true>()
const PLAN_GATE_STORE_CAP = 64

/** Marks the conversation plan-gated (called when the plan skill is loaded). */
export function armPlanGate(conversationId: string): void {
  planGateArmedStore.delete(conversationId)
  planGateArmedStore.set(conversationId, true)
  while (planGateArmedStore.size > PLAN_GATE_STORE_CAP) {
    const oldest = planGateArmedStore.keys().next().value
    if (oldest === undefined) break
    planGateArmedStore.delete(oldest)
  }
}

/** Whether the conversation was plan-gated earlier (via a use_skill load). */
export function isPlanGateArmed(conversationId: string): boolean {
  return planGateArmedStore.get(conversationId) === true
}

export interface ToolAdvertiseOptions {
  mode: AgentMode
  disabled?: ReadonlySet<string>
  /** On-demand groups already loaded for this conversation via `load_tools`. */
  loadedGroups?: ReadonlySet<string>
  /**
   * Operator categories currently ACTIVE for this conversation (see
   * `use_operators`). Workflow mode advertises the core four operators plus
   * exactly these categories' schemas. Unlike `loadedGroups` this set is
   * replaced, not accumulated, so switching categories really does drop the
   * previous ones from the payload.
   */
  activeOperatorCategories?: ReadonlySet<BlockCategory>
  /**
   * Specialist sub-agent tool boundary. When set, only tools in this set may be
   * advertised (load_tools is always included so grouped tools can be
   * preloaded). Undefined = inherit the full tool set (custom agents,
   * supervisor, ordinary turns).
   */
  allowTools?: ReadonlySet<string>
  /**
   * True when the plan-first flow approved a plan that declares a multi-
   * workflow split. Workflow mode then also advertises `compose_workflow`, so
   * the model can save each approved sub-workflow segment as it finishes
   * recording it (each compose clears the draft for the next segment). Without
   * an approved split the tool stays hidden — composition is exactly what the
   * end-of-turn save card is for in the single-workflow flow.
   */
  planSplitApproved?: boolean
  /**
   * Tools withheld from the advertised set REGARDLESS of mode or groups —
   * broader than `disabled` (user choice): this is the caller declaring the
   * tool cannot work in this run. Used to hide `ask_user` from unattended
   * runs (scheduled tasks, Feishu, workflow AI-agent blocks), where there is
   * no human to answer and the schema would only waste a round on a refusal.
   */
  hidden?: ReadonlySet<string>
}

/**
 * Tools workflow generation never advertises: everything that CHANGES the page.
 *
 * A workflow is only ever built from operator calls, because an operator call
 * is the only thing that records a node. Leaving the native action tools
 * advertised is how the mode stopped producing workflows — the model used the
 * shorter, more familiar names, the draft stayed empty, and the save card had
 * nothing to show. Each entry here has an operator equivalent:
 *
 *   click → wf_op_event-click · fill/select_option/set_checkbox → wf_op_forms
 *   press_key → wf_op_press-key · scroll → wf_op_element-scroll
 *   wait_for → wf_op_wait-connections · open_url/tab_* → wf_op_new-tab/switch-tab/…
 *   save_local → wf_op_save-local
 *
 * `run_javascript` is deliberately NOT listed: it is withheld by its own branch
 * below, which re-admits it once the `operators_escape` group is loaded.
 */
export const WORKFLOW_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
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
  'save_local',
])

/** Last definition wins, so a caller can override a base tool deliberately. */
function dedupeToolsByName(tools: readonly WireTool[]): WireTool[] {
  const byName = new Map<string, WireTool>()
  for (const tool of tools) byName.set(tool.function.name, tool)
  return [...byName.values()]
}

/**
 * The always-advertised operator core, as a set.
 *
 * Needed by the auto-activate path: the core four are also members of
 * `op_interaction`, so without this exemption a call to `wf_op_forms` while no
 * category is active would be intercepted with "call it again" — for a tool
 * that was advertised all along.
 */
const CORE_OPERATOR_TOOL_SET: ReadonlySet<string> = new Set(CORE_OPERATOR_TOOL_NAMES)

/**
 * The tool schemas advertised for one conversation round: the core set, the
 * `load_tools` loader, and every tool of an already-loaded group — minus the
 * user's disabled tools, the specialist's whitelist boundary, and (in
 * read-only mode) every page-changing action. Chat mode advertises nothing at
 * all.
 */
export function advertiseTools({
  mode,
  disabled = new Set<string>(),
  loadedGroups = new Set<string>(),
  activeOperatorCategories,
  allowTools,
  planSplitApproved,
  hidden,
}: ToolAdvertiseOptions): WireTool[] {
  if (mode === 'chat') return []
  if (mode === 'workflow') {
    // Workflow generation is OPERATOR-DIRECT: the model performs the task with
    // `wf_op_*` operator tools, each call really operates the page and appends
    // a node to the conversation's draft, and the draft is what the save card
    // persists.
    //
    // The native action tools (`click` / `fill` / `open_url` / …) are therefore
    // WITHHELD. That is not a style preference: they record nothing, so a model
    // that reaches for the shorter, more familiar action names completes the
    // task and leaves an empty draft — the mode then has no workflow to offer,
    // which is exactly how the save card disappeared. Everything they can do is
    // expressible with an operator (see `WORKFLOW_WITHHELD_TOOLS`).
    //
    // Reads stay: `snapshot_page` is what `ref` targeting depends on, and
    // `read_current_page` / `screenshot` / `recognize_image` observe without
    // changing the page. `list_tabs` stays for the same reason — a task really
    // can span tabs, and the tab *actions* are operators (`wf_op_switch-tab`,
    // `wf_op_close-tab`, …) while only the listing is a read.
    //
    // Cost control is the other half. The 54 operator schemas are ~32.4k chars
    // and used to be re-sent every round. Now only `CORE_OPERATOR_TOOL_NAMES`
    // (four schemas, ~3.5k) is unconditional and the rest arrives per category,
    // declared through `use_operators` — which REPLACES the active set, so a
    // model that moves from scraping to data plumbing does not keep paying for
    // both.
    const authorLoaded = loadedGroups.has('operators_author') || loadedGroups.has('operators')
    // The legacy `operators` group really does carry the escape hatch, so
    // honour that rather than advertising a group whose tool list lies.
    const escapeLoaded = loadedGroups.has('operators_escape') || loadedGroups.has('operators')
    const core = TOOLS.filter((tool) => {
      const name = tool.function.name
      if (WORKFLOW_WITHHELD_TOOLS.has(name)) return false
      // `ask_user` is FORBIDDEN in workflow generation: the mode's deliverable
      // is the draft → save-card flow, which must not stall on questions, and
      // the workflow's replay runs unattended anyway. (The dispatch layer
      // refuses a stray call too — see the ask_user branch in runOneToolCall.)
      if (name === 'ask_user') return false
      // `compose_workflow` is in the `operators` group, so a conversation that
      // loaded the legacy group would otherwise be handed a tool that composes
      // a *second*, competing graph behind the panel's back. It is re-admitted
      // only by an approved plan split: the plan skill then saves each
      // sub-workflow segment mid-turn (see `planSplitApproved`).
      if (name === 'compose_workflow') return planSplitApproved === true
      // `load_tools` is replaced below by the workflow-specific copy, whose
      // group menu only lists what this mode can widen with.
      if (name === 'load_tools') return false
      // `run_javascript` is core in every other mode; here it is the escape
      // hatch, so it arrives only after a deliberate load and only with the
      // justification the gate demands (see `runOperatorToolWithExecution`).
      if (name === RUN_JAVASCRIPT_TOOL) return escapeLoaded
      // The tab listing is a read and is always available; the tab actions are
      // operators. Without this the whole `tabs` group would have to be loaded
      // to see what is open — and loading it would hand back `tab_new` too.
      if (name === 'list_tabs') return true
      const group = TOOL_GROUP_BY_NAME.get(name)
      if (group && !loadedGroups.has(group)) return false
      return true
    })
    const operatorTools = [
      ...buildWorkflowCoreTools(),
      ...buildWorkflowCategoryTools(activeOperatorCategories ?? []),
      ...(authorLoaded ? buildWorkflowAuthorTools() : []),
      ...(escapeLoaded ? buildWorkflowEscapeTools() : []),
    ]
    // Dedupe by name: the core four are also members of `op_interaction`, so
    // activating that category naively would advertise `wf_op_forms` twice and
    // the provider rejects a tool list with repeated names.
    return dedupeToolsByName([
      ...core,
      workflowLoadTools(),
      useOperatorsTool(),
      ...operatorTools,
    ]).filter((tool) => {
      if (disabled.has(tool.function.name)) return false
      if (allowTools && !allowTools.has(tool.function.name)) return false
      if (hidden?.has(tool.function.name)) return false
      return true
    })
  }
  return TOOLS.map((tool) => {
    // Workflow-composition tools (`wf_op_*` / `compose_workflow`) are
    // exclusive to workflow mode. In every other mode hide both operator
    // groups from load_tools' group menu so the model never discovers them
    // (the dispatch layer also refuses them; this only trims what's
    // disclosed).
    if (tool.function.name === 'load_tools') {
      const params = tool.function.parameters as { properties?: Record<string, unknown> }
      const properties = (params.properties ?? {}) as Record<string, unknown>
      const groups = properties.groups as Record<string, unknown> | undefined
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters: {
            ...params,
            properties: {
              ...properties,
              groups: {
                ...(groups ?? {}),
                items: {
                  type: 'string',
                  enum: Object.keys(TOOL_GROUPS).filter((g) => !isWorkflowOnlyGroup(g)),
                },
              },
            },
          },
        },
      } as WireTool
    }
    return tool
  }).filter((tool) => {
    const name = tool.function.name
    if (disabled.has(name)) return false
    if (allowTools && !allowTools.has(name)) return false
    if (hidden?.has(name)) return false
    if (mode === 'readonly' && ACTION_TOOLS.has(name)) return false
    const group = TOOL_GROUP_BY_NAME.get(name)
    if (group && !loadedGroups.has(group)) return false
    return true
  })
}

/**
 * The escape hatch's native-tool name. Named once because two places must
 * agree on it: `advertiseTools` withholds it from workflow generation until
 * the group is loaded, and the tool loop applies the justification gate to it.
 */
export const RUN_JAVASCRIPT_TOOL = 'run_javascript'

/**
 * Groups that exist only for workflow generation: their names must never
 * appear in the ordinary `load_tools` menu, because outside this mode the
 * dispatch layer refuses them anyway and disclosing them only teaches the
 * model to ask for tools it cannot have.
 */
function isWorkflowOnlyGroup(group: string): boolean {
  return (
    group === 'operators' ||
    group === 'operators_author' ||
    group === 'operators_escape' ||
    categoryOfOperatorGroup(group) !== undefined
  )
}

/** Name of the workflow-mode category selector. Named once; dispatch and the auto-activate path share it. */
export const USE_OPERATORS_TOOL = 'use_operators'

/**
 * `use_operators`: declare which operator categories this task needs.
 *
 * This is the whole token argument of operator-direct mode. All 54 operator
 * schemas are ~32.4k chars and would otherwise be re-sent on every round of a
 * 20-round budget; here the model names the one or two categories a step
 * actually needs and only those arrive.
 *
 * The semantics are REPLACE, not accumulate, and the description says so: a
 * model moving from scraping to data plumbing must be able to drop
 * `interaction`, otherwise the set only ever grows back to "everything" and the
 * saving disappears. The four core operators (`CORE_OPERATOR_TOOL_NAMES`) are
 * always present, so a model that has not declared anything can still navigate,
 * click, fill and read.
 *
 * Calling it for a category that is already active is a no-op, and the result
 * echoes what changed so the model can see the effect without another round.
 */
function useOperatorsTool(): WireTool {
  const menu = ADVERTISABLE_OPERATOR_CATEGORIES.map(
    (category) => `"${category}" (${OPERATOR_CATEGORY_HINTS[category]})`,
  ).join('; ')
  return {
    type: 'function',
    function: {
      name: USE_OPERATORS_TOOL,
      description:
        'Choose which groups of workflow step tools are available for the rest of this task. ' +
        'REPLACES the current selection (it does not add to it), so name everything you still need. ' +
        `Categories: ${menu}. ` +
        `Always available without declaring anything: ${CORE_OPERATOR_TOOL_NAMES.join(', ')}. ` +
        'Declare a category before using its tools; calling one that is not active also activates its category, but costs a round.',
      parameters: {
        type: 'object',
        properties: {
          categories: {
            type: 'array',
            items: { type: 'string', enum: [...ADVERTISABLE_OPERATOR_CATEGORIES] },
            description:
              'The categories to make available. Pass [] to fall back to the core four only.',
          },
        },
        required: ['categories'],
      },
    },
  } as WireTool
}

/**
 * `load_tools`, re-skinned for workflow mode: same tool, but the group menu
 * and the description only mention what this mode can actually widen with.
 */
function workflowLoadTools(): WireTool {
  const base = TOOLS.find((tool) => tool.function.name === 'load_tools')!
  const params = base.function.parameters as { properties?: Record<string, unknown> }
  const properties = (params.properties ?? {}) as Record<string, unknown>
  const groups = properties.groups as Record<string, unknown> | undefined
  return {
    ...base,
    function: {
      ...base.function,
      description:
        'Load the whole workflow step catalog at once, for the rare step no category covers. Group "operators_author": every `wf_op_*` block tool — loops, sub-workflows, data plumbing, disk writes, notifications. Prefer `use_operators` with the categories you need: this loads all 53 schemas and keeps them for the rest of the conversation. Group "operators_escape": `run_javascript` — raw JavaScript, LAST RESORT only, and every call must carry a `justification`. The remaining groups (`skills`, `data`, `ops`, `delegate`) are the ordinary non-page tools, available exactly as in the other modes.',
      parameters: {
        ...params,
        properties: {
          ...properties,
          groups: {
            ...(groups ?? {}),
            // The tab group is deliberately absent: the tab LISTING is
            // advertised outright and the tab ACTIONS are operators, so loading
            // it would only hand back native tools that record nothing.
            //
            // Everything else that is not a page action stays loadable, so
            // workflow generation really does have every capability of the
            // other modes — it just has to express page changes as operators.
            // (`save_local` lives in `data` but is withheld anyway; the
            // operator `wf_op_save-local` is the recording equivalent.)
            items: {
              type: 'string',
              enum: ['skills', 'data', 'ops', 'delegate', 'operators_author', 'operators_escape'],
            },
          },
        },
      },
    },
  } as WireTool
}

export interface AgentDeps {
  send: (message: AgentServerMessage) => void
  confirm: ConfirmFn
  /**
   * Interactive clarifying-question channel for the `ask_user` tool. Present
   * only when a human can actually answer (panel port turns, including their
   * delegated sub-agents); unattended runs omit it and the tool reports that
   * gracefully instead of blocking the loop forever.
   */
  askUser?: AskUserFn
  /**
   * Interactive plan-approval channel for the `present_plan` tool. Present
   * only when a human can decide (panel port turns, including their delegated
   * sub-agents); unattended runs omit it and the tool auto-approves so the
   * turn states its plan and proceeds instead of blocking forever.
   */
  planDecision?: PlanDecisionFn
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
   * Overrides the provider/model for this turn (e.g. the AI-takeover runner
   * pointing at `settings.takeoverModel`). Returns undefined (or is omitted)
   * to fall back to the active chat provider.
   */
  getProvider?: () => Promise<ProviderProfile | undefined>
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
  /**
   * Enables the supervisor/delegation machinery for this turn (system-prompt
   * section + the on-demand "delegate" tool group + delegation budgets).
   * Panel chat turns set this; unattended runs never do, so scheduled and
   * Feishu prompts cannot fan out into sub-agents.
   */
  enableDelegation?: boolean
  /**
   * Set when this turn IS a delegated specialist run. The turn then uses the
   * agent's identity prompt and tool whitelist and can never delegate again.
   */
  subAgent?: { agent: Agent; seq: number }
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

/**
 * Default element budget for a snapshot sent to the model. Kept lean because a
 * snapshot is re-sent on every later round.
 */
const SNAPSHOT_ELEMENT_LIMIT = 80

/**
 * Hard ceiling on elements returned even when the caller asks for more. A
 * takeover agent may raise `maxElements` (long pages, target below the fold);
 * without this the old 80-element cap silently discarded the extra elements
 * the agent explicitly requested.
 */
const SNAPSHOT_ELEMENT_HARD_CAP = 250

/** Redacts a snapshot to a model-friendly size: targets + labels, no giant text. */
function summarizeSnapshot(
  snapshot: {
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
  },
  elementLimit = SNAPSHOT_ELEMENT_LIMIT,
): unknown {
  const limit = Math.max(1, Math.min(SNAPSHOT_ELEMENT_HARD_CAP, Math.floor(elementLimit) || 1))
  const elements = snapshot.elements.slice(0, limit).map((el) => {
    // Compact locator hint (#id / [data-testid] / [name]): the ONLY stable
    // handle the model can copy into a block's `selector` param when it
    // proposes a fix. Few tokens, only for genuinely stable specs.
    const loc = locatorHintOf(el.target)
    return {
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
      ...(loc ? { loc } : {}),
    }
  })
  // Keep the text but cap it hard: a snapshot is re-sent on every later round
  // and the model's locators come from the elements, not the prose.
  const text =
    snapshot.text.length > 3000 ? `${snapshot.text.slice(0, 3000)}…[truncated]` : snapshot.text
  return {
    url: snapshot.url,
    title: snapshot.title,
    text,
    truncated: snapshot.truncated,
    elementsTruncated: snapshot.elementsTruncated || snapshot.elements.length > limit,
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

function compactSnapshot(
  snapshot: Parameters<typeof summarizeSnapshot>[0],
  elementLimit = SNAPSHOT_ELEMENT_LIMIT,
): unknown {
  const summarized = summarizeSnapshot(snapshot, elementLimit) as {
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

export interface ToolContext {
  conversationId: string
  /**
   * On-demand tool groups loaded so far in this conversation (live view — the
   * `load_tools` tool mutates it mid-turn). Undefined = none loaded.
   */
  loadedGroups?: ReadonlySet<string>
  /**
   * Present only on supervisor-enabled turns: the agent catalogue plus the
   * per-turn delegation budget and same-target retry map. The
   * `delegate_to_agent` tool refuses to run without it.
   */
  delegation?: DelegationRuntime
  /** Present only when the turn is itself a delegated specialist run. */
  subAgent?: { agent: Agent; seq: number }
  /** Specialist tool whitelist boundary; undefined = inherit all tools. */
  toolAllowSet?: ReadonlySet<string>
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
   *
   * `type` rides along so workflow generation can tell a password field from
   * an ordinary input before typing into it (see `lib/workflow/secret-guard`).
   */
  snapshotTargets?: Map<string, { target: Target; name: string; type?: string }>
  /**
   * Set by the operator branch of `executeTool` for the call in flight: the
   * action name and RESOLVED args the history should record instead of the
   * raw `wf_op_*` call. Cleared before every call so it can never leak from
   * one step to the next.
   */
  operatorAudit?: { action: string; args: Record<string, unknown> }
  /**
   * Panel-window scope for this turn: every tab resolution, tab op and page
   * read stays inside this window. Undefined for unattended runs (legacy
   * global behaviour). Validated once at turn start via
   * {@link normalScopeFromWindowId}.
   */
  scope?: ScopeWindow
  /**
   * Plan-first gate state for this turn (see {@link planGateBlocks}). Present
   * only on interactive panel turns — unattended runs never arm it, and a
   * sub-agent never arms it (it executes an already-approved sub-task).
   * `armed` comes from the pinned plan skill, a previous `use_skill` load of
   * it, or a mid-turn load; `approved` flips on an approved `present_plan`
   * call and resets at the start of every turn (one user message = one task =
   * one plan).
   */
  planGate?: PlanGate
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
      const reason = ctx.navigated
        ? 'The page navigated since your last snapshot, so every old ref is stale.'
        : "Refs come from the latest snapshot_page or an action's observation."
      return {
        error: `Unknown ref "${ref}". ${reason} Take a fresh snapshot (snapshot_page) and use the new refs — never reuse an old ref.`,
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
  snapshot: {
    elements: Array<{ ref?: unknown; name?: unknown; target?: unknown; type?: unknown }>
  },
): void {
  const map = new Map<string, { target: Target; name: string; type?: string }>()
  for (const el of snapshot.elements) {
    const target = asTarget(el.target)
    if (target && typeof el.ref === 'string') {
      map.set(el.ref, {
        target,
        name: typeof el.name === 'string' ? el.name : '',
        ...(typeof el.type === 'string' && el.type ? { type: el.type } : {}),
      })
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
    case 'delegate_to_agent':
      lines.push(`Agent: ${String(args.agent ?? '')}`)
      if (typeof args.task === 'string') {
        const task = args.task
        lines.push(`Task: ${task.length > 120 ? `${task.slice(0, 120)}…` : task}`)
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
    case 'present_plan': {
      const steps = Array.isArray(args.steps) ? args.steps : []
      const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
      return `Submit the ${steps.length}-step execution plan${goal ? ` — ${goal.slice(0, 120)}` : ''}`
    }
    case 'read_current_page':
      return 'Read the text of the current page'
    case 'snapshot_page':
      return 'Read the current page and list its buttons, links, and fields'
    case 'list_console_messages':
      return 'Read browser console messages'
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
    case 'create_scheduled_task': {
      const when = parseScheduleArg(args.schedule).schedule
      const whenText = when ? describeSchedule(when, 'en') : 'on a schedule'
      const updating = typeof args.id === 'string' && args.id.trim() !== ''
      return `${updating ? 'Update' : 'Create'} scheduled task "${String(args.name ?? '')}" (${whenText})`
    }
    case 'delegate_to_agent':
      return `Delegate a sub-task to agent "${String(args.agent ?? '')}"`
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
 * Validates and normalizes the `schedule` argument of `create_scheduled_task`.
 *
 * `normalizeSchedule` is the storage-side clamp: it silently coerces garbage
 * into a runnable schedule. That is right for hand-edited records but wrong for
 * a model call — a typo would silently become "daily 09:00" — so the kind and
 * the shape are checked EXPLICITLY here first and only well-formed schedules
 * are passed on for clamping.
 */
function parseScheduleArg(raw: unknown): { schedule?: Schedule; error?: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: '"schedule" is required: an object with a "kind" field.' }
  }
  const value = raw as Record<string, unknown>
  const num = (input: unknown): number | null => {
    const n = typeof input === 'number' ? input : Number(input)
    return Number.isFinite(n) ? n : null
  }
  const kind = value['kind']
  if (kind === 'none') return { schedule: { kind: 'none' } }
  if (kind === 'interval') {
    const minutes = num(value['minutes'])
    if (minutes === null || minutes <= 0) {
      return { error: 'schedule.kind "interval" needs a positive "minutes" (1-1440).' }
    }
    return { schedule: { kind: 'interval', minutes } }
  }
  if (kind === 'daily' || kind === 'weekdays') {
    const hour = num(value['hour'])
    if (hour === null) return { error: `schedule.kind "${kind}" needs a numeric "hour" (0-23).` }
    const minute = num(value['minute'])
    if (value['minute'] !== undefined && minute === null) {
      return { error: 'schedule."minute" must be a number (0-59).' }
    }
    return { schedule: { kind, hour, minute: minute ?? 0 } }
  }
  if (kind === 'weekly') {
    const hour = num(value['hour'])
    if (hour === null) return { error: 'schedule.kind "weekly" needs a numeric "hour" (0-23).' }
    const minute = num(value['minute'])
    if (value['minute'] !== undefined && minute === null) {
      return { error: 'schedule."minute" must be a number (0-59).' }
    }
    const rawDays = Array.isArray(value['days']) ? value['days'].map((d) => Number(d)) : []
    // Filter to the valid range FIRST, then reject: a list of out-of-range
    // values must not silently collapse into "daily" (normalizeSchedule's
    // fallback) when the model clearly meant specific days.
    const days = rawDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    if (days.length === 0) {
      return {
        error:
          'schedule.kind "weekly" needs a non-empty "days" array of 0-6 (0=Sunday … 6=Saturday); use kind "daily" for every day.',
      }
    }
    return { schedule: { kind: 'weekly', days, hour, minute: minute ?? 0 } }
  }
  return {
    error:
      'schedule.kind must be one of: "daily", "weekdays", "weekly", "interval", "none". ' +
      'Examples: {"kind":"weekdays","hour":9} · {"kind":"weekly","days":[1],"hour":10,"minute":30} · {"kind":"interval","minutes":30}.',
  }
}

/**
 * The `create_scheduled_task` handler: validates the arguments, persists the
 * task and (re)arms its alarm. Creating and updating share this path because a
 * model asked to "change my task to 8am" has no other write surface — it can
 * only pass the `id` it got from `list_scheduled_tasks` or a previous create.
 *
 * Exported for tests; not part of the public agent API.
 */
export async function createScheduledTaskFromArgs(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? '').trim()
  if (!name) return JSON.stringify({ ok: false, error: '"name" is required.' })

  const parsedSchedule = parseScheduleArg(args.schedule)
  if (parsedSchedule.error || !parsedSchedule.schedule) {
    return JSON.stringify({ ok: false, error: parsedSchedule.error })
  }
  const schedule = normalizeSchedule(parsedSchedule.schedule)

  const kind = args.kind === 'workflow' ? 'workflow' : 'agent-prompt'
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  const workflowId = typeof args.workflowId === 'string' ? args.workflowId.trim() : ''
  if (kind === 'agent-prompt' && !prompt) {
    return JSON.stringify({
      ok: false,
      error:
        'kind "agent-prompt" requires "prompt": the self-contained instruction for each unattended run.',
    })
  }
  if (kind === 'workflow' && !workflowId) {
    return JSON.stringify({
      ok: false,
      error:
        'kind "workflow" requires "workflowId". Call list_scheduled_tasks or ask the user for it.',
    })
  }

  // A scheduled workflow must point at a workflow that exists: a typo would
  // otherwise silently produce a task that fails on every future run.
  if (kind === 'workflow') {
    const workflow = await getWorkflow(workflowId)
    if (!workflow) {
      const available = (await listWorkflows())
        .slice(0, 5)
        .map((wf) => ({ id: wf.id, name: wf.name }))
      return JSON.stringify({
        ok: false,
        error: `No workflow with id "${workflowId}".`,
        ...(available.length > 0 ? { available } : {}),
      })
    }
  }

  const enabled = args.enabled === undefined ? true : args.enabled !== false
  const notifyFeishu = args.notifyFeishu === true
  const maxToolRounds = typeof args.maxToolRounds === 'number' ? args.maxToolRounds : undefined

  const base: Partial<ScheduledTask> = {
    name,
    schedule,
    kind,
    prompt: kind === 'agent-prompt' ? prompt : undefined,
    workflowId: kind === 'workflow' ? workflowId : undefined,
    enabled,
    notifyFeishu,
    ...(maxToolRounds !== undefined ? { maxToolRounds: coerceMaxToolRounds(maxToolRounds) } : {}),
  }

  // Update path: an explicit id must exist. Create path: refuse a silent
  // duplicate — same-name tasks are only distinguishable in the UI, so point
  // the model at the existing id instead.
  const existing = args.id !== undefined ? await getTask(String(args.id)) : undefined
  if (args.id !== undefined && !existing) {
    return JSON.stringify({ ok: false, error: `No scheduled task with id "${String(args.id)}".` })
  }
  let match = existing
  if (!match) {
    const all = await listTasks()
    match = all.find((task) => task.name.trim().toLowerCase() === name.toLowerCase())
    if (match) {
      return JSON.stringify({
        ok: false,
        error: `A task named "${match.name}" already exists. To change it, pass its id ("${match.id}"); otherwise pick a different name.`,
        existingId: match.id,
      })
    }
  }

  // createDraft is an allowlist constructor (it never copies `workflowId` and
  // defaults `prompt` to ''), so the validated base is spread over it: the
  // draft contributes id/createdAt/updatedAt and the maxToolRounds default,
  // the base contributes exactly what was requested — including
  // `prompt: undefined` for workflow tasks, matching how the Tasks-tab editor
  // keeps them.
  const task: ScheduledTask = match ? { ...match, ...base } : { ...createDraft(base), ...base }

  await saveTask(task)
  // Arms the one-shot alarm (or clears it for a disabled/manual task). This is
  // the same call the Tasks tab's save command makes, so both entry points stay
  // in sync by construction.
  await scheduleTask(task.id)

  const next = nextRunAt(schedule, Date.now())
  return JSON.stringify({
    ok: true,
    id: task.id,
    name: task.name,
    kind: task.kind,
    schedule: describeSchedule(schedule, 'en'),
    ...(next !== null ? { nextRunAt: new Date(next).toISOString() } : { nextRunAt: null }),
    updated: !!match,
    note: 'Saved and armed. The user can manage it in the Tasks tab; each run executes unattended in full auto.',
  })
}

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
      const requestedElements = typeof args.maxElements === 'number' ? args.maxElements : 120
      // Clamp before the in-page call: a wild request must not make the kernel
      // build a huge element list.
      const maxElements = Math.max(
        1,
        Math.min(SNAPSHOT_ELEMENT_HARD_CAP, Math.floor(requestedElements) || 120),
      )
      const snapshot = await snapshotActiveTab(maxChars, maxElements, ctx.scope)
      ctx.lastUrl = snapshot.url
      rememberSnapshotTargets(ctx, snapshot)
      // Honor the requested element budget (up to the hard cap) instead of the
      // old fixed 80, so a takeover agent asking for 200 actually receives 200.
      return JSON.stringify(compactSnapshot(snapshot, maxElements))
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
      // Local OCR (Tesseract.js) runs first in the full build: it is fully
      // offline, free and, with the upscale+contrast preprocessing, accurate
      // enough for clean text. The vision model is the fallback for the
      // noisy/distorted images OCR comes up empty on — and the ONLY reader in
      // the no-ocr build, which strips the local engine entirely.
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
      let best: {
        text: string
        confidence: number
        agreed: boolean
        alternatives: string[]
        attempt: number
        rank: number
      } | null = null
      const readings: string[] = []

      if (__OCR__) {
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
                timing: {
                  captureMs,
                  preprocessMs,
                  ocrMs,
                  visionMs: 0,
                  attempts,
                  totalMs: Math.round(performance.now() - totalStart),
                },
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
            const alternatives = (ocr.alternatives ?? []).filter(
              (t) => t.trim() && t.trim() !== text,
            )
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
      } else {
        // No-ocr build: no local read exists — prepare the image once for the
        // vision-model fallback below (same download/preprocess contract).
        let imageData = dataUrl
        if (sourceUrl) {
          const downloaded = await fetchImageAsDataUrl(sourceUrl)
          if (!downloaded.ok) {
            return JSON.stringify({
              ok: false,
              error: downloaded.error,
              timing: {
                captureMs,
                preprocessMs,
                ocrMs,
                visionMs: 0,
                attempts,
                totalMs: Math.round(performance.now() - totalStart),
              },
            })
          }
          imageData = downloaded.dataUrl
        }
        const tPre = performance.now()
        processed = await preprocessImage(imageData)
        preprocessMs = Math.round(performance.now() - tPre)
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
          parts.push(
            `All readings: ${readings.join(' | ')} — compare and fill the most plausible one.`,
          )
        }
        parts.push(
          `Local OCR (Tesseract.js · ${lang}) read ${text.length} chars; use this text to fill the CAPTCHA field.`,
        )
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
          (__OCR__
            ? 'Local OCR could not read the image and no vision-capable image model is configured. '
            : 'This build ships without local OCR (no-ocr variant) and no vision-capable image model is configured. ') +
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
      // M2-16: one-line semantic summary so the model sees page health
      // without parsing the raw request buffer.
      const summary = summarizePerfNetwork([], requests).text
      return JSON.stringify({
        ok: true,
        requests,
        summary,
        ...(requests.length === 0
          ? { note: 'No requests captured yet. Run an action first, then call again.' }
          : {}),
      })
    }

    case 'list_console_messages': {
      throwIfAborted()
      // Reads the passive CDP monitor's console buffer; attaching here
      // (best-effort) makes the tool useful even when called before any
      // action ran. Never requires approval: pure read of an in-memory buffer.
      const tab = await resolveAutomationTab(undefined, ctx.scope)
      if (!tab || typeof tab.id !== 'number') {
        return JSON.stringify({ ok: false, error: '没有可读取的标签页。' })
      }
      await ensureTabMonitor(tab.id)
      const level = args.level === 'all' ? 'all' : 'errors'
      const messages = getConsoleEntries(tab.id, level)
      // M2-16: one-line semantic summary so the model sees page health
      // without parsing the raw console buffer.
      const summary = summarizePerfNetwork(messages, []).text
      return JSON.stringify({
        ok: true,
        messages,
        count: messages.length,
        summary,
        ...(messages.length === 0
          ? {
              note: 'No console messages captured yet. The monitor only sees output emitted after it attached — run an action first, then call again.',
            }
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

      // When download directory is configured, always write silently without user confirmation
      if (hasDir && dir) {
        const ok = await writeFileToDownloadDir(dir, filename, content)
        if (ok) return JSON.stringify({ ok: true, savedPath: filename, mode: 'auto' })
        return JSON.stringify({
          ok: false,
          error: 'Failed to write to configured download directory. Check permissions.',
        })
      }

      // No directory configured: fall back to user confirmation
      const transfer = resolveTransferMode('auto', settings.downloadAutoSave, hasDir)
      if (transfer === 'auto' && dir) {
        const ok = await writeFileToDownloadDir(dir, filename, content)
        if (ok) return JSON.stringify({ ok: true, savedPath: filename, mode: 'auto' })
      }

      const res = await askSaveViaSidePanel(filename, { text: content })
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
      unpinTab(ctx.scope)
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
      // Loading the plan skill arms the plan gate for the rest of the
      // conversation — its own note says "follow for the rest of this
      // conversation", so the hard gate must span turns, not just this one.
      if (skill.name === PLAN_SKILL_NAME) {
        armPlanGate(ctx.conversationId)
        if (ctx.planGate) ctx.planGate.armed = true
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
      // The skill was created outside a panel command, so nothing else would
      // refresh the panel's list — push the change so the new skill shows up
      // in the Skills tab and the composer's slash menu right away.
      notifySkillsChanged()
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
          id: task.id,
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

    case 'create_scheduled_task': {
      throwIfAborted()
      return await createScheduledTaskFromArgs(args)
    }

    case 'compose_workflow': {
      throwIfAborted()
      const out = await composeWorkflowFromDraft(ctx.conversationId, {
        name: typeof args.name === 'string' ? args.name : undefined,
        description: typeof args.description === 'string' ? args.description : undefined,
        save: args.save === undefined ? true : Boolean(args.save),
      })
      if ('error' in out) return JSON.stringify({ error: out.error })
      return JSON.stringify({
        ok: true,
        saved: out.saved,
        workflowId: out.workflow.id,
        name: out.workflow.name,
        nodeCount: out.workflow.drawflow.nodes.length,
      })
    }

    default: {
      if (isOperatorTool(name)) {
        throwIfAborted()
        // Workflow generation is not a dry run: the operator really operates
        // the page, and the node is recorded only once it succeeded. A failed
        // action records nothing and hands the error back for the model to fix.
        const out = await runOperatorToolWithExecution({
          name,
          args: (args ?? {}) as Record<string, unknown>,
          conversationId: ctx.conversationId,
          ...(ctx.snapshotTargets ? { snapshotTargets: ctx.snapshotTargets } : {}),
          ...(ctx.scope ? { scope: ctx.scope } : {}),
          // `executeTool`'s signal is optional; block executors require one.
          signal: signal ?? new AbortController().signal,
        })
        if (!out.ok) return JSON.stringify({ error: out.error })
        // Hand the audit record to `runOneToolCall`: the action history stores
        // the browser action the operator really performed, with the resolved
        // parameters, so the History tab reads naturally and the
        // history→workflow path still compiles this conversation.
        ctx.operatorAudit = out.audit
        return JSON.stringify({
          ok: true,
          nodeId: out.nodeId,
          workflowSize: out.workflowSize,
          ...(out.executed ? {} : { recordedWithoutRunning: true }),
          ...(out.note ? { note: out.note } : {}),
          ...(out.branch ? { branch: out.branch } : {}),
          // Tell the model its literal became a reference, so it does not
          // "correct" the node back to the value on a later call.
          ...(out.secretRedacted
            ? {
                secretRedacted: true,
                secretNote:
                  'A credential value in your parameters was replaced with its {{variable}} reference before the node was recorded. Pass references, never values.',
              }
            : {}),
          // Same reason, for business data: a frozen keyword would make the
          // workflow repeat this one run forever. Naming the new inputs lets
          // the model REUSE them on later calls instead of re-typing literals.
          ...(out.dynamicData
            ? {
                dynamicData: out.dynamicData,
                dynamicNote:
                  'Business values were recorded as references, not literals. ' +
                  (out.dynamicData.declared.length > 0
                    ? `These are now workflow inputs on the trigger: ${out.dynamicData.declared.join(', ')}. `
                    : '') +
                  'Reuse those names as {{name}} when the same value is needed again.',
              }
            : {}),
          // The escape hatch was justified, so the user has to hear about it:
          // they are the one who will maintain this workflow later.
          ...(out.scriptJustification
            ? {
                scriptJustification: out.scriptJustification,
                scriptNote:
                  'This step uses raw JavaScript, which is a LAST RESORT. Keep going with declarative operators for the remaining steps, and state in your final summary which step needed code and why — the user maintains this workflow, so they must know.',
              }
            : {}),
        })
      }
      throw new Error(`Unknown tool: ${name}`)
    }
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
): Promise<
  | {
      snapshot: unknown
      screenshot?: string
      consoleErrors?: string[]
      perfNetworkSummary?: string
    }
  | undefined
> {
  try {
    // Let the action's async page updates (fetch → render) land first, or the
    // observation shows the pre-action page.
    await waitForPageStable(signal, undefined, ctx.scope)
    const snapshot = await snapshotActiveTab(1500, 40, ctx.scope)
    // The observation's refs become the model's next action handles.
    rememberSnapshotTargets(ctx, snapshot)
    const observed: {
      snapshot: unknown
      screenshot?: string
      consoleErrors?: string[]
      perfNetworkSummary?: string
    } = {
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
      // M2-16: combine the fresh console errors with recent network failures
      // into one semantic "page health" line, fed back with the observation so
      // the loop can reason about perf/network health without the raw buffers.
      const recent = getRecentRequests(tabId)
      observed.perfNetworkSummary = summarizePerfNetwork(errors, recent).text
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
    if (name === 'present_plan') {
      const parsed = JSON.parse(result) as { approved?: boolean; auto?: boolean; error?: string }
      if (parsed.error) return `present_plan: ${parsed.error}`.slice(0, 200)
      if (parsed.approved) return parsed.auto ? 'Plan auto-approved (unattended)' : 'Plan approved'
      return 'Plan rejected'
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
    if (name === 'create_scheduled_task') {
      const parsed = JSON.parse(result) as {
        name?: string
        schedule?: string
        updated?: boolean
        error?: string
      }
      if (parsed.error) return `create_scheduled_task: ${parsed.error}`.slice(0, 200)
      return `${parsed.updated ? 'Updated' : 'Created'} scheduled task "${parsed.name ?? 'task'}" (${parsed.schedule ?? 'scheduled'})`
    }
    if (name === 'delegate_to_agent') {
      const parsed = JSON.parse(result) as {
        agent?: string
        status?: string
        reason?: string
        error?: string
        rounds?: number
      }
      if (parsed.status === 'refused')
        return `Delegation refused: ${parsed.reason ?? ''}`.slice(0, 200)
      if (parsed.error) return `delegate_to_agent: ${parsed.error}`.slice(0, 200)
      return `Delegated to ${parsed.agent ?? 'agent'}: ${parsed.status ?? 'done'}${
        parsed.rounds ? ` (${parsed.rounds} rounds)` : ''
      }`
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
  const [
    preferredProvider,
    skillList,
    initialMode,
    toolConfig,
    maxToolRounds,
    agentList,
    settings,
  ] = await Promise.all([
    deps.getProvider ? deps.getProvider().catch(() => undefined) : Promise.resolve(undefined),
    listSkills(),
    deps.getMode(),
    deps.getToolConfig(),
    deps.getMaxToolRounds(),
    // Unattended runs (no enableDelegation) never read the agent store, so
    // scheduled/Feishu prompts cannot fan out into sub-agents.
    deps.enableDelegation ? listAgents() : Promise.resolve([] as Agent[]),
    getSettings(),
  ])
  const provider = preferredProvider ?? (await getActiveProvider())
  const activeSkill = deps.skillId ? await getSkill(deps.skillId) : undefined

  // Plan-first gate (see `planGateBlocks`): arm when the plan skill governs
  // this turn — pinned explicitly, or mounted earlier in the conversation via
  // `use_skill` (conversation store). Only interactive panel turns arm it:
  // unattended runs (no `planDecision` channel) get plan guidance from the
  // skill's prompt alone, and a delegated specialist executes an
  // already-approved sub-task. `approved` starts false every turn: one user
  // message = one task = one plan.
  const planGateArmed =
    !deps.subAgent &&
    deps.planDecision !== undefined &&
    (activeSkill?.name === PLAN_SKILL_NAME || isPlanGateArmed(deps.conversationId))

  // Workflow generation mounts the built-in `workflow-generator` skill for the
  // whole turn: its operator guide (action→operator mapping, data rules,
  // keep/drop criteria) is the domain knowledge the condensed mode paragraph
  // deliberately no longer duplicates. Resolved from the skill store so user
  // edits apply immediately; the shipped constant is the fallback for a store
  // where the builtin was somehow removed. Specialists are excluded — the
  // workflow-expert gets the same skill through its own linked-skills path.
  const modeSkill =
    !deps.subAgent && initialMode === 'workflow'
      ? ((await findSkillByName('workflow-generator')) ??
        BUILT_IN_SKILLS.find((skill) => skill.id === 'builtin-workflow-generator'))
      : undefined

  // The mounted skill must NOT also sit in the catalogue: the catalogue tells
  // the model to load skills via `use_skill`, which would spend a round
  // re-loading instructions that are already in the system prompt.
  const catalogue: Skill[] = activeSkill
    ? []
    : modeSkill
      ? skillList.filter((skill) => skill.id !== modeSkill.id)
      : skillList
  const disabled = new Set(toolConfig.disabledTools)
  const messages: Messages = messagesFor(effectiveLocale(settings.locale, navigator.language))

  // --- Specialist sub-agent turn -------------------------------------------
  // A delegated run gets the agent's identity prompt + linked skills, a
  // whitelist-clamped tool set, and no delegation machinery of its own.
  let toolAllowSet: Set<string> | undefined
  let systemPrompt: string
  let delegation: DelegationRuntime | undefined

  if (deps.subAgent) {
    const agent = deps.subAgent.agent
    if (agent.tools.length > 0) {
      toolAllowSet = new Set([...agent.tools, 'load_tools'])
      // Pre-load every on-demand group that contributes a whitelisted tool so
      // the specialist has its full tool set from the FIRST request, under its
      // own namespaced conversation id. The delegate group is excluded:
      // specialists can never delegate.
      const groups = Object.entries(TOOL_GROUPS)
        .filter(
          ([group, names]) => group !== 'delegate' && names.some((name) => toolAllowSet!.has(name)),
        )
        .map(([group]) => group)
      storeLoadedGroups(deps.conversationId, groups)
    }
    systemPrompt = buildSystemPrompt({
      mode: initialMode,
      subAgent: { agent, skills: skillList },
      messages,
    })
  } else {
    // --- Supervisor turn ----------------------------------------------------
    // Enable the delegation runtime only when a delegatable supervisor AND at
    // least one cataloguable specialist actually exist; otherwise nothing in
    // the prompt mentions delegation and the tool group stays pointless.
    let supervisorBlock: { agent: Agent; catalogue: string } | undefined
    if (deps.enableDelegation && initialMode !== 'chat') {
      const specialists = agentList.filter((entry) => entry.role === 'specialist')
      const specialistCatalogue = renderAgentCatalogue(specialists, messages)
      const supervisor =
        agentList.find((entry) => entry.id === BUILT_IN_SUPERVISOR_ID && entry.delegatable) ??
        agentList.find((entry) => entry.role === 'supervisor' && entry.delegatable)
      if (supervisor && specialistCatalogue) {
        supervisorBlock = { agent: supervisor, catalogue: specialistCatalogue }
        delegation = { agents: agentList, count: 0, attempts: new Map() }
      }
    }
    systemPrompt = buildSystemPrompt({
      activeSkill,
      catalogue,
      mode: initialMode,
      basePrompt: toolConfig.basePrompt,
      messages,
      ...(modeSkill ? { modeSkill } : {}),
      ...(supervisorBlock ? { supervisor: supervisorBlock } : {}),
    })
  }
  const roundsCap = maxToolRounds || DEFAULT_MAX_TOOL_ROUNDS

  // Filter the advertised tools per round (see advertiseTools): the core set
  // plus any on-demand group the model has loaded so far this conversation.
  //  - chat mode sends no tools at all (pure conversation);
  //  - read-only mode hides every action that changes the page;
  //  - the user's disabled-tool list hides specific tools regardless of mode;
  //  - a specialist sub-agent additionally sees only its whitelist.
  // The execution switch below still rejects a tool that slips through, so a
  // stale model call cannot run a disabled or unadvertised tool.
  const loadedGroups = storeLoadedGroups(deps.conversationId, [])

  const ctx: ToolContext = {
    conversationId: deps.conversationId,
    loadedGroups,
    navigated: false,
    disabled,
    ...(delegation ? { delegation } : {}),
    ...(deps.subAgent ? { subAgent: deps.subAgent } : {}),
    ...(toolAllowSet ? { toolAllowSet } : {}),
    // Panel-scoped turns validate their window once here; a window that died
    // between the message and this point (or an editor-popup sender) degrades
    // to undefined = legacy global behaviour.
    ...(deps.scopeWindowId !== undefined
      ? { scope: await normalScopeFromWindowId(deps.scopeWindowId) }
      : {}),
    ...(planGateArmed
      ? { planGate: { armed: true, approved: false, split: false } satisfies PlanGate }
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

    // Recomputed per round: a `load_tools` or `use_operators` call in this turn
    // must change the advertised set from the very next request on.
    const tools = advertiseTools({
      mode: initialMode,
      disabled,
      loadedGroups: ctx.loadedGroups,
      activeOperatorCategories: getActiveOperatorCategories(ctx.conversationId),
      ...(ctx.toolAllowSet ? { allowTools: ctx.toolAllowSet } : {}),
      // An approved multi-workflow split releases `compose_workflow` so the
      // plan's segments can be saved mid-turn (each compose clears the draft).
      ...(ctx.planGate?.approved && ctx.planGate.split ? { planSplitApproved: true } : {}),
      // Unattended runs (no panel port → no askUser dep) must not even SEE
      // `ask_user`: scheduled tasks, Feishu commands and workflow AI-agent
      // blocks have nobody to answer, so the schema is withheld outright and
      // the dispatch-level refusal stays as defence in depth only.
      ...(deps.askUser ? {} : { hidden: new Set<string>(['ask_user']) }),
    })

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

/**
 * Attaches structured recovery context to a failed tool result: the failure
 * class, concrete recovery steps, the recent failed attempts at the SAME tool,
 * and the current page URL. A bare error string makes a model guess — and often
 * repeat the same call; this is what shortens the retry loop.
 */
function enrichToolError(
  base: Record<string, unknown>,
  history: readonly { role: string; name?: string; content?: unknown }[],
  name: string,
  lastUrl: string | undefined,
): string {
  const message = typeof base['error'] === 'string' ? base['error'] : 'Tool failed'
  const structured = buildToolErrorContext(message)
  const priorAttempts = recentFailedAttempts(history, name)
  return JSON.stringify({
    ...base,
    errorType: structured.errorType,
    suggestedRecovery: structured.suggestedRecovery,
    ...(priorAttempts.length > 0 ? { previousAttempts: priorAttempts } : {}),
    pageStateSummary: { url: lastUrl ?? '' },
  })
}

/**
 * Tools may REPORT failure (`{ok:false,error}`) instead of throwing. Enrich
 * those results the same way; a success (or already-structured error) passes
 * through untouched.
 */
function enrichToolOutputError(
  output: string,
  history: readonly { role: string; name?: string; content?: unknown }[],
  name: string,
  lastUrl: string | undefined,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return output
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return output
  const record = parsed as Record<string, unknown>
  if (record['errorType'] !== undefined) return output
  const failed = record['ok'] === false || typeof record['error'] === 'string'
  if (!failed) return output
  return enrichToolError(record, history, name, lastUrl)
}

/**
 * PURE one-click-approval predicate for a tool call: does `mode` auto-approve
 * `name` without popping the confirm card?
 *
 * Full auto and workflow generation are the two never-ask modes — every tool
 * the model calls runs immediately, whether it mutates the page or only reads
 * it. In workflow generation the model must not stall behind one-click
 * approval (the whole point is autonomous drafting); if it did, `open_url` /
 * `click` would hang on a card and the turn would stop.
 *
 * In every other mode only non-action/non-read tools (get_secret, load_tools,
 * pure queries) are auto-approved; anything that opens / clicks / types /
 * attaches a page still reaches the approval card. Semi mode's granted-page
 * read-drift is resolved separately in {@link runOneToolCall} against the
 * live tab URL.
 *
 * Exported and side-effect free so the confirmation contract can be
 * unit-tested without a browser driver.
 */
export function modeAutoApproves(mode: AgentMode, name: string): boolean {
  if (mode === 'full' || mode === 'workflow') return true
  return !(isPageAction(name) || READ_TOOLS.has(name))
}

/**
 * The (action, args) pair the action history records for one tool call.
 *
 * A workflow operator is recorded as the browser action it actually performed,
 * with its RESOLVED parameters — see `operatorAuditCall`. Everything else
 * records itself. The raw tool name still drives execution, the model-facing
 * result and the transcript; only the audit trail is remapped.
 */
function auditOf(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): { name: string; args: Record<string, unknown> } {
  const audit = ctx.operatorAudit
  if (!audit || !isOperatorTool(name)) return { name, args }
  return { name: audit.action, args: audit.args }
}

async function runOneToolCall(
  call: WireToolCall,
  history: WireMessage[],
  deps: AgentDeps,
  ctx: ToolContext,
): Promise<void> {
  const name = call.function.name
  // Hygiene: the audit record is written by `executeTool`, and a call that is
  // refused before reaching it must not inherit the previous step's record.
  ctx.operatorAudit = undefined
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

  // Supervisor → specialist delegation. Not a browser action, never approved
  // or recorded as one (the specialist's own actions still are); all gates
  // live in runDelegateTool. Runs the isolated sub-agent loop and returns a
  // compressed report.
  if (name === 'delegate_to_agent') {
    const outcome = await runDelegateTool(args, deps, ctx)
    pushResult(JSON.stringify(outcome))
    if (outcome.status === 'refused') {
      deps.send({
        type: 'tool.result',
        name,
        summary: `Delegation refused: ${outcome.reason.slice(0, 120)}`,
      })
      return
    }
    deps.send({
      type: 'tool.result',
      name,
      summary: `Delegated to ${outcome.agent}: ${outcome.status}${
        outcome.rounds > 0 ? ` (${outcome.rounds} rounds)` : ''
      }`,
    })
    await recordAction(
      deps.conversationId,
      name,
      describeAction(name, args, ctx.snapshotTargets),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      true,
      outcome.ok,
      describeDetail(name, args, ctx.snapshotTargets, JSON.stringify(outcome)),
      { agent: outcome.agent, task: typeof args.task === 'string' ? args.task : '' },
    )
    return
  }

  // The on-demand group loader: record the groups on this conversation so the
  // next round advertises them. Pure bookkeeping — no approval, no page touch.
  if (name === 'load_tools') {
    const requested = Array.isArray(args.groups) ? args.groups.map(String) : []
    let valid = requested.filter((group) => Boolean(TOOL_GROUPS[group]))
    const invalid = requested.filter((group) => !TOOL_GROUPS[group])
    // Workflow composition is exclusive to workflow mode: never let a
    // non-workflow turn pull an operator group into the conversation.
    if ((await deps.getMode()) !== 'workflow') {
      valid = valid.filter((group) => !isWorkflowOnlyGroup(group))
    }
    // A specialist can only load groups that contribute whitelisted tools,
    // and never the delegate group (no recursive delegation).
    if (ctx.subAgent) {
      valid = valid.filter(
        (group) =>
          group !== 'delegate' &&
          (!ctx.toolAllowSet || TOOL_GROUPS[group]!.some((tool) => ctx.toolAllowSet!.has(tool))),
      )
    }
    if (valid.length === 0) {
      // Name only the groups this mode can actually offer: listing the
      // workflow-only ones here would hand the model a menu it is refused.
      const offered = Object.keys(TOOL_GROUPS).filter((group) => !isWorkflowOnlyGroup(group))
      pushResult(
        JSON.stringify({
          error: `No valid group requested. Valid groups: ${offered.join(', ')}.`,
        }),
      )
      deps.send({ type: 'tool.result', name, summary: 'load_tools: no valid group' })
      return
    }
    const fresh = valid.filter((group) => !ctx.loadedGroups?.has(group))
    const loaded = storeLoadedGroups(ctx.conversationId, valid)
    const advertised = [...loaded].flatMap((group) => [...(TOOL_GROUPS[group] ?? [])])
    pushResult(
      JSON.stringify({
        loaded: fresh,
        alreadyLoaded: valid.filter((group) => !fresh.includes(group)),
        ...(invalid.length > 0 ? { unknownGroups: invalid } : {}),
        toolsAdvertised: ctx.toolAllowSet
          ? advertised.filter((tool) => ctx.toolAllowSet!.has(tool))
          : advertised,
      }),
    )
    deps.send({
      type: 'tool.result',
      name,
      summary:
        fresh.length > 0 ? `Loaded tools: ${fresh.join(', ')}` : 'Tool groups already loaded',
    })
    return
  }

  // The category selector: replace the active operator-category set so the
  // next round advertises exactly the schemas this step needs. Pure
  // bookkeeping — no approval, no page touch, and no node recorded (it chooses
  // what the model can build WITH, it is not itself a workflow step).
  if (name === USE_OPERATORS_TOOL) {
    if ((await deps.getMode()) !== 'workflow') {
      pushResult(
        JSON.stringify({
          error: `The "${USE_OPERATORS_TOOL}" tool is only available in workflow-generation mode.`,
        }),
      )
      deps.send({
        type: 'tool.result',
        name,
        summary: `Blocked (${name} is workflow-mode only)`,
      })
      return
    }
    const requested = Array.isArray(args.categories) ? args.categories.map(String) : []
    const valid = requested.filter(isAdvertisableOperatorCategory)
    const invalid = requested.filter((category) => !valid.includes(category as BlockCategory))
    const before = getActiveOperatorCategories(ctx.conversationId)
    const active = storeActiveOperatorCategories(ctx.conversationId, valid)
    const advertised = [
      ...CORE_OPERATOR_TOOL_NAMES,
      ...valid.flatMap((category) => [...OPERATOR_CATEGORY_TOOL_NAMES[category]]),
    ]
    pushResult(
      JSON.stringify({
        active: [...active],
        added: [...active].filter((category) => !before.has(category)),
        removed: [...before].filter((category) => !active.has(category)),
        ...(invalid.length > 0 ? { unknownCategories: invalid } : {}),
        // Deduped: the core four are members of `interaction`, so naming it
        // would otherwise report `wf_op_forms` twice.
        toolsAdvertised: [...new Set(advertised)],
      }),
    )
    deps.send({
      type: 'tool.result',
      name,
      summary:
        active.size > 0
          ? `Operator categories: ${[...active].join(', ')}`
          : 'Operator categories cleared (core four only)',
    })
    return
  }

  // A tool hidden inside an unloaded group was never advertised, so a call to
  // it is a hallucination — but a deliberate one: the model clearly needs it.
  // Auto-load the group right away (equivalent to the model calling
  // load_tools first) and instruct an immediate retry. Refusing with merely a
  // hint made weaker models give up and claim "tool limitations" to the user.
  const groupName = TOOL_GROUP_BY_NAME.get(name)
  // An operator whose CATEGORY was never declared is the common case now that
  // the catalog is dispatched by category: activate the category and retry,
  // rather than dumping the whole 53-schema catalog into the next round. The
  // core four are exempt — they are advertised unconditionally, so a call to
  // one is never a stray call.
  const operatorCategory = groupName ? categoryOfOperatorGroup(groupName) : undefined
  const groupUnavailable = CORE_OPERATOR_TOOL_SET.has(name)
    ? false
    : operatorCategory
      ? !getActiveOperatorCategories(ctx.conversationId).has(operatorCategory)
      : Boolean(groupName) && !ctx.loadedGroups?.has(groupName!)
  if (groupName && groupUnavailable) {
    // Sub-agent boundary: never auto-load the delegate group (recursion
    // guard) or a group whose tools the specialist's whitelist excludes.
    const blockedForSubAgent =
      !!ctx.subAgent &&
      (groupName === 'delegate' || (!!ctx.toolAllowSet && !ctx.toolAllowSet.has(name)))
    if (blockedForSubAgent) {
      pushResult(
        JSON.stringify({
          error: `The "${name}" tool is not available to this sub-agent. Complete the task with your advertised tools only.`,
        }),
      )
      deps.send({
        type: 'tool.result',
        name,
        summary: `Blocked (${name} not allowed for this sub-agent)`,
      })
      return
    }
    // Composition tools are workflow-mode-only; never auto-load one of their
    // groups to answer a stray call outside workflow generation.
    if (isWorkflowOnlyGroup(groupName) && (await deps.getMode()) !== 'workflow') {
      pushResult(
        JSON.stringify({
          error: `The "${name}" tool is only available in workflow-generation mode.`,
        }),
      )
      deps.send({
        type: 'tool.result',
        name,
        summary: `Blocked (${name} is workflow-mode only)`,
      })
      return
    }
    if (operatorCategory) {
      // Activate just this category. Adding to the current set (rather than
      // replacing it) keeps whatever the model was already using: it is
      // mid-task, and dropping those schemas to teach a lesson about declaring
      // categories early would cost more than the tokens saved.
      storeActiveOperatorCategories(ctx.conversationId, [
        ...getActiveOperatorCategories(ctx.conversationId),
        operatorCategory,
      ])
      pushResult(
        JSON.stringify({
          error: `"${name}" was not available: the "${operatorCategory}" operator category has been activated now and will be advertised on the next request. Call "${name}" again immediately — do not tell the user you lack tools.`,
        }),
      )
      deps.send({
        type: 'tool.result',
        name,
        summary: `Activated operator category ${operatorCategory} — retry ${name}`,
      })
      return
    }
    storeLoadedGroups(ctx.conversationId, [groupName])
    pushResult(
      JSON.stringify({
        error: `"${name}" was not loaded: its "${groupName}" tool group has been auto-loaded now and will be advertised on the next request. Call "${name}" again immediately — do not tell the user you lack tools.`,
      }),
    )
    deps.send({
      type: 'tool.result',
      name,
      summary: `Auto-loaded ${groupName} group — retry ${name}`,
    })
    return
  }

  // Specialist tool boundary, defence in depth: even if a non-grouped tool
  // slipped past advertisement, refuse it rather than executing it.
  if (ctx.toolAllowSet && name !== 'load_tools' && !ctx.toolAllowSet.has(name)) {
    const message = `The "${name}" tool is not allowed for this sub-agent.`
    pushResult(JSON.stringify({ error: message }))
    deps.send({
      type: 'tool.result',
      name,
      summary: `Blocked (${name} not allowed for this sub-agent)`,
    })
    return
  }

  // The clarifying-question channel. Not a page action and never behind the
  // approval card (see the ACTION_TOOLS comment); deliberately handled BEFORE
  // the mode gates so it also answers a stray call in readonly/chat mode
  // instead of dying as an unknown tool in `executeTool`. Sub-agents reach
  // this only past the whitelist check above — asking must be picked like any
  // other tool. Forbidden contexts are refused here too, as defence in depth
  // behind the withheld schema: workflow generation (the draft → save-card
  // flow must not stall on questions, and replay runs unattended) and
  // unattended runs (no `askUser` dep — nobody can answer).
  if (name === 'ask_user') {
    if ((await deps.getMode()) === 'workflow') {
      pushResult(
        JSON.stringify({
          error:
            'The "ask_user" tool is not available in workflow-generation mode. Record the standard flow with operators; the user reviews and adjusts it in the save card.',
        }),
      )
      deps.send({ type: 'tool.result', name, summary: 'Blocked (workflow mode)' })
      return
    }
    const question = typeof args.question === 'string' ? args.question.trim().slice(0, 2000) : ''
    // Structured suggestions are MANDATORY: at least 3 candidates, each with a
    // label AND its pros/cons, the recommended one first (the panel pre-selects
    // it). A bare "how should I proceed?" card wastes the user's time — reject
    // the call with one actionable message so the model can comply and retry.
    const rawOptions = Array.isArray(args.options) ? args.options : []
    const options: Array<{ label: string; pros: string; cons: string }> = []
    for (const raw of rawOptions) {
      if (typeof raw !== 'object' || raw === null) continue
      const record = raw as Record<string, unknown>
      const label = typeof record['label'] === 'string' ? record['label'].trim() : ''
      const pros = typeof record['pros'] === 'string' ? record['pros'].trim() : ''
      const cons = typeof record['cons'] === 'string' ? record['cons'].trim() : ''
      if (!label || !pros || !cons) continue
      options.push({
        label: label.slice(0, 80),
        pros: pros.slice(0, 200),
        cons: cons.slice(0, 200),
      })
      if (options.length >= 6) break
    }
    if (!question || options.length < 3) {
      pushResult(
        JSON.stringify({
          error:
            'ask_user requires "question" (explain the situation) and 3-6 "options", each with non-empty "label", "pros" and "cons"; put the recommended option first.',
        }),
      )
      deps.send({ type: 'tool.result', name, summary: 'ask_user: invalid arguments' })
      return
    }
    if (!deps.askUser) {
      pushResult(
        JSON.stringify({
          ok: false,
          error:
            'No interactive user is connected (unattended run): ask_user is unavailable. Decide with a reasonable default and state the assumption in your answer.',
        }),
      )
      deps.send({ type: 'tool.result', name, summary: 'No interactive user (unattended run)' })
      return
    }
    const answer = await deps.askUser({ question, options })
    if (answer.cancelled) {
      pushResult(
        JSON.stringify({
          ok: false,
          cancelled: true,
          error:
            'The user dismissed the question without answering. Proceed with a sensible default and state the assumption, or stop.',
        }),
      )
      deps.send({ type: 'tool.result', name, summary: 'User dismissed the question' })
      await recordAction(
        deps.conversationId,
        name,
        `Ask the user: ${question.slice(0, 120)}`,
        ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
        true,
        false,
        [`Question: ${question}`, 'Answer: (dismissed)'],
        { question, options },
      )
      return
    }
    const answerText = answer.answer.trim()
    pushResult(JSON.stringify({ ok: true, answer: answerText }))
    deps.send({
      type: 'tool.result',
      name,
      summary: `User answered: "${answerText.slice(0, 80)}${answerText.length > 80 ? '…' : ''}"`,
    })
    await recordAction(
      deps.conversationId,
      name,
      `Ask the user: ${question.slice(0, 120)}`,
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      true,
      true,
      [`Question: ${question}`, `Answer: ${answerText}`],
      { question, options },
    )
    return
  }

  // The plan-approval hand-off (`present_plan`). Dispatched here — before the
  // mode gates — because it is a UI interaction, not a page action: it must
  // reach the panel in every mode, need no approval card itself, and, on
  // approval, OPEN the plan gate that the branch below enforces. An unattended
  // run (no `planDecision` dep) auto-approves so a scheduled task with the
  // plan skill states its plan and proceeds instead of stalling.
  if (name === 'present_plan') {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
    const rawSteps = Array.isArray(args.steps) ? args.steps : []
    const steps: PlanStep[] = []
    for (const raw of rawSteps) {
      if (typeof raw !== 'object' || raw === null) continue
      const record = raw as Record<string, unknown>
      const title = typeof record['title'] === 'string' ? record['title'].trim() : ''
      if (!title) continue
      const detail = typeof record['detail'] === 'string' ? record['detail'].trim() : ''
      steps.push(
        detail
          ? { title: title.slice(0, 500), detail: detail.slice(0, 500) }
          : { title: title.slice(0, 500) },
      )
      if (steps.length >= 20) break
    }
    if (!goal || steps.length < 2) {
      pushResult(
        JSON.stringify({
          error:
            'present_plan requires "goal" (one line) and "steps" (2-20 items, each with a non-empty "title").',
        }),
      )
      deps.send({ type: 'tool.result', name, summary: 'present_plan: invalid plan' })
      return
    }
    const risks = typeof args.risks === 'string' ? args.risks.trim().slice(0, 2000) : ''
    const split = typeof args.split === 'string' ? args.split.trim().slice(0, 2000) : ''
    const plan: PlanRequest = {
      goal: goal.slice(0, 500),
      steps,
      ...(risks ? { risks } : {}),
      ...(split ? { split } : {}),
    }
    if (!deps.planDecision) {
      if (ctx.planGate) ctx.planGate.approved = true
      pushResult(
        JSON.stringify({
          ok: true,
          approved: true,
          auto: true,
          note: 'No interactive user is connected (unattended run): the plan is auto-approved. State it in your answer and proceed as planned.',
        }),
      )
      deps.send({
        type: 'tool.result',
        name,
        summary: `Plan auto-approved (${steps.length} steps)`,
      })
      return
    }
    const decision = await deps.planDecision(plan)
    if (decision.approved) {
      // Open the gate. A plan that declared a split also releases
      // `compose_workflow` for the rest of the turn (see `planSplitApproved`).
      if (ctx.planGate) {
        ctx.planGate.approved = true
        ctx.planGate.split = split !== ''
      }
      pushResult(
        JSON.stringify({
          ok: true,
          approved: true,
          note: 'The user approved the plan. Execute it now; if the page no longer matches, explain the difference first.',
        }),
      )
      deps.send({
        type: 'tool.result',
        name,
        summary: `Plan approved (${steps.length} steps)`,
      })
      await recordAction(
        deps.conversationId,
        name,
        `Plan approved: ${plan.goal.slice(0, 120)}`,
        ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
        true,
        true,
        [`Goal: ${plan.goal}`, `Steps: ${steps.length}`, ...(split ? [`Split: ${split}`] : [])],
        plan as unknown as Record<string, unknown>,
      )
      return
    }
    const feedback = (decision.feedback ?? '').trim()
    pushResult(
      JSON.stringify({
        ok: false,
        approved: false,
        feedback,
        error: `The user rejected the plan${feedback ? `: ${feedback}` : ' without feedback'}. Revise it accordingly and call present_plan again; after two rejected revisions, ask the user directly (ask_user) instead.`,
      }),
    )
    deps.send({
      type: 'tool.result',
      name,
      summary: `Plan rejected: ${feedback.slice(0, 120) || 'no feedback'}`,
    })
    await recordAction(
      deps.conversationId,
      name,
      `Plan rejected: ${plan.goal.slice(0, 120)}`,
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      true,
      false,
      [`Goal: ${plan.goal}`, `Steps: ${steps.length}`, `Feedback: ${feedback || '(none)'}`],
      plan as unknown as Record<string, unknown>,
    )
    return
  }

  // The plan-first gate: while the plan skill governs this turn and its plan
  // has not been approved, every page action — including every `wf_op_*`
  // operator, which would otherwise record research detours into the draft —
  // is refused. Reads stay available (see `PLAN_PHASE_READS`): the research
  // phase needs them. Deliberately BEFORE the mode gates: this is an
  // additional, earlier gate, not a replacement for per-mode approval.
  if (planGateBlocks(ctx.planGate, name)) {
    pushResult(
      JSON.stringify({
        error:
          'Plan-first is active: the plan has not been approved yet, so page actions are refused. Finish your research (reads stay available), then call present_plan with the steps and wait for approval.',
      }),
    )
    deps.send({ type: 'tool.result', name, summary: 'Blocked (plan not approved)' })
    await recordAction(
      deps.conversationId,
      name,
      describeAction(name, args, ctx.snapshotTargets),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      false,
      false,
      [...describeDetail(name, args, ctx.snapshotTargets), 'Blocked: plan not approved'],
      args,
    )
    return
  }

  // Read the mode freshly for every action, so switching it in the panel
  // applies to the very next tool call, even within the same turn.
  const mode = await deps.getMode()

  // Read-only mode refuses any action that changes the page. Defensive: the
  // tool isn't even advertised in this mode (when the turn started there),
  // but a turn that began in another mode can be switched to read-only
  // mid-run; actions from that point must stop. `isPageAction` covers the
  // workflow operators, which are the dangerous case — a workflow-generation
  // turn keeps them in its advertised set for the whole turn.
  if ((mode === 'readonly' || mode === 'chat') && isPageAction(name)) {
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

  let approved = true
  if (!modeAutoApproves(mode, name)) {
    // Semi (and below): an action tool, or a read that drifted off the user's
    // granted page, still reaches the one-click card.
    let mustConfirm = true
    if (READ_TOOLS.has(name) && deps.grantedPageUrl) {
      // A page attached by the user is already consented to, but a read that
      // drifted to another page still asks.
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
    pushResult(enrichToolOutputError(output, history, name, ctx.lastUrl))
    const summary = shortSummary(name, output)
    deps.send({ type: 'tool.result', name, summary })
    let ok = true
    try {
      const parsed = JSON.parse(output) as { ok?: boolean; error?: string }
      ok = parsed.ok !== false
    } catch {
      /* keep ok */
    }
    const audit = auditOf(name, args, ctx)
    await recordAction(
      deps.conversationId,
      audit.name,
      describeAction(audit.name, audit.args, ctx.snapshotTargets),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      approved,
      ok,
      describeDetail(audit.name, audit.args, ctx.snapshotTargets, output),
      audit.args,
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
    pushResult(enrichToolError({ error: message }, history, name, ctx.lastUrl))
    deps.send({ type: 'tool.result', name, summary: `Failed: ${message}` })
    const audit = auditOf(name, args, ctx)
    await recordAction(
      deps.conversationId,
      audit.name,
      describeAction(audit.name, audit.args, ctx.snapshotTargets),
      ctx.lastUrl ? hostOf(ctx.lastUrl) : undefined,
      approved,
      false,
      [...describeDetail(audit.name, audit.args, ctx.snapshotTargets), `Error: ${message}`],
      audit.args,
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
  scope?: ScopeWindow,
): Promise<unknown> {
  if (!TOOLS.some((tool) => tool.function.name === name)) {
    return { ok: false, error: `Unknown tool: ${name}` }
  }
  // The bridge is unattended: there is no panel port to route a clarifying
  // question to, so refuse it explicitly instead of the opaque "unknown" path
  // below (ask_user IS in TOOLS, so tools.list does advertise it).
  if (name === 'ask_user') {
    return {
      ok: false,
      error: 'ask_user needs an interactive side panel and is not available over the bridge.',
    }
  }
  // Same for the plan-approval card: there is nobody to approve a plan here.
  if (name === 'present_plan') {
    return {
      ok: false,
      error: 'present_plan needs an interactive side panel and is not available over the bridge.',
    }
  }
  const settings = await getSettings()
  const disabled = new Set(settings.disabledTools)
  if (disabled.has(name)) {
    return { ok: false, error: `The "${name}" tool is disabled in settings.` }
  }
  // The bridge has no sender window of its own: an explicitly passed scope
  // (the connection's assigned window, see resolveBridgeTarget in
  // window-policy) wins; otherwise while a panel window exists it is the
  // monitored/controlled
  // one, so scope to it; with no panel open the legacy global resolution
  // applies.
  const resolved = scope ?? (await resolveUnattendedScope())
  const ctx: ToolContext = {
    conversationId: `external:${newId()}`,
    // The bridge bypasses advertisement entirely, so treat every group as
    // loaded: runOneToolCall's unloaded-group refusal must not block it.
    loadedGroups: new Set(Object.keys(TOOL_GROUPS)),
    navigated: false,
    disabled,
    ...(resolved ? { scope: resolved } : {}),
  }
  const output = await executeTool(name, args, ctx)
  try {
    return JSON.parse(output)
  } catch {
    return { ok: true, output }
  }
}
