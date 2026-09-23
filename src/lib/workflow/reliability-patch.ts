/**
 * ReliabilityPatch — LEGACY patch shape, superseded by the unified
 * {@link WorkflowPatchSet} + {@link PatchEngine} (spec §5.6/§8).
 *
 * @deprecated No business code calls this module anymore — the generation and
 * debug entries both go through `src/lib/workflow/repair/patch-engine.ts`. It
 * is retained only for `tests/reliability-patch.spec.ts` and will be removed
 * once that regression coverage is ported onto PatchEngine-based tests.
 *
 * Originally the ONLY shape the AI-repair loop could use to change a workflow:
 * a LOCAL, single-node param change with a stated confidence and reason. It
 * could never touch another node, add/remove/retype a node (`blockId` is
 * protected), disable a node (`disableBlock` is protected), or RELAX a contract
 * (idempotency may only be tightened; postconditions may only be added).
 *
 * @module lib/workflow/reliability-patch
 */
import { patchNodeParams } from './auto-debug-patch'
import type { Workflow } from './types'

/** What kind of local change the patch makes (drives verify expectations). */
export type ReliabilityPatchKind =
  | 'set-locator' // selector / findBy / target — the classic stale-locator fix
  | 'set-readiness' // __reliability.readiness window/states
  | 'set-param' // any other node param (value, url, keys…)
  | 'set-contract' // __reliability contract fields (intent/postconditions)

export interface ReliabilityPatch {
  /** The ONE node being patched. */
  nodeId: string
  kind: ReliabilityPatchKind
  /** Flat param merge, exactly what `patchNodeParams` accepts. */
  paramsPatch: Record<string, unknown>
  /** 0..1 — the gate decides apply/verify behavior. */
  confidence: number
  /** Why this patch should fix the failure (one line, Chinese). */
  reason: string
  /** The failure code the patch answers (circuit-breaker identity). */
  failureCode?: string
}

export interface PatchValidationResult {
  ok: boolean
  problems: string[]
}

/** Keys the AI may NEVER set through a patch. */
const FORBIDDEN_PATCH_KEYS = new Set(['blockId', 'disableBlock', 'id', 'position'])

/** Idempotency ranks — a patch may only TIGHTEN (higher number = safer). */
const IDEMPOTENCY_RANK: Record<string, number> = { unsafe: 0, conditional: 1, safe: 2 }

/**
 * Schema + policy validation for one patch against its workflow. Pure — no
 * side effects, safe to call before deciding to apply.
 */
export function validateReliabilityPatch(
  patch: ReliabilityPatch,
  workflow: Workflow,
): PatchValidationResult {
  const problems: string[] = []
  if (!patch.nodeId) problems.push('缺少 nodeId')
  const node = workflow.drawflow.nodes.find((n) => n.id === patch.nodeId)
  if (!node) problems.push(`节点 ${patch.nodeId} 不存在`)
  if (!patch.paramsPatch || typeof patch.paramsPatch !== 'object') {
    problems.push('缺少 paramsPatch')
  } else if (Object.keys(patch.paramsPatch).length === 0) {
    problems.push('paramsPatch 为空')
  }
  for (const key of Object.keys(patch.paramsPatch ?? {})) {
    if (FORBIDDEN_PATCH_KEYS.has(key)) {
      problems.push(`禁止修改参数 ${key}`)
    }
  }
  if (
    patch.paramsPatch &&
    patch.paramsPatch['__reliability'] &&
    typeof patch.paramsPatch['__reliability'] === 'object'
  ) {
    const contract = patch.paramsPatch['__reliability'] as Record<string, unknown>
    const original = (node?.data?.['__reliability'] ?? {}) as Record<string, unknown>
    const nextIdem = typeof contract['idempotency'] === 'string' ? contract['idempotency'] : undefined
    const prevIdem = typeof original['idempotency'] === 'string' ? original['idempotency'] : undefined
    if (nextIdem && prevIdem && (IDEMPOTENCY_RANK[nextIdem] ?? 0) < (IDEMPOTENCY_RANK[prevIdem] ?? 0)) {
      problems.push('禁止放宽幂等性（idempotency 只能收紧）')
    }
    if (Array.isArray(original['postconditions']) && Array.isArray(contract['postconditions'])) {
      if ((contract['postconditions'] as unknown[]).length < (original['postconditions'] as unknown[]).length) {
        problems.push('禁止删除后置条件（postconditions 只能新增）')
      }
    }
  }
  if (typeof patch.confidence !== 'number' || patch.confidence < 0 || patch.confidence > 1) {
    problems.push('confidence 必须在 0..1')
  }
  if (!patch.reason?.trim()) problems.push('缺少 reason')
  return { ok: problems.length === 0, problems }
}

