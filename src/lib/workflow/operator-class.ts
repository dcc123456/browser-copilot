/**
 * How each workflow operator behaves during workflow GENERATION.
 *
 * Generation runs every operator against the live page so that "what got
 * recorded is what actually happened" holds. A few blocks cannot or must not
 * run inline, and this module is the single list of which:
 *
 *   - blocks the engine interprets itself (loops, sub-workflows, the trigger),
 *     because a single-node call cannot express them;
 *   - blocks whose side effects the user never asked for while merely
 *     *drafting* (real HTTP requests, notifications, disk writes, nested agent
 *     runs);
 *   - blocks that need a human at the keyboard;
 *   - blocks whose executors are still placeholders, so running them proves
 *     nothing.
 *
 * Pure block-id data with no `chrome` dependency, so both the execution bridge
 * (`background/workflow-engine/operator-exec`) and the tool catalogue
 * (`lib/tool-catalog`) classify operators identically. That matters: the
 * settings UI shows a warning for tools that act on the page, and a tool that
 * only records must not be flagged as one.
 *
 * @module lib/workflow/operator-class
 */

/** How an operator behaves during generation. */
export type OperatorExecClass = 'execute' | 'record-only'

/**
 * Blocks the engine interprets itself, so a single-node call cannot express
 * them. A loop body only exists relative to the loop node, and a sub-workflow
 * needs a saved child to reference.
 */
export const ENGINE_INTERPRETED_BLOCK_IDS: ReadonlySet<string> = new Set([
  'trigger',
  'execute-workflow',
  'loop-data',
  'loop-elements',
  'repeat-task',
  'while-loop',
  'loop-breakpoint',
])

/**
 * Blocks with side effects outside the page. Running these while the user is
 * only *drafting* a workflow would fire real requests / notifications / disk
 * writes, so they are recorded and left for the replay to perform.
 */
export const SIDE_EFFECT_BLOCK_IDS: ReadonlySet<string> = new Set([
  'webhook',
  'notification',
  'save-local',
  'save-assets',
  'export-data',
  'insert-data',
  'delete-data',
  'google-sheets',
  'google-drive',
  'google-sheets-drive',
  'block-package',
])

/** Blocks that recurse into an LLM run, or need a human at the keyboard. */
export const INTERACTIVE_BLOCK_IDS: ReadonlySet<string> = new Set([
  'ai-agent',
  'ai-prompt',
  'parameter-prompt',
])

/** Blocks whose executors are still placeholders — running them proves nothing. */
export const PLACEHOLDER_BLOCK_IDS: ReadonlySet<string> = new Set([
  'browser-event',
  'proxy',
  'note',
  'blocks-group',
])

/**
 * The one escape hatch: raw JavaScript.
 *
 * Lives here rather than in `operator-tools` because it is a *classification* —
 * the block is excluded from every category advertisement and from the
 * always-on tier, and is reachable only through `load_tools({groups:
 * ['operators_escape']})` plus a justification (see `scriptJustification`).
 * Keeping the id in this import-free module lets the category derivation
 * (`operator-categories`) and the tool builder (`operator-tools`) agree on it
 * without importing each other.
 */
export const JAVASCRIPT_BLOCK_ID = 'javascript-code'

/**
 * Edit-less blocks that ARE operators.
 *
 * The operator set is "palette blocks with a real edit form", which keeps the
 * runtime-only routing primitives (`active-tab`, `forward-page`, …) away from
 * the model. `go-back` is the deliberate exception: it takes no arguments at
 * all, and without it the model cannot record "open a list item, read its
 * detail, go back to the list" — the shape every collect-the-lists task needs
 * and the one the loop folding looks for. Both derivations apply this set so
 * they cannot disagree.
 */
export const EDIT_LESS_OPERATOR_IDS: ReadonlySet<string> = new Set(['go-back'])

/** Human explanation for why a block was recorded without running. */
export const RECORD_ONLY_REASONS: Readonly<Record<string, string>> = {
  trigger: 'trigger is the graph entry point; it is recorded, not run',
  'execute-workflow': 'sub-workflows run as part of their parent; recorded only',
  'loop-data': 'loops are driven by the engine, not by a single node; recorded only',
  'loop-elements': 'loops are driven by the engine, not by a single node; recorded only',
  'repeat-task': 'loops are driven by the engine, not by a single node; recorded only',
  'while-loop': 'loops are driven by the engine, not by a single node; recorded only',
  'loop-breakpoint': 'a breakpoint only means something inside a running loop; recorded only',
  webhook: 'recorded without sending the request — the replay performs it',
  notification: 'recorded without firing the notification — the replay performs it',
  'save-local': 'recorded without writing to disk — the replay performs it',
  'save-assets': 'recorded without downloading assets — the replay performs it',
  'export-data': 'recorded without exporting — the replay performs it',
  'insert-data': 'recorded without touching the data table — the replay performs it',
  'delete-data': 'recorded without touching the data table — the replay performs it',
  'ai-agent': 'recorded without starting a nested agent run — the replay performs it',
  'ai-prompt': 'recorded without calling the model — the replay performs it',
  'parameter-prompt': 'recorded without prompting you now — the replay asks',
  'browser-event': 'executor is still a placeholder; recorded only',
  proxy: 'executor is still a placeholder; recorded only',
  note: 'a note is documentation, not an action',
  'blocks-group': 'a group is a canvas container, not an action',
}

/**
 * Classify one operator block. Exhaustive over the operator set — a test
 * asserts that, so a newly catalogued block cannot silently default to running.
 */
export function operatorExecClass(blockId: string): OperatorExecClass {
  if (
    ENGINE_INTERPRETED_BLOCK_IDS.has(blockId) ||
    SIDE_EFFECT_BLOCK_IDS.has(blockId) ||
    INTERACTIVE_BLOCK_IDS.has(blockId) ||
    PLACEHOLDER_BLOCK_IDS.has(blockId)
  ) {
    return 'record-only'
  }
  return 'execute'
}

/** Why this block is recorded without running, for the tool result's note. */
export function recordOnlyReason(blockId: string): string {
  return RECORD_ONLY_REASONS[blockId] ?? `${blockId} is recorded without running`
}
