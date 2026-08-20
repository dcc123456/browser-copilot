import { describe, expect, it } from 'vitest'
import {
  applySlashPick,
  filterSkills,
  findSlashQuery,
  moveSelection,
} from '../src/lib/slash'
import type { Skill } from '../src/lib/types'

function skill(name: string, description = '', id = name.toLowerCase()): Skill {
  return {
    id,
    name,
    description,
    instructions: 'body',
    autoMatch: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('findSlashQuery', () => {
  it('opens on a slash at the start of the draft', () => {
    expect(findSlashQuery('/', 1)).toEqual({ start: 0, end: 1, term: '' })
    expect(findSlashQuery('/sum', 4)).toEqual({ start: 0, end: 4, term: 'sum' })
  })

  it('opens after whitespace and after a newline', () => {
    expect(findSlashQuery('hi /sum', 7)).toEqual({ start: 3, end: 7, term: 'sum' })
    expect(findSlashQuery('hi\n/sum', 7)).toEqual({ start: 3, end: 7, term: 'sum' })
  })

  /**
   * The cases that make a naive `lastIndexOf('/')` unusable in a chat box, where
   * URLs and paths are far more common than commands.
   */
  it('ignores a mid-word slash', () => {
    expect(findSlashQuery('https://example.com', 19)).toBeNull()
    expect(findSlashQuery('src/lib', 7)).toBeNull()
    expect(findSlashQuery('3/4', 3)).toBeNull()
    expect(findSlashQuery('and/or', 6)).toBeNull()
  })

  it('closes once the caret passes whitespace', () => {
    // The term ends at the caret, so typing a space dismisses the menu instead of
    // leaving it open to keep stealing Enter.
    expect(findSlashQuery('/sum ', 5)).toBeNull()
    expect(findSlashQuery('/sum this', 9)).toBeNull()
  })

  it('reads the query at the caret, not at the end of the text', () => {
    // Caret sits right after "/su" in "/su rest".
    expect(findSlashQuery('/su rest', 3)).toEqual({ start: 0, end: 3, term: 'su' })
    // Caret inside a later command while an earlier word contains a slash.
    expect(findSlashQuery('a/b /su', 7)).toEqual({ start: 4, end: 7, term: 'su' })
  })

  it('returns null when there is no slash before the caret', () => {
    expect(findSlashQuery('hello', 5)).toBeNull()
    expect(findSlashQuery('', 0)).toBeNull()
  })

  it('tolerates an out-of-range caret', () => {
    expect(findSlashQuery('/sum', 0)).toBeNull()
    expect(findSlashQuery('/sum', 99)).toBeNull()
  })
})

describe('filterSkills', () => {
  const skills = [
    skill('Summarise', 'Condense an article'),
    skill('Auto-summary', 'Second-pass summary'),
    skill('Translate', 'Render into another language'),
  ]

  it('lists everything for a bare slash', () => {
    expect(filterSkills(skills, '')).toHaveLength(3)
  })

  /** A user typing "su" means the skill that starts with it, not merely contains it. */
  it('ranks prefix matches above word-start and substring matches', () => {
    const names = filterSkills(skills, 'su').map((entry) => entry.name)
    expect(names[0]).toBe('Summarise')
    expect(names).toContain('Auto-summary')
  })

  it('treats a hyphen as a word boundary', () => {
    expect(filterSkills(skills, 'summary').map((entry) => entry.name)).toContain('Auto-summary')
  })

  it('is case-insensitive and ignores padding', () => {
    expect(filterSkills(skills, 'TRANS')).toHaveLength(1)
    expect(filterSkills(skills, '  trans  ')).toHaveLength(1)
  })

  // So "/article" finds a skill whose name gives no hint.
  it('falls back to the description', () => {
    const found = filterSkills(skills, 'article')
    expect(found.map((entry) => entry.name)).toEqual(['Summarise'])
  })

  it('ranks a name match above a description match', () => {
    const list = [skill('Recap', 'summarise an article'), skill('Summarise', 'condense')]
    expect(filterSkills(list, 'summar')[0]?.name).toBe('Summarise')
  })

  it('returns empty when nothing matches', () => {
    expect(filterSkills(skills, 'zzz')).toEqual([])
  })

  it('does not mutate the input', () => {
    const original = [...skills]
    filterSkills(skills, '')
    expect(skills).toEqual(original)
  })
})

describe('applySlashPick', () => {
  it('removes a command at the start', () => {
    expect(applySlashPick('/sum', { start: 0, end: 4, term: 'sum' })).toEqual({
      text: '',
      caret: 0,
    })
  })

  /**
   * The command is a control gesture, not content: leaving it in the draft would
   * send "/summarise" to the model as though the user had typed it.
   */
  it('removes a command mid-sentence and collapses the leftover space', () => {
    expect(applySlashPick('do /sum now', { start: 3, end: 7, term: 'sum' })).toEqual({
      text: 'do now',
      caret: 3,
    })
  })

  it('keeps text that follows without an intervening space', () => {
    expect(applySlashPick('/sum!', { start: 0, end: 4, term: 'sum' })).toEqual({
      text: '!',
      caret: 0,
    })
  })

  it('leaves a leading space alone when the command starts the draft', () => {
    // No preceding text, so there is no double space to collapse.
    expect(applySlashPick('/sum rest', { start: 0, end: 4, term: 'sum' })).toEqual({
      text: ' rest',
      caret: 0,
    })
  })
})

describe('moveSelection', () => {
  it('advances and retreats', () => {
    expect(moveSelection(0, 1, 3)).toBe(1)
    expect(moveSelection(2, -1, 3)).toBe(1)
  })

  // Wrapping is what makes the menu feel like a native picker.
  it('wraps at both ends', () => {
    expect(moveSelection(2, 1, 3)).toBe(0)
    expect(moveSelection(0, -1, 3)).toBe(2)
  })

  it('stays at zero for an empty list', () => {
    expect(moveSelection(0, 1, 0)).toBe(0)
    expect(moveSelection(0, -1, 0)).toBe(0)
  })
})
