import { describe, expect, it } from 'vitest'
import {
  matchConditionPath,
  type ConditionAndRow,
  type ConditionGroup,
  type ConditionPath,
} from '../src/lib/workflow/condition-tree'

/** A single OR group holding one AND row that compares two literal values. */
function eqGroup(left: string, right: string): ConditionGroup {
  const row: ConditionAndRow = {
    id: `row-${left}-${right}`,
    items: [
      { id: 'l', category: 'value', type: 'value', data: { value: left } },
      { id: 'c', category: 'compare', type: 'eq' },
      { id: 'r', category: 'value', type: 'value', data: { value: right } },
    ],
  }
  return { id: `grp-${left}-${right}`, conditions: [row] }
}

function path(id: string, conditions: ConditionGroup[]): ConditionPath {
  return { id, name: `path ${id}`, conditions }
}

const env = { vars: {} }

describe('matchConditionPath · ordered branch resolution', () => {
  it('returns the first path whose condition tree holds', async () => {
    const paths = [path('p1', [eqGroup('a', 'a')]), path('p2', [eqGroup('b', 'b')])]
    await expect(matchConditionPath(paths, env)).resolves.toMatchObject({ id: 'p1' })
  })

  it('skips paths that do not hold and takes the next match', async () => {
    const paths = [path('p1', [eqGroup('a', 'zzz')]), path('p2', [eqGroup('b', 'b')])]
    await expect(matchConditionPath(paths, env)).resolves.toMatchObject({ id: 'p2' })
  })

  it('never lets an unconfigured (empty) path swallow the run', async () => {
    const paths = [path('empty', []), path('p2', [eqGroup('b', 'b')])]
    await expect(matchConditionPath(paths, env)).resolves.toMatchObject({ id: 'p2' })
  })

  it('returns null when no path holds (caller takes the fallback)', async () => {
    const paths = [path('p1', [eqGroup('a', 'zzz')]), path('p2', [])]
    await expect(matchConditionPath(paths, env)).resolves.toBeNull()
  })

  it('ignores entries without a usable stable id', async () => {
    const paths = [
      { name: 'no id', conditions: [eqGroup('a', 'a')] },
      path('good', [eqGroup('b', 'b')]),
    ]
    await expect(matchConditionPath(paths, env)).resolves.toMatchObject({ id: 'good' })
  })

  it('returns null for a non-array input', async () => {
    await expect(matchConditionPath(undefined, env)).resolves.toBeNull()
  })
})
