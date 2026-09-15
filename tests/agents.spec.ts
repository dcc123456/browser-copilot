import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_MAX_ROUNDS,
  MAX_AGENT_MAX_ROUNDS,
  MAX_DELEGATION_HINT_LENGTH,
  MAX_SUBAGENT_SUMMARY_CHARS,
  normalizeAgent,
  renderAgentCatalogue,
  renderDelegationPrompt,
  renderSubAgentSection,
  renderSupervisorGuide,
  smallTaskRefusal,
  truncateSubAgentSummary,
  validateAgent,
} from '../src/lib/agents'
import type { Agent } from '../src/lib/types'

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'Search Expert',
    role: 'specialist',
    domain: 'search',
    delegationHint: 'Finds sources on the web.',
    instructions: 'Search, then report at most ten results.',
    tools: ['snapshot_page'],
    skillNames: [],
    delegatable: false,
    maxRounds: 8,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('validateAgent', () => {
  it('accepts a complete specialist', () => {
    expect(validateAgent(agent(), [])).toEqual([])
  })

  it('requires a name', () => {
    expect(validateAgent(agent({ name: '   ' }), [])).toContainEqual({
      field: 'name',
      code: 'nameRequired',
    })
  })

  it('requires instructions', () => {
    expect(validateAgent(agent({ instructions: '' }), [])).toContainEqual({
      field: 'instructions',
      code: 'instructionsRequired',
    })
  })

  it('rejects case-insensitive name clashes but lets an agent keep its own name', () => {
    const existing = [agent({ id: 'other', name: 'Copywriter' })]
    expect(
      validateAgent(agent({ id: 'a1', name: 'copywriter' }), existing).map((p) => p.code),
    ).toContain('nameTaken')
    expect(validateAgent(agent({ id: 'other', name: 'Copywriter' }), existing)).toEqual([])
  })

  it('accepts direct edits to a built-in agent (restore-default lives in storage)', () => {
    expect(validateAgent(agent({ builtIn: true }), [])).toEqual([])
  })
})

describe('normalizeAgent', () => {
  it('trims and clamps the text fields', () => {
    const result = normalizeAgent(
      agent({
        name: '  x  ',
        delegationHint: 'y'.repeat(500),
        instructions: '  do it  ',
      }),
    )
    expect(result.name).toBe('x')
    expect(result.instructions).toBe('do it')
    expect(result.delegationHint).toHaveLength(MAX_DELEGATION_HINT_LENGTH)
  })

  it('drops unknown tool names and dedupes case-insensitively', () => {
    const result = normalizeAgent(
      agent({ tools: ['snapshot_page', 'snapshot_page', 'not_a_tool', 'click', 4 as never] }),
    )
    expect(result.tools).toEqual(['snapshot_page', 'click'])
  })

  it('dedupes referenced skill names', () => {
    const result = normalizeAgent(agent({ skillNames: ['workflow-generator', 'Workflow-Generator'] }))
    expect(result.skillNames).toEqual(['workflow-generator'])
  })

  it('never lets a specialist keep delegation power', () => {
    expect(normalizeAgent(agent({ delegatable: true })).delegatable).toBe(false)
    expect(
      normalizeAgent(agent({ role: 'supervisor', delegatable: true })).delegatable,
    ).toBe(true)
  })

  it('coerces unknown roles/domains and clamps maxRounds', () => {
    const result = normalizeAgent(
      agent({
        role: 'wizard' as never,
        domain: 'magic' as never,
        maxRounds: 999,
      }),
    )
    expect(result.role).toBe('specialist')
    expect(result.domain).toBe('custom')
    expect(result.maxRounds).toBe(MAX_AGENT_MAX_ROUNDS)
  })

  it('falls back to the default round cap for garbage input', () => {
    expect(normalizeAgent(agent({ maxRounds: NaN })).maxRounds).toBe(DEFAULT_AGENT_MAX_ROUNDS)
  })
})

