/**
 * Slash-command parsing for the composer.
 *
 * Kept free of React and `chrome` so the fiddly part — deciding when a `/` is a
 * command versus ordinary text, and how a pick rewrites the draft — is
 * unit-testable without a DOM.
 *
 * @module lib/slash
 */
import type { Skill } from './types'

/** An active slash query found in the draft. */
export interface SlashQuery {
  /** Index of the `/` itself. */
  start: number
  /** Index just past the query text; always the caret position. */
  end: number
  /** Text between the `/` and the caret, excluding the slash. */
  term: string
}

/**
 * Finds the slash query the caret currently sits in, if any.
 *
 * A `/` only opens the menu at the start of the draft or after whitespace, so a
 * URL (`https://x`), a path (`src/lib`), or a date (`3/4`) never triggers it —
 * those are far more common in a chat box than a command.
 *
 * The query ends at the caret rather than at the next space: a menu that stayed
 * open while the user typed past it would keep stealing Enter.
 */
export function findSlashQuery(text: string, caret: number): SlashQuery | null {
  if (caret < 1 || caret > text.length) return null

  // Walk back from the caret to the nearest '/' with no whitespace in between.
  let index = caret - 1
  while (index >= 0) {
    const char = text[index]
    if (char === undefined) return null
    if (char === '/') break
    // Whitespace or a newline means the caret is not inside a command token.
    if (/\s/.test(char)) return null
    index -= 1
  }
  if (index < 0) return null

  const before = index === 0 ? undefined : text[index - 1]
  // Mid-word slashes (paths, URLs, fractions) are not commands.
  if (before !== undefined && !/\s/.test(before)) return null

  return { start: index, end: caret, term: text.slice(index + 1, caret) }
}

/**
 * Ranks skills against a query term.
 *
 * Ordering is prefix matches, then word-start matches, then anything containing
 * the term. A user typing `su` expects "Summarise" before "Auto-summary", and a
 * flat substring filter would not deliver that.
 *
 * Matching is case-insensitive, and an empty term lists everything so a bare `/`
 * shows the full menu.
 */
export function filterSkills(skills: readonly Skill[], term: string): Skill[] {
  const needle = term.trim().toLowerCase()
  if (needle === '') return [...skills]

  const scored: { skill: Skill; rank: number }[] = []
  for (const skill of skills) {
    const name = skill.name.toLowerCase()
    if (name.startsWith(needle)) {
      scored.push({ skill, rank: 0 })
      continue
    }
    // A match at a word boundary reads as intentional; mid-word does not.
    const words = name.split(/[\s\-_]+/)
    if (words.some((word) => word.startsWith(needle))) {
      scored.push({ skill, rank: 1 })
      continue
    }
    if (name.includes(needle)) {
      scored.push({ skill, rank: 2 })
      continue
    }
    // Fall back to the description so "/article" can find a skill named "Recap".
    if (skill.description.toLowerCase().includes(needle)) {
      scored.push({ skill, rank: 3 })
    }
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .map((entry) => entry.skill)
}

/**
 * Removes the slash query from the draft after a pick.
 *
 * The command is a control gesture, not content: leaving `/summarise` in the text
 * would send it to the model as if the user had typed it. The selected skill is
 * shown as a chip instead.
 */
export function applySlashPick(
  text: string,
  query: SlashQuery,
): { text: string; caret: number } {
  const before = text.slice(0, query.start)
  const after = text.slice(query.end)
  // Collapse the space the command leaves behind, so removing a mid-sentence
  // command does not produce a double space.
  const joined =
    before !== '' && after.startsWith(' ') ? `${before}${after.slice(1)}` : `${before}${after}`
  return { text: joined, caret: before.length }
}

/** Moves a selection index within a list, wrapping at both ends. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length === 0) return 0
  return (((current + delta) % length) + length) % length
}
