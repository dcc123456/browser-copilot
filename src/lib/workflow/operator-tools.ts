/**
 * Workflow operator → LLM tool generator.
 *
 * Each entry of {@link BLOCK_CATALOG} (except cloud-only and pure-placeholder
 * blocks) is rendered as one OpenAI-compatible function-calling tool whose
 * name is `wf_op_<blockId>`. Calling one of these tools EXECUTES the block
 * against the live page (see `background/workflow-engine/operator-exec`) and
 * appends a node to the conversation's `WorkflowDraft` only when that
 * execution succeeded — so the draft describes what actually happened.
 *
 * The schema is derived from the catalog entry's own `data` so the LLM and
 * the workflow executor agree on parameter names without a second source of
 * truth.
 *
 * The set is split into two tiers (see {@link WORKFLOW_AUTHOR_BLOCK_IDS}):
 * the page-driving core is advertised every round, the rest is loaded on
 * demand through `load_tools`.
 *
 * @module lib/workflow/operator-tools
 */

import type { WireTool } from '../llm'
import { PALETTE_BLOCKS } from './blocks/palette'
import type { BlockCatalogEntry, BlockCategory } from './blocks/types'
import {
  ADVERTISABLE_OPERATOR_CATEGORIES,
  CORE_OPERATOR_BLOCK_IDS,
  OPERATOR_CATEGORY_BLOCK_IDS,
  OPERATOR_CATEGORY_TOOL_NAMES,
  operatorCategoryGroup,
} from './operator-categories'
import { JAVASCRIPT_BLOCK_ID } from './operator-class'

/** Tool name prefix shared by every operator-derived tool. */
export const WF_OP_PREFIX = 'wf_op_'

/**
 * Returns the LLM tool name for a block id. Centralised so dispatch and
 * generation agree on the prefix and casing.
 */
export function operatorToolName(blockId: string): string {
  return WF_OP_PREFIX + blockId
}

/**
 * Returns the block id for an operator tool name, or undefined if the name
 * does not belong to this family.
 */
export function blockIdFromOperatorName(toolName: string): string | undefined {
  if (!toolName.startsWith(WF_OP_PREFIX)) return undefined
  return toolName.slice(WF_OP_PREFIX.length)
}

/**
 * Operator block ids: every palette entry that exposes a real edit form.
 * Placeholder / no-edit blocks (`active-tab`, `go-back`, `forward-page`,
 * `loop-breakpoint`, `blocks-group`) are intentionally excluded because they
 * are runtime-only routing primitives the LLM has no business picking directly.
 *
 * Built from {@link PALETTE_BLOCKS} — not the raw catalog — so Browser
 * Copilot's own blocks (`ai-agent`, `ocr`, `set-variable`, `get-secret`) are
 * reachable too. Without them the operator guide's standard recipes ("read the
 * image, then fill the code in") cannot be expressed at all.
 */
const PALETTE_OPERATOR_ENTRIES: readonly BlockCatalogEntry[] = PALETTE_BLOCKS.filter(
  (entry) => !entry.disableEdit,
)

const PALETTE_OPERATOR_IDS: readonly string[] = PALETTE_OPERATOR_ENTRIES.map((entry) => entry.id)

/**
 * Every block id an operator tool can name — the single source of truth for
 * "what can the model build with". Exported so the execution bridge's
 * classification can be asserted exhaustive against it.
 */
export const OPERATOR_BLOCK_IDS: readonly string[] = PALETTE_OPERATOR_IDS

/**
 * Operators that are NOT advertised on every round — the on-demand tail.
 *
 * DERIVED from the category taxonomy (`operator-categories`), not hand-written.
 * It used to be a curated list of ~30 ids, which meant a newly catalogued block
 * silently vanished from every advertisement until someone remembered to add
 * it. Now a block is reachable the moment it lands in a category.
 *
 * The set is the union of the advertisable categories — i.e. every operator
 * except {@link JAVASCRIPT_BLOCK_ID}, which only the escape group carries.
 * `TOOL_GROUPS.operators_author` is this set, so the group remains the
 * "give me every operator at once" escape hatch it has always been.
 */
