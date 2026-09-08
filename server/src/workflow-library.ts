/**
 * The server-side workflow library: the extension's `workflows.json` loaded,
 * validated, reference-checked and served to the engine.
 *
 * The extension persists ALL workflows under the single `workflows` key —
 * materialized as one `workflows.json` file when a data directory is
 * configured (see `lib/workflow/storage.ts` + `lib/fs-store.ts`). This module
 * reads and writes THAT format unchanged, so copying the file between the
 * extension and the server is a plain file copy in both directions.
 *
 * ## Nested workflows (`execute-workflow`)
 *
 * A workflow node may call another workflow by ID (the block's
 * `values.workflowId`, legacy `data.workflowId`). Copying a parent to the
 * server therefore requires its referenced children to be present under the
 * SAME ids — the reference is by id, never by name. This module scans the
 * graph, reports missing children and cross-workflow cycles at load/import
 * time, and the run layer re-checks before starting a run (the engine keeps
 * its own runtime self/cross-loop guard as the last line of defense).
 *
 * @module server/workflow-library
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { asWorkflow } from '../../src/lib/workflow/storage'
import { migrateWorkflow } from '../../src/lib/workflow/migrate'
import { validateWorkflow } from '../../src/lib/workflow/validation'
import type { Workflow, WorkflowNode } from '../../src/lib/workflow/types'

/** The reference one `execute-workflow` node holds. */
export interface WorkflowReference {
  /** The node holding the reference. */
  nodeId: string
  nodeLabel: string
  /** The referenced child workflow id (as stored). */
  childId: string
}

export interface WorkflowReport {
  workflow: Workflow
  /** `execute-workflow` references found in the graph (deduped by child id). */
  references: WorkflowReference[]
  /** Referenced child ids that are NOT in the library. */
  missing: string[]
  /** Cycles this workflow participates in, as id chains (including itself). */
  cycles: string[][]
}

/** What the import endpoint returns per submitted workflow record. */
export interface ImportEntryResult {
  index: number
  id: string
  name: string
  ok: boolean
  error?: string
  /** Schema-lint warnings from `validateWorkflow` (non-fatal). */
  warnings: string[]
  /** Missing child workflow ids after the import. */
  missing: string[]
}

export interface ImportResult {
  imported: number
  skipped: number
  entries: ImportEntryResult[]
}

/** Extracts the block id the engine would dispatch on for a node. */
function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  if (typeof fromData === 'string' && fromData) return fromData
  return node.label
}

/** Mirrors the engine's `paramsOf`: the editor stores params under `values`. */
function paramsOf(node: WorkflowNode): Record<string, unknown> {
  const values = node.data?.['values']
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    return values as Record<string, unknown>
  }
  return node.data ?? {}
}

/**
 * Collects the `execute-workflow` child ids a workflow references.
 * Mirrors the engine's `runSubWorkflow` param read exactly.
 */
export function referencesOfWorkflow(workflow: Workflow): WorkflowReference[] {
  const out: WorkflowReference[] = []
  const seen = new Set<string>()
  for (const node of workflow.drawflow.nodes) {
    if (blockIdOf(node) !== 'execute-workflow') continue
    const childId = String(paramsOf(node)['workflowId'] ?? '')
    if (!childId || seen.has(childId)) continue
    seen.add(childId)
    out.push({
      nodeId: node.id,
      nodeLabel: node.label,
      childId,
    })
  }
  return out
}

/** Accepts `{workflows: [...]}`, a bare array, or a single workflow object. */
function extractWorkflowList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const inner = (payload as Record<string, unknown>)['workflows']
    if (Array.isArray(inner)) return inner
    // A single workflow object carries id+name at the top level.
    if (typeof (payload as Record<string, unknown>)['id'] === 'string') return [payload]
  }
  throw new Error('Unrecognized payload: expected a workflow array, {workflows:[…]} or a single workflow object')
}

export class WorkflowLibrary {
  /** id → canonical workflow, newest-wins on duplicate ids. */
  private byId = new Map<string, Workflow>()
  /** Which file each id came from; writes go back to the primary file. */
  private sources = new Map<string, 'primary' | 'extra'>()

