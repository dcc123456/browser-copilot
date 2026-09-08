import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowLibrary, referencesOfWorkflow } from '../src/workflow-library'

/** A minimal extension-format workflow record (asWorkflow-compatible). */
function makeWorkflow(id: string, name: string, children: string[] = []): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [
    { id: 't1', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
  ]
  children.forEach((childId, index) => {
    nodes.push({
      id: `sub-${index}`,
      label: 'execute-workflow',
      position: { x: 100 + index * 40, y: 0 },
      data: { blockId: 'execute-workflow', values: { workflowId: childId } },
    })
  })
  const chain = ['t1', ...children.map((_, index) => `sub-${index}`)]
  const edges = chain
    .slice(0, -1)
    .map((source, i) => ({ id: `e-${i}`, source, target: chain[i + 1] }))
  return { id, name, drawflow: { nodes, edges } }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-library-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function newLibrary(): WorkflowLibrary {
  return new WorkflowLibrary(join(dir, 'workflows.json'))
}

describe('WorkflowLibrary', () => {
  it('imports a batch and reports missing children per entry', () => {
    const library = newLibrary()
    const result = library.importPayload([
      makeWorkflow('child-1', '子流程'),
      makeWorkflow('parent-1', '父流程', ['child-1', 'ghost-id']),
    ])

    expect(result.imported).toBe(2)
    expect(result.entries[0]?.ok).toBe(true)
    // Two-pass import: the child imported earlier satisfies one reference,
    // but `ghost-id` is still absent from the whole batch.
    expect(result.entries[1]?.ok).toBe(true)
    expect(result.entries[1]?.missing).toEqual(['ghost-id'])

    const parent = library.get('parent-1')
    expect(parent?.name).toBe('父流程')
  })

  it('flags missing children when a referenced workflow is absent', () => {
    const library = newLibrary()
    const result = library.importPayload(makeWorkflow('lone', '孤立流程', ['nope']))
    expect(result.imported).toBe(1)
    expect(result.entries[0]?.missing).toEqual(['nope'])

    const report = library.reportFor('lone')
    // Migration displays the block label as "Execute workflow".
    expect(report?.references[0]).toMatchObject({ nodeId: 'sub-0', childId: 'nope' })
    expect(report?.missing).toEqual(['nope'])
  })

  it('accepts {workflows:[...]} payloads and single objects', () => {
    const library = newLibrary()
    expect(library.importPayload({ workflows: [makeWorkflow('a', 'A')] }).imported).toBe(1)
    expect(library.importPayload(makeWorkflow('b', 'B')).imported).toBe(1)
    expect(library.list()).toHaveLength(2)
  })

  it('rejects payloads that are not workflows', () => {
    const library = newLibrary()
    const result = library.importPayload([{ hello: 'world' }, makeWorkflow('ok', 'OK')])
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.entries[0]?.error).toBeTruthy()
  })

  it('detects reference cycles between workflows', () => {
    const library = newLibrary()
    library.importPayload([makeWorkflow('p', 'P', ['q']), makeWorkflow('q', 'Q', ['p'])])
    const cycles = library.allCycles()
    expect(cycles).toHaveLength(1)
    expect(new Set(cycles[0])).toEqual(new Set(['p', 'q']))
  })

  it('computes transitive missing sets', () => {
    const library = newLibrary()
    library.importPayload([makeWorkflow('mid', 'Mid', ['ghost']), makeWorkflow('root', 'Root', ['mid'])])
    expect(library.missingFor('root')).toEqual(['ghost'])
    expect(library.missingFor('mid')).toEqual(['ghost'])
  })

  it('resolveWorkflow resolves engine children (and only library members)', async () => {
    const library = newLibrary()
    library.importPayload(makeWorkflow('kid', 'Kid'))
    expect(await library.resolveWorkflow('kid')).not.toBeNull()
    expect(await library.resolveWorkflow('absent')).toBeNull()
  })

  it('persists upserts atomically to the primary file', async () => {
    const file = join(dir, 'workflows.json')
    const library = new WorkflowLibrary(file)
    const stored = library.upsert(makeWorkflow('w1', 'First') as never)
    expect(stored.name).toBe('First')

    // Reload from disk: the upsert must have survived.
    const reloaded = new WorkflowLibrary(file)
    reloaded.load()
    expect(reloaded.get('w1')?.name).toBe('First')

    // A second upsert of the same id updates in place.
    library.upsert(makeWorkflow('w1', 'Renamed') as never)
    expect(library.list()).toHaveLength(1)
    expect(library.get('w1')?.name).toBe('Renamed')
  })

  it('merges extra workflow files from workflowsExtraDir', () => {
    writeFileSync(join(dir, 'extra-a.json'), JSON.stringify(makeWorkflow('x1', 'Extra')), 'utf8')
    const library = new WorkflowLibrary(join(dir, 'workflows.json'), dir)
    library.load()
    expect(library.get('x1')?.name).toBe('Extra')
  })

  it('referencesOfWorkflow reads engine-style params (values or legacy)', () => {
    expect(referencesOfWorkflow(makeWorkflow('a', 'A', ['b']) as never)).toEqual([
      { nodeId: 'sub-0', nodeLabel: 'execute-workflow', childId: 'b' },
    ])
  })
})
