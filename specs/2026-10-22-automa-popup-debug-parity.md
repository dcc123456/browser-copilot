# Automa popup and breakpoint-debug parity

## Why

Automa opens several block-property editors in modals and supports interactive breakpoint
stepping through `testingMode` + per-block `$breakpoint`. This project renders those editors
inline and has no pause machinery. The goal is to match Automa's interaction model without
importing the CDP-specific debug layers.

Reference source: `tmp/automa-src/automa-a4cbe34a60c92873c48c2470ca8ab1d96c22c7a0/`
(commit `a4cbe34a`).

## Popups

Automa's editors update the block live; their modals have no OK/Cancel footer and close via
X, Escape or backdrop. We use the existing `src/workflow-editor/ui/Modal.tsx` (the only
popup primitive in the repo) with the same live-update behaviour.

| Automa editor                         | Automa surface          | Our surface |
| ------------------------------------- | ----------------------- | ----------- |
| `EditWhileLoop.vue` (max-w-3xl)       | condition modal         | `lg` Modal  |
| `EditInsertData.vue`                  | row-list modal          | `lg` Modal  |
| `EditDataMapping.vue` (max-w-2xl)     | mapping modal           | `md` Modal  |
| `EditParameterPrompt.vue` (max-w-4xl) | parameter modal         | `xl` Modal  |
| `EditExecuteWorkflow.vue` (max-w-xl)  | global-data modal       | `md` Modal  |
| `EditWebhook.vue` (max-w-3xl)         | Body modal              | `lg` Modal  |
| `EditLoopData.vue` (max-w-3xl)        | custom-data modal       | `lg` Modal  |
| `EditGetText.vue`                     | flags popover           | `sm` Modal  |
| `EditRegexVariable.vue`               | flags popover           | `sm` Modal  |
| `EditTrigger.vue` (max-w-2xl)         | Workflow Triggers modal | `lg` Modal  |

There is no Popover primitive, so the two regex-flag surfaces use a small Modal. The
conversion is UI-only: block data keys do not change.

## Debug layers

Automa has three distinct layers; only the third is in scope.

1. Workflow `settings.debugMode` — CDP-based execution. This project already has the editor
   toggle and the `debug` run option; unchanged.
2. Per-block `settings.debugMode` — CDP simulation for form/click/key blocks. Out of scope
   (the user chose breakpoint stepping only).
3. `testingMode` + `$breakpoint` — interactive pause/resume/next/stop. Implemented here.

### Breakpoint semantics

- `$breakpoint` is stored in block data, so it saves and exports with the workflow.
- The worker pauses **before** executing the marked block.
- Resume continues; execution pauses again at the next breakpoint.
- Next executes the frozen block, then pauses before its successor even when the successor
  is not marked.
- Stop cancels the run (normal `cancelled` outcome).
- Testing mode requires saved data; the editor saves before running.
- Concurrent runs of the same workflow are refused while testing.
- The panel shows only this workflow's state.

### MV3 constraints

A paused run cannot survive service-worker eviction. The run holds keepalive while testing;
a pause auto-cancels after 8 minutes (below the existing 10-minute hold cap). If the worker
is evicted anyway, the editor sees the run disappear from `workflows.running` and reports it
as lost — there is no silent auto-resume.

## Multi-trigger storage

Automa stores `data.triggers = [{ id, type, data }]`. This project currently stores one flat
trigger on the trigger block plus a top-level `Workflow.trigger` mirror.

New shape:

- Trigger block: `data.triggers` is the source of truth.
- The first spec is the **primary**; its fields are mirrored to the legacy flat keys
  (`type`, `urlPattern`, `menuItemId`, `parameters`, …) and to `Workflow.trigger`, so old
  workflows, the workflows-list chip and the Runner keep working.
- Legacy workflows without `data.triggers` normalize to one spec built from the flat fields,
  then the top-level mirror.
- All enabled specs can fire in the extension (startup, shortcut, context menu, visit-web,
  element-change, schedule/interval alarms). Alarm names become
  `wftrigger:<workflowId>:<triggerId>`; the legacy `wftrigger:<workflowId>` name is still
  accepted and resolves to the primary.
- The Runner scheduler reads the primary mirror only; multi-trigger scheduling is an
  extension-only capability in this iteration.

## Block settings additions

- `blockTimeout` (General tab): 0 = unlimited. Enforced per attempt by the engine with an
  AbortController; a timeout fails the node through the normal retry/onError path.
- Lines tab: outgoing connections carry optional `label`, `animated`, `color`. They are
  persisted on `WorkflowEdge` and rendered by `CustomEdge`.
- The per-block CDP debug switch is deliberately omitted.
