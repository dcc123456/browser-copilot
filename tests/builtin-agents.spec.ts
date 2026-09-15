import { describe, expect, it } from 'vitest'
import { BUILT_IN_AGENTS, BUILT_IN_SUPERVISOR_ID } from '../src/lib/builtin-agents'
import { normalizeAgent } from '../src/lib/agents'
import { TOOLS, TOOL_GROUPS } from '../src/background/agent'

/**
 * Built-in agents must always load: unique ids/names, valid tool whitelists,
 * and exactly one non-delegating specialist set plus one supervisor. A typo in
 * a tool name would otherwise silently shrink an agent's capabilities after
 * normalization.
 */
describe('built-in agents', () => {
  it('ships exactly six agents', () => {
    expect(BUILT_IN_AGENTS).toHaveLength(6)
  })

  it('has unique ids and names', () => {
    const ids = BUILT_IN_AGENTS.map((agent) => agent.id)
    const names = BUILT_IN_AGENTS.map((agent) => agent.name.toLowerCase())
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names every whitelisted tool in TOOLS or a TOOL_GROUPS member', () => {
    const known = new Set<string>([
      ...TOOLS.map((tool) => tool.function.name),
      ...Object.values(TOOL_GROUPS).flat(),
    ])
    for (const agent of BUILT_IN_AGENTS) {
      for (const toolName of agent.tools) {
        expect(known.has(toolName), `${agent.name} -> ${toolName}`).toBe(true)
      }
    }
  })

  it('references skills that exist... at least with valid names (non-empty)', () => {
    for (const agent of BUILT_IN_AGENTS) {
      for (const skillName of agent.skillNames) {
        expect(skillName.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('normalizes without dropping any whitelisted tool', () => {
    for (const agent of BUILT_IN_AGENTS) {
      const normalized = normalizeAgent(agent)
      expect(normalized.tools).toEqual(agent.tools)
    }
  })

  it('has exactly one delegatable supervisor; specialists never delegate', () => {
    const supervisors = BUILT_IN_AGENTS.filter((agent) => agent.role === 'supervisor')
    expect(supervisors).toHaveLength(1)
    expect(supervisors[0]!.id).toBe(BUILT_IN_SUPERVISOR_ID)
    expect(supervisors[0]!.delegatable).toBe(true)
    for (const specialist of BUILT_IN_AGENTS.filter((agent) => agent.role === 'specialist')) {
      expect(specialist.delegatable).toBe(false)
    }
  })

  it('carries a delegation hint on every specialist', () => {
    for (const specialist of BUILT_IN_AGENTS.filter((agent) => agent.role === 'specialist')) {
      expect(specialist.delegationHint.trim().length).toBeGreaterThan(0)
    }
  })
})
