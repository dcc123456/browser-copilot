/**
 * AI takeover (AI 接管) — shared, chrome-free layer.
 *
 * When a workflow run fails at a node, the engine can hand that ONE node over
 * to an AI agent: the agent looks at the live page (snapshot first), completes
 * the failed node's purpose with the page tools, and hands control back so the
 * remaining nodes keep running in the same run. This module holds everything
 * that must stay pure and shared between the engine, the background takeover
 * runner and the panel:
 *
 * - the takeover report / fix types (also used by the panel's confirm flow),
 * - the takeover prompt builder,
 * - the defensive verdict parser (the agent MUST end with one JSON line).
 *
 * The runtime agent loop lives in `background/workflow-engine/ai-takeover`;
 * the engine-side hook types live in `workflow-engine/engine`.
 *
 * @module lib/workflow/ai-takeover
 */
import type { ProviderProfile, Settings } from '../types'

/** Total takeover attempts per failed node before the run fails (重试 3 次). */
export const TAKEOVER_MAX_ATTEMPTS = 3

/**
 * Why a takeover could not complete the step. `auth` / `captcha` are
 * UNRECOVERABLE — retrying burns model calls for nothing, so the runtime
 * stops after the first attempt when the agent reports one of them.
 */
export type TakeoverReasonKind = 'auth' | 'captcha' | 'notfound' | 'timeout' | 'network' | 'other'

/** Reason kinds that can never succeed by retrying. */
export const HOPELESS_REASON_KINDS: readonly TakeoverReasonKind[] = ['auth', 'captcha']

const REASON_KINDS: readonly string[] = ['auth', 'captcha', 'notfound', 'timeout', 'network', 'other']

/** Narrow a free-form reason to the whitelist (undefined when not one of them). */
export function asReasonKind(value: unknown): TakeoverReasonKind | undefined {
  return typeof value === 'string' && (REASON_KINDS as readonly string[]).includes(value)
    ? (value as TakeoverReasonKind)
    : undefined
}

/**
 * Keyword fallback classification for models that skip `reasonKind`.
 * Chinese + English needles cover the common hopeless cases (login walls,
 * captchas); everything else stays 'other'/undefined — only hopeless kinds
 * trigger the fast-fail, so a wrong guess here is cheap.
 */
export function classifyReason(text: string): TakeoverReasonKind | undefined {
  const t = text.toLowerCase()
  if (/(验证码|captcha|recaptcha|human verification)/.test(t)) return 'captcha'
  if (/(需要登录|请先登录|请登录|未登录|登录页|sign in|log in|login required|not logged in|unauthorized|401|403)/.test(t)) return 'auth'
  if (/(超时|timeout|timed out)/.test(t)) return 'timeout'
  if (/(网络|断网|network|net::err|failed to fetch)/.test(t)) return 'network'
  if (/(未找到|没有找到|不存在|not found|no element|no matching)/.test(t)) return 'notfound'
  return undefined
}

/**
 * Label of the tracked run that wraps a takeover debug session. The panel's
 * live log modal polls the running-tasks board for this label, so both sides
 * must agree on the format.
 */
export function debugRunLabel(workflowName: string): string {
  return `AI 调试: ${workflowName}`
}

/** One graph fix the takeover proposes for a node (applied only after user confirmation). */
export interface TakeoverFix {
  nodeId: string
  /** Human-readable node name for the confirm dialog. */
  nodeLabel: string
  /** Corrected block params, merged flat onto `node.data` (protected keys ignored). */
  paramsPatch: Record<string, unknown>
  /** One-line Chinese note of WHAT the AI changed and why. */
  note: string
}

/** One takeover episode as reported back to the panel / debug session log. */
export interface TakeoverReport {
  nodeId: string
  nodeLabel: string
  completed: boolean
  attempts: number
  /** What the AI did (Chinese, shown in logs and the confirm dialog). */
  summary?: string
  /** Why the takeover failed (after exhausting the attempts). */
  error?: string
  /** Classified failure reason (drives fast-fail and the stats view). */
  reasonKind?: TakeoverReasonKind
  /** Proposed node fix awaiting user confirmation (never auto-applied). */
  fix?: TakeoverFix
}

