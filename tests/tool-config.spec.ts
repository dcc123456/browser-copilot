import { describe, expect, it } from 'vitest'
import { advertiseTools, buildSystemPrompt, TOOLS } from '../src/background/agent'
import { DEFAULT_SYSTEM_PROMPT } from '../src/lib/system-prompt'
import {
  BRIDGE_ONLY_TOOLS,
  TOOL_META,
  TOOL_META_BY_NAME_MERGED,
  TOOL_SECTIONS,
} from '../src/lib/tool-catalog'
import { TOOL_GROUPS } from '../src/lib/tool-groups'

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

  it('chat mode still carries a skill pinned for the turn', () => {
    const prompt = buildSystemPrompt({
      mode: 'chat',
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
    // The user message points at "the instructions in the system prompt".
    expect(prompt).toContain('ACTIVE SKILL')
    expect(prompt).toContain('Reply in bullets.')
    expect(prompt).not.toContain('SEMI-AUTO')
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

  it('never advertises a bridge-only tool to the model', () => {
    // `generate_workflow` starts a whole generation turn and `verify_workflow`
    // executes a saved graph. Both exist for the local-agent bridge: offered
    // mid-turn, the first lets the agent recurse into itself and the second runs
    // a workflow against the page that nobody in that conversation asked for.
    const surfaces: Parameters<typeof advertiseTools>[0][] = [
      { mode: 'full' },
      { mode: 'workflow' },
      {
        mode: 'workflow',
        loadedGroups: new Set(['operators_author', 'operators_escape']),
      },
    ]
    for (const options of surfaces) {
      const names = advertiseTools(options).map((tool) => tool.function.name)
      for (const bridgeOnly of BRIDGE_ONLY_TOOLS) expect(names).not.toContain(bridgeOnly)
    }
  })
})

describe('settings tool sections', () => {
  it('shows every tool exactly once', () => {
    const shown = TOOL_SECTIONS.flatMap((section) => section.tools.map((meta) => meta.name))
    // Duplicates would render two switches for one tool; a missing tool would
    // make it impossible to disable in Settings.
    expect(new Set(shown).size).toBe(shown.length)
    expect([...shown].sort()).toEqual(TOOL_META.map((meta) => meta.name).sort())
  })

  it('groups a tool by the group that loads it', () => {
    const sectionOf = new Map<string, string>()
    for (const section of TOOL_SECTIONS) {
      for (const meta of section.tools) sectionOf.set(meta.name, section.id)
    }
    const scoped = ['tabs', 'data', 'skills', 'ops', 'forms', 'flow', 'keys', 'vision', 'script']
    for (const group of scoped) {
      for (const name of TOOL_GROUPS[group]!) expect(sectionOf.get(name)).toBe(group)
    }
    // The universal browse loop is never behind a load round, so it must sit in
    // the always-on section rather than in some capability bucket.
    for (const name of ['click', 'fill', 'read_current_page', 'snapshot_page', 'run_plan']) {
      expect(sectionOf.get(name)).toBe('core')
    }
    // Workflow-only and bridge-only entries are not panel capabilities.
    expect(sectionOf.get('compose_workflow')).toBe('workflow')
    for (const name of BRIDGE_ONLY_TOOLS) expect(sectionOf.get(name)).toBe('workflow')
  })

  it('keeps the on-demand groups ahead of the catch-all buckets', () => {
    const ids = TOOL_SECTIONS.map((section) => section.id)
    expect(ids[0]).toBe('core')
    expect(ids.at(-1)).toBe('workflow')
    // Every section carries a heading and at least one switch.
    for (const section of TOOL_SECTIONS) {
      expect(section.labelKey).toBeTruthy()
      expect(section.tools.length).toBeGreaterThan(0)
    }
  })
})
