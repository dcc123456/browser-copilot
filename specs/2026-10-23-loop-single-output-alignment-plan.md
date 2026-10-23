# Loop Data / Loop Elements single-output alignment (2026-10-23)

Reference: Automa commit `a4cbe34a60c92873c48c2470ca8ab1d96c22c7a0`, local
clone under `tmp/automa-src/`:

- `src/utils/shared.js:798` (`loop-data`), `:837` (`loop-elements`), `:872`
  (`loop-breakpoint`) — both loop blocks declare `outputs: 1`.
- `src/workflowEngine/blocksHandler/handlerLoopData.js:133-136` — loop-data
  returns exactly one continuation, `{ nextBlockId: this.getBlockConnections(id) }`.
- `src/workflowEngine/blocksHandler/handlerLoopBreakpoint.js:21-25` — with items
  left, the breakpoint jumps back to `currentLoop.blockId`.
  `:71-78` — on exhaustion or `clearLoop` ("Stop loop") it deletes the loop
  state and follows **its own** output, `this.getBlockConnections(block.id)`.
- `src/workflowEngine/blocksHandler/handlerRepeatTask.js` — `repeat-task` keeps
  two outputs; `handlerWhileLoop.js` keeps a true/fallback pair. The two-output
  shape is legitimate for those blocks and is left untouched.

## Goal

Make `loop-data` and `loop-elements` draw one output, exactly like Automa, and
move the "after the loop" path onto the `loop-breakpoint` block. The user's
decision: **full Automa alignment** — design + migration first, then engine,
generator/folding, and existing `output-2` wiring.

Target graph shape (linear, no drawn cycle):

```
trigger → loop-data ──output-1──→ body … → loop-breakpoint ──output-1──→ after-loop
```

A body can also end in an early `loop-breakpoint` (skip the rest of this item);
the breakpoint that ends the loop owns the after-loop path.

## Engine model

The engine keeps its inline interpreter: `loop-data` / `loop-elements` still
iterate internally, and `loop-breakpoint` still unwinds with
`LoopBreakpointError`. What changes is **where the loop continues afterwards**:

1. `LoopBreakpointError` gains the throwing node's id. `runLoopBody` records the
   breakpoint's out-edge as the loop's exit target every time a breakpoint
   owned by this loop fires.
2. `clearLoop` ("Stop loop") exits through **that breakpoint's** out-edge
   (Automa `handlerLoopBreakpoint:71-78`), not through the loop node's old
   `output-2`.
3. Natural exhaustion exits through the last breakpoint reached during the run.
   A statically-resolved breakpoint in the body is the fallback when the body
   never ran (empty source) or never reached one.
4. Legacy `output-2` / `end` edges are still accepted at run time as a last
   fallback, so a workflow that was stored before this change keeps running
   even if it is executed without being re-saved. Nothing new writes that edge.

Static resolution walks the body from `output-1` and does not enter a nested
loop's body; a nested loop is treated as a single step from its body entry to
its own exit. Matching follows the existing ownership rule: a breakpoint with
no `loopId` belongs to the innermost loop; a non-empty `loopId` must equal the
loop's `loopId` or node id.

### Deliberate deviations

| Automa                                                                      | This build                                                                                                                 | Why                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Only a breakpoint advances the loop; a body path that skips it ends the run | The interpreter advances to the next item anyway, and exits through the breakpoint's out-edge when the source is exhausted | Inline iteration is our engine's existing model; well-formed bodies (and every migrated/folded one) always reach the breakpoint |
| An empty source enters the body once with `undefined`                       | An empty source runs the body zero times, then follows the breakpoint exit                                                 | Existing behaviour; safer than running a body against missing data                                                              |
| `loopId` is required; the breakpoint fails without it                       | Empty `loopId` means the innermost loop                                                                                    | Existing engine rule, used by hand-wired graphs                                                                                 |
| `repeat-task` / `while-loop` two outputs                                    | Unchanged                                                                                                                  | Automa itself declares two outputs for these blocks; only Loop Data / Loop Elements are single-output                           |

## Canvas ports

`src/lib/workflow/block-ports.ts` stops declaring branch handles for
`loop-data` and `loop-elements`; they fall through to the single default
`<blockId>-output-1` handle, with no "loop"/"end" labels — the same unlabelled
single handle Automa renders. `while-loop` and `repeat-task` keep their two
handles. Because a handle id is a stored edge endpoint, the load-time healer
would re-anchor an old `output-2` edge to `output-1`; migration runs first
(editor load and `saveWorkflow`), so no old edge reaches the healer unchanged.

## Migration / normalization

Implemented inside `migrateWorkflow` (runs on load and on every save), so it
covers stored workflows, imports, generation, repair and folding in one place.
For each `loop-data` / `loop-elements` node:

