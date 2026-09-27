/**
 * A generated step declares what its success MEANS. Most of those declarations
 * are predictions about the business outcome ("a row appears", "the dialog is
 * gone"), and a prediction that misses is not evidence that the step failed.
 *
 * These tests pin the split the product depends on:
 *
 *   - HARD conditions (the variable the step must produce, the attribute it must
 *     set) fail the node — that is a broken step;
 *   - SOFT conditions never fail a step. They record a warning, mark the run
 *     unverified, and hand the repair layer the thing to look at.
 *
 * The second half pins the change-conditions' memory: "vanished" and "appeared"
 * are only judgeable against the page as it was BEFORE the step, so the engine
 * has to look while it still can, and say "I never looked" instead of guessing.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'
import { conditionLocatorKey, isHardCondition } from '../src/lib/workflow/conditions'
import {
  captureConditionBaseline,
  evaluateCondition,
  type ConditionBaseline,
  type ConditionPageProbe,
} from '../src/background/workflow-engine/condition-runtime'

// --- Engine harness -----------------------------------------------------------

function strictWorkflow(nodeData: Record<string, unknown>): Workflow {
  const node: WorkflowNode = {
    id: 'a',
    label: 'event-click',
    position: { x: 0, y: 0 },
    data: { blockId: 'event-click', selector: '#buy', ...nodeData },
  }
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes: [node], edges: [] },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      reliabilityMode: 'generated-strict',
    },
  }
}

const withReliability = (spec: Record<string, unknown>): Record<string, unknown> => ({
  __reliability: spec,
})

describe('engine hard / soft condition semantics', () => {
  it('a soft postcondition miss keeps the run OK and records why it is not verified', async () => {
    const events: string[] = []
    const result = await runWorkflow(
      strictWorkflow(
        withReliability({
          postconditions: [{ kind: 'elementVisible', target: { role: 'heading' } }],
        }),
      ),
      {
        executors: {
          'event-click': async () => {
            events.push('execute')
            return null
          },
        },
        evaluateCondition: async () => false,
      },
    )

    expect(events).toEqual(['execute'])
    expect(result.outcome).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(result.conditionWarnings).toHaveLength(1)
    expect(result.conditionWarnings?.[0]).toContain('a:')
    // The user reads this in the run log: the step ran, the promise did not hold.
    expect(result.steps?.some((line) => line.text.includes('条件未确认'))).toBe(true)
  })

  it('a hard postcondition miss fails the node (the step did not do its job)', async () => {
    const result = await runWorkflow(
      strictWorkflow(
        withReliability({ postconditions: [{ kind: 'variableExists', name: 'csrf' }] }),
      ),
      {
        executors: { 'event-click': async () => null },
        evaluateCondition: async (condition) => !isHardCondition(condition),
      },
    )

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('POSTCONDITION_FAILED')
    expect(result.conditionWarnings ?? []).toHaveLength(0)
  })

  it('a soft precondition miss does not stop the step from running', async () => {
    let executed = false
    const result = await runWorkflow(
      strictWorkflow(
        withReliability({ preconditions: [{ kind: 'urlContains', value: '/checkout' }] }),
      ),
      {
        executors: {
          'event-click': async () => {
            executed = true
            return null
          },
        },
        evaluateCondition: async () => false,
      },
    )

    expect(executed).toBe(true)
    expect(result.outcome).toBe('ok')
    expect(result.conditionWarnings?.[0]).toContain('URL 包含 "/checkout"')
  })

  it('a hard precondition miss throws before the page is touched', async () => {
    let executed = false
    const result = await runWorkflow(
      strictWorkflow(
        withReliability({
          preconditions: [{ kind: 'attributeEquals', target: { role: 'textbox' }, name: 'disabled', expected: 'false' }],
        }),
      ),
      {
        executors: {
          'event-click': async () => {
            executed = true
            return null
          },
        },
        evaluateCondition: async () => false,
      },
    )

    expect(executed).toBe(false)
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('PRECONDITION_FAILED')
  })

  it('never checks conditions for a hand-made (compat) workflow', async () => {
    let checked = false
    const wf = strictWorkflow(
      withReliability({ postconditions: [{ kind: 'elementVisible', target: { role: 'heading' } }] }),
    )
    const result = await runWorkflow(
      { ...wf, settings: { ...wf.settings, reliabilityMode: 'compat' } },
      {
        executors: { 'event-click': async () => null },
        evaluateCondition: async () => {
          checked = true
          return false
        },
      },
    )

    expect(checked).toBe(false)
    expect(result.outcome).toBe('ok')
  })
})

describe('engine baseline capture', () => {
  it('looks at the page before the step, and hands that observation to the verdict', async () => {
    const order: string[] = []
    const target = { role: 'row' }
    const result = await runWorkflow(
      strictWorkflow(withReliability({ postconditions: [{ kind: 'elementAppeared', target }] })),
      {
        executors: {
          'event-click': async () => {
            order.push('execute')
            return null
          },
        },
        captureConditionBaseline: async (conditions) => {
          order.push('capture')
          expect(conditions.map((c) => c.kind)).toEqual(['elementAppeared'])
          return { counts: {}, exists: { [conditionLocatorKey(target)]: false } }
        },
        evaluateCondition: async (_condition, baseline) => {
          order.push('evaluate')
          return baseline?.exists?.[conditionLocatorKey(target)] === false
        },
      },
    )

    expect(order).toEqual(['capture', 'execute', 'evaluate'])
    expect(result.conditionWarnings ?? []).toHaveLength(0)
  })

  it('skips the pre-step observation entirely when no condition describes a change', async () => {
    let captured = false
    await runWorkflow(
      strictWorkflow(
        withReliability({ postconditions: [{ kind: 'elementVisible', target: { role: 'heading' } }] }),
      ),
      {
        executors: { 'event-click': async () => null },
        captureConditionBaseline: async () => {
          captured = true
          return undefined
        },
        evaluateCondition: async () => true,
      },
    )

    expect(captured).toBe(false)
  })

  it('re-observes on every retry attempt: the failed attempt changed the page', async () => {
    let captures = 0
    let attempts = 0
    const result = await runWorkflow(
      strictWorkflow({
        ...withReliability({ postconditions: [{ kind: 'urlChanged' }] }),
        // The retry policy a generated non-unsafe step now ships with (Step 3).
        onError: { enable: true, toDo: 'retry', retryTimes: 1, retryInterval: 0 },
      }),
      {
        executors: {
          'event-click': async () => {
            attempts += 1
            if (attempts === 1) throw new Error('LOCATOR_NOT_FOUND: first attempt')
            return null
          },
        },
        captureConditionBaseline: async () => {
          captures += 1
          return { counts: {}, exists: {}, url: 'https://x.test/cart' }
        },
        // The page is only "moved on" from the second attempt's point of view.
        evaluateCondition: async () => attempts > 1,
      },
    )

    expect(result.outcome).toBe('ok')
    expect(captures).toBe(2)
  })
})

// --- Condition runtime --------------------------------------------------------

function probe(state: {
  exists?: boolean
  count?: number
  url?: string
}): ConditionPageProbe {
  return {
    exists: async () => state.exists ?? false,
    visible: async () => false,
    enabled: async () => false,
    text: async () => undefined,
    attribute: async () => undefined,
    count: async () => state.count ?? 0,
    url: async () => state.url,
  }
}

describe('change conditions', () => {
  it('urlChanged compares the step-start URL with the live one', async () => {
    const deps = (baseline?: ConditionBaseline) => ({
      variables: {},
      probe: probe({ url: 'https://x.test/checkout' }),
      baseline,
    })
    expect(
      (await evaluateCondition({ kind: 'urlChanged' }, deps({ counts: {}, exists: {}, url: 'https://x.test/cart' })))
        .satisfied,
    ).toBe(true)
    const same = await evaluateCondition(
      { kind: 'urlChanged' },
      deps({ counts: {}, exists: {}, url: 'https://x.test/checkout' }),
    )
    expect(same.satisfied).toBe(false)
    expect(same.detail).toContain('URL 仍为')
    const blind = await evaluateCondition({ kind: 'urlChanged' }, deps(undefined))
    expect(blind.satisfied).toBe(false)
    expect(blind.detail).toContain('缺少步骤前的 URL 观测')
  })

  it('elementGone / elementAppeared need a recorded before-state, and never guess it', async () => {
    const target = { role: 'dialog' }
    const gone = await evaluateCondition(
      { kind: 'elementGone', target },
      {
        variables: {},
        probe: probe({ exists: false }),
        baseline: { counts: {}, exists: { [conditionLocatorKey(target)]: true } },
      },
    )
    expect(gone.satisfied).toBe(true)

    const stillThere = await evaluateCondition(
      { kind: 'elementGone', target },
      {
        variables: {},
        probe: probe({ exists: true }),
        baseline: { counts: {}, exists: { [conditionLocatorKey(target)]: true } },
      },
    )
    expect(stillThere.satisfied).toBe(false)
    expect(stillThere.detail).toContain('元素仍然存在')

    const appeared = await evaluateCondition(
      { kind: 'elementAppeared', target },
      {
        variables: {},
        probe: probe({ exists: true }),
        baseline: { counts: {}, exists: { [conditionLocatorKey(target)]: false } },
      },
    )
    expect(appeared.satisfied).toBe(true)

    // The dialog was already open before the step: "it appeared" is false even
    // though an element is visible now.
    const wasAlready = await evaluateCondition(
      { kind: 'elementAppeared', target },
      {
        variables: {},
        probe: probe({ exists: true }),
        baseline: { counts: {}, exists: { [conditionLocatorKey(target)]: true } },
      },
    )
    expect(wasAlready.satisfied).toBe(false)
    expect(wasAlready.detail).toContain('步骤前就已存在')

    const blind = await evaluateCondition(
      { kind: 'elementAppeared', target },
      { variables: {}, probe: probe({ exists: true }) },
    )
    expect(blind.satisfied).toBe(false)
    expect(blind.detail).toContain('缺少步骤前的元素观测')
  })

  it('countIncreased only credits a real increase', async () => {
    const target = { role: 'listitem' }
    const baseline: ConditionBaseline = {
      counts: { [conditionLocatorKey(target)]: 2 },
      exists: {},
    }
    expect(
      (
        await evaluateCondition(
          { kind: 'countIncreased', target },
          { variables: {}, probe: probe({ count: 3 }), baseline },
        )
      ).satisfied,
    ).toBe(true)
    const flat = await evaluateCondition(
      { kind: 'countIncreased', target },
      { variables: {}, probe: probe({ count: 2 }), baseline },
    )
    expect(flat.satisfied).toBe(false)
    expect(flat.detail).toContain('2 → 2')
  })
})

describe('captureConditionBaseline', () => {
  it('observes the URL, existence and count once each, keyed by locator', async () => {
    const calls: string[] = []
    const row = { role: 'listitem' }
    const dialog = { role: 'dialog' }
    const countingProbe: ConditionPageProbe = {
      ...probe({ exists: true, count: 4, url: 'https://x.test/cart' }),
      exists: async (target) => {
        calls.push(`exists:${conditionLocatorKey(target)}`)
        return target === dialog
      },
      count: async (target) => {
        calls.push(`count:${conditionLocatorKey(target)}`)
        return 4
      },
    }
    const baseline = await captureConditionBaseline(
      [
        { kind: 'urlChanged' },
        { kind: 'countIncreased', target: row },
        { kind: 'countIncreased', target: row },
        { kind: 'elementGone', target: dialog },
        { kind: 'elementAppeared', target: dialog },
        { kind: 'elementVisible', target: row },
      ],
      countingProbe,
    )

    expect(baseline).toEqual({
      url: 'https://x.test/cart',
      counts: { [conditionLocatorKey(row)]: 4 },
      exists: { [conditionLocatorKey(dialog)]: true },
    })
    // one observation per distinct locator, and nothing for the plain-visible
    // condition (its verdict needs no before-state)
    expect(calls).toEqual([
      `count:${conditionLocatorKey(row)}`,
      `exists:${conditionLocatorKey(dialog)}`,
    ])
  })

  it('returns undefined when there is nothing to remember', async () => {
    const baseline = await captureConditionBaseline(
      [{ kind: 'elementVisible', target: { role: 'heading' } }],
      probe({ url: 'https://x.test/cart' }),
    )
    expect(baseline).toBeUndefined()
  })
})

describe('condition vocabulary', () => {
  it('treats only variable and attribute facts as hard', () => {
    for (const condition of [
      { kind: 'variableExists', name: 'x' },
      { kind: 'variableEquals', name: 'x', expected: 1 },
      { kind: 'attributeEquals', target: { role: 'textbox' }, name: 'checked', expected: 'true' },
    ] as WorkflowCondition[]) {
      expect(isHardCondition(condition)).toBe(true)
    }
    for (const condition of [
      { kind: 'urlChanged' },
      { kind: 'elementGone', target: { role: 'dialog' } },
      { kind: 'elementAppeared', target: { role: 'row' } },
      { kind: 'countIncreased', target: { role: 'row' } },
      { kind: 'elementVisible', target: { role: 'row' } },
    ] as WorkflowCondition[]) {
      expect(isHardCondition(condition)).toBe(false)
    }
  })
})
