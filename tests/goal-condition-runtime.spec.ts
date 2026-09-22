/**
 * Goal + condition runtime tests (spec §8, Phase 5): the goal gate is
 * deterministic — page/URL/variable observations decide, terminal-state
 * conditions mark already-done goals, and the LLM judge can NEVER forge a
 * success. The derived goal spec is grounded in node postconditions only.
 */
import { describe, expect, it } from 'vitest'
import { deriveGoalSpecFromNodes, normalizeGoalSpec } from '../src/lib/workflow/goal'
import {
  evaluateAllConditions,
  evaluateCondition,
  type ConditionPageProbe,
} from '../src/background/workflow-engine/condition-runtime'
import { verifyGoalSpec } from '../src/background/workflow-engine/goal-verifier'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'
import { node } from '../specs/reliability-fixtures/harness'

/** A page probe driven by a plain record — deterministic and observable. */
function fakeProbe(state: {
  exists?: boolean
  visible?: boolean
  enabled?: boolean
  text?: string | undefined
  attr?: string | undefined
  count?: number
  url?: string
}): ConditionPageProbe {
  return {
    exists: async () => state.exists ?? false,
    visible: async () => state.visible ?? false,
    enabled: async () => state.enabled ?? false,
    text: async () => state.text,
    attribute: async () => state.attr,
    count: async () => state.count ?? 0,
    url: async () => state.url,
  }
}

describe('normalizeGoalSpec', () => {
  it('accepts a well-formed goal and drops garbage', () => {
    const good = normalizeGoalSpec({
      summary: '登录成功',
      successConditions: [{ kind: 'urlContains', value: '/dashboard' }],
    })
    expect(good?.summary).toBe('登录成功')
    expect(good?.successConditions).toHaveLength(1)
    expect(normalizeGoalSpec({ summary: '', successConditions: [] })).toBeUndefined()
    expect(normalizeGoalSpec(null)).toBeUndefined()
    expect(normalizeGoalSpec({ summary: 'x', successConditions: 'nope' })).toBeUndefined()
  })
})

describe('deriveGoalSpecFromNodes', () => {
  it('derives from node postconditions in graph order; unsafe ones double as terminal state', () => {
    const nodes = [
      node('a', 'trigger', {}),
      node('b', 'forms', {
        __reliability: {
          intent: '提交登录表单',
          idempotency: 'unsafe',
          postconditions: [{ kind: 'urlContains', value: '/dashboard' }],
        },
      }),
      node('c', 'get-text', {
        __reliability: {
          intent: '读取欢迎语',
          postconditions: [{ kind: 'elementText', target: { role: 'h1' }, expected: '欢迎' }],
        },
      }),
    ]
    const goal = deriveGoalSpecFromNodes({ name: 'wf', nodes }, '登录并看到欢迎语')
    expect(goal?.summary).toBe('登录并看到欢迎语')
    expect(goal?.successConditions.map((c) => c.kind)).toEqual(['urlContains', 'elementText'])
    expect(goal?.terminalStateConditions?.map((c) => c.kind)).toEqual(['urlContains'])
  })

  it('derives nothing when no node declares postconditions (no invented facts)', () => {
    const goal = deriveGoalSpecFromNodes(
      { name: 'wf', nodes: [node('a', 'trigger', {}), node('b', 'click', {})] },
      '随便点点',
    )
    expect(goal).toBeUndefined()
  })
})

