# Trigger single-select + multiple trigger methods per scheduled task

Date: 2026-10-26
Status: implementing

## Part 1 — the trigger block edits exactly one trigger

The block form currently shows a type dropdown *and* a "Workflow triggers" button
that opens a list modal for adding further specs. The user wants only the
dropdown; a workflow supports a single trigger.

- Drop the button, the modal, and the add/remove/select-spec state from
  `workflow-editor/blocks/batchD/EditTrigger`.
- Every edit writes `writeTriggers(data, [editedSpec])`, i.e. the stored list
  collapses to one entry. Graphs imported with several triggers keep their
  primary (index 0, the one the old modal labelled "Primary") and show a hint
  that editing keeps only that one. The trigger engine and Runner keep reading
  the same array shape; nothing else changes.

## Part 2 — a scheduled task can carry several trigger methods

Today `ScheduledTask.schedule` is a single `Schedule` and the scheduler arms one
alarm (`task:<id>` / `workflow:<id>`). The request: in the task editor, a task
may hold several trigger methods; each one fires the task, i.e. behaves like one
more scheduled task.

### Data model

- Add `schedules?: Schedule[]` to `ScheduledTask`. `schedule` stays as the
  **primary mirror** (`schedules[0]`), so every existing reader (agent tool,
  run logs, older UI builds) keeps working and single-schedule records need no
  migration.
- `lib/schedule.ts` owns the two helpers:
  - `schedulesOf(task)` — normalized, `none` entries dropped, `[]` = manual;
    falls back to `[task.schedule]` when the array is absent (legacy record).
  - `withSchedules(task, schedules)` — normalizes, dedupes exact duplicates
    (two runs at the same instant is never intended), rewrites the `schedule`
    mirror, and stores `[]` for manual-only.
- `task-store.asTask` normalizes the array on read so a hand-edited record can
  never reach the scheduler half-written.

### Scheduler

- One alarm per entry: `task:<id>` / `workflow:<id>` for index 0 (unchanged, so
  already-armed alarms keep firing), `…#<index>` for the rest.
- `scheduleTask(id)` clears every alarm of that task (any index, either prefix),
  then arms each entry with `nextRunAt`; a passed `once` entry is left unarmed.
- On fire: parse `{taskId, index}`; a recurring entry re-arms **itself** only, so
  firing one entry does not push another interval entry's next run forward.
- A spent `once` entry: if it is the only entry, disable the task exactly as
  today; otherwise drop that entry, re-arm the remaining list (indices shift),
  and run the task. The task stays enabled because its other entries still fire.

### UI

- `TaskEditDialog` renders one bordered card per entry: a mode select
  (weekly / once / interval) + the existing config controls + remove button +
  live preview. "Add trigger method" appends a weekly entry; an empty list is the
  manual task (no alarm), preserving today's manual behavior.
- `TasksTab` shows one chip per entry and treats a task as manual only when the
  list is empty.

### Agent tool

- `create_scheduled_task` keeps its single `schedule` argument (the model's
  contract does not change) and writes `schedules: [schedule]`, so an update
  intentionally replaces the task's trigger methods.
- `list_scheduled_tasks` reports every entry, joined with `; `.