export const WORKFLOW_AUTHOR_BLOCK_IDS: ReadonlySet<string> = new Set(
  ADVERTISABLE_OPERATOR_CATEGORIES.flatMap((category) => OPERATOR_CATEGORY_BLOCK_IDS[category]),
)

/**
 * Operators advertised on EVERY round of workflow generation.
 *
 * A deliberately tiny core (see `CORE_OPERATOR_BLOCK_IDS`): navigate, click,
 * fill-or-read a field, read text. Everything else waits for the model to
 * declare a category, which is what keeps the per-round payload from carrying
 * all 54 schemas.
 *
 * Note this is a SUBSET of {@link WORKFLOW_AUTHOR_BLOCK_IDS} — the core four
 * live in `interaction`, so the two tiers overlap by design. The old tiers
 * were a strict partition; that invariant is gone and the tests assert the new
 * shape instead.
 */
export const WORKFLOW_ACTION_BLOCK_IDS: ReadonlySet<string> = new Set(CORE_OPERATOR_BLOCK_IDS)

/** Operator entries held back from the every-round advertisement. */
const WORKFLOW_AUTHOR_OPERATOR_ENTRIES: readonly BlockCatalogEntry[] =
  PALETTE_OPERATOR_ENTRIES.filter((entry) => WORKFLOW_AUTHOR_BLOCK_IDS.has(entry.id))

/**
 * The block id of the one escape hatch.
 *
 * Defined in `operator-class` (an import-free module) so the category
 * derivation can exclude it without importing this module — the dependency
 * only ever runs one way: `operator-class` ← `operator-categories` ← here.
 * Re-exported because every existing caller imports it from this module.
 */
export { JAVASCRIPT_BLOCK_ID }

/**
 * The argument the escape hatch will not run without. Shared by the tool
 * schema (which marks it required) and the recording gate (which refuses the
 * call) so the two cannot disagree about the name.
 */
export const SCRIPT_JUSTIFICATION_ARG = 'justification'

/**
 * How short a justification may be before the gate treats it as missing. A
 * one-word answer ("needed") is not a reason; the point is to force the model
 * to name the operators it ruled out, which is also what the user reads later
 * on the canvas card.
 */
export const MIN_SCRIPT_JUSTIFICATION_CHARS = 12

/**
 * The escape hatch's gate.
 *
 * `javascript-code` is allowed only when no declarative operator can do the
 * step, and the only way to tell those two cases apart is to make the model
 * say which operators it ruled out and why. A call without that reasoning is
 * refused BEFORE anything runs, so no node is recorded: a draft can never end
 * up holding a script nobody justified.
 *
 * Lives here rather than next to either caller because BOTH recording paths
 * (`background/operator-tool-run`, `background/operator-tool-handler`) must
 * apply the same rule — and a rule kept in two places drifts.
 *
 * @returns the trimmed justification, or null when the call must be refused.
 */
export function scriptJustification(args: Record<string, unknown>): string | null {
  const raw = args[SCRIPT_JUSTIFICATION_ARG]
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return text.length >= MIN_SCRIPT_JUSTIFICATION_CHARS ? text : null
}

/**
 * Refusal handed back to the model. Names the declarative substitutes by block
 * id on purpose: "prefer operators" on its own gets ignored, and the model
 * needs to see the ladder rungs it skipped before it can decide the step is
 * genuinely inexpressible.
 */
