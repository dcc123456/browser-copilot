/**
 * Agent import / export helpers — the agent counterpart of `skills-import`.
 *
 * Reuses that module's parsers (JSON / the minimal YAML subset / Markdown
 * frontmatter) rather than carrying a second YAML parser. The one format
 * constraint this adds: `tools` and `skills` are persisted as COMMA-SEPARATED
 * STRINGS in the frontmatter, because the supported YAML subset has no nested
 * arrays. JSON imports may still use real arrays.
 *
 * @module lib/agents-import
 */
import {
  DEFAULT_AGENT_MAX_ROUNDS,
  normalizeAgent,
  validateAgent,
  type AgentProblem,
} from './agents'
import {
  parseJsonSkillsText,
  parseMarkdownSkillsFileText,
  parseSkillsFiles,
  parseYamlSkillsText,
  yamlScalar,
} from './skills-import'
import type { Agent, AgentDomain, AgentRole } from './types'

// Re-exported under an agent name so callers read agent files with the exact
// same File dispatch the skills tab uses; the implementation is
// format-generic (extension/content sniffing only).
export { parseSkillsFiles as parseAgentFiles }

const NAME_ALIASES = ['name', 'title', 'agentName', 'agent_name'] as const
const HINT_ALIASES = [
  'delegationHint',
  'delegation_hint',
  'description',
  'desc',
  'summary',
  'about',
  'tagline',
] as const
const INSTR_ALIASES = [
  'instructions',
  'instruction',
  'prompt',
  'content',
  'body',
  'text',
  'system_prompt',
  'systemPrompt',
  'system',
] as const
const TOOLS_ALIASES = ['tools', 'toolNames', 'tool_names'] as const
const SKILLS_ALIASES = ['skillNames', 'skill_names', 'skills'] as const
const ROLE_ALIASES = ['role'] as const
const DOMAIN_ALIASES = ['domain'] as const
const DELEGATABLE_ALIASES = ['delegatable', 'canDelegate', 'can_delegate'] as const

function pickString(raw: Record<string, unknown>, aliases: readonly string[]): string {
  for (const key of aliases) {
    if (key in raw) {
      const v = raw[key]
      if (typeof v === 'string') return v
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    }
  }
  return ''
}

function pickBoolean(raw: Record<string, unknown>, aliases: readonly string[]): boolean {
  for (const key of aliases) {
    if (key in raw) {
      const v = raw[key]
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase()
        if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
        if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
      }
    }
  }
  return false
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** A list field that may arrive as a JSON array OR a comma-separated string. */
function pickList(raw: Record<string, unknown>, aliases: readonly string[]): string[] {
  for (const key of aliases) {
    if (!(key in raw)) continue
    const v = raw[key]
    if (Array.isArray(v)) return v.filter((item): item is string => typeof item === 'string')
    if (typeof v === 'string') return v.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
}

function newAgentId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `imp-a-${ts}-${rand}`
}

/**
 * Filesystem-safe slug — the folder name for `agents/<slug>/AGENT.md`. Same
 * rules as the skill slug so the two directories sort and sanitize alike.
 */
export function agentSlug(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'agent'
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_') || 'agent'
}

/** Stable id for an AGENT.md that omits one (hand-authored files). */
function derivedAgentId(name: string): string {
  return `agent-${agentSlug(name)}`
}

const ROLES: readonly AgentRole[] = ['supervisor', 'specialist']
const DOMAINS: readonly AgentDomain[] = [
  'search',
  'writing',
  'operations',
  'workflow',
  'analysis',
  'custom',
]

/**
 * Maps one loosely-shaped import object to an Agent, or null when the input is
 * clearly not an agent (no name/hint/instructions produced by any alias).
 */
export function mapAliasedToAgent(raw: unknown): Agent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const name = pickString(obj, NAME_ALIASES)
  const delegationHint = pickString(obj, HINT_ALIASES)
  const instructions = pickString(obj, INSTR_ALIASES)
  if (name.length === 0 && delegationHint.length === 0 && instructions.length === 0) {
    return null
  }
  const roleRaw = pickString(obj, ROLE_ALIASES).trim().toLowerCase()
  const role: AgentRole = ROLES.includes(roleRaw as AgentRole) ? (roleRaw as AgentRole) : 'specialist'
  const domainRaw = pickString(obj, DOMAIN_ALIASES).trim().toLowerCase()
  const domain: AgentDomain = DOMAINS.includes(domainRaw as AgentDomain)
    ? (domainRaw as AgentDomain)
    : 'custom'
  const createdAt = coerceNumber(obj['createdAt']) ?? Date.now()
  const updatedAt = coerceNumber(obj['updatedAt']) ?? createdAt
  const id =
    typeof obj['id'] === 'string' && (obj['id'] as string).length > 0
      ? (obj['id'] as string)
      : newAgentId()
  const agent: Agent = {
    id,
    name,
    role,
    domain,
    delegationHint,
    instructions,
    tools: pickList(obj, TOOLS_ALIASES),
    skillNames: pickList(obj, SKILLS_ALIASES),
    delegatable: role === 'supervisor' && pickBoolean(obj, DELEGATABLE_ALIASES),
    maxRounds: coerceNumber(obj['maxRounds']) ?? DEFAULT_AGENT_MAX_ROUNDS,
    createdAt,
    updatedAt,
  }
  return agent
}

