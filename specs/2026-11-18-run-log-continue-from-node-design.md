# Continue a run from a log row — design

Date: 2026-11-18
Area: workflow-editor log viewer / manual run

## Goal

Next to the `Locate` button on each executed-block row of a run's log, add a
`Continue from here` button. Clicking it starts a NEW manual run of the same
workflow at that row's node, seeded with the full variable bag that the previous
run had generated at that point.

## What already exists (reuse map)

- `TraceRow` (`src/workflow-editor/sidebar/log-view.tsx:440`) renders the
  `Locate` button; it holds `entry.nodeId` and `entry.vars`, but not `runId`.
- `RunView.runId` is available one level up in `RunDetailModal`
  (`src/workflow-editor/sidebar/RunDetailModal.tsx:36`).
- `Run from here` already exists on the canvas: `App.tsx:1187` → `handleRun(id)`
  → `workflows.run` with `startAt` (`App.tsx:1008`, `index.ts:2151`,
  `engine.ts:2008`). **It does not carry variables.**
- Every settled node writes a checkpoint with a FULL deep-cloned variable bag
  (`engine.ts:798` `emitCheckpoint` → `run-workflow.ts:947` → checkpoint store).
- `resumeFrom` (`run-workflow.ts:686`) already restores checkpoints — but it
  picks the last clean point automatically; it cannot be pinned to a node the
  user clicked. `planReplay` (`repair/replay-engine.ts:93`) shows the
  "startAt + checkpoint variables" pattern.
- `resumePointOf` / `restoreVariables` (`src/lib/workflow/checkpoints.ts`) are
  the shared, chrome-free checkpoint helpers. `getCheckpointStore()` and
  `readPersistedCheckpoints()` are already imported in `index.ts:227-238`.

No new infrastructure is introduced: the feature extends the existing
`workflows.run` command and the existing checkpoint helpers (AGENTS §5.6).

## Variable source decision

The log row's `entry.vars` is **not** the authoritative data: it is the debug
snapshot passed through `boundedVariables()` (`running-tasks.ts:188`), which
truncates long strings, drops large data URLs and caps key count. Using it would
silently lose the very "previously generated data" the feature promises.

The authoritative full bag is the checkpoint recorded for that node in
`checkpoints/<runId>.json` (in-memory first, persisted fallback — same read
pattern as `workflows.resumePoint`, `index.ts:2286`). Therefore:

- A new pure helper `variablesAtNode(checkpoints, nodeId)` in
  `src/lib/workflow/checkpoints.ts` returns the newest checkpoint's full
  variables for that node, skipping entries with `snapshotAvailable === false`
  and skipping in-flight phases (`nodeStarted`, `sideEffectStarted`) that never
  committed. Failed/ok/cancelled/sideEffectObserved settled entries are
  accepted — retrying a failed node with its captured bag is the intended use.
- The UI still passes the row's bounded `entry.vars` as a **fallback** (old runs
  whose checkpoints were pruned still continue, with reduced data).

### What is restorable today

`executeWorkflow` seeds only `variables` on start; `pageState` and
`agentMemory` are checkpoint metadata that the engine does not replay. So
"other data" means the complete variable bag (arrays, objects, dataTable,
large CSV strings) rather than the bounded log preview. This is stated plainly
so the UI does not over-promise page-state restoration.

### Semantics

`Continue from here` on row X ⇒ `executeWorkflow(startAt = X, variables = bag
at X)`. The node itself is re-executed — identical to the canvas `Run from
here` action, which the user already has, with the addition of restored state.
If X's last checkpoint is an uncommitted side-effect phase, that entry is
skipped rather than blind-replayed (mirrors `resumePointOf`).

## Protocol

Extend the `workflows.run` command (`src/lib/messages.ts:314`) with:

- `variables?: Record<string, unknown>` — explicit seed / bounded fallback.
- `sourceRunId?: string` — run whose checkpoint supplies the full bag for
  `startAt`.

`workflows.run` handler (`index.ts:2135`):

1. If `startAt` and `sourceRunId` are both set, load that run's checkpoints
   (memory → persisted), call `variablesAtNode(checkpoints, startAt)`.
2. `seedVariables = restored ?? command.variables`.
3. Pass `startAt` + `variables: seedVariables` to `executeWorkflow`.

All post-run behaviour (self-heal, certification, metrics, run log) is reused
unchanged. Response shape is unchanged.

## UI threading

```
TraceRow.onContinue(nodeId, entry.vars)
  → RunDetailModal.onContinueFrom(nodeId, runId, vars)
    → LogsModal.onContinueFrom (closes both modals, then calls up)
      → App: setLogsOpen(false); handleRun(nodeId, { sourceRunId: runId, variables: vars })
```

`handleRun` gains an optional second argument carrying `sourceRunId` /
`variables` and forwards them on the existing `workflows.run` command. The
canvas `onRunFromHere` call site is unchanged (single argument).

i18n: one new key `continueFromNode` in `EDITOR_STRINGS.en` / `.zh`
("Continue from here" / "从这里继续"); the `Messages`-style key-count test in
`tests/editor-i18n.spec.ts` guards both sides.

## Alternatives rejected

- **Pass `entry.vars` only, no checkpoint lookup.** Rejected: bounded snapshot
  loses data (spec Goal), so the promise "carry previous data" would be false
  for any non-trivial variable.
- **Reuse `workflows.resume` (`resumeFrom`).** Rejected: it always selects the
  last clean point and cannot be pinned to the row the user clicked.
- **Add a separate `workflows.continueFrom` command + handler.** Rejected:
  duplicates the whole post-run pipeline (self-heal/certification/metrics);
  extending `workflows.run` reuses it for free (AGENTS §5.1/5.3).
- **A third variable source / store.** Rejected: AGENTS §5.6 — checkpoint state
  has exactly one shared contract; extend `src/lib/workflow/checkpoints.ts`.

## Tests

- `tests/checkpoints.spec.ts`: `variablesAtNode` — restores full bag, skips
  `snapshotAvailable:false`, skips in-flight phases, picks newest, returns
  undefined when absent.
- `tests/run-log-continue.spec.tsx`: `RunDetailModal` renders the Continue
  button when `onContinueFrom` is supplied (absent otherwise), and clicking it
  calls back with `(nodeId, runId, vars)` without opening the variable inspector.
- `tests/editor-i18n.spec.ts` key-alignment (automatic).
- Compile-time: `workflows.run` command fields covered by `pnpm typecheck`.
