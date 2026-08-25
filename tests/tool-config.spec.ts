import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, TOOLS } from '../src/background/agent'
import { DEFAULT_SYSTEM_PROMPT } from '../src/lib/system-prompt'
import { TOOL_META, TOOL_META_BY_NAME } from '../src/lib/tool-catalog'

describe('system prompt', () => {
  it('uses the full default operating rules when no override is given', () => {
    const prompt = buildSystemPrompt({ mode: 'semi' })
    expect(prompt).toContain('Key rules you must follow')
    expect(prompt).toContain('SEMI-AUTO')
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true)
  })

  it('uses a custom base prompt verbatim, still appending the mode line', () => {
    const custom = 'Be terse. Always answer in haiku.'
    const prompt = buildSystemPrompt({ mode: 'full', basePrompt: custom })
    expect(prompt).toContain(custom)
    expect(prompt).not.toContain('Key rules you must follow')
    // The mode is still advertised so the model knows it can act.
    expect(prompt).toContain('FULL AUTO')
  })

  it('treats a blank override as "use the default"', () => {
    const prompt = buildSystemPrompt({ mode: 'readonly', basePrompt: '   ' })
    expect(prompt).toContain('Key rules you must follow')
    expect(prompt).toContain('READ-ONLY')
  })

  it('chat mode uses a tiny identity prompt and ignores overrides/rules', () => {
    const custom = 'Be terse. Always answer in haiku.'
    const prompt = buildSystemPrompt({ mode: 'chat', basePrompt: custom })
    expect(prompt).not.toContain('Key rules you must follow')
    expect(prompt).not.toContain(custom)
    expect(prompt).not.toContain('SEMI-AUTO')
    expect(prompt.length).toBeLessThan(260)
  })
})

describe('tool catalog', () => {
  it('covers every tool the agent advertises', () => {
    for (const tool of TOOLS) {
      expect(TOOL_META_BY_NAME.has(tool.function.name)).toBe(true)
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
