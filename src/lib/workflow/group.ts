/**
 * The `blocks-group` container: a node that holds its children in `data.blocks`
 * instead of on the canvas.
 *
 * The child shape is the interoperable Automa one — `{ id, itemId, data }`, an
 * ordered list — so an imported group's children run and an exported one can be
 * read back. Children are NOT graph nodes: they appear in no edge, no checkpoint
 * and no repair target, which is why this module, not the graph, owns their
 * serialization in both directions.
 *
 * @module lib/workflow/group
 */
import { CATALOG_BY_ID } from './blocks/palette'
import { GROUP_CHILD_EXCLUDED_BLOCK_IDS } from './operator-class'
import type { WorkflowEdge, WorkflowNode } from './types'

export const GROUP_BLOCK_ID = 'blocks-group'

/** One child of a group: `id` is the block type, `itemId` its stable identity. */
export interface WorkflowGroupChild {
  id: string
  itemId: string
  data: Record<string, unknown>
}

/** A child that cannot run: unknown block type, or one a linear chain cannot hold. */
export interface GroupChildProblem {
  itemId: string
  blockId: string
  reason: 'unknown_block' | 'cannot_be_in_group'
}

export function blockIdOf(node: WorkflowNode): string {
  return typeof node.data?.blockId === 'string' ? node.data.blockId : node.label
}

export function isGroupNode(node: WorkflowNode): boolean {
  return blockIdOf(node) === GROUP_BLOCK_ID
}

/** Read a node's children, ignoring entries the file cannot describe. */
export function groupChildrenOf(node: WorkflowNode | undefined): WorkflowGroupChild[] {
  const raw = node?.data?.blocks
  if (!Array.isArray(raw)) return []
  const children: WorkflowGroupChild[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { id, itemId } = entry as Record<string, unknown>
    if (typeof id !== 'string' || typeof itemId !== 'string') continue
    const record = (entry as { data?: unknown }).data
    children.push({
      id,
      itemId,
      data: record && typeof record === 'object' ? (record as Record<string, unknown>) : {},
    })
  }
  return children
}

/** Which children the engine must refuse to run, in order. */
export function groupChildProblems(children: WorkflowGroupChild[]): GroupChildProblem[] {
  const problems: GroupChildProblem[] = []
  for (const child of children) {
    if (!CATALOG_BY_ID.has(child.id)) {
      problems.push({ itemId: child.itemId, blockId: child.id, reason: 'unknown_block' })
    } else if (GROUP_CHILD_EXCLUDED_BLOCK_IDS.has(child.id)) {
      problems.push({ itemId: child.itemId, blockId: child.id, reason: 'cannot_be_in_group' })
    }
  }
  return problems
}

/** One wording for a refused child: the run gate and the run itself must agree. */
export function groupChildProblemText(problem: GroupChildProblem): string {
  return problem.reason === 'unknown_block'
    ? `分组里的步骤「${problem.itemId}」指向未知算子「${problem.blockId}」`
    : `算子「${problem.blockId}」不能放进分组：组是一条线性子链，分支和循环只能在画布上接`
}

/**
 * The id a child runs under. It is derived from the group and the child's
 * position, never stored in the file: children are not addressable nodes, and
 * the run gate blames this id when it refuses a child.
 */
export function groupChildKey(group: WorkflowNode, index: number): string {
  return `${group.id}#${index + 1}`
}

/**
 * Each child as the transient node the engine runs and the run gate inspects.
 * The block's own name is the label: nothing outside these two callers sees it.
 */
export function groupChildNodes(group: WorkflowNode): WorkflowNode[] {
  return groupChildrenOf(group).map((child, index) => {
    const key = groupChildKey(group, index)
    return {
      id: key,
      label: child.id,
      position: group.position,
      data: { ...child.data, blockId: child.id },
    }
  })
}

/** Why a selection cannot be folded into one group. */
export type GroupPackFailure =
  | { reason: 'too_few'; count: number }
  | { reason: 'not_a_chain' }
  | { reason: 'stray_connection' }
  | { reason: 'forbidden_child'; blockId: string }

