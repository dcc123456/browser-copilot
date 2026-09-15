import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentFromMarkdown,
  agentSlug,
  agentToMarkdown,
  exportAgentsJson,
  importAgentsBatch,
  mapAliasedToAgent,
} from '../src/lib/agents-import'
import { normalizeAgent } from '../src/lib/agents'
import type { Agent } from '../src/lib/types'

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'search-expert',
    role: 'specialist',
    domain: 'search',
    delegationHint: 'Finds things.',
    instructions: 'Line one\nLine two with "quotes".',
    tools: ['snapshot_page', 'click'],
    skillNames: ['workflow-generator'],
    delegatable: false,
    maxRounds: 8,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

describe('agent markdown round trip', () => {
  it('preserves every field through agentToMarkdown -> agentFromMarkdown', () => {
    const original = agent()
    const parsed = agentFromMarkdown(agentToMarkdown(original))
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual(original)
  })

  it('keeps multi-line instruction bodies intact', () => {
    const original = agent({
      instructions: '# Heading\n\n- a\n- b\n\n```js\ncode()\n```\n',
    })
    const parsed = agentFromMarkdown(agentToMarkdown(original))
    expect(parsed?.instructions).toBe(original.instructions.replace(/\n+$/, ''))
  })

  it('round-trips an agent with empty lists', () => {
    const parsed = agentFromMarkdown(agentToMarkdown(agent({ tools: [], skillNames: [] })))
    expect(parsed?.tools).toEqual([])
    expect(parsed?.skillNames).toEqual([])
  })

  it('round-trips a supervisor', () => {
    const supervisor = agent({
      id: 'sup',
      name: 'supervisor',
      role: 'supervisor',
      domain: 'custom',
      delegatable: true,
      tools: [],
    })
    const parsed = agentFromMarkdown(agentToMarkdown(supervisor))
    expect(parsed?.role).toBe('supervisor')
    expect(parsed?.delegatable).toBe(true)
  })

  it('returns null for text that is not an agent file', () => {
    expect(agentFromMarkdown('just some notes, no frontmatter')).toBeNull()
  })

  it('derives a stable slug id for a hand-authored file without id', () => {
    const md = [
      '---',
      'name: My Agent',
      'delegationHint: helps',
      '---',
      '',
      'Do the work.',
    ].join('\n')
    const parsed = agentFromMarkdown(md)
    expect(parsed?.id).toBe('agent-My_Agent')
    expect(agentSlug('My Agent')).toBe('My_Agent')
  })
})

describe('mapAliasedToAgent', () => {
  it('maps generic title/description/prompt aliases', () => {
    const mapped = mapAliasedToAgent({
      title: 'helper',
      tagline: 'helps with stuff',
      system: 'be helpful',
      tools: 'click, fill',
    })
    expect(mapped?.name).toBe('helper')
    expect(mapped?.delegationHint).toBe('helps with stuff')
    expect(mapped?.instructions).toBe('be helpful')
    expect(mapped?.tools).toEqual(['click', 'fill'])
  })

  it('accepts arrays for list fields', () => {
    const mapped = mapAliasedToAgent({ name: 'x', instructions: 'y', tools: ['click', 3, 'fill'] })
    expect(mapped?.tools).toEqual(['click', 'fill'])
  })

  it('rejects an object with no semantic fields', () => {
    expect(mapAliasedToAgent({ foo: 1 })).toBeNull()
  })

  it('never lets a specialist claim delegation power', () => {
    const mapped = mapAliasedToAgent({ name: 'x', instructions: 'y', delegatable: true })
    expect(mapped?.delegatable).toBe(false)
  })
})

describe('importAgentsBatch', () => {
  it('accepts valid entries and rejects empty names / instructions', () => {
    const result = importAgentsBatch(
      [
        { name: 'one', instructions: 'do one' },
        { name: '', instructions: 'x' },
        { name: 'three', instructions: '' },
      ],
      [],
    )
    expect(result.saved.map((a) => a.name)).toEqual(['one'])
    expect(result.problems.map((p) => p.problems[0]?.code)).toEqual([
      'nameRequired',
      'instructionsRequired',
    ])
  })

  it('rejects duplicates against storage and within the same batch', () => {
    const existing = [normalizeAgent(agent({ id: 'old', name: 'dup' }))]
    const result = importAgentsBatch(
      [
        { name: 'dup', instructions: 'x' },
        { name: 'Dup', instructions: 'y' },
        { name: 'fresh', instructions: 'z' },
      ],
      existing,
    )
    expect(result.saved.map((a) => a.name)).toEqual(['fresh'])
    expect(result.problems).toHaveLength(2)
    expect(result.problems.every((p) => p.problems[0]?.code === 'nameTaken')).toBe(true)
  })
})

