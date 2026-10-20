/**
 * Which connection ports a block actually draws.
 *
 * A handle id IS a stored edge endpoint, so the canvas renderer, the load-time
 * edge healer and the assistant's graph patches must answer "what ports does
 * this block have" from one list. React Flow silently drops an edge whose
 * handle names nothing — nodes stay visible, the connection just is not there —
 * so a second derivation that drifts deletes wiring without a word.
 *
 * @module lib/workflow/block-ports
 */

import { conditionPathsOf } from './condition-tree'
import { FALLBACK_HANDLE_SUFFIX } from './graph-edges'

/** Handle suffix a conditions block's "no path matched" output uses. It is
 *  deliberately NOT `output-fallback`: that id already means "route here when
 *  the block errors" (the onError policy), and a node must never render two
 *  handles under one id. */
export const CONDITIONS_NONE_SUFFIX = 'output-none'

/** One drawn output port. */
export interface BlockPort {
  /** Handle id suffix, e.g. `output-1`, or `output-<pathId>` for a conditions path. */
  idSuffix: string
  label: string
}

/** Fixed branch ports (exists/not, loop/end), English labels matching Automa.
 *  The conditions block is absent on purpose — its ports are per-path, derived
 *  from its data by {@link branchHandlesFor}. */
const BRANCH_HANDLES: Record<string, BlockPort[]> = {
  'element-exists': [
    { idSuffix: 'output-1', label: 'exists' },
    { idSuffix: 'output-2', label: 'not exists' },
  ],
  'loop-data': [
    { idSuffix: 'output-1', label: 'loop' },
    { idSuffix: 'output-2', label: 'end' },
  ],
  'loop-elements': [
    { idSuffix: 'output-1', label: 'loop' },
    { idSuffix: 'output-2', label: 'end' },
  ],
  'while-loop': [
    { idSuffix: 'output-1', label: 'loop' },
    { idSuffix: 'output-2', label: 'end' },
  ],
}

/** The block fields the port derivation reads. */
export type BlockPortSource = { id: string; inputs?: number; outputs?: number }

/**
 * The branch ports a block renders, in draw order, or `null` when it has the
 * single default output. The conditions block is data-driven: one port per
 * configured path, named by the path, plus the always-present "no path matched"
 * port.
 */
export function branchHandlesFor(
  block: BlockPortSource,
  blockData: Record<string, unknown> | undefined,
): BlockPort[] | null {
  if (block.id === 'conditions') {
    const paths = conditionPathsOf(blockData?.['paths'])
    return [
      ...paths.map((path, index) => ({
        idSuffix: `output-${path.id}`,
        label: path.name || `Path ${index + 1}`,
      })),
      { idSuffix: CONDITIONS_NONE_SUFFIX, label: 'fallback' },
    ]
  }
  const branches = BRANCH_HANDLES[block.id]
  if (branches) return branches
  return block.id === 'repeat-task' && block.outputs === 2
    ? [
        { idSuffix: 'output-1', label: 'loop' },
        { idSuffix: 'output-2', label: 'end' },
      ]
    : null
}

/** Handle id of a block's error-fallback port. Drawn independently of the paths. */
export function fallbackHandleOf(blockId: string): string {
  return `${blockId}${FALLBACK_HANDLE_SUFFIX}`
}

/**
 * Whether the block actually renders its fallback port. The port only means
 * something when the on-error policy routes failures to a branch, so an edge
 * hanging on `-output-fallback` under any other policy names nothing.
 */
export function errorFallbackDrawn(blockData: Record<string, unknown> | undefined): boolean {
  const onError = blockData?.['onError'] as { enable?: boolean; toDo?: string } | undefined
  return onError?.enable === true && onError?.toDo === 'fallback'
}

/** Handle id a block is fed through, or undefined when it draws no input port. */
export function inputHandleOf(block: BlockPortSource): string | undefined {
  return (block.inputs ?? 1) > 0 ? `${block.id}-input-1` : undefined
}

/**
 * The output ports a block draws, and where a connection that cannot name a
 * port lands: the topmost drawn one, which is what the canvas shows first.
 *
 * The handle set is the id space load-time healing accepts (it therefore always
 * carries the fallback id); use {@link errorFallbackDrawn} to ask whether that
 * port is really rendered.
 */
export function outputPortsOf(
  block: BlockPortSource,
  blockData: Record<string, unknown> | undefined,
): { handles: Set<string>; primary: string } {
  const branches = branchHandlesFor(block, blockData)
  const handles = new Set<string>([fallbackHandleOf(block.id)])
  if (branches) for (const port of branches) handles.add(`${block.id}-${port.idSuffix}`)
  else handles.add(`${block.id}-output-1`)
  return {
    handles,
    primary: branches ? `${block.id}-${branches[0]!.idSuffix}` : `${block.id}-output-1`,
  }
}

/**
 * The port a node's normal continuation leaves from. A conditions block's ports
 * are named after its paths, so `output-1` may name nothing — and React Flow
 * drops an edge whose handle does not resolve, silently.
 */
export function normalOutputHandleOf(
  block: BlockPortSource,
  blockData: Record<string, unknown> | undefined,
): string {
  return outputPortsOf(block, blockData).primary
}

/**
 * Handle id → the label drawn beside the port. Used where an edge is about to be
 * cut because a block no longer has that port: the user has to be told WHICH
 * branch went, and `output-2` is not an answer anyone can read.
 */
export function outputPortLabelsOf(
  block: BlockPortSource,
  blockData: Record<string, unknown> | undefined,
): Map<string, string> {
  const branches = branchHandlesFor(block, blockData)
  const labels = new Map<string, string>()
  if (branches) for (const port of branches) labels.set(`${block.id}-${port.idSuffix}`, port.label)
  else labels.set(`${block.id}-output-1`, 'output')
  labels.set(fallbackHandleOf(block.id), 'on error')
  return labels
}
