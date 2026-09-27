import { describe, expect, it } from 'vitest'
import { buildVerificationResult, verifyThroughRunner, type WorkflowRunner } from '../../src/background/workflow-engine/repair/verification-runner'
import type { ExecutionTrace } from '../../src/lib/workflow/repair/types'
import { buildTrace, edge, makeWorkflow, node } from '../repair/helpers'
function wf() { return makeWorkflow([node('t','trigger'), node('n','event-click',{selector:'.btn'})], [edge('t','n')]) }
function okTrace(): ExecutionTrace {
  const w = wf()
  return buildTrace(w, 'run', [{id:'t',status:'ok',variables:{}},{id:'n',status:'ok',variables:{}}], {})
}
describe('V57 successful repair is independently re-verified', () => {
  it('a takeover-free run after the patch must verify', () => {
    const result = buildVerificationResult({ workflow: wf(), outcome: { outcome: 'ok', trace: okTrace() }, allowedAiTakeover: false })
    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    // Certification is only granted by this independent re-verification after
    // the patch — never carried over from before the failure.
  })
  it('re-runs verification through the runner with takeover disabled', async () => {
    const runner: WorkflowRunner = { run: async () => ({ outcome: 'ok', trace: okTrace() }) }
    const result = await verifyThroughRunner(runner, wf(), { entry: 'VERIFY', allowAiTakeover: false })
    expect(result.verified).toBe(true)
  })
})
describe('V58 repair that still fails is not certified', () => {
  it('a failed independent run leaves verified=false and keeps the failure type', async () => {
    const runner: WorkflowRunner = {
      run: async () => ({ outcome: 'failed', error: 'TARGET_NOT_FOUND: .btn', trace: buildTrace(wf(), 'run', [{id:'t',status:'ok',variables:{}},{id:'n',status:'failed',variables:{},error:'TARGET_NOT_FOUND: .btn'}], {}) }),
    }
    const result = await verifyThroughRunner(runner, wf(), { allowAiTakeover: false })
    expect(result.success).toBe(false)
    expect(result.verified).toBe(false)
    expect(result.failureType).toBe('TARGET_NOT_FOUND')
  })
})