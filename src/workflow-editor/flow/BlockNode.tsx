/**
 * Canvas node renderer — the React port of Automa's BlockBasic/BlockBase.
 *
 * Automa lays blocks out left-to-right: a target handle on the left, the node
 * body (category-colored icon chip + bold name + dim description) and a source
 * handle on the right. Branch blocks render multiple labeled source handles
 * (conditions/element-exists/loops); blocks with on-error fallback get an extra
 * low-right handle. Disabled blocks gray out; blocks with validation errors
 * show a red alert.
 *
 * @module workflow-editor/flow/BlockNode
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { BlockIcon } from '../../lib/workflow/blocks/icons'
import type { BlockCatalogEntry } from '../../lib/workflow/blocks/types'
import { useEditorLocale } from '../locale-context'

/** Callbacks the editor injects so the node's hover toolbar can act on it. */
export interface BlockNodeActions extends Record<string, unknown> {
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onSettings: (id: string) => void
  onEdit: (id: string) => void
  onToggleDisable: (id: string) => void
  onRunFromHere: (id: string) => void
}

/** Extra node-data fields the editor stores alongside the Automa block data. */
export interface BlockNodeData extends Record<string, unknown> {
  /** Resolved catalog entry for the block. */
  block: BlockCatalogEntry
  /** Node display name (falls back to the block name). */
  label?: string
  /** The block's `data` payload (selector, url, description, ...). */
  blockData: Record<string, unknown>
  /** True when a run is currently executing this node. */
  running?: boolean
  /** Outcome from the last run, for the node border tint. */
  runState?: 'done' | 'error'
  /** Hover-toolbar callbacks, injected by the editor (see App.tsx). */
  actions?: BlockNodeActions
}

/**
 * Hover action toolbar — React port of Automa's `block-menu` (BlockBase.vue).
 * Revealed on node hover; buttons carry the `nodrag` class so React Flow never
 * starts a canvas drag from a toolbar click, and every click stops propagation
 * so the node isn't selected/dragged as a side effect.
 */
function NodeToolbar({ id, disabled, actions }: { id: string; disabled: boolean; actions?: BlockNodeActions }) {
  const { t } = useEditorLocale()
  if (!actions) return null
  const stop = (fn: (id: string) => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    fn(id)
  }
  return (
    <div className="wf-node-toolbar nodrag" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" title={t('nodeDelete')} onClick={stop(actions.onDelete)}>
        <i className="ri-delete-bin-7-line" />
      </button>
      <button type="button" title={t('nodeDuplicate')} onClick={stop(actions.onDuplicate)}>
        <i className="ri-file-copy-line" />
      </button>
      <button type="button" title={t('nodeSettings')} onClick={stop(actions.onSettings)}>
        <i className="ri-settings-3-line" />
      </button>
      <button
        type="button"
        title={disabled ? t('nodeEnable') : t('nodeDisable')}
        onClick={stop(actions.onToggleDisable)}
      >
        <i className={disabled ? 'ri-toggle-line' : 'ri-toggle-fill'} />
      </button>
      <button type="button" title={t('nodeRunFromHere')} onClick={stop(actions.onRunFromHere)}>
        <i className="ri-play-line" />
      </button>
      <button type="button" title={t('nodeEdit')} onClick={stop(actions.onEdit)}>
        <i className="ri-pencil-line" />
      </button>
    </div>
  )
}

