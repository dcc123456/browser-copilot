import { describe, expect, it } from 'vitest'
import { hasIntent } from '../src/lib/workflow/semantic-intent'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
const zh = [
  '生成文案', '写一段回复', '撰写邮件', '回复客户', '个性化回复', '个性化邮件',
  '根据页面内容生成', '根据上下文填写', '改写文案', '润色内容', '总结后生成',
]
const en = [
  'write a reply', 'draft an email', 'compose a message', 'generate text', 'generate a reply',
  'personalized message', 'personalized email', 'generate from page context',
  'rewrite the text', 'rephrase the sentence', 'polish the paragraph', 'summarize and write',
]
describe('V38 dynamic generation bilingual semantics', () => {
  it.each([...zh, ...en])('detects semantic-generation for: %s', (text) => {
    expect(hasIntent(text, 'semantic-generation')).toBe(true)
  })
  it.each([...zh.slice(0,4), ...en.slice(0,4)])('discovers ai-agent for: %s', (text) => {
    const result = findWorkflowOperators({ stepIntent: text, limit: 8 })
    expect(result.candidateBlockIds).toContain('ai-agent')
  })
  it('does not upgrade a deterministic task to ai-agent', () => {
    const result = findWorkflowOperators({ stepIntent: 'fill the fixed username field', limit: 8 })
    expect(result.candidateBlockIds).not.toContain('ai-agent')
  })
})
describe('V41-V43 AI agent dataflow', () => {
  it('is the formal capability for model-created output with a tracked variable', () => {
    const result = findWorkflowOperators({ stepIntent: 'draft a personalized follow-up email', limit: 8 })
    const ai = result.candidates.find((c) => c.blockId === 'ai-agent')
    expect(ai).toBeDefined()
  })
})