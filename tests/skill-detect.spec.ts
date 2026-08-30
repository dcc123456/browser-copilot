import { describe, expect, it } from 'vitest'
import { detectSkillCandidatesFromMarkdown } from '../src/lib/skill-detect'

describe('detectSkillCandidatesFromMarkdown', () => {
  it('detects a JSON skill inside a ```json fence', () => {
    const md = 'Here is one:\n```json\n{"name":"JSON Skill","description":"desc","instructions":"do x"}\n```\n'
    const found = detectSkillCandidatesFromMarkdown(md)
    expect(found).toHaveLength(1)
    expect(found[0]!.draft.name).toBe('JSON Skill')
    expect(found[0]!.draft.instructions).toBe('do x')
  })

  it('detects a YAML skill inside a ```yaml fence', () => {
    const md = '```yaml\nname: YAML Skill\ndescription: desc\ninstructions: run it\n```'
    const found = detectSkillCandidatesFromMarkdown(md)
    expect(found).toHaveLength(1)
    expect(found[0]!.draft.name).toBe('YAML Skill')
  })

  it('detects a bare ``` skill (unlabeled fence)', () => {
    const md = '```\n{"title":"Bare","instructions":"go"}\n```'
    const found = detectSkillCandidatesFromMarkdown(md)
    expect(found).toHaveLength(1)
    expect(found[0]!.draft.name).toBe('Bare')
  })

  it('detects a <skill> custom block outside code fences', () => {
    const md = '<skill name="Tag Skill" description="hi">Do the thing</skill>'
    const found = detectSkillCandidatesFromMarkdown(md)
    expect(found).toHaveLength(1)
    expect(found[0]!.draft.name).toBe('Tag Skill')
    expect(found[0]!.draft.instructions).toBe('Do the thing')
  })

  it('detects a JSON array of skills', () => {
    const md = '```json\n[{"name":"A","instructions":"1"},{"name":"B","instructions":"2"}]\n```'
    const found = detectSkillCandidatesFromMarkdown(md)
    expect(found).toHaveLength(2)
  })

  it('returns empty for a reply with no skill structure', () => {
    const md = 'Just a normal answer with ```code\nconst x = 1\n``` in it.'
    expect(detectSkillCandidatesFromMarkdown(md)).toHaveLength(0)
  })

  it('returns empty for empty input', () => {
    expect(detectSkillCandidatesFromMarkdown('')).toHaveLength(0)
  })

  it('deduplicates when the same block would match twice', () => {
    const md = '```json\n{"name":"X","instructions":"i"}\n```\n```json\n{"name":"X","instructions":"i"}\n```'
    // Two fences carrying the *identical* skill body yield a single candidate,
    // so the user does not get duplicate save-cards for one reply.
    expect(detectSkillCandidatesFromMarkdown(md).length).toBe(1)
  })

  it('detects multiple distinct skills from separate fences', () => {
    const md = '```json\n{"name":"A","instructions":"1"}\n```\n```json\n{"name":"B","instructions":"2"}\n```'
    const found = detectSkillCandidatesFromMarkdown(md)
    expect(found.map((f) => f.draft.name).sort()).toEqual(['A', 'B'])
  })

  it('handles HTML entities inside <skill> blocks', () => {
    const md = '<skill name="&quot;Quoted&quot;">a &lt;b&gt;</skill>'
    const found = detectSkillCandidatesFromMarkdown(md)
    expect(found[0]!.draft.name).toBe('"Quoted"')
    expect(found[0]!.draft.instructions).toBe('a <b>')
  })
})