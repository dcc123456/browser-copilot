/**
 * Generated-workflow static validation tests (spec §9/§12 Phase 6): six
 * layers — A graph, B data flow, C locator, D readiness, E side effect,
 * F goal — checked without a browser. `error` blocks save/run; warnings
 * annotate. Compat (non-generated) workflows are never gated.
 */
import { describe, expect, it } from 'vitest'
import {
  validateGeneratedWorkflow,
  blockingIssues,
} from '../src/lib/workflow/generated-validation'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

// --- graph builder ---------------------------------------------------------------

let seq = 0
function nid(): string {
  return `n${++seq}`
}

function makeNode(blockId: string, data: Record<string, unknown> = {}, label = blockId): WorkflowNode {
  return { id: nid(), label, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

function makeEdge(source: string, target: string, sourceHandle = 'next'): WorkflowEdge {
  return { id: nid(), source, target, sourceHandle, targetHandle: 'input-1' }
}

function triggerNode(): WorkflowNode {
  return makeNode('trigger', { type: 'manual', enabled: true })
}

function linearWorkflow(...nodes: WorkflowNode[]): Workflow {
  const edges: WorkflowEdge[] = []
  for (let i = 0; i + 1 < nodes.length; i++) {
    edges.push(makeEdge(nodes[i]!.id, nodes[i + 1]!.id))
  }
  return {
    id: 'wf',
    name: 'wf',
    description: '',
    trigger: { type: 'manual', enabled: true },
    settings: { ...({ provenance: 'chat-generate' } as unknown as Workflow['settings']) },
    table: [],
    drawflow: { nodes, edges },
    createdAt: 0,
    updatedAt: 0,
  }
}

const CLICK_CONTRACT = {
  __reliability: {
    intent: '点击',
    idempotency: 'safe',
    postconditions: [{ kind: 'elementExists', target: { testId: 'x' } }],
  },
}

const SUBMIT_CONTRACT = {
  __reliability: {
    intent: '提交登录',
    idempotency: 'unsafe',
    postconditions: [{ kind: 'urlContains', value: '/dashboard' }],
  },
}

/** A minimal workflow that passes all six layers. */
function validWorkflow(): Workflow {
  return linearWorkflow(
    triggerNode(),
    makeNode('open-url', { url: 'https://x.test/login' }),
    makeNode('forms', { action: 'fill', selector: '#user', value: '{{user}}', fields: [] }),
    makeNode('set-variable', { variableName: 'user', value: 'u1' }),
    makeNode('forms', { action: 'submit', selector: '#login', value: '', ...SUBMIT_CONTRACT }),
    makeNode('get-text', { selector: 'h1', variableName: 'title', saveData: false }),
  )
}

function codes(report: ReturnType<typeof validateGeneratedWorkflow>): string[] {
  return report.errors.map((i) => i.code)
}

// --- layer A: graph ---------------------------------------------------------------

describe('layer A — graph', () => {
  it('empty graph is an error', () => {
    const report = validateGeneratedWorkflow(linearWorkflow())
    expect(codes(report)).toContain('GRAPH_EMPTY')
  })

  it('unreachable node is an error', () => {
    const wf = validWorkflow()
    const orphan = makeNode('get-text', { selector: 'h2' })
    wf.drawflow.nodes.push(orphan)
    const report = validateGeneratedWorkflow(wf)
    expect(codes(report)).toContain('GRAPH_UNREACHABLE_NODE')
    expect(report.issues.find((i) => i.code === 'GRAPH_UNREACHABLE_NODE')?.nodeId).toBe(orphan.id)
  })

  it('unknown block id is an error', () => {
    const wf = validWorkflow()
    wf.drawflow.nodes.push(makeNode('definitely-not-a-block', {}))
    wf.drawflow.edges.push(makeEdge(wf.drawflow.nodes[0]!.id, wf.drawflow.nodes.at(-1)!.id))
    const report = validateGeneratedWorkflow(wf)
    expect(codes(report)).toContain('GRAPH_UNKNOWN_BLOCK')
  })

  it('branch edges via output handles keep nodes reachable', () => {
    const wf = validWorkflow()
    const cond = makeNode('element-exists', { selector: '#x' })
    const branch = makeNode('get-text', { selector: 'h3' })
    wf.drawflow.nodes.push(cond, branch)
    const tail = wf.drawflow.nodes[1]!
    wf.drawflow.edges.push(makeEdge(tail.id, cond.id, 'next'))
    wf.drawflow.edges.push(makeEdge(cond.id, branch.id, 'element-exists-output-1'))
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('GRAPH_'))).toHaveLength(0)
  })
})

