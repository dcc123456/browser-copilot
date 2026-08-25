import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, TOOLS } from '../src/background/agent'
import { TOOL_META, TOOL_META_BY_NAME } from '../src/lib/tool-catalog'

describe('system prompt toggle', () => {
  it('keeps the full operating rules by default', () => {
    const prompt = buildSystemPrompt({ mode: 'semi' })
    expect(prompt).toContain('Key rules you must follow')
    expect(prompt).toContain('SEMI-AUTO')
  })

  it('drops the rules when disabled, keeping only an identity line', () => {
    const prompt = buildSystemPrompt({ mode: 'full', disableRules: true })
    expect(prompt).not.toContain('Key rules you must follow')
    expect(prompt).not.toContain('FULL AUTO')
    expect(prompt).toContain('Browser Copilot')
    // The bare prompt is much shorter, so disabling meaningfully cuts tokens.
    expect(prompt.length).toBeLessThan(300)
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
