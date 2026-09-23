import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelRepair,
  confirmOverwrite,
  confirmRepair,
  getActiveRecoverySession,
  resetRecoverySessions,
  startAiRepair,
  type RecoveryActions,
} from '../src/background/workflow-engine/recovery-orchestrator'
import { makeWorkflow, node } from './repair/helpers'
import type {
  FailureAnalysis,
  VerificationResult,
  WorkflowPatchSet,
} from '../src/lib/workflow/repair/types'
import type { Workflow } from '../src/lib/workflow/types'

function analysis(): FailureAnalysis {
  return {
    analysisId: 'a1',
    workflowId: 'wf',
    failedNodeId: 'n5',
    failureType: 'TARGET_NOT_FOUND',
    explanation: 'element not found',
    confidence: 0.9,
    retryRecommended: false,
    diagnosisTime: 0,
  } as unknown as FailureAnalysis
}

function patch(): WorkflowPatchSet {
  return {
    patchSetId: 'p1',
    analysisId: 'a1',
    operations: [
      { operationId: 'o1', nodeId: 'n5', kind: 'REPLACE_TARGET', reason: 'stale selector', evidenceIds: [] },
    ],
    reason: 'fix selector',
    confidence: 0.9,
    expectedEffect: 'element resolves',
  }
}

function verification(verified: boolean): VerificationResult {
  return { verified, trace: { traceId: 't' } } as unknown as VerificationResult
}

function workflow(): Workflow {
  return makeWorkflow(
    [node('trigger', 'trigger'), node('n5', 'event-click', { selector: '.go' })],
    [{ id: 'e1', source: 'trigger', target: 'n5' }],
  )
}

interface StubFlags {
  diagnoseVerified?: boolean
  noPatch?: boolean
  applyVerified?: boolean
}

function makeActions(flags: StubFlags = {}): RecoveryActions & {
  commits: Workflow[]
} {
  const commits: Workflow[] = []
  return {
    commits,
    diagnose: vi.fn(async () => ({ analysis: analysis(), verified: flags.diagnoseVerified ?? false })),
    propose: vi.fn(async () =>
      flags.noPatch ? { reason: 'provider unavailable' } : { patch: patch() },
    ),
    applyAndVerify: vi.fn(async () => {
      const verified = flags.applyVerified ?? true
      return {
        workingCopy: verified ? workflow() : undefined,
        verification: verification(verified),
      }
    }),
    commit: vi.fn(async (wf: Workflow) => {
      commits.push(wf)
    }),
  }
}

describe('recovery orchestrator (single-entry AI repair)', () => {
  beforeEach(() => {
    resetRecoverySessions()
  })

  it('runs Diagnose and Proposal automatically, then pauses for repair confirmation', async () => {
    const actions = makeActions()
    const session = await startAiRepair({
      requestId: 'rq1',
      runId: 'run1',
      workflow: workflow(),
      actions,
    })
    expect(session.phase).toBe('AWAIT_REPAIR_CONFIRM')
    expect(session.status).toBe('waiting')
    expect(session.proposal).toBeDefined()
    expect(actions.diagnose).toHaveBeenCalledTimes(1)
    expect(actions.propose).toHaveBeenCalledTimes(1)
  })

  it('refuses a second start while one is active', async () => {
    const actions = makeActions()
    await startAiRepair({ requestId: 'rq1', runId: 'run1', workflow: workflow(), actions })
    await expect(
      startAiRepair({ requestId: 'rq2', runId: 'run2', workflow: workflow(), actions }),
    ).rejects.toThrow(/already active/)
  })

  it('applies and verifies after confirm, then pauses for overwrite confirmation', async () => {
    const actions = makeActions()
    await startAiRepair({ requestId: 'rq1', runId: 'run1', workflow: workflow(), actions })
    const session = await confirmRepair('rq1', actions)
    expect(session.phase).toBe('AWAIT_OVERWRITE_CONFIRM')
    expect(session.workingCopy).toBeDefined()
    expect(session.verification?.verified).toBe(true)
    // No commit yet.
    expect(actions.commits).toHaveLength(0)
  })

  it('does not commit without the second confirmation', async () => {
    const actions = makeActions()
    await startAiRepair({ requestId: 'rq1', runId: 'run1', workflow: workflow(), actions })
    await confirmRepair('rq1', actions)
    // Still paused; formal workflow not committed.
    expect(getActiveRecoverySession()!.phase).toBe('AWAIT_OVERWRITE_CONFIRM')
    expect(actions.commits).toHaveLength(0)
  })

  it('commits only after overwrite confirmation', async () => {
    const actions = makeActions()
    await startAiRepair({ requestId: 'rq1', runId: 'run1', workflow: workflow(), actions })
    await confirmRepair('rq1', actions)
    const session = await confirmOverwrite('rq1', actions)
    expect(session.phase).toBe('DONE')
    expect(actions.commits).toHaveLength(1)
    expect(getActiveRecoverySession()!.phase).toBe('DONE')
  })

  it('fails honestly when the patched workflow does not verify', async () => {
    const actions = makeActions({ applyVerified: false })
    await startAiRepair({ requestId: 'rq1', runId: 'run1', workflow: workflow(), actions })
    const session = await confirmRepair('rq1', actions)
    expect(session.phase).toBe('FAILED')
    expect(actions.commits).toHaveLength(0)
  })

  it('routes to human takeover when no patch is available', async () => {
    const actions = makeActions({ noPatch: true })
    const session = await startAiRepair({
      requestId: 'rq1',
      runId: 'run1',
      workflow: workflow(),
      actions,
    })
    expect(session.phase).toBe('HUMAN_TAKEOVER')
    expect(session.reason).toContain('unavailable')
  })

  it('ends immediately when diagnosis finds the workflow healthy', async () => {
    const actions = makeActions({ diagnoseVerified: true })
    const session = await startAiRepair({
      requestId: 'rq1',
      runId: 'run1',
      workflow: workflow(),
      actions,
    })
    expect(session.phase).toBe('DONE')
    expect(actions.propose).not.toHaveBeenCalled()
  })

  it('can be cancelled before commit', async () => {
    const actions = makeActions()
    await startAiRepair({ requestId: 'rq1', runId: 'run1', workflow: workflow(), actions })
    const session = cancelRepair('rq1')
    expect(session.phase).toBe('CANCELLED')
    expect(getActiveRecoverySession()).toBeNull()
  })

  it('rejects actions from a stale request id', async () => {
    const actions = makeActions()
    await startAiRepair({ requestId: 'rq1', runId: 'run1', workflow: workflow(), actions })
    await expect(confirmRepair('stale', actions)).rejects.toThrow(/does not match/)
  })
})
