/**
 * Optional verification after an AI-takeover fix is APPLIED (M1-10a).
 *
 * The debug session already runs a takeover-free verify pass before it ever
 * lands a fix as pending. This is the *second* safety net: when the user clicks
 * "apply" on the panel and asks for confirmation, we can re-run the patched
 * workflow WITHOUT AI takeover to prove the patched node no longer errors.
 *
 * The runner is injected so the logic is testable offline — the real call site
 * passes `executeWorkflow` bound to the panel's window scope. Keeping it pure
 * also means no `chrome.*` dependency leaks into the shared layer.
 *
 * @module lib/workflow/apply-verify
 */
import type { Workflow } from './types'

/** A minimal run outcome — enough to decide pass/fail without a full engine type. */
export interface AppliedVerifyRun {
  outcome: 'ok' | 'cancelled' | 'failed'
  summary?: string
}

/** Outcome of re-running an applied workflow without AI takeover. */
export interface AppliedVerifyOutcome {
  /** The takeover-free re-run completed without a node error. */
  ok: boolean
  /** Alias for `ok`: the patched node no longer blocks the run. */
  verified: boolean
  /** Run summary (first error line when it failed). */
  summary?: string
}

/**
 * Re-runs an APPLIED workflow WITHOUT AI takeover to confirm the patched node
 * no longer errors. `run` is injected so this stays testable offline.
 *
 * @param workflow the patched workflow to re-run
 * @param run injected runner (real site: `executeWorkflow` scoped to the panel window)
 */
export async function verifyAppliedWorkflow(
  workflow: Workflow,
  run: (wf: Workflow) => Promise<AppliedVerifyRun>,
): Promise<AppliedVerifyOutcome> {
  const r = await run(workflow)
  const ok = r.outcome === 'ok'
  return { ok, verified: ok, ...(r.summary != null ? { summary: r.summary } : {}) }
}
