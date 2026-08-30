import { describe, expect, it } from 'vitest'
import {
  exportSkillsJson,
  importSkillsBatch,
  mapAliasedToSkill,
  parseJsonSkillsText,
  parseSkillsFileText,
  parseYamlSkillsText,
} from '../src/lib/skills-import'
import { normalizeSkill } from '../src/lib/skills'
import type { Skill } from '../src/lib/types'

function s(name: string): Skill {
  return {
    id: `id-${name}`,
    name,
    description: `d-${name}`,
    instructions: `i-${name}`,
    autoMatch: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('mapAliasedToSkill', () => {
  it('maps alias keys to the canonical three fields', () => {
    const mapped = mapAliasedToSkill({ title: 'T', desc: 'D', prompt: 'P' })!
    expect(mapped.name).toBe('T')
    expect(mapped.description).toBe('D')
    expect(mapped.instructions).toBe('P')
    expect(mapped.autoMatch).toBe(true)
  })

  it('honours explicit autoMatch=false', () => {
    const mapped = mapAliasedToSkill({ name: 'n', instructions: 'x', autoMatch: false })!
    expect(mapped.autoMatch).toBe(false)
  })

  it('returns null when nothing recognizable is present', () => {
    expect(mapAliasedToSkill({ foo: 1, bar: 2 })).toBeNull()
    expect(mapAliasedToSkill(null)).toBeNull()
    expect(mapAliasedToSkill('string')).toBeNull()
    expect(mapAliasedToSkill([1, 2])).toBeNull()
  })

  it('accepts nested content and system_prompt aliases', () => {
    const mapped = mapAliasedToSkill({
      name: 'A',
      content: 'body',
      system_prompt: 'sys',
    })!
    expect(mapped.instructions).toBe('body') // content wins over system_prompt order? -> first alias hit
  })
})

describe('parseJsonSkillsText', () => {
  it('accepts a single object', () => {
    const { ok, raws } = parseJsonSkillsText('{"name":"x"}')
    expect(ok).toBe(true)
    expect(raws).toHaveLength(1)
  })
  it('accepts an array', () => {
    const { ok, raws } = parseJsonSkillsText('[{},{}]')
    expect(ok).toBe(true)
    expect(raws).toHaveLength(2)
  })
  it('fails on invalid json', () => {
    expect(parseJsonSkillsText('not json').ok).toBe(false)
  })
})

describe('parseYamlSkillsText', () => {
  it('parses a flat object', () => {
    const { ok, raws } = parseYamlSkillsText('name: X\ndescription: D\ninstructions: P\n')
    expect(ok).toBe(true)
    expect(raws).toHaveLength(1)
    const mapped = mapAliasedToSkill(raws[0])!
    expect(mapped.name).toBe('X')
    expect(mapped.instructions).toBe('P')
  })

  it('parses a block scalar instructions', () => {
    const { raws } = parseYamlSkillsText('name: X\ninstructions: |\n  line one\n  line two\n')
    const mapped = mapAliasedToSkill(raws[0])!
    expect(mapped.instructions).toBe('line one\nline two')
  })

  it('parses a list of skills', () => {
    const { ok, raws } = parseYamlSkillsText(
      '- name: A\n  instructions: iA\n- name: B\n  instructions: iB\n',
    )
    expect(ok).toBe(true)
    expect(raws).toHaveLength(2)
  })

  it('fails on nothing parseable', () => {
    expect(parseYamlSkillsText('just words\n').ok).toBe(false)
  })
})

describe('parseSkillsFileText', () => {
  it('routes by extension', () => {
    expect(parseSkillsFileText('a.json', '{}').from).toBe('json')
    expect(parseSkillsFileText('a.yaml', 'name: x').from).toBe('yaml')
    expect(parseSkillsFileText('a.yml', 'name: x').from).toBe('yaml')
  })
  it('routes markdown by extension', () => {
    expect(parseSkillsFileText('a.md', '---\nname: x\n---\nbody').from).toBe('md')
    expect(parseSkillsFileText('a.markdown', '---\nname: x\n---\nbody').from).toBe('md')
  })
  it('sniffs content when extension is unknown', () => {
    expect(parseSkillsFileText('a.skill', '{"name":"x"}').from).toBe('json')
    expect(parseSkillsFileText('a.txt', 'name: x').from).toBe('yaml')
  })
  it('parses markdown frontmatter with body as instructions when none present', () => {
    const { ok, raws, from } = parseSkillsFileText(
      'SKILL.md',
      '---\nname: Web Scraper\ndescription: scrape pages\nautoMatch: false\n---\n# Instructions\nFetch the page.\n',
    )
    expect(ok).toBe(true)
    expect(from).toBe('md')
    expect(raws).toHaveLength(1)
    const raw = raws[0] as Record<string, unknown>
    expect(raw['name']).toBe('Web Scraper')
    expect(raw['description']).toBe('scrape pages')
    expect(raw['instructions']).toBe('# Instructions\nFetch the page.')
    // The YAML subset stores scalars as strings; the alias mapper coerces them.
    expect(mapAliasedToSkill(raw)!.autoMatch).toBe(false)
  })
  it('keeps explicit instructions field over the markdown body', () => {
    const { ok, raws } = parseSkillsFileText(
      'a.md',
      '---\nname: T\ninstructions: explicit\n---\nthis body is ignored\n',
    )
    expect(ok).toBe(true)
    const raw = raws[0] as Record<string, unknown>
    expect(raw['instructions']).toBe('explicit')
  })
  it('rejects markdown files without frontmatter', () => {
    const { ok } = parseSkillsFileText('a.md', 'just some text, no frontmatter')
    expect(ok).toBe(false)
  })
})

describe('importSkillsBatch', () => {
  const existing = [s('Taken')]

  it('returns a saved + problems split for mixed input', () => {
    const raws = [
      { name: 'New Skill', instructions: 'hello world' }, // saved
      { title: 'Taken', prompt: 'dup' }, // nameTaken (case-insensitive)
      { name: 'Missing instructions only' }, // instructionsRequired
    ]
    const { saved, problems } = importSkillsBatch(raws, existing)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.name).toBe('New Skill')
    expect(problems).toHaveLength(2)
    expect(problems[0]!.problems).toEqual([{ field: 'name', code: 'nameTaken' }])
    expect(problems[1]!.problems).toEqual([
      { field: 'instructions', code: 'instructionsRequired' },
    ])
  })

  it('treats unmappable entries as parseFailed', () => {
    const { saved, problems } = importSkillsBatch([123, { name: 'ok', instructions: 'x' }], [])
    expect(saved).toHaveLength(1)
    expect(problems).toHaveLength(1)
    expect(problems[0]!.problems).toEqual([{ field: 'parse', code: 'parseFailed' }])
  })

  it('accumulates non-clashing names within a single batch', () => {
    const raws = [
      { name: 'A', instructions: '1' },
      { name: 'A', instructions: '2' }, // clashes with the one just saved
    ]
    const { saved, problems } = importSkillsBatch(raws, [])
    expect(saved).toHaveLength(1)
    expect(problems).toHaveLength(1)
  })
})

describe('export + import round-trip', () => {
  it('exported json re-imports to equivalent normalized skills', () => {
    const originals = [
      s('中文 名称'),
      { ...s('Long'), instructions: 'multi\nline\nwith **markdown** and 中文\n\nand code\n```\nx\n```' },
    ]
    const json = exportSkillsJson(originals)
    const { ok, raws } = parseJsonSkillsText(json)
    expect(ok).toBe(true)
    const { saved } = importSkillsBatch(raws, [])
    expect(saved.length).toBe(originals.length)
    // Compare normalized business fields (id / timestamps are regenerated).
    const strip = (skill: Skill) => ({
      name: normalizeSkill(skill).name,
      description: normalizeSkill(skill).description,
      instructions: normalizeSkill(skill).instructions,
      autoMatch: normalizeSkill(skill).autoMatch,
    })
    expect(saved.map(strip)).toEqual(originals.map(strip))
  })
})