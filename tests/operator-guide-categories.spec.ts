/**
 * The guide's mapping table must agree with the catalog about categories.
 *
 * `operator-guide.ts` tells the model which category each operator lives in, and
 * the model declares categories through `use_operators` to receive that
 * category's tool set. A row naming the wrong category therefore sends the model
 * after a tool it cannot see: the call lands out of bounds, the bridge activates
 * a category and asks for a retry, and a round is spent — or, with a weaker
 * model, the model concludes the operator is unavailable and works around it.
 *
 * Two rows were wrong when this was written: `take-screenshot` was filed under
 * `interaction` (it is `browser`) and `export-data` under `browser` (it is
 * `general`). Both were invisible because nothing compares the two lists: the
 * guide is a template string, the catalog is data, and the guide is consumed by
 * a model rather than by code.
 *
 * Membership is the assertion, not position: a row may name one category for
 * several operators (`set-variable / data-mapping / … | data`), so what has to
 * hold is that each operator's real category appears in its row.
 */
import { describe, expect, it } from 'vitest'
import { OPERATOR_GUIDE } from '../src/lib/workflow/operator-guide'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'
import { isAdvertisableOperatorCategory } from '../src/lib/workflow/operator-categories'

/** Labels that are not catalog categories: they describe *when* a tool is sent. */
const NON_CATEGORY_LABELS = new Set(['常驻', 'escape'])

interface Row {
  operators: string[]
  categories: string[]
  line: string
}

function tableRows(): Row[] {
  const rows: Row[] = []
  for (const line of OPERATOR_GUIDE.split('\n')) {
    if (!line.startsWith('|')) continue
    // `| a | b |` splits into ['', ' a ', ' b ', '']: drop the empty edges.
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length < 3) continue
    const [, operatorsCell, categoryCell] = cells
    if (!operatorsCell || !categoryCell) continue
    if (operatorsCell.includes('算子') || operatorsCell.startsWith('-')) continue

    rows.push({
      operators: operatorsCell
        .split('/')
        .map((name) => name.trim().replace(/`/g, ''))
        .filter((name) => /^[a-z][a-z0-9-]*$/.test(name)),
      categories: categoryCell
        .split('/')
        .map((name) => name.trim())
        .filter((name) => name && !NON_CATEGORY_LABELS.has(name) && !name.includes('→')),
      line,
    })
  }
  return rows
}

describe('operator guide: the category column matches the catalog', () => {
  const rows = tableRows().filter((row) => row.operators.length > 0)

  it('finds the mapping table', () => {
    // Guards the guard: a parser that matched nothing would pass vacuously.
    expect(rows.length).toBeGreaterThan(15)
  })

  it('names only operators that exist', () => {
    const unknown = rows.flatMap((row) => row.operators).filter((id) => !BLOCK_BY_ID.has(id))
    expect([...new Set(unknown)]).toEqual([])
  })

  it('files every operator under its real, advertisable category', () => {
    const problems: string[] = []
    for (const row of rows) {
      if (row.categories.length === 0) continue
      for (const id of row.operators) {
        const entry = BLOCK_BY_ID.get(id)
        if (!entry) continue
        if (!row.categories.includes(entry.category)) {
          problems.push(
            `${id}: guide says [${row.categories.join(', ')}] but catalog says ${entry.category}`,
          )
        }
        if (!isAdvertisableOperatorCategory(entry.category)) {
          problems.push(`${id}: ${entry.category} is not an advertisable category`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})
