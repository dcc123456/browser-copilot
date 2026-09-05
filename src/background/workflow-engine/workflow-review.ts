/**
 * AI node review for conversation-generated workflows (the save-card
 * curator).
 *
 * The panel sends a freshly generated workflow; this module cuts it into
 * steps (`reviewStepsOf`), asks the active model provider — guided by the
 * operator guide — to judge which steps the replay genuinely needs, and
 * parses the verdict defensively. Verdicts never drop a step unless the
 * model EXPLICITLY marks it (a missing `keep` is a keep), so a chatty or
 * broken model can never silently delete real steps.
 *
 * The call pattern mirrors `auto-debug-ai.ts`: prompt builder and parser are
 * exported pure (unit-testable); `reviewWorkflow` is the only side-effectful
 * entry.
 *
 * @module background/workflow-engine/workflow-review
 */
import { streamCompletion } from '../../lib/llm'
import { getSettings } from '../../lib/storage'
import { OPERATOR_GUIDE } from '../../lib/workflow/operator-guide'
import {
  reviewStepsOf,
  type ReviewStep,
  type WorkflowReview,
  type WorkflowReviewVerdict,
} from '../../lib/workflow/review-patch'
import type { Workflow } from '../../lib/workflow/types'

/** Cap per string value shipped to the model so one node can't blow context. */
const VALUE_CAP = 200

/** Hard cap on steps sent for review; the tail stays unjudged (= kept). */
const MAX_REVIEW_STEPS = 40

/**
 * One-shot review budget: 5 minutes, aligned with the debug AI budget.
 * Generous on purpose — the user explicitly clicked "save as workflow" and is
 * waiting on the dialog, while a thinking model can legitimately spend
 * minutes on the guide + step list before any content. A timed-out or
 * aborted review keeps every step (safe direction), reports the reason, and
 * can be retried from the dialog.
 */
const REVIEW_TIMEOUT_MS = 5 * 60_000

/** The steps that participate in the review (id set the parser accepts). */
export function reviewableSteps(workflow: Workflow): ReviewStep[] {
  return reviewStepsOf(workflow).slice(0, MAX_REVIEW_STEPS)
}

/** JSON.stringify replacer that truncates long strings (applies recursively). */
function truncateStrings(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    typeof val === 'string' && val.length > VALUE_CAP ? `${val.slice(0, VALUE_CAP)}…` : val,
  )
}

/**
 * Builds the review prompt. English scaffolding (models follow it reliably);
 * the summary and reasons are requested in Chinese because they are shown to
 * the user on the save card.
 */
export function buildReviewPrompt(workflow: Workflow): string {
  const steps = reviewableSteps(workflow)
  const lines: string[] = []
  lines.push(
    'You are the workflow curator inside a browser-automation Chrome extension.',
    "A workflow was just generated from ONE conversation's recorded actions.",
    'Judge every step: keep only what the replay genuinely needs; exploratory and one-off actions are garbage and must be dropped.',
    '',
    '## Domain knowledge (operator guide)',
    OPERATOR_GUIDE,
    '',
    '## Steps to judge (oldest first; the `id` is the verdict key)',
  )
  steps.forEach((step, index) => {
    const description = step.description ? ` 描述: ${step.description}` : ''
    lines.push(`${index + 1}. id=${step.id} block=${step.blockId}${description}`)
    const params = { ...step.params } as Record<string, unknown>
    delete params['description']
    lines.push(`   params: ${truncateStrings(params)}`)
    if (step.satelliteSummary.length > 0) {
      lines.push(
        `   附属机制节点（随本步骤同去留，勿单独评判）: ${step.satelliteSummary.join('；')}`,
      )
    }
  })
  if (reviewStepsOf(workflow).length > steps.length) {
    lines.push(`(仅前 ${steps.length} 步参与审查，其余步骤一律保留)`)
  }
  lines.push(
    '',
    '## Rules',
    '- Judge each step by the 节点取舍 standard in the guide: drop exploratory clicks, back-and-forth navigation, dead-end detours, one-off reads whose result no later step consumes, and repeats of the same target (keep the final effective one).',
    '- When uncertain, KEEP the step: a false drop breaks the replay, a false keep is merely noise.',
    '- The first step (trigger) is never in the list and can never be dropped.',
    '- summary: 中文、最多 3 句 —— 这段会话做了什么、你剔除了哪些步骤及原因。会原样展示给用户。',
    '- reason: 中文、一个短句，只给被剔除的步骤。',
    '',
    '## Response format',
    'Respond with ONLY a JSON object — no markdown fence, no commentary:',
    '{"summary":"…","steps":[{"id":"<step id>","keep":true},{"id":"<step id>","keep":false,"reason":"…"}]}',
    'Include EVERY step id listed above exactly once.',
  )
  return lines.join('\n')
}

/**
 * Removes reasoning-model thinking blocks so the JSON search in
 * {@link parseReview} cannot latch onto a brace inside the model's chain of
 * thought. Handles both `<think>…</think>` pairs (repeated, case-insensitive)
 * and a lone closing tag — thinking cut off mid-stream by the timeout — which
 * drops everything before it.
 */
