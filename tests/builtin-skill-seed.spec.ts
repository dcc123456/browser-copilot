import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILT_IN_SKILLS } from '../src/lib/builtin-skills'
import { ensureSchema, listSkills, SCHEMA_VERSION } from '../src/lib/storage'
import { resetStorageCache } from '../src/lib/fs-store'

/**
 * Built-in skills must reach EXISTING installs, not only fresh ones.
 *
 * `seedBuiltInSkills` used to live behind the schema-version gate, so adding a
 * built-in without bumping `SCHEMA_VERSION` silently skipped seeding on every
 * install whose storage was already current — the plan skill never appeared in
 * the slash menu. Seeding now runs on every bootstrap; this test stamps the
 * store at the CURRENT version (the state where the old code early-returned
 * and skipped seeding) and requires the built-ins to be inserted anyway.
 */

function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    get: vi.fn(async (keys: string | string[] | null) => {
      const wanted =
        keys === null ? [...store.keys()] : typeof keys === 'string' ? [keys] : keys
      const out: Record<string, unknown> = {}
      for (const key of wanted) {
        if (store.has(key)) out[key] = store.get(key)
      }
      return out
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value)
    }),
    remove: vi.fn(async (keys: string | string[] | null) => {
      const wanted =
        keys === null ? [...store.keys()] : typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) store.delete(key)
    }),
  }
  return { store, storage: { local } }
}

describe('built-in skill seeding on a current install', () => {
  let chrome: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    chrome = makeChromeMock()
    vi.stubGlobal('chrome', chrome)
    resetStorageCache()
    // An install whose storage is already at the current schema version —
    // exactly the state where the version-gated seed used to early-return.
    // Browser mode (no IndexedDB stub → no storage directory), matching how
    // fresh collections are seeded as empty arrays.
    chrome.store.set('schemaVersion', SCHEMA_VERSION)
  })

  afterEach(() => {
    resetStorageCache()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('seeds every built-in skill even when the schema version already matches', async () => {
    await ensureSchema()

    const names = (await listSkills()).map((skill) => skill.name)
    for (const builtin of BUILT_IN_SKILLS) {
      expect(names, `${builtin.name} must be seeded`).toContain(builtin.name)
    }
  })

  it('seeding is idempotent: rerunning the bootstrap does not duplicate skills', async () => {
    await ensureSchema()
    const first = await listSkills()

    await ensureSchema()
    const second = await listSkills()

    expect(second.map((skill) => skill.id).sort()).toEqual(
      first.map((skill) => skill.id).sort(),
    )
  })
})
