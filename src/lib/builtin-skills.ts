/**
 * Built-in skills shipped with the extension.
 *
 * These ride along so a fresh install (or an upgrade) already has the
 * auto-skill-creation skill without the user having to author it. Seeded
 * idempotently by `storage.ensureSchema` — a skill is only inserted when no
 * existing skill shares its name, so user edits are never overwritten.
 *
 * @module lib/builtin-skills
 */

import type { Skill } from './types'

/**
 * "skill-generator": turns a repeated workflow into a saved, project-native
 * skill by authoring a tight SKILL.md and persisting it via the `create_skill`
 * tool. Authored to combine the general skill-authoring principles with this
 * project's specific skill storage (folder-per-skill `SKILL.md`).
 */
export const BUILT_IN_SKILLS: readonly Skill[] = [
  {
    id: 'builtin-skill-generator',
    name: 'skill-generator',
    description:
      'Creates a saved skill for this project: interviews the user, then authors a concise skill (name, when-to-use description, imperative Markdown instructions) and saves it immediately with the create_skill tool. Use when the user asks to create, make, add, or remember a new reusable skill/procedure, or to turn a repeated workflow into a skill.',
    instructions: `# Skill Generator

Turn the user's request into a reusable skill for this Browser Copilot project, then save it right away.

## How a skill works here

A skill is a saved, self-contained set of instructions the agent can auto-apply later. It is stored as a SKILL.md file under \`skills/<slug>/SKILL.md\` with YAML frontmatter (name + description) and a Markdown body. The description is what makes the agent \`use_skill\` it automatically, so it must say BOTH what the skill does AND when to use it.

## Steps

1. Understand the goal with the user — clarify what task the skill should handle and a couple of concrete example uses. Ask sparingly, not all questions at once.
2. Plan the contents: prefer the smallest thing that works. Write instructions from scratch only when there is no built-in tool for the job. If a task needs the existing tools (e.g. \`recognize_image\` for a CAPTCHA, \`save_local\` for saving files), name them explicitly so the body guides the agent to call them.
3. Author the output:
   - \`name\`: short kebab-case or concise label, unique and lowercased (e.g. \`captcha-helper\`).
   - \`description\`: one to two sentences — what it does + concrete triggers ("Use when …").
   - \`instructions\`: Markdown in the user's language, IMPERATIVE form, step-by-step. Include: goal, when to use, concrete steps referencing the exact tools, and failure handling. Keep it under ~500 lines.
4. Call the \`create_skill\` tool with name, description, and instructions, and \`autoMatch: true\` unless the user wants it only when pinned. 

## Quality bar

- Be concise — do not restate general knowledge the model already has; only add what is non-obvious.
- Follow existing conventions in this project (reply in the user's language, require approval for page actions).
- After saving, confirm to the user that the skill was created and usable, and briefly what it does.`,
    autoMatch: true,
    createdAt: 0,
    updatedAt: 0,
  },
]