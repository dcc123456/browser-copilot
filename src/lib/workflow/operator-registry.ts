/**
 * Operator Registry — the AI decision layer for workflow generation.
 *
 * The registry is deliberately DECOUPLED from the editor's block catalog
 * (`blocks/catalog.ts` / `blocks/palette.ts`). The editor catalog answers
 * "what can be inserted on the canvas"; this registry answers "which executable
 * implementation can satisfy a semantic intent". It is the single source the
 * AI discovery reads, and it records operational facts the presentation catalog
 * does not: whether an executor really exists, placeholder / cloud-only /
 * generation flags, AI exposure, side-effect level, semantic capabilities and
 * the default goal + repair hints.
 *
 * The registry is DERIVED from the palette so every executable block is
 * accounted for (an audit test asserts completeness), with an explicit override
 * table for facts the catalog cannot express.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/operator-registry
 */

import { PALETTE_BLOCKS } from './blocks/palette'
import type { SemanticActionName } from './block-capabilities'
import { capabilityOf } from './block-capabilities'
import {
  ENGINE_INTERPRETED_BLOCK_IDS,
  PLACEHOLDER_BLOCK_IDS,
  SIDE_EFFECT_BLOCK_IDS,
  JAVASCRIPT_BLOCK_ID,
} from './operator-class'
import type { WorkflowNodeGoalContract } from './node-goal-contract'

/** How visible an operator is during generation. */
export type AiExposure = 'core' | 'on-demand' | 'fallback' | 'hidden'

/** Side-effect level of an operator. */
export type SideEffectLevel = 'none' | 'page' | 'external'

/** Operational facts about one operator for the AI decision layer. */
export interface OperatorRegistryEntry {
  /** Block id, unique. */
  id: string
  /** English display name. */
  name: string
  /** English one-line description. */
  description: string
  /** Generation visibility. */
  aiExposure: AiExposure
  /** Side-effect level. */
  sideEffect: SideEffectLevel
  /** Semantic capabilities (action kinds) the operator implements. */
  capabilities: SemanticActionName[]
  /** Whether a real executor exists (false ⇒ placeholder). */
  hasExecutor: boolean
  /** Cloud-only block (hidden from local generation). */
  cloud: boolean
  /** Whether the engine interprets the node itself. */
  engineInterpreted: boolean
  /** Whether the operator may be used by Workflow AI generation. */
  allowGeneration: boolean
  /** Semantic phrases (en + zh) discovery matches on, lowercase. */
  semanticPhrases: string[]
  /**
   * Build the default node goal contract for this operator, instantiated with
   * the current call arguments. Returns undefined when the operator cannot
   * carry a goal contract.
   */
  buildGoalContract?: (args: Record<string, unknown>) => WorkflowNodeGoalContract | undefined
}

/** Overrides for facts the palette/catalog cannot express, keyed by block id. */
interface OperatorOverride {
  aiExposure?: AiExposure
  sideEffect?: SideEffectLevel
  hasExecutor?: boolean
  allowGeneration?: boolean
  semanticPhrases?: string[]
  buildGoalContract?: OperatorRegistryEntry['buildGoalContract']
}

const OVERRIDES: Record<string, OperatorOverride> = {
  'javascript-code': {
    aiExposure: 'fallback',
    sideEffect: 'page',
    allowGeneration: true,
    semanticPhrases: ['javascript', 'js', 'raw code', '脚本'],
  },
  'ai-agent': {
    aiExposure: 'on-demand',
    sideEffect: 'none',
    allowGeneration: true,
    semanticPhrases: [
      'ai', 'generate text', 'draft', 'summarize', 'semantic generation',
      'ai 生成', '生成文案', '撰写', '总结', '个性化',
    ],
  },
  'save-assets': {
    aiExposure: 'on-demand',
    sideEffect: 'external',
    hasExecutor: false,
    allowGeneration: true,
    semanticPhrases: ['save assets', 'download assets', '下载资源', '保存素材'],
  },
  'new-tab': {
    aiExposure: 'core',
    semanticPhrases: ['open website', 'open url', 'navigate to', 'go to', 'open the website', 'open', '打开网站', '打开网址', '打开指定网站', '导航到', '访问'],
  },
  'read-page': { aiExposure: 'core' },
  'event-click': {
    aiExposure: 'core',
    semanticPhrases: ['click', 'press button', 'tap', '点击', '按'],
  },
  forms: {
    aiExposure: 'core',
    semanticPhrases: ['fill', 'type', 'enter text', 'input', '填写', '输入'],
  },
  'get-text': { aiExposure: 'core' },
  'element-exists': {
    aiExposure: 'core',
    semanticPhrases: ['element exists', 'wait', 'wait for', 'await', 'until', 'exists', '等待', '等候', '直到', '存在'],
  },
  'save-local': { aiExposure: 'hidden' },
  note: { aiExposure: 'hidden' },
  'blocks-group': { aiExposure: 'hidden' },
  'workflow-state': { aiExposure: 'hidden' },
  'switch-tab': {
    semanticPhrases: ['switch tab', 'switch to tab', 'change tab', 'next tab', 'browser tab', '切换标签', '切换标签页', '切换', '标签页'],
  },
  'insert-data': {
    semanticPhrases: ['save data', 'insert data', 'store data', 'update data', 'save', 'insert', '保存数据', '插入数据', '存储数据'],
  },
  'upload-file': {
    semanticPhrases: [
      'upload',
      'upload file',
      'upload image',
      'upload resume',
      'upload attachment',
      'upload the screenshot',
      'upload the generated image',
      'file input',
      'attach file',
      '上传',
      '上传文件',
      '上传图片',
      '上传简历',
      '上传截图',
      '上传生成的图片',
      '上传附件',
    ],
    // Structured node contract (spec §12): node success means the files are
    // in the page upload control — NOT that the site finished processing.
    buildGoalContract: (args) => {
      const selector =
        typeof args['selector'] === 'string' ? args['selector'].trim() : ''
      if (!selector) return undefined
      const mode = args['sourceMode'] === 'workflow-file' ? 'workflow-file' : 'user-select'
      const fileVariable =
        typeof args['fileVariable'] === 'string' ? args['fileVariable'].trim() : ''
      const target = { stableAttributes: { 'data-css': selector } }
      const successCriteria = [
        { kind: 'elementExists' as const, target },
        ...(mode === 'workflow-file' && fileVariable
          ? [{ kind: 'variableExists' as const, name: fileVariable }]
          : []),
      ]
      return {
        version: 1 as const,
        goal:
          mode === 'workflow-file'
            ? `Put file(s) from variable "${fileVariable || '?'}" into the upload control (${selector})`
            : `Put the user-selected file(s) into the upload control (${selector})`,
        successCriteria,
        failureMeaning: [
          'The target element is missing or is not a file input / drop zone.',
          'The file variable is missing or holds invalid file data.',
          'The control does not accept the number of files provided.',
        ],
        evidence: [
          { kind: 'element', ref: selector, note: 'upload target' },
          ...(mode === 'workflow-file' && fileVariable
            ? [{ kind: 'variable' as const, ref: fileVariable, note: 'file source' }]
            : []),
        ],
        repairHints: [
          { target: 'locator', action: 'Re-locate the real input[type=file], including hidden inputs.' },
          { target: 'locator', action: 'Check for a custom drop zone and target it.' },
          { target: 'parameter', action: 'Fix the multiple flag to match the control.' },
          { target: 'parameter', action: 'Fix the file variable / file data.' },
        ],
      }
    },
  },
}

