/**
 * Agent validation and prompt composition.
 *
 * An *agent* is an active execution unit — an identity, a tool boundary, and
 * (for the supervisor) a delegation brief — whereas a {@link Skill} is a
 * passive instruction block injected into the active system prompt. Agents
 * may reference skills by name and reuse {@link renderSkillPrompt}, but this
 * module never touches the skill hot path.
 *
 * Like `lib/skills`, kept free of `chrome` APIs so every rule here is unit
 * testable in isolation.
 *
 * @module lib/agents
 */
import { MAX_INSTRUCTIONS_LENGTH, MAX_NAME_LENGTH, renderSkillPrompt } from './skills'
import { TOOL_META_BY_NAME } from './tool-catalog'
import type { Agent, AgentDomain, Skill } from './types'

/** A validation failure tied to the field that caused it. */
export interface AgentProblem {
  field: 'name' | 'instructions'
  /** Message key, resolved by the caller so errors follow the UI language. */
  code: 'nameRequired' | 'instructionsRequired' | 'nameTaken' | 'builtInReadOnly'
}

/** Longest delegation hint accepted (mirrors the skill description cap). */
export const MAX_DELEGATION_HINT_LENGTH = 300
/** Hard cap on the summary a sub-agent hands back to the supervisor. */
export const MAX_SUBAGENT_SUMMARY_CHARS = 1200
/** Default per-delegation model↔tool round cap. */
export const DEFAULT_AGENT_MAX_ROUNDS = 8
/** Bounds for the configurable per-agent round cap. */
export const MIN_AGENT_MAX_ROUNDS = 1
export const MAX_AGENT_MAX_ROUNDS = 20
/** Hard cap on delegations within a single supervisor turn. */
export const MAX_DELEGATIONS_PER_TURN = 4
/** A delegated task shorter than this is refused by the code-level gate. */
export const SMALL_TASK_CHAR_THRESHOLD = 200

const DOMAINS: readonly AgentDomain[] = [
  'search',
  'writing',
  'operations',
  'workflow',
  'analysis',
  'custom',
]

/**
 * Checks an agent against the other stored agents.
 *
 * Name uniqueness is enforced case-insensitively, for the same reason as
 * skills: the supervisor selects agents by name. Built-in agents are
 * read-only — the UI edits a user-owned copy instead.
 */
