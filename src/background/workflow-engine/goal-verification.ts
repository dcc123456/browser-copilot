/**
 * Goal Verification — the three-level (L1/L2/L3) certification engine.
 */
import { goalSpecOf } from '../../lib/workflow/reliability'
import { conditionRequiresBaseline, describeCondition, type WorkflowCondition } from '../../lib/workflow/conditions'
import { provesLandedEffect } from '../../lib/workflow/repair-verification'
import { nodeGoalContractOf, type WorkflowNodeGoalContract } from '../../lib/workflow/node-goal-contract'
import type { Workflow, WorkflowNode } from '../../lib/workflow/types'
import { evaluateCondition, type ConditionPageProbe } from './condition-runtime'
import type { ExecuteWorkflowResult } from './run-workflow'
export type VerificationLevel = 'L1' | 'L2' | 'L3'
export interface ConditionEvidence { description: string; satisfied: boolean; detail?: string }
export interface NodeVerification {
  nodeId: string; blockId: string; executed: boolean; contract?: WorkflowNodeGoalContract;
  criteria: ConditionEvidence[]; preconditions: ConditionEvidence[]
  /** Contract rows that compare against a before-the-step observation: the engine checked them, this verifier cannot re-observe them. */
  unevaluated?: string[]
}
export interface VerificationReport {
  level: VerificationLevel; passed: boolean;
  l1: ConditionEvidence[];
  l2: { nodes: NodeVerification[]; allHeld: boolean; /** False when NO node declared a contract: nothing was verified here. */ evaluated?: boolean; unevaluated?: string[] };
  l3: { goalSummary: string; conditions: ConditionEvidence[]; allHeld: boolean; unevaluated?: string[] };
  /** Soft postconditions the run reported — they never fail a step, but they bar certification. */
  softUnconfirmed?: string[];
  /** Goal rows that only held on a later read inside `settleMs`; evidence that the verdict waited, not guessed. */
  settledAfterMs?: number;
  certified: boolean; reason: string
}
export interface GoalVerificationOptions {
  /**
   * Extra window (ms) spent RE-READING only the success rows that came back
   * false. A goal row is a claim about the page after the run, and the page is
   * still settling when the last step returns: a drawer animating open, a list
   * re-rendering, a save flushing to storage. Reading once at that instant is
   * how a replay that really landed its draft failed its own goal — round 33
   * read 「元素存在 "草稿箱"」 as absent one minute before the same element was
   * found present AND visible on the same tab. Rows that already hold are not
   * re-read, so this costs nothing on a clean run. `0` (the default) keeps the
   * single honest read.
   */
  settleMs?: number
  /** Poll spacing inside the settle window. */
  pollMs?: number
  /** Injectable sleep (tests); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}
/**
 * The window a real certification uses. Generous enough to cover the thing that
 * actually broke round 33 — the last step clicked 「暂存离开」, the page navigated,
 * and 「草稿箱」 only exists on the OTHER side of that navigation — and still short
 * enough that a genuinely unmet goal reports in seconds, not minutes. Only paid
 * when a row already failed, so a clean certification never waits.
 */
export const DEFAULT_GOAL_SETTLE_MS = 6000
const DEFAULT_GOAL_SETTLE_POLL_MS = 1000
function isActionNode(node: WorkflowNode): boolean {
  return typeof node.data?.blockId === 'string' && node.data.blockId !== 'trigger'
}
/**
 * WHICH promise of WHICH step broke.
 *
 * Round 57 replayed 20/20 in 33s and really saved the draft, and the single
 * thing between that and a certification was «a node goal contract did not
 * hold» — no step named, no condition named. A user holding that sentence has
 * no way to tell a run that failed from a promise that was written wrong, which
 * are opposite fixes. The evidence already exists in the ballot; this only
 * refuses to throw it away.
 */
function l2FailureReason(reports: readonly NodeVerification[]): string {
  for (const report of reports) {
    for (const row of [...report.criteria, ...report.preconditions]) {
      if (row.satisfied) continue
      return (
        `L2 failed: the ${report.blockId} step's own contract «${row.description}» did not hold` +
        (row.detail ? ` (${row.detail}).` : '.')
      )
    }
  }
  return 'L2 failed: a node goal contract did not hold.'
}
/**
 * A condition that compares against an observation taken BEFORE the step
 * (`urlChanged`, `elementGone`, `elementAppeared`, `countIncreased`) was checked
 * by the engine at that step, with that baseline. After the run there is nothing
 * to compare it against, so re-observing it here can only ever read false — which
 * is how a graph that really changed the page failed its own goal. Such a miss
 * would have surfaced as a soft warning instead (change conditions are never
 * hard, see `isHardCondition`), so leaving it out of this ballot loses no
 * evidence; it simply cannot serve as proof either.
 */
function reObservableAfterTheRun(condition: WorkflowCondition): boolean {
  return !conditionRequiresBaseline(condition)
}
function blockIdOf(node: WorkflowNode): string {
  return typeof node.data?.blockId === 'string' ? node.data.blockId : 'unknown'
}
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
export async function verifyWorkflowGoal(
  workflow: Workflow,
  run: ExecuteWorkflowResult,
  probe: ConditionPageProbe,
  options: GoalVerificationOptions = {},
): Promise<VerificationReport> {
  const nodes = workflow.drawflow.nodes.filter(isActionNode)
  const variables = run.variables ?? {}
  // L1 is per-node evidence, not the run's verdict: a step skipped by a branch
  // or swallowed by `onError: continue` did NOT execute, and calling it
  // executed is how a half-run gets a certificate. `completedNodeIds` is the
  // engine's own list; without it there is no per-node truth to report, so the
  // run outcome is all we honestly have.
  const completed = run.completedNodeIds ? new Set(run.completedNodeIds) : undefined
  // Rows the run already observed at their own step, keyed by node + row text.
  // Anything the engine never answered still gets the end-of-run read below.
  const liveBallot = new Map<string, boolean>()
  for (const entry of run.nodeConditions ?? []) {
    liveBallot.set(`${entry.nodeId}\u0000${entry.description}`, entry.satisfied)
  }
  const liveFor = (nodeId: string, condition: WorkflowCondition): boolean | undefined =>
    liveBallot.get(`${nodeId}\u0000${describeCondition(condition)}`)
  const l1: ConditionEvidence[] = nodes.map((node) => {
    const executed = completed ? completed.has(node.id) : run.outcome === 'ok'
    return {
      description: blockIdOf(node) + ' executed',
      satisfied: executed,
      ...(!executed
        ? { detail: run.error ?? (completed ? 'The step never ran.' : 'The run did not finish successfully.') }
        : {}),
    }
  })
  const l1Pass = run.outcome === 'ok' && l1.every((c) => c.satisfied)
  const nodeReports: NodeVerification[] = []
  for (const node of nodes) {
    const data = (node.data ?? {}) as Record<string, unknown>
    const contract = nodeGoalContractOf(data)
    const criteria: ConditionEvidence[] = []
    const preconditions: ConditionEvidence[] = []
    const unevaluated: string[] = []
    if (contract) {
      for (const condition of contract.successCriteria) {
        // A promise is judged where it was made. The run recorded this row while
        // its own step was the page in front of it; re-asking at the end reads
        // false for every step the run navigated away from — round 76 replayed
        // 13/13 and was refused by the title input of a form the draft save had
        // already left behind.
        const seen = liveFor(node.id, condition)
        if (seen !== undefined) {
          criteria.push({ description: describeCondition(condition), satisfied: seen })
          continue
        }
        if (!reObservableAfterTheRun(condition)) {
          unevaluated.push(describeCondition(condition))
          continue
        }
        const outcome = await evaluateCondition(condition, { variables, probe })
        criteria.push({ description: outcome.description, satisfied: outcome.satisfied, ...(outcome.detail ? { detail: outcome.detail } : {}) })
      }
      for (const condition of contract.preconditions ?? []) {
        const seen = liveFor(node.id, condition)
        if (seen !== undefined) {
          preconditions.push({ description: describeCondition(condition), satisfied: seen })
          continue
        }
        if (!reObservableAfterTheRun(condition)) {
          unevaluated.push(describeCondition(condition))
          continue
        }
        const outcome = await evaluateCondition(condition, { variables, probe })
        preconditions.push({ description: outcome.description, satisfied: outcome.satisfied, ...(outcome.detail ? { detail: outcome.detail } : {}) })
      }
    }
    nodeReports.push({ nodeId: node.id, blockId: blockIdOf(node), executed: completed ? completed.has(node.id) : l1Pass, ...(contract ? { contract } : {}), criteria, preconditions, ...(unevaluated.length > 0 ? { unevaluated } : {}) })
  }
  // `every` over nodes with nothing to check is vacuously true — that is not
  // verification, it is the absence of evidence. Report whether L2 was
  // evaluated at all so no consumer reads an empty ballot as a pass.
  const l2Evaluated = nodeReports.some((report) => report.criteria.length > 0 || report.preconditions.length > 0)
  const l2AllHeld = nodeReports.every((report) => report.criteria.every((c) => c.satisfied) && report.preconditions.every((c) => c.satisfied))
  const goalSpec = goalSpecOf(workflow)
  const goalBaseline = run.goalBaseline
  const l3Conditions: ConditionEvidence[] = []
  // A URL row says where the run IS, not what it DID, and a graph that opens the
  // publish page satisfies `/publish` before its first step. S0 already refuses
  // that as evidence (see `provesLandedEffect`); L3 has to use the same standard
  // or a replay that clicked nothing certifies its own goal.
  let l3EffectProven = false
  let settledAfterMs: number | undefined
  let settleWaitedMs = 0
  const l3Unevaluated: string[] = []
  // A missing variable row is the one failure a reader cannot act on from prose:
  // 「变量 xiaohongshuTitle 不存在」 is either the goal naming something the graph
  // never writes or the run failing to produce it, and the names this replay DID
  // hold is the only evidence that tells them apart.
  const variableNames = Object.keys(variables)
  const withBag = (detail: string | undefined): string | undefined =>
    variableNames.length === 0
      ? detail
      : `${detail ?? ''}（本次运行的变量：${variableNames.slice(0, 12).join(', ')}）` || undefined
  if (goalSpec) {
    const readRow = async (condition: WorkflowCondition): Promise<ConditionEvidence> => {
      const outcome = await evaluateCondition(condition, {
        variables,
        probe,
        ...(goalBaseline ? { baseline: goalBaseline } : {}),
      })
      const detail =
        !outcome.satisfied && (condition.kind === 'variableExists' || condition.kind === 'variableEquals')
          ? withBag(outcome.detail)
          : outcome.detail
      return { description: outcome.description, satisfied: outcome.satisfied, ...(detail ? { detail } : {}) }
    }
    const rows: { condition: WorkflowCondition; evidence: ConditionEvidence }[] = []
    for (const condition of goalSpec.successConditions) {
      // A change row needs the page as it stood BEFORE the run, and only the run
      // still has it (`goalBaseline`). Re-observing it here would compare the
      // page against itself and report "it changed" for a page that never moved,
      // which is the vacuous pass this layer exists to refuse — so with no
      // snapshot the row stays unevaluated, exactly as before.
      if (!reObservableAfterTheRun(condition) && !goalBaseline) {
        l3Unevaluated.push(describeCondition(condition))
        continue
      }
      rows.push({ condition, evidence: await readRow(condition) })
    }
    // Settle window: re-read ONLY the rows that came back false. A row that held
    // is not re-asked (the page may have moved on), and a row that never holds
    // still bars certification once the window is spent — this cannot turn a
    // goal that did not land into one that did, it only stops calling a slow page
    // a failed action.
    const { settleMs = 0, pollMs = DEFAULT_GOAL_SETTLE_POLL_MS, sleep = defaultSleep } = options
    while (settleWaitedMs < settleMs && rows.some((row) => !row.evidence.satisfied)) {
      const slice = Math.min(pollMs, settleMs - settleWaitedMs)
      await sleep(slice)
      settleWaitedMs += slice
      for (const row of rows) {
        if (row.evidence.satisfied) continue
        const again = await readRow(row.condition)
        if (again.satisfied && settledAfterMs === undefined) settledAfterMs = settleWaitedMs
        row.evidence = again
      }
    }
    for (const row of rows) {
      l3Conditions.push(row.evidence)
      if (row.evidence.satisfied && provesLandedEffect(row.condition)) l3EffectProven = true
    }
  }
  const l3AllHeld = !!goalSpec && l3Conditions.length > 0 && l3Conditions.every((c) => c.satisfied) && l3EffectProven
  // Soft postconditions (business-outcome predictions the generator wrote): a
  // miss never failed the step, but a run whose declared outcomes were not
  // observed cannot be certified. This is D3 — signal, not gate.
  const softUnconfirmed = run.conditionWarnings ?? []
  const passed = l1Pass && l2AllHeld && l3AllHeld && softUnconfirmed.length === 0
  // `level` is the deepest layer the verification REACHED, not a badge: L3 is
  // only reached when a goal with conditions was actually evaluated. Claiming
  // 'L3' for a workflow that never got that far (an empty L2 ballot used to
  // grant it) is the label bug this replaces.
  const l3Evaluated = !!goalSpec && l3Conditions.length > 0
  let level: VerificationLevel = 'L1'
  if (l1Pass) level = l2AllHeld && l3Evaluated ? 'L3' : 'L2'
  const l2Unevaluated = nodeReports.flatMap((report) => report.unevaluated ?? [])
  const reason = !l1Pass
    ? 'L1 failed: one or more nodes did not execute.'
    : !l3AllHeld
      ? !goalSpec
        ? 'L3 failed: the workflow has no goal contract to verify.'
        : !l3Evaluated && l3Unevaluated.length > 0
          ? 'L3 failed: every success condition compares against an observation from before its step, which cannot be re-checked after the run — the goal states nothing observable now.'
          : l3Evaluated && l3Conditions.every((c) => c.satisfied)
            ? 'L3 failed: every success condition holds from the page the workflow opens (a URL row), so none of them proves the goal landed.'
            : `L3 failed: the workflow goal success conditions did not all hold${
                settleWaitedMs > 0 ? ` (the page was re-read for ${settleWaitedMs} ms after the run and they still did not).` : '.'
              }`
      : !l2AllHeld
        ? l2FailureReason(nodeReports)
        : softUnconfirmed.length > 0
          ? `Goal conditions held, but ${softUnconfirmed.length} declared outcome(s) were not confirmed on the page.`
          : 'L3 passed: the workflow achieved its goal.'
  return { level, passed, l1, l2: { nodes: nodeReports, allHeld: l2AllHeld, evaluated: l2Evaluated, ...(l2Unevaluated.length > 0 ? { unevaluated: l2Unevaluated } : {}) }, l3: { goalSummary: goalSpec?.summary ?? '', conditions: l3Conditions, allHeld: l3AllHeld, ...(l3Unevaluated.length > 0 ? { unevaluated: l3Unevaluated } : {}) }, softUnconfirmed, ...(settledAfterMs !== undefined ? { settledAfterMs } : {}), certified: passed, reason }
}