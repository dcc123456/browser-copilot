# Operator AI change-diff modal design (2026-11-18)

## Goal

In the workflow editor's AI assistant (`OperatorChatDock`), the in-place fix
evidence line ("Changed: url: ... → ...") is truncated and read-only. Make it
clickable; the click opens a modal that shows the complete change. Code-valued
parameters are rendered as a git-diff-style line comparison (removed/added
lines, context, line numbers), not as one flattened JSON string.

## Scope decisions

- The "AI 助手" here is the editor floating assistant, not the sidepanel
  workflow-generation card. `specs/2026-11-11-workflow-editor-improvements-design.md:165`
  explicitly identifies it, and only this surface already carries full
  before/after values (`OperatorParamChange[]`). The generation card's
  `GeneratedWorkflowRepairInfo` (`src/lib/messages.ts:75-97`) has no patch data,
  so extending it would require a new wire protocol and is out of scope.
- Data source is `landing.changed`, already handed to the dock by
  `applyNodeActionFromAi` (`src/workflow-editor/App.tsx:1786-1793`). Values are
  the real before/after; secret-named keys are `MASK` on both ends
  (`src/lib/workflow/operator-advise.ts:459-460`), so no new leak path is added.
- No persistence change: `hydrateTurns` deliberately drops `landing` after a
  reload because its Undo snapshot is stale
  (`src/workflow-editor/ai/OperatorChatDock.tsx:204-209`). The clickable evidence
  is part of that same landing row, so it lives and dies with it. Persisting a
  second copy of the change data would reintroduce the stale-snapshot problem.

## Selection and evidence

### Candidates

1. **Add the `diff` (jsdiff) package** and call `diffLines(old, new)`.
   - Evidence: npm package page documents `diffLines(oldStr, newStr[, options])`
     returning change objects with `value`, `added`, `removed`, `count`
     (<https://www.npmjs.com/package/diff>, version 9.0.0).
   - Rejected: the repository has no diff dependency
     (`package.json`, `pnpm-lock.yaml`, `node_modules`); adding one for a single
     read-only view grows the extension bundle and the supply-chain surface for
     an algorithm we can express in ~50 lines. `maxEditLength`/`timeout` also
     return `undefined`, which would need extra fallback handling anyway.
2. **Use an official CodeMirror diff/merge view.**
   - Evidence: CodeMirror's API reference lists `@codemirror/merge` as an
     official package, and documents `ChangeSet` plus view decorations/gutter
     markers as the building blocks (<https://codemirror.net/docs/ref/>).
   - Rejected: `@codemirror/merge` is not installed; the project already has
     CodeMirror 6 packages for _editing_ (`package.json:65-72`) but the change
     modal is read-only. Mounting two editors plus a merge view for a chat
     evidence row is disproportionate; plain `<pre>` lines with Tailwind tokens
     match the existing repair views (`src/sidepanel/RepairDialog.tsx:76-100`,
     `src/sidepanel/FailureCenter.tsx:128-205`).
3. **Pure local line diff + Tailwind-styled `<pre>` rows (chosen).**
   - Put an LCS-based `diffLines` helper in `src/lib/` (chrome-free, cross-end
     boundary per AGENTS.md §5.7), returning ordered rows with `kind` and
     old/new line numbers. Bound the matrix size so a huge pasted value cannot
     freeze the UI; above the bound, fall back to "all removed, then all added".
   - Render each changed parameter under its own `key` header with git-like
     `--- before` / `+++ after` markers, `-`/`+` prefixes, line numbers and
     semantic `text-err`/`text-ok` tokens. Non-code values go through the same
     formatter (JSON, indented), so structured parameters are readable too.
   - Modal uses the existing `src/workflow-editor/ui/Modal.tsx` (portal,
     backdrop + Escape close, `nodrag`), matching other editor dialogs.

### Local verification

- `src/lib/**` has no diff helper (grep for `diffLines|createPatch|LCS|unifiedDiff`:
  no matches), satisfying the reuse check in AGENTS.md §5.1.
- `landing.changed` is the only structured before/after data on this path;
  `patch.before` is consumed as the Undo snapshot and is never put on a turn.

## UX and i18n

- The existing evidence line becomes a button with a "View full changes" label;
  the truncated summary stays so the row is still informative at a glance.
- Modal title, column captions and empty-state copy go into
  `src/workflow-editor/i18n.ts` in both `en` and `zh` (flat camelCase keys near
  the other `operatorAi*` keys). Git's `---` / `+++` / `@@` markers and the
  parameter key names stay literal.
- Clicking opens the modal for the changes of that specific assistant answer;
  Escape, the X button and backdrop click all close it.

## Tests

- Pure helper: identical text, single insert/delete/replace, repeated lines,
  multiline code, empty sides, and the large-input fallback.
- Component (jsdom, same pattern as `tests/acceptance-operator-chat-dock.spec.tsx`):
  the evidence line is a button, clicking opens a dialog containing the full
  untruncated value and the `-`/`+` diff rows, and the dialog closes again.