describe('renderAgentCatalogue', () => {
  it('lists specialists by name and hint only', () => {
    const catalogue = renderAgentCatalogue([agent()])
    expect(catalogue).toContain('Search Expert: Finds sources on the web.')
    expect(catalogue).toContain('delegate')
  })

  it('never leaks instruction bodies', () => {
    const catalogue = renderAgentCatalogue([agent({ instructions: 'SECRET-BODY' })])
    expect(catalogue).not.toContain('SECRET-BODY')
  })

  it('omits hint-less specialists, supervisors, and is empty without targets', () => {
    expect(renderAgentCatalogue([agent({ delegationHint: '  ' })])).toBe('')
    expect(
      renderAgentCatalogue([
        agent({ id: 'sup', role: 'supervisor', delegatable: true, name: 'sup' }),
      ]),
    ).toBe('')
    expect(renderAgentCatalogue([])).toBe('')
  })
})

describe('renderSupervisorGuide', () => {
  it('biases toward not splitting and names the big-task thresholds', () => {
    const guide = renderSupervisorGuide()
    expect(guide).toMatch(/DEFAULT: do it/i)
    expect(guide).toContain('3+')
    expect(guide).toContain('8+')
    expect(guide).toContain('4 delegations')
    // Appended to every interactive turn — must stay terse.
    expect(guide.length).toBeLessThanOrEqual(900)
  })
})

describe('renderDelegationPrompt', () => {
  it('carries task, context, deliverable and the report contract', () => {
    const prompt = renderDelegationPrompt(
      agent(),
      'Find three vendors',
      { context: 'The user builds bikes.', expects: 'A markdown table.' },
    )
    expect(prompt).toContain('Find three vendors')
    expect(prompt).toContain('The user builds bikes.')
    expect(prompt).toContain('A markdown table.')
    expect(prompt).toContain(String(MAX_SUBAGENT_SUMMARY_CHARS))
    expect(prompt).toMatch(/cannot delegate/i)
  })

  it('tells the agent to read the page itself when no context is supplied', () => {
    const prompt = renderDelegationPrompt(agent(), 'Do the thing')
    expect(prompt).toMatch(/inspect it yourself/i)
  })
})

describe('renderSubAgentSection', () => {
  it('includes the agent instructions', () => {
    const section = renderSubAgentSection(agent(), [])
    expect(section).toContain('Search Expert')
    expect(section).toContain('Search, then report at most ten results.')
  })

  it('expands referenced skills that exist', () => {
    const section = renderSubAgentSection(
      agent({ skillNames: ['wf'] }),
      [{ name: 'wf', instructions: 'WF-BODY', description: '', autoMatch: true, id: 's', createdAt: 0, updatedAt: 0 }],
    )
    expect(section).toContain('WF-BODY')
  })

  it('silently skips missing skill references', () => {
    expect(() => renderSubAgentSection(agent({ skillNames: ['ghost'] }), [])).not.toThrow()
  })
})

describe('truncateSubAgentSummary', () => {
  it('keeps short reports untouched', () => {
    expect(truncateSubAgentSummary('  done  ')).toBe('done')
  })

  it('hard-clips long reports', () => {
    const result = truncateSubAgentSummary('x'.repeat(5000))
    expect(result.length).toBeLessThanOrEqual(MAX_SUBAGENT_SUMMARY_CHARS + 20)
    expect(result).toContain('truncated')
  })
})

describe('smallTaskRefusal', () => {
  const parent = new Set(['click', 'snapshot_page', 'read_current_page'])

  it('refuses a tiny task whose specialist adds no tool the parent lacks', () => {
    expect(smallTaskRefusal('do a tiny thing', ['click'], parent)).toMatch(/small/)
  })

  it('treats an inherit-all whitelist as fully overlapping', () => {
    expect(smallTaskRefusal('tiny', [], parent)).toMatch(/small/)
  })

  it('allows a small task when the specialist owns a tool the parent lacks', () => {
    expect(smallTaskRefusal('tiny', ['get_secret'], parent)).toBeNull()
  })

  it('allows any task at or above the char threshold', () => {
    expect(smallTaskRefusal('x'.repeat(200), ['click'], parent)).toBeNull()
  })
})
