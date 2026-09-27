import { describe, expect, it } from 'vitest'
import { detectSemanticIntents, hasIntent } from '../src/lib/workflow/semantic-intent'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
describe('29.4 ai-agent for dynamic text', () => {
  const zh = '读取客户信息，生成个性化邮件并填写到正文'
  const en = 'Read the customer information, draft a personalized email, and fill it into the message body.'
  it.each([zh, en])('detects reading + semantic generation for: %s', (text) => {
    expect(hasIntent(text, 'reading')).toBe(true)
    expect(hasIntent(text, 'semantic-generation')).toBe(true)
  })
  it.each([zh, en])('discovers ai-agent for the composed text in: %s', (text) => {
    const result = findWorkflowOperators({ stepIntent: text, limit: 8 })
    expect(result.candidateBlockIds).toContain('ai-agent')
  })
})
describe('29.5 deterministic text filling', () => {
  it('does not select ai-agent for a plain username fill', () => {
    const result = findWorkflowOperators({ stepIntent: '把用户名填写到输入框', limit: 8 })
    expect(result.candidateBlockIds).not.toContain('ai-agent')
    expect(result.candidateBlockIds).toContain('forms')
  })
})
describe('29.6 control-flow semantics', () => {
  const zh = ['遍历所有商品', '每一条订单', '直到没有更多结果', '如果状态是失败，否则继续', '最多重试 3 次', '翻页直到最后一页']
  const en = ['process every product', 'for each order', 'continue until there are no more results', 'if the status is failed, otherwise continue', 'retry up to 3 times', 'paginate until the last page']
  it.each(zh)('detects a control-flow intent (zh): %s', (text) => {
    const intents = detectSemanticIntents(text)
    const kinds = intents.map((i) => i.intent)
    expect(kinds.some((k) => k.startsWith('if') || k.includes('each') || k.includes('while') || k.includes('retry') || k.includes('pagination'))).toBe(true)
  })
  it.each(en)('detects a control-flow intent (en): %s', (text) => {
    const intents = detectSemanticIntents(text)
    const kinds = intents.map((i) => i.intent)
    expect(kinds.some((k) => k.startsWith('if') || k.includes('each') || k.includes('while') || k.includes('retry') || k.includes('pagination'))).toBe(true)
  })
})