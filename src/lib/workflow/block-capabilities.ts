/**
 * Block capability catalog (计划 T01.2).
 *
 * A semantic layer over `blocks/catalog.ts`: for every block the palette
 * offers, a {@link BlockCapability} records what the block ACTS ON, which
 * variables it consumes/produces, whether it has side effects, whether the
 * engine interprets it (loops / branches / sub-workflow) and which semantic
 * actions it implements.
 *
 * Capabilities are DERIVED from the catalog (id/category/default data/port
 * counts) plus an explicit override table for the blocks whose meaning the
 * metadata cannot express — the override is kept in this module, not baked
 * into the catalog, so the editor catalog stays presentation-focused.
 *
 * Consumers: the IR → Workflow compiler (T02.5), the dataflow validator
 * (T04), and the deterministic repair library (T06.2).
 *
 * @module lib/workflow/block-capabilities
 */

import { PALETTE_BLOCKS } from './blocks/palette'
import type { BlockCategory } from './blocks/types'

import type { SemanticAction } from './ir'

export type SemanticActionName = SemanticAction['kind']

/** High-level capability classification. */
export type BlockCapabilityKind =
  | 'interaction'
  | 'navigation'
  | 'data'
  | 'control'
  | 'general'

/** One block's semantic capabilities. */
export interface BlockCapability {
  blockId: string
  kind: BlockCapabilityKind
  /** Semantic actions the block can execute. */
  actions: SemanticActionName[]
  /** Whether the block acts on a page element (must have a target). */
  needsTarget: boolean
  /** Whether execution produces an irreversible / business side effect. */
  hasSideEffect: boolean
  /** Block param keys relevant to the compiler (structural + data params). */
  params: string[]
  /** Param keys whose values are variables the block consumes. */
  inputsVars: string[]
  /** Param keys that name variables the block writes. */
  outputsVars: string[]
  /** The engine interprets this block itself (no plain executor call). */
  engineInterpreted: boolean
}

/** Minimal catalog metadata required for inference. */
export interface CatalogLikeEntry {
  blockId: string
  kind: BlockCategory
  inputs: number
  outputs: number
  params: string[]
  refDataKeys: string[]
}

// --- Explicit overrides ---------------------------------------------------------

type Override = Partial<Omit<BlockCapability, 'blockId' | 'kind'>> &
  Pick<BlockCapability, 'kind'>

const OVERRIDES: Record<string, Override> = {
  'event-click': {
    kind: 'interaction',
    actions: ['click'],
    needsTarget: true,
    hasSideEffect: true,
    outputsVars: [],
  },
  forms: {
    kind: 'interaction',
    actions: ['fill', 'select', 'check', 'submit'],
    needsTarget: true,
    hasSideEffect: true,
    outputsVars: ['variableName'],
  },
  'get-text': {
    kind: 'interaction',
    actions: ['read-text'],
    needsTarget: true,
    hasSideEffect: false,
    outputsVars: ['variableName'],
  },
  'attribute-value': {
    kind: 'interaction',
    actions: ['read-attribute'],
    needsTarget: true,
    hasSideEffect: false,
    outputsVars: ['variableName'],
  },
  'element-exists': {
    kind: 'interaction',
    actions: ['element-exists'],
    needsTarget: true,
    hasSideEffect: false,
    outputsVars: ['variableName'],
  },
  'hover-element': {
    kind: 'interaction',
    actions: ['hover'],
    needsTarget: true,
    hasSideEffect: false,
  },
  'press-key': {
    kind: 'interaction',
    actions: ['press-key'],
    needsTarget: false,
    hasSideEffect: false,
  },
  'element-scroll': {
    kind: 'interaction',
    actions: ['scroll'],
    needsTarget: false,
    hasSideEffect: false,
  },
  'new-tab': {
    kind: 'navigation',
    actions: ['navigate'],
    needsTarget: false,
    hasSideEffect: true,
  },
  'active-tab': {
    kind: 'navigation',
    actions: ['navigate'],
    needsTarget: false,
    hasSideEffect: false,
  },
  'switch-tab': {
    kind: 'navigation',
    actions: ['navigate'],
    needsTarget: false,
    hasSideEffect: false,
  },
  delay: {
    kind: 'general',
    actions: ['wait-element', 'wait-time'],
    needsTarget: false,
    hasSideEffect: false,
  },
  'javascript-code': {
    kind: 'general',
    actions: ['execute-js'],
    needsTarget: false,
    hasSideEffect: false,
  },
  'while-loop': {
    kind: 'control',
    actions: [],
    needsTarget: false,
    hasSideEffect: false,
    engineInterpreted: true,
  },
  'loop-data': {
    kind: 'control',
    actions: [],
    needsTarget: false,
    hasSideEffect: false,
    engineInterpreted: true,
  },
  'loop-elements': {
    kind: 'control',
    actions: [],
    needsTarget: false,
    hasSideEffect: false,
    engineInterpreted: true,
  },
  conditions: {
    kind: 'control',
    actions: [],
    needsTarget: false,
    hasSideEffect: false,
    engineInterpreted: true,
  },
  'execute-workflow': {
    kind: 'control',
    actions: [],
    needsTarget: false,
    hasSideEffect: false,
    engineInterpreted: true,
  },
  'read-page': {
    kind: 'data',
    actions: [],
    needsTarget: false,
    hasSideEffect: false,
  },
  'ai-agent': {
    kind: 'general',
    actions: ['ai-generate'],
    needsTarget: false,
    hasSideEffect: false,
  },
}