1. Take its `output-2` / bare `end` out-edges as the old after-loop target.
2. Collect the body's tails: nodes reachable from `output-1` that have no
   outgoing edge or that are themselves a `loop-breakpoint` (a breakpoint ends
   the body — its out-edge is the after-loop path, so the walk does not continue
   through it). The old after-loop edge and edges back into the loop node are
   ignored.
3. If a tail is already a `loop-breakpoint`, reuse it as the exit; otherwise
   insert one `loop-breakpoint` node (empty `loopId` unless the loop has one,
   `clearLoop: false`) after the body and connect every tail to it.
4. Re-source the old after-loop edge from the breakpoint's `output-1`. A
   continuation the reused breakpoint already has wins: the old edge is dropped
   instead of overwriting it.
5. Remove legacy back-edges from body nodes into the loop node (the old folded
   cycle), so the graph is linear like Automa's.
6. A loop with an after-loop edge but no body edge gets
   `loop → breakpoint → after-loop`: the breakpoint is then the whole body, so
   the loop still iterates the source (doing nothing) before continuing.

The rewrite is idempotent: after step 4 the loop no longer has an after-loop
edge, so a second pass does nothing. Inserted nodes carry the loop node's
existing `loopId` when it has one; no new ids are invented on the loop itself.
`loopBreakpointPosition` (exported from `loop-collapse`, shared with the fold)
places the node one cell right of the body tail, or one row below when a node
already occupies that spot — the migrated graph is read in the editor, so the
breakpoint must not be dropped on top of the existing after-loop node.

## Folding (`loop-collapse`)

`loop-elements` folds now emit the linear shape directly:
`loop → body head … body tail → inserted loop-breakpoint → successor`. The old
back-edge to the loop is gone, and the breakpoint is placed with
`loopBreakpointPosition` (clear of the run's successor). `chainOf` walks the
breakpoint as the end of the body and continues along its after-loop edge, while
marking everything from the loop to that breakpoint as body so no detector folds
inside it; the cycle handling stays for `repeat-task` only. `repeat-task`
folding is unchanged.

`foldDraftRun` re-anchors the draft's append tail onto the inserted breakpoint
when the folded run used to be the tail — chaining onto the loop node itself
would append into the body instead of after the loop.

## Generation

No prompt change: the model still emits loops as it does today, and a
model-supplied `next: 'end'` on a loop becomes a stored `output-2` edge that
save-time migration converts into the breakpoint path. `loop-breakpoint` stays
outside the model's operator set (`NON_OPERATOR_BLOCK_IDS`): the structure is
inserted deterministically, not generated. A loop that deliberately has no
after-loop path stays single-output with no breakpoint; when its source is
exhausted the run ends there, which is the old behaviour for a loop without
`output-2`.

## Tests

- Ports: Loop Data / Loop Elements expose only `output-1`.
- Migration (`tests/loop-exit-migrate.spec.ts`): `output-2` rewired through an
  inserted breakpoint; body tails and legacy back-edges handled; bodyless loop;
  idempotence; reused breakpoint; an existing breakpoint continuation wins;
  collision-free placement.
- Engine (`tests/workflow-phase4.spec.ts`): natural exhaustion and `clearLoop`
  follow the breakpoint's out-edge; a body that never reaches the breakpoint
  still exits through the static one; empty source exits through it; legacy
  `output-2` graphs still run; nested loops keep innermost ownership.
- Folding (`tests/loop-collapse.spec.ts`): loop-elements produces the
  breakpoint and no cycle; detection after a fold still walks the after-loop
  tail and never folds inside the body; placement clears existing nodes.
- Round-trip fixture: `loop-data` / `loop-elements` no longer expected to render
  `output-2`.

## Verification

- `pnpm typecheck`, `TZ=UTC pnpm test` (434 files / 5052 tests), scoped
  `eslint` (0 errors; only pre-existing warnings), `prettier --check`,
  `pnpm build`, `pnpm server:typecheck`, `pnpm server:test`, `pnpm bench:debug`.
- Real browser (Playwright, unpacked `dist/`, `tmp/loop-single-output-probe.mjs`):
  seeded one legacy `loop-data` and one legacy `loop-elements` workflow with a
  folded cycle and an `output-2` after-loop edge. 24/24 assertions passed:
  - each loop node draws exactly one source handle;
  - a Loop Breakpoint node appears, clear of the existing nodes;
  - the after-loop node is still on the canvas and the canvas renders 4 edges;
  - Save persists the breakpoint with `loopId: ""` / `clearLoop: false`, the
    after-loop edge leaves `loop-breakpoint-output-1`, no `output-2` edge
    survives, the back-edge into the loop is gone;
  - reopening and saving again adds no node or edge (idempotent).
    Screenshots: `tmp/loop-single-output-data.png`,
    `tmp/loop-single-output-elements.png`.
