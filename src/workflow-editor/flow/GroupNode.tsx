/**
 * Canvas renderer for the `blocks-group` container — the React port of Automa's
 * `BlockGroup.vue`.
 *
 * A group holds its children in `data.blocks` rather than on the canvas, so the
 * node itself is the editor for that list: the name, the order, and the pencil
 * that opens one child's block form live here. The engine runs those children in
 * this exact order (see `background/workflow-engine/engine.ts`), which is why
 * moving a row is a semantic edit, not a layout one.
 *
 * @module workflow-editor/flow/GroupNode
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ArrowDown, ArrowUp, Pencil, Trash2, TriangleAlert, Ungroup } from 'lucide-react'
import { BlockIcon } from '../../lib/workflow/blocks/icons'
import { CATALOG_BY_ID } from '../../lib/workflow/blocks/palette'
import { GROUP_INPUT_HANDLE, GROUP_OUTPUT_HANDLE, groupChildrenOf } from '../../lib/workflow/group'
import { useEditorLocale } from '../locale-context'
import { NodeToolbar, type BlockNodeData } from './BlockNode'

/** What the editor must supply for the in-node child list to be operable. */
export interface GroupNodeActions extends Record<string, unknown> {
  onGroupName: (nodeId: string, name: string) => void
  onChildMove: (nodeId: string, index: number, delta: number) => void
  onChildEdit: (nodeId: string, index: number) => void
  onChildDelete: (nodeId: string, index: number) => void
  /** Spread the children back onto the canvas. */
  onUnpack: (nodeId: string) => void
}

type GroupFlowData = BlockNodeData & { groupActions?: GroupNodeActions }

function GroupNodeComponent({ id, data, selected }: NodeProps) {
  const { blockName, t } = useEditorLocale()
  const node = data as unknown as GroupFlowData
  const block = node.block
  if (!block) return null
  const bd = node.blockData ?? {}
  const actions = node.groupActions
  const children = groupChildrenOf({ id, label: block.id, position: { x: 0, y: 0 }, data: bd })
  const disabled = bd.disableBlock === true
  const name = typeof bd.name === 'string' ? bd.name : ''
  // A click on a row button must not become a canvas/node interaction too.
  const guard = (event: React.MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }

  return (
    <div
      className={`wf-node w-80 ${selected ? 'wf-node-selected' : ''} ${
        disabled ? 'wf-node-disabled' : ''
      } ${node.running ? 'wf-node-running' : ''} ${node.runState ? `wf-node-${node.runState}` : ''}`}
    >
      {/* The way back out lives in the same hover menu every other node has, so
          a group is not a special case to find. */}
      <NodeToolbar
        id={id}
        disabled={disabled}
        breakpoint={bd['$breakpoint'] === true}
        actions={node.actions}
        extra={
          actions && (
            <button
              type="button"
              title={t('groupUnpack')}
              onClick={(event) => {
                guard(event)
                actions.onUnpack(id)
              }}
            >
              <Ungroup size={14} />
            </button>
          )
        }
      />

      <Handle
        id={GROUP_INPUT_HANDLE}
        type="target"
        position={Position.Left}
        className="wf-handle"
      />

      <div className="flex items-center gap-2">
        <span
          className={`wf-node-chip ${disabled ? 'wf-node-chip-disabled' : ''}`}
          style={
            disabled ? undefined : { ['--cat-color' as string]: `var(--cat-${block.category})` }
          }
        >
          <BlockIcon icon={block.icon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          {node.runState === 'error' && (
            <span className="wf-node-alert" title={node.blockedReason}>
              <TriangleAlert size={13} />
            </span>
          )}
          <input
            className="nodrag w-full rounded-md border border-border bg-panel px-1.5 py-1 text-xs font-medium text-ink outline-none focus:border-accent"
            value={name}
            placeholder={t('groupNamePlaceholder')}
            onChange={(event) => actions?.onGroupName(id, event.target.value)}
            onPointerDown={(event) => event.stopPropagation()}
          />
        </div>
      </div>

      {/* The children, in the order the engine runs them. */}
      <ul className="nowheel nodrag mt-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {children.length === 0 && (
          <li className="rounded-md border border-dashed border-border px-2 py-3 text-center text-[11px] text-muted">
            {t('groupChildrenEmpty')}
          </li>
        )}
        {children.map((child, index) => {
          const entry = CATALOG_BY_ID.get(child.id)
          const description =
            typeof child.data['description'] === 'string' ? child.data['description'] : ''
          // A disabled child still sits in the list — the run just skips it — so
          // the row says so the same way a disabled node on the canvas does.
          const childDisabled = child.data['disableBlock'] === true
          return (
            <li
              key={`${child.itemId}-${index}`}
              className={`flex items-center gap-1.5 rounded-md border border-border bg-panel px-1.5 py-1 ${
                childDisabled ? 'opacity-60' : ''
              }`}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium text-accent">
                {index + 1}
              </span>
              {entry && <BlockIcon icon={entry.icon} size={13} />}
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-[11px] leading-tight font-medium text-ink"
                  title={blockName(child.id, entry?.name ?? child.id)}
                >
                  {blockName(child.id, entry?.name ?? child.id)}
                </p>
                {description !== '' && (
                  <p className="truncate text-[10px] leading-tight text-muted" title={description}>
                    {description}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-accent-soft hover:text-ink disabled:opacity-40"
                title={t('groupChildMoveUp')}
                disabled={index === 0 || !actions}
                onClick={(event) => {
                  guard(event)
                  actions?.onChildMove(id, index, -1)
                }}
              >
                <ArrowUp size={12} />
              </button>
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-accent-soft hover:text-ink disabled:opacity-40"
                title={t('groupChildMoveDown')}
                disabled={index === children.length - 1 || !actions}
                onClick={(event) => {
                  guard(event)
                  actions?.onChildMove(id, index, 1)
                }}
              >
                <ArrowDown size={12} />
              </button>
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-accent-soft hover:text-ink disabled:opacity-40"
                title={t('groupChildEdit')}
                disabled={!actions}
                onClick={(event) => {
                  guard(event)
                  actions?.onChildEdit(id, index)
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-accent-soft hover:text-ink disabled:opacity-40"
                title={t('groupChildDelete')}
                disabled={!actions}
                onClick={(event) => {
                  guard(event)
                  actions?.onChildDelete(id, index)
                }}
              >
                <Trash2 size={12} />
              </button>
            </li>
          )
        })}
      </ul>

      <Handle
        id={GROUP_OUTPUT_HANDLE}
        type="source"
        position={Position.Right}
        className="wf-handle"
      />
    </div>
  )
}

export const GroupNode = memo(GroupNodeComponent)
