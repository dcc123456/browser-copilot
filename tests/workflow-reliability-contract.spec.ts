/**
 * The Reliability Contract unit tests (spec §4 Phase 1).
 *
 * Covers: mode resolution (old → compat, generated → strict, explicit wins),
 * old-JSON deserialization tolerance, the node `__reliability` accessor's
 * untrusted-input handling, block+intent idempotency classification, the
 * strict goal gate, and the ambiguity policy split.
 */
import { describe, expect, it } from 'vitest'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import {
  ambiguityPolicyOf,
  goalGateProblems,
  goalSpecOf,
  idempotencyOf,
  isGeneratedStrict,
  nodeReliabilityOf,
  reliabilityModeOf,
  requiresTerminalStateCheck,
  withNodeReliability,
} from '../src/lib/workflow/reliability'
import { isWorkflowCondition, describeCondition } from '../src/lib/workflow/conditions'
import {
  defaultReadinessFor,
  normalizeReadinessSpec,
} from '../src/lib/workflow/readiness'
import {
  semanticLocatorFromTarget,
  stableAttributesOf,
  isUnstableValue,
} from '../src/lib/workflow/element-fingerprint'

function workflowOf(
  settings: Record<string, unknown>,
  nodes: Workflow['drawflow']['nodes'] = [],
): Workflow {
  const now = Date.now()
  return {
    id: 'w1',
    name: 'W',
    createdAt: now,
    updatedAt: now,
    drawflow: { nodes, edges: [] },
    trigger: { type: 'manual' },
    settings: settings as unknown as Workflow['settings'],
  }
}

/** A node performing an UNSAFE action (forms submit) — the goal gate's trigger. */
function unsafeSubmitNode(): Workflow['drawflow']['nodes'][number] {
  return {
    id: 'n-submit',
    label: 'forms',
    position: { x: 0, y: 0 },
    data: { blockId: 'forms', action: 'submit', selector: '#login' },
  }
}

function nodeOf(data: Record<string, unknown>): WorkflowNode {
  return { id: 'n1', label: String(data['blockId'] ?? 'click'), position: { x: 0, y: 0 }, data }
}

describe('reliability mode resolution', () => {
  it('defaults an old workflow (no provenance, no mode) to compat', () => {
    const wf = workflowOf({ saveLog: false, debugMode: false, notification: false })
    expect(reliabilityModeOf(wf)).toBe('compat')
    expect(isGeneratedStrict(wf)).toBe(false)
  })

  it('treats chat-generate provenance as generated-strict', () => {
    const wf = workflowOf({
      saveLog: false,
      debugMode: false,
      notification: false,
      provenance: 'chat-generate',
    })
    expect(reliabilityModeOf(wf)).toBe('generated-strict')
  })

  it('treats chat-history provenance as generated-strict', () => {
    const wf = workflowOf({
      saveLog: false,
      debugMode: false,
      notification: false,
      provenance: 'chat-history',
    })
    expect(reliabilityModeOf(wf)).toBe('generated-strict')
  })

  it('an explicit compat beats a generation provenance', () => {
    const wf = workflowOf({
      saveLog: false,
      debugMode: false,
      notification: false,
      provenance: 'chat-generate',
      reliabilityMode: 'compat',
    })
    expect(reliabilityModeOf(wf)).toBe('compat')
  })

  it('an explicit generated-strict applies without provenance', () => {
    const wf = workflowOf({
      saveLog: false,
      debugMode: false,
      notification: false,
      reliabilityMode: 'generated-strict',
    })
    expect(reliabilityModeOf(wf)).toBe('generated-strict')
  })

  it('ignores unknown mode values', () => {
    const wf = workflowOf({
      saveLog: false,
      debugMode: false,
      notification: false,
      reliabilityMode: 'turbo',
    })
    expect(reliabilityModeOf(wf)).toBe('compat')
  })

  it('old workflow JSON with extra unknown settings still deserializes', () => {
    const wf = workflowOf({ saveLog: false, debugMode: false, notification: false, __reliability: { junk: true } })
    expect(() => reliabilityModeOf(wf)).not.toThrow()
    expect(reliabilityModeOf(wf)).toBe('compat')
  })
})

