# Trigger single-select + multiple trigger methods per scheduled task

Date: 2026-10-26
Status: implemented

## Part 1 — the trigger block edits exactly one trigger

The block form currently shows a type dropdown _and_ a "Workflow triggers" button
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
  - `withSchedules(task, schedules)` — normalizes, rewrites the `schedule`
    mirror, and stores `[]` for manual-only. Exact duplicates are **kept**: each
    entry is an independent run, so two identical entries are the user asking
    for two runs, and silently collapsing them would make "Add trigger method"
    look like it did nothing.
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
  live preview. "Add trigger method" appends an interval entry (every 60 min,
  the neutral starting point); an empty list is the manual task (no alarm),
  preserving today's manual behavior.
- `TasksTab` shows one chip per entry and treats a task as manual only when the
  list is empty.

### Agent tool

- `create_scheduled_task` keeps its single `schedule` argument (the model's
  contract does not change) and writes `schedules: [schedule]`, so an update
  intentionally replaces the task's trigger methods.
- `list_scheduled_tasks` reports every entry, joined with `; `.

## Part 3 — cron trigger methods, and an icon remove button

A fourth card mode, `cron`, carrying a standard five-field expression evaluated
in the machine's local timezone (the same way the existing daily/weekly presets
mean local wall-clock time).

### Why `croner`

The runner already parses cron for workflow triggers with `croner`
(`server/src/scheduler.ts`), so the extension reuses the same library instead of
growing a second cron engine (§5.6). Verified against the installed
`croner@9.1.0` types and a local spike:

- `new Cron(expr, { paused: true })` validates without arming a timer and throws
  on a malformed pattern; `nextRun(date)` returns the first firing strictly
  after `date` in local time, or `null` when the pattern can never occur.
- It also accepts a six-field (seconds) pattern, which is rejected here on
  purpose: `chrome.alarms` has a one-minute floor, so a seconds field could not
  be honored.
- A pattern that is syntactically valid but never fires (`0 0 31 2 *`) keeps the
  card, shows a "never occurs" warning, and arms nothing.

### Data + UI

- `Schedule` gains `{ kind: 'cron'; expression: string }`. Storage normalization
  keeps the trimmed expression even when it is invalid, so an editor round-trip
  can show the typo instead of silently deleting the trigger; `nextRunAt`
  returns `null` for an invalid pattern, so nothing is ever armed from one.
- The editor treats invalid cron as unsaveable (Save disabled + inline bilingual
  error). A valid pattern shows its next local firing.
- The per-card remove control becomes an icon button (existing `.icon-btn` +
  `.danger` styles) whose accessible name/title stays the bilingual
  "Remove"/"移除" copy.
- `create_scheduled_task` gains `schedule.kind: "cron"` with a required
  `expression`, validated explicitly like the other kinds (a model typo is
  reported, never coerced), and the advertised-payload budget is raised by the
  measured delta.
