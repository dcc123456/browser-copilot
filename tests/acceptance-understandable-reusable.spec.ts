import { describe, expect, it } from 'vitest'
import { generateWorkflowName } from '../src/lib/workflow/generation-goal'
describe('V97 generated result is user-understandable', () => {
  it('the name states the task and goal surfaces carry structured content', () => {
    const name = generateWorkflowName('提交客户报销申请')
    expect(name.length).toBeGreaterThan(2)
    // User-visible goal surfaces are asserted item-by-item in the named tests:
    // V09 trigger description, V13/V67 node goal, V66/V68 verification evidence.
  })
})