// --- layer B: data flow ------------------------------------------------------------

describe('layer B — data flow', () => {
  it('a referenced variable with no writer is an error', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('forms', { action: 'fill', selector: '#q', value: '{{missingVar}}' }),
    )
    expect(codes(validateGeneratedWorkflow(wf))).toContain('DATA_UNWRITTEN_VARIABLE')
  })

  it('a variable written upstream satisfies the reference', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('set-variable', { variableName: 'q', value: 'phone' }),
      makeNode('forms', { action: 'fill', selector: '#q', value: '{{q}}' }),
    )
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('DATA_'))).toHaveLength(0)
  })

  it('declared workflow inputs count as written', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('open-url', { url: 'https://x.test/?q={{keyword}}' }),
    )
    ;(wf.settings as unknown as Record<string, unknown>)['inputs'] = [{ name: 'keyword' }]
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('DATA_'))).toHaveLength(0)
  })

  it('table references do not need a variable writer', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('set-variable', { variableName: 'q', value: '{{table[0][1]}}' }),
      makeNode('forms', { action: 'fill', selector: '#q', value: '{{q}}' }),
    )
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('DATA_'))).toHaveLength(0)
  })
})

// --- layer C: locator ---------------------------------------------------------------

describe('layer C — locator', () => {
  it('element block without a locator is an error', () => {
    const wf = linearWorkflow(triggerNode(), makeNode('get-text', {}))
    expect(codes(validateGeneratedWorkflow(wf))).toContain('LOCATOR_MISSING')
  })

  it('nth-child selectors are refused on generated-strict runs', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', { selector: '.list > div:nth-child(2) button' }),
    )
    expect(codes(validateGeneratedWorkflow(wf))).toContain('LOCATOR_POSITIONAL')
  })

  it('generated class tokens (ember-1234 / css-1a2b3c) are refused', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', { selector: '#ember-1234 .css-1a2b3c' }),
    )
    expect(codes(validateGeneratedWorkflow(wf))).toContain('LOCATOR_UNSTABLE_TOKEN')
  })

  it('stable selectors pass the locator layer', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', { selector: '[data-testid="checkout"]', ...CLICK_CONTRACT }),
    )
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('LOCATOR_'))).toHaveLength(0)
  })

  it('positional selectors are allowed on compat workflows (never gated)', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', { selector: '.list > div:nth-child(2) button' }),
    )
    wf.settings = { ...wf.settings, provenance: undefined }
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('LOCATOR_'))).toHaveLength(0)
  })
})

// --- layer D: readiness -------------------------------------------------------------

describe('layer D — readiness', () => {
  it('out-of-window readiness timeout is an error', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', {
        selector: '[data-testid="x"]',
        ...CLICK_CONTRACT,
        __reliability: {
          intent: '点击',
          postconditions: [{ kind: 'elementExists', target: { testId: 'x' } }],
          readiness: { before: [{ state: 'present', timeoutMs: 120_000 }] },
        },
      }),
    )
    expect(codes(validateGeneratedWorkflow(wf))).toContain('READINESS_TIMEOUT_RANGE')
  })

  it('a sane explicit contract produces no readiness issues', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', {
        selector: '[data-testid="x"]',
        ...CLICK_CONTRACT,
        __reliability: {
          intent: '点击',
          postconditions: [{ kind: 'elementExists', target: { testId: 'x' } }],
          readiness: { before: [{ state: 'visible' }] },
        },
      }),
    )
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('READINESS_'))).toHaveLength(0)
  })
})

// --- layer E: side effects -----------------------------------------------------------

