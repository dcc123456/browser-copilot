/**
 * Workflow data migration.
 *
 * Two conversions live here:
 * 1. `migrateWorkflow` — Browser Copilot's legacy workflow format (blocks
 *    keyed by the old MVP ids like `click`/`fill` with `data.values`) into the
 *    interoperable model (the interoperable block ids like `event-click`/`forms`
 *    with the interoperable flat `data` fields such as `selector`/`findBy`).
 * 2. `fromAutomaExport` — an external import adapter: it reads an
 *    Automa-exported workflow JSON (classic drawflow `drawflow.Home.data` node
 *    map) viewed purely as an external interoperability data format, treating
 *    the record shape as an import schema rather than aligning with this
 *    project's own internals, and produces this project's `{nodes, edges}`
 *    graph.
 *
 * The execution engine also reads the legacy field names during a transition
 * period, so old workflows keep running even before re-save; migration here is
 * lazy (applied on load) and non-destructive.
 *
 * @module lib/workflow/migrate
 */

import { BLOCK_CATALOG } from './blocks/catalog'
import { CUSTOM_BLOCKS } from './blocks/custom'
import { CATALOG_BY_ID } from './blocks/palette'
import { normalOutputHandleOf } from './block-ports'
import { loopBreakpointPosition } from './loop-collapse'
import { isTriggerNode, normalizeTriggers, primaryTrigger } from './triggers'
import type { Workflow, WorkflowEdge, WorkflowNode, WorkflowTrigger } from './types'

export { isTriggerNode }

/**
 * Runtime interoperability alias map: legacy Browser Copilot block ids (the MVP
 * registry) -> the runtime block ids used by the engine and editor. This is an
 * alias remap at the runtime boundary, not a claim that the legacy ids are
 * "Automa original ids". Blocks whose runtime id already matches (delay,
 * webhook, cookie, ...) need no entry. Values not listed here keep their id.
 */
export const LEGACY_ID_TO_AUTOMA: Record<string, string> = {
  click: 'event-click',
  fill: 'forms',
  'select-option': 'forms',
  'set-checkbox': 'forms',
  'set-radio': 'forms',
  scroll: 'element-scroll',
  hover: 'hover-element',
  condition: 'conditions',
  breakpoint: 'loop-breakpoint',
  // Chat-saved workflow ids that never had catalog blocks (the editor could
  // not render nodes carrying them; the engine ran them natively):
  manual: 'trigger',
  'open-url': 'new-tab',
  'wait-for': 'delay',
}

