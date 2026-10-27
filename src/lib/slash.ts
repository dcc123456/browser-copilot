/**
 * Slash-query parsing shared by the composer and the workflow editor.
 *
 * Kept free of React and `chrome` so the fiddly part — deciding when a `/` is a
 * command versus ordinary text, how a pick rewrites the draft, and how a list is
 * ranked — is unit-testable without a DOM. The composer selects a skill; the
 * editor's block-parameter fields select a variable to insert.
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
 * Rank entries against a query term.
 *
 * Ordering is prefix matches, then word-start matches, then anything containing
 * the term. A user typing `su` expects "Summarise" before "Auto-summary", and a
 * flat substring filter would not deliver that.
 *
 * Matching is case-insensitive, and an empty term lists everything so a bare `/`
 * shows the full menu. `hintOf` is the fallback haystack — a description for a
 * skill, a credential label for a variable — so a term that misses the name can
 * still find the entry the user is thinking of.
 */
export function rankByTerm<T>(
  items: readonly T[],
  term: string,
  nameOf: (item: T) => string,
  hintOf?: (item: T) => string,
): T[] {
  const needle = term.trim().toLowerCase()
  if (needle === '') return [...items]

  const scored: { item: T; rank: number }[] = []
  for (const item of items) {
    const name = nameOf(item).toLowerCase()
    if (name.startsWith(needle)) {
      scored.push({ item, rank: 0 })
      continue
    }
    // A match at a word boundary reads as intentional; mid-word does not.
    const words = name.split(/[\s\-_·::]+/)
    if (words.some((word) => word.startsWith(needle))) {
      scored.push({ item, rank: 1 })
      continue
    }
    if (name.includes(needle)) {
      scored.push({ item, rank: 2 })
      continue
    }
    // Fall back to the hint so "/article" can find a skill named "Recap".
    if (hintOf && hintOf(item).toLowerCase().includes(needle)) {
      scored.push({ item, rank: 3 })
    }
  }

  return scored
    .sort((a, b) => a.rank - b.rank || nameOf(a.item).localeCompare(nameOf(b.item)))
    .map((entry) => entry.item)
}

/**
 * Ranks skills against a query term. See {@link rankByTerm} for the ordering.
 */
export function filterSkills(skills: readonly Skill[], term: string): Skill[] {
  return rankByTerm(
    skills,
    term,
    (skill) => skill.name,
    (skill) => skill.description,
  )
}

/**
 * Removes the slash query from the draft after a pick.
 *
 * The command is a control gesture, not content: leaving `/summarise` in the text
 * would send it to the model as if the user had typed it. The selected skill is
 * shown as a chip instead.
 */
export function applySlashPick(text: string, query: SlashQuery): { text: string; caret: number } {
  const before = text.slice(0, query.start)
  const after = text.slice(query.end)
  // Collapse the space the command leaves behind, so removing a mid-sentence
  // command does not produce a double space.
  const joined =
    before !== '' && after.startsWith(' ') ? `${before}${after.slice(1)}` : `${before}${after}`
  return { text: joined, caret: before.length }
}

/**
 * Recognises a freshly typed `@` that should open the file picker, and consumes
 * it.
 *
 * Like `/`, the `@` is a gesture rather than content, so it must not travel to
 * the model. The rules mirror {@link findSlashQuery}: only a word-start `@`
 * counts, so an address (`me@host`) stays ordinary text. Requiring that exactly
 * one character was inserted keeps a pasted `@` — or a caret move onto an
 * existing one — from silently eating it.
 */
export function takeAttachTrigger(
  previous: string,
  next: string,
  caret: number | null,
): { text: string; caret: number } | null {
  if (caret === null || caret < 1) return null
  if (next[caret - 1] !== '@') return null
  const before = caret >= 2 ? next[caret - 2] : undefined
  if (before !== undefined && !/\s/.test(before)) return null
  if (`${next.slice(0, caret - 1)}${next.slice(caret)}` !== previous) return null
  return { text: `${next.slice(0, caret - 1)}${next.slice(caret)}`, caret: caret - 1 }
}

/** Moves a selection index within a list, wrapping at both ends. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length === 0) return 0
  return (((current + delta) % length) + length) % length
}

/**
 * Replace the live slash query with `insert`, leaving the rest of the draft alone.
 *
 * {@link applySlashPick} deletes the command because a skill is a control gesture
 * rendered as a chip. Here the command IS the gesture for a value the draft keeps:
 * `/pro` picks `{{productName}}`, so the `/` and the term between it and the caret
 * are swapped for the insertion and the caret lands just past it. Text the user
 * already typed after the caret stays put, and no space is invented — a trailing
 * space would be committed into a block parameter, where `{{x}} ` is not `{{x}}`.
 */
export function applySlashInsert(
  text: string,
  query: SlashQuery,
  insert: string,
): { text: string; caret: number } {
  const caret = query.start + insert.length
  return { text: `${text.slice(0, query.start)}${insert}${text.slice(query.end)}`, caret }
}
