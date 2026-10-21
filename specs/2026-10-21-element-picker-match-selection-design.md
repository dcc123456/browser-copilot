# Element picker: choose which match

Date: 2026-10-21
Area: `inpage/element-picker`, `workflow-editor/blocks/shared`

## Problem

`build()` walks up at most six ancestors looking for a selector that matches
exactly one element. Repeated rows / cards / list items share the same ancestor
path and the same classes, so the walk never separates them: the picker shows
`Matches N elements` and commits that broad selector anyway.

Every executor then resolves a broad selector differently from what the user
aimed at:

- kernel `resolve` takes the first visible match of the first matching spec;
- `get-text` takes `nodes[0]` unless `multiple` is set;
- screenshots / OCR capture the first match.

Clicking the second row of a list can therefore silently act on the first row,
and the editor offers no way to say which row was meant.

## Decision

**Pin the committed selector to the exact match the user aimed at.** The match
stepper is only UI over that one operation; block data gains no new field.

When the short selector matches `N > 1` and the caller is picking a single
target:

1. The picker keeps the aimed element as the default match.
2. CSS mode: retry the ancestor walk with positional `:nth-of-type`
   qualifications on the repeated level; if that is still not unique, use an
   absolute `:nth-child` path from `body`/`html`. A unique XPath is already
   positional.
3. XPath mode: wrap the broad expression as `(expr)[n]` (1-based).
4. A `‹ n / N ›` stepper appears under the count; prev/next re-pins to another
   member of the same broad match set. The selector text and the committed
   result are always the pinned selector.

The selector string stays the single source of truth. Every consumer — the
kernel target resolver, `get-text`'s `querySelectorAll`, `loop-elements`,
screenshots — already does the right thing with a selector that matches one
element, so no executor or block-data migration is needed.

### All-match blocks opt out

Some selectors intentionally mean "every match". Those callers pass the
picker's existing `multiple: true` argument, which suppresses pinning and the
stepper and keeps the broad selector:

- `loop-elements` (iterates every match through `loopElementSelector`);
- `loop-data` with `loopThrough: 'elements'` (same engine path);
- any interaction block whose `multiple` option is checked (collect every match,
  e.g. `get-text`).

The first two expose a new `pickAllMatches` prop on `InteractionBase` /
`SelectorField` without changing block data.

## Rejected alternatives

- **Store `selectorIndex` in block data and append it as TargetSpec `nth`.**
  Several executors read `data.selector` directly (`get-text`, `read-page`,
  screenshots, `loop-elements`) instead of building a Target, so the index
  would have to be plumbed through every reader and could drift from the
  selector it belongs to. The selector string is already the cross-cutting
  contract.
- **CSS `:nth-child(An+B of S)`.** The `of S` form only counts siblings under
  one parent; a repeated pattern (e.g. one price per card) spans many parents,
  so the global Nth match is not expressible this way.
- **Make the stepper purely cosmetic and record the broad selector.** That is
  today's behavior and the reported bug.

## UX copy (en + zh-CN)

The picker's new copy is registered in its in-page `STRINGS` table (the page
world has no i18n module):

- `Match {n} of {N}` / `第 {n} / {N} 个匹配`
- `Previous match` / `上一个匹配`, `Next match` / `下一个匹配`
- `Matches {N} elements · using #{n}` / `匹配 {N} 个元素 · 使用第 {n} 个`

## Tests

- `tests/build-selector.spec.ts`: `buildPinnedSelector` returns a unique
  selector for a repeated-row element where `buildSelector` is ambiguous, keeps
  the short selector when it is already unique, and never returns a selector
  for another element. `buildIndexedXPath` resolves to the Nth XPath match.
- `tests/element-picker.spec.ts`: hovering the 2nd of three repeated rows pins
  the selector to it, shows `Match 2 of 3`, prev/next re-pin and wrap, Enter
  commits the single-match selector; `multiple: true` keeps the broad selector
  and hides the stepper; zh locale renders the Chinese stepper.
