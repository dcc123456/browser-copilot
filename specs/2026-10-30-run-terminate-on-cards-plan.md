# Terminate from the running workflow / task card · plan

Date: 2026-10-30
Status: implementing

## Requirement (dcc)

While a workflow or a scheduled task is running, its own card in the Workflows /
Tasks tab must show a terminate button; clicking it stops that run.

## Findings

- The worker already exposes the live run registry through `tasks.running` and
  accepts `tasks.cancel { runId }` (`background/running-tasks#cancelRun`).
- Only the History tab's activity board consumed that snapshot, so a user
  looking at the workflow/task card had no way to stop its run without leaving
  the tab.
- `RunningTaskView` carries both `workflowId` (manual/editor runs) and `taskId`
  (scheduled / Feishu / run-now runs), so each card can match its own runs
  without a new worker command.

## Decisions

- Extract the board's poll + cancel bookkeeping into
  `sidepanel/hooks/useRunningTasks.ts`; the board, Workflows tab and Tasks tab
  share one implementation (§5.2).
- Cards match runs by `workflowId` / `taskId`. While any match is live, the
  card shows a `运行中 / Running` chip and replaces its Run button with a danger
  `终止 / Terminate` button (`取消中 / Cancelling…` after the click). Terminating
  cancels every live run of that item, so overlapping runs cannot survive one
  click.
- No confirmation dialog: the board never asked for one and the abort is the
  same path.

## Files

- `src/sidepanel/hooks/useRunningTasks.ts` (new)
- `src/sidepanel/RunningBoard.tsx` — use the hook, keep settled detection.
- `src/sidepanel/WorkflowsTab.tsx`, `src/sidepanel/TasksTab.tsx` — running chip +
  terminate action.
- `tests/tasks-tab.spec.tsx`, `tests/workflows-tab-resume.spec.tsx` — mock
  `tasks.running` and cover the terminate call.

## Verification

Typecheck, full test suite, lint/format on changed files, build, and the
Playwright probe: seed a running entry, assert the card shows the terminate
button and sends `tasks.cancel`.
