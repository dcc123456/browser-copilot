import { describe, expect, it, vi } from 'vitest'
import { saveGenerationGoal, loadGenerationGoal } from '../src/lib/workflow/generation-goal-storage'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
import { resolveNodeGoalContract } from '../src/lib/workflow/node-goal-instantiation'
import { compileIR, type WorkflowIR } from '../src/lib/workflow/ir'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
function chromeMock() {
  const store = new Map<string, unknown>()
  return { storage: { local: {
    get: vi.fn(async (keys: string[]) => { const out: Record<string, unknown> = {}; for (const k of keys) if (store.has(k)) out[k] = store.get(k); return out }),
    set: vi.fn(async (items: Record<string, unknown>) => { for (const [k,v] of Object.entries(items)) store.set(k,v) }),
  } } }
}
const probe: ConditionPageProbe = {
  exists: async () => true, visible: async () => true, enabled: async () => true,
  text: async () => 'ok', attribute: async () => 'v', count: async () => 1, url: async () => 'https://t.test',
}
describe('V94 full normal task chain', () => {
  it('runs prepare → discovery → node goal → compile → verify in one chain', async () => {
    vi.stubGlobal('chrome', chromeMock())
    const conversationId = 'conv-e2e'
    // 1. prepare goal
    const contract = {
      version: 1 as const, name: 'Submit the form',
      goalSpec: { summary: 'The success banner appears after submit.', successConditions: [{ kind: 'elementExists', target: { testId: 'banner' } }] as never[] },
      requiredCapabilities: ['click','element-exists'],
    }
    await saveGenerationGoal(conversationId, contract)
    const loaded = await loadGenerationGoal(conversationId)
    expect(loaded?.goalSpec.summary).toContain('success banner')
    // 2. capability inference + discovery
    const discovery = findWorkflowOperators({ stepIntent: 'click the submit button', workflowGoal: loaded!.goalSpec.summary })
    expect(discovery.candidateBlockIds).toContain('event-click')
    // 3. node goal resolution (on execution success)
    const nodeGoal = resolveNodeGoalContract('event-click', { variableName: 'submitted' })
    expect(nodeGoal?.successCriteria.length).toBeGreaterThan(0)
    // 4. IR → compile → static validation → goal verification
    const ir: WorkflowIR = {
      version: 1, goal: { ...loaded!.goalSpec }, inputs: [],
      steps: [{ id: 's1', intent: 'Click submit', action: { kind: 'click' }, target: { kind:'element', semantic:{testId:'submit'} } as never, preconditions: [], postconditions: loaded!.goalSpec.successConditions } as never],
      edges: [], metadata: {},
    }
    const workflow = compileIR(ir)
    const run = { runId: 'r', outcome: 'ok' as const, variables: { banner: true } }
    const report = await verifyWorkflowGoal(workflow, run as never, probe)
    expect(report.passed).toBe(true)
    expect(report.certified).toBe(true)
  })
})