export const SCRIPT_REFUSAL =
  'Refused: `javascript-code` requires a `justification` naming the declarative operators you tried and the concrete reason each one cannot do this step. ' +
  'Generated workflows must stay maintainable by someone who does not read code, so a script is a LAST RESORT. ' +
  'Work the ladder before retrying: get-text / attribute-value (read) · forms (fill / select / check) · event-click / hover-element / press-key / element-scroll (interact) · element-exists / conditions (branch) · set-variable / data-mapping / slice-variable / regex-variable / increase-variable / sort-data (transform) · wait-connections / delay (settle) · webhook (fetch). ' +
  'Split the step into a combination of those if any works; call this tool again only when none can, with the justification attached. ' +
  '/ 代码节点是最后手段：必须说明试过哪些算子、它们为什么不行，否则不会记录节点。'

/**
 * The escape hatch: blocks that are never advertised in ANY round.
 *
 * A generated workflow is meant to be maintainable by someone who does not
 * read code, so a script is allowed only when no declarative operator can
 * perform the step (the ladder is spelled out in `lib/workflow/operator-guide`).
 * Keeping the schema out of the payload is what makes that rule hold in
 * practice: a block the model never sees is a block it cannot casually reach
 * for, and getting at it takes a deliberate
 * `load_tools({groups:['operators_escape']})`.
 *
 * Availability alone is not enforcement — the call itself is gated too (see
 * `SCRIPT_JUSTIFICATION` in `background/operator-tool-run`).
 */
export const WORKFLOW_ESCAPE_BLOCK_IDS: ReadonlySet<string> = new Set([JAVASCRIPT_BLOCK_ID])

/** Operator entries that are only ever reachable through the escape group. */
const WORKFLOW_ESCAPE_OPERATOR_ENTRIES: readonly BlockCatalogEntry[] =
  PALETTE_OPERATOR_ENTRIES.filter((entry) => WORKFLOW_ESCAPE_BLOCK_IDS.has(entry.id))

/**
 * Operator entries advertised in EVERY workflow-mode round — the core four,
 * regardless of which categories the model declared.
 */
const WORKFLOW_ACTION_OPERATOR_ENTRIES: readonly BlockCatalogEntry[] =
  PALETTE_OPERATOR_ENTRIES.filter((entry) => WORKFLOW_ACTION_BLOCK_IDS.has(entry.id))

/** Block ids of the always-advertised operator tier. */
export const WORKFLOW_ACTION_OPERATOR_IDS: readonly string[] = WORKFLOW_ACTION_OPERATOR_ENTRIES.map(
  (entry) => entry.id,
)

/** Block ids of the on-demand operator tier. */
export const WORKFLOW_AUTHOR_OPERATOR_IDS: readonly string[] = WORKFLOW_AUTHOR_OPERATOR_ENTRIES.map(
  (entry) => entry.id,
)

/** Tool names of the always-advertised operator tier. */
export const WORKFLOW_ACTION_OPERATOR_NAMES: readonly string[] =
  WORKFLOW_ACTION_OPERATOR_IDS.map(operatorToolName)

/** Tool names of the on-demand operator tier (`TOOL_GROUPS.operators_author`). */
export const WORKFLOW_AUTHOR_OPERATOR_NAMES: readonly string[] =
  WORKFLOW_AUTHOR_OPERATOR_IDS.map(operatorToolName)

/** Block ids of the escape hatch — never advertised unless explicitly loaded. */
export const WORKFLOW_ESCAPE_OPERATOR_IDS: readonly string[] = WORKFLOW_ESCAPE_OPERATOR_ENTRIES.map(
  (entry) => entry.id,
)

/** Tool names of the escape hatch (`TOOL_GROUPS.operators_escape`). */
export const WORKFLOW_ESCAPE_OPERATOR_NAMES: readonly string[] =
  WORKFLOW_ESCAPE_OPERATOR_IDS.map(operatorToolName)

/** Tool name → block id, for the full operator set. */
export const WF_OP_BY_NAME: ReadonlyMap<string, string> = new Map(
  PALETTE_OPERATOR_IDS.map((id) => [operatorToolName(id), id] as const),
)

/** All operator tool names in catalog order, useful for whitelists. */
export const OPERATOR_NAMES: readonly string[] = PALETTE_OPERATOR_IDS.map(operatorToolName)

