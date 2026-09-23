import { describe, expect, it } from 'vitest'
import { TraceCollector, inputRefsOf } from '../../src/lib/workflow/execution-trace'
import { edge, makeWorkflow, node } from './helpers'

describe('ExecutionTrace collector (Phase 1)', () => {
  it('records one NodeExecutionTrace per node in a linear workflow', () => {
    const workflow = makeWorkflow(
      [
        node('t', 'trigger'),
        node('a', 'get-text', { variableName: 'v1' }),
        node('b', 'event-click', { selector: '{{v1}}' }),
      ],
      [edge('t', 'a'), edge('a', 'b')],
    )
    const collector = new TraceCollector({
      workflowId: workflow.id,
      runId: 'r',
      entry: 'DEBUG',
    })
    let incoming: Record<string, unknown> = {}
    for (const wfNode of workflow.drawflow.nodes) {
      collector.startNode(wfNode, incoming)
      if (wfNode.id === 'a') incoming = { v1: 'hello' }
      collector.finishNode(wfNode, 'ok', incoming, incoming)
    }
    const trace = collector.build('ok', incoming)
    expect(trace.nodeExecutions).toHaveLength(3)
    expect(trace.nodeExecutions.map((record) => record.nodeId)).toEqual(['t', 'a', 'b'])
  })

  it('retries append attempts instead of overwriting the previous one', () => {
    const workflow = makeWorkflow(
      [node('t', 'trigger'), node('a', 'event-click', { selector: '.btn' })],
      [edge('t', 'a')],
    )
    const collector = new TraceCollector({ workflowId: workflow.id, runId: 'r', entry: 'DEBUG' })
    const wfNode = workflow.drawflow.nodes[1]!
    collector.startNode(wfNode, {})
    collector.finishNode(
      wfNode,
      'failed',
      {},
      {},
      {
        code: 'PAGE_NOT_READY',
        message: 'PAGE_NOT_READY',
        nodeId: 'a',
        retryable: true,
        source: 'EXECUTOR',
      },
    )
    collector.startNode(wfNode, {})
    collector.finishNode(wfNode, 'ok', {}, {})
    const trace = collector.build('ok', {})
    const attempts = trace.nodeExecutions.filter((record) => record.nodeId === 'a')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.attempt).toBe(0)
    expect(attempts[0]!.status).toBe('failed')
    expect(attempts[1]!.attempt).toBe(1)
    expect(attempts[1]!.status).toBe('ok')
  })

  it('failedNodeId matches the last failed node', () => {
    const workflow = makeWorkflow(
      [node('t', 'trigger'), node('a', 'event-click', { selector: '.x' })],
      [edge('t', 'a')],
    )
    const collector = new TraceCollector({ workflowId: workflow.id, runId: 'r', entry: 'DEBUG' })
    const wfNode = workflow.drawflow.nodes[1]!
    collector.startNode(wfNode, {})
    collector.finishNode(
      wfNode,
      'failed',
      {},
      {},
      {
        code: 'TARGET_NOT_FOUND',
        message: 'TARGET_NOT_FOUND',
        nodeId: 'a',
        retryable: true,
        source: 'EXECUTOR',
      },
    )
    const trace = collector.build(
      'failed',
      {},
      {
        code: 'TARGET_NOT_FOUND',
        message: 'TARGET_NOT_FOUND',
        nodeId: 'a',
        retryable: true,
        source: 'EXECUTOR',
      },
    )
    expect(trace.failedNodeId).toBe('a')
  })

  it('does not retain raw sensitive values, only summaries', () => {
    const workflow = makeWorkflow(
      [node('t', 'trigger'), node('a', 'set-variable', { variableName: 'password' })],
      [edge('t', 'a')],
    )
    const collector = new TraceCollector({ workflowId: workflow.id, runId: 'r', entry: 'DEBUG' })
    const wfNode = workflow.drawflow.nodes[1]!
    collector.startNode(wfNode, {})
    collector.finishNode(wfNode, 'ok', {}, { password: 'super-secret-value' })
    const trace = collector.build('ok', { password: 'super-secret-value' })
    const json = JSON.stringify(trace)
    expect(json).not.toContain('super-secret-value')
    expect(trace.finalVariables['password']?.redacted).toBe(true)
  })

  it('inputRefsOf extracts nested {{a.b.0}} roots and resolves them against the bag', () => {
    const wfNode = node('a', 'event-click', {
      selector: '{{user.name}} and {{missing}}',
    })
    const refs = inputRefsOf(wfNode, { user: { name: 'bob' } })
    expect(refs.map((ref) => ref.variable).sort()).toEqual(['missing', 'user'])
    const user = refs.find((ref) => ref.variable === 'user')!
    expect(user.resolved).toBe(true)
    expect(refs.find((ref) => ref.variable === 'missing')!.resolved).toBe(false)
  })

  it('records checkpoints independently of node executions', () => {
    const collector = new TraceCollector({ workflowId: 'wf', runId: 'r', entry: 'REPLAY' })
    collector.recordCheckpoint(0, 'a', 'ok', { v: 1 })
    const trace = collector.build('ok', { v: 1 })
    expect(trace.checkpoints).toHaveLength(1)
    expect(trace.checkpoints[0]!.checkpointId).toBe('r:0')
    expect(trace.checkpoints[0]!.snapshotAvailable).toBe(true)
  })

  it('marks snapshotAvailable=false explicitly instead of silent empty vars', () => {
    const collector = new TraceCollector({ workflowId: 'wf', runId: 'r', entry: 'REPLAY' })
    // Snapshot failed: summaries must NOT be treated as a real empty state.
    collector.recordCheckpoint(2, 'a', 'ok', { v: 1 }, false)
    const trace = collector.build('ok', {})
    const checkpoint = trace.checkpoints[0]!
    expect(checkpoint.snapshotAvailable).toBe(false)
    expect(checkpoint.variableSummaries).toEqual({})
    // An explicit, non-silent error event is recorded.
    expect(
      trace.events.some((event) => event.kind === 'error' && /snapshot unavailable/.test(event.text)),
    ).toBe(true)
  })
})