export interface GroupPackPlan {
  /** The new group node, ready to insert. */
  group: WorkflowNode
  /** Canvas nodes to remove. */
  removedIds: string[]
  /** Edges to keep, already re-anchored onto the group. */
  keptEdges: WorkflowEdge[]
  /** Edges that connected the selection internally and now live in `blocks`. */
  droppedEdgeIds: string[]
}

/** Either a ready-to-apply plan, or why this selection cannot become a group. */
export type GroupPackResult = { plan: GroupPackPlan } | { failure: GroupPackFailure }

/** Handle ids of a group node's single input/output port. */
export const GROUP_INPUT_HANDLE = `${GROUP_BLOCK_ID}-input-1`
export const GROUP_OUTPUT_HANDLE = `${GROUP_BLOCK_ID}-output-1`

/**
 * Fold a selected LINEAR CHAIN of nodes into one group node.
 *
 * Linear is the only shape a group can hold: children run in sequence and the
 * last one exits through the group's outgoing edge. So the selection must form a
 * single path, and only its head may be entered from outside and only its tail
 * may leave — an edge from the middle would silently move to after the group.
 */
export function planGroupPack(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  selectedIds: readonly string[],
  groupId: string,
  groupName: string,
): GroupPackResult {
  const selected = new Set(selectedIds)
  const byId = new Map(nodes.filter((node) => selected.has(node.id)).map((node) => [node.id, node]))
  if (byId.size < 2) return { failure: { reason: 'too_few', count: byId.size } }

  for (const node of byId.values()) {
    const blockId = blockIdOf(node)
    if (!CATALOG_BY_ID.has(blockId) || GROUP_CHILD_EXCLUDED_BLOCK_IDS.has(blockId)) {
      return { failure: { reason: 'forbidden_child', blockId } }
    }
  }

  const internalOut = new Map<string, string>()
  const internalIn = new Map<string, string>()
  const externalIn: WorkflowEdge[] = []
  const externalOut: WorkflowEdge[] = []
  const droppedEdgeIds: string[] = []

  for (const edge of edges) {
    const fromSelected = selected.has(edge.source)
    const toSelected = selected.has(edge.target)
    if (fromSelected && toSelected) {
      if (internalOut.has(edge.source) || internalIn.has(edge.target)) {
        return { failure: { reason: 'not_a_chain' } }
      }
      internalOut.set(edge.source, edge.target)
      internalIn.set(edge.target, edge.source)
      droppedEdgeIds.push(edge.id)
      continue
    }
    if (toSelected) externalIn.push(edge)
    else if (fromSelected) externalOut.push(edge)
  }

  if (internalOut.size !== byId.size - 1) return { failure: { reason: 'not_a_chain' } }
  const head = [...byId.keys()].find((id) => !internalIn.has(id))
  if (!head) return { failure: { reason: 'not_a_chain' } }

  const order: string[] = []
  let cursor: string | undefined = head
  while (cursor) {
    order.push(cursor)
    cursor = internalOut.get(cursor)
  }
  if (order.length !== byId.size) return { failure: { reason: 'not_a_chain' } }
  const tail = order[order.length - 1]

  if (externalIn.some((edge) => edge.target !== head)) {
    return { failure: { reason: 'stray_connection' } }
  }
  if (externalOut.some((edge) => edge.source !== tail)) {
    return { failure: { reason: 'stray_connection' } }
  }

  const children = order.map((id) => childOfNode(byId.get(id)!))
  const positions = order.map((id) => byId.get(id)!.position)
  const group: WorkflowNode = {
    id: groupId,
    label: CATALOG_BY_ID.get(GROUP_BLOCK_ID)?.name ?? GROUP_BLOCK_ID,
    position: {
      x: Math.min(...positions.map((p) => p.x)),
      y: Math.min(...positions.map((p) => p.y)),
    },
    data: {
      disableBlock: false,
      name: groupName,
      blocks: children,
      blockId: GROUP_BLOCK_ID,
    },
  }

  const keptEdges: WorkflowEdge[] = [
    ...externalIn.map((edge) => ({ ...edge, target: groupId, targetHandle: GROUP_INPUT_HANDLE })),
    ...externalOut.map((edge) => ({ ...edge, source: groupId, sourceHandle: GROUP_OUTPUT_HANDLE })),
  ]

  return { plan: { group, removedIds: order, keptEdges, droppedEdgeIds } }
}

