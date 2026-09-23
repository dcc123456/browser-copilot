/**
 * Promote dangling variable references to declared workflow run inputs.
 *
 * A node referencing `{{orderId}}` with no upstream producer is not a broken
 * graph — it is a workflow that needs the USER to supply `orderId` at launch.
 * The save card renders declared inputs as fields. Generation is expected to
 * declare these, but when it does not the assembly promotes them automatically
 * (a declared input is provided by the launcher, so the data-flow layer counts
 * it as written).
 */
import { isTriggerNode } from './migrate'

/** Everything before the first dot — `{{a.b}}` reads a property of `a`. */
function referenceRoot(reference: string): string {
  return reference.split('.')[0] ?? reference
}

/** Variable references inside a node's data (best-effort, no graph dependency). */
function referencesOf(data: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const matches = value.match(/\{\{\s*([^}]+?)\s*\}\}/g) ?? []
      for (const m of matches) {
        const name = referenceRoot(m.slice(2, -2).trim())
        if (name) out.add(name)
      }
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v)
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) visit(v)
    }
  }
  visit(data)
  return out
}

interface LikeNode {
  data?: Record<string, unknown>
}

/**
 * Declare every referenced-but-unproduced variable as a run input on the
 * trigger node's `parameters`, in place. Returns the names added.
 */
export function declareMissingInputs(nodes: LikeNode[]): string[] {
  const produced = new Set<string>()
  const referenced = new Set<string>()
  for (const node of nodes) {
    const data = node.data
    if (!data) continue
    if (isTriggerNode({ data } as never)) {
      // Inputs already declared on the trigger count as produced.
      const params = data['parameters']
      if (Array.isArray(params)) {
        for (const p of params as unknown[]) {
          if (p && typeof p === 'object' && typeof (p as Record<string, unknown>)['name'] === 'string')
            produced.add((p as Record<string, unknown>)['name'] as string)
        }
      }
      continue
    }
    const writer = typeof data['variableName'] === 'string' ? data['variableName'] : ''
    if (writer) produced.add(writer as string)
    for (const ref of referencesOf(data)) referenced.add(ref)
  }

  const missing = [...referenced].filter((name) => !produced.has(name)).sort()
  if (missing.length === 0) return []

  const trigger = nodes.find((n) => isTriggerNode({ data: n.data } as never))
  if (!trigger?.data) return []
  const existing = Array.isArray(trigger.data['parameters'])
    ? [...(trigger.data['parameters'] as unknown[])]
    : []
  for (const name of missing) existing.push({ name, type: 'text' })
  trigger.data['parameters'] = existing
  return missing
}
