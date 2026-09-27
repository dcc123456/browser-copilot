import { describe, expect, it } from 'vitest'
import { generateWorkflowName, isAcceptableWorkflowName } from '../src/lib/workflow/generation-goal'
describe('V08 workflow name auto generation', () => {
  const tasks = [
    { zh: '创建客户档案', keyword: '客户' },
    { zh: '抓取商品列表价格', keyword: '商品' },
    { zh: '提交报销申请单', keyword: '申请' },
    { zh: '发送跟进邮件', keyword: '邮件' },
  ]
  it.each(tasks)('produces a task-related name for: $zh', ({ zh, keyword }) => {
    const name = generateWorkflowName(zh)
    expect(name).toContain(keyword)
    expect(isAcceptableWorkflowName(name)).toBe(true)
  })
  it('rejects workflow-xxxx / new workflow / test / random-id names', () => {
    expect(isAcceptableWorkflowName('workflow-a1b2c3')).toBe(false)
    expect(isAcceptableWorkflowName('New workflow')).toBe(false)
    expect(isAcceptableWorkflowName('test')).toBe(false)
    expect(isAcceptableWorkflowName('')).toBe(false)
  })
  it('is semantically stable across repeated generations', () => {
    const a = generateWorkflowName('创建客户档案')
    const b = generateWorkflowName('创建客户档案')
    expect(a).toBe(b)
  })
})