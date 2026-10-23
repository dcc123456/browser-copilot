# Operator parity + multi-variable plan (2026-10-22)

Source of truth for Automa behaviour: `automa` commit
`a4cbe34a60c92873c48c2470ca8ab1d96c22c7a0`, files downloaded under
`tmp/automa-ref/` (`handlerLoopData.js`, `handlerWhileLoop.js`,
`handlerRepeatTask.js`, `handlerLoopBreakpoint.js`, `handlerWebhook.js`,
`webhookUtil.js`, edit/canvas components). No documentation prose was used
where the source was available.

## 1. `workflow-file` naming

The option means **a file produced by an earlier step and stored in a workflow
variable** — a screenshot, a generated image, an upload artifact — never the
workflow JSON and never a local path.

- UI label: `File from an earlier step` / `上游步骤产出的文件`.
- Field label: `Variable holding the file` / `存放文件的变量`.
- An inline explanation states the variable-name contract and names the common
  producers.
- The internal value `workflow-file` and the `fileVariable` key are unchanged,
  so saved workflows keep loading.

## 2. `set-variable` — many variables in one node

New shape:

```jsonc
{
  "variables": [
    { "name": "token", "value": "{{otp}}" },
    { "name": "at", "value": "..." },
  ],
}
```

- Executor precedence: rows from `variables` (non-empty `name`); when that
  array is absent/empty, the legacy `variableName` + `value` pair. Rows with an
  empty name are skipped. An empty value is legal (clearing a variable).
- The editor starts from the legacy pair when the array is empty, so opening an
  old node shows its existing assignment; the first edit writes `variables` and
  blanks the legacy keys so they can never shadow the new shape.
- Catalog default stays `variables: []` (not a seeded row): a catalog default
  row would be merged into migrated nodes and hide their legacy values
  (`project-catalog-defaults-poison-migrations`).
- Requirements accept either shape. `schemaRequired` advertises `variables` to
  the model, while the run/record gate still accepts legacy nodes.
- `producedVariableNames`, `data-params` and provenance read every row name.

## 3. Automa parity audit

### 3.1 `loop-data`