describe('layer E — side effects', () => {
  it('submit without idempotency is an error on strict runs', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('forms', { action: 'submit', selector: '#login', value: '' }),
    )
    expect(codes(validateGeneratedWorkflow(wf))).toContain('SIDE_EFFECT_IDEMPOTENCY_MISSING')
  })

  it('submit without postconditions is an error on strict runs', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('forms', {
        action: 'submit',
        selector: '#login',
        value: '',
        __reliability: { intent: '提交', idempotency: 'unsafe' },
      }),
    )
    expect(codes(validateGeneratedWorkflow(wf))).toContain('SIDE_EFFECT_POSTCONDITION_MISSING')
  })

  it('submit with the full contract passes the side-effect layer', () => {
    const wf = linearWorkflow(triggerNode(), makeNode('forms', { action: 'submit', selector: '#login', value: '', ...SUBMIT_CONTRACT }))
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('SIDE_EFFECT_'))).toHaveLength(0)
  })

  it('safe fills are not gated by the side-effect layer', () => {
    const wf = linearWorkflow(triggerNode(), makeNode('forms', { action: 'fill', selector: '#q', value: 'x' }))
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('SIDE_EFFECT_'))).toHaveLength(0)
  })

  it('unsafe submits on compat workflows are not gated', () => {
    const wf = linearWorkflow(triggerNode(), makeNode('forms', { action: 'submit', selector: '#login', value: '' }))
    wf.settings = { ...wf.settings, provenance: undefined }
    expect(validateGeneratedWorkflow(wf).ok).toBe(true)
  })
})

// --- layer F: goal --------------------------------------------------------------------

describe('layer F — goal', () => {
  it('strict workflow WITH unsafe actions and no goalSpec is an error', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('forms', { action: 'submit', selector: '#login', value: '' }),
    )
    expect(codes(validateGeneratedWorkflow(wf))).toContain('GOAL_MISSING')
  })

  it('strict read-only workflow without goalSpec is NOT gated (no false-success risk)', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', { selector: '#x' }),
      makeNode('get-text', { selector: 'h1', variableName: 'title', saveData: false }),
    )
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('GOAL_'))).toHaveLength(0)
  })

  it('goalSpec derived from postconditions satisfies the layer', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', { selector: '#x', ...CLICK_CONTRACT }),
    )
    expect(codes(validateGeneratedWorkflow(wf)).filter((c) => c.startsWith('GOAL_'))).toHaveLength(0)
  })

  it('an empty declared goalSpec with nothing derivable stays GOAL_MISSING', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('forms', { action: 'submit', selector: '#login', value: '' }),
    )
    wf.settings = { ...wf.settings, goalSpec: { summary: 's', successConditions: [] } }
    expect(codes(validateGeneratedWorkflow(wf))).toContain('GOAL_MISSING')
  })
})

// --- integration ----------------------------------------------------------------------

describe('report shape and gating', () => {
  it('a fully-contracted workflow validates clean', () => {
    const report = validateGeneratedWorkflow(validWorkflow())
    expect(report.ok).toBe(true)
    expect(blockingIssues(report)).toHaveLength(0)
  })

  it('ok is false iff there is at least one error; warnings never block', () => {
    const wf = validWorkflow()
    wf.drawflow.nodes.push(makeNode('get-text', { selector: 'h9' })) // unreachable → error
    const report = validateGeneratedWorkflow(wf)
    expect(report.ok).toBe(false)
    expect(report.errors.length).toBeGreaterThanOrEqual(1)
    expect(report.issues).toHaveLength(report.errors.length + report.warnings.length)
  })

  it('every error carries a code and message; most carry a suggestedFix', () => {
    const report = validateGeneratedWorkflow(linearWorkflow(triggerNode(), makeNode('forms', { action: 'submit', selector: '#l', value: '' })))
    for (const issue of report.errors) {
      expect(issue.code).toMatch(/^[A-Z_]+$/)
      expect(issue.message).toBeTruthy()
    }
    expect(report.errors[0]?.suggestedFix).toBeTruthy()
  })

  it('compat workflows are never blocked', () => {
    const wf = linearWorkflow(
      triggerNode(),
      makeNode('event-click', { selector: '.x:nth-child(3)' }),
      makeNode('forms', { action: 'submit', selector: '#login', value: '{{undeclared}}' }),
    )
    wf.settings = { ...wf.settings, provenance: undefined } as unknown as Workflow['settings']
    expect(validateGeneratedWorkflow(wf).ok).toBe(true)
  })
})
