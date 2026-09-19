/**
 * Workflow operator categories → the on-demand tool tiers of workflow mode.
 *
 * Workflow generation used to advertise all 54 operator schemas on every round
 * (~32.4k chars, ~9.8k tokens, re-sent for the whole conversation). The catalog
 * already groups those blocks into categories for the canvas palette, and this
 * module turns that same grouping into a dispatch mechanism: the model declares
 * the categories it needs, and only those schemas are advertised.
 *
 * Two things make this cheap to maintain:
 *
 *   - Everything is DERIVED from {@link PALETTE_BLOCKS}. A newly catalogued
 *     block lands in its own category automatically; nothing here needs editing.
 *   - The grouping is the palette's, so the tool the model is offered and the
 *     card it sees on the canvas are the same taxonomy.
 *
 * Categories with no members (`onlineServices`, `package` — every block in them
 * is cloud-only) are omitted from the dispatch menu rather than advertised as
 * empty.
 *
 * @module lib/workflow/operator-categories
 */

import { CATEGORY_META } from './blocks/catalog'
import { PALETTE_BLOCKS } from './blocks/palette'
import type { BlockCatalogEntry, BlockCategory } from './blocks/types'
import { EDIT_LESS_OPERATOR_IDS, JAVASCRIPT_BLOCK_ID } from './operator-class'

/**
 * Every block an operator tool can name — the same predicate
 * `operator-tools` uses (`PALETTE_BLOCKS` minus the edit-less routing
 * primitives, plus the edit-less exceptions). Derived independently here rather
 * than imported so the dependency only runs one way;
 * `tests/operator-categories.spec.ts` asserts the two derivations agree, so
 * they cannot drift apart silently.
 */
const OPERATOR_ENTRIES: readonly BlockCatalogEntry[] = PALETTE_BLOCKS.filter(
  (entry) => !entry.disableEdit || EDIT_LESS_OPERATOR_IDS.has(entry.id),
)

/**
 * The one operator no category may claim.
 *
 * `javascript-code` is the escape hatch: it is reachable only through
 * `load_tools({groups:['operators_escape']})` and only with a justification.
 * Letting the palette's `interaction` category advertise it would hand the
 * model raw JS as an ordinary step, which is exactly what the hatch exists to
 * prevent.
 */
const NON_CATEGORY_BLOCK_IDS: ReadonlySet<string> = new Set([JAVASCRIPT_BLOCK_ID])

/** Every category id, in the palette's display order. */
const ALL_CATEGORIES: readonly BlockCategory[] = [
  'general',
  'browser',
  'interaction',
  'data',
  'conditions',
  'onlineServices',
  'package',
]

/** An empty `Record<BlockCategory, T>`, so the maps below stay exhaustively typed. */
function emptyByCategory<T>(value: (category: BlockCategory) => T): Record<BlockCategory, T> {
  return {
    interaction: value('interaction'),
    browser: value('browser'),
    general: value('general'),
    onlineServices: value('onlineServices'),
    data: value('data'),
    conditions: value('conditions'),
    package: value('package'),
  }
}

/** Category members, keyed by category id. Empty categories are kept (as `[]`). */
export const OPERATOR_CATEGORY_ENTRIES: Record<BlockCategory, readonly BlockCatalogEntry[]> =
  (() => {
    const map = emptyByCategory<BlockCatalogEntry[]>(() => [])
    for (const entry of OPERATOR_ENTRIES) {
      if (NON_CATEGORY_BLOCK_IDS.has(entry.id)) continue
      map[entry.category].push(entry)
    }
    return map
  })()

/** Block ids per category. */
export const OPERATOR_CATEGORY_BLOCK_IDS: Record<BlockCategory, readonly string[]> = (() => {
  const map = emptyByCategory<string[]>(() => [])
  for (const category of ALL_CATEGORIES) {
    map[category] = OPERATOR_CATEGORY_ENTRIES[category].map((entry) => entry.id)
  }
  return map
})()