| Automa capability                                                                         | Current build                                       | Decision                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `numbers`, `data-columns`/`table`, `custom-data`, `variable`, `elements`, `google-sheets` | all six visible; google-sheets errors without OAuth | keep                                                                                                                                                                                                                                             |
| Nested variable paths (`objectPath.get`)                                                  | only top-level                                      | use shared `getByPath`                                                                                                                                                                                                                           |
| Variable coercion: array as-is, JSON string parsed, string → chars, number → `1..N`       | string → one item, number → one item                | match Automa                                                                                                                                                                                                                                     |
| Invalid non-array data → `invalid-loop-data`                                              | object wrapped into one item                        | fail loudly                                                                                                                                                                                                                                      |
| `startIndex`                                                                              | stored/ignored                                      | skip the ordered items (ignored by `numbers`, like Automa)                                                                                                                                                                                       |
| `resumeLastWorkflow`                                                                      | stored/ignored                                      | host-injected `LoopProgressStore`; load at start, save per iteration, clear on completion. Extension: `chrome.storage.local` (`loopProgress:` prefix). Runner: one in-memory `Map` per service, matching Automa's process-lifetime localStorage. |
| `reverseLoop`                                                                             | applied to data arrays only                         | apply to every non-numbers mode except `elements` (Automa explicitly excludes elements)                                                                                                                                                          |
| `maxLoop`                                                                                 | caps data arrays                                    | cap elements too; ignored by `numbers` (Automa's range is the whole loop)                                                                                                                                                                        |
| Elements `waitForSelector` / `waitSelectorTimeout`                                        | form fields, ignored                                | poll the element count before looping                                                                                                                                                                                                            |
| Elements XPath selector                                                                   | kernel `safeQuery` is CSS-only                      | accept Automa's `isXPath` shape (`[`, `(`, `/`, `@`, `id(` prefixes, plus `xpath:`) in `safeQuery`; `KERNEL_VERSION` 5                                                                                                                           |
| Custom-data JSON/CSV import                                                               | JSON textarea only                                  | import JSON/CSV/XLSX in the form using the existing spreadsheet parser; a JSON object is wrapped in an array                                                                                                                                     |

Ordering decision: reverse first, then `startIndex`, then `maxLoop` — Automa's
source applies `startIndex` before reversing, which makes the two knobs
interact in a way no user can predict. The capability set is identical; the
order is the predictable one. This is a documented deviation, not a missing
feature.

Google Sheets remains an explicit error: this build ships no Sheets
integration/OAuth, so pretending the loop works would be worse than saying so.

### 3.2 `repeat-task`

- Add the missing edit form (Automa edits `repeatFor` on the canvas; this build
  had only the generic key/value editor). The executor already accepts both
  `count` and `repeatFor`.
- Deliberate deviation: `repeatFor = 0` performs zero iterations. Automa's
  handler runs once because its first comparison is against `undefined`; that
  is a bug, not a capability.

### 3.3 `while-loop`

The condition builder already supports value, code, data-exists,
element-exists and visibility items, and the engine evaluates per iteration.
No capability gap found; no change beyond regression tests.

### 3.4 `loop-breakpoint`

Automa semantics:

- default: **continue** — abandon the rest of the body and re-enter the loop
  for the next item;
- `clearLoop` (labelled “Stop loop”): clear the loop state and leave the loop;
- when the loop has no next item (or max is reached), leave the loop.

Current build always leaves the loop, which is inverted. Decision:

- `LoopBreakpointError` carries `clearLoop`.
- The owning loop translates it to `continue` (next iteration, or exit when
  none remains) or `end` when `clearLoop` is set.
- `clearLoop` also clears the saved `resumeLastWorkflow` index (the loop-data
  branch clears it on `'end'`; a failure keeps it so the run can resume).
- The breakpoint gets an edit form (loop id + “Stop loop”) instead of relying
  on the generic editor.
- Element pagination (`loadMoreAction`) belongs to the separate
  `loop-elements` block in this build and is out of scope for the five named
  operators.

### 3.5 `webhook`

Automa capabilities missing here:

- headers are `{name,value}[]` (the form writes this; the executor only parsed a
  JSON string);
- content types `text`, `json`, `form`, `form-data` (JSON parse, URLSearchParams,
  FormData; no body for GET/HEAD; no manual Content-Type for form-data);
- URL must be `http(s)`;
- non-2xx → fallback output when wired, otherwise fail with status;
- network/timeout → fallback when wired;
- `assignVariable` stores the decoded/data-path-narrowed value;
- `saveData` writes to the data table (`$assignColumns` = append object rows);
- `$response` in `dataPath` exposes `{ok,url,status,statusText,redirected,data}`;
- the legacy `headers` JSON-string object (not just the row array) still works.

Decision: move request building and response decoding into
`src/lib/workflow/webhook.ts` (chrome-free, used by both executors) so the
extension and Runner cannot drift. Keep the existing `lastHttpResponse` record
assignment as a compatibility layer, and additionally write the decoded value
to `variableName` when `assignVariable` is on. `base64` keeps returning the raw
base64 string in `record.body` (existing contract); no capability is lost.

Deliberate deviation: Automa's `form-data` accepts local file paths through its
extension file API; this build only fetches http(s)/data URLs (no workflow may
read an arbitrary local path). Plain field values are still sent as text, and a
third array element still supplies the filename. The editor stores the body as
the same 2-D JSON array Automa documents.

### 3.6 Run preflight

The browser probe exposed two run-gate requirements that were stricter than the
engine and refused working loops:

- `loop-data` demanded `loopData` no matter which source was selected, so a
  correctly configured **elements** loop (selector only) or **variable** loop
  (variable name only) stopped before the first node. The gate now branches on
  `loopThrough`: `elements` → `elementSelector`, `variable` → `variableName`,
  `custom-data` → `loopData`; `numbers`, table sources and `google-sheets` have
  no statically required field (defaults / runtime data / a clear runtime
  error). This also stops an empty table loop from being blocked.
- `while-loop` demanded `code`, but the editor stores a condition tree on
  `conditions`. The gate now accepts either through the shared
  `hasConditionsContent` predicate.

Both fixes live in `src/lib/workflow/block-requirements.ts`, so the record and
run gates see the same rules; the Runner has no separate preflight.

## 4. Tests / acceptance

- Unit: multi-variable executor (extension + Runner), legacy fallback,
  requirements/schema; loop modes (variable coercion, startIndex/resume,
  elements options), breakpoint continue/clear; webhook headers array, all
  content types, fallback, `$response`, assign/save.
- Preflight unit cases: elements / variable / custom-data / table / numbers
  `loop-data`, and `while-loop` with a condition tree instead of `code`.
- Gates: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`,
  `pnpm build`, `pnpm server:typecheck`, `pnpm server:test`,
  `pnpm bench:debug`, `pnpm verify:injected` (kernel XPath change).
- Browser evidence (`tmp/operator-parity-probe.mjs`, artifact under
  `tmp/operator-parity-probe/`): loads the unpacked `dist/` build and proves
  `set-variable` row order, webhook request/`dataPath` response, an XPath
  elements loop with three distinct element selectors, breakpoint
  continue (body 3×, end 1×) versus stop (body 1×, end 1×), and the zh-CN copy
  for the renamed file source, the row editor and the breakpoint form.