/**
 * One tool group per advertisable category, ready to spread into
 * `TOOL_GROUPS` (see `background/agent`).
 *
 * Registering them as groups is what buys the whole dispatch mechanism for
 * free: `load_tools` can name them, and a stray call to an operator whose
 * category was never declared auto-activates that category instead of failing
 * (the model would otherwise have no way to recover).
 */
export const WORKFLOW_CATEGORY_TOOL_GROUPS: Record<string, readonly string[]> = Object.fromEntries(
  ADVERTISABLE_OPERATOR_CATEGORIES.map((category) => [
    operatorCategoryGroup(category),
    OPERATOR_CATEGORY_TOOL_NAMES[category],
  ]),
)

/** Category ids offered by `use_operators`, in palette display order. */
export const OPERATOR_CATEGORY_IDS: readonly BlockCategory[] = ADVERTISABLE_OPERATOR_CATEGORIES

/**
 * Build the LLM tool list from the palette. Called once per request so the
 * cost is negligible (~54 entries); cheap enough to inline at module load by
 * `advertiseTools`.
 *
 * This is the FULL set, escape hatch included — the whitelist the dispatcher
 * and the tier assertions agree on. Workflow mode advertises
 * {@link buildWorkflowCoreTools} plus whichever categories the conversation
 * declared (`use_operators`) or loaded (`operators_author`, `operators_escape`).
 */
export function buildOperatorTools(): WireTool[] {
  return PALETTE_OPERATOR_ENTRIES.map(operatorToolFromEntry)
}

/** The every-round operator core — see {@link WORKFLOW_ACTION_OPERATOR_IDS}. */
export function buildWorkflowCoreTools(): WireTool[] {
  return WORKFLOW_ACTION_OPERATOR_ENTRIES.map(operatorToolFromEntry)
}

/** The on-demand operator tier — see {@link WORKFLOW_AUTHOR_OPERATOR_IDS}. */
export function buildWorkflowAuthorTools(): WireTool[] {
  return WORKFLOW_AUTHOR_OPERATOR_ENTRIES.map(operatorToolFromEntry)
}

/**
 * Operators of the given categories, in catalog order, without duplicates.
 *
 * Deduplication matters: the core four all live in `interaction`, so building
 * the interaction category naively would emit `wf_op_forms` twice and the
 * provider rejects a tool list with repeated names.
 */
export function buildWorkflowCategoryTools(categories: Iterable<BlockCategory>): WireTool[] {
  const wanted = new Set<string>()
  for (const category of categories) {
    for (const id of OPERATOR_CATEGORY_BLOCK_IDS[category] ?? []) wanted.add(id)
  }
  return PALETTE_OPERATOR_ENTRIES.filter((entry) => wanted.has(entry.id)).map(operatorToolFromEntry)
}

/** The escape hatch — see {@link WORKFLOW_ESCAPE_OPERATOR_IDS}. */
export function buildWorkflowEscapeTools(): WireTool[] {
  return WORKFLOW_ESCAPE_OPERATOR_ENTRIES.map(operatorToolFromEntry)
}

/** Translate one catalog entry to a `WireTool`. Exported for tests. */
export function operatorToolFromEntry(entry: BlockCatalogEntry): WireTool {
  return {
    type: 'function',
    function: {
      name: operatorToolName(entry.id),
      description: composeDescription(entry),
      parameters: dataSchemaFromEntry(entry),
    },
  }
}

/**
 * The one sentence every operator tool carries. Kept to a single clause: the
 * behaviour is identical for all ~54 tools and is spelled out in full in the
 * workflow-mode system prompt, so repeating it per tool only inflated the
 * payload that gets re-sent on every round. Trimmed again when `forms`' read
 * mode (`getValue`) needed a described parameter and the round-1 budget had
 * ~130 chars left.
 */
const OPERATOR_DESCRIPTION_SUFFIX =
  'Runs on the page now, records only on success / 立即执行，成功才记录。'

