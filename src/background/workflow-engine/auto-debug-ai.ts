/**
 * AI decision layer for the workflow auto-debugger.
 *
 * Given a failure context (graph + failing node + error + steps + page facts),
 * asks the active model provider for ONE structured repair decision and parses
 * it defensively. The heavy lifting — turning the decision into graph edits —
 * lives in the pure patch layer (`lib/workflow/auto-debug-patch`).
 *
 * The model is prompted for JSON only; any parse failure degrades to an
 * `unfixable` decision so a chatty model can never corrupt a workflow.
 *
 * @module background/workflow-engine/auto-debug-ai
 */
import { streamCompletion } from '../../lib/llm'
import { getSettings } from '../../lib/storage'
import type { DebugDecision, DebugFailureContext } from '../../lib/workflow/auto-debug-patch'
import { NoProviderError } from '../../lib/workflow/auto-debug-patch'
import type { WorkflowNode } from '../../lib/workflow/types'

/** Cap per string value shipped to the model so one node can't blow context. */
const VALUE_CAP = 200

const STRATEGIES: ReadonlySet<string> = new Set([
  'retry',
  'repair-params',
  'insert-branch',
  'insert-ai-agent',
  'remove-redundant',
  'unfixable',
])

function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  if (typeof fromData === 'string' && fromData) return fromData
  return node.label
}

/** JSON.stringify replacer that truncates long strings (applies recursively). */
function truncateStrings(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    typeof val === 'string' && val.length > VALUE_CAP ? `${val.slice(0, VALUE_CAP)}…` : val,
  )
}

/** Compact, size-capped view of the graph for the prompt. */
function graphSummary(workflow: DebugFailureContext['workflow']): string {
  const nodes = workflow.drawflow.nodes.map((node) => {
    const params = { ...(node.data ?? {}) } as Record<string, unknown>
    delete params['description']
    return {
      id: node.id,
      blockId: blockIdOf(node),
      label: node.label,
      description: node.data?.['description'],
      params,
    }
  })
  const edges = workflow.drawflow.edges.map((edge) => ({
    from: edge.source,
    to: edge.target,
    handle: edge.sourceHandle ?? '',
  }))
  return `Nodes: ${truncateStrings(nodes)}\nEdges: ${truncateStrings(edges)}`
}

/**
 * Builds the repair-decision prompt. English scaffolding (models follow it
 * reliably); the diagnosis is requested in Chinese because it is shown to the
 * user in the debug report.
 */
