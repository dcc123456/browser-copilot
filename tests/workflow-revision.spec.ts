import { describe, expect, it } from 'vitest'
import {
  REVISION_HISTORY_LIMIT,
  commitWorkflowRevision,
  currentRevisionOf,
  latestRevisionRecord,
  revisionMatchesBase,
} from '../src/lib/workflow/workflow-revision'
import type { Workflow } from '../src/lib/workflow/types'

function workflowWith(revision: number | undefined, historyLength = 0): Pick<Workflow, 'revision' | 'revisionHistory'> {
  return {
    ...(revision !== undefined ? { revision } : {}),
    revisionHistory: Array.from({ length: historyLength }, (_, i) => ({
      revision: i + 1,
      updatedAt: i + 1,
      source: 'manual-edit' as const,
    })),
  }
}

describe('workflow revision management', () => {
  it('treats an un-revisioned record as revision 0', () => {
    expect(currentRevisionOf({})).toBe(0)
    expect(currentRevisionOf({ revision: undefined })).toBe(0)
  })

  it('starts the first commit at revision 1 with no parent', () => {
    const next = commitWorkflowRevision(workflowWith(undefined), {
      source: 'generation',
      at: 1000,
    })
    expect(next.revision).toBe(1)
    expect(next.revisionHistory).toHaveLength(1)
    expect(next.revisionHistory[0]).toMatchObject({
      revision: 1,
      updatedAt: 1000,
      source: 'generation',
    })
    expect(next.revisionHistory[0]!.parentRevision).toBeUndefined()
  })

  it('bumps an AI repair from revision 12 to 13 and records the parent', () => {
    const next = commitWorkflowRevision(workflowWith(12), {
      source: 'ai-repair',
      repairSessionId: 'rec1',
    })
    expect(next.revision).toBe(13)
    expect(next.revisionHistory.at(-1)).toMatchObject({
      revision: 13,
      source: 'ai-repair',
      parentRevision: 12,
      repairSessionId: 'rec1',
    })
  })

  it('caps history at the configured limit, keeping the newest entries', () => {
    const next = commitWorkflowRevision(workflowWith(REVISION_HISTORY_LIMIT, REVISION_HISTORY_LIMIT), {
      source: 'manual-edit',
    })
    expect(next.revision).toBe(REVISION_HISTORY_LIMIT + 1)
    expect(next.revisionHistory).toHaveLength(REVISION_HISTORY_LIMIT)
    expect(next.revisionHistory[0]!.revision).toBe(2)
    expect(next.revisionHistory.at(-1)!.revision).toBe(REVISION_HISTORY_LIMIT + 1)
  })

  it('detects a revision conflict from a concurrent commit', () => {
    const base = workflowWith(12)
    expect(revisionMatchesBase(base, 12)).toBe(true)
    // A concurrent edit bumped the formal workflow to 13.
    expect(revisionMatchesBase(workflowWith(13), 12)).toBe(false)
  })

  it('returns the latest history record', () => {
    expect(latestRevisionRecord(workflowWith(2, 2))?.revision).toBe(2)
    expect(latestRevisionRecord({})).toBeUndefined()
  })
})
