import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteWorkflow,
  duplicateWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
} from '../src/lib/workflow/storage'
import type { Workflow } from '../src/lib/workflow/types'
import { validateWorkflow } from '../src/lib/workflow/validation'

/**
 * In-memory `chrome.storage.local` double. Only `get`/`set` are needed here
 * (workflows never call `remove`), but the whole surface is stubbed so any
 * accidental misuse fails loudly instead of silently.
 */
function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    get: vi.fn(async (keys: string | string[]) => {
      const wanted = typeof keys === 'string' ? [keys] : keys
      const out: Record<string, unknown> = {}
      for (const key of wanted) {
        if (store.has(key)) out[key] = store.get(key)
      }
      return out
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value)
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const wanted = typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) store.delete(key)
      return Promise.resolve()
    }),
  }
  return { store, storage: { local: { get: local.get, set: local.set, remove: local.remove } } }
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  const now = Date.now()
  return {
    id: 'wf-1',
    name: 'Scrape leads',
    description: 'Collect contact rows',
    createdAt: now,
    updatedAt: now,
    drawflow: { nodes: [], edges: [] },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: true,
      reuseLastState: false,
    },
    ...overrides,
  }
}

describe('workflow storage', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns saved workflows from list and get', async () => {
    await saveWorkflow(makeWorkflow({ id: 'a', name: 'Alpha' }))

    const list = await listWorkflows()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('a')
    expect(list[0]!.name).toBe('Alpha')

    const got = await getWorkflow('a')
    expect(got!.name).toBe('Alpha')
    expect(got!.settings.notification).toBe(true)
  })

  it('returns an empty list when nothing is stored', async () => {
    expect(await listWorkflows()).toEqual([])
    expect(await getWorkflow('missing')).toBeUndefined()
  })

  it('sorts saved workflows by updatedAt descending', async () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => 1000)
    try {
      await saveWorkflow(makeWorkflow({ id: 'a', name: 'A' }))
      clock.mockImplementation(() => 2000)
      await saveWorkflow(makeWorkflow({ id: 'b', name: 'B' }))
      clock.mockImplementation(() => 3000)
      // Touching A bumps it above B.
      await saveWorkflow(makeWorkflow({ id: 'a', name: 'A v2' }))

      const list = await listWorkflows()
      expect(list.map((w) => w.id)).toEqual(['a', 'b'])
      expect(list[0]!.updatedAt).toBe(3000)
    } finally {
      clock.mockRestore()
    }
  })

  it('updates an existing workflow instead of duplicating it', async () => {
    await saveWorkflow(makeWorkflow({ id: 'a', name: 'Old' }))
    await saveWorkflow(makeWorkflow({ id: 'a', name: 'New' }))

    const list = await listWorkflows()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('New')
  })

  it('removes a workflow on delete', async () => {
    await saveWorkflow(makeWorkflow({ id: 'a' }))
    await saveWorkflow(makeWorkflow({ id: 'b' }))

    await deleteWorkflow('a')

    const list = await listWorkflows()
    expect(list.map((w) => w.id)).toEqual(['b'])
    expect(await getWorkflow('a')).toBeUndefined()
  })

  it('duplicates a workflow under a new id with the given name', async () => {
    await saveWorkflow(
      makeWorkflow({ id: 'a', name: 'Original', table: 'tbl-1' }),
    )

    const copy = await duplicateWorkflow('a', 'Renamed copy')

    expect(copy).toBeDefined()
    expect(copy!.id).not.toBe('a')
    expect(copy!.name).toBe('Renamed copy')
    expect(copy!.table).toBe('tbl-1')
    // Both records survive; the duplicate is independent of the source.
    const ids = new Set((await listWorkflows()).map((w) => w.id))
    expect(ids).toEqual(new Set([copy!.id, 'a']))
  })

  it('duplicates with a "(copy)" suffix when no name is given', async () => {
    await saveWorkflow(makeWorkflow({ id: 'a', name: 'Original' }))
    const copy = await duplicateWorkflow('a')
    expect(copy!.name).toBe('Original (copy)')
  })

  it('returns undefined when duplicating an unknown id', async () => {
    expect(await duplicateWorkflow('nope')).toBeUndefined()
  })
})

describe('validateWorkflow', () => {
  it('accepts a well-formed workflow', () => {
    const wf = makeWorkflow()
    expect(validateWorkflow(wf)).toEqual([])
  })

  it('reports missing id and name', () => {
    const problems = validateWorkflow(makeWorkflow({ id: '', name: '   ' }))
    expect(problems.join(' | ')).toMatch(/id/)
    expect(problems.join(' | ')).toMatch(/name/)
  })

  it('rejects a non-object payload', () => {
    expect(validateWorkflow(null).length).toBeGreaterThan(0)
    expect(validateWorkflow('nope').length).toBeGreaterThan(0)
  })

  it('flags non-array nodes and edges', () => {
    const bad = makeWorkflow({
      drawflow: { nodes: 'x' as unknown as [], edges: {} as unknown as [] },
    })
    const problems = validateWorkflow(bad).join(' | ')
    expect(problems).toMatch(/nodes/)
    expect(problems).toMatch(/edges/)
  })

  it('flags nodes missing a label or position', () => {
    const bad = makeWorkflow({
      drawflow: {
        nodes: [
          { id: 'n1', label: 'ok', position: { x: 0, y: 0 }, data: {} },
          { id: 'n2', position: { x: 1, y: 1 }, data: {} } as never,
          { id: 'n3', label: 'no pos', data: {} } as never,
        ],
        edges: [],
      },
    })
    const problems = validateWorkflow(bad).join(' | ')
    expect(problems).toMatch(/label/)
    expect(problems).toMatch(/position/)
  })
})