describe('goal spec gate', () => {
  it('compat workflows are never gated', () => {
    const wf = workflowOf({ saveLog: false, debugMode: false, notification: false })
    expect(goalGateProblems(wf)).toEqual([])
  })

  it('a strict workflow WITH unsafe actions but no goalSpec is blocked', () => {
    const wf = workflowOf(
      {
        saveLog: false,
        debugMode: false,
        notification: false,
        provenance: 'chat-generate',
      },
      [unsafeSubmitNode()],
    )
    expect(goalGateProblems(wf)).toHaveLength(1)
  })

  it('a strict read-only workflow without goalSpec is NOT gated (nothing to verify)', () => {
    const wf = workflowOf({
      saveLog: false,
      debugMode: false,
      notification: false,
      provenance: 'chat-generate',
    })
    expect(goalGateProblems(wf)).toEqual([])
  })

  it('a strict workflow with a well-formed goalSpec passes the gate', () => {
    const wf = workflowOf({
      saveLog: false,
      debugMode: false,
      notification: false,
      provenance: 'chat-generate',
      goalSpec: {
        summary: '订单 10001 已发货',
        successConditions: [
          {
            kind: 'elementText',
            target: { role: 'text', accessibleName: '订单 10001' },
            expected: '已发货',
            match: 'contains',
          },
        ],
      },
    })
    expect(goalGateProblems(wf)).toEqual([])
    expect(goalSpecOf(wf)?.summary).toBe('订单 10001 已发货')
  })

  it('a goalSpec with empty successConditions is rejected', () => {
    const wf = workflowOf(
      {
        saveLog: false,
        debugMode: false,
        notification: false,
        provenance: 'chat-generate',
        goalSpec: { summary: 'x', successConditions: [] },
      },
      [unsafeSubmitNode()],
    )
    expect(goalGateProblems(wf)).toHaveLength(1)
  })

  it('a goalSpec with garbage conditions is rejected', () => {
    const wf = workflowOf(
      {
        saveLog: false,
        debugMode: false,
        notification: false,
        provenance: 'chat-generate',
        goalSpec: { summary: 'x', successConditions: [{ kind: 'nonsense' }] },
      },
      [unsafeSubmitNode()],
    )
    expect(goalGateProblems(wf)).toHaveLength(1)
  })
})

describe('node reliability accessor', () => {
  it('returns undefined for nodes without __reliability (old JSON safe)', () => {
    expect(nodeReliabilityOf(nodeOf({ blockId: 'click', selector: '#a' }))).toBeUndefined()
  })

  it('keeps well-formed fields and drops garbage ones', () => {
    const spec = nodeReliabilityOf(
      nodeOf(
        withNodeReliability(
          { blockId: 'click' },
          {
            intent: '点击发货按钮',
            idempotency: 'conditional',
            preconditions: [{ kind: 'variableExists', name: 'orderId' }],
            postconditions: '不是数组',
            readiness: { before: [{ state: 'visible' }] },
            locator: { selectorVerified: true },
          } as unknown as Parameters<typeof withNodeReliability>[1],
        ),
      ),
    )
    expect(spec?.intent).toBe('点击发货按钮')
    expect(spec?.idempotency).toBe('conditional')
    expect(spec?.preconditions).toHaveLength(1)
    expect(spec?.postconditions).toBeUndefined()
    expect(spec?.readiness?.before).toHaveLength(1)
    expect(spec?.locator?.selectorVerified).toBe(true)
  })

  it('rejects an idempotency value outside the whitelist', () => {
    const spec = nodeReliabilityOf(
      nodeOf(
        withNodeReliability({ blockId: 'click' }, { idempotency: 'yolo' } as unknown as Parameters<typeof withNodeReliability>[1]),
      ),
    )
    expect(spec?.idempotency).toBeUndefined()
  })
})

