/**
 * Operators that carry no per-node goal contract (spec
 * `specs/2026-10-15-notification-feishu-and-goal-free-design.md` §3.1).
 *
 * `notification` / `webhook` / `export-data` act on the outside world and leave
 * no page state behind, so nothing may be INVENTED for them — an invented row
 * can only ever bar certification. `blocks-group` and `note` are structural
 * (a container / documentation), for the same reason. A contract the model
 * recorded itself still wins, so real evidence is never thrown away.
 */
import { describe, expect, it } from 'vitest'
import { NON_GOAL_BEARING_BLOCK_IDS } from '../src/lib/workflow/operator-class'
import { operatorCarriesGoal, operatorEntry } from '../src/lib/workflow/operator-registry'
import { resolveNodeGoalContract } from '../src/lib/workflow/node-goal-instantiation'
import { validateGeneratedWorkflow } from '../src/lib/workflow/generated-validation'
import type { Workflow } from '../src/lib/workflow/types'

const contract = {
  goal: '热搜前十已导出',
  successCriteria: [{ kind: 'variableExists', name: 'hotSearchCsv' }],
}

describe('operators that bear no goal', () => {
  it('classifies exactly the fire-and-done and structural operators', () => {
    expect([...NON_GOAL_BEARING_BLOCK_IDS].sort()).toEqual([
      'blocks-group',
      'export-data',
      'note',
      'notification',
      'webhook',
    ])
  })

  it('reports the classification through the registry', () => {
    for (const id of NON_GOAL_BEARING_BLOCK_IDS) {
      expect(operatorEntry(id)?.goalBearing, id).toBe(false)
      expect(operatorCarriesGoal(id), id).toBe(false)
    }
    expect(operatorCarriesGoal('forms')).toBe(true)
    expect(operatorCarriesGoal('event-click')).toBe(true)
    // An id the registry does not know keeps the existing behaviour.
    expect(operatorCarriesGoal('not-a-block')).toBe(true)
  })

  it('invents no contract for them, not even from a produced variable', () => {
    expect(
      resolveNodeGoalContract('notification', { title: '完成', message: '正文' }),
    ).toBeUndefined()
    expect(resolveNodeGoalContract('webhook', { url: 'https://example.com' })).toBeUndefined()
    // `variableName` used to be enough for a 「变量存在」 row.
    expect(
      resolveNodeGoalContract('export-data', { dataToExport: 'variable', variableName: 'csv' }),
    ).toBeUndefined()
    // A container is not an action: naming it is not a goal to verify.
    expect(
      resolveNodeGoalContract('blocks-group', { name: '收集列表', blocks: [] }),
    ).toBeUndefined()
  })

  it('still honours a contract the model wrote itself', () => {
    expect(resolveNodeGoalContract('export-data', { variableName: 'csv' }, contract)).toEqual({
      version: 1,
      ...contract,
    })
  })

  it('does not demand a contract from them during generation validation', () => {
    const workflow = {
      id: 'w',
      name: 'notify',
      description: '',
      createdAt: 1,
      updatedAt: 1,
      trigger: { type: 'manual', enabled: true },
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      drawflow: {
        nodes: [
          {
            id: 'a',
            label: 'notification',
            position: { x: 0, y: 0 },
            data: { blockId: 'notification', message: 'hi' },
          },
          {
            id: 'b',
            label: 'webhook',
            position: { x: 0, y: 0 },
            data: { blockId: 'webhook', url: 'https://e.com' },
          },
          {
            id: 'c',
            label: 'export-data',
            position: { x: 0, y: 0 },
            data: { blockId: 'export-data', name: 'x.csv' },
          },
          {
            id: 'd',
            label: 'blocks-group',
            position: { x: 0, y: 0 },
            data: { blockId: 'blocks-group', name: '收集列表', blocks: [] },
          },
        ],
        edges: [],
      },
    } as unknown as Workflow

    const codes = validateGeneratedWorkflow(workflow).issues.map((issue) => issue.code)
    expect(codes).not.toContain('NODE_GOAL_MISSING')
  })
})
