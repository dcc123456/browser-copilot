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

/** Total takeover attempts per failed node before the run fails (重试 3 次). */
export const TAKEOVER_MAX_ATTEMPTS = 3

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
}

/** Plain-data payload for {@link buildTakeoverPrompt} (no graph types needed). */
export interface TakeoverPromptParts {
  workflowName?: string
  workflowDescription?: string
  /** Engine step lines up to the failure, oldest first (already tail-capped). */
  steps: { kind: string; text: string }[]
  /** One line describing the last node that ran BEFORE the failure (the takeover anchor). */
  previousNodeLine?: string
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
  if (parts.previousNodeLine) {
    lines.push('', '## Where you take over (the previous node already ran)')
    lines.push(parts.previousNodeLine)
  }
  if (parts.steps.length > 0) {
    lines.push('', '## Recent run steps (oldest first)')
    for (const step of parts.steps) lines.push(`- [${step.kind}] ${step.text}`)
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
    '',
    '## How to work',
    '1. FIRST call snapshot_page to see the current page (structure + interactive elements with refs). The recorded selector is often stale — trust what the page shows NOW.',
    '2. Locate the real target for this step\'s purpose among the snapshot elements.',
    '3. Complete the step with the page tools (click / fill / press key / navigate / read). Do ONLY this step\'s work — no extra exploring, no doing later steps.',
    '4. Verify your action took effect (a fresh snapshot / element check) before finishing.',
    '5. If the step should PRODUCE a value (element text, HTTP response body, OCR result…), put that value in "output" — it is stored into the step\'s output variable.',
  )
  if (parts.lastAttemptNote) {
    lines.push(
      '',
      `## Previous takeover attempt (attempt ${parts.attempt - 1}/${parts.maxAttempts}) did NOT complete`,
      parts.lastAttemptNote,
      'Read it, adjust your approach, and try again.',
    )
  }
  lines.push(
    '',
    '## Response format (MANDATORY)',
    'End your reply with ONE line of JSON — no markdown fence, no commentary after it:',
    '{"completed":true,"summary":"一句话中文总结你做了什么","output":"该步骤应产出的值（没有则省略）","fix":{"paramsPatch":{"selector":"你实际使用的正确选择器或修正后的参数"}}}',
    '- completed=false when you could not finish the step; explain why in summary.',
    '- fix.paramsPatch: corrected params for the failed node so FUTURE runs work WITHOUT AI takeover. Only when confident; usually {"selector":"..."}. Omit when unsure.',
    `- You have ${parts.maxAttempts} attempts in total; this is attempt ${parts.attempt}.`,
  )
  return lines.join('\n')
}

/**
 * Parses the agent's reply into a verdict. The reply may contain prose before
 * the JSON; the LAST parseable JSON object wins. No parseable object, a
 * non-boolean `completed`, or any shape deviation degrades to
 * `completed: false` so a chatty agent can never fake a success.
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
      }
    } catch {
      /* try the next candidate */
    }
  }
  return {
    completed: false,
    summary: text.slice(0, 200).trim() || '（AI 未返回有效结论）',
  }
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