describe('idempotency classification (block + intent)', () => {
  it('reads are safe', () => {
    expect(idempotencyOf('get-text')).toBe('safe')
    expect(idempotencyOf('read-page')).toBe('safe')
    expect(idempotencyOf('element-exists')).toBe('safe')
  })

  it('a plain click is conditional', () => {
    expect(idempotencyOf('click')).toBe('conditional')
    expect(idempotencyOf('event-click')).toBe('conditional')
  })

  it('a forms submit is unsafe by block', () => {
    expect(idempotencyOf('forms', { action: 'submit' })).toBe('unsafe')
  })

  it('a forms fill is conditional', () => {
    expect(idempotencyOf('forms', { action: 'fill' })).toBe('conditional')
  })

  it('webhook is unsafe by block', () => {
    expect(idempotencyOf('webhook')).toBe('unsafe')
  })

  it('an unsafe intent upgrades a conditional block', () => {
    expect(idempotencyOf('click', { description: '点击登录按钮' })).toBe('unsafe')
    expect(idempotencyOf('forms', { action: 'fill', description: '填写并提交订单' })).toBe('unsafe')
    expect(idempotencyOf('press-key', { description: 'press Enter to submit the form' })).toBe('unsafe')
  })

  it('a benign intent keeps conditional', () => {
    expect(idempotencyOf('click', { description: '展开筛选面板' })).toBe('conditional')
  })

  it('the explicit contract wins over every default', () => {
    const spec = nodeReliabilityOf(nodeOf(withNodeReliability({ blockId: 'click' }, { idempotency: 'safe' })))
    expect(idempotencyOf('click', {}, spec)).toBe('safe')
    const unsafe = nodeReliabilityOf(nodeOf(withNodeReliability({ blockId: 'get-text' }, { idempotency: 'unsafe' })))
    expect(idempotencyOf('get-text', {}, unsafe)).toBe('unsafe')
  })

  it('unknown blocks fall back to conditional', () => {
    expect(idempotencyOf('mystery-block')).toBe('conditional')
  })

  it('terminal-state check requirement follows the unsafe class', () => {
    expect(requiresTerminalStateCheck('forms', { action: 'submit' })).toBe(true)
    expect(requiresTerminalStateCheck('get-text', {})).toBe(false)
    expect(requiresTerminalStateCheck('click', { description: '提交表单' })).toBe(true)
  })
})

describe('ambiguity policy', () => {
  it('strict scores, compat keeps first-visible', () => {
    const compat = workflowOf({ saveLog: false, debugMode: false, notification: false })
    const strict = workflowOf({
      saveLog: false,
      debugMode: false,
      notification: false,
      provenance: 'chat-generate',
    })
    expect(ambiguityPolicyOf(compat)).toBe('first-visible')
    expect(ambiguityPolicyOf(strict)).toBe('score')
  })
})

describe('condition guards', () => {
  it('accepts a well-formed elementText condition', () => {
    expect(
      isWorkflowCondition({
        kind: 'elementText',
        target: { role: 'button', accessibleName: '发货' },
        expected: '已发货',
        match: 'contains',
      }),
    ).toBe(true)
  })

  it('rejects a condition with an empty (identity-less) target', () => {
    expect(
      isWorkflowCondition({ kind: 'elementExists', target: {} }),
    ).toBe(false)
  })

  it('rejects unknown kinds and malformed payloads', () => {
    expect(isWorkflowCondition({ kind: 'magic' })).toBe(false)
    expect(isWorkflowCondition({ kind: 'urlContains' })).toBe(false)
    expect(isWorkflowCondition({ kind: 'elementText', target: { role: 'button' } })).toBe(false)
    expect(
      isWorkflowCondition({ kind: 'count', target: { role: 'list' }, op: 'gte', value: '3' }),
    ).toBe(false)
    expect(isWorkflowCondition('urlContains')).toBe(false)
  })

  it('describes a condition in Chinese for logs/validators', () => {
    const text = describeCondition({
      kind: 'elementText',
      target: { role: 'button', accessibleName: '发货' },
      expected: '已发货',
      match: 'contains',
    })
    expect(text).toContain('发货')
    expect(text).toContain('已发货')
  })
})

