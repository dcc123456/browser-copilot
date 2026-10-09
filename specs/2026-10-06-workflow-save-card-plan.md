# Workflow generation card: opt-in verification, grouped details, upload-file folding

Date: 2026-10-06 · Area: sidepanel save card, generation save path, loop folding · Branch: develop

## Problem

Three reports about workflow-generation mode, all confirmed in code before touching it:

1. **The "保存后验证运行 / Verify run after save" checkbox was advisory only.** The card
   honoured it for the explicit debug run (`ChatTab.persistPromptWorkflow`), but
   `workflows.save` in the background replayed every generated workflow anyway:
   `if (command.fromGeneration) void recordGenerationTrial(...)`
   (`src/background/index.ts`). The only opt-out was the per-workflow
   `settings.trialRun === false` — a different, persisted thing the checkbox never set.
   So an unchecked box still meant "the browser went and ran my workflow".
2. **The save-card popup was one flat stack.** Roughly a dozen sibling groups
   (warnings, selector probe, repair, integrity, runnability, stages, declared inputs,
   code nodes, AI step selection, fold suggestions, checkbox, actions) rendered with the
   same weight, so the card's own actions were buried under its diagnostics.
3. **`upload-file` offered loop folds.** Folding is a denylist
   (`src/lib/workflow/loop-collapse.ts`): everything except `trigger`, `repeat-task`,
   `loop-elements` and `javascript-code` could be folded.

## Decisions

- **Gating scope: the checkbox path only.** Three sites start a trial: the panel save
  command, the unattended bridge (`workflow-generation-bridge.ts`, `generate_workflow`)
  and the `compose_workflow` tool. The latter two belong to turns with no card and no
  checkbox; their trial is the agent's own evidence, so it stays. Interactive workflow
  mode never reaches them — `agent.ts` instructs the model to end its turn and
  `compose_workflow` is only released for an approved multi-workflow plan split.
  `hardenWorkflowSelectors` (a read-only page probe that writes verified selectors and
  element waits) stays ungated: it executes nothing.
- **Carry the flag, don't reuse `settings.trialRun`.** `settings.trialRun` is persisted on
  the workflow, so writing `false` there would keep future regenerations of the same
  workflow silent even after the user opts back in. A transient `verifyRun` on the command
  states exactly one thing: _this_ save was not asked to be verified. When it is absent, no
  record is written at all, and the health card reports the workflow as unverified — the
  truth, rather than a stored "skipped by settings" verdict.
- **Group headers must not hide severity.** A folded group is a collapsed `<details>`, not
  a removed one: the header carries the row count and, for the diagnostics group, a
  warn/err triangle. Folding the details never hides the fact that something needs
  attention. The headline, trigger picker, live "checking selectors…" status, the verify
  checkbox and the action row stay permanently visible — the card's consequential choice
  is never behind a fold.
- **New file `src/sidepanel/components/CardSection.tsx`** (AGENTS.md §5.3 note): the card
  needs the same collapsed-group primitive three times, and the portal dialogs already
  hand-rolled `<details>` twice (`WorkflowGenerationDialog`, `ThinkBlock`). One component
  with Tailwind semantic tokens only; no new styling infrastructure.

## upload-file is never foldable

A fold rewrites the body's _selector_ per iteration (`{{loopElementSelector}}`); it never
rewrites the payload. For `upload-file` the payload IS the point — `files` / `fileVariable`
/ a file the user picks — so folding N recorded uploads replays one file N times. In
`user-select` mode it would additionally demand N modal picker interactions from a loop
whose purpose is to run unattended. Added to `NEVER_FOLD_BLOCKS`, which is the single
choke point used by all three detectors (same-block runs, compound period head, compound
body), so no suggestion path can bypass it.

## Evidence

- `tests/chat-save-dialog.spec.tsx`: the save command carries `verifyRun: false` unless the
  box is checked, and `true` when it is; the card's detail groups render closed with a
  count in the header, and the checkbox plus actions stay outside them.
- `tests/loop-collapse.spec.ts`: identical and varying `upload-file` runs offer no fold.
- Gates: `pnpm typecheck` (src + tests) clean, `pnpm test` 3831 passed / 335 files,
  `pnpm build` clean, `eslint` + `prettier --check` clean for every file touched here.
- **BLOCKED**: the live side-panel popup. Nothing in this repo drives the panel —
  `pnpm selftest` exercises the background chain, not this surface. Manual check: build,
  load `dist/` unpacked, finish a workflow-generation turn, and confirm (a) with the box
  unchecked the saved workflow is never replayed and its health card reads unverified,
  (b) the popup opens as collapsed category headers, (c) a recorded pair of uploads offers
  no "fold into loop" row.
- Pre-existing, untouched here: repo-wide `pnpm lint` and `pnpm format:check` already fail
  on develop (`tmp/` scratch scripts plus drift in files this change does not modify).
