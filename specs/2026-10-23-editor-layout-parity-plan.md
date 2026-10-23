# Editor layout parity with Automa (2026-10-23)

Reference: Automa commit `a4cbe34a60c92873c48c2470ca8ab1d96c22c7a0`,
`src/newtab/pages/workflows/[id].vue`,
`src/components/newtab/workflow/WorkflowDetailsCard.vue`,
`WorkflowBlockList.vue`, and `editor/EditorLocalActions.vue` (local clone
under `tmp/automa-src/`).

## Goal

Bring the workflow editor's information hierarchy closer to Automa without
changing the engine or the canvas semantics:

- Workflow icon/name/rename/dirty marker move from the top toolbar into the
  left sidebar header.
- The left sidebar gains a fixed block search above the scrolling palette.
- The top toolbar becomes an `Editor / Logs` tab group on the left and the
  action group on the right, ending in a labelled accent **Save**.
- The sidebar default widens from 320px to 360px.
- The run-logs modal grows from `md` to `xl` with a taller list.

## Deliberate deviations from Automa

| Automa                                              | This build                                                             | Why                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Toolbar is an absolute overlay above the canvas     | Toolbar stays an in-flow row                                           | User decision; avoids the canvas content sliding under the toolbar on short windows                       |
| Logs is a main-panel tab                            | Logs stays a modal, enlarged to `xl`                                   | The run/log viewer already works as a modal and stacks with the run-detail modal; no new tab shell needed |
| Sidebar min width 360px                             | Default 360px, minimum stays 220px                                     | Narrow windows remain usable; drag-resize is an existing affordance                                       |
| Header shows name + description                     | Header shows name, icon, rename and dirty marker only                  | Description is not part of the accepted alignment scope                                                   |
| Hiding the sidebar hides the name (same in Automa)  | Same                                                                   | Parity; reopening the palette restores rename access                                                      |
| Search matches the localized block name (substring) | Search matches localized name/description plus raw name/id (substring) | Same interaction, but ids keep working when a user searches in the other language                         |

## Upload source

`upload-file`'s four source modes (`user-select`, `workflow-file`,
`latest-download`, `file-path`) now use the shared `Select` component, exactly
like `parse-excel`. Stored values are unchanged, so existing workflows load
without migration.

## New component

`src/workflow-editor/sidebar/WorkflowSidebarHeader.tsx` owns the workflow title
and rename dialog. It is split out of `TopToolbar` because the title now lives
in a different surface and the rename flow is independently testable. The
rename modal markup and behaviour are unchanged.

## Layout mechanics

- The palette root is a flex column: fixed search row, then a
  `min-h-0 flex-1 overflow-y-auto` list. The old `.wf-sidebar-scroll` helper is
  removed with its last consumer.
- `.wf-edit-overlay` remains a direct child of `Sidebar`, so opening a block
  form still covers the header, search and palette (Automa replaces the whole
  left panel).
- The left width storage key becomes `bc.editor.paletteWidth.v2`: the old key
  held the previous 320px default, so keeping it would leave existing installs
  on the old layout. The reset happens once; later drags persist under the new
  key.
- All new styles are Tailwind utilities over semantic tokens. Only dead CSS
  rules are removed; no new hand-written classes.

## Verification

- Component tests: the upload source is one four-option dropdown (the shared
  selector control's find-by dropdown is the form's other `<select>`); palette
  search filters to a flat grid and shows the empty state; the sidebar header
  renames and marks dirty.
- `tests/editor-i18n.spec.ts` keeps en/zh key parity for `searchBlocks`.
- Playwright probe against unpacked `dist/`: sidebar width, header/search,
  overlay coverage, upload dropdown, `xl` logs modal, rename + save round trip.