describe('exportAgentsJson', () => {
  it('re-imports to equivalent agents (new ids)', () => {
    const original = [agent({ id: 'x', createdAt: 5, updatedAt: 9 })]
    const text = exportAgentsJson(original)
    const raws = JSON.parse(text) as unknown[]
    const result = importAgentsBatch(raws, [])
    expect(result.saved).toHaveLength(1)
    expect(result.saved[0]!.name).toBe('search-expert')
    expect(result.saved[0]!.tools).toEqual(['snapshot_page', 'click'])
    expect(result.saved[0]!.id).not.toBe('x')
  })
})

describe('seedBuiltInAgents (storage integration)', () => {
  beforeEach(() => {
    const store = new Map<string, unknown>()
    vi.stubGlobal(
      'chrome',
      {
        storage: {
          local: {
            get: vi.fn(async (keys: string | string[]) => {
              const wanted = typeof keys === 'string' ? [keys] : keys
              const out: Record<string, unknown> = {}
              for (const key of wanted) if (store.has(key)) out[key] = store.get(key)
              return out
            }),
            set: vi.fn(async (items: Record<string, unknown>) => {
              for (const [key, value] of Object.entries(items)) store.set(key, value)
            }),
            remove: vi.fn(async () => {}),
          },
        },
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('seeds once and is idempotent, and never overwrites a user-edited copy', async () => {
    const storage = await import('../src/lib/storage')
    const { BUILT_IN_AGENTS } = await import('../src/lib/builtin-agents')

    await storage.seedBuiltInAgents()
    await storage.seedBuiltInAgents()

    const agents = await storage.listAgents()
    expect(agents).toHaveLength(BUILT_IN_AGENTS.length)
    expect(new Set(agents.map((a) => a.name)).size).toBe(BUILT_IN_AGENTS.length)

    // Simulate a user edit: same built-in id, real timestamp + changed text.
    const target = agents.find((a) => a.id === BUILT_IN_AGENTS[0]!.id)!
    const edited = { ...target, instructions: 'MY CUSTOM EDIT', updatedAt: 123456789 }
    await storage.saveAgent(edited)
    await storage.seedBuiltInAgents()

    const after = await storage.listAgents()
    const same = after.find((a) => a.id === edited.id)!
    expect(same.instructions).toBe('MY CUSTOM EDIT')
    expect(same.updatedAt).toBe(123456789)
  })

  it('restores an edited (even renamed) built-in to the shipped version in place', async () => {
    const storage = await import('../src/lib/storage')
    const { BUILT_IN_AGENTS } = await import('../src/lib/builtin-agents')
    await storage.seedBuiltInAgents()

    const shipped = BUILT_IN_AGENTS[1]!
    // Edit like the panel does: same id + builtIn marker, real timestamp, and
    // even a rename — a later seed must not clobber it.
    await storage.saveAgent({
      ...shipped,
      name: `${shipped.name}-hacked`,
      instructions: 'MY EDIT',
      updatedAt: 424242,
    })
    await storage.seedBuiltInAgents()
    const edited = (await storage.listAgents()).find((a) => a.id === shipped.id)!
    expect(edited.instructions).toBe('MY EDIT')

    // One-click restore: shipped content, original name, updatedAt back to 0,
    // no duplicate entry under the same id.
    const restored = await storage.resetAgentToBuiltIn(shipped.id)
    expect(restored).toEqual({ ...shipped })
    expect(restored.updatedAt).toBe(0)
    const all = await storage.listAgents()
    expect(all.filter((a) => a.id === shipped.id)).toHaveLength(1)
    expect(all.find((a) => a.id === shipped.id)!.name).toBe(shipped.name)
  })

  it('throws when resetting an id that is not a built-in', async () => {
    const storage = await import('../src/lib/storage')
    await expect(storage.resetAgentToBuiltIn('user-made-id')).rejects.toThrow(/built-in/)
  })
})