/** The structured verdict the takeover agent is asked to end its reply with. */
export interface TakeoverVerdict {
  completed: boolean
  /** One concise Chinese sentence of what the agent did / why it gave up. */
  summary: string
  /** Value the failed step should have produced (read text, HTTP body, …). */
  output?: string
  /** Corrected params for the failed node (e.g. the selector actually used). */
  paramsPatch?: Record<string, unknown>
  /**
   * The node the fix targets. Root causes often live UPSTREAM of the node
   * that threw (a bad value produced earlier), so the agent may name that
   * node instead; the runtime validates it against the real graph and
   * defaults to the failed node when absent/unknown.
   */
  fixNodeId?: string
  /** Classified failure reason when completed=false. */
  reasonKind?: TakeoverReasonKind
}

/** Plain-data payload for {@link buildTakeoverPrompt} (no graph types needed). */
export interface TakeoverPromptParts {
  workflowName?: string
  workflowDescription?: string
  /** Engine step lines up to the failure, oldest first (already tail-capped). */
  steps: { kind: string; text: string }[]
  /** One line describing the last node that ran BEFORE the failure (the takeover anchor). */
  previousNodeLine?: string
  /** Older completed-node lines (before the immediate anchor), oldest first. */
  earlierNodeLines?: string[]
  /**
   * The nodes that actually ran BEFORE the failure (execution order, oldest
   * first, most recent last) with their ids and params — the evidence trail
   * for tracing a root cause UPSTREAM of the node that threw.
   */
  upstream?: { id: string; line: string; params: Record<string, unknown> }[]
  /**
   * The run's current variable values (capped by the runtime). Wrong values
   * here are the fingerprint of an upstream root cause.
   */
  variables?: Record<string, unknown>
  /** Downstream node labels — shown as "do NOT do these" boundaries. */
  upcomingNodeLines?: string[]
  /** Output variable the failed step must fill (when its block declares one). */
  outputVariable?: string
  /** Compact tool trace of the previous attempt (tool/result/error lines). */
  lastAttemptTrace?: string[]
  failing: {
    blockId: string
    blockName?: string
    label?: string
    description?: string
    params: Record<string, unknown>
  }
  error: string
  attempt: number
  maxAttempts: number
  /** What went wrong in the previous attempt (fed back on retries). */
  lastAttemptNote?: string
}

/** Cap per param value shipped to the model so one node can't blow context. */
const VALUE_CAP = 200

/** JSON.stringify replacer that truncates long strings (applies recursively). */
function truncateStrings(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    typeof val === 'string' && val.length > VALUE_CAP ? `${val.slice(0, VALUE_CAP)}…` : val,
  )
}

/**
 * Builds the takeover prompt. English scaffolding (models follow it reliably);
 * `summary` is requested in Chinese because it is shown to the user.
 */