/**
 * Cap on the catalog sentence folded into a tool description. A few catalog
 * entries (`ocr`, `get-secret`) carry a paragraph; uncapped, one of them would
 * outweigh three ordinary operators in a payload that is re-sent every round.
 * The full text stays available in the palette UI.
 */
const MAX_OPERATOR_DESCRIPTION_CHARS = 160

/** Truncate at a word boundary so the description never ends mid-word. */
function clampDescription(text: string): string {
  if (text.length <= MAX_OPERATOR_DESCRIPTION_CHARS) return text
  const cut = text.slice(0, MAX_OPERATOR_DESCRIPTION_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * Description written into the LLM. Bilingual (zh/en) because the agent speaks
 * both depending on the user's locale.
 *
 * Deliberately terse. The load-bearing instruction — "these ACT on the page
 * and record only what worked" — lives in the system prompt and in
 * {@link OPERATOR_DESCRIPTION_SUFFIX}; anything longer here is paid on every
 * round of every workflow conversation.
 */
function composeDescription(entry: BlockCatalogEntry): string {
  const base = clampDescription(entry.description?.trim() || entry.name)
  return `[wf_op] ${base} ${OPERATOR_DESCRIPTION_SUFFIX}`
}

/**
 * Editor-only fields that must never reach the model's schema. They are
 * canvas/UI state (which element is highlighted, where a value is assigned,
 * ...) and the model fills them with noise that then lands in the recorded
 * node.
 *
 * `multiple` / `saveData` / `dataColumn` are here too, but are re-exposed for
 * the two blocks that implement them — see {@link COLLECTING_BLOCK_IDS}.
 *
 * `onConflict` / `refKey` are here because **no executor reads either** (they are
 * declared by export-data, the two Google Sheets blocks, handle-download and
 * save-assets, and edited by their forms). Advertising a knob that silently does
 * nothing is how a workflow comes to promise behaviour it does not have — the
 * same reason the collect trio is gated. Move one back out only once an executor
 * honours it.
 *
 * `saveMode` is different: `save-local` ignores it **on purpose**. A configured
 * download directory wins unconditionally so that setting one up stops the
 * prompts; honouring `manual` here would re-introduce a dialog for everyone who
 * configured a directory. See `writeToConfiguredDir` in the executor.
 */
export const UI_ONLY_KEYS: ReadonlySet<string> = new Set([
  'disableBlock',
  'description',
  'markEl',
  'multiple',
  'saveData',
  'dataColumn',
  'assignVariable',
  'events',
  'resumeLastWorkflow',
  'loopId',
  'onConflict',
  'refKey',
  'saveMode',
])

/** The data-table collection trio, in the order they are documented. */
const COLLECT_KEYS: ReadonlySet<string> = new Set(['multiple', 'saveData', 'dataColumn'])

/**
 * Blocks whose executors really read `multiple` / `saveData` / `dataColumn`.
 *
 * The three keys come from Automa's shared "InsertWorkflowData" slot and are
 * declared by about sixteen catalog entries, but only these two executors do
 * anything with them. Re-exposing them everywhere would tell the model to
 * switch on a feature that silently does nothing, and a workflow that claims to
 * collect and then exports an empty file is worse than one that never claimed
 * to. Add a block here only once its executor honours all three.
 *
 * `take-screenshot` also collects (through its own `saveToColumn` toggle), but
 * is deliberately NOT added: the value it would put in the column is a base64
 * data URL, which is not something a model should be told to pipe into a table.
 * Its form still exposes the controls for a human.
 */
const COLLECTING_BLOCK_IDS: ReadonlySet<string> = new Set(['get-text', 'read-page'])

/**
 * What `saveData` / `dataColumn` mean. Shared by both collecting blocks so the
 * model is told the same thing about the same mechanism, and so a change to the
 * semantics only has to be written once.
 */
const COLLECT_PROPERTIES: Readonly<Record<string, unknown>> = {
  saveData: {
    type: 'boolean',
    description:
      'Also append the read values into the data table — the only thing `wf_op_export-data` writes. This is how a page list is collected.',
  },
  dataColumn: {
    type: 'string',
    description:
      'Column name for saveData. Rows are addressed by match index (or by the loop index inside a loop), so reading again with a different column fills that column in instead of adding rows.',
  },
}

/**
 * Per-block schema overrides for shapes the default-value derivation cannot
 * express. `conditions` is the important one: its `data.conditions` is an empty
 * array by default, so derivation produced `items: {type: 'string'}` — which
 * taught the model to emit a string list the executor cannot evaluate. Both
 * accepted forms are declared explicitly here, plus `code`, which the executor
 * evaluates in the page and which is far easier for a model to get right.
 */
const SCHEMA_OVERRIDES: Readonly<Record<string, Record<string, unknown>>> = {
  [JAVASCRIPT_BLOCK_ID]: {
    [SCRIPT_JUSTIFICATION_ARG]: {
      type: 'string',
      description:
        'Required. Why no declarative operator can do this step: name the operators you tried and the concrete reason each fails. A call without it is refused.',
    },
  },
  forms: {
    getValue: {
      type: 'boolean',
      description:
        'READ mode: capture the control’s value into `variableName` instead of writing (checkbox → boolean, multi-select → array). Read a field with this — never a script.',
    },
  },
  'get-text': {
    multiple: {
      type: 'boolean',
      description: 'Read EVERY match of `selector`, not just the first.',
    },
    ...COLLECT_PROPERTIES,
  },
  'read-page': {
    source: {
      type: 'string',
      enum: ['text', 'selection', 'html'],
      description:
        'What to read: `text` = the page’s visible text (default), `selection` = what the user highlighted, `html` = raw markup.',
    },
    selector: {
      type: 'string',
      description:
        'Optional CSS selector to scope the read. Empty = the whole page. Ignored when source is `selection`.',
    },
    maxChars: {
      type: 'number',
      description: 'Cap on returned characters (default 20000).',
    },
    variableName: {
      type: 'string',
      description:
        'Variable the read lands in (default `lastReadPage`); reference it downstream as `{{name}}`.',
    },
    ...COLLECT_PROPERTIES,
  },
  'save-local': {
    value: {
      type: 'string',
      description: 'The content to write. MUST be a `{{reference}}`; a literal is refused.',
    },
    filename: {
      type: 'string',
      description: 'File name with extension, e.g. `report.md`. May contain `{{reference}}`.',
    },
    // `saveMode` is deliberately NOT here. It is a real edit-form field, but
    // `save-local` ignores it on purpose (a configured download directory wins
    // unconditionally so that setting one up stops the prompts), so teaching the
    // model "`manual` asks" would be a lie. Overrides are merged AFTER the
    // UI_ONLY_KEYS filter, so listing it here re-advertises it.
    variableName: {
      type: 'string',
      description:
        'OUTPUT only: the variable that receives the saved file PATH. NOT the content — that is `value`.',
    },
  },
  'export-data': {
    name: {
      type: 'string',
      description: 'File name with extension, e.g. `热搜.csv`. May contain `{{reference}}`.',
    },
    type: {
      type: 'string',
      enum: ['csv', 'json', 'plain-text'],
      description: '`csv` (header row, default) | `json` | `plain-text` (no header, no quoting).',
    },
    dataToExport: {
      type: 'string',
      enum: ['data-columns', 'variable'],
      description:
        '`data-columns` (default) = the collected table; `variable` = the one named below.',
    },
    variableName: {
      type: 'string',
      description: 'Only with `dataToExport:"variable"`.',
    },
    csvDelimiter: {
      type: 'string',
      description: 'Cell separator (default `,`).',
    },
    addBOMHeader: {
      type: 'boolean',
      description: 'Prepend a UTF-8 BOM for Excel-friendly Chinese CSV.',
    },
  },
  conditions: {
    code: {
      type: 'string',
      description:
        'A JS expression evaluated in the page, e.g. "document.querySelectorAll(\'.row\').length > 3". Preferred over condition rows.',
    },
    conditions: {
      type: 'array',
      description: 'Automa-style condition groups; ignored when `code` is set.',
      items: {
        type: 'object',
        properties: {
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                compare: { type: 'string' },
                value: {},
                name: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: true,
      },
    },
  },
}

/**
 * Arguments a tool will not accept a call without. Only the escape hatch has
 * any: the model must state why no declarative operator can do the step, which
 * is both the enforcement point and the note the user reads on the canvas.
 */
const REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = {
  [JAVASCRIPT_BLOCK_ID]: [SCRIPT_JUSTIFICATION_ARG],
}

/**
 * The element-locator params added to every block that reads an element from
 * the page. `ref` is preferred: it comes from `snapshot_page` and already
 * carries a scored, multi-strategy locator, which the bridge resolves into the
 * node's `selector` + `target`.
 */ const ELEMENT_TARGET_PROPERTIES: Readonly<Record<string, unknown>> = {
  ref: {
    type: 'string',
    description: 'Element ref from snapshot_page (e.g. "e12"); preferred.',
  },
  target: {
    type: 'object',
    description: 'Rich locator {primary, fallbacks}; only when no ref is available.',
    additionalProperties: true,
  },
  label: { type: 'string', description: 'Human-readable element name, for logs.' },
  selector: { type: 'string', description: 'Raw CSS selector; last resort.' },
}

/** Whether a block reads an element from the page. */
export function takesElementTarget(entry: BlockCatalogEntry): boolean {
  return (entry.refDataKeys ?? []).includes('selector')
}

/**
 * Convert a catalog entry's `data` shape into an OpenAI-compatible JSON Schema.
 * UI-only fields are dropped; everything else becomes a property. Nested object
 * defaults recurse one level so `eventParams` / `targetOptions` show up as
 * structured objects, not opaque strings. Blocks that read an element also get
 * the locator params, so the model can target by `ref` instead of guessing CSS.
 */
export function dataSchemaFromEntry(entry: BlockCatalogEntry): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const collects = COLLECTING_BLOCK_IDS.has(entry.id)
  for (const [key, value] of Object.entries(entry.data)) {
    // UI-only, unless this block is one of the two that really collect.
    if (UI_ONLY_KEYS.has(key) && !(collects && COLLECT_KEYS.has(key))) continue
    properties[key] = jsonSchemaForValue(value)
  }
  Object.assign(properties, SCHEMA_OVERRIDES[entry.id] ?? {})
  if (takesElementTarget(entry)) Object.assign(properties, ELEMENT_TARGET_PROPERTIES)
  const required = REQUIRED_ARGS[entry.id]
  return {
    type: 'object',
    additionalProperties: true,
    properties,
    ...(required ? { required: [...required] } : {}),
  }
}

/** One leaf or nested-object schema for a default value. */
function jsonSchemaForValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { type: 'string' }
  }
  if (typeof value === 'string') return { type: 'string' }
  if (typeof value === 'number') return { type: 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (Array.isArray(value)) {
    // An empty default array tells us nothing about its items, and guessing
    // `items: {type: 'string'}` taught the model to emit shapes the executors
    // cannot read. Declare it as a plain array instead; blocks whose arrays
    // need structure carry a SCHEMA_OVERRIDES entry.
    if (value.length === 0) return { type: 'array' }
    return { type: 'array', items: jsonSchemaForValue(value[0]) }
  }
  if (typeof value === 'object') {
    const nested: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      nested[k] = jsonSchemaForValue(v)
    }
    return { type: 'object', properties: nested, additionalProperties: true }
  }
  return { type: 'string' }
}

/** Convenience accessor for consumers that only know the tool name. */
export function isOperatorTool(toolName: string): boolean {
  return WF_OP_BY_NAME.has(toolName)
}