/** Branch handle labels for multi-output blocks (English, matching Automa). */
const BRANCH_HANDLES: Record<string, { idSuffix: string; label: string }[]> = {
  conditions: [
    { idSuffix: 'output-1', label: 'true' },
    { idSuffix: 'output-2', label: 'false' },
  ],
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

function BlockNodeComponent({ id, data, selected }: NodeProps) {
  const { blockName } = useEditorLocale()
  const node = data as unknown as BlockNodeData
  const block = node.block
  if (!block) return null
  const bd = node.blockData ?? {}
  const disabled = bd.disableBlock === true
  const onError = bd.onError as { enable?: boolean; toDo?: string } | undefined
  const hasFallback = onError?.enable === true && onError?.toDo === 'fallback'
  const displayName = blockName(block.id, block.name)
  const description = typeof bd.description === 'string' ? bd.description : ''
  // Selector/URL summary for blocks without a custom description.
  const summary =
    description ||
    (typeof bd.selector === 'string' && bd.selector) ||
    (typeof bd.url === 'string' && bd.url) ||
    ''
  const hasError = false // validation wired in P4 once forms land
  const branches = BRANCH_HANDLES[block.id]
  const branchHandles =
    branches ??
    (block.outputs === 2 && block.id === 'repeat-task'
      ? [
          { idSuffix: 'output-1', label: 'loop' },
          { idSuffix: 'output-2', label: 'end' },
        ]
      : null)

  return (
    <div
      className={`wf-node ${selected ? 'wf-node-selected' : ''} ${disabled ? 'wf-node-disabled' : ''} ${
        node.running ? 'wf-node-running' : ''
      } ${node.runState ? `wf-node-${node.runState}` : ''}`}
      onDoubleClick={(e) => {
        e.stopPropagation()
        node.actions?.onEdit(id)
      }}
    >
      {/* Hover action toolbar (Automa block-menu) */}
      <NodeToolbar id={id} disabled={disabled} actions={node.actions} />
      {block.inputs > 0 && (
        <Handle id={`${block.id}-input-1`} type="target" position={Position.Left} className="wf-handle" />
      )}

      <div className="wf-node-body">
        <span
          className={`wf-node-chip ${disabled ? 'wf-node-chip-disabled' : ''}`}
          style={disabled ? undefined : { ['--cat-color' as string]: `var(--cat-${block.category})` }}
        >
          <BlockIcon icon={block.icon} size={16} />
        </span>
        <div className="wf-node-text">
          {hasError && <i className="wf-node-alert ri-error-warning-line" />}
          <p className="wf-node-name">{node.label || displayName}</p>
          {summary && <p className="wf-node-desc">{summary}</p>}
          {bd.loopId ? (
            <span className="wf-node-loopid" title="Loop id (click to copy)">
              {String(bd.loopId)}
            </span>
          ) : null}
        </div>
      </div>

      {hasFallback && (
        <div className="wf-node-fallback">
          <i className="ri-information-line" />
          <span>fallback</span>
        </div>
      )}

      {/* Single (default) source handle */}
      {!branchHandles && <Handle id={`${block.id}-output-1`} type="source" position={Position.Right} className="wf-handle" />}

      {/* Branch source handles, spread vertically with labels */}
      {branchHandles?.map((h, i) => (
        <Handle
          key={h.idSuffix}
          id={`${block.id}-${h.idSuffix}`}
          type="source"
          position={Position.Right}
          className="wf-handle wf-handle-branch"
          style={{ top: `${((i + 1) / (branchHandles.length + 1)) * 100}%` }}
        >
          <span className="wf-handle-label">{String(h.label)}</span>
        </Handle>
      ))}

      {hasFallback && (
        <Handle
          id={`${block.id}-output-fallback`}
          type="source"
          position={Position.Right}
          className="wf-handle wf-handle-fallback"
          style={{ top: 'auto', bottom: 8 }}
        />
      )}
    </div>
  )
}

export const BlockNode = memo(BlockNodeComponent)

/** Note block (sticky note) — Automa BlockNote. */
function NoteNodeComponent({ id, data }: NodeProps) {
  const { t } = useEditorLocale()
  const node = data as unknown as BlockNodeData
  const text = String((node.blockData?.description as string) ?? '')
  return (
    <div className="wf-note">
      {node.actions && (
        <div className="wf-node-toolbar nodrag" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            title={t('noteDelete')}
            onClick={(e) => {
              e.stopPropagation()
              node.actions?.onDelete(id)
            }}
          >
            <i className="ri-delete-bin-7-line" />
          </button>
          <button
            type="button"
            title={t('noteEdit')}
            onClick={(e) => {
              e.stopPropagation()
              node.actions?.onEdit(id)
            }}
          >
            <i className="ri-pencil-line" />
          </button>
        </div>
      )}
      <Handle type="target" position={Position.Left} className="wf-handle" style={{ opacity: 0 }} />
      <p>{text || 'Note'}</p>
      <Handle type="source" position={Position.Right} className="wf-handle" style={{ opacity: 0 }} />
    </div>
  )
}
export const NoteNode = memo(NoteNodeComponent)

/** Node type map for React Flow. */
export const nodeTypes = {
  BlockNode,
  NoteNode,
}