export function buildDebugPrompt(ctx: DebugFailureContext): string {
  const lines: string[] = []
  lines.push(
    'You are the autonomous debugging brain inside a browser-automation Chrome extension.',
    'A workflow (a directed graph of operator blocks) failed to run.',
    'Diagnose the failure and prescribe ONE minimal repair so the next run can succeed.',
    '',
    '## Workflow graph',
    graphSummary(ctx.workflow),
    '',
    '## Failure',
    `Error: ${ctx.error || '(no error text)'}`,
  )
  if (ctx.failingNodeId) {
    const node = ctx.workflow.drawflow.nodes.find((n) => n.id === ctx.failingNodeId)
    if (node) {
      lines.push(
        `Failed node: ${node.id} (blockId: ${blockIdOf(node)}, label: ${node.label})`,
        `Failed node params: ${truncateStrings(node.data ?? {})}`,
      )
    }
  }
  const steps = ctx.steps.slice(-30)
  if (steps.length > 0) {
    lines.push('', '## Recent run steps (oldest first)')
    for (const step of steps) lines.push(`- [${step.kind}] ${step.text}`)
  }
  const facts = ctx.pageFacts
  const factLines: string[] = []
  if (facts?.url) factLines.push(`url=${facts.url}`)
  if (facts?.title) factLines.push(`title=${facts.title}`)
  if (facts?.selectorMatches && Object.keys(facts.selectorMatches).length > 0) {
    factLines.push(`selector element counts now: ${JSON.stringify(facts.selectorMatches)}`)
  }
  if (factLines.length > 0) {
    lines.push('', '## Page facts at debug time (best effort)', ...factLines)
  }
  if (facts?.elements !== undefined && facts?.elements !== null) {
    lines.push(
      '',
      '## Page elements (inspected live on the page right now)',
      truncateStrings(facts.elements),
      '',
      'Interpretation: `target` is what the failed selector points at today (found=false means it matches nothing).',
      '`candidates` are elements whose tag/classes resemble the failed selector — a corrected selector usually exists among them.',
      '`interactive` lists the page\'s actionable elements (a/button/input/select/textarea) with generated CSS selectors.',
    )
  }
  lines.push(
    '',
    '## Available repair strategies (choose exactly one)',
    '- retry: the error looks TRANSIENT (timeout, network flake, element not rendered yet). Sets an Automa-style retry policy on the failed node. Provide retryTimes (1-5) and retryIntervalSec (1-30).',
    '- repair-params: a parameter is clearly stale/wrong (selector changed, URL changed, wrong variable name). Provide paramsPatch with the FULL corrected value for every key you patch (flat block params, e.g. {"selector": "...", "url": "..."}). When page elements were inspected, prefer a corrected selector taken from the inspected candidates over inventing one.',
    '- insert-branch: the page can be in TWO valid states and the flow should tolerate both. Splices an element-exists (or conditions) guard BEFORE the failed node: when the guard passes the original step runs, otherwise it either skips the step (onFalse: "skip") or delegates to an AI agent (onFalse: "ai-agent", provide agentPrompt). Provide selector (or variable/compare/value for a conditions guard).',
    '- insert-ai-agent: the page changed and the step needs dynamic, AI-driven handling (locate the new element, adapt to a redesign). Splices an AI agent step BEFORE the failed node; the agent sees a live page snapshot. Provide prompt (what the agent must do) and optionally selector/actOnPage.',
    '- remove-redundant: the graph contains clearly duplicated/redundant steps (identical consecutive blocks, duplicated delays or get-text, unreachable leftovers). Provide removeNodeIds with the node ids to DELETE; they are spliced out (predecessors reconnect to their default downstream). NEVER include the trigger/entry node.',
    '- unfixable: auth problems, missing data, missing capability, or anything you cannot fix confidently.',
    '',
    '## Rules',
    '- Prefer the MINIMAL change that plausibly fixes the failure.',
    '- Look at the failed node params AND the inspected page elements: a selector that matches 0 elements with a similar candidate present usually means repair-params with that candidate selector, or insert-branch when the element is optional.',
    '- LOGIC ADJUSTMENT: every constructive strategy (retry / repair-params / insert-branch / insert-ai-agent) may additionally carry "removeNodeIds" to delete steps that no longer make sense after the repair (a duplicated pre-step, a get-text of a removed element...). Use it to adjust the flow logic so it can COMPLETE; the trigger node is always protected.',
    '- Never retype a node (change its blockId) and never disable blocks.',
    '- diagnosis: ONE concise sentence in Chinese (它会被直接展示给用户).',
    '',
    '## Response format',
    'Respond with ONLY a JSON object — no markdown fence, no commentary:',
    '{"diagnosis":"...","strategy":"retry|repair-params|insert-branch|insert-ai-agent|remove-redundant|unfixable","retryTimes":3,"retryIntervalSec":2,"paramsPatch":{...},"branch":{"kind":"element-exists|conditions","selector":"...","variable":"...","compare":"exists|eql|contains|...","value":"...","onFalse":"skip|ai-agent","agentPrompt":"..."},"agent":{"prompt":"...","selector":"...","actOnPage":true},"alsoPatchParams":{...},"removeNodeIds":["id1"]}',
    'Include only the fields relevant to the chosen strategy.',
  )
  return lines.join('\n')
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/** Validates the model's branch payload into the patch-layer shape. */
function parseBranch(value: unknown): DebugDecision['branch'] {
  const raw = asRecord(value)
  if (!raw) return undefined
  const kind = raw['kind'] === 'conditions' ? 'conditions' : 'element-exists'
  const onFalse = raw['onFalse'] === 'ai-agent' ? 'ai-agent' : 'skip'
  return {
    kind,
    ...(asString(raw['selector']) ? { selector: asString(raw['selector']) } : {}),
    ...(asString(raw['findBy']) ? { findBy: asString(raw['findBy']) } : {}),
    ...(asString(raw['variable']) ? { variable: asString(raw['variable']) } : {}),
    ...(asString(raw['compare']) ? { compare: asString(raw['compare']) } : {}),
    ...(raw['value'] !== undefined ? { value: raw['value'] } : {}),
    onFalse,
    ...(asString(raw['agentPrompt']) ? { agentPrompt: asString(raw['agentPrompt']) } : {}),
  }
}

/** Validates the model's agent payload into the patch-layer shape. */
function parseAgent(value: unknown): DebugDecision['agent'] {
  const raw = asRecord(value)
  if (!raw) return undefined
  return {
    ...(asString(raw['prompt']) ? { prompt: asString(raw['prompt']) } : {}),
    ...(asString(raw['selector']) ? { selector: asString(raw['selector']) } : {}),
    ...(raw['actOnPage'] !== undefined ? { actOnPage: Boolean(raw['actOnPage']) } : {}),
    ...(asString(raw['variableName']) ? { variableName: asString(raw['variableName']) } : {}),
  }
}

/**
 * Parses the model's reply into a decision. Any deviation from the contract
 * (no JSON, unknown strategy, wrong shapes) degrades to `unfixable` with the
 * raw text as the diagnosis, so nothing silently corrupts the workflow.
 */
export function parseDecision(text: string): DebugDecision {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return {
      diagnosis: text.slice(0, 300) || 'AI 未返回有效决策',
      strategy: 'unfixable',
    }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return { diagnosis: text.slice(0, 300), strategy: 'unfixable' }
  }
  const strategy = STRATEGIES.has(String(parsed['strategy']))
    ? (String(parsed['strategy']) as DebugDecision['strategy'])
    : 'unfixable'
  return {
    diagnosis: asString(parsed['diagnosis']) || '（AI 未给出诊断）',
    strategy,
    ...(Number.isFinite(Number(parsed['retryTimes']))
      ? { retryTimes: Number(parsed['retryTimes']) }
      : {}),
    ...(Number.isFinite(Number(parsed['retryIntervalSec']))
      ? { retryIntervalSec: Number(parsed['retryIntervalSec']) }
      : {}),
    ...(asRecord(parsed['paramsPatch']) ? { paramsPatch: asRecord(parsed['paramsPatch']) } : {}),
    ...(parseBranch(parsed['branch']) ? { branch: parseBranch(parsed['branch']) } : {}),
    ...(parseAgent(parsed['agent']) ? { agent: parseAgent(parsed['agent']) } : {}),
    ...(asRecord(parsed['alsoPatchParams'])
      ? { alsoPatchParams: asRecord(parsed['alsoPatchParams']) }
      : {}),
    ...(asStringArray(parsed['removeNodeIds'])
      ? { removeNodeIds: asStringArray(parsed['removeNodeIds']) }
      : {}),
  }
}

/**
 * Asks the active provider for one repair decision. Throws `NoProviderError`
 * when no model is configured (the orchestrator turns that into a structured
 * "cannot debug" result instead of a crash).
 */
export async function aiDecide(
  ctx: DebugFailureContext,
  signal?: AbortSignal,
): Promise<DebugDecision> {
  const settings = await getSettings()
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
  if (!provider || !provider.apiKey.trim()) {
    throw new NoProviderError('未配置模型 provider / API Key，AI 调试不可用')
  }
  const result = await streamCompletion({
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: provider.model,
    messages: [{ role: 'user', content: buildDebugPrompt(ctx) }],
    headers: provider.headers,
    maxTokens: 1500,
    ...(signal ? { signal } : {}),
  })
  return parseDecision(result.content)
}
