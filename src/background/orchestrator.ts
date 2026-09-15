/**
 * Multi-agent orchestration: supervisor → specialist delegation.
 *
 * A delegation runs a FULL {@link runAgentTurn} loop with an isolated history
 * and a tool boundary, then hands the supervisor a hard-clipped summary plus
 * artifact references. The sub-agent's transcript is dropped the moment it
 * finishes, which is what keeps context isolated (sub-agent page reads are not
 * covered by `retireOldPageReads` — whole-history disposal is the reclamation
 * mechanism, see the design plan).
 *
 * Safety invariants:
 * - The sub-agent reuses the parent's `confirm` and window scope: approvals
 *   and page isolation are never weakened by delegation.
 * - Sub-agents never receive the "delegate" tool group, so recursion is
 *   structurally impossible.
 * - Every gate (budget, small-task, retry) is enforced IN CODE here; the
 *   supervisor's prompt guide only nudges, it does not decide.
 *
 * @module background/orchestrator
 */
import type { Agent } from '../lib/types'
import type { WireMessage } from '../lib/llm'
import {
  MAX_DELEGATIONS_PER_TURN,
  renderDelegationPrompt,
  smallTaskRefusal,
  truncateSubAgentSummary,
} from '../lib/agents'
import { agentSlug } from '../lib/agents-import'
import { advertiseTools, runAgentTurn, type AgentDeps, type ToolContext } from './agent'

/** A reference-shaped deliverable the supervisor can pull on demand. */
export interface SubAgentArtifact {
  /** `workflow` is reserved for generated-workflow references. */
  kind: 'url' | 'file' | 'text' | 'workflow'
  ref: string
  label?: string
}

/** The compressed report returned to the supervisor. */
export interface SubAgentResult {
  ok: boolean
  agent: string
  status: 'completed' | 'partial' | 'failed'
  /** ≤ MAX_SUBAGENT_SUMMARY_CHARS, hard-clipped. */
  summary: string
  artifacts: SubAgentArtifact[]
  /** Model↔tool rounds the sub-agent used. */
  rounds: number
  error?: string
}

/**
 * A refusal that never started a sub-agent (budget/small-task/retry gates).
 * Returned as `status: 'refused'` so the supervisor corrects itself; it costs
 * zero LLM calls beyond the supervisor's own.
 */
export interface DelegationRefusal {
  ok: true
  agent: string
  status: 'refused'
  reason: string
}

export type DelegationOutcome = SubAgentResult | DelegationRefusal

/**
 * Mutable per-turn delegation bookkeeping, held on the supervisor's
 * ToolContext. In-memory only (like the loaded-tool-groups store): losing it
 * after worker eviction merely resets the budgets.
 */
export interface DelegationRuntime {
  /** All stored agents, resolved once per turn. */
  agents: Agent[]
  /** Delegations started this turn; capped at MAX_DELEGATIONS_PER_TURN. */
  count: number
  /** agent+task → prior attempts; same target retried at most once. */
  attempts: Map<string, number>
}

function argsString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Tools the supervisor has advertised right now, for the overlap gate. */
async function parentToolNames(deps: AgentDeps, ctx: ToolContext): Promise<Set<string>> {
  const mode = await deps.getMode()
  return new Set(
    advertiseTools({
      mode,
      disabled: ctx.disabled,
      loadedGroups: ctx.loadedGroups,
    }).map((tool) => tool.function.name),
  )
}

/** Cheap stable key for the same-target retry cap. */
function attemptKey(agentName: string, task: string): string {
  return `${agentName.trim().toLowerCase()}|${task.trim().toLowerCase().slice(0, 400)}`
}

function failed(agent: string, error: string): SubAgentResult {
  return {
    ok: false,
    agent,
    status: 'failed',
    summary: '',
    artifacts: [],
    rounds: 0,
    error,
  }
}

/**
 * Entry point for the `delegate_to_agent` tool. Enforces every gate in code,
 * then runs the isolated sub-agent loop. Expected failures (unknown agent,
 * sub-agent error) come back as results so the supervisor can react; only
 * cancellation throws.
 */
