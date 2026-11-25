# Applying a version switches to it (no rollback entry) — design

Date: 2026-11-25
Area: workflow-editor version history
Supersedes: `specs/2026-11-24-workflow-version-history-design.md` R8 / AC-6 / AC-14
(the "rollback trace line" part). Everything else in that design stays.

## Problem

Clicking **Apply** on a version created a new history row `回滚自 vN`
(`source: 'rollback'`) and left the canvas marked unsaved. Users read that as
"apply created another version / rolled the workflow back", which is not what
the button promises: Apply should switch the workflow to that version, and the
version count must stay the same. A new version should appear only when the
user changes the content and saves.

## New semantics

| Action                           | Result                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Click **Apply** on v2            | Workflow content (name / description / trigger / settings / graph) becomes v2's; the list does **not** gain a row; v2 is marked **Current** (its fingerprint equals the canvas) |
| Apply, then Save without editing | Saved, but **no new version** (the content is already in the history)                                                                                                           |
| Apply, edit a node, Save         | **+1 version** (content differs from the stored record)                                                                                                                         |
| Apply                            | ONE undo step, like any other canvas change                                                                                                                                     |
| Old rollback rows in storage     | Dropped on read: they were traces with no snapshot and were already unusable                                                                                                    |

Filing (`folderId`), parameter values, marketplace provenance and the revision
line belong to the workflow, not to the version, so applying an old graph does
not un-file the workflow, wipe its inputs or roll its save sequence backwards.
Card positions and the viewport are view state and stay as they are. The
revision counter is bumped like any other content commit (so a stale AI repair
cannot be applied on top of restored content), but no version line is written.

## Implementation

- `workflows.versions.apply { workflow }` replaces `workflows.versions.rollback`.
  The background merges the snapshot's graph-owned fields onto the stored record
  (`applyVersionToStored`), bumps the revision (`manual-edit`), writes the
  workflow, reschedules triggers — and never calls the snapshot writer.
- `saveWorkflowVersionSnapshot` gains `baselineFingerprint`: the content on disk
  BEFORE the save. A save that writes it back unchanged creates no version
  (`isDuplicateFingerprint`). Without it, a save right after Apply would see the
  newer v5 line and manufacture a duplicate v2 snapshot.
- `WorkflowVersionEntry` no longer carries `source` / `fromVersion` / `note`;
  `rollbackEntryOf` / `rollbackSourceDeleted` / `recordWorkflowRollback` are
  removed. `coerceVersionIndex` drops legacy rollback rows on read.
- Editor `applyVersionSnapshot`: restores content + edge styling, keeps card
  positions, marks the canvas saved after the switch, and keeps it marked
  unsaved if the switch failed.
- Panel copy explains the new behaviour; no "rollback" wording remains.

Rejected alternatives:

- Keep the rollback row but hide it: the user explicitly said no rollback style;
  a hidden row would still occupy one of the 20 slots.
- Make Apply canvas-only (unsaved): a refresh silently lost the switch, and the
  next save would still have to decide whether it "changed" anything.
- Add a dedicated "apply" snapshot: defeats "no new version".

## Acceptance

| #    | Criterion                                                                                                                               | Method                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| AC-1 | Apply persists the version's content without appending an index entry                                                                   | code path + manual (list count unchanged) |
| AC-2 | Save after Apply with no edits creates no version (`baselineFingerprint` dedupe)                                                        | `tests/workflow-versions.spec.ts`         |
| AC-3 | Applying merges only graph-owned fields (name/description/trigger/settings/drawflow); revision/filing/parameter values/viewport survive | same                                      |
| AC-4 | Applied content fingerprints equal the version's snapshot (row shows Current)                                                           | same                                      |
| AC-5 | Legacy `source: 'rollback'` rows never surface again                                                                                    | read filter (`coerceVersionIndex`)        |
| AC-6 | No new UI copy is single-language                                                                                                       | `pnpm typecheck` + review                 |

## Manual check

1. Build, load the extension, open a workflow and save twice with one edit in
   between (two versions), then open 版本.
2. Click **Apply** on the older version. Expected: canvas switches to it; the
   list still has the same number of rows; that row now says 当前; no
   「回滚自」 row appears.
3. Close the panel, click Save without editing. Expected: save succeeds and the
   version count is still unchanged.
4. Edit one node, Save, reopen 版本. Expected: exactly one new version appears,
   marked 当前.
5. Reopen the editor (or reload the page). Expected: the workflow still shows
   the version applied in step 2 (or the newer save from step 4).
