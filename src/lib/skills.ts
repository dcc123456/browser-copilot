/**
 * Skill validation and prompt composition.
 *
 * Kept free of `chrome` APIs so the rules that decide whether a skill is usable —
 * and how it reaches the model — are unit-testable in isolation.
 *
 * @module lib/skills
 */
import type { Skill } from './types'

/** A validation failure tied to the field that caused it. */
export interface SkillProblem {
  field: 'name' | 'instructions'
  /** Message key, resolved by the caller so errors follow the UI language. */
  code: 'nameRequired' | 'instructionsRequired' | 'nameTaken'
}

/** Longest instruction text accepted. */
export const MAX_INSTRUCTIONS_LENGTH = 8000
/** Longest skill name accepted. */
export const MAX_NAME_LENGTH = 60

/**
 * Checks a skill against the other stored skills.
 *
 * Name uniqueness is enforced case-insensitively because the agent selects skills
 * by name: two skills differing only in case would make an automatic selection
 * ambiguous, and the user could not tell which one ran.
 */
export function validateSkill(skill: Skill, existing: readonly Skill[]): SkillProblem[] {
  const problems: SkillProblem[] = []
  const name = skill.name.trim()
  const instructions = skill.instructions.trim()

  if (name.length === 0) problems.push({ field: 'name', code: 'nameRequired' })
  if (instructions.length === 0) {
    problems.push({ field: 'instructions', code: 'instructionsRequired' })
  }

  const clash = existing.some(
    (other) => other.id !== skill.id && other.name.trim().toLowerCase() === name.toLowerCase(),
  )
  if (name.length > 0 && clash) problems.push({ field: 'name', code: 'nameTaken' })

  return problems
}

/** Trims and clamps user input so one skill cannot crowd out the conversation. */
export function normalizeSkill(skill: Skill): Skill {
  return {
    ...skill,
    name: skill.name.trim().slice(0, MAX_NAME_LENGTH),
    description: skill.description.trim().slice(0, 300),
    instructions: skill.instructions.trim().slice(0, MAX_INSTRUCTIONS_LENGTH),
  }
}

/**
 * Renders the instruction block for an explicitly selected skill.
 *
 * Delimited and labelled so the model can tell the skill author's instructions
 * from the user's live message. Without that separation, instruction text reads
 * as if the user had just typed it, which makes "ignore the skill and do X"
 * ambiguous.
 */
export function renderSkillPrompt(skill: Skill): string {
  return [
    `## Active skill: ${skill.name}`,
    skill.description ? `Purpose: ${skill.description}` : '',
    '',
    'Follow these instructions for this conversation unless the user overrides them:',
    '',
    skill.instructions,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * Renders the catalogue of auto-matchable skills.
 *
 * Only name and description are included — never the instruction bodies. Sending
 * every skill's full text would inflate the prompt with content the model does
 * not need until a skill is actually chosen, so the model is told to request one
 * by name via the `use_skill` tool instead.
 */
export function renderSkillCatalogue(skills: readonly Skill[]): string {
  const usable = skills.filter((skill) => skill.autoMatch && skill.description.trim() !== '')
  if (usable.length === 0) return ''

  const lines = usable.map((skill) => `- ${skill.name}: ${skill.description}`)
  return [
    '## Available skills',
    '',
    'These saved skills may fit the user\u2019s request:',
    '',
    ...lines,
    '',
    'If one clearly applies, call `use_skill` with its exact name to load its',
    'instructions before answering. If none apply, just answer normally \u2014 do not',
    'mention this list.',
  ].join('\n')
}