/** Turn a group back into canvas nodes plus the edges that threaded it. */
export function unpackGroupNode(
  group: WorkflowNode,
  edges: WorkflowEdge[],
  options: { idFactory: () => string; takenIds: ReadonlySet<string>; spacing?: number },
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const children = groupChildrenOf(group)
  const spacing = options.spacing ?? 280
  const incoming = edges.filter((edge) => edge.target === group.id)
  const outgoing = edges.filter((edge) => edge.source === group.id)

  if (children.length === 0) {
    // An empty group is a pass-through, so joining each predecessor to each
    // successor keeps what the run actually did.
    const bridged: WorkflowEdge[] = []
    for (const inEdge of incoming) {
      for (const outEdge of outgoing) {
        bridged.push({
          ...outEdge,
          id: `edge-${inEdge.source}-${outEdge.target}`,
          source: inEdge.source,
          target: outEdge.target,
        })
      }
    }
    return { nodes: [], edges: bridged }
  }

  // Reuse a child's `itemId` as the new node id while it is still free, so
  // packing and unpacking round-trip identity; imported ids can collide.
  const taken = new Set(options.takenIds)
  const nodes: WorkflowNode[] = children.map((child, index) => {
    const id = taken.has(child.itemId) ? options.idFactory() : child.itemId
    taken.add(id)
    return {
      id,
      label: CATALOG_BY_ID.get(child.id)?.name ?? child.id,
      position: { x: group.position.x + index * spacing, y: group.position.y },
      data: { ...structuredClone(child.data), blockId: child.id },
    }
  })

  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  const restored: WorkflowEdge[] = []
  for (const edge of incoming) {
    restored.push({ ...edge, target: first.id, targetHandle: `${blockIdOf(first)}-input-1` })
  }
  for (let index = 0; index + 1 < nodes.length; index++) {
    const from = nodes[index]!
    const to = nodes[index + 1]!
    restored.push({
      id: `edge-${from.id}-${to.id}`,
      source: from.id,
      target: to.id,
      sourceHandle: `${blockIdOf(from)}-output-1`,
      targetHandle: `${blockIdOf(to)}-input-1`,
    })
  }
  for (const edge of outgoing) {
    restored.push({ ...edge, source: last.id, sourceHandle: `${blockIdOf(last)}-output-1` })
  }
  return { nodes, edges: restored }
}

function childOfNode(node: WorkflowNode): WorkflowGroupChild {
  const { blockId: _blockId, ...childData } = node.data
  return { id: blockIdOf(node), itemId: node.id, data: structuredClone(childData) }
}

/** A new child from a palette block, at the same default data the canvas gives it. */
export function groupChildFromBlock(
  block: { id: string; data: Record<string, unknown> },
  itemId: string,
): WorkflowGroupChild {
  return { id: block.id, itemId, data: structuredClone(block.data) }
}

/**
 * Move a child by `delta` positions. Order IS execution order inside a group, so
 * this returns a fresh list and leaves the input untouched.
 */
export function moveGroupChild(
  children: WorkflowGroupChild[],
  index: number,
  delta: number,
): WorkflowGroupChild[] {
  const target = index + delta
  if (index < 0 || index >= children.length) return children
  if (target < 0 || target >= children.length) return children
  const next = children.slice()
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved!)
  return next
}

export function removeGroupChild(
  children: WorkflowGroupChild[],
  index: number,
): WorkflowGroupChild[] {
  if (index < 0 || index >= children.length) return children
  return children.filter((_child, position) => position !== index)
}