/**
 * Tool names per category (`wf_op_<blockId>`).
 *
 * The prefix is spelled out rather than imported from `operator-tools` so this
 * module stays upstream of it; a test asserts these names equal
 * `blockIds.map(operatorToolName)`, so the two cannot drift.
 */
export const OPERATOR_CATEGORY_TOOL_NAMES: Record<BlockCategory, readonly string[]> = (() => {
  const map = emptyByCategory<string[]>(() => [])
  for (const category of ALL_CATEGORIES) {
    map[category] = OPERATOR_CATEGORY_BLOCK_IDS[category].map((id) => 'wf_op_' + id)
  }
  return map
})()

/** Tool group name for a category, e.g. `interaction` → `op_interaction`. */
export function operatorCategoryGroup(category: BlockCategory): string {
  return `op_${category}`
}

/** Reverse of {@link operatorCategoryGroup}; undefined for any other group. */
export function categoryOfOperatorGroup(group: string): BlockCategory | undefined {
  if (!group.startsWith('op_')) return undefined
  const category = group.slice(3)
  return category in OPERATOR_CATEGORY_ENTRIES ? (category as BlockCategory) : undefined
}

/** Type guard for a category id the model may name in `use_operators`. */
export function isAdvertisableOperatorCategory(value: string): value is BlockCategory {
  return (ADVERTISABLE_OPERATOR_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Categories worth offering the model: those that actually have members.
 * `onlineServices` and `package` are cloud-only, so listing them would only
 * teach the model to ask for an empty set.
 */
export const ADVERTISABLE_OPERATOR_CATEGORIES: readonly BlockCategory[] = ALL_CATEGORIES.filter(
  (category) => OPERATOR_CATEGORY_ENTRIES[category].length > 0,
)

/**
 * One-line "when to declare this category" hint, used to build the
 * `use_operators` menu. Kept terse on purpose: this text is re-sent every
 * round, so it is the most expensive prose in the mode.
 */
export const OPERATOR_CATEGORY_HINTS: Record<BlockCategory, string> = {
  interaction: 'click, type, select, hover, upload, read text/attributes off the page',
  browser: 'tabs, navigation, cookies, dialogs, downloads, screenshots, OCR, writing a file',
  data: 'transform values: variables, mapping, regex, sorting, slicing, table rows, secrets',
  conditions: 'branch and repeat: if/exists, loops, repeat N times',
  general: 'timing, sub-workflows, webhooks, notifications, clipboard, nested agent runs',
  onlineServices: 'cloud integrations (not available in this build)',
  package: 'packaged block groups (not available in this build)',
}

/** Human-readable category name (palette taxonomy). */
export function operatorCategoryLabel(category: BlockCategory): string {
  return CATEGORY_META[category].name
}

/**
 * The operators advertised on EVERY round, whatever the model declared.
 *
 * These are the irreducible core of any page task — navigate, click, fill or
 * read a field, read text, and go back — and they are all in `interaction` (or
 * `browser`, for the two navigation blocks), so a model that declares nothing
 * can still start working instead of burning a round on a declaration. All
 * five cost ~3.5k chars; `go-back` carries no arguments at all.
 *
 * `go-back` is core because the list→detail→back collection pattern needs it
 * every time: open an item, read its detail, return to the list. Without it
 * that shape can only be faked by re-navigating, which re-shuffles the list
 * the workflow is iterating.
 *
 * `new-tab` is outside the "interaction" mental model (it is catalogued under
 * `browser`); it is here because every task starts by getting to a page.
 */
export const CORE_OPERATOR_BLOCK_IDS: readonly string[] = [
  'new-tab',
  'event-click',
  'forms',
  'get-text',
  'go-back',
]

/** Tool names of the always-advertised core. */
export const CORE_OPERATOR_TOOL_NAMES: readonly string[] = CORE_OPERATOR_BLOCK_IDS.map(
  (id) => 'wf_op_' + id,
)
