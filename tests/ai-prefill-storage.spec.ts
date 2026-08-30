import { describe, expect, it } from 'vitest'
import { aiPrefillSteps, applyAiPrefillOptions } from '../src/lib/storage'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

function node(id: string, data: Record<string, unknown>): WorkflowNode {
  return { id, label: id, position: { x: 0, y: 0 }, data }
}

function workflow(nodes: WorkflowNode[]): Workflow {
  return {
    id: 'wf-1',
    name: 'wf',
    createdAt: 1,
    updatedAt: 1,
    drawflow: { nodes, edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

/**
 * A forms step paired with an upstream ai-agent node through the `aiFill1`
 * variable. With `disabled` it models the state after the user unchecked the
 * step on the save card (literal value + skipped AI node).
 */
function pairFixture(disabled = false): Workflow {
  return workflow([
    node('n-ai', {
      blockId: 'ai-agent',
      variableName: 'aiFill1',
      description: 'AI 生成表单内容: 搜索词',
      referenceValue: '旧搜索词',
      ...(disabled ? { disableBlock: true } : {}),
    }),
    node('n-forms', {
      blockId: 'forms',
      selector: '#q',
      findBy: 'cssSelector',
      type: 'text-field',
      value: disabled ? '旧搜索词' : '{{aiFill1}}',
      clearValue: true,
    }),
  ])
}

const find = (wf: Workflow, id: string) => wf.drawflow.nodes.find((n) => n.id === id)!

describe('aiPrefillSteps', () => {
  it('lists forms steps whose value references a paired ai-agent variable', () => {
    expect(aiPrefillSteps(pairFixture())).toEqual([
      { nodeId: 'n-forms', label: '搜索词', referenceValue: '旧搜索词' },
    ])
  })

  it('ignores literal values and tokens without a matching ai-agent node', () => {
    const literal = workflow([
      node('n-ai', {
        blockId: 'ai-agent',
        variableName: 'aiFill1',
        description: 'x',
        referenceValue: 'y',
      }),
      node('n-forms', { blockId: 'forms', value: 'plain text' }),
    ])
    expect(aiPrefillSteps(literal)).toEqual([])

    const unpaired = workflow([node('n-forms', { blockId: 'forms', value: '{{aiFill1}}' })])
    expect(aiPrefillSteps(unpaired)).toEqual([])
  })
})

describe('applyAiPrefillOptions', () => {
  it('an unchecked step falls back to the captured text and disables the ai node', () => {
    const result = applyAiPrefillOptions(pairFixture(), { 'n-forms': false })

    expect(find(result, 'n-forms').data.value).toBe('旧搜索词')
    expect(find(result, 'n-ai').data.disableBlock).toBe(true)
  })

  it('re-checking a token step clears a stale disable flag and keeps the reference', () => {
    // The save card applies to freshly generated workflows, whose forms values
    // are `{{var}}` tokens; "checked" re-enables an ai node disabled beforehand.
    const stale = workflow([
      node('n-ai', {
        blockId: 'ai-agent',
        variableName: 'aiFill1',
        description: 'AI 生成表单内容: 搜索词',
        referenceValue: '旧搜索词',
        disableBlock: true,
      }),
      node('n-forms', {
        blockId: 'forms',
        selector: '#q',
        findBy: 'cssSelector',
        type: 'text-field',
        value: '{{aiFill1}}',
        clearValue: true,
      }),
    ])

    const result = applyAiPrefillOptions(stale, { 'n-forms': true })

    expect(find(result, 'n-forms').data.value).toBe('{{aiFill1}}')
    expect(find(result, 'n-ai').data.disableBlock).toBe(false)
  })

  it('is idempotent and leaves unselected steps untouched', () => {
    const once = applyAiPrefillOptions(pairFixture(), { 'n-forms': false })
    const twice = applyAiPrefillOptions(once, { 'n-forms': false })
    expect(twice).toEqual(once)

    const untouched = applyAiPrefillOptions(pairFixture(), {})
    expect(find(untouched, 'n-forms').data.value).toBe('{{aiFill1}}')
    expect(untouched.drawflow.nodes[1]!.data).not.toHaveProperty('disableBlock')
  })
})
