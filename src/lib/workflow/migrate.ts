/**
 * Workflow data migration.
 *
 * Two conversions live here:
 * 1. `migrateWorkflow` — Browser Copilot's legacy workflow format (blocks
 *    keyed by the old MVP ids like `click`/`fill` with `data.values`) into the
 *    Automa-aligned model (Automa block ids like `event-click`/`forms` with
 *    Automa's flat `data` fields such as `selector`/`findBy`).
 * 2. `fromAutomaExport` — an Automa-exported JSON file (classic drawflow
 *    `drawflow.Home.data` node map) into this project's `{nodes, edges}` graph.
 *
 * The execution engine also reads the legacy field names during a transition
 * period, so old workflows keep running even before re-save; migration here is
 * lazy (applied on load) and non-destructive.
 *
 * @module lib/workflow/migrate
 */

import { BLOCK_CATALOG } from './blocks/catalog'
import { CATALOG_BY_ID } from './blocks/palette'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

/**
 * Legacy Browser Copilot block ids (the MVP registry) -> Automa block ids.
 * Blocks whose id already matches Automa (delay, webhook, cookie, ...) need no
 * entry. Values not listed here keep their id.
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
}

/** Catalog defaults by id, looked up once. */
const CATALOG_DEFAULTS = new Map<string, Record<string, unknown>>(
  BLOCK_CATALOG.map((b) => [b.id, b.data]),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Migrate a single node's payload to the Automa shape:
 * - maps the block id via {@link LEGACY_ID_TO_AUTOMA}
 * - flattens the legacy `{ values: { cssSelector, ... } }` into Automa fields
 *   (`selector`, `findBy: 'cssSelector'`)
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

  // New-style nodes store blockId/values too; the flat Automa fields may be
  // present directly on data already.
  const values = isRecord(source.values) ? source.values : {}

  // Legacy cssSelector -> Automa selector (only when no explicit selector yet).
  const legacySelector =
    (source.selector as string | undefined) ??
    (values.cssSelector as string | undefined) ??
    (values.selector as string | undefined)
  if (legacySelector !== undefined) {
    data.selector = legacySelector
    if (data.findBy === undefined) data.findBy = 'cssSelector'
  }

  // Copy over all other fields: flat Automa fields win, then legacy values.
  for (const [key, value] of Object.entries(source)) {
    if (key === 'values' || key === 'blockId' || key === 'selector') continue
    data[key] = value
  }
  for (const [key, value] of Object.entries(values)) {
    if (key === 'cssSelector') continue
    if (data[key] === undefined) data[key] = value
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
 * handles stored as bare (`output-1`, Automa exports) or node-id-prefixed
 * (`<nodeId>-output-1`, early recorder output) are normalized here.
 */
function normalizeHandle(
  handle: string | undefined,
  blockId: string,
  kind: 'source' | 'target',
): string {
  const fallback = `${blockId}-${kind === 'source' ? 'output-1' : 'input-1'}`
  if (!handle) return fallback
  // Bare suffix (Automa export): "output-1", "true", "input-1", ...
  if (!handle.includes('-output-') && !handle.includes('-input-') && !handle.includes('-fallback')) {
    // Branch/condition handles may be a bare semantic key ("true"/"false").
    if (kind === 'source' && (handle === 'true' || handle === 'false' || handle === 'loop' || handle === 'end')) {
      return `${blockId}-${handle}`
    }
    return handle.startsWith('output') || handle.startsWith('input') ? `${blockId}-${handle}` : fallback
  }
  // Extract the trailing "-output-N" / "-input-N" / "-fallback" suffix regardless
  // of the (possibly node-id) prefix.
  const match = /-(output-\d+|input-\d+|fallback|true|false|loop|end)$/.exec(handle)
  const tail = match ? match[1] : (kind === 'source' ? 'output-1' : 'input-1')
  return `${blockId}-${tail}`
}

export function migrateWorkflow(wf: Workflow): Workflow {
  if (!wf?.drawflow?.nodes) return wf
  let changed = false
  const nodeBlockById = new Map<string, string>()
  const nodes: WorkflowNode[] = wf.drawflow.nodes.map((node) => {
    const rawBlockId =
      (node.data?.blockId as string | undefined) ??
      (node as unknown as { blockId?: string }).blockId ??
      node.label
    const { blockId, data } = migrateNodeData(rawBlockId, node.data)
    nodeBlockById.set(node.id, blockId)
    if (blockId !== rawBlockId || !isRecord(node.data) || node.data.values !== undefined) {
      changed = true
    }
    const label =
      typeof data.description === 'string' && data.description
        ? data.description
        : CATALOG_BY_ID.get(blockId)?.name ?? blockId
    return { ...node, label, data: { ...data, blockId } }
  })

  // Normalize edge handles to block-id-keyed handles so connections render.
  const edges: WorkflowEdge[] = (wf.drawflow.edges ?? []).map((edge) => {
    const sourceBlock = nodeBlockById.get(edge.source)
    const targetBlock = nodeBlockById.get(edge.target)
    const sourceHandle = sourceBlock ? normalizeHandle(edge.sourceHandle, sourceBlock, 'source') : edge.sourceHandle
    const targetHandle = targetBlock ? normalizeHandle(edge.targetHandle, targetBlock, 'target') : edge.targetHandle
    if (sourceHandle !== edge.sourceHandle || targetHandle !== edge.targetHandle) changed = true
    return { ...edge, sourceHandle, targetHandle }
  })

  if (!changed) return wf
  return { ...wf, drawflow: { ...wf.drawflow, nodes, edges } }
}

/**
 * Convert an Automa-exported workflow JSON to this project's graph shape.
 *
 * Automa stores nodes as `drawflow.Home.data` — a record keyed by node id with
 * `{ id, name (blockId), data, positionX, positionY, inputs, outputs }` and
 * connections nested as `outputs[handleId].connections[].{node, output}`.
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
  // Automa classic format: drawflow.Home.data is a node-id -> node map.
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