  constructor(
    private readonly primaryFile: string,
    /** Optional directory of extra `*.json` workflow files merged in. */
    private readonly extraDir: string = '',
  ) {}

  /** Loads (or reloads) the library from disk. Throws on malformed JSON. */
  load(): void {
    this.byId.clear()
    this.sources.clear()

    if (existsSync(this.primaryFile)) {
      const raw = JSON.parse(readFileSync(this.primaryFile, 'utf8'))
      this.ingest(extractWorkflowList(raw), 'primary')
    }

    if (this.extraDir && existsSync(this.extraDir)) {
      for (const entry of readdirSync(this.extraDir)) {
        if (!entry.endsWith('.json')) continue
        const raw = JSON.parse(readFileSync(join(this.extraDir, entry), 'utf8'))
        this.ingest(extractWorkflowList(raw), 'extra')
      }
    }
  }

  private ingest(list: unknown[], source: 'primary' | 'extra'): void {
    for (const raw of list) {
      const base = asWorkflow(raw)
      if (!base) continue
      const normalized = migrateWorkflow(base)
      this.byId.set(normalized.id, normalized)
      this.sources.set(normalized.id, source)
    }
  }

  /** All workflows, newest-updated first (mirrors the extension's ordering). */
  list(): Workflow[] {
    return [...this.byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Workflow | undefined {
    return this.byId.get(id)
  }

  /** The resolver injected into the engine for `execute-workflow` blocks. */
  readonly resolveWorkflow = async (id: string): Promise<Workflow | null> => {
    return this.byId.get(id) ?? null
  }

  /**
   * Upserts one workflow (canonicalized like the extension's `saveWorkflow`)
   * and persists the primary file atomically (tmp + rename).
   */
  upsert(workflow: Workflow): Workflow {
    const base = asWorkflow({ ...workflow, updatedAt: Date.now() })
    if (!base) throw new Error('Invalid workflow: missing id or name')
    const normalized = migrateWorkflow(base)
    this.byId.set(normalized.id, normalized)
    this.sources.set(normalized.id, 'primary')
    this.persistPrimary()
    return normalized
  }

  /** Persists every primary-sourced workflow back to `workflows.json`. */
  private persistPrimary(): void {
    // Preserve extra-sourced entries? No: the primary file mirrors the
    // extension exactly; extra-dir files stay separate on disk. Entries that
    // came from the extra dir are NOT written into the primary file, so a
    // round-trip through upsert keeps file provenance stable.
    const list = [...this.byId.values()].filter(
      (wf) => this.sources.get(wf.id) === 'primary',
    )
    mkdirSync(dirname(this.primaryFile), { recursive: true })
    const tmp = `${this.primaryFile}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    renameSync(tmp, this.primaryFile)
  }

  /**
   * Deletes one workflow. Primary-sourced entries are removed and the primary
   * file is persisted; extra-dir entries are refused (the operator deletes the
   * source file instead — the library cannot know which of several extra
   * files owned it without reparsing all of them).
   */
  remove(id: string): { ok: true; id: string } | { ok: false; reason: 'not-found' | 'extra-source' } {
    if (!this.byId.has(id)) return { ok: false, reason: 'not-found' }
    if (this.sources.get(id) === 'extra') return { ok: false, reason: 'extra-source' }
    this.byId.delete(id)
    this.sources.delete(id)
    this.persistPrimary()
    return { ok: true, id }
  }

  /**
   * Imports an extension `workflows.json` payload (or bare list / single
   * object). Every record is validated; valid ones are merged into the
   * library and the primary file is rewritten. The response reports, per
   * record, schema warnings and which referenced children are still missing —
   * the "what else must I copy" answer for nested workflows.
   */
  importPayload(payload: unknown): ImportResult {
    const list = extractWorkflowList(payload)
    const entries: ImportEntryResult[] = []
    let imported = 0
    let skipped = 0

    // First pass: validate + stage so missing-children reflects the WHOLE
    // batch (a parent and its child may arrive in the same import).
    const staged: { index: number; workflow: Workflow }[] = []
    for (let index = 0; index < list.length; index++) {
      const raw = list[index]
      const base = asWorkflow(raw)
      const normalized = base ? migrateWorkflow(base) : null
      if (!normalized) {
        entries.push({
          index,
          id: String((raw as { id?: unknown })?.['id'] ?? ''),
          name: String((raw as { name?: unknown })?.['name'] ?? ''),
          ok: false,
          error: 'Invalid workflow record (missing id or name)',
          warnings: [],
          missing: [],
        })
        skipped += 1
        continue
      }
      staged.push({ index, workflow: normalized })
    }

    // Second pass: stage into a scratch view so reference checks see siblings.
    const merged = new Map(this.byId)
    for (const { workflow } of staged) merged.set(workflow.id, workflow)

    for (const { index, workflow } of staged) {
      const warnings = validateWorkflow(workflow)
      const missing = referencesOfWorkflow(workflow)
        .map((ref) => ref.childId)
        .filter((childId) => !merged.has(childId))
      entries.push({
        index,
        id: workflow.id,
        name: workflow.name,
        ok: true,
        warnings,
        missing,
      })
      imported += 1
      this.byId.set(workflow.id, workflow)
      this.sources.set(workflow.id, 'primary')
    }

    if (imported > 0) this.persistPrimary()
    return { imported, skipped, entries }
  }

  /**
   * The full reference report for one workflow: direct references, missing
   * children, and every cycle reachable from it (A→B→A, self-loops included).
   */
  reportFor(id: string): WorkflowReport | undefined {
    const workflow = this.byId.get(id)
    if (!workflow) return undefined
    const references = referencesOfWorkflow(workflow)
    const missing = references.map((ref) => ref.childId).filter((child) => !this.byId.has(child))
    return { workflow, references, missing, cycles: this.cyclesFrom(id) }
  }

  /** All cycles in the library, as id chains (`[a, b, a]`). */
  allCycles(): string[][] {
    const cycles: string[][] = []
    const seen = new Set<string>()
    for (const id of this.byId.keys()) {
      for (const cycle of this.cyclesFrom(id)) {
        // Dedupe rotations AND repeated-node paths: compare by unique id set.
        const key = [...new Set(cycle)].sort().join('→')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push(cycle)
        }
      }
    }
    return cycles
  }

  /** DFS from `start`; returns every cycle path that returns to `start`. */
  private cyclesFrom(start: string): string[][] {
    const cycles: string[][] = []
    const path: string[] = [start]
    const onPath = new Set<string>([start])
    const visit = (current: string): void => {
      for (const ref of referencesOfWorkflow(this.byId.get(current)!)) {
        if (ref.childId === start) {
          cycles.push([...path, start])
          continue
        }
        if (onPath.has(ref.childId) || !this.byId.has(ref.childId)) continue
        path.push(ref.childId)
        onPath.add(ref.childId)
        visit(ref.childId)
        path.pop()
        onPath.delete(ref.childId)
      }
    }
    visit(start)
    return cycles
  }

  /**
   * Missing children for ONE workflow (transitive): what must be copied
   * before the parent can run. Cycles are NOT missing — they are legal to
   * store (the engine guards them at runtime) but reported by
   * {@link reportFor}.
   */
  missingFor(id: string): string[] {
    const missing = new Set<string>()
    const visited = new Set<string>()
    const visit = (current: string): void => {
      if (visited.has(current)) return
      visited.add(current)
      const wf = this.byId.get(current)
      if (!wf) {
        missing.add(current)
        return
      }
      // Recurse into EVERY referenced child — missing ones are recorded, and
      // in-library ones (like intermediate parents) must be explored too.
      // `visited` keeps cycles from recursing forever.
      for (const ref of referencesOfWorkflow(wf)) visit(ref.childId)
    }
    visit(id)
    missing.delete(id)
    return [...missing]
  }
}
