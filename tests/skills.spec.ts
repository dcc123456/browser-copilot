import { describe, expect, it } from 'vitest'
import {
  MAX_INSTRUCTIONS_LENGTH,
  MAX_NAME_LENGTH,
  normalizeSkill,
  renderSkillCatalogue,
  renderSkillPrompt,
  validateSkill,
  wrapSkillDirective,
} from '../src/lib/skills'
import type { Skill } from '../src/lib/types'

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 's1',
    name: 'Summarise',
    description: 'Condense a long article into bullets.',
    instructions: 'Reply with at most five bullets.',
    autoMatch: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('validateSkill', () => {
  it('accepts a complete skill', () => {
    expect(validateSkill(skill(), [])).toEqual([])
  })

  it('requires a name', () => {
    const problems = validateSkill(skill({ name: '   ' }), [])
    expect(problems).toEqual([{ field: 'name', code: 'nameRequired' }])
  })

  it('requires instructions', () => {
    const problems = validateSkill(skill({ instructions: '\n\t ' }), [])
    expect(problems).toEqual([{ field: 'instructions', code: 'instructionsRequired' }])
  })

  it('reports both missing fields at once', () => {
    const problems = validateSkill(skill({ name: '', instructions: '' }), [])
    expect(problems).toHaveLength(2)
  })

  /**
   * Names must be unique case-insensitively because the agent selects a skill by
   * name; two casings would make an automatic pick ambiguous and the user could
   * not tell which instructions ran.
   */
  it('rejects a name that clashes ignoring case and padding', () => {
    const existing = [skill({ id: 'other', name: 'Summarise' })]
    for (const name of ['summarise', 'SUMMARISE', '  Summarise  ']) {
      const problems = validateSkill(skill({ id: 's1', name }), existing)
      expect(problems).toContainEqual({ field: 'name', code: 'nameTaken' })
    }
  })

  it('lets a skill keep its own name when edited', () => {
    const existing = [skill({ id: 's1', name: 'Summarise' })]
    expect(validateSkill(skill({ id: 's1' }), existing)).toEqual([])
  })

  it('does not report a clash when the name is blank', () => {
    const problems = validateSkill(skill({ name: '' }), [skill({ id: 'other', name: '' })])
    expect(problems.map((problem) => problem.code)).toEqual(['nameRequired'])
  })
})

describe('normalizeSkill', () => {
  it('trims surrounding whitespace', () => {
    const result = normalizeSkill(skill({ name: '  Recap  ', instructions: '  do it  ' }))
    expect(result.name).toBe('Recap')
    expect(result.instructions).toBe('do it')
  })

  // A pathological paste must not be able to crowd the conversation out of the
  // context window.
  it('clamps over-long input', () => {
    const result = normalizeSkill(
      skill({ name: 'x'.repeat(500), instructions: 'y'.repeat(50_000) }),
    )
    expect(result.name).toHaveLength(MAX_NAME_LENGTH)
    expect(result.instructions).toHaveLength(MAX_INSTRUCTIONS_LENGTH)
  })

  it('preserves the fields it does not own', () => {
    const result = normalizeSkill(skill({ autoMatch: false, createdAt: 42 }))
    expect(result.autoMatch).toBe(false)
    expect(result.createdAt).toBe(42)
  })
})

describe('renderSkillPrompt', () => {
  it('labels and delimits the instructions', () => {
    const prompt = renderSkillPrompt(skill())
    expect(prompt).toContain('## ACTIVE SKILL — APPLY NOW: Summarise')
    expect(prompt).toContain('Reply with at most five bullets.')
  })

  it('tells the model the skill is already active so it does not refuse', () => {
    expect(renderSkillPrompt(skill())).toMatch(/already\s+active/i)
  })

  it('omits the purpose line when there is no description', () => {
    expect(renderSkillPrompt(skill({ description: '' }))).not.toContain('Purpose:')
  })
})

describe('renderSkillCatalogue', () => {
  it('lists auto-matchable skills by name and description', () => {
    const catalogue = renderSkillCatalogue([skill()])
    expect(catalogue).toContain('Summarise: Condense a long article into bullets.')
    expect(catalogue).toContain('use_skill')
  })

  /**
   * Instruction bodies are deliberately withheld: sending every skill's full text
   * would inflate each request with content the model cannot use until it has
   * actually chosen one.
   */
  it('never leaks instruction bodies', () => {
    const catalogue = renderSkillCatalogue([skill({ instructions: 'SECRET-BODY' })])
    expect(catalogue).not.toContain('SECRET-BODY')
  })

  it('excludes skills the user kept manual', () => {
    expect(renderSkillCatalogue([skill({ autoMatch: false })])).toBe('')
  })

  // Without a description the model has nothing to match on, so listing it would
  // only invite a guess.
  it('excludes auto-match skills with no description', () => {
    expect(renderSkillCatalogue([skill({ description: '  ' })])).toBe('')
  })

  it('returns empty for an empty list', () => {
    expect(renderSkillCatalogue([])).toBe('')
  })

  it('includes only the usable subset', () => {
    const catalogue = renderSkillCatalogue([
      skill({ id: 'a', name: 'Keep', description: 'yes' }),
      skill({ id: 'b', name: 'Drop', autoMatch: false }),
    ])
    expect(catalogue).toContain('Keep')
    expect(catalogue).not.toContain('Drop')
  })
})

describe('wrapSkillDirective', () => {
  it('names the skill, mandates applying it, and keeps the user content', () => {
    const wrapped = wrapSkillDirective(skill(), 'Translate this paragraph.')
    expect(wrapped).toContain('Summarise')
    expect(wrapped).toContain('MUST apply')
    expect(wrapped).toContain('Translate this paragraph.')
  })
})