function deriveEntry(id: string): OperatorRegistryEntry {
  const block = PALETTE_BLOCKS.find((entry) => entry.id === id)
  if (!block) throw new Error(`operator registry: unknown block id ${id}`)
  const capability = capabilityOf(id)
  const override = OVERRIDES[id]
  const actions = capability?.actions ?? []

  const engineInterpreted = ENGINE_INTERPRETED_BLOCK_IDS.has(id)
  const placeholder = PLACEHOLDER_BLOCK_IDS.has(id)
  const isExternalSideEffect = SIDE_EFFECT_BLOCK_IDS.has(id)

  const aiExposure: AiExposure =
    override?.aiExposure ?? (id === JAVASCRIPT_BLOCK_ID ? 'fallback' : 'on-demand')
  const sideEffect: SideEffectLevel =
    override?.sideEffect ?? (isExternalSideEffect ? 'external' : capability?.hasSideEffect ? 'page' : 'none')
  const hasExecutor: boolean =
    override?.hasExecutor ?? (!placeholder && !engineInterpreted && block.id !== 'trigger')
  const allowGeneration: boolean =
    override?.allowGeneration ?? (!placeholder && aiExposure !== 'hidden')

  return {
    id,
    name: block.name,
    description: block.description,
    aiExposure,
    sideEffect,
    capabilities: actions,
    hasExecutor,
    cloud: block.cloud === true,
    engineInterpreted,
    allowGeneration,
    semanticPhrases: override?.semanticPhrases ?? defaultPhrases(block.name, block.description),
    ...(override?.buildGoalContract ? { buildGoalContract: override.buildGoalContract } : {}),
  }
}

function defaultPhrases(name: string, description: string): string[] {
  return [name.toLowerCase()]
    .concat(description ? [description.toLowerCase().slice(0, 80)] : [])
    .filter(Boolean)
}

/** Build the full registry once. */
function buildRegistry(): Map<string, OperatorRegistryEntry> {
  const map = new Map<string, OperatorRegistryEntry>()
  for (const block of PALETTE_BLOCKS) {
    map.set(block.id, deriveEntry(block.id))
  }
  return map
}

const REGISTRY = buildRegistry()

/** All operator entries. */
export function allOperators(): OperatorRegistryEntry[] {
  return [...REGISTRY.values()]
}

/** Look up one operator by id. */
export function operatorEntry(id: string): OperatorRegistryEntry | undefined {
  return REGISTRY.get(id)
}

/** Operators allowed in AI generation, optionally filtered by exposure. */
export function generationOperators(exposure?: AiExposure): OperatorRegistryEntry[] {
  return allOperators().filter(
    (entry) => entry.allowGeneration && (!exposure || entry.aiExposure === exposure),
  )
}

/**
 * Audit the registry against the palette: every executable palette block must
 * be present. Returns block ids missing from the registry (empty ⇒ complete).
 */
export function auditRegistry(): { missing: string[]; unexecutable: string[] } {
  const missing: string[] = []
  const unexecutable: string[] = []
  for (const block of PALETTE_BLOCKS) {
    const entry = REGISTRY.get(block.id)
    if (!entry) {
      missing.push(block.id)
      continue
    }
    if (!entry.hasExecutor) unexecutable.push(block.id)
  }
  return { missing, unexecutable }
}
