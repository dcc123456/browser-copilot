# Code-node helper help — design

## Problem

The `javascript-code` block's settings modal lists five "available functions" as
plain external links:

```
automaNextBlock(data, insert?)
automaRefData(keyword, path?)
automaSetVariable(name, value)
automaFetch(type, resource)
automaResetTimeout()
```

Two of those entries are wrong:

- `automaFetch(type, resource)` exists in **none** of the four execution
  paths (`src/inpage/kernel.ts`, `src/background/driver.ts` → kernel,
  `src/background/workflow-engine/executors.ts` local fallback,
  `server/src/executors.ts` local fallback). A script that calls it fails with
  `automaFetch is not defined`.
- `automaNextBlock(data, insert?)` advertises an `insert` argument that every
  harness ignores.

The entries also give no explanation of what each helper does or when to use
it, and the `variables` object (exposed by every harness and offered by the
editor's autocomplete) is not documented in the editor at all.

## Audit — what the harnesses actually expose

| Helper                           | Page harness (`kernel.ts` `runWorkflowJs`)                                        | Extension local fallback                                | Runner local fallback       |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------- |
| `automaNextBlock(data?)`         | yes                                                                               | yes                                                     | yes                         |
| `automaSetVariable(name, value)` | yes                                                                               | yes                                                     | yes                         |
| `automaRefData(keyword, path?)`  | yes (`variables`, `table`, `loopData`, `prevBlockData`, `globalData`, `workflow`) | yes (same minus `workflow`)                             | yes (same minus `workflow`) |
| `automaResetTimeout()`           | yes — re-arms the timer                                                           | no-op (runs to completion; timeout is a `Promise.race`) | no-op                       |
| `variables`                      | yes                                                                               | yes                                                     | yes                         |
| `automaFetch(type, resource)`    | **no**                                                                            | **no**                                                  | **no**                      |

Decision: the editor advertises **only** what runs. `automaFetch` is removed
(implementing it would need a new page↔worker network bridge in three mirrored
harnesses, which is a different feature); `automaNextBlock`'s signature drops
the non-existent `insert` argument. `automaResetTimeout` stays because the
real page path implements it; the local fallbacks keep it as a harmless no-op.

`src/workflow-editor/blocks/batchA/EditCreateElement.tsx` also advertises
`automaExecWorkflow(options)` for its embedded script tab. That is a separate
node and out of scope here; it is recorded as a known issue, not changed.

## Single source of truth

New module `src/lib/workflow/code-node-helpers.ts` (chrome-free) exports
`CODE_NODE_HELPERS`: one entry per advertised helper with

- `name` / `signature` / `kind` (`function` | `object`)
- `hint` — one-line autocomplete detail
- `what` — what it does
- `when` — when to use it
- `snippet` — CodeMirror insertion template

English is the source for the editor's `bt()` translator; zh-CN lives in
`BLOCK_FORM_STRINGS.zh` (`src/workflow-editor/i18n.ts`), alongside the other
block-form copy. Both editor surfaces read the same list:

- `EditJavascriptCode` renders the help chips.
- `CodeEditor` generates the JavaScript autocomplete entries, removing the
  second hard-coded list that could drift from the editor.

No new i18n mechanism, no duplicate helper table.

## UI — icon + bubble

New `src/workflow-editor/ui/HelperTip.tsx`: a chip (Info icon + signature,
monospace, Tailwind semantic tokens) toggles an anchored bubble that shows

- the signature,
- **What it does**,
- **When to use it**.

The bubble is a disclosure (`aria-expanded` / `aria-controls`), closes on a
second click or a pointer-down outside the chip, and only one stays open at a
time because opening another chip is an outside click for the first. Styling is
all Tailwind utilities over the existing design tokens (`bg-sunken`,
`bg-panel`, `border-border`, `text-ink`, `text-muted`, `text-accent`,
`hover:bg-hover`); the obsolete `.wf-code-chip*` CSS rules are deleted.

The help row wraps instead of scrolling horizontally, so the bubble is never
clipped by an `overflow-x` container. The JS-code modal is `xl`
(max-width 1120px), leaving room for a 320px bubble anchored to any chip.

## Verification

1. **Catalogue parity (page harness)** — `tests/code-node-helper-contract.spec.tsx`
   runs a probe for every advertised name through `runWorkflowJs`; the probe
   table must cover the catalogue exactly, so adding an entry without a probe
   fails. A timing probe proves `automaResetTimeout` actually re-arms the page
   timer.
2. **Catalogue parity (extension local fallback)** — the same probe table runs
   through `EXECUTORS['javascript-code']` with no page bridge.
3. **Catalogue parity (Runner)** — the same probes run through the Runner's
   `javascript-code` executor in `server/test/executors.test.ts`.
4. **UI** — `tests/code-node-helper-help.spec.tsx` clicks a chip, asserts the
   what/when copy appears and that outside click / second click closes it, and
   asserts every English source string has a zh translation.

The page-harness probes prove the helpers are defined and behave as documented
at runtime; the reset timing probe proves the one helper whose effect is not
just "returns a value". Real-browser loading of the unpacked extension remains
the manual acceptance step.

## Manual acceptance

1. `pnpm build`, load `dist/` as an unpacked extension, open the workflow editor.
2. Add **JavaScript code**, open its settings, click the code preview to open the
   modal.
3. Click each Info chip: a bubble shows the signature, "What it does" and
   "When to use it"; only one bubble is open at a time; clicking elsewhere closes
   it.
4. Confirm `automaFetch` is no longer listed and `automaNextBlock` shows
   `automaNextBlock(data?)`.
5. Switch the extension language to zh-CN and repeat: every bubble is in Chinese.
6. Run a workflow whose code block calls `automaResetTimeout()` inside a long
   `await` loop: the block completes instead of timing out.

## Rejected alternatives

- **Implement `automaFetch`.** Requires a page→background fetch proxy plus
  matching implementations in the Runner; it is new infrastructure, not a help
  text fix. Removed instead.
- **Keep external Automa doc links as the help.** The upstream docs describe
  `insert` and `automaFetch`, which do not exist here, so the links would keep
  advertising unusable API.
- **Inline expanding text instead of a bubble.** The user asked for
  icon + bubble; inline text would also push the editor out of the fixed-height
  modal.
