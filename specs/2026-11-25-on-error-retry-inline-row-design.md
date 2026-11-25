# On-error retry: Times and Interval on one row — design

Date: 2026-11-25
Area: workflow-editor block settings modal (On error tab)

## Goal

In the operator node's settings dialog (hover toolbar → gear), the **On error**
tab has an "Enable" switch, then a "Retry the action" switch. With retry on,
the retry **Times** and **Interval** currently render as two stacked rows. They
must render **on one line** (same row), wrapping only when the dialog is too
narrow to fit both.

## Current facts

- The dialog is `BlockSettingsModal` → `OnErrorFields`
  (`src/workflow-editor/blocks/shared/BlockSettingsFields.tsx`).
- The two controls are `div.wf-inline-field` rows inside `div.wf-onerror-retry`.
- `editor.css` gives `.wf-onerror-retry` `display: flex; flex-direction: column`,
  and the second row carries `.wf-inline-field-indent { margin-left: 44px }`
  because it was designed as an indented second line.
- Modal width is 540px (`wf-modal-md`); the two fields total ~330px, so one row
  fits in every supported locale.

## Approach

- Drop the two pending classes from the JSX and style the wrapper with Tailwind
  utilities: `mt-2 flex flex-wrap items-center gap-x-4 gap-y-2` (AGENTS §2 — no
  new hand-written CSS classes).
- Remove `wf-inline-field-indent` from the Interval field; the indent exists
  only for the stacked layout.
- Delete the now-unused `.wf-onerror-retry` and `.wf-inline-field-indent` rules
  from `editor.css` (AGENTS §5.4 — dead code goes).
- `.wf-inline-field` itself is unchanged: each field still shows
  `label ⓘ [input] (seconds)`.
- No copy changes: `times` / `interval` / `seconds` already exist in `en` and
  `zh`.

Rejected alternatives:

- Adding `flex-row` next to the existing class: `.wf-onerror-retry` would still
  set `flex-direction: column`, and which wins depends on bundle order — a
  fragile layout.
- Making the whole tab a grid: the tab also contains the banner, switches and
  the behaviour select; only these two fields share a row.

## Acceptance

| #    | Criterion                                                                                                                                    | Method                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| AC-1 | With enable + retry on, Times and Interval render as siblings of ONE flex-row container                                                      | `tests/block-settings-on-error-row.spec.tsx` (jsdom structure) |
| AC-2 | With retry off, neither field renders (unchanged)                                                                                            | same test                                                      |
| AC-3 | zh labels 次数 / 间隔 still render, both in the same row container                                                                           | same test                                                      |
| AC-4 | The dialog still shows the previous rows (banner / Enable / Retry switch / behaviour select) and saving still writes the same `onError` keys | existing behaviour + manual check                              |

## Manual check

1. Build and load the unpacked extension; open a workflow and hover an operator
   node → gear → **On error** tab.
2. Turn **Enable** on and **Retry the action** on.
3. Expected: `Times ⓘ [input]` and `Interval ⓘ [input] seconds` sit on the same
   line; no 44px indent on the second one.
4. Toggle Retry off → both fields disappear; toggle on again → they return on
   one line.
5. Change both numbers, close the dialog, reopen it: the values persist.

## Verification

- `pnpm typecheck`, `pnpm test`, `pnpm lint` (changed files), `pnpm format:check`,
  `pnpm build`.
- Live browser check is manual (no extension host in this environment).
