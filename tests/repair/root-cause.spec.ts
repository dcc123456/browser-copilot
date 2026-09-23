import { describe, expect, it } from 'vitest'
import { analyzeFailure } from '../../src/background/workflow-engine/repair/failure-analyzer'
import { canonicalizeAnalysis } from '../../src/background/workflow-engine/repair/root-cause-analyzer'
import type { ExecutionTrace } from '../../src/lib/workflow/repair/types'
import { buildTrace, edge, linearChain, makeWorkflow, node } from './helpers'

/**
 * Linear chain: trigger t, get-text n3 (produces captcha),
 * event-click n5 (consumes {{captcha}}).
 */
function captchaChain(options: {
  producerValue?: unknown
  consumerRef?: string
  producerVariable?: string
  consumerVariableName?: boolean
}) {
  const nodes = [
    node('t', 'trigger'),
    node('n3', 'get-text', {
      variableName: options.producerVariable ?? 'captcha',
    }),
    node('n5', 'event-click', {
      selector: options.consumerRef ?? '{{captcha}}',
    }),
  ]
  const edges = [edge('t', 'n3'), edge('n3', 'n5')]
  return makeWorkflow(nodes, edges)
}

describe('FailureAnalyzer root cause (Test A–F)', () => {
  it('Test A: failed node itself when its own selector is wrong', () => {
    const { nodes, edges } = linearChain(
      ['t', 'n5'],
      (id) => (id === 't' ? 'trigger' : 'event-click'),
      (id) => (id === 'n5' ? { selector: '.stale' } : {}),
    )
    const workflow = makeWorkflow(nodes, edges)
    const trace = buildTrace(
      workflow,
      'runA',
      [
        { id: 't', status: 'ok', variables: {} },
        {
          id: 'n5',
          status: 'failed',
          variables: {},
          error: 'LOCATOR_NOT_FOUND: .stale',
        },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    expect(analysis.failedNodeId).toBe('n5')
    expect(analysis.rootCauseNodeIds).toEqual(['n5'])
    expect(analysis.repairTarget).toBe('FAILED_NODE')
  })

  it('Test B: direct upstream empty variable → producer is root cause', () => {
    const workflow = captchaChain({ producerValue: '' })
    const trace = buildTrace(
      workflow,
      'runB',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '' } },
        {
          id: 'n5',
          status: 'failed',
          variables: { captcha: '' },
          error: 'some action error',
        },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    expect(analysis.failedNodeId).toBe('n5')
    expect(analysis.rootCauseNodeIds).toEqual(['n3'])
    expect(analysis.repairTarget).toBe('UPSTREAM_NODE')
  })

  it('Test C: transform node is root; its valid upstream is not blamed', () => {
    // t → n3 get-text rawCaptcha → n6 regex-variable captcha → n8 event-click
    const workflow = makeWorkflow(
      [
        node('t', 'trigger'),
        node('n3', 'get-text', { variableName: 'rawCaptcha' }),
        node('n6', 'regex-variable', {
          variableName: 'captcha',
          variable: '{{rawCaptcha}}',
        }),
        node('n8', 'event-click', { selector: '{{captcha}}' }),
      ],
      [edge('t', 'n3'), edge('n3', 'n6'), edge('n6', 'n8')],
    )
    const trace = buildTrace(
      workflow,
      'runC',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { rawCaptcha: '123456' } },
        {
          id: 'n6',
          status: 'ok',
          variables: { rawCaptcha: '123456', captcha: undefined },
        },
        {
          id: 'n8',
          status: 'failed',
          variables: { rawCaptcha: '123456', captcha: undefined },
          error: 'ACTION_ERROR',
        },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    expect(analysis.rootCauseNodeIds).toEqual(['n6'])
    expect(analysis.rootCauseNodeIds).not.toContain('n3')
  })

  it('Test D: two independent upstream roots', () => {
    const workflow = makeWorkflow(
      [
        node('t', 'trigger'),
        node('n3', 'get-text', { variableName: 'username' }),
        node('n4', 'get-text', { variableName: 'password' }),
        node('n5', 'forms', { value: '{{username}} {{password}}' }),
      ],
      [edge('t', 'n3'), edge('n3', 'n4'), edge('n4', 'n5')],
    )
    const trace = buildTrace(
      workflow,
      'runD',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { username: '' } },
        { id: 'n4', status: 'ok', variables: { username: '', password: '' } },
        {
          id: 'n5',
          status: 'failed',
          variables: { username: '', password: '' },
          error: 'ACTION_ERROR',
        },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    expect(analysis.rootCauseNodeIds.sort()).toEqual(['n3', 'n4'])
    expect(analysis.repairTarget).toBe('MULTIPLE_NODES')
  })

  it('Test E: misspelled variable reference blamed on the consumer', () => {
    // n3 produces captcha; n5 references {{captch}} which nothing produces.
    const workflow = makeWorkflow(
      [
        node('t', 'trigger'),
        node('n3', 'get-text', { variableName: 'captcha' }),
        node('n5', 'event-click', { selector: '{{captch}}' }),
      ],
      [edge('t', 'n3'), edge('n3', 'n5')],
    )
    const trace = buildTrace(
      workflow,
      'runE',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '123456' } },
        {
          id: 'n5',
          status: 'failed',
          variables: { captcha: '123456' },
          error: 'ACTION_ERROR',
        },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    expect(analysis.rootCauseNodeIds).toEqual(['n5'])
  })

  it('Test F: CAPTCHA failure → NO_SAFE_REPAIR', () => {
    const workflow = captchaChain({})
    const trace = buildTrace(
      workflow,
      'runF',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: 'abc' } },
        {
          id: 'n5',
          status: 'failed',
          variables: { captcha: 'abc' },
          error: 'CAPTCHA required',
        },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    expect(analysis.repairTarget).toBe('NO_SAFE_REPAIR')
  })

  it('Test F2: PAGE_NOT_READY recommends retry before patching', () => {
    const { nodes, edges } = linearChain(
      ['t', 'n5'],
      (id) => (id === 't' ? 'trigger' : 'event-click'),
      (id) => (id === 'n5' ? { selector: '.btn' } : {}),
    )
    const workflow = makeWorkflow(nodes, edges)
    const trace: ExecutionTrace = buildTrace(
      workflow,
      'runT',
      [
        { id: 't', status: 'ok', variables: {} },
        {
          id: 'n5',
          status: 'failed',
          variables: {},
          error: 'PAGE_NOT_READY: page not ready',
        },
      ],
      {},
    )
    const analysis = analyzeFailure({ workflow, trace })
    expect(analysis.retryRecommended).toBe(true)
  })

  it('canonicalize: two diagnoses from identical workflows compare equal', () => {
    const workflow = captchaChain({})
    const traceA = buildTrace(
      workflow,
      'run1',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '' } },
        { id: 'n5', status: 'failed', variables: { captcha: '' }, error: 'e' },
      ],
      {},
    )
    const traceB = buildTrace(
      workflow,
      'run2',
      [
        { id: 't', status: 'ok', variables: {} },
        { id: 'n3', status: 'ok', variables: { captcha: '' } },
        { id: 'n5', status: 'failed', variables: { captcha: '' }, error: 'e' },
      ],
      { entry: 'GENERATION' },
    )
    const a = canonicalizeAnalysis(analyzeFailure({ workflow, trace: traceA }))
    const b = canonicalizeAnalysis(analyzeFailure({ workflow, trace: traceB }))
    expect(a).toEqual(b)
  })
})