export function buildTakeoverPrompt(parts: TakeoverPromptParts): string {
  const lines: string[] = []
  lines.push(
    'You are the AI takeover step inside a browser-automation Chrome extension.',
    'A workflow run FAILED at one step. You take over EXACTLY that step: look at the live page, complete the step\'s purpose like a human operator would, then hand control back — the workflow continues automatically with the following steps.',
    '',
    '## Workflow intent',
    `Name: ${parts.workflowName || '(unnamed)'}`,
  )
  if (parts.workflowDescription) lines.push(`Description: ${parts.workflowDescription}`)
  if (parts.previousNodeLine || (parts.earlierNodeLines?.length ?? 0) > 0) {
    lines.push('', '## Where you take over (these nodes already ran, oldest first)')
    for (const line of parts.earlierNodeLines ?? []) lines.push(line)
    if (parts.previousNodeLine) lines.push(parts.previousNodeLine)
  }
  if (parts.upstream && parts.upstream.length > 0) {
    lines.push(
      '',
      '## Upstream chain (executed before the failure, oldest first — with node ids)',
      'These are the nodes whose OUTPUTS the failed step consumed. If a value here looks wrong, the root cause is upstream.',
    )
    for (const up of parts.upstream) {
      lines.push(`- id=${up.id} ${up.line}`, `  params: ${truncateStrings(up.params)}`)
    }
  }
  if (parts.variables && Object.keys(parts.variables).length > 0) {
    lines.push(
      '',
      '## Current variable values (produced by the upstream nodes)',
      ...Object.entries(parts.variables).map(([key, value]) => `- ${key} = ${truncateStrings(value)}`),
      'A wrong/empty value here points at the node that PRODUCED it — that node is the one to fix.',
    )
  }
  if (parts.steps.length > 0) {
    lines.push('', '## Recent run steps (oldest first)')
    for (const step of parts.steps) lines.push(`- [${step.kind}] ${step.text}`)
  }
  if (parts.upcomingNodeLines && parts.upcomingNodeLines.length > 0) {
    lines.push(
      '',
      '## What comes AFTER this step (these steps run AUTOMATICALLY — do NOT do them)',
      ...parts.upcomingNodeLines.map((line) => `- ${line}`),
      'Doing a later step yourself breaks the flow (double submit, wrong state). Stop once THIS step is done.',
    )
  }
  lines.push(
    '',
    '## The failed step you MUST complete',
    `Block: ${parts.failing.blockName || parts.failing.blockId} (${parts.failing.blockId})`,
  )
  if (parts.failing.description) lines.push(`Purpose: ${parts.failing.description}`)
  if (parts.failing.label && parts.failing.label !== parts.failing.blockId) {
    lines.push(`Label: ${parts.failing.label}`)
  }
  lines.push(
    `Params: ${truncateStrings(parts.failing.params)}`,
    `Error: ${parts.error || '(no error text)'}`,
  )
  if (parts.outputVariable) {
    lines.push(
      `Output variable: "${parts.outputVariable}" — downstream steps read {{${parts.outputVariable}}}.`,
      'This step MUST PRODUCE a value: put what it reads/produces in "output" (omitting it breaks every later step).',
    )
  }
  lines.push(
    '',
    '## How to work',
    '0. CLASSIFY the failure FIRST: is it a slow page (element not rendered yet), a stale selector, a login wall / captcha (HOPELESS — do not click around), a bad INPUT produced by an upstream node, or something else? The class decides your strategy:',
    '   - slow page / not rendered → scroll into view, `wait_for` the element (wait_for or passing a `target`/CSS to wait), then act.',
    '   - stale selector → locate the real target in the snapshot and act on it.',
    '   - login wall / captcha → do NOT burn tool rounds; finish immediately with completed=false and reasonKind "auth"/"captcha".',
    '   - bad input from upstream (variable holds the wrong text/empty, the value filled looks mangled) → compare the variable values above with what the page actually shows; the node that PRODUCED the wrong value (read the upstream chain ids) is the true culprit.',
    '1. FIRST call snapshot_page to see the current page (structure + interactive elements with refs). The recorded selector is often stale — trust what the page shows NOW. On long pages raise `maxElements` (e.g. 200) and scroll if the target is below the fold.',
    '2. Locate the real target for this step\'s purpose among the snapshot elements. Elements may carry a `loc` hint — a stable CSS locator (#id, [data-testid="…"], [name="…"]) you can reuse.',
    '3. If the target is NOT in the snapshot (overlay, canvas, odd markup): scroll into view, take a `screenshot` (visual) or `read_current_page` (text) to find it; use `recognize_image` for text inside images.',
    '4. Complete the step with the page tools (click / fill / press key / navigate / read). Do ONLY this step\'s work — no extra exploring, no doing later steps.',
    '5. Verify your action took effect (a fresh snapshot / element check) before finishing.',
    '6. If the step should PRODUCE a value (element text, HTTP response body, OCR result…), put that value in "output" — it is stored into the step\'s output variable.',
  )
  if (parts.lastAttemptNote) {
    lines.push(
      '',
      `## Previous takeover attempt (attempt ${parts.attempt - 1}/${parts.maxAttempts}) did NOT complete`,
      parts.lastAttemptNote,
      'Read it, adjust your approach, and try again.',
    )
  }
  if (parts.lastAttemptTrace && parts.lastAttemptTrace.length > 0) {
    lines.push(
      '',
      "## What your PREVIOUS attempt actually did (tool trace, oldest first — you have NO other memory of it)",
      ...parts.lastAttemptTrace.map((line) => `- ${line}`),
      'Do NOT blindly repeat these calls: any action listed here already ran. If it failed, change the approach — different element/ref, scroll first, fill instead of click, re-snapshot, or a different page area.',
    )
  }
  lines.push(
    '',
    '## Response format (MANDATORY)',
    'End your reply with ONE line of JSON — no markdown fence, no commentary after it:',
    '{"completed":true,"summary":"一句话中文总结你做了什么","output":"该步骤应产出的值（没有则省略）","fix":{"nodeId":"<要修的节点id，省略=失败节点>","paramsPatch":{"selector":"你实际使用的正确选择器或修正后的参数"}},"reasonKind":"notfound"}',
    '- completed=false when you could not finish the step; explain why in summary and set reasonKind to one of: auth | captcha | notfound | timeout | network | other.',
    '- fix.paramsPatch: corrected params so FUTURE runs work WITHOUT AI takeover. Only when confident:',
    '  · stale selector → the stable locator you actually saw (the element\'s `loc` hint, #id, [data-testid=…]);',
    '  · page loads slowly → {"waitForSelector":true,"waitSelectorTimeout":5000} (or higher), optionally alongside the corrected selector;',
    '  · omit entirely when unsure.',
    "- fix.nodeId: WHERE the fix belongs. The node that threw is NOT always the culprit — when the real cause is an upstream node producing a wrong value (bad read, wrong element, mangled variable), set fix.nodeId to THAT upstream node's id (see the Upstream chain section). Omit to target the failed node itself.",
    `- You have ${parts.maxAttempts} attempts in total; this is attempt ${parts.attempt}.`,
  )
  return lines.join('\n')
}