export function validateAgent(agent: Agent, existing: readonly Agent[]): AgentProblem[] {
  const problems: AgentProblem[] = []
  const name = agent.name.trim()
  const instructions = agent.instructions.trim()

  if (agent.builtIn === true) {
    problems.push({ field: 'name', code: 'builtInReadOnly' })
  }
  if (name.length === 0) problems.push({ field: 'name', code: 'nameRequired' })
  if (instructions.length === 0) {
    problems.push({ field: 'instructions', code: 'instructionsRequired' })
  }

  const clash = existing.some(
    (other) => other.id !== agent.id && other.name.trim().toLowerCase() === name.toLowerCase(),
  )
  if (name.length > 0 && clash) problems.push({ field: 'name', code: 'nameTaken' })

  return problems
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/**
 * Trims, clamps and canonicalises user input. Tool names are checked against
 * the shared tool catalog and unknown ones dropped, so a stale whitelist can
 * never advertise a non-existent tool; specialists can never gain delegation
 * power (`delegatable` is forced false for them) so recursive delegation is
 * structurally impossible regardless of what a hand-edited file claims.
 */
export function normalizeAgent(agent: Agent): Agent {
  const role = agent.role === 'supervisor' ? 'supervisor' : 'specialist'
  const domain = DOMAINS.includes(agent.domain) ? agent.domain : 'custom'
  const maxRounds = Number.isFinite(agent.maxRounds)
    ? Math.min(
        MAX_AGENT_MAX_ROUNDS,
        Math.max(MIN_AGENT_MAX_ROUNDS, Math.round(agent.maxRounds || DEFAULT_AGENT_MAX_ROUNDS)),
      )
    : DEFAULT_AGENT_MAX_ROUNDS
  return {
    ...agent,
    name: agent.name.trim().slice(0, MAX_NAME_LENGTH),
    delegationHint: agent.delegationHint.trim().slice(0, MAX_DELEGATION_HINT_LENGTH),
    instructions: agent.instructions.trim().slice(0, MAX_INSTRUCTIONS_LENGTH),
    // delegate_to_agent is a supervisor-only power: strip it even if a
    // hand-edited file or stale data put it in a specialist whitelist.
    tools: uniqueStrings(agent.tools).filter(
      (name) => TOOL_META_BY_NAME.has(name) && name !== 'delegate_to_agent',
    ),
    skillNames: uniqueStrings(agent.skillNames),
    role,
    domain,
    delegatable: role === 'supervisor' && agent.delegatable === true,
    maxRounds,
  }
}

/**
 * Renders the catalogue of specialist agents the supervisor may delegate to.
 *
 * Only name + delegation hint are included — never instruction bodies — for
 * the same token economy as {@link renderSkillCatalogue}: the supervisor does
 * not need a specialist's full prompt until it actually delegates. Agents
 * without a hint are omitted: the model would have nothing to match on.
 */
export function renderAgentCatalogue(agents: readonly Agent[]): string {
  const usable = agents.filter(
    (agent) => agent.role === 'specialist' && agent.delegationHint.trim() !== '',
  )
  if (usable.length === 0) return ''

  const lines = usable.map((agent) => `- ${agent.name}: ${agent.delegationHint.trim()}`)
  return [
    '## Specialist agents you can delegate to',
    '',
    'These specialist agents each own one kind of work and only see the task you',
    'hand them. Refer to one by its exact `agent` name in delegate_to_agent:',
    '',
    ...lines,
    '',
    'The "delegate" tool group is hidden by default: call',
    '`load_tools` with groups: ["delegate"] before the first delegation.',
  ].join('\n')
}

/**
 * The supervisor's delegation decision guide. Deliberately terse (~600
 * chars): it is appended to EVERY interactive turn, so every word is paid on
 * every round. The stance is "default to doing it yourself" — splitting is
 * the exception, and the code-level cost gate backs this up regardless of
 * whether the model obeys.
 */
export function renderSupervisorGuide(): string {
  return [
    '## Delegating to specialist agents',
    '',
    'You own the task and the final answer. DEFAULT: do it yourself with your',
    'current tools. Delegate ONLY for a BIG task — at least one of: 3+',
    'independently verifiable sub-goals; spans 2+ domains (search, writing,',
    'operations, …); or you estimate 8+ of your own tool calls. Never split a',
    'small task to look organized: splitting costs more tokens.',
    '',
    'Give a self-contained task, only the specific upstream outputs needed',
    '(never the whole transcript), and the expected deliverable. Run',
    'independent calls in parallel; dependent ones in order. You get back only',
    'a ≤1200-char summary plus artifact references — accept it, or reject ONCE',
    'with concrete fixes; after that change strategy or do it yourself. At most',
    '4 delegations per turn.',
  ].join('\n')
}

/**
 * Assembles the specialist's first (and only seeded) user message. Context is
 * fully isolated: the sub-agent starts from this one message, so it must say
 * everything the supervisor chose to hand over — plus an explicit reminder to
 * take its own page snapshot rather than assuming page state.
 */
export function renderDelegationPrompt(
  agent: Agent,
  task: string,
  upstream?: { context?: string; expects?: string },
): string {
  const context = upstream?.context?.trim()
  const expects = upstream?.expects?.trim()
  return [
    `You are "${agent.name}", a specialist agent handed ONE scoped task by the supervisor.`,
    'Stay inside your role and your advertised tools.',
    '',
    '# Task',
    task.trim(),
    '',
    '# Upstream context',
    context ||
      '(none provided — if you need the page, inspect it yourself with read_current_page/snapshot_page; do not assume state)',
    '',
    '# Expected deliverable',
    expects || 'The result requested by the task.',
    '',
    '# Rules',
    "- Work autonomously through your tool loop. Page reads and actions still need the user's approval via the panel — never bypass it.",
    '- You cannot delegate further: no delegation tool exists for you.',
    '- Your FINAL assistant message is the ONLY thing returned to the supervisor. Lead with the result; no preamble and no restating the task.',
    `- Hard cap ${MAX_SUBAGENT_SUMMARY_CHARS} characters. Be dense. Long deliverables (full drafts, lists over 10 items) go to a file with save_local when you have that tool; mention the filename instead of pasting.`,
    '- Cite sources as URLs. If you cannot fully finish, return what you have and state exactly what is missing.',
    '- Reply in the same language as the task.',
  ].join('\n')
}

/**
 * Builds the system prompt body of a specialist sub-agent. The project's base
 * operating rules stay in force (approvals, secret handling), then the
 * agent's own instructions and referenced skill prompts are appended — the
 * same "active skill last-ish" ordering the main loop uses.
 */
export function renderSubAgentSection(agent: Agent, skills: readonly Skill[]): string {
  const parts = [
    `## ACTING AS SPECIALIST AGENT — ${agent.name}`,
    '',
    `Role: ${agent.domain} specialist. The conversation below is a single task delegated to you;`,
    'apply your instructions to it directly.',
    '',
    '---',
    agent.instructions,
    '---',
  ]
  for (const skillName of agent.skillNames) {
    const skill = skills.find(
      (entry) => entry.name.trim().toLowerCase() === skillName.trim().toLowerCase(),
    )
    if (skill) parts.push(renderSkillPrompt(skill))
  }
  return parts.join('\n')
}

/** Hard-clips a sub-agent report to the summary budget; never throws. */
export function truncateSubAgentSummary(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_SUBAGENT_SUMMARY_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_SUBAGENT_SUMMARY_CHARS)}…[truncated]`
}

/**
 * The code-level small-task gate (gate 2 of the delegation design).
 *
 * Returns a refusal reason when a delegation should be short-circuitted with
 * ZERO model calls: the task text is tiny AND every tool the specialist can
 * use is already available to the supervisor right now, so handing it off
 * cannot buy anything but overhead. An empty whitelist means "inherit all
 * tools", which is trivially a subset of the parent's set.
 */
export function smallTaskRefusal(
  task: string,
  agentTools: readonly string[],
  parentAvailableTools: ReadonlySet<string>,
): string | null {
  if (task.trim().length >= SMALL_TASK_CHAR_THRESHOLD) return null
  const effective = agentTools.length === 0 ? [...parentAvailableTools] : agentTools
  if (effective.every((name) => parentAvailableTools.has(name))) {
    return 'task is small; do it yourself with your current tools'
  }
  return null
}