export function stripThinkBlocks(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const lastClose = out.toLowerCase().lastIndexOf('</think>')
  if (lastClose >= 0) out = out.slice(lastClose + '</think>'.length)
  return out
}

/**
 * Parses the model's reply. Any deviation (no JSON, wrong shapes, unknown
 * step ids, zero usable verdicts) degrades to `null` = "review unavailable";
 * a verdict whose `keep` is not EXPLICITLY false is a keep, so a sloppy
 * reply can only ever err on the safe side.
 */
export function parseReview(text: string, validIds: ReadonlySet<string>): WorkflowReview | null {
  const cleaned = stripThinkBlocks(text)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const summary = typeof parsed['summary'] === 'string' ? parsed['summary'].trim() : ''
  const rawSteps = Array.isArray(parsed['steps']) ? parsed['steps'] : []
  const steps: WorkflowReviewVerdict[] = []
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const id = entry['id']
    if (typeof id !== 'string' || !validIds.has(id)) continue
    const reason =
      typeof entry['reason'] === 'string' && entry['reason'].trim()
        ? entry['reason'].trim()
        : undefined
    steps.push({ id, keep: entry['keep'] !== false, ...(reason ? { reason } : {}) })
  }
  if (steps.length === 0) return null
  return { summary: summary || '（AI 未给出总结）', steps }
}

/**
 * Reviews the workflow with the active provider.
 *
 * Returns `null` only for the CLEAN "nothing to review" outcomes: no provider
 * configured, or the workflow has no reviewable steps. Every real failure —
 * timeout, unreachable/failed endpoint, unusable reply — THROWS so the caller
 * can surface WHY the review is unavailable instead of a bare "unavailable"
 * hint (the panel still keeps every step either way).
 */
/**
 * Run the AI review. Streams PROGRESS to `onLog` while the request is in
 * flight — model chosen, first tokens, verdicts arriving — so the panel's
 * review dialog shows a live step log instead of a silent wait. A null
 * return means review is unavailable (no provider / nothing to review) and
 * the caller keeps every step; a thrown error carries the reason.
 */
export async function reviewWorkflow(
  workflow: Workflow,
  onLog?: (text: string) => void,
): Promise<WorkflowReview | null> {
  const settings = await getSettings()
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
  if (!provider || !provider.apiKey.trim()) return null
  const steps = reviewableSteps(workflow)
  if (steps.length === 0) return null
  onLog?.(`模型：${provider.model} · 正在审查 ${steps.length} 个步骤…`)
  let content: string
  let streamed = ''
  let loggedVerdicts = 0
  let sawFirstToken = false
  try {
    const result = await streamCompletion(
      {
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: provider.model,
        messages: [{ role: 'user', content: buildReviewPrompt(workflow) }],
        headers: provider.headers,
        // No hard max_tokens cap (unlike the old 1500): a thinking model spends
        // that budget on reasoning before emitting any content, truncating
        // the verdict JSON into unparseable noise — the "review always
        // unavailable" bug. The provider's own default applies, as on the agent
        // path; the timeout above bounds the wait.
        signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
      },
      {
        // Live progress: every verdict object in the streaming JSON carries
        // exactly one `"id":` key, so counting those in the accumulated
        // content tracks how many verdicts have arrived — without parsing
        // partial JSON. onText fires for content deltas only (no reasoning).
        onText: (delta) => {
          streamed += delta
          if (!sawFirstToken) {
            sawFirstToken = true
            onLog?.('模型开始返回判决…')
          }
          const seen = (streamed.match(/"id"/g) ?? []).length
          if (seen > loggedVerdicts) {
            loggedVerdicts = seen
            onLog?.(`已收到 ${seen}/${steps.length} 个步骤的判决…`)
          }
        },
      },
    )
    content = result.content
  } catch (error) {
    console.warn('[workflow-review] request failed:', error)
    const err = error as Error
    // Timeout / mid-stream abort. In an MV3 service worker an aborted
    // response stream surfaces as "BodyStreamBuffer was aborted" rather than
    // the abort reason, so match that text too and report one clear,
    // retryable failure instead of raw internals.
    if (
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      /timed?\s*out|abort/i.test(err?.message ?? '')
    ) {
      throw new Error(
        `AI 审查请求超时或被中断（预算 ${REVIEW_TIMEOUT_MS / 60_000} 分钟），可点击「重试审查」再试一次。`,
      )
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
  const review = parseReview(content, new Set(steps.map((step) => step.id)))
  if (!review) {
    // Visible in the service-worker console; also thrown so the panel's
    // unavailable hint can carry the reason.
    console.warn('[workflow-review] unusable reply:', content.slice(0, 300))
    throw new Error(
      `The model reply contained no usable review verdict. Reply head: ${content.slice(0, 120) || '(empty)'}`,
    )
  }
  return review
}
