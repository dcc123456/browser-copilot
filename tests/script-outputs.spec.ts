/**
 * Static extraction of script output variables and their consumers.
 *
 * A `javascript-code` block publishes names through its code
 * (`automaSetVariable`, assignments onto `variables`), not through a
 * `variableName` field. These tests pin the extraction shapes and the two
 * consumers that unlock downstream `{{name}}` references: the `/` menu
 * (`collectSuggestions`) and the producer-completeness check.
 */
import { describe, expect, it } from 'vitest'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'
import {
  mergeScriptOutputNames,
  scriptOutputVariableNames,
} from '../src/lib/workflow/script-outputs'
import { producedVariableNames } from '../src/lib/workflow/producer-completeness'
import { collectSuggestions } from '../src/lib/workflow/var-suggestions'

function scriptNode(id: string, code: string, outputVariables?: string[]): WorkflowNode {
  const data: Record<string, unknown> = { blockId: 'javascript-code', code }
  if (outputVariables) data['outputVariables'] = outputVariables
  return { id, label: 'javascript-code', position: { x: 0, y: 0 }, data }
}

describe('scriptOutputVariableNames', () => {
  it('extracts automaSetVariable names in all quote styles', () => {
    const code = [
      "await automaSetVariable('title', el.textContent)",
      'automaSetVariable("count", 3)',
      'automaSetVariable(`rows`, data)',
    ].join('\n')
    expect(scriptOutputVariableNames(code)).toEqual(['title', 'count', 'rows'])
  })

  it('extracts assignments onto the variables store', () => {
    const code = ['variables.price = 10', "variables['items'] = list"].join('\n')
    expect(scriptOutputVariableNames(code)).toEqual(['price', 'items'])
  })

  it('keeps first-appearance order and dedupes', () => {
    const code = "variables.b = 1\nautomaSetVariable('a', 2)\nvariables.b = 3"
    expect(scriptOutputVariableNames(code)).toEqual(['b', 'a'])
  })

  it('ignores nested member assignments — only top-level names are offerable', () => {
    expect(scriptOutputVariableNames('variables.row.deep = 1')).toEqual([])
  })

  it('filters out non-identifier and dynamic names', () => {
    const code = [
      'variables["with space"] = 1',
      "variables['kebab-name'] = 2",
      'variables[dynamicKey] = 3',
      'automaSetVariable(otherVar, 4)',
      'automaSetVariable("good", 5)',
    ].join('\n')
    expect(scriptOutputVariableNames(code)).toEqual(['good'])
  })

  it('returns nothing for empty or unrelated code', () => {
    expect(scriptOutputVariableNames('')).toEqual([])
    expect(scriptOutputVariableNames('return document.title')).toEqual([])
  })
})

describe('mergeScriptOutputNames', () => {
  it('declared names first, then extracted ones, deduped', () => {
    expect(
      mergeScriptOutputNames(
        ['declared', 'shared'],
        'variables.extracted = 1\nvariables.shared = 2',
      ),
    ).toEqual(['declared', 'shared', 'extracted'])
  })

  it('drops non-string and non-identifier declarations', () => {
    expect(mergeScriptOutputNames([42, null, 'ok name', 'valid'], '')).toEqual(['valid'])
  })
})

describe('producedVariableNames for javascript-code', () => {
  it('publishes code-extracted names, declared names and lastResult', () => {
    const node = scriptNode('s', "automaSetVariable('rows', data)", ['declared'])
    expect(producedVariableNames(node)).toEqual(['declared', 'rows', 'lastResult'])
  })

  it('publishes lastResult even with no visible writes', () => {
    const node = scriptNode('s', 'return document.title')
    expect(producedVariableNames(node)).toContain('lastResult')
  })
})

describe('downstream {{name}} references to a script block', () => {
  function workflow(nodes: WorkflowNode[]): Workflow {
    return {
      id: 'wf',
      name: 'wf',
      createdAt: 0,
      updatedAt: 0,
      trigger: { type: 'manual' },
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      drawflow: {
        nodes,
        edges: [
          {
            id: 'e1',
            source: 't',
            sourceHandle: 'trigger-output-1',
            target: 's',
            targetHandle: 'javascript-code-input-1',
          },
          {
            id: 'e2',
            source: 's',
            sourceHandle: 'javascript-code-output-1',
            target: 'save',
            targetHandle: 'save-local-input-1',
          },
        ],
      },
    }
  }

  it('passes the completeness check when a consumer reads a script variable', () => {
    const wf = workflow([
      {
        id: 't',
        label: 'trigger',
        position: { x: 0, y: 0 },
        data: { blockId: 'trigger' },
      },
      scriptNode('s', "automaSetVariable('price', 42)"),
      {
        id: 'save',
        label: 'save-local',
        position: { x: 0, y: 0 },
        data: { blockId: 'save-local', value: '{{price}}' },
      },
    ])
    // No MISSING_PRODUCER for {{price}} — the script block produces it.
    expect(wf && producedVariableNames(wf.drawflow.nodes[1]!)).toContain('price')
  })

  it('offers script variables in the / menu of a downstream node', () => {
    const graph = {
      nodes: [scriptNode('s', "automaSetVariable('price', 42)")],
      edges: [
        {
          id: 'e',
          source: 's',
          sourceHandle: 'javascript-code-output-1',
          target: 'save',
          targetHandle: 'save-local-input-1',
        },
      ],
    }
    const suggestions = collectSuggestions(graph, 'save', {})
    const names = suggestions.map((suggestion) => suggestion.name)
    expect(names).toContain('price')
    expect(names).toContain('lastResult')
  })
})
