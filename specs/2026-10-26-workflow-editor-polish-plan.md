# Workflow editor polish — plan (2026-10-26)

Eight editor issues reported by the user. One (data table) was a question about an
existing capability; its scope was decided by dialog: add an explanation panel, not a
new operator.

## Decisions

- **Recording**: stopping a recording appends its steps to the CURRENT canvas instead of
  opening a new workflow. If the current graph has exactly one node without an outgoing
  edge, the first recorded step is wired after it; otherwise the recorded row is placed
  to the right, unconnected. The recorded workflow is not persisted separately.
- **Workflow ID copy**: editor left sidebar header only.
- **Data table**: no new operator. Add an editor "Data table" panel that explains the
  run-scoped `dataTable` variable, lists the workflow's writers/readers and the columns
  it writes, and jumps to the corresponding node.

## Evidence

- Save button renders only `saving`; `dirty` is cleared in `App.tsx:771` and is otherwise
  used for close guards. Sidebar header already draws a dirty dot
  (`sidebar/WorkflowSidebarHeader.tsx:56-61`).
- Recording stop persists a brand-new workflow and reloads the editor
  (`App.tsx:1107-1116`; `background/record-controller.ts:103-133`;
  `lib/workflow/record-convert.ts:40-114`). No append path exists.
- No workflow id is shown in the editor; the sidebar header shows name + dirty dot only.
- "数据表" is the runtime variable `variables.dataTable`, written by `saveData` operators
  (`executors.ts:486-580`) and read by export/loop/sort/delete/mapping. There is no
  standalone operator or table schema; the palette search matches descriptions of the
  insert/delete/mapping operators.
- Zoom row and minimap are both bottom-right (`toolbar/CanvasControls.tsx:134-143`;
  `editor.css:407-424`, minimap default 200×150 + 15px margin), so they overlap.
- Auto-layout packs rows to the full canvas width and calls `fitView` over the full
  canvas (`App.tsx:1129-1159`); the left sidebar is an absolute overlay
  (`editor.css:508-526`), so its width is invisible to both.
- Undo is keyboard-only and has no redo (`App.tsx:347-366`; `graph-history.ts`).
- Toast stack sits at bottom-center 20px (`editor.css:903-913`), which the new bottom
  toolbar would cover.
- Clipboard: the manifest grants `clipboardRead` only (`scripts/manifest-shared.ts:100`).
  A page-side `navigator.clipboard.writeText` call was observed to be invoked and then
  never settle; the background channel (`driver.ts` offscreen document) writes without a
  focused document, which `clipboardWrite` would be needed for. Chosen route: a hidden
  textarea + `document.execCommand('copy')` inside the click gesture — no permission, no
  async round-trip; the promise rejects visibly if the browser refuses.

## Implementation

1. `TopToolbar`: `dirty` prop + red dot on the Save button (bilingual title).
2. `record.stop` gains `save?: boolean` and returns the built workflow; `stopRecording`
   skips persistence when `save === false`. New pure helper
   `lib/workflow/record-append.ts` appends the recorded graph (trigger dropped, unique
   terminal auto-wired) and is unit-tested. The editor calls `fitView` on the new nodes.
3. `lib/clipboard.ts` (shared helper, gesture `execCommand` route) + a copy button in
   `WorkflowSidebarHeader`.
4. `workflow-editor/data-table-usage.ts` (pure) derives writers/readers/columns from the
   node graph; `ui/DataTablePanel.tsx` renders the explanation and usage; the top toolbar
   opens it.
5. `.wf-canvas-bottom-right` shifts left of the 200px minimap + margin.
6. `auto-layout.ts` gains a pure `viewportForBounds(bounds, size, leftInset, padding)`;
   the caller packs rows to `width - paletteWidth` and sets that viewport.
7. `graph-history.ts` gains pure `takeUndo` / `takeRedo`; App keeps a redo stack,
   clears it on new structural edits, adds Ctrl+Shift+Z / Ctrl+Y, and mounts
   `toolbar/BottomToolbar.tsx` (undo / redo / auto-layout) at bottom-center. Auto-layout
   leaves the top toolbar; toasts move up; the debug bar moves above the new bar.

## Verification

- New unit tests: record append (connect vs no-connect), viewport fit, undo/redo rules,
  data-table usage derivation.
- Existing suite + typecheck + lint + format + build.
- Real Chrome (Playwright + unpacked `dist`): save dot appears/clears; record stop appends
  nodes without opening a new window; ID copy writes the clipboard; zoom row no longer
  overlaps the minimap; auto-layout leaves nodes right of the sidebar; bottom bar
  undo/redo works; data-table panel lists usage.

## Out of scope

- A standalone data-table operator, column schema editor, or live table viewer.
- Refactoring the three pre-existing clipboard call sites to the new helper.