/**
 * Parses the agent's reply into a verdict. The reply may contain prose before
 * the JSON; the LAST parseable JSON object wins. No parseable object, a
 * non-boolean `completed`, or any shape deviation degrades to
 * `completed: false` so a chatty agent can never fake a success.
 *
 * Recovery heuristic: when no JSON object parses at all but the reply plainly
 * claims `"completed": true`, the work IS accepted — models that finished the
 * step but mangled the verdict line must not burn another attempt redoing it.
 */
export function parseTakeoverVerdict(text: string): TakeoverVerdict {
  const candidates: string[] = []
  const lastBrace = text.lastIndexOf('{')
  const lastClose = text.lastIndexOf('}')
  if (lastBrace >= 0 && lastClose > lastBrace) candidates.push(text.slice(lastBrace, lastClose + 1))
  const firstBrace = text.indexOf('{')
  if (firstBrace >= 0 && lastClose > firstBrace && firstBrace !== lastBrace) {
    candidates.push(text.slice(firstBrace, lastClose + 1))
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const fixRecord =
        parsed['fix'] && typeof parsed['fix'] === 'object' && !Array.isArray(parsed['fix'])
          ? (parsed['fix'] as Record<string, unknown>)
          : undefined
      const patch =
        fixRecord?.['paramsPatch'] &&
        typeof fixRecord['paramsPatch'] === 'object' &&
        !Array.isArray(fixRecord['paramsPatch'])
          ? (fixRecord['paramsPatch'] as Record<string, unknown>)
          : undefined
      return {
        completed: parsed['completed'] === true,
        summary:
          typeof parsed['summary'] === 'string' && parsed['summary'].trim()
            ? parsed['summary'].trim()
            : text.slice(0, 200).trim() || '（AI 未给出总结）',
        ...(typeof parsed['output'] === 'string' && parsed['output'] ? { output: parsed['output'] } : {}),
        ...(patch && Object.keys(patch).length > 0 ? { paramsPatch: patch } : {}),
        ...(typeof fixRecord?.['nodeId'] === 'string' && fixRecord['nodeId'].trim()
          ? { fixNodeId: fixRecord['nodeId'].trim() }
          : {}),
        ...(asReasonKind(parsed['reasonKind']) ? { reasonKind: asReasonKind(parsed['reasonKind']) } : {}),
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (/"completed"\s*:\s*true/i.test(text)) {
    const summary =
      text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith('{') && !line.startsWith('}')) ??
      text.slice(0, 200).trim()
    return { completed: true, summary: summary.slice(0, 200) || '（AI 未给出总结）' }
  }
  return {
    completed: false,
    summary: text.slice(0, 200).trim() || '（AI 未返回有效结论）',
  }
}

/**
 * Resolves the provider/model the takeover agent should use: the dedicated
 * `settings.takeoverModel` when configured (provider and/or a model override
 * on the active profile), otherwise the active chat provider.
 */
export function takeoverProviderOf(settings: Settings): ProviderProfile | undefined {
  const active =
    settings.providers.find((profile) => profile.id === settings.activeProviderId) ??
    settings.providers[0]
  if (!active) return undefined
  const override = settings.takeoverModel
  if (!override || (!override.providerId && !override.model)) return active
  const base =
    override.providerId !== ''
      ? settings.providers.find((profile) => profile.id === override.providerId)
      : active
  if (!base) return active
  return override.model && override.model !== base.model ? { ...base, model: override.model } : base
}

/**
 * Params keys under which a block stores its step output. When the failed node
 * declares one, the takeover writes the agent's `output` there so downstream
 * `{{variable}}` references still resolve (best effort).
 */
const OUTPUT_PARAM_KEYS = ['variableName', 'responseVariable'] as const

export function outputVariableKeyOf(params: Record<string, unknown>): string | undefined {
  for (const key of OUTPUT_PARAM_KEYS) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}