describe('readiness defaults and guards', () => {
  it('click waits present+visible+enabled before', () => {
    const spec = defaultReadinessFor('click')
    expect(spec?.before?.map((r) => r.state)).toEqual(['present', 'visible', 'enabled'])
    expect(spec?.after).toBeUndefined()
  })

  it('fill adds a value-committed after-requirement', () => {
    const spec = defaultReadinessFor('forms', { action: 'fill', value: 'hello' })
    expect(spec?.before?.length).toBe(3)
    expect(spec?.after?.[0]?.state).toBe('value-committed')
    expect(spec?.after?.[0]?.value).toBe('hello')
  })

  it('forms submit has no default after-requirement', () => {
    const spec = defaultReadinessFor('forms', { action: 'submit' })
    expect(spec?.after).toBeUndefined()
  })

  it('reads and navigation have their own defaults', () => {
    expect(defaultReadinessFor('get-text')?.before?.map((r) => r.state)).toEqual([
      'present',
      'visible',
    ])
    expect(defaultReadinessFor('attribute-value')?.before?.map((r) => r.state)).toEqual(['present'])
    expect(defaultReadinessFor('read-page')?.before?.[0]?.state).toBe('navigation-settled')
    expect(defaultReadinessFor('new-tab')?.after?.[0]?.state).toBe('navigation-settled')
  })

  it('unknown blocks have no default readiness', () => {
    expect(defaultReadinessFor('webhook')).toBeUndefined()
  })

  it('normalizeReadinessSpec drops garbage and clamps the timeout', () => {
    expect(normalizeReadinessSpec('x')).toBeUndefined()
    expect(normalizeReadinessSpec({ before: [{ state: 'nope' }] })).toBeUndefined()
    const spec = normalizeReadinessSpec({
      before: [{ state: 'visible' }, { state: 42 }],
      timeoutMs: 999_999,
      pollIntervalMs: 5,
    })
    expect(spec?.before).toHaveLength(1)
    expect(spec?.timeoutMs).toBe(60_000)
    expect(spec?.pollIntervalMs).toBe(5)
  })
})

describe('semantic locator derivation', () => {
  it('derives role+name identity from a rich role target', () => {
    const locator = semanticLocatorFromTarget({
      primary: { how: 'role', value: '发货', role: 'button' },
      fallbacks: [],
      label: '发货',
    })
    expect(locator?.role).toBe('button')
    expect(locator?.accessibleName).toBe('发货')
  })

  it('skips css-only targets (a positional path is not identity)', () => {
    expect(
      semanticLocatorFromTarget({
        primary: { how: 'css', value: '.list > div:nth-child(2)' },
        fallbacks: [{ how: 'css', value: '#x' }],
      }),
    ).toBeUndefined()
  })

  it('skips unstable ids but keeps stable ones', () => {
    expect(
      semanticLocatorFromTarget({
        primary: { how: 'id', value: 'css-1x2y3z' },
        fallbacks: [{ how: 'role', value: '登录', role: 'button' }],
      })?.role,
    ).toBe('button')
    expect(
      semanticLocatorFromTarget({ primary: { how: 'id', value: 'login-submit' }, fallbacks: [] })
        ?.stableAttributes,
    ).toEqual({ id: 'login-submit' })
  })

  it('stable attribute filter drops random ids and classes', () => {
    const attrs = stableAttributesOf({
      id: 'ember-1234',
      name: 'email',
      class: 'btn-primary',
      'data-testid': 'submit-order',
    })
    expect(attrs).toEqual({ name: 'email', 'data-testid': 'submit-order' })
  })

  it('isUnstableValue flags the generated shapes', () => {
    expect(isUnstableValue('ember-123')).toBe(true)
    expect(isUnstableValue(':r1a2b:')).toBe(true)
    expect(isUnstableValue('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isUnstableValue('a1b2c3d4e5f6')).toBe(true)
    expect(isUnstableValue('login-submit')).toBe(false)
    expect(isUnstableValue('email')).toBe(false)
  })
})