// --- Inference ------------------------------------------------------------------

const ELEMENT_CATEGORY: ReadonlySet<BlockCategory> = new Set<BlockCategory>([
  'interaction',
])

function kindFromCategory(category: BlockCategory): BlockCapabilityKind {
  switch (category) {
    case 'interaction':
      return 'interaction'
    case 'browser':
      return 'navigation'
    case 'data':
      return 'data'
    case 'conditions':
      return 'control'
    case 'general':
    case 'onlineServices':
    case 'package':
      return 'general'
  }
}

/**
 * Infer a capability from catalog metadata. The defaults are deliberately
 * conservative: only interaction blocks need a target; side effects are
 * assumed false unless an override says otherwise.
 */
export function inferBlockCapability(entry: CatalogLikeEntry): BlockCapability {
  const capability: BlockCapability = {
    blockId: entry.blockId,
    kind: kindFromCategory(entry.kind),
    actions: [],
    needsTarget: ELEMENT_CATEGORY.has(entry.kind) && entry.inputs > 0,
    hasSideEffect: false,
    params: [...entry.params],
    inputsVars: [],
    outputsVars: entry.refDataKeys.includes('variableName') ? ['variableName'] : [],
    engineInterpreted: false,
  }
  const override = OVERRIDES[entry.blockId]
  if (!override) return capability
  return {
    ...capability,
    ...override,
    blockId: entry.blockId,
  }
}

// --- Catalog construction -------------------------------------------------------

function entryFromPalette(paletteEntry: (typeof PALETTE_BLOCKS)[number]): CatalogLikeEntry {
  return {
    blockId: paletteEntry.id,
    kind: paletteEntry.category,
    inputs: paletteEntry.inputs,
    outputs: paletteEntry.outputs,
    params: Object.keys(paletteEntry.data ?? {}),
    refDataKeys: paletteEntry.refDataKeys ?? [],
  }
}

/** The derived capability for every palette block. */
export const BLOCK_CAPABILITIES: ReadonlyMap<string, BlockCapability> = new Map(
  PALETTE_BLOCKS.map((paletteEntry) => {
    const capability = inferBlockCapability(entryFromPalette(paletteEntry))
    return [capability.blockId, capability] as const
  }),
)

export function capabilityOf(blockId: string): BlockCapability | undefined {
  return BLOCK_CAPABILITIES.get(blockId)
}

// --- Semantic action indexes ----------------------------------------------------

/** Blocks implementing one semantic action; override order determines ranking. */
export function blocksForSemanticAction(action: SemanticActionName): string[] {
  const blocks: string[] = []
  for (const capability of BLOCK_CAPABILITIES.values()) {
    if (capability.actions.includes(action)) blocks.push(capability.blockId)
  }
  return blocks
}

/** Semantic actions implemented by one block. */
export function semanticActionsOfBlock(blockId: string): SemanticActionName[] {
  return capabilityOf(blockId)?.actions ?? []
}
