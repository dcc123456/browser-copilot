# Run the current operator node only — design

Date: 2026-11-25
Area: workflow-editor canvas node toolbar / manual run

## Goal

Add a button to the hover toolbar of an operator node that runs **only that
node** as a test. It executes the block against the live page, reports
success/failure, and never follows the node's out-edges — so a user can check
one step without replaying the whole workflow.

## What already exists (reuse map)

- The hover toolbar is `NodeToolbar` in
  `src/workflow-editor/flow/BlockNode.tsx`; the editor wires its callbacks in
  `src/workflow-editor/App.tsx` (`nodeActions`) and `onRunFromHere` already
  calls `handleRun(id)`.
- `handleRun` saves the graph and sends `workflows.run` with `startAt`; the
  background (`src/background/index.ts` `case 'workflows.run'`) calls
  `executeWorkflow`.
- `ExecuteWorkflowOptions.startAt` / engine `WorkflowRunOptions.startAt` start
  the walk at a node but continue to the end; `stopBefore` only supports
  stopping **in front of** a node.
- The engine's per-node path (`runNode`) already covers interpolation, retry
  policy, readiness, checkpoints, run-log lines, the run gate and self-heal. A
  second single-block executor (`background/workflow-engine/operator-exec.ts`)
  exists for generation/node-fix, but it skips those layers — reusing it here
  would make the test disagree with what a real run does.
- `ENGINE_INTERPRETED_BLOCK_IDS` / `PLACEHOLDER_BLOCK_IDS`
  (`src/lib/workflow/operator-class.ts`) are the existing single source for
  "a single-node call cannot express this" and "running it proves nothing".

No new execution channel is introduced: the feature extends the existing
`workflows.run` command and the existing engine walk (AGENTS §5.6).

## Decision

Extend the existing run path with an `onlyNode` flag rather than adding a
separate command:

- `workflows.run { startAt, onlyNode: true }` — the background rejects the flag
  without `startAt`, filters the run-gate findings to that node, and calls
  `executeWorkflow(..., startAt, onlyNode)`.
- Engine: the top-level `runSegment` walk runs the first node and returns
  instead of following its out-edge. Loop/sub-workflow bodies call the same
  walk with their own `startAt` and are unaffected (the flag is only passed to
  the top-level call).
- The run is a real run: it appears in the run log, can be stopped, and its
  failure is reported. But it is a **partial** run, so:
  - the L3 goal gate is skipped (the workflow goal cannot be reached by one
    step);
  - certification and `certificationStatus` write-back are skipped;
  - the first-run-of-revision health metric is not recorded.
    Self-heal write-back is kept: when the node only worked by degrading down the
    locator ladder, the winner is still worth persisting.

Rejected alternatives:

- `startAt` + `stopBefore` on the next node: only works for a linear edge and
  branches make "the next node" ambiguous.
- `executeOperatorNode` (generation bridge): no retry policy, no readiness, no
  run-log/run-row, no run gate — the test would not match a real replay.
- A new `workflows.runNode` command: duplicates the running-board, stop and
  toast wiring `handleRun` already owns (§5.2).

## Semantics

| Case                                                                            | Behavior                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Click "run this block only" on node X                                           | Save the graph, then run from X and stop after X settles                                           |
| X succeeds                                                                      | Toast "block ran successfully"; the node ring shows it was running                                 |
| X fails                                                                         | Toast names the block's error; the run log keeps the failing step                                  |
| X is `trigger` / loop / `execute-workflow` / `blocks-group` / `loop-breakpoint` | No button: the engine interprets these across nodes, a single-node call cannot express them        |
| X is a placeholder executor (`browser-event`, `proxy`, `note`)                  | No button: running the stub proves nothing                                                         |
| Upstream variables                                                              | The bag starts from the trigger defaults, as any "run from here" does; upstream outputs are absent |
| Linked node has `$breakpoint` and testing mode is on                            | The testing-mode pause still applies (same engine path)                                            |

## Files

- `src/lib/messages.ts` — `workflows.run.onlyNode?: boolean`.
- `src/lib/workflow/operator-class.ts` — `isSingleNodeRunnable(blockId)` beside
  the existing classification sets.
- `src/background/workflow-engine/engine.ts` — `WorkflowRunOptions.onlyNode`,
  top-level walk stops after the first node.
- `src/background/workflow-engine/run-workflow.ts` — pass the flag, skip the
  goal gate, write a run-log line saying this was a single-block test.
- `src/background/index.ts` — validate `startAt`, filter preflight to the node,
  skip certification / first-run metric for a node test.
- `src/workflow-editor/flow/BlockNode.tsx` — toolbar button (icon `CirclePlay`,
  title from i18n), gated by `isSingleNodeRunnable`.
- `src/workflow-editor/App.tsx` — `onRunNode` action; `handleRun` third argument
  `{ onlyNode }`; running ring on the tested node; single-block toasts.
- `src/workflow-editor/i18n.ts` — `nodeRunOnly` / `runNodeFinished` /
  `runNodeFailed` in `en` and `zh`.

## Verification

- `tests/engine-only-node.spec.ts` — real engine: only the requested node runs
  (no downstream executor calls), success/failure outcomes, `completedNodeIds`
  contains exactly that node.
- `tests/node-run-only-button.spec.tsx` — static render of `BlockNode`: the
  toolbar carries the new button with its i18n title for a normal operator; no
  button for an engine-interpreted block (trigger) or a placeholder block.
- Gates: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`,
  `pnpm build`; Runner side untouched.

## Manual check

1. Load the unpacked build and open a workflow with ≥2 operator nodes.
2. Hover node B; click the new circle-play button. Expected: B gets the running
   ring, then a success toast; node C did not run (its page action is absent).
3. Hover a trigger / loop node. Expected: no circle-play button.
4. Make B fail (e.g. an impossible selector) and run it again. Expected: a
   failure toast naming B's error, and the run log shows only B.
