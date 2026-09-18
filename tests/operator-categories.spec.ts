import { describe, expect, it } from 'vitest'
import { USE_OPERATORS_TOOL, advertiseTools } from '../src/background/agent'
import {
  ADVERTISABLE_OPERATOR_CATEGORIES,
  CORE_OPERATOR_BLOCK_IDS,
  OPERATOR_CATEGORY_BLOCK_IDS,
  OPERATOR_CATEGORY_ENTRIES,
  OPERATOR_CATEGORY_HINTS,
  OPERATOR_CATEGORY_TOOL_NAMES,
  operatorCategoryGroup,
  operatorCategoryLabel,
} from '../src/lib/workflow/operator-categories'

/**
 * The dispatch contract that makes operator-direct mode affordable.
 *
 * The mode hands the model four operators plus a menu of categories; everything
 * else arrives only after the model names a category. Two things have to hold
 * for that to work at all, and neither is enforced by the type system:
 *
 *   1. every category the menu offers is real and has members, and
 *   2. the model is TOLD the selection replaces rather than accumulates.
 *
 * Get (2) wrong and a long conversation quietly ends up paying for every
 * category it ever touched, which is exactly the cost problem this exists to
 * solve.
 */
describe('operator category menu', () => {
  it('offers only categories that have members', () => {
    expect(ADVERTISABLE_OPERATOR_CATEGORIES.length).toBeGreaterThan(0)
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      expect(OPERATOR_CATEGORY_ENTRIES[category].length).toBeGreaterThan(0)
      expect(OPERATOR_CATEGORY_BLOCK_IDS[category].length).toBeGreaterThan(0)
    }
  })

  it('keeps the cloud-only categories out of the menu', () => {
    // Every block in them is `cloud: true`, so offering them would only teach
    // the model to ask for an empty set and then apologise.
    expect(ADVERTISABLE_OPERATOR_CATEGORIES).not.toContain('onlineServices')
    expect(ADVERTISABLE_OPERATOR_CATEGORIES).not.toContain('package')
  })

  it('gives every offered category a one-line hint', () => {
    // The menu is built by interpolating these; a missing one reads
    // `undefined` in the tool description.
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      const hint = OPERATOR_CATEGORY_HINTS[category]
      expect(typeof hint).toBe('string')
      expect(hint.trim().length).toBeGreaterThan(0)
    }
  })

  it('keeps each hint short enough to re-send every round', () => {
    // The menu is the most expensive prose in the mode: it is part of a tool
    // description, so it is paid on every round of every workflow conversation.
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      expect(OPERATOR_CATEGORY_HINTS[category].length).toBeLessThanOrEqual(90)
    }
  })

  it('covers the Browser Copilot custom blocks, not just the vendored catalog', () => {
    // `ai-agent` / `ocr` / `set-variable` / `get-secret` are this project's own
    // blocks. A dispatch derived only from the vendored catalog would make them
    // unreachable.
    const covered = new Set(
      ADVERTISABLE_OPERATOR_CATEGORIES.flatMap((category) => OPERATOR_CATEGORY_BLOCK_IDS[category]),
    )
    for (const id of ['ai-agent', 'ocr', 'set-variable', 'get-secret']) {
      expect(covered.has(id)).toBe(true)
    }
  })

  it('names every category for a human', () => {
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      expect(operatorCategoryLabel(category).trim().length).toBeGreaterThan(0)
      expect(operatorCategoryGroup(category)).toBe(`op_${category}`)
    }
  })
})

describe('use_operators tool description', () => {
  const tool = advertiseTools({ mode: 'workflow' }).find(
    (entry) => entry.function.name === USE_OPERATORS_TOOL,
  )!

  it('is advertised in workflow mode', () => {
    expect(tool).toBeDefined()
  })

  it('says the selection REPLACES rather than adds', () => {
    // Without this the model declares categories one at a time and never drops
    // any, so the payload grows back toward "all 54 schemas".
    expect(tool.function.description.toUpperCase()).toContain('REPLACE')
  })

  it('names the operators that need no declaration', () => {
    for (const name of CORE_OPERATOR_BLOCK_IDS) {
      expect(tool.function.description).toContain(name)
    }
  })

  it('lists every offered category in its menu', () => {
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      expect(tool.function.description).toContain(category)
    }
  })

  it('requires the categories argument, so an empty declaration is explicit', () => {
    const params = tool.function.parameters as { required?: string[] }
    expect(params.required).toEqual(['categories'])
  })

  it('stays small enough to re-send every round', () => {
    expect(tool.function.description.length).toBeLessThanOrEqual(1_200)
    expect(JSON.stringify(tool).length).toBeLessThanOrEqual(1_600)
  })
})

describe('category tool names', () => {
  it('prefixes every block id with the operator namespace', () => {
    for (const category of ADVERTISABLE_OPERATOR_CATEGORIES) {
      for (const name of OPERATOR_CATEGORY_TOOL_NAMES[category]) {
        expect(name.startsWith('wf_op_')).toBe(true)
      }
    }
  })

  it('never lists the same tool under two categories', () => {
    const all = ADVERTISABLE_OPERATOR_CATEGORIES.flatMap(
      (category) => OPERATOR_CATEGORY_TOOL_NAMES[category],
    )
    expect(new Set(all).size).toBe(all.length)
  })
})
