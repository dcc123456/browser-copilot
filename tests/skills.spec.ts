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
import { BUILT_IN_SKILLS } from '../src/lib/builtin-skills'
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

/**
 * The built-in workflow generator ships its whole operator guide as skill
 * instructions, and the store truncates anything past
 * `MAX_INSTRUCTIONS_LENGTH` (`.slice`). A guide that grows past the cap would
 * lose its TAIL — the task instructions the model actually acts on — with no
 * error anywhere. Pin the ceiling so that fails here instead of silently in
 * production.
 */
describe('built-in skill instruction budget', () => {
  it('keeps every built-in skill under the instruction cap', () => {
    for (const builtin of BUILT_IN_SKILLS) {
      expect(
        builtin.instructions.length,
        `${builtin.id} is ${builtin.instructions.length} chars`,
      ).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH)
    }
  })

  it('leaves headroom in the workflow generator guide', () => {
    // Not just under the cap: close enough to it that the next paragraph would
    // silently truncate. Keep a working margin.
    const generator = BUILT_IN_SKILLS.find((s) => s.id === 'builtin-workflow-generator')!
    expect(MAX_INSTRUCTIONS_LENGTH - generator.instructions.length).toBeGreaterThanOrEqual(200)
  })
})

/**
 * The plan skill is the plan-first gate's trigger half: the gate only arms when
 * a skill NAMED `plan` is pinned or loaded, so the shipped builtin must exist,
 * be auto-matchable with a tight trigger, and teach the `present_plan` hand-off.
 */
describe('built-in plan skill', () => {
  const plan = BUILT_IN_SKILLS.find((s) => s.id === 'builtin-plan')

  it('ships under the reserved plan skill name', () => {
    expect(plan).toBeDefined()
    expect(plan!.name).toBe('plan')
    expect(plan!.autoMatch).toBe(true)
  })

  it('keeps the trigger description tight (it gates every matched task)', () => {
    // A vague trigger would route ordinary tasks through plan approval; the
    // description must name the explicit planning requests it serves.
    expect(plan!.description).toContain('present_plan')
    expect(plan!.description).toContain('plan first')
  })

  it('teaches the present_plan hand-off and the no-execution rule', () => {
    expect(plan!.instructions).toContain('present_plan')
    expect(plan!.instructions).toContain('禁止')
    expect(plan!.instructions).toContain('全自动 / 半自动模式')
    expect(plan!.instructions).toContain('工作流生成模式')
  })
})