describe('evaluateCondition', () => {
  it('urlContains / urlMatches read the live URL', async () => {
    const probe = fakeProbe({ url: 'https://x.test/dashboard?ok=1' })
    expect(
      (await evaluateCondition({ kind: 'urlContains', value: '/dashboard' }, { variables: {}, probe }))
        .satisfied,
    ).toBe(true)
    expect(
      (
        await evaluateCondition(
          { kind: 'urlMatches', value: 'dashboard\\?ok=1' },
          { variables: {}, probe },
        )
      ).satisfied,
    ).toBe(true)
    expect(
      (await evaluateCondition({ kind: 'urlContains', value: '/admin' }, { variables: {}, probe }))
        .satisfied,
    ).toBe(false)
  })

  it('elementText supports exact and contains matching', async () => {
    const probe = fakeProbe({ text: '欢迎回来，张三' })
    const target = { role: 'h1' }
    expect(
      (
        await evaluateCondition(
          { kind: 'elementText', target, expected: '张三', match: 'contains' },
          { variables: {}, probe },
        )
      ).satisfied,
    ).toBe(true)
    expect(
      (
        await evaluateCondition(
          { kind: 'elementText', target, expected: '欢迎回来，张三', match: 'exact' },
          { variables: {}, probe },
        )
      ).satisfied,
    ).toBe(true)
    expect(
      (
        await evaluateCondition(
          { kind: 'elementText', target, expected: '再见', match: 'contains' },
          { variables: {}, probe },
        )
      ).detail,
    ).toContain('文本为')
  })

  it('variable conditions read the run bag with JSON-level equality', async () => {
    const probe = fakeProbe({})
    expect(
      (
        await evaluateCondition(
          { kind: 'variableEquals', name: 'n', expected: 3 },
          { variables: { n: 3 }, probe },
        )
      ).satisfied,
    ).toBe(true)
    expect(
      (
        await evaluateCondition(
          { kind: 'variableExists', name: 'missing' },
          { variables: {}, probe },
        )
      ).satisfied,
    ).toBe(false)
  })

  it('count conditions compare against the live match count', async () => {
    const target = { role: 'button' }
    const probe = fakeProbe({ count: 2 })
    expect(
      (await evaluateCondition({ kind: 'count', target, op: 'gte', value: 2 }, { variables: {}, probe }))
        .satisfied,
    ).toBe(true)
    expect(
      (await evaluateCondition({ kind: 'count', target, op: 'eq', value: 1 }, { variables: {}, probe }))
        .satisfied,
    ).toBe(false)
  })

  it('evaluateAllConditions short-circuits at the first failure', async () => {
    const probe = fakeProbe({ url: 'https://x.test/other' })
    const conditions: WorkflowCondition[] = [
      { kind: 'urlContains', value: '/dashboard' },
      { kind: 'elementExists', target: { role: 'h1' } },
    ]
    const result = await evaluateAllConditions(conditions, { variables: {}, probe })
    expect(result.allSatisfied).toBe(false)
    expect(result.outcomes).toHaveLength(1) // stopped at the URL failure
  })
})

describe('verifyGoalSpec', () => {
  const goal = {
    summary: '登录成功',
    successConditions: [{ kind: 'urlContains', value: '/dashboard' }] as WorkflowCondition[],
    terminalStateConditions: [{ kind: 'urlContains', value: '/account' }] as WorkflowCondition[],
  }

  it('achieved when the success conditions hold', async () => {
    const verdict = await verifyGoalSpec(goal, {
      variables: {},
      probe: fakeProbe({ url: 'https://x.test/dashboard' }),
    })
    expect(verdict.achieved).toBe(true)
    expect(verdict.alreadySatisfied).toBeUndefined()
    expect(verdict.unmet).toHaveLength(0)
  })

  it('alreadySatisfied when only the terminal state holds', async () => {
    const verdict = await verifyGoalSpec(goal, {
      variables: {},
      probe: fakeProbe({ url: 'https://x.test/account' }),
    })
    expect(verdict.achieved).toBe(true)
    expect(verdict.alreadySatisfied).toBe(true)
  })

  it('NOT achieved (fail closed) when conditions fail — LLM cannot forge success', async () => {
    const verdict = await verifyGoalSpec(
      goal,
      { variables: {}, probe: fakeProbe({ url: 'https://x.test/login' }) },
      async () => ({ plausible: true, note: '看起来登录了' }),
    )
    expect(verdict.achieved).toBe(false)
    expect(verdict.unmet).toEqual(['URL 包含 "/dashboard"'])
    expect(verdict.note).toContain('不可作为成功依据')
  })

  it('a failing or absent judge keeps the deterministic failure', async () => {
    const failing = await verifyGoalSpec(
      goal,
      { variables: {}, probe: fakeProbe({ url: 'https://x.test/login' }) },
      async () => {
        throw new Error('judge down')
      },
    )
    expect(failing.achieved).toBe(false)
    const absent = await verifyGoalSpec(goal, {
      variables: {},
      probe: fakeProbe({ url: 'https://x.test/login' }),
    })
    expect(absent.achieved).toBe(false)
    expect(absent.note).toContain('目标未达成')
  })
})