export async function runDelegateTool(
  args: Record<string, unknown>,
  deps: AgentDeps,
  ctx: ToolContext,
): Promise<DelegationOutcome> {
  const runtime = ctx.delegation
  const agentName = argsString(args, 'agent')

  // Unattended runs build no delegation runtime; the group may still have
  // been loaded, so answer instead of executing anything.
  if (!runtime) {
    return failed(agentName || '(unknown)', 'Delegation is not available in this run.')
  }

  const task = argsString(args, 'task')

  // Gate 3 (turn budget) — checked first: past the cap, nothing else matters.
  if (runtime.count >= MAX_DELEGATIONS_PER_TURN) {
    return {
      ok: true,
      agent: agentName || '(unknown)',
      status: 'refused',
      reason: 'delegation budget exhausted: at most 4 delegations per turn; do the rest yourself',
    }
  }

  if (!agentName || !task) {
    return failed(
      agentName || '(unknown)',
      'Both "agent" (exact specialist name) and "task" (a self-contained instruction) are required.',
    )
  }

  const target = runtime.agents.find(
    (entry) =>
      entry.role === 'specialist' && entry.name.trim().toLowerCase() === agentName.toLowerCase(),
  )
  if (!target) {
    const available = runtime.agents
      .filter((entry) => entry.role === 'specialist')
      .map((entry) => entry.name)
    return failed(
      agentName,
      `No specialist agent named "${agentName}". Available: ${available.join(', ') || '(none)'}.`,
    )
  }

  // Gate 2 (code-level small-task short circuit): zero LLM cost. A tiny task
  // the supervisor could do with tools it already has must not be handed off,
  // regardless of what the prompt guide said.
  const smallReason = smallTaskRefusal(task, target.tools, await parentToolNames(deps, ctx))
  if (smallReason) {
    return { ok: true, agent: target.name, status: 'refused', reason: smallReason }
  }

  // Retry cap: the SAME agent+task pair runs at most twice. The second reject
  // forces a strategy change instead of a review/retry token loop.
  const key = attemptKey(target.name, task)
  const prior = runtime.attempts.get(key) ?? 0
  if (prior >= 2) {
    return {
      ok: true,
      agent: target.name,
      status: 'refused',
      reason:
        'this exact task was already delegated to this agent once; change strategy or do it yourself',
    }
  }
  runtime.attempts.set(key, prior + 1)
  runtime.count += 1

  const context = argsString(args, 'context')
  const expects = argsString(args, 'expects')
  const seq = runtime.count

  try {
    return await runSubAgent({
      agent: target,
      task,
      ...(context ? { context } : {}),
      ...(expects ? { expects } : {}),
      seq,
      parent: deps,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    return failed(target.name, error instanceof Error ? error.message : String(error))
  }
}

// --- Sub-agent execution ------------------------------------------------------

export interface RunSubAgentOptions {
  agent: Agent
  task: string
  context?: string
  expects?: string
  /** 1-based delegation sequence number, used to namespace the conversation. */
  seq: number
  parent: AgentDeps
}

/** Pulls reference-shaped results out of the sub-agent's discarded history. */
function collectArtifacts(history: readonly WireMessage[]): SubAgentArtifact[] {
  const artifacts: SubAgentArtifact[] = []
  const seen = new Set<string>()
  const add = (artifact: SubAgentArtifact): void => {
    const key = `${artifact.kind}:${artifact.ref}`
    if (seen.has(key)) return
    seen.add(key)
    artifacts.push(artifact)
  }
  for (const message of history) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue
    const name = (message as { name?: string }).name ?? ''
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(message.content) as Record<string, unknown>
    } catch {
      continue
    }
    if (parsed['ok'] === false || parsed['error']) continue
    if (name === 'save_local') {
      const ref = String(parsed['savedPath'] ?? parsed['filename'] ?? '')
      if (ref) add({ kind: 'file', ref, label: 'Saved file' })
    } else if (name === 'open_url' || name === 'tab_new') {
      const ref = String(parsed['url'] ?? '')
      if (ref) add({ kind: 'url', ref, label: 'Opened page' })
    }
  }
  return artifacts
}

/** Last assistant prose in the sub-agent's history ('' when none). */
function finalAssistantText(history: readonly WireMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]
    if (!message) continue
    if (message.role === 'assistant' && typeof message.content === 'string') {
      return message.content
    }
  }
  return ''
}

function hasToolCalls(message: WireMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false
  const calls = (message as { tool_calls?: unknown }).tool_calls
  return Array.isArray(calls) && calls.length > 0
}

/**
 * Runs one specialist agent on one delegated task with an isolated history.
 * The child conversation id is namespaced (`<parent>:agent:<slug>:<n>`) so the
 * conversation-keyed loaded-tool-group store cannot leak between the
 * supervisor and its sub-agents (or between sibling sub-agents).
 */
export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const { agent, parent, seq } = options
  const childConversationId = `${parent.conversationId}:agent:${agentSlug(agent.name)}:${seq}`

  const history: WireMessage[] = [
    { role: 'user', content: renderDelegationPrompt(agent, options.task, options) },
  ]

  // Muted deps: progress gets out as short [name]-prefixed status lines, but
  // streamed tokens and per-tool payloads never flow back into the
  // supervisor's context. confirm is reused verbatim — approvals are not
  // muted or bypassed.
  const childDeps: AgentDeps = {
    ...parent,
    conversationId: childConversationId,
    subAgent: { agent, seq },
    // No delegation context: the child's ToolContext must not inherit the
    // parent's runtime, and specialists never get the delegate group.
    enableDelegation: false,
    getMaxToolRounds: async () => agent.maxRounds,
    send: (message) => {
      if (message.type === 'tool.start') {
        parent.send({ type: 'status', text: `[${agent.name}] ${message.name}` })
      } else if (message.type === 'status') {
        parent.send({ type: 'status', text: `[${agent.name}] ${message.text}` })
      }
      // delta / usage / phase / tool.result: deliberately dropped.
    },
  }

  await runAgentTurn(history, childDeps)

  // A loop whose LAST assistant turn still carried tool calls was cut off by
  // the round cap without a final report — partial at best.
  const lastAssistantIndex = (): number => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]?.role === 'assistant') return i
    }
    return -1
  }
  const lastIdx = lastAssistantIndex()
  const endedMidTools = hasToolCalls(history[lastIdx])
  const rounds = history.filter((message: WireMessage) => hasToolCalls(message)).length

  const report = truncateSubAgentSummary(finalAssistantText(history))
  const status: SubAgentResult['status'] = endedMidTools
    ? 'partial'
    : report
      ? 'completed'
      : 'failed'

  return {
    ok: status !== 'failed',
    agent: agent.name,
    status,
    summary: report,
    artifacts: collectArtifacts(history),
    rounds,
    ...(status === 'failed'
      ? { error: 'the sub-agent finished without a report before its round cap' }
      : {}),
  }
}
