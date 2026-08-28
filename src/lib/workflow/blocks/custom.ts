/**
 * Local (Browser-Copilot-only) block catalog entries.
 *
 * The generated {@link BLOCK_CATALOG} (`catalog.ts`, produced by
 * `catalog.gen.mjs` from Automa's shared.js) is byte-aligned with Automa and
 * must stay regenerable, so blocks that only exist in Browser Copilot are NOT
 * added there. They live here instead and are merged into the palette /
 * catalog lookups by `palette.ts`, the same way Automa blocks are consumed by
 * the editor, run logs, migration, and engine label resolution.
 *
 * Entries mirror {@link BlockCatalogEntry}; `cloud` is always false (these run
 * locally).
 *
 * @module lib/workflow/blocks/custom
 */

import type { BlockCatalogEntry } from './types'

/**
 * Browser-Copilot extension blocks, appended after the generated catalog.
 * Ids must not collide with Automa block ids (the lookup maps would otherwise
 * shadow one another).
 */
export const CUSTOM_BLOCKS: BlockCatalogEntry[] = [
  {
    id: 'ai-agent',
    name: 'AI agent',
    description:
      'Read a target element and hand it to an AI agent that can analyze the page and (optionally) act on it.',
    icon: 'riRobot2Line',
    category: 'general',
    component: 'BlockBasic',
    editComponent: 'EditAiAgent',
    inputs: 1,
    outputs: 1,
    allowedInputs: true,
    maxConnection: 1,
    tag: 'AI',
    data: {
      disableBlock: false,
      description: '',
      // Element locator (Automa shape): `selector` + `findBy`. Empty selector
      // means "no specific element — let the agent read the page itself".
      findBy: 'cssSelector',
      selector: '',
      // The user's instruction. Supports {{variable}} interpolation at runtime.
      prompt: '',
      // When false the agent runs in read-only mode (analyze only); when true
      // it runs fully autonomously and may click/fill/navigate.
      actOnPage: false,
      // Per-node cap on model↔tool round trips (independent of the global
      // setting), so a single workflow step cannot loop unbounded.
      maxToolRounds: 20,
      // Variable the agent's final text answer is stored under.
      variableName: 'lastAIAgent',
      // Have the agent take a page snapshot before acting so it can locate
      // interactive elements itself.
      useSnapshot: true,
    },
    cloud: false,
  },
]

/** Ids of every local extension block. */
export const CUSTOM_BLOCK_IDS: ReadonlySet<string> = new Set(CUSTOM_BLOCKS.map((b) => b.id))

/** Whether a block id refers to a local (non-Automa) extension block. */
export function isCustomBlock(id: string): boolean {
  return CUSTOM_BLOCK_IDS.has(id)
}
