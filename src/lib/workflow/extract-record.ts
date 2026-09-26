/**
 * High-level `extract-record` operator (spec §27).
 *
 * Lets the model express "extract structured records from repeated page
 * elements" as ONE intent while the system owns the low-level orchestration:
 * loop-elements + get-text + attribute-value + insert-data. No new block is
 * required; this module validates the record spec and compiles it into an
 * ordered plan of existing block ids.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/extract-record
 */

/** One field to extract from each repeated element. */
export interface ExtractField {
  /** Output record field name. */
  key: string
  /** Extract text content, or an element attribute. */
  type: 'text' | 'attribute'
  /** Attribute name when `type === 'attribute'`. */
  name?: string
}

/** The extract-record spec. */
export interface ExtractRecordSpec {
  /** Selector for the repeated container element (e.g. `.product-card`). */
  target: string
  /** Fields to extract per record. */
  fields: ExtractField[]
  /** Optional data column to append records to. */
  saveColumn?: string
}

/** One low-level block step in the compiled plan. */
export interface ExtractPlanStep {
  blockId: string
  purpose: string
}

/** Normalise and validate an untrusted extract-record spec. */
export function normalizeExtractRecordSpec(value: unknown): ExtractRecordSpec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw['target'] !== 'string' || !raw['target'].trim()) return undefined
  if (!Array.isArray(raw['fields']) || raw['fields'].length === 0) return undefined
  const fields: ExtractField[] = []
  for (const fieldRaw of raw['fields']) {
    if (!fieldRaw || typeof fieldRaw !== 'object') continue
    const field = fieldRaw as Record<string, unknown>
    if (typeof field['key'] !== 'string' || !field['key'].trim()) continue
    if (field['type'] !== 'text' && field['type'] !== 'attribute') continue
    if (field['type'] === 'attribute' && typeof field['name'] !== 'string') continue
    fields.push({
      key: field['key'],
      type: field['type'],
      ...(typeof field['name'] === 'string' ? { name: field['name'] } : {}),
    })
  }
  if (fields.length === 0) return undefined
  return {
    target: raw['target'],
    fields,
    ...(typeof raw['saveColumn'] === 'string' && raw['saveColumn'].trim()
      ? { saveColumn: raw['saveColumn'] }
      : {}),
  }
}

/**
 * Compile an extract-record spec into the low-level block plan.
 *
 * Structure (spec §27):
 *   loop-elements over the target container
 *     → get-text for each text field
 *     → attribute-value for each attribute field
 *     → insert-data to append the structured record
 */
export function compileExtractRecord(spec: ExtractRecordSpec): ExtractPlanStep[] {
  const plan: ExtractPlanStep[] = [
    { blockId: 'loop-elements', purpose: `Iterate each ${spec.target} element` },
  ]
  for (const field of spec.fields) {
    if (field.type === 'text') {
      plan.push({ blockId: 'get-text', purpose: `Read text into ${field.key}` })
    } else {
      plan.push({
        blockId: 'attribute-value',
        purpose: `Read attribute ${field.name ?? ''} into ${field.key}`,
      })
    }
  }
  plan.push({
    blockId: 'insert-data',
    purpose: spec.saveColumn
      ? `Append the record to ${spec.saveColumn}`
      : 'Append the structured record to the data table',
  })
  return plan
}
