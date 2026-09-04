/**
 * Built-in skills shipped with the extension.
 *
 * These ride along so a fresh install (or an upgrade) already has the
 * auto-skill-creation skill without the user having to author it. Seeded
 * idempotently by `storage.ensureSchema` — a skill is only inserted when no
 * existing skill shares its name, so user edits are never overwritten (an
 * untouched built-in copy is refreshed to the shipped version, see
 * `seedBuiltInSkills`).
 *
 * @module lib/builtin-skills
 */

import type { Skill } from './types'
import { OPERATOR_GUIDE } from './workflow/operator-guide'

/**
 * "skill-generator": turns a repeated workflow into a saved, project-native
 * skill by authoring a tight SKILL.md and persisting it via the `create_skill`
 * tool.
 *
 * The authoring guidance below deliberately follows the methodology of
 * Anthropic's `skill-creator` skill (concise-is-key, description-as-trigger,
 * degrees of freedom, examples-first interviews, iterate after real use),
 * adapted to this project's storage: one `SKILL.md` per skill — YAML
 * frontmatter (name + description) plus a Markdown body — written through the
 * `create_skill` tool. There are no bundled `scripts/`, `references/` or
 * `assets/` directories here, so "plan reusable resources" becomes "plan which
 * of the agent's existing tools the body should invoke".
 */
export const BUILT_IN_SKILLS: readonly Skill[] = [
  {
    id: 'builtin-skill-generator',
    name: 'skill-generator',
    description:
      'Creates a saved skill for this project: interviews the user with concrete examples, authors a concise skill (trigger-quality description, imperative Markdown body), saves it with the create_skill tool, and iterates after real use. Use when the user asks to create, make, add, or remember a reusable skill/procedure, or to turn a repeated workflow into a skill.',
    instructions: `# Skill Generator

Turn the user's request into a saved skill for this Browser Copilot project, then save it right away with the \`create_skill\` tool.

## What a skill is here

A skill is a self-contained instruction pack the agent loads when a task matches it. It is stored as one \`SKILL.md\` (\`skills/<slug>/SKILL.md\`): YAML frontmatter with \`name\` + \`description\`, and a Markdown body with the actual instructions. The **description is the trigger** — the agent reads only name + description when deciding whether to use a skill; the body is loaded after the match. So every piece of "when to use this" information belongs in the description, not the body.

## Process

### 1. Understand the skill through concrete examples

Skip only if the usage patterns are already obvious. Ask the user (a few questions at a time, not a wall of them):

- What exactly should the skill do — and what is out of scope?
- "Give me one or two examples of how you'd use it." / "What would you say that should trigger it?"
- Any page types, sites, or data formats involved?

Finish this step when you could describe 2–3 concrete invocations.

### 2. Plan the contents

For each example, work out how you would execute it from scratch, then keep only what is non-obvious or repeatedly re-derived:

- Which of this project's tools does the procedure rely on? Name them exactly (e.g. \`recognize_image\` for a CAPTCHA, \`save_local\` to write files, \`run_javascript\`, \`fill\`, \`snapshot_page\`), so the body routes the agent to them.
- What domain rules, selectors, field orders, or failure modes would the agent otherwise get wrong?

### 3. Author the skill

\`name\`: short, lowercase, kebab-case, unique (e.g. \`captcha-helper\`).

\`description\`: one to two sentences saying BOTH what it does AND when to use it, with concrete triggers — this is what makes the skill auto-match. Weak: "Helps with forms." Strong: "Fills the site's multi-page export form (filters → date range → submit). Use when the user asks to export data from <site> or mentions the export form."

\`instructions\` (the body): Markdown in the user's language. Rules:

- **The model is already smart.** Only add what it cannot know: your project's real steps, exact tool names, selectors, formats, edge cases. Never restate general knowledge ("be careful", "verify the result") — every paragraph must justify its token cost.
- **Write in imperative form.** "Call \`snapshot_page\` first", not "You might want to take a snapshot".
- **Match freedom to fragility.** Exact, numbered steps when the sequence is fragile or must be repeated identically; looser guidance with decision rules when context decides the approach.
- **Prefer a worked example over an explanation.** One concrete input→action→output beats three paragraphs of description.
- Include: the goal (one line), the steps referencing exact tools, and failure handling (what to check and which branch to take when a step fails).
- Keep it under ~500 lines. No meta content (no "about this skill", changelogs, or usage docs for humans).

### 4. Save it

Call \`create_skill\` with name, description, and instructions; pass \`autoMatch: false\` only if the user wants it available solely when pinned manually.

### 5. Iterate

Tell the user the skill is saved and what it does in one line. After they use it on a real task, offer to refine it: notice where the agent struggled or had to improvise, then update the skill via \`create_skill\` (same name updates in place).

## Quality bar

- Concise over complete: the smallest body that reliably produces correct behavior.
- The saved skill must work for an agent that has NEVER seen this conversation — it cannot ask you follow-ups, so every required detail is written down.
- Follow project conventions: reply in the user's language; page actions require user approval.`,
    autoMatch: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-workflow-generator',
    name: 'workflow-generator',
    description:
      '把一段对话操作或需求整理成正确的工作流：讲解每个算子节点的用途与用法、对话动作到算子的映射、节点取舍标准（剔除探索性/一次性动作）。Use when the user asks to 生成工作流/保存为工作流/把操作做成自动化/整理成工作流, or asks which operator/block node to use for something.',
    instructions:
      OPERATOR_GUIDE +
      `

## 你现在的任务（对话中生成/整理工作流时）

1. 先复述目标（一句话），再列出步骤清单：每步一行——算子名 + 一句话说明 + 保留/剔除及剔除理由。剔除要果断，存疑则保留。
2. 按清单给出节点与连边数据（严格遵循上面的图结构规则；每个节点带一句中文 description）。用户会在「保存为工作流」确认卡片上看到 AI 审查总结并逐步骤微调——你的清单和卡片的判定标准一致，别让两者互相矛盾。
3. 生成的工作流默认手动触发；用户明确要定时/右键等触发方式时再换 trigger 配置。`,
    autoMatch: true,
    createdAt: 0,
    updatedAt: 0,
  },
]