/** Catalog defaults by id, looked up once (Automa blocks + local extensions). */
const CATALOG_DEFAULTS = new Map<string, Record<string, unknown>>(
  [...BLOCK_CATALOG, ...CUSTOM_BLOCKS].map((b) => [b.id, b.data]),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Migrate a single node's payload to the runtime interoperable shape:
 * - maps the block id via {@link LEGACY_ID_TO_AUTOMA}
 * - flattens the legacy `{ values: { cssSelector, ... } }` into the
 *   interoperable flat fields (`selector`, `findBy: 'cssSelector'`)
 * - fills catalog defaults so downstream forms/engine always see known keys
 */
export function migrateNodeData(
  blockId: string,
  rawData: unknown,
): { blockId: string; data: Record<string, unknown> } {
  const nextId = LEGACY_ID_TO_AUTOMA[blockId] ?? blockId
  const defaults = CATALOG_DEFAULTS.get(nextId) ?? {}
  const data: Record<string, unknown> = structuredClone(defaults)

  const source = isRecord(rawData) ? rawData : {}

  // New-style nodes store blockId/values too; the flat interoperable fields
  // may be present directly on data already.
  const values = isRecord(source.values) ? source.values : {}

  // Apply sources from weakest to strongest so stored data is never clobbered
  // by the catalog's empty-string placeholders (url: '', selector: '', ...):
  // defaults < legacy values < flat interoperable fields.
  for (const [key, value] of Object.entries(values)) {
    if (key === 'cssSelector') continue
    data[key] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (key === 'values' || key === 'blockId' || key === 'selector') continue
    data[key] = value
  }

  // Legacy cssSelector -> interoperable selector field (flat selector wins when present).
  const legacySelector =
    (source.selector as string | undefined) ??
    (values.cssSelector as string | undefined) ??
    (values.selector as string | undefined)
  if (legacySelector !== undefined) {
    data.selector = legacySelector
    if (data.findBy === undefined) data.findBy = 'cssSelector'
  }

  // Legacy `wait-for` carried a selector + timeout; its catalog replacement
  // (`delay`) reads `delay` (ms). Translate when the saved node used timeout.
  if (nextId === 'delay' && data.delay === undefined && typeof data.timeout === 'number') {
    data.delay = data.timeout
    delete data.timeout
  }

  // Ensure description exists (node subtitle field).
  if (typeof data.description !== 'string') data.description = ''

  return { blockId: nextId, data }
}

/**
 * Apply migration to a whole workflow. Returns a new object; the input is not
 * mutated. Unknown nodes (including cloud blocks) are preserved by id so the
 * editor can flag them and the engine can report "unsupported".
 */
/**
 * Rewrite an edge handle to reference the rendered `<Handle id>` for a given
 * block id. The editor keys handles by BLOCK id (`<blockId>-output-1`), so
 * handles stored as bare (`output-1`, from external imports) or node-id-prefixed
 * (`<nodeId>-output-1`, early recorder output) are normalized here.
 */
function normalizeHandle(
  handle: string | undefined,
  blockId: string,
  kind: 'source' | 'target',
): string {
  const fallback = `${blockId}-${kind === 'source' ? 'output-1' : 'input-1'}`
  if (!handle) return fallback
  // Bare suffix (from external imports): "output-1", "true", "input-1", ...
  if (
    !handle.includes('-output-') &&
    !handle.includes('-input-') &&
    !handle.includes('-fallback')
  ) {
    // Branch/condition handles may be a bare semantic key ("true"/"false").
    if (
      kind === 'source' &&
      (handle === 'true' || handle === 'false' || handle === 'loop' || handle === 'end')
    ) {
      return `${blockId}-${handle}`
    }
    // A bare "fallback" is the fallback SOURCE handle (the engine's output key);
    // the editor renders it as `<blockId>-output-fallback`.
    if (kind === 'source' && handle === 'fallback') return `${blockId}-output-fallback`
    return handle.startsWith('output') || handle.startsWith('input')
      ? `${blockId}-${handle}`
      : fallback
  }
  // Extract the trailing handle suffix regardless of the (possibly node-id)
  // prefix. `-output-fallback` must be matched before bare `-fallback`
  // (leftmost alternative wins): the editor renders the fallback handle as
  // `<blockId>-output-fallback`, and rewriting it to `<blockId>-fallback`
  // detached every saved fallback edge on reopen (the line silently vanished).
  // `output-<token>` accepts letters too so conditions-block path handles
  // (`output-<pathId>`, e.g. `output-p1`) survive normalization instead of being
  // clobbered to `output-1`.
  const match =
    /-(output-fallback|input-fallback|output-[A-Za-z0-9_]+|input-[A-Za-z0-9_]+|fallback|true|false|loop|end)$/.exec(
      handle,
    )
  const raw = match ? match[1] : kind === 'source' ? 'output-1' : 'input-1'
  // The fallback handle only exists as a SOURCE (`-output-fallback`). Bare
  // `-fallback` tails come from older mangled saves — repair them so already
  // stored workflows heal on the next load/save.
  if (raw === 'fallback' || raw === 'output-fallback' || raw === 'input-fallback') {
    return kind === 'source' ? `${blockId}-output-fallback` : fallback
  }
  return `${blockId}-${raw}`
}

/**
 * Blocks whose after-loop path lives on a `loop-breakpoint`, not on a second
 * output (Automa: both declare `outputs: 1`).
 */
const SINGLE_OUTPUT_LOOP_BLOCKS: ReadonlySet<string> = new Set(['loop-data', 'loop-elements'])

const blockIdOfNode = (node: WorkflowNode | undefined): string =>
  typeof node?.data?.['blockId'] === 'string' ? (node.data['blockId'] as string) : ''

/**
 * Move a legacy Loop Data / Loop Elements `output-2` edge onto a
 * `loop-breakpoint` at the end of the body.
 *
 * The loop handle no longer renders, so React Flow would silently drop the
 * edge. Rewiring instead preserves the after-loop path: every body tail feeds
 * one breakpoint, the breakpoint's own output carries the old after-loop
 * target, and the old folded back-edge into the loop is removed. Idempotent —
 * after the rewrite the loop has no `output-2` edge left to act on.
 */
function normalizeLoopExits(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; changed: boolean } {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const nextNodes = [...nodes]
  let nextEdges = [...edges]
  let changed = false
  const usedNodeIds = new Set(nodes.map((node) => node.id))
  const usedEdgeIds = new Set(edges.map((edge) => edge.id))
  const freshEdgeId = (base: string): string => {
    let id = base
    let suffix = 2
    while (usedEdgeIds.has(id)) id = `${base}-${suffix++}`
    usedEdgeIds.add(id)
    return id
  }

  for (const loop of nodes) {
    const loopBlock = blockIdOfNode(loop)
    if (!SINGLE_OUTPUT_LOOP_BLOCKS.has(loopBlock)) continue
    const isExitEdge = (edge: WorkflowEdge): boolean =>
      edge.source === loop.id &&
      (edge.sourceHandle === `${loopBlock}-output-2` || edge.sourceHandle === `${loopBlock}-end`)
    const exitEdges = nextEdges.filter(isExitEdge)
    if (exitEdges.length === 0) continue
    changed = true

    // Normal control-flow edges of this loop's body, excluding the old exit and
    // error fallbacks; an edge back into the loop closes a folded cycle.
    const outgoing = new Map<string, WorkflowEdge[]>()
    for (const edge of nextEdges) {
      if (isExitEdge(edge) || edge.target === loop.id) continue
      if ((edge.sourceHandle ?? '').endsWith('-output-fallback')) continue
      const list = outgoing.get(edge.source) ?? []
      list.push(edge)
      outgoing.set(edge.source, list)
    }
    const bodyEdges = nextEdges.filter(
      (edge) =>
        edge.source === loop.id &&
        !isExitEdge(edge) &&
        !(edge.sourceHandle ?? '').endsWith('-output-fallback'),
    )
    const reachable = new Set<string>()
    const queue = bodyEdges.map((edge) => edge.target)
    while (queue.length > 0) {
      const id = queue.shift() as string
      if (id === loop.id || reachable.has(id)) continue
      reachable.add(id)
      // A breakpoint ends the body; its own out-edge is the after-loop path, so
      // walking through it would misread the rest of the workflow as body flow.
      const node = nodeById.get(id)
      if (node && blockIdOfNode(node) === 'loop-breakpoint') continue
      for (const edge of outgoing.get(id) ?? []) queue.push(edge.target)
    }
    const tails = [...reachable].filter((id) => {
      const node = nodeById.get(id)
      return (
        (node && blockIdOfNode(node) === 'loop-breakpoint') || (outgoing.get(id) ?? []).length === 0
      )
    })

    // The old cycle is replaced by loop → … → breakpoint → after-loop.
    nextEdges = nextEdges.filter((edge) => !(reachable.has(edge.source) && edge.target === loop.id))

    const loopRawId = loop.data?.['loopId']
    const loopId = loopRawId === undefined || loopRawId === null ? '' : String(loopRawId).trim()
    const fits = (node: WorkflowNode): boolean => {
      const raw = node.data?.['loopId']
      const key = raw === undefined || raw === null ? '' : String(raw).trim()
      return key === '' || key === loopId || key === loop.id
    }
    let exitBlock = tails
      .map((id) => nodeById.get(id))
      .find((node) => node && blockIdOfNode(node) === 'loop-breakpoint' && fits(node))
    if (!exitBlock) {
      const anchorId = tails[tails.length - 1]
      const anchor = anchorId ? nodeById.get(anchorId) : loop
      const baseId = `${loop.id}-loop-breakpoint`
      let id = baseId
      let suffix = 2
      while (usedNodeIds.has(id)) id = `${baseId}-${suffix++}`
      usedNodeIds.add(id)
      exitBlock = {
        id,
        label: CATALOG_BY_ID.get('loop-breakpoint')?.name ?? 'Loop breakpoint',
        position: loopBreakpointPosition(nextNodes, anchor?.position ?? { x: 0, y: 0 }),
        data: {
          ...structuredClone(CATALOG_DEFAULTS.get('loop-breakpoint') ?? {}),
          blockId: 'loop-breakpoint',
          loopId,
          clearLoop: false,
          description: '',
        },
      }
      const lastBodyIndex = [...reachable, loop.id].reduce(
        (last, id) =>
          Math.max(
            last,
            nextNodes.findIndex((node) => node.id === id),
          ),
        -1,
      )
      nextNodes.splice(lastBodyIndex + 1, 0, exitBlock)
    }
    const exitId = exitBlock.id

    // No usable body path: the breakpoint itself is the body, so the loop still
    // walks its source before continuing at the breakpoint's output.
    if (tails.length === 0) {
      nextEdges.push({
        id: freshEdgeId(`${loop.id}-exit-body`),
        source: loop.id,
        target: exitId,
        sourceHandle: `${loopBlock}-output-1`,
        targetHandle: 'loop-breakpoint-input-1',
      })
    }
    for (const tailId of tails) {
      if (tailId === exitId) continue
      const tail = nodeById.get(tailId)
      if (!tail) continue
      const tailBlock = blockIdOfNode(tail)
      nextEdges.push({
        id: freshEdgeId(`${tailId}-to-${exitId}`),
        source: tailId,
        target: exitId,
        sourceHandle: normalOutputHandleOf(
          CATALOG_BY_ID.get(tailBlock) ?? { id: tailBlock, inputs: 1, outputs: 1 },
          tail.data,
        ),
        targetHandle: 'loop-breakpoint-input-1',
      })
    }

    const breakpointAlreadyContinues = nextEdges.some((edge) => edge.source === exitId)
    if (breakpointAlreadyContinues) {
      // An explicit edge out of the breakpoint wins over the old loop output.
      nextEdges = nextEdges.filter((edge) => !exitEdges.includes(edge))
    } else {
      nextEdges = nextEdges.map((edge) =>
        exitEdges.includes(edge)
          ? { ...edge, source: exitId, sourceHandle: 'loop-breakpoint-output-1' }
          : edge,
      )
    }
  }

  return { nodes: nextNodes, edges: nextEdges, changed }
}

export function migrateWorkflow(wf: Workflow): Workflow {
  if (!wf?.drawflow?.nodes) return wf
  let changed = false
  const nodeBlockById = new Map<string, string>()
  // conditions blocks that got a single auto-migrated path in this pass, so the
  // old true/false edges below can be re-pointed at that path / the fallback.
  const migratedConditionPath = new Map<string, string>()
  const nodes: WorkflowNode[] = wf.drawflow.nodes.map((node) => {
    const rawBlockId =
      (node.data?.blockId as string | undefined) ??
      (node as unknown as { blockId?: string }).blockId ??
      node.label
    const { blockId, data } = migrateNodeData(rawBlockId, node.data)
    nodeBlockById.set(node.id, blockId)

    // Legacy `conditions` blocks carried one boolean (true/false) over a flat
    // condition tree. Give them the N-path shape: one named path holding the
    // legacy tree, plus the always-present fallback. Idempotent — the test is
    // on the STORED data, because `migrateNodeData` has already merged the
    // catalog's `paths: []` default in and that would read as "already done".
    const stored = isRecord(node.data) ? node.data : {}
    if (blockId === 'conditions' && stored['paths'] === undefined) {
      data['paths'] = [
        {
          id: 'p1',
          name: 'Path 1',
          conditions: Array.isArray(stored['conditions']) ? stored['conditions'] : [],
        },
      ]
      // `paths` is authoritative from here on, so the legacy single tree goes:
      // leaving it behind would let a later read resurrect a branch the user
      // has since deleted.
      delete data['conditions']
      migratedConditionPath.set(node.id, 'p1')
      changed = true
    }

    if (blockId !== rawBlockId || !isRecord(node.data) || node.data.values !== undefined) {
      changed = true
    }
    const label =
      typeof data.description === 'string' && data.description
        ? data.description
        : (CATALOG_BY_ID.get(blockId)?.name ?? blockId)
    return { ...node, label, data: { ...data, blockId } }
  })

  // Normalize edge handles to block-id-keyed handles so connections render.
  const edges: WorkflowEdge[] = (wf.drawflow.edges ?? []).map((edge) => {
    const sourceBlock = nodeBlockById.get(edge.source)
    const targetBlock = nodeBlockById.get(edge.target)
    let sourceHandle = sourceBlock
      ? normalizeHandle(edge.sourceHandle, sourceBlock, 'source')
      : edge.sourceHandle
    const targetHandle = targetBlock
      ? normalizeHandle(edge.targetHandle, targetBlock, 'target')
      : edge.targetHandle

    // Re-point a migrated conditions block's legacy true/false edges onto the
    // single auto path and the "no path matched" port. `output-none` is its own
    // handle id: `output-fallback` already means "route here when the block
    // errors" (the onError policy) and a node must never render both.
    const migratedPath = migratedConditionPath.get(edge.source)
    if (sourceBlock === 'conditions' && migratedPath) {
      if (sourceHandle === `${sourceBlock}-output-1`) {
        sourceHandle = `${sourceBlock}-output-${migratedPath}`
      } else if (sourceHandle === `${sourceBlock}-output-2`) {
        sourceHandle = `${sourceBlock}-output-none`
      }
    }

    if (sourceHandle !== edge.sourceHandle || targetHandle !== edge.targetHandle) changed = true
    return { ...edge, sourceHandle, targetHandle }
  })

  const loopExits = normalizeLoopExits(nodes, edges)
  if (loopExits.changed) changed = true

  if (!changed) return wf
  return { ...wf, drawflow: { ...wf.drawflow, nodes: loopExits.nodes, edges: loopExits.edges } }
}

/** Trigger kinds the editor's trigger block can emit. */
const TRIGGER_NODE_KINDS: ReadonlySet<string> = new Set([
  'manual',
  'interval',
  'date',
  'specific-day',
  'visit-web',
  'keyboard-shortcut',
  'context-menu',
  'on-startup',
  'element-change',
])

/**
 * Denormalize the trigger block into the workflow's top-level `trigger`
 * field. The graph's trigger node is the Automa-style source of truth (edited
 * in `EditTrigger`), while listeners (`background/index.ts`) and the
 * workflows list chip read the top-level field — saving without syncing them
 * leaves the chip and context-menu/visit-web registration stale.
 *
 * A multi-trigger block mirrors its PRIMARY (first) trigger only; the full list
 * stays on the node and runtime readers go through `effectiveTriggers`.
 *
 * Returns `undefined` when the graph has no trigger node (callers then keep
 * the workflow's previous top-level trigger). Unknown `data.type` values fall
 * back to `'manual'`.
 */
export function triggerFromNodes(nodes: WorkflowNode[]): WorkflowTrigger | undefined {
  const node = nodes.find(isTriggerNode)
  if (!node) return undefined
  const spec = primaryTrigger(normalizeTriggers(node.data))
  const type = TRIGGER_NODE_KINDS.has(spec.type) ? (spec.type as WorkflowTrigger['type']) : 'manual'
  const trigger: WorkflowTrigger = { type, enabled: spec.enabled !== false }
  const url = spec.data['url']
  if (type === 'visit-web' && typeof url === 'string' && url) {
    trigger.urlPattern = url
  }
  const contextMenuName = spec.data['contextMenuName']
  if (type === 'context-menu' && typeof contextMenuName === 'string' && contextMenuName) {
    trigger.menuItemId = contextMenuName
  }
  // The declared inputs travel with the mirror because the RUN path seeds the
  // variable scope from it. Dropping them here would leave every `{{input}}`
  // reference a generated workflow recorded resolving to an empty string.
  const parameters = node.data?.['parameters']
  if (Array.isArray(parameters) && parameters.length > 0) {
    trigger.parameters = parameters as WorkflowTrigger['parameters']
  }
  return trigger
}

/**
 * Import-adapt an Automa-exported workflow JSON into this project's graph
 * shape. The JSON is treated as an external interoperability data format: its
 * record layout is read purely as an external import schema, and this project
 * keeps its own independently defined internal graph model.
 *
 * In the external import format nodes live under `drawflow.Home.data` — a
 * record keyed by node id with `{ id, name (blockId), data, positionX,
 * positionY, inputs, outputs }` and connections nested as
 * `outputs[handleId].connections[].{node, output}`.
 * Returns `null` when the JSON is not an Automa export.
 */
export function fromAutomaExport(json: unknown): {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
} | null {
  if (!isRecord(json)) return null
  const drawflow = isRecord(json.drawflow) ? json.drawflow : null
  const home = drawflow ? (drawflow.Home ?? drawflow.home) : null
  const homeData = isRecord(home) ? (home.data as Record<string, unknown> | undefined) : null
  // External import format: drawflow.Home.data is a node-id -> node map.
  // Native Browser Copilot format uses a drawflow.nodes *array* — reject it.
  if (!isRecord(homeData) || Array.isArray(drawflow?.nodes)) return null
  const rawNodes = homeData

  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []
  let edgeSeq = 0

  for (const [key, value] of Object.entries(rawNodes)) {
    if (!isRecord(value)) continue
    const blockId = String(value.name ?? key)
    const blockData = isRecord(value.data) ? value.data : {}
    const { data } = migrateNodeData(blockId, blockData)
    nodes.push({
      id: String(value.id ?? key),
      label: CATALOG_BY_ID.get(blockId)?.name ?? blockId,
      position: {
        x: Number(value.positionX ?? 0),
        y: Number(value.positionY ?? 0),
      },
      data: { ...data, blockId },
    })

    // Connections live on the source node's outputs map.
    const outputs = isRecord(value.outputs) ? value.outputs : {}
    for (const [sourceHandle, out] of Object.entries(outputs)) {
      if (!isRecord(out)) continue
      const conns = Array.isArray(out.connections) ? out.connections : []
      for (const conn of conns) {
        if (!isRecord(conn)) continue
        edges.push({
          id: `automa-edge-${edgeSeq++}`,
          source: String(value.id ?? key),
          target: String(conn.node ?? ''),
          sourceHandle: String(sourceHandle),
          targetHandle: String(conn.input ?? conn.targetHandle ?? 'input-1'),
        })
      }
    }
  }

  return { nodes, edges }
}
