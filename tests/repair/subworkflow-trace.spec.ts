/**
 * Cross-sub-workflow trace tests (P3, spec §15 Phase 8).
 */
import { describe, expect, it } from 'vitest'

import { TraceCollector } from '../../src/lib/workflow/execution-trace'
import {
  failureIsInSubWorkflow,
  findNodeExecution,
  nodeWorkflowPath,
  qualifiedNodeId,
  workflowOfNode,
} from '../../src/lib/workflow/repair/subworkflow-trace'
import type { WorkflowNode } from '../../src/lib/workflow/types'

const node = (id: string, blockId = 'delay'): WorkflowNode => ({
  id,
  label: blockId,
  position: { x: 0, y: 0 },
  data: { blockId },
})

describe('cross-sub-workflow trace', () => {
  it('records the nesting path and stamps child node executions', () => {
    const collector = new TraceCollector({
      workflowId: 'parent',
      runId: 'r',
      entry: 'DEBUG',
    })

    collector.startNode(node('p1'), {})
    collector.finishNode(node('p1'), 'ok', {}, { x: 1 })

    // Enter a child workflow and run a node there.
    collector.enterSubWorkflow('child')
    expect(collector.currentWorkflowPathIndex()).toBe(1)
    collector.startNode(node('c1'), {})
    collector.finishNode(node('c1'), 'failed', {}, {})

    // While nested the path spans parent→child.
    const nestedTrace = collector.build('failed', {})
    expect(nestedTrace.workflowPath).toEqual(['parent', 'child'])
    const childRun = nestedTrace.nodeExecutions.find((entry) => entry.nodeId === 'c1')!
    expect(childRun.workflowPathIndex).toBe(1)
    expect(workflowOfNode(nestedTrace, childRun)).toBe('child')
    expect(nodeWorkflowPath(nestedTrace, childRun)).toEqual(['parent', 'child'])
    expect(qualifiedNodeId(nestedTrace, childRun)).toBe('parent/child::c1')

    collector.exitSubWorkflow()

    expect(collector.currentWorkflowPathIndex()).toBe(0)

    const trace = collector.build('failed', {})
    const parentRun = trace.nodeExecutions.find((entry) => entry.nodeId === 'p1')!
    expect(parentRun.workflowPathIndex).toBeUndefined()
    expect(workflowOfNode(trace, parentRun)).toBe('parent')
  })

  it('attributes a failed node in a child to the child workflow', () => {
    const collector = new TraceCollector({
      workflowId: 'parent',
      runId: 'r',
      entry: 'GENERATION',
    })
    collector.enterSubWorkflow('child')
    collector.startNode(node('c9', 'click'), {})
    collector.finishNode(
      node('c9', 'click'),
      'failed',
      {},
      {},
      {
        code: 'TARGET_NOT_FOUND',
        message: 'missing',
        nodeId: 'c9',
        retryable: false,
        source: 'EXECUTOR',
      },
    )
    collector.exitSubWorkflow()
    const trace = collector.build('failed', {})
    expect(trace.failedNodeId).toBe('c9')
    expect(failureIsInSubWorkflow(trace)).toBe(true)
  })

  it('prefers the deepest nested record for a recurring node id', () => {
    const collector = new TraceCollector({
      workflowId: 'parent',
      runId: 'r',
      entry: 'DEBUG',
    })
    collector.startNode(node('n', 'delay'), {})
    collector.finishNode(node('n', 'delay'), 'ok', {}, {})
    collector.enterSubWorkflow('child')
    collector.startNode(node('n', 'click'), {})
    collector.finishNode(node('n', 'click'), 'failed', {}, {})
    collector.exitSubWorkflow()
    const trace = collector.build('failed', {})
    const resolved = findNodeExecution(trace, 'n')!
    expect(resolved.workflowPathIndex).toBe(1)
    expect(resolved.blockId).toBe('click')
  })

  it('handles balanced enter/exit even with more exits than entries', () => {
    const collector = new TraceCollector({
      workflowId: 'root',
      runId: 'r',
      entry: 'DEBUG',
    })
    collector.exitSubWorkflow() // no-op: never leave the root
    expect(collector.currentWorkflowPathIndex()).toBe(0)
  })
})
