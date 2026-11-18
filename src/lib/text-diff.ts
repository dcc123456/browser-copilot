/**
 * Line-level text diff for read-only change views (the operator AI's full-change
 * modal). Uses an LCS table so unchanged lines stay as context; a cell budget
 * keeps a very large pasted value from freezing the UI, with a plain
 * remove-then-add view as the fallback.
 *
 * @module lib/text-diff
 */

export type DiffLineKind = 'context' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based position in the before text; absent for added lines. */
  oldNumber?: number
  /** 1-based position in the after text; absent for removed lines. */
  newNumber?: number
}

const MAX_LCS_CELLS = 1_000_000

function linesOf(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function replaceAllRows(oldLines: readonly string[], newLines: readonly string[]): DiffLine[] {
  return [
    ...oldLines.map((text, index): DiffLine => ({ kind: 'removed', text, oldNumber: index + 1 })),
    ...newLines.map((text, index): DiffLine => ({ kind: 'added', text, newNumber: index + 1 })),
  ]
}

/** Ordered diff rows: context lines carry both numbers, changed lines one. */
export function diffTextLines(before: string, after: string): DiffLine[] {
  const oldLines = linesOf(before)
  const newLines = linesOf(after)
  if ((oldLines.length + 1) * (newLines.length + 1) > MAX_LCS_CELLS)
    return replaceAllRows(oldLines, newLines)

  const width = newLines.length + 1
  const lcs = new Uint32Array((oldLines.length + 1) * width)
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const oldLine = oldLines[i] ?? ''
      const newLine = newLines[j] ?? ''
      lcs[i * width + j] =
        oldLine === newLine
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0)
    }
  }

  const rows: DiffLine[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex] ?? ''
    const newLine = newLines[newIndex] ?? ''
    if (oldLine === newLine) {
      rows.push({
        kind: 'context',
        text: oldLine,
        oldNumber: oldIndex + 1,
        newNumber: newIndex + 1,
      })
      oldIndex++
      newIndex++
    } else if (
      (lcs[(oldIndex + 1) * width + newIndex] ?? 0) >= (lcs[oldIndex * width + newIndex + 1] ?? 0)
    ) {
      rows.push({ kind: 'removed', text: oldLine, oldNumber: oldIndex + 1 })
      oldIndex++
    } else {
      rows.push({ kind: 'added', text: newLine, newNumber: newIndex + 1 })
      newIndex++
    }
  }
  while (oldIndex < oldLines.length) {
    rows.push({ kind: 'removed', text: oldLines[oldIndex] ?? '', oldNumber: oldIndex + 1 })
    oldIndex++
  }
  while (newIndex < newLines.length) {
    rows.push({ kind: 'added', text: newLines[newIndex] ?? '', newNumber: newIndex + 1 })
    newIndex++
  }
  return rows
}
