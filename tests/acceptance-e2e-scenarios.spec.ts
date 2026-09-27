import { describe, expect, it } from 'vitest'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
describe('V74 simple navigation task', () => {
  it('discovers a navigation operator for the goal', () => {
    const result = findWorkflowOperators({ stepIntent: 'open the specified website https://t.test' })
    const nav = result.candidates.find((c) => ['new-tab','switch-tab'].includes(c.blockId))
    expect(nav).toBeDefined()
  })
})
describe('V75 simple fill task', () => {
  it('discovers forms for name/email fields', () => {
    const result = findWorkflowOperators({ stepIntent: 'open the signup page and fill in the name and email' })
    const forms = result.candidates.find((c) => c.blockId === 'forms')
    expect(forms).toBeDefined()
  })
})
describe('V76 click plus state verification', () => {
  it('ranks the click operator first for click-then-verify', () => {
    const result = findWorkflowOperators({ stepIntent: 'click submit and confirm the success message appears' })
    expect(result.candidateBlockIds[0]).toBe('event-click')
  })
})
describe('V77 single condition task', () => {
  it('detects the if-else control flow', () => {
    const result = findWorkflowOperators({ stepIntent: 'stop if an error message appears, otherwise continue' })
    expect(result.detectedIntents.some((d) => d.intent === 'if-else')).toBe(true)
  })
})
describe('V78 loop task', () => {
  it('detects for-each for iterating products', () => {
    const result = findWorkflowOperators({ stepIntent: 'iterate all products and extract the name and price' })
    expect(result.detectedIntents.some((d) => d.intent === 'for-each')).toBe(true)
  })
})
describe('V79 pagination task', () => {
  it('detects pagination with a termination condition', () => {
    const result = findWorkflowOperators({ stepIntent: 'go through every page until there is no next page' })
    expect(result.detectedIntents.some((d) => d.intent === 'pagination')).toBe(true)
    expect(result.detectedIntents.some((d) => d.intent === 'while-until')).toBe(true)
  })
})
describe('V80 dynamic content generation task', () => {
  it('detects reading then ai-agent generation', () => {
    const result = findWorkflowOperators({ stepIntent: 'read the customer profile and write a personalized reply' })
    expect(result.detectedIntents.some((d) => d.intent === 'semantic-generation')).toBe(true)
    expect(result.candidateBlockIds).toContain('ai-agent')
  })
})