/** The confidence gate's decision for a patch. */
export type PatchGate = 'refuse' | 'apply-and-verify' | 'apply-verify-chain'

export function confidenceGate(patch: ReliabilityPatch): PatchGate {
  if (patch.confidence < 0.75) return 'refuse'
  if (patch.confidence < 0.9) return 'apply-and-verify'
  return 'apply-verify-chain'
}

/**
 * Stable identity of a patch for the circuit breaker: node + failure code +
 * kind + the exact param diff. Two rounds proposing the "same fix" hash equal.
 */
export function patchFingerprint(patch: ReliabilityPatch): string {
  const params = Object.entries(patch.paramsPatch)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : (JSON.stringify(v) ?? '')}`)
    .sort()
    .join('|')
  return [patch.nodeId, patch.failureCode ?? '', patch.kind, params].join('#')
}

export interface ApplyPatchResult {
  workflow: Workflow
  applied: boolean
  changes: string[]
  problems?: string[]
}

/**
 * Validate then apply one patch (single node, protected keys filtered).
 * Invalid patches are NOT applied — the problems come back as evidence.
 */
export function applyReliabilityPatch(
  workflow: Workflow,
  patch: ReliabilityPatch,
): ApplyPatchResult {
  const validation = validateReliabilityPatch(patch, workflow)
  if (!validation.ok) {
    return { workflow, applied: false, changes: [], problems: validation.problems }
  }
  const result = patchNodeParams(workflow, patch.nodeId, patch.paramsPatch)
  return {
    workflow: result.workflow,
    applied: result.changed,
    changes: [...result.changes, `置信度 ${patch.confidence.toFixed(2)}：${patch.reason}`],
  }
}

/**
 * The circuit breaker. Feed it every applied patch + the failure codes seen
 * afterwards; it refuses a patch whose identity already failed once.
 */
export class PatchCircuitBreaker {
  /** Identities applied and currently watched (one failure tolerated). */
  private readonly watching = new Set<string>()
  /** Identities whose SAME patch already failed after being applied — open. */
  private readonly open = new Set<string>()

  /** Record that a patch was applied (identity watched again, breaker reset). */
  applied(patch: ReliabilityPatch): void {
    const fingerprint = patchFingerprint(patch)
    this.watching.delete(fingerprint)
    this.open.delete(fingerprint)
  }

  /**
   * Record a failure recurrence. Returns `true` for a FIRST failure (the
   * identity is now watched, the breaker stays closed) and `false` when the
   * SAME patch failed AGAIN — the breaker then opens for that identity.
   */
  observeFailure(patch: ReliabilityPatch): boolean {
    const fingerprint = patchFingerprint(patch)
    if (this.watching.has(fingerprint)) {
      this.open.add(fingerprint)
      return false
    }
    this.watching.add(fingerprint)
    return true
  }

  /** A patch whose identity is breaker-open is refused. */
  allows(patch: ReliabilityPatch): boolean {
    return !this.open.has(patchFingerprint(patch))
  }
}
