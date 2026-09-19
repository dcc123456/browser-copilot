import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, TOOLS } from '../src/background/agent'
import { DEFAULT_SYSTEM_PROMPT } from '../src/lib/system-prompt'
import { TOOL_META, TOOL_META_BY_NAME_MERGED } from '../src/lib/tool-catalog'

describe('system prompt', () => {
  it('uses the full default operating rules when no override is given', () => {
    const prompt = buildSystemPrompt({ mode: 'semi' })
    expect(prompt).toContain('Never invent page content')
    expect(prompt).toContain('SEMI-AUTO')
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })

  it('uses a custom base prompt verbatim, still appending the mode line', () => {
    const custom = 'Be terse. Always answer in haiku.'
    const prompt = buildSystemPrompt({ mode: 'full', basePrompt: custom })
    expect(prompt).toContain(custom)
    expect(prompt).not.toContain('Never invent page content')
    // The mode is still advertised so the model knows it can act.
    expect(prompt).toContain('FULL AUTO')
  })

  it('treats a blank override as "use the default"', () => {
    const prompt = buildSystemPrompt({ mode: 'readonly', basePrompt: '   ' })
    expect(prompt).toContain('Never invent page content')
    expect(prompt).toContain('READ-ONLY')
  })

  it('chat mode uses a tiny identity prompt and ignores overrides/rules', () => {
    const custom = 'Be terse. Always answer in haiku.'
    const prompt = buildSystemPrompt({ mode: 'chat', basePrompt: custom })
    expect(prompt).not.toContain('Never invent page content')
    expect(prompt).not.toContain(custom)
    expect(prompt).not.toContain('SEMI-AUTO')
    expect(prompt.length).toBeLessThan(260)
  })

  it('places an active skill AFTER the mode line so it is the nearest instruction', () => {
    const prompt = buildSystemPrompt({
      mode: 'semi',
      activeSkill: {
        id: 's1',
        name: 'Summarise',
        description: 'Summarise text',
        instructions: 'Reply in bullets.',
        autoMatch: true,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    const modeAt = prompt.indexOf('SEMI-AUTO')
    const skillAt = prompt.indexOf('ACTIVE SKILL')
    expect(modeAt).toBeGreaterThan(-1)
    expect(skillAt).toBeGreaterThan(modeAt)
    // The skill block is the final block in the prompt.
    expect(prompt.lastIndexOf('Reply in bullets.')).toBeGreaterThan(skillAt)
  })

  /**
   * Workflow generation mounts the operator guide through `modeSkill`. When it
   * is present the mode paragraph must DROP its duplicated domain rules (they
   * would be paid twice on every round); when it is absent those rules must
   * ride in the paragraph instead, so the mode is never left mechanics-only.
   */
  it('workflow mode mounts the mode skill and sheds duplicated domain rules', () => {
    const skill = {
      id: 'builtin-workflow-generator',
      name: 'workflow-generator',
      description: 'Turns operations into workflows',
      instructions: '# 工作流算子指南\n\n对话动作 → 算子映射表。',
      autoMatch: true,
      createdAt: 1,
      updatedAt: 1,
    }
    const mounted = buildSystemPrompt({ mode: 'workflow', modeSkill: skill })
    expect(mounted).toContain('WORKFLOW GENERATE')
    expect(mounted).toContain('MODE SKILL — workflow-generator (ACTIVE)')
    expect(mounted).toContain('对话动作 → 算子映射表')
    // Dedupe: rules that live in the guide leave the mode paragraph.
    expect(mounted).not.toContain('READS RECORD NOTHING')
    expect(mounted).not.toContain('COLLECTING A LIST')
    // Mechanics stay in the paragraph even with the skill mounted.
    expect(mounted).toContain('use_operators')
    expect(mounted).toContain('END YOUR TURN')

    // Order: the mode skill comes after the mode paragraph but BEFORE a pinned
    // active skill, which stays the nearest instruction to the user's message.
    const both = buildSystemPrompt({ mode: 'workflow', modeSkill: skill, activeSkill: skill })
    expect(both.indexOf('MODE SKILL')).toBeLessThan(both.indexOf('ACTIVE SKILL'))
  })

  it('workflow mode without a mode skill keeps the domain rules in the paragraph', () => {
    const prompt = buildSystemPrompt({ mode: 'workflow' })
    expect(prompt).not.toContain('MODE SKILL')
    expect(prompt).toContain('READS RECORD NOTHING')
    expect(prompt).toContain('COLLECTING A LIST')
  })
})

describe('tool catalog', () => {
  it('covers every tool the agent advertises', () => {
    for (const tool of TOOLS) {
      expect(TOOL_META_BY_NAME_MERGED.has(tool.function.name)).toBe(true)
    }
  })

  it('has no duplicate entries', () => {
    const names = TOOL_META.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('declares a non-empty label and warning key for each tool', () => {
    for (const meta of TOOL_META) {
      expect(meta.labelKey).toBeTruthy()
      expect(meta.warningKey).toBeTruthy()
      expect(meta.labelKey).not.toBe(meta.warningKey)
    }
  })
})