// --- Batch validation -------------------------------------------------------

export interface AgentImportProblem {
  index: number
  raw: unknown
  problems: Array<AgentProblem | { field: 'parse'; code: 'parseFailed' }>
}

export interface AgentImportBatchResult {
  saved: Agent[]
  problems: AgentImportProblem[]
}

/**
 * Maps, normalizes and validates a parsed raw list. The accumulating scratch
 * list makes a single import unable to create duplicate names against itself.
 */
export function importAgentsBatch(raws: unknown[], existing: readonly Agent[]): AgentImportBatchResult {
  const saved: Agent[] = []
  const problems: AgentImportProblem[] = []
  const accumulated: Agent[] = existing.slice()

  raws.forEach((raw, index) => {
    const mapped = mapAliasedToAgent(raw)
    if (!mapped) {
      problems.push({ index, raw, problems: [{ field: 'parse', code: 'parseFailed' }] })
      return
    }
    const normalized = normalizeAgent(mapped)
    if (normalized.name.length === 0) {
      problems.push({ index, raw, problems: [{ field: 'name', code: 'nameRequired' }] })
      return
    }
    if (normalized.instructions.length === 0) {
      problems.push({
        index,
        raw,
        problems: [{ field: 'instructions', code: 'instructionsRequired' }],
      })
      return
    }
    const issues = validateAgent(normalized, accumulated)
    if (issues.length > 0) {
      problems.push({ index, raw, problems: issues })
      return
    }
    saved.push(normalized)
    accumulated.push(normalized)
  })

  return { saved, problems }
}

// --- Export -----------------------------------------------------------------

/**
 * Serialises all agents as an indented JSON array. Ids/timestamps are stripped
 * so re-import regenerates them, keeping round-trip behaviour stable.
 */
export function exportAgentsJson(agents: readonly Agent[]): string {
  const stripped = agents.map((agent) => ({
    name: agent.name,
    role: agent.role,
    domain: agent.domain,
    delegationHint: agent.delegationHint,
    instructions: agent.instructions,
    tools: agent.tools,
    skillNames: agent.skillNames,
    delegatable: agent.delegatable,
    maxRounds: agent.maxRounds,
  }))
  return JSON.stringify(stripped, null, 2)
}

// --- AGENT.md (folder-per-agent) serialization ------------------------------

/**
 * Serialises an agent to `agents/<slug>/AGENT.md`: YAML frontmatter (list
 * fields as comma-separated strings, the subset's only encodable shape) plus
 * the instruction body. Generic agent readers ignore the extra identity keys.
 */
export function agentToMarkdown(agent: Agent): string {
  const header = [
    '---',
    `name: ${yamlScalar(agent.name)}`,
    `role: ${agent.role}`,
    `domain: ${agent.domain}`,
    `delegationHint: ${yamlScalar(agent.delegationHint)}`,
    `tools: ${yamlScalar(agent.tools.join(', '))}`,
    `skills: ${yamlScalar(agent.skillNames.join(', '))}`,
    `delegatable: ${agent.delegatable}`,
    `maxRounds: ${agent.maxRounds}`,
    `id: ${yamlScalar(agent.id)}`,
    `createdAt: ${agent.createdAt}`,
    `updatedAt: ${agent.updatedAt}`,
    '---',
  ].join('\n')
  const body = agent.instructions.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return `${header}\n\n${body}\n`
}

/** Parses an `AGENT.md` back into an Agent; null when the text is not valid. */
export function agentFromMarkdown(text: string): Agent | null {
  const parsed = parseMarkdownSkillsFileText(text)
  if (!parsed.ok || parsed.raws.length === 0) return null
  const raw = parsed.raws[0]
  const mapped = mapAliasedToAgent(raw)
  if (!mapped) return null
  const obj = raw as Record<string, unknown>
  const id =
    typeof obj['id'] === 'string' && (obj['id'] as string).trim()
      ? (obj['id'] as string).trim()
      : derivedAgentId(mapped.name)
  const createdAt = coerceNumber(obj['createdAt']) ?? mapped.createdAt
  const updatedAt = coerceNumber(obj['updatedAt']) ?? createdAt
  return { ...mapped, id, createdAt, updatedAt }
}

/** Dispatches one text body by extension, the agent counterpart of the skill parser. */
export function parseAgentFileText(
  filename: string,
  text: string,
): { ok: boolean; raws: unknown[]; from: 'json' | 'yaml' | 'md' | 'unknown' } {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.json')) return { ...parseJsonSkillsText(text), from: 'json' }
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return { ...parseYamlSkillsText(text), from: 'yaml' }
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    const r = parseMarkdownSkillsFileText(text)
    return { ok: r.ok, raws: r.raws, from: 'md' }
  }
  const trimmed = text.replace(/^\s*/, '')
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return { ...parseJsonSkillsText(text), from: 'json' }
  }
  const md = parseMarkdownSkillsFileText(text)
  if (md.ok) return { ok: true, raws: md.raws, from: 'md' }
  return { ...parseYamlSkillsText(text), from: 'yaml' }
}
