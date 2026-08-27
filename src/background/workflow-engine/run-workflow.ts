/**
 * Integration layer that wires the pure engine to a tracked "running task".
 *
 * Starts a `running-tasks` entry so the run appears on the board, streams every
 * engine step into its progress log, and finishes it with the settling outcome.
 * This is the entry point callers (chat, scheduler, Feishu bot, manual run)
 * use to actually execute a workflow.
 *
 * @module background/workflow-engine/run-workflow
 */

import type { Workflow } from '../../lib/workflow/types'
import { addStep, finishRun, startRun, type RunSource } from '../running-tasks'
import { countElements } from '../driver'
import { BLOCK_BY_ID } from '../../lib/workflow/blocks/palette'
import { runWorkflow } from './engine'

/** Resolve a node id to a human-readable block label for run logs. */
function nodeLabel(workflow: Workflow, nodeId: string): string {
  const node = workflow.drawflow.nodes.find((n) => n.id === nodeId)
  if (!node) return nodeId
  const blockId = (node.data?.['blockId'] as string) || node.label
  const block = BLOCK_BY_ID.get(blockId)
  const desc = (node.data?.['description'] as string) || ''
  const name = block?.name ?? blockId
  return desc ? `${name}: ${desc}` : name
}

export interface ExecuteWorkflowOptions {
  source: RunSource
  taskId?: string
  feishuChatId?: string
  variables?: Record<string, unknown>
  /** Optional caller-side sink for each engine step, fired alongside the run log. */
  onStep?: (kind: string, nodeId: string, text: string) => void
}

export interface ExecuteWorkflowResult {
  runId: string
  outcome: 'ok' | 'cancelled' | 'failed'
  summary?: string
  error?: string
}

/**
 * Run `workflow` as a tracked task, mapping engine steps onto the run's log.
 * A thrown engine error (e.g. a cancellation escaping the engine) is treated as
 * a `'cancelled'` abort so the board never shows a crashed run as `'ok'`.
 */
export async function executeWorkflow(
  workflow: Workflow,
  opts: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowResult> {
  const run = startRun({
    label: workflow.name,
    source: opts.source,
    taskId: opts.taskId,
    workflowId: workflow.id,
    feishuChatId: opts.feishuChatId,
  })
  const runId = run.runId

  try {
    const result = await runWorkflow(workflow, {
      variables: opts.variables,
      signal: run.controller.signal,
      loopElementCounter: (selector, signal) => countElements(selector, signal),
      onStep: (kind, nodeId, text) => {
        if (kind === 'tool') {
          // Per-block header: resolved block name, not the raw node id.
          addStep(runId, 'tool', nodeLabel(workflow, nodeId))
        } else {
          addStep(runId, kind, text)
        }
        // Surface to the caller (e.g. Feishu streaming) alongside the run log.
        opts.onStep?.(kind, nodeId, text)
      },
    })
    const outcome: ExecuteWorkflowResult['outcome'] = run.controller.signal.aborted
      ? 'cancelled'
      : result.outcome
    const summary = result.summary
    // For a failed run, prefer the dedicated error field; fall back to summary
    // so legacy failures still show something in the history error block.
    const error = outcome === 'failed' ? (result.error ?? summary) : undefined
    finishRun(runId, { outcome, summary, error })
    return { runId, outcome, summary, error }
  } catch (e) {
    // A cancellation or engine error that leaked out of runWorkflow.
    const aborted = run.controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')
    if (aborted) {
      finishRun(runId, { outcome: 'cancelled' })
      return { runId, outcome: 'cancelled' }
    }
    const text = e instanceof Error ? e.message : String(e)
    finishRun(runId, { outcome: 'failed', summary: text.split('\n')[0], error: text })
    return { runId, outcome: 'failed', summary: text.split('\n')[0], error: text }
  }
}