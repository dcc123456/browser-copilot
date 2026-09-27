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
import { ambiguityPolicyOf, degradeReplayOf, isGeneratedStrict } from '../src/lib/workflow/reliability'

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

  it('persists everything that makes a GENERATED workflow generated', async () => {
    // The bug this pins: `asWorkflow` rebuilt `settings` from a five-boolean
    // whitelist, so provenance / reliabilityMode / goalSpec / the origin URL /
    // the trial record were destroyed at the moment of saving. A generated
    // graph therefore came back as a legacy compat workflow and EVERY strict
    // mechanism the record path had built — scored resolution, readiness gates,
    // candidate chains, self-heal — was silently skipped on replay. The
    // workflow that lost its identity is also the one that started failing on
    // first replay.
    const now = Date.now()
    await saveWorkflow(
      makeWorkflow({
        id: 'generated',
        revision: 4,
        revisionHistory: [
          { revision: 3, updatedAt: now - 1000, source: 'generation' },
          { revision: 4, updatedAt: now, source: 'ai-repair', parentRevision: 3 },
        ],
        settings: {
          saveLog: true,
          debugMode: false,
          notification: false,
          reuseLastState: false,
          defaultWaitMs: 0,
          provenance: 'chat-generate',
          reliabilityMode: 'generated-strict',
          generationOriginUrl: 'https://shop.example/cart',
          goalSpec: {
            summary: 'Submit the order',
            successConditions: [{ kind: 'urlContains', value: '/orders' }],
          },
          saveWarnings: ['缺少导航锚点'],
          certificationStatus: 'unverified',
          takeoverOnRun: true,
          degradeReplay: false,
          trialRun: {
            outcome: 'partial',
            at: now,
            full: false,
            coveredSteps: 3,
            totalSteps: 5,
          },
        },
      }),
    )

    const got = (await getWorkflow('generated'))!
    expect(got.settings).toMatchObject({
      saveLog: true,
      defaultWaitMs: 0,
      provenance: 'chat-generate',
      reliabilityMode: 'generated-strict',
      generationOriginUrl: 'https://shop.example/cart',
      saveWarnings: ['缺少导航锚点'],
      certificationStatus: 'unverified',
      takeoverOnRun: true,
      degradeReplay: false,
    })
    expect(got.settings.goalSpec?.successConditions[0]).toMatchObject({ kind: 'urlContains' })
    expect(got.settings.trialRun).toMatchObject({
      outcome: 'partial',
      coveredSteps: 3,
      totalSteps: 5,
      full: false,
    })
    expect(got.revision).toBe(4)
    expect(got.revisionHistory?.map((entry) => entry.revision)).toEqual([3, 4])
    // The identity is not decorative: with it persisted, the run resolves to
    // the strict regime; without it the same record would run as legacy compat.
    expect(isGeneratedStrict(got)).toBe(true)
    expect(ambiguityPolicyOf(got)).toBe('score')
    expect(degradeReplayOf(got)).toBe(false)
  })

  it('drops malformed settings keys instead of trusting them', async () => {
    // The whitelist gained real weight: the same guard that keeps a half-written
    // record from poisoning a run must not smuggle garbage into the strict path.
    await saveWorkflow(
      makeWorkflow({
        id: 'garbage',
        revision: 'not-a-number' as unknown as number,
        settings: {
          saveLog: false,
          debugMode: false,
          notification: false,
          reuseLastState: false,
          provenance: 'from-a-mars-attack' as never,
          reliabilityMode: 'maybe' as never,
          goalSpec: 'nope' as never,
          defaultWaitMs: '2000' as never,
          saveWarnings: ['ok', 42 as never],
          // A stored record the reader cannot understand must not survive as a
          // "certified" claim: `passed` is exactly the word a health card keys on.
          trialRun: { outcome: 'passed' } as never,
          certificationStatus: 'gold-certified' as never,
        },
      }),
    )
    const stored = (await getWorkflow('garbage'))!
    const settings = stored.settings as unknown as Record<string, unknown>
    expect(settings.provenance).toBeUndefined()
    expect(settings.reliabilityMode).toBeUndefined()
    expect(settings.goalSpec).toBeUndefined()
    expect(settings.defaultWaitMs).toBeUndefined()
    expect(settings.certificationStatus).toBeUndefined()
    expect(settings.trialRun).toBeUndefined()
    expect(settings.saveWarnings).toEqual(['ok'])
    expect(stored.revision).toBeUndefined()
    // Nothing left to derive strictness from: this one runs as legacy compat.
    expect(isGeneratedStrict(stored)).toBe(false)
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

  it('serializes concurrent saves so neither is lost', async () => {
    // The regression behind "my workflows keep disappearing": with a latency-y
    // backend, two overlapping read-modify-write cycles both read the same base
    // list and the later write silently dropped the other's workflow. The
    // per-key queue (lib/key-lock.ts) must serialize them.
    const originalGet = mocks.storage.local.get
    mocks.storage.local.get = vi.fn(async (keys: string | string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return originalGet(keys)
    })

    await Promise.all([
      saveWorkflow(makeWorkflow({ id: 'a', name: 'Alpha' })),
      saveWorkflow(makeWorkflow({ id: 'b', name: 'Beta' })),
      saveWorkflow(makeWorkflow({ id: 'c', name: 'Gamma' })),
    ])

    const ids = (await listWorkflows()).map((w) => w.id)
    expect(ids.sort()).toEqual(['a', 'b', 'c'])
  })

  it('duplicates a workflow under a new id with the given name', async () => {
    await saveWorkflow(makeWorkflow({ id: 'a', name: 'Original', table: 'tbl-1' }))

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
