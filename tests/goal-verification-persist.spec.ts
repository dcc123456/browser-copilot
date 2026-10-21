import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The goal verdict a generation measured has to survive the save.
 *
 * The settings whitelist rebuilds `settings` key by key, so a verdict written
 * by the compose path and NOT added to that whitelist is dropped at save time:
 * the code writes it, the workflow loads without it, and the card shows
 * nothing. That is the failure this file exists to catch — the round trip
 * below is the direct defence.
 */

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    store,
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) {
            if (store.has(key)) out[key] = store.get(key)
          }
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
        remove: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          for (const key of wanted) store.delete(key)
        },
      },
    },
  }
}

let chromeMock = makeChromeMock()

beforeEach(() => {
  chromeMock = makeChromeMock()
  vi.stubGlobal('chrome', chromeMock)
  vi.resetModules()
})

const FAILED_TRIAL = {
  outcome: 'failed' as const,
  at: 1,
  full: false,
  coveredSteps: 1,
  totalSteps: 2,
  failureCode: 'LOCATOR_NOT_FOUND',
  reason: 'the target was not on the page',
}

/** A draft with one step that declares a postcondition, so a goal is derived. */
async function draftWithOneClick() {
  const handler = await import('../src/background/operator-tool-handler')
  await handler.runOperatorTool({
    name: 'wf_op_event-click',
    args: {
      selector: '#x',
      __reliability: {
        intent: '点击目标元素',
        idempotency: 'safe',
        postconditions: [{ kind: 'elementExists', target: { testId: 'x' } }],
      },
    },
    conversationId: 'conv',
  })
  return handler
}

describe('the goal verdict survives the save', () => {
  it('reads back the verdict the compose path wrote', async () => {
    const handler = await draftWithOneClick()
    const composed = await handler.composeWorkflowFromDraft('conv', {
      save: true,
      trial: async (workflow) => ({ workflow, record: FAILED_TRIAL }),
    })
    expect('error' in composed).toBe(false)
    if ('error' in composed) throw new Error(composed.error)

    const { getWorkflow } = await import('../src/lib/workflow/storage')
    const stored = await getWorkflow(composed.workflow.id)
    // The whitelist is the only reader of a persisted setting: a verdict the
    // whitelist does not know is a verdict nobody ever sees.
    expect(stored?.settings.goalVerification).toMatchObject({
      level: 'NONE',
      certified: false,
    })
    expect(stored?.settings.goalVerification?.unmet).toEqual(['the target was not on the page'])
  })

  it('still saves a workflow whose goal was not met', async () => {
    const handler = await draftWithOneClick()
    const composed = await handler.composeWorkflowFromDraft('conv', {
      save: true,
      trial: async (workflow) => ({
        workflow,
        record: { ...FAILED_TRIAL, outcome: 'passed' as const, failureCode: undefined },
      }),
    })
    if ('error' in composed) throw new Error(composed.error)
    // Saving must never be blocked by a verdict.
    expect(composed.saved).toBe(true)
  })
})

describe('a broken graph and an unmet goal read differently', () => {
  it('gives the two findings their own wording', async () => {
    const handler = await import('../src/background/operator-tool-handler')
    const broken = handler.trialFailedWarning(FAILED_TRIAL)
    const unmet = handler.goalUnmetWarning({
      level: 'L3',
      certified: false,
      reason: 'L3 failed',
      unmet: ['草稿箱里有新草稿'],
    })

    expect(broken).toContain('验证未通过')
    expect(unmet).toContain('目标未达成')
    expect(unmet).toContain('草稿箱里有新草稿')
    expect(broken).not.toBe(unmet)
  })

  it('says nothing when the goal was met, and nothing when it was never judged', async () => {
    const handler = await import('../src/background/operator-tool-handler')
    expect(
      handler.goalUnmetWarning({ level: 'L3', certified: true, reason: 'ok', unmet: [] }),
    ).toBeUndefined()
    expect(
      handler.goalUnmetWarning({
        level: 'NONE',
        certified: false,
        reason: 'the trial stopped before the last step',
        unmet: [],
      }),
    ).toBeUndefined()
  })
})

describe('the whitelist drops a verdict it cannot read', () => {
  it('keeps a malformed record out without throwing', async () => {
    const { normalizeGoalVerification } =
      await import('../src/lib/workflow/goal-verification-record')
    expect(normalizeGoalVerification(undefined)).toBeUndefined()
    expect(normalizeGoalVerification('certified')).toBeUndefined()
    expect(normalizeGoalVerification({ level: 'L9', certified: true })).toBeUndefined()
    expect(normalizeGoalVerification({ level: 'L3' })).toEqual({
      level: 'L3',
      certified: false,
      reason: '',
      unmet: [],
    })
  